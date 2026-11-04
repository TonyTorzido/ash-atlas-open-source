import { describe, expect, it, vi } from "vitest";

import { PopulationFlagPlanBackfillWorker } from "./populationFlagPlanBackfill.js";
import { populationZonesV2IntersectingCircle } from "./populationZonesV2Geometry.js";

describe("PopulationFlagPlanBackfillWorker", () => {
  it("derives one deduplicated destination and submits it through background priority", async () => {
    const flag = {
      id: "10000000-0000-4000-8000-000000000001",
      created_at: new Date("2026-08-05T00:00:00.000Z"),
      lat: 39.7392,
      lon: -104.9903,
      resource_vision_radius_m: 650
    };
    const transactionQuery = vi.fn(async (sql: string) => {
      if (sql.includes("RETURNING sweep")) {
        return {
          rows: [{
            sweep: 0,
            cursor_created_at: null,
            cursor_flag_id: null,
            lease_generation: 1
          }]
        };
      }
      if (sql.includes("FROM flags")) return { rows: [flag] };
      return { rows: [] };
    });
    const release = vi.fn();
    let pressured = false;
    const poolQuery = vi.fn(async (..._args: unknown[]) => {
      void _args;
      pressured = true;
      return { rows: [], rowCount: 1 };
    });
    const pool = {
      connect: vi.fn(async () => ({ query: transactionQuery, release })),
      query: poolQuery
    };
    const zoneIds = populationZonesV2IntersectingCircle(
      { lat: flag.lat, lon: flag.lon },
      flag.resource_vision_radius_m
    );
    const planner = {
      prefetchEnvironmentForZones: vi.fn(async () => ({})),
      scheduleZonesAndWait: vi.fn(async () => ({
        disabled: false,
        readyZoneIds: zoneIds,
        pendingZoneIds: []
      }))
    };
    const worker = new PopulationFlagPlanBackfillWorker(
      pool as never,
      planner as never,
      { warn: vi.fn() },
      () => pressured,
      650,
      60_000
    );

    worker.start();
    await vi.waitFor(() =>
      expect(planner.scheduleZonesAndWait).toHaveBeenCalledOnce());
    await worker.stop();

    expect(planner.prefetchEnvironmentForZones).toHaveBeenCalledWith({
      zoneIds,
      regionCode: "background",
      reason: "flag-plan-backfill",
      priority: 3,
      workClass: "global",
      signal: expect.any(AbortSignal)
    });
    expect(planner.scheduleZonesAndWait).toHaveBeenCalledWith({
      zoneIds,
      regionCode: "background",
      reason: "flag-plan-backfill",
      priority: 3,
      workClass: "global",
      signal: expect.any(AbortSignal)
    });
    expect(poolQuery.mock.calls[0]?.[1]).toEqual(expect.arrayContaining([
      flag.created_at,
      flag.id,
      zoneIds.length,
      zoneIds.length
    ]));
    expect(release).toHaveBeenCalledOnce();
  });

  it("does not claim work while host pressure is elevated", async () => {
    const pool = { connect: vi.fn(), query: vi.fn() };
    const worker = new PopulationFlagPlanBackfillWorker(
      pool as never,
      {
        prefetchEnvironmentForZones: vi.fn(),
        scheduleZonesAndWait: vi.fn()
      } as never,
      { warn: vi.fn() },
      () => true,
      650,
      5
    );

    worker.start();
    await new Promise((resolve) => setTimeout(resolve, 15));
    await worker.stop();
    expect(pool.connect).not.toHaveBeenCalled();
  });
});
