import { createHash, randomUUID } from "node:crypto";

import { parseDeviceEnvironment, type DeviceEnvironment, type NativeLocationSignals } from "@ash-atlas/shared";
import type pg from "pg";

import type { AppConfig } from "../../../config.js";
import type { AppLogger } from "../../../logger.js";
import { defaultGeoZoneLookup, type GeoZoneLookup } from "../geoZones.js";
import type { TrustSignalSink } from "../trustService.js";
import type { DeviceCheckBitsQuery, DeviceCheckBitsUpdate } from "./deviceCheckClient.js";
import { countriesForMcc } from "./mccCountries.js";

// Device environment + integrity signals (NATIVE_ANTISPOOF_BUILD_PLAN.md §8.9).
// The environment block rides on attestation requests (about every 30 min and per
// relocation), never on fixes. Everything here is evidence only: in shadow every
// signal is recorded at weight 0; enforce applies TRUST_ENVIRONMENT_SIGNAL_WEIGHTS.
// Nothing here blocks, locks or revokes. Stored rows keep only sha256(installId)
// and countries derived from time zone and locale, never the raw values.

export const ENVIRONMENT_SIGNAL_RULES = [
  "env_emulator",
  "env_root",
  "env_debugger",
  "env_sideload",
  "env_vpn_active",
  "env_sim_country_mismatch",
  "env_network_country_mismatch",
  "env_cell_country_mismatch",
  "env_timezone_country_mismatch",
  "gnss_zero_satellites",
  "install_multi_account",
  "devicecheck_spoof_bit",
  "pi_high_device_activity",
  "pi_risky_app_access",
  // MEETS_VIRTUAL_INTEGRITY without MEETS_DEVICE_INTEGRITY: Google's own emulator
  // (e.g. Google Play Games for PC). Same family as emulator hints.
  "pi_virtual_integrity"
] as const;
export type EnvironmentSignalRule = (typeof ENVIRONMENT_SIGNAL_RULES)[number];

export type EnvironmentSignalConfig = Pick<AppConfig, "TRUST_ENVIRONMENT_SIGNALS_MODE" | "TRUST_ENVIRONMENT_SIGNAL_WEIGHTS">;

export type DeviceEnvironmentConfig = EnvironmentSignalConfig & Pick<
  AppConfig,
  "TRUST_INSTALL_ALT_ACCOUNT_THRESHOLD" | "TRUST_DEVICECHECK_BIT_SET_ENABLED" | "TRUST_ATTEST_RETENTION_DAYS"
>;

type Signal = { rule: string; weight: number; metadata: Record<string, unknown> };

/**
 * One signal under TRUST_ENVIRONMENT_SIGNALS_MODE: null when off, weight 0 in
 * shadow, the configured weight (default 0) in enforce. Deduped per account and day.
 */
export function environmentSignal(
  rule: EnvironmentSignalRule,
  config: EnvironmentSignalConfig,
  accountId: string,
  at: Date,
  metadata: Record<string, unknown> = {}
): Signal | null {
  const mode = config.TRUST_ENVIRONMENT_SIGNALS_MODE;
  if (mode === "off") return null;
  const configured = config.TRUST_ENVIRONMENT_SIGNAL_WEIGHTS[rule] ?? 0;
  return {
    rule,
    weight: mode === "enforce" ? configured : 0,
    metadata: { ...metadata, mode, configuredWeight: configured, dedupeKey: `${rule}:${accountId}:${at.toISOString().slice(0, 10)}` }
  };
}

/** GNSS reports zero satellites used while the fix claims good accuracy (Android). */
export function gnssZeroSatellites(
  native: NativeLocationSignals | null,
  accuracyM: number | undefined,
  maxAccuracyM: number
): boolean {
  return native?.gnssSatellitesUsed === 0
    && typeof accuracyM === "number"
    && accuracyM <= maxAccuracyM;
}

export type EnvironmentSummary = Readonly<{
  installIdHash: string;
  installIdPersistent: boolean | null;
  installSource: DeviceEnvironment["installSource"] | null;
  emulatorHints: string[];
  rootHints: string[];
  debuggerAttached: boolean | null;
  devOptions: boolean | null;
  adbEnabled: boolean | null;
  autoTimeEnabled: boolean | null;
  vpnActive: boolean | null;
  simCountry: string | null;
  networkCountry: string | null;
  cellCountries: string[];
  timeZoneCountries: string[];
  localeCountry: string | null;
}>;

