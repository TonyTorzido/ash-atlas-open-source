import { randomUUID } from "node:crypto";

import { distanceMeters, type LatLon } from "@ash-atlas/shared";
import type pg from "pg";

import type { AppConfig } from "../../config.js";
import type { AppLogger } from "../../logger.js";
import { alertCellKey, roundAlertCoordinate } from "./trustAlerts.js";

// Inviter accountability (docs/architecture/NATIVE_ANTISPOOF_BUILD_PLAN.md
// 3.2, 3.5, 3.6): trust_arrivals keeps who brought whom (host, guest, kind,
// destination rounded to 0.01 degrees) for 90 days, and a host who brings
// TRUST_MASS_ARRIVAL_COUNT distinct accounts within 60 minutes to a place far
// from their homes files one mass_arrival alert per 6 hours.

export type ArrivalKind = "invite" | "party_manual" | "party_auto_follow";

export const ARRIVAL_RETENTION_DAYS = 90;
export const MASS_ARRIVAL_WINDOW_MS = 60 * 60_000;
export const MASS_ARRIVAL_FAR_FROM_HOME_M = 100_000;
export const MASS_ARRIVAL_SEVERITY = 3;
const MASS_ARRIVAL_ALERT_INTERVAL = "6 hours";
const MAX_LISTED_ARRIVALS = 20;

export type HostArrivalRow = Readonly<{
  guestAccountId: string;
  destination: LatLon | null;
  guestHome: LatLon | null;
}>;

export type ArrivalRecord = Readonly<{
  id: string;
  hostAccountId: string;
  guestAccountId: string;
  kind: ArrivalKind;
  latRounded: number | null;
  lonRounded: number | null;
  createdAt: Date;
}>;

export interface TrustArrivalStore {
  accountsForPlayers(playerIds: readonly string[]): Promise<Map<string, string>>;
  recordArrival(input: Readonly<{
    hostAccountId: string;
    guestAccountId: string;
    kind: ArrivalKind;
    destination: LatLon | null;
    now: Date;
  }>): Promise<void>;
  hostArrivalsSince(hostAccountId: string, since: Date): Promise<HostArrivalRow[]>;
  fileMassArrivalAlert(input: Readonly<{
    hostAccountId: string;
    destination: LatLon | null;
    now: Date;
    details: Record<string, unknown>;
  }>): Promise<boolean>;
}

/** Arrivals that count toward a mass arrival: far from the guest's home anchor (or no anchor). */
export function farArrivalGuests(rows: readonly HostArrivalRow[]): string[] {
  const guests = new Set<string>();
  for (const row of rows) {
    if (
      row.guestHome === null
      || row.destination === null
      || distanceMeters(row.destination, row.guestHome) >= MASS_ARRIVAL_FAR_FROM_HOME_M
    ) {
      guests.add(row.guestAccountId);
    }
  }
  return [...guests].sort();
}

export class TrustArrivalLog {
  private readonly logger: Pick<AppLogger, "warn"> | undefined;
  private readonly now: () => Date;
  private readonly classify: ((lat: number, lon: number) => string) | undefined;

  constructor(
    private readonly store: TrustArrivalStore,
    private readonly config: Pick<AppConfig, "TRUST_MASS_ARRIVAL_COUNT">,
    options: Readonly<{
      logger?: Pick<AppLogger, "warn">;
      now?: () => Date;
      // Population-grid zone class for the alert details.
      classify?: (lat: number, lon: number) => string;
    }> = {}
  ) {
    this.logger = options.logger;
    this.now = options.now ?? (() => new Date());
    this.classify = options.classify;
  }

  /** Fire-and-forget from the travel path after an invite/party arrival commits. */
  noteArrival(input: Readonly<{
    guestPlayerId: string;
    hostPlayerId: string | undefined;
    kind: ArrivalKind;
    destination: LatLon | null;
  }>): void {
    void this.recordArrival(input).catch((error: unknown) => {
      this.logger?.warn({ err: error, playerId: input.guestPlayerId }, "Trust arrival could not be recorded");
    });
  }

  async recordArrival(input: Parameters<TrustArrivalLog["noteArrival"]>[0]): Promise<boolean> {
    if (!input.hostPlayerId || input.hostPlayerId === input.guestPlayerId) return false;
    const accounts = await this.store.accountsForPlayers([input.hostPlayerId, input.guestPlayerId]);
    const hostAccountId = accounts.get(input.hostPlayerId);
    const guestAccountId = accounts.get(input.guestPlayerId);
    if (!hostAccountId || !guestAccountId || hostAccountId === guestAccountId) return false;
    const now = this.now();
    const destination = input.destination
      ? { lat: roundAlertCoordinate(input.destination.lat), lon: roundAlertCoordinate(input.destination.lon) }
      : null;
    await this.store.recordArrival({ hostAccountId, guestAccountId, kind: input.kind, destination, now });
    const rows = await this.store.hostArrivalsSince(hostAccountId, new Date(now.getTime() - MASS_ARRIVAL_WINDOW_MS));
    const guests = farArrivalGuests(rows);
    if (guests.length < this.config.TRUST_MASS_ARRIVAL_COUNT) return false;
    return this.store.fileMassArrivalAlert({
      hostAccountId,
      destination,
      now,
      details: {
        hostAccountId,
        arrivals: guests.slice(0, MAX_LISTED_ARRIVALS),
        arrivalCount: guests.length,
        destination,
        zoneClass: destination && this.classify ? this.classify(destination.lat, destination.lon) : null
      }
    });
  }
}

