import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_PLAYER_APPEARANCE_CATALOG,
  EQUIPMENT_SLOTS,
  projectPlayerAppearance
} from "@ash-atlas/shared";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "../db/disposableTestPool.js";
import { runMigrations } from "../db/migrate.js";
import { ClassService } from "./classes/classService.js";
import { EquipmentService, type EquipmentManorSmithContext } from "./equipment.js";
import { InventoryService } from "./inventory.js";
import { playerEquipmentCombatStateFromSnapshot } from "./combat/combatEngine.js";
import { seedTradeSkillRank } from "./skills/tradeSkillTestSeed.js";
import { WalletService } from "./wallet.js";

const adminUrl =
  process.env.EQUIPMENT_TEST_ADMIN_URL ??
  process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;
const MIGRATION = "0651_equipment_progression_combat_kits.sql";
const UPGRADE_CITY_ID = "95000000-0000-4000-8000-000000000001";
const LEGACY_FACILITY_ID = "95000000-0000-4000-8000-000000000002";

describeDatabase("equipment progression PostgreSQL lifecycle", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const databaseName = `ash_atlas_stability_equipment_${suffix}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  const repoMigrations = fileURLToPath(
    new URL("../../../../db/migrations/", import.meta.url)
  );
  const accountId = randomUUID();
  const playerId = `equipment-${suffix}`;
  const starterIds = {
    sword: randomUUID(),
    bow: randomUUID(),
    staff: randomUUID(),
    tunic: randomUUID()
  };
  const trainingIds = {
    helm: randomUUID(),
    gloves: randomUUID(),
    boots: randomUUID(),
    ring: randomUUID()
  };
  let precedingMigrations = "";
  let databaseUrl = "";
  let pool: pg.Pool;
  let appliedMigrations: string[] = [];

  beforeAll(async () => {
    const parsed = assertDisposableAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    precedingMigrations = await mkdtemp(
      path.join(tmpdir(), "ash-atlas-equipment-migrations-")
    );
    for (const name of (await readdir(repoMigrations))
      .filter((name) => name.endsWith(".sql") && name < MIGRATION)
      .sort()) {
      await copyFile(
        path.join(repoMigrations, name),
        path.join(precedingMigrations, name)
      );
    }
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await runMigrations(databaseUrl, { migrationsDirectory: precedingMigrations });
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 8 });
    await seedPopulatedLegacyPlayer();
    appliedMigrations = await runMigrations(databaseUrl);
    await pool.query(
      `INSERT INTO player_progression_profiles (player_id, level)
       VALUES ($1, 25)
       ON CONFLICT (player_id) DO UPDATE SET level=EXCLUDED.level`,
      [playerId]
    );
    await seedEquipmentAuthorityFixtures();
    await seedUpgradeHouse(playerId);
  }, 90_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end();
    if (precedingMigrations) {
      await rm(precedingMigrations, { recursive: true, force: true });
    }
  });

  it("preserves populated level-0 equipment, normalizes health, seeds six kits, and reruns empty", async () => {
    expect(appliedMigrations).toContain(MIGRATION);
    await expect(pool.query(
      `SELECT definition_id, item_level, equipped_slot
       FROM equipment_instances
       WHERE owner_player_id = $1
       ORDER BY definition_id`,
      [playerId]
    )).resolves.toMatchObject({
      rows: [
        { definition_id: "padded_tunic", item_level: 0, equipped_slot: "chest" },
        { definition_id: "starter_bow", item_level: 0, equipped_slot: null },
        { definition_id: "starter_staff", item_level: 0, equipped_slot: null },
        { definition_id: "starter_sword", item_level: 0, equipped_slot: "melee" }
      ]
    });
    await expect(pool.query(
      `SELECT current_health, max_health, persistence_version::text
       FROM player_combat_profiles
       WHERE player_id = $1`,
      [playerId]
    )).resolves.toMatchObject({
      rows: [{ current_health: 25, max_health: 100, persistence_version: "8" }]
    });
    await expect(pool.query(
      `SELECT count(*)::int AS count
       FROM combat_kits
       WHERE player_id = $1`,
      [playerId]
    )).resolves.toMatchObject({ rows: [{ count: 6 }] });
    await expect(runMigrations(databaseUrl)).resolves.toEqual([]);
  }, 90_000);

  it("applies 0651 to a truly fresh empty database and reruns without work", async () => {
    const freshDatabaseName = `${databaseName}_empty`;
    const parsed = assertDisposableAdminUrl(adminUrl!);
    parsed.pathname = `/${freshDatabaseName}`;
    const freshDatabaseUrl = parsed.toString();
    let freshPool: pg.Pool | undefined;
    await admin.query(`CREATE DATABASE ${quoteIdentifier(freshDatabaseName)}`);
    try {
      const firstRun = await runMigrations(freshDatabaseUrl);
      expect(firstRun).toContain(MIGRATION);
      await expect(runMigrations(freshDatabaseUrl)).resolves.toEqual([]);

      freshPool = new DisposableTestPool({ connectionString: freshDatabaseUrl, max: 2 });
      await expect(freshPool.query(
        `SELECT
           (SELECT count(*)::int FROM players) AS players,
           to_regclass('public.player_equipment_state')::text AS equipment_state,
           to_regclass('public.combat_kits')::text AS combat_kits,
           to_regclass('public.equipment_upgrade_operations')::text AS upgrade_operations,
           (SELECT count(*)::int
            FROM schema_migrations
            WHERE version = $1) AS migration_rows`,
        [MIGRATION]
      )).resolves.toMatchObject({
        rows: [{
          players: 0,
          equipment_state: "player_equipment_state",
          combat_kits: "combat_kits",
          upgrade_operations: "equipment_upgrade_operations",
          migration_rows: 1
        }]
      });
    } finally {
      await freshPool?.end();
      await admin.query(
        `DROP DATABASE IF EXISTS ${quoteIdentifier(freshDatabaseName)} WITH (FORCE)`
      );
    }
  }, 90_000);

  it("rolls back all 0651 schema changes and its ledger row on terminal failure", async () => {
    const rollbackDatabaseName = `${databaseName}_rollback`;
    const parsed = assertDisposableAdminUrl(adminUrl!);
    parsed.pathname = `/${rollbackDatabaseName}`;
    const rollbackDatabaseUrl = parsed.toString();
    const rollbackMigrations = await mkdtemp(
      path.join(tmpdir(), "ash-atlas-equipment-rollback-")
    );
    let rollbackPool: pg.Pool | undefined;

    try {
      for (const name of await readdir(precedingMigrations)) {
        await copyFile(
          path.join(precedingMigrations, name),
          path.join(rollbackMigrations, name)
        );
      }
      const migrationSql = await readFile(path.join(repoMigrations, MIGRATION), "utf8");
      await writeFile(
        path.join(rollbackMigrations, MIGRATION),
        `${migrationSql}\nDO $$ BEGIN RAISE EXCEPTION 'forced 0651 rollback'; END $$;\n`,
        "utf8"
      );

      await admin.query(`CREATE DATABASE ${quoteIdentifier(rollbackDatabaseName)}`);
      await expect(runMigrations(rollbackDatabaseUrl, {
        migrationsDirectory: rollbackMigrations
      })).rejects.toThrow("forced 0651 rollback");

      rollbackPool = new DisposableTestPool({ connectionString: rollbackDatabaseUrl, max: 2 });
      await expect(rollbackPool.query(
        `SELECT
           to_regclass('public.player_equipment_state')::text AS equipment_state,
           to_regclass('public.combat_kits')::text AS combat_kits,
           EXISTS (
             SELECT 1
             FROM information_schema.columns
             WHERE table_schema = 'public'
               AND table_name = 'equipment_instances'
               AND column_name = 'item_level'
           ) AS item_level_exists,
           (SELECT count(*)::int
            FROM schema_migrations
            WHERE version = $1) AS migration_rows`,
        [MIGRATION]
      )).resolves.toMatchObject({
        rows: [{
          equipment_state: null,
          combat_kits: null,
          item_level_exists: false,
          migration_rows: 0
        }]
      });
    } finally {
      await rollbackPool?.end();
      await admin.query(
        `DROP DATABASE IF EXISTS ${quoteIdentifier(rollbackDatabaseName)} WITH (FORCE)`
      );
      await rm(rollbackMigrations, { recursive: true, force: true });
    }
  }, 90_000);

  it("derives Hunter weapon mode from the readied melee or ranged slot", async () => {
    const classes = new ClassService(pool);
    const activeWeaponMode = (
      classes as unknown as {
        activeWeaponMode(
          queryable: pg.Pool,
          currentPlayerId: string,
          classId: "hunter"
        ): Promise<"melee" | "ranged" | null>;
      }
    ).activeWeaponMode.bind(classes);
    await pool.query(
      `UPDATE equipment_instances
       SET location = 'equipped', equipped_slot = 'secondary'
       WHERE instance_id = $1`,
      [starterIds.bow]
    );

    try {
      await pool.query(
        `UPDATE player_equipment_state
         SET readied_weapon_slot = 'melee'
         WHERE player_id = $1`,
        [playerId]
      );
      await expect(activeWeaponMode(pool, playerId, "hunter")).resolves.toBe("melee");

      await pool.query(
        `UPDATE player_equipment_state
         SET readied_weapon_slot = 'secondary'
         WHERE player_id = $1`,
        [playerId]
      );
      await expect(activeWeaponMode(pool, playerId, "hunter")).resolves.toBe("ranged");
    } finally {
      await pool.query(
        `UPDATE equipment_instances
         SET location = 'inventory', equipped_slot = NULL
         WHERE instance_id = $1`,
        [starterIds.bow]
      );
      await pool.query(
        `UPDATE player_equipment_state
         SET readied_weapon_slot = 'melee'
         WHERE player_id = $1`,
        [playerId]
      );
    }
  }, 90_000);

  it("bootstraps Ninja with a persisted, readied Shuriken", async () => {
    const current = await seedCurrentPlayer("ninja-bootstrap", 0n);
    const service = new EquipmentService(pool);

    const initial = await service.ensureStarterLoadout(current.playerId, "ninja");
    expect(initial.equipment).toMatchObject({
      active: { secondary: { definitionId: "starter_shuriken" } },
      readiedWeaponSlot: "secondary",
      weapon: { definitionId: "starter_shuriken" },
      derivedStats: { readiedWeaponCategory: "shuriken" }
    });

    const persisted = await pool.query(
      `SELECT definition_id, location, equipped_slot
       FROM equipment_instances
       WHERE owner_player_id = $1 AND definition_id = 'starter_shuriken'`,
      [current.playerId]
    );
    expect(persisted.rows).toEqual([
      { definition_id: "starter_shuriken", location: "equipped", equipped_slot: "secondary" }
    ]);

    const replay = await service.ensureStarterLoadout(current.playerId, "ninja");
    expect(replay).toMatchObject({ applied: false, replayed: true });
    expect(replay.equipment.active.secondary?.instanceId)
      .toBe(initial.equipment.active.secondary?.instanceId);
  }, 90_000);

  it("applies death wear once, repairs atomically, and crafts Repair Kits idempotently", async () => {
    const current = await seedCurrentPlayer("repair-economy", 0n);
    const inventory = new InventoryService(pool);
    const service = new EquipmentService(pool, { inventory });
    const starterLoadout = await service.ensureStarterLoadout(current.playerId);
    const starterSwordId = starterLoadout.equipment.active.melee!.instanceId;

    const repairItemId = randomUUID();
    const itemOperationKey = `repair-economy-equipment:${current.playerId}`;
    await pool.query(
      `UPDATE equipment_instances
       SET location='inventory', equipped_slot=NULL
       WHERE owner_player_id=$1 AND definition_id='padded_tunic' AND location='equipped'`,
      [current.playerId]
    );
    await pool.query(
      `INSERT INTO equipment_operations (operation_key,player_id,action,completed_at)
       VALUES ($1,$2,'starter_loadout',now())`,
      [itemOperationKey, current.playerId]
    );
    await pool.query(
      `INSERT INTO equipment_instances (
         instance_id,definition_id,owner_player_id,location,equipped_slot,
         inventory_slot_index,item_level,balance_version,enchantment_identity,
         created_by_operation_key,metadata
       ) VALUES ($1,'training_heavy_chest',$2,'equipped','chest',NULL,8,1,
                 'venomsteel:fire',$3, '{"repair-test":true}'::jsonb)`,
      [repairItemId, current.playerId, itemOperationKey]
    );
    await pool.query(
      `UPDATE equipment_instances SET condition=35 WHERE instance_id=$1`,
      [repairItemId]
    );
    await inventory.grantItemsForOperation({
      operationKey: `repair-economy-materials:${current.playerId}`,
      playerId: current.playerId,
      source: "test_fixture",
      grants: [
        { itemId: "repair_kit", variant: "default", quantity: 3 },
        { itemId: "iron_bar", variant: "default", quantity: 2 },
        { itemId: "chitin", variant: "default", quantity: 2 },
        { itemId: "balsam_resin", variant: "default", quantity: 1 },
        { itemId: "merfolk_scale" as never, variant: "default", quantity: 1 },
        { itemId: "dryad_heartwood" as never, variant: "default", quantity: 1 }
      ]
    });

    const wear = await service.applyDeathConditionWear({
      playerId: current.playerId,
      operationKey: `player-death:repair-economy:${current.playerId}:1`
    });
    expect(wear).toMatchObject({ applied: true, replayed: false, changed: true });
    expect(wear.equipment.instances.find((item) => item.instanceId === repairItemId))
      .toMatchObject({ condition: 25, location: "equipped" });
    await expect(service.applyDeathConditionWear({
      playerId: current.playerId,
      operationKey: `player-death:repair-economy:${current.playerId}:1`
    })).resolves.toMatchObject({ applied: false, replayed: true, changed: true });

    await expect(service.repairEquipment(
      current,
      repairItemId,
      25,
      "repair-economy-denied",
      manorSmithAuthority()
    )).rejects.toMatchObject({
      code: "EQUIPMENT_REPAIR_SKILL_REQUIRED",
      message: "Needs Blacksmithing rank 1 to repair gear."
    });
    await seedTradeSkillRank(pool, current.playerId, "blacksmithing", 1);
    const repaired = await service.repairEquipment(
      current,
      repairItemId,
      25,
      "repair-economy-one",
      manorSmithAuthority()
    );
    expect(repaired).toMatchObject({
      applied: true,
      conditionBefore: 25,
      conditionAfter: 50
    });
    expect(repaired.equipment.instances.find((item) => item.instanceId === repairItemId))
      .toMatchObject({
        condition: 50,
        itemLevel: 8,
        enchantmentIdentity: "venomsteel:fire"
      });
    await expect(pool.query(
      `SELECT condition,metadata FROM equipment_instances WHERE instance_id=$1`,
      [repairItemId]
    )).resolves.toMatchObject({
      rows: [{ condition: 50, metadata: { "repair-test": true } }]
    });
    await expect(service.repairEquipment(
      current,
      repairItemId,
      25,
      "repair-economy-one",
      manorSmithAuthority()
    )).resolves.toMatchObject({ applied: false, replayed: true, conditionAfter: 50 });
    expect((await inventory.getInventorySnapshot(current.playerId)).totals).toMatchObject({
      repair_kit: 2,
      iron_bar: 0
    });

    // Blacksmithing rank 1 scales the 10-point death wear to 7, so 7 is the highest condition that still breaks.
    await pool.query(
      `UPDATE equipment_instances SET condition=7 WHERE instance_id=$1`,
      [repairItemId]
    );
    const broken = await service.applyDeathConditionWear({
      playerId: current.playerId,
      operationKey: `player-death:repair-economy:${current.playerId}:2`
    });
    expect(broken.equipment.instances.find((item) => item.instanceId === repairItemId))
      .toMatchObject({ condition: 0, location: "inventory", equippedSlot: null });
    expect(broken.equipment.instances.find((item) => item.instanceId === starterSwordId))
      .toMatchObject({ condition: 100 });

    await inventory.grantItemsForOperation({
      operationKey: `repair-economy-broken-materials:${current.playerId}`,
      playerId: current.playerId,
      source: "test_fixture",
      grants: [{ itemId: "repair_kit", variant: "default", quantity: 1 },
        { itemId: "iron_bar", variant: "default", quantity: 2 }]
    });
    const repairedBroken = await service.repairEquipment(
      current,
      repairItemId,
      0,
      "repair-economy-broken",
      manorSmithAuthority()
    );
    expect(repairedBroken).toMatchObject({ conditionBefore: 0, conditionAfter: 25 });
    await expect(service.equip(
      current.playerId,
      repairItemId,
      "chest",
      "repair-economy-equip-broken"
    )).resolves.toMatchObject({ equipment: { active: { chest: { instanceId: repairItemId } } } });
    await expect(service.repairEquipment(
      current,
      repairItemId,
      25,
      "repair-economy-insufficient",
      manorSmithAuthority()
    )).rejects.toMatchObject({ code: "EQUIPMENT_REPAIR_MATERIALS_REQUIRED" });
    expect((await inventory.getInventorySnapshot(current.playerId)).totals).toMatchObject({
      repair_kit: 2,
      iron_bar: 0,
      // Armor repair never spends the Repair Kit's category inputs.
      chitin: 2,
      balsam_resin: 1,
      merfolk_scale: 1,
      dryad_heartwood: 1
    });

    // Mending Resin: +12 points (+17 with Alchemy), replay-safe, never above the stored 100 maximum.
    await inventory.grantItemsForOperation({
      operationKey: `mend-resin-materials:${current.playerId}`,
      playerId: current.playerId,
      source: "test_fixture",
      grants: [{ itemId: "mending_resin" as never, variant: "default", quantity: 4 }]
    });
    const mended = await service.mendEquipmentWithResin(current, repairItemId, "mend-one");
    expect(mended).toMatchObject({ applied: true, conditionBefore: 25, conditionAfter: 37 });
    await expect(service.mendEquipmentWithResin(current, repairItemId, "mend-one"))
      .resolves.toMatchObject({ applied: false, replayed: true, conditionAfter: 37 });
    expect(((await inventory.getInventorySnapshot(current.playerId)).totals as Record<string, number>).mending_resin).toBe(3);
    await seedTradeSkillRank(pool, current.playerId, "alchemy", 1);
    await expect(service.mendEquipmentWithResin(current, repairItemId, "mend-two"))
      .resolves.toMatchObject({ conditionBefore: 37, conditionAfter: 54 });
    await pool.query(`UPDATE equipment_instances SET condition=95 WHERE instance_id=$1`, [repairItemId]);
    await expect(service.mendEquipmentWithResin(current, repairItemId, "mend-cap"))
      .resolves.toMatchObject({ conditionBefore: 95, conditionAfter: 100 });
    await expect(service.mendEquipmentWithResin(current, repairItemId, "mend-full"))
      .rejects.toMatchObject({ code: "EQUIPMENT_REPAIR_UNAVAILABLE" });
    await pool.query(`UPDATE equipment_instances SET condition=25 WHERE instance_id=$1`, [repairItemId]);

    const crafted = await service.craftRepairKit(current, "repair-economy-kit", manorSmithAuthority());
    expect(crafted).toMatchObject({ applied: true, replayed: false, quantity: 1 });
    await expect(service.craftRepairKit(current, "repair-economy-kit", manorSmithAuthority()))
      .resolves.toMatchObject({ applied: false, replayed: true, quantity: 1 });
    expect((await inventory.getInventorySnapshot(current.playerId)).totals).toMatchObject({
      chitin: 0,
      giving_berry: 0,
      balsam_resin: 0,
      repair_kit: 3,
      // 2 any Scales + 1 woody Plant, lowest grade first: the G2 drops stay.
      merfolk_scale: 1,
      dryad_heartwood: 1
    });
  }, 120_000);

  it("repairs the legacy Ninja bootstrap without duplicating or displacing equipment", async () => {
    const current = await seedCurrentPlayer("ninja-legacy-repair", 0n);
    const service = new EquipmentService(pool);
    await service.getSnapshot(current.playerId);

    const operationKey = `starter-loadout:${current.playerId}:ninja:v1`;
    const shurikenId = randomUUID();
    const swordId = randomUUID();
    const bowId = randomUUID();
    const staffId = randomUUID();
    const tunicId = randomUUID();
    await pool.query(
      `INSERT INTO equipment_operations (
         operation_key, player_id, action, completed_at
       ) VALUES ($1, $2, 'starter_loadout', now())`,
      [operationKey, current.playerId]
    );
    await pool.query(
      `INSERT INTO equipment_instances (
         instance_id, definition_id, owner_player_id, location, equipped_slot,
         inventory_slot_index, created_by_operation_key
       ) VALUES
         ($1, 'starter_shuriken', $6, 'equipped', 'secondary', 0, $7),
         ($2, 'starter_sword', $6, 'equipped', 'melee', 1, $7),
         ($3, 'starter_bow', $6, 'inventory', NULL, 2, $7),
         ($4, 'starter_staff', $6, 'inventory', NULL, 3, $7),
         ($5, 'padded_tunic', $6, 'equipped', 'chest', 4, $7)`,
      [
        shurikenId,
        swordId,
        bowId,
        staffId,
        tunicId,
        current.playerId,
        operationKey
      ]
    );
    await pool.query(
      `UPDATE player_equipment_state
       SET inventory_revision = 9,
           active_revision = 13,
           checkpoint_revision = 13,
           readied_weapon_slot = 'melee',
           active_kit_index = 1
       WHERE player_id = $1`,
      [current.playerId]
    );

    const repaired = await service.ensureStarterLoadout(current.playerId, "ninja");
    expect(repaired).toMatchObject({ applied: true, replayed: false });
    expect(repaired.equipment).toMatchObject({
      active: {
        melee: { instanceId: swordId, definitionId: "starter_sword" },
        secondary: { instanceId: shurikenId, definitionId: "starter_shuriken" }
      },
      readiedWeaponSlot: "secondary",
      weapon: { instanceId: shurikenId, definitionId: "starter_shuriken" },
      derivedStats: { readiedWeaponCategory: "shuriken" },
      activeRevision: 14,
      checkpointRevision: 14,
      inventoryRevision: 9
    });
    expect(projectPlayerAppearance(
      repaired.equipment,
      DEFAULT_PLAYER_APPEARANCE_CATALOG
    )).toMatchObject({
      activeHand: "secondary",
      slots: {
        secondary: { equipmentDefinitionId: "starter_shuriken" }
      }
    });
    expect(playerEquipmentCombatStateFromSnapshot(repaired.equipment)).toMatchObject({
      activeWeaponSlot: "secondary",
      activeWeaponInstanceId: shurikenId,
      weaponCategory: "shuriken",
      switchingToSlot: null,
      switchStartedAtTick: null,
      switchCompletesAtTick: null
    });
    await expect(pool.query(
      `SELECT
         (SELECT count(*)::int
          FROM equipment_instances
          WHERE owner_player_id = $1 AND definition_id = 'starter_shuriken') AS shuriken_count,
         (SELECT instance_id::text
          FROM equipment_instances
          WHERE owner_player_id = $1 AND definition_id = 'starter_shuriken') AS shuriken_id,
         (SELECT location
          FROM equipment_instances
          WHERE owner_player_id = $1 AND definition_id = 'starter_shuriken') AS shuriken_location,
         (SELECT equipped_slot
          FROM equipment_instances
          WHERE owner_player_id = $1 AND definition_id = 'starter_shuriken') AS shuriken_slot,
         (SELECT inventory_revision::int FROM player_equipment_state WHERE player_id = $1) AS inventory_revision,
         (SELECT active_revision::int FROM player_equipment_state WHERE player_id = $1) AS active_revision,
         (SELECT checkpoint_revision::int FROM player_equipment_state WHERE player_id = $1) AS checkpoint_revision,
         (SELECT readied_weapon_slot FROM player_equipment_state WHERE player_id = $1) AS readied_weapon_slot,
         (SELECT active_kit_index FROM player_equipment_state WHERE player_id = $1) AS active_kit_index`,
      [current.playerId]
    )).resolves.toMatchObject({
      rows: [{
        shuriken_count: 1,
        shuriken_id: shurikenId,
        shuriken_location: "equipped",
        shuriken_slot: "secondary",
        inventory_revision: 9,
        active_revision: 14,
        checkpoint_revision: 14,
        readied_weapon_slot: "secondary",
        active_kit_index: 1
      }]
    });

    const replay = await service.ensureStarterLoadout(current.playerId, "ninja");
    expect(replay).toMatchObject({ applied: false, replayed: true });
    expect(replay.equipment.active.secondary?.instanceId).toBe(shurikenId);
    await expect(pool.query(
      `SELECT inventory_revision::int, active_revision::int,
              checkpoint_revision::int, readied_weapon_slot, active_kit_index
       FROM player_equipment_state
       WHERE player_id = $1`,
      [current.playerId]
    )).resolves.toMatchObject({
      rows: [{
        inventory_revision: 9,
        active_revision: 14,
        checkpoint_revision: 14,
        readied_weapon_slot: "secondary",
        active_kit_index: 1
      }]
    });
  }, 90_000);

  it("leaves an explicitly equipped secondary weapon in place during Ninja repair", async () => {
    const current = await seedCurrentPlayer("ninja-secondary-choice", 0n);
    const service = new EquipmentService(pool);
    await service.getSnapshot(current.playerId);

    const operationKey = `starter-loadout:${current.playerId}:ninja:v1`;
    const shurikenId = randomUUID();
    const swordId = randomUUID();
    const bowId = randomUUID();
    const staffId = randomUUID();
    const tunicId = randomUUID();
    await pool.query(
      `INSERT INTO equipment_operations (
         operation_key, player_id, action, completed_at
       ) VALUES ($1, $2, 'starter_loadout', now())`,
      [operationKey, current.playerId]
    );
    await pool.query(
      `INSERT INTO equipment_instances (
         instance_id, definition_id, owner_player_id, location, equipped_slot,
         inventory_slot_index, created_by_operation_key
       ) VALUES
         ($1, 'starter_shuriken', $6, 'inventory', NULL, 0, $7),
         ($2, 'starter_sword', $6, 'equipped', 'melee', 1, $7),
         ($3, 'starter_bow', $6, 'equipped', 'secondary', 2, $7),
         ($4, 'starter_staff', $6, 'inventory', NULL, 3, $7),
         ($5, 'padded_tunic', $6, 'equipped', 'chest', 4, $7)`,
      [
        shurikenId,
        swordId,
        bowId,
        staffId,
        tunicId,
        current.playerId,
        operationKey
      ]
    );
    await pool.query(
      `UPDATE player_equipment_state
       SET inventory_revision = 4,
           active_revision = 7,
           checkpoint_revision = 7,
           readied_weapon_slot = 'melee',
           active_kit_index = 2
       WHERE player_id = $1`,
      [current.playerId]
    );

    const repaired = await service.ensureStarterLoadout(current.playerId, "ninja");
    expect(repaired.equipment).toMatchObject({
      active: {
        secondary: { instanceId: bowId, definitionId: "starter_bow" }
      },
      readiedWeaponSlot: "melee",
      activeRevision: 7,
      checkpointRevision: 7,
      inventoryRevision: 4
    });
    expect(repaired.equipment.instances.find((item) => item.instanceId === shurikenId))
      .toMatchObject({ location: "inventory", equippedSlot: null });
    await expect(pool.query(
      `SELECT inventory_revision::int, active_revision::int,
              checkpoint_revision::int, readied_weapon_slot, active_kit_index,
              (SELECT instance_id::text
               FROM equipment_instances
               WHERE owner_player_id = $1 AND equipped_slot = 'secondary') AS secondary_id,
              (SELECT location
               FROM equipment_instances
               WHERE instance_id = $2) AS shuriken_location
       FROM player_equipment_state
       WHERE player_id = $1`,
      [current.playerId, shurikenId]
    )).resolves.toMatchObject({
      rows: [{
        inventory_revision: 4,
        active_revision: 7,
        checkpoint_revision: 7,
        readied_weapon_slot: "melee",
        active_kit_index: 2,
        secondary_id: bowId,
        shuriken_location: "inventory"
      }]
    });
  }, 90_000);

  it("round-trips complete level-0 kits, paid upgrades, replay, checkpoint, reconnect, and rollback", async () => {
    const service = new EquipmentService(pool);
    const starter = await service.ensureStarterLoadout(playerId);
    expect(starter.equipment.instances).toHaveLength(4);
    expect(starter.equipment.instances.every((item) => item.itemLevel === 0)).toBe(true);
    await expect(pool.query(
      `SELECT count(*)::int AS count
       FROM equipment_instances
       WHERE owner_player_id = $1
         AND definition_id IN (
           'starter_sword', 'starter_bow', 'starter_staff', 'padded_tunic'
         )
         AND location <> 'destroyed'`,
      [playerId]
    )).resolves.toMatchObject({ rows: [{ count: 4 }] });

    await grantCompleteTrainingLoadout();
    let snapshot = await service.connectRuntime(playerId, {
      context: "pvp_open_world",
      characterLevel: 15,
      classId: "warrior",
      classRank: 10
    });
    expect(snapshot.inventoryRevision).toBe(0);
    expect(snapshot.instances.find((item) => item.instanceId === trainingIds.helm))
      .toMatchObject({ itemLevel: 0 });

    const savedOne = await service.saveCombatKit(
      playerId,
      1,
      snapshot.inventoryRevision,
      "save-kit-one"
    );
    expect(savedOne.equipment.kits[0]).toMatchObject({
      valid: true,
      invalidReason: null
    });
    expect(savedOne.equipment.kits[0]!.items.head?.itemLevel).toBe(0);
    expect((await service.saveCombatKit(
      playerId,
      1,
      snapshot.inventoryRevision,
      "save-kit-one"
    )).replayed).toBe(true);

    const renamed = await service.renameCombatKit(
      playerId,
      1,
      "Frontline",
      "rename-kit-one"
    );
    expect(renamed.equipment.kits[0]?.name).toBe("Frontline");
    const savedTwo = await service.saveCombatKit(
      playerId,
      2,
      renamed.equipment.inventoryRevision,
      "save-kit-two"
    );
    await expect(pool.query(
      `SELECT count(*)::int AS count
       FROM combat_kit_items
       WHERE player_id = $1 AND instance_id = $2`,
      [playerId, starterIds.bow]
    )).resolves.toMatchObject({ rows: [{ count: 2 }] });

    const upgraded = await upgradeAtFacility(service,
      { playerId, accountId },
      starterIds.bow,
      0,
      "upgrade-bow-zero-one"
    );
    expect(upgraded).toMatchObject({
      applied: true,
      replayed: false,
      levelBefore: 0,
      levelAfter: 1,
      goldCost: "10",
      goldBalance: "990",
      equipment: {
        activeRevision: savedTwo.equipment.activeRevision + 1,
        checkpointRevision: savedTwo.equipment.checkpointRevision + 1
      }
    });
    expect(upgraded.equipment.kits[0]!.items.secondary).toMatchObject({
      itemLevel: 1
    });
    const upgradeReplay = await upgradeAtFacility(service,
      { playerId, accountId },
      starterIds.bow,
      0,
      "upgrade-bow-zero-one"
    );
    expect(upgradeReplay).toMatchObject({
      applied: false,
      replayed: true,
      levelBefore: 0,
      levelAfter: 1,
      goldBalance: "990"
    });
    await expect(pool.query(
      `SELECT gold_balance::text, version::text,
              (SELECT count(*)::int FROM wallet_events
               WHERE operation_key = $2 AND player_id = $1) AS events
       FROM player_wallets
       WHERE player_id = $1`,
      [playerId, `equipment-upgrade:${accountId}:upgrade-bow-zero-one`]
    )).resolves.toMatchObject({
      rows: [{ gold_balance: "990", version: "2", events: 1 }]
    });

    const inactiveUpgrade = await upgradeAtFacility(service,
      { playerId, accountId },
      starterIds.staff,
      0,
      "upgrade-inventory-staff"
    );
    expect(inactiveUpgrade.equipment).toMatchObject({
      activeRevision: upgraded.equipment.activeRevision,
      checkpointRevision: upgraded.equipment.checkpointRevision
    });

    snapshot = inactiveUpgrade.equipment;
    const staged = await service.stageKitActivation(playerId, {
      requestId: "activate-frontline",
      kitIndex: 1,
      expectedInventoryRevision: snapshot.inventoryRevision
    });
    expect(staged.equipment.kits[0]!.items.secondary?.itemLevel).toBe(1);
    await service.flushAndRelease(playerId);

    await service.connectRuntime(playerId, {
      context: "pvp_open_world",
      characterLevel: 15,
      classId: "warrior",
      classRank: 10
    });
    const restaged = await service.stageKitActivation(playerId, {
      requestId: "activate-frontline",
      kitIndex: 1,
      expectedInventoryRevision: snapshot.inventoryRevision
    });
    expect(restaged).toMatchObject({
      activationTick: null,
      replayed: true,
      activeRevision: 2
    });
    service.markActivationApplied(playerId, restaged.requestId, 51);
    await service.flushDirtyCheckpoints();
    await service.flushAndRelease(playerId);

    const reconnected = await service.connectRuntime(playerId);
    expect(reconnected).toMatchObject({
      activeKitIndex: 1,
      readiedWeaponSlot: "secondary",
      activeRevision: 2,
      checkpointRevision: 2
    });
    expect(reconnected.active.secondary).toMatchObject({
      instanceId: starterIds.bow,
      itemLevel: 1
    });
    const durableActivationReplay = await service.stageKitActivation(playerId, {
      requestId: "activate-frontline",
      kitIndex: 1,
      expectedInventoryRevision: reconnected.inventoryRevision
    });
    expect(durableActivationReplay).toMatchObject({
      activationTick: 51,
      replayed: true,
      activeRevision: 2
    });
    expect(service.pendingActivation(playerId)).toBeNull();
    expect(service.peekDirtyCheckpoints()).toEqual([]);
    await expect(pool.query(
      `SELECT
         (SELECT count(*)::int
          FROM combat_kit_operations
          WHERE player_id = $1
            AND request_id = 'activate-frontline'
            AND action = 'activate'
            AND completed_at IS NOT NULL
            AND (result->>'activationTick')::int = 51) AS completed_operations,
         (SELECT active_revision::int
          FROM player_equipment_state
          WHERE player_id = $1) AS active_revision,
         (SELECT count(*)::int
          FROM equipment_audit_events
          WHERE player_id = $1
            AND event_type = 'active_loadout_checkpointed') AS checkpoints`,
      [playerId]
    )).resolves.toMatchObject({
      rows: [{
        completed_operations: 1,
        active_revision: 2,
        checkpoints: 1
      }]
    });
    await service.flushAndRelease(playerId);
    await pool.query(
      `DELETE FROM combat_kit_items
       WHERE player_id = $1
         AND kit_index = 1
         AND equipment_slot = 'head'`,
      [playerId]
    );
    await pool.query(
      `UPDATE player_equipment_state
       SET active_kit_index = 1,
           readied_weapon_slot = 'secondary'
       WHERE player_id = $1`,
      [playerId]
    );
    const beforeRecovery = await pool.query<{
      kit_items: number;
      equipment_instances: number;
    }>(
      `SELECT
         (SELECT count(*)::int
          FROM combat_kit_items
          WHERE player_id = $1 AND kit_index = 1) AS kit_items,
         (SELECT count(*)::int
          FROM equipment_instances
          WHERE owner_player_id = $1) AS equipment_instances`,
      [playerId]
    );
    const recoveredInvalidActiveKit = await service.connectRuntime(playerId);
    expect(recoveredInvalidActiveKit).toMatchObject({
      activeKitIndex: null,
      readiedWeaponSlot: "secondary"
    });
    expect(recoveredInvalidActiveKit.kits[0]).toMatchObject({
      kitIndex: 1,
      valid: false,
      invalidReason: "incomplete"
    });
    expect(EQUIPMENT_SLOTS.every(
      (slot) => recoveredInvalidActiveKit.active[slot] !== null
    )).toBe(true);
    await expect(pool.query(
      `SELECT
         active_kit_index,
         readied_weapon_slot,
         (SELECT count(*)::int
          FROM combat_kit_items
          WHERE player_id = $1 AND kit_index = 1) AS kit_items,
         (SELECT count(*)::int
          FROM equipment_instances
          WHERE owner_player_id = $1) AS equipment_instances
       FROM player_equipment_state
       WHERE player_id = $1`,
      [playerId]
    )).resolves.toMatchObject({
      rows: [{
        active_kit_index: null,
        readied_weapon_slot: "secondary",
        kit_items: beforeRecovery.rows[0]!.kit_items,
        equipment_instances: beforeRecovery.rows[0]!.equipment_instances
      }]
    });

    await expect(service.clearCombatKit(
      playerId,
      1,
      recoveredInvalidActiveKit.inventoryRevision - 1,
      "stale-clear"
    )).rejects.toEqual(expect.objectContaining({
      code: "EQUIPMENT_STALE_INVENTORY_REVISION"
    }));
    const cleared = await service.clearCombatKit(
      playerId,
      1,
      recoveredInvalidActiveKit.inventoryRevision,
      "clear-kit-one"
    );
    expect(cleared.equipment.kits[0]).toMatchObject({
      valid: false,
      invalidReason: "incomplete"
    });

    const rollbackService = new EquipmentService(pool, {
      afterUpgradeDebit: () => {
        throw new Error("forced post-debit rollback");
      }
    });
    await expect(upgradeAtFacility(rollbackService,
      { playerId, accountId },
      trainingIds.boots,
      0,
      "rollback-after-wallet"
    )).rejects.toThrow("forced post-debit rollback");
    await expect(pool.query(
      `SELECT
         (SELECT item_level FROM equipment_instances WHERE instance_id = $1) AS item_level,
         (SELECT gold_balance::text FROM player_wallets WHERE player_id = $2) AS gold_balance,
         (SELECT count(*)::int FROM equipment_upgrade_operations
          WHERE operation_key = $3) AS operations,
         (SELECT count(*)::int FROM wallet_events
          WHERE operation_key = $3 AND player_id = $2) AS wallet_events`,
      [
        trainingIds.boots,
        playerId,
        `equipment-upgrade:${accountId}:rollback-after-wallet`
      ]
    )).resolves.toMatchObject({
      rows: [{
        item_level: 0,
        gold_balance: "980",
        operations: 0,
        wallet_events: 0
      }]
    });

    const concurrent = await Promise.allSettled([
      upgradeAtFacility(service,
        { playerId, accountId },
        trainingIds.ring,
        0,
        "concurrent-ring-a"
      ),
      upgradeAtFacility(service,
        { playerId, accountId },
        trainingIds.ring,
        0,
        "concurrent-ring-b"
      )
    ]);
    expect(concurrent.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(concurrent.filter((result) => result.status === "rejected")).toHaveLength(1);
    const rejected = concurrent.find((result) => result.status === "rejected");
    expect((rejected as PromiseRejectedResult).reason).toEqual(expect.objectContaining({
      code: "EQUIPMENT_STALE_LEVEL"
    }));
    await expect(pool.query(
      `SELECT
         (SELECT item_level FROM equipment_instances WHERE instance_id = $1) AS item_level,
         (SELECT gold_balance::text FROM player_wallets WHERE player_id = $2) AS gold_balance,
         (SELECT count(*)::int FROM wallet_events
          WHERE player_id = $2 AND reason = 'equipment_upgrade_v1') AS upgrade_events`,
      [trainingIds.ring, playerId]
    )).resolves.toMatchObject({
      rows: [{ item_level: 1, gold_balance: "970", upgrade_events: 3 }]
    });
  }, 90_000);

  it("protects later upgrades, insufficient funds, ownership, destruction, max level, and request intent", async () => {
    const service = new EquipmentService(pool);
    const progression = await seedCurrentPlayer("later", 500n);
    const progressionItems = {
      primary: randomUUID(),
      sameDefinitionCopy: randomUUID(),
      conflict: randomUUID(),
      maximum: randomUUID(),
      destroyed: randomUUID()
    };
    await grantCurrentItems(progression.playerId, "later", [
      {
        instanceId: progressionItems.primary,
        definitionId: "training_ring",
        itemLevel: 0
      },
      {
        instanceId: progressionItems.sameDefinitionCopy,
        definitionId: "training_ring",
        itemLevel: 0
      },
      {
        instanceId: progressionItems.conflict,
        definitionId: "training_heavy_gloves",
        itemLevel: 0
      },
      {
        instanceId: progressionItems.maximum,
        definitionId: "training_heavy_boots",
        itemLevel: 25
      },
      {
        instanceId: progressionItems.destroyed,
        definitionId: "training_light_hood",
        itemLevel: 0,
        location: "destroyed"
      }
    ]);

    await expect(service.upgrade(
      progression,
      progressionItems.primary,
      0,
      "missing-manor-authority"
    )).rejects.toEqual(expect.objectContaining({
      code: "MANOR_SMITH_ACCESS_DENIED"
    }));
    await expect(service.upgrade(
      progression,
      progressionItems.primary,
      0,
      "new-city-authority",
      undefined,
      {
        kind: "legacy_city_replay",
        facilityStructureId: LEGACY_FACILITY_ID
      }
    )).rejects.toEqual(expect.objectContaining({
      code: "MANOR_SMITH_ACCESS_DENIED"
    }));
    await expect(pool.query(
      `SELECT
         (SELECT item_level FROM equipment_instances WHERE instance_id=$1) AS item_level,
         (SELECT gold_balance::text FROM player_wallets WHERE player_id=$2) AS gold_balance,
         (SELECT count(*)::int FROM equipment_upgrade_operations
          WHERE player_id=$2) AS operation_count`,
      [progressionItems.primary, progression.playerId]
    )).resolves.toMatchObject({
      rows: [{ item_level: 0, gold_balance: "500", operation_count: 0 }]
    });

    const firstUpgrade = await upgradeAtFacility(service,
      progression,
      progressionItems.primary,
      0,
      "durable-progression-zero-one"
    );
    expect(firstUpgrade).toMatchObject({
      applied: true,
      replayed: false,
      levelBefore: 0,
      levelAfter: 1,
      goldCost: "10",
      goldBalance: "490"
    });
    const legacyRequestId = "completed-legacy-city-replay";
    const legacyOperationKey =
      `equipment-upgrade:${progression.accountId}:${legacyRequestId}`;
    const storedLegacyResult = {
      ...firstUpgrade,
      instanceId: progressionItems.sameDefinitionCopy,
      applied: true,
      replayed: false
    };
    await pool.query(
      `INSERT INTO equipment_upgrade_operations (
         operation_key,player_id,account_id,request_id,instance_id,expected_level,
         level_before,level_after,gold_cost,balance_version,wallet_operation_key,
         wallet_version_after,result,completed_at,facility_structure_id,
         authority_kind,authority_source
       ) VALUES (
         $1,$2,$3,$4,$5,0,0,1,10,1,$6,1,$7::jsonb,clock_timestamp(),$8,
         'legacy',NULL
       )`,
      [
        legacyOperationKey,
        progression.playerId,
        progression.accountId,
        legacyRequestId,
        progressionItems.sameDefinitionCopy,
        `equipment-test-opening-wallet:${progression.playerId}`,
        JSON.stringify(storedLegacyResult),
        LEGACY_FACILITY_ID
      ]
    );
    const beforeLegacyReplay = await pool.query(
      `SELECT
         (SELECT item_level FROM equipment_instances WHERE instance_id=$1) AS item_level,
         (SELECT gold_balance::text FROM player_wallets WHERE player_id=$2) AS gold_balance,
         (SELECT count(*)::int FROM wallet_events WHERE player_id=$2) AS wallet_events`,
      [progressionItems.sameDefinitionCopy, progression.playerId]
    );
    await expect(service.upgrade(
      progression,
      progressionItems.sameDefinitionCopy,
      0,
      legacyRequestId,
      undefined,
      {
        kind: "legacy_city_replay",
        facilityStructureId: LEGACY_FACILITY_ID
      }
    )).resolves.toMatchObject({
      applied: false,
      replayed: true,
      instanceId: progressionItems.sameDefinitionCopy,
      levelBefore: 0,
      levelAfter: 1,
      goldCost: "10",
      goldBalance: "490"
    });
    await expect(pool.query(
      `SELECT
         (SELECT item_level FROM equipment_instances WHERE instance_id=$1) AS item_level,
         (SELECT gold_balance::text FROM player_wallets WHERE player_id=$2) AS gold_balance,
         (SELECT count(*)::int FROM wallet_events WHERE player_id=$2) AS wallet_events`,
      [progressionItems.sameDefinitionCopy, progression.playerId]
    )).resolves.toEqual(beforeLegacyReplay);
    const laterUpgrade = await upgradeAtFacility(service,
      progression,
      progressionItems.primary,
      1,
      "durable-progression-one-two"
    );
    expect(laterUpgrade).toMatchObject({
      applied: true,
      replayed: false,
      levelBefore: 1,
      levelAfter: 2,
      goldCost: "15",
      goldBalance: "475"
    });
    const laterReplay = await upgradeAtFacility(service,
      progression,
      progressionItems.primary,
      1,
      "durable-progression-one-two"
    );
    expect(laterReplay).toMatchObject({
      applied: false,
      replayed: true,
      levelBefore: 1,
      levelAfter: 2,
      goldCost: "15",
      goldBalance: "475"
    });
    await expect(pool.query(
      "SELECT item_level FROM equipment_instances WHERE instance_id = $1",
      [progressionItems.sameDefinitionCopy]
    )).resolves.toMatchObject({ rows: [{ item_level: 0 }] });
    await expect(pool.query(
      `SELECT
         (SELECT item_level FROM equipment_instances WHERE instance_id = $1) AS item_level,
         (SELECT gold_balance::text FROM player_wallets WHERE player_id = $2) AS gold_balance,
         (SELECT count(*)::int FROM wallet_events
          WHERE player_id = $2 AND reason = 'equipment_upgrade_v1') AS wallet_events,
         (SELECT count(*)::int FROM equipment_upgrade_operations
          WHERE player_id = $2) AS upgrade_operations`,
      [progressionItems.primary, progression.playerId]
    )).resolves.toMatchObject({
      rows: [{
        item_level: 2,
        gold_balance: "475",
        wallet_events: 2,
        upgrade_operations: 3
      }]
    });

    await expect(upgradeAtFacility(service,
      progression,
      progressionItems.conflict,
      0,
      "durable-progression-one-two"
    )).rejects.toEqual(expect.objectContaining({
      code: "EQUIPMENT_IDEMPOTENCY_CONFLICT"
    }));
    await expect(upgradeAtFacility(service,
      progression,
      progressionItems.maximum,
      25,
      "durable-maximum"
    )).rejects.toEqual(expect.objectContaining({
      code: "EQUIPMENT_MAXIMUM_LEVEL"
    }));
    await expect(upgradeAtFacility(service,
      progression,
      progressionItems.destroyed,
      0,
      "durable-destroyed"
    )).rejects.toEqual(expect.objectContaining({
      code: "EQUIPMENT_DESTROYED"
    }));

    const otherOwner = await seedCurrentPlayer("other-owner", 0n);
    const otherOwnerItem = randomUUID();
    await grantCurrentItems(otherOwner.playerId, "other-owner", [{
      instanceId: otherOwnerItem,
      definitionId: "training_ring",
      itemLevel: 0
    }]);
    await expect(upgradeAtFacility(service,
      progression,
      otherOwnerItem,
      0,
      "durable-not-owner"
    )).rejects.toEqual(expect.objectContaining({
      code: "EQUIPMENT_NOT_OWNED"
    }));

    const concurrentLater = await Promise.allSettled([
      upgradeAtFacility(service,
        progression,
        progressionItems.primary,
        2,
        "durable-concurrent-later-a"
      ),
      upgradeAtFacility(service,
        progression,
        progressionItems.primary,
        2,
        "durable-concurrent-later-b"
      )
    ]);
    expect(concurrentLater.filter((result) => result.status === "fulfilled"))
      .toHaveLength(1);
    expect(concurrentLater.filter((result) => result.status === "rejected"))
      .toHaveLength(1);
    const fulfilledLater = concurrentLater.find(
      (result) => result.status === "fulfilled"
    );
    if (!fulfilledLater || fulfilledLater.status !== "fulfilled") {
      throw new Error("Expected exactly one later-level upgrade to commit");
    }
    expect(fulfilledLater.value).toMatchObject({
      levelBefore: 2,
      levelAfter: 3,
      goldCost: "25",
      goldBalance: "450"
    });
    const rejectedLater = concurrentLater.find(
      (result) => result.status === "rejected"
    );
    if (!rejectedLater || rejectedLater.status !== "rejected") {
      throw new Error("Expected exactly one later-level upgrade to lose the level race");
    }
    expect(rejectedLater.reason).toEqual(expect.objectContaining({
      code: "EQUIPMENT_STALE_LEVEL"
    }));

    const insufficient = await seedCurrentPlayer("insufficient", 9n);
    const insufficientItems = {
      zero: randomUUID(),
      later: randomUUID()
    };
    await grantCurrentItems(insufficient.playerId, "insufficient", [
      {
        instanceId: insufficientItems.zero,
        definitionId: "training_light_gloves",
        itemLevel: 0
      },
      {
        instanceId: insufficientItems.later,
        definitionId: "training_light_boots",
        itemLevel: 1
      }
    ]);
    await expect(upgradeAtFacility(service,
      insufficient,
      insufficientItems.zero,
      0,
      "durable-insufficient-zero-one"
    )).rejects.toEqual(expect.objectContaining({
      code: "WALLET_INSUFFICIENT_FUNDS"
    }));
    await expect(upgradeAtFacility(service,
      insufficient,
      insufficientItems.later,
      1,
      "durable-insufficient-one-two"
    )).rejects.toEqual(expect.objectContaining({
      code: "WALLET_INSUFFICIENT_FUNDS"
    }));

    await expect(pool.query(
      `SELECT
         (SELECT item_level FROM equipment_instances WHERE instance_id = $1) AS primary_level,
         (SELECT item_level FROM equipment_instances WHERE instance_id = $2) AS conflict_level,
         (SELECT item_level FROM equipment_instances WHERE instance_id = $3) AS maximum_level,
         (SELECT item_level FROM equipment_instances WHERE instance_id = $4) AS destroyed_level,
         (SELECT item_level FROM equipment_instances WHERE instance_id = $5) AS non_owner_level,
         (SELECT gold_balance::text FROM player_wallets WHERE player_id = $6) AS gold_balance,
         (SELECT count(*)::int FROM wallet_events
          WHERE player_id = $6 AND reason = 'equipment_upgrade_v1') AS wallet_events,
         (SELECT count(*)::int FROM equipment_upgrade_operations
          WHERE player_id = $6) AS upgrade_operations`,
      [
        progressionItems.primary,
        progressionItems.conflict,
        progressionItems.maximum,
        progressionItems.destroyed,
        otherOwnerItem,
        progression.playerId
      ]
    )).resolves.toMatchObject({
      rows: [{
        primary_level: 3,
        conflict_level: 0,
        maximum_level: 25,
        destroyed_level: 0,
        non_owner_level: 0,
        gold_balance: "450",
        wallet_events: 3,
        upgrade_operations: 4
      }]
    });
    await expect(pool.query(
      `SELECT
         (SELECT item_level FROM equipment_instances WHERE instance_id = $1) AS zero_level,
         (SELECT item_level FROM equipment_instances WHERE instance_id = $2) AS later_level,
         (SELECT gold_balance::text FROM player_wallets WHERE player_id = $3) AS gold_balance,
         (SELECT count(*)::int FROM wallet_events
          WHERE player_id = $3 AND reason = 'equipment_upgrade_v1') AS wallet_events,
         (SELECT count(*)::int FROM equipment_upgrade_operations
          WHERE player_id = $3) AS upgrade_operations`,
      [
        insufficientItems.zero,
        insufficientItems.later,
        insufficient.playerId
      ]
    )).resolves.toMatchObject({
      rows: [{
        zero_level: 0,
        later_level: 1,
        gold_balance: "9",
        wallet_events: 0,
        upgrade_operations: 0
      }]
    });
  }, 90_000);

  it("repairs level-gated Smithing eligibility and durably upgrades 12 to 13 and 24 to 25", async () => {
    const service = new EquipmentService(pool);
    const actor = await seedCurrentPlayer("curve-v2-smithing", 10_000n);
    const levelTwelve = randomUUID();
    const levelTwentyFour = randomUUID();
    await grantCurrentItems(actor.playerId, "curve-v2-smithing", [
      {
        instanceId: levelTwelve,
        definitionId: "training_ring",
        itemLevel: 12
      },
      {
        instanceId: levelTwentyFour,
        definitionId: "training_heavy_boots",
        itemLevel: 24
      }
    ]);

    await pool.query(
      "UPDATE player_progression_profiles SET level = 12 WHERE player_id = $1",
      [actor.playerId]
    );
    expect((await service.getSnapshot(actor.playerId)).instances.find(
      (item) => item.instanceId === levelTwelve
    )).toMatchObject({
      nextUpgradeLevel: 13,
      nextUpgradeCost: "450",
      upgradeDisabledReason: "character_level_required"
    });

    await pool.query(
      "UPDATE player_progression_profiles SET level = 13 WHERE player_id = $1",
      [actor.playerId]
    );
    expect((await service.getSnapshot(actor.playerId)).instances.find(
      (item) => item.instanceId === levelTwelve
    )).toMatchObject({
      nextUpgradeLevel: 13,
      nextUpgradeCost: "450",
      upgradeDisabledReason: null
    });
    await expect(upgradeAtFacility(
      service,
      actor,
      levelTwelve,
      12,
      "curve-v2-smithing-twelve-thirteen"
    )).resolves.toMatchObject({
      applied: true,
      replayed: false,
      levelBefore: 12,
      levelAfter: 13,
      goldCost: "450"
    });

    await pool.query(
      "UPDATE player_progression_profiles SET level = 24 WHERE player_id = $1",
      [actor.playerId]
    );
    expect((await service.getSnapshot(actor.playerId)).instances.find(
      (item) => item.instanceId === levelTwentyFour
    )).toMatchObject({
      nextUpgradeLevel: 25,
      nextUpgradeCost: "2420",
      upgradeDisabledReason: "character_level_required"
    });

    await pool.query(
      "UPDATE player_progression_profiles SET level = 25 WHERE player_id = $1",
      [actor.playerId]
    );
    await expect(upgradeAtFacility(
      service,
      actor,
      levelTwentyFour,
      24,
      "curve-v2-smithing-twenty-four-twenty-five"
    )).resolves.toMatchObject({
      applied: true,
      replayed: false,
      levelBefore: 24,
      levelAfter: 25,
      goldCost: "2420"
    });
    await expect(upgradeAtFacility(
      service,
      actor,
      levelTwentyFour,
      25,
      "curve-v2-smithing-maximum"
    )).rejects.toEqual(expect.objectContaining({
      code: "EQUIPMENT_MAXIMUM_LEVEL"
    }));

    await expect(pool.query(
      `SELECT
         (SELECT item_level FROM equipment_instances WHERE instance_id = $1) AS level_thirteen,
         (SELECT item_level FROM equipment_instances WHERE instance_id = $2) AS level_twenty_five,
         (SELECT gold_balance::text FROM player_wallets WHERE player_id = $3) AS gold_balance,
         (SELECT count(*)::int FROM wallet_events
          WHERE player_id = $3 AND reason = 'equipment_upgrade_v1') AS wallet_events`,
      [levelTwelve, levelTwentyFour, actor.playerId]
    )).resolves.toMatchObject({
      rows: [{
        level_thirteen: 13,
        level_twenty_five: 25,
        gold_balance: "7130",
        wallet_events: 2
      }]
    });
  }, 90_000);

  it("supports the adventurer loadout lifecycle with partial kits, atomic swaps and location-free gold upgrades", async () => {
    const actor = await seedCurrentPlayer("adventurer", 10_000n);
    await pool.query("UPDATE player_progression_profiles SET level=1 WHERE player_id=$1", [actor.playerId]);
    const sword = randomUUID();
    const alternate = randomUUID();
    const chest = randomUUID();
    await grantCurrentItems(actor.playerId, "adventurer", [
      { instanceId: sword, definitionId: "starter_sword", itemLevel: 25 },
      { instanceId: alternate, definitionId: "starter_sword", itemLevel: 12 },
      { instanceId: chest, definitionId: "padded_tunic", itemLevel: 0 }
    ]);
    const service = new EquipmentService(pool);
    await service.connectRuntime(actor.playerId);
    await service.equip(actor.playerId, sword, "melee", "equip-max");
    const partial = await service.saveCombatKit(actor.playerId, 1, (await service.getSnapshot(actor.playerId)).inventoryRevision, "save-partial");
    expect(partial.equipment.kits[0]).toMatchObject({ valid: true, items: { melee: { instanceId: sword }, chest: null, head: null } });
    const swap = await service.equip(actor.playerId, alternate, "melee", "replace-max");
    expect(swap.equipment.active.melee?.instanceId).toBe(alternate);
    expect(swap.equipment.instances.find((item) => item.instanceId === sword)?.location).toBe("inventory");
    expect((await service.equip(actor.playerId, alternate, "melee", "replace-max")).replayed).toBe(true);
    await service.equip(actor.playerId, chest, "chest", "equip-chest");
    const beforeActivation = await service.getSnapshot(actor.playerId);
    await service.stageKitActivation(actor.playerId, { requestId: "partial-activate", kitIndex: 1, expectedInventoryRevision: beforeActivation.inventoryRevision });
    service.markActivationApplied(actor.playerId, "partial-activate", 42);
    await service.flushDirtyCheckpoints();
    await service.flushAndRelease(actor.playerId);
    const reconnected = await service.connectRuntime(actor.playerId);
    expect(reconnected.active).toMatchObject({ melee: { instanceId: sword, itemLevel: 25 }, chest: null, head: null });
    const upgrade = await service.upgrade(actor, alternate, 12, "anywhere-upgrade");
    expect(upgrade).toMatchObject({ levelBefore: 12, levelAfter: 13, goldCost: "450", replayed: false });
    const replay = await service.upgrade(actor, alternate, 12, "anywhere-upgrade");
    expect(replay).toMatchObject({ replayed: true, goldBalance: upgrade.goldBalance });
    const otherActor = await seedCurrentPlayer("adventurer-other", 1_000n);
    await expect(service.upgrade(otherActor, alternate, 13, "wrong-owner")).rejects.toMatchObject({ code: "EQUIPMENT_NOT_OWNED" });
    const preserved = await pool.query("SELECT instance_id::text, item_level FROM equipment_instances WHERE owner_player_id=$1 ORDER BY instance_id", [actor.playerId]);
    expect(await runMigrations(databaseUrl)).toEqual([]);
    expect((await pool.query("SELECT instance_id::text, item_level FROM equipment_instances WHERE owner_player_id=$1 ORDER BY instance_id", [actor.playerId])).rows).toEqual(preserved.rows);
    await service.flushAndRelease(actor.playerId);
  }, 90_000);

  async function upgradeAtFacility(
    service: EquipmentService,
    actor: { playerId: string; accountId: string },
    instanceId: string,
    expectedLevel: number,
    requestId: string
  ) {
    return service.upgrade(
      actor,
      instanceId,
      expectedLevel,
      requestId,
      undefined,
      {
        kind: "manor_smith",
        manorId: UPGRADE_CITY_ID,
        manorSessionId: "95000000-0000-4000-8000-000000000004",
        movementSequence: 1,
        authorize: async () => undefined
      }
    );
  }

  function manorSmithAuthority(): EquipmentManorSmithContext {
    return {
      kind: "manor_smith",
      manorId: UPGRADE_CITY_ID,
      manorSessionId: "95000000-0000-4000-8000-000000000004",
      movementSequence: 1,
      authorize: async () => undefined
    };
  }

  async function seedEquipmentAuthorityFixtures(): Promise<void> {
    const flagId = "95000000-0000-4000-8000-000000000004";
    await pool.query(
      `INSERT INTO flags (id,owner_id,name,lat,lon,claim_radius_m,geom)
       VALUES ($1,$2,'Equipment City Center',35,-106,1000,
               ST_SetSRID(ST_MakePoint(-106,35),4326))`,
      [flagId, playerId]
    );
    await pool.query(
      `INSERT INTO cities (
         id,world_id,canonical_municipality_id,world_settlement_id,
         world_settlement_source,world_source_settlement_id,name,country_code,
         founder_player_id,founding_request_id,seat_flag_id,
         hall_lat,hall_lon,hall_geom,founding_annex_radius_m
       ) VALUES (
         $1,'main','equipment-city','equipment-city','test','equipment-city',
         'Equipment City','US',$2,'equipment-city-found',$3,
         35,-106,ST_SetSRID(ST_MakePoint(-106,35),4326),1000
       )`,
      [UPGRADE_CITY_ID, playerId, flagId]
    );
    await pool.query(
      `UPDATE flags
       SET control_type='city_seat',city_id=$2,city_affiliated_at=now(),
           city_affiliated_by_player_id=NULL,original_owner_player_id=NULL,
           contributed_by_player_id=NULL,original_personal_color=NULL
       WHERE id=$1`,
      [flagId, UPGRADE_CITY_ID]
    );
    await pool.query(
      `INSERT INTO city_structures (
         structure_id,city_id,structure_type,tier,owner_player_id,world_id,
         lat,lon,geom,footprint_geom,footprint_radius_m,state,
         build_operation_key,built_at,destroyed_at
       ) VALUES (
         $1,$2,'weaponsmith',3,NULL,'main',35,-106,
         ST_SetSRID(ST_MakePoint(-106,35),4326),
         ST_Buffer(ST_SetSRID(ST_MakePoint(-106,35),4326)::geography,15)::geometry,
         15,'destroyed','equipment-test-retired-facility',
         '2026-07-01T00:00:00Z','2026-07-02T00:00:00Z'
       )`,
      [LEGACY_FACILITY_ID, UPGRADE_CITY_ID]
    );
  }

  async function seedUpgradeHouse(ownerPlayerId: string): Promise<void> {
    const structureId = randomUUID();
    await pool.query(
      `WITH house AS (
         INSERT INTO city_structures (
           structure_id,city_id,structure_type,tier,owner_player_id,world_id,
           lat,lon,geom,footprint_geom,footprint_radius_m,state,
           build_operation_key,built_at
         ) VALUES (
           $1,$2,'city_house',1,$3,'main',35.001,-106,
           ST_SetSRID(ST_MakePoint(-106,35.001),4326),
           ST_Buffer(ST_SetSRID(ST_MakePoint(-106,35.001),4326)::geography,10)::geometry,
           10,'active',$4,now()
         )
         RETURNING structure_id
       )
       INSERT INTO city_memberships (
         membership_id,city_id,player_id,world_id,role,house_structure_id,joined_at
       )
       SELECT gen_random_uuid(),$2,$3,'main','member',structure_id,now() FROM house`,
      [structureId, UPGRADE_CITY_ID, ownerPlayerId, `equipment-test-house:${structureId}`]
    );
  }

  async function seedPopulatedLegacyPlayer(): Promise<void> {
    await pool.query(
      `INSERT INTO accounts (id, status, trust_tier)
       VALUES ($1, 'active', 'standard')`,
      [accountId]
    );
    await pool.query(
      `INSERT INTO players (
         id, account_id, username, username_normalized, region_code,
         lat, lon, anchor_lat, anchor_lon, move_leash_radius_m, online, geom
       ) VALUES (
         $1, $2, $3, $3, 'equipment-test',
         35, -106, 35, -106, 900, false,
         ST_SetSRID(ST_MakePoint(-106, 35), 4326)
       )`,
      [playerId, accountId, `equipment-${suffix}`]
    );
    await pool.query(
      `INSERT INTO player_combat_profiles (
         player_id, max_health, current_health, persistence_version
       ) VALUES ($1, 200, 50, 7)`,
      [playerId]
    );
    const walletClient = await pool.connect();
    try {
      await walletClient.query("BEGIN");
      await new WalletService().creditForOperationInTransaction(walletClient, {
        playerId,
        accountId,
        amount: 1_000n,
        operationKey: `equipment-test-opening-wallet:${playerId}`,
        reason: "equipment_test_opening_wallet"
      });
      await walletClient.query("COMMIT");
    } catch (error) {
      await walletClient.query("ROLLBACK");
      throw error;
    } finally {
      walletClient.release();
    }
    const operationKey = `legacy-equipment:${playerId}`;
    await pool.query(
      `INSERT INTO equipment_operations (
         operation_key, player_id, action, completed_at
       ) VALUES ($1, $2, 'starter_loadout', now())`,
      [operationKey, playerId]
    );
    await pool.query(
      `INSERT INTO equipment_instances (
         instance_id, definition_id, owner_player_id, location, equipped_slot,
         created_by_operation_key
       ) VALUES
         ($1, 'starter_sword', $5, 'equipped', 'weapon', $6),
         ($2, 'starter_bow', $5, 'inventory', NULL, $6),
         ($3, 'starter_staff', $5, 'inventory', NULL, $6),
         ($4, 'padded_tunic', $5, 'equipped', 'chest', $6)`,
      [
        starterIds.sword,
        starterIds.bow,
        starterIds.staff,
        starterIds.tunic,
        playerId,
        operationKey
      ]
    );
  }

  async function grantCompleteTrainingLoadout(): Promise<void> {
    const operationKey = `training-equipment:${playerId}`;
    await pool.query(
      `INSERT INTO equipment_operations (
         operation_key, player_id, action, completed_at
       ) VALUES ($1, $2, 'starter_loadout', now())`,
      [operationKey, playerId]
    );
    await pool.query(
      `INSERT INTO equipment_instances (
         instance_id, definition_id, owner_player_id, location, equipped_slot,
         inventory_slot_index, item_level, balance_version, created_by_operation_key
       ) VALUES
         ($1, 'training_heavy_helm', $5, 'equipped', 'head', 4, 0, 1, $6),
         ($2, 'training_heavy_gloves', $5, 'equipped', 'gloves', 5, 0, 1, $6),
         ($3, 'training_heavy_boots', $5, 'equipped', 'boots', 6, 0, 1, $6),
         ($4, 'training_ring', $5, 'equipped', 'ring', 7, 0, 1, $6)`,
      [
        trainingIds.helm,
        trainingIds.gloves,
        trainingIds.boots,
        trainingIds.ring,
        playerId,
        operationKey
      ]
    );
    await pool.query(
      `UPDATE equipment_instances
       SET location = 'equipped', equipped_slot = 'secondary'
       WHERE instance_id = $1`,
      [starterIds.bow]
    );
    await pool.query(
      `UPDATE player_equipment_state
       SET readied_weapon_slot = 'secondary'
       WHERE player_id = $1`,
      [playerId]
    );
  }

  async function seedCurrentPlayer(
    label: string,
    openingGold: bigint
  ): Promise<{ playerId: string; accountId: string }> {
    const currentAccountId = randomUUID();
    const currentPlayerId = `equipment-${label}-${suffix}`;
    await pool.query(
      `INSERT INTO accounts (id, status, trust_tier)
       VALUES ($1, 'active', 'standard')`,
      [currentAccountId]
    );
    await pool.query(
      `INSERT INTO players (
         id, account_id, username, username_normalized, region_code,
         lat, lon, anchor_lat, anchor_lon, move_leash_radius_m, online, geom
       ) VALUES (
         $1, $2, $3, $3, 'equipment-test',
         35, -106, 35, -106, 900, false,
         ST_SetSRID(ST_MakePoint(-106, 35), 4326)
       )`,
      [currentPlayerId, currentAccountId, currentPlayerId]
    );
    await pool.query(
      `INSERT INTO player_progression_profiles (player_id, level)
       VALUES ($1, 25)
       ON CONFLICT (player_id) DO UPDATE SET level=EXCLUDED.level`,
      [currentPlayerId]
    );
    await seedUpgradeHouse(currentPlayerId);
    if (openingGold > 0n) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await new WalletService().creditForOperationInTransaction(client, {
          playerId: currentPlayerId,
          accountId: currentAccountId,
          amount: openingGold,
          operationKey: `equipment-test-opening-wallet:${currentPlayerId}`,
          reason: "equipment_test_opening_wallet"
        });
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
    return { playerId: currentPlayerId, accountId: currentAccountId };
  }

  async function grantCurrentItems(
    ownerPlayerId: string,
    label: string,
    items: ReadonlyArray<{
      instanceId: string;
      definitionId: string;
      itemLevel: number;
      location?: "inventory" | "destroyed";
    }>
  ): Promise<void> {
    const operationKey = `current-equipment:${label}:${ownerPlayerId}`;
    await pool.query(
      `INSERT INTO equipment_operations (
         operation_key, player_id, action, completed_at
       ) VALUES ($1, $2, 'starter_loadout', now())`,
      [operationKey, ownerPlayerId]
    );
    for (const item of items) {
      await pool.query(
        `INSERT INTO equipment_instances (
           instance_id, definition_id, owner_player_id, location, equipped_slot,
           inventory_slot_index, item_level, balance_version, created_by_operation_key
         ) VALUES ($1, $2, $3, $4, NULL, $5, $6, 1, $7)`,
        [
          item.instanceId,
          item.definitionId,
          ownerPlayerId,
          item.location ?? "inventory",
          null,
          item.itemLevel,
          operationKey
        ]
      );
    }
  }
});

function assertDisposableAdminUrl(value: string): URL {
  const parsed = new URL(value);
  const database = decodeURIComponent(parsed.pathname.slice(1));
  if (
    !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
    !database.startsWith("ash_atlas_stability")
  ) {
    throw new Error(
      "Equipment integration tests require a local disposable ash_atlas_stability admin database"
    );
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/.test(value)) {
    throw new Error("Unsafe disposable equipment database name");
  }
  return `"${value}"`;
}
