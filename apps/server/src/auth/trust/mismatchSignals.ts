import { distanceMeters } from "@ash-atlas/shared";

import { classifyAsn, type AsnClass } from "./asnClasses.js";
import { defaultGeoZoneLookup, utcOffsetMinutes, type GeoZoneLookup } from "./geoZones.js";
import type { IpGeoLookup } from "./ipGeo.js";
import { normalizeIp } from "../networkTelemetry.js";
import type { TrustSignal } from "./trustScore.js";

// Mismatch signals (NATIVE_ANTISPOOF_BUILD_PLAN.md section 5). Pure: callers pass the
// IP databases and zone lookup. Only ASN, class, country and a 0.1 degree IP point are
// returned for storage; the raw IP never leaves this function.

export const MISMATCH_SIGNAL_WEIGHTS = {
  ip_hosting_or_vpn: 1,
  ip_location_mismatch: 2,
  ip_satellite: 0,
  carrier_country_mismatch: 2,
  timezone_mismatch: 1,
  gps_static: 0.5
} as const;

export type MismatchRule = keyof typeof MISMATCH_SIGNAL_WEIGHTS;

export const IP_MISMATCH_DISTANCE_M = 500_000;
export const TIMEZONE_MISMATCH_TOLERANCE_MIN = 60;
export const STATIC_FIX_RUN = 10;
export const HARD_MISMATCH_FIXES = 3;
export const HARD_MISMATCH_WINDOW_MS = 24 * 60 * 60_000;

export type MismatchInput = Readonly<{
  accountId: string;
  lat: number;
  lon: number;
  now: Date;
  // Trusted-proxy client address (request.ip). Never stored.
  clientIp?: string | null | undefined;
  deviceTimeZone?: string | undefined;
  // Android getNetworkCountryIso() from the native block; empty or absent skips.
  networkCountryIso?: string | undefined;
}>;

export type MismatchDeps = Readonly<{
  ipGeo?: IpGeoLookup | null | undefined;
  zones?: GeoZoneLookup | undefined;
}>;

export type MismatchResult = Readonly<{
  // Candidate signals, each with a per-day dedupeKey.
  signals: TrustSignal[];
  features: Record<string, unknown>;
  ipClass: AsnClass | null;
  hostingOrVpn: boolean;
  // Hard-eligible on this fix (a revocation needs HARD_MISMATCH_FIXES in 24 h).
  hardIpMismatch: boolean;
  hardCarrierMismatch: boolean;
  // Hosting/VPN or hard-type mismatch: the fix must not count toward Settled.
  excludeFromSettled: boolean;
}>;

const round1 = (value: number): number => Math.round(value * 10) / 10;

function signal(
  rule: MismatchRule,
  input: MismatchInput,
  metadata: Record<string, unknown> = {}
): TrustSignal {
  const day = input.now.toISOString().slice(0, 10);
  return {
    rule,
    weight: MISMATCH_SIGNAL_WEIGHTS[rule],
    metadata: { ...metadata, dedupeKey: `${rule}:${input.accountId}:${day}` }
  };
}

