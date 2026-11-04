import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runMigrations } from "../db/migrate.js";
import { createLogger } from "../logger.js";
import { AtlasClock } from "./atlasClock.js";
import { DeveloperLeaderboardService } from "./developerLeaderboards.js";
import { WeeklyLeaderboardService } from "./weeklyLeaderboards.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const currentInstant = new Date("2026-07-16T18:00:00.000Z");

describeDatabase("weekly leaderboard PostgreSQL integration", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    await runMigrations(databaseUrl!);
    pool = new pg.Pool({ connectionString: databaseUrl!, max: 12 });
  }, 30_000);

  beforeEach(async () => {
    await pool.query("TRUNCATE players CASCADE");
    await createPlayer("owner", "Owner");
    await createPlayer("other", "Other");
  });

  afterAll(async () => {
    await pool?.query("TRUNCATE players CASCADE");
    await pool?.end();
  });

  it("captures only completed personal builds, excluding raw automatic flags, conversion, reinforcement, and deletion", async () => {
    const builtFlag = await createFlag("owner", "2026-07-14T12:00:00.000Z");
    await pool.query(
      `INSERT INTO flag_build_operations (
         operation_key,player_id,request_id,flag_id,created_at
       ) VALUES ('flag-build:owner:request','owner','request',$1,$2)`,
      [builtFlag, "2026-07-14T12:00:01.000Z"]
    );
    await expect(pool.query(
      `INSERT INTO flag_build_operations (
         operation_key,player_id,request_id,flag_id,created_at
       ) VALUES ('flag-build:owner:request','owner','request',$1,$2)
       ON CONFLICT DO NOTHING`,
      [builtFlag, "2026-07-14T12:00:02.000Z"]
    )).resolves.toMatchObject({ rowCount: 0 });

    await createFlag("owner", "2026-07-14T12:01:00.000Z", 36);
    await pool.query(
      `UPDATE flags SET reinforcement_level=1,health=200,maximum_health=200 WHERE id=$1`,
      [builtFlag]
    );
    await pool.query("DELETE FROM flags WHERE id=$1", [builtFlag]);

    const triggerTables = await triggerSourceTables(
      "weekly_leaderboard_flag_build_capture"
    );
    expect(triggerTables).toEqual(["flag_build_operations"]);
    expect(await eventValue("flags_built", "owner")).toBe(1);
  });

  it("captures city founding once but not replay, joining, mayor changes, or deactivation", async () => {
    const seatFlag = await createFlag("owner", "2026-07-14T13:00:00.000Z");
    const cityId = randomUUID();
    await pool.query(
      `INSERT INTO cities (
         id,world_id,canonical_municipality_id,
         world_settlement_id,world_settlement_source,world_source_settlement_id,
         name,country_code,region_code,founder_player_id,mayor_player_id,
         founding_request_id,seat_flag_id,hall_lat,hall_lon,hall_geom,
         founding_annex_radius_m,created_at,mayor_house_deadline,
         mayor_confirmed_at
       ) VALUES (
         $1,'main',$2,$2,'world','source-city',
         'Test City','US','US-NM','owner',NULL,
         'found-request',$3,35,-106,
         ST_SetSRID(ST_MakePoint(-106,35),4326),10000,$4,
         $4::timestamptz + interval '15 minutes',NULL
      )`,
      [cityId, `settlement-${cityId}`, seatFlag, "2026-07-14T13:00:01.000Z"]
    );
    await expect(pool.query(
      "INSERT INTO cities SELECT * FROM cities WHERE id=$1 ON CONFLICT DO NOTHING",
      [cityId]
    )).resolves.toMatchObject({ rowCount: 0 });
    await pool.query(
      `INSERT INTO city_memberships (city_id,player_id,world_id,role,left_at)
       VALUES ($1,'other','main','member',now())`,
      [cityId]
    );
    await pool.query(
      `UPDATE cities
       SET mayor_player_id='other',active=false,jumpable=false,
           inactive_reason='abandoned',ended_at=now(),
           rebuild_available_at=now() + interval '7 days'
       WHERE id=$1`,
      [cityId]
    );
    await pool.query("DELETE FROM city_memberships WHERE city_id=$1", [cityId]);
    await pool.query("DELETE FROM cities WHERE id=$1", [cityId]);

    expect(await triggerSourceTables("weekly_leaderboard_city_founding_capture"))
      .toEqual(["cities"]);
    expect(await eventValue("cities_founded", "owner")).toBe(1);
    expect(await eventValue("cities_founded", "other")).toBe(0);
  });

  it("uses canonical reward ownership and mob IDs while excluding duplicate deaths and non-death cleanup", async () => {
    for (const [mob, category] of [
      ["mysterious_traveler", "mysterious_travelers_killed"],
      ["ogre", "ogres_killed"],
      ["deer", "deer_killed"],
      ["wolf", "wolves_killed"],
      ["sap_crawler", "resin_crawlers_killed"]
    ] as const) {
      await createCombatSettlement(mob, "owner");
      expect(await eventValue(category, "owner")).toBe(1);
    }
    await createCombatSettlement("goblin", "owner");
    await createCombatSettlement("wolf", null);
    const duplicateMobId = randomUUID();
    await createCombatSettlement("wolf", "owner", duplicateMobId);
    await expect(createCombatSettlement("wolf", "owner", duplicateMobId, true))
      .resolves.toBe(0);

    expect(await triggerSourceTables("weekly_leaderboard_mob_death_capture"))
      .toEqual(["combat_reward_settlements"]);
    expect(await eventValue("wolves_killed", "owner")).toBe(2);
    expect(await totalEvents()).toBe(6);
  });

  it("waits for reward settlement completion before counting a mob life", async () => {
    const instanceId = randomUUID();
    await createCombatSettlement("mysterious_traveler", "owner", instanceId, false, false);
    expect(await eventValue("mysterious_travelers_killed", "owner")).toBe(0);

    await pool.query(
      `UPDATE combat_reward_settlements
       SET status='completed',completed_at='2026-07-14T14:03:00Z'
       WHERE defeated_mob_instance_id=$1`,
      [instanceId]
    );
    await pool.query(
      `UPDATE combat_reward_settlements SET updated_at=now()
       WHERE defeated_mob_instance_id=$1`,
      [instanceId]
    );
    expect(await eventValue("mysterious_travelers_killed", "owner")).toBe(1);
  });

  it("counts one completed wood harvest session independent of yield", async () => {
    const woodSession = await createHarvestSession("wood");
    await pool.query(
      `UPDATE harvest_sessions
       SET status='completed',completed_at='2026-07-14T13:00:00Z',
           mastery_results='{"baseQuantity":1,"bonusQuantity":9}'::jsonb
       WHERE id=$1`,
      [woodSession]
    );
    await pool.query(
      "UPDATE harvest_sessions SET updated_at=now() WHERE id=$1",
      [woodSession]
    );
    expect(await eventValue("trees_chopped", "owner")).toBe(1);

    const foodSession = await createHarvestSession("food");
    await pool.query(
      `UPDATE harvest_sessions
       SET status='completed',completed_at='2026-07-14T13:05:00Z'
       WHERE id=$1`,
      [foodSession]
    );
    const cancelledWood = await createHarvestSession("wood");
    await pool.query(
      `UPDATE harvest_sessions
       SET status='cancelled',cancelled_at='2026-07-14T13:06:00Z'
       WHERE id=$1`,
      [cancelledWood]
    );
    expect(await eventValue("trees_chopped", "owner")).toBe(1);
  });

  it("captures actual positive character EXP but excludes replay, profession, and corrections", async () => {
    const operationId = randomUUID();
    await createXpOperation(operationId, "character-xp:one", "owner", 37);
    await expect(createXpOperation(operationId, "character-xp:one", "owner", 37, true))
      .resolves.toBe(0);
    await createXpOperation(randomUUID(), "character-xp:zero", "owner", 0);
    await expect(
      createXpOperation(randomUUID(), "character-xp:negative", "owner", -1)
    ).rejects.toMatchObject({ code: "23514" });

    expect(await triggerSourceTables("weekly_leaderboard_character_xp_capture"))
      .toEqual(["xp_operations"]);
    expect(await eventValue("exp_earned", "owner")).toBe(37);
  });

  it("projects concurrent increments atomically and keeps deterministic tie ordering", async () => {
    await pool.query(
      `INSERT INTO weekly_leaderboard_events (
         source_type,source_id,player_id,category,value,occurred_at,week_start
       ) VALUES
         ('character_xp','concurrent-a','owner','exp_earned',9,
          '2026-07-14T12:00:00Z','2026-07-13'),
         ('character_xp','concurrent-b','owner','exp_earned',11,
          '2026-07-14T12:01:00Z','2026-07-13'),
         ('character_xp','tie-other','other','exp_earned',20,
          '2026-07-14T12:00:00Z','2026-07-13')`
    );
    const first = service();
    const second = service();
    await Promise.all([first.flush(), second.flush()]);

    const snapshot = await first.snapshot("owner");
    const board = snapshot.boards.find(({ category }) => category === "exp_earned")!;
    expect(board.top.map(({ playerId, value }) => ({ playerId, value }))).toEqual([
      { playerId: "other", value: 20 },
      { playerId: "owner", value: 20 }
    ]);
  });

  it("returns bounded nearby ranks outside the top 100 and preserves totals through name changes", async () => {
    const values: unknown[] = [];
    const tuples: string[] = [];
    for (let index = 0; index < 105; index += 1) {
      const playerId = index === 104 ? "owner" : `rank-${index.toString().padStart(3, "0")}`;
      if (playerId !== "owner") await createPlayer(playerId, `Player ${index}`);
      const valueOffset = values.length;
      values.push("2026-07-13", playerId, 1_000 - index, "2026-07-14T12:00:00Z");
      tuples.push(
        `($${valueOffset + 1}::date,$${valueOffset + 2},'flags_built',$${valueOffset + 3},$${valueOffset + 4}::timestamptz)`
      );
    }
    await pool.query(
      `INSERT INTO weekly_leaderboard_totals (
         week_start,player_id,category,value,reached_at
       ) VALUES ${tuples.join(",")}`,
      values
    );
    await pool.query("UPDATE players SET username='Renamed Owner' WHERE id='owner'");

    const snapshot = await service().snapshot("owner");
    const board = snapshot.boards.find(({ category }) => category === "flags_built")!;
    expect(board.top).toHaveLength(100);
    expect(board.personal).toMatchObject({ value: 896, rank: 105 });
    expect(board.personal.nearby).toHaveLength(3);
    expect(board.personal.nearby.at(-1)).toMatchObject({
      rank: 105,
      playerId: "owner",
      displayName: "Renamed Owner"
    });
  });

  it("starts a new empty week while preserving the archived prior week", async () => {
    await pool.query(
      `INSERT INTO weekly_leaderboard_totals (
         week_start,player_id,category,value,reached_at
       ) VALUES ('2026-07-06','owner','cities_founded',2,'2026-07-07T12:00:00Z')`
    );
    const leaderboards = service(new Date("2026-07-13T06:00:00.000Z"));
    const current = await leaderboards.snapshot("owner", "current");
    const previous = await leaderboards.snapshot("owner", "previous");

    expect(current.weekStart).toBe("2026-07-13");
    expect(current.boards.every(({ personal }) => personal.value === 0)).toBe(true);
    expect(previous).toMatchObject({ weekStart: "2026-07-06", archived: true });
    expect(previous.boards.find(({ category }) => category === "cities_founded")?.personal.value)
      .toBe(2);
  });

  it("keeps the owner chat metric private, visible-only, and deterministically ranked", async () => {
    const scopeId = randomUUID();
    for (const type of ["city", "kingdom", "party"] as const) {
      await createChatChannel(`${type}:${scopeId}`, type);
      await createChatMessage(`${type}:${scopeId}`, "owner", "visible", "2026-07-14T10:03:00Z");
    }
    await createChatMessage("public:general", "owner", "visible", "2026-07-14T10:00:00Z");
    await createChatMessage("public:trading", "owner", "visible", "2026-07-14T10:01:00Z");
    await createChatMessage("public:hunting", "owner", "visible", "2026-07-14T10:02:00Z");
    await createChatMessage("local:map", "owner", "visible", "2026-07-14T10:03:00Z");
    await createChatMessage("public:general", "owner", "hidden", "2026-07-14T10:04:00Z");
    await createChatMessage("public:general", "owner", "deleted", "2026-07-14T10:05:00Z");
    await createChatMessage("public:general", "owner", "visible", "2026-07-01T10:05:00Z");
    await createChatMessage("public:general", "other", "visible", "2026-07-14T09:00:00Z");
    await createChatMessage("public:trading", "other", "visible", "2026-07-14T09:01:00Z");
    await createChatMessage("public:hunting", "other", "visible", "2026-07-14T09:02:00Z");

    const publicService = service();
    const developer = new DeveloperLeaderboardService(
      pool,
      publicService,
      new AtlasClock(() => currentInstant)
    );
    const inspected = await developer.inspectPlayer("owner", "current");
    const privateMetric = inspected.metrics.find(
      ({ visibility }) => visibility === "owner_only"
    );
    expect(inspected.metrics.filter(({ visibility }) => visibility === "public"))
      .toHaveLength(9);
    expect(privateMetric).toMatchObject({
      value: 3,
      rank: 2,
      breakdown: [
        { label: "General", value: 1 },
        { label: "Trading", value: 1 },
        { label: "Hunting", value: 1 }
      ]
    });

    const ranking = await developer.privateRanking(privateMetric!.key, "current");
    expect(ranking.entries.map(({ playerId, rank, value }) => ({ playerId, rank, value })))
      .toEqual([
        { playerId: "other", rank: 1, value: 3 },
        { playerId: "owner", rank: 2, value: 3 }
      ]);
  });

  function service(now = currentInstant): WeeklyLeaderboardService {
    return new WeeklyLeaderboardService(
      pool,
      createLogger("weekly-leaderboard-test"),
      new AtlasClock(() => now)
    );
  }

  async function createPlayer(id: string, username: string): Promise<void> {
    await pool.query(
      `INSERT INTO players (
         id,username,username_normalized,region_code,lat,lon,
         anchor_lat,anchor_lon,move_leash_radius_m,online,geom
       ) VALUES (
         $1,$2,lower($2),'US-NM',35,-106,35,-106,1250,false,
         ST_SetSRID(ST_MakePoint(-106,35),4326)
       )`,
      [id, username]
    );
  }

  async function createFlag(
    ownerId: string,
    createdAt: string,
    lat = 35
  ): Promise<string> {
    const flagId = randomUUID();
    await pool.query(
      `INSERT INTO flags (
         id,owner_id,name,lat,lon,claim_radius_m,
         resource_vision_radius_m,environment_snapshot,geom,created_at
       ) VALUES (
         $1,$2,'Flag',$4,-106,10000,1000,'{}'::jsonb,
         ST_SetSRID(ST_MakePoint(-106,$4),4326),$3
       )`,
      [flagId, ownerId, createdAt, lat]
    );
    return flagId;
  }

  async function createCombatSettlement(
    mobArchetype: string,
    rewardPlayerId: string | null,
    instanceId = randomUUID(),
    ignoreConflict = false,
    complete = true
  ): Promise<number> {
    const result = await pool.query(
      `INSERT INTO combat_reward_settlements (
         settlement_key,defeated_mob_instance_id,mob_life_generation,
         mob_archetype,server_tick,status,candidate,reward_player_id,created_at
       ) VALUES (
         $1,$2,1,$3,1,'pending','{}'::jsonb,$4,'2026-07-14T14:00:00Z'
       )
       ${ignoreConflict ? "ON CONFLICT DO NOTHING" : ""}`,
      [`${instanceId}:defeat:1`, instanceId, mobArchetype, rewardPlayerId]
    );
    if (result.rowCount === 1 && complete) {
      await pool.query(
        `UPDATE combat_reward_settlements
         SET status='completed',completed_at='2026-07-14T14:02:00Z'
         WHERE settlement_key=$1`,
        [`${instanceId}:defeat:1`]
      );
    }
    return result.rowCount ?? 0;
  }

  async function createHarvestSession(resourceType: "wood" | "food"): Promise<string> {
    const suffix = randomUUID();
    const nodeId = `leaderboard-node-${suffix}`;
    const sessionId = randomUUID();
    await pool.query(
      `INSERT INTO harvest_sessions (
         id,player_id,node_id,resource_type,operation_key,status,
         started_at,completes_at,expires_at
       ) VALUES (
         $1,'owner',$2,$3,$4,'active',
         '2026-07-14T12:00:00Z','2026-07-14T12:01:00Z','2026-07-14T12:02:00Z'
       )`,
      [sessionId, nodeId, resourceType, `leaderboard-harvest-${suffix}`]
    );
    return sessionId;
  }

  async function createChatMessage(
    channelKey: string,
    playerId: string,
    status: "visible" | "hidden" | "deleted",
    createdAt: string
  ): Promise<void> {
    const channel = await pool.query<{ id: string }>(
      "SELECT id::text FROM chat_channels WHERE channel_key=$1",
      [channelKey]
    );
    const channelId = channel.rows[0]!.id;
    const sequence = await pool.query<{ next: string }>(
      `SELECT (COALESCE(max(sequence_number),0)+1)::text AS next
       FROM chat_messages WHERE channel_id=$1`,
      [channelId]
    );
    await pool.query(
      `INSERT INTO chat_messages (
         id,channel_id,sequence_number,sender_player_id,sender_display_name,
         body,client_request_id,message_status,moderation_status,
         deleted_at,deletion_reason,created_at
       ) VALUES (
         $1,$2,$3,$4,$4 || ' name','message',$5,$6,'clear',
         CASE WHEN $6='deleted' THEN $7::timestamptz ELSE NULL END,
         CASE WHEN $6='deleted' THEN 'moderated' ELSE NULL END,$7
       )`,
      [randomUUID(), channelId, sequence.rows[0]!.next, playerId, randomUUID(), status, createdAt]
    );
  }

  async function createChatChannel(
    channelKey: string,
    channelType: "city" | "kingdom" | "party"
  ): Promise<void> {
    await pool.query(
      `INSERT INTO chat_channels (
         id,channel_key,channel_type,display_name,visibility_policy,
         send_access_policy,history_retention_policy,rate_limit_policy,
         moderation_policy,active
       ) VALUES (
         $1,$2,$3,$3,'authenticated_scope_v1','authenticated_scope_v1',
         'bounded_scope_v1','public_standard_v1','public_chat_v1',true
       )`,
      [randomUUID(), channelKey, channelType]
    );
  }

  async function createXpOperation(
    operationId: string,
    operationKey: string,
    playerId: string,
    grantedXp: number,
    ignoreConflict = false
  ): Promise<number> {
    const result = await pool.query(
      `INSERT INTO xp_operations (
         operation_id,operation_key,player_id,source_type,source_id,
         requested_xp,granted_xp,discarded_xp,previous_xp,resulting_xp,
         previous_level,resulting_level,replay_result,metadata,created_at
       ) VALUES (
         $1,$2,$3,'harvest','source',$4::integer,$4::integer,0,0,$4::bigint,0,0,'{}'::jsonb,'{}'::jsonb,
         '2026-07-14T15:00:00Z'
       )
       ${ignoreConflict ? "ON CONFLICT DO NOTHING" : ""}`,
      [operationId, operationKey, playerId, grantedXp]
    );
    return result.rowCount ?? 0;
  }

  async function eventValue(category: string, playerId: string): Promise<number> {
    const result = await pool.query<{ value: string }>(
      `SELECT COALESCE(sum(value),0)::text AS value
       FROM weekly_leaderboard_events
       WHERE category=$1 AND player_id=$2`,
      [category, playerId]
    );
    return Number(result.rows[0]?.value ?? 0);
  }

  async function totalEvents(): Promise<number> {
    const result = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM weekly_leaderboard_events"
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async function triggerSourceTables(triggerName: string): Promise<string[]> {
    const result = await pool.query<{ table_name: string }>(
      `SELECT DISTINCT event_object_table AS table_name
       FROM information_schema.triggers
       WHERE trigger_name=$1
       ORDER BY event_object_table`,
      [triggerName]
    );
    return result.rows.map(({ table_name }) => table_name);
  }
});
