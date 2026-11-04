import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runMigrations } from "../db/migrate.js";
import { EquipmentService } from "./equipment.js";
import { InventoryService } from "./inventory.js";
import { spendUtilityGearUseInTransaction } from "./utilityGear.js";

const databaseUrl = safeDisposableDatabaseUrl(process.env.TEST_DATABASE_URL);
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("Loadout Scroll PostgreSQL integration", () => {
  let pool: pg.Pool;
  let inventory: InventoryService;
  let equipment: EquipmentService;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl!, max: 6 });
    await pool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ash_atlas_telemetry_exporter') THEN
        CREATE ROLE ash_atlas_telemetry_exporter NOLOGIN;
      END IF;
    END $$`);
    await runMigrations(databaseUrl!);
  }, 180_000);

  afterAll(async () => { await pool?.end(); });

  beforeEach(() => {
    inventory = new InventoryService(pool);
    equipment = new EquipmentService(pool, { inventory });
  });

  async function inTransaction(work: (client: pg.PoolClient) => Promise<void>): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await work(client);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async function player(atlasPass: boolean): Promise<string> {
    const accountId = randomUUID();
    const playerId = `scroll-${randomUUID().slice(0, 8)}`;
    await pool.query("INSERT INTO accounts (id) VALUES ($1)", [accountId]);
    await pool.query(
      `INSERT INTO players (
         id, account_id, username, display_color, region_code, lat, lon,
         anchor_lat, anchor_lon, move_leash_radius_m, online, geom
       ) VALUES ($1, $2, $3, '#38bdf8', 'NM', 35, -106, 35, -106, 900, false,
         ST_SetSRID(ST_MakePoint(-106, 35), 4326))`,
      [playerId, accountId, `U${playerId.slice(-8)}`]
    );
    await pool.query("INSERT INTO player_progression_profiles (player_id) VALUES ($1)", [playerId]);
    if (atlasPass) {
      await pool.query(
        `INSERT INTO premium_subscriptions (account_id, platform, original_transaction_id, sku, environment, status, current_period_end)
         VALUES ($1, 'web', $2, 'atlas_pass_monthly', 'sandbox', 'active', now() + interval '20 days')`,
        [accountId, `sub-${accountId}`]
      );
    }
    await inTransaction(async (client) => {
      await inventory.grantItemsForOperationInTransaction(client, {
        operationKey: `seed:${playerId}`, playerId, source: "test", sourceEntityType: "test", sourceEntityId: playerId,
        grants: [
          { itemId: "gearwork_essence", variant: null, quantity: 400 },
          { itemId: "cloth", variant: null, quantity: 40 }
        ]
      });
      await inventory.grantItemsForOperationInTransaction(client, {
        operationKey: `seed-lumen:${playerId}`, playerId, source: "lumen_admin_grant", sourceEntityType: "test", sourceEntityId: playerId,
        grants: [{ itemId: "lumen", variant: null, quantity: 200 }]
      });
    });
    await equipment.ensureStarterLoadout(playerId);
    return playerId;
  }

  async function held(playerId: string, itemId: string): Promise<number> {
    const result = await pool.query<{ quantity: string }>(
      "SELECT COALESCE(sum(quantity),0) AS quantity FROM player_inventory WHERE player_id=$1 AND resource_type=$2",
      [playerId, itemId]
    );
    return Number(result.rows[0]!.quantity);
  }

  async function grantGear(playerId: string, definitionIds: readonly string[]): Promise<Record<string, string>> {
    const operationKey = `gear:${playerId}:${randomUUID()}`;
    await inTransaction(async (client) => {
      await equipment.grantPackageInstancesInTransaction(client, {
        operationKey, playerId, source: "test",
        grants: definitionIds.map((definitionId) => ({ definitionId, quantity: 1 }))
      } as Parameters<EquipmentService["grantPackageInstancesInTransaction"]>[1]);
    });
    const rows = await pool.query<{ definition_id: string; instance_id: string }>(
      "SELECT definition_id, instance_id::text FROM equipment_instances WHERE created_by_operation_key=$1",
      [operationKey]
    );
    return Object.fromEntries(rows.rows.map((row) => [row.definition_id, row.instance_id]));
  }

  async function worn(playerId: string): Promise<Record<string, string>> {
    const rows = await pool.query<{ equipped_slot: string; instance_id: string }>(
      "SELECT equipped_slot, instance_id::text FROM equipment_instances WHERE owner_player_id=$1 AND location='equipped'",
      [playerId]
    );
    return Object.fromEntries(rows.rows.map((row) => [row.equipped_slot, row.instance_id]));
  }

  /** Two scrolls: 1 = starter melee + chest, 2 = axe + chain armor + shield. */
  async function twoSets(playerId: string) {
    await equipment.craftGearScroll(playerId, randomUUID());
    await equipment.craftGearScroll(playerId, randomUUID());
    const gear = await grantGear(playerId, ["training_axe", "chain_armor", "training_shield"]);
    await equipment.connectRuntime(playerId);
    const starter = await worn(playerId);
    await equipment.rememberGearScroll(playerId, 1, "weapons_armor");
    await equipment.equip(playerId, gear.training_axe!, "melee", randomUUID());
    await equipment.equip(playerId, gear.chain_armor!, "chest", randomUUID());
    await equipment.equip(playerId, gear.training_shield!, "secondary", randomUUID());
    await equipment.rememberGearScroll(playerId, 2, "weapons_armor");
    return { starter, gear };
  }

  it("lets an Atlas Pass member craft, charging once on a replayed request", async () => {
    const playerId = await player(true);
    const requestId = randomUUID();
    const first = await equipment.craftGearScroll(playerId, requestId);
    const replay = await equipment.craftGearScroll(playerId, requestId);
    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(await held(playerId, "loadout_scroll")).toBe(1);
    expect(await held(playerId, "lumen")).toBe(140);
    expect(await held(playerId, "gearwork_essence")).toBe(280);
    expect(await held(playerId, "cloth")).toBe(32);
    expect(replay.gearScrolls.count).toBe(1);
  });

  it("denies crafting without an Atlas Pass and leaves the materials alone", async () => {
    const playerId = await player(false);
    await expect(equipment.craftGearScroll(playerId, randomUUID())).rejects.toMatchObject({ code: "UTILITY_GEAR_PASS_REQUIRED" });
    expect(await held(playerId, "loadout_scroll")).toBe(0);
    expect(await held(playerId, "lumen")).toBe(200);
  });

  it("remembers instance ids, equips them back and skips an item that left the player", async () => {
    const playerId = await player(true);
    const { starter, gear } = await twoSets(playerId);
    const view = await equipment.gearScrolls(playerId);
    expect(view.scrolls[1]!.items.map((item) => item.instanceId).sort())
      .toEqual([gear.training_axe, gear.chain_armor, gear.training_shield].sort());
    expect(view.scrolls[1]!.items.every((item) => item.displayName)).toBe(true);

    const back = await equipment.equipGearScroll(playerId, 1, randomUUID());
    expect(back).toMatchObject({ kind: "applied", changed: true, skipped: 0 });
    expect((await worn(playerId)).melee).toBe(starter.melee);
    // The scroll is not consumed and costs nothing.
    expect(await held(playerId, "loadout_scroll")).toBe(2);

    // The chain armor is dropped; equipping scroll 2 skips it and keeps the current chest.
    await pool.query("UPDATE equipment_instances SET location='world_drop' WHERE instance_id=$1", [gear.chain_armor]);
    const partial = await equipment.equipGearScroll(playerId, 2, randomUUID());
    expect(partial).toMatchObject({ kind: "applied", equipped: 2, skipped: 1 });
    const after = await worn(playerId);
    expect(after.melee).toBe(gear.training_axe);
    expect(after.secondary).toBe(gear.training_shield);
    expect(after.chest).toBe(starter.chest);
    expect(equipment.runtimeSnapshot(playerId)!.active.melee?.instanceId).toBe(gear.training_axe);
  });

  it("swaps scrolls while a utility glove is worn and leaves the glove on", async () => {
    const playerId = await player(true);
    const { starter } = await twoSets(playerId);
    const { lumber_glove: glove } = await grantGear(playerId, ["lumber_glove"]);
    await pool.query("UPDATE equipment_instances SET location='equipped', equipped_slot='gloves' WHERE instance_id=$1", [glove]);
    await equipment.refreshInventorySlots(playerId);

    expect(await equipment.equipGearScroll(playerId, 1, randomUUID())).toMatchObject({ kind: "applied", changed: true, skipped: 0 });
    const after = await worn(playerId);
    expect(after.melee).toBe(starter.melee);
    expect(after.gloves).toBe(glove);
    expect(equipment.runtimeSnapshot(playerId)!.active.gloves?.instanceId).toBe(glove);
  });

  it("skips remembered gear the active class cannot use and puts on the rest", async () => {
    const playerId = await player(true);
    const { starter, gear } = await twoSets(playerId);
    await equipment.equipGearScroll(playerId, 1, randomUUID());
    const outcome = await equipment.equipGearScroll(playerId, 2, randomUUID(), {
      classAllows: (weapon) => weapon?.weaponCategory !== "axe"
    });
    expect(outcome).toMatchObject({ kind: "applied", changed: true, equipped: 2, skipped: 1 });
    const after = await worn(playerId);
    expect(after.melee).toBe(starter.melee);
    expect(after.chest).toBe(gear.chain_armor);
    expect(after.secondary).toBe(gear.training_shield);
  });

  async function spendGlove(playerId: string) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const spent = await spendUtilityGearUseInTransaction(client, playerId, "lumber_glove");
      await client.query("COMMIT");
      return spent;
    } finally {
      client.release();
    }
  }

  /** Kit 1 = axe set; the starter set is worn again with a Lumber Glove, then kit 1 is applied in memory. */
  async function kitOverGlove(playerId: string, gloveUses: number) {
    const { starter, gear } = await twoSets(playerId);
    const saved = equipment.runtimeSnapshot(playerId)!;
    await equipment.saveCombatKit(playerId, 1, saved.inventoryRevision, randomUUID());
    await equipment.equipGearScroll(playerId, 1, randomUUID());
    const gloves = await grantGear(playerId, ["lumber_glove"]);
    const glove = gloves.lumber_glove!;
    await pool.query(
      "UPDATE equipment_instances SET location='equipped', equipped_slot='gloves', uses_remaining=$2 WHERE instance_id=$1",
      [glove, gloveUses]
    );
    const before = await equipment.refreshInventorySlots(playerId);
    const requestId = randomUUID();
    await equipment.stageKitActivation(playerId, { requestId, kitIndex: 1, expectedInventoryRevision: before.inventoryRevision });
    equipment.markActivationApplied(playerId, requestId, 1);
    expect(equipment.runtimeSnapshot(playerId)!.active.melee?.instanceId).toBe(gear.training_axe);
    // The worn glove stays on through the kit activation.
    expect(equipment.runtimeSnapshot(playerId)!.active.gloves?.instanceId).toBe(glove);
    return { starter, gear, glove };
  }

  it("keeps an applied kit activation through a glove use", async () => {
    const playerId = await player(true);
    const { gear, glove } = await kitOverGlove(playerId, 5);
    expect(await spendGlove(playerId)).toMatchObject({ remaining: 4 });
    const synced = await equipment.syncUtilityGear(playerId);
    expect(synced.active.melee?.instanceId).toBe(gear.training_axe);
    expect(synced.active.gloves).toMatchObject({ instanceId: glove, usesRemaining: 4 });
    await equipment.flushDirtyCheckpoints();
    const after = await worn(playerId);
    expect(after.melee).toBe(gear.training_axe);
    expect(after.chest).toBe(gear.chain_armor);
    expect(after.gloves).toBe(glove);
  });

  it("keeps an applied kit activation when the glove's last use destroys it", async () => {
    const playerId = await player(true);
    const { gear, glove } = await kitOverGlove(playerId, 1);
    expect(await spendGlove(playerId)).toMatchObject({ destroyed: true, replacementInstanceId: null });
    const synced = await equipment.syncUtilityGear(playerId);
    expect(synced.active.melee?.instanceId).toBe(gear.training_axe);
    expect(synced.active.gloves).toBeNull();
    expect(synced.instances.some((instance) => instance.instanceId === glove)).toBe(false);
    await equipment.flushDirtyCheckpoints();
    const after = await worn(playerId);
    expect(after.melee).toBe(gear.training_axe);
    expect(after.gloves).toBeUndefined();
  });

  it("saves an unsaved kit activation with the same items when the glove's last use is replaced", async () => {
    const playerId = await player(true);
    await twoSets(playerId);
    // Kit 1 holds exactly what is worn, so activating it changes only the active kit index.
    await equipment.saveCombatKit(playerId, 1, equipment.runtimeSnapshot(playerId)!.inventoryRevision, randomUUID());
    const gloves = await grantGear(playerId, ["lumber_glove"]);
    const spare = await grantGear(playerId, ["lumber_glove"]);
    await pool.query(
      "UPDATE equipment_instances SET location='equipped', equipped_slot='gloves', uses_remaining=1 WHERE instance_id=$1",
      [gloves.lumber_glove]
    );
    const snapshot = await equipment.refreshInventorySlots(playerId);
    const requestId = randomUUID();
    await equipment.stageKitActivation(playerId, { requestId, kitIndex: 1, expectedInventoryRevision: snapshot.inventoryRevision });
    equipment.markActivationApplied(playerId, requestId, 1);
    expect(await spendGlove(playerId)).toMatchObject({ destroyed: true, replacementInstanceId: spare.lumber_glove });

    const synced = await equipment.syncUtilityGear(playerId);
    expect(synced.activeKitIndex).toBe(1);
    expect(synced.active.gloves?.instanceId).toBe(spare.lumber_glove);
    await equipment.flushDirtyCheckpoints();
    const state = await pool.query<{ active_kit_index: number | null }>(
      "SELECT active_kit_index FROM player_equipment_state WHERE player_id=$1", [playerId]
    );
    expect(state.rows[0]!.active_kit_index).toBe(1);
    expect((await worn(playerId)).gloves).toBe(spare.lumber_glove);
  });

  it("ends a burst of 10 swap requests on the latest set", async () => {
    const playerId = await player(true);
    const { gear } = await twoSets(playerId);
    await equipment.equipGearScroll(playerId, 1, randomUUID());
    const positions = [2, 1, 2, 1, 2, 1, 2, 1, 1, 2];
    const outcomes = await Promise.all(positions.map((position) => equipment.equipGearScroll(playerId, position, randomUUID())));
    expect(outcomes.filter((outcome) => outcome.kind === "superseded").length).toBeGreaterThan(0);
    expect(outcomes.at(-1)).toMatchObject({ kind: "applied", position: 2 });
    const after = await worn(playerId);
    expect(after.melee).toBe(gear.training_axe);
    expect(after.chest).toBe(gear.chain_armor);
    expect(equipment.runtimeSnapshot(playerId)!.active.chest?.instanceId).toBe(gear.chain_armor);
  });

  it("never lets an item be both equipped and dropped when a swap races an outgoing drop", async () => {
    for (let round = 0; round < 5; round += 1) {
      const playerId = await player(true);
      const { gear } = await twoSets(playerId);
      await equipment.equipGearScroll(playerId, 1, randomUUID());
      // The lock-then-require-inventory contract the drop, market and gift paths use.
      const trade = inTransaction(async (client) => {
        const row = await client.query<{ location: string }>(
          "SELECT location FROM equipment_instances WHERE instance_id=$1 FOR UPDATE", [gear.training_axe]
        );
        if (row.rows[0]?.location !== "inventory") return;
        await client.query("UPDATE equipment_instances SET location='world_drop' WHERE instance_id=$1", [gear.training_axe]);
      });
      const swap = equipment.equipGearScroll(playerId, 2, randomUUID());
      await Promise.all([trade, swap]);
      const axe = await pool.query<{ location: string }>("SELECT location FROM equipment_instances WHERE instance_id=$1", [gear.training_axe]);
      const location = axe.rows[0]!.location;
      expect(["equipped", "world_drop"]).toContain(location);
      const runtimeMelee = equipment.runtimeSnapshot(playerId)!.active.melee?.instanceId ?? null;
      if (location === "world_drop") expect(runtimeMelee).not.toBe(gear.training_axe);
      else expect(runtimeMelee).toBe(gear.training_axe);
    }
  });

  it("forgets a given-away scroll's memory, so a scroll received later arrives empty", async () => {
    const playerId = await player(true);
    const friend = await player(false);
    const { gear } = await twoSets(playerId);
    const moveScroll = async (from: string, to: string, key: string) => {
      await inTransaction(async (client) => {
        await inventory.debitItemsForOperationInTransaction(client, {
          operationKey: `${key}:out`, playerId: from, source: "test", sourceEntityType: "test", sourceEntityId: to,
          debits: [{ itemId: "loadout_scroll", variant: null, quantity: 1 }]
        });
        await inventory.grantItemsForOperationInTransaction(client, {
          operationKey: `${key}:in`, playerId: to, source: "test", sourceEntityType: "test", sourceEntityId: from,
          grants: [{ itemId: "loadout_scroll", variant: null, quantity: 1 }]
        });
      });
    };
    const positions = async () => (await pool.query<{ scroll_position: number }>(
      "SELECT DISTINCT scroll_position FROM player_gear_scroll_memory WHERE player_id=$1 ORDER BY 1", [playerId]
    )).rows.map((row) => row.scroll_position);

    // Leaving and coming back inside one transaction (a move) keeps the memory.
    await moveScroll(playerId, playerId, `scroll-move:${playerId}`);
    expect(await positions()).toEqual([1, 2]);

    await moveScroll(playerId, friend, `scroll-gift:${playerId}`);
    expect(await positions()).toEqual([1]);
    await moveScroll(friend, playerId, `scroll-return:${playerId}`);
    const view = await equipment.gearScrolls(playerId);
    expect(view.count).toBe(2);
    expect(view.scrolls[1]!.items).toEqual([]);
    expect(view.scrolls[0]!.items.map((item) => item.instanceId)).not.toContain(gear.chain_armor);
  });

  it("keeps scroll memory across disconnect and reconnect", async () => {
    const playerId = await player(true);
    const { gear } = await twoSets(playerId);
    await equipment.flushAndRelease(playerId);
    await equipment.connectRuntime(playerId);
    const view = await equipment.gearScrolls(playerId);
    expect(view.count).toBe(2);
    expect(view.scrolls[1]!.items.map((item) => item.instanceId)).toContain(gear.chain_armor);
    await equipment.equipGearScroll(playerId, 1, randomUUID());
    await equipment.flushAndRelease(playerId);
    await equipment.connectRuntime(playerId);
    expect(await equipment.equipGearScroll(playerId, 2, randomUUID())).toMatchObject({ kind: "applied", changed: true, skipped: 0 });
    expect((await worn(playerId)).chest).toBe(gear.chain_armor);
  });
});

function safeDisposableDatabaseUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = new URL(value);
  if (parsed.hostname !== "127.0.0.1" || parsed.port === "35432" || !parsed.pathname.slice(1).startsWith("ash_atlas_stability")) {
    throw new Error("TEST_DATABASE_URL must target a local ash_atlas_stability database outside the retained port");
  }
  return parsed.toString();
}
