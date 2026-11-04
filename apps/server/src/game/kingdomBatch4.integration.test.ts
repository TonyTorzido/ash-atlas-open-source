import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../config.js";
import { runMigrations } from "../db/migrate.js";
import type { AppLogger } from "../logger.js";
import type { WorldLookupClient } from "../world/worldLookupClient.js";
import { abandonInactiveOwnerFlags } from "./flagAbandonment.js";
import { FlagService } from "./flags.js";
import { InventoryService } from "./inventory.js";
import { kingdomPerksForPlayer } from "./kingdomPerks.js";
import { KingdomService } from "./kingdoms.js";
import { settleFallenOrganizationStructures } from "./organizationStructureFall.js";

const databaseUrl = process.env.KINGDOM_BATCH4_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("kingdom downgrade, castle rubble and flag abandonment PostgreSQL integration", () => {
  let pool: pg.Pool;
  let inventory: InventoryService;
  let flags: FlagService;
  let kingdoms: KingdomService;
  let now: Date;
  let kingdomId = "";

  beforeAll(async () => {
    const name = new URL(databaseUrl!).pathname.slice(1);
    if (!name.startsWith("ash_atlas_stability")) {
      throw new Error("KINGDOM_BATCH4_TEST_DATABASE_URL must target an ash_atlas_stability* database");
    }
    await runMigrations(databaseUrl!);
    pool = new pg.Pool({ connectionString: databaseUrl!, max: 8 });
    inventory = new InventoryService(pool);
  }, 120_000);

  beforeEach(async () => {
    await pool.query("TRUNCATE kingdoms, players, flag_abandonments CASCADE");
    now = new Date("2026-10-05T12:00:00.000Z");
    for (const id of ["ruler", "squire"]) await createPlayer(id);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as AppLogger;
    flags = new FlagService(pool, {} as never, {} as never, logger as never, inventory);
    kingdoms = new KingdomService(
      pool,
      { lookupGameplayEnvironment: vi.fn(), lookupGameplayEnvironments: vi.fn() } as unknown as WorldLookupClient,
      loadConfig({ NODE_ENV: "test" }),
      logger,
      () => new Date(now)
    );
    kingdomId = await createKingdom("ruler");
    await addKingdomMember(kingdomId, "squire", "member");
  });

  afterAll(async () => {
    await pool?.query("TRUNCATE kingdoms, players CASCADE");
    await pool?.end();
  });

  it("downgrades an Obelisk one level for a 45% treasury refund, once per request, leader only", async () => {
    const flagId = await insertKingdomFlag("Watch", { obeliskLevel: 3 });
    expect(await health(flagId)).toEqual({ health: 6_900, maximumHealth: 6_900 });
    // Denied: an ordinary member.
    await expect(flags.downgradeKingdomStructure("squire", flagId, "obelisk", 3, "squire-down"))
      .rejects.toMatchObject({ code: "KINGDOM_PERMISSION_DENIED" });
    // Allowed: the leader. Level 3 cost 21,000 Bricks + 9,500 crude oil.
    const first = await flags.downgradeKingdomStructure("ruler", flagId, "obelisk", 3, "down-1");
    expect(first.replayed).toBe(false);
    expect(first.flag.obeliskLevel).toBe(2);
    expect(await health(flagId)).toEqual({ health: 4_600, maximumHealth: 4_600 });
    expect(await treasury("bricks")).toBe(9_450);
    expect(await treasury("crude_oil")).toBe(4_275);
    // Replaying the same request refunds nothing more.
    const replay = await flags.downgradeKingdomStructure("ruler", flagId, "obelisk", 3, "down-1");
    expect(replay.replayed).toBe(true);
    expect(await treasury("bricks")).toBe(9_450);
    expect(await treasury("crude_oil")).toBe(4_275);
    // A new request for the level already gone is refused; level 1 is the floor.
    await expect(flags.downgradeKingdomStructure("ruler", flagId, "obelisk", 3, "down-2"))
      .rejects.toMatchObject({ code: "KINGDOM_STRUCTURE_LEVEL_CHANGED" });
    await flags.downgradeKingdomStructure("ruler", flagId, "obelisk", 2, "down-3");
    await expect(flags.downgradeKingdomStructure("ruler", flagId, "obelisk", 1, "down-4"))
      .rejects.toMatchObject({ code: "KINGDOM_STRUCTURE_DOWNGRADE_FLOOR" });
    const rows = await pool.query(
      `SELECT operation, from_level, to_level, bricks_quantity, material_quantity
       FROM kingdom_structure_build_operations ORDER BY from_level DESC`
    );
    expect(rows.rows).toEqual([
      { operation: "downgrade", from_level: 3, to_level: 2, bricks_quantity: 9_450, material_quantity: 4_275 },
      { operation: "downgrade", from_level: 2, to_level: 1, bricks_quantity: 2_880, material_quantity: 1_485 }
    ]);
  });

  it("downgrades the Brick Furnace and Command Board through the kingdom mutation, replay-safe, leader only", async () => {
    await pool.query("INSERT INTO kingdom_brick_furnaces (kingdom_id, level) VALUES ($1, 2)", [kingdomId]);
    await pool.query("INSERT INTO kingdom_command_boards (kingdom_id, level) VALUES ($1, 3)", [kingdomId]);
    await expect(kingdoms.downgradeKingdomFacility("squire", {
      requestId: "squire-furnace", structure: "brick_furnace", fromLevel: 2
    })).rejects.toMatchObject({ code: "KINGDOM_PERMISSION_DENIED" });
    const furnace = await kingdoms.downgradeKingdomFacility("ruler", {
      requestId: "furnace-down", structure: "brick_furnace", fromLevel: 2
    });
    expect(furnace.replayed).toBe(false);
    expect(furnace.state?.brickFurnace?.level).toBe(1);
    expect(await treasury("refined_oil")).toBe(1_012);
    const replay = await kingdoms.downgradeKingdomFacility("ruler", {
      requestId: "furnace-down", structure: "brick_furnace", fromLevel: 2
    });
    expect(replay.replayed).toBe(true);
    expect(await treasury("refined_oil")).toBe(1_012);
    // Command Board 3 -> 2 refunds 45% of 325,000 Bricks / 980 Pearl / 1,640 Glimmer Oil.
    await kingdoms.downgradeKingdomFacility("ruler", { requestId: "table-down", structure: "command_board", fromLevel: 3 });
    expect(await treasury("bricks")).toBe(146_250);
    expect(await treasury("pearl")).toBe(441);
    expect(await treasury("refined_oil")).toBe(1_750);
    // The level can be built again after a downgrade (full price).
    await setTreasury("bricks", 325_000);
    await setTreasury("pearl", 980);
    await setTreasury("refined_oil", 1_640);
    await kingdoms.upgradeCommandBoard("ruler", { requestId: "table-up", targetLevel: 3 });
    expect(await treasury("bricks")).toBe(0);
    const levels = await pool.query("SELECT level FROM kingdom_command_boards WHERE kingdom_id=$1", [kingdomId]);
    expect(levels.rows[0]).toEqual({ level: 3 });
  });

  it("turns a fallen Castle into rubble (kingdom and flags kept, perks off, building held), rebuilds it, and disbands only after 7 days", async () => {
    const castleId = await insertCastle();
    const flagId = await insertKingdomFlag("Outer Watch");
    await pool.query(
      `INSERT INTO kingdom_perk_selections (kingdom_id, perk_level, perk_id, selected_at, updated_at)
       VALUES ($1, 2, 'verdant_surge', now(), now())`,
      [kingdomId]
    );
    expect((await kingdomPerksForPlayer(pool, "squire", new Date()))?.perkIds.has("verdant_surge")).toBe(true);
    const paying = new KingdomService(
      pool,
      { lookupGameplayEnvironment: vi.fn(), lookupGameplayEnvironments: vi.fn() } as unknown as WorldLookupClient,
      loadConfig({ NODE_ENV: "test", KINGDOMS_FREE_CONSTRUCTION: "false" }),
      { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as AppLogger,
      () => new Date(now)
    );

    // The Castle falls: rubble, not dissolution.
    await pool.query("UPDATE flags SET health = 0 WHERE id = $1", [castleId]);
    const begin = vi.fn(async () => null);
    const fallen = await settleFallenOrganizationStructures(pool, { begin });
    expect(begin).not.toHaveBeenCalled();
    expect(fallen.ruinedCastles.map(({ kingdomId: id }) => id)).toEqual([kingdomId]);
    expect(fallen.ruinedCastles[0]!.notifyPlayerIds.sort()).toEqual(["ruler", "squire"]);
    const kingdomRow = await pool.query<{ status: string; ruined: boolean }>(
      "SELECT status, castle_ruined_at IS NOT NULL AS ruined FROM kingdoms WHERE id = $1",
      [kingdomId]
    );
    expect(kingdomRow.rows[0]).toEqual({ status: "active", ruined: true });
    expect((await pool.query("SELECT 1 FROM flags WHERE id = ANY($1::uuid[])", [[castleId, flagId]])).rowCount).toBe(2);
    // The rubble is not selected again.
    const again = await settleFallenOrganizationStructures(pool, { begin });
    expect(again.ruinedCastles).toEqual([]);
    expect(begin).not.toHaveBeenCalled();

    // Perks give nothing; building is held; the state shows the rubble.
    expect((await kingdomPerksForPlayer(pool, "squire", new Date()))?.perkIds.size).toBe(0);
    await expect(paying.upgradeBrickFurnace("ruler", { requestId: "furnace-in-rubble", targetLevel: 1 }))
      .rejects.toMatchObject({ code: "KINGDOM_CASTLE_RUBBLE" });
    const state = await paying.getState("ruler");
    expect(state.castleRubble?.rebuildCost).toEqual([
      { resourceType: "refined_oil", quantity: 1_150 },
      { resourceType: "wood", quantity: 450 },
      { resourceType: "stone", quantity: 550 },
      { resourceType: "iron", quantity: 425 }
    ]);

    // Disband is refused for 7 days; rebuild is the leader's alone.
    await expect(paying.dissolveKingdom("ruler", "disband-early"))
      .rejects.toMatchObject({ code: "KINGDOM_CASTLE_RUBBLE_DISBAND_LOCKED" });
    await expect(paying.rebuildCastle("squire", "squire-rebuild"))
      .rejects.toMatchObject({ code: "KINGDOM_PERMISSION_DENIED" });
    // Wood from the treasury (it holds enough), stone from the leader's pack.
    await setTreasury("wood", 500);
    await grantItem("ruler", "stone", 555);
    await grantItem("ruler", "refined_oil", 1_150);
    await grantItem("ruler", "iron", 425);
    const rebuilt = await paying.rebuildCastle("ruler", "rebuild-1");
    expect(rebuilt.replayed).toBe(false);
    expect(await treasury("wood")).toBe(50);
    expect(await itemQuantity("ruler", "stone")).toBe(5);
    expect(await itemQuantity("ruler", "refined_oil")).toBe(0);
    expect(await health(castleId)).toMatchObject({ health: (await health(castleId)).maximumHealth });
    expect((await kingdomPerksForPlayer(pool, "squire", new Date()))?.perkIds.has("verdant_surge")).toBe(true);
    const replay = await paying.rebuildCastle("ruler", "rebuild-1");
    expect(replay.replayed).toBe(true);
    expect(await treasury("wood")).toBe(50);
    expect(await itemQuantity("ruler", "stone")).toBe(5);

    // A second fall; 7 days later the leader may disband (territory collapse included).
    await pool.query("UPDATE flags SET health = 0 WHERE id = $1", [castleId]);
    await settleFallenOrganizationStructures(pool, { begin });
    now = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1_000 - 60_000);
    await expect(paying.dissolveKingdom("ruler", "disband-6d23h"))
      .rejects.toMatchObject({ code: "KINGDOM_CASTLE_RUBBLE_DISBAND_LOCKED" });
    now = new Date(now.getTime() + 2 * 60_000);
    // Ruined at the real clock time; make the ruin 7 days old for this check.
    await pool.query(
      "UPDATE kingdoms SET castle_ruined_at = $2 WHERE id = $1",
      [kingdomId, new Date(now.getTime() - 7 * 24 * 60 * 60 * 1_000 - 1_000)]
    );
    await paying.dissolveKingdom("ruler", "disband-7d");
    const ended = await pool.query<{ status: string }>("SELECT status FROM kingdoms WHERE id = $1", [kingdomId]);
    expect(ended.rows[0]!.status).toBe("dissolved");
  });

  it("abandons personal flags of owners unseen for 31 days, keeps 29-day owners and kingdom flags, once", async () => {
    const day = 24 * 60 * 60 * 1_000;
    const clock = new Date();
    await createPlayer("sleeper", new Date(clock.getTime() - 31 * day));
    await createPlayer("napper", new Date(clock.getTime() - 29 * day));
    await pool.query("UPDATE players SET last_seen_at = $2 WHERE id = $1", ["ruler", new Date(clock.getTime() - 40 * day)]);
    const sleeperFlag = await insertPersonalFlag("sleeper", 36.2);
    const napperFlag = await insertPersonalFlag("napper", 36.4);
    const kingdomFlag = await insertKingdomFlag("Leader's Watch");

    const first = await abandonInactiveOwnerFlags(pool, { now: clock });
    expect(first.failures).toEqual([]);
    expect(first.abandonedFlagIds).toEqual([sleeperFlag]);
    expect(first.ownerPlayerIds).toEqual(["sleeper"]);
    const remaining = await pool.query<{ id: string }>(
      "SELECT id::text FROM flags WHERE id = ANY($1::uuid[]) ORDER BY id",
      [[sleeperFlag, napperFlag, kingdomFlag]]
    );
    expect(remaining.rows.map((row) => row.id).sort()).toEqual([napperFlag, kingdomFlag].sort());
    const audit = await pool.query("SELECT owner_player_id, reason FROM flag_abandonments WHERE flag_id = $1", [sleeperFlag]);
    expect(audit.rows).toEqual([{ owner_player_id: "sleeper", reason: "owner_inactive_30_days" }]);
    // A second (or concurrent) sweep changes nothing.
    const [again, racing] = await Promise.all([
      abandonInactiveOwnerFlags(pool, { now: clock }),
      abandonInactiveOwnerFlags(pool, { now: clock })
    ]);
    expect([...again.abandonedFlagIds, ...racing.abandonedFlagIds]).toEqual([]);
    expect((await pool.query("SELECT 1 FROM flag_abandonments")).rowCount).toBe(1);
  });

  async function insertPersonalFlag(ownerId: string, lat: number): Promise<string> {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO flags (id, owner_id, name, lat, lon, claim_radius_m, geom, access_mode)
       VALUES (gen_random_uuid(),$1,$1,$2,-106.5,20,ST_SetSRID(ST_MakePoint(-106.5,$2),4326),'private')
       RETURNING id::text`,
      [ownerId, lat]
    );
    return result.rows[0]!.id;
  }

  async function treasury(resourceType: string): Promise<number> {
    const result = await pool.query<{ quantity: string }>(
      `SELECT quantity::text FROM kingdom_treasury_balances
       WHERE kingdom_id=$1 AND resource_type=$2 AND variant='default'`,
      [kingdomId, resourceType]
    );
    return Number(result.rows[0]?.quantity ?? 0);
  }

  async function setTreasury(resourceType: string, quantity: number): Promise<void> {
    await pool.query(
      `INSERT INTO kingdom_treasury_balances (kingdom_id, resource_type, variant, quantity)
       VALUES ($1,$2,'default',$3)
       ON CONFLICT (kingdom_id, resource_type, variant) DO UPDATE SET quantity = EXCLUDED.quantity`,
      [kingdomId, resourceType, quantity]
    );
  }

  async function itemQuantity(playerId: string, itemId: string): Promise<number> {
    const snapshot = await inventory.getInventorySnapshot(playerId);
    return snapshot.items
      .filter((item) => item.resourceType === itemId)
      .reduce((sum, item) => sum + Number(item.quantity), 0);
  }

  async function grantItem(playerId: string, itemId: string, quantity: number): Promise<void> {
    await inventory.grantItemsForOperation({
      operationKey: `batch4-test:${playerId}:${randomUUID()}`,
      playerId,
      source: "kingdom_batch4_test",
      sourceEntityType: "kingdom_batch4_test",
      sourceEntityId: playerId,
      grants: [{ itemId: itemId as never, variant: "default", quantity }]
    });
  }

  async function insertCastle(): Promise<string> {
    const sourceId = randomUUID();
    const client = await pool.connect();
    try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO flags (id, owner_id, name, lat, lon, claim_radius_m, geom, control_type, kingdom_id,
                          access_mode, kingdom_affiliated_at, original_owner_player_id)
       VALUES ($1,'ruler','Castle',36.01,-106,100,ST_SetSRID(ST_MakePoint(-106,36.01),4326),'kingdom_seat',$2,
               'private',now(),'ruler')`,
      [sourceId, kingdomId]
    );
    await client.query(
      `INSERT INTO kingdom_seats (
         id, kingdom_id, lat, lon, geom, territory_radius_m, is_land, is_saltwater, inside_major_lake,
         environment_source_versions, environment_rules_version, environment_modifiers,
         environment_lookup_at, construction_state, completed_under_free_construction, status,
         completed_at, source_flag_id
       ) VALUES (gen_random_uuid(),$1,36.01,-106,ST_SetSRID(ST_MakePoint(-106,36.01),4326),100,true,false,false,
                 '{}'::jsonb,1,'[]'::jsonb,now(),'complete',true,'active',now(),$2)`,
      [kingdomId, sourceId]
    );
    await client.query("COMMIT");
    } finally {
      client.release();
    }
    return sourceId;
  }

  async function health(flagId: string): Promise<{ health: number; maximumHealth: number }> {
    const result = await pool.query<{ health: number; maximum_health: number }>(
      "SELECT health, maximum_health FROM flags WHERE id=$1",
      [flagId]
    );
    return { health: result.rows[0]!.health, maximumHealth: result.rows[0]!.maximum_health };
  }

  async function createPlayer(id: string, lastSeenAt: Date | null = null): Promise<void> {
    const accountId = randomUUID();
    await pool.query("INSERT INTO accounts (id,status,trust_tier) VALUES ($1,'active','standard')", [accountId]);
    await pool.query(
      `INSERT INTO players (
         id, account_id, username, username_normalized, display_color, region_code, lat, lon,
         anchor_lat, anchor_lon, move_leash_radius_m, online, geom, last_seen_at
       ) VALUES ($1,$2,$1,$1,'#38bdf8','NM',36,-106,36,-106,900,false,ST_SetSRID(ST_MakePoint(-106,36),4326),
                 COALESCE($3::timestamptz, now()))`,
      [id, accountId, lastSeenAt]
    );
  }

  async function createKingdom(leaderId: string): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO kingdoms (id, normalized_name, display_name, founder_player_id, leader_player_id, founding_request_id)
       VALUES ($1,$2,'Emberreach',$3,$3,$4)`,
      [id, `emberreach-${id.slice(0, 8)}`, leaderId, randomUUID()]
    );
    await addKingdomMember(id, leaderId, "leader");
    return id;
  }

  async function addKingdomMember(kingdom: string, playerId: string, role: "leader" | "member"): Promise<void> {
    await pool.query(
      `INSERT INTO kingdom_memberships (id, kingdom_id, player_id, role, status, joined_at, perk_qualified_at)
       VALUES (gen_random_uuid(),$1,$2,$3,'active',now(),now())`,
      [kingdom, playerId, role]
    );
  }

  async function insertKingdomFlag(name: string, levels: { obeliskLevel?: number } = {}): Promise<string> {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO flags (id, owner_id, name, lat, lon, claim_radius_m, geom, control_type, kingdom_id,
                          access_mode, kingdom_affiliated_at, original_owner_player_id, contributed_by_player_id,
                          obelisk_level)
       VALUES (gen_random_uuid(),'ruler',$1,36,-106,20,ST_SetSRID(ST_MakePoint(-106,36),4326),'kingdom',$2,
               'private',now(),'ruler','ruler',$3)
       RETURNING id::text`,
      [name, kingdomId, levels.obeliskLevel ?? null]
    );
    return result.rows[0]!.id;
  }
});
