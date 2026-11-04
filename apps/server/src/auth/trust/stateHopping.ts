import { distanceMeters } from "@ash-atlas/shared";
import type pg from "pg";

import { DEFAULT_TRUST_RISK_SIGNAL_WEIGHTS, type AppConfig } from "../../config.js";
import type { AppLogger } from "../../logger.js";
import type { TrustAlertWriter } from "./trustAlerts.js";
import type { TrustSignalSink } from "./trustService.js";

// Location history and state hopping (owner decision D, 2026-10-04). Every
// stored fix (silent passive checks at session start and while the app is open,
// plus relocations) adds to the account's history. "State hopping" is the
// spoofer's pattern: jumps between distant regions faster than any real travel,
// returning to an earlier region (A -> B -> A). Thresholds are secret
// (TRUST_STATE_HOP_*), never shown to players.

export type HistoryFix = Readonly<{ lat: number; lon: number; at: Date; source: "passive" | "relocation" }>;

export type StateHopRules = Readonly<{ regionKm: number; maxKmh: number; minHops: number }>;

export type LocationHop = Readonly<{
  from: Readonly<{ lat: number; lon: number }>;
  to: Readonly<{ lat: number; lon: number }>;
  distanceKm: number;
  hours: number;
  kmh: number;
  implausible: boolean;
  passivePair: boolean;
}>;

export type LocationHistorySummary = Readonly<{
  fixes: number;
  visits: number;
  hops: readonly LocationHop[];
  implausibleHops: number;
  returnedToEarlierRegion: boolean;
  // The pattern: enough implausible hops and a return to an earlier region.
  stateHopping: boolean;
  // Two consecutive passive fixes too far apart for the time between them.
  passiveImpossible: boolean;
}>;

const MIN_HOURS = 1 / 60;

/** Pure: groups fixes (oldest first) into regional visits and measures the jumps between them. */
export function summarizeLocationHistory(fixes: readonly HistoryFix[], rules: StateHopRules): LocationHistorySummary {
  const sorted = [...fixes].sort((a, b) => a.at.getTime() - b.at.getTime());
  const regionM = rules.regionKm * 1000;
  const anchors: Array<{ lat: number; lon: number }> = [];
  const hops: LocationHop[] = [];
  let returned = false;
  let previous: HistoryFix | null = null;
  for (const fix of sorted) {
    const anchor = anchors.at(-1);
    if (!anchor || distanceMeters(anchor, fix) > regionM) {
      if (anchor && previous) {
        const distanceKm = distanceMeters(previous, fix) / 1000;
        const hours = Math.max(MIN_HOURS, (fix.at.getTime() - previous.at.getTime()) / 3_600_000);
        const kmh = distanceKm / hours;
        hops.push({
          from: { lat: previous.lat, lon: previous.lon },
          to: { lat: fix.lat, lon: fix.lon },
          distanceKm,
          hours,
          kmh,
          implausible: kmh > rules.maxKmh,
          passivePair: previous.source === "passive" && fix.source === "passive"
        });
        if (anchors.slice(0, -1).some((earlier) => distanceMeters(earlier, fix) <= regionM)) returned = true;
      }
      anchors.push({ lat: fix.lat, lon: fix.lon });
    }
    previous = fix;
  }
  const implausibleHops = hops.filter((hop) => hop.implausible).length;
  return {
    fixes: sorted.length,
    visits: anchors.length,
    hops,
    implausibleHops,
    returnedToEarlierRegion: returned,
    stateHopping: implausibleHops >= rules.minHops && returned,
    passiveImpossible: hops.some((hop) => hop.implausible && hop.passivePair)
  };
}

export interface LocationHistoryStore {
  recentFixes(accountId: string, since: Date, limit: number): Promise<HistoryFix[]>;
}

export type LocationHistoryConfig = Pick<AppConfig, "TRUST_MISMATCH_MODE"> & Partial<Pick<
  AppConfig,
  | "TRUST_RISK_SIGNAL_WEIGHTS"
  | "TRUST_STATE_HOP_REGION_KM"
  | "TRUST_STATE_HOP_MAX_KMH"
  | "TRUST_STATE_HOP_MIN_HOPS"
  | "TRUST_STATE_HOP_WINDOW_DAYS"
>>;

const HISTORY_LIMIT = 200;
const MAX_TRACKED_ACCOUNTS = 50_000;
const round1 = (value: number): number => Math.round(value * 10) / 10;

/** Re-reads the account's recent history after a far fix; never throws. */
export class LocationHistoryMonitor {
  // Last fix position per account: a check runs only when the new fix left the region.
  private readonly lastPositions = new Map<string, { lat: number; lon: number }>();
  private readonly now: () => Date;