const ISO2 = /^[A-Z]{2}$/u;
const iso2 = (value: string | null | undefined): string | null => {
  const upper = value?.trim().toUpperCase();
  return upper && ISO2.test(upper) ? upper : null;
};
const optionalBool = (value: boolean | undefined): boolean | null => (typeof value === "boolean" ? value : null);

export function installIdHash(installId: string): string {
  return createHash("sha256").update(installId, "utf8").digest("hex");
}

/** Reduces the block to what is stored: hashed install id, derived countries, flags. */
export function summarizeEnvironment(
  environment: DeviceEnvironment,
  zones: GeoZoneLookup = defaultGeoZoneLookup
): EnvironmentSummary {
  const cellCountries = new Set<string>();
  for (const mcc of environment.cellMccs ?? []) for (const country of countriesForMcc(mcc)) cellCountries.add(country);
  const localeRegion = environment.locale?.split(/[-_]/u).slice(1).find((part) => /^[A-Za-z]{2}$/u.test(part));
  return {
    installIdHash: installIdHash(environment.installId),
    installIdPersistent: optionalBool(environment.installIdPersistent),
    installSource: environment.installSource ?? null,
    emulatorHints: [...new Set(environment.emulatorHints ?? [])].slice(0, 16),
    rootHints: [...new Set(environment.rootHints ?? [])].slice(0, 16),
    debuggerAttached: optionalBool(environment.debuggerAttached),
    devOptions: optionalBool(environment.devOptions),
    adbEnabled: optionalBool(environment.adbEnabled),
    autoTimeEnabled: optionalBool(environment.autoTimeEnabled),
    vpnActive: optionalBool(environment.vpnActive),
    simCountry: iso2(environment.simCountryIso),
    networkCountry: iso2(environment.networkCountryIso),
    cellCountries: [...cellCountries].sort().slice(0, 8),
    timeZoneCountries: environment.timeZone
      ? [...zones.countriesForZones([environment.timeZone])].sort().slice(0, 32)
      : [],
    localeCountry: iso2(localeRegion)
  };
}

const HIGH_DEVICE_ACTIVITY = new Set(["LEVEL_3", "LEVEL_4"]);
const RISKY_APP_ACCESS = new Set(["UNKNOWN_CAPTURING", "UNKNOWN_CONTROLLING", "UNKNOWN_OVERLAYS"]);
const RISKY_PLAY_PROTECT = new Set(["HIGH_RISK", "MEDIUM_RISK"]);

export type EnvironmentEvaluationInput = Readonly<{
  summary: EnvironmentSummary | null;
  // Countries of the baseline GPS fix; empty skips every country comparison.
  gpsCountries: ReadonlySet<string>;
  playIntegrity: Readonly<Record<string, unknown>> | null;
  deviceCheckBit0: boolean | null;
  // Distinct accounts seen on this install id, this one included.
  installAccounts: number;
  installThreshold: number;
}>;

