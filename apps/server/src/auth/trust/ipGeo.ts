import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import maxmind from "maxmind";

import type { AppLogger } from "../../logger.js";

// IP -> ASN, country and approximate point from DB-IP Lite City + ASN (CC BY 4.0,
// https://db-ip.com/db/lite.php). The monthly files are NOT committed: see
// tools/trust/update-ipgeo.mjs and docs/ops/IPGEO_DATABASES.md. A missing database
// disables every IP signal (one warning at boot); nothing else changes.

export const IPGEO_CITY_FILE = "dbip-city-lite.mmdb";
export const IPGEO_ASN_FILE = "dbip-asn-lite.mmdb";

export type IpGeoResult = Readonly<{
  asn: number | null;
  organization: string | null;
  // ISO 3166-1 alpha-2, upper case.
  country: string | null;
  point: Readonly<{ lat: number; lon: number }> | null;
}>;

export interface IpGeoLookup {
  // False when no database is loaded: callers skip every IP signal.
  isAvailable(): boolean;
  lookup(ip: string): IpGeoResult | null;
}

export const unavailableIpGeo: IpGeoLookup = {
  isAvailable: () => false,
  lookup: () => null
};

type CityRecord = {
  country?: { iso_code?: string };
  registered_country?: { iso_code?: string };
  location?: { latitude?: number; longitude?: number };
};
type AsnRecord = { autonomous_system_number?: number; autonomous_system_organization?: string };
type ReaderLike<T> = { get(ip: string): T | null };

export function defaultIpGeoDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.TRUST_IPGEO_DIR?.trim();
  if (configured) return resolve(configured);
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(process.cwd(), "apps/server/data/ipgeo"),
    resolve(process.cwd(), "data/ipgeo"),
    resolve(moduleDirectory, "../../../data/ipgeo")
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

type Opener = <T>(path: string) => Promise<ReaderLike<T>>;
const defaultOpener: Opener = async <T>(path: string) =>
  (await maxmind.open(path as string)) as unknown as ReaderLike<T>;

const RELOAD_CHECK_INTERVAL_MS = 10 * 60_000;

type Loaded = {
  city: ReaderLike<CityRecord> | null;
  asn: ReaderLike<AsnRecord> | null;
  stamp: string;
};

function fileStamp(path: string): string {
  try {
    const stat = statSync(path);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return "missing";
  }
}

export class MaxmindIpGeo implements IpGeoLookup {
  private loaded: Loaded = { city: null, asn: null, stamp: "" };
  private loading: Promise<void> | null = null;
  private lastCheckMs = 0;
  private warned = false;

  constructor(
    private readonly directory: string,
    private readonly options: Readonly<{
      logger?: Pick<AppLogger, "warn" | "info"> | undefined;
      open?: Opener;
      now?: () => number;
    }> = {}
  ) {}

  private get cityPath(): string {
    return resolve(this.directory, IPGEO_CITY_FILE);
  }

  private get asnPath(): string {
    return resolve(this.directory, IPGEO_ASN_FILE);
  }

  /** Opens the databases once at boot; a missing or broken file logs one warning. */
  async init(): Promise<void> {
    await this.reload();
  }

  isAvailable(): boolean {
    this.maybeReload();
    return this.loaded.city !== null || this.loaded.asn !== null;
  }

  lookup(ip: string): IpGeoResult | null {
    if (!this.isAvailable()) return null;
    let city: CityRecord | null = null;
    let asn: AsnRecord | null = null;
    try {
      city = this.loaded.city?.get(ip) ?? null;
      asn = this.loaded.asn?.get(ip) ?? null;
    } catch {
      return null;
    }
    const country = (city?.country?.iso_code ?? city?.registered_country?.iso_code ?? "").toUpperCase();
    const latitude = city?.location?.latitude;
    const longitude = city?.location?.longitude;
    return {
      asn: typeof asn?.autonomous_system_number === "number" ? asn.autonomous_system_number : null,
      organization: asn?.autonomous_system_organization ?? null,
      country: /^[A-Z]{2}$/u.test(country) ? country : null,
      point: typeof latitude === "number" && typeof longitude === "number"
        ? { lat: latitude, lon: longitude }
        : null
    };
  }

  // Picks up the monthly swap done by tools/trust/update-ipgeo.mjs without a restart.
  private maybeReload(): void {
    const nowMs = (this.options.now ?? Date.now)();
    if (this.loading || nowMs - this.lastCheckMs < RELOAD_CHECK_INTERVAL_MS) return;
    this.lastCheckMs = nowMs;
    const stamp = `${fileStamp(this.cityPath)}|${fileStamp(this.asnPath)}`;
    if (stamp === this.loaded.stamp) return;
    void this.reload();
  }

  private reload(): Promise<void> {
    this.loading ??= this.doReload().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  private async doReload(): Promise<void> {
    const open = this.options.open ?? defaultOpener;
    const stamp = `${fileStamp(this.cityPath)}|${fileStamp(this.asnPath)}`;
    this.lastCheckMs = (this.options.now ?? Date.now)();
    let city: ReaderLike<CityRecord> | null = null;
    let asn: ReaderLike<AsnRecord> | null = null;
    try {
      if (!stamp.startsWith("missing")) city = await open<CityRecord>(this.cityPath);
      if (!stamp.endsWith("missing")) asn = await open<AsnRecord>(this.asnPath);
    } catch (error) {
      this.options.logger?.warn({ err: error, directory: this.directory }, "IP geolocation database could not be opened");
    }
    this.loaded = { city, asn, stamp };
    if (!city && !asn) {
      if (!this.warned) {
        this.warned = true;
        this.options.logger?.warn(
          { directory: this.directory },
          "IP geolocation databases not found; IP mismatch signals are skipped (run tools/trust/update-ipgeo.mjs)"
        );
      }
    } else if (!city || !asn) {
      this.options.logger?.warn(
        { directory: this.directory, city: city !== null, asn: asn !== null },
        "Only one IP geolocation database is loaded; related IP signals are partial"
      );
    } else {
      this.options.logger?.info({ directory: this.directory }, "IP geolocation databases loaded");
    }
  }
}

export async function createIpGeo(
  options: Readonly<{
    directory?: string;
    logger?: Pick<AppLogger, "warn" | "info"> | undefined;
    open?: Opener;
    now?: () => number;
  }> = {}
): Promise<MaxmindIpGeo> {
  const geo = new MaxmindIpGeo(options.directory ?? defaultIpGeoDirectory(), options);
  await geo.init();
  return geo;
}
