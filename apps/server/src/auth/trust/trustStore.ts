import { randomUUID } from "node:crypto";

import type pg from "pg";

import { queryLinkedAccounts } from "./accountLinks.js";

import type {
  LatLon,
  LocationFixAssurance,
  TrustAdminAccountDetail,
  TrustAdminAccountSummary,
  TrustAdminArrivalView,
  TrustAdminAttestationView,
  TrustAdminEnvironmentView,
  TrustAdminEventView,
  TrustAdminLocationReportView,
  TrustAdminSettlementView
} from "@ash-atlas/shared";

import type { AltDoorwayStore, DoorwayPlayerRecord } from "./altDoorway.js";
import {
  applySettlementFixInTransaction,
  isSettledNow,
  type SettlementEvent,
  type SettlementFixUpdate
} from "./settlement.js";
import { roundAlertCoordinate } from "./trustAlerts.js";
import {
  ARRIVAL_RETENTION_DAYS,
  PostgresTrustArrivalStore,
  type ArrivalRecord
} from "./trustArrivals.js";
import {
  decayLogodds,
  nextShadowTier,
  shadowTierFor,
  staticPrior,
  type AccountTrustTier,
  type LadderThresholds,
  type SpeedBucket
} from "./trustScore.js";

export type LandActionHoldReason = "relocation_cooldown" | "transit" | "settle";

// Passive rows are high volume; relocation rows keep TRUST_LOCATION_REPORT_RETENTION_DAYS.
export const PASSIVE_LOCATION_REPORT_RETENTION_DAYS = 30;

export function locationReportRetentionCutoffs(
  retentionDays: number,
  now: Date
): { cutoff: Date; passiveCutoff: Date } {
  const daysAgo = (days: number) => new Date(now.getTime() - days * 24 * 60 * 60_000);
  return {
    cutoff: daysAgo(retentionDays),
    passiveCutoff: daysAgo(Math.min(retentionDays, PASSIVE_LOCATION_REPORT_RETENTION_DAYS))
  };
}

export type AccountLocationState = Readonly<{
  accountId: string;
  lastSeq: number;
  lastAcceptedReportId: string | null;
  lastFix: Readonly<{ lat: number; lon: number; accuracyM: number | null; at: Date }> | null;
  // The last fix came from a passive LOCATION_FIX (stored or not). Absent means false.
  lastFixPassive?: boolean;
  // Fix of the report at lastAcceptedReportId (the last stored accepted fix).
  lastStoredFix?: Readonly<{ lat: number; lon: number; accuracyM: number | null; at: Date }> | null;
  lastLandAction: Readonly<{ lat: number; lon: number; at: Date }> | null;
  landActionHoldUntil: Date | null;
  landActionHoldReason: LandActionHoldReason | null;
  relocations7dFar: number;
  // Home anchor (migration 0884): first accepted fix; a passive-derived home is
  // replaced once by the first accepted relocation.
  home?: Readonly<{ lat: number; lon: number; source: "passive" | "relocation" }> | null;
}>;

export type LocationContext = Readonly<{
  state: AccountLocationState | null;
  // Far relocations recorded since the given instant.
  farRelocationsSince: number;
}>;

export type LocationReportVerdict = "accepted" | "shadow_rejected" | "rejected" | "travel_failed";

export type LocationReportRow = Readonly<{
  id: string;
  accountId: string;
  playerId: string | null;
  source: "relocation" | "passive";
  requestId: string | null;
  lat: number;
  lon: number;
  accuracyM: number | null;
  clientPlatform: "web" | "ios" | "android" | null;
  deviceInstallationId: string | null;
  networkHash: string | null;
  networkPrefixHash: string | null;
  deviceTimeZone: string | null;
  receivedAt: Date;
  prevReportId: string | null;
  distanceM: number | null;
  elapsedMs: number | null;
  impliedKmh: number | null;
  speedBucket: SpeedBucket | null;
  verdict: LocationReportVerdict;
  verdictReason: string | null;
  features: Record<string, unknown>;
  score: number;
  // Per-fix assurance (migration 0911); absent means unknown.
  assurance?: LocationFixAssurance | null;
  // Resolved device attestation the fix carried (migration 0911).
  attestationId?: string | null;
}>;

// Applied to account_location_state only when the fix was accepted (the avatar moved).
export type AcceptedFixUpdate = Readonly<{
  holdUntil: Date | null;
  holdReason: LandActionHoldReason | null;
  relocations7dFar: number;
} & PresenceDayUpdate>;

// A passive fix near home confirms its UTC day (alt doorway, migration 0884).
export type PresenceDayUpdate = {
  // YYYY-MM-DD, or absent when the fix does not confirm a day.
  presenceDay?: string | null;
  // confirmed_days at which home_confirmed_at is set.
  confirmedDaysTarget?: number;
};

export type UnstoredFix = Readonly<{
  accountId: string;
  lat: number;
  lon: number;
  accuracyM: number | null;
  at: Date;
  assurance?: LocationFixAssurance | null;
  settlement?: SettlementFixUpdate | null;
} & PresenceDayUpdate>;

export type RecordedLocationReport = { reportId: string; seq: number; settlementEvent?: SettlementEvent };

// Sets home when none exists, or replaces a passive-derived home with the
// first accepted relocation. All right-hand sides read the old row.
function homeSql(source: string, lat: string, lon: string, at: string): string {
  const replace = `(home_lat IS NULL OR (${source}::text = 'relocation' AND home_source IS DISTINCT FROM 'relocation'))`;
  return `home_set_at = CASE WHEN ${replace} THEN ${at}::timestamptz ELSE home_set_at END,
                  home_source = CASE WHEN ${replace} THEN ${source}::text ELSE home_source END,
                  home_lat = CASE WHEN ${replace} THEN ${lat}::double precision ELSE home_lat END,
                  home_lon = CASE WHEN ${replace} THEN ${lon}::double precision ELSE home_lon END`;
}

// Counts a presence day at most once per UTC day; $day is a date or NULL,
// $target the confirmed_days that mark the home confirmed, $at the fix time.
function presenceDaySql(day: string, target: string, at: string): string {
  const fresh = `(${day}::date IS NOT NULL AND (last_confirmed_day IS NULL OR last_confirmed_day < ${day}::date))`;
  return `confirmed_days = confirmed_days + CASE WHEN ${fresh} THEN 1 ELSE 0 END,
                  home_confirmed_at = CASE
                    WHEN home_confirmed_at IS NULL AND ${fresh} AND confirmed_days + 1 >= ${target}::int
                      THEN ${at}::timestamptz
                    ELSE home_confirmed_at
                  END,
                  last_confirmed_day = CASE WHEN ${fresh} THEN ${day}::date ELSE last_confirmed_day END`;
}