export function evaluateMismatch(input: MismatchInput, deps: MismatchDeps = {}): MismatchResult {
  const zones = deps.zones ?? defaultGeoZoneLookup;
  const signals: TrustSignal[] = [];
  const features: Record<string, unknown> = {};

  const gpsZones = zones.zonesAt(input.lat, input.lon);
  const gpsCountries = zones.countriesForZones(gpsZones);
  if (gpsZones.length > 0) features.gpsZone = gpsZones[0];

  // IP signals need the database and a usable client address.
  let ipClass: AsnClass | null = null;
  let hardIpMismatch = false;
  const ip = input.clientIp ? normalizeIp(input.clientIp) : "unknown";
  const geo = deps.ipGeo && ip !== "unknown" && deps.ipGeo.isAvailable() ? deps.ipGeo.lookup(ip) : null;
  if (geo) {
    ipClass = classifyAsn(geo.asn, geo.organization);
    features.ipAsn = geo.asn;
    features.ipAsnClass = ipClass;
    features.ipCountry = geo.country;
    features.ipPoint = geo.point ? { lat: round1(geo.point.lat), lon: round1(geo.point.lon) } : null;
    if (ipClass === "hosting_vpn") {
      signals.push(signal("ip_hosting_or_vpn", input, { asn: geo.asn }));
    } else if (ipClass === "satellite") {
      // Neutral: ground stations sit far from the customer. Feature only.
      features.ipSatellite = true;
    } else {
      let kind: "distance" | "country" | null = null;
      let distanceKm: number | null = null;
      if (ipClass === "fixed" && geo.point) {
        const distanceM = distanceMeters({ lat: input.lat, lon: input.lon }, geo.point);
        distanceKm = Math.round(distanceM / 1000);
        if (distanceM > IP_MISMATCH_DISTANCE_M) {
          kind = "distance";
          hardIpMismatch = true;
        }
      } else if (geo.country && gpsCountries.size > 0 && !gpsCountries.has(geo.country)) {
        // Mobile and unknown carriers exit the network in another city; country level only.
        kind = "country";
      }
      if (kind) {
        features.ipMismatchKind = kind;
        signals.push(signal("ip_location_mismatch", input, {
          kind,
          asnClass: ipClass,
          ipCountry: geo.country,
          distanceKm
        }));
      }
    }
  }

  let hardCarrierMismatch = false;
  const iso = input.networkCountryIso?.trim().toUpperCase();
  if (iso && /^[A-Z]{2}$/u.test(iso)) {
    features.carrierCountry = iso;
    if (gpsCountries.size > 0 && !gpsCountries.has(iso)) {
      hardCarrierMismatch = true;
      signals.push(signal("carrier_country_mismatch", input, { carrierCountry: iso }));
    }
  }

  if (input.deviceTimeZone && gpsZones.length > 0) {
    const deviceOffset = utcOffsetMinutes(input.deviceTimeZone, input.now);
    if (deviceOffset !== null) {
      const gpsOffsets = gpsZones
        .map((zone) => utcOffsetMinutes(zone, input.now))
        .filter((offset): offset is number => offset !== null);
      if (gpsOffsets.length > 0) {
        const diff = Math.min(...gpsOffsets.map((offset) => Math.abs(offset - deviceOffset)));
        features.timezoneOffsetDiffMin = diff;
        if (diff > TIMEZONE_MISMATCH_TOLERANCE_MIN) {
          signals.push(signal("timezone_mismatch", input, { diffMinutes: diff }));
        }
      }
    }
  }

  const hostingOrVpn = ipClass === "hosting_vpn";
  return {
    signals,
    features,
    ipClass,
    hostingOrVpn,
    hardIpMismatch,
    hardCarrierMismatch,
    excludeFromSettled: hostingOrVpn || hardIpMismatch || hardCarrierMismatch
  };
}

/** Consecutive identical native fixes per account (in process; evidence only, never hard). */
export class StaticFixTracker {
  private readonly runs = new Map<string, { key: string; count: number }>();

  static keyFor(lat: number, lon: number, accuracyM: number | undefined): string {
    return `${lat.toFixed(6)}:${lon.toFixed(6)}:${accuracyM ?? "na"}`;
  }

  // Run length including this fix; does not mutate.
  peek(accountId: string, key: string): number {
    const last = this.runs.get(accountId);
    return last && last.key === key ? last.count + 1 : 1;
  }

  commit(accountId: string, key: string): void {
    const count = this.peek(accountId, key);
    if (!this.runs.has(accountId) && this.runs.size >= 50_000) this.runs.clear();
    this.runs.set(accountId, { key, count });
  }

  reset(accountId: string): void {
    this.runs.delete(accountId);
  }
}

export function staticFixSignal(input: MismatchInput, run: number): TrustSignal | null {
  // One signal per full run of STATIC_FIX_RUN identical fixes.
  if (run < STATIC_FIX_RUN || run % STATIC_FIX_RUN !== 0) return null;
  return signal("gps_static", input, { run });
}
