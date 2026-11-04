import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../config.js";
import { runMigrations } from "../db/migrate.js";
import type { AppLogger } from "../logger.js";
import type { WorldLookupClient } from "../world/worldLookupClient.js";
import {
  FLAG_BUILD_COST,
  FlagService,
  type PreparedFlagPlacement
} from "./flags.js";
import { InventoryService } from "./inventory.js";
import { MasteryService } from "./masteries.js";

const databaseUrl = validatedDatabaseUrl(process.env.FLAG_CONSTRUCTION_TEST_DATABASE_URL);
const migrationsDirectory = process.env.FLAG_CONSTRUCTION_MIGRATIONS_DIRECTORY;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("transactional flag construction", () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 12 });
  const inventory = new InventoryService(pool);
  const masteries = new MasteryService(pool);
  const config = loadConfig({ NODE_ENV: "test" });
  const service = new FlagService(
    pool,
    {} as WorldLookupClient,
    config,
    { info() {}, warn() {} } as unknown as AppLogger,
    inventory,
    masteries
  );
  const playerIds = Array.from({ length: 12 }, () => `flag-construction-${randomUUID()}`);

  beforeAll(async () => {
    await runMigrations(databaseUrl!, migrationsDirectory ? { migrationsDirectory } : undefined);
    for (const playerId of playerIds) {
      await insertPlayer(pool, playerId);
    }
  });

  afterAll(async () => {
    await pool.query(
      "DELETE FROM mastery_progression_operations WHERE player_id = ANY($1::text[])",
      [playerIds]
    );
    await pool.query("ALTER TABLE inventory_events DISABLE TRIGGER inventory_events_immutable");
    await pool.query("ALTER TABLE inventory_operations DISABLE TRIGGER inventory_operations_immutable");
    await pool.query("ALTER TABLE player_inventory DISABLE TRIGGER player_inventory_identity_guard");
    await pool.query("DELETE FROM inventory_events WHERE player_id = ANY($1::text[])", [playerIds]);
    await pool.query("DELETE FROM inventory_operations WHERE player_id = ANY($1::text[])", [playerIds]);
    await pool.query("DELETE FROM player_inventory WHERE player_id = ANY($1::text[])", [playerIds]);
    await pool.query("ALTER TABLE player_inventory ENABLE TRIGGER player_inventory_identity_guard");
    await pool.query("ALTER TABLE inventory_operations ENABLE TRIGGER inventory_operations_immutable");
    await pool.query("ALTER TABLE inventory_events ENABLE TRIGGER inventory_events_immutable");
    await pool.query("DELETE FROM player_inventory_slots WHERE player_id = ANY($1::text[])", [playerIds]);
    await pool.query("DELETE FROM player_inventory_capacities WHERE player_id = ANY($1::text[])", [playerIds]);
    await pool.query("ALTER TABLE flag_material_spend DISABLE TRIGGER flag_material_spend_immutable");
    await pool.query("DELETE FROM flag_material_spend WHERE paid_by_player_id = ANY($1::text[])", [playerIds]);
    await pool.query("ALTER TABLE flag_material_spend ENABLE TRIGGER flag_material_spend_immutable");
    await pool.query("ALTER TABLE weekly_leaderboard_events DISABLE TRIGGER weekly_leaderboard_events_immutable");
    await pool.query("DELETE FROM weekly_leaderboard_events WHERE player_id = ANY($1::text[])", [playerIds]);
    await pool.query("ALTER TABLE weekly_leaderboard_events ENABLE TRIGGER weekly_leaderboard_events_immutable");
    await pool.query("DELETE FROM weekly_leaderboard_totals WHERE player_id = ANY($1::text[])", [playerIds]);
    await pool.query("DELETE FROM flags WHERE owner_id = ANY($1::text[])", [playerIds]);
    await pool.query("DELETE FROM players WHERE id = ANY($1::text[])", [playerIds]);
    await pool.end();
  });

  it("commits debit, flag, XP, refund decision, and activation job exactly once", async () => {
    const playerId = playerIds[0]!;
    await setInventory(inventory, playerId, 6, 4);
    const authorityBefore = await durablePlayerAuthority(pool, playerId);
    const requestId = `replay-${randomUUID()}`;
    const first = await service.commitPreparedPlacement(
      prepared(playerId, -55, -150),
      true,
      requestId
    );
    const replay = await service.commitPreparedPlacement(
      prepared(playerId, -54, -145),
      true,
      requestId
    );

    expect(replay).toMatchObject({
      replayed: true,
      flag: { id: first.flag.id }
    });
    const counts = await pool.query<{
      flags: string;
      jobs: string;
      builds: string;
      inventory_operations: string;
      inventory_events: string;
      mastery_operations: string;
      builder_xp: number;
    }>(
      `SELECT
         (SELECT count(*)::text FROM flags WHERE owner_id = $1) AS flags,
         (SELECT count(*)::text FROM resource_vision_jobs job
            JOIN flags flag ON flag.id = job.flag_id WHERE flag.owner_id = $1) AS jobs,
         (SELECT count(*)::text FROM flag_build_operations WHERE player_id = $1) AS builds,
         (SELECT count(*)::text FROM inventory_operations
            WHERE player_id = $1 AND source = 'flag_construction') AS inventory_operations,
         (SELECT count(*)::text FROM inventory_events
            WHERE player_id = $1 AND source = 'flag_construction') AS inventory_events,
         (SELECT count(*)::text FROM mastery_progression_operations
            WHERE player_id = $1 AND source_type = 'construction') AS mastery_operations,
         (SELECT max(requested_xp)::int FROM mastery_progression_operations
            WHERE player_id = $1 AND policy_id = 'flag-build') AS builder_xp`,
      [playerId]
    );
    expect(counts.rows[0]).toEqual({
      flags: "1",
      jobs: "1",
      builds: "1",
      inventory_operations: "1",
      inventory_events: "2",
      mastery_operations: "1",
      builder_xp: 25
    });
    expect(await inventory.getInventorySnapshot(playerId)).toMatchObject({
      totals: { wood: 3, leather: 2 }
    });
    expect(await durablePlayerAuthority(pool, playerId)).toEqual(
      authorityBefore
    );
  });

  it("persists Rank-8 Material Recovery once without duplicating refunded inventory on replay", async () => {
    const playerId = playerIds[10]!;
    await masteries.getOrCreate(playerId);
    await pool.query(
      `UPDATE player_profession_progress SET xp=100000,rank=8
       WHERE player_id=$1 AND profession_id='builder'`,
      [playerId]
    );
    await setInventory(inventory, playerId, 6, 4);
    const roll = vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation((array) => {
      (array as Uint32Array)[0] = 0;
      return array;
    });
    try {
      const requestId = `material-recovery-${randomUUID()}`;
      const first = await service.commitPreparedPlacement(
        prepared(playerId, -5, -150),
        true,
        requestId
      );
      const replay = await service.commitPreparedPlacement(
        prepared(playerId, -4, -145),
        true,
        requestId
      );
      expect(first).toMatchObject({
        replayed: false,
        materialsRefunded: true,
        masteryGrant: { trackId: "builder", requestedXp: 25 }
      });
      expect(replay).toMatchObject({
        replayed: true,
        flag: { id: first.flag.id },
        materialsRefunded: true
      });
      expect(await inventory.getInventorySnapshot(playerId)).toMatchObject({
        totals: { wood: 6, leather: 4 }
      });
      await expect(pool.query(
        `SELECT count(*)::int AS count FROM inventory_operations
         WHERE operation_key=$1`,
        [`flag-build-refund:${playerId}:${requestId}`]
      )).resolves.toMatchObject({ rows: [{ count: 1 }] });
      await expect(pool.query(
        `SELECT random_results FROM mastery_progression_operations
         WHERE operation_key=$1`,
        [`profession-xp:flag-build:${playerId}:${requestId}:builder`]
      )).resolves.toMatchObject({
        rows: [{ random_results: { materialsRefunded: true, refundChance: 0.03 } }]
      });
    } finally {
      roll.mockRestore();
    }
  });

  it.each([
    ["wood", 2, 2, -45, -150],
    ["leather", 3, 1, -35, -150]
  ])("rolls back every construction effect when %s is insufficient", async (
    _resource,
    wood,
    leather,
    lat,
    lon
  ) => {
    const playerId = playerIds[lat === -45 ? 1 : 2]!;
    await setInventory(inventory, playerId, wood, leather);
    await expect(
      service.commitPreparedPlacement(prepared(playerId, lat, lon), true, randomUUID())
    ).rejects.toThrow("Inventory does not contain enough items");
    const state = await pool.query<{ flags: string; jobs: string; operations: string }>(
      `SELECT
         (SELECT count(*)::text FROM flags WHERE owner_id = $1) AS flags,
         (SELECT count(*)::text FROM resource_vision_jobs job
            JOIN flags flag ON flag.id = job.flag_id WHERE flag.owner_id = $1) AS jobs,
         (SELECT count(*)::text FROM inventory_operations
            WHERE player_id = $1 AND source = 'flag_construction') AS operations`,
      [playerId]
    );
    expect(state.rows[0]).toEqual({ flags: "0", jobs: "0", operations: "0" });
    expect(await inventory.getInventorySnapshot(playerId)).toMatchObject({
      totals: { wood, leather }
    });
  });

  it("atomically debits both stacks under concurrent distinct operations", async () => {
    const playerId = playerIds[3]!;
    await setInventory(
      inventory,
      playerId,
      FLAG_BUILD_COST.wood,
      FLAG_BUILD_COST.leather
    );
    const attempts = await Promise.allSettled([
      debitInTransaction(pool, inventory, playerId, `atomic-a-${randomUUID()}`),
      debitInTransaction(pool, inventory, playerId, `atomic-b-${randomUUID()}`)
    ]);
    expect(attempts.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect(await inventory.getInventorySnapshot(playerId)).toMatchObject({
      totals: { wood: 0, leather: 0 }
    });
    const ledger = await pool.query<{ operations: string; events: string }>(
      `SELECT
         (SELECT count(*)::text FROM inventory_operations
            WHERE player_id = $1 AND source = 'flag_construction_test') AS operations,
         (SELECT count(*)::text FROM inventory_events
            WHERE player_id = $1 AND source = 'flag_construction_test') AS events`,
      [playerId]
    );
    expect(ledger.rows[0]).toEqual({ operations: "1", events: "2" });
  });

  it("allows one winner for two conflicting full construction transactions", async () => {
    const leftPlayer = playerIds[4]!;
    const rightPlayer = playerIds[5]!;
    await Promise.all([
      setInventory(inventory, leftPlayer, 3, 2),
      setInventory(inventory, rightPlayer, 3, 2)
    ]);
    const attempts = await Promise.allSettled([
      service.commitPreparedPlacement(prepared(leftPlayer, -25, -150), true, randomUUID()),
      service.commitPreparedPlacement(prepared(rightPlayer, -25, -150), true, randomUUID())
    ]);
    expect(attempts.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter(({ status }) => status === "rejected")).toHaveLength(1);
    const flags = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM flags WHERE owner_id = ANY($1::text[])",
      [[leftPlayer, rightPlayer]]
    );
    expect(flags.rows[0]?.count).toBe("1");
  });

  it("applies Public and Normal defaults in the construction transaction", async () => {
    const publicPlayer = playerIds[6]!;
    const normalPlayer = playerIds[7]!;
    await pool.query(
      `UPDATE player_flag_preferences
       SET default_flag_access_mode='public', default_public_toll_gold=7
       WHERE owner_player_id=$1`, [publicPlayer]
    );
    await pool.query(
      `UPDATE player_flag_preferences
       SET default_flag_access_mode='normal', default_normal_toll_gold=9
       WHERE owner_player_id=$1`, [normalPlayer]
    );
    await Promise.all([
      setInventory(inventory, publicPlayer, 3, 2),
      setInventory(inventory, normalPlayer, 3, 2)
    ]);
    const publicFlag = await service.commitPreparedPlacement(prepared(publicPlayer, -15, -150), true, randomUUID());
    const normalFlag = await service.commitPreparedPlacement(prepared(normalPlayer, -10, -150), true, randomUUID());
    const state = await pool.query<{
      id: string; access_mode: string; jump_toll_gold: string;
    }>(
      `SELECT id, access_mode, jump_toll_gold::text
       FROM flags WHERE id=ANY($1::uuid[]) ORDER BY id`,
      [[publicFlag.flag.id, normalFlag.flag.id]]
    );
    expect(state.rows).toHaveLength(2);
    expect(state.rows.find((row) => row.id === publicFlag.flag.id)).toMatchObject({
      access_mode: "public", jump_toll_gold: "7"
    });
    expect(state.rows.find((row) => row.id === normalFlag.flag.id)).toMatchObject({
      access_mode: "normal", jump_toll_gold: "9"
    });
  });

  it("rolls back flag creation and inventory debit together", async () => {
    const playerId = playerIds[8]!;
    await setInventory(inventory, playerId, 3, 2);
    await pool.query(`CREATE OR REPLACE FUNCTION reject_flag_construction_test() RETURNS trigger AS $$
      BEGIN IF NEW.name = 'Rollback Flag' THEN RAISE EXCEPTION 'forced construction rollback'; END IF; RETURN NEW; END;
      $$ LANGUAGE plpgsql`);
    await pool.query(`CREATE TRIGGER reject_flag_construction_test
      BEFORE INSERT ON flags FOR EACH ROW EXECUTE FUNCTION reject_flag_construction_test()`);
    try {
      await expect(service.commitPreparedPlacement({
        ...prepared(playerId, 5, -150), name: "Rollback Flag"
      }, true, randomUUID())).rejects.toThrow("forced construction rollback");
    } finally {
      await pool.query("DROP TRIGGER reject_flag_construction_test ON flags");
      await pool.query("DROP FUNCTION reject_flag_construction_test() ");
    }
    await expect(pool.query(
      "SELECT count(*)::int AS flags FROM flags WHERE owner_id=$1", [playerId]
    )).resolves.toMatchObject({ rows: [{ flags: 0 }] });
    expect(await inventory.getInventorySnapshot(playerId)).toMatchObject({ totals: { wood: 3, leather: 2 } });
  });

  it("creates and spends for one buoy exactly once across replay", async () => {
    const playerId = playerIds[9]!;
    await setInventory(inventory, playerId, 6, 6, 2);
    const requestId = `buoy-replay-${randomUUID()}`;
    const first = await service.commitPreparedPlacement({
      ...prepared(playerId, 15, -150),
      anchorKind: "buoy",
      name: "Buoy 1"
    }, true, requestId);
    const replay = await service.commitPreparedPlacement({
      ...prepared(playerId, 25, -150),
      anchorKind: "buoy",
      name: "Buoy 2"
    }, true, requestId);

    expect(replay).toMatchObject({ replayed: true, flag: { id: first.flag.id } });
    expect(first.flag).toMatchObject({ anchorKind: "buoy", controlType: "personal" });
    expect(await inventory.getInventorySnapshot(playerId)).toMatchObject({
      totals: { wood: 3, leather: 3, crude_oil: 1 }
    });
    await expect(pool.query(
      "SELECT count(*)::int AS count FROM flags WHERE owner_id=$1 AND anchor_kind='buoy'",
      [playerId]
    )).resolves.toMatchObject({ rows: [{ count: 1 }] });
  });

  it("rolls back the entire buoy spend when crude oil is missing", async () => {
    const playerId = playerIds[11]!;
    await setInventory(inventory, playerId, 3, 3);
    await expect(service.commitPreparedPlacement({
      ...prepared(playerId, 35, -150),
      anchorKind: "buoy",
      name: "Buoy 1"
    }, true, randomUUID())).rejects.toThrow("Inventory does not contain enough items");
    expect(await inventory.getInventorySnapshot(playerId)).toMatchObject({
      totals: { wood: 3, leather: 3, crude_oil: 0 }
    });
    await expect(pool.query(
      "SELECT count(*)::int AS count FROM flags WHERE owner_id=$1",
      [playerId]
    )).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });
});