export interface LocationReportStore {
  loadLocationContext(accountId: string, farSince: Date, farMinDistanceM: number): Promise<LocationContext>;
  // settlement is applied in the same transaction, only for accepted fixes.
  recordLocationReport(
    row: LocationReportRow,
    accepted: AcceptedFixUpdate | null,
    settlement?: SettlementFixUpdate | null
  ): Promise<RecordedLocationReport>;
  // Advances last_fix_* without a report row (redundant passive fix).
  updateLastFix(fix: UnstoredFix): Promise<SettlementEvent | void>;
  // Stored reports flagged hard-eligible (fixed-line IP / carrier-country mismatch) since `since`.
  countHardMismatchFixes?(accountId: string, since: Date): Promise<Readonly<{ ip: number; carrier: number }>>;
  // Recorded (not reversed) weight of the given signal rules since `since`.
  mismatchWeightSince?(accountId: string, rules: readonly string[], since: Date): Promise<number>;
  // Deletes reports older than `cutoff`, and passive reports older than `passiveCutoff`.
  deleteLocationReportsBefore(cutoff: Date, passiveCutoff?: Date): Promise<number>;
}

export type LandActionHold = Readonly<{
  holdUntil: Date | null;
  holdReason: LandActionHoldReason | null;
}>;

export type LandActionRecord = Readonly<{
  accountId: string;
  lat: number;
  lon: number;
  at: Date;
  regionCell: string;
  // UTC calendar day, YYYY-MM-DD.
  day: string;
}>;

export interface LandActionStore {
  loadLandActionHold(accountId: string): Promise<LandActionHold>;
  recordLandAction(record: LandActionRecord): Promise<void>;
}

export class PostgresLandActionStore implements LandActionStore {
  constructor(private readonly pool: pg.Pool) {}

  async loadLandActionHold(accountId: string): Promise<LandActionHold> {
    const result = await this.pool.query<{
      land_action_hold_until: Date | null;
      land_action_hold_reason: LandActionHoldReason | null;
    }>(
      `SELECT land_action_hold_until, land_action_hold_reason
         FROM account_location_state
        WHERE account_id = $1`,
      [accountId]
    );
    const row = result.rows[0];
    return {
      holdUntil: row?.land_action_hold_until ?? null,
      holdReason: row?.land_action_hold_reason ?? null
    };
  }

  async recordLandAction(record: LandActionRecord): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO account_location_state (
           account_id, last_land_action_at, last_land_action_lat, last_land_action_lon
         ) VALUES ($1, $2, $3, $4)
         ON CONFLICT (account_id) DO UPDATE
           SET last_land_action_at = EXCLUDED.last_land_action_at,
               last_land_action_lat = EXCLUDED.last_land_action_lat,
               last_land_action_lon = EXCLUDED.last_land_action_lon,
               updated_at = now()
         WHERE account_location_state.last_land_action_at IS NULL
            OR account_location_state.last_land_action_at <= EXCLUDED.last_land_action_at`,
        [record.accountId, record.at, record.lat, record.lon]
      );
      // The conflict row lock makes day counting exact under concurrency and replay.
      await client.query(
        `INSERT INTO account_regions (
           account_id, region_cell, interaction_days, first_seen_at, last_seen_at, last_counted_day
         ) VALUES ($1, $2, 1, $3, $3, $4::date)
         ON CONFLICT (account_id, region_cell) DO UPDATE
           SET interaction_days = account_regions.interaction_days
                 + CASE WHEN account_regions.last_counted_day < EXCLUDED.last_counted_day THEN 1 ELSE 0 END,
               last_counted_day = GREATEST(account_regions.last_counted_day, EXCLUDED.last_counted_day),
               last_seen_at = GREATEST(account_regions.last_seen_at, EXCLUDED.last_seen_at)`,
        [record.accountId, record.regionCell, record.at, record.day]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

type StateRow = {
  account_id: string | null;
  last_seq: string;
  last_accepted_report_id: string | null;
  last_fix_lat: number | null;
  last_fix_lon: number | null;
  last_fix_accuracy_m: number | null;
  last_fix_at: Date | null;
  last_land_action_at: Date | null;
  last_land_action_lat: number | null;
  last_land_action_lon: number | null;
  land_action_hold_until: Date | null;
  land_action_hold_reason: LandActionHoldReason | null;
  relocations_7d_far: number;
  home_lat?: number | null;
  home_lon?: number | null;
  home_source?: "passive" | "relocation" | null;
  far_relocations_since: string;
  stored_lat: number | null;
  stored_lon: number | null;
  stored_accuracy_m: number | null;
  stored_received_at: Date | null;
  stored_source: "relocation" | "passive" | null;
};

export class PostgresLocationReportStore implements LocationReportStore {
  constructor(private readonly pool: pg.Pool) {}

  async loadLocationContext(
    accountId: string,
    farSince: Date,
    farMinDistanceM: number
  ): Promise<LocationContext> {
    const result = await this.pool.query<StateRow>(
      `SELECT state.*,
              stored.lat AS stored_lat,
              stored.lon AS stored_lon,
              stored.accuracy_m AS stored_accuracy_m,
              stored.received_at AS stored_received_at,
              stored.source AS stored_source,
              (SELECT count(*)
                 FROM location_reports report
                WHERE report.account_id = $1
                  AND report.source = 'relocation'
                  AND report.verdict IN ('accepted', 'shadow_rejected')
                  AND report.received_at >= $2
                  AND report.distance_m >= $3) AS far_relocations_since
         FROM (SELECT $1::uuid AS lookup_id) lookup
         LEFT JOIN account_location_state state ON state.account_id = lookup.lookup_id
         LEFT JOIN location_reports stored ON stored.id = state.last_accepted_report_id`,
      [accountId, farSince, farMinDistanceM]
    );
    const row = result.rows[0];
    const farRelocationsSince = Number(row?.far_relocations_since ?? 0);
    if (!row || row.account_id === null) {
      return { state: null, farRelocationsSince };
    }
    return { state: mapState(row, row.account_id), farRelocationsSince };
  }

  async countHardMismatchFixes(accountId: string, since: Date): Promise<Readonly<{ ip: number; carrier: number }>> {
    const result = await this.pool.query<{ ip: string; carrier: string }>(
      `SELECT count(*) FILTER (WHERE features->>'hardIpMismatch' = 'true') AS ip,
              count(*) FILTER (WHERE features->>'hardCarrierMismatch' = 'true') AS carrier
         FROM location_reports
        WHERE account_id = $1 AND received_at >= $2`,
      [accountId, since]
    );
    return { ip: Number(result.rows[0]?.ip ?? 0), carrier: Number(result.rows[0]?.carrier ?? 0) };
  }

  async mismatchWeightSince(accountId: string, rules: readonly string[], since: Date): Promise<number> {
    const result = await this.pool.query<{ total: string | null }>(
      `SELECT sum(weight)::text AS total
         FROM account_trust_events
        WHERE account_id = $1 AND kind = 'signal' AND rule = ANY($2::text[])
          AND created_at >= $3 AND reversed_at IS NULL`,
      [accountId, rules, since]
    );
    return Number(result.rows[0]?.total ?? 0);
  }

  async recordLocationReport(
    row: LocationReportRow,
    accepted: AcceptedFixUpdate | null,
    settlement: SettlementFixUpdate | null = null
  ): Promise<RecordedLocationReport> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // The upsert row lock serializes seq assignment per account.
      const seqResult = await client.query<{ last_seq: string }>(
        `INSERT INTO account_location_state (account_id, last_seq)
         VALUES ($1, 1)
         ON CONFLICT (account_id) DO UPDATE
           SET last_seq = account_location_state.last_seq + 1,
               updated_at = now()
         RETURNING last_seq`,
        [row.accountId]
      );
      const seq = Number(seqResult.rows[0]!.last_seq);
      await client.query(
        `INSERT INTO location_reports (
           id, account_id, player_id, seq, source, request_id, lat, lon, accuracy_m,
           client_platform, device_installation_id, network_hash, network_prefix_hash,
           device_time_zone, received_at, prev_report_id, distance_m, elapsed_ms,
           implied_kmh, speed_bucket, verdict, verdict_reason, features, score, assurance,
           attestation_id
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
           (SELECT id FROM location_reports WHERE id = $16::uuid),
           $17, $18, $19, $20, $21, $22, $23::jsonb, $24, $25,
           (SELECT id FROM device_attestations WHERE id = $26::uuid)
         )`,
        [
          row.id,
          row.accountId,
          row.playerId,
          seq,
          row.source,
          row.requestId,
          row.lat,
          row.lon,
          row.accuracyM,
          row.clientPlatform,
          row.deviceInstallationId,
          row.networkHash,
          row.networkPrefixHash,
          row.deviceTimeZone,
          row.receivedAt,
          row.prevReportId,
          row.distanceM,
          row.elapsedMs,
          row.impliedKmh,
          row.speedBucket,
          row.verdict,
          row.verdictReason,
          JSON.stringify(row.features),
          row.score,
          row.assurance ?? null,
          row.attestationId ?? null
        ]
      );
      if (accepted) {
        // A longer hold already in force is never shortened. The first accepted
        // fix sets the home anchor (a relocation replaces a passive home once);
        // passive fixes near home confirm days.
        await client.query(
          `UPDATE account_location_state
              SET ${homeSql("$10", "$3", "$4", "$6")},
                  ${presenceDaySql("$11", "$12", "$6")},
                  last_accepted_report_id = $2,
                  last_fix_lat = $3,
                  last_fix_lon = $4,
                  last_fix_accuracy_m = $5,
                  last_fix_at = $6,
                  last_fix_assurance = $13,
                  land_action_hold_reason = CASE
                    WHEN $7::timestamptz IS NOT NULL
                     AND (land_action_hold_until IS NULL OR land_action_hold_until < $7::timestamptz)
                      THEN $8::text
                    ELSE land_action_hold_reason
                  END,
                  land_action_hold_until = CASE
                    WHEN $7::timestamptz IS NOT NULL
                     AND (land_action_hold_until IS NULL OR land_action_hold_until < $7::timestamptz)
                      THEN $7::timestamptz
                    ELSE land_action_hold_until
                  END,
                  relocations_7d_far = $9,
                  updated_at = now()
            WHERE account_id = $1`,
          [
            row.accountId,
            row.id,
            row.lat,
            row.lon,
            row.accuracyM,
            row.receivedAt,
            accepted.holdUntil,
            accepted.holdReason,
            accepted.relocations7dFar,
            row.source,
            accepted.presenceDay ?? null,
            accepted.confirmedDaysTarget ?? 1,
            row.assurance ?? null
          ]
        );
      }
      const settlementEvent = accepted && settlement
        ? await applySettlementFixInTransaction(client, row.accountId, settlement)
        : null;
      await client.query("COMMIT");
      return { reportId: row.id, seq, ...(settlementEvent ? { settlementEvent } : {}) };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async updateLastFix(fix: UnstoredFix): Promise<SettlementEvent | void> {
    // Never moves last_fix_* backwards in time.
    const text = `UPDATE account_location_state
          SET last_fix_lat = $2,
              last_fix_lon = $3,
              last_fix_accuracy_m = $4,
              last_fix_at = $5,
              last_fix_assurance = $8,
              ${homeSql("'passive'", "$2", "$3", "$5")},
              ${presenceDaySql("$6", "$7", "$5")},
              updated_at = now()
        WHERE account_id = $1
          AND (last_fix_at IS NULL OR last_fix_at <= $5)`;
    const values = [
      fix.accountId, fix.lat, fix.lon, fix.accuracyM, fix.at, fix.presenceDay ?? null,
      fix.confirmedDaysTarget ?? 1, fix.assurance ?? null
    ];
    if (!fix.settlement) {
      await this.pool.query(text, values);
      return;
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(text, values);
      const event = await applySettlementFixInTransaction(client, fix.accountId, fix.settlement);
      await client.query("COMMIT");
      return event;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async deleteLocationReportsBefore(cutoff: Date, passiveCutoff: Date = cutoff): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM location_reports
        WHERE received_at < $1
           OR (source = 'passive' AND received_at < $2)`,
      [cutoff, passiveCutoff]
    );
    return result.rowCount ?? 0;
  }
}

