import { randomUUID } from "node:crypto";

import { levelForTotalXp, totalXpForLevel } from "@ash-atlas/shared";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runMigrations } from "../db/migrate.js";
import { BackpackService } from "./backpacks.js";
import { applyDeathBackpackDrop } from "./deathBackpackDrop.js";
import { DroppedItemService, DROPPED_ITEM_TTL_MS } from "./droppedItems.js";
import { InventoryService } from "./inventory.js";

const databaseUrl = process.env.DEATH_DROP_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const POSITION = { lat: 35, lon: -106 } as const;
const REGION = "NM";
const overworld = { space: "overworld", lat: POSITION.lat, lon: POSITION.lon, regionCode: REGION };

describeDatabase("death backpack drop PostgreSQL integration", () => {
  let pool: pg.Pool;
  let inventory: InventoryService;
  let drops: DroppedItemService;
  let backpacks: BackpackService;

  beforeAll(async () => {
    const name = new URL(databaseUrl!).pathname.slice(1);
    if (!name.startsWith("ash_atlas_stability")) {
      throw new Error("DEATH_DROP_TEST_DATABASE_URL must target an ash_atlas_stability* database");
    }
    await runMigrations(databaseUrl!);
    pool = new pg.Pool({ connectionString: databaseUrl!, max: 8 });
    inventory = new InventoryService(pool);
    drops = new DroppedItemService(pool, inventory);
    backpacks = new BackpackService(pool, { inventory });
  }, 180_000);

  beforeEach(async () => {
    await pool.query(`TRUNCATE world_backpack_drops, backpack_drop_operations, player_death_backpack_drops,
      world_item_drops, world_equipment_drops, players CASCADE`);
  });

  afterAll(async () => {
    await pool?.end();
  });

  // A fixed random source makes the random overflow order reproducible.
  const kill = (
    victim: string,
    death: string,
    metadata: Record<string, unknown> = { deathDrop: overworld },
    random: () => number = () => 0.999
  ) =>
    applyDeathBackpackDrop(pool, inventory, {
      deathOperationKey: `player-death:${death}`,
      victimPlayerId: victim,
      metadata,
      random
    });

  it("drops the lowest pack (+0 before +1 and +2) and hides it from the owner's snapshot", async () => {
    await createPlayer("victim", 10);
    const plus2 = await addBackpack("victim", 2, "equipped", 0);
    const plus0 = await addBackpack("victim", 0, "inventory", null);
    const plus1 = await addBackpack("victim", 1, "equipped", 1);
    const result = await kill("victim", "tiers", { deathDrop: overworld, killerPlayerId: "someone" });
    expect(result.summary).toEqual({
      outcome: "dropped",
      lines: [{ kind: "backpack", itemId: "starter_backpack", name: "Backpack +0", quantity: 1 }]
    });
    expect(await location(plus0)).toBe("world_drop");
    expect(await location(plus1)).toBe("equipped");
    expect(await location(plus2)).toBe("equipped");
    const snapshot = await backpacks.getSnapshot("victim");
    expect(snapshot.instances.map((instance) => instance.instanceId).sort()).toEqual([plus1, plus2].sort());
    const listed = await drops.listActiveInGameplayCircle(POSITION, 50);
    expect(listed.map((drop) => drop.backpackInstanceId)).toEqual([plus0]);
  });

  it("drops a single pack on a PvE death", async () => {
    await createPlayer("victim", 10);
    const only = await addBackpack("victim", 3, "equipped", 2);
    const result = await kill("victim", "single");
    expect(result.summary.lines.map((line) => line.name)).toEqual(["Backpack +3"]);
    expect(await location(only)).toBe("world_drop");
  });

  it.each([
    // 0.999 keeps the stable order (iron bars, wood): 8 iron bars cover the 4 kg.
    { death: "overflow-keep", value: 0.999, expected: { iron_bar: 8, wood: 0 } },
    // 0 swaps wood to the front: all 40 wood cover the 4 kg exactly.
    { death: "overflow-swap", value: 0, expected: { iron_bar: 0, wood: 40 } }
  ])("drops random overflow ($death), only the units needed, and puts exactly that on the ground", async ({ death, value, expected }) => {
    const random = () => value;
    {
      await createPlayer("victim", 10, 30_000);
      await addBackpack("victim", 0, "equipped", 0); // +5 kg
      await addBackpack("victim", 1, "equipped", 1); // +10 kg -> 45 kg max
      await grant("victim", "iron_bar", 80); // 40 kg
      await grant("victim", "wood", 40); // 4 kg -> 44 kg carried, 40 kg max after the +0 leaves
      const result = await kill("victim", death, { deathDrop: overworld }, random);
      expect(result.summary.lines[0]).toEqual({ kind: "backpack", itemId: "starter_backpack", name: "Backpack +0", quantity: 1 });
      expect(await quantity("victim", "iron_bar")).toBe(80 - expected.iron_bar);
      expect(await quantity("victim", "wood")).toBe(40 - expected.wood);
      const weight = await pool.query<{ fits: boolean }>(
        "SELECT player_inventory_weight_grams($1) <= player_inventory_maximum_grams($1) AS fits", ["victim"]
      );
      expect(weight.rows[0]!.fits).toBe(true);
      const listed = await drops.listActiveInGameplayCircle(POSITION, 50);
      const onGround = Object.fromEntries(listed.filter((drop) => !drop.backpackInstanceId).map((drop) => [drop.itemId, drop.quantity]));
      const left = Object.fromEntries(Object.entries(expected).filter(([, amount]) => amount > 0));
      expect(onGround).toEqual(left);
      expect(Object.fromEntries(result.summary.lines.slice(1).map((line) => [line.itemId, line.quantity]))).toEqual(left);
      expect(new Set(listed.map((drop) => drop.pileId)).size).toBe(1);
    }
  });

  it("drops whole pieces of gear in the shuffled order when only gear can help", async () => {
    await createPlayer("victim", 10, 2_000);
    await addBackpack("victim", 0, "equipped", 0); // 7 kg max
    const bows = [randomUUID(), randomUUID(), randomUUID(), randomUUID()].sort();
    for (const id of bows) await addEquipment("victim", id); // 4 x 1.5 kg = 6 kg
    const result = await kill("victim", "gear");
    // 2 kg max after the pack: 4 kg over. 0.999 never swaps, so the three lowest ids (4.5 kg) drop.
    expect(result.summary.lines.filter((line) => line.kind === "equipment")).toHaveLength(3);
    const remaining = await pool.query<{ instance_id: string; location: string }>(
      "SELECT instance_id::text,location FROM equipment_instances WHERE instance_id=ANY($1::uuid[]) ORDER BY instance_id",
      [bows]
    );
    expect(remaining.rows.map((row) => row.location)).toEqual(["world_drop", "world_drop", "world_drop", "inventory"]);
  });

  it("lays the pile out backpack first, then the overflow in the order it was chosen", async () => {
    await createPlayer("victim", 10, 2_000);
    await addBackpack("victim", 0, "equipped", 0); // 7 kg max
    const [bowA, bowB] = [randomUUID(), randomUUID()].sort();
    await addEquipment("victim", bowA!);
    await addEquipment("victim", bowB!); // 3 kg
    await grant("victim", "iron_bar", 8); // 4 kg -> 7 kg carried, 2 kg max once the pack leaves
    // Stable order is bow a, bow b, iron bars; a random of 0 shuffles it to bow b, iron bars, bow a.
    // Bow b (1.5 kg) plus 7 iron bars (3.5 kg) cover the 5 kg, so bow a stays.
    const result = await kill("victim", "pile-order", { deathDrop: overworld }, () => 0);
    expect(result.summary.lines.map((line) => [line.kind, line.quantity])).toEqual([
      ["backpack", 1], ["equipment", 1], ["item", 7]
    ]);
    const listed = await drops.listActiveInGameplayCircle(POSITION, 50);
    expect(new Set(listed.map((drop) => drop.pileId)).size).toBe(1);
    const pile = [...listed].sort((left, right) => (left.pileOrder ?? 0) - (right.pileOrder ?? 0));
    expect(pile.map((drop) => drop.backpackInstanceId ? "backpack" : drop.equipmentInstanceId ?? `${drop.itemId} x${drop.quantity}`))
      .toEqual(["backpack", bowB, "iron_bar x7"]);
    expect(new Set(pile.map((drop) => drop.pileOrder)).size).toBe(3);
  });

  it("protects level 3 and drops at level 4", async () => {
    await createPlayer("novice", 3);
    await createPlayer("adept", 4);
    const novicePack = await addBackpack("novice", 0, "equipped", 0);
    const adeptPack = await addBackpack("adept", 0, "equipped", 0);
    expect((await kill("novice", "novice")).summary).toEqual({ outcome: "protected", lines: [] });
    expect((await kill("adept", "adept")).summary.outcome).toBe("dropped");
    expect(await location(novicePack)).toBe("equipped");
    expect(await location(adeptPack)).toBe("world_drop");
  });

  it("drops nothing for dungeon deaths, unknown context, or without a pack", async () => {
    await createPlayer("delver", 10);
    await createPlayer("packless", 10);
    const pack = await addBackpack("delver", 0, "equipped", 0);
    expect((await kill("delver", "dungeon", { deathDrop: { space: "dungeon" } })).summary.outcome).toBe("dungeon");
    expect((await kill("delver", "recovered", { recoveredFromCombatProfile: true })).summary.outcome).toBe("unknown_context");
    expect((await kill("packless", "packless")).summary.outcome).toBe("no_backpack");
    expect(await location(pack)).toBe("equipped");
  });

  it("replays the same death without moving anything twice", async () => {
    await createPlayer("victim", 10, 30_000);
    await addBackpack("victim", 0, "equipped", 0);
    await addBackpack("victim", 1, "equipped", 1);
    await grant("victim", "iron_bar", 80);
    await grant("victim", "wood", 40);
    const [first, second] = await Promise.all([kill("victim", "replay"), kill("victim", "replay")]);
    const third = await kill("victim", "replay");
    expect([first.applied, second.applied].sort()).toEqual([false, true]);
    expect(third.applied).toBe(false);
    expect(third.summary).toEqual(first.summary);
    expect(await quantity("victim", "iron_bar")).toBe(72);
    const counts = await pool.query<{ backpacks: string; items: string }>(
      `SELECT (SELECT count(*) FROM world_backpack_drops)::text AS backpacks,
              (SELECT COALESCE(sum(original_quantity),0) FROM world_item_drops)::text AS items`
    );
    expect(counts.rows[0]).toEqual({ backpacks: "1", items: "8" });
  });

  it("lets exactly one of two nearby players pick up the dropped pack", async () => {
    await createPlayer("victim", 10);
    await createPlayer("alice", 10);
    await createPlayer("bob", 10);
    const pack = await addBackpack("victim", 2, "equipped", 0);
    await kill("victim", "race");
    const [drop] = await drops.listActiveInGameplayCircle(POSITION, 50);
    const actor = (playerId: string) => ({ playerId, regionCode: REGION, position: { ...POSITION } });
    const outcomes = await Promise.allSettled([
      drops.pickupDroppedBackpack(actor("alice"), "pick-a", drop!.dropId),
      drops.pickupDroppedBackpack(actor("bob"), "pick-b", drop!.dropId)
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    const owner = await pool.query<{ owner_player_id: string; location: string }>(
      "SELECT owner_player_id,location FROM player_backpack_instances WHERE instance_id=$1", [pack]
    );
    expect(["alice", "bob"]).toContain(owner.rows[0]!.owner_player_id);
    expect(owner.rows[0]!.location).toBe("inventory");
    expect(await drops.listActiveInGameplayCircle(POSITION, 50)).toEqual([]);
  });

  it("despawns the dropped pack and items through expireDue", async () => {
    await createPlayer("victim", 10, 30_000);
    const pack = await addBackpack("victim", 0, "equipped", 0);
    await addBackpack("victim", 1, "equipped", 1);
    await grant("victim", "iron_bar", 80);
    await grant("victim", "wood", 40);
    await kill("victim", "despawn");
    expect(await drops.expireDue(new Date(Date.now() + DROPPED_ITEM_TTL_MS - 60_000))).toBe(0);
    expect(await drops.expireDue(new Date(Date.now() + DROPPED_ITEM_TTL_MS + 60_000))).toBe(2);
    expect(await location(pack)).toBe("destroyed");
    const status = await pool.query<{ status: string }>("SELECT status FROM world_backpack_drops");
    expect(status.rows).toEqual([{ status: "expired" }]);
  });

  async function createPlayer(id: string, level: number, baseCapacityGrams?: number): Promise<void> {
    const accountId = randomUUID();
    await pool.query("INSERT INTO accounts (id,status,trust_tier) VALUES ($1,'active','standard')", [accountId]);
    await pool.query(
      `INSERT INTO players (
         id, account_id, username, username_normalized, display_color, region_code, lat, lon,
         anchor_lat, anchor_lon, move_leash_radius_m, online, geom
       ) VALUES ($1,$2,$1,$1,'#38bdf8',$3,35,-106,35,-106,900,true,ST_SetSRID(ST_MakePoint(-106,35),4326))`,
      [id, accountId, REGION]
    );
    const totalXp = totalXpForLevel(level);
    await pool.query(
      `INSERT INTO player_progression_profiles (player_id,total_xp,level) VALUES ($1,$2,$3)
       ON CONFLICT (player_id) DO UPDATE SET total_xp=EXCLUDED.total_xp,level=EXCLUDED.level`,
      [id, totalXp, levelForTotalXp(totalXp)]
    );
    if (baseCapacityGrams !== undefined) {
      await pool.query(
        `INSERT INTO player_inventory_capacities (player_id,base_capacity_grams) VALUES ($1,$2)
         ON CONFLICT (player_id) DO UPDATE SET base_capacity_grams=EXCLUDED.base_capacity_grams`,
        [id, baseCapacityGrams]
      );
    }
  }

  async function addBackpack(playerId: string, level: number, where: "equipped" | "inventory", slot: number | null): Promise<string> {
    const instanceId = randomUUID();
    const operation = `death-test-pack:${instanceId}`;
    const account = await pool.query<{ account_id: string }>("SELECT account_id FROM players WHERE id=$1", [playerId]);
    await pool.query(
      `WITH operation AS (
         INSERT INTO backpack_operations(operation_key,player_id,account_id,request_id,action,request_hash)
         VALUES($1,$2,$3,$1,'create',$4) RETURNING operation_key
       ) INSERT INTO player_backpack_instances(
           instance_id,owner_player_id,definition_id,location,equipped_slot,upgrade_level,created_by_operation_key
         ) SELECT $5,$2,'starter_backpack',$6,$7,$8,operation_key FROM operation`,
      [operation, playerId, account.rows[0]!.account_id, "0".repeat(64), instanceId, where, slot, level]
    );
    return instanceId;
  }

  async function addEquipment(playerId: string, instanceId: string): Promise<void> {
    const operation = `death-test-gear:${instanceId}`;
    await pool.query(
      "INSERT INTO equipment_operations(operation_key,player_id,action,completed_at) VALUES($1,$2,'starter_loadout',now())",
      [operation, playerId]
    );
    await pool.query(
      `INSERT INTO equipment_instances(instance_id,definition_id,owner_player_id,location,created_by_operation_key)
       VALUES($1,'starter_bow',$2,'inventory',$3)`,
      [instanceId, playerId, operation]
    );
  }

  async function grant(playerId: string, itemId: "iron_bar" | "wood", amount: number): Promise<void> {
    await inventory.grantItemsForOperation({
      operationKey: `death-test:${playerId}:${randomUUID()}`,
      playerId,
      source: "death_drop_test",
      sourceEntityType: "death_drop_test",
      sourceEntityId: playerId,
      grants: [{ itemId, variant: "default", quantity: amount }]
    });
  }

  async function quantity(playerId: string, itemId: string): Promise<number> {
    const result = await pool.query<{ quantity: string }>(
      "SELECT COALESCE(sum(quantity),0)::text AS quantity FROM player_inventory WHERE player_id=$1 AND resource_type=$2",
      [playerId, itemId]
    );
    return Number(result.rows[0]!.quantity);
  }

  async function location(instanceId: string): Promise<string> {
    const result = await pool.query<{ location: string }>(
      "SELECT location FROM player_backpack_instances WHERE instance_id=$1", [instanceId]
    );
    return result.rows[0]!.location;
  }
});
