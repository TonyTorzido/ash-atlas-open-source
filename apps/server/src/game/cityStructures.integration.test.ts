import { randomUUID } from "node:crypto";

import {
  CITY_HOUSE_BUILD_DURATION_MS,
  CITY_STRUCTURE_BUILD_DURATION_MS,
  CITY_STRUCTURE_INTERACTION_RADIUS_M,
  CITY_WAREHOUSE_INTERACTION_RADIUS_M,
  MILITARY_CITY_FACILITY_COSTS,
  MILITARY_FACILITY_TYPES,
  OIL_WELL_BUILD_DURATION_MS,
  OIL_WELL_INTERACTION_RADIUS_M,
  requireInventoryCatalogItem
} from "@ash-atlas/shared";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runMigrations } from "../db/migrate.js";
import { CityStructureService } from "./cityStructures.js";
import { CityTreasuryService } from "./cityTreasury.js";
import { CityWarehouseService } from "./cityWarehouse.js";
import { DroppedItemService } from "./droppedItems.js";
import { HarvestAccessService } from "./harvestAccess.js";
import { InventoryService } from "./inventory.js";
import type { PlayerRecord } from "./state.js";
import { WalletService } from "./wallet.js";

const databaseUrl = process.env.SETTLEMENT_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const hall = { lat: 35, lon: -106 };
const houseA = { lat: 35.00405, lon: -106 };
const houseB = { lat: 35, lon: -105.99507 };
const warehousePosition = { lat: 34.99595, lon: -106 };
const westPosition = { lat: 35, lon: -106.00493 };