function mapState(row: StateRow, accountId: string): AccountLocationState {
  const lastStoredFix =
    row.stored_lat !== null && row.stored_lon !== null && row.stored_received_at !== null
      ? {
          lat: row.stored_lat,
          lon: row.stored_lon,
          accuracyM: row.stored_accuracy_m,
          at: row.stored_received_at
        }
      : null;
  // last_fix_* is either the stored report's fix or a newer unstored passive fix.
  const lastFixPassive = row.last_fix_at !== null && (
    lastStoredFix === null
    || row.stored_source === "passive"
    || lastStoredFix.at.getTime() !== row.last_fix_at.getTime()
  );
  return {
    accountId,
    lastSeq: Number(row.last_seq),
    lastAcceptedReportId: row.last_accepted_report_id,
    lastFix:
      row.last_fix_lat !== null && row.last_fix_lon !== null && row.last_fix_at !== null
        ? {
            lat: row.last_fix_lat,
            lon: row.last_fix_lon,
            accuracyM: row.last_fix_accuracy_m,
            at: row.last_fix_at
          }
        : null,
    lastLandAction:
      row.last_land_action_lat !== null && row.last_land_action_lon !== null && row.last_land_action_at !== null
        ? {
            lat: row.last_land_action_lat,
            lon: row.last_land_action_lon,
            at: row.last_land_action_at
          }
        : null,
    landActionHoldUntil: row.land_action_hold_until,
    landActionHoldReason: row.land_action_hold_reason,
    relocations7dFar: row.relocations_7d_far,
    home: row.home_lat !== null && row.home_lat !== undefined && row.home_lon !== null && row.home_lon !== undefined
      ? { lat: row.home_lat, lon: row.home_lon, source: row.home_source ?? "relocation" }
      : null,
    lastFixPassive,
    lastStoredFix
  };
}

export type TrustSignalInput = Readonly<{
  rule: string;
  weight: number;
  metadata: Record<string, unknown>;
  dedupeKey: string | null;
}>;

export type TrustLadderConfig = Readonly<{
  // false when TRUST_QUARANTINE_MODE=off: no tiers are computed.
  computeTiers: boolean;
  thresholds: LadderThresholds;
}>;

export type ApplySignalsInput = Readonly<{
  accountId: string;
  reportId: string | null;
  signals: ReadonlyArray<TrustSignalInput>;
  now: Date;
  tauDays: number;
  ladder: TrustLadderConfig;
  // With no signals, only refresh decay and tier when a state row exists.
}>;