/** Pure: the environment signals one attestation request raises. */
export function evaluateEnvironmentSignals(
  input: EnvironmentEvaluationInput
): Array<Readonly<{ rule: EnvironmentSignalRule; metadata: Record<string, unknown> }>> {
  const out: Array<{ rule: EnvironmentSignalRule; metadata: Record<string, unknown> }> = [];
  const gps = input.gpsCountries;
  const outside = (country: string | null): boolean => country !== null && gps.size > 0 && !gps.has(country);
  const gpsList = [...gps].sort().slice(0, 8);
  const summary = input.summary;
  if (summary) {
    if (summary.emulatorHints.length > 0) out.push({ rule: "env_emulator", metadata: { hints: summary.emulatorHints } });
    if (summary.rootHints.length > 0) out.push({ rule: "env_root", metadata: { hints: summary.rootHints } });
    if (summary.debuggerAttached === true) out.push({ rule: "env_debugger", metadata: {} });
    if (summary.installSource === "sideload") out.push({ rule: "env_sideload", metadata: {} });
    if (summary.vpnActive === true) out.push({ rule: "env_vpn_active", metadata: {} });
    if (outside(summary.simCountry)) {
      out.push({ rule: "env_sim_country_mismatch", metadata: { simCountry: summary.simCountry, gpsCountries: gpsList } });
    }
    if (outside(summary.networkCountry)) {
      out.push({ rule: "env_network_country_mismatch", metadata: { networkCountry: summary.networkCountry, gpsCountries: gpsList } });
    }
    if (summary.cellCountries.length > 0 && gps.size > 0 && !summary.cellCountries.some((country) => gps.has(country))) {
      out.push({ rule: "env_cell_country_mismatch", metadata: { cellCountries: summary.cellCountries, gpsCountries: gpsList } });
    }
    if (summary.timeZoneCountries.length > 0 && gps.size > 0 && !summary.timeZoneCountries.some((country) => gps.has(country))) {
      out.push({
        rule: "env_timezone_country_mismatch",
        metadata: { timeZoneCountries: summary.timeZoneCountries.slice(0, 8), gpsCountries: gpsList }
      });
    }
    if (input.installAccounts >= input.installThreshold) {
      out.push({
        rule: "install_multi_account",
        metadata: { accounts: input.installAccounts, persistent: summary.installIdPersistent, installIdHash: summary.installIdHash.slice(0, 16) }
      });
    }
  }
  if (input.deviceCheckBit0 === true) out.push({ rule: "devicecheck_spoof_bit", metadata: {} });
  const pi = input.playIntegrity;
  if (pi) {
    const level = typeof pi.deviceActivityLevel === "string" ? pi.deviceActivityLevel : null;
    if (level && HIGH_DEVICE_ACTIVITY.has(level)) out.push({ rule: "pi_high_device_activity", metadata: { deviceActivityLevel: level } });
    const apps = Array.isArray(pi.appsDetected) ? pi.appsDetected.filter((entry): entry is string => typeof entry === "string") : [];
    const playProtect = typeof pi.playProtectVerdict === "string" ? pi.playProtectVerdict : null;
    const recognition = Array.isArray(pi.deviceRecognitionVerdict)
      ? pi.deviceRecognitionVerdict.filter((entry): entry is string => typeof entry === "string")
      : [];
    if (recognition.includes("MEETS_VIRTUAL_INTEGRITY") && !recognition.includes("MEETS_DEVICE_INTEGRITY")) {
      out.push({ rule: "pi_virtual_integrity", metadata: { deviceRecognitionVerdict: recognition.slice(0, 8) } });
    }
    if (apps.some((entry) => RISKY_APP_ACCESS.has(entry)) || (playProtect !== null && RISKY_PLAY_PROTECT.has(playProtect))) {
      out.push({ rule: "pi_risky_app_access", metadata: { appsDetected: apps.slice(0, 8), playProtectVerdict: playProtect } });
    }
  }
  return out;
}

// Play Integrity summary fields worth keeping beside the environment row.
function playIntegrityExcerpt(summary: Readonly<Record<string, unknown>> | null): Record<string, unknown> | null {
  if (!summary) return null;
  const pick = (key: string): unknown => summary[key] ?? null;
  return {
    deviceRecognitionVerdict: pick("deviceRecognitionVerdict"),
    deviceActivityLevel: pick("deviceActivityLevel"),
    appsDetected: pick("appsDetected"),
    playProtectVerdict: pick("playProtectVerdict"),
    appLicensingVerdict: pick("appLicensingVerdict")
  };
}

export type EnvironmentReportInsert = Readonly<{
  id: string;
  accountId: string;
  attestationId: string | null;
  platform: "ios" | "android";
  summary: EnvironmentSummary;
  gpsCountries: string[];
  playIntegrity: Record<string, unknown> | null;
  deviceCheckBit0: boolean | null;
  createdAt: Date;
}>;

export interface DeviceEnvironmentStore {
  lastFix(accountId: string): Promise<Readonly<{ lat: number; lon: number }> | null>;
  insertReport(row: EnvironmentReportInsert): Promise<void>;
  /** Distinct accounts (this one included) that reported this install id since `since`. */
  installAccountCount(installIdHash: string, since: Date): Promise<number>;
  saveDeviceCheckToken(accountId: string, token: string, at: Date): Promise<void>;
  loadDeviceCheckToken(accountId: string, since: Date): Promise<string | null>;
  cleanup(before: Date, tokensBefore: Date): Promise<number>;
}

export type DeviceCheckBitsClient = Readonly<{ queryBits: DeviceCheckBitsQuery; updateBits: DeviceCheckBitsUpdate }>;

export type EnvironmentRecordInput = Readonly<{
  accountId: string;
  attestationId: string | null;
  platform: "ios" | "android";
  environment: unknown;
  deviceCheckToken?: string | undefined;
  // Relocation-bound fix; otherwise the account's last fix is the GPS reference.
  fix?: Readonly<{ lat: number; lon: number }> | null | undefined;
  playIntegrity?: Readonly<Record<string, unknown>> | null | undefined;
}>;

// A stored DeviceCheck token is used to set bit0 for this long after it was seen.
const DEVICECHECK_TOKEN_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

