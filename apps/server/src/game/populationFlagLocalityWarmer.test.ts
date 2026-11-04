import { describe, expect, it, vi } from "vitest";

import { PopulationFlagLocalityWarmer } from "./populationFlagLocalityWarmer.js";
import { populationZonesV2IntersectingCircle } from "./populationZonesV2Geometry.js";

const FLAG = {
  id: "10000000-0000-4000-8000-000000000001",
  lat: 39.7392,
  lon: -104.9903,
  resource_vision_radius_m: 650
};

describe("PopulationFlagLocalityWarmer", () => {
  it("warms canonical nearby destinations and retains shared player interest", async () => {
    const pool = {
      query: vi.fn(async (..._args: unknown[]) => {
        void _args;
        return { rows: [FLAG, { ...FLAG, id: "flag-2" }] };
      })
    };
    const planner = plannerHarness();
    const warmer = new PopulationFlagLocalityWarmer(
      pool as never,
      planner as never,
      { warn: vi.fn() },
      {
        fallbackFlagRadiusM: 650,
        maximumFlags: 12,
        maximumDistinctZones: 16,
        interestTtlMs: 60_000
      }
    );
    const zoneIds = [...populationZonesV2IntersectingCircle(
      { lat: FLAG.lat, lon: FLAG.lon },
      FLAG.resource_vision_radius_m
    )].sort();

    warmer.refresh({
      playerId: "player-1",
      generation: 1,
      center: { lat: 39.7392, lon: -104.9903 }
    });
    warmer.refresh({
      playerId: "player-2",
      generation: 1,
      center: { lat: 39.7392, lon: -104.9903 }
    });
    await vi.waitFor(() =>
      expect(planner.prefetchEnvironmentForZones).toHaveBeenCalledTimes(4));

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("ORDER BY f.geom <-> query_point.geom"),
      [39.7392, -104.9903, expect.any(String), 12, 650]
    );
    expect(String(pool.query.mock.calls[0]?.[0])).not.toContain("ST_DWithin");

    for (const [input] of planner.prefetchEnvironmentForZones.mock.calls) {
      expect(input).toMatchObject({
        zoneIds,
        priority: 2,
        workClass: "locality"
      });
    }
    expect(warmer.metricsSnapshot()).toMatchObject({
      activePlayers: 2,
      interestedZones: zoneIds.length,
      flagsSelected: 4
    });

    expect(warmer.releasePlayer("player-1")).toBe(true);
    expect(planner.cancelQueuedZones).toHaveBeenLastCalledWith({
      zoneIds: [],
      workClass: "locality"
    });
    expect(warmer.releasePlayer("player-2")).toBe(true);
    expect(planner.cancelQueuedZones).toHaveBeenLastCalledWith({
      zoneIds,
      workClass: "locality"
    });
    warmer.close();
  });

  it("discards a stale candidate query after a newer relocation generation", async () => {
    let resolveFirst!: (value: { rows: typeof FLAG[] }) => void;
    const first = new Promise<{ rows: typeof FLAG[] }>((resolve) => {
      resolveFirst = resolve;
    });
    const pool = {
      query: vi.fn()
        .mockImplementationOnce(() => first)
        .mockResolvedValueOnce({ rows: [FLAG] })
    };
    const planner = plannerHarness();
    const warmer = new PopulationFlagLocalityWarmer(
      pool as never,
      planner as never,
      { warn: vi.fn() },
      { fallbackFlagRadiusM: 650, interestTtlMs: 60_000 }
    );

    warmer.refresh({
      playerId: "player-1",
      generation: 1,
      center: { lat: 39.7, lon: -105 }
    });
    warmer.refresh({
      playerId: "player-1",
      generation: 2,
      center: { lat: 39.8, lon: -105 }
    });
    await vi.waitFor(() =>
      expect(planner.prefetchEnvironmentForZones).toHaveBeenCalledOnce());
    resolveFirst({ rows: [FLAG] });
    await vi.waitFor(() =>
      expect(warmer.metricsSnapshot().staleRefreshes).toBe(1));

    expect(planner.prefetchEnvironmentForZones).toHaveBeenCalledOnce();
    warmer.close();
  });
});

function plannerHarness() {
  return {
    prefetchEnvironmentForZones: vi.fn(async (input: { zoneIds: string[] }) => ({
      readyPlanZoneIds: [],
      unresolvedPlanZoneIds: input.zoneIds
    })),
    scheduleZones: vi.fn(async (input: { zoneIds: string[] }) => ({
      disabled: false,
      readyZoneIds: [],
      pendingZoneIds: input.zoneIds
    })),
    cancelQueuedZones: vi.fn(() => 0)
  };
}