export type ApplySignalsResult = Readonly<{
  logodds: number;
  effective: number;
  shadowTier: number;
  applied: number;
}>;

export type AccountTrustContext = Readonly<{
  trustTier: AccountTrustTier;
  createdAt: Date;
  riskScore: number;
  providers: ReadonlyArray<Readonly<{ provider: string; email: string | null }>>;
  logodds: number;
  logoddsUpdatedAt: Date | null;
  loginDays: number;
}>;

export interface TrustStateStore {
  applySignals(input: ApplySignalsInput): Promise<ApplySignalsResult | null>;
  recomputeLogodds(accountId: string, now: Date, tauDays: number, db?: Queryable): Promise<number>;
  hasFamiliarCell(accountId: string, cells: readonly string[], minDays: number, seenSince: Date): Promise<boolean>;
  loadAccountTrustContext(accountId: string): Promise<AccountTrustContext | null>;
  promoteTrustTier(accountId: string, to: "standard", now: Date, metadata: Record<string, unknown>): Promise<boolean>;
}

export type Queryable = Pick<pg.PoolClient, "query">;

type TrustStateRow = {
  logodds: number;
  logodds_updated_at: Date;
  peak_logodds: number;
  shadow_tier: number;
  tier_entered_at: Date | null;
  tier_exit_eligible_at: Date | null;
};

export class PostgresTrustStateStore implements TrustStateStore {
  constructor(private readonly pool: pg.Pool) {}

