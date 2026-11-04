import { distanceMeters, STONE_MINE_YIELD_QUANTITY } from "@ash-atlas/shared";
import type pg from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  FLAG_BUILD_COST,
  FLAG_BUILD_RECIPE,
  FLAG_REINFORCEMENT_STONE_COST,
  FlagService,
  type PreparedFlagPlacement
} from "./flags.js";
import { ambientWolfPositions } from "./ambientWolves.js";

describe("first-pass gathering economy", () => {
  it("keeps the initial flag cheap and uses the specified five-stone first upgrade", () => {
    expect(FLAG_BUILD_COST).toEqual({ wood: 3, leather: 2 });
    expect(FLAG_BUILD_RECIPE).toEqual([
      { itemId: "wood", quantity: 3 },
      { itemId: "leather", quantity: 2 }
    ]);
    expect(FLAG_REINFORCEMENT_STONE_COST).toBe(5);
    expect(STONE_MINE_YIELD_QUANTITY).toBe(3);
  });

  it("debits 3 wood and 2 leather in the flag placement transaction", async () => {
    const { service, debit } = flagHarness();
    await service.commitPreparedPlacement(preparedFlag(), false, "build-request");
    expect(debit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      operationKey: "flag-build:player:build-request",
      debits: [
        { itemId: "wood", variant: null, quantity: 3 },
        { itemId: "leather", variant: null, quantity: 2 }
      ]
    }));
  });

  it("debits 5 stone for an owner-only stone upgrade", async () => {
    const { service, debit } = flagHarness();
    const result = await service.reinforceFlag(
      "player",
      "00000000-0000-4000-8000-000000000001",
      "reinforce-request"
    );
    expect(debit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      operationKey: "flag-tier:player:reinforce-request",
      debits: [{ itemId: "stone", variant: null, quantity: 5 }]
    }));
    expect(result.flag.reinforcementLevel).toBe(1);
  });

  it("debits 25 stone for a personal stone flag Tower upgrade", async () => {
    const { service, debit } = flagHarness(1, 3);
    const result = await service.upgradeFlagTier(
      "player",
      "00000000-0000-4000-8000-000000000001",
      "tower",
      "tower-request"
    );
    expect(debit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      operationKey: "flag-tier:player:tower-request",
      source: "flag_tower_upgrade",
      debits: [{ itemId: "stone", variant: null, quantity: 25 }]
    }));
    expect(result.flag.reinforcementLevel).toBe(3);
  });

  it("replays the same Tower upgrade without a second debit", async () => {
    const operationKey = "flag-tier:player:tower-replay";
    const { service, debit } = flagHarness(3, 3, operationKey);
    await expect(service.upgradeFlagTier(
      "player", "00000000-0000-4000-8000-000000000001", "tower", "tower-replay"
    )).resolves.toMatchObject({ replayed: true, flag: { reinforcementLevel: 3 } });
    expect(debit).not.toHaveBeenCalled();
  });

  it("places three ordinary wolves within a Resource Vision circle", () => {
    const center = { lat: 35.0844, lon: -106.6504 };
    const positions = ambientWolfPositions(center);
    expect(positions).toHaveLength(3);
    expect(positions.map((position) => Math.round(distanceMeters(center, position))))
      .toEqual([320, 640, 920]);
  });
});

function flagHarness(currentLevel = 0, resultLevel = 1, reinforcedOperationKey: string | null = null) {
  const inventory = inventorySnapshot();
  const debit = vi.fn(async () => ({ applied: true, inventory }));
  const row = (reinforcementLevel: number) => ({
    id: "00000000-0000-4000-8000-000000000001",
    owner_id: "player",
    owner_username: "Ash",
    owner_color: "#38bdf8",
    name: "Flag 1",
    lat: 35.0844,
    lon: -106.6504,
    regionCode: "world_v1_lat35_lon-107",
    movementLeashRadiusM: 1_250,
    movementRevision: 0,
    relocationRevision: 0,
    builderRank: 0,
    buildDurationMs: 4_000,
    materialAffordable: true,
    admissionTimings: {
      defaultNameMs: 0,
      territoryAdmissionMs: 0,
      worldLookupMs: 0,
      builderRankMs: 0,
      affordabilityMs: 0,
      totalMs: 0,
      quoteState: "miss"
    },
    package_id: "world_v1_lat35_lon-107",
    elevation_m: 1_500,
    terrain_class: "flat",
    biome: "desert",
    ecoregion: "test",
    claim_radius_m: 1_250,
    city_id: null,
    kingdom_id: null,
    control_type: "personal",
    anchor_kind: "flag",
    resource_vision_radius_m: 1_250,
    reinforcement_level: reinforcementLevel,
    reinforced_operation_key: reinforcedOperationKey,
    created_at: new Date("2026-07-14T00:00:00.000Z")
  });
  const client = {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("UPDATE flags") && sql.includes("reinforcement_level = $2")) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("SELECT control_type, anchor_kind, owner_id, city_id, kingdom_id")) {
        return { rows: [row(currentLevel)], rowCount: 1 };
      }
      if (sql.includes("SELECT shrine.unlocked_slots")) {
        return {
          rows: [{
            unlocked_slots: 0,
            player_level: 1,
            current_shards: "0",
            built_shrines: "0"
          }],
          rowCount: 1
        };
      }
      if (sql.includes("SELECT f.id") && sql.includes("FOR UPDATE OF f")) {
        return { rows: [row(0)], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO flags")) return { rows: [row(0)], rowCount: 1 };
      return { rows: [], rowCount: null };
    }),
    release: vi.fn()
  };
  const pool = {
    connect: vi.fn(async () => client),
    query: vi.fn(async () => ({ rows: [row(resultLevel)], rowCount: 1 }))
  } as unknown as pg.Pool;
  const service = new FlagService(
    pool,
    {} as never,
    {} as never,
    { info: vi.fn(), warn: vi.fn() } as never,
    {
      debitItemsForOperationInTransaction: debit,
      getInventorySnapshot: vi.fn(async () => inventory),
      snapshotInTransaction: vi.fn(async () => inventory)
    } as never
  );
  return { service, debit };
}

function preparedFlag(): PreparedFlagPlacement {
  return {
    flagId: "00000000-0000-4000-8000-000000000001",
    anchorKind: "flag",
    ownerId: "player",
    ownerUsername: "Ash",
    ownerColor: "#38bdf8",
    name: "Flag 1",
    lat: 35.0844,
    lon: -106.6504,
    regionCode: "world_v1_lat35_lon-107",
    movementLeashRadiusM: 1_250,
    movementRevision: 0,
    relocationRevision: 0,
    builderRank: 0,
    buildDurationMs: 4_000,
    materialAffordable: true,
    admissionTimings: {
      defaultNameMs: 0,
      territoryAdmissionMs: 0,
      worldLookupMs: 0,
      builderRankMs: 0,
      affordabilityMs: 0,
      totalMs: 0,
      quoteState: "miss"
    },
    world: {
      ok: true,
      packageId: "world_v1_lat35_lon-107",
      elevationM: 1_500,
      terrainClass: "flat",
      biome: "desert",
      ecoregion: "test",
      raw: {}
    }
  };
}

function inventorySnapshot() {
  return {
    playerId: "player",
    items: [],
    totals: {
      wood: 0,
      stone: 0,
      food: 0,
      ore: 0,
      water: 0,
      leather: 0,
      giving_berry: 0,
      balsam_resin: 0,
      crystal: 0, pearl: 0, atlas_shrine_shard: 0,
      enchantment_stone: 0
    }
  };
}
