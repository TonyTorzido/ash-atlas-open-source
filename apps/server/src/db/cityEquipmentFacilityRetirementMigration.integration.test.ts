import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "./disposableTestPool.js";
import { CityStructureService } from "../game/cityStructures.js";
import { CityTreasuryService } from "../game/cityTreasury.js";
import { CityWarehouseService } from "../game/cityWarehouse.js";
import { EquipmentService } from "../game/equipment.js";
import { InventoryService } from "../game/inventory.js";
import { WalletService } from "../game/wallet.js";
import { runMigrations } from "./migrate.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;
const TARGET_MIGRATION = "0711_retire_city_equipment_facilities.sql";

describeDatabase("city equipment facility retirement migration", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const databaseName = `ash_atlas_stability_city_facility_retirement_${suffix}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
  const migrations = fileURLToPath(
    new URL("../../../../db/migrations/", import.meta.url)
  );
  const founderA = `retirement-founder-a-${suffix}`;
  const founderB = `retirement-founder-b-${suffix}`;
  const mayor = `retirement-mayor-${suffix}`;
  const accountIds = {
    founderA: randomUUID(),
    founderB: randomUUID(),
    mayor: randomUUID()
  };
  const cityA = randomUUID();
  const cityB = randomUUID();
  const ids = {
    activeWeaponsmith: randomUUID(),
    activeArmory: randomUUID(),
    constructingWeaponsmith: randomUUID(),
    constructingArmory: randomUUID(),
    destroyedWeaponsmith: randomUUID(),
    destroyedArmory: randomUUID(),
    warehouse: randomUUID(),
    cityHouse: randomUUID(),
    mayorHouse: randomUUID(),
    equipment: randomUUID()
  };
  let precedingMigrations = "";
  let databaseUrl = "";
  let pool: pg.Pool;
  let completedLegacyRequestId = "";

  beforeAll(async () => {
    const parsed = requireDisposableAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    precedingMigrations = await mkdtemp(
      path.join(tmpdir(), "ash-atlas-city-facility-retirement-")
    );
    for (const name of (await readdir(migrations))
      .filter((name) => name.endsWith(".sql") && name < TARGET_MIGRATION)
      .sort()) {
      await copyFile(path.join(migrations, name), path.join(precedingMigrations, name));
    }
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await runMigrations(databaseUrl, { migrationsDirectory: precedingMigrations });
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 6 });
    await seedPopulatedRetirementFixture();
  }, 90_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end();
    if (precedingMigrations) {
      await rm(precedingMigrations, { recursive: true, force: true });
    }
  });

  it("retires active and constructing legacy facilities without economic mutation", async () => {
    const protectedBefore = await protectedState();
    const destroyedBefore = await pool.query(
      `SELECT structure_id::text,state,built_at,destroyed_at,placement_revision::text
       FROM city_structures
       WHERE structure_id IN ($1,$2)
       ORDER BY structure_id`,
      [ids.destroyedWeaponsmith, ids.destroyedArmory]
    );

    await copyFile(path.join(migrations, TARGET_MIGRATION), path.join(precedingMigrations, TARGET_MIGRATION));
    await expect(runMigrations(databaseUrl, { migrationsDirectory: precedingMigrations }))
      .resolves.toEqual([TARGET_MIGRATION]);

    await expect(pool.query(
      `SELECT structure_id::text,state,built_at IS NOT NULL AS has_built_at,
              destroyed_at IS NOT NULL AS has_destroyed_at,
              placement_revision::text
       FROM city_structures
       WHERE structure_id IN ($1,$2,$3,$4)
       ORDER BY structure_id`,
      [
        ids.activeWeaponsmith,
        ids.activeArmory,
        ids.constructingWeaponsmith,
        ids.constructingArmory
      ]
    )).resolves.toMatchObject({
      rows: expect.arrayContaining([
        expect.objectContaining({
          structure_id: ids.activeWeaponsmith,
          state: "destroyed",
          has_built_at: true,
          has_destroyed_at: true,
          placement_revision: "8"
        }),
        expect.objectContaining({
          structure_id: ids.activeArmory,
          state: "destroyed",
          has_built_at: true,
          has_destroyed_at: true,
          placement_revision: "8"
        }),
        expect.objectContaining({
          structure_id: ids.constructingWeaponsmith,
          state: "destroyed",
          has_built_at: true,
          has_destroyed_at: true,
          placement_revision: "8"
        }),
        expect.objectContaining({
          structure_id: ids.constructingArmory,
          state: "destroyed",
          has_built_at: true,
          has_destroyed_at: true,
          placement_revision: "8"
        })
      ])
    });
    await expect(pool.query(
      `SELECT structure_id::text,state,built_at,destroyed_at,placement_revision::text
       FROM city_structures
       WHERE structure_id IN ($1,$2)
       ORDER BY structure_id`,
      [ids.destroyedWeaponsmith, ids.destroyedArmory]
    )).resolves.toEqual(destroyedBefore);
    await expect(pool.query(
      `SELECT structure_id::text,state,structure_type
       FROM city_structures
       WHERE structure_id IN ($1,$2,$3)
       ORDER BY structure_type`,
      [ids.warehouse, ids.cityHouse, ids.mayorHouse]
    )).resolves.toMatchObject({
      rows: [
        { structure_id: ids.cityHouse, state: "active", structure_type: "city_house" },
        { structure_id: ids.mayorHouse, state: "active", structure_type: "mayor_house" },
        { structure_id: ids.warehouse, state: "active", structure_type: "warehouse" }
      ]
    });
    await expect(protectedState()).resolves.toEqual(protectedBefore);
  }, 90_000);

  it("neutralizes incomplete operations, preserves history FKs, and cannot reconcile retirement", async () => {
    await expect(pool.query(
      `SELECT action,completed_at IS NOT NULL AS complete,
              result->'structure'->>'state' AS result_state,
              COALESCE(jsonb_array_length(result->'droppedItems'),0) AS drop_count
       FROM city_structure_operations
       WHERE operation_key LIKE 'retirement-pending:%'
       ORDER BY operation_key`
    )).resolves.toMatchObject({
      rows: [
        { action: "upgrade_facility", complete: true, result_state: "destroyed", drop_count: 0 },
        { action: "destroy_facility", complete: true, result_state: "destroyed", drop_count: 0 },
        { action: "build_facility", complete: true, result_state: "destroyed", drop_count: 0 },
        { action: "build_facility", complete: true, result_state: "destroyed", drop_count: 0 }
      ]
    });
    await expect(pool.query(
      `SELECT
         (SELECT count(*)::int
          FROM city_structure_events history
          LEFT JOIN city_structures structure ON structure.structure_id=history.structure_id
          LEFT JOIN city_structure_operations operation
            ON operation.operation_key=history.operation_key
          WHERE structure.structure_id IS NULL OR operation.operation_key IS NULL) AS event_orphans,
         (SELECT count(*)::int
          FROM city_structure_material_spend history
          LEFT JOIN city_structures structure ON structure.structure_id=history.structure_id
          WHERE structure.structure_id IS NULL) AS spend_orphans,
         (SELECT count(*)::int
          FROM city_structure_refunds history
          LEFT JOIN city_structures structure ON structure.structure_id=history.structure_id
          LEFT JOIN city_structure_operations operation
            ON operation.operation_key=history.operation_key
          WHERE structure.structure_id IS NULL OR operation.operation_key IS NULL) AS refund_orphans,
         (SELECT count(*)::int
          FROM equipment_upgrade_operations history
          LEFT JOIN city_structures structure
            ON structure.structure_id=history.facility_structure_id
          WHERE history.facility_structure_id IS NOT NULL
            AND structure.structure_id IS NULL) AS equipment_orphans`
    )).resolves.toMatchObject({
      rows: [{
        event_orphans: 0,
        spend_orphans: 0,
        refund_orphans: 0,
        equipment_orphans: 0
      }]
    });

    // Historical retirement assertions above run before later schema changes.
    await runMigrations(databaseUrl);
    const inventory = new InventoryService(pool);
    const treasury = new CityTreasuryService(pool);
    const warehouse = new CityWarehouseService(pool, inventory);
    const structures = new CityStructureService(
      pool,
      "main",
      inventory,
      treasury,
      warehouse
    );
    await expect(structures.reconcileDueConstruction()).resolves.toEqual([]);
    await expect(pool.query(
      `SELECT count(*)::int AS count
       FROM city_structures
       WHERE structure_type IN ('weaponsmith','armory')
         AND state <> 'destroyed'`
    )).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });

  it("replays completed legacy equipment history without charging or upgrading", async () => {
    const before = await pool.query(
      `SELECT
         (SELECT item_level FROM equipment_instances WHERE instance_id=$1) AS item_level,
         (SELECT gold_balance::text FROM player_wallets WHERE player_id=$2) AS gold_balance,
         (SELECT count(*)::int FROM wallet_events WHERE player_id=$2) AS wallet_events`,
      [ids.equipment, founderA]
    );
    const result = await new EquipmentService(pool).upgrade(
      { playerId: founderA, accountId: accountIds.founderA },
      ids.equipment,
      0,
      completedLegacyRequestId,
      undefined,
      {
        kind: "legacy_city_replay",
        facilityStructureId: ids.activeWeaponsmith
      }
    );
    expect(result).toMatchObject({
      applied: false,
      replayed: true,
      instanceId: ids.equipment,
      levelBefore: 0,
      levelAfter: 1,
      goldCost: "10",
      goldBalance: "100"
    });
    await expect(pool.query(
      `SELECT
         (SELECT item_level FROM equipment_instances WHERE instance_id=$1) AS item_level,
         (SELECT gold_balance::text FROM player_wallets WHERE player_id=$2) AS gold_balance,
         (SELECT count(*)::int FROM wallet_events WHERE player_id=$2) AS wallet_events`,
      [ids.equipment, founderA]
    )).resolves.toEqual(before);
  });

  it("is mutation-idempotent when the retirement SQL executes again", async () => {
    const before = await retirementState();
    const sql = await readFile(path.join(migrations, TARGET_MIGRATION), "utf8");
    await pool.query(sql);
    await expect(retirementState()).resolves.toEqual(before);
    await expect(runMigrations(databaseUrl)).resolves.toEqual([]);
  });

  async function seedPopulatedRetirementFixture(): Promise<void> {
    await createPlayer(founderA, accountIds.founderA);
    await createPlayer(founderB, accountIds.founderB);
    await createPlayer(mayor, accountIds.mayor);
    await createCity(cityA, founderA, mayor, "A");
    await createCity(cityB, founderB, founderB, "B");

    await insertStructure(ids.activeWeaponsmith, cityA, "weaponsmith", "active", null);
    await insertStructure(ids.activeArmory, cityA, "armory", "active", null);
    await insertStructure(
      ids.constructingWeaponsmith,
      cityB,
      "weaponsmith",
      "constructing",
      null
    );
    await insertStructure(ids.constructingArmory, cityB, "armory", "constructing", null);
    await insertStructure(ids.destroyedWeaponsmith, cityA, "weaponsmith", "destroyed", null);
    await insertStructure(ids.destroyedArmory, cityA, "armory", "destroyed", null);
    await insertStructure(ids.warehouse, cityA, "warehouse", "active", null);
    await insertStructure(ids.cityHouse, cityA, "city_house", "active", founderA);
    await insertStructure(ids.mayorHouse, cityA, "mayor_house", "active", mayor);

    const pending = [
      ["retirement-pending:1", ids.activeWeaponsmith, "upgrade_facility"],
      ["retirement-pending:2", ids.activeArmory, "destroy_facility"],
      ["retirement-pending:3", ids.constructingWeaponsmith, "build_facility"],
      ["retirement-pending:4", ids.constructingArmory, "build_facility"]
    ] as const;
    for (const [operationKey, structureId, action] of pending) {
      await insertStructureOperation(operationKey, structureId, action, false);
    }
    await insertStructureOperation(
      "retirement-history:destroyed-weaponsmith",
      ids.destroyedWeaponsmith,
      "destroy_facility",
      true
    );
    await insertStructureOperation(
      "retirement-history:destroyed-armory",
      ids.destroyedArmory,
      "destroy_facility",
      true
    );
    await pool.query(
      `INSERT INTO city_structure_events (
         operation_key,city_id,structure_id,actor_player_id,event_type,details
       ) VALUES (
         'retirement-history:destroyed-weaponsmith',$1,$2,$3,'destroyed',
         '{"fixture":true}'::jsonb
       )`,
      [cityA, ids.destroyedWeaponsmith, founderA]
    );
    await pool.query(
      `INSERT INTO city_structure_material_spend (
         structure_id,tier,item_id,variant,quantity,paid_by_player_id,
         source_operation_key
       ) VALUES ($1,1,'wood','default',125,$2,'retirement-history:spend')`,
      [ids.destroyedWeaponsmith, founderA]
    );
    await pool.query(
      `INSERT INTO city_structure_refunds (
         operation_key,structure_id,item_id,variant,invested_quantity,
         refund_quantity,destination,recipient_player_id
       ) VALUES (
         'retirement-history:destroyed-armory',$1,'stone','default',125,41,
         'player_inventory',$2
       )`,
      [ids.destroyedArmory, founderA]
    );
    await pool.query(
      `UPDATE city_treasuries
       SET balance=90,lifetime_earned=120,lifetime_spent=30,revision=2
       WHERE city_id=$1`,
      [cityA]
    );
    const inventory = new InventoryService(pool);
    await inventory.grantItemsForOperation({
      operationKey: "retirement-fixture-inventory",
      playerId: founderA,
      source: "city_test_seed",
      grants: [{ itemId: "wood", variant: null, quantity: 17 }]
    });
    await pool.query(
      `INSERT INTO city_warehouse_stacks (
         city_id,slot_index,item_id,variant,quantity
       ) VALUES ($1,0,'stone','default',23)`,
      [cityA]
    );
    await seedCompletedLegacyEquipmentOperation();
  }

  async function seedCompletedLegacyEquipmentOperation(): Promise<void> {
    await pool.query(
      `INSERT INTO player_progression_profiles (player_id,level)
       VALUES ($1,25)
       ON CONFLICT (player_id) DO UPDATE SET level=EXCLUDED.level`,
      [founderA]
    );
    await pool.query(
      `INSERT INTO equipment_operations (
         operation_key,player_id,action,completed_at
       ) VALUES ('retirement-fixture-equipment',$1,'starter_loadout',clock_timestamp())`,
      [founderA]
    );
    await pool.query(
      `INSERT INTO equipment_instances (
         instance_id,definition_id,owner_player_id,location,equipped_slot,
         inventory_slot_index,item_level,balance_version,created_by_operation_key
       ) VALUES ($1,'training_ring',$2,'inventory',NULL,1,0,1,
                 'retirement-fixture-equipment')`,
      [ids.equipment, founderA]
    );
    const wallet = new WalletService();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await wallet.creditForOperationInTransaction(client, {
        playerId: founderA,
        accountId: accountIds.founderA,
        amount: 100n,
        operationKey: "retirement-fixture-wallet",
        reason: "equipment_test_opening_wallet"
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    // Retained completed results use the historical snapshot shape; current services
    // cannot read the pre-retirement schema (for example, achievements are newer).
    const emptySlots = { head: null, chest: null, gloves: null, boots: null,
      ring: null, melee: null, secondary: null };
    const equipment = {
      snapshotVersion: 2,
      balanceVersion: 2,
      playerId: founderA,
      active: emptySlots,
      readiedWeaponSlot: "melee",
      activeKitIndex: null,
      kits: [],
      inventoryRevision: 0,
      activeRevision: 0,
      checkpointRevision: 0,
      characterLevel: 25,
      repairMessage: null,
      derivedStats: {
        balanceVersion: 2, context: "pve", maximumHealth: 100, characterLevel: 25,
        classId: "warrior", classRank: 0, normalizedClassPower: 0,
        readiedWeaponSlot: "melee", readiedWeaponCategory: null,
        weaponItemLevel: 0, effectiveWeaponLevel: 0, weightedArmorLevel: 0,
        shieldLevel: null, shieldGuardBonus: 0, pvpOffense: 10, pvpGuard: 0,
        pveAttackPower: 10, pveDefense: 0, pveWeaponProficiencyMultiplier: 1,
        universalAttackPower: 10, universalDefense: 0,
        weaponAttackPower: { melee: 10, secondary: 10 },
        weaponCategories: { melee: null, secondary: null },
        resourceMaximumBonus: 0, resourceGenerationMultiplier: 1,
        actionDurationMultiplier: 1, movementSpeedMultiplier: 1,
        crowdControlDurationMultiplier: 1, attackIntervalMs: 1600, attackRangeM: 75,
        challengeProfile: { balanceVersion: 2, currentGearLevel: 0, unlockedGearLevel: 0,
          tier: "common", contributors: { melee: 0, chest: 0, secondary: 0 } },
        items: emptySlots
      },
      instances: [{
        instanceId: ids.equipment,
        definitionId: "training_ring",
        displayName: "Training Ring",
        ownerPlayerId: founderA,
        location: "inventory",
        equippedSlot: null,
        inventorySlotIndex: 1,
        itemLevel: 0,
        maximumItemLevel: 25,
        category: "ring",
        balanceVersion: 1,
        enchantmentIdentity: null,
        savedKitIndices: [],
        nextUpgradeLevel: 1,
        nextUpgradeCost: "10",
        upgradeDisabledReason: null,
        derived: {
          instanceId: ids.equipment, definitionId: "training_ring", slot: "ring",
          category: "ring", weaponCategory: null, armorCategory: null, twoHanded: false,
          itemLevel: 0, maximumItemLevel: 25, requiredCharacterLevel: 0,
          statScope: "utility_only", utilityKind: "none", affinityBonus: 0,
          effectiveItemLevel: 0, pveLevelScaling: 1, pveAttackContribution: 0,
          pveDefenseContribution: 0, pvpLevelContribution: 0,
          universalAttackContribution: 0, universalDefenseContribution: 0,
          resourceMaximumBonus: 0, resourceGenerationMultiplier: 1,
          actionDurationMultiplier: 1, movementSpeedMultiplier: 1,
          crowdControlDurationMultiplier: 1, balanceVersion: 2
        },
        attackPowerBonus: 0,
        defenseBonus: 0,
        weaponCategory: null,
        armorCategory: null,
        twoHanded: false
      }],
      weapon: null,
      chest: null,
      totalAttackPowerBonus: 0,
      totalDefenseBonus: 0
    };
    completedLegacyRequestId = "retirement-completed-legacy-upgrade";
    const operationKey =
      `equipment-upgrade:${accountIds.founderA}:${completedLegacyRequestId}`;
    const result = {
      applied: true,
      replayed: false,
      instanceId: ids.equipment,
      levelBefore: 0,
      levelAfter: 1,
      goldCost: "10",
      balanceVersion: 1,
      goldBalance: "100",
      equipment
    };
    await pool.query(
      `INSERT INTO equipment_upgrade_operations (
         operation_key,player_id,account_id,request_id,instance_id,expected_level,
         level_before,level_after,gold_cost,balance_version,wallet_operation_key,
         wallet_version_after,result,completed_at,facility_structure_id,
         authority_kind,authority_source
       ) VALUES (
         $1,$2,$3,$4,$5,0,0,1,10,1,'retirement-fixture-wallet',1,
         $6::jsonb,clock_timestamp(),$7,'legacy',NULL
       )`,
      [
        operationKey,
        founderA,
        accountIds.founderA,
        completedLegacyRequestId,
        ids.equipment,
        JSON.stringify(result),
        ids.activeWeaponsmith
      ]
    );
  }

  async function createPlayer(playerId: string, accountId: string): Promise<void> {
    await pool.query(
      `INSERT INTO accounts (id,status,trust_tier)
       VALUES ($1,'active','standard')`,
      [accountId]
    );
    await pool.query(
      `INSERT INTO players (
         id,account_id,username,username_normalized,display_color,region_code,
         lat,lon,anchor_lat,anchor_lon,move_leash_radius_m,online,geom
       ) VALUES (
         $1,$2,$1,$1,'#38bdf8','NM',35,-106,35,-106,900,false,
         ST_SetSRID(ST_MakePoint(-106,35),4326)
       )`,
      [playerId, accountId]
    );
  }

  async function createCity(
    cityId: string,
    founderPlayerId: string,
    mayorPlayerId: string,
    label: string
  ): Promise<void> {
    const flagId = randomUUID();
    const lat = label === "A" ? 35 : 40;
    await pool.query(
      `INSERT INTO flags (id,owner_id,name,lat,lon,claim_radius_m,geom)
       VALUES ($1,$2,$3,$4,-106,1000,
               ST_SetSRID(ST_MakePoint(-106,$4),4326))`,
      [flagId, founderPlayerId, `Retirement ${label} Seat`, lat]
    );
    await pool.query(
      `INSERT INTO cities (
         id,world_id,canonical_municipality_id,world_settlement_id,
         world_settlement_source,world_source_settlement_id,name,country_code,
         founder_player_id,mayor_player_id,founding_request_id,seat_flag_id,
         hall_lat,hall_lon,hall_geom,founding_annex_radius_m,
         mayor_confirmed_at
       ) VALUES (
         $1,'main',$2,$2,'test',$2,$3,'US',$4,$5,$6,$7,
         $8,-106,ST_SetSRID(ST_MakePoint(-106,$8),4326),1000,clock_timestamp()
       )`,
      [
        cityId,
        `retirement-city-${label}-${suffix}`,
        `Retirement ${label}`,
        founderPlayerId,
        mayorPlayerId,
        `retirement-found-${label}`,
        flagId,
        lat
      ]
    );
    await pool.query(
      `UPDATE flags
       SET control_type='city_seat',city_id=$2,city_affiliated_at=clock_timestamp(),
           city_affiliated_by_player_id=$3,original_owner_player_id=$3,
           contributed_by_player_id=$3,original_personal_color='#38bdf8'
       WHERE id=$1`,
      [flagId, cityId, founderPlayerId]
    );
  }

  async function insertStructure(
    structureId: string,
    cityId: string,
    type: "weaponsmith" | "armory" | "warehouse" | "city_house" | "mayor_house",
    state: "constructing" | "active" | "destroyed",
    ownerPlayerId: string | null
  ): Promise<void> {
    await pool.query(
      `INSERT INTO city_structures (
         structure_id,city_id,structure_type,tier,owner_player_id,world_id,
         region_code,lat,lon,geom,footprint_geom,footprint_radius_m,
         placement_revision,state,build_operation_key,
         construction_started_at,construction_completes_at,built_at,destroyed_at,
         created_at,updated_at
       ) VALUES (
         $1,$2,$3,1,$4,'main','NM',35,-106,
         ST_SetSRID(ST_MakePoint(-106,35),4326),
         ST_Buffer(ST_SetSRID(ST_MakePoint(-106,35),4326)::geography,15)::geometry,
         15,7,$5,$6,
         CASE WHEN $5='constructing' THEN '2026-07-20T00:00:00Z'::timestamptz END,
         CASE WHEN $5='constructing' THEN '2026-07-20T00:01:00Z'::timestamptz END,
         CASE WHEN $5<>'constructing' THEN '2026-07-19T00:00:00Z'::timestamptz END,
         CASE WHEN $5='destroyed' THEN '2026-07-21T00:00:00Z'::timestamptz END,
         '2026-07-18T00:00:00Z','2026-07-21T00:00:00Z'
       )`,
      [structureId, cityId, type, ownerPlayerId, state, `retirement-build:${structureId}`]
    );
  }

  async function insertStructureOperation(
    operationKey: string,
    structureId: string,
    action: "build_facility" | "upgrade_facility" | "destroy_facility",
    complete: boolean
  ): Promise<void> {
    await pool.query(
      `INSERT INTO city_structure_operations (
         operation_key,actor_player_id,request_id,action,city_id,structure_id,
         intent,result,completed_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6,'{"fixture":true}'::jsonb,
         CASE WHEN $7 THEN '{"fixture":"complete"}'::jsonb END,
         CASE WHEN $7 THEN '2026-07-22T00:00:00Z'::timestamptz END
       )`,
      [
        operationKey,
        founderA,
        `request:${operationKey}`,
        action,
        cityA,
        structureId,
        complete
      ]
    );
  }

  async function protectedState(): Promise<unknown> {
    const result = await pool.query(
      `SELECT
         (SELECT jsonb_agg(to_jsonb(row_data) ORDER BY row_data.player_id)
          FROM (
            SELECT player_id,resource_type,variant,quantity::text
            FROM player_inventory
          ) row_data) AS inventory,
         (SELECT jsonb_agg(to_jsonb(row_data) ORDER BY row_data.city_id,row_data.slot_index)
          FROM (
            SELECT city_id::text,slot_index,item_id,variant,quantity::text
            FROM city_warehouse_stacks
          ) row_data) AS warehouse,
         (SELECT jsonb_agg(to_jsonb(row_data) ORDER BY row_data.city_id)
          FROM (
            SELECT city_id::text,balance::text,lifetime_earned::text,
                   lifetime_spent::text,revision::text
            FROM city_treasuries
          ) row_data) AS treasuries,
         (SELECT jsonb_agg(to_jsonb(row_data) ORDER BY row_data.instance_id)
          FROM (
            SELECT instance_id::text,item_level,balance_version
            FROM equipment_instances
          ) row_data) AS equipment,
         (SELECT count(*)::int FROM city_structure_refunds) AS refunds,
         (SELECT count(*)::int FROM world_item_drops) AS drops,
         (SELECT count(*)::int FROM city_structure_events) AS events`
    );
    return result.rows[0];
  }

  async function retirementState(): Promise<unknown> {
    const result = await pool.query(
      `SELECT
         (SELECT jsonb_agg(to_jsonb(row_data) ORDER BY row_data.structure_id)
          FROM (
            SELECT structure_id::text,state,built_at,destroyed_at,
                   placement_revision::text,updated_at
            FROM city_structures
            WHERE structure_type IN ('weaponsmith','armory')
          ) row_data) AS structures,
         (SELECT jsonb_agg(to_jsonb(row_data) ORDER BY row_data.operation_key)
          FROM (
            SELECT operation_key,result,completed_at
            FROM city_structure_operations
            WHERE structure_id IN (
              SELECT structure_id FROM city_structures
              WHERE structure_type IN ('weaponsmith','armory')
            )
          ) row_data) AS operations`
    );
    return result.rows[0];
  }
});

function requireDisposableAdminUrl(value: string): URL {
  const parsed = new URL(value);
  const database = decodeURIComponent(parsed.pathname.slice(1));
  if (
    !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
    !database.startsWith("ash_atlas_stability")
  ) {
    throw new Error("City facility retirement tests require a local stability database");
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(value)) {
    throw new Error("Unsafe disposable stability database name");
  }
  return `"${value}"`;
}
