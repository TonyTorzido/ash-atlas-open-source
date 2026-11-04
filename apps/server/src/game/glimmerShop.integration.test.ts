import { randomUUID } from "node:crypto";

import type { EquipmentDefinitionId } from "@ash-atlas/shared";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DisposableTestPool } from "../db/disposableTestPool.js";
import { runMigrations } from "../db/migrate.js";
import { EquipmentService } from "./equipment.js";
import { GlimmerShopService } from "./glimmerShop.js";
import { InventoryService } from "./inventory.js";
import { PremiumWalletService } from "./premiumWallet.js";
import { ManorPresenceService } from "./manor.js";
import { SalonService } from "./salon.js";

const adminUrl =
  process.env.PLAYER_PACKAGE_TEST_ADMIN_URL ??
  process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;

describeDatabase("Glimmer Shop", () => {
  const databaseName = `ash_atlas_stability_shop_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  let pool: pg.Pool;
  let inventory: InventoryService;
  let equipment: EquipmentService;
  let premium: PremiumWalletService;
  let shop: GlimmerShopService;
  const PLAYER = "shop-a";
  let accountId: string;

  beforeAll(async () => {
    const parsed = new URL(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    await runMigrations(parsed.toString());
    if ((await runMigrations(parsed.toString())).length !== 0) throw new Error("Shop migration second run was not empty");
    pool = new DisposableTestPool({ connectionString: parsed.toString(), max: 10 });
    inventory = new InventoryService(pool);
    equipment = new EquipmentService(pool, { inventory });
    premium = new PremiumWalletService(pool);
    shop = new GlimmerShopService(pool, { inventory, equipment, premium });
  }, 180_000);

  beforeEach(async () => {
    await pool.query("TRUNCATE accounts CASCADE");
    await pool.query("TRUNCATE shop_item_copies");
    await pool.query("UPDATE glimmer_shop_catalog SET on_sale=true, source=CASE WHEN kind='weapon' THEN 'shop' END, price_glimmer=CASE kind WHEN 'weapon' THEN 1000 WHEN 'mask' THEN 1500 ELSE 2000 END");
    accountId = randomUUID();
    await pool.query("INSERT INTO accounts (id,trust_tier) VALUES ($1,'standard')", [accountId]);
    await pool.query(
      `INSERT INTO players (id,account_id,username,region_code,lat,lon,anchor_lat,anchor_lon,move_leash_radius_m,online,geom)
       VALUES ($1,$2,$1,'GLOBAL',0,0,0,0,1250,false,ST_SetSRID(ST_MakePoint(0,0),4326))`,
      [PLAYER, accountId]
    );
  });

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await admin.end();
  });

  async function fund(amount: number): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await premium.creditForOperationInTransaction(client, {
        accountId, currency: "glimmer", amount: BigInt(amount), operationKey: `test-fund:${randomUUID()}`, reason: "admin"
      });
      await client.query("COMMIT");
    } finally {
      client.release();
    }
  }
  const glimmer = async (): Promise<number> => Number((await premium.snapshot(accountId)).balances.glimmer.balance);
  /** Copies of a look in the inventory (masks/skins are per-copy items, variant = copy id). */
  async function held(itemId: string, look: string): Promise<number> {
    const result = await pool.query<{ quantity: string }>(
      `SELECT COALESCE(sum(inventory.quantity),0)::text AS quantity
       FROM player_inventory inventory JOIN shop_item_copies copy ON copy.copy_id = inventory.variant
       WHERE inventory.player_id=$1 AND inventory.resource_type=$2 AND copy.look=$3`,
      [PLAYER, itemId, look]
    );
    return Number(result.rows[0]!.quantity);
  }
  async function copiesOf(itemId: string, look: string): Promise<string[]> {
    const result = await pool.query<{ copy_id: string }>(
      `SELECT copy.copy_id FROM player_inventory inventory JOIN shop_item_copies copy ON copy.copy_id = inventory.variant
       WHERE inventory.player_id=$1 AND inventory.resource_type=$2 AND copy.look=$3 AND inventory.quantity > 0
       ORDER BY copy.copy_id`,
      [PLAYER, itemId, look]
    );
    return result.rows.map((row) => row.copy_id);
  }
  async function debitCopy(itemId: string, copyId: string): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await inventory.debitItemsForOperationInTransaction(client, {
        operationKey: `debit:${randomUUID()}`, playerId: PLAYER, source: "development_debit",
        debits: [{ itemId: itemId as never, variant: copyId, quantity: 1 }]
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async function weapons(definitionId: string): Promise<number> {
    const result = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM equipment_instances WHERE owner_player_id=$1 AND definition_id=$2",
      [PLAYER, definitionId]
    );
    return Number(result.rows[0]!.count);
  }
  const cart = [
    { sku: "mask_hockey", quantity: 2 },
    { sku: "legion_gladius", quantity: 1 },
    { sku: "manor_skin_haunted", quantity: 1 }
  ];

  it("debits and mints a whole cart atomically, refuses short balances and replays once", async () => {
    await fund(5_000);
    await expect(shop.buy(PLAYER, { requestId: randomUUID(), lines: cart, expectedTotalGlimmer: 6_000 }))
      .rejects.toMatchObject({ code: "SHOP_INSUFFICIENT_GLIMMER" });
    expect(await glimmer()).toBe(5_000);
    expect(await held("face_mask", "hockey-mask")).toBe(0);
    expect(await weapons("legion_gladius")).toBe(0);

    await fund(2_000);
    const requestId = randomUUID();
    const bought = await shop.buy(PLAYER, { requestId, lines: cart, expectedTotalGlimmer: 6_000 });
    expect(bought).toMatchObject({ replayed: false, totalGlimmer: 6_000 });
    expect(bought.premiumWallet.balances.glimmer.balance).toBe("1000");
    expect(await held("face_mask", "hockey-mask")).toBe(2);
    expect(await held("manor_skin", "haunted_manor")).toBe(1);
    expect(await weapons("legion_gladius")).toBe(1);
    const ledger = await pool.query("SELECT 1 FROM premium_wallet_events WHERE ref_type='glimmer_shop_purchase' AND ref_id=$1", [requestId]);
    expect(ledger.rowCount).toBe(1);

    // Replay: same result, charged once, nothing minted twice.
    await expect(shop.buy(PLAYER, { requestId, lines: cart, expectedTotalGlimmer: 6_000 }))
      .resolves.toMatchObject({ replayed: true, totalGlimmer: 6_000 });
    expect(await glimmer()).toBe(1_000);
    expect(await held("face_mask", "hockey-mask")).toBe(2);
    expect(await weapons("legion_gladius")).toBe(1);
    await expect(shop.buy(PLAYER, { requestId, lines: [{ sku: "mask_hockey", quantity: 1 }], expectedTotalGlimmer: 1_500 }))
      .rejects.toMatchObject({ code: "SHOP_IDEMPOTENCY_CONFLICT" });
  });

  it("rejects a changed price, off-sale or craft-only items and out-of-bounds carts without charging", async () => {
    await fund(10_000);
    await pool.query("UPDATE glimmer_shop_catalog SET price_glimmer=1200 WHERE sku='legion_gladius'");
    await expect(shop.buy(PLAYER, { requestId: randomUUID(), lines: [{ sku: "legion_gladius", quantity: 1 }], expectedTotalGlimmer: 1_000 }))
      .rejects.toMatchObject({ code: "SHOP_PRICE_CHANGED" });
    await pool.query("UPDATE glimmer_shop_catalog SET on_sale=false WHERE sku='mask_kitsune'");
    await expect(shop.buy(PLAYER, { requestId: randomUUID(), lines: [{ sku: "mask_kitsune", quantity: 1 }], expectedTotalGlimmer: 1_500 }))
      .rejects.toMatchObject({ code: "SHOP_ITEM_UNAVAILABLE" });
    await pool.query("UPDATE glimmer_shop_catalog SET source='craft' WHERE sku='runestar'");
    await expect(shop.buy(PLAYER, { requestId: randomUUID(), lines: [{ sku: "runestar", quantity: 1 }], expectedTotalGlimmer: 1_000 }))
      .rejects.toMatchObject({ code: "SHOP_ITEM_UNAVAILABLE" });
    await expect(shop.buy(PLAYER, { requestId: randomUUID(), lines: [{ sku: "nope", quantity: 1 }], expectedTotalGlimmer: 1_000 }))
      .rejects.toMatchObject({ code: "SHOP_ITEM_UNAVAILABLE" });
    for (const quantity of [0, 100]) {
      await expect(shop.buy(PLAYER, { requestId: randomUUID(), lines: [{ sku: "mask_hockey", quantity }], expectedTotalGlimmer: 1_500 }))
        .rejects.toMatchObject({ code: "SHOP_INVALID_REQUEST" });
    }
    const tooMany = Array.from({ length: 21 }, (_, index) => ({ sku: `sku_${index}`, quantity: 1 }));
    await expect(shop.buy(PLAYER, { requestId: randomUUID(), lines: tooMany, expectedTotalGlimmer: 21_000 }))
      .rejects.toMatchObject({ code: "SHOP_INVALID_REQUEST" });
    expect(await glimmer()).toBe(10_000);
    const catalog = await shop.catalog();
    expect(catalog.items.some((item) => item.sku === "mask_kitsune" || item.sku === "runestar")).toBe(false);
    expect(catalog.items.find((item) => item.sku === "mask_hockey")).toMatchObject({ kind: "mask", priceGlimmer: 1_500, displayName: "Hockey Mask" });
    expect(catalog.items.some((item) => item.grantVariant === "manor_lobby")).toBe(false);
  });

  it("edits a catalog row with one audit entry and replays the operation key", async () => {
    const operationKey = randomUUID();
    const edited = await shop.editCatalogItem("admin-1", "runestar", { operationKey, priceGlimmer: 1_250, source: "shop", featured: true });
    expect(edited).toMatchObject({ replayed: false, item: { priceGlimmer: 1_250, source: "shop", featured: true } });
    await expect(shop.editCatalogItem("admin-1", "runestar", { operationKey, priceGlimmer: 9 }))
      .resolves.toMatchObject({ replayed: true, item: { priceGlimmer: 1_250 } });
    await expect(shop.editCatalogItem("admin-1", "mask_kitsune", { operationKey: randomUUID(), source: "shop" }))
      .rejects.toMatchObject({ code: "SHOP_INVALID_REQUEST" });
    const audit = await pool.query<{ before: { priceGlimmer: number }; after: { priceGlimmer: number }; actor_player_id: string }>(
      "SELECT before,after,actor_player_id FROM glimmer_shop_catalog_audit WHERE sku='runestar'"
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ actor_player_id: "admin-1", before: { priceGlimmer: 1_000 }, after: { priceGlimmer: 1_250 } });
    expect((await shop.catalog()).shopOnlyDefinitionIds).toContain("runestar");
  });

  it("refuses the Smithing craft of a shop-only swag weapon and refuses a sold-and-craftable source", async () => {
    const authority = { kind: "manor_smith" as const, manorId: randomUUID(), manorSessionId: "s", movementSequence: 0, authorize: async () => {} };
    const actor = { playerId: PLAYER, accountId };
    await pool.query("UPDATE glimmer_shop_catalog SET source='shop' WHERE sku='runestar'");
    await expect(equipment.craftStockEquipment(actor, "shuriken", randomUUID(), authority, "runestar" as EquipmentDefinitionId))
      .rejects.toMatchObject({ code: "EQUIPMENT_CRAFT_RECIPE_UNAVAILABLE", message: expect.stringContaining("Glimmer Shop") });
    await pool.query("UPDATE glimmer_shop_catalog SET source='craft' WHERE sku='runestar'");
    const craftable = await equipment.craftStockEquipment(actor, "shuriken", randomUUID(), authority, "runestar" as EquipmentDefinitionId).catch((error: Error) => error);
    expect(String((craftable as Error).message)).not.toContain("Glimmer Shop");
    await expect(pool.query("UPDATE glimmer_shop_catalog SET source='both' WHERE sku='runestar'")).rejects.toThrow(/glimmer_shop_catalog_source_no_craftables/);
  });

  it("wears a mask only when owned and keeps the worn copy in the inventory", async () => {
    const salon = new SalonService(pool, null);
    await expect(salon.equipMask(PLAYER, randomUUID())).rejects.toMatchObject({ code: "MASK_NOT_OWNED" });
    await expect(pool.query("UPDATE players SET mask_appearance_id='kitsune-mask' WHERE id=$1", [PLAYER]))
      .rejects.toMatchObject({ constraint: "player_face_mask_worn" });
    await fund(3_000);
    await shop.buy(PLAYER, { requestId: randomUUID(), lines: [{ sku: "mask_kitsune", quantity: 2 }], expectedTotalGlimmer: 3_000 });
    const [worn, spare] = await copiesOf("face_mask", "kitsune-mask");
    await expect(salon.equipMask(PLAYER, worn!)).resolves.toMatchObject({
      changed: true, maskCopyId: worn, styles: { mask: "kitsune-mask" }
    });
    const snapshot = await inventory.snapshotInTransaction(pool, PLAYER);
    expect(snapshot.items.find((item) => item.variant === worn)).toMatchObject({ look: "kitsune-mask", equipped: true });
    expect(snapshot.items.find((item) => item.variant === spare)?.equipped).toBeUndefined();
    // The worn copy is locked; the spare copy can go.
    await expect(debitCopy("face_mask", worn!)).rejects.toMatchObject({ code: "INVENTORY_ITEM_EQUIPPED" });
    await debitCopy("face_mask", spare!);
    expect(await held("face_mask", "kitsune-mask")).toBe(1);
    await expect(salon.equipMask(PLAYER, null)).resolves.toMatchObject({ changed: true, styles: { mask: null } });
  });

  it("tags every bought copy with a unique random tag and the buyer, never sequentially", async () => {
    await pool.query("UPDATE players SET username='Original Buyer' WHERE id=$1", [PLAYER]);
    await fund(20_000);
    await shop.buy(PLAYER, { requestId: randomUUID(), lines: [{ sku: "mask_hockey", quantity: 3 }, { sku: "runestar", quantity: 2 }], expectedTotalGlimmer: 6_500 });
    await shop.buy(PLAYER, { requestId: randomUUID(), lines: [{ sku: "mask_hockey", quantity: 2 }], expectedTotalGlimmer: 3_000 });
    const copies = await pool.query<{ copy_id: string; tag: string; original_buyer_name: string }>(
      "SELECT copy_id, tag, original_buyer_name FROM shop_item_copies ORDER BY created_at, copy_id"
    );
    expect(copies.rows).toHaveLength(7);
    expect(new Set(copies.rows.map((row) => row.tag)).size).toBe(7);
    expect(copies.rows.every((row) => /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/.test(row.tag))).toBe(true);
    expect(copies.rows.every((row) => row.original_buyer_name === "Original Buyer")).toBe(true);
    // Random 40-bit values: no two consecutive purchases yield neighbouring tags.
    const values = copies.rows.map((row) => [...row.tag.replace("-", "")]
      .reduce((total, char) => total * 32n + BigInt("0123456789ABCDEFGHJKMNPQRSTVWXYZ".indexOf(char)), 0n));
    for (let index = 1; index < values.length; index += 1) {
      const gap = values[index]! - values[index - 1]!;
      expect(gap === 1n || gap === -1n).toBe(false);
    }
    // Each mask is its own inventory row; weapons carry the tag on the equipment snapshot.
    expect(await copiesOf("face_mask", "hockey-mask")).toHaveLength(5);
    const equipmentSnapshot = await equipment.snapshotInTransaction(pool, PLAYER);
    const tagged = equipmentSnapshot.instances.filter((item) => item.definitionId === "runestar");
    expect(tagged.length).toBe(2);
    expect(tagged.every((item) => item.provenance?.originalBuyerName === "Original Buyer")).toBe(true);
  });

  it("locks only the copy of a Manor skin that is equipped", async () => {
    await fund(4_000);
    await shop.buy(PLAYER, { requestId: randomUUID(), lines: [{ sku: "manor_skin_haunted", quantity: 2 }], expectedTotalGlimmer: 4_000 });
    const [equippedCopy, spare] = await copiesOf("manor_skin", "haunted_manor");
    await pool.query("INSERT INTO player_manors (owner_player_id, manor_type_id) VALUES ($1,'manor_lobby')", [PLAYER]);
    const manors = new ManorPresenceService(pool, undefined, { inventory });
    await expect(manors.equipSkin({ playerId: PLAYER, requestId: randomUUID(), manorTypeId: "haunted_manor", copyId: randomUUID() }))
      .rejects.toMatchObject({ code: "MANOR_SKIN_NOT_OWNED" });
    await manors.equipSkin({ playerId: PLAYER, requestId: randomUUID(), manorTypeId: "haunted_manor", copyId: equippedCopy! });
    await expect(debitCopy("manor_skin", equippedCopy!)).rejects.toMatchObject({ code: "INVENTORY_ITEM_EQUIPPED" });
    await debitCopy("manor_skin", spare!);
    expect(await held("manor_skin", "haunted_manor")).toBe(1);
  });

  it("rejects the whole purchase when the inventory is full", async () => {
    await fund(200_000);
    // Fill the carry capacity with stone first.
    await inventory.grantItemsForOperation({
      operationKey: `fill:${randomUUID()}`, playerId: PLAYER, source: "development_grant", allowPartial: true,
      grants: [{ itemId: "stone", variant: null, quantity: 1_000_000 }]
    });
    await expect(shop.buy(PLAYER, {
      requestId: randomUUID(),
      lines: [{ sku: "mask_kitsune", quantity: 1 }, { sku: "centaur_lance", quantity: 1 }],
      expectedTotalGlimmer: 1_500 + 1_000
    })).rejects.toMatchObject({ code: "SHOP_INVENTORY_FULL" });
    expect(await glimmer()).toBe(200_000);
    expect(await held("face_mask", "kitsune-mask")).toBe(0);
    expect(await weapons("centaur_lance")).toBe(0);
  });
});
