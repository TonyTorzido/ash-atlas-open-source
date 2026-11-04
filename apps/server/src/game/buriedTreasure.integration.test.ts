import { createHash, randomUUID } from "node:crypto";

import {
  SHOVEL_MAX_USES,
  TREASURE_AREA_CAPS,
  TREASURE_AREA_TOTAL_CAP,
  TREASURE_LANDMARK_MAX_OFFSET_M,
  distanceMeters,
  rollTreasureRewards,
  type TreasureTier
} from "@ash-atlas/shared";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runMigrations } from "../db/migrate.js";
import { InventoryService } from "./inventory.js";
import { TreasureRuntime, TreasureService } from "./buriedTreasure.js";
import { seedTradeSkillRank } from "./skills/tradeSkillTestSeed.js";

const databaseUrl = process.env.TREASURE_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

const HERE = { lat: 36, lon: -106 };
const NEAR = { lat: 36.0001, lon: -106 }; // ~11 m: inside the 40 m dig radius
const FAR = { lat: 36.01, lon: -106 }; // ~1.1 km away
const sha256 = (value: string) => createHash("sha256").update(value).digest();

describeDatabase("buried treasure PostgreSQL integration", () => {
  let pool: pg.Pool;
  let inventory: InventoryService;
  let treasure: TreasureService;
  let ringGrants: Array<{ operationKey: string; playerId: string; definitionId: string }> = [];

  beforeAll(async () => {
    const name = new URL(databaseUrl!).pathname.slice(1);
    if (!name.startsWith("ash_atlas_stability")) {
      throw new Error("TREASURE_TEST_DATABASE_URL must target an ash_atlas_stability* database");
    }
    await runMigrations(databaseUrl!);
    pool = new pg.Pool({ connectionString: databaseUrl!, max: 12 });
    inventory = new InventoryService(pool);
    const equipment = {
      grantPackageInstancesInTransaction: async (
        _client: unknown,
        input: { operationKey: string; playerId: string; grants: ReadonlyArray<{ definitionId: string }> }
      ) => {
        ringGrants.push({ operationKey: input.operationKey, playerId: input.playerId, definitionId: input.grants[0]!.definitionId });
        return { applied: true, equipment: {}, grants: [] };
      }
    };
    treasure = new TreasureService(pool, inventory, equipment as never);
  }, 120_000);

  beforeEach(async () => {
    ringGrants = [];
    await pool.query(
      "TRUNCATE buried_treasure_operations, buried_treasures, player_shovel_wear, hollin_huts, players CASCADE"
    );
    for (const id of ["digger-a", "digger-b", "newbie"]) await createPlayer(id);
    await setLevel("digger-a", 25);
    await setLevel("digger-b", 25);
    await setLevel("newbie", 1);
    await seedTradeSkillRank(pool, "digger-a", "cartography", 3);
    await seedTradeSkillRank(pool, "digger-b", "cartography", 3);
    await seedTradeSkillRank(pool, "newbie", "cartography", 3);
  });

  afterAll(async () => {
    await pool?.query(
      "TRUNCATE buried_treasure_operations, buried_treasures, player_shovel_wear, hollin_huts, players CASCADE"
    );
    await pool?.end();
  });

  it("dig-once: two simultaneous diggers produce exactly one winner and one payout", async () => {
    await grant("digger-a", "shovel", 1);
    await grant("digger-b", "shovel", 1);
    const id = await bury("bronze", HERE);
    const results = await Promise.allSettled([
      treasure.dig("digger-a", NEAR, id, "dig-race-a-1"),
      treasure.dig("digger-b", NEAR, id, "dig-race-b-1")
    ]);
    const winners = results.filter((result) => result.status === "fulfilled");
    const losers = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]!.reason).toMatchObject({ code: "TREASURE_GONE" });
    const winnerId = results[0]!.status === "fulfilled" ? "digger-a" : "digger-b";
    const loserId = winnerId === "digger-a" ? "digger-b" : "digger-a";
    const row = (await pool.query("SELECT status, dug_by_player_id FROM buried_treasures WHERE treasure_id=$1::uuid", [id])).rows[0];
    expect(row).toMatchObject({ status: "dug", dug_by_player_id: winnerId });
    expect(Number((await pool.query("SELECT count(*) FROM buried_treasure_operations WHERE action='dig'")).rows[0].count)).toBe(1);
    // The loser keeps an unworn shovel and receives nothing.
    expect(await quantity(loserId, "shovel")).toBe(1);
    expect(await totalNonShovel(loserId)).toBe(0);
    expect(await totalNonShovel(winnerId)).toBeGreaterThan(0);
  });

  it("rewards are granted once and a replayed request returns the same result", async () => {
    await grant("digger-a", "shovel", 1);
    const id = await bury("silver", HERE);
    const first = await treasure.dig("digger-a", NEAR, id, "dig-replay-1");
    expect(first.replayed).toBe(false);
    const expected = rollTreasureRewards("silver", id, sha256);
    expect(first.items).toEqual(expected.items);
    const held = await totalNonShovel("digger-a");
    const replay = await treasure.dig("digger-a", NEAR, id, "dig-replay-1");
    expect(replay).toMatchObject({ replayed: true, treasureId: id, items: first.items, message: first.message });
    expect(await totalNonShovel("digger-a")).toBe(held);
    expect(Number((await pool.query("SELECT count(*) FROM inventory_operations WHERE operation_key=$1", [`buried-treasure:${id}`])).rows[0].count)).toBe(1);
    // A fresh request for the same cache cannot pay again, and the shovel was worn only once.
    await expect(treasure.dig("digger-a", NEAR, id, "dig-replay-2")).rejects.toMatchObject({ code: "TREASURE_GONE" });
    expect(await totalNonShovel("digger-a")).toBe(held);
    expect((await treasure.state("digger-a", HERE)).shovelUsesRemaining).toBe(SHOVEL_MAX_USES - 1);
    // Re-using a request id for another action is refused.
    await expect(treasure.artisanShovel("digger-a", "dig-replay-1")).rejects.toMatchObject({ code: "TREASURE_REPLAY_CONFLICT" });
  });

  it("grants the ring exactly once under the cache's key", async () => {
    await grant("digger-a", "shovel", 1);
    let id = randomUUID();
    while (rollTreasureRewards("gold", id, sha256).ring === null) id = randomUUID();
    await bury("gold", HERE, id);
    const result = await treasure.dig("digger-a", NEAR, id, "dig-ring-1");
    expect(result.ring).toBe(rollTreasureRewards("gold", id, sha256).ring);
    await treasure.dig("digger-a", NEAR, id, "dig-ring-1");
    expect(ringGrants).toEqual([{ operationKey: `buried-treasure-ring:${id}`, playerId: "digger-a", definitionId: result.ring }]);
  });

  it("wears the shovel per dig and breaks it on the last use", async () => {
    await grant("digger-a", "shovel", 2);
    for (let index = 0; index < SHOVEL_MAX_USES; index += 1) {
      const id = await bury("bronze", HERE);
      const result = await treasure.dig("digger-a", NEAR, id, `dig-wear-${index}`);
      await clearHaul("digger-a");
      if (index < SHOVEL_MAX_USES - 1) {
        expect(result).toMatchObject({ shovelBroke: false, shovelUsesRemaining: SHOVEL_MAX_USES - 1 - index });
        expect(await quantity("digger-a", "shovel")).toBe(2);
      } else {
        expect(result).toMatchObject({ shovelBroke: true, shovelUsesRemaining: null });
        expect(await quantity("digger-a", "shovel")).toBe(1);
      }
    }
    const state = await treasure.state("digger-a", HERE);
    expect(state).toMatchObject({ shovels: 1, shovelUsesRemaining: SHOVEL_MAX_USES });
  }, 120_000);

  it("denies digging without a shovel or out of reach, and leaves the cache buried", async () => {
    const id = await bury("bronze", HERE);
    await expect(treasure.dig("digger-a", NEAR, id, "dig-noshovel-1")).rejects.toMatchObject({ code: "TREASURE_SHOVEL_REQUIRED" });
    await grant("digger-a", "shovel", 1);
    await expect(treasure.dig("digger-a", FAR, id, "dig-far-1")).rejects.toMatchObject({ code: "TREASURE_OUT_OF_RANGE" });
    await expect(treasure.dig("digger-a", null, id, "dig-nopos-1")).rejects.toMatchObject({ code: "TREASURE_POSITION_REQUIRED" });
    expect((await pool.query("SELECT status FROM buried_treasures WHERE treasure_id=$1::uuid", [id])).rows[0].status).toBe("buried");
    expect(await quantity("digger-a", "shovel")).toBe(1);
    expect((await treasure.state("digger-a", HERE)).shovelUsesRemaining).toBe(SHOVEL_MAX_USES);
  });

  it("gates silver and gold by Cartography rank: hidden from the list and refused to dig below the rank", async () => {
    await pool.query("DELETE FROM player_skill_ranks WHERE player_id IN ('newbie','digger-b')");
    await grant("newbie", "shovel", 1);
    await grant("digger-b", "shovel", 1);
    const bronze = await bury("bronze", HERE);
    const silver = await bury("silver", HERE);
    const gold = await bury("gold", HERE);
    const low = await treasure.state("newbie", HERE);
    expect(low.caches.map((cache) => cache.tier)).toEqual(["bronze"]);
    expect(low.hiddenTiers).toEqual([{ tier: "silver", requiredRank: 2 }, { tier: "gold", requiredRank: 3 }]);
    await expect(treasure.dig("newbie", NEAR, silver, "dig-deny-silver")).rejects.toMatchObject({ code: "TREASURE_NOT_FOUND" });
    await expect(treasure.dig("newbie", NEAR, gold, "dig-deny-gold")).rejects.toMatchObject({ code: "TREASURE_NOT_FOUND" });
    expect((await treasure.dig("newbie", NEAR, bronze, "dig-allow-bronze")).tier).toBe("bronze");

    await seedTradeSkillRank(pool, "digger-b", "cartography", 2);
    const mid = await treasure.state("digger-b", HERE);
    expect(mid.caches.map((cache) => cache.tier).sort()).toEqual(["silver"]);
    await expect(treasure.dig("digger-b", NEAR, gold, "dig-deny-gold-2")).rejects.toMatchObject({ code: "TREASURE_NOT_FOUND" });
    expect((await treasure.dig("digger-b", NEAR, silver, "dig-allow-silver")).tier).toBe("silver");
    expect(["buried"]).toContain((await pool.query("SELECT status FROM buried_treasures WHERE treasure_id=$1::uuid", [gold])).rows[0].status);
  });

  it("hides silver and gold from a low Cartography rank even at a high level, and refuses a Shovel craft", async () => {
    await createPlayer("novice");
    await setLevel("novice", 25);
    await grant("novice", "shovel", 1);
    const silver = await bury("silver", HERE);
    const gold = await bury("gold", HERE);
    expect((await treasure.state("novice", HERE)).caches.map((cache) => cache.tier)).toEqual([]);
    await expect(treasure.dig("novice", NEAR, silver, "skill-deny-silver")).rejects.toMatchObject({ code: "TREASURE_NOT_FOUND" });
    await seedTradeSkillRank(pool, "novice", "cartography", 1);
    await expect(treasure.artisanShovel("novice", "skill-deny-shovel")).rejects.toMatchObject({
      code: "TREASURE_SKILL_REQUIRED",
      message: "Needs Cartography rank 2 to craft a Shovel."
    });
    await seedTradeSkillRank(pool, "novice", "cartography", 2);
    await expect(treasure.dig("novice", NEAR, gold, "skill-deny-gold")).rejects.toMatchObject({ code: "TREASURE_NOT_FOUND" });
    expect((await treasure.dig("novice", NEAR, silver, "skill-allow-silver")).tier).toBe("silver");
  });

  it("crafts a Shovel from 8 crude oil, 14 wood and 11 iron bars, once per request", async () => {
    await expect(treasure.artisanShovel("digger-a", "craft-short-1")).rejects.toMatchObject({ code: "TREASURE_MATERIALS_REQUIRED" });
    await grant("digger-a", "crude_oil", 8);
    await grant("digger-a", "wood", 14);
    await grant("digger-a", "iron_bar", 11);
    expect(await treasure.artisanShovel("digger-a", "craft-ok-1")).toMatchObject({ replayed: false });
    expect(await treasure.artisanShovel("digger-a", "craft-ok-1")).toMatchObject({ replayed: true });
    expect(await quantity("digger-a", "shovel")).toBe(1);
    for (const itemId of ["crude_oil", "wood", "iron_bar"]) expect(await quantity("digger-a", itemId)).toBe(0);
  });

  it("buries caches within the area caps and near a landmark for silver and gold", async () => {
    await pool.query(
      `INSERT INTO hollin_huts (hut_id, request_id, region_code, zone_id, lat, lon)
       VALUES ('treasure-test-hut', 'treasure-test-hut', 'NM', 'zone', 36.02, -106)`
    );
    let seed = 7;
    const random = () => {
      seed = (seed * 1_664_525 + 1_013_904_223) % 4_294_967_296;
      return seed / 4_294_967_296;
    };
    const runtime = new TreasureRuntime({
      pool,
      playerPositions: () => [],
      lookupLand: async (points) => points.map(() => ({ land: true, label: "Test Mesa" })),
      random
    });
    // The player stands 2.2 km from the hut, so the hut is the nearest landmark choice.
    const player = { lat: 36.0002, lon: -106 };
    for (let index = 0; index < 40; index += 1) await runtime.spawnNear(player);
    const rows = (await pool.query<{ tier: TreasureTier; landmark_kind: string | null; place_label: string | null; lat: number; lon: number }>(
      "SELECT tier, landmark_kind, place_label, ST_Y(geom) AS lat, ST_X(geom) AS lon FROM buried_treasures WHERE status='buried'"
    )).rows;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(TREASURE_AREA_TOTAL_CAP);
    for (const tier of ["bronze", "silver", "gold"] as const) {
      expect(rows.filter((row) => row.tier === tier).length).toBeLessThanOrEqual(TREASURE_AREA_CAPS[tier]);
    }
    for (const row of rows) {
      expect(row.place_label).toBe("Test Mesa");
      if (row.tier === "bronze") expect(row.landmark_kind).toBeNull();
      else {
        expect(row.landmark_kind).toBe("hollin_hut");
        expect(distanceMeters({ lat: 36.02, lon: -106 }, row)).toBeLessThanOrEqual(TREASURE_LANDMARK_MAX_OFFSET_M + 5);
      }
    }
    // Water (or a failed lookup) buries nothing.
    await pool.query("TRUNCATE buried_treasures");
    const dry = new TreasureRuntime({
      pool,
      playerPositions: () => [],
      lookupLand: async (points) => points.map(() => ({ land: false, label: null })),
      random
    });
    for (let index = 0; index < 5; index += 1) expect(await dry.spawnNear(player)).toBeNull();
  });

  /** Buries a cache directly; `distance` offsets are small so everything is within reach of NEAR. */
  async function bury(tier: TreasureTier, at: { lat: number; lon: number }, id: string = randomUUID()): Promise<string> {
    await pool.query(
      `INSERT INTO buried_treasures (treasure_id, tier, geom, spawned_at, expires_at)
       VALUES ($1::uuid, $2, ST_SetSRID(ST_MakePoint($4,$3),4326), clock_timestamp(), clock_timestamp() + interval '6 hours')`,
      [id, tier, at.lat, at.lon]
    );
    return id;
  }

  async function setLevel(playerId: string, level: number): Promise<void> {
    const xp = ({ 1: 7_194, 10: 127_902, 25: 1_000_000 } as Record<number, number>)[level] ?? 0;
    await pool.query(
      `INSERT INTO player_progression_profiles (player_id, total_xp) VALUES ($1,$2)
       ON CONFLICT (player_id) DO UPDATE SET total_xp = EXCLUDED.total_xp`,
      [playerId, xp]
    );
  }

  async function grant(playerId: string, itemId: "shovel" | "crude_oil" | "wood" | "iron_bar", amount: number): Promise<void> {
    await inventory.grantItemsForOperation({
      operationKey: `treasure-test:${playerId}:${randomUUID()}`,
      playerId,
      source: "treasure_test",
      sourceEntityType: "treasure_test",
      sourceEntityId: playerId,
      grants: [{ itemId, variant: "default", quantity: amount }]
    });
  }

  async function quantity(playerId: string, itemId: string): Promise<number> {
    const snapshot = await inventory.getInventorySnapshot(playerId);
    return snapshot.items.filter((item) => item.resourceType === itemId).reduce((sum, item) => sum + Number(item.quantity), 0);
  }

  async function totalNonShovel(playerId: string): Promise<number> {
    const snapshot = await inventory.getInventorySnapshot(playerId);
    return snapshot.items.filter((item) => item.resourceType !== "shovel").reduce((sum, item) => sum + Number(item.quantity), 0);
  }

  /** Empties the haul (not the shovels) so a long digging run never trips the carry limit. */
  async function clearHaul(playerId: string): Promise<void> {
    const snapshot = await inventory.getInventorySnapshot(playerId);
    const debits = snapshot.items
      .filter((item) => item.resourceType !== "shovel")
      .map((item) => ({ itemId: item.resourceType, variant: item.variant ?? null, quantity: Number(item.quantity) }));
    if (debits.length === 0) return;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await inventory.debitItemsForOperationInTransaction(client, {
        operationKey: `treasure-test-clear:${playerId}:${randomUUID()}`,
        playerId,
        source: "treasure_test",
        sourceEntityType: "treasure_test",
        sourceEntityId: playerId,
        debits: debits as never
      });
      await client.query("COMMIT");
    } finally {
      client.release();
    }
  }

  async function createPlayer(id: string): Promise<void> {
    const accountId = randomUUID();
    await pool.query("INSERT INTO accounts (id,status,trust_tier) VALUES ($1,'active','standard')", [accountId]);
    await pool.query(
      `INSERT INTO players (
         id, account_id, username, username_normalized, display_color, region_code, lat, lon,
         anchor_lat, anchor_lon, move_leash_radius_m, online, geom
       ) VALUES ($1,$2,$1,$1,'#38bdf8','NM',36,-106,36,-106,900,true,ST_SetSRID(ST_MakePoint(-106,36),4326))`,
      [id, accountId]
    );
  }
});
