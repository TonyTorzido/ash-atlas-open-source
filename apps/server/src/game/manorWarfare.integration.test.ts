import { MANOR_WARFARE_MAXIMUM_HEALTH } from "@ash-atlas/shared";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runMigrations } from "../db/migrate.js";
import { FlagService } from "./flags.js";
import { ManorPresenceService } from "./manor.js";
import type { PlayerRecord } from "./state.js";

const databaseUrl = process.env.MANOR_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("Manor warfare (houses) PostgreSQL authority", () => {
  let pool: pg.Pool;
  let presence: ManorPresenceService;

  beforeAll(async () => {
    await runMigrations(databaseUrl!);
    await runMigrations(databaseUrl!);
    pool = new pg.Pool({ connectionString: databaseUrl!, max: 10 });
    presence = new ManorPresenceService(pool, new FlagService(pool, {} as never, {} as never, {} as never));
  }, 60_000);

  beforeEach(async () => {
    await pool.query("TRUNCATE players CASCADE");
    await createPlayer("owner", "Ash");
    await createPlayer("raider", "Bex");
  });

  afterAll(async () => { await pool?.end(); });

  it("lets another player attack a Manor (4,400 HP, replay-safe, 24 h cooldown) but never its owner", async () => {
    const manorId = await seedBuiltManor("owner", 35, -106);
    const atManor = { position: { lat: 35, lon: -106 }, target: null, online: true };

    await expect(presence.attackManor("owner", manorId, "own-hit", atManor))
      .rejects.toMatchObject({ code: "MANOR_ATTACK_TARGET_INVALID" });

    const hit = await presence.attackManor("raider", manorId, "hit-1", atManor);
    expect(hit).toMatchObject({ damage: 25, health: MANOR_WARFARE_MAXIMUM_HEALTH - 25, replayed: false });
    await expect(presence.attackManor("raider", manorId, "hit-1", atManor))
      .resolves.toMatchObject({ damage: 25, replayed: true });
    await expect(presence.attackManor("raider", manorId, "hit-2", atManor))
      .rejects.toMatchObject({ code: "MANOR_ATTACK_COOLDOWN" });
    await expect(presence.attackManor("raider", manorId, "far", { ...atManor, position: { lat: 35.01, lon: -106 } }))
      .rejects.toMatchObject({ code: "MANOR_ATTACK_OUT_OF_RANGE" });
    expect((await presence.builtManor(manorId))?.warfare).toMatchObject({
      health: MANOR_WARFARE_MAXIMUM_HEALTH - 25,
      maximumHealth: 4_400,
      burnThreshold: 2_200,
      burnDurationMs: 90 * 60 * 60 * 1_000,
      burning: false
    });
    const enemies = await pool.query(
      "SELECT 1 FROM player_enemy_marks WHERE owner_id='owner' AND target_id='raider'"
    );
    expect(enemies.rowCount).toBe(1);
  });

  it("a burnt-down Manor keeps all its contents and furniture, refuses entry, and its owner can repair it", async () => {
    const manorId = await seedBuiltManor("owner", 35, -106);
    await pool.query(
      `INSERT INTO manor_decoration_placements
         (manor_id,definition_id,item_id,item_variant,room_id,surface_id,x,y,rotation_deg,width,height,scale_x,scale_y,anchor_x,anchor_y)
       VALUES ($1,'decoration','wood','default','manor_lobby_room','floor_surface',224,347,0,120,120,3.5,3.5,.5,.5)`,
      [manorId]
    );
    // Ignited at the threshold 101 h ago: the 90 h burn has run out.
    await pool.query(
      `UPDATE player_manors
       SET health=2000,health_at=now()-interval '101 hours',burning_since=now()-interval '101 hours'
       WHERE id=$1`,
      [manorId]
    );
    const contentsBefore = await manorContents(manorId);
    expect(contentsBefore.manor_decoration_placements).toBeGreaterThanOrEqual(1);
    const sweep = await presence.reconcileManorWarfare(() => false);
    expect(sweep.changedManorIds).toEqual([manorId]);

    const row = await pool.query(
      "SELECT built_at IS NOT NULL AS built,health,burning_since FROM player_manors WHERE id=$1",
      [manorId]
    );
    expect(row.rows[0]).toEqual({ built: true, health: 0, burning_since: null });
    // Every table that references the Manor (storage, recovery pile, furniture,
    // stations, drops, ...) keeps exactly the rows it had before the burn-out.
    expect(await manorContents(manorId)).toEqual(contentsBefore);

    await expect(presence.enter(player("owner", 35, -106))).rejects.toMatchObject({ code: "MANOR_BURNT" });
    await expect(presence.attackManor("raider", manorId, "after-burn", {
      position: { lat: 35, lon: -106 }, target: null, online: true
    })).rejects.toMatchObject({ code: "MANOR_BURNT" });

    await expect(presence.startManorRepair("raider", manorId, {
      position: { lat: 35, lon: -106 }, target: null, online: true
    })).rejects.toMatchObject({ code: "MANOR_REPAIR_OWNER_REQUIRED" });
    await expect(presence.startManorRepair("owner", manorId, {
      position: { lat: 35, lon: -106 }, target: null, online: true
    })).resolves.toMatchObject({ replayed: false });
    // Repair from 0 runs at 5x the burn rate (full in 36 h): pretend 1 h has passed.
    await pool.query(
      "UPDATE player_manors SET health_at=health_at-interval '1 hour',repair_started_at=repair_started_at-interval '1 hour' WHERE id=$1",
      [manorId]
    );
    await expect(presence.stopManorRepair("owner")).resolves.toEqual({ manorId });
    const repaired = await presence.builtManor(manorId);
    expect(repaired?.warfare?.health).toBe(122);
    await expect(presence.enter(player("owner", 35, -106))).resolves.toMatchObject({ manorId });
  });

  async function manorContents(manorId: string): Promise<Record<string, number>> {
    const tables = await pool.query<{ table_name: string; column_name: string }>(
      `SELECT c.conrelid::regclass::text AS table_name,a.attname AS column_name
       FROM pg_constraint c
       JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=c.conkey[1]
       WHERE c.contype='f' AND c.confrelid='player_manors'::regclass AND cardinality(c.conkey)=1
       ORDER BY 1,2`
    );
    const counts: Record<string, number> = {};
    for (const { table_name: table, column_name: column } of tables.rows) {
      const result = await pool.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM ${table} WHERE ${column}=$1`,
        [manorId]
      );
      counts[table] = (counts[table] ?? 0) + Number(result.rows[0]!.count);
    }
    return counts;
  }

  async function seedBuiltManor(playerId: string, lat: number, lon: number): Promise<string> {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO player_manors (owner_player_id,world_region_code,world_lat,world_lon,geom,built_at,placement_revision)
       VALUES ($1,'world-test',$2,$3,ST_SetSRID(ST_MakePoint($3,$2),4326),now(),1)
       RETURNING id`,
      [playerId, lat, lon]
    );
    return result.rows[0]!.id;
  }

  async function createPlayer(id: string, username: string): Promise<void> {
    await pool.query(
      `INSERT INTO players (id,username,region_code,lat,lon,anchor_lat,anchor_lon,move_leash_radius_m,online,geom)
       VALUES ($1,$2,'world-test',35,-106,35,-106,2000,true,ST_SetSRID(ST_MakePoint(-106,35),4326))`,
      [id, username]
    );
  }
});

function player(id: string, lat: number, lon: number): PlayerRecord {
  return {
    playerId: id, username: id, displayColor: null, regionCode: "world-test", position: { lat, lon },
    anchor: { lat: 35, lon: -106 }, moveLeashRadiusM: 2000, movementRevision: 0, target: null, online: true,
    updatedAt: new Date()
  };
}
