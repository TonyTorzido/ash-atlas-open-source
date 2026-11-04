import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { BACKPACK_LEVELS } from "@ash-atlas/shared";
import { BackpackError, BackpackService } from "./backpacks.js";
import { InventoryService } from "./inventory.js";
import { seedTradeSkillRank } from "./skills/tradeSkillTestSeed.js";
import { WalletService } from "./wallet.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("durable backpack crafting and capacity", () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 6 });
  const accountId = randomUUID();
  const playerId = `backpack-${randomUUID()}`;
  const actor = { accountId, playerId };

  beforeAll(async () => {
    await pool.query("SELECT 1");
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE accounts CASCADE");
    await pool.query(
      "INSERT INTO accounts (id,status,trust_tier) VALUES ($1,'active','standard')",
      [accountId]
    );
    await pool.query(
      `INSERT INTO players (
         id,account_id,username,username_normalized,region_code,lat,lon,
         anchor_lat,anchor_lon,move_leash_radius_m,online,geom
       ) VALUES ($1,$2,$3,$3,'GLOBAL',0,0,0,0,1250,true,
                 ST_SetSRID(ST_MakePoint(0,0),4326))`,
      [playerId, accountId, `Backpack Ranger ${accountId.slice(0, 8)}`]
    );
    await seedTradeSkillRank(pool, playerId, "leatherworking", 1);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await new WalletService().creditForOperationInTransaction(client, {
        playerId,
        accountId,
        amount: 200_000n,
        operationKey: `backpack-test-wallet:${playerId}`,
        reason: "backpack_test_seed"
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    await pool.query("INSERT INTO player_inventory_capacities(player_id,base_capacity_grams) VALUES($1,1000000)",[playerId]);
    await new InventoryService(pool).grantItemsForOperation({
      playerId,
      operationKey: `backpack-test-leather:${playerId}`,
      source: "backpack_test",
      sourceEntityType: "test",
      sourceEntityId: playerId,
      grants: [{ itemId: "leather", variant: null, quantity: 5_000 }]
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("refuses a Backpack craft without Leatherworking rank 1", async () => {
    await pool.query("DELETE FROM player_skill_ranks WHERE player_id=$1", [playerId]);
    await expect(new BackpackService(pool).craft({ playerId, accountId }, randomUUID())).rejects.toMatchObject({
      code: "BACKPACK_SKILL_REQUIRED",
      message: "Needs Leatherworking rank 1 to craft a Backpack."
    });
  });

  it("crafts a Backpack +0, replays exactly once, and upgrades the same instance through +10", async () => {
    const service = new BackpackService(pool);
    const createRequestId = randomUUID();
    const created = await service.craft(actor, createRequestId);
    const replay = await service.craft(actor, createRequestId);

    expect(created).toMatchObject({
      action: "create",
      replayed: false,
      walletGold: "198000",
      backpacks: {
        baseCapacityGrams: 1000000,
        backpackBonusGrams: 5000,
        maximumCapacityGrams: 1005000,
        instances: [{
          displayName: "Backpack +0",
          location: "inventory",
          upgradeLevel: 0,
          capacityBonusGrams: 5000,
          unitWeightGrams: 0
        }]
      }
    });
    expect(created.inventory.totals.leather).toBe(4920);
    expect(replay).toMatchObject({
      requestId: createRequestId,
      replayed: true,
      walletGold: "198000"
    });

    const instanceId = created.backpacks.instances[0]!.instanceId;
    expect(created.backpacks.equipped.every((item) => item === null)).toBe(true);
    let wallet = 198000;
    let leather = 4920;
    for (let level = 1; level <= 10; level++) {
      const definition = BACKPACK_LEVELS[level]!;
      wallet -= definition.upgradeCost.gold;
      leather -= definition.upgradeCost.leather;
      const result = await service.upgrade(actor, randomUUID(), instanceId);
      expect(result.walletGold).toBe(String(wallet));
      expect(result.inventory.totals.leather).toBe(leather);
      expect(result.backpacks).toMatchObject({
        backpackBonusGrams: definition.capacityBonusGrams,
        maximumCapacityGrams: 1000000 + definition.capacityBonusGrams
      });
      expect(result.backpacks.instances[0]).toMatchObject({
        instanceId,
        displayName: `Backpack +${level}`,
        location: "inventory",
        upgradeLevel: level,
        capacityBonusGrams: definition.capacityBonusGrams,
        unitWeightGrams: 0
      });
    }
    const reloaded = await new BackpackService(pool).getSnapshot(playerId);
    expect(reloaded.instances[0]).toMatchObject({
      instanceId,
      displayName: "Backpack +10",
      location: "inventory",
      upgradeLevel: 10,
      capacityBonusGrams: 55_000,
      unitWeightGrams: 0
    });
    await expect(service.upgrade(actor, randomUUID(), instanceId)).rejects.toMatchObject({
      code: "BACKPACK_MAXIMUM_TIER"
    });
  });

  it("upgrades an inventory backpack and grants its capacity without an equip gate", async () => {
    const service = new BackpackService(pool);
    const crafted = await service.craft(actor, randomUUID());
    const instanceId = crafted.backpacks.instances[0]!.instanceId;
    const upgraded = await service.upgrade(actor, randomUUID(), instanceId);
    expect(upgraded.backpacks).toMatchObject({
      backpackBonusGrams: 10000,
      maximumCapacityGrams: 1010000,
      instances: [{ instanceId, location: "inventory", upgradeLevel: 1, displayName: "Backpack +1" }]
    });
  });

  it("serializes duplicate upgrade retries and rejects a previous owner's request", async () => {
    const service = new BackpackService(pool);
    const crafted = await service.craft(actor, randomUUID());
    const instanceId = crafted.backpacks.instances[0]!.instanceId;
    const requestId = randomUUID();
    const [first, second] = await Promise.all([
      service.upgrade(actor, requestId, instanceId),
      service.upgrade(actor, requestId, instanceId)
    ]);
    expect(first.replayed || second.replayed).toBe(true);
    expect(first.backpacks.instances[0]?.upgradeLevel).toBe(1);
    expect(second.backpacks.instances[0]?.upgradeLevel).toBe(1);
    expect(first.walletGold).toBe("197500");
    expect(second.walletGold).toBe("197500");

    const otherAccountId = randomUUID();
    const otherPlayerId = `backpack-other-${randomUUID()}`;
    await pool.query(
      "INSERT INTO accounts (id,status,trust_tier) VALUES ($1,'active','standard')",
      [otherAccountId]
    );
    await pool.query(
      `INSERT INTO players (
         id,account_id,username,username_normalized,region_code,lat,lon,
         anchor_lat,anchor_lon,move_leash_radius_m,online,geom
       ) VALUES ($1,$2,$3,$3,'GLOBAL',0,0,0,0,1250,true,
                 ST_SetSRID(ST_MakePoint(0,0),4326))`,
      [otherPlayerId, otherAccountId, `Other Backpack ${otherAccountId.slice(0, 8)}`]
    );
    await expect(service.upgrade(
      { accountId: otherAccountId, playerId: otherPlayerId },
      randomUUID(),
      instanceId
    )).rejects.toMatchObject({ code: "BACKPACK_NOT_OWNED" });
  });

  it("rolls leather, gold, instance, event, and operation rows back together", async () => {
    const service = new BackpackService(pool, {
      afterDebit: () => {
        throw new Error("forced rollback");
      }
    });
    await expect(service.craft(actor, randomUUID())).rejects.toThrow(
      "forced rollback"
    );
    const result = await pool.query<{
      leather: string;
      gold: string;
      instances: string;
      operations: string;
      events: string;
    }>(
      `SELECT
         (SELECT quantity::text FROM player_inventory
          WHERE player_id=$1 AND resource_type='leather' AND variant='default') AS leather,
         (SELECT gold_balance::text FROM player_wallets WHERE player_id=$1) AS gold,
         (SELECT count(*)::text FROM player_backpack_instances WHERE owner_player_id=$1) AS instances,
         (SELECT count(*)::text FROM backpack_operations WHERE player_id=$1) AS operations,
         (SELECT count(*)::text FROM backpack_events WHERE player_id=$1) AS events`,
      [playerId]
    );
    expect(result.rows[0]).toEqual({
      leather: "5000",
      gold: "200000",
      instances: "0",
      operations: "0",
      events: "0"
    });
  });

  it("never debits the other resource when leather or gold is insufficient", async () => {
    const service = new BackpackService(pool);
    const inventory = new InventoryService(pool);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await inventory.debitItemsForOperationInTransaction(client, {
        playerId,
        operationKey: `backpack-test-leather-drain:${playerId}`,
        source: "backpack_test",
        sourceEntityType: "test",
        sourceEntityId: playerId,
        debits: [{ itemId: "leather", variant: null, quantity: 4_921 }]
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    await expect(service.craft(actor, randomUUID())).rejects.toMatchObject({
      code: "BACKPACK_INSUFFICIENT_LEATHER"
    });
    await expect(pool.query<{ gold: string }>(
      "SELECT gold_balance::text AS gold FROM player_wallets WHERE player_id=$1",
      [playerId]
    )).resolves.toMatchObject({ rows: [{ gold: "200000" }] });

    await inventory.grantItemsForOperation({
      playerId,
      operationKey: `backpack-test-leather-restore:${playerId}`,
      source: "backpack_test",
      sourceEntityType: "test",
      sourceEntityId: playerId,
      grants: [{ itemId: "leather", variant: null, quantity: 4_921 }]
    });
    const walletClient = await pool.connect();
    try {
      await walletClient.query("BEGIN");
      await new WalletService().debitForOperationInTransaction(walletClient, {
        playerId,
        accountId,
        amount: 198_001n,
        operationKey: `backpack-test-wallet-drain:${playerId}`,
        reason: "backpack_test"
      });
      await walletClient.query("COMMIT");
    } catch (error) {
      await walletClient.query("ROLLBACK");
      throw error;
    } finally {
      walletClient.release();
    }
    await expect(service.craft(actor, randomUUID())).rejects.toMatchObject({
      code: "BACKPACK_INSUFFICIENT_GOLD"
    });
    await expect(pool.query<{ leather: string }>(
      `SELECT quantity::text AS leather FROM player_inventory
       WHERE player_id=$1 AND resource_type='leather' AND variant='default'`,
       [playerId]
    )).resolves.toMatchObject({ rows: [{ leather: "5000" }] });
  });

  it("rejects obsolete equip and unequip mutations without changing custody", async () => {
    const service = new BackpackService(pool);
    const created = await service.craft(actor, randomUUID());
    const instanceId = created.backpacks.instances[0]!.instanceId;
    await expect(service.equip(actor, randomUUID(), instanceId, 0)).rejects.toSatisfy((error: unknown) =>
      error instanceof BackpackError && error.code === "BACKPACK_INVALID_REQUEST");
    await expect(service.unequip(actor, randomUUID(), instanceId)).rejects.toSatisfy((error: unknown) =>
      error instanceof BackpackError && error.code === "BACKPACK_INVALID_REQUEST");
    const snapshot = await service.getSnapshot(playerId);
    expect(snapshot).toMatchObject({
      backpackBonusGrams: 5000,
      maximumCapacityGrams: 1005000,
      equipped: [null, null, null, null],
      instances: [{ instanceId, location: "inventory", upgradeLevel: 0 }]
    });
  });

  it("counts all owned backpack instances cumulatively", async () => {
    const service = new BackpackService(pool);
    const crafted = await Promise.all([
      service.craft(actor, randomUUID()),
      service.craft(actor, randomUUID()),
      service.craft(actor, randomUUID())
    ]);
    expect(crafted).toHaveLength(3);
    const instances = await pool.query<{ instance_id: string }>(
      `SELECT instance_id::text
       FROM player_backpack_instances
       WHERE owner_player_id=$1 AND location='inventory'
       ORDER BY created_at,instance_id`,
      [playerId]
    );
    expect(instances.rows).toHaveLength(3);
    const instanceIds = instances.rows.map((row) => row.instance_id);
    const first = await service.upgrade(actor, randomUUID(), instanceIds[0]!);
    const second = await service.upgrade(actor, randomUUID(), instanceIds[1]!);
    expect(second.backpacks).toMatchObject({
      backpackBonusGrams: 25000,
      maximumCapacityGrams: 1025000
    });
    expect(second.backpacks.instances).toEqual(expect.arrayContaining([
      expect.objectContaining({ instanceId: instanceIds[0], location: "inventory", upgradeLevel: 1 }),
      expect.objectContaining({ instanceId: instanceIds[1], location: "inventory", upgradeLevel: 1 }),
      expect.objectContaining({ instanceId: instanceIds[2], location: "inventory", upgradeLevel: 0 })
    ]));
    expect(first.backpacks.equipped.every((item) => item === null)).toBe(true);
  });
});
