import { randomUUID } from "node:crypto";

import type pg from "pg";

import type { AppLogger } from "../logger.js";
import {
  POPULATION_PLAN_CACHE_TRANSITION,
  POPULATION_PLAN_VERSION
} from "./populationZonesV2Identity.js";
import {
  populationZonesV2IntersectingCircle,
  type PopulationZoneV2Id
} from "./populationZonesV2Geometry.js";
import type { PopulationZonesV2Planner } from "./populationZonesV2Planner.js";

const STRATEGY = POPULATION_PLAN_CACHE_TRANSITION.strategy;

type FlagCursor = Readonly<{
  id: string;
  created_at: Date;
  lat: number;
  lon: number;
  resource_vision_radius_m: number;
}>;

export class PopulationFlagPlanBackfillWorker {
  private readonly ownerId =
    `population-flag-plan-backfill:${process.pid}:${randomUUID()}`;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private active = false;
  private stopping = false;
  private activeController: AbortController | null = null;
  private idleDelayMs = 1_000;
  private readonly metrics = {
    pagesCompleted: 0,
    flagsScanned: 0,
    distinctZonesDiscovered: 0,
    duplicateZoneReferences: 0,
    readyZones: 0,
    failedZones: 0,
    pressurePauses: 0,
    idlePolls: 0,
    leaseHeartbeats: 0,
    leaseLosses: 0
  };

  constructor(
    private readonly pool: pg.Pool,
    private readonly planner: Pick<
      PopulationZonesV2Planner,
      "prefetchEnvironmentForZones" | "scheduleZonesAndWait"
    >,
    private readonly logger: Pick<AppLogger, "warn">,
    private readonly pressureElevated: () => boolean,
    private readonly fallbackRadiusM: number,
    private readonly pressureDelayMs = 1_000,
    private readonly leaseMs = 60_000,
    private readonly operationTimeoutMs = 120_000,
    private readonly pageSize = 32,
    private readonly maximumDistinctZones = 16
  ) {}

  start(): void {
    if (this.timer || this.active) {
      throw new Error("population flag plan backfill is already running");
    }
    this.stopping = false;
    this.schedulePump(0);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.activeController?.abort(new DOMException("Backfill stopped", "AbortError"));
    while (this.active) await new Promise((resolve) => setTimeout(resolve, 10));
  }

  metricsSnapshot(): Readonly<typeof this.metrics & {
    active: boolean;
    idleDelayMs: number;
  }> {
    return { ...this.metrics, active: this.active, idleDelayMs: this.idleDelayMs };
  }

