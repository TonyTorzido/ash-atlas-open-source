import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runMigrations } from "../db/migrate.js";
import {
  assertKingdomFlagAction,
  clearAndPruneKingdomFlags,
  endKingdomWithCollapse
} from "./kingdoms.js";
import { FlagService } from "./flags.js";
import {
  TERRITORY_COLLAPSE_BATCH_INTERVAL_MS,
  TERRITORY_COLLAPSE_BATCH_SIZE,
  TerritoryCollapseService,
  beginTerritoryCollapseInTransaction
} from "./territoryCollapse.js";

const databaseUrl = process.env.TERRITORY_COLLAPSE_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const { Pool } = pg;
const ORIGIN = { lat: 35.0853, lon: -106.6511 };
const RADIUS_M = 100;
const STEP_M = 190; // neighbours touch (190 < 200) without covering each other's center
const LAT_STEP = STEP_M / 111_320;
const LON_STEP = STEP_M / (111_320 * Math.cos((ORIGIN.lat * Math.PI) / 180));
const FAR_FUTURE = (): Date => new Date(Date.now() + 3_600_000);

describeDatabase("territory collapse PostgreSQL integration", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    const name = new URL(databaseUrl!).pathname.slice(1);
    if (!name.startsWith("ash_atlas_stability")) {
      throw new Error("TERRITORY_COLLAPSE_TEST_DATABASE_URL must target an ash_atlas_stability* database");
    }
    await runMigrations(databaseUrl!);
    pool = new Pool({ connectionString: databaseUrl!, max: 8 });
  }, 120_000);

  beforeEach(async () => {
    await pool.query("TRUNCATE territory_collapses, players CASCADE");
    await createPlayer(pool, "mayor", "Mayor");
    await createPlayer(pool, "member", "Member");
  });

  afterAll(async () => {
    await pool?.query("TRUNCATE territory_collapses, players CASCADE");
    await pool?.end();
  });

  it("breaks every city flag in hop order across ticks and resumes after a restart", async () => {
    // Seat at the origin, then a 12-flag chain east and a 3-flag spur north of flag 2.
    const cityId = await createCity(pool, "mayor", "Ashford", 0, 0);
    const chain: string[] = [];
    for (let column = 1; column <= 12; column += 1) {
      chain.push(await createCityFlag(pool, cityId, "mayor", 0, column));
    }
    for (let row = 1; row <= 3; row += 1) {
      await createCityFlag(pool, cityId, "mayor", row, 2);
    }
    const orphan = await createCityFlag(pool, cityId, "mayor", 0, 40); // not connected
    const flags = new FlagService(pool, {} as never, {} as never, {} as never);
    const seatPoint = cellPoint(0, 3);
    await expect(flags.resolveTerritoryAtPoint(seatPoint.lat, seatPoint.lon))
      .resolves.toMatchObject({ claimed: true });

    const begun = await withTransaction(pool, async (client) => {
      await client.query(
        `UPDATE cities SET active = false, jumpable = false, inactive_reason = 'destroyed',
           ended_at = now(), rebuild_available_at = now() + interval '7 days' WHERE id = $1`,
        [cityId]
      );
      return beginTerritoryCollapseInTransaction(client, {
        kind: "city", id: cityId, displayName: "Ashford", reason: "test",
        actorPlayerId: null, notifyPlayerIds: ["member"]
      });
    });
    expect(begun.flagCount).toBe(17);

    // Collapsing flags stop claiming territory before any of them broke.
    await expect(flags.resolveTerritoryAtPoint(seatPoint.lat, seatPoint.lon))
      .resolves.toMatchObject({ claimed: false });
    await expect(pool.query(
      "SELECT count(*)::int AS n FROM flags WHERE city_id = $1 AND territory_collapse_id = $2",
      [cityId, begun.collapseId]
    )).resolves.toMatchObject({ rows: [{ n: 17 }] });

    // Batches are spread over time: the second batch is due one interval later.
    const due = await pool.query<{ wave_index: number; offset_ms: number }>(
      `SELECT wave_index, (extract(epoch FROM due_at - min(due_at) OVER ()) * 1000)::int AS offset_ms
       FROM territory_collapse_flags WHERE collapse_id = $1 ORDER BY wave_index`,
      [begun.collapseId]
    );
    expect(due.rows[TERRITORY_COLLAPSE_BATCH_SIZE - 1]?.offset_ms ?? 0).toBe(0);

    const announcements = await new TerritoryCollapseService(pool).claimAnnouncements();
    expect(announcements).toEqual([expect.objectContaining({
      collapseId: begun.collapseId, displayName: "Ashford", notifyPlayerIds: ["mayor", "member"]
    })]);
    await expect(new TerritoryCollapseService(pool).claimAnnouncements()).resolves.toEqual([]);

    const order: string[] = [];
    const first = new TerritoryCollapseService(pool);
    const firstBatch = await first.breakDueBatch(FAR_FUTURE(), 5);
    order.push(...firstBatch.flatMap((batch) => batch.flagIds));
    expect(order).toHaveLength(5);
    expect(firstBatch[0]?.completed).toBe(false);

    // Simulated restart: a fresh service picks up the remaining pending rows.
    const restarted = new TerritoryCollapseService(pool);
    for (let tick = 0; tick < 10; tick += 1) {
      const batches = await restarted.breakDueBatch(FAR_FUTURE(), 5);
      if (batches.length === 0) break;
      for (const batch of batches) {
        expect(batch.flagIds.length).toBeLessThanOrEqual(5);
        order.push(...batch.flagIds);
      }
    }
    expect(new Set(order).size).toBe(17);
    const hops = await pool.query<{ flag_id: string; wave_hop: number; status: string }>(
      "SELECT flag_id::text, wave_hop, status FROM territory_collapse_flags WHERE collapse_id = $1",
      [begun.collapseId]
    );
    const hopById = new Map(hops.rows.map((row) => [row.flag_id, row.wave_hop]));
    const orderedHops = order.map((id) => hopById.get(id)!);
    expect(orderedHops).toEqual([...orderedHops].sort((left, right) => left - right));
    expect(hopById.get(chain[0]!)).toBe(1);
    expect(hopById.get(chain[11]!)).toBe(12);
    expect(order.at(-1)).toBe(orphan);
    expect(hops.rows.every((row) => row.status === "broken")).toBe(true);
    await expect(pool.query("SELECT count(*)::int AS n FROM flags WHERE city_id = $1", [cityId]))
      .resolves.toMatchObject({ rows: [{ n: 0 }] });
    await expect(pool.query(
      "SELECT status, broken_count FROM territory_collapses WHERE collapse_id = $1",
      [begun.collapseId]
    )).resolves.toMatchObject({ rows: [{ status: "completed", broken_count: 17 }] });
    await expect(pool.query(
      `SELECT count(*)::int AS n FROM city_flag_affiliation_history
       WHERE city_id = $1 AND action = 'city_deactivated'`,
      [cityId]
    )).resolves.toMatchObject({ rows: [{ n: 17 }] });
    // Replay: nothing left to break.
    await expect(restarted.breakDueBatch(FAR_FUTURE())).resolves.toEqual([]);
  });

  it("dissolving a kingdom breaks every kingdom flag including the seat source", async () => {
    const kingdomId = await createKingdom(pool, "mayor", 0, 0);
    await pool.query(
      `INSERT INTO kingdom_memberships (id, kingdom_id, player_id, role, status, joined_at, perk_qualified_at)
       VALUES (gen_random_uuid(), $1, 'member', 'member', 'active', now(), now())`,
      [kingdomId]
    );
    const kingdomFlags: string[] = [];
    for (let column = 1; column <= 4; column += 1) {
      kingdomFlags.push(await createKingdomFlag(pool, kingdomId, "member", 0, column));
    }
    // The contributor keeps no rights over a contributed flag; the leader does.
    await expect(assertKingdomFlagAction(pool, "member", kingdomId, "destroy"))
      .rejects.toMatchObject({ code: "KINGDOM_FLAG_DESTROY_PERMISSION_REQUIRED" });
    await expect(assertKingdomFlagAction(pool, "mayor", kingdomId, "destroy"))
      .resolves.toBe("leader");
    const begun = await endKingdomWithCollapse(pool, kingdomId, "mayor", "kingdom_dissolved");
    expect(begun).toMatchObject({ kind: "kingdom", flagCount: 5 });
    await expect(endKingdomWithCollapse(pool, kingdomId, "mayor", "kingdom_dissolved"))
      .resolves.toBeNull();
    await expect(pool.query("SELECT status FROM kingdoms WHERE id = $1", [kingdomId]))
      .resolves.toMatchObject({ rows: [{ status: "dissolved" }] });
    await expect(pool.query(
      "SELECT count(*)::int AS n FROM kingdom_memberships WHERE kingdom_id = $1 AND status = 'active'",
      [kingdomId]
    )).resolves.toMatchObject({ rows: [{ n: 0 }] });
    const service = new TerritoryCollapseService(pool);
    const broken: string[] = [];
    for (let tick = 0; tick < 5; tick += 1) {
      for (const batch of await service.breakDueBatch(FAR_FUTURE())) broken.push(...batch.flagIds);
    }
    expect(broken).toHaveLength(5);
    await expect(pool.query("SELECT count(*)::int AS n FROM flags WHERE kingdom_id = $1", [kingdomId]))
      .resolves.toMatchObject({ rows: [{ n: 0 }] });
    await expect(pool.query(
      "SELECT source_flag_id FROM kingdom_seats WHERE kingdom_id = $1",
      [kingdomId]
    )).resolves.toMatchObject({ rows: [{ source_flag_id: null }] });
  });

  it("breaks released and cut-off kingdom flags instead of returning them", async () => {
    const kingdomId = await createKingdom(pool, "mayor", 0, 0);
    const kingdomFlags: string[] = [];
    for (let column = 1; column <= 4; column += 1) {
      kingdomFlags.push(await createKingdomFlag(pool, kingdomId, "member", 0, column));
    }
    const pruned = await withTransaction(pool, (client) => clearAndPruneKingdomFlags(
      client, kingdomId, [kingdomFlags[1]!], "mayor", "authorized_release", "release-1"
    ));
    expect(new Set(pruned.affectedFlagIds)).toEqual(new Set(kingdomFlags.slice(1)));
    expect(pruned.ownerPlayerIds).toEqual(["member"]);
    await expect(pool.query(
      "SELECT id::text FROM flags WHERE id = ANY($1::uuid[])",
      [kingdomFlags]
    )).resolves.toMatchObject({ rows: [{ id: kingdomFlags[0] }] });
  });

  it("breaks a 1000-flag city in bounded batches instead of one transaction", async () => {
    const cityId = await createCity(pool, "mayor", "Bigtown", 0, 0);
    const cells: Array<[number, number]> = [];
    for (let index = 1; cells.length < 999; index += 1) {
      cells.push([Math.floor(index / 40), index % 40]);
    }
    await pool.query(
      `INSERT INTO flags (id, owner_id, name, lat, lon, claim_radius_m, geom, control_type, city_id,
                          access_mode, city_affiliated_at)
       SELECT gen_random_uuid(), 'mayor', 'Bigtown''s Flag', cell.lat, cell.lon, $2,
              ST_SetSRID(ST_MakePoint(cell.lon, cell.lat), 4326), 'city', $1, 'public', now()
       FROM unnest($3::double precision[], $4::double precision[]) AS cell(lat, lon)`,
      [
        cityId,
        RADIUS_M,
        cells.map(([row, column]) => cellPoint(row, column).lat),
        cells.map(([row, column]) => cellPoint(row, column).lon)
      ]
    );
    const begun = await withTransaction(pool, (client) => beginTerritoryCollapseInTransaction(client, {
      kind: "city", id: cityId, displayName: "Bigtown", reason: "test",
      actorPlayerId: null, notifyPlayerIds: []
    }));
    expect(begun.flagCount).toBe(1_000);
    const span = await pool.query<{ span_ms: number }>(
      `SELECT (extract(epoch FROM max(due_at) - min(due_at)) * 1000)::int AS span_ms
       FROM territory_collapse_flags WHERE collapse_id = $1`,
      [begun.collapseId]
    );
    expect(span.rows[0]!.span_ms).toBe(49 * TERRITORY_COLLAPSE_BATCH_INTERVAL_MS);

    const service = new TerritoryCollapseService(pool);
    const sizes: number[] = [];
    for (let tick = 0; tick < 60; tick += 1) {
      const batches = await service.breakDueBatch(FAR_FUTURE());
      if (batches.length === 0) break;
      sizes.push(batches.reduce((total, batch) => total + batch.flagIds.length, 0));
    }
    expect(sizes).toHaveLength(1_000 / TERRITORY_COLLAPSE_BATCH_SIZE);
    expect(sizes.every((size) => size === TERRITORY_COLLAPSE_BATCH_SIZE)).toBe(true);
    await expect(pool.query("SELECT count(*)::int AS n FROM flags WHERE city_id = $1", [cityId]))
      .resolves.toMatchObject({ rows: [{ n: 0 }] });
  }, 120_000);
});

