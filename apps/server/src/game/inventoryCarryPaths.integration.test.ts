import { randomUUID } from "node:crypto";
import { EQUIPMENT_CRAFT_RECIPES, getItemWeightGrams, type ResourceType } from "@ash-atlas/shared";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../db/migrate.js";
import { DisposableTestPool } from "../db/disposableTestPool.js";
import { DroppedItemService } from "./droppedItems.js";
import { DevelopmentEconomyService } from "./developmentEconomy.js";
import { EquipmentService } from "./equipment.js";
import { InventoryService } from "./inventory.js";
import { materialProtectionAllocation } from "./inventoryProtection.js";
import { ManorStorageService } from "./manor.js";
import type { PlayerRecord } from "./state.js";

const adminUrl = process.env.CARRY_PATHS_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;

describeDatabase("carry capacity across durable inventory callers", () => {
  const databaseName = `ash_atlas_stability_inventory_paths_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  let pool: pg.Pool;
  let inventory: InventoryService;

  beforeAll(async () => {
    const url = new URL(adminUrl!);
    if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname)) throw new Error("Local disposable PostgreSQL required");
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    url.pathname = `/${databaseName}`;
    await runMigrations(url.toString());
    pool = new DisposableTestPool({ connectionString: url.toString(), max: 8 });
    inventory = new InventoryService(pool);
  }, 90_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await admin.end();
  });

  async function actor(capacityGrams = 100_000): Promise<PlayerRecord & { accountId: string }> {
    const accountId = randomUUID();
    const playerId = `carry-path-${randomUUID()}`;
    await pool.query("INSERT INTO accounts (id,status,trust_tier) VALUES ($1,'active','standard')", [accountId]);
    await pool.query(
      `INSERT INTO players (id,account_id,username,username_normalized,region_code,lat,lon,
       anchor_lat,anchor_lon,move_leash_radius_m,online,geom)
       VALUES ($1,$2,$1,$1,'GLOBAL',35,-106,35,-106,1250,true,ST_SetSRID(ST_MakePoint(-106,35),4326))`,
      [playerId, accountId]
    );
    await pool.query(
      `INSERT INTO player_inventory_capacities (player_id,base_capacity_grams) VALUES ($1,$2)
       ON CONFLICT (player_id) DO UPDATE SET base_capacity_grams=EXCLUDED.base_capacity_grams`,
      [playerId, capacityGrams]
    );
    return { playerId, accountId, username: playerId, displayColor: null, regionCode: "GLOBAL",
      position: { lat: 35, lon: -106 }, anchor: { lat: 35, lon: -106 }, moveLeashRadiusM: 1250,
      movementRevision: 0, target: null, online: true, updatedAt: new Date() };
  }
  function grant(playerId: string, itemId: ResourceType, quantity: number) {
    return inventory.grantItemsForOperation({ playerId, operationKey: randomUUID(), source: "carry_paths_test", grants: [{ itemId, variant: null, quantity }] });
  }
  async function fill(playerId: string) {
    const snapshot = await inventory.getInventorySnapshot(playerId);
    const room = BigInt(snapshot.maximumWeightGrams!) - BigInt(snapshot.currentWeightGrams!);
    const quantity = Number(room / BigInt(getItemWeightGrams("wood")));
    if (quantity > 0) await grant(playerId, "wood", quantity);
  }
  async function seedManor(playerId: string) {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO player_manors (owner_player_id,world_region_code,world_lat,world_lon,geom,built_at,placement_revision)
       VALUES ($1,'GLOBAL',35,-106,ST_SetSRID(ST_MakePoint(-106,35),4326),now(),1) RETURNING id`, [playerId]
    );
    const manorId = result.rows[0]!.id;
    await pool.query(
      `INSERT INTO player_manor_presence (player_id,manor_id,return_region_code,return_lat,return_lon)
       VALUES ($1,$2,'GLOBAL',35,-106)`, [playerId, manorId]
    );
    return manorId;
  }

  it("keeps one balance and drops quantities above the old stack limit with exact replay", async () => {
    const owner = await actor();
    await grant(owner.playerId, "wood", 900);
    const before = await inventory.getInventorySnapshot(owner.playerId);
    expect(before.items.filter(item => item.resourceType === "wood")).toHaveLength(1);
    const service = new DroppedItemService(pool);
    const request = { requestId: randomUUID(), itemId: "wood", variant: null, stackId: before.items[0]!.stackId!, quantity: 700 };
    const dropped = await service.dropItem(owner, request);
    expect(dropped.drop.quantity).toBe(700);
    expect(dropped.inventory.totals.wood).toBe(200);
    expect((await service.dropItem(owner, request)).replayed).toBe(true);
    expect((await inventory.getInventorySnapshot(owner.playerId)).totals.wood).toBe(200);
  });

  it("preserves a full player's ground pickup, then takes only the fitting quantity", async () => {
    const source = await actor();
    const receiver = await actor(1_000);
    await grant(source.playerId, "wood", 20);
    const service = new DroppedItemService(pool);
    const drop = await service.dropItem(source, { requestId: randomUUID(), itemId: "wood", quantity: 20, variant: null });
    await fill(receiver.playerId);
    await expect(service.pickupDroppedItem(receiver, randomUUID(), drop.drop.dropId)).rejects.toThrow(/capacity/i);
    expect((await pool.query("SELECT remaining_quantity::text,status FROM world_item_drops WHERE id=$1", [drop.drop.dropId])).rows[0])
      .toEqual({ remaining_quantity: "20", status: "active" });
    const debitClient = await pool.connect();
    try {
      await debitClient.query("BEGIN");
      await inventory.debitItemsForOperationInTransaction(debitClient, { operationKey: randomUUID(), playerId: receiver.playerId, source: "carry_paths_test", debits: [{ itemId: "wood", quantity: 3, variant: null }] });
      await debitClient.query("COMMIT");
    } finally { debitClient.release(); }
    const requestId = randomUUID();
    const pickup = await service.pickupDroppedItem(receiver, requestId, drop.drop.dropId);
    expect(pickup).toMatchObject({ pickedUpQuantity: 3, remainingQuantity: 17 });
    expect((await service.pickupDroppedItem(receiver, requestId, drop.drop.dropId)).replayed).toBe(true);
    expect((await inventory.getInventorySnapshot(receiver.playerId)).totals.wood).toBe(10);
  });

  it("crafts from a full inventory using the net material-to-equipment weight and replays once", async () => {
    const recipe = EQUIPMENT_CRAFT_RECIPES.find(recipe => recipe.familyId === "sword")!;
    const materialWeight = recipe.materials.reduce((sum, item) => sum + getItemWeightGrams(item.itemId) * item.quantity, 0);
    const owner = await actor(materialWeight);
    for (const material of recipe.materials) await grant(owner.playerId, material.itemId, material.quantity);
    const equipment = new EquipmentService(pool);
    const requestId = randomUUID();
    const authority = { kind: "manor_smith" as const, manorId: randomUUID(), manorSessionId: randomUUID(), movementSequence: 0, authorize: async () => {} };
    const crafted = await equipment.craftStockEquipment(owner, recipe.familyId, requestId, authority);
    expect(crafted.inventory.currentWeightGrams).toBe(String(getItemWeightGrams(recipe.definitionId)));
    expect(crafted.inventory.items).toHaveLength(0);
    expect(crafted.equipment.instances).toHaveLength(1);
    expect((await equipment.craftStockEquipment(owner, recipe.familyId, requestId, authority)).replayed).toBe(true);
    expect((await pool.query("SELECT count(*)::int AS count FROM equipment_instances WHERE owner_player_id=$1", [owner.playerId])).rows[0]!.count).toBe(1);
  });

  it("rejects overweight manor withdrawals without losing stored resources or unique equipment state", async () => {
    const owner = await actor(1_000);
    const manorId = await seedManor(owner.playerId);
    const resource = await pool.query<{ stack_id: string }>(
      `INSERT INTO manor_storage_stacks (manor_id,slot_index,item_id,variant,quantity)
       VALUES ($1,0,'wood','default',25) RETURNING stack_id`, [manorId]
    );
    const instanceId = randomUUID();
    const equipmentOperationKey = randomUUID();
    await pool.query("INSERT INTO equipment_operations (operation_key,player_id,action) VALUES ($1,$2,'starter_loadout')", [equipmentOperationKey, owner.playerId]);
    await pool.query(
      `INSERT INTO equipment_instances (instance_id,definition_id,owner_player_id,location,
       equipped_slot,inventory_slot_index,manor_id,manor_slot_index,item_level,condition,balance_version,created_by_operation_key)
       VALUES ($1,'starter_sword',$2,'manor_storage',NULL,NULL,$3,1,3,41,1,$4)`,
      [instanceId, owner.playerId, manorId, equipmentOperationKey]
    );
    await fill(owner.playerId);
    const storage = new ManorStorageService(pool);
    await expect(storage.transfer({ playerId: owner.playerId, requestId: randomUUID(), direction: "withdrawal", sourceStackId: resource.rows[0]!.stack_id, quantity: 1 })).rejects.toMatchObject({ code: "PLAYER_INVENTORY_FULL" });
    await expect(storage.transferEquipment({ playerId: owner.playerId, requestId: randomUUID(), direction: "withdrawal", equipmentInstanceId: instanceId })).rejects.toMatchObject({ code: "PLAYER_INVENTORY_FULL" });
    expect((await pool.query("SELECT quantity::text FROM manor_storage_stacks WHERE stack_id=$1", [resource.rows[0]!.stack_id])).rows[0]!.quantity).toBe("25");
    expect((await pool.query("SELECT location,item_level,condition FROM equipment_instances WHERE instance_id=$1", [instanceId])).rows[0])
      .toEqual({ location: "manor_storage", item_level: 3, condition: 41 });
  });

  it("keeps exact dropped equipment state on failed pickup and transfers that instance once", async () => {
    const owner = await actor();
    const receiver = await actor(1_000);
    const equipment = new EquipmentService(pool);
    const starter = await equipment.ensureStarterLoadout(owner.playerId);
    const item = starter.equipment.instances.find(item => item.definitionId === "starter_staff")!;
    await pool.query("UPDATE equipment_instances SET condition=41,item_level=3 WHERE instance_id=$1", [item.instanceId]);
    const state = await pool.query("SELECT inventory_revision::text FROM player_equipment_state WHERE player_id=$1", [owner.playerId]);
    const service = new DroppedItemService(pool);
    const dropped = await service.dropEquipment(owner, { requestId: randomUUID(), equipmentInstanceId: item.instanceId, expectedEquipmentRevision: Number(state.rows[0]!.inventory_revision) });
    await expect(service.pickupDroppedEquipment(receiver, randomUUID(), dropped.drop.dropId))
      .rejects.toMatchObject({ code: "DROPPED_ITEM_CARRY_CAPACITY_EXCEEDED" });
    expect((await pool.query("SELECT owner_player_id,location,condition,item_level FROM equipment_instances WHERE instance_id=$1", [item.instanceId])).rows[0])
      .toEqual({ owner_player_id: owner.playerId, location: "world_drop", condition: 41, item_level: 3 });
    await pool.query("UPDATE player_inventory_capacities SET base_capacity_grams=$2 WHERE player_id=$1", [receiver.playerId, getItemWeightGrams(item.definitionId)]);
    const requestId = randomUUID();
    await service.pickupDroppedEquipment(receiver, requestId, dropped.drop.dropId);
    expect((await service.pickupDroppedEquipment(receiver, requestId, dropped.drop.dropId)).replayed).toBe(true);
    expect((await pool.query("SELECT owner_player_id,location,condition,item_level,inventory_slot_index FROM equipment_instances WHERE instance_id=$1", [item.instanceId])).rows[0])
      .toEqual({ owner_player_id: receiver.playerId, location: "inventory", condition: 41, item_level: 3, inventory_slot_index: null });
  });

  it("persists Manor floor equipment with exact local coordinates and replays drop and pickup once", async () => {
    const owner = await actor();
    const manorId = await seedManor(owner.playerId);
    const equipment = new EquipmentService(pool);
    const starter = await equipment.ensureStarterLoadout(owner.playerId);
    const item = starter.equipment.instances.find((candidate) => candidate.definitionId === "starter_staff")!;
    const state = await pool.query(
      "SELECT inventory_revision::text FROM player_equipment_state WHERE player_id=$1",
      [owner.playerId]
    );
    const service = new DroppedItemService(pool);
    const position = { x: 901, y: 402 };
    const dropInput = {
      requestId: randomUUID(),
      equipmentInstanceId: item.instanceId,
      expectedEquipmentRevision: Number(state.rows[0]!.inventory_revision),
      manorId,
      spaceId: "manor_main_room" as const,
      position
    };
    const dropped = await service.dropManorEquipment(owner.playerId, dropInput);
    expect(dropped.drop).toMatchObject({
      manorId,
      spaceId: "manor_main_room",
      localX: position.x,
      localY: position.y,
      status: "active",
      quantity: 1
    });
    expect((await service.dropManorEquipment(owner.playerId, dropInput)).replayed).toBe(true);
    expect(await service.listActiveManorEquipment(manorId, "manor_main_room")).toEqual([dropped.drop]);

    const ownerInManor = {
      ...owner,
      regionCode: `interior:manor:${manorId}`,
      zoneId: `manor:${manorId}:manor_main_room`,
      manorId,
      spaceId: "manor_main_room" as const,
      localPosition: position,
      position: { lat: 0, lon: 0 }
    };
    const pickupRequestId = randomUUID();
    const pickedUp = await service.pickupDroppedEquipment(
      ownerInManor,
      pickupRequestId,
      dropped.drop.dropId
    );
    expect(pickedUp.drop.status).toBe("picked_up");
    expect((await service.pickupDroppedEquipment(
      ownerInManor,
      pickupRequestId,
      dropped.drop.dropId
    )).replayed).toBe(true);
    expect((await service.listActiveManorEquipment(manorId, "manor_main_room"))).toEqual([]);
    expect((await pool.query(
      "SELECT owner_player_id,location FROM equipment_instances WHERE instance_id=$1",
      [item.instanceId]
    )).rows[0]).toEqual({ owner_player_id: owner.playerId, location: "inventory" });
  });

  it("persists Manor material drops as separate custody rows while projecting a nearby pile", async () => {
    const owner = await actor(20_000_000);
    const manorId = await seedManor(owner.playerId);
    await grant(owner.playerId, "wood", 6_000);
    const before = await inventory.getInventorySnapshot(owner.playerId);
    const position = { x: 900, y: 400 };
    const ownerInManor = {
      ...owner,
      regionCode: `interior:manor:${manorId}`,
      zoneId: `manor:${manorId}:manor_main_room`,
      manorId,
      spaceId: "manor_main_room" as const,
      localPosition: position,
      position: { lat: 0, lon: 0 }
    };
    const service = new DroppedItemService(pool);
    const firstRequestId = randomUUID();
    const woodStackId = before.items.find((item) => item.resourceType === "wood")?.stackId;
    if (!woodStackId) throw new Error("wood grant did not create a stack");
    const first = await service.dropItem(ownerInManor, {
      requestId: firstRequestId,
      itemId: "wood",
      variant: null,
      quantity: 3_000,
      stackId: woodStackId
    });
    const second = await service.dropItem({
      ...ownerInManor,
      localPosition: { x: position.x + 30, y: position.y + 40 }
    }, {
      requestId: randomUUID(),
      itemId: "wood",
      variant: null,
      quantity: 3_000
    });
    expect(second.drop).toMatchObject({
      manorId,
      spaceId: "manor_main_room",
      pileId: first.drop.pileId,
      localX: position.x + 30,
      localY: position.y + 40,
      expiresAt: "9999-12-31T23:59:59.999Z"
    });
    expect((await pool.query<{ count: string; quantity: string }>(
      `SELECT count(*)::text AS count, sum(original_quantity)::text AS quantity
       FROM world_item_drops WHERE manor_id=$1 AND status='active'`,
      [manorId]
    )).rows[0]).toEqual({ count: "2", quantity: "6000" });
    await expect(service.listActiveManorDrops(manorId, "manor_main_room"))
      .resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ dropId: first.drop.dropId, localX: position.x, localY: position.y }),
        expect.objectContaining({ dropId: second.drop.dropId, localX: position.x + 30, localY: position.y + 40 })
      ]));
    expect((await service.dropItem(ownerInManor, {
      requestId: firstRequestId,
      itemId: "wood",
      variant: null,
      quantity: 3_000,
      stackId: woodStackId
    })).replayed).toBe(true);
    const offCoordinate = { ...ownerInManor, localPosition: { x: position.x + .02, y: position.y } };
    const pickupRequestId = randomUUID();
    await expect(service.pickupDroppedItem(offCoordinate, pickupRequestId, first.drop.dropId))
      .rejects.toMatchObject({ code: "DROPPED_ITEM_OUT_OF_RANGE" });
    const pickedUp = await service.pickupDroppedItem(ownerInManor, pickupRequestId, first.drop.dropId);
    expect(pickedUp).toMatchObject({ pickedUpQuantity: 3_000, removed: true });
    await expect(service.pickupDroppedItem(offCoordinate, pickupRequestId, first.drop.dropId))
      .resolves.toMatchObject({ replayed: true });
    const pickedUpSecond = await service.pickupDroppedItem(
      { ...ownerInManor, localPosition: { x: position.x + 30, y: position.y + 40 } },
      randomUUID(),
      second.drop.dropId
    );
    expect(pickedUpSecond).toMatchObject({ pickedUpQuantity: 3_000, removed: true });
    await expect(service.pickupDroppedItem(ownerInManor, randomUUID(), first.drop.dropId))
      .rejects.toMatchObject({ code: "DROPPED_ITEM_ALREADY_PICKED_UP" });
    const redropped = await service.dropItem(ownerInManor, {
      requestId: randomUUID(),
      itemId: "wood",
      variant: null,
      quantity: 6_000
    });
    expect(redropped.drop).toMatchObject({
      manorId,
      spaceId: "manor_main_room",
      localX: position.x,
      localY: position.y
    });
  });

  it("anchors an ordinary Manor item to a mixed recovery pile and picks only that row once", async () => {
    const owner = await actor();
    const manorId = await seedManor(owner.playerId);
    await grant(owner.playerId, "wood", 1);
    await grant(owner.playerId, "iron", 2);
    const position = { x: 877.8, y: 307.23 };
    const ownerInManor = {
      ...owner,
      regionCode: `interior:manor:${manorId}`,
      zoneId: `manor:${manorId}:manor_main_room`,
      manorId,
      spaceId: "manor_main_room" as const,
      localPosition: position,
      position: { lat: 0, lon: 0 }
    };
    const service = new DroppedItemService(pool);
    const recoveryPileId = `manor-storage-recovery:${manorId}`;
    const recoveredWood = await service.dropItem(ownerInManor, {
      requestId: randomUUID(),
      itemId: "wood",
      variant: null,
      quantity: 1
    });
    await pool.query(
      "UPDATE world_item_drops SET pile_id=$2,pile_order=0 WHERE id=$1",
      [recoveredWood.drop.dropId, recoveryPileId]
    );

    const equipment = new EquipmentService(pool);
    const starter = await equipment.ensureStarterLoadout(owner.playerId);
    const recoveredEquipment = starter.equipment.instances.find(
      (candidate) => candidate.definitionId === "starter_staff"
    )!;
    const state = await pool.query(
      "SELECT inventory_revision::text FROM player_equipment_state WHERE player_id=$1",
      [owner.playerId]
    );
    const equipmentDrop = await service.dropManorEquipment(owner.playerId, {
      requestId: randomUUID(),
      equipmentInstanceId: recoveredEquipment.instanceId,
      expectedEquipmentRevision: Number(state.rows[0]!.inventory_revision),
      manorId,
      spaceId: "manor_main_room",
      position
    });
    await pool.query(
      "UPDATE world_equipment_drops SET pile_id=$2,pile_order=1 WHERE id=$1",
      [equipmentDrop.drop.dropId, recoveryPileId]
    );

    const newIron = await service.dropItem(ownerInManor, {
      requestId: randomUUID(),
      itemId: "iron",
      variant: null,
      quantity: 2
    });
    expect(newIron.drop).toMatchObject({
      manorId,
      spaceId: "manor_main_room",
      pileId: recoveryPileId,
      pileOrder: 2,
      localX: position.x,
      localY: position.y
    });
    await expect(service.listActiveManorDrops(manorId, "manor_main_room"))
      .resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ dropId: recoveredWood.drop.dropId, pileId: recoveryPileId }),
        expect.objectContaining({ dropId: equipmentDrop.drop.dropId, pileId: recoveryPileId }),
        expect.objectContaining({ dropId: newIron.drop.dropId, pileId: recoveryPileId })
      ]));

    const pickupRequestId = randomUUID();
    const picked = await service.pickupDroppedItem(
      ownerInManor,
      pickupRequestId,
      newIron.drop.dropId
    );
    expect(picked).toMatchObject({
      pickedUpQuantity: 2,
      remainingQuantity: 0,
      removed: true
    });
    expect((await service.pickupDroppedItem(
      ownerInManor,
      pickupRequestId,
      newIron.drop.dropId
    )).replayed).toBe(true);
    expect((await pool.query(
      "SELECT status,remaining_quantity::text AS remaining_quantity FROM world_item_drops WHERE id=$1",
      [recoveredWood.drop.dropId]
    )).rows[0]).toEqual({ status: "active", remaining_quantity: "1" });
    expect((await pool.query(
      "SELECT status,remaining_quantity::text AS remaining_quantity FROM world_item_drops WHERE id=$1",
      [newIron.drop.dropId]
    )).rows[0]).toEqual({ status: "picked_up", remaining_quantity: "0" });
    expect((await pool.query(
      "SELECT status FROM world_equipment_drops WHERE id=$1",
      [equipmentDrop.drop.dropId]
    )).rows[0]).toEqual({ status: "active" });
    expect((await inventory.getInventorySnapshot(owner.playerId)).totals.iron).toBe(2);
  });

  it("rolls back the entire developer grant when requested materials exceed capacity", async () => {
    const owner = await actor(1_000);
    const service = new DevelopmentEconomyService(pool);
    await expect(service.grant(owner.playerId, owner.accountId, randomUUID(), { gold: 100n, materials: [{ itemId: "wood", quantity: 11n }] }))
      .rejects.toMatchObject({ code: "DEV_CARRY_CAPACITY_EXCEEDED" });
    expect((await inventory.getInventorySnapshot(owner.playerId)).totals.wood).toBe(0);
    const wallet = await pool.query("SELECT gold_balance::text AS gold FROM player_wallets WHERE player_id=$1", [owner.playerId]);
    expect(wallet.rows[0]?.gold ?? "0").toBe("0");
  });

  it("uses the canonical resource entry UUID for protected partial deposits", async () => {
    const owner = await actor();
    const manorId = await seedManor(owner.playerId);
    await grant(owner.playerId, "wood", 437);
    const entry = (await inventory.getInventorySnapshot(owner.playerId)).items[0]!;
    await pool.query("INSERT INTO player_item_keep_policies (player_id,item_id,variant,keep_quantity,revision) VALUES ($1,'wood','default',400,1)", [owner.playerId]);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const allocation = await materialProtectionAllocation(client, owner.playerId);
      expect(allocation.byStackId.get(entry.stackId!)?.movableQuantity).toBe(37);
      await client.query("COMMIT");
    } finally { client.release(); }
    const storage = new ManorStorageService(pool);
    await expect(storage.transfer({ playerId: owner.playerId, requestId: randomUUID(), direction: "deposit", sourceStackId: entry.stackId!, quantity: 38 })).rejects.toThrow(/protect/i);
    const result = await storage.transfer({ playerId: owner.playerId, requestId: randomUUID(), direction: "deposit", sourceStackId: entry.stackId!, quantity: 37 });
    expect(result.inventory.totals.wood).toBe(400);
    expect((await pool.query("SELECT sum(quantity)::text AS total FROM manor_storage_stacks WHERE manor_id=$1", [manorId])).rows[0]!.total).toBe("37");
  });
});
