import { randomUUID } from "node:crypto";

import { KINGDOM_BRICK_FURNACE_PACKAGE_COOLDOWN_MS } from "@ash-atlas/shared";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../config.js";
import { runMigrations } from "../db/migrate.js";
import type { AppLogger } from "../logger.js";
import type { WorldLookupClient } from "../world/worldLookupClient.js";
import { FlagService } from "./flags.js";
import { InventoryService } from "./inventory.js";
import { kingdomBrickYieldAt, kingdomBrickYieldRoll } from "./kingdomBrickYield.js";
import { KingdomService } from "./kingdoms.js";

const databaseUrl = process.env.KINGDOM_BRICKS_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("kingdom bricks, obelisks and Brick Furnace PostgreSQL integration", () => {
  let pool: pg.Pool;
  let inventory: InventoryService;
  let flags: FlagService;
  let kingdoms: KingdomService;
  let now: Date;
  let kingdomId = "";

  beforeAll(async () => {
    const name = new URL(databaseUrl!).pathname.slice(1);
    if (!name.startsWith("ash_atlas_stability")) {
      throw new Error("KINGDOM_BRICKS_TEST_DATABASE_URL must target an ash_atlas_stability* database");
    }
    await runMigrations(databaseUrl!);
    pool = new pg.Pool({ connectionString: databaseUrl!, max: 8 });
    inventory = new InventoryService(pool);
  }, 120_000);

  beforeEach(async () => {
    await pool.query("TRUNCATE kingdoms, players CASCADE");
    now = new Date("2026-10-02T12:00:00.000Z");
    for (const id of ["ruler", "squire", "outsider"]) await createPlayer(id);
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

  it("taxes a brick deposit 12% (rounded up), ledgers it once, and replays a repeated request", async () => {
    await grant("squire", "bricks", 205);
    const first = await kingdoms.depositBricks("squire", { requestId: "deposit-1", quantity: 105 });
    expect(first.replayed).toBe(false);
    // 105 Bricks: 13 destroyed (12.6 rounded up), 92 credited.
    expect(await treasury("bricks")).toBe(92);
    expect(await itemQuantity("squire", "bricks")).toBe(100);
    const replay = await kingdoms.depositBricks("squire", { requestId: "deposit-1", quantity: 105 });
    expect(replay.replayed).toBe(true);
    expect(await treasury("bricks")).toBe(92);
    expect(await itemQuantity("squire", "bricks")).toBe(100);
    // Concurrent duplicates of one new request move Bricks once.
    await Promise.allSettled([
      kingdoms.depositBricks("squire", { requestId: "deposit-2", quantity: 50 }),
      kingdoms.depositBricks("squire", { requestId: "deposit-2", quantity: 50 })
    ]);
    expect(await treasury("bricks")).toBe(92 + 44);
    expect(await itemQuantity("squire", "bricks")).toBe(50);
    const deposits = await pool.query(
      "SELECT quantity,tax_destroyed,credited FROM kingdom_brick_deposits ORDER BY created_at, quantity DESC"
    );
    expect(deposits.rows).toEqual([
      { quantity: 105, tax_destroyed: 13, credited: 92 },
      { quantity: 50, tax_destroyed: 6, credited: 44 }
    ]);
    const ledger = await pool.query<{ total: string }>(
      "SELECT sum(quantity)::text AS total FROM kingdom_treasury_ledger WHERE source_type='brick_deposit'"
    );
    expect(ledger.rows[0]!.total).toBe("136");
    // Bricks never bypass the tax through a plain donation, and 1 Brick credits nothing.
    await expect(kingdoms.donate("squire", { requestId: "donate-bricks", resourceType: "bricks", quantity: 10 }))
      .rejects.toMatchObject({ code: "KINGDOM_DONATION_USE_BRICK_DEPOSIT" });
    await expect(kingdoms.depositBricks("squire", { requestId: "deposit-1-brick", quantity: 1 }))
      .rejects.toMatchObject({ code: "KINGDOM_BRICK_DEPOSIT_INVALID" });
    await expect(kingdoms.depositBricks("squire", { requestId: "deposit-too-many", quantity: 51 }))
      .rejects.toMatchObject({ code: "KINGDOM_BRICK_DEPOSIT_INSUFFICIENT" });
    await expect(pool.query("DELETE FROM kingdom_brick_deposits")).rejects.toMatchObject({ code: "55000" });
  });

  it("builds obelisk levels from treasury Bricks, takes crude oil from the builder when the treasury lacks it, and allows only the leader", async () => {
    const flagId = await insertKingdomFlag("Watch");
    await setTreasury("bricks", 8_700);
    await grant("ruler", "crude_oil", 1_100);
    await grant("squire", "crude_oil", 1_100);
    // Denied: an ordinary member.
    await expect(flags.upgradeKingdomStructure("squire", flagId, "obelisk", 1, "squire-obelisk"))
      .rejects.toMatchObject({ code: "FLAG_UPGRADE_FORBIDDEN" });
    await expect(flags.assertKingdomStructureBuildAllowed("squire", flagId, "obelisk", 1))
      .rejects.toMatchObject({ code: "FLAG_UPGRADE_FORBIDDEN" });
    // Allowed: the leader. Damage carries over (200 max, 150 health).
    await pool.query("UPDATE flags SET health=150 WHERE id=$1", [flagId]);
    const first = await flags.upgradeKingdomStructure("ruler", flagId, "obelisk", 1, "obelisk-1");
    expect(first.replayed).toBe(false);
    expect(first.flag.obeliskLevel).toBe(1);
    expect(await health(flagId)).toEqual({ health: 2_230, maximumHealth: 2_300 });
    expect(await treasury("bricks")).toBe(6_500);
    expect(await itemQuantity("ruler", "crude_oil")).toBe(0);
    // Replay charges nothing; a second request for the built level and a skipped level are refused.
    expect((await flags.upgradeKingdomStructure("ruler", flagId, "obelisk", 1, "obelisk-1")).replayed).toBe(true);
    await expect(flags.upgradeKingdomStructure("ruler", flagId, "obelisk", 1, "obelisk-1-again"))
      .rejects.toMatchObject({ code: "FLAG_KINGDOM_STRUCTURE_LEVEL_CHANGED" });
    await expect(flags.upgradeKingdomStructure("ruler", flagId, "obelisk", 3, "obelisk-3"))
      .rejects.toMatchObject({ code: "FLAG_KINGDOM_STRUCTURE_LEVEL_CHANGED" });
    await expect(flags.upgradeKingdomStructure("ruler", flagId, "kingdom_tower", 1, "tower-on-obelisk"))
      .rejects.toMatchObject({ code: "FLAG_KINGDOM_STRUCTURE_OCCUPIED" });
    // Level 2: 6,400 Bricks + 3,300 crude oil, which the treasury now holds.
    await setTreasury("crude_oil", 3_300);
    await flags.upgradeKingdomStructure("ruler", flagId, "obelisk", 2, "obelisk-2");
    expect(await health(flagId)).toEqual({ health: 4_530, maximumHealth: 4_600 });
    expect(await treasury("bricks")).toBe(100);
    expect(await treasury("crude_oil")).toBe(0);
    // Level 3 needs 21,000 Bricks: refused, nothing charged.
    await expect(flags.upgradeKingdomStructure("ruler", flagId, "obelisk", 3, "obelisk-3b"))
      .rejects.toMatchObject({ code: "FLAG_KINGDOM_STRUCTURE_BRICKS_REQUIRED" });
    expect(await treasury("bricks")).toBe(100);
    const builds = await pool.query(
      "SELECT to_level,bricks_quantity,material_quantity,material_source FROM kingdom_structure_build_operations ORDER BY to_level"
    );
    expect(builds.rows).toEqual([
      { to_level: 1, bricks_quantity: 2_200, material_quantity: 1_100, material_source: "builder" },
      { to_level: 2, bricks_quantity: 6_400, material_quantity: 3_300, material_source: "treasury" }
    ]);
  });

  it("builds a Kingdom Tower on a Kingdom Flag with the HP ladder", async () => {
    const flagId = await insertKingdomFlag("Spire");
    await setTreasury("bricks", 9_200);
    await setTreasury("crystal", 900);
    await flags.upgradeKingdomStructure("ruler", flagId, "kingdom_tower", 1, "tower-1");
    expect(await health(flagId)).toEqual({ health: 11_500, maximumHealth: 11_500 });
    const second = await flags.upgradeKingdomStructure("ruler", flagId, "kingdom_tower", 2, "tower-2");
    expect(second.flag.towerLevel).toBe(2);
    expect(await health(flagId)).toEqual({ health: 23_000, maximumHealth: 23_000 });
    expect(await treasury("bricks")).toBe(0);
    expect(await treasury("crystal")).toBe(0);
    await expect(flags.upgradeKingdomStructure("ruler", flagId, "obelisk", 1, "obelisk-on-tower"))
      .rejects.toMatchObject({ code: "FLAG_KINGDOM_STRUCTURE_OCCUPIED" });
  });

  it("upgrades the Brick Furnace, sells one package per 20 hours, and replays a repeated purchase", async () => {
    await grant("ruler", "refined_oil", 1_150);
    await grant("squire", "refined_oil", 20);
    await expect(kingdoms.upgradeBrickFurnace("squire", { requestId: "furnace-squire", targetLevel: 1 }))
      .rejects.toMatchObject({ code: "KINGDOM_PERMISSION_DENIED" });
    await expect(kingdoms.buyBrickFurnacePackage("squire", { requestId: "early", furnaceLevel: 1 }))
      .rejects.toMatchObject({ code: "KINGDOM_BRICK_FURNACE_REQUIRED" });
    await kingdoms.upgradeBrickFurnace("ruler", { requestId: "furnace-1", targetLevel: 1 });
    expect(await itemQuantity("ruler", "refined_oil")).toBe(0);
    const bought = await kingdoms.buyBrickFurnacePackage("squire", { requestId: "package-1", furnaceLevel: 1 });
    expect(bought.state?.brickFurnace).toMatchObject({ level: 1 });
    expect(await treasury("bricks")).toBe(480);
    expect(await itemQuantity("squire", "refined_oil")).toBe(14);
    // Replay: no second charge or credit.
    expect((await kingdoms.buyBrickFurnacePackage("squire", { requestId: "package-1", furnaceLevel: 1 })).replayed)
      .toBe(true);
    expect(await treasury("bricks")).toBe(480);
    expect(await itemQuantity("squire", "refined_oil")).toBe(14);
    // Cooldown: refused until 20 hours have passed, for any member.
    now = new Date(now.getTime() + KINGDOM_BRICK_FURNACE_PACKAGE_COOLDOWN_MS - 1_000);
    await expect(kingdoms.buyBrickFurnacePackage("squire", { requestId: "package-2", furnaceLevel: 1 }))
      .rejects.toMatchObject({ code: "KINGDOM_BRICK_FURNACE_COOLDOWN" });
    now = new Date(now.getTime() + 1_000);
    await kingdoms.buyBrickFurnacePackage("squire", { requestId: "package-3", furnaceLevel: 1 });
    expect(await treasury("bricks")).toBe(960);
    expect(await itemQuantity("squire", "refined_oil")).toBe(8);
    // A stale furnace level is refused rather than charged differently.
    await expect(kingdoms.buyBrickFurnacePackage("squire", { requestId: "package-4", furnaceLevel: 2 }))
      .rejects.toMatchObject({ code: "KINGDOM_BRICK_FURNACE_LEVEL_CHANGED" });
  });

  it("drops obelisk-multiplied Bricks on kingdom land only, more for members", async () => {
    const flagId = await insertKingdomFlag("Quarry");
    await pool.query("UPDATE flags SET claim_radius_m=300 WHERE id=$1", [flagId]);
    let hit = 0;
    while (kingdomBrickYieldRoll(`k${hit}`) >= 0.1) hit += 1;
    let miss = 0;
    while (kingdomBrickYieldRoll(`k${miss}`) < 0.1) miss += 1;
    const onLand = { lat: 36.001, lon: -106 };
    const yieldFor = (playerId: string, rollKey: string, position = onLand) =>
      kingdomBrickYieldAt(pool, { playerId, position, rollKey });
    // No obelisk: the base x1.
    expect(await yieldFor("squire", `k${hit}`)).toMatchObject({ quantity: 1, obeliskLevel: null, member: true });
    expect(await yieldFor("squire", `k${miss}`)).toBeNull();
    // A raw level change keeps current health; the maximum follows the level.
    await pool.query("UPDATE flags SET obelisk_level=2 WHERE id=$1", [flagId]);
    expect(await health(flagId)).toEqual({ health: 220, maximumHealth: 4_600 });
    expect(await yieldFor("squire", `k${hit}`)).toMatchObject({ quantity: 3, obeliskLevel: 2, member: true });
    expect(await yieldFor("outsider", `k${hit}`)).toMatchObject({ quantity: 2, member: false });
    // Off kingdom land: nothing.
    expect(await yieldFor("squire", `k${hit}`, { lat: 37, lon: -106 })).toBeNull();
    // A destroyed obelisk no longer multiplies.
    await pool.query("UPDATE flags SET health=0 WHERE id=$1", [flagId]);
    expect(await yieldFor("squire", `k${hit}`)).toMatchObject({ quantity: 1, obeliskLevel: null });
  });

  async function treasury(resourceType: string): Promise<number> {
    const result = await pool.query<{ quantity: string }>(
      "SELECT quantity::text FROM kingdom_treasury_balances WHERE kingdom_id=$1 AND resource_type=$2",
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

  async function grant(playerId: string, itemId: "bricks" | "crude_oil" | "refined_oil", quantity: number) {
    await inventory.grantItemsForOperation({
      operationKey: `bricks-test:${playerId}:${randomUUID()}`,
      playerId,
      source: "kingdom_bricks_test",
      sourceEntityType: "kingdom_bricks_test",
      sourceEntityId: playerId,
      grants: [{ itemId, variant: "default", quantity }]
    });
  }

  async function health(flagId: string): Promise<{ health: number; maximumHealth: number }> {
    const row = (await pool.query<{ health: number; maximum_health: number }>(
      "SELECT health,maximum_health FROM flags WHERE id=$1", [flagId]
    )).rows[0]!;
    return { health: Number(row.health), maximumHealth: Number(row.maximum_health) };
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

  async function insertKingdomFlag(name: string): Promise<string> {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO flags (id, owner_id, name, lat, lon, claim_radius_m, geom, control_type, kingdom_id,
                          access_mode, kingdom_affiliated_at, original_owner_player_id, contributed_by_player_id)
       VALUES (gen_random_uuid(),'ruler',$1,36,-106,20,ST_SetSRID(ST_MakePoint(-106,36),4326),'kingdom',$2,
               'private',now(),'ruler','ruler')
       RETURNING id::text`,
      [name, kingdomId]
    );
    return result.rows[0]!.id;
  }
});
