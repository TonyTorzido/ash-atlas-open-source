import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RING_LOW_ELIGIBLE_BONUS_IDS, type ResourceType } from "@ash-atlas/shared";

import { DisposableTestPool } from "./disposableTestPool.js";
import { runMigrations } from "./migrate.js";
import { EquipmentService } from "../game/equipment.js";
import { InventoryService } from "../game/inventory.js";
import { DroppedItemService, dropEquipmentToGroundInTransaction } from "../game/droppedItems.js";

const TARGET_MIGRATION = "1070_random_rings.sql";
const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;

describeDatabase("random rings migration and ring operations", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const databaseName = `ash_atlas_stability_random_rings_${suffix}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  const sourceMigrations = path.resolve(process.cwd(), "../../db/migrations");
  const playerId = `rings-migration-${suffix}`;
  const operationKey = `rings-migration:${suffix}`;
  const chopping = randomUUID();
  const attack = randomUUID();
  const training = randomUUID();
  let databaseUrl = "";
  let migrationsDirectory = "";
  let pool: DisposableTestPool;

  beforeAll(async () => {
    const parsed = assertDisposableAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    migrationsDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-random-rings-"));
    for (const name of (await readdir(sourceMigrations))
      .filter((entry) => entry.endsWith(".sql") && entry < TARGET_MIGRATION)
      .sort()) {
      await copyFile(path.join(sourceMigrations, name), path.join(migrationsDirectory, name));
    }
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await runMigrations(databaseUrl, { migrationsDirectory });
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 4 });
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end();
    if (migrationsDirectory) await rm(migrationsDirectory, { recursive: true, force: true });
  });

  it("converts every stock ring into a Plain ring once, then reruns empty", async () => {
    await pool.query(
      `INSERT INTO players (
         id,username,region_code,lat,lon,anchor_lat,anchor_lon,
         move_leash_radius_m,online,geom
       ) VALUES ($1,'rings-migration','NM',35,-106,35,-106,900,false,
         ST_SetSRID(ST_MakePoint(-106,35),4326))`,
      [playerId]
    );
    await pool.query(
      `INSERT INTO equipment_operations (operation_key,player_id,action,completed_at)
       VALUES ($1,$2,'starter_loadout',now())`,
      [operationKey, playerId]
    );
    for (const [instanceId, definitionId, equipped] of [
      [chopping, "chopping_ring", false],
      [attack, "attack_ring", true],
      [training, "training_ring", false]
    ] as const) {
      await pool.query(
        `INSERT INTO equipment_instances (
           instance_id,definition_id,owner_player_id,location,equipped_slot,
           item_level,balance_version,created_by_operation_key
         ) VALUES ($1,$2,$3,$4,$5,0,2,$6)`,
        [instanceId, definitionId, playerId, equipped ? "equipped" : "inventory", equipped ? "ring" : null, operationKey]
      );
    }

    await copyFile(path.join(sourceMigrations, TARGET_MIGRATION), path.join(migrationsDirectory, TARGET_MIGRATION));
    await expect(runMigrations(databaseUrl, { migrationsDirectory })).resolves.toEqual([TARGET_MIGRATION]);

    const converted = await pool.query<{
      instance_id: string; definition_id: string; location: string; equipped_slot: string | null;
      ring_bonuses: Array<{ id: string; family?: string }>; ring_rough: boolean; metadata: { convertedFromRing?: string };
    }>(
      `SELECT instance_id::text,definition_id,location,equipped_slot,ring_bonuses,ring_rough,metadata
       FROM equipment_instances WHERE owner_player_id=$1 ORDER BY instance_id`,
      [playerId]
    );
    expect(converted.rows).toHaveLength(3);
    for (const row of converted.rows) {
      expect(row.definition_id).toBe("ring_plain");
      expect(row.ring_rough).toBe(false);
      expect(row.ring_bonuses).toHaveLength(1);
      expect(RING_LOW_ELIGIBLE_BONUS_IDS).toContain(row.ring_bonuses[0]!.id);
    }
    expect(converted.rows.find((row) => row.instance_id === attack)).toMatchObject({
      location: "equipped", equipped_slot: "ring", metadata: { convertedFromRing: "attack_ring" }
    });
    await expect(runMigrations(databaseUrl, { migrationsDirectory })).resolves.toEqual([]);
    await expect(pool.query(
      "SELECT count(*)::int AS count FROM equipment_instances WHERE definition_id IN ('training_ring','chopping_ring','mining_ring','attack_ring')"
    )).resolves.toMatchObject({ rows: [{ count: 0 }] });
  }, 180_000);

  it("keeps Rough rings bound, polishes and dumps once per request", async () => {
    const inventory = new InventoryService(pool);
    const equipment = new EquipmentService(pool, { inventory });
    const grant = async (key: string, definitionId: "ring_fine", bonuses: Array<{ id: string }>) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await equipment.grantPackageInstancesInTransaction(client, {
          operationKey: key, playerId, source: "rings_test",
          grants: [{ definitionId, quantity: 1, ringBonuses: bonuses }]
        });
        await client.query("COMMIT");
        return result;
      } finally {
        client.release();
      }
    };
    const granted = await grant(`ring-test-grant:${suffix}`, "ring_fine", [{ id: "max_hp" }, { id: "land_speed" }]);
    const fair = granted.equipment.instances.find((item) => item.definitionId === "ring_fine")!;
    expect(fair.ring).toEqual({ tier: "fine", rough: true, bonuses: [] });

    // Denied: a Rough ring cannot be worn, and the database refuses to wear it.
    await expect(equipment.equip(playerId, fair.instanceId, "ring_2", `equip-rough-${suffix}`))
      .rejects.toMatchObject({ code: "EQUIPMENT_RING_ROUGH" });
    await expect(pool.query(
      "UPDATE equipment_instances SET location='equipped', equipped_slot='ring_2', inventory_slot_index=NULL WHERE instance_id=$1",
      [fair.instanceId]
    )).rejects.toMatchObject({ constraint: "equipment_instances_ring_rough_check" });
    await expect(equipment.polishRing(playerId, fair.instanceId, `polish-broke-${suffix}`))
      .rejects.toMatchObject({ code: "EQUIPMENT_RING_OIL_REQUIRED" });

    const oil = await pool.connect();
    try {
      await oil.query("BEGIN");
      await inventory.grantItemsForOperationInTransaction(oil, {
        operationKey: `ring-test-oil:${suffix}`, playerId, source: "rings_test",
        sourceEntityType: "test", sourceEntityId: suffix, metadata: {},
        grants: [{ itemId: "refined_oil" as ResourceType, variant: null, quantity: 15 }]
      });
      await oil.query("COMMIT");
    } finally {
      oil.release();
    }
    const polished = await equipment.polishRing(playerId, fair.instanceId, `polish-${suffix}`);
    expect(polished).toMatchObject({ applied: true, oilSpent: 12, tier: "fine" });
    // Replay: same request, no second spend.
    const replay = await equipment.polishRing(playerId, fair.instanceId, `polish-${suffix}`);
    expect(replay).toMatchObject({ applied: false, replayed: true, oilSpent: 10 });
    await expect(pool.query(
      "SELECT COALESCE(sum(quantity),0)::int AS quantity FROM player_inventory WHERE player_id=$1 AND resource_type='refined_oil'",
      [playerId]
    )).resolves.toMatchObject({ rows: [{ quantity: 5 }] });

    // Allowed: the polished ring goes into the second slot; its bonuses reach the combat stats.
    const worn = await equipment.equip(playerId, fair.instanceId, "ring_2", `equip-polished-${suffix}`);
    expect(worn.equipment.active.ring_2?.instanceId).toBe(fair.instanceId);
    expect(worn.equipment.derivedStats.ringBonuses).toMatchObject({ max_hp: 5, land_speed: 1 });
    expect(worn.equipment.derivedStats.maximumHealth).toBeGreaterThanOrEqual(105);

    const minor = worn.equipment.instances.find((item) => item.instanceId === chopping)!;
    const dumped = await equipment.dumpRing(playerId, minor.instanceId, `dump-${suffix}`);
    expect(dumped).toMatchObject({ applied: true, shardsGranted: 5 });
    const dumpReplay = await equipment.dumpRing(playerId, minor.instanceId, `dump-${suffix}`);
    expect(dumpReplay).toMatchObject({ applied: false, replayed: true });
    await expect(equipment.dumpRing(playerId, minor.instanceId, `dump-again-${suffix}`))
      .rejects.toMatchObject({ code: "EQUIPMENT_NOT_CARRIED" });
    await expect(pool.query(
      "SELECT COALESCE(sum(quantity),0)::int AS quantity FROM player_inventory WHERE player_id=$1 AND resource_type='ring_shard'",
      [playerId]
    )).resolves.toMatchObject({ rows: [{ quantity: 5 }] });

    // Full-bag overflow: a Rough ring may land on the loot pile as system loot.
    const overflow = await pool.connect();
    try {
      await overflow.query("BEGIN");
      const key = `combat-ring:overflow-${suffix}`;
      await overflow.query(
        "INSERT INTO equipment_operations (operation_key,player_id,action,completed_at) VALUES ($1,$2,'package_grant',now())",
        [key, playerId]
      );
      const instanceId = await equipment.insertOverflowRingInTransaction(overflow, {
        operationKey: key, playerId, definitionId: "ring_peerless" as never, source: "rings_test"
      });
      const drop = await dropEquipmentToGroundInTransaction(overflow, {
        operationKey: `${key}:ground`, playerId, instanceId, itemId: "ring_peerless" as never,
        placement: { regionCode: "NM", zoneId: "test-zone", pileId: `combat:${suffix}`, pileOrder: 1000,
          position: { lat: 35, lon: -106 }, createdAt: new Date() }
      });
      await overflow.query("COMMIT");
      await expect(pool.query(
        "SELECT location,ring_rough,jsonb_array_length(ring_bonuses) AS bonuses FROM equipment_instances WHERE instance_id=$1",
        [instanceId]
      )).resolves.toMatchObject({ rows: [{ location: "world_drop", ring_rough: true, bonuses: 2 }] });

      // Only the owner sees and takes a Rough ring on the ground.
      const strangerId = `rings-stranger-${suffix}`;
      await pool.query(
        `INSERT INTO players (
           id,username,region_code,lat,lon,anchor_lat,anchor_lon,
           move_leash_radius_m,online,geom
         ) VALUES ($1,'rings-stranger','NM',35,-106,35,-106,900,false,
           ST_SetSRID(ST_MakePoint(-106,35),4326))`,
        [strangerId]
      );
      const drops = new DroppedItemService(pool, inventory);
      const seen = async (viewer: string) => (await drops.listActiveInGameplayCircle(
        { lat: 35, lon: -106 }, 500, [], [], viewer
      )).some((entry) => entry.dropId === drop.dropId);
      await expect(seen(strangerId)).resolves.toBe(false);
      await expect(seen(playerId)).resolves.toBe(true);
      const at = { regionCode: "NM", zoneId: "test-zone", position: { lat: 35, lon: -106 } };
      await expect(drops.pickupDroppedEquipment({ playerId: strangerId, ...at }, `steal-${suffix}`, drop.dropId))
        .rejects.toThrow(/not yours/u);
      await expect(drops.pickupDroppedEquipment({ playerId, ...at }, `take-${suffix}`, drop.dropId))
        .resolves.toMatchObject({ drop: { equipmentInstanceId: instanceId } });
    } finally {
      overflow.release();
    }
  }, 180_000);
});

function assertDisposableAdminUrl(value: string): URL {
  const parsed = new URL(value);
  if (
    !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !/^ash_atlas_stability(?:_[a-z0-9_]+)?$/u.test(parsed.pathname.slice(1))
  ) {
    throw new Error("Random rings migration test requires a local disposable stability database");
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(value)) {
    throw new Error("Unsafe disposable stability database name");
  }
  return `"${value}"`;
}
