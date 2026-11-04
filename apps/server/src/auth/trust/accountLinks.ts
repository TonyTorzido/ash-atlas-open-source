import { distanceMeters } from "@ash-atlas/shared";
import type pg from "pg";

import { DEFAULT_TRUST_RISK_SIGNAL_WEIGHTS, type AppConfig } from "../../config.js";
import type { AppLogger } from "../../logger.js";
import { environmentSignal } from "./attestation/deviceEnvironment.js";
import type { TrustAlertWriter } from "./trustAlerts.js";
import type { TrustSignalSink } from "./trustService.js";

// Multi-accounting and account sharing (owner decision C, 2026-10-04). Evidence
// only: signals + admin alerts, never a block. Links come from the native
// install id (device_environment_reports.install_id_hash: on iOS the keychain id
// that survives reinstalls) and the login device (account_device_links). Play
// Integrity exposes no stable device id; a DeviceCheck bit0 device raises
// devicecheck_spoof_bit in deviceEnvironment.ts.

export type AccountLinkVia = "install" | "login_device";

export type LinkedAccount = Readonly<{ accountId: string; via: readonly AccountLinkVia[]; lastSeenAt: Date }>;

export type OtherDeviceFix = Readonly<{ lat: number; lon: number; at: Date; deviceInstallationId: string }>;

export interface AccountLinkStore {
  // Other accounts sharing a native install id or a login device with this account since `since`.
  linkedAccounts(accountId: string, since: Date, limit: number): Promise<LinkedAccount[]>;
  // Distinct native install ids this account reported since `since`.
  nativeInstallCount(accountId: string, since: Date): Promise<number>;
  // This account's latest stored fix from another device since `since` (rejected
  // fixes included: a refused claim from another device is still that device).
  latestFixFromOtherDevice(accountId: string, deviceInstallationId: string, since: Date): Promise<OtherDeviceFix | null>;
}

export type AccountLinkConfig = Pick<
  AppConfig,
  | "TRUST_ENVIRONMENT_SIGNALS_MODE"
  | "TRUST_ENVIRONMENT_SIGNAL_WEIGHTS"
  | "TRUST_INSTALL_ALT_ACCOUNT_THRESHOLD"
  | "TRUST_ATTEST_RETENTION_DAYS"
> & Partial<Pick<
  AppConfig,
  | "TRUST_RISK_SIGNAL_WEIGHTS"
  | "TRUST_ACCOUNT_SHARED_DEVICES"
  | "TRUST_ACCOUNT_SHARED_WINDOW_MINUTES"
  | "TRUST_ACCOUNT_SHARED_MAX_KMH"
>>;

const DAY_MS = 24 * 60 * 60_000;
const CHECK_INTERVAL_MS = 5 * 60_000;
const LINK_LIMIT = 25;
// Two devices this close are one household, whatever the clock says.
const SHARED_MIN_DISTANCE_M = 50_000;
const MAX_TRACKED_ACCOUNTS = 50_000;

/**
 * Called after each stored fix (LocationReportService). At most one check per
 * account every few minutes in this process; never throws.
 */
export class AccountLinkMonitor {
  private readonly lastChecks = new Map<string, number>();
  // Last device seen per account: a device switch always runs the concurrency check.
  private readonly lastDevices = new Map<string, string | null>();
  private readonly now: () => Date;

  constructor(
    private readonly store: AccountLinkStore,
    private readonly config: AccountLinkConfig,
    private readonly deps: Readonly<{
      sink: TrustSignalSink;
      alerts?: Pick<TrustAlertWriter, "fileZoneAlert"> | undefined;
      logger?: Pick<AppLogger, "warn"> | undefined;
      now?: () => Date;
    }>
  ) {
    this.now = deps.now ?? (() => new Date());
  }

  async onFix(input: Readonly<{
    accountId: string;
    deviceInstallationId: string | null;
    lat: number;
    lon: number;
    at?: Date;
  }>): Promise<void> {
    if (this.config.TRUST_ENVIRONMENT_SIGNALS_MODE === "off") return;
    const at = input.at ?? this.now();
    const last = this.lastChecks.get(input.accountId);
    const previousDevice = this.lastDevices.get(input.accountId);
    const deviceSwitched = previousDevice !== undefined && previousDevice !== input.deviceInstallationId;
    if (this.lastDevices.size >= MAX_TRACKED_ACCOUNTS) this.lastDevices.clear();
    this.lastDevices.set(input.accountId, input.deviceInstallationId);
    const throttled = last !== undefined && at.getTime() - last < CHECK_INTERVAL_MS && at.getTime() >= last;
    if (throttled && !deviceSwitched) return;
    if (this.lastChecks.size >= MAX_TRACKED_ACCOUNTS) this.lastChecks.clear();
    this.lastChecks.set(input.accountId, at.getTime());
    try {
      if (!throttled) await this.checkMultiAccount(input, at);
      await this.checkShared(input, at);
    } catch (error) {
      this.lastChecks.delete(input.accountId);
      this.deps.logger?.warn({ err: error, accountId: input.accountId }, "Account link check failed");
    }
  }

  private async checkMultiAccount(input: Readonly<{ accountId: string; lat: number; lon: number }>, at: Date): Promise<void> {
    const since = new Date(at.getTime() - this.config.TRUST_ATTEST_RETENTION_DAYS * DAY_MS);
    const linked = await this.store.linkedAccounts(input.accountId, since, LINK_LIMIT);
    if (linked.length + 1 < this.config.TRUST_INSTALL_ALT_ACCOUNT_THRESHOLD) return;
    const signal = environmentSignal("install_multi_account", this.config, input.accountId, at, {
      accounts: linked.length + 1,
      via: [...new Set(linked.flatMap((entry) => entry.via))]
    });
    if (signal) await this.deps.sink.recordSignals({ accountId: input.accountId, signals: [signal] });
    await this.deps.alerts?.fileZoneAlert({
      accountId: input.accountId,
      kind: "multi_account",
      lat: input.lat,
      lon: input.lon,
      now: at,
      dedupe: "account",
      details: { linkedAccounts: linked.map((entry) => ({ accountId: entry.accountId, via: entry.via })) }
    });
  }

