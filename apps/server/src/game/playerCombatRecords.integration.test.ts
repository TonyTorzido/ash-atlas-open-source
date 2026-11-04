import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DisposableTestPool } from "../db/disposableTestPool.js";
import { runMigrations } from "../db/migrate.js";
import { ProgressionService } from "./progression.js";

const adminUrl =
  process.env.PLAYER_PACKAGE_TEST_ADMIN_URL ??
  process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;

describeDatabase("player combat records", () => {
  const databaseName = `ash_atlas_stability_combat_records_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  let pool: pg.Pool;
  let progression: ProgressionService;
  const [HUNTER, VICTIM] = ["record-hunter", "record-victim"];

  beforeAll(async () => {
    const parsed = new URL(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    await runMigrations(parsed.toString());
    if ((await runMigrations(parsed.toString())).length !== 0) {
      throw new Error("Combat record migration second run was not empty");
    }
    pool = new DisposableTestPool({ connectionString: parsed.toString(), max: 6 });
    progression = new ProgressionService(pool);
  }, 180_000);

  beforeEach(async () => {
    await pool.query("TRUNCATE accounts CASCADE");
    for (const playerId of [HUNTER, VICTIM]) {
      const accountId = randomUUID();
      await pool.query("INSERT INTO accounts (id,trust_tier) VALUES ($1,'standard')", [accountId]);
      await pool.query(
        `INSERT INTO players (
           id,account_id,username,region_code,lat,lon,anchor_lat,anchor_lon,
           move_leash_radius_m,online,geom
         ) VALUES ($1,$2,$1,'GLOBAL',0,0,0,0,1250,false,ST_SetSRID(ST_MakePoint(0,0),4326))`,
        [playerId, accountId]
      );
    }
  });

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await admin.end();
  });

  async function record(playerId: string) {
    const result = await pool.query<{ kills: string; deaths: string; pvp_kills: string; pvp_deaths: string }>(
      "SELECT kills,deaths,pvp_kills,pvp_deaths FROM player_combat_records WHERE player_id=$1",
      [playerId]
    );
    const row = result.rows[0];
    return row
      ? { kills: Number(row.kills), deaths: Number(row.deaths), pvpKills: Number(row.pvp_kills), pvpDeaths: Number(row.pvp_deaths) }
      : null;
  }

  it("counts a mob kill, a death and a PvP kill once each, and replays add nothing", async () => {
    // Mob kill: credited once on the settlement's transition into 'completed'.
    await pool.query(
      `INSERT INTO combat_reward_settlements (
         settlement_key,defeated_mob_instance_id,mob_life_generation,mob_archetype,
         server_tick,status,reward_player_id
       ) VALUES ('kill-1','record-deer',0,'deer',1,'pending',$1)`,
      [HUNTER]
    );
    expect(await record(HUNTER)).toBeNull();
    const complete = `UPDATE combat_reward_settlements
      SET status='completed', completed_at=now(), result='{}'::jsonb WHERE settlement_key='kill-1'`;
    await pool.query(complete);
    await pool.query(complete);
    await pool.query("UPDATE combat_reward_settlements SET updated_at=now() WHERE settlement_key='kill-1'");
    expect(await record(HUNTER)).toEqual({ kills: 1, deaths: 0, pvpKills: 0, pvpDeaths: 0 });

    // Player death without a killer (mob death), replayed with the same death key.
    const mobDeath = { operationKey: "player-death:mob-1", playerId: HUNTER, metadata: { deathId: "mob-1" } };
    await progression.applyDeathPenalty(mobDeath);
    expect((await progression.applyDeathPenalty(mobDeath)).replayed).toBe(true);
    expect(await record(HUNTER)).toEqual({ kills: 1, deaths: 1, pvpKills: 0, pvpDeaths: 0 });

    // PvP: the hunter kills the victim; the retry is a replay.
    const pvpDeath = {
      operationKey: "player-death:pvp-1",
      playerId: VICTIM,
      metadata: { deathId: "pvp-1", killerPlayerId: HUNTER }
    };
    await progression.applyDeathPenalty(pvpDeath);
    expect((await progression.applyDeathPenalty(pvpDeath)).replayed).toBe(true);
    expect(await record(HUNTER)).toEqual({ kills: 2, deaths: 1, pvpKills: 1, pvpDeaths: 0 });
    expect(await record(VICTIM)).toEqual({ kills: 0, deaths: 1, pvpKills: 0, pvpDeaths: 1 });
  });
});