export class DeviceEnvironmentService {
  private readonly sink: TrustSignalSink | undefined;
  private readonly deviceCheck: DeviceCheckBitsClient | null;
  private readonly logger: Pick<AppLogger, "warn" | "info"> | undefined;
  private readonly now: () => Date;
  private readonly zones: GeoZoneLookup;

  constructor(
    private readonly store: DeviceEnvironmentStore,
    private readonly config: DeviceEnvironmentConfig,
    options: Readonly<{
      sink?: TrustSignalSink;
      deviceCheck?: DeviceCheckBitsClient | null;
      logger?: Pick<AppLogger, "warn" | "info">;
      now?: () => Date;
      zones?: GeoZoneLookup;
    }> = {}
  ) {
    this.sink = options.sink;
    this.deviceCheck = options.deviceCheck ?? null;
    this.logger = options.logger;
    this.now = options.now ?? (() => new Date());
    this.zones = options.zones ?? defaultGeoZoneLookup;
  }

  /** Stores the summary and records its signals. Never throws: the attestation is already answered. */
  async record(input: EnvironmentRecordInput): Promise<void> {
    if (this.config.TRUST_ENVIRONMENT_SIGNALS_MODE === "off") return;
    try {
      const now = this.now();
      const parsed = parseDeviceEnvironment(input.environment);
      const summary = parsed.status === "ok" ? summarizeEnvironment(parsed.environment, this.zones) : null;
      const deviceCheckBit0 = await this.queryBit0(input);
      const playIntegrity = input.playIntegrity ?? null;
      if (!summary && deviceCheckBit0 !== true && !playIntegrity) return;
      const fix = input.fix ?? await this.store.lastFix(input.accountId);
      const gpsCountries = fix ? this.zones.countriesForZones(this.zones.zonesAt(fix.lat, fix.lon)) : new Set<string>();
      let installAccounts = 0;
      if (summary) {
        await this.store.insertReport({
          id: randomUUID(),
          accountId: input.accountId,
          attestationId: input.attestationId,
          platform: input.platform,
          summary,
          gpsCountries: [...gpsCountries].sort().slice(0, 32),
          playIntegrity: playIntegrityExcerpt(playIntegrity),
          deviceCheckBit0,
          createdAt: now
        });
        installAccounts = await this.store.installAccountCount(
          summary.installIdHash,
          new Date(now.getTime() - this.config.TRUST_ATTEST_RETENTION_DAYS * DAY_MS)
        );
      }
      const signals = evaluateEnvironmentSignals({
        summary,
        gpsCountries,
        playIntegrity,
        deviceCheckBit0,
        installAccounts,
        installThreshold: this.config.TRUST_INSTALL_ALT_ACCOUNT_THRESHOLD
      })
        .map((candidate) => environmentSignal(candidate.rule, this.config, input.accountId, now, {
          ...candidate.metadata,
          ...(input.attestationId ? { attestationId: input.attestationId } : {})
        }))
        .filter((signal): signal is Signal => signal !== null);
      if (parsed.status === "malformed") this.logger?.info({ accountId: input.accountId }, "Device environment block ignored (out of bounds)");
      if (signals.length > 0 && this.sink) await this.sink.recordSignals({ accountId: input.accountId, signals });
    } catch (error) {
      this.logger?.warn({ err: error, accountId: input.accountId }, "Device environment could not be recorded");
    }
  }

  /**
   * Sets DeviceCheck bit0 ("locked for spoofing") on the account's last iOS
   * device (TRUST_DEVICECHECK_BIT_SET_ENABLED). Keeps bit1. Never throws.
   */
  async markSpoofingLock(accountId: string): Promise<"set" | "skipped" | "failed"> {
    if (!this.config.TRUST_DEVICECHECK_BIT_SET_ENABLED || !this.deviceCheck) return "skipped";
    try {
      const token = await this.store.loadDeviceCheckToken(
        accountId,
        new Date(this.now().getTime() - DEVICECHECK_TOKEN_MAX_AGE_MS)
      );
      if (!token) return "skipped";
      const current = await this.deviceCheck.queryBits(token);
      if (current === "invalid" || current === "unavailable") return "failed";
      const bit1 = current === "unset" ? false : current.bit1;
      const result = await this.deviceCheck.updateBits(token, { bit0: true, bit1 });
      if (result === "ok") {
        this.logger?.info({ accountId }, "DeviceCheck spoofing bit set");
        return "set";
      }
      return "failed";
    } catch (error) {
      this.logger?.warn({ err: error, accountId }, "DeviceCheck spoofing bit could not be set");
      return "failed";
    }
  }

