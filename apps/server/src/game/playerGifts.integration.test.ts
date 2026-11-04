import { randomUUID } from "node:crypto";

import { GIFT_BOX_PRICE_GOLD, sendPlayerGiftMessageSchema, type SendPlayerGiftInput } from "@ash-atlas/shared";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DisposableTestPool } from "../db/disposableTestPool.js";
import { runMigrations } from "../db/migrate.js";
import { EquipmentService } from "./equipment.js";
import { InventoryService } from "./inventory.js";
import { PlayerGiftService } from "./playerGifts.js";
import { PlayerPackageService } from "./playerPackages.js";
import { WalletService } from "./wallet.js";

const adminUrl =
  process.env.PLAYER_PACKAGE_TEST_ADMIN_URL ??
  process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;

describeDatabase("player gifts", () => {
  const databaseName = `ash_atlas_stability_gifts_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  let pool: pg.Pool;
  let inventory: InventoryService;
  let wallet: WalletService;
  let gifts: PlayerGiftService;
  let packages: PlayerPackageService;
  // sender, recipient, sender alt (same account), low level, unsettled, second sender
  const [A, B, ALT, LOW, UNSETTLED, E] = ["gift-a", "gift-b", "gift-alt", "gift-low", "gift-unsettled", "gift-e"];

  beforeAll(async () => {
    const parsed = new URL(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    await runMigrations(parsed.toString());
    if ((await runMigrations(parsed.toString())).length !== 0) {
      throw new Error("Gift migration second run was not empty");
    }
    pool = new DisposableTestPool({ connectionString: parsed.toString(), max: 10 });
    inventory = new InventoryService(pool);
    wallet = new WalletService(pool);
    const equipment = new EquipmentService(pool);
    gifts = new PlayerGiftService(pool, { inventory, equipment, wallet });
    packages = new PlayerPackageService(pool, { inventory, equipment, wallet });
  }, 180_000);

  beforeEach(async () => {
    await pool.query("TRUNCATE accounts CASCADE");
    const accountA = randomUUID();
    const seeds: Array<[string, string, number, boolean]> = [
      [A, accountA, 5, true],
      [B, randomUUID(), 1, false],
      [ALT, randomUUID(), 5, true],
      [LOW, randomUUID(), 4, true],
      [UNSETTLED, randomUUID(), 10, false],
      [E, randomUUID(), 5, true]
    ];
    for (const [playerId, accountId, level, settled] of seeds) {
      await pool.query(
        "INSERT INTO accounts (id,trust_tier) VALUES ($1,'standard') ON CONFLICT DO NOTHING",
        [accountId]
      );
      await pool.query(
        `INSERT INTO players (
           id,account_id,username,region_code,lat,lon,anchor_lat,anchor_lon,
           move_leash_radius_m,online,geom
         ) VALUES ($1,$2,$1,'GLOBAL',0,0,0,0,1250,false,ST_SetSRID(ST_MakePoint(0,0),4326))`,
        [playerId, accountId]
      );
      await pool.query(
        `INSERT INTO player_progression_profiles (player_id, level) VALUES ($1,$2)
         ON CONFLICT (player_id) DO UPDATE SET level = EXCLUDED.level`,
        [playerId, level]
      );
      if (settled) {
        await pool.query(
          `INSERT INTO account_settlement (account_id,target_checks,target_days,settled_at)
           VALUES ($1,10,3,now()) ON CONFLICT (account_id) DO NOTHING`,
          [accountId]
        );
      }
    }
    for (const playerId of [A, ALT, LOW, UNSETTLED, E]) {
      await give(playerId, [["gift_box", 10], ["wood", 50], ["stone", 20]]);
      await give(playerId, [["lumen", 20]], "lumen_admin_grant");
    }
  });

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await admin.end();
  });

  async function give(playerId: string, items: Array<[string, number]>, source = "development_grant"): Promise<void> {
    await inventory.grantItemsForOperation({
      operationKey: `seed:${playerId}:${randomUUID()}`,
      playerId,
      source,
      grants: items.map(([itemId, quantity]) => ({ itemId: itemId as never, variant: null, quantity }))
    });
  }

  async function quantity(playerId: string, itemId: string): Promise<number> {
    const result = await pool.query<{ quantity: string }>(
      "SELECT COALESCE(sum(quantity),0)::text AS quantity FROM player_inventory WHERE player_id=$1 AND resource_type=$2",
      [playerId, itemId]
    );
    return Number(result.rows[0]!.quantity);
  }

  async function gold(playerId: string): Promise<number> {
    const result = await pool.query<{ gold: string }>(
      "SELECT COALESCE((SELECT gold_balance FROM player_wallets WHERE player_id=$1),0)::text AS gold",
      [playerId]
    );
    return Number(result.rows[0]!.gold);
  }

  async function fundGold(playerId: string, amount: number): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const account = await client.query<{ account_id: string }>("SELECT account_id::text FROM players WHERE id=$1", [playerId]);
      await wallet.creditForOperationInTransaction(client, {
        playerId,
        accountId: account.rows[0]!.account_id,
        amount: BigInt(amount),
        operationKey: `fund:${randomUUID()}`,
        reason: "development_grant"
      });
      await client.query("COMMIT");
    } finally {
      client.release();
    }
  }

  async function equipmentInstance(playerId: string, definitionId: string, location: "inventory" | "equipped", itemLevel = 3): Promise<string> {
    const operationKey = `seed-equipment:${randomUUID()}`;
    const instanceId = randomUUID();
    await pool.query(
      "INSERT INTO equipment_operations (operation_key,player_id,action,completed_at) VALUES ($1,$2,'starter_loadout',now())",
      [operationKey, playerId]
    );
    await pool.query(
      `INSERT INTO equipment_instances (
         instance_id,definition_id,owner_player_id,location,equipped_slot,
         inventory_slot_index,item_level,balance_version,created_by_operation_key,metadata
       ) VALUES ($1,$2,$3,$4,$5,NULL,$6,2,$7,'{}'::jsonb)`,
      [instanceId, definitionId, playerId, location, location === "equipped" ? "weapon" : null, itemLevel, operationKey]
    );
    return instanceId;
  }

  function gift(recipientPlayerId: string, overrides: Partial<SendPlayerGiftInput> = {}): SendPlayerGiftInput {
    return {
      requestId: randomUUID(),
      recipientPlayerId,
      message: "Enjoy",
      items: [{ itemKind: "resource", itemId: "wood", quantity: 5 }],
      equipmentInstanceIds: [],
      ...overrides
    };
  }

  it("buys Gift Boxes once per request and refuses without enough Gold", async () => {
    const requestId = randomUUID();
    await expect(gifts.buyGiftBoxes(B, requestId, 1)).rejects.toMatchObject({ code: "GIFT_BOX_INSUFFICIENT_GOLD" });
    expect(await quantity(B, "gift_box")).toBe(0);
    await fundGold(B, 1_000);
    const [first, second] = await Promise.all([
      gifts.buyGiftBoxes(B, requestId, 2),
      gifts.buyGiftBoxes(B, requestId, 2)
    ]);
    expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
    expect(await gold(B)).toBe(1_000 - 2 * GIFT_BOX_PRICE_GOLD);
    expect(await quantity(B, "gift_box")).toBe(2);
    await expect(gifts.buyGiftBoxes(B, requestId, 3)).rejects.toMatchObject({ code: "GIFT_BOX_IDEMPOTENCY_CONFLICT" });
    const events = await pool.query(
      "SELECT event_kind, leg FROM economy_events WHERE reason = 'gift_box_purchase' ORDER BY leg"
    );
    expect(events.rows).toEqual([
      { event_kind: "SOURCE", leg: "credit" },
      { event_kind: "SINK", leg: "debit" }
    ]);
  });

  it("refuses currency lines in the schema and in the database", async () => {
    for (const itemKind of ["gold", "city_coins", "glimmer"]) {
      expect(sendPlayerGiftMessageSchema.safeParse({
        type: "SEND_PLAYER_GIFT",
        requestId: randomUUID(),
        recipientPlayerId: B,
        items: [{ itemKind, itemId: itemKind, quantity: 1 }],
        equipmentInstanceIds: []
      }).success).toBe(false);
    }
    const sent = await gifts.send(A, gift(B));
    await expect(pool.query(
      `INSERT INTO player_package_items (package_id,line_number,item_kind,canonical_item_id,variant,original_quantity,remaining_quantity)
       VALUES ($1,9,'gold',NULL,NULL,10,10)`,
      [sent.packageId]
    )).rejects.toMatchObject({ code: "23514" });
  });

  it("sends Lumen, refuses non-giftable items and keeps the sender's items on refusal", async () => {
    await expect(gifts.send(A, gift(B, { items: [{ itemKind: "resource", itemId: "gift_box", quantity: 1 }] })))
      .rejects.toMatchObject({ code: "PLAYER_GIFT_ITEM_NOT_GIFTABLE" });
    await expect(gifts.send(A, gift(B, { items: [{ itemKind: "resource", itemId: "coal", quantity: 1 }] })))
      .rejects.toMatchObject({ code: "PLAYER_GIFT_ITEM_NOT_GIFTABLE" });
    await expect(gifts.send(A, gift(B, { items: [] }))).rejects.toMatchObject({ code: "PLAYER_GIFT_EMPTY" });
    const sent = await gifts.send(A, gift(B, { items: [{ itemKind: "resource", itemId: "lumen", quantity: 7 }] }));
    expect(sent.package).toMatchObject({ kind: "player_gift", sender: A, senderPlayerId: A, title: `Gift from ${A}` });
    expect(sent.package.items).toEqual([expect.objectContaining({ itemId: "lumen", displayName: "Lumen", remainingQuantity: 7 })]);
    expect(await quantity(A, "lumen")).toBe(13);
    expect(await quantity(A, "gift_box")).toBe(9);
    const claimed = await packages.claim(B, sent.packageId, randomUUID(), sent.package.revision);
    expect(claimed.package.status).toBe("claimed");
    expect(await quantity(B, "lumen")).toBe(7);
    const projected = await pool.query(
      "SELECT count(*)::int AS count FROM economy_events WHERE reason IN ('player_gift_send','player_gift_claim')"
    );
    expect(projected.rows[0].count).toBe(0);
  });

  it("refuses self, same account, blocks either way, under-level and unsettled senders", async () => {
    await expect(gifts.send(A, gift(A))).rejects.toMatchObject({ code: "PLAYER_GIFT_SELF" });
    await expect(gifts.send(A, gift("nobody"))).rejects.toMatchObject({ code: "PLAYER_GIFT_RECIPIENT_NOT_FOUND" });
    await expect(gifts.send(LOW, gift(B))).rejects.toMatchObject({ code: "PLAYER_GIFT_SENDER_LEVEL" });
    await expect(gifts.send(UNSETTLED, gift(B))).rejects.toMatchObject({ code: "PLAYER_GIFT_SENDER_UNSETTLED" });
    await pool.query("INSERT INTO player_blocks (blocker_id, blocked_id) VALUES ($1,$2)", [B, A]);
    await expect(gifts.send(A, gift(B))).rejects.toMatchObject({ code: "PLAYER_GIFT_BLOCKED" });
    await pool.query("DELETE FROM player_blocks");
    await pool.query("INSERT INTO player_blocks (blocker_id, blocked_id) VALUES ($1,$2)", [A, B]);
    await expect(gifts.send(A, gift(B))).rejects.toMatchObject({ code: "PLAYER_GIFT_BLOCKED" });
    expect(await quantity(A, "gift_box")).toBe(10);
    expect(await quantity(A, "wood")).toBe(50);
  });

  it("replays a double-submitted send and rejects changed contents", async () => {
    const input = gift(B);
    const results = await Promise.all([gifts.send(A, input), gifts.send(A, input)]);
    expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);
    expect(results[0]!.packageId).toBe(results[1]!.packageId);
    expect(await quantity(A, "gift_box")).toBe(9);
    expect(await quantity(A, "wood")).toBe(45);
    await expect(gifts.send(A, { ...input, items: [{ itemKind: "resource", itemId: "wood", quantity: 6 }] }))
      .rejects.toMatchObject({ code: "PLAYER_GIFT_IDEMPOTENCY_CONFLICT" });
  });

  it("caps a recipient at 5 held gifts, including under concurrency", async () => {
    for (let index = 0; index < 3; index += 1) await gifts.send(A, gift(B));
    await expect(gifts.send(A, gift(B))).rejects.toMatchObject({ code: "PLAYER_GIFT_PAIR_LIMIT" });
    await gifts.send(E, gift(B));
    const racing = await Promise.allSettled([gifts.send(E, gift(B)), gifts.send(E, gift(B))]);
    expect(racing.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(racing.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "PLAYER_GIFT_RECIPIENT_FULL" }
    });
    const boxesBefore = await quantity(A, "gift_box");
    const woodBefore = await quantity(A, "wood");
    await pool.query("UPDATE player_package_campaigns SET created_at = now() - interval '2 days'");
    await expect(gifts.send(A, gift(B))).rejects.toMatchObject({
      code: "PLAYER_GIFT_RECIPIENT_FULL",
      message: `${B} is already holding 5 gifts.`
    });
    expect(await quantity(A, "gift_box")).toBe(boxesBefore);
    expect(await quantity(A, "wood")).toBe(woodBefore);
    expect((await gifts.status(B)).heldCount).toBe(5);
  });

  it("opens a gift once under concurrent claims and keeps the over-weight remainder in the gift", async () => {
    const sent = await gifts.send(A, gift(B, { items: [{ itemKind: "resource", itemId: "stone", quantity: 20 }] }));
    const stone = await pool.query<{ grams: number }>("SELECT unit_weight_grams AS grams FROM item_definitions WHERE item_id='stone'");
    await pool.query(
      "INSERT INTO player_inventory_capacities (player_id) VALUES ($1) ON CONFLICT DO NOTHING",
      [B]
    );
    await pool.query("UPDATE player_inventory_capacities SET base_capacity_grams=$2 WHERE player_id=$1", [B, stone.rows[0]!.grams * 8]);
    const claims = await Promise.allSettled([
      packages.claim(B, sent.packageId, randomUUID(), sent.package.revision),
      packages.claim(B, sent.packageId, randomUUID(), sent.package.revision)
    ]);
    expect(claims.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await quantity(B, "stone")).toBe(8);
    const partial = (await packages.inbox(B))[0]!;
    expect(partial).toMatchObject({ status: "partial", items: [expect.objectContaining({ remainingQuantity: 12 })] });
    expect((await gifts.status(B)).heldCount).toBe(1);
    await pool.query("UPDATE player_inventory_capacities SET base_capacity_grams=1000000 WHERE player_id=$1", [B]);
    const finished = await packages.claim(B, sent.packageId, randomUUID(), partial.revision);
    expect(finished.package.status).toBe("claimed");
    expect(await quantity(B, "stone")).toBe(20);
    expect((await gifts.status(B)).heldCount).toBe(0);
  });

  it("moves exact equipment instances through escrow and refuses equipped ones", async () => {
    const equipped = await equipmentInstance(A, "double_axe", "equipped");
    await expect(gifts.send(A, gift(B, { items: [], equipmentInstanceIds: [equipped] })))
      .rejects.toMatchObject({ code: "PLAYER_GIFT_EQUIPMENT_NOT_ELIGIBLE" });
    const axe = await equipmentInstance(A, "double_axe", "inventory", 4);
    await pool.query("UPDATE equipment_instances SET condition = 77 WHERE instance_id=$1", [axe]);
    const sent = await gifts.send(A, gift(B, { equipmentInstanceIds: [axe] }));
    expect(sent.equipment.instances.some((instance) => instance.instanceId === axe)).toBe(false);
    expect(await pool.query("SELECT location, owner_player_id FROM equipment_instances WHERE instance_id=$1", [axe]))
      .toMatchObject({ rows: [{ location: "gift_escrow", owner_player_id: A }] });
    const claimed = await packages.claim(B, sent.packageId, randomUUID(), sent.package.revision);
    expect(claimed.package.status).toBe("claimed");
    expect(claimed.equipment.instances.find((instance) => instance.instanceId === axe))
      .toMatchObject({ itemLevel: 4, location: "inventory", ownerPlayerId: B });
    expect(await pool.query("SELECT condition, gift_package_id FROM equipment_instances WHERE instance_id=$1", [axe]))
      .toMatchObject({ rows: [{ condition: 77, gift_package_id: null }] });
  });

  it("still delivers admin packages", async () => {
    const created = await packages.createCampaign(
      { subject: "verified-owner", playerId: null },
      {
        operationKey: randomUUID(),
        targetMode: "specific",
        recipientPlayerIds: [B],
        title: "Admin delivery",
        message: "",
        items: [{ itemKind: "resource", itemId: "wood", variant: "default", quantity: 3 }]
      }
    );
    expect(created.packages[0]).toMatchObject({ kind: "admin", sender: "Ash Atlas", senderPlayerId: null });
    const claimed = await packages.claim(B, created.packages[0]!.packageId, randomUUID(), created.packages[0]!.revision);
    expect(claimed.package.status).toBe("claimed");
    expect(await quantity(B, "wood")).toBe(3);
    expect((await gifts.status(B)).heldCount).toBe(0);
  });
});