export class PostgresTrustArrivalStore implements TrustArrivalStore {
  constructor(private readonly pool: pg.Pool) {}

  async accountsForPlayers(playerIds: readonly string[]): Promise<Map<string, string>> {
    const result = await this.pool.query<{ id: string; account_id: string }>(
      "SELECT id, account_id::text AS account_id FROM players WHERE id = ANY($1::text[]) AND account_id IS NOT NULL",
      [playerIds]
    );
    return new Map(result.rows.map((row) => [row.id, row.account_id]));
  }

  async recordArrival(input: Parameters<TrustArrivalStore["recordArrival"]>[0]): Promise<void> {
    await this.pool.query(
      `INSERT INTO trust_arrivals (id, host_account_id, guest_account_id, kind, lat_rounded, lon_rounded, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        randomUUID(),
        input.hostAccountId,
        input.guestAccountId,
        input.kind,
        input.destination?.lat ?? null,
        input.destination?.lon ?? null,
        input.now
      ]
    );
  }

  async hostArrivalsSince(hostAccountId: string, since: Date): Promise<HostArrivalRow[]> {
    const result = await this.pool.query<{
      guest_account_id: string;
      lat_rounded: number | null;
      lon_rounded: number | null;
      home_lat: number | null;
      home_lon: number | null;
    }>(
      `SELECT a.guest_account_id::text AS guest_account_id, a.lat_rounded, a.lon_rounded,
              s.home_lat, s.home_lon
         FROM trust_arrivals a
         LEFT JOIN account_settlement s ON s.account_id = a.guest_account_id
        WHERE a.host_account_id = $1 AND a.created_at > $2
        ORDER BY a.created_at DESC
        LIMIT 500`,
      [hostAccountId, since]
    );
    return result.rows.map((row) => ({
      guestAccountId: row.guest_account_id,
      destination: row.lat_rounded !== null && row.lon_rounded !== null ? { lat: row.lat_rounded, lon: row.lon_rounded } : null,
      guestHome: row.home_lat !== null && row.home_lon !== null ? { lat: row.home_lat, lon: row.home_lon } : null
    }));
  }

  /** One mass_arrival alert per host per 6 hours (serialized per host). */
  async fileMassArrivalAlert(input: Parameters<TrustArrivalStore["fileMassArrivalAlert"]>[0]): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `trust_alert:mass_arrival:${input.hostAccountId}`
      ]);
      const recent = await client.query(
        `SELECT 1 FROM trust_alerts
          WHERE account_id = $1 AND kind = 'mass_arrival'
            AND created_at > $2::timestamptz - interval '${MASS_ARRIVAL_ALERT_INTERVAL}'
          LIMIT 1`,
        [input.hostAccountId, input.now]
      );
      let created = false;
      if (!recent.rowCount) {
        await client.query(
          `INSERT INTO trust_alerts (id, account_id, kind, severity, status, cell_key, lat_rounded, lon_rounded, details, created_at)
           VALUES ($1, $2, 'mass_arrival', $3, 'pending', $4, $5, $6, $7::jsonb, $8)`,
          [
            randomUUID(),
            input.hostAccountId,
            MASS_ARRIVAL_SEVERITY,
            input.destination ? alertCellKey(input.destination.lat, input.destination.lon) : null,
            input.destination?.lat ?? null,
            input.destination?.lon ?? null,
            JSON.stringify(input.details),
            input.now
          ]
        );
        created = true;
      }
      await client.query("COMMIT");
      return created;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Trust screen (A8): who this account brought in, newest first. */
  async arrivalsBroughtBy(hostAccountId: string, since: Date, limit = 200): Promise<ArrivalRecord[]> {
    return this.arrivals("host_account_id", hostAccountId, since, limit);
  }

  /** Trust screen (A8): who brought this account in, newest first. */
  async arrivalsBroughtIn(guestAccountId: string, since: Date, limit = 200): Promise<ArrivalRecord[]> {
    return this.arrivals("guest_account_id", guestAccountId, since, limit);
  }

  async deleteArrivalsBefore(cutoff: Date): Promise<number> {
    const result = await this.pool.query("DELETE FROM trust_arrivals WHERE created_at < $1", [cutoff]);
    return result.rowCount ?? 0;
  }

  private async arrivals(
    column: "host_account_id" | "guest_account_id",
    accountId: string,
    since: Date,
    limit: number
  ): Promise<ArrivalRecord[]> {
    const result = await this.pool.query<{
      id: string;
      host_account_id: string;
      guest_account_id: string;
      kind: ArrivalKind;
      lat_rounded: number | null;
      lon_rounded: number | null;
      created_at: Date;
    }>(
      `SELECT id::text, host_account_id::text, guest_account_id::text, kind, lat_rounded, lon_rounded, created_at
         FROM trust_arrivals
        WHERE ${column} = $1 AND created_at >= $2
        ORDER BY created_at DESC
        LIMIT $3`,
      [accountId, since, Math.max(1, Math.min(limit, 1000))]
    );
    return result.rows.map((row) => ({
      id: row.id,
      hostAccountId: row.host_account_id,
      guestAccountId: row.guest_account_id,
      kind: row.kind,
      latRounded: row.lat_rounded,
      lonRounded: row.lon_rounded,
      createdAt: row.created_at
    }));
  }
}