  constructor(
    private readonly store: LocationHistoryStore,
    private readonly config: LocationHistoryConfig,
    private readonly deps: Readonly<{
      sink: TrustSignalSink;
      alerts?: Pick<TrustAlertWriter, "fileZoneAlert"> | undefined;
      logger?: Pick<AppLogger, "warn"> | undefined;
      now?: () => Date;
    }>
  ) {
    this.now = deps.now ?? (() => new Date());
  }

  rules(): StateHopRules {
    return {
      regionKm: this.config.TRUST_STATE_HOP_REGION_KM ?? 300,
      maxKmh: this.config.TRUST_STATE_HOP_MAX_KMH ?? 900,
      minHops: this.config.TRUST_STATE_HOP_MIN_HOPS ?? 2
    };
  }

  async onFix(input: Readonly<{
    accountId: string;
    lat: number;
    lon: number;
    at?: Date;
    source?: HistoryFix["source"];
  }>): Promise<void> {
    if (this.config.TRUST_MISMATCH_MODE === "off") return;
    const rules = this.rules();
    const last = this.lastPositions.get(input.accountId);
    if (this.lastPositions.size >= MAX_TRACKED_ACCOUNTS) this.lastPositions.clear();
    this.lastPositions.set(input.accountId, { lat: input.lat, lon: input.lon });
    // Same region as this process last saw: nothing new to judge.
    if (last && distanceMeters(last, input) <= rules.regionKm * 1000) return;
    const at = input.at ?? this.now();
    try {
      const windowDays = this.config.TRUST_STATE_HOP_WINDOW_DAYS ?? 7;
      const history = await this.store.recentFixes(
        input.accountId,
        new Date(at.getTime() - windowDays * 24 * 60 * 60_000),
        HISTORY_LIMIT
      );
      // A redundant passive fix is not stored as a row: judge it anyway.
      const latest = history.at(-1);
      const current: HistoryFix = { lat: input.lat, lon: input.lon, at, source: input.source ?? "passive" };
      const stored = latest !== undefined && latest.at.getTime() === at.getTime()
        && latest.lat === input.lat && latest.lon === input.lon;
      const summary = summarizeLocationHistory(stored ? history : [...history, current], rules);
      if (!summary.stateHopping && !summary.passiveImpossible) return;
      const day = at.toISOString().slice(0, 10);
      const details = {
        visits: summary.visits,
        implausibleHops: summary.implausibleHops,
        returnedToEarlierRegion: summary.returnedToEarlierRegion,
        passiveImpossible: summary.passiveImpossible,
        hops: summary.hops.filter((hop) => hop.implausible).slice(-6).map((hop) => ({
          from: { lat: round1(hop.from.lat), lon: round1(hop.from.lon) },
          to: { lat: round1(hop.to.lat), lon: round1(hop.to.lon) },
          km: Math.round(hop.distanceKm),
          kmh: Math.round(hop.kmh)
        }))
      };
      // An impossible passive pair alone is already speed_impossible (+4); the
      // pattern adds state_hopping on top.
      if (summary.stateHopping) {
        await this.deps.sink.recordSignals({
          accountId: input.accountId,
          signals: [{
            rule: "state_hopping",
            weight: this.config.TRUST_RISK_SIGNAL_WEIGHTS?.state_hopping ?? DEFAULT_TRUST_RISK_SIGNAL_WEIGHTS.state_hopping ?? 0,
            metadata: { ...details, dedupeKey: `state_hopping:${input.accountId}:${day}` }
          }]
        });
      }
      await this.deps.alerts?.fileZoneAlert({
        accountId: input.accountId,
        kind: "state_hopping",
        lat: input.lat,
        lon: input.lon,
        now: at,
        dedupe: "account",
        details
      });
    } catch (error) {
      this.lastPositions.delete(input.accountId);
      this.deps.logger?.warn({ err: error, accountId: input.accountId }, "Location history check failed");
    }
  }
}

export class PostgresLocationHistoryStore implements LocationHistoryStore {
  constructor(private readonly pool: pg.Pool) {}

  // Every stored claim of where the device was (refused relocations included).
  async recentFixes(accountId: string, since: Date, limit: number): Promise<HistoryFix[]> {
    const result = await this.pool.query<{ lat: number; lon: number; received_at: Date; source: "passive" | "relocation" }>(
      `SELECT lat, lon, received_at, source
         FROM (SELECT lat, lon, received_at, source
                 FROM location_reports
                WHERE account_id = $1 AND received_at >= $2
                ORDER BY received_at DESC
                LIMIT $3) recent
        ORDER BY received_at`,
      [accountId, since, limit]
    );
    return result.rows.map((row) => ({ lat: Number(row.lat), lon: Number(row.lon), at: row.received_at, source: row.source }));
  }
}