  private schedulePump(delayMs: number): void {
    if (this.stopping || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pump();
    }, delayMs);
    this.timer.unref?.();
  }

  private pump(): void {
    if (this.stopping || this.active) return;
    if (this.pressureElevated()) {
      this.metrics.pressurePauses += 1;
      this.schedulePump(this.pressureDelayMs);
      return;
    }
    this.active = true;
    let worked = false;
    void this.runPage().then((result) => {
      worked = result;
      if (worked) {
        this.idleDelayMs = 1_000;
      } else {
        this.metrics.idlePolls += 1;
        this.idleDelayMs = Math.min(30_000, this.idleDelayMs * 2);
      }
    }).catch(async (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      await this.pool.query(
        `UPDATE population_flag_plan_backfill_jobs
         SET status='retrying', lease_owner=NULL, lease_expires_at=NULL,
             next_retry_at=clock_timestamp() + interval '5 seconds',
             last_error=$2, updated_at=clock_timestamp()
         WHERE plan_version=$1 AND lease_owner=$3 AND status <> 'completed'`,
        [POPULATION_PLAN_VERSION, message.slice(0, 2_000), this.ownerId]
      ).catch(() => undefined);
      if (!this.stopping) {
        this.logger.warn({ err: error }, "population flag plan backfill failed");
      }
      this.idleDelayMs = 5_000;
    }).finally(() => {
      this.activeController = null;
      this.active = false;
      if (!this.stopping) this.schedulePump(worked ? 0 : this.idleDelayMs);
    });
  }

  private async runPage(): Promise<boolean> {
    const client = await this.pool.connect();
    let flags: readonly FlagCursor[] = [];
    let sweep = 0;
    let leaseGeneration: string | number = 0;
    try {
      await client.query("BEGIN");
      const claim = await client.query<{
        sweep: number;
        cursor_created_at: Date | null;
        cursor_flag_id: string | null;
        lease_generation: string | number;
      }>(
        `UPDATE population_flag_plan_backfill_jobs
         SET status='processing', lease_owner=$2,
             lease_generation=lease_generation + 1,
             lease_expires_at=clock_timestamp()
               + ($3::bigint * interval '1 millisecond'),
             attempt_count=attempt_count + 1, updated_at=clock_timestamp()
         WHERE plan_version=$1 AND strategy=$4 AND status <> 'completed'
           AND next_retry_at <= clock_timestamp()
           AND (lease_expires_at IS NULL OR lease_expires_at < clock_timestamp())
         RETURNING sweep, cursor_created_at, cursor_flag_id, lease_generation`,
        [POPULATION_PLAN_VERSION, this.ownerId, this.leaseMs, STRATEGY]
      );
      const job = claim.rows[0];
      if (!job) {
        await client.query("COMMIT");
        return false;
      }
      sweep = job.sweep;
      leaseGeneration = job.lease_generation;
      const next = await client.query<FlagCursor>(
        `SELECT id, created_at, lat, lon,
                COALESCE(resource_vision_radius_m, $3)::float8
                  AS resource_vision_radius_m
         FROM flags
         WHERE $1::timestamptz IS NULL
            OR (created_at, id) > ($1::timestamptz, $2::uuid)
         ORDER BY created_at, id
         LIMIT $4`,
        [job.cursor_created_at, job.cursor_flag_id, this.fallbackRadiusM, this.pageSize]
      );
      flags = next.rows;
      if (flags.length === 0) {
        await client.query(
          sweep === 0
            ? `UPDATE population_flag_plan_backfill_jobs
               SET status='pending', sweep=1, cursor_created_at=NULL,
                   cursor_flag_id=NULL, lease_owner=NULL, lease_expires_at=NULL,
                   next_retry_at=clock_timestamp(), last_error=NULL,
                   updated_at=clock_timestamp()
               WHERE plan_version=$1 AND lease_owner=$2 AND lease_generation=$3`
            : `UPDATE population_flag_plan_backfill_jobs
               SET status='completed', lease_owner=NULL, lease_expires_at=NULL,
                   last_error=NULL, completed_at=clock_timestamp(),
                   updated_at=clock_timestamp()
               WHERE plan_version=$1 AND lease_owner=$2 AND lease_generation=$3`,
          [POPULATION_PLAN_VERSION, this.ownerId, leaseGeneration]
        );
        await client.query("COMMIT");
        return false;
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    const selectedFlags: FlagCursor[] = [];
    const zoneIds = new Set<PopulationZoneV2Id>();
    let zoneReferences = 0;
    for (const flag of flags) {
      const flagZoneIds = populationZonesV2IntersectingCircle(
        { lat: flag.lat, lon: flag.lon },
        flag.resource_vision_radius_m
      );
      const nextSize = new Set([...zoneIds, ...flagZoneIds]).size;
      if (selectedFlags.length > 0 && nextSize > this.maximumDistinctZones) break;
      selectedFlags.push(flag);
      zoneReferences += flagZoneIds.length;
      for (const zoneId of flagZoneIds) zoneIds.add(zoneId);
    }
    const lastFlag = selectedFlags.at(-1)!;
    const controller = new AbortController();
    this.activeController = controller;
    const timeout = setTimeout(
      () => controller.abort(new DOMException("Backfill operation timed out", "AbortError")),
      this.operationTimeoutMs
    );
    timeout.unref?.();
    const heartbeat = setInterval(() => {
      void this.pool.query(
        `UPDATE population_flag_plan_backfill_jobs
         SET lease_expires_at=clock_timestamp()
               + ($4::bigint * interval '1 millisecond'),
             updated_at=clock_timestamp()
         WHERE plan_version=$1 AND lease_owner=$2 AND lease_generation=$3`,
        [POPULATION_PLAN_VERSION, this.ownerId, leaseGeneration, this.leaseMs]
      ).then((result) => {
        if ((result.rowCount ?? 0) > 0) {
          this.metrics.leaseHeartbeats += 1;
          return;
        }
        this.metrics.leaseLosses += 1;
        controller.abort(new DOMException("Backfill lease was lost", "AbortError"));
      }).catch(() => {
        controller.abort(new DOMException("Backfill lease heartbeat failed", "AbortError"));
      });
    }, Math.max(1_000, Math.floor(this.leaseMs / 3)));
    heartbeat.unref?.();
    let readyZoneIds: readonly PopulationZoneV2Id[] = [];
    let failedZoneIds: readonly PopulationZoneV2Id[] = [];
    try {
      const distinctZoneIds = [...zoneIds].sort();
      await this.planner.prefetchEnvironmentForZones({
        zoneIds: distinctZoneIds,
        regionCode: "background",
        reason: "flag-plan-backfill",
        priority: 3,
        workClass: "global",
        signal: controller.signal
      });
      const result = await this.planner.scheduleZonesAndWait({
        zoneIds: distinctZoneIds,
        regionCode: "background",
        reason: "flag-plan-backfill",
        priority: 3,
        workClass: "global",
        signal: controller.signal
      });
      readyZoneIds = result.readyZoneIds;
      failedZoneIds = result.terminalFailureZoneIds ?? [];
      if (controller.signal.aborted) throw controller.signal.reason;
      if (result.pendingZoneIds.length > 0) {
        throw new Error("population flag plan backfill remained pending");
      }
    } finally {
      clearTimeout(timeout);
      clearInterval(heartbeat);
    }

    const updated = await this.pool.query(
      `UPDATE population_flag_plan_backfill_jobs
       SET status='pending', cursor_created_at=$4, cursor_flag_id=$5,
           flags_discovered=flags_discovered + $6,
           zones_discovered=zones_discovered + $7,
           zones_ready=zones_ready + $8, zones_failed=zones_failed + $9,
           lease_owner=NULL, lease_expires_at=NULL,
           next_retry_at=clock_timestamp(), last_error=NULL,
           updated_at=clock_timestamp()
       WHERE plan_version=$1 AND lease_owner=$2 AND lease_generation=$3`,
      [
        POPULATION_PLAN_VERSION,
        this.ownerId,
        leaseGeneration,
        lastFlag.created_at,
        lastFlag.id,
        selectedFlags.length,
        zoneIds.size,
        readyZoneIds.length,
        failedZoneIds.length
      ]
    );
    if ((updated.rowCount ?? 0) === 0) {
      throw new Error("population flag plan backfill lost its fenced lease");
    }
    this.metrics.pagesCompleted += 1;
    this.metrics.flagsScanned += selectedFlags.length;
    this.metrics.distinctZonesDiscovered += zoneIds.size;
    this.metrics.duplicateZoneReferences += Math.max(0, zoneReferences - zoneIds.size);
    this.metrics.readyZones += readyZoneIds.length;
    this.metrics.failedZones += failedZoneIds.length;
    return true;
  }
}
