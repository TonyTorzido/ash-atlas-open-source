import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runMigrations } from "../db/migrate.js";
import { InventoryService } from "./inventory.js";
import { MonolithService, allyMonolithInRange, monolithAdjustedBuildingDamage } from "./monoliths.js";

const databaseUrl = process.env.MONOLITH_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

const HERE = { lat: 36, lon: -106 };
const NEAR = { lat: 36.001, lon: -106 }; // ~111 m away: inside the 300 m radius
const FAR = { lat: 36.01, lon: -106 }; // ~1.1 km away

describeDatabase("war monoliths PostgreSQL integration", () => {
  let pool: pg.Pool;
  let inventory: InventoryService;
  let monoliths: MonolithService;
  let kingdomId = "";

  beforeAll(async () => {
    const name = new URL(databaseUrl!).pathname.slice(1);
    if (!name.startsWith("ash_atlas_stability")) {
      throw new Error("MONOLITH_TEST_DATABASE_URL must target an ash_atlas_stability* database");
    }
    await runMigrations(databaseUrl!);
    pool = new pg.Pool({ connectionString: databaseUrl!, max: 8 });
    inventory = new InventoryService(pool);
    monoliths = new MonolithService(pool, inventory);
  }, 120_000);

  beforeEach(async () => {
    await pool.query("TRUNCATE war_monolith_operations, war_monoliths, kingdoms, players CASCADE");
    for (const id of ["engineer", "ally", "enemy"]) await createPlayer(id);
    kingdomId = randomUUID();
    await pool.query(
      `INSERT INTO kingdoms (id, normalized_name, display_name, founder_player_id, leader_player_id, founding_request_id)
       VALUES ($1,$2,'Emberreach','engineer','engineer',$3)`,
      [kingdomId, `emberreach-${kingdomId.slice(0, 8)}`, randomUUID()]
    );
    for (const [playerId, role] of [["engineer", "leader"], ["ally", "member"]] as const) {
      await pool.query(
        `INSERT INTO kingdom_memberships (id, kingdom_id, player_id, role, status, joined_at, perk_qualified_at)
         VALUES (gen_random_uuid(),$1,$2,$3,'active',now(),now())`,
        [kingdomId, playerId, role]
      );
    }
  });

  afterAll(async () => {
    await pool?.query("TRUNCATE war_monolith_operations, war_monoliths, kingdoms, players CASCADE");
    await pool?.end();
  });

  it("gates types by rank: rank 1 builds a Healer but not a Frenzy", async () => {
    await setRank("engineer", 1);
    await grant("engineer", "crystal", 5);
    await expect(monoliths.place("engineer", HERE, "berserker", "place-denied-1"))
      .rejects.toMatchObject({ code: "MONOLITH_RANK_REQUIRED" });
    const placed = await monoliths.place("engineer", HERE, "healer", "place-allowed-1");
    expect(placed.replayed).toBe(false);
    expect(await quantity("engineer", "crystal")).toBe(4);
    // Replaying the same request neither charges nor places twice.
    const replay = await monoliths.place("engineer", HERE, "healer", "place-allowed-1");
    expect(replay).toMatchObject({ replayed: true, monolithId: placed.monolithId });
    expect(await quantity("engineer", "crystal")).toBe(4);
    expect(Number((await pool.query("SELECT count(*) FROM war_monoliths")).rows[0].count)).toBe(1);
    await expect(monoliths.place("engineer", HERE, "healer", "place-again-1"))
      .rejects.toMatchObject({ code: "MONOLITH_ALREADY_STANDING" });
  });

  it("Frenzy adds 30% Siege building damage for allied Sieges in range only", async () => {
    await setRank("engineer", 2);
    await grant("engineer", "crystal", 1);
    await monoliths.place("engineer", HERE, "berserker", "frenzy-1");
    const target = { lat: 36.004, lon: -106, owner_id: "enemy", city_id: null, kingdom_id: null };
    expect(await monolithAdjustedBuildingDamage(pool, 1_000, { attacker: { playerId: "ally", position: NEAR }, target })).toBe(1_300);
    expect(await monolithAdjustedBuildingDamage(pool, 1_000, { attacker: { playerId: "enemy", position: NEAR }, target })).toBe(1_000);
    expect(await monolithAdjustedBuildingDamage(pool, 1_000, { attacker: { playerId: "ally", position: FAR }, target })).toBe(1_000);
  });

  it("Fortified cuts building damage to 55% for allied structures in range", async () => {
    await setRank("engineer", 3);
    await grant("engineer", "crystal", 1);
    await monoliths.place("engineer", HERE, "fortified", "fortified-1");
    const kingdomFlag = { ...NEAR, owner_id: "engineer", city_id: null, kingdom_id: kingdomId };
    const enemyFlag = { ...NEAR, owner_id: "enemy", city_id: null, kingdom_id: null };
    expect(await monolithAdjustedBuildingDamage(pool, 1_000, { attacker: null, target: kingdomFlag })).toBe(550);
    expect(await monolithAdjustedBuildingDamage(pool, 1_000, { attacker: null, target: enemyFlag })).toBe(1_000);
    expect(await monolithAdjustedBuildingDamage(pool, 1_000, { attacker: null, target: { ...kingdomFlag, ...FAR } })).toBe(1_000);
  });

  it("stops working after 20 h, recharges as a remnant, and retires when the remnants run out", async () => {
    await setRank("engineer", 2);
    await grant("engineer", "crystal", 2);
    const placed = await monoliths.place("engineer", HERE, "berserker", "lifetime-place-1");
    const beneficiary = { playerId: "ally", cityId: null, kingdomId };
    expect(await allyMonolithInRange(pool, "berserker", NEAR, beneficiary)).toBe(true);
    await shiftClock(placed.monolithId!, 21);
    expect(await allyMonolithInRange(pool, "berserker", NEAR, beneficiary)).toBe(false);
    const state = await monoliths.state("engineer", HERE);
    expect(state.monoliths[0]).toMatchObject({ phase: "remnant", own: true });
    await monoliths.recharge("ally", HERE, placed.monolithId!, "recharge-by-ally").catch((error) => {
      expect(error).toMatchObject({ code: "MONOLITH_MATERIALS_REQUIRED" });
    });
    await monoliths.recharge("engineer", HERE, placed.monolithId!, "recharge-1");
    expect(await allyMonolithInRange(pool, "berserker", NEAR, beneficiary)).toBe(true);
    await shiftClock(placed.monolithId!, 51);
    expect(await monoliths.retireFinished()).toBe(1);
    expect((await pool.query("SELECT status, retired_reason FROM war_monoliths")).rows[0])
      .toEqual({ status: "retired", retired_reason: "expired" });
  });

  it("only enemies can ignite; a burning monolith falls in an hour", async () => {
    await setRank("engineer", 1);
    await grant("engineer", "crystal", 1);
    await grant("ally", "crude_oil", 20);
    await grant("enemy", "crude_oil", 20);
    const placed = await monoliths.place("engineer", HERE, "healer", "ignite-target");
    await expect(monoliths.ignite("ally", HERE, placed.monolithId!, "ignite-ally"))
      .rejects.toMatchObject({ code: "MONOLITH_ALLIED" });
    await expect(monoliths.ignite("enemy", FAR, placed.monolithId!, "ignite-far"))
      .rejects.toMatchObject({ code: "MONOLITH_OUT_OF_RANGE" });
    await monoliths.ignite("enemy", HERE, placed.monolithId!, "ignite-enemy");
    expect(await quantity("enemy", "crude_oil")).toBe(0);
    expect(await quantity("ally", "crude_oil")).toBe(20);
    const burning = await monoliths.state("enemy", HERE);
    expect(burning.monoliths[0]).toMatchObject({ phase: "burning", allied: false });
    await pool.query("UPDATE war_monoliths SET burn_until = clock_timestamp() - interval '1 second'");
    expect(await monoliths.retireFinished()).toBe(1);
    expect((await pool.query("SELECT retired_reason FROM war_monoliths")).rows[0].retired_reason).toBe("burnt");
  });

  /** Moves every timestamp of the monolith `hours` into the past. */
  async function shiftClock(monolithId: string, hours: number): Promise<void> {
    await pool.query(
      `UPDATE war_monoliths SET placed_at = placed_at - $2 * interval '1 hour',
         expires_at = expires_at - $2 * interval '1 hour', remnant_until = remnant_until - $2 * interval '1 hour'
       WHERE monolith_id=$1::uuid`,
      [monolithId, hours]
    );
  }

  async function setRank(playerId: string, rank: number): Promise<void> {
    await pool.query(
      `INSERT INTO player_skill_ranks (player_id, skill_id, rank, points_spent, grandfathered, revision)
       VALUES ($1,'field_engineering',$2,$2,false,1)
       ON CONFLICT (player_id, skill_id) DO UPDATE SET rank=EXCLUDED.rank`,
      [playerId, rank]
    );
  }

  async function grant(playerId: string, itemId: "crystal" | "crude_oil", amount: number): Promise<void> {
    await inventory.grantItemsForOperation({
      operationKey: `monolith-test:${playerId}:${randomUUID()}`,
      playerId,
      source: "monolith_test",
      sourceEntityType: "monolith_test",
      sourceEntityId: playerId,
      grants: [{ itemId, variant: "default", quantity: amount }]
    });
  }

  async function quantity(playerId: string, itemId: string): Promise<number> {
    const snapshot = await inventory.getInventorySnapshot(playerId);
    return snapshot.items.filter((item) => item.resourceType === itemId).reduce((sum, item) => sum + Number(item.quantity), 0);
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