function cellPoint(row: number, column: number): { lat: number; lon: number } {
  return { lat: ORIGIN.lat + row * LAT_STEP, lon: ORIGIN.lon + column * LON_STEP };
}

async function withTransaction<T>(pool: pg.Pool, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function createPlayer(pool: pg.Pool, id: string, username: string): Promise<void> {
  const accountId = randomUUID();
  await pool.query("INSERT INTO accounts (id,status,trust_tier) VALUES ($1,'active','standard')", [accountId]);
  await pool.query(
    `INSERT INTO players (
       id, account_id, username, username_normalized, display_color, region_code, lat, lon,
       anchor_lat, anchor_lon, move_leash_radius_m, online, geom
     ) VALUES ($1,$3,$2,$1,'#38bdf8','NM',35.0853,-106.6511,35.0853,-106.6511,
               900,false,ST_SetSRID(ST_MakePoint(-106.6511,35.0853),4326))`,
    [id, username, accountId]
  );
}

async function createCity(pool: pg.Pool, mayorId: string, name: string, row: number, column: number): Promise<string> {
  const cityId = randomUUID();
  const { lat, lon } = cellPoint(row, column);
  await pool.query(
    `INSERT INTO cities (
       id, world_id, canonical_municipality_id, world_settlement_id, world_settlement_source,
       world_source_settlement_id, name, country_code, region_code, founder_player_id,
       founding_request_id, construction_phase, construction_completed_at, jumpable,
       seat_flag_id, hall_lat, hall_lon, hall_geom, founding_annex_radius_m, mayor_player_id
     ) VALUES ($1,'main',$2,$2,'overture',$2,$3,'US','US-NM',$4,$5,'complete',now(),true,
               NULL,$6,$7,ST_SetSRID(ST_MakePoint($7,$6),4326),500,$4)`,
    [cityId, `test:${name}:${cityId}`, name, mayorId, randomUUID(), lat, lon]
  );
  const seatId = await createCityFlag(pool, cityId, mayorId, row, column, "city_seat");
  await pool.query("UPDATE cities SET seat_flag_id = $2 WHERE id = $1", [cityId, seatId]);
  return cityId;
}

async function createCityFlag(
  pool: pg.Pool,
  cityId: string,
  ownerId: string,
  row: number,
  column: number,
  controlType: "city" | "city_seat" = "city"
): Promise<string> {
  const { lat, lon } = cellPoint(row, column);
  const result = await pool.query<{ id: string }>(
    `INSERT INTO flags (id, owner_id, name, lat, lon, claim_radius_m, geom, control_type, city_id,
                        access_mode, city_affiliated_at)
     VALUES (gen_random_uuid(),$1,'City Flag',$2,$3,$4,ST_SetSRID(ST_MakePoint($3,$2),4326),$5,$6,'public',now())
     RETURNING id::text`,
    [ownerId, lat, lon, RADIUS_M, controlType, cityId]
  );
  return result.rows[0]!.id;
}

async function createKingdom(pool: pg.Pool, leaderId: string, row: number, column: number): Promise<string> {
  const kingdomId = randomUUID();
  const { lat, lon } = cellPoint(row, column);
  await pool.query(
    `INSERT INTO kingdoms (id, normalized_name, display_name, founder_player_id, leader_player_id, founding_request_id)
     VALUES ($1,$2,'Emberreach',$3,$3,$4)`,
    [kingdomId, `emberreach-${kingdomId.slice(0, 8)}`, leaderId, randomUUID()]
  );
  await pool.query(
    `INSERT INTO kingdom_memberships (id, kingdom_id, player_id, role, status, joined_at, perk_qualified_at)
     VALUES (gen_random_uuid(),$1,$2,'leader','active',now(),now())`,
    [kingdomId, leaderId]
  );
  const sourceId = randomUUID();
  const seatId = randomUUID();
  await withTransaction(pool, async (client) => {
    await client.query(
      `INSERT INTO flags (id, owner_id, name, lat, lon, claim_radius_m, geom, control_type, kingdom_id,
                          access_mode, kingdom_affiliated_at, original_owner_player_id)
       VALUES ($1,$2,'Seat',$3,$4,$5,ST_SetSRID(ST_MakePoint($4,$3),4326),'kingdom_seat',$6,'private',now(),$2)`,
      [sourceId, leaderId, lat, lon, RADIUS_M, kingdomId]
    );
    await client.query(
      `INSERT INTO kingdom_seats (
         id, kingdom_id, lat, lon, geom, territory_radius_m, is_land, is_saltwater, inside_major_lake,
         environment_source_versions, environment_rules_version, environment_modifiers,
         environment_lookup_at, construction_state, completed_under_free_construction, status,
         completed_at, source_flag_id
       ) VALUES ($1,$2,$3,$4,ST_SetSRID(ST_MakePoint($4,$3),4326),$5,true,false,false,
                 '{}'::jsonb,1,'[]'::jsonb,now(),'complete',true,'active',now(),$6)`,
      [seatId, kingdomId, lat, lon, RADIUS_M, sourceId]
    );
  });
  return kingdomId;
}

async function createKingdomFlag(
  pool: pg.Pool,
  kingdomId: string,
  contributorId: string,
  row: number,
  column: number
): Promise<string> {
  const { lat, lon } = cellPoint(row, column);
  const result = await pool.query<{ id: string }>(
    `INSERT INTO flags (id, owner_id, name, lat, lon, claim_radius_m, geom, control_type, kingdom_id,
                        access_mode, kingdom_affiliated_at, original_owner_player_id, contributed_by_player_id)
     VALUES (gen_random_uuid(),'mayor','Kingdom Flag',$1,$2,$3,ST_SetSRID(ST_MakePoint($2,$1),4326),
             'kingdom',$4,'private',now(),$5,$5)
     RETURNING id::text`,
    [lat, lon, RADIUS_M, kingdomId, contributorId]
  );
  return result.rows[0]!.id;
}