  async applySignals(input: ApplySignalsInput): Promise<ApplySignalsResult | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (input.signals.length > 0) {
        await client.query(
          `INSERT INTO account_trust_state (account_id, logodds_updated_at)
           VALUES ($1, $2)
           ON CONFLICT (account_id) DO NOTHING`,
          [input.accountId, input.now]
        );
      }
      // The row lock serializes every score change for this account.
      const stateResult = await client.query<TrustStateRow>(
        `SELECT logodds, logodds_updated_at, peak_logodds, shadow_tier,
                tier_entered_at, tier_exit_eligible_at
           FROM account_trust_state
          WHERE account_id = $1
          FOR UPDATE`,
        [input.accountId]
      );
      const state = stateResult.rows[0];
      if (!state) {
        await client.query("ROLLBACK");
        return null;
      }
      let running = decayLogodds(state.logodds, state.logodds_updated_at, input.now, input.tauDays);
      let peak = state.peak_logodds;
      let applied = 0;
      for (const signal of input.signals) {
        const next = running + signal.weight;
        const inserted = await client.query(
          `INSERT INTO account_trust_events (
             id, account_id, kind, rule, weight, logodds_after, location_report_id,
             dedupe_key, metadata, created_at
           ) VALUES (
             $1, $2, 'signal', $3, $4, $5,
             (SELECT id FROM location_reports WHERE id = $6::uuid),
             $7, $8::jsonb, $9
           )
           ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
          [
            randomUUID(),
            input.accountId,
            signal.rule,
            signal.weight,
            next,
            input.reportId,
            signal.dedupeKey,
            JSON.stringify(signal.metadata),
            input.now
          ]
        );
        if ((inserted.rowCount ?? 0) === 0) continue;
        running = next;
        peak = Math.max(peak, running);
        applied += 1;
      }

      const context = await loadAccountContext(client, input.accountId);
      const effective = running + (context
        ? staticPrior({ providers: context.providers, createdAt: context.createdAt, riskScore: context.riskScore, now: input.now })
        : 0);
      let tierState = {
        tier: state.shadow_tier,
        enteredAt: state.tier_entered_at,
        exitEligibleAt: state.tier_exit_eligible_at
      };
      if (input.ladder.computeTiers && context) {
        const target = shadowTierFor(effective, context.trustTier, input.ladder.thresholds);
        const next = nextShadowTier(tierState, target, input.now);
        if (next.changed) {
          await client.query(
            `INSERT INTO account_trust_events (
               id, account_id, kind, rule, weight, logodds_after, metadata, created_at
             ) VALUES ($1, $2, 'shadow_tier_change', 'shadow_tier', 0, $3, $4::jsonb, $5)`,
            [
              randomUUID(),
              input.accountId,
              running,
              JSON.stringify({ from: tierState.tier, to: next.tier, effective }),
              input.now
            ]
          );
        }
        tierState = { tier: next.tier, enteredAt: next.enteredAt, exitEligibleAt: next.exitEligibleAt };
      }
      await client.query(
        `UPDATE account_trust_state
            SET logodds = $2,
                logodds_updated_at = $3,
                peak_logodds = $4,
                shadow_tier = $5,
                tier_entered_at = $6,
                tier_exit_eligible_at = $7,
                updated_at = now()
          WHERE account_id = $1`,
        [
          input.accountId,
          running,
          input.now,
          peak,
          tierState.tier,
          tierState.enteredAt,
          tierState.exitEligibleAt
        ]
      );
      await client.query("COMMIT");
      return { logodds: running, effective, shadowTier: tierState.tier, applied };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  // Sum of unreversed signals, each decayed from its own time: equals the
  // incrementally maintained logodds at the same instant.
  async recomputeLogodds(accountId: string, now: Date, tauDays: number, db?: Queryable): Promise<number> {
    const result = await (db ?? this.pool).query<{ weight: number; created_at: Date }>(
      `SELECT weight, created_at
         FROM account_trust_events
        WHERE account_id = $1 AND kind = 'signal' AND reversed_at IS NULL`,
      [accountId]
    );
    return result.rows.reduce(
      (total, row) => total + decayLogodds(row.weight, row.created_at, now, tauDays),
      0
    );
  }

  async hasFamiliarCell(
    accountId: string,
    cells: readonly string[],
    minDays: number,
    seenSince: Date
  ): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1
         FROM account_regions
        WHERE account_id = $1
          AND region_cell = ANY($2::text[])
          AND interaction_days >= $3
          AND last_seen_at >= $4
        LIMIT 1`,
      [accountId, cells, minDays, seenSince]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async loadAccountTrustContext(accountId: string): Promise<AccountTrustContext | null> {
    const context = await loadAccountContext(this.pool, accountId);
    if (!context) return null;
    const [state, loginDays] = await Promise.all([
      this.pool.query<{ logodds: number; logodds_updated_at: Date }>(
        "SELECT logodds, logodds_updated_at FROM account_trust_state WHERE account_id = $1",
        [accountId]
      ),
      this.pool.query<{ days: number }>(
        `SELECT count(DISTINCT (created_at AT TIME ZONE 'UTC')::date)::int AS days
           FROM auth_events
          WHERE account_id = $1 AND event_type LIKE '%login\\_success'`,
        [accountId]
      )
    ]);
    return {
      ...context,
      logodds: state.rows[0]?.logodds ?? 0,
      logoddsUpdatedAt: state.rows[0]?.logodds_updated_at ?? null,
      loginDays: loginDays.rows[0]?.days ?? 0
    };
  }

  async promoteTrustTier(
    accountId: string,
    to: "standard",
    now: Date,
    metadata: Record<string, unknown>
  ): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query(
        "UPDATE accounts SET trust_tier = $2 WHERE id = $1 AND trust_tier = 'new'",
        [accountId, to]
      );
      if ((updated.rowCount ?? 0) === 0) {
        await client.query("ROLLBACK");
        return false;
      }
      await client.query(
        `INSERT INTO account_trust_events (
           id, account_id, kind, rule, weight, logodds_after, metadata, created_at
         ) VALUES ($1, $2, 'note', 'trust_tier_promotion', 0,
           COALESCE((SELECT logodds FROM account_trust_state WHERE account_id = $2), 0),
           $3::jsonb, $4)`,
        [randomUUID(), accountId, JSON.stringify({ from: "new", to, ...metadata }), now]
      );
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

async function loadAccountContext(
  db: Queryable,
  accountId: string
): Promise<Pick<AccountTrustContext, "trustTier" | "createdAt" | "riskScore" | "providers"> | null> {
  const result = await db.query<{
    trust_tier: AccountTrustTier;
    created_at: Date;
    risk_score: number;
    providers: Array<{ provider: string; email: string | null }> | null;
  }>(
    `SELECT a.trust_tier, a.created_at, a.risk_score,
            (SELECT json_agg(json_build_object('provider', i.provider, 'email', i.email))
               FROM account_identities i
              WHERE i.account_id = a.id) AS providers
       FROM accounts a
      WHERE a.id = $1`,
    [accountId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    trustTier: row.trust_tier,
    createdAt: row.created_at,
    riskScore: row.risk_score,
    providers: row.providers ?? []
  };
}

export type TrustAdminStore = {
  listTopAccounts(input: Readonly<{
    limit: number;
    minLogodds: number;
    now: Date;
    tauDays: number;
  }>): Promise<TrustAdminAccountSummary[]>;
  accountDetail(accountId: string, now: Date, tauDays: number): Promise<TrustAdminAccountDetail | null>;
};

type AdminAccountRow = {
  account_id: string;
  player_name: string | null;
  trust_tier: AccountTrustTier;
  created_at: Date;
  risk_score: number;
  providers: Array<{ provider: string; email: string | null }> | null;
  logodds: number | null;
  logodds_updated_at: Date | null;
  peak_logodds: number | null;
  shadow_tier: number | null;
  last_signal_at: Date | null;
};

const ADMIN_ACCOUNT_SELECT = `
  SELECT a.id AS account_id,
         (SELECT p.username FROM players p WHERE p.account_id = a.id LIMIT 1) AS player_name,
         a.trust_tier, a.created_at, a.risk_score,
         (SELECT json_agg(json_build_object('provider', i.provider, 'email', i.email))
            FROM account_identities i WHERE i.account_id = a.id) AS providers,
         s.logodds, s.logodds_updated_at, s.peak_logodds, s.shadow_tier,
         (SELECT max(e.created_at) FROM account_trust_events e
           WHERE e.account_id = a.id AND e.kind = 'signal') AS last_signal_at
    FROM accounts a
    LEFT JOIN account_trust_state s ON s.account_id = a.id`;

function summaryFromRow(row: AdminAccountRow, now: Date, tauDays: number): TrustAdminAccountSummary {
  const decayed = row.logodds !== null && row.logodds_updated_at
    ? decayLogodds(row.logodds, row.logodds_updated_at, now, tauDays)
    : 0;
  const providers = row.providers ?? [];
  const prior = staticPrior({ providers, createdAt: row.created_at, riskScore: row.risk_score, now });
  return {
    accountId: row.account_id,
    playerName: row.player_name,
    trustTier: row.trust_tier,
    shadowTier: row.shadow_tier ?? 0,
    effectiveLogodds: decayed + prior,
    decayedLogodds: decayed,
    priorLogodds: prior,
    peakLogodds: row.peak_logodds ?? 0,
    providers: [...new Set(providers.map((entry) => entry.provider))].sort(),
    createdAt: row.created_at.toISOString(),
    lastSignalAt: row.last_signal_at?.toISOString() ?? null
  };
}

const ADMIN_ARRIVAL_LIMIT = 100;
const ADMIN_ATTESTATION_LIMIT = 20;
const ADMIN_ENVIRONMENT_LIMIT = 20;
// Account links shown on the admin detail (install id or login device, both directions).
const ADMIN_LINK_WINDOW_DAYS = 365;

type EnvironmentRow = {
  id: string; platform: string; install_id_hash: string; install_id_persistent: boolean | null;
  install_source: string | null; emulator_hints: string[]; root_hints: string[]; debugger_attached: boolean | null;
  dev_options: boolean | null; adb_enabled: boolean | null; auto_time_enabled: boolean | null; vpn_active: boolean | null;
  sim_country: string | null; network_country: string | null; cell_countries: string[]; time_zone_countries: string[];
  locale_country: string | null; gps_countries: string[]; play_integrity: Record<string, unknown> | null;
  devicecheck_bit0: boolean | null; created_at: Date;
};

function roundedHome(lat: number | null, lon: number | null): { lat: number; lon: number } | null {
  return lat !== null && lon !== null
    ? { lat: roundAlertCoordinate(lat), lon: roundAlertCoordinate(lon) }
    : null;
}

export class PostgresTrustAdminStore implements TrustAdminStore {
  private readonly arrivals: PostgresTrustArrivalStore;

  constructor(private readonly pool: pg.Pool) {
    this.arrivals = new PostgresTrustArrivalStore(pool);
  }

  // Candidates are pre-ranked in SQL by decayed score plus the risk-score
  // prior (the cheap part of the prior), then ranked exactly in memory.
  async listTopAccounts(input: Readonly<{
    limit: number;
    minLogodds: number;
    now: Date;
    tauDays: number;
  }>): Promise<TrustAdminAccountSummary[]> {
    const result = await this.pool.query<AdminAccountRow>(
      `${ADMIN_ACCOUNT_SELECT}
       ORDER BY (COALESCE(s.logodds * exp(-GREATEST(0, extract(epoch FROM ($1::timestamptz - s.logodds_updated_at))) / ($2::float8 * 86400)), 0)
                 + a.risk_score / 25.0) DESC,
                a.id
       LIMIT $3`,
      [input.now, input.tauDays, Math.min(1000, Math.max(input.limit * 4, 200))]
    );
    return result.rows
      .map((row) => summaryFromRow(row, input.now, input.tauDays))
      .filter((summary) => summary.effectiveLogodds >= input.minLogodds)
      .sort((a, b) => b.effectiveLogodds - a.effectiveLogodds || a.accountId.localeCompare(b.accountId))
      .slice(0, input.limit);
  }

  async accountDetail(accountId: string, now: Date, tauDays: number): Promise<TrustAdminAccountDetail | null> {
    const account = await this.pool.query<AdminAccountRow>(`${ADMIN_ACCOUNT_SELECT} WHERE a.id = $1`, [accountId]);
    const row = account.rows[0];
    if (!row) return null;
    const arrivalSince = new Date(now.getTime() - ARRIVAL_RETENTION_DAYS * 24 * 60 * 60_000);
    const [events, reports, hold, settlement, attestations, broughtBy, broughtIn] = await Promise.all([
      this.pool.query<{
        id: string; kind: TrustAdminEventView["kind"]; rule: string; weight: number;
        logodds_after: number; created_at: Date; reversed_at: Date | null; metadata: Record<string, unknown>;
      }>(
        `SELECT id, kind, rule, weight, logodds_after, created_at, reversed_at, metadata
           FROM account_trust_events WHERE account_id = $1
          ORDER BY created_at DESC, id LIMIT 100`,
        [accountId]
      ),
      this.pool.query<{
        id: string; received_at: Date; source: "relocation" | "passive"; lat: number; lon: number;
        accuracy_m: number | null; speed_bucket: string | null; implied_kmh: number | null;
        distance_m: number | null; verdict: string; verdict_reason: string | null; score: number;
      }>(
        `SELECT id, received_at, source, lat, lon, accuracy_m, speed_bucket, implied_kmh,
                distance_m, verdict, verdict_reason, score
           FROM location_reports WHERE account_id = $1
          ORDER BY received_at DESC, id LIMIT 20`,
        [accountId]
      ),
      this.pool.query<{
        land_action_hold_until: Date | null;
        land_action_hold_reason: string | null;
        last_fix_assurance: string | null;
      }>(
        `SELECT land_action_hold_until, land_action_hold_reason, last_fix_assurance
           FROM account_location_state WHERE account_id = $1`,
        [accountId]
      ),
      this.pool.query<{
        home_lat: number | null; home_lon: number | null;
        settled_home_lat: number | null; settled_home_lon: number | null;
        difficulty: string | number; target_checks: number; target_days: number;
        counted_checks: number; counted_days: number; distinct_positions: number;
        settled_at: Date | null; provisional_until: Date | null;
        unsettled_at: Date | null; unsettle_reason: string | null;
      }>(
        `SELECT home_lat, home_lon, settled_home_lat, settled_home_lon, difficulty, target_checks,
                target_days, counted_checks, counted_days, distinct_positions, settled_at,
                provisional_until, unsettled_at, unsettle_reason
           FROM account_settlement WHERE account_id = $1`,
        [accountId]
      ),
      this.pool.query<{
        id: string; method: string; outcome: string; assurance: string;
        reason: string | null; created_at: Date;
      }>(
        `SELECT id::text, method, outcome, assurance, reason, created_at
           FROM device_attestations WHERE account_id = $1
          ORDER BY created_at DESC, id LIMIT $2`,
        [accountId, ADMIN_ATTESTATION_LIMIT]
      ),
      this.arrivals.arrivalsBroughtIn(accountId, arrivalSince, ADMIN_ARRIVAL_LIMIT),
      this.arrivals.arrivalsBroughtBy(accountId, arrivalSince, ADMIN_ARRIVAL_LIMIT)
    ]);
    const { environments, linked } = await this.environmentDetail(accountId);
    const linkSince = new Date(now.getTime() - ADMIN_LINK_WINDOW_DAYS * 24 * 60 * 60_000);
    const [accountLinks, nativeInstalls] = await Promise.all([
      queryLinkedAccounts(this.pool, accountId, linkSince, ADMIN_ENVIRONMENT_LIMIT),
      this.pool.query<{ n: string }>(
        "SELECT count(DISTINCT install_id_hash)::text AS n FROM device_environment_reports WHERE account_id = $1 AND created_at >= $2",
        [accountId, linkSince]
      )
    ]);
    const names = await this.playerNames([
      ...broughtBy.map((arrival) => arrival.hostAccountId),
      ...broughtIn.map((arrival) => arrival.guestAccountId),
      ...linked.map((entry) => entry.account_id),
      ...accountLinks.map((entry) => entry.accountId)
    ]);
    const settlementRow = settlement.rows[0];
    const settlementView: TrustAdminSettlementView | null = settlementRow
      ? {
          settled: isSettledNow(
            { settledAt: settlementRow.settled_at, provisionalUntil: settlementRow.provisional_until },
            now
          ),
          settledAt: settlementRow.settled_at?.toISOString() ?? null,
          provisionalUntil: settlementRow.provisional_until?.toISOString() ?? null,
          home: roundedHome(settlementRow.home_lat, settlementRow.home_lon),
          settledHome: roundedHome(settlementRow.settled_home_lat, settlementRow.settled_home_lon),
          difficulty: Number(settlementRow.difficulty),
          targetChecks: settlementRow.target_checks,
          targetDays: settlementRow.target_days,
          countedChecks: settlementRow.counted_checks,
          countedDays: settlementRow.counted_days,
          distinctPositions: settlementRow.distinct_positions,
          unsettledAt: settlementRow.unsettled_at?.toISOString() ?? null,
          unsettleReason: settlementRow.unsettle_reason
        }
      : null;
    const arrivalView = (arrival: ArrivalRecord, otherAccountId: string): TrustAdminArrivalView => ({
      id: arrival.id,
      otherAccountId,
      otherPlayerName: names.get(otherAccountId) ?? null,
      kind: arrival.kind,
      lat: arrival.latRounded,
      lon: arrival.lonRounded,
      createdAt: arrival.createdAt.toISOString()
    });
    return {
      ...summaryFromRow(row, now, tauDays),
      landActionHoldUntil: hold.rows[0]?.land_action_hold_until?.toISOString() ?? null,
      landActionHoldReason: hold.rows[0]?.land_action_hold_reason ?? null,
      lastFixAssurance: hold.rows[0]?.last_fix_assurance ?? null,
      settlement: settlementView,
      attestations: attestations.rows.map((row): TrustAdminAttestationView => ({
        id: row.id,
        method: row.method,
        outcome: row.outcome,
        assurance: row.assurance,
        reason: row.reason,
        createdAt: row.created_at.toISOString()
      })),
      environments: environments.map((env): TrustAdminEnvironmentView => ({
        id: env.id,
        platform: env.platform,
        installIdHash: env.install_id_hash.slice(0, 16),
        installIdPersistent: env.install_id_persistent,
        installSource: env.install_source,
        emulatorHints: env.emulator_hints,
        rootHints: env.root_hints,
        debuggerAttached: env.debugger_attached,
        devOptions: env.dev_options,
        adbEnabled: env.adb_enabled,
        autoTimeEnabled: env.auto_time_enabled,
        vpnActive: env.vpn_active,
        simCountry: env.sim_country,
        networkCountry: env.network_country,
        cellCountries: env.cell_countries,
        timeZoneCountries: env.time_zone_countries,
        localeCountry: env.locale_country,
        gpsCountries: env.gps_countries,
        playIntegrity: env.play_integrity,
        deviceCheckBit0: env.devicecheck_bit0,
        createdAt: env.created_at.toISOString()
      })),
      installLinkedAccounts: linked.map((entry) => ({
        accountId: entry.account_id,
        playerName: names.get(entry.account_id) ?? null,
        lastSeenAt: entry.last_seen_at.toISOString()
      })),
      linkedAccounts: accountLinks.map((entry) => ({
        accountId: entry.accountId,
        playerName: names.get(entry.accountId) ?? null,
        via: entry.via,
        lastSeenAt: entry.lastSeenAt.toISOString()
      })),
      nativeDeviceCount: Number(nativeInstalls.rows[0]?.n ?? 0),
      broughtBy: broughtBy.map((arrival) => arrivalView(arrival, arrival.hostAccountId)),
      broughtIn: broughtIn.map((arrival) => arrivalView(arrival, arrival.guestAccountId)),
      events: events.rows.map((event): TrustAdminEventView => ({
        id: event.id,
        kind: event.kind,
        rule: event.rule,
        weight: event.weight,
        logoddsAfter: event.logodds_after,
        createdAt: event.created_at.toISOString(),
        reversedAt: event.reversed_at?.toISOString() ?? null,
        metadata: event.metadata
      })),
      locationReports: reports.rows.map((report): TrustAdminLocationReportView => ({
        id: report.id,
        receivedAt: report.received_at.toISOString(),
        source: report.source,
        lat: report.lat,
        lon: report.lon,
        accuracyM: report.accuracy_m,
        speedBucket: report.speed_bucket,
        impliedKmh: report.implied_kmh,
        distanceM: report.distance_m,
        verdict: report.verdict,
        verdictReason: report.verdict_reason,
        score: report.score
      }))
    };
  }

  // Newest environment summaries and other accounts on the same install ids (plan §8.9).
  private async environmentDetail(accountId: string): Promise<{
    environments: EnvironmentRow[];
    linked: Array<{ account_id: string; last_seen_at: Date }>;
  }> {
    const environments = await this.pool.query<EnvironmentRow>(
      `SELECT id::text, platform, install_id_hash, install_id_persistent, install_source, emulator_hints, root_hints,
              debugger_attached, dev_options, adb_enabled, auto_time_enabled, vpn_active, sim_country, network_country,
              cell_countries, time_zone_countries, locale_country, gps_countries, play_integrity, devicecheck_bit0, created_at
         FROM device_environment_reports WHERE account_id = $1
        ORDER BY created_at DESC, id LIMIT $2`,
      [accountId, ADMIN_ENVIRONMENT_LIMIT]
    );
    const linked = await this.pool.query<{ account_id: string; last_seen_at: Date }>(
      `SELECT other.account_id::text AS account_id, max(other.created_at) AS last_seen_at
         FROM device_environment_reports other
        WHERE other.install_id_hash IN (
                SELECT DISTINCT install_id_hash FROM device_environment_reports WHERE account_id = $1)
          AND other.account_id <> $1
        GROUP BY other.account_id
        ORDER BY last_seen_at DESC LIMIT $2`,
      [accountId, ADMIN_ENVIRONMENT_LIMIT]
    );
    return { environments: environments.rows, linked: linked.rows };
  }

  private async playerNames(accountIds: readonly string[]): Promise<Map<string, string>> {
    const unique = [...new Set(accountIds)];
    if (unique.length === 0) return new Map();
    const result = await this.pool.query<{ account_id: string; username: string }>(
      "SELECT account_id::text AS account_id, username FROM players WHERE account_id = ANY($1::uuid[])",
      [unique]
    );
    return new Map(result.rows.map((row) => [row.account_id, row.username]));
  }
}

// Alt doorway reads/writes (migrations 0884, 0911, 0912). Keyed by player id:
// travel code knows players, and players.account_id is unique.
export class PostgresAltDoorwayStore implements AltDoorwayStore {
  constructor(private readonly pool: pg.Pool) {}

  async loadDoorwayPlayer(playerId: string): Promise<DoorwayPlayerRecord | null> {
    const result = await this.pool.query<{
      account_id: string | null;
      account_created_at: Date | null;
      dev_profile: boolean;
      last_fix_lat: number | null;
      last_fix_lon: number | null;
      last_fix_at: Date | null;
      last_fix_assurance: LocationFixAssurance | null;
      last_relocated_at: Date | null;
      settled_at: Date | null;
      provisional_until: Date | null;
      settled_home_lat: number | null;
      settled_home_lon: number | null;
    }>(
      `SELECT p.account_id, a.created_at AS account_created_at, p.last_relocated_at,
              s.last_fix_lat, s.last_fix_lon, s.last_fix_at, s.last_fix_assurance,
              st.settled_at, st.provisional_until, st.settled_home_lat, st.settled_home_lon,
              EXISTS (
                SELECT 1 FROM account_identities i
                 WHERE i.account_id = p.account_id
                   AND i.provider_subject LIKE 'ash-atlas-dev:%'
              ) AS dev_profile
         FROM players p
         LEFT JOIN accounts a ON a.id = p.account_id
         LEFT JOIN account_location_state s ON s.account_id = p.account_id
         LEFT JOIN account_settlement st ON st.account_id = p.account_id
        WHERE p.id = $1`,
      [playerId]
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      accountId: row.account_id,
      accountCreatedAt: row.account_created_at,
      devProfile: row.dev_profile,
      settled: isSettledNow({ settledAt: row.settled_at, provisionalUntil: row.provisional_until }, new Date()),
      settledHome: row.settled_home_lat !== null && row.settled_home_lon !== null
        ? { lat: row.settled_home_lat, lon: row.settled_home_lon }
        : null,
      lastFix: row.last_fix_lat !== null && row.last_fix_lon !== null && row.last_fix_at !== null
        ? { lat: row.last_fix_lat, lon: row.last_fix_lon, at: row.last_fix_at }
        : null,
      lastFixAssurance: row.last_fix_assurance,
      lastRelocatedAt: row.last_relocated_at
    };
  }

  async ownedDestinationPosition(
    playerId: string,
    destination: Readonly<{ kind: "flag" | "kingdom_seat"; id: string }>
  ): Promise<LatLon | null> {
    const result = destination.kind === "flag"
      ? await this.pool.query<{ lat: number; lon: number }>(
          "SELECT lat, lon FROM flags WHERE id = $1::uuid AND owner_id = $2",
          [destination.id, playerId]
        )
      : await this.pool.query<{ lat: number; lon: number }>(
          `SELECT seat.lat, seat.lon
             FROM kingdom_seats seat
             JOIN kingdoms k ON k.id = seat.kingdom_id
            WHERE seat.id = $1::uuid AND k.founder_player_id = $2`,
          [destination.id, playerId]
        );
    const row = result.rows[0];
    return row ? { lat: row.lat, lon: row.lon } : null;
  }

  async linkedAccounts(
    accountId: string,
    otherAccountId: string,
    networkSince: Date
  ): Promise<Readonly<{ device: boolean; network: boolean }>> {
    const result = await this.pool.query<{ device: boolean; network: boolean }>(
      `SELECT EXISTS (
                SELECT 1
                  FROM account_device_links mine
                  JOIN account_device_links theirs
                    ON theirs.device_installation_id = mine.device_installation_id
                 WHERE mine.account_id = $1 AND theirs.account_id = $2
              ) AS device,
              EXISTS (
                SELECT 1
                  FROM auth_events mine
                  JOIN auth_events theirs
                    ON theirs.network_prefix_hash = mine.network_prefix_hash
                 WHERE mine.account_id = $1
                   AND theirs.account_id = $2
                   AND mine.network_prefix_hash IS NOT NULL
                   AND mine.created_at >= $3
                   AND theirs.created_at >= $3
              ) AS network`,
      [accountId, otherAccountId, networkSince]
    );
    return { device: result.rows[0]?.device === true, network: result.rows[0]?.network === true };
  }

  async sharedPrefixAsnClasses(
    accountId: string,
    otherAccountId: string,
    since: Date
  ): Promise<ReadonlyArray<string | null>> {
    const result = await this.pool.query<{ asn_class: string | null }>(
      `WITH shared AS (
         SELECT DISTINCT mine.network_prefix_hash AS prefix_hash
           FROM auth_events mine
           JOIN auth_events theirs ON theirs.network_prefix_hash = mine.network_prefix_hash
          WHERE mine.account_id = $1
            AND theirs.account_id = $2
            AND mine.network_prefix_hash IS NOT NULL
            AND mine.created_at >= $3
            AND theirs.created_at >= $3
       )
       SELECT (SELECT report.features->>'ipAsnClass'
                 FROM location_reports report
                WHERE report.account_id IN ($1, $2)
                  AND report.network_prefix_hash = shared.prefix_hash
                  AND report.features->>'ipAsnClass' IS NOT NULL
                ORDER BY report.received_at DESC
                LIMIT 1) AS asn_class
         FROM shared`,
      [accountId, otherAccountId, since]
    );
    return result.rows.map((row) => row.asn_class);
  }

  async loadArrivalHold(playerId: string): Promise<Date | null> {
    const result = await this.pool.query<{ arrival_raid_hold_until: Date | null }>(
      `SELECT s.arrival_raid_hold_until
         FROM players p
         JOIN account_location_state s ON s.account_id = p.account_id
        WHERE p.id = $1`,
      [playerId]
    );
    return result.rows[0]?.arrival_raid_hold_until ?? null;
  }

  async setArrivalHold(playerId: string, until: Date): Promise<void> {
    // Never shortens a later hold.
    await this.pool.query(
      `INSERT INTO account_location_state (account_id, arrival_raid_hold_until)
       SELECT p.account_id, $2::timestamptz
         FROM players p
        WHERE p.id = $1 AND p.account_id IS NOT NULL
       ON CONFLICT (account_id) DO UPDATE
         SET arrival_raid_hold_until = GREATEST(
               account_location_state.arrival_raid_hold_until,
               EXCLUDED.arrival_raid_hold_until
             ),
             updated_at = now()`,
      [playerId, until]
    );
  }

  async playerOwnsFlag(playerId: string, flagId: string): Promise<boolean> {
    const result = await this.pool.query(
      "SELECT 1 FROM flags WHERE id = $1::uuid AND owner_id = $2",
      [flagId, playerId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async isDevProfile(accountId: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1 FROM account_identities
        WHERE account_id = $1 AND provider_subject LIKE 'ash-atlas-dev:%'
        LIMIT 1`,
      [accountId]
    );
    return (result.rowCount ?? 0) > 0;
  }
}

export type OwnerSettlementRecord = Readonly<{
  settledAt: Date | null;
  provisionalUntil: Date | null;
  settledHome: LatLon | null;
}>;

// Alert-zone and anchoring reads (plan 3.3, 4.2). Flags are owned by player id;
// players.account_id is unique, so one account is at most one player.
export class PostgresTrustZoneStore {
  constructor(private readonly pool: pg.Pool) {}

  // Distinct other accounts owning a flag or its claim within radiusKm of the
  // point. flags_geography_gix serves the bounding prefilter (radius plus the
  // 10 km maximum claim radius, flags_claim_radius_m_domain); the exact test
  // then measures to the edge of each claim.
  async yellowOwners(
    lat: number,
    lon: number,
    radiusKm: number,
    excludeAccountId: string | null,
    limit = 50
  ): Promise<string[]> {
    const radiusM = radiusKm * 1000;
    const result = await this.pool.query<{ account_id: string }>(
      `WITH target AS (SELECT ST_SetSRID(ST_MakePoint($2::double precision, $1::double precision), 4326)::geography AS point)
       SELECT DISTINCT p.account_id
         FROM flags f
         CROSS JOIN target
         JOIN players p ON p.id = f.owner_id
        WHERE ST_DWithin(f.geom::geography, target.point, $3::double precision + 10000)
          AND ST_Distance(f.geom::geography, target.point) <= $3::double precision + f.claim_radius_m
          AND p.account_id IS NOT NULL
          AND ($4::uuid IS NULL OR p.account_id <> $4::uuid)
        ORDER BY p.account_id
        LIMIT $5`,
      [lat, lon, radiusM, excludeAccountId, limit]
    );
    return result.rows.map((row) => row.account_id);
  }

  // Distinct other accounts whose kingdom is within radiusKm of the point: the
  // founder of a kingdom whose seat territory is in range, and the owners of
  // kingdom flags whose claim is in range (plan 4.2, owner decision B).
  async kingdomOwners(
    lat: number,
    lon: number,
    radiusKm: number,
    excludeAccountId: string | null,
    limit = 25
  ): Promise<string[]> {
    const radiusM = radiusKm * 1000;
    const result = await this.pool.query<{ account_id: string }>(
      `WITH target AS (SELECT ST_SetSRID(ST_MakePoint($2::double precision, $1::double precision), 4326)::geography AS point),
       nearby AS (
         SELECT k.founder_player_id AS player_id
           FROM kingdom_seats seat
           JOIN kingdoms k ON k.id = seat.kingdom_id
           CROSS JOIN target
          WHERE ST_DWithin(seat.geom::geography, target.point, $3::double precision + seat.territory_radius_m)
         UNION
         SELECT p.id
           FROM flags f
           CROSS JOIN target
           LEFT JOIN kingdoms k ON k.id = f.kingdom_id
           JOIN players p ON p.id IN (f.owner_id, k.founder_player_id)
          WHERE (f.control_type IN ('kingdom', 'kingdom_seat') OR f.kingdom_id IS NOT NULL)
            AND ST_DWithin(f.geom::geography, target.point, $3::double precision + 10000)
            AND ST_Distance(f.geom::geography, target.point) <= $3::double precision + f.claim_radius_m)
       SELECT DISTINCT p.account_id
         FROM nearby
         JOIN players p ON p.id = nearby.player_id
        WHERE p.account_id IS NOT NULL
          AND ($4::uuid IS NULL OR p.account_id <> $4::uuid)
        ORDER BY p.account_id
        LIMIT $5`,
      [lat, lon, radiusM, excludeAccountId, limit]
    );
    return result.rows.map((row) => row.account_id);
  }

  async loadOwnerSettlement(accountId: string): Promise<OwnerSettlementRecord | null> {
    const result = await this.pool.query<{
      settled_at: Date | null;
      provisional_until: Date | null;
      settled_home_lat: number | null;
      settled_home_lon: number | null;
    }>(
      `SELECT settled_at, provisional_until, settled_home_lat, settled_home_lon
         FROM account_settlement WHERE account_id = $1`,
      [accountId]
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      settledAt: row.settled_at,
      provisionalUntil: row.provisional_until,
      settledHome: row.settled_home_lat !== null && row.settled_home_lon !== null
        ? { lat: row.settled_home_lat, lon: row.settled_home_lon }
        : null
    };
  }
}
