import { randomUUID } from "node:crypto";

import { cityBuildingWarfareProfile } from "@ash-atlas/shared";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runMigrations } from "../db/migrate.js";
import { CityStructureService } from "./cityStructures.js";
import {
  applyCityBuildingBombInTransaction,
  attackCityBuilding,
  lockCityBuildingInTransaction,
  reconcileCityBuildingWarfare,
  startCityBuildingRepair,
  stopCityBuildingRepairForPlayer
} from "./cityStructureWarfare.js";

const databaseUrl = process.env.WAR_STRUCTURES_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const BUILDING = { lat: 35.02, lon: -106.01 } as const;
const HOUR_MS = 3_600_000;

describeDatabase("city building warfare PostgreSQL integration", () => {
  let pool: pg.Pool;
  let structures: CityStructureService;
  let cityId = "";

  beforeAll(async () => {
    const name = new URL(databaseUrl!).pathname.slice(1);
    if (!name.startsWith("ash_atlas_stability")) {
      throw new Error("WAR_STRUCTURES_TEST_DATABASE_URL must target an ash_atlas_stability* database");
    }
    await runMigrations(databaseUrl!);
    pool = new pg.Pool({ connectionString: databaseUrl!, max: 8 });
    structures = new CityStructureService(pool, "global", {} as never, {} as never, {} as never);
  }, 120_000);

  beforeEach(async () => {
    await pool.query("TRUNCATE organization_wars, organization_war_alerts, players CASCADE");
    for (const id of ["mayor", "citizen", "raider"]) await createPlayer(id);
    cityId = await createCity("mayor");
    await addCityMember(cityId, "mayor", "mayor");
    await addCityMember(cityId, "citizen", "member");
  });

  afterAll(async () => {
    await pool?.query("TRUNCATE organization_wars, organization_war_alerts, players CASCADE");
    await pool?.end();
  });

  it("matches the shared health table in SQL", async () => {
    for (const type of ["city_house", "oil_well", "quartz_hut", "salon", "barracks", "demolition_factory",
      "warehouse", "market", "city_kennel", "cistern_warrens", "monument", "mayor_house"]) {
      const sql = await pool.query<{ health: number | null }>(
        "SELECT city_structure_warfare_maximum_health($1) AS health", [type]
      );
      expect(sql.rows[0]!.health).toBe(cityBuildingWarfareProfile(type)?.maximumHealth ?? null);
    }
  });

  it("lets a hostile player attack a building but not a member of its city", async () => {
    const warehouse = await insertBuilding("warehouse");
    await expect(attack("citizen", warehouse, "ally")).rejects.toMatchObject({ code: "CITY_BUILDING_ATTACK_ALLY" });
    const first = await attack("raider", warehouse, "hostile-1");
    expect(first).toMatchObject({ damage: 25, replayed: false });
    expect((await attack("raider", warehouse, "hostile-1")).replayed).toBe(true);
    await expect(attack("raider", warehouse, "hostile-2")).rejects.toMatchObject({ code: "CITY_BUILDING_ATTACK_COOLDOWN" });
    expect(await healthOf(warehouse)).toBe(22_975);
  });

  it("ignites at the burn threshold and burns out to destroyed, keeping warehouse items", async () => {
    const warehouse = await insertBuilding("warehouse");
    await pool.query(
      `INSERT INTO city_warehouse_stacks (city_id,slot_index,item_id,variant,quantity)
       VALUES ($1,0,'stone','default',40)`,
      [cityId]
    );
    await setCheckpoint(warehouse, 11_900, false);
    const hit = await withTransaction((client) => applyCityBuildingBombInTransaction(client, warehouse, "raider"));
    expect(hit).toMatchObject({ dealt: 400, health: 11_500, ignited: true, fallen: false });
    await expect(withTransaction((client) => applyCityBuildingBombInTransaction(client, warehouse, "raider")))
      .rejects.toMatchObject({ code: "CITY_BUILDING_BURNING" });

    // 26 h into the 27 h burn: 426 health left, still standing.
    await shiftCheckpoint(warehouse, 26 * HOUR_MS);
    expect(await healthOf(warehouse)).toBe(426);
    await reconcileCityBuildingWarfare(pool, () => true);
    expect((await row(warehouse)).state).toBe("active");

    await shiftCheckpoint(warehouse, HOUR_MS);
    const sweep = await structures.reconcileBuildingWarfare(() => true);
    expect(sweep.changedStructureIds).toContain(warehouse);
    expect(sweep.destroyed.map((entry) => entry.structure.structureId)).toEqual([warehouse]);
    expect(await row(warehouse)).toMatchObject({ state: "destroyed", health: 0, burning_since: null });
    const stacks = await pool.query<{ quantity: string }>(
      "SELECT quantity::text FROM city_warehouse_stacks WHERE city_id=$1", [cityId]
    );
    expect(stacks.rows.map((stack) => Number(stack.quantity))).toEqual([40]);
  });

  it("repairs at 5x the burn rate with the burn paused, and triples damage while repairing", async () => {
    const warehouse = await insertBuilding("warehouse");
    await setCheckpoint(warehouse, 6_000, true);
    await expect(startCityBuildingRepair(pool, { playerId: "raider", structureId: warehouse, player: near() }))
      .rejects.toMatchObject({ code: "CITY_BUILDING_REPAIR_MEMBER_REQUIRED" });
    await startCityBuildingRepair(pool, { playerId: "citizen", structureId: warehouse, player: near() });
    // Warehouse burn: 11,500 over 27 h = about 426/h; a full repair takes much less, restoring 2,129 in the first hour.
    await shiftCheckpoint(warehouse, HOUR_MS);
    expect(await healthOf(warehouse)).toBe(8_129);

    // A bomb on a repairing building deals 3x and ignores the threshold floor.
    const hit = await withTransaction((client) => applyCityBuildingBombInTransaction(client, warehouse, "raider"));
    expect(hit).toMatchObject({ dealt: 3_450, health: 4_679, fallen: false });

    // Stopping below the threshold resumes the burn from the restored health.
    expect(await stopCityBuildingRepairForPlayer(pool, "citizen")).toMatchObject({ structureId: warehouse });
    await shiftCheckpoint(warehouse, HOUR_MS);
    expect(await healthOf(warehouse)).toBe(4_254);

    // A repair that lifts the building above its threshold puts the burn out.
    await startCityBuildingRepair(pool, { playerId: "citizen", structureId: warehouse, player: near() });
    // 4,254 + 8,518 (4 h of repair) = 12,772, above the 11,500 threshold.
    await shiftCheckpoint(warehouse, 4 * HOUR_MS);
    await reconcileCityBuildingWarfare(pool, () => false);
    expect(await row(warehouse)).toMatchObject({ health: 12_772, burning_since: null, repair_player_id: null });
  });

  it("never lets a ember bomb hit a City House", async () => {
    const house = (await pool.query<{ structure_id: string }>(
      "SELECT house_structure_id::text AS structure_id FROM city_memberships WHERE player_id='citizen'"
    )).rows[0]!.structure_id;
    await expect(withTransaction((client) => applyCityBuildingBombInTransaction(client, house, "raider")))
      .rejects.toMatchObject({ code: "CITY_BUILDING_BOMB_IMMUNE" });
    expect(await healthOf(house)).toBe(17_500);
  });

  it("destroys a burnt-out City House and ends its owner's membership", async () => {
    const house = (await pool.query<{ structure_id: string }>(
      "SELECT house_structure_id::text AS structure_id FROM city_memberships WHERE player_id='citizen'"
    )).rows[0]!.structure_id;
    await setCheckpoint(house, 100, true);
    await shiftCheckpoint(house, 10 * HOUR_MS);
    const sweep = await structures.reconcileBuildingWarfare(() => true);
    expect(sweep.destroyed).toEqual([expect.objectContaining({ ownerPlayerId: "citizen", membershipEnded: true })]);
    const membership = await pool.query(
      "SELECT 1 FROM city_memberships WHERE player_id='citizen' AND left_at IS NULL"
    );
    expect(membership.rowCount).toBe(0);
  });

  async function attack(playerId: string, structureId: string, requestId: string) {
    return attackCityBuilding(pool, { playerId, structureId, requestId, player: near() });
  }

  function near() {
    return { position: BUILDING, target: null, online: true } as const;
  }

  async function healthOf(structureId: string): Promise<number> {
    return withTransaction(async (client) => (await lockCityBuildingInTransaction(client, structureId))!.health);
  }

  async function row(structureId: string) {
    return (await pool.query<{ state: string; health: number | null; burning_since: Date | null; repair_player_id: string | null }>(
      "SELECT state,health,burning_since,repair_player_id FROM city_structures WHERE structure_id=$1",
      [structureId]
    )).rows[0]!;
  }

  async function setCheckpoint(structureId: string, health: number, burning: boolean): Promise<void> {
    await pool.query(
      `UPDATE city_structures SET health=$2,health_at=clock_timestamp(),
         burning_since=CASE WHEN $3 THEN clock_timestamp() ELSE NULL END
       WHERE structure_id=$1`,
      [structureId, health, burning]
    );
  }

  /** Moves the checkpoint (and any repair start) into the past, as if time passed. */
  async function shiftCheckpoint(structureId: string, ms: number): Promise<void> {
    await pool.query(
      `UPDATE city_structures
       SET health_at=health_at-($2::bigint*interval '1 millisecond'),
           burning_since=burning_since-($2::bigint*interval '1 millisecond'),
           repair_started_at=repair_started_at-($2::bigint*interval '1 millisecond')
       WHERE structure_id=$1`,
      [structureId, ms]
    );
  }

  async function withTransaction<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
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

  async function insertBuilding(type: "warehouse"): Promise<string> {
    const result = await pool.query<{ structure_id: string }>(
      `INSERT INTO city_structures (
         structure_id, city_id, structure_type, tier, owner_player_id, world_id,
         lat, lon, geom, footprint_geom, footprint_radius_m, state, build_operation_key, built_at
       ) VALUES (
         gen_random_uuid(), $1, $2, 1, NULL, 'global', $3, $4,
         ST_SetSRID(ST_MakePoint($4,$3),4326),
         ST_Buffer(ST_SetSRID(ST_MakePoint($4,$3),4326)::geography,10)::geometry,
         10, 'active', $5, clock_timestamp()
       ) RETURNING structure_id::text`,
      [cityId, type, BUILDING.lat, BUILDING.lon, `war-c3-${randomUUID()}`]
    );
    return result.rows[0]!.structure_id;
  }

  async function createPlayer(id: string): Promise<void> {
    const accountId = randomUUID();
    await pool.query("INSERT INTO accounts (id,status,trust_tier) VALUES ($1,'active','standard')", [accountId]);
    await pool.query(
      `INSERT INTO players (
         id, account_id, username, username_normalized, display_color, region_code, lat, lon,
         anchor_lat, anchor_lon, move_leash_radius_m, online, geom
       ) VALUES ($1,$2,$1,$1,'#38bdf8','NM',35,-106,35,-106,900,true,ST_SetSRID(ST_MakePoint(-106,35),4326))`,
      [id, accountId]
    );
  }

  async function createCity(mayorId: string): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO cities (
         id, world_id, canonical_municipality_id, world_settlement_id, world_settlement_source,
         world_source_settlement_id, name, country_code, region_code, founder_player_id,
         founding_request_id, construction_phase, construction_completed_at, jumpable,
         seat_flag_id, hall_lat, hall_lon, hall_geom, founding_annex_radius_m, mayor_player_id
       ) VALUES ($1,'global',$2,$2,'overture',$2,'Ashford','US','US-NM',$3,$4,'complete',now(),true,
                 NULL,35.01,-106,ST_SetSRID(ST_MakePoint(-106,35.01),4326),500,$3)`,
      [id, `test:${id}`, mayorId, randomUUID()]
    );
    await pool.query("INSERT INTO city_treasuries (city_id) VALUES ($1) ON CONFLICT DO NOTHING", [id]);
    return id;
  }

  async function addCityMember(city: string, playerId: string, role: "mayor" | "member"): Promise<void> {
    await pool.query(
      `WITH house AS (
         INSERT INTO city_structures (
           structure_id, city_id, structure_type, tier, owner_player_id, world_id,
           lat, lon, geom, footprint_geom, footprint_radius_m, state, build_operation_key, built_at
         ) VALUES (
           gen_random_uuid(), $1, 'city_house', 1, $2, 'global', $5, $6,
           ST_SetSRID(ST_MakePoint($6,$5),4326),
           ST_Buffer(ST_SetSRID(ST_MakePoint($6,$5),4326)::geography,10)::geometry,
           10, 'active', $3, clock_timestamp()
         ) RETURNING structure_id
       )
       INSERT INTO city_memberships (city_id, player_id, world_id, role, house_structure_id, joined_at)
       SELECT $1, $2, 'global', $4, structure_id, clock_timestamp() FROM house`,
      [city, playerId, `war-c3-house-${city}-${playerId}`, role, BUILDING.lat, BUILDING.lon]
    );
  }
});
