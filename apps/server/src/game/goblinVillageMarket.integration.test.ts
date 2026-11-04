import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { distanceMeters } from "@ash-atlas/shared";

import type { AppConfig } from "../config.js";
import { runMigrations } from "../db/migrate.js";
import { BackpackService } from "./backpacks.js";
import type { CityService } from "./cities.js";
import { CombatEngine } from "./combat/combatEngine.js";
import { EquipmentService } from "./equipment.js";
import type { FlagService } from "./flags.js";
import { GoblinVillageService } from "./goblinVillage.js";
import { InventoryService } from "./inventory.js";
import { packageIdForPosition, zoneIdForPosition } from "./spatialZones.js";
import type { PlayerRecord } from "./state.js";
import { WalletService } from "./wallet.js";
import type { WorldLookupClient } from "../world/worldLookupClient.js";

const databaseUrl = safeDisposableDatabaseUrl(process.env.SETTLEMENT_TEST_DATABASE_URL);
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("Goblin Market PostgreSQL integration", () => {
  let pool: pg.Pool;
  let service: GoblinVillageService;
  let inventory: InventoryService;
  let equipment: EquipmentService;
  let backpacks: BackpackService;
  let wallet: WalletService;
  const playerId = "goblin-market-player";
  const accountId = randomUUID();
  const cityId = randomUUID();
  const flagId = randomUUID();
  const marketId = randomUUID();
  const equipmentId = randomUUID();
  const damagedChestId = randomUUID();
  const laterEquipmentId = randomUUID();
  const backpackId = randomUUID();
  const position = { lat: 35.0844, lon: -106.6504 };

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl!, max: 4 });
    await pool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ash_atlas_telemetry_exporter') THEN
        CREATE ROLE ash_atlas_telemetry_exporter NOLOGIN;
      END IF;
    END $$`);
    await runMigrations(databaseUrl!);
  }, 30_000);

  beforeEach(async () => {
    await pool.query("TRUNCATE players CASCADE");
    await pool.query("DELETE FROM accounts WHERE id=$1", [accountId]);
    await pool.query("INSERT INTO accounts (id,status,trust_tier) VALUES ($1,'active','standard')", [accountId]);
    await pool.query(
      `INSERT INTO players (
         id,account_id,username,username_normalized,region_code,lat,lon,anchor_lat,anchor_lon,
         move_leash_radius_m,online,geom
       ) VALUES ($1,$2,$1,$1,'NM',$3,$4,$3,$4,900,true,
                 ST_SetSRID(ST_MakePoint($4,$3),4326))`,
      [playerId, accountId, position.lat, position.lon]
    );
    await pool.query(
      `INSERT INTO cities (
         id,world_id,canonical_municipality_id,world_settlement_id,world_settlement_source,
         world_source_settlement_id,name,country_code,founder_player_id,founding_request_id,
         hall_lat,hall_lon,hall_geom,founding_annex_radius_m,controller_kind,culture,banner_color
       ) VALUES ($1,'main',$2,$2,'system','goblin','Goblin Village','US',$3,'goblin-test',
                 $4,$5,ST_SetSRID(ST_MakePoint($5,$4),4326),2000,'npc','goblin','#174f2a')`,
      [cityId, `npc-${cityId}`, playerId, position.lat, position.lon]
    );
    await pool.query(
      `INSERT INTO flags (
         id,owner_id,name,lat,lon,claim_radius_m,reinforcement_level,control_type,city_id,
         access_mode,jump_toll_gold,city_affiliated_at,health,maximum_health,
         system_controlled,presentation_color,geom
       ) VALUES ($1,$2,'Goblin Tower',$3,$4,500,3,'city_seat',$5,
                 'public',0,now(),200,200,true,'#174f2a',
                 ST_SetSRID(ST_MakePoint($4,$3),4326))`,
      [flagId, playerId, position.lat, position.lon, cityId]
    );
    await pool.query("UPDATE cities SET seat_flag_id=$2 WHERE id=$1", [cityId, flagId]);
    await pool.query(
      `INSERT INTO city_structures (
         structure_id,city_id,structure_type,tier,world_id,region_code,lat,lon,geom,
         footprint_geom,footprint_radius_m,state,build_operation_key,built_at
       ) VALUES ($1,$2,'market',1,'main','NM',$3,$4,
                 ST_SetSRID(ST_MakePoint($4,$3),4326),
                 ST_Buffer(ST_SetSRID(ST_MakePoint($4,$3),4326)::geography,25)::geometry,
                 25,'active','goblin-market-test',now())`,
      [marketId, cityId, position.lat, position.lon]
    );

    inventory = new InventoryService(pool);
    wallet = new WalletService(pool);
    equipment = new EquipmentService(pool, { inventory, wallet });
    backpacks = new BackpackService(pool, { inventory, wallet });
    await inventory.grantItemsForOperation({
      operationKey: "goblin-test-resource",
      playerId,
      source: "test",
      grants: [
        { itemId: "wood", variant: "default", quantity: 7 },
        { itemId: "fire_feather", variant: "default", quantity: 1 }
      ]
    });
    await equipment.snapshotInTransaction(pool, playerId);
    await backpacks.snapshotInTransaction(pool, playerId);
    await pool.query(
      `INSERT INTO equipment_operations (operation_key,player_id,action,completed_at)
       VALUES ('goblin-test-equipment',$1,'starter_loadout',now())`,
      [playerId]
    );
    await pool.query(
      `INSERT INTO equipment_instances (
         instance_id,definition_id,owner_player_id,location,item_level,
         balance_version,created_by_operation_key
       ) VALUES ($1,'starter_sword',$2,'inventory',0,1,'goblin-test-equipment')`,
      [equipmentId, playerId]
    );
    await pool.query(
      `INSERT INTO equipment_instances (
         instance_id,definition_id,owner_player_id,location,item_level,
         condition,balance_version,created_by_operation_key
       ) VALUES ($1,'training_heavy_chest',$2,'inventory',0,50,1,'goblin-test-equipment')`,
      [damagedChestId, playerId]
    );
    await pool.query(
      `INSERT INTO backpack_operations (
         operation_key,player_id,account_id,request_id,action,request_hash
       ) VALUES ('goblin-test-backpack',$1,$2,'goblin-test-backpack','create',$3)`,
      [playerId, accountId, "0".repeat(64)]
    );
    await pool.query(
      `INSERT INTO player_backpack_instances (
         instance_id,owner_player_id,definition_id,location,created_by_operation_key
       ) VALUES ($1,$2,'starter_backpack','inventory','goblin-test-backpack')`,
      [backpackId, playerId]
    );
    await equipment.connectRuntime(playerId);

    const market = {
      structureId: marketId,
      cityId,
      type: "market",
      tier: 1,
      state: "active",
      lat: position.lat,
      lon: position.lon,
      cityControllerKind: "npc",
      cityCulture: "goblin"
    };
    const cities = {
      getCity: async () => ({ id: cityId, name: "Goblin Village" }),
      structures: { listForCity: async () => [market] }
    } as unknown as CityService;
    service = new GoblinVillageService(
      pool,
      { WORLD_ID: "main" } as AppConfig,
      {} as WorldLookupClient,
      cities,
      {} as FlagService,
      inventory,
      equipment,
      backpacks,
      wallet,
      new CombatEngine({ tickRateHz: 20, playerMovementSpeedMps: 40, isPlayerAuthorityActive: () => true }),
      { notifyZoneReady: async () => undefined } as never
    );
  });

  afterAll(async () => {
    await pool?.query("TRUNCATE players CASCADE");
    await pool?.query("DELETE FROM accounts WHERE id=$1", [accountId]);
    await pool?.end();
  });

  it("sells each carried kind atomically, replays after movement, and rejects conflicting intent", async () => {
    const player = runtimePlayer(position);
    const opened = await service.openMarket(player, marketId);
    expect(opened.lines).toContainEqual(expect.objectContaining({
      kind: "resource",
      displayName: "Ember Feather",
      quantity: 1,
      offerGold: "1000"
    }));
    expect(opened.lines.some((line) => line.kind === "equipment" && line.identity === damagedChestId))
      .toBe(false);
    const resource = opened.lines.find((line) =>
      line.kind === "resource" && line.displayName === "Wood"
    )!;
    const resourceSale = await service.sell(player, accountId, sale("resource-sale", resource));
    expect(resourceSale.walletGold).toBe("7");

    const moved = runtimePlayer({ lat: 36, lon: -107 });
    const replay = await service.sell(moved, accountId, sale("resource-sale", resource));
    expect(replay).toMatchObject({ replayed: true, walletGold: "7" });
    await expect(service.sell(moved, accountId, {
      ...sale("resource-sale", resource),
      itemIdentity: "different"
    })).rejects.toMatchObject({ code: "GOBLIN_MARKET_REQUEST_CONFLICT" });

    const equipmentLine = (await service.openMarket(player, marketId)).lines.find((line) => line.kind === "equipment")!;
    const equipmentSale = sale("equipment-sale", equipmentLine);
    expect((await service.sell(player, accountId, equipmentSale)).walletGold).toBe("37");
    expect(equipment.runtimeSnapshot(playerId)?.instances.some((item) => item.instanceId === equipmentId)).toBe(false);
    await pool.query(
       `INSERT INTO equipment_instances (
         instance_id,definition_id,owner_player_id,location,item_level,
         balance_version,created_by_operation_key
       ) VALUES ($1,'starter_sword',$2,'inventory',0,1,'goblin-test-equipment')`,
      [laterEquipmentId, playerId]
    );
    await pool.query(
      "UPDATE player_equipment_state SET inventory_revision=inventory_revision+1 WHERE player_id=$1",
      [playerId]
    );
    await equipment.refreshInventorySlots(playerId);
    expect((await service.sell(moved, accountId, equipmentSale)).replayed).toBe(true);
    expect(equipment.runtimeSnapshot(playerId)?.instances.some((item) => item.instanceId === laterEquipmentId)).toBe(true);

    const backpackLine = (await service.openMarket(player, marketId)).lines.find((line) => line.kind === "backpack")!;
    expect(backpackLine.displayName).toBe("Backpack +0");
    expect((await service.sell(player, accountId, sale("backpack-sale", backpackLine))).walletGold).toBe("62");
  });

  it("adds a worn Coinwright Glove's rounded-down 22% per item and spends one use per sale", async () => {
    const gloveId = randomUUID();
    await pool.query(
      `INSERT INTO equipment_instances (
         instance_id,definition_id,owner_player_id,location,equipped_slot,item_level,
         balance_version,created_by_operation_key,uses_remaining
       ) VALUES ($1,'coinwright_glove',$2,'equipped','gloves',0,1,'goblin-test-equipment',100)`,
      [gloveId, playerId]
    );
    await equipment.syncUtilityGear(playerId);
    const usesLeft = () => equipment.runtimeSnapshot(playerId)?.instances
      .find((item) => item.instanceId === gloveId)?.usesRemaining;
    const player = runtimePlayer(position);
    const lines = (await service.openMarket(player, marketId)).lines;
    const wood = lines.find((line) => line.kind === "resource" && line.displayName === "Wood")!;
    const feather = lines.find((line) => line.kind === "resource" && line.displayName === "Ember Feather")!;

    // Seven 1-gold Wood: each item's 22% rounds down to nothing (a pooled bonus would pay 1).
    const woodSale = await service.sell(player, accountId, sale("coinwright-wood", wood));
    expect(woodSale.walletGold).toBe("7");
    expect(usesLeft()).toBe(99);
    expect(woodSale.equipment.instances.find((item) => item.instanceId === gloveId)?.usesRemaining).toBe(99);

    const featherSale = await service.sell(player, accountId, sale("coinwright-feather", feather));
    expect(featherSale.walletGold).toBe("1227");
    expect(usesLeft()).toBe(98);
    const replay = await service.sell(player, accountId, sale("coinwright-feather", feather));
    expect(replay).toMatchObject({ replayed: true, walletGold: "1227" });
    const stored = await pool.query<{ uses_remaining: number }>(
      "SELECT uses_remaining FROM equipment_instances WHERE instance_id=$1", [gloveId]
    );
    expect(stored.rows[0]?.uses_remaining).toBe(98);
  });

  it("keeps an unsaved kit activation through a sale and never sells the item it wears", async () => {
    // Kit 1 = a spare sword; it is activated in memory only (not yet saved) before the sale.
    const kitSword = randomUUID();
    const worn = randomUUID();
    for (const id of [kitSword, worn]) {
      await pool.query(
        `INSERT INTO equipment_instances (
           instance_id,definition_id,owner_player_id,location,item_level,
           balance_version,created_by_operation_key
         ) VALUES ($1,'starter_sword',$2,'inventory',0,1,'goblin-test-equipment')`,
        [id, playerId]
      );
    }
    await pool.query(
      "UPDATE player_equipment_state SET inventory_revision=inventory_revision+1 WHERE player_id=$1", [playerId]
    );
    let snapshot = await equipment.refreshInventorySlots(playerId);
    await equipment.equip(playerId, kitSword, "melee", randomUUID());
    snapshot = equipment.runtimeSnapshot(playerId)!;
    await equipment.saveCombatKit(playerId, 1, snapshot.inventoryRevision, randomUUID());
    await equipment.equip(playerId, worn, "melee", randomUUID());
    snapshot = equipment.runtimeSnapshot(playerId)!;
    const requestId = randomUUID();
    await equipment.stageKitActivation(playerId, { requestId, kitIndex: 1, expectedInventoryRevision: snapshot.inventoryRevision });
    equipment.markActivationApplied(playerId, requestId, 1);
    expect(equipment.runtimeSnapshot(playerId)!.active.melee?.instanceId).toBe(kitSword);

    const player = runtimePlayer(position);
    const lines = (await service.openMarket(player, marketId)).lines;
    const wood = lines.find((line) => line.kind === "resource" && line.displayName === "Wood");
    if (wood) await service.sell(player, accountId, sale(`kit-wood-${requestId}`, wood));
    // The activation was saved before the sale, so the kit sword is worn, not carried, and is not offered.
    const after = (await service.openMarket(player, marketId)).lines;
    expect(after.some((line) => line.kind === "equipment" && line.identity === kitSword)).toBe(false);
    expect(equipment.runtimeSnapshot(playerId)!.active.melee?.instanceId).toBe(kitSword);
    const durable = await pool.query<{ location: string; equipped_slot: string | null }>(
      "SELECT location, equipped_slot FROM equipment_instances WHERE instance_id=$1", [kitSword]
    );
    expect(durable.rows[0]).toMatchObject({ location: "equipped", equipped_slot: "melee" });
  });

  it("denies new sales outside proximity and after durable hostility", async () => {
    const line = (await service.openMarket(runtimePlayer(position), marketId)).lines[0]!;
    await expect(service.sell(runtimePlayer({ lat: 36, lon: -107 }), accountId, sale("far-sale", line)))
      .rejects.toMatchObject({ code: "GOBLIN_MARKET_ACCESS_DENIED" });
    await pool.query(
      `INSERT INTO npc_city_player_relations (city_id,player_id,first_hostile_request_id)
       VALUES ($1,$2,'hostile-test')`,
      [cityId, playerId]
    );
    await expect(service.sell(runtimePlayer(position), accountId, sale("enemy-sale", line)))
      .rejects.toMatchObject({ code: "GOBLIN_MARKET_ACCESS_DENIED" });
    expect((await wallet.snapshot(playerId, accountId)).gold).toBe("0");
  });

  it("sells wheat seeds to players with fixed stock, capacity authority, and replay safety", async () => {
    const opened = await service.openMarket(runtimePlayer(position), marketId);
    expect(opened.buyLines).toContainEqual(expect.objectContaining({
      itemId: "wheat_seed",
      quantity: 250,
      unitPriceGold: "10"
    }));
    await creditGold(20, "goblin-seed-funds");

    const purchaseInput = {
      requestId: "wheat-seed-purchase",
      marketStructureId: marketId,
      itemId: "wheat_seed" as const,
      quantity: 2,
      expectedUnitPriceGold: "10"
    };
    const purchased = await service.buy(runtimePlayer(position), accountId, purchaseInput);
    expect(purchased).toMatchObject({ replayed: false, itemId: "wheat_seed", quantity: 2, totalGold: "20" });
    expect(purchased.snapshot.buyLines).toContainEqual(expect.objectContaining({ quantity: 248 }));
    expect(purchased.inventory.items).toContainEqual(expect.objectContaining({ resourceType: "wheat_seed", quantity: 2 }));
    expect(purchased.walletGold).toBe("0");

    const replay = await service.buy(runtimePlayer({ lat: 36, lon: -107 }), accountId, purchaseInput);
    expect(replay).toMatchObject({ replayed: true, quantity: 2, totalGold: "20" });
    await expect(service.buy(runtimePlayer(position), accountId, {
      ...purchaseInput,
      quantity: 1
    })).rejects.toMatchObject({ code: "GOBLIN_MARKET_REQUEST_CONFLICT" });
    await expect(service.buy(runtimePlayer({ lat: 36, lon: -107 }), accountId, {
      ...purchaseInput,
      requestId: "wheat-seed-far-purchase",
      quantity: 1
    })).rejects.toMatchObject({ code: "GOBLIN_MARKET_ACCESS_DENIED" });
    await expect(service.buy(runtimePlayer(position), accountId, {
      ...purchaseInput,
      requestId: "wheat-seed-insufficient-purchase",
      quantity: 1
    })).rejects.toMatchObject({ code: "WALLET_INSUFFICIENT_FUNDS" });
  });

  it("commits a remotely placed 19-tower village footprint, market band, and durable defenders", async () => {
    const center = { lat: 36.2, lon: -107.4 };
    expect(distanceMeters(position, center)).toBeGreaterThan(250);
    const dynamicCities = {
      getCity: async (requestedCityId: string) => {
        const result = await pool.query<{ id: string; name: string }>(
          "SELECT id::text,name FROM cities WHERE id=$1",
          [requestedCityId]
        );
        return result.rows[0]
          ? { id: result.rows[0].id, name: result.rows[0].name }
          : null;
      },
      structures: {
        listForCity: async (requestedCityId: string) => {
          const result = await pool.query<{
            structure_id: string;
            city_id: string;
            lat: number;
            lon: number;
          }>(
            `SELECT structure_id::text,city_id::text,lat,lon
             FROM city_structures WHERE city_id=$1`,
            [requestedCityId]
          );
          return result.rows.map((row) => ({
            structureId: row.structure_id,
            cityId: row.city_id,
            type: "market" as const,
            tier: 1 as const,
            state: "active" as const,
            lat: Number(row.lat),
            lon: Number(row.lon)
          }));
        }
      }
    } as unknown as CityService;
    const dynamicFlags = {
      getMapFlag: async (id: string) => ({ id })
    } as unknown as FlagService;
    const worldLookup = {
      lookupGameplayEnvironments: async (points: readonly { lat: number; lon: number }[]) =>
        points.map((point) => ({
          ok: true,
          contractVersion: "gameplay-environment-v1" as const,
          runtime: null,
          latitude: point.lat,
          longitude: point.lon,
          countryCode: "US",
          regionCode: "NM",
          packageId: "test-land",
          elevationM: 1,
          terrainClass: "land",
          biome: "temperate",
          ecoregion: "test",
          isLand: true,
          isSaltwater: false,
          insideMajorLake: false,
          raw: {}
        }))
    } as unknown as WorldLookupClient;
    let combatRegionCodes: readonly string[] = [];
    let combatZoneIds: readonly string[] = [];
    const combat = new CombatEngine({
      tickRateHz: 20,
      playerMovementSpeedMps: 40,
      isPlayerAuthorityActive: () => true,
      getAuthoritativeViewCircle: () => ({
        anchorType: "flag",
        anchorId: "goblin-village-test-view",
        center,
        radiusM: 3_000,
        generation: 1,
        eligibleRegionCodes: combatRegionCodes,
        eligibleZoneIds: combatZoneIds
      })
    });
    const notifyZoneReady = vi.fn(async () => undefined);
    const spawnService = new GoblinVillageService(
      pool,
      {
        WORLD_ID: "main",
        FLAG_CLAIM_RADIUS_M: 100,
        FLAG_RESOURCE_VISION_RADIUS_M: 650
      } as AppConfig,
      worldLookup,
      dynamicCities,
      dynamicFlags,
      inventory,
      equipment,
      backpacks,
      wallet,
      combat,
      { notifyZoneReady } as never
    );

    const spawned = await spawnService.spawn(
      runtimePlayer(position),
      "goblin-village-real-spawn",
      center
    );
    expect(spawned.flags).toHaveLength(19);
    expect(distanceMeters(center, spawned.market)).toBeGreaterThanOrEqual(300);
    expect(distanceMeters(center, spawned.market)).toBeLessThanOrEqual(450);
    await expect(pool.query(
      `SELECT count(*)::int AS count FROM flags
       WHERE city_id=$1 AND reinforcement_level=3 AND system_controlled
         AND presentation_color='#174f2a'`,
      [spawned.city.id]
    )).resolves.toMatchObject({ rows: [{ count: 19 }] });
    await expect(pool.query(
      "SELECT count(*)::int AS count FROM npc_city_defender_slots WHERE city_id=$1",
      [spawned.city.id]
    )).resolves.toMatchObject({ rows: [{ count: 8 }] });
    const populationOverrideCount = Number((await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM goblin_village_population_overrides WHERE city_id=$1",
      [spawned.city.id]
    )).rows[0]?.count ?? 0);
    expect(populationOverrideCount).toBeGreaterThan(0);
    expect(notifyZoneReady).toHaveBeenCalledTimes(populationOverrideCount);
    const defenderSlots = (await pool.query<{ defender_id: string; lat: number; lon: number }>(
      "SELECT defender_id::text,lat,lon FROM npc_city_defender_slots WHERE city_id=$1",
      [spawned.city.id]
    )).rows;
    const defenderIds = defenderSlots.map((row) => `goblin-defender:${row.defender_id}`);
    combatRegionCodes = [...new Set(defenderSlots.map((slot) => packageIdForPosition({
      lat: Number(slot.lat),
      lon: Number(slot.lon)
    })))];
    combatZoneIds = [...new Set(defenderSlots.map((slot) => zoneIdForPosition({
      lat: Number(slot.lat),
      lon: Number(slot.lon)
    })))];
    combat.connectPlayer({
      playerId,
      name: playerId,
      regionCode: packageIdForPosition(center),
      zoneId: zoneIdForPosition(center),
      position: center,
      accountId,
      connectionId: "goblin-village-test-connection",
      profile: {
        playerId,
        maxHealth: 100,
        currentHealth: 100,
        baseAttackDamage: 10
      }
    });
    const combatInterest = combat.buildInterestFrame([playerId]);
    const visibleDefenderIds = combat.snapshotForPlayer(playerId, combatInterest).upserts
      .filter((entity) => entity.entityId.startsWith("goblin-defender:"))
      .map((entity) => entity.entityId);
    expect(visibleDefenderIds).toHaveLength(8);
    expect(visibleDefenderIds).toEqual(expect.arrayContaining(defenderIds));

    await pool.query(
      `INSERT INTO goblin_market_sales (
         player_id,request_id,account_id,city_id,market_structure_id,
         item_kind,item_identity,quantity,offer_gold
       ) VALUES ($1,'retained-delete-audit',$2,$3,$4,'resource','retained-stack',1,1)`,
      [playerId, accountId, spawned.city.id, spawned.market.structureId]
    );
    const deletion = await spawnService.deleteVillage(
      playerId,
      "delete-spawned-village",
      spawned.city.id
    );
    expect(deletion).toMatchObject({
      replayed: false,
      city: { cityId: spawned.city.id },
      removedFlagIds: expect.arrayContaining(spawned.flags.map((flag) => flag.id)),
      structureIds: [spawned.market.structureId]
    });
    await expect(spawnService.deleteVillage(
      playerId,
      "delete-spawned-village",
      spawned.city.id
    )).resolves.toMatchObject({ replayed: true, city: { cityId: spawned.city.id } });
    await expect(pool.query(
      `SELECT city.active,city.jumpable,city.inactive_reason,city.seat_flag_id,
              structure.state,structure.destroyed_at IS NOT NULL AS destroyed,
              (SELECT count(*)::int FROM flags WHERE city_id=city.id) AS flag_count,
              (SELECT count(*)::int FROM goblin_village_spawns WHERE city_id=city.id) AS spawn_count,
              (SELECT count(*)::int FROM goblin_market_sales WHERE city_id=city.id) AS sale_count
       FROM cities city
       JOIN city_structures structure ON structure.city_id=city.id
       WHERE city.id=$1`,
      [spawned.city.id]
    )).resolves.toMatchObject({ rows: [{
      active: false,
      jumpable: false,
      inactive_reason: "destroyed",
      seat_flag_id: null,
      state: "destroyed",
      destroyed: true,
      flag_count: 0,
      spawn_count: 1,
      sale_count: 1
    }] });
    expect((await spawnService.listActiveVillages())
      .some((village) => village.cityId === spawned.city.id)).toBe(false);
    expect(defenderIds.every((entityId) => combat.entity(entityId) === null)).toBe(true);
    await expect(pool.query(
      "SELECT count(*)::int AS count FROM goblin_village_population_overrides WHERE city_id=$1",
      [spawned.city.id]
    )).resolves.toMatchObject({ rows: [{ count: 0 }] });
    expect(notifyZoneReady).toHaveBeenCalledTimes(populationOverrideCount * 3);

    const humanCityId = randomUUID();
    await pool.query(
      `INSERT INTO cities (
         id,world_id,canonical_municipality_id,world_settlement_id,world_settlement_source,
         world_source_settlement_id,name,country_code,founder_player_id,founding_request_id,
         hall_lat,hall_lon,hall_geom,founding_annex_radius_m,controller_kind,culture,banner_color
       ) VALUES ($1,'main',$2,$2,'system','human-test','Human City','US',$3,$4,
                 $5,$6,ST_SetSRID(ST_MakePoint($6,$5),4326),500,'player','human','#000000')`,
      [humanCityId, `human-${humanCityId}`, playerId, `human-${humanCityId}`, position.lat, position.lon]
    );
    await expect(spawnService.deleteVillage(
      playerId,
      "reject-human-city-delete",
      humanCityId
    )).rejects.toMatchObject({ code: "GOBLIN_VILLAGE_DELETE_NOT_ALLOWED" });
    await expect(pool.query("SELECT active FROM cities WHERE id=$1", [humanCityId]))
      .resolves.toMatchObject({ rows: [{ active: true }] });
  });

  function runtimePlayer(at: { lat: number; lon: number }): PlayerRecord {
    return { playerId, position: at, anchor: position } as PlayerRecord;
  }

  function sale(requestId: string, line: Awaited<ReturnType<typeof service.openMarket>>["lines"][number]) {
    return {
      requestId,
      marketStructureId: marketId,
      itemKind: line.kind,
      itemIdentity: line.identity,
      quantity: line.quantity,
      expectedOfferGold: line.offerGold
    };
  }

  async function creditGold(amount: number, operationKey: string): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await wallet.creditForOperationInTransaction(client, {
        playerId,
        accountId,
        amount: BigInt(amount),
        operationKey,
        reason: "goblin_market_test_funds"
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
});

function safeDisposableDatabaseUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = new URL(value);
  const databaseName = parsed.pathname.slice(1);
  if (
    parsed.hostname !== "127.0.0.1" ||
    parsed.port === "35432" ||
    !databaseName.startsWith("ash_atlas_stability")
  ) {
    throw new Error(
      "SETTLEMENT_TEST_DATABASE_URL must target a local ash_atlas_stability database outside the retained port"
    );
  }
  return parsed.toString();
}
