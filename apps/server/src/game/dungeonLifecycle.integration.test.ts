import { randomUUID } from "node:crypto";

import { CISTERN_WARRENS_DUNGEON, dungeonAnchorDefinition, dungeonRoomDefinition } from "@ash-atlas/shared";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "../db/disposableTestPool.js";
import { runMigrations } from "../db/migrate.js";
import { DungeonRuntime } from "./dungeon.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;

describeDatabase("dungeon lifecycle PostgreSQL authority", () => {
  const databaseName = `ash_atlas_stability_dungeon_lifecycle_${randomUUID().replaceAll("-", "")}`;
  let admin: pg.Pool;
  let pool: DisposableTestPool;

  beforeAll(async () => {
    const parsed = assertDisposableAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await runMigrations(parsed.toString());
    pool = new DisposableTestPool({ connectionString: parsed.toString(), max: 4 });
    const accountId = randomUUID();
    await pool.query("INSERT INTO accounts (id,status,trust_tier) VALUES ($1,'active','standard')", [accountId]);
    await pool.query(
      `INSERT INTO players (
         id,account_id,username,username_normalized,region_code,lat,lon,
         anchor_lat,anchor_lon,move_leash_radius_m,online,geom
       ) VALUES ('dungeon-lifecycle-player',$1,'DungeonLifecyclePlayer','dungeonlifecycleplayer',
         'GLOBAL',40,-105,40,-105,100,true,ST_SetSRID(ST_MakePoint(-105,40),4326))`,
      [accountId]
    );
    const secondAccountId = randomUUID();
    await pool.query("INSERT INTO accounts (id,status,trust_tier) VALUES ($1,'active','standard')", [secondAccountId]);
    await pool.query(
      `INSERT INTO players (
         id,account_id,username,username_normalized,region_code,lat,lon,
         anchor_lat,anchor_lon,move_leash_radius_m,online,geom
       ) VALUES ('dungeon-lifecycle-player-2',$1,'DungeonLifecyclePlayerTwo','dungeonlifecycleplayertwo',
         'GLOBAL',40,-105,40,-105,100,true,ST_SetSRID(ST_MakePoint(-105,40),4326))`,
      [secondAccountId]
    );
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin?.end();
  });

  it("round-trips authored entry, presence, reconnect, transfer, and exit", async () => {
    const runtime = new DungeonRuntime(pool as never, dungeonCombat() as never);
    const player = testPlayer();
    const entranceRoom = dungeonRoomDefinition("cistern_warrens", CISTERN_WARRENS_DUNGEON.entrance.roomId)!;
    const arrival = dungeonAnchorDefinition(entranceRoom, CISTERN_WARRENS_DUNGEON.entrance.arrivalAnchorId);
    const canonical = {
      spaceId: entranceRoom.id,
      position: { x: arrival.x, y: arrival.y },
      instanceId: "dungeon:cistern_warrens_world_entrance:player:dungeon-lifecycle-player",
      locationType: "dungeon" as const
    };

    const entered = await runtime.enter(player, "cistern_warrens_world_entrance", canonical);
    expect(entered).toMatchObject({ dungeonId: "cistern_warrens", spaceId: "hatch_landing", instanceId: canonical.instanceId });
    expect((await pool.query("SELECT dungeon_id,instance_id,space_id FROM dungeon_presence WHERE player_id=$1", [player.playerId])).rows)
      .toEqual([{ dungeon_id: "cistern_warrens", instance_id: canonical.instanceId, space_id: "hatch_landing" }]);

    await runtime.detachRuntime(player.playerId);
    const restored = await runtime.restore(player, { sewerId: "cistern_warrens_world_entrance", ...canonical });
    expect(restored).toMatchObject({ sessionId: entered.sessionId, spaceId: "hatch_landing" });

    const depths = dungeonRoomDefinition("cistern_warrens", "overflow_channel")!;
    const depthsSpawn = dungeonAnchorDefinition(depths, "spawn");
    const transferred = runtime.transferSpace(player.playerId, restored!.sessionId, depths.id, { x: depthsSpawn.x, y: depthsSpawn.y });
    expect(transferred.spaceId).toBe("overflow_channel");
    await runtime.leave(player.playerId, transferred.sessionId);
    expect((await pool.query("SELECT 1 FROM dungeon_presence WHERE player_id=$1", [player.playerId])).rowCount).toBe(0);
  });

  it("shares one authored run for concurrent occupants and rejects duplicate entry", async () => {
    const runtime = new DungeonRuntime(pool as never, dungeonCombat() as never);
    const first = testPlayer();
    const second = { ...testPlayer(), playerId: "dungeon-lifecycle-player-2", username: "DungeonLifecyclePlayerTwo" };
    const canonical = {
      spaceId: "hatch_landing", position: { x: 500, y: 200 },
      instanceId: "dungeon:cistern_warrens_world_entrance:shared", locationType: "dungeon" as const
    };

    const [firstSession, secondSession] = await Promise.all([
      runtime.enter(first, "cistern_warrens_world_entrance", canonical),
      runtime.enter(second, "cistern_warrens_world_entrance", canonical)
    ]);
    const runRows = await pool.query<{ run_id: string }>(
      "SELECT DISTINCT run_id::text FROM dungeon_presence WHERE instance_id=$1",
      [canonical.instanceId]
    );
    expect(runRows.rows).toHaveLength(1);
    await expect(runtime.enter(first, "cistern_warrens_world_entrance", canonical)).rejects.toMatchObject({ code: "ALREADY_INSIDE" });
    expect((await pool.query(
      "SELECT count(*)::int AS count, count(DISTINCT run_id)::int AS runs FROM dungeon_presence WHERE instance_id=$1",
      [canonical.instanceId]
    )).rows[0]).toEqual({ count: 2, runs: 1 });
    await runtime.leave(first.playerId, firstSession.sessionId);
    await runtime.leave(second.playerId, secondSession.sessionId);
  });

  it("rejects an invalid arrival before writing durable presence", async () => {
    const runtime = new DungeonRuntime(pool as never, dungeonCombat() as never);
    const player = testPlayer();
    await expect(runtime.enter(player, "cistern_warrens_world_entrance", {
      spaceId: "hatch_landing", position: { x: 1, y: 1 },
      instanceId: "dungeon:cistern_warrens_world_entrance:player:invalid", locationType: "dungeon"
    })).rejects.toMatchObject({ code: "INVALID_POSITION" });
    expect((await pool.query("SELECT 1 FROM dungeon_presence WHERE player_id=$1", [player.playerId])).rowCount).toBe(0);
  });
});

function dungeonCombat(): Record<string, unknown> {
  return {
    syncPlayer: () => undefined,
    cancelCombat: () => undefined,
    entity: () => null,
    generalSkillRank: () => 0,
    spawnMob: () => undefined,
    despawnMob: () => undefined
  };
}

function testPlayer() {
  return {
    playerId: "dungeon-lifecycle-player", username: "DungeonLifecyclePlayer", displayColor: null,
    regionCode: "GLOBAL", position: { lat: 40, lon: -105 }, anchor: { lat: 40, lon: -105 },
    moveLeashRadiusM: 100, movementRevision: 1, target: null, online: true, updatedAt: new Date()
  };
}

function assertDisposableAdminUrl(value: string): URL {
  const parsed = new URL(value);
  if (!["127.0.0.1", "localhost"].includes(parsed.hostname) ||
      !/^ash_atlas_stability(?:_[a-z0-9_]+)?$/u.test(parsed.pathname.slice(1))) {
    throw new Error("Dungeon lifecycle tests require a local disposable ash_atlas_stability database");
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(value)) throw new Error("Unsafe disposable database name");
  return `"${value}"`;
}