  async cleanup(): Promise<number> {
    const now = this.now().getTime();
    return this.store.cleanup(
      new Date(now - this.config.TRUST_ATTEST_RETENTION_DAYS * DAY_MS),
      new Date(now - DEVICECHECK_TOKEN_MAX_AGE_MS)
    );
  }

  private async queryBit0(input: EnvironmentRecordInput): Promise<boolean | null> {
    if (input.platform !== "ios" || !input.deviceCheckToken || !this.deviceCheck) return null;
    if (this.config.TRUST_DEVICECHECK_BIT_SET_ENABLED) {
      await this.store.saveDeviceCheckToken(input.accountId, input.deviceCheckToken, this.now());
    }
    const bits = await this.deviceCheck.queryBits(input.deviceCheckToken);
    if (bits === "unset") return false;
    return typeof bits === "object" ? bits.bit0 : null;
  }
}

export class PostgresDeviceEnvironmentStore implements DeviceEnvironmentStore {
  constructor(private readonly pool: pg.Pool) {}

  async lastFix(accountId: string): Promise<Readonly<{ lat: number; lon: number }> | null> {
    const result = await this.pool.query<{ last_fix_lat: number | null; last_fix_lon: number | null }>(
      "SELECT last_fix_lat, last_fix_lon FROM account_location_state WHERE account_id = $1",
      [accountId]
    );
    const row = result.rows[0];
    return row && row.last_fix_lat !== null && row.last_fix_lon !== null
      ? { lat: Number(row.last_fix_lat), lon: Number(row.last_fix_lon) }
      : null;
  }

  async insertReport(row: EnvironmentReportInsert): Promise<void> {
    const s = row.summary;
    await this.pool.query(
      `INSERT INTO device_environment_reports (
         id, account_id, attestation_id, platform, install_id_hash, install_id_persistent, install_source,
         emulator_hints, root_hints, debugger_attached, dev_options, adb_enabled, auto_time_enabled, vpn_active,
         sim_country, network_country, cell_countries, time_zone_countries, locale_country, gps_countries,
         play_integrity, devicecheck_bit0, created_at
       ) VALUES (
         $1, $2, (SELECT id FROM device_attestations WHERE id = $3::uuid), $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
         $15, $16, $17, $18, $19, $20, $21::jsonb, $22, $23
       )`,
      [
        row.id, row.accountId, row.attestationId, row.platform, s.installIdHash, s.installIdPersistent, s.installSource,
        s.emulatorHints, s.rootHints, s.debuggerAttached, s.devOptions, s.adbEnabled, s.autoTimeEnabled, s.vpnActive,
        s.simCountry, s.networkCountry, s.cellCountries, s.timeZoneCountries, s.localeCountry, row.gpsCountries,
        row.playIntegrity ? JSON.stringify(row.playIntegrity) : null, row.deviceCheckBit0, row.createdAt
      ]
    );
  }

  async installAccountCount(installIdHash: string, since: Date): Promise<number> {
    const result = await this.pool.query<{ count: number }>(
      `SELECT count(DISTINCT account_id)::int AS count
         FROM device_environment_reports WHERE install_id_hash = $1 AND created_at >= $2`,
      [installIdHash, since]
    );
    return result.rows[0]?.count ?? 0;
  }

  async saveDeviceCheckToken(accountId: string, token: string, at: Date): Promise<void> {
    await this.pool.query(
      `INSERT INTO devicecheck_device_tokens (account_id, device_token, updated_at) VALUES ($1, $2, $3)
       ON CONFLICT (account_id) DO UPDATE SET device_token = EXCLUDED.device_token, updated_at = EXCLUDED.updated_at`,
      [accountId, token, at]
    );
  }

  async loadDeviceCheckToken(accountId: string, since: Date): Promise<string | null> {
    const result = await this.pool.query<{ device_token: string }>(
      "SELECT device_token FROM devicecheck_device_tokens WHERE account_id = $1 AND updated_at >= $2",
      [accountId, since]
    );
    return result.rows[0]?.device_token ?? null;
  }

  async cleanup(before: Date, tokensBefore: Date): Promise<number> {
    const reports = await this.pool.query("DELETE FROM device_environment_reports WHERE created_at < $1", [before]);
    const tokens = await this.pool.query("DELETE FROM devicecheck_device_tokens WHERE updated_at < $1", [tokensBefore]);
    return (reports.rowCount ?? 0) + (tokens.rowCount ?? 0);
  }
}