  private async checkShared(
    input: Readonly<{ accountId: string; deviceInstallationId: string | null; lat: number; lon: number }>,
    at: Date
  ): Promise<void> {
    const reasons: Record<string, unknown>[] = [];
    const deviceLimit = this.config.TRUST_ACCOUNT_SHARED_DEVICES ?? 2;
    const installs = await this.store.nativeInstallCount(
      input.accountId,
      new Date(at.getTime() - this.config.TRUST_ATTEST_RETENTION_DAYS * DAY_MS)
    );
    if (installs >= deviceLimit) reasons.push({ kind: "devices", installs });
    if (input.deviceInstallationId) {
      const windowMs = (this.config.TRUST_ACCOUNT_SHARED_WINDOW_MINUTES ?? 120) * 60_000;
      const other = await this.store.latestFixFromOtherDevice(
        input.accountId,
        input.deviceInstallationId,
        new Date(at.getTime() - windowMs)
      );
      if (other) {
        const distanceM = distanceMeters(other, input);
        const hours = Math.max(1 / 60, (at.getTime() - other.at.getTime()) / 3_600_000);
        const kmh = distanceM / 1000 / hours;
        if (distanceM >= SHARED_MIN_DISTANCE_M && kmh > (this.config.TRUST_ACCOUNT_SHARED_MAX_KMH ?? 900)) {
          reasons.push({ kind: "concurrent", distanceKm: Math.round(distanceM / 1000), kmh: Math.round(kmh) });
        }
      }
    }
    if (reasons.length === 0) return;
    const day = at.toISOString().slice(0, 10);
    await this.deps.sink.recordSignals({
      accountId: input.accountId,
      signals: [{
        rule: "account_shared",
        weight: this.config.TRUST_RISK_SIGNAL_WEIGHTS?.account_shared ?? DEFAULT_TRUST_RISK_SIGNAL_WEIGHTS.account_shared ?? 0,
        metadata: { reasons, dedupeKey: `account_shared:${input.accountId}:${day}` }
      }]
    });
    await this.deps.alerts?.fileZoneAlert({
      accountId: input.accountId,
      kind: "account_shared",
      lat: input.lat,
      lon: input.lon,
      now: at,
      dedupe: "account",
      details: { reasons }
    });
  }
}

/** Other accounts on the same native install id or login device (both directions). */
export async function queryLinkedAccounts(
  db: Pick<pg.Pool, "query">,
  accountId: string,
  since: Date,
  limit: number
): Promise<LinkedAccount[]> {
  const result = await db.query<{ account_id: string; via: AccountLinkVia[]; last_seen_at: Date }>(
    `WITH links AS (
       SELECT other.account_id, 'install'::text AS via, max(other.created_at) AS last_seen_at
         FROM device_environment_reports other
        WHERE other.install_id_hash IN (
                SELECT DISTINCT install_id_hash FROM device_environment_reports
                 WHERE account_id = $1 AND created_at >= $2)
          AND other.account_id <> $1
          AND other.created_at >= $2
        GROUP BY other.account_id
       UNION ALL
       SELECT theirs.account_id, 'login_device'::text, max(theirs.last_seen_at)
         FROM account_device_links mine
         JOIN account_device_links theirs ON theirs.device_installation_id = mine.device_installation_id
        WHERE mine.account_id = $1 AND theirs.account_id <> $1 AND theirs.last_seen_at >= $2
        GROUP BY theirs.account_id)
     SELECT account_id::text AS account_id, array_agg(DISTINCT via ORDER BY via) AS via, max(last_seen_at) AS last_seen_at
       FROM links
      GROUP BY account_id
      ORDER BY max(last_seen_at) DESC
      LIMIT $3`,
    [accountId, since, limit]
  );
  return result.rows.map((row) => ({ accountId: row.account_id, via: row.via, lastSeenAt: row.last_seen_at }));
}

export class PostgresAccountLinkStore implements AccountLinkStore {
  constructor(private readonly pool: pg.Pool) {}

  linkedAccounts(accountId: string, since: Date, limit: number): Promise<LinkedAccount[]> {
    return queryLinkedAccounts(this.pool, accountId, since, limit);
  }

  async nativeInstallCount(accountId: string, since: Date): Promise<number> {
    const result = await this.pool.query<{ n: string }>(
      `SELECT count(DISTINCT install_id_hash)::text AS n
         FROM device_environment_reports
        WHERE account_id = $1 AND created_at >= $2`,
      [accountId, since]
    );
    return Number(result.rows[0]?.n ?? 0);
  }

  async latestFixFromOtherDevice(accountId: string, deviceInstallationId: string, since: Date): Promise<OtherDeviceFix | null> {
    const result = await this.pool.query<{ lat: number; lon: number; received_at: Date; device_installation_id: string }>(
      `SELECT lat, lon, received_at, device_installation_id::text AS device_installation_id
         FROM location_reports
        WHERE account_id = $1
          AND received_at >= $3
          AND device_installation_id IS NOT NULL
          AND device_installation_id <> $2::uuid
        ORDER BY received_at DESC
        LIMIT 1`,
      [accountId, deviceInstallationId, since]
    );
    const row = result.rows[0];
    return row
      ? { lat: Number(row.lat), lon: Number(row.lon), at: row.received_at, deviceInstallationId: row.device_installation_id }
      : null;
  }
}
