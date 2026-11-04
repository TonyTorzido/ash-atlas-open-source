import { describe, expect, it, vi } from "vitest";

import { MOB_CHALLENGE_TIERS, MOB_CHALLENGE_TIER_BAND_WIDTH } from "@ash-atlas/shared";

import { PostgresPopulationZonesV2Store } from "./populationZonesV2Store.js";

describe("population combat profile claim no-op fast path", () => {
  it("returns without a transaction when every requested zone is profiled", async () => {
    const connect = vi.fn();
    const query = vi.fn(async (...args: unknown[]) => {
      void args;
      return { rows: [], rowCount: 0 };
    });
    const store = new PostgresPopulationZonesV2Store(
      { connect, query } as never,
      undefined,
      undefined,
      { profileClaimNoopFastPathEnabled: true }
    );

    await expect(store.claimMobCombatProfilesForZones([
      { zoneId: "zone-a", level: 5, source: "zone_player_profile" },
      { zoneId: "zone-b", level: 7, source: "zone_player_profile" }
    ])).resolves.toBe(0);

    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[1]).toEqual([["zone-a", "zone-b"]]);
    expect(connect).not.toHaveBeenCalled();
  });

  it("locks and updates only zones reported as still unclaimed", async () => {
    const connect = vi.fn();
    const query = vi.fn()
      .mockResolvedValueOnce({
        rows: [{ zone_id: "zone-b" }],
        rowCount: 1
      })
      .mockResolvedValueOnce({
        rows: [{ claimed_count: 3 }],
        rowCount: 1
      });
    const store = new PostgresPopulationZonesV2Store(
      { connect, query } as never,
      undefined,
      undefined,
      { profileClaimNoopFastPathEnabled: true }
    );

    await expect(store.claimMobCombatProfilesForZones([
      { zoneId: "zone-a", level: 5, source: "zone_player_profile" },
      { zoneId: "zone-b", level: 7, source: "zone_player_profile" }
    ])).resolves.toBe(3);

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1]?.[1]).toEqual([
      ["zone-b"],
      [7],
      ["zone_player_profile"],
      [...MOB_CHALLENGE_TIERS],
      MOB_CHALLENGE_TIER_BAND_WIDTH
    ]);
    expect(connect).not.toHaveBeenCalled();
  });

  it("skips the no-op probe for a newly materialized unclaimed zone", async () => {
    const connect = vi.fn();
    const query = vi.fn(async (...args: unknown[]) => {
      void args;
      return {
        rows: [{ claimed_count: 4 }],
        rowCount: 1
      };
    });
    const store = new PostgresPopulationZonesV2Store(
      { connect, query } as never,
      undefined,
      undefined,
      { profileClaimNoopFastPathEnabled: true }
    );

    await expect(store.claimMobCombatProfilesForZones([{
      zoneId: "zone-a",
      level: 11,
      source: "zone_player_profile",
      knownUnclaimed: true
    }])).resolves.toBe(4);

    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[1]).toEqual([
      ["zone-a"],
      [11],
      ["zone_player_profile"],
      [...MOB_CHALLENGE_TIERS],
      MOB_CHALLENGE_TIER_BAND_WIDTH
    ]);
    expect(connect).not.toHaveBeenCalled();
  });

  it("uses the atomic claim statement directly while the fast path is disabled", async () => {
    const connect = vi.fn();
    const query = vi.fn(async () => ({
      rows: [{ claimed_count: 0 }],
      rowCount: 1
    }));
    const store = new PostgresPopulationZonesV2Store(
      { connect, query } as never
    );

    await expect(store.claimMobCombatProfilesForZones([
      { zoneId: "zone-a", level: 5, source: "zone_player_profile" }
    ])).resolves.toBe(0);

    expect(query).toHaveBeenCalledOnce();
    expect(connect).not.toHaveBeenCalled();
  });
});