async function debitInTransaction(
  pool: pg.Pool,
  inventory: InventoryService,
  playerId: string,
  operationKey: string
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await inventory.debitItemsForOperationInTransaction(client, {
      operationKey,
      playerId,
      source: "flag_construction_test",
      debits: [
        { itemId: "wood", variant: null, quantity: FLAG_BUILD_COST.wood },
        { itemId: "leather", variant: null, quantity: FLAG_BUILD_COST.leather }
      ]
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function insertPlayer(pool: pg.Pool, playerId: string): Promise<void> {
  await pool.query(
    `INSERT INTO players (
       id, username, region_code, lat, lon, anchor_lat, anchor_lon,
       move_leash_radius_m, online, geom
     ) VALUES ($1,$1,'GLOBAL',0,0,0,0,1250,false,
               ST_SetSRID(ST_MakePoint(0,0),4326))`,
    [playerId]
  );
}

async function setInventory(
  inventory: InventoryService,
  playerId: string,
  wood: number,
  leather: number,
  crudeOil = 0
): Promise<void> {
  await inventory.grantItemsForOperation({
    operationKey: `flag-construction-seed:${playerId}`,
    playerId,
    source: "flag_construction_test_seed",
    grants: [
      { itemId: "wood", variant: null, quantity: wood },
      { itemId: "leather", variant: null, quantity: leather },
      ...(crudeOil > 0
        ? [{ itemId: "crude_oil" as const, variant: null, quantity: crudeOil }]
        : [])
    ]
  });
}

async function durablePlayerAuthority(
  pool: pg.Pool,
  playerId: string
): Promise<Record<string, unknown>> {
  const result = await pool.query(
    `SELECT lat, lon, anchor_lat, anchor_lon,
            resource_vision_center_lat, resource_vision_center_lon,
            current_flag_id, current_kingdom_seat_id
     FROM players
     WHERE id = $1`,
    [playerId]
  );
  return result.rows[0] ?? {};
}

function prepared(playerId: string, lat: number, lon: number): PreparedFlagPlacement {
  return {
    flagId: randomUUID(),
    anchorKind: "flag",
    ownerId: playerId,
    ownerUsername: playerId,
    name: `Flag ${randomUUID().slice(0, 8)}`,
    lat,
    lon,
    regionCode: "GLOBAL",
    movementLeashRadiusM: 1_250,
    movementRevision: 0,
    relocationRevision: 0,
    builderRank: 0,
    buildDurationMs: 4_000,
    materialAffordable: true,
    world: {
      ok: true,
      packageId: "GLOBAL",
      elevationM: 1_000,
      terrainClass: "land",
      biome: "plains",
      ecoregion: "test",
      isLand: true,
      isSaltwater: false,
      insideMajorLake: false,
      raw: {}
    },
    admissionTimings: {
      defaultNameMs: 0,
      territoryAdmissionMs: 0,
      worldLookupMs: 0,
      builderRankMs: 0,
      affordabilityMs: 0,
      totalMs: 0,
      quoteState: "miss"
    }
  };
}

function validatedDatabaseUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (!/\/ash_atlas_stability[^/?]*/.test(value)) {
    throw new Error("FLAG_CONSTRUCTION_TEST_DATABASE_URL must target an ash_atlas_stability database");
  }
  return value;
}