describeDatabase("City Houses, treasury, Warehouse, and facilities", () => {
  let pool: pg.Pool;
  let inventory: InventoryService;
  let treasury: CityTreasuryService;
  let warehouse: CityWarehouseService;
  let structures: CityStructureService;

  beforeAll(async () => {
    await runMigrations(databaseUrl!);
    pool = new pg.Pool({ connectionString: databaseUrl!, max: 12 });
  }, 30_000);

  beforeEach(async () => {
    await pool.query("TRUNCATE players CASCADE");
    for (const playerId of ["a", "b", "c", "d", "e"]) {
      await createPlayer(pool, playerId);
    }
    inventory = new InventoryService(pool);
    treasury = new CityTreasuryService(pool);
    warehouse = new CityWarehouseService(pool, inventory);
    structures = activateBuildsImmediately(
      pool,
      new CityStructureService(pool, "main", inventory, treasury, warehouse)
    );
    for (const playerId of ["a", "b", "c", "d", "e"]) {
      await grantMaterials(inventory, playerId, 1_000, 1_000);
    }
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("rejects City House placement until staged city construction is complete", async () => {
    const cityId = await createCity(pool, "a", "Blueprint City", hall, "open");
    await expect(pool.query(
      `SELECT construction_phase,construction_completed_at IS NOT NULL AS completed
       FROM cities WHERE id=$1`,
      [cityId]
    )).resolves.toMatchObject({
      rows: [{ construction_phase: "complete", completed: true }]
    });
    await pool.query(
      `UPDATE cities
       SET construction_phase='blueprint',construction_completed_at=NULL,jumpable=false
       WHERE id=$1`,
      [cityId]
    );

    await expect(structures.buildHouse("b", houseB, "blueprint-house"))
      .rejects.toMatchObject({ code: "CITY_CONSTRUCTION_INCOMPLETE" });
    await expect(pool.query(
      "SELECT count(*)::int AS count FROM city_structures WHERE city_id=$1",
      [cityId]
    )).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });

  it("resolves an active Market through the qualified joined structure query", async () => {
    const cityId = await createCity(pool, "a", "Qualified Market", hall, "open");
    const structureId = randomUUID();
    await pool.query(
      `INSERT INTO city_structures (
         structure_id,city_id,structure_type,tier,world_id,region_code,
         lat,lon,geom,footprint_geom,footprint_radius_m,placement_revision,
         state,build_operation_key,built_at
       ) VALUES (
         $1,$2,'market',1,'main','US-NM',$3,$4,
         ST_SetSRID(ST_MakePoint($4,$3),4326),
         ST_Buffer(ST_SetSRID(ST_MakePoint($4,$3),4326)::geography,20)::geometry,
         20,7,'active',$5,clock_timestamp()
       )`,
      [structureId, cityId, hall.lat, hall.lon, `test-market:${structureId}`]
    );

    await expect(
      structures.getActiveMarket(structureId, "7")
    ).resolves.toMatchObject({
      structureId,
      cityId,
      type: "market",
      placementRevision: "7",
      state: "active"
    });

    await pool.query(
      "UPDATE cities SET active=false,inactive_reason='abandoned',ended_at=now(),rebuild_available_at=now()+interval '7 days' WHERE id=$1",
      [cityId]
    );
    await expect(structures.getActiveMarket(structureId, "7")).resolves.toBeNull();
  });

  it("constructs one owner Oil Well and serializes lazy production and harvest", async () => {
    const cityId = await createCity(pool, "a", "Oil Test", hall, "open");
    await structures.buildHouse("a", houseA, "oil-house");
    await inventory.grantItemsForOperation({
      operationKey: "oil-test-resin",
      playerId: "a",
      source: "city_test_seed",
      grants: [{ itemId: "balsam_resin", variant: null, quantity: 150 }]
    });
    const durable = new CityStructureService(
      pool,
      "main",
      inventory,
      treasury,
      warehouse
    );
    const started = await durable.buildOilWell(
      "a",
      cityId,
      westPosition,
      "oil-build"
    );
    expect(started.structure).toMatchObject({
      type: "oil_well",
      state: "constructing",
      ownerPlayerId: "a",
      ownerUsername: "a",
      footprintRadiusM: 12
    });
    expect(
      Date.parse(started.structure.constructionCompletesAt!) -
      Date.parse(started.structure.constructionStartedAt!)
    ).toBe(OIL_WELL_BUILD_DURATION_MS);
    await expect(durable.buildOilWell(
      "a",
      cityId,
      warehousePosition,
      "oil-build-second"
    )).rejects.toMatchObject({ code: "CITY_CONSTRUCTION_ALREADY_ACTIVE" });

    await completeStructureNow(pool, durable, started.structure.structureId);
    await expect(durable.buildOilWell(
      "a",
      cityId,
      warehousePosition,
      "oil-build-after-active"
    )).rejects.toMatchObject({ code: "OIL_WELL_ALREADY_EXISTS" });
    await expect(durable.ownerOilWellProjection("a", westPosition))
      .resolves.toMatchObject({ structureId: started.structure.structureId });
    const beyondOwnerProjection = await projectPosition(pool, westPosition, 1_501, 90);
    await expect(durable.ownerOilWellProjection("a", beyondOwnerProjection))
      .resolves.toBeNull();

    await pool.query(
      `UPDATE city_oil_well_production
       SET stored_crude_oil=0,
           production_cursor=clock_timestamp()-interval '13 hours'
       WHERE structure_id=$1`,
      [started.structure.structureId]
    );
    await expect(durable.openOilWell(
      "a",
      started.structure.structureId,
      westPosition
    )).resolves.toMatchObject({ storedCrudeOil: 120, canHarvest: true });

    await pool.query(
      `INSERT INTO player_profession_progress (player_id,profession_id,xp,rank,curve_version)
       VALUES ('a','oil_worker',755,1,2)
       ON CONFLICT (player_id,profession_id) DO UPDATE SET xp=EXCLUDED.xp,rank=EXCLUDED.rank`
    );
    await expect(durable.openOilWell(
      "a",
      started.structure.structureId,
      westPosition
    )).resolves.toMatchObject({ storedCrudeOil: 120, capacity: 124 });

    await pool.query(
      `UPDATE city_oil_well_production
       SET stored_crude_oil=0,
           production_cursor=clock_timestamp()-interval '13 minutes'
       WHERE structure_id=$1`,
      [started.structure.structureId]
    );
    await expect(durable.openOilWell(
      "a",
      started.structure.structureId,
      beyondOwnerProjection,
      true
    )).rejects.toMatchObject({ code: "OIL_WELL_REMOTE_MONITORING_LOCKED" });
    await pool.query(
      `INSERT INTO player_profession_progress (player_id,profession_id,xp,rank,curve_version)
       VALUES ('a','oil_worker',5288,4,2)
       ON CONFLICT (player_id,profession_id) DO UPDATE SET xp=EXCLUDED.xp,rank=EXCLUDED.rank`
    );
    const opened = await durable.openOilWell(
      "a",
      started.structure.structureId,
      beyondOwnerProjection,
      true
    );
    expect(opened).toMatchObject({
      storedCrudeOil: 2,
      capacity: 136,
      productionPerHour: 10,
      canHarvest: true
    });
    expect(Date.parse(opened.nextUnitAt!) - opened.serverTime)
      .toBeGreaterThan(4 * 60_000);
    await expect(durable.harvestOilWell(
      "a",
      started.structure.structureId,
      beyondOwnerProjection,
      "oil-harvest-remote-before-master",
      true
    )).rejects.toMatchObject({ code: "OIL_WELL_REMOTE_HARVEST_LOCKED" });
    await expect(durable.harvestOilWell(
      "a",
      started.structure.structureId,
      beyondOwnerProjection,
      "oil-harvest-too-far"
    )).rejects.toMatchObject({ code: "OIL_WELL_PROXIMITY_REQUIRED" });

    const [first, second] = await Promise.all([
      durable.harvestOilWell(
        "a",
        started.structure.structureId,
        westPosition,
        "oil-harvest-a"
      ),
      durable.harvestOilWell(
        "a",
        started.structure.structureId,
        westPosition,
        "oil-harvest-b"
      )
    ]);
    expect(first.harvestedQuantity + second.harvestedQuantity).toBe(2);
    expect((first.masteryGrant?.grantedXp ?? 0) + (second.masteryGrant?.grantedXp ?? 0)).toBe(2);
    expect(first.masteryGrant?.requestedXp ?? 0).toBe(first.harvestedQuantity);
    expect(second.masteryGrant?.requestedXp ?? 0).toBe(second.harvestedQuantity);
    const replay = await durable.harvestOilWell(
      "a",
      started.structure.structureId,
      westPosition,
      "oil-harvest-a"
    );
    expect(replay.replayed).toBe(true);
    expect(replay.harvestedQuantity).toBe(first.harvestedQuantity);
    expect(replay.masteryGrant).toEqual(first.masteryGrant);

    await inventory.grantItemsForOperation({
      operationKey: "oil-test-partial-capacity",
      playerId: "a",
      source: "city_test_seed",
      grants: [{ itemId: "crude_oil", variant: null, quantity: 247 }]
    });
    const beforeSplits = await inventory.getInventorySnapshot("a");
    const woodStackId = await inventoryStackId(pool, "a", "wood");
    for (
      let index = 0;
      index < (beforeSplits.unlockedSlots ?? 40) - beforeSplits.items.length;
      index += 1
    ) {
      await inventory.splitStack("a", `oil-capacity-split-${index}`, woodStackId, 1);
    }
    await pool.query(
      `UPDATE city_oil_well_production
       SET stored_crude_oil=5,production_cursor=clock_timestamp()
       WHERE structure_id=$1`,
      [started.structure.structureId]
    );
    const partial = await durable.harvestOilWell(
      "a",
      started.structure.structureId,
      westPosition,
      "oil-harvest-partial"
    );
    expect(partial).toMatchObject({
      harvestedQuantity: 1,
      well: { storedCrudeOil: 4 },
      masteryGrant: { requestedXp: 1, grantedXp: 1, resultingXp: 5_291 }
    });
    await pool.query(
      `UPDATE city_oil_well_production
       SET stored_crude_oil=5,production_cursor=clock_timestamp()
       WHERE structure_id=$1`,
      [started.structure.structureId]
    );
    const fullInventory = await durable.harvestOilWell(
      "a",
      started.structure.structureId,
      westPosition,
      "oil-harvest-full-inventory"
    );
    expect(fullInventory).toMatchObject({
      harvestedQuantity: 0,
      well: { storedCrudeOil: 5 }
    });
    expect(fullInventory.masteryGrant).toBeUndefined();

    await pool.query(
      `INSERT INTO player_profession_progress (player_id,profession_id,xp,rank,curve_version)
       VALUES ('a','oil_worker',25000,8,2)
       ON CONFLICT (player_id,profession_id) DO UPDATE SET xp=EXCLUDED.xp,rank=EXCLUDED.rank`
    );
    await pool.query(
      `UPDATE city_oil_well_production
       SET stored_crude_oil=5,production_cursor=clock_timestamp()
       WHERE structure_id=$1`,
      [started.structure.structureId]
    );
    const remoteHarvest = await durable.harvestOilWell(
      "a",
      started.structure.structureId,
      beyondOwnerProjection,
      "oil-harvest-remote",
      true
    );
    expect(remoteHarvest).toMatchObject({
      harvestedQuantity: 0,
      replayed: false,
      well: { storedCrudeOil: 5, capacity: 150 }
    });
    expect(remoteHarvest.masteryGrant).toBeUndefined();
    await expect(durable.harvestOilWell(
      "b",
      started.structure.structureId,
      beyondOwnerProjection,
      "oil-harvest-wrong-owner",
      true
    )).rejects.toMatchObject({ code: "OIL_WELL_OWNER_REQUIRED" });
    await expect(durable.openOilWell(
      "b",
      started.structure.structureId,
      westPosition
    )).rejects.toMatchObject({ code: "OIL_WELL_PRIVATE" });

    await structures.buildHouse("b", houseB, "oil-cancel-house");
    await inventory.grantItemsForOperation({
      operationKey: "oil-cancel-resin",
      playerId: "b",
      source: "city_test_seed",
      grants: [{ itemId: "balsam_resin", variant: null, quantity: 100 }]
    });
    const cancelBefore = await inventory.getInventorySnapshot("b");
    await durable.buildOilWell(
      "b",
      cityId,
      warehousePosition,
      "oil-cancel-build"
    );
    const cancelled = await durable.cancelOilWellConstruction(
      "b",
      "movement_started"
    );
    expect(cancelled?.structure).toMatchObject({
      type: "oil_well",
      state: "destroyed"
    });
    expect((await inventory.getInventorySnapshot("b")).totals)
      .toEqual(cancelBefore.totals);

    const destroyBefore = await inventory.getInventorySnapshot("b");
    const destroyStarted = await durable.buildOilWell(
      "b",
      cityId,
      warehousePosition,
      "oil-destroy-build"
    );
    await completeStructureNow(
      pool,
      durable,
      destroyStarted.structure.structureId
    );
    await pool.query(
      `UPDATE city_oil_well_production
       SET stored_crude_oil=5,production_cursor=clock_timestamp()
       WHERE structure_id=$1`,
      [destroyStarted.structure.structureId]
    );
    const activeForDestroy = await durable.getOilWellForOwner("b");
    const destroyed = await durable.destroyOilWell(
      "b",
      destroyStarted.structure.structureId,
      activeForDestroy!.placementRevision,
      warehousePosition,
      "oil-destroy"
    );
    expect(destroyed).toMatchObject({
      structure: { type: "oil_well", state: "destroyed" }
    });
    expect(destroyed.inventory?.totals).toMatchObject({
      wood: destroyBefore.totals.wood - 250 + 83,
      stone: destroyBefore.totals.stone - 25 + 8,
      balsam_resin: destroyBefore.totals.balsam_resin - 100 + 33,
      crude_oil: destroyBefore.totals.crude_oil
    });
    await expect(durable.destroyOilWell(
      "b",
      destroyStarted.structure.structureId,
      activeForDestroy!.placementRevision,
      warehousePosition,
      "oil-destroy"
    )).resolves.toMatchObject({ replayed: true });
    await expect(pool.query(
      "SELECT count(*)::int AS count FROM city_oil_well_production WHERE structure_id=$1",
      [destroyStarted.structure.structureId]
    )).resolves.toMatchObject({ rows: [{ count: 0 }] });

    const house = await activeHouseIdentity(pool, "a");
    const left = await durable.destroyHouse(
      "a",
      house.structureId,
      house.placementRevision,
      "oil-membership-loss"
    );
    expect(left.destroyedStructures).toEqual([
      expect.objectContaining({
        structureId: started.structure.structureId,
        type: "oil_well",
        state: "destroyed"
      })
    ]);
    await expect(pool.query(
      "SELECT count(*)::int AS count FROM city_oil_well_production WHERE structure_id=$1",
      [started.structure.structureId]
    )).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });

  it("builds one member Quartz Hut, produces 10 Crystal per hour, and collects once per request", async () => {
    const cityId = await createCity(pool, "a", "Crystal Test", hall, "open");
    await structures.buildHouse("a", houseA, "crystal-house");
    for (const playerId of ["a", "b"]) {
      await inventory.grantItemsForOperation({
        operationKey: `crystal-test-sulfur:${playerId}`,
        playerId,
        source: "city_test_seed",
        grants: [{ itemId: "sulfur", variant: null, quantity: 150 }]
      });
    }
    const durable = new CityStructureService(pool, "main", inventory, treasury, warehouse);

    // Denied: "b" is not a member of this city.
    await expect(durable.buildOilWell("b", cityId, westPosition, "crystal-outsider", "quartz_hut"))
      .rejects.toMatchObject({ code: "OIL_WELL_MEMBERSHIP_REQUIRED" });

    const before = await inventory.getInventorySnapshot("a");
    const started = await durable.buildOilWell("a", cityId, westPosition, "crystal-build", "quartz_hut");
    expect(started.structure).toMatchObject({
      type: "quartz_hut",
      state: "constructing",
      ownerPlayerId: "a",
      footprintRadiusM: 12
    });
    expect(started.inventory?.totals).toMatchObject({
      wood: before.totals.wood - 230,
      stone: before.totals.stone - 30,
      sulfur: before.totals.sulfur - 90
    });
    await expect(durable.buildOilWell("a", cityId, westPosition, "crystal-build", "quartz_hut"))
      .resolves.toMatchObject({ structure: { structureId: started.structure.structureId } });
    await completeStructureNow(pool, durable, started.structure.structureId);
    // Denied: one Quartz Hut per player.
    await expect(durable.buildOilWell("a", cityId, warehousePosition, "crystal-second", "quartz_hut"))
      .rejects.toMatchObject({ code: "QUARTZ_HUT_ALREADY_EXISTS" });
    await expect(durable.getOilWellForOwner("a", "quartz_hut"))
      .resolves.toMatchObject({ structureId: started.structure.structureId, state: "active" });

    await pool.query(
      `UPDATE city_quartz_hut_production
       SET stored_crystal=0,production_cursor=clock_timestamp()-interval '13 hours'
       WHERE structure_id=$1`,
      [started.structure.structureId]
    );
    await expect(durable.openOilWell("a", started.structure.structureId, westPosition))
      .resolves.toMatchObject({
        structureType: "quartz_hut",
        resourceItemId: "crystal",
        storedCrudeOil: 120,
        capacity: 120,
        productionPerHour: 10
      });
    await pool.query(
      `UPDATE city_quartz_hut_production
       SET stored_crystal=0,production_cursor=clock_timestamp()-interval '13 minutes'
       WHERE structure_id=$1`,
      [started.structure.structureId]
    );
    const far = await projectPosition(pool, westPosition, 200, 90);
    await expect(durable.harvestOilWell("a", started.structure.structureId, far, "crystal-far"))
      .rejects.toMatchObject({ code: "QUARTZ_HUT_PROXIMITY_REQUIRED" });
    await expect(durable.harvestOilWell("a", started.structure.structureId, far, "crystal-remote", true))
      .rejects.toMatchObject({ code: "QUARTZ_HUT_REMOTE_UNAVAILABLE" });
    await expect(durable.harvestOilWell("b", started.structure.structureId, westPosition, "crystal-thief"))
      .rejects.toMatchObject({ code: "QUARTZ_HUT_PRIVATE" });

    const [first, second] = await Promise.all([
      durable.harvestOilWell("a", started.structure.structureId, westPosition, "crystal-harvest-a"),
      durable.harvestOilWell("a", started.structure.structureId, westPosition, "crystal-harvest-b")
    ]);
    expect(first.harvestedQuantity + second.harvestedQuantity).toBe(2);
    expect(first.masteryGrant).toBeUndefined();
    const replay = await durable.harvestOilWell("a", started.structure.structureId, westPosition, "crystal-harvest-a");
    expect(replay).toMatchObject({ replayed: true, harvestedQuantity: first.harvestedQuantity });
    expect((await inventory.getInventorySnapshot("a")).totals.crystal).toBe(2);

    const active = await durable.getOilWellForOwner("a", "quartz_hut");
    const destroyed = await durable.destroyOilWell(
      "a",
      started.structure.structureId,
      active!.placementRevision,
      westPosition,
      "crystal-destroy"
    );
    expect(destroyed.structure).toMatchObject({ type: "quartz_hut", state: "destroyed" });
    await expect(pool.query(
      "SELECT count(*)::int AS count FROM city_quartz_hut_production WHERE structure_id=$1",
      [started.structure.structureId]
    )).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });

  it("uses the Oil Well interaction radius for local open and harvest", async () => {
    const cityId = await createCity(pool, "a", "Oil Radius", hall, "open");
    await structures.buildHouse("a", houseA, "oil-radius-house");
    await inventory.grantItemsForOperation({
      operationKey: "oil-radius-resin",
      playerId: "a",
      source: "city_test_seed",
      grants: [{ itemId: "balsam_resin", variant: null, quantity: 150 }]
    });
    const durable = new CityStructureService(pool, "main", inventory, treasury, warehouse);
    const started = await durable.buildOilWell(
      "a",
      cityId,
      westPosition,
      "oil-radius-build"
    );
    const structureId = started.structure.structureId;
    await completeStructureNow(pool, durable, structureId);

    const withinOilWellDistanceM = OIL_WELL_INTERACTION_RADIUS_M - 2;
    expect(withinOilWellDistanceM).toBeGreaterThan(CITY_STRUCTURE_INTERACTION_RADIUS_M);
    const withinOilWellPosition = await projectPosition(
      pool,
      westPosition,
      withinOilWellDistanceM,
      90
    );
    const beyondOilWellPosition = await projectPosition(
      pool,
      westPosition,
      OIL_WELL_INTERACTION_RADIUS_M + 1,
      90
    );
    await pool.query(
      `UPDATE city_oil_well_production
       SET stored_crude_oil=1,production_cursor=clock_timestamp()
       WHERE structure_id=$1`,
      [structureId]
    );

    await expect(durable.openOilWell(
      "a",
      structureId,
      withinOilWellPosition
    )).resolves.toMatchObject({ storedCrudeOil: 1, canHarvest: true });
    await expect(durable.harvestOilWell(
      "a",
      structureId,
      withinOilWellPosition,
      "oil-radius-harvest-within"
    )).resolves.toMatchObject({ harvestedQuantity: 1, replayed: false });
    await expect(durable.openOilWell(
      "a",
      structureId,
      beyondOilWellPosition
    )).rejects.toMatchObject({ code: "OIL_WELL_PROXIMITY_REQUIRED" });
    await expect(durable.harvestOilWell(
      "a",
      structureId,
      beyondOilWellPosition,
      "oil-radius-harvest-beyond"
    )).rejects.toMatchObject({ code: "OIL_WELL_PROXIMITY_REQUIRED" });
  });

  it("enforces Oil Well access and settles one public toll exactly once", async () => {
    const cityId = await createCity(pool, "a", "Public Oil", hall, "open");
    await structures.buildHouse("a", houseA, "public-oil-house");
    await inventory.grantItemsForOperation({
      operationKey: "public-oil-resin",
      playerId: "a",
      source: "city_test_seed",
      grants: [{ itemId: "balsam_resin", variant: null, quantity: 150 }]
    });
    const durable = new CityStructureService(pool, "main", inventory, treasury, warehouse);
    const started = await durable.buildOilWell(
      "a",
      cityId,
      westPosition,
      "public-oil-build"
    );
    const structureId = started.structure.structureId;
    await completeStructureNow(pool, durable, structureId);

    const access = new HarvestAccessService(pool);
    await expect(access.dashboard("a")).resolves.toMatchObject({
      settings: expect.arrayContaining([{ harvestType: "oil_well", tollGold: "0", revision: "0" }]),
      assets: [{
        assetId: structureId,
        harvestType: "oil_well",
        accessMode: "private",
        accessRevision: "0"
      }]
    });
    await expect(access.updateAsset({
      ownerPlayerId: "b",
      assetId: structureId,
      harvestType: "oil_well",
      accessMode: "public",
      expectedRevision: "0",
      position: westPosition
    })).rejects.toMatchObject({ code: "HARVEST_ACCESS_FORBIDDEN" });
    await expect(access.updateAsset({
      ownerPlayerId: "a",
      assetId: structureId,
      harvestType: "oil_well",
      accessMode: "public",
      expectedRevision: "0",
      position: { lat: westPosition.lat, lon: westPosition.lon + 0.01 }
    })).rejects.toMatchObject({ code: "HARVEST_ACCESS_PROXIMITY_REQUIRED" });
    await expect(durable.openOilWell("b", structureId, westPosition))
      .rejects.toMatchObject({ code: "OIL_WELL_PRIVATE" });

    await access.updateAsset({
      ownerPlayerId: "a",
      assetId: structureId,
      harvestType: "oil_well",
      accessMode: "public",
      expectedRevision: "0",
      position: westPosition
    });
    await access.updateToll({
      ownerPlayerId: "a",
      harvestType: "oil_well",
      tollGold: "7",
      expectedRevision: "0"
    });
    await expect(durable.openOilWell("b", structureId, westPosition)).resolves.toMatchObject({
      accessMode: "public",
      tollGold: "7",
      isOwner: false
    });

    const wallet = new WalletService();
    await fundWallet(pool, wallet, "b", 20n, "public-oil-payer");
    await pool.query(
      `UPDATE city_oil_well_production
       SET stored_crude_oil=4,production_cursor=clock_timestamp()
       WHERE structure_id=$1`,
      [structureId]
    );
    const first = await durable.harvestOilWell(
      "b",
      structureId,
      westPosition,
      "public-oil-harvest"
    );
    expect(first).toMatchObject({
      harvestedQuantity: 4,
      replayed: false,
      tollGold: "7",
      walletGold: "13"
    });
    await expect(durable.harvestOilWell(
      "b",
      structureId,
      westPosition,
      "public-oil-harvest"
    )).resolves.toMatchObject({
      harvestedQuantity: 4,
      replayed: true,
      tollGold: "7",
      walletGold: "13"
    });
    await expect(walletSnapshot(pool, wallet, "a")).resolves.toMatchObject({ gold: "7", revision: "1" });
    await expect(walletSnapshot(pool, wallet, "b")).resolves.toMatchObject({ gold: "13", revision: "2" });
    await expect(pool.query(
      `SELECT count(*)::int AS count FROM harvest_toll_operations
       WHERE operation_key=$1`,
      [`oil-well:b:public-oil-harvest`]
    )).resolves.toMatchObject({ rows: [{ count: 1 }] });

    await access.updateToll({
      ownerPlayerId: "a",
      harvestType: "oil_well",
      tollGold: "20",
      expectedRevision: "1"
    });
    await pool.query(
      `UPDATE city_oil_well_production
       SET stored_crude_oil=2,production_cursor=clock_timestamp()
       WHERE structure_id=$1`,
      [structureId]
    );
    const inventoryBefore = await inventory.getInventorySnapshot("b");
    await expect(durable.harvestOilWell(
      "b",
      structureId,
      westPosition,
      "public-oil-insufficient"
    )).rejects.toMatchObject({ code: "INSUFFICIENT_GOLD" });
    await expect(pool.query(
      `SELECT stored_crude_oil FROM city_oil_well_production
       WHERE structure_id=$1`,
      [structureId]
    )).resolves.toMatchObject({ rows: [{ stored_crude_oil: 2 }] });
    expect((await inventory.getInventorySnapshot("b")).totals.crude_oil)
      .toBe(inventoryBefore.totals.crude_oil);
  });

  it("transfers 1, 37, 120, and 150 crude authoritatively and records matching Oil Worker intent", async () => {
    const cityId = await createCity(pool, "a", "Oil XP Matrix", hall, "open");
    await structures.buildHouse("a", houseA, "oil-xp-house");
    await inventory.grantItemsForOperation({
      operationKey: "oil-xp-resin",
      playerId: "a",
      source: "city_test_seed",
      grants: [{ itemId: "balsam_resin", variant: null, quantity: 150 }]
    });
    const durable = new CityStructureService(pool, "main", inventory, treasury, warehouse);
    const started = await durable.buildOilWell("a", cityId, westPosition, "oil-xp-build");
    await completeStructureNow(pool, durable, started.structure.structureId);
    const remotePosition = await projectPosition(pool, westPosition, 1_501, 90);

    let expectedXp = 0;
    for (const quantity of [1, 37, 120]) {
      await pool.query(
        `UPDATE city_oil_well_production
         SET stored_crude_oil=$2,production_cursor=clock_timestamp()
         WHERE structure_id=$1`,
        [started.structure.structureId, quantity]
      );
      const before = (await inventory.getInventorySnapshot("a")).totals.crude_oil;
      const result = await durable.harvestOilWell(
        "a", started.structure.structureId, westPosition, `oil-xp-${quantity}`
      );
      expectedXp += quantity;
      expect(result).toMatchObject({
        harvestedQuantity: quantity,
        masteryGrant: {
          requestedXp: quantity,
          grantedXp: quantity,
          resultingXp: expectedXp
        }
      });
      expect(result.inventory.totals.crude_oil).toBe(before + quantity);
      await expect(durable.harvestOilWell(
        "a", started.structure.structureId, westPosition, `oil-xp-${quantity}`
      )).resolves.toMatchObject({ replayed: true, harvestedQuantity: quantity });
    }

    await pool.query(
      `UPDATE player_profession_progress SET xp=25000,rank=8
       WHERE player_id='a' AND profession_id='oil_worker'`
    );
    await pool.query(
      `UPDATE city_oil_well_production
       SET stored_crude_oil=150,production_cursor=clock_timestamp()
       WHERE structure_id=$1`,
      [started.structure.structureId]
    );
    const master = await durable.harvestOilWell(
      "a", started.structure.structureId, remotePosition, "oil-xp-150", true
    );
    expect(master).toMatchObject({
      harvestedQuantity: 150,
      well: { capacity: 150, storedCrudeOil: 0 },
      masteryGrant: { requestedXp: 150, grantedXp: 0, resultingXp: 25_000 }
    });
  });

  it("durably constructs every player city structure for 30 seconds", async () => {
    const cityId = await createCity(pool, "a", "Durable", hall, "reserved");
    const durable = new CityStructureService(
      pool,
      "main",
      inventory,
      treasury,
      warehouse
    );
    const before = await inventoryTotals(pool, "a");
    const started = await durable.buildHouse("a", houseA, "durable-house");

    expect(started).toMatchObject({
      replayed: false,
      membership: null,
      structure: { state: "constructing", type: "city_house" }
    });
    expect(
      Date.parse(started.structure.constructionCompletesAt!) -
      Date.parse(started.structure.constructionStartedAt!)
    ).toBe(CITY_HOUSE_BUILD_DURATION_MS);
    expect(await durable.reconcileDueConstruction()).toEqual([]);
    await expect(durable.getActiveHouse(started.structure.structureId))
      .resolves.toBeNull();
    await expect(pool.query(
      "SELECT count(*)::int AS count FROM city_memberships WHERE player_id='a'"
    )).resolves.toMatchObject({ rows: [{ count: 0 }] });

    const replay = await durable.buildHouse("a", houseA, "durable-house");
    expect(replay).toMatchObject({
      replayed: true,
      structure: { structureId: started.structure.structureId }
    });
    expect(await inventoryTotals(pool, "a")).toEqual({
      stone: before.stone - 14,
      wood: before.wood - 28
    });

    await pool.query(
      `UPDATE city_structures
       SET construction_started_at=clock_timestamp()-interval '70 seconds',
           construction_completes_at=clock_timestamp()-interval '10 seconds'
       WHERE structure_id=$1`,
      [started.structure.structureId]
    );
    await pool.query(
      `UPDATE cities
       SET mayor_house_deadline=clock_timestamp()-interval '30 seconds'
       WHERE id=$1`,
      [cityId]
    );
    await expect(durable.reconcileExpiredFounderClaimDeadlines()).resolves.toContain(cityId);

    const restarted = new CityStructureService(
      pool,
      "main",
      inventory,
      treasury,
      warehouse
    );
    const completed = await restarted.reconcileDueConstruction();
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      structure: {
        structureId: started.structure.structureId,
        state: "active",
        type: "city_house"
      },
      membership: { cityId, role: "member" }
    });
    await expect(pool.query(
      `SELECT mayor_player_id,mayor_confirmed_at,mayor_house_deadline
       FROM cities WHERE id=$1`,
      [cityId]
    )).resolves.toMatchObject({
      rows: [{
        mayor_player_id: null,
        mayor_confirmed_at: null,
        mayor_house_deadline: null
      }]
    });
    await restarted.claimMayor("a", cityId, "durable-claim");

    await creditCityCoins(
      pool,
      treasury,
      cityId,
      "a",
      started.structure.structureId,
      200,
      "durable-warehouse"
    );
    const warehouseBuild = await restarted.buildFacility(
      "a",
      cityId,
      "warehouse",
      warehousePosition,
      "durable-warehouse"
    );
    expect(warehouseBuild.state).toBe("constructing");
    expect(
      Date.parse(warehouseBuild.constructionCompletesAt!) -
      Date.parse(warehouseBuild.constructionStartedAt!)
    ).toBe(CITY_STRUCTURE_BUILD_DURATION_MS);
    await expect(restarted.activeConstructionForPlayer("a")).resolves.toMatchObject({
      action: "build_facility",
      structureId: warehouseBuild.structureId
    });
    const cityRevision = await pool.query<{ spatial_revision: string }>(
      "SELECT spatial_revision::text FROM cities WHERE id=$1",
      [cityId]
    );
    await expect(restarted.buildMarket(
      "a",
      cityId,
      westPosition,
      "durable-overlap",
      cityRevision.rows[0]!.spatial_revision
    )).rejects.toMatchObject({
      code: "CITY_CONSTRUCTION_ALREADY_ACTIVE"
    });
    await expect(
      warehouse.open("a", warehouseBuild.structureId, warehousePosition)
    ).rejects.toMatchObject({ code: "CITY_WAREHOUSE_ACCESS_DENIED" });
    await expect(
      restarted.buildFacility(
        "a",
        cityId,
        "warehouse",
        westPosition,
        "durable-warehouse-conflict"
      )
    ).rejects.toMatchObject({ code: "CITY_CONSTRUCTION_ALREADY_ACTIVE" });
    await expect(
      restarted.buildFacility(
        "a",
        cityId,
        "armory" as never,
        warehousePosition,
        "durable-spacing-conflict"
      )
    ).rejects.toMatchObject({ code: "CITY_FACILITY_NOT_FOUND" });
    await expect(
      restarted.buildFacility(
        "a",
        cityId,
        "weaponsmith" as never,
        warehousePosition,
        "durable-weaponsmith-unavailable"
      )
    ).rejects.toMatchObject({ code: "CITY_FACILITY_NOT_FOUND" });
  });

  it("resolves facility and civic builds from the standing city territory", async () => {
    const cityId = await createCity(pool, "a", "Current City", hall, "reserved");
    const staleCityId = await createCity(
      pool,
      "b",
      "Stale City",
      { lat: 37, lon: -108 },
      "reserved"
    );
    const house = await structures.buildHouse("a", houseA, "current-city-house");
    await structures.claimMayor("a", cityId, "current-city-mayor");
    await creditCityCoins(
      pool,
      treasury,
      cityId,
      "a",
      house.membership!.houseStructureId,
      2_000,
      "current-city-credit"
    );

    const warehouseStructure = await structures.buildFacility(
      "a",
      staleCityId,
      "warehouse",
      warehousePosition,
      "current-city-warehouse"
    );
    expect(warehouseStructure).toMatchObject({
      cityId,
      type: "warehouse",
      state: "active"
    });

    await grantMaterials(inventory, "a", 1_000, 1_000, "current-city-market");
    await warehouse.donateAllEligible(
      "a",
      warehouseStructure.structureId,
      warehousePosition,
      "current-city-market-materials"
    );
    await pool.query(
      `INSERT INTO city_gold_reserves (city_id,balance,lifetime_donated)
       VALUES ($1,5000,5000)
       ON CONFLICT (city_id) DO UPDATE
       SET balance=5000,lifetime_donated=5000+city_gold_reserves.lifetime_spent`,
      [cityId]
    );
    const revision = await pool.query<{ spatial_revision: string }>(
      "SELECT spatial_revision::text FROM cities WHERE id=$1",
      [cityId]
    );

    const market = await structures.buildMarket(
      "a",
      staleCityId,
      westPosition,
      "current-city-market",
      revision.rows[0]!.spatial_revision
    );
    expect(market).toMatchObject({
      cityId,
      type: "market",
      state: "constructing"
    });
  });

  it("builds and upgrades all three Monument types while rejecting a duplicate live type", async () => {
    const cityId = await createCity(pool, "a", "Three Monuments", hall, "reserved");
    const house = await structures.buildHouse("a", houseA, "monuments-house");
    await structures.claimMayor("a", cityId, "monuments-claim");
    await creditCityCoins(
      pool,
      treasury,
      cityId,
      "a",
      house.membership!.houseStructureId,
      10_000,
      "monuments"
    );
    await structures.buildFacility(
      "a",
      cityId,
      "warehouse",
      warehousePosition,
      "monuments-warehouse"
    );
    await pool.query(
      `INSERT INTO city_warehouse_stacks (city_id,slot_index,item_id,variant,quantity)
       VALUES ($1,1,'wood','default',500),
              ($1,2,'wood','default',500),
              ($1,3,'wood','default',500),
              ($1,4,'wood','default',500),
              ($1,5,'wood','default',500),
              ($1,6,'wood','default',500),
              ($1,7,'stone','default',250),
              ($1,8,'stone','default',250),
              ($1,9,'stone','default',100)`,
      [cityId]
    );
    await pool.query(
      `INSERT INTO city_gold_reserves (city_id,balance,lifetime_donated)
       VALUES ($1,5000,5000)
       ON CONFLICT (city_id) DO UPDATE
       SET balance=5000,lifetime_donated=5000+city_gold_reserves.lifetime_spent`,
      [cityId]
    );

    const durable = new CityStructureService(
      pool,
      "main",
      inventory,
      treasury,
      warehouse
    );
    const positions = await Promise.all([
      projectPosition(pool, hall, 800, 45),
      projectPosition(pool, hall, 800, 165),
      projectPosition(pool, hall, 800, 285)
    ]);
    const monumentTypes = ["mining", "forestry", "hunting"] as const;
    const monuments = [];
    for (const [index, districtType] of monumentTypes.entries()) {
      const revisions = await pool.query<{
        spatial_revision: string;
        district_revision: string;
      }>(
        `SELECT spatial_revision::text,district_revision::text
         FROM cities WHERE id=$1`,
        [cityId]
      );
      const started = await durable.buildMonument(
        "a",
        cityId,
        districtType,
        positions[index]!,
        `monument-${districtType}`,
        revisions.rows[0]!.spatial_revision,
        revisions.rows[0]!.district_revision
      );
      await completeStructureNow(pool, durable, started.structureId);
      monuments.push({ ...started, position: positions[index]! });
    }

    const constructionEvent = await pool.query<{
      prior_district_revision: string;
      district_revision: string;
      prior_city_revision: string;
      city_revision: string;
    }>(
      `SELECT prior_district_revision::text,district_revision::text,
              prior_city_revision::text,city_revision::text
       FROM city_district_events
       WHERE structure_id=$1 AND event_type='monument_construction_started'`,
      [monuments[0]!.structureId]
    );
    expect(constructionEvent.rows).toHaveLength(1);
    expect(BigInt(constructionEvent.rows[0]!.district_revision)).toBe(
      BigInt(constructionEvent.rows[0]!.prior_district_revision) + 1n
    );
    expect(BigInt(constructionEvent.rows[0]!.city_revision)).toBe(
      BigInt(constructionEvent.rows[0]!.prior_city_revision) + 1n
    );

    await expect(pool.query(
      `SELECT district_type,tier,state FROM city_structures
       WHERE city_id=$1 AND structure_type='monument' AND state='active'
       ORDER BY district_type`,
      [cityId]
    )).resolves.toMatchObject({
      rows: [
        { district_type: "forestry", tier: 1, state: "active" },
        { district_type: "hunting", tier: 1, state: "active" },
        { district_type: "mining", tier: 1, state: "active" }
      ]
    });

    const duplicateRevisions = await pool.query<{
      spatial_revision: string;
      district_revision: string;
    }>(
      `SELECT spatial_revision::text,district_revision::text
       FROM cities WHERE id=$1`,
      [cityId]
    );
    await expect(durable.buildMonument(
      "a",
      cityId,
      "mining",
      hall,
      "monument-mining-duplicate",
      duplicateRevisions.rows[0]!.spatial_revision,
      duplicateRevisions.rows[0]!.district_revision
    )).rejects.toMatchObject({ code: "CITY_MONUMENT_ALREADY_EXISTS" });

    for (const monument of monuments) {
      for (const targetTier of [2, 3] as const) {
        await pool.query(
          `UPDATE city_gold_reserves
           SET balance=5000,lifetime_donated=5000+lifetime_spent
           WHERE city_id=$1`,
          [cityId]
        );
        const districtRevision = await pool.query<{ district_revision: string }>(
          `SELECT district_revision::text FROM cities WHERE id=$1`,
          [cityId]
        );
        const identity = await structureIdentity(pool, monument.structureId);
        const upgraded = await durable.upgradeMonument(
          "a",
          monument.structureId,
          (targetTier - 1) as 1 | 2,
          identity.placementRevision,
          districtRevision.rows[0]!.district_revision,
          monument.position,
          `upgrade-${monument.districtType}-${targetTier}`
        );
        await completeStructureNow(pool, durable, upgraded.structureId);
      }
    }

    await expect(pool.query(
      `SELECT district_type,tier FROM city_structures
       WHERE city_id=$1 AND structure_type='monument' AND state='active'
       ORDER BY district_type`,
      [cityId]
    )).resolves.toMatchObject({
      rows: [
        { district_type: "forestry", tier: 3 },
        { district_type: "hunting", tier: 3 },
        { district_type: "mining", tier: 3 }
      ]
    });
  });

  it("cancels a durable city build on movement and fully refunds its payer and treasury", async () => {
    const cityId = await createCity(pool, "a", "Cancel Build", hall, "reserved");
    const durable = new CityStructureService(
      pool,
      "main",
      inventory,
      treasury,
      warehouse
    );
    const house = await durable.buildHouse("a", houseA, "cancel-house");
    await completeStructureNow(pool, durable, house.structure.structureId);
    await durable.claimMayor("a", cityId, "cancel-claim");
    await creditCityCoins(
      pool,
      treasury,
      cityId,
      "a",
      house.structure.structureId,
      200,
      "cancel-warehouse-credit"
    );
    const inventoryBefore = await inventory.getInventorySnapshot("a");
    const treasuryBefore = await treasury.snapshot(cityId);
    const started = await durable.buildFacility(
      "a",
      cityId,
      "warehouse",
      warehousePosition,
      "cancel-warehouse"
    );

    const cancelled = await durable.cancelConstructionForMovement("a");

    expect(cancelled).toMatchObject({
      action: "build_facility",
      structure: {
        structureId: started.structureId,
        type: "warehouse",
        state: "destroyed"
      }
    });
    expect((await inventory.getInventorySnapshot("a")).totals).toEqual(inventoryBefore.totals);
    expect((await treasury.snapshot(cityId)).balance).toBe(treasuryBefore.balance);
    await expect(durable.activeConstructionForPlayer("a")).resolves.toBeNull();
  });

  it("restores an active city upgrade and its shared resources when movement cancels it", async () => {
    const cityId = await createCity(pool, "a", "Cancel Upgrade", hall, "reserved");
    const house = await structures.buildHouse("a", houseA, "cancel-upgrade-house");
    await structures.claimMayor("a", cityId, "cancel-upgrade-claim");
    await creditCityCoins(
      pool,
      treasury,
      cityId,
      "a",
      house.membership!.houseStructureId,
      1_000,
      "cancel-upgrade-credit"
    );
    const activeWarehouse = await structures.buildFacility(
      "a",
      cityId,
      "warehouse",
      warehousePosition,
      "cancel-upgrade-warehouse"
    );
    await warehouse.donateAllEligible(
      "a",
      activeWarehouse.structureId,
      warehousePosition,
      "cancel-upgrade-materials"
    );
    const durable = new CityStructureService(
      pool,
      "main",
      inventory,
      treasury,
      warehouse
    );
    const materialsBefore = await warehouseMaterials(pool, cityId);
    const treasuryBefore = await treasury.snapshot(cityId);
    const started = await durable.upgradeFacility(
      "a",
      activeWarehouse.structureId,
      1,
      warehousePosition,
      "cancel-upgrade"
    );
    expect(started).toMatchObject({ state: "constructing", tier: 2 });

    const cancelled = await durable.cancelConstructionForMovement("a");

    expect(cancelled).toMatchObject({
      action: "upgrade_facility",
      structure: { structureId: activeWarehouse.structureId, state: "active", tier: 1 }
    });
    expect(await warehouseMaterials(pool, cityId)).toEqual(materialsBefore);
    expect((await treasury.snapshot(cityId)).balance).toBe(treasuryBefore.balance);
  });

  it("accepts the exact House exclusion distance and rejects any smaller distance", async () => {
    await createCity(pool, "a", "Boundary", hall, "reserved");
    const durable = new CityStructureService(
      pool,
      "main",
      inventory,
      treasury,
      warehouse
    );
    await durable.buildHouse("a", houseA, "boundary-anchor");
    const tooClose = await projectPosition(pool, houseA, 319.99, 90);
    const exact = await projectPosition(pool, houseA, 320, 90);

    await expect(durable.buildHouse("c", tooClose, "boundary-too-close"))
      .rejects.toMatchObject({
        code: "CITY_STRUCTURE_CLEARANCE_REQUIRED",
        details: {
          blockingStructureType: "city_house",
          requiredCenterDistanceM: 320
        }
      });
    await expect(durable.buildHouse("b", exact, "boundary-exact"))
      .resolves.toMatchObject({ structure: { state: "constructing" } });
  });

  it("builds house-backed membership exactly once and rejects invalid or duplicate placement atomically", async () => {
    const cityId = await createCity(pool, "a", "Alpha", hall, "reserved");
    const kingdomId = randomUUID();
    await pool.query(
      `INSERT INTO kingdoms (
         id, normalized_name, display_name, founder_player_id, leader_player_id, founding_request_id
       ) VALUES ($1,$2,$3,'a','a',$4)`,
      [kingdomId, `kingdom-${kingdomId.slice(0, 8)}`, "Alpha Kingdom", randomUUID()]
    );
    await pool.query(
      `INSERT INTO kingdom_memberships (
         id, kingdom_id, player_id, role, status, joined_at, perk_qualified_at
       ) VALUES ($1,$2,'a','leader','active',now(),now())`,
      [randomUUID(), kingdomId]
    );

    const beforeBuild = await inventoryTotals(pool, "a");
    const built = await structures.buildHouse("a", houseA, "house-a");
    const replay = await structures.buildHouse("a", { lat: 34, lon: -106 }, "house-a");

    expect(built).toMatchObject({
      replayed: false,
      structure: { cityId, type: "city_house", ownerPlayerId: "a" },
      membership: { cityId, role: "member" }
    });
    expect(replay).toMatchObject({
      replayed: true,
      structure: { structureId: built.structure.structureId }
    });
    await expect(structures.getActiveHouse(built.structure.structureId)).resolves.toMatchObject({
      structureId: built.structure.structureId,
      cityId,
      type: "city_house",
      lat: houseA.lat,
      lon: houseA.lon
    });
    expect(await inventoryTotals(pool, "a")).toEqual({
      stone: beforeBuild.stone - 14,
      wood: beforeBuild.wood - 28
    });
    await expect(pool.query(
      `SELECT count(*)::int AS count
       FROM city_memberships WHERE player_id='a' AND left_at IS NULL`
    )).resolves.toMatchObject({ rows: [{ count: 1 }] });
    await expect(pool.query(
      `SELECT count(*)::int AS count
       FROM kingdom_memberships WHERE player_id='a' AND status='active'`
    )).resolves.toMatchObject({ rows: [{ count: 1 }] });
    await expect(pool.query(
      `SELECT mayor_player_id,mayor_confirmed_at IS NOT NULL AS confirmed,
              mayor_house_deadline
       FROM cities WHERE id=$1`,
      [cityId]
    )).resolves.toMatchObject({
      rows: [{
        mayor_player_id: null,
        confirmed: false,
        mayor_house_deadline: expect.any(Date)
      }]
    });

    const beforeInvalid = await inventoryTotals(pool, "b");
    await expect(
      structures.buildHouse("b", { lat: 35.009, lon: -106 }, "outside-footprint")
    ).rejects.toMatchObject({ code: "CITY_STRUCTURE_FOOTPRINT_OUTSIDE_TERRITORY" });
    expect(await inventoryTotals(pool, "b")).toEqual(beforeInvalid);
    await expect(
      structures.buildHouse("c", { lat: 34, lon: -106 }, "outside-city")
    ).rejects.toMatchObject({
      code: "CITY_HOUSE_CITY_TERRITORY_REQUIRED",
      message: "Stand inside active city territory to build a City House."
    });
    expect(await inventoryTotals(pool, "c")).toEqual({ stone: 1_000, wood: 1_000 });

    const durable = new CityStructureService(
      pool,
      "main",
      inventory,
      treasury,
      warehouse
    );
    const competing = await Promise.allSettled([
      durable.buildHouse("b", houseB, "parallel-one"),
      durable.buildHouse("b", warehousePosition, "parallel-two")
    ]);
    expect(competing.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(competing.filter(({ status }) => status === "rejected")).toHaveLength(1);
    await expect(pool.query(
      `SELECT count(*)::int AS houses
       FROM city_structures
       WHERE owner_player_id='b' AND state IN ('constructing','active')
         AND structure_type IN ('city_house','mayor_house')`
    )).resolves.toMatchObject({ rows: [{ houses: 1 }] });
  });

  it("fails safely when more than one active city controls the standing location", async () => {
    await createCity(pool, "a", "Alpha", hall, "open");
    await createCity(pool, "b", "Beta", { lat: 35.0135, lon: -106 }, "open");
    const before = await inventoryTotals(pool, "c");

    await expect(
      structures.buildHouse("c", { lat: 35.00675, lon: -106 }, "overlapping-cities")
    ).rejects.toMatchObject({ code: "CITY_HOUSE_CITY_TERRITORY_AMBIGUOUS" });
    expect(await inventoryTotals(pool, "c")).toEqual(before);
  });

  it("serializes mayor claims, preserves single-city membership, and permits immediate foreign rejoining", async () => {
    const cityId = await createCity(pool, "a", "Vacant", hall, "open");
    const foreignCityId = await createCity(
      pool,
      "c",
      "Foreign",
      { lat: 36, lon: -107 },
      "open"
    );
    await structures.buildHouse("a", houseA, "a-house");
    await structures.buildHouse("b", houseB, "b-house");

    const claims = await Promise.allSettled([
      structures.claimMayor("a", cityId, "claim-a"),
      structures.claimMayor("b", cityId, "claim-b")
    ]);
    expect(claims.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(claims.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect(claims.find(({ status }) => status === "rejected")).toMatchObject({
      reason: {
        code: "CITY_MAYOR_ALREADY_CLAIMED",
        message: "This city already has a Mayor."
      }
    });
    const mayor = await pool.query<{ mayor_player_id: string }>(
      "SELECT mayor_player_id FROM cities WHERE id=$1",
      [cityId]
    );
    const winner = mayor.rows[0]!.mayor_player_id;
    expect(["a", "b"]).toContain(winner);
    await expect(
      structures.claimMayor(winner, cityId, `claim-${winner}`)
    ).resolves.toMatchObject({ replayed: true });
    await expect(pool.query(
      `SELECT owner_player_id,structure_type
       FROM city_structures
       WHERE city_id=$1 AND state='active'
       ORDER BY owner_player_id`,
      [cityId]
    )).resolves.toMatchObject({
      rows: [
        {
          owner_player_id: "a",
          structure_type: winner === "a" ? "mayor_house" : "city_house"
        },
        {
          owner_player_id: "b",
          structure_type: winner === "b" ? "mayor_house" : "city_house"
        }
      ]
    });
    await structures.relinquishMayor(winner, cityId, `relinquish-${winner}`);
    await expect(pool.query(
      `SELECT founder_player_id,mayor_player_id,mayor_confirmed_at,mayor_house_deadline
       FROM cities WHERE id=$1`,
      [cityId]
    )).resolves.toMatchObject({
      rows: [{
        founder_player_id: "a",
        mayor_player_id: null,
        mayor_confirmed_at: null,
        mayor_house_deadline: null
      }]
    });

    await expect(
      structures.buildHouse(
        winner,
        { lat: 36.00405, lon: -107 },
        `already-member-${winner}`
      )
    ).rejects.toMatchObject({ code: "CITY_ALREADY_MEMBER" });

    const winnerHouse = await activeHouseIdentity(pool, winner);
    const destroyed = await structures.destroyHouse(
      winner,
      winnerHouse.structureId,
      winnerHouse.placementRevision,
      `destroy-${winner}`
    );
    expect(destroyed.membership).toBeNull();
    await expect(pool.query(
      `SELECT ended_reason,previous_city_id,foreign_city_block_until
       FROM city_memberships
       WHERE player_id=$1 AND left_at IS NOT NULL
       ORDER BY left_at DESC LIMIT 1`,
      [winner]
    )).resolves.toMatchObject({
      rows: [{
        ended_reason: "house_destroyed",
        previous_city_id: null,
        foreign_city_block_until: null
      }]
    });

    await pool.query(
      `UPDATE city_memberships
       SET previous_city_id=city_id,
           foreign_city_block_until=now()+interval '24 hours'
       WHERE player_id=$1 AND city_id=$2 AND left_at IS NOT NULL`,
      [winner, cityId]
    );
    const foreign = await structures.buildHouse(
      winner,
      { lat: 36.00405, lon: -107 },
      `foreign-${winner}`
    );
    expect(foreign.membership).toMatchObject({
      cityId: foreignCityId,
      role: "member"
    });
  });

  it("enforces the founder reservation until the exact deadline and requires an explicit claim", async () => {
    const cityId = await createCity(pool, "a", "Reserved", hall, "reserved");
    const deadline = await pool.query<{ remaining: number }>(
      `SELECT EXTRACT(EPOCH FROM (mayor_house_deadline-now()))::int AS remaining
       FROM cities WHERE id=$1`,
      [cityId]
    );
    expect(deadline.rows[0]!.remaining).toBeGreaterThanOrEqual(895);
    expect(deadline.rows[0]!.remaining).toBeLessThanOrEqual(900);

    await expect(
      structures.claimMayor("a", cityId, "founder-without-house")
    ).rejects.toMatchObject({ code: "CITY_MAYOR_REQUIRED_MEMBERSHIP" });
    const founderHouse = await structures.buildHouse("a", houseA, "founder-house");
    const memberHouse = await structures.buildHouse("b", houseB, "member-house");
    expect(founderHouse).toMatchObject({
      structure: { type: "city_house" },
      membership: { role: "member" }
    });
    expect(memberHouse).toMatchObject({
      structure: { type: "city_house" },
      membership: { role: "member" }
    });
    await expect(pool.query(
      `SELECT mayor_player_id,mayor_house_deadline,
              mayor_confirmed_at IS NOT NULL AS confirmed
       FROM cities WHERE id=$1`,
      [cityId]
    )).resolves.toMatchObject({
      rows: [{
        mayor_player_id: null,
        mayor_house_deadline: expect.any(Date),
        confirmed: false
      }]
    });
    await expect(
      structures.claimMayor("b", cityId, "reserved-member-claim")
    ).rejects.toMatchObject({
      code: "CITY_MAYOR_FOUNDER_RESERVED",
      message: "Only the city founder may claim Mayor before the founder reservation expires."
    });

    const claimed = await structures.claimMayor("a", cityId, "founder-claim");
    expect(claimed).toMatchObject({
      replayed: false,
      structure: { type: "mayor_house", ownerPlayerId: "a" },
      membership: { role: "mayor" }
    });
    await expect(
      structures.claimMayor("a", cityId, "founder-claim")
    ).resolves.toMatchObject({ replayed: true });
    await expect(pool.query(
      `SELECT founder_player_id,mayor_player_id,
              mayor_confirmed_at IS NOT NULL AS confirmed,mayor_house_deadline
       FROM cities WHERE id=$1`,
      [cityId]
    )).resolves.toMatchObject({
      rows: [{
        founder_player_id: "a",
        mayor_player_id: "a",
        confirmed: true,
        mayor_house_deadline: null
      }]
    });

    await structures.relinquishMayor("a", cityId, "founder-relinquish");
    await expect(pool.query(
      `SELECT founder_player_id,mayor_player_id,mayor_confirmed_at,mayor_house_deadline
       FROM cities WHERE id=$1`,
      [cityId]
    )).resolves.toMatchObject({
      rows: [{
        founder_player_id: "a",
        mayor_player_id: null,
        mayor_confirmed_at: null,
        mayor_house_deadline: null
      }]
    });
    await expect(
      structures.claimMayor("b", cityId, "claim-after-relinquish")
    ).resolves.toMatchObject({
      structure: { type: "mayor_house", ownerPlayerId: "b" },
      membership: { role: "mayor" }
    });

    const boundaryCityId = await createCity(
      pool,
      "c",
      "Boundary",
      { lat: 36, lon: -107 },
      "reserved"
    );
    await structures.buildHouse("c", { lat: 36.00405, lon: -107 }, "boundary-founder");
    await structures.buildHouse("d", { lat: 36, lon: -106.99507 }, "boundary-member");
    await pool.query(
      "UPDATE cities SET mayor_house_deadline=clock_timestamp() WHERE id=$1",
      [boundaryCityId]
    );
    await expect(
      structures.claimMayor("d", boundaryCityId, "exact-deadline-claim")
    ).resolves.toMatchObject({ membership: { role: "mayor" } });
    await structures.relinquishMayor("d", boundaryCityId, "boundary-relinquish");
    await expect(
      structures.claimMayor("c", boundaryCityId, "founder-after-deadline")
    ).resolves.toMatchObject({ membership: { role: "mayor" } });

    const expiredId = await createCity(
      pool,
      "e",
      "Expired",
      { lat: 37, lon: -108 },
      "reserved"
    );
    await pool.query(
      "UPDATE cities SET mayor_house_deadline=clock_timestamp()-interval '1 second' WHERE id=$1",
      [expiredId]
    );
    const restarted = new CityStructureService(
      pool,
      "main",
      inventory,
      treasury,
      warehouse
    );
    await expect(restarted.reconcileExpiredFounderClaimDeadlines()).resolves.toContain(expiredId);
    await expect(pool.query(
      "SELECT mayor_player_id,mayor_house_deadline FROM cities WHERE id=$1",
      [expiredId]
    )).resolves.toMatchObject({
      rows: [{ mayor_player_id: null, mayor_house_deadline: null }]
    });
  });

  it("normalizes grandfathered oversized Warehouse stacks on open", async () => {
    const cityId = await createCity(pool, "a", "Warehouse Repair", hall, "reserved");
    const house = await structures.buildHouse("a", houseA, "warehouse-repair-house");
    await structures.claimMayor("a", cityId, "warehouse-repair-claim");
    await creditCityCoins(pool, treasury, cityId, "a", house.membership!.houseStructureId, 1_000);
    const facility = await structures.buildFacility(
      "a",
      cityId,
      "warehouse",
      warehousePosition,
      "warehouse-repair-build"
    );
    try {
      await pool.query("UPDATE item_definitions SET max_stack=1000 WHERE item_id='iron_bar'");
      await pool.query(
        `INSERT INTO city_warehouse_stacks
           (city_id,slot_index,item_id,variant,quantity)
         VALUES ($1,0,'iron_bar','default',125)`,
        [cityId]
      );
    } finally {
      await pool.query("UPDATE item_definitions SET max_stack=50 WHERE item_id='iron_bar'");
    }

    const normalized = await warehouse.open("a", facility.structureId, warehousePosition);
    expect(normalized.stacks.map(({ quantity }) => quantity)).toEqual([50, 50, 25]);
    expect(normalized.stacks.reduce((total, stack) => total + stack.quantity, 0)).toBe(125);
    await expect(warehouse.open("a", facility.structureId, warehousePosition))
      .resolves.toEqual(normalized);
  });

  it("charges the Demolition Factory recipe exactly once and leaves omitted materials and City Coins untouched", async () => {
    const demolitionFactoryMaterials = [
      { itemId: "iron_bar", quantity: 100 },
      { itemId: "sulfur", quantity: 100 },
      { itemId: "cloth", quantity: 200 },
      { itemId: "wood", quantity: 500 }
    ] as const;
    const cityId = await createCity(pool, "a", "Factory Cost", hall, "reserved");
    const house = await structures.buildHouse("a", houseA, "factory-cost-house");
    await structures.claimMayor("a", cityId, "factory-cost-mayor");
    await creditCityCoins(
      pool,
      treasury,
      cityId,
      "a",
      house.membership!.houseStructureId,
      1_000,
      "factory-cost-coins"
    );
    await structures.buildFacility(
      "a",
      cityId,
      "warehouse",
      warehousePosition,
      "factory-cost-warehouse"
    );
    await seedWarehouseStacks(pool, cityId, [
      ...demolitionFactoryMaterials,
      { itemId: "simple_food", quantity: 1_000 },
      { itemId: "stone", quantity: 111 },
      { itemId: "leather", quantity: 222 }
    ]);
    const warehouseBefore = await warehouseMaterials(pool, cityId);
    const treasuryBefore = await treasury.snapshot(cityId);
    expect(treasuryBefore.balance).toBe("890");
    expect(warehouseBefore).toEqual([
      { item_id: "cloth", quantity: "200" },
      { item_id: "iron_bar", quantity: "100" },
      { item_id: "leather", quantity: "222" },
      { item_id: "simple_food", quantity: "1000" },
      { item_id: "stone", quantity: "111" },
      { item_id: "sulfur", quantity: "100" },
      { item_id: "wood", quantity: "500" }
    ]);

    const built = await structures.buildFacility(
      "a",
      cityId,
      "demolition_factory",
      westPosition,
      "factory-cost-build"
    );
    expect(built).toMatchObject({
      type: "demolition_factory",
      state: "active"
    });
    expect(await warehouseMaterials(pool, cityId)).toEqual([
      { item_id: "leather", quantity: "222" },
      { item_id: "simple_food", quantity: "1000" },
      { item_id: "stone", quantity: "111" }
    ]);
    expect(await treasury.snapshot(cityId)).toEqual(treasuryBefore);
    const replay = await structures.buildFacility(
      "a",
      cityId,
      "demolition_factory",
      westPosition,
      "factory-cost-build"
    );
    expect(replay).toMatchObject({
      structureId: built.structureId,
      type: "demolition_factory",
      state: "active"
    });
    expect(await warehouseMaterials(pool, cityId)).toEqual([
      { item_id: "leather", quantity: "222" },
      { item_id: "simple_food", quantity: "1000" },
      { item_id: "stone", quantity: "111" }
    ]);
    expect(await treasury.snapshot(cityId)).toEqual(treasuryBefore);
    await expect(pool.query<{
      item_id: string;
      quantity: string;
    }>(
      `SELECT item_id,quantity::text
       FROM city_structure_material_spend
       WHERE structure_id=$1::uuid
       ORDER BY item_id`,
      [built.structureId]
    )).resolves.toMatchObject({
      rows: [
        { item_id: "cloth", quantity: "200" },
        { item_id: "iron_bar", quantity: "100" },
        { item_id: "sulfur", quantity: "100" },
        { item_id: "wood", quantity: "500" }
      ]
    });

    const insufficientCityId = await createCity(
      pool,
      "b",
      "Factory Cost Insufficient",
      { lat: 36, lon: -106 },
      "reserved"
    );
    const insufficientHouse = await structures.buildHouse(
      "b",
      { lat: 36.00405, lon: -106 },
      "factory-cost-insufficient-house"
    );
    await structures.claimMayor("b", insufficientCityId, "factory-cost-insufficient-mayor");
    await creditCityCoins(
      pool,
      treasury,
      insufficientCityId,
      "b",
      insufficientHouse.membership!.houseStructureId,
      1_000,
      "factory-cost-insufficient-coins"
    );
    await structures.buildFacility(
      "b",
      insufficientCityId,
      "warehouse",
      { lat: 35.99595, lon: -106 },
      "factory-cost-insufficient-warehouse"
    );
    await seedWarehouseStacks(pool, insufficientCityId, [
      { itemId: "iron_bar", quantity: 100 },
      { itemId: "sulfur", quantity: 99 },
      { itemId: "simple_food", quantity: 1_000 },
      { itemId: "cloth", quantity: 200 },
      { itemId: "wood", quantity: 500 },
      { itemId: "stone", quantity: 111 },
      { itemId: "leather", quantity: 222 }
    ]);
    const insufficientBefore = await warehouseMaterials(pool, insufficientCityId);
    const insufficientTreasuryBefore = await treasury.snapshot(insufficientCityId);
    await expect(structures.buildFacility(
      "b",
      insufficientCityId,
      "demolition_factory",
      { lat: 36, lon: -106.00493 },
      "factory-cost-insufficient-build"
    )).rejects.toMatchObject({ code: "CITY_WAREHOUSE_MATERIALS_INSUFFICIENT" });
    expect(await warehouseMaterials(pool, insufficientCityId)).toEqual(insufficientBefore);
    expect(await treasury.snapshot(insufficientCityId)).toEqual(insufficientTreasuryBefore);
  }, 60_000);

  it("exposes the active personal military roster and serializes duplicate construction", async () => {
    const militaryCity = await createCity(pool, "a", "Military Roster", hall, "reserved");
    const house = await structures.buildHouse("a", houseA, "military-roster-house");
    await structures.claimMayor("a", militaryCity, "military-roster-mayor");
    await creditCityCoins(
      pool,
      treasury,
      militaryCity,
      "a",
      house.membership!.houseStructureId,
      1_000,
      "military-roster-coins"
    );
    await structures.buildFacility(
      "a",
      militaryCity,
      "warehouse",
      warehousePosition,
      "military-roster-warehouse"
    );
    const materialTotals = new Map<string, number>();
    for (const type of MILITARY_FACILITY_TYPES) {
      for (const material of MILITARY_CITY_FACILITY_COSTS[type].materials) {
        materialTotals.set(
          material.itemId,
          (materialTotals.get(material.itemId) ?? 0) + material.quantity
        );
      }
    }
    await seedWarehouseStacks(
      pool,
      militaryCity,
      [...materialTotals.entries()].map(([itemId, quantity]) => ({ itemId, quantity }))
    );

    const durable = new CityStructureService(
      pool,
      "main",
      inventory,
      treasury,
      warehouse
    );
    const barracks = await durable.buildFacility(
      "a",
      militaryCity,
      "barracks",
      westPosition,
      "military-roster-barracks"
    );
    await completeStructureNow(pool, durable, barracks.structureId);
    const demolitionFactory = await durable.buildFacility(
      "a",
      militaryCity,
      "demolition_factory",
      houseB,
      "military-roster-demolition-factory"
    );
    await completeStructureNow(pool, durable, demolitionFactory.structureId);

    await expect(durable.buildFacility(
      "a",
      militaryCity,
      "barracks",
      westPosition,
      "military-roster-barracks-duplicate"
    )).rejects.toMatchObject({ code: "CITY_FACILITY_ALREADY_EXISTS" });
    await expect(durable.buildFacility(
      "a",
      militaryCity,
      "demolition_factory",
      houseB,
      "military-roster-demolition-factory"
    )).resolves.toMatchObject({
      structureId: demolitionFactory.structureId,
      type: "demolition_factory"
    });

    const concurrentCity = await createCity(
      pool,
      "c",
      "Concurrent Military Roster",
      { lat: 36, lon: -107 },
      "reserved"
    );
    const concurrentHouse = await structures.buildHouse(
      "c",
      { lat: 36.00405, lon: -107 },
      "military-roster-concurrent-house"
    );
    await structures.claimMayor("c", concurrentCity, "military-roster-concurrent-mayor");
    await creditCityCoins(
      pool,
      treasury,
      concurrentCity,
      "c",
      concurrentHouse.membership!.houseStructureId,
      1_000,
      "military-roster-concurrent-coins"
    );
    await structures.buildFacility(
      "c",
      concurrentCity,
      "warehouse",
      { lat: 35.99595, lon: -107 },
      "military-roster-concurrent-warehouse"
    );
    await seedWarehouseStacks(pool, concurrentCity, [
      ...MILITARY_CITY_FACILITY_COSTS.barracks.materials,
      ...MILITARY_CITY_FACILITY_COSTS.demolition_factory.materials
    ]);
    const concurrentResults = await Promise.allSettled([
      durable.buildFacility(
        "c",
        concurrentCity,
        "barracks",
        { lat: 36, lon: -107.00493 },
        "military-roster-concurrent-a"
      ),
      durable.buildFacility(
        "c",
        concurrentCity,
        "barracks",
        { lat: 36, lon: -106.99507 },
        "military-roster-concurrent-b"
      )
    ]);
    expect(concurrentResults.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(concurrentResults.filter((result) => result.status === "rejected")).toHaveLength(1);
    const rejected = concurrentResults.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" ? rejected.reason : null).toMatchObject({
      code: "CITY_CONSTRUCTION_ALREADY_ACTIVE"
    });
    await expect(pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM city_structures
       WHERE owner_player_id=$1 AND structure_type='barracks'
         AND state IN ('constructing','active')`,
      ["c"]
    )).resolves.toMatchObject({ rows: [{ count: 1 }] });
  }, 90_000);

  it("keeps donations and construction atomic while enforcing facility costs and tier capacity", async () => {
    const cityId = await createCity(pool, "a", "Builders", hall, "reserved");
    const house = await structures.buildHouse("a", houseA, "builder-house");
    await structures.claimMayor("a", cityId, "builder-claim");
    await creditCityCoins(pool, treasury, cityId, "a", house.membership!.houseStructureId, 1_000);

    const initialPersonal = await inventoryTotals(pool, "a");
    const warehouseStructure = await structures.buildFacility(
      "a",
      cityId,
      "warehouse",
      warehousePosition,
      "warehouse-one"
    );
    expect(await inventoryTotals(pool, "a")).toEqual({
      stone: initialPersonal.stone - 75,
      wood: initialPersonal.wood - 100
    });
    await expect(warehouse.open("b", warehouseStructure.structureId, warehousePosition))
      .rejects.toMatchObject({ code: "CITY_WAREHOUSE_ACCESS_DENIED" });
    expect(CITY_WAREHOUSE_INTERACTION_RADIUS_M).toBe(CITY_STRUCTURE_INTERACTION_RADIUS_M);
    await expect(warehouse.open("a", warehouseStructure.structureId, {
      lat: warehousePosition.lat + 0.00018,
      lon: warehousePosition.lon
    })).resolves.toMatchObject({ structureId: warehouseStructure.structureId });
    await expect(warehouse.open("a", warehouseStructure.structureId, {
      lat: warehousePosition.lat + 0.00027,
      lon: warehousePosition.lon
    }))
      .rejects.toMatchObject({ code: "CITY_WAREHOUSE_ACCESS_DENIED" });

    const donated = await warehouse.donateAllEligible(
      "a",
      warehouseStructure.structureId,
      warehousePosition,
      "donate-materials"
    );
    const replay = await warehouse.donateAllEligible(
      "a",
      warehouseStructure.structureId,
      warehousePosition,
      "donate-materials"
    );
    expect(donated).toMatchObject({
      replayed: false,
      warehouse: { tier: 1, totalSlots: 60, canReorganize: true }
    });
    expect(donated.donatedQuantity).toBeGreaterThan(0);
    expect(replay).toMatchObject({ replayed: true, donatedQuantity: donated.donatedQuantity });
    await grantMaterials(inventory, "a", 1_000, 1_000, "second-load");
    await warehouse.donateAllEligible(
      "a",
      warehouseStructure.structureId,
      warehousePosition,
      "donate-second-load"
    );

    const tierTwo = await structures.upgradeFacility(
      "a",
      warehouseStructure.structureId,
      1,
      warehousePosition,
      "warehouse-two"
    );
    expect(tierTwo.tier).toBe(2);
    expect(await treasury.snapshot(cityId)).toMatchObject({ balance: "400", lifetimeSpent: "600" });

    const materialsBeforeFailure = await warehouseMaterials(pool, cityId);
    await expect(
      structures.upgradeFacility(
        "a",
        warehouseStructure.structureId,
        2,
        warehousePosition,
        "warehouse-three-insufficient"
      )
    ).rejects.toMatchObject({ code: "CITY_TREASURY_INSUFFICIENT" });
    expect(await warehouseMaterials(pool, cityId)).toEqual(materialsBeforeFailure);
    await expect(pool.query(
      "SELECT tier FROM city_structures WHERE structure_id=$1",
      [warehouseStructure.structureId]
    )).resolves.toMatchObject({ rows: [{ tier: 2 }] });

    await creditCityCoins(
      pool,
      treasury,
      cityId,
      "a",
      house.membership!.houseStructureId,
      2_000,
      "tier-three"
    );
    await expect(
      structures.upgradeFacility(
        "a",
        warehouseStructure.structureId,
        2,
        warehousePosition,
        "warehouse-three"
      )
    ).resolves.toMatchObject({ tier: 3 });
    await expect(warehouse.open("a", warehouseStructure.structureId, warehousePosition))
      .resolves.toMatchObject({ tier: 3, totalSlots: 160 });
    await pool.query(
      `INSERT INTO city_warehouse_stacks (city_id,slot_index,item_id,variant,quantity)
       VALUES ($1,99,'stone','mossy',7)`,
      [cityId]
    );
    const treasuryBeforeDestroy = await treasury.snapshot(cityId);

    await expect(structures.destroyFacility(
      "a",
      warehouseStructure.structureId,
      "0",
      warehousePosition,
      "destroy-warehouse-stale"
    )).rejects.toMatchObject({ code: "CITY_FACILITY_STALE" });
    expect((await warehouseMaterials(pool, cityId)).length).toBeGreaterThan(0);
    const destroyedWarehouse = await structures.destroyFacility(
      "a",
      warehouseStructure.structureId,
      (await structureIdentity(pool, warehouseStructure.structureId)).placementRevision,
      warehousePosition,
      "destroy-warehouse"
    );
    const destroyedDrops = destroyedWarehouse.droppedItems ?? [];
    expect(destroyedDrops.length).toBeGreaterThan(0);
    expect(destroyedDrops.every((drop) => drop.quantity > 0)).toBe(true);
    expect(destroyedDrops).toEqual(expect.arrayContaining([
      expect.objectContaining({ itemId: "stone", variant: "mossy", quantity: 7 })
    ]));
    await expect(pool.query(
      `SELECT item_id,invested_quantity::text,refund_quantity::text
       FROM city_structure_refunds
       WHERE structure_id=$1
       ORDER BY item_id`,
      [warehouseStructure.structureId]
    )).resolves.toMatchObject({
      rows: [
        { item_id: "stone", invested_quantity: "95", refund_quantity: "31" },
        { item_id: "wood", invested_quantity: "700", refund_quantity: "233" }
      ]
    });
    expect(await treasury.snapshot(cityId)).toEqual(treasuryBeforeDestroy);
    const replayedWarehouse = await structures.destroyFacility(
      "a",
      warehouseStructure.structureId,
      (await structureIdentity(pool, warehouseStructure.structureId)).placementRevision,
      warehousePosition,
      "destroy-warehouse"
    );
    expect((replayedWarehouse.droppedItems ?? []).map((drop) => drop.dropId))
      .toEqual(destroyedDrops.map((drop) => drop.dropId));
    const partialPickup = await new DroppedItemService(pool).pickupDroppedItem(
      playerRecordAt("a", warehousePosition),
      "destroyed-warehouse-partial-pickup",
      destroyedDrops[0]!.dropId,
      { mode: "quantity", quantity: 1 }
    );
    expect(partialPickup).toMatchObject({
      pickedUpQuantity: 1,
      remainingQuantity: destroyedDrops[0]!.quantity - 1
    });
    const pickedInventory = {
      stone: destroyedDrops[0]!.itemId === "stone" ? 1 : 0,
      wood: destroyedDrops[0]!.itemId === "wood" ? 1 : 0
    };
    expect(await warehouseMaterials(pool, cityId)).toEqual([]);
    expect(await inventoryTotals(pool, "a")).toEqual(pickedInventory);
    await expect(
      structures.buildFacility(
        "a",
        cityId,
        "warehouse",
        warehousePosition,
        "rebuild-warehouse"
      )
    ).rejects.toThrow("Inventory does not contain enough items");
    expect(await inventoryTotals(pool, "a")).toEqual(pickedInventory);
  });

  it("lets only the confirmed Mayor consolidate and reorganize Warehouse donations without losing quantities", async () => {
    const cityId = await createCity(pool, "a", "Organizers", hall, "reserved");
    const house = await structures.buildHouse("a", houseA, "organizer-house");
    await structures.claimMayor("a", cityId, "organizer-claim");
    await creditCityCoins(
      pool,
      treasury,
      cityId,
      "a",
      house.membership!.houseStructureId,
      110,
      "organizer-warehouse"
    );
    const warehouseStructure = await structures.buildFacility(
      "a",
      cityId,
      "warehouse",
      warehousePosition,
      "organizer-warehouse"
    );
    const donated = await warehouse.donateAllEligible(
      "a",
      warehouseStructure.structureId,
      warehousePosition,
      "organizer-donation"
    );
    const movedStack = donated.warehouse.stacks[0]!;
    const scattered = await warehouse.move(
      "a",
      warehouseStructure.structureId,
      warehousePosition,
      "organizer-scatter",
      movedStack.stackId,
      12
    );
    const legacyStacks = await pool.query<{ stack_id: string; slot_index: number }>(
      `INSERT INTO city_warehouse_stacks (
         city_id,slot_index,item_id,variant,quantity
       ) VALUES
         ($1,20,'crude_oil','default',125),
         ($1,21,'crude_oil','default',125)
       RETURNING stack_id::text,slot_index`,
      [cityId]
    );
    const legacyBySlot = new Map(
      legacyStacks.rows.map((stack) => [stack.slot_index, stack.stack_id])
    );
    const beforeReorganize = await warehouse.open(
      "a",
      warehouseStructure.structureId,
      warehousePosition
    );
    await structures.buildHouse("b", houseB, "organizer-member-house");
    await expect(warehouse.reorganize(
      "b",
      warehouseStructure.structureId,
      warehousePosition,
      "member-reorganize"
    )).rejects.toMatchObject({ code: "CITY_MAYOR_PERMISSION_DENIED" });

    const reorganized = await warehouse.reorganize(
      "a",
      warehouseStructure.structureId,
      warehousePosition,
      "mayor-reorganize"
    );
    expect(reorganized.warehouse.stacks.map((stack) => stack.slotIndex))
      .toEqual(reorganized.warehouse.stacks.map((_, index) => index));
    expect(reorganized.warehouse.usedSlots).toBe(beforeReorganize.usedSlots - 1);
    expect(reorganized.warehouse.stacks.filter((stack) => stack.itemId === "crude_oil"))
      .toEqual([
        expect.objectContaining({
          stackId: legacyBySlot.get(20),
          quantity: 250,
          maxStack: 250
        })
      ]);
    expect(reorganized.warehouse.stacks.some(
      (stack) => stack.stackId === legacyBySlot.get(21)
    )).toBe(false);
    const totals = (stacks: typeof reorganized.warehouse.stacks) => Object.fromEntries(
      [...stacks.reduce((byItem, stack) => {
        const key = `${stack.itemId}:${stack.variant ?? "default"}`;
        byItem.set(key, (byItem.get(key) ?? 0) + stack.quantity);
        return byItem;
      }, new Map<string, number>())].sort(([left], [right]) => left.localeCompare(right))
    );
    expect(totals(reorganized.warehouse.stacks)).toEqual(totals(beforeReorganize.stacks));
    expect(scattered.warehouse.stacks.length + 2).toBe(beforeReorganize.usedSlots);
    await expect(warehouse.reorganize(
      "a",
      warehouseStructure.structureId,
      warehousePosition,
      "mayor-reorganize"
    )).resolves.toMatchObject({ replayed: true });
  });

  it("reserves one Cistern Warrens per city and protects an occupied shared instance", async () => {
    const cityId = await createCity(pool, "a", "Cistern City", hall, "reserved");
    const house = await structures.buildHouse("a", houseA, "sewer-house");
    await structures.claimMayor("a", cityId, "sewer-mayor");
    await creditCityCoins(
      pool,
      treasury,
      cityId,
      "a",
      house.membership!.houseStructureId,
      500,
      "sewer-coins"
    );
    const cityWarehouse = await structures.buildFacility(
      "a",
      cityId,
      "warehouse",
      warehousePosition,
      "sewer-warehouse"
    );
    await warehouse.donateAllEligible(
      "a",
      cityWarehouse.structureId,
      warehousePosition,
      "sewer-materials"
    );
    const materialsBefore = await warehouseMaterials(pool, cityId);

    const sewer = await structures.buildFacility(
      "a",
      cityId,
      "cistern_warrens",
      westPosition,
      "cistern-warrens-one"
    );
    expect(sewer).toMatchObject({ type: "cistern_warrens", tier: 1, state: "active" });
    const materialsAfter = await warehouseMaterials(pool, cityId);
    const quantity = (
      materials: Array<{ item_id: string; quantity: string }>,
      itemId: string
    ): number => Number(materials.find((item) => item.item_id === itemId)?.quantity ?? 0);
    expect(quantity(materialsAfter, "wood")).toBe(quantity(materialsBefore, "wood") - 140);
    expect(quantity(materialsAfter, "stone")).toBe(quantity(materialsBefore, "stone") - 160);
    await expect(structures.buildFacility(
      "a",
      cityId,
      "cistern_warrens",
      hall,
      "cistern-warrens-two"
    )).rejects.toMatchObject({ code: "CITY_FACILITY_ALREADY_EXISTS" });
    await expect(structures.upgradeFacility(
      "a",
      sewer.structureId,
      1,
      westPosition,
      "cistern-warrens-upgrade"
    )).rejects.toMatchObject({ code: "CITY_FACILITY_NOT_FOUND" });

    await pool.query(
      `INSERT INTO cistern_warrens_presence (
         player_id,sewer_structure_id,session_id,local_x,local_y,
         return_region_code,return_lat,return_lon
       ) VALUES ('b',$1::uuid,$2::uuid,14,24,'US-NM',$3,$4)`,
      [sewer.structureId, randomUUID(), westPosition.lat, westPosition.lon]
    );
    await expect(structures.destroyFacility(
      "a",
      sewer.structureId,
      sewer.placementRevision,
      westPosition,
      "cistern-warrens-destroy-occupied"
    )).rejects.toMatchObject({ code: "CISTERN_WARRENS_OCCUPIED" });
    await pool.query("DELETE FROM cistern_warrens_presence WHERE player_id='b'");
    await expect(structures.destroyFacility(
      "a",
      sewer.structureId,
      sewer.placementRevision,
      westPosition,
      "cistern-warrens-destroy"
    )).resolves.toMatchObject({ structure: { state: "destroyed", type: "cistern_warrens" } });
  });

  it.each(["weaponsmith", "armory"] as const)(
    "rejects stale %s upgrade and destruction without refunds, drops, or balance changes",
    async (legacyType) => {
      const cityId = await createCity(pool, "a", `Retired ${legacyType}`, hall, "reserved");
      const house = await structures.buildHouse("a", houseA, `legacy-house-${legacyType}`);
      await structures.claimMayor("a", cityId, `legacy-claim-${legacyType}`);
      const structureId = randomUUID();
      await pool.query(
        `INSERT INTO city_structures (
           structure_id,city_id,structure_type,tier,owner_player_id,world_id,
           region_code,lat,lon,geom,footprint_geom,footprint_radius_m,
           placement_revision,state,build_operation_key,built_at
         )
         SELECT $1::uuid,$2::uuid,$3,2,NULL,world_id,
                region_code,lat,lon,geom,footprint_geom,footprint_radius_m,
                1,'active',$4,clock_timestamp()
         FROM city_structures
         WHERE structure_id=$5::uuid`,
        [
          structureId,
          cityId,
          legacyType,
          `legacy-fixture:${legacyType}`,
          house.structure.structureId
        ]
      );
      const before = await pool.query<{
        treasury_balance: string;
        refund_count: number;
        drop_count: number;
      }>(
        `SELECT
           (SELECT balance::text FROM city_treasuries WHERE city_id=$1) AS treasury_balance,
           (SELECT count(*)::int FROM city_structure_refunds) AS refund_count,
           (SELECT count(*)::int FROM world_item_drops) AS drop_count`
      , [cityId]);

      await expect(
        structures.upgradeFacility(
          "a",
          structureId,
          2,
          westPosition,
          `legacy-upgrade-${legacyType}`
        )
      ).rejects.toMatchObject({ code: "CITY_FACILITY_NOT_FOUND" });
      await expect(
        structures.destroyFacility(
          "a",
          structureId,
          "1",
          westPosition,
          `legacy-destroy-${legacyType}`
        )
      ).rejects.toMatchObject({ code: "CITY_FACILITY_NOT_FOUND" });

      await expect(pool.query(
        `SELECT state,tier,placement_revision::text
         FROM city_structures WHERE structure_id=$1`,
        [structureId]
      )).resolves.toMatchObject({
        rows: [{ state: "active", tier: 2, placement_revision: "1" }]
      });
      await expect(pool.query(
        `SELECT
           (SELECT balance::text FROM city_treasuries WHERE city_id=$1) AS treasury_balance,
           (SELECT count(*)::int FROM city_structure_refunds) AS refund_count,
           (SELECT count(*)::int FROM world_item_drops) AS drop_count`,
        [cityId]
      )).resolves.toEqual(before);
    }
  );

  it("charges each Warehouse upgrade from authoritative Warehouse materials and City Coins", async () => {
    const cityId = await createCity(pool, "a", "Balanced", hall, "reserved");
    const house = await structures.buildHouse("a", houseA, "balanced-house");
    await structures.claimMayor("a", cityId, "balanced-claim");
    await creditCityCoins(
      pool,
      treasury,
      cityId,
      "a",
      house.membership!.houseStructureId,
      10_000,
      "balanced-facilities"
    );
    const warehouseStructure = await structures.buildFacility(
      "a",
      cityId,
      "warehouse",
      warehousePosition,
      "balanced-warehouse"
    );
    await warehouse.donateAllEligible(
      "a",
      warehouseStructure.structureId,
      warehousePosition,
      "balanced-materials"
    );
    for (const load of [1, 2]) {
      await grantMaterials(inventory, "a", 1_000, 1_000, `balanced-load-${load}`);
      await warehouse.donateAllEligible(
        "a",
        warehouseStructure.structureId,
        warehousePosition,
        `balanced-donation-${load}`
      );
    }
    const facilities = [
      {
        type: "warehouse",
        structureId: warehouseStructure.structureId,
        position: warehousePosition,
        woodByTier: { 2: 200, 3: 400 },
        coinsByTier: { 2: 500, 3: 1_500 }
      }
    ] as const;

    for (const facility of facilities) {
      for (const targetTier of [2, 3] as const) {
        const materialsBefore = Object.fromEntries(
          (await warehouseMaterials(pool, cityId))
            .map((row) => [row.item_id, Number(row.quantity)])
        );
        const treasuryBefore = BigInt((await treasury.snapshot(cityId)).balance);
        await expect(structures.upgradeFacility(
          "a",
          facility.structureId,
          (targetTier - 1) as 1 | 2,
          facility.position,
          `${facility.type}-tier-${targetTier}`
        )).resolves.toMatchObject({ tier: targetTier });
        const materialsAfter = Object.fromEntries(
          (await warehouseMaterials(pool, cityId))
            .map((row) => [row.item_id, Number(row.quantity)])
        );
        const treasuryAfter = BigInt((await treasury.snapshot(cityId)).balance);

        expect(materialsBefore.stone! - materialsAfter.stone!).toBe(10);
        expect(materialsBefore.wood! - materialsAfter.wood!)
          .toBe(facility.woodByTier[targetTier]);
        expect(treasuryBefore - treasuryAfter)
          .toBe(BigInt(facility.coinsByTier[targetTier]));
      }
    }
  });

  it("upgrades the City Market level by level for the Mayor only, charging CITY_MARKET_COST times the level once", async () => {
    const cityId = await createCity(pool, "a", "Marketton", hall, "open");
    const house = await structures.buildHouse("a", houseA, "market-house");
    await structures.claimMayor("a", cityId, "market-claim");
    await structures.buildHouse("b", houseB, "market-house-b");
    await creditCityCoins(pool, treasury, cityId, "a", house.membership!.houseStructureId, 10_000, "market-coins");
    const warehouseStructure = await structures.buildFacility("a", cityId, "warehouse", warehousePosition, "market-warehouse");
    // Stock the Warehouse directly (donations are weight-capped).
    await pool.query(
      `INSERT INTO city_warehouse_stacks (city_id,slot_index,item_id,variant,quantity)
       VALUES ($1,50,'wood','default',500),($1,51,'wood','default',500),($1,52,'wood','default',500),
              ($1,53,'stone','default',250),($1,54,'stone','default',250)`,
      [cityId]
    );
    void warehouseStructure;
    const marketId = randomUUID();
    const marketPosition = { lat: 35.0012, lon: -106.0012 };
    await pool.query(
      `INSERT INTO city_structures (
         structure_id,city_id,structure_type,tier,world_id,region_code,
         lat,lon,geom,footprint_geom,footprint_radius_m,placement_revision,
         state,build_operation_key,built_at
       ) VALUES (
         $1,$2,'market',1,'main','US-NM',$3,$4,
         ST_SetSRID(ST_MakePoint($4,$3),4326),
         ST_Buffer(ST_SetSRID(ST_MakePoint($4,$3),4326)::geography,20)::geometry,
         20,1,'active',$5,clock_timestamp()
       )`,
      [marketId, cityId, marketPosition.lat, marketPosition.lon, `test-market:${marketId}`]
    );
    // Denied: a member who is not the Mayor; nothing is charged.
    const treasuryBefore = BigInt((await treasury.snapshot(cityId)).balance);
    await expect(structures.upgradeFacility("b", marketId, 1, marketPosition, "member-market"))
      .rejects.toMatchObject({ code: expect.stringMatching(/MAYOR|PERMISSION/u) });
    // Allowed: level 2 costs the build's 275 wood, 45 stone and 1,100 City Coins times 2.
    const materialsBefore = Object.fromEntries((await warehouseMaterials(pool, cityId)).map((row) => [row.item_id, Number(row.quantity)]));
    await expect(structures.upgradeFacility("a", marketId, 1, marketPosition, "market-2"))
      .resolves.toMatchObject({ type: "market", tier: 2 });
    const materialsAfter = Object.fromEntries((await warehouseMaterials(pool, cityId)).map((row) => [row.item_id, Number(row.quantity)]));
    expect(materialsBefore.wood! - materialsAfter.wood!).toBe(550);
    expect(materialsBefore.stone! - materialsAfter.stone!).toBe(90);
    expect(treasuryBefore - BigInt((await treasury.snapshot(cityId)).balance)).toBe(2_200n);
    // Replay of the same request charges nothing more; a stale level is refused.
    await expect(structures.upgradeFacility("a", marketId, 1, marketPosition, "market-2"))
      .resolves.toMatchObject({ tier: 2 });
    expect(treasuryBefore - BigInt((await treasury.snapshot(cityId)).balance)).toBe(2_200n);
    await expect(structures.upgradeFacility("a", marketId, 1, marketPosition, "market-2-again"))
      .rejects.toMatchObject({ code: "CITY_FACILITY_STALE_TIER" });
    await expect(structures.upgradeFacility("a", marketId, 2, marketPosition, "market-3"))
      .resolves.toMatchObject({ tier: 3 });
    expect(treasuryBefore - BigInt((await treasury.snapshot(cityId)).balance)).toBe(5_500n);
    // Level 10 is the top.
    await pool.query("UPDATE city_structures SET tier=10 WHERE structure_id=$1", [marketId]);
    await expect(structures.upgradeFacility("a", marketId, 10, marketPosition, "market-11"))
      .rejects.toMatchObject({ code: "CITY_FACILITY_MAXIMUM_TIER" });
    await expect(pool.query("UPDATE city_structures SET tier=4 WHERE structure_id=$1", [warehouseStructure.structureId]))
      .rejects.toMatchObject({ code: "23514" });
  });

  it("donates an exact stack atomically and exposes it to another active house-backed member", async () => {
    const cityId = await createCity(pool, "a", "Donors", hall, "reserved");
    const donorHouse = await structures.buildHouse("a", houseA, "donor-house");
    await structures.buildHouse("b", houseB, "viewer-house");
    await structures.claimMayor("a", cityId, "donor-claim");
    await creditCityCoins(
      pool,
      treasury,
      cityId,
      "a",
      donorHouse.membership!.houseStructureId,
      100,
      "donor-warehouse"
    );
    const warehouseStructure = await structures.buildFacility(
      "a",
      cityId,
      "warehouse",
      warehousePosition,
      "donor-warehouse"
    );
    const sourceStackId = await inventoryStackId(pool, "a", "wood");
    const before = await inventoryTotals(pool, "a");

    await expect(
      warehouse.open("a", warehouseStructure.structureId, warehousePosition)
    ).resolves.toMatchObject({ cityId, usedSlots: 0 });
    const donated = await warehouse.donate(
      "a",
      warehouseStructure.structureId,
      warehousePosition,
      "exact-donation",
      sourceStackId,
      25
    );

    expect(donated).toMatchObject({
      replayed: false,
      donatedQuantity: 25,
      warehouse: {
        structureId: warehouseStructure.structureId,
        usedSlots: 1,
        stacks: [{ itemId: "wood", quantity: 25 }]
      }
    });
    expect(await inventoryTotals(pool, "a")).toEqual({
      ...before,
      wood: before.wood - 28
    });
    await expect(
      warehouse.open("b", warehouseStructure.structureId, warehousePosition)
    ).resolves.toMatchObject({
      cityId,
      canReorganize: false,
      stacks: [{ itemId: "wood", quantity: 25 }]
    });
    await expect(pool.query(
      `SELECT
         (SELECT count(*)::int FROM city_warehouse_operations
          WHERE operation_key='city-warehouse:a:exact-donation') AS operations,
         (SELECT count(*)::int FROM city_warehouse_events
          WHERE operation_key='city-warehouse:a:exact-donation') AS events`
    )).resolves.toMatchObject({ rows: [{ operations: 1, events: 1 }] });
  });

  it("enforces full and partial protection across bulk donation and restacking", async () => {
    const cityId = await createCity(pool, "a", "Protected", hall, "reserved");
    const protectedHouse = await structures.buildHouse("a", houseA, "protected-house");
    await structures.claimMayor("a", cityId, "protected-claim");
    await creditCityCoins(
      pool,
      treasury,
      cityId,
      "a",
      protectedHouse.membership!.houseStructureId,
      100,
      "protected-warehouse"
    );
    const warehouseStructure = await structures.buildFacility(
      "a",
      cityId,
      "warehouse",
      warehousePosition,
      "protected-warehouse"
    );
    const before = await inventoryTotals(pool, "a");
    await setMaterialKeep(pool, "a", "wood", before.wood - 25);
    await setMaterialKeep(pool, "a", "stone", before.stone);
    const woodStackId = await inventoryStackId(pool, "a", "wood");

    await expect(warehouse.donate(
      "a",
      warehouseStructure.structureId,
      warehousePosition,
      "protected-excess",
      woodStackId,
      26
    )).rejects.toMatchObject({ code: "CITY_WAREHOUSE_PROTECTED_QUANTITY" });
    expect(await inventoryTotals(pool, "a")).toEqual(before);

    const donated = await warehouse.donateAllEligible(
      "a",
      warehouseStructure.structureId,
      warehousePosition,
      "protected-bulk"
    );
    expect(donated.donatedQuantity).toBe(25);
    expect(await inventoryTotals(pool, "a")).toEqual({
      wood: before.wood - 25,
      stone: before.stone
    });

    await inventory.grantItemsForOperation({
      operationKey: "city-test-materials:a:restacked-protection",
      playerId: "a",
      source: "city_test_seed",
      grants: [{ itemId: "wood", variant: null, quantity: 50 }]
    });
    await warehouse.donateAllEligible(
      "a",
      warehouseStructure.structureId,
      warehousePosition,
      "protected-restacked-bulk"
    );
    expect(await inventoryTotals(pool, "a")).toEqual({
      wood: before.wood - 25,
      stone: before.stone
    });
    expect(await warehouseMaterials(pool, cityId)).toEqual([
      { item_id: "wood", quantity: "75" }
    ]);
  });

  it("rejects invalid access and failed mutations without leaving partial state", async () => {
    const cityId = await createCity(pool, "a", "Guards", hall, "reserved");
    const house = await structures.buildHouse("a", houseA, "guard-house");
    const formerHouse = await structures.buildHouse("b", houseB, "former-house");
    await structures.claimMayor("a", cityId, "guard-claim");
    await creditCityCoins(
      pool,
      treasury,
      cityId,
      "a",
      house.membership!.houseStructureId,
      110,
      "guard-warehouse"
    );
    const warehouseStructure = await structures.buildFacility(
      "a",
      cityId,
      "warehouse",
      warehousePosition,
      "guard-warehouse"
    );

    await expect(warehouse.open("c", warehouseStructure.structureId, warehousePosition))
      .rejects.toMatchObject({ code: "CITY_WAREHOUSE_ACCESS_DENIED" });
    await expect(warehouse.open("a", warehouseStructure.structureId, {
      lat: warehousePosition.lat + 0.0027,
      lon: warehousePosition.lon
    }))
      .rejects.toMatchObject({ code: "CITY_WAREHOUSE_ACCESS_DENIED" });
    await expect(warehouse.open("a", house.structure.structureId, houseA))
      .rejects.toMatchObject({ code: "CITY_WAREHOUSE_ACCESS_DENIED" });

    await structures.destroyHouse(
      "b",
      formerHouse.structure.structureId,
      formerHouse.structure.placementRevision,
      "former-leaves"
    );
    await expect(warehouse.open("b", warehouseStructure.structureId, warehousePosition))
      .rejects.toMatchObject({ code: "CITY_WAREHOUSE_ACCESS_DENIED" });

    await structures.buildHouse("c", westPosition, "broken-house");
    await pool.query(
      `UPDATE city_structures
       SET state='destroyed',destroyed_at=now()
       WHERE owner_player_id='c' AND state='active'`
    );
    await expect(warehouse.open("c", warehouseStructure.structureId, warehousePosition))
      .rejects.toMatchObject({ code: "CITY_WAREHOUSE_ACCESS_DENIED" });

    const missingStackId = randomUUID();
    await expect(warehouse.donate(
      "a",
      warehouseStructure.structureId,
      warehousePosition,
      "missing-stack",
      missingStackId,
      1
    )).rejects.toMatchObject({ code: "CITY_WAREHOUSE_STACK_NOT_FOUND" });

    await inventory.grantItemsForOperation({
      operationKey: "city-test-materials:a:unsupported",
      playerId: "a",
      source: "city_test_seed",
      grants: [{ itemId: "balsam_resin", variant: null, quantity: 2 }]
    });
    await expect(warehouse.donate(
      "a",
      warehouseStructure.structureId,
      warehousePosition,
      "unsupported-stack",
      await inventoryStackId(pool, "a", "balsam_resin"),
      1
    )).rejects.toMatchObject({ code: "CITY_WAREHOUSE_RESOURCE_REQUIRED" });

    const beforeFull = await inventoryTotals(pool, "a");
    const fullStack = requireInventoryCatalogItem("stone").maxStack;
    await pool.query(
      `INSERT INTO city_warehouse_stacks
         (city_id,slot_index,item_id,variant,quantity)
       SELECT $1,slot,'stone','default',$2::bigint
       FROM generate_series(0,59) slot`,
      [cityId, fullStack]
    );
    await expect(warehouse.donate(
      "a",
      warehouseStructure.structureId,
      warehousePosition,
      "full-warehouse",
      await inventoryStackId(pool, "a", "wood"),
      1
    )).rejects.toMatchObject({ code: "CITY_WAREHOUSE_FULL" });
    expect(await inventoryTotals(pool, "a")).toEqual(beforeFull);
    await expect(pool.query(
      `SELECT
         (SELECT count(*)::int FROM city_warehouse_operations) AS operations,
         (SELECT count(*)::int FROM city_warehouse_events) AS events`
    )).resolves.toMatchObject({ rows: [{ operations: 0, events: 0 }] });

    await structures.destroyFacility(
      "a",
      warehouseStructure.structureId,
      warehouseStructure.placementRevision,
      warehousePosition,
      "destroy-guard-warehouse"
    );
    await expect(warehouse.open("a", warehouseStructure.structureId, warehousePosition))
      .rejects.toMatchObject({ code: "CITY_WAREHOUSE_ACCESS_DENIED" });
    expect(formerHouse.membership?.cityId).toBe(cityId);
  });

  it("replays completed intent and rejects changed or incomplete request intent", async () => {
    const cityId = await createCity(pool, "a", "Replay", hall, "reserved");
    const replayHouse = await structures.buildHouse("a", houseA, "replay-house");
    await structures.claimMayor("a", cityId, "replay-claim");
    await creditCityCoins(
      pool,
      treasury,
      cityId,
      "a",
      replayHouse.membership!.houseStructureId,
      100,
      "replay-warehouse"
    );
    const warehouseStructure = await structures.buildFacility(
      "a",
      cityId,
      "warehouse",
      warehousePosition,
      "replay-warehouse"
    );
    const stackId = await inventoryStackId(pool, "a", "wood");
    const first = await warehouse.donate(
      "a",
      warehouseStructure.structureId,
      warehousePosition,
      "same-request",
      stackId,
      10
    );
    const replay = await warehouse.donate(
      "a",
      warehouseStructure.structureId,
      warehousePosition,
      "same-request",
      stackId,
      10
    );
    expect(replay).toEqual({ ...first, replayed: true });
    await expect(warehouse.donate(
      "a",
      warehouseStructure.structureId,
      warehousePosition,
      "same-request",
      stackId,
      11
    )).rejects.toMatchObject({ code: "CITY_WAREHOUSE_IDEMPOTENCY_CONFLICT" });
    await expect(warehouse.donate(
      "a",
      warehouseStructure.structureId,
      warehousePosition,
      "same-request",
      randomUUID(),
      10
    )).rejects.toMatchObject({ code: "CITY_WAREHOUSE_IDEMPOTENCY_CONFLICT" });

    const incompleteStackId = await inventoryStackId(pool, "a", "stone");
    await pool.query(
      `INSERT INTO city_warehouse_operations
         (operation_key,actor_player_id,request_id,city_id,action,intent)
       VALUES ($1,'a','incomplete-request',$2,'donate',$3::jsonb)`,
      [
        "city-warehouse:a:incomplete-request",
        cityId,
        JSON.stringify({
          quantity: 1,
          stackId: incompleteStackId,
          structureId: warehouseStructure.structureId
        })
      ]
    );
    await expect(warehouse.donate(
      "a",
      warehouseStructure.structureId,
      warehousePosition,
      "incomplete-request",
      incompleteStackId,
      1
    )).rejects.toMatchObject({ code: "CITY_WAREHOUSE_OPERATION_INCOMPLETE" });

    const replacementId = await replaceWarehouseStructure(
      pool,
      warehouseStructure.structureId
    );
    await expect(warehouse.donate(
      "a",
      replacementId,
      warehousePosition,
      "same-request",
      stackId,
      10
    )).rejects.toMatchObject({ code: "CITY_WAREHOUSE_IDEMPOTENCY_CONFLICT" });
    await expect(pool.query(
      `SELECT count(*)::int AS count
       FROM city_warehouse_events
       WHERE operation_key='city-warehouse:a:same-request'`
    )).resolves.toMatchObject({ rows: [{ count: 1 }] });
  });

  it("keeps former-member contributions and returns the viewer outside the top 25", async () => {
    const cityId = await createCity(pool, "a", "Ranked", hall, "open");
    const house = await structures.buildHouse("a", houseA, "rank-house");
    await creditCityCoins(pool, treasury, cityId, "a", house.membership!.houseStructureId, 10);
    await structures.destroyHouse(
      "a",
      house.structure.structureId,
      house.structure.placementRevision,
      "rank-leave"
    );

    for (let index = 0; index < 26; index += 1) {
      const playerId = `rank-${index.toString().padStart(2, "0")}`;
      await createPlayer(pool, playerId);
      await pool.query(
        `INSERT INTO city_coin_contributions (
           city_id,player_id,lifetime_contributed,first_contributed_at,last_contributed_at
         ) VALUES ($1,$2,$3,'2026-01-01','2026-01-01')`,
        [cityId, playerId, 1_000 - index]
      );
    }

    const leaderboard = await treasury.leaderboard(cityId, "a");
    expect(leaderboard.entries).toHaveLength(25);
    expect(leaderboard.entries[0]).toMatchObject({
      rank: 1,
      playerId: "rank-00",
      contributed: "1000"
    });
    expect(leaderboard.own).toMatchObject({
      rank: 27,
      playerId: "a",
      contributed: "10",
      currentMember: false
    });
  });
});

async function createPlayer(pool: pg.Pool, playerId: string): Promise<void> {
  const accountId = randomUUID();
  await pool.query(
    "INSERT INTO accounts (id,status,trust_tier) VALUES ($1,'active','standard')",
    [accountId]
  );
  await pool.query(
    `INSERT INTO players (
       id,account_id,username,username_normalized,display_color,region_code,
       lat,lon,anchor_lat,anchor_lon,move_leash_radius_m,online,geom
      ) VALUES (
       $1,$2,$1,$1,'#38bdf8','NM',35,-106,35,-106,1250,false,
       ST_SetSRID(ST_MakePoint(-106,35),4326)
      )`,
    [playerId, accountId]
  );
}

async function fundWallet(
  pool: pg.Pool,
  wallet: WalletService,
  playerId: string,
  amount: bigint,
  operationKey: string
): Promise<void> {
  const accountId = await playerAccountId(pool, playerId);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await wallet.creditForOperationInTransaction(client, {
      playerId,
      accountId,
      amount,
      operationKey,
      reason: "harvest_access_test_seed"
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function walletSnapshot(
  pool: pg.Pool,
  wallet: WalletService,
  playerId: string
) {
  return wallet.snapshotInTransaction(pool, playerId, await playerAccountId(pool, playerId));
}

async function playerAccountId(pool: pg.Pool, playerId: string): Promise<string> {
  const account = await pool.query<{ account_id: string }>(
    "SELECT account_id::text FROM players WHERE id=$1",
    [playerId]
  );
  if (!account.rows[0]?.account_id) throw new Error(`Missing account for ${playerId}`);
  return account.rows[0].account_id;
}

async function createCity(
  pool: pg.Pool,
  founderPlayerId: string,
  name: string,
  position: { lat: number; lon: number },
  founderClaim: "reserved" | "open"
): Promise<string> {
  const cityId = randomUUID();
  const flagId = randomUUID();
  const settlementId = `settlement-${cityId}`;
  await pool.query(
    `INSERT INTO flags (id,owner_id,name,lat,lon,claim_radius_m,geom)
     VALUES ($1,$2,$3,$4,$5,1000,ST_SetSRID(ST_MakePoint($5,$4),4326))`,
    [flagId, founderPlayerId, `${name}'s Flag`, position.lat, position.lon]
  );
  await pool.query(
    `INSERT INTO cities (
       id,world_id,canonical_municipality_id,world_settlement_id,
       world_settlement_source,world_source_settlement_id,name,country_code,
       region_code,founder_player_id,mayor_player_id,founding_request_id,
       seat_flag_id,hall_lat,hall_lon,hall_geom,founding_annex_radius_m,
       mayor_house_deadline,mayor_confirmed_at
     ) VALUES (
       $1,'main',$2,$2,'test',$2,$3,'US','US-NM',$4,NULL,$5,$6,$7,$8,
       ST_SetSRID(ST_MakePoint($8,$7),4326),1000,
       CASE WHEN $9::text = 'reserved' THEN now()+interval '15 minutes' ELSE NULL END,NULL
     )`,
    [
      cityId,
      settlementId,
      name,
      founderPlayerId,
      `found-${cityId}`,
      flagId,
      position.lat,
      position.lon,
      founderClaim
    ]
  );
  await pool.query(
    `UPDATE flags
     SET control_type='city_seat',city_id=$2,city_affiliated_at=now(),
         city_affiliated_by_player_id=NULL,original_owner_player_id=NULL,
         contributed_by_player_id=NULL,original_personal_color=NULL
     WHERE id=$1`,
    [flagId, cityId]
  );
  return cityId;
}

async function grantMaterials(
  inventory: InventoryService,
  playerId: string,
  wood: number,
  stone: number,
  suffix = "initial"
): Promise<void> {
  await inventory.grantItemsForOperation({
    operationKey: `city-test-materials:${playerId}:${suffix}`,
    playerId,
    source: "city_test_seed",
    grants: [
      { itemId: "wood", variant: null, quantity: wood },
      { itemId: "stone", variant: null, quantity: stone }
    ]
  });
}

async function inventoryStackId(
  pool: pg.Pool,
  playerId: string,
  itemId: string
): Promise<string> {
  const result = await pool.query<{ stack_id: string }>(
    `SELECT stack_id::text
     FROM player_inventory_slots
     WHERE player_id=$1 AND resource_type=$2
     ORDER BY slot_index
     LIMIT 1`,
    [playerId, itemId]
  );
  if (!result.rows[0]) throw new Error(`missing ${itemId} stack for ${playerId}`);
  return result.rows[0].stack_id;
}

async function setMaterialKeep(
  pool: pg.Pool,
  playerId: string,
  itemId: string,
  quantity: number
): Promise<void> {
  await pool.query(
    `INSERT INTO player_item_keep_policies
       (player_id,item_id,variant,keep_quantity,revision)
     VALUES ($1,$2,'default',$3,1)`,
    [playerId, itemId, quantity]
  );
}

async function replaceWarehouseStructure(
  pool: pg.Pool,
  structureId: string
): Promise<string> {
  const replacementId = randomUUID();
  await pool.query(
    `UPDATE city_structures
     SET state='destroyed',destroyed_at=now(),updated_at=now()
     WHERE structure_id=$1::uuid`,
    [structureId]
  );
  await pool.query(
    `INSERT INTO city_structures (
       structure_id,city_id,structure_type,tier,owner_player_id,world_id,
       region_code,lat,lon,geom,footprint_geom,footprint_radius_m,
       placement_revision,state,build_operation_key,built_at,upgraded_at
     )
     SELECT $2::uuid,city_id,structure_type,tier,owner_player_id,world_id,
            region_code,lat,lon,geom,footprint_geom,footprint_radius_m,
            placement_revision+1,'active',$3,built_at,upgraded_at
     FROM city_structures
     WHERE structure_id=$1::uuid`,
    [structureId, replacementId, `test-replacement:${replacementId}`]
  );
  return replacementId;
}

async function inventoryTotals(
  pool: pg.Pool,
  playerId: string
): Promise<{ stone: number; wood: number }> {
  const result = await pool.query<{ resource_type: "stone" | "wood"; quantity: string }>(
    `SELECT resource_type,quantity::text
     FROM player_inventory
     WHERE player_id=$1 AND resource_type IN ('stone','wood')
     ORDER BY resource_type`,
    [playerId]
  );
  const totals = { stone: 0, wood: 0 };
  for (const row of result.rows) totals[row.resource_type] = Number(row.quantity);
  return totals;
}

async function warehouseMaterials(
  pool: pg.Pool,
  cityId: string
): Promise<Array<{ item_id: string; quantity: string }>> {
  const result = await pool.query<{ item_id: string; quantity: string }>(
    `SELECT item_id,sum(quantity)::text AS quantity
     FROM city_warehouse_stacks
     WHERE city_id=$1 GROUP BY item_id ORDER BY item_id`,
    [cityId]
  );
  return result.rows;
}

async function seedWarehouseStacks(
  pool: pg.Pool,
  cityId: string,
  materials: readonly { itemId: string; quantity: number }[]
): Promise<void> {
  let slotIndex = 0;
  for (const material of materials) {
    const definition = await pool.query<{ max_stack: number }>(
      "SELECT max_stack FROM item_definitions WHERE item_id=$1",
      [material.itemId]
    );
    const maximum = Number(definition.rows[0]?.max_stack);
    if (!Number.isSafeInteger(maximum) || maximum <= 0) {
      throw new Error(`missing stack policy for ${material.itemId}`);
    }
    let remaining = material.quantity;
    while (remaining > 0) {
      const quantity = Math.min(remaining, maximum);
      await pool.query(
        `INSERT INTO city_warehouse_stacks
           (city_id,slot_index,item_id,variant,quantity)
         VALUES ($1,$2,$3,'default',$4)`,
        [cityId, slotIndex, material.itemId, quantity]
      );
      slotIndex += 1;
      remaining -= quantity;
    }
  }
}

async function projectPosition(
  pool: pg.Pool,
  origin: { lat: number; lon: number },
  distanceM: number,
  bearingDegrees: number
): Promise<{ lat: number; lon: number }> {
  const result = await pool.query<{ lat: number; lon: number }>(
    `SELECT ST_Y(projected::geometry) AS lat,
            ST_X(projected::geometry) AS lon
     FROM (
       SELECT ST_Project(
         ST_SetSRID(ST_MakePoint($1,$2),4326)::geography,
         $3::double precision,
         radians($4)
       ) AS projected
     ) projection`,
    [origin.lon, origin.lat, distanceM, bearingDegrees]
  );
  return result.rows[0]!;
}

function playerRecordAt(
  playerId: string,
  position: { lat: number; lon: number }
): PlayerRecord {
  return {
    playerId,
    username: playerId,
    displayColor: null,
    regionCode: "GLOBAL",
    position,
    anchor: position,
    moveLeashRadiusM: 1_250,
    movementRevision: 0,
    target: null,
    online: true,
    updatedAt: new Date()
  };
}

async function activeHouseIdentity(
  pool: pg.Pool,
  playerId: string
): Promise<{ structureId: string; placementRevision: string }> {
  const result = await pool.query<{
    structure_id: string;
    placement_revision: string;
  }>(
    `SELECT structure_id::text,placement_revision::text
     FROM city_structures
     WHERE owner_player_id=$1 AND state='active'
       AND structure_type IN ('city_house','mayor_house')`,
    [playerId]
  );
  return {
    structureId: result.rows[0]!.structure_id,
    placementRevision: result.rows[0]!.placement_revision
  };
}

async function structureIdentity(
  pool: pg.Pool,
  structureId: string
): Promise<{ placementRevision: string }> {
  const result = await pool.query<{ placement_revision: string }>(
    `SELECT placement_revision::text
     FROM city_structures WHERE structure_id=$1`,
    [structureId]
  );
  return { placementRevision: result.rows[0]!.placement_revision };
}

function activateBuildsImmediately(
  pool: pg.Pool,
  service: CityStructureService
): CityStructureService {
  return new Proxy(service, {
    get(target, property, receiver) {
      if (property === "buildHouse") {
        return async (...args: Parameters<CityStructureService["buildHouse"]>) => {
          const started = await target.buildHouse(...args);
          await completeStructureNow(pool, target, started.structure.structureId);
          const completed = await target.buildHouse(...args);
          return { ...completed, replayed: started.replayed };
        };
      }
      if (property === "buildFacility") {
        return async (...args: Parameters<CityStructureService["buildFacility"]>) => {
          const started = await target.buildFacility(...args);
          await completeStructureNow(pool, target, started.structureId);
          return target.buildFacility(...args);
        };
      }
      if (property === "upgradeFacility") {
        return async (...args: Parameters<CityStructureService["upgradeFacility"]>) => {
          const started = await target.upgradeFacility(...args);
          await completeStructureNow(pool, target, started.structureId);
          return target.upgradeFacility(...args);
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

async function completeStructureNow(
  pool: pg.Pool,
  service: CityStructureService,
  structureId: string
): Promise<void> {
  await pool.query(
    `UPDATE city_structures
     SET construction_completes_at=clock_timestamp()
     WHERE structure_id=$1 AND state='constructing'`,
    [structureId]
  );
  await service.reconcileDueConstruction();
}

async function creditCityCoins(
  pool: pg.Pool,
  treasury: CityTreasuryService,
  cityId: string,
  playerId: string,
  houseStructureId: string,
  amount: number,
  suffix = "initial"
): Promise<void> {
  const membership = await pool.query<{ membership_id: string }>(
    `SELECT membership_id::text
     FROM city_memberships
     WHERE city_id=$1 AND player_id=$2 AND house_structure_id=$3 AND left_at IS NULL`,
    [cityId, playerId, houseStructureId]
  );
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await treasury.creditCombatInTransaction(client, {
      operationKey: `city-test-credit:${cityId}:${suffix}`,
      cityId,
      playerId,
      membershipId: membership.rows[0]!.membership_id,
      amount,
      settlementKey: `city-test-settlement:${suffix}`,
      mobArchetype: "test"
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
