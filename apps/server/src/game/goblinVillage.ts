import { createHash, randomUUID } from "node:crypto";

import {
  CITY_MARKET_INTERACTION_RADIUS_M,
  CITY_STRUCTURE_FOOTPRINT_RADIUS_M,
  EQUIPMENT_MAX_CONDITION,
  INVENTORY_CATALOG,
  wanderingMerchantUnitPrice,
  classifyFlagPlacementTerrain,
  destinationPoint,
  distanceMeters,
  equipmentRepairCostForFamily,
  requireEquipmentDefinition,
  type BackpackSnapshot,
  type CitySnapshot,
  type CityStructureSnapshot,
  type EquipmentSnapshotV2,
  type FlagSnapshot,
  type GoblinMarketBuyLine,
  type GoblinMarketSnapshot,
  type PlayerInventorySnapshot,
  type ResourceType
} from "@ash-atlas/shared";
import type pg from "pg";

import type { AppConfig } from "../config.js";
import type { WorldLookupClient } from "../world/worldLookupClient.js";
import type { BackpackService } from "./backpacks.js";
import type { CityService } from "./cities.js";
import type { CombatEngine } from "./combat/combatEngine.js";
import type { EquipmentService } from "./equipment.js";
import { lockFlagControlGeometry } from "./flagControlGeometry.js";
import {
  goblinMarketBackpackOfferGold,
  goblinMarketEquipmentOfferGold,
  GOBLIN_MARKET_RESOURCE_UNIT_PRICES,
  goblinMarketResourceOfferGold,
  GOBLIN_MARKET_WHEAT_SEED_INITIAL_STOCK,
  GOBLIN_MARKET_WHEAT_SEED_ITEM_ID,
  GOBLIN_MARKET_WHEAT_SEED_UNIT_PRICE_GOLD
} from "./goblinMarketPricing.js";
import { tradeSkillRank } from "./skills/tradeSkillRank.js";
import { prepareFlagEnvironmentPersistence } from "./flagEnvironmentPersistence.js";
import type { FlagService } from "./flags.js";
import type { InventoryService } from "./inventory.js";
import type { PlayerRecord } from "./state.js";
import {
  populationZonesV2IntersectingCircle,
  type PopulationZoneV2Id
} from "./populationZonesV2Geometry.js";
import type { PopulationZonesV2Runtime } from "./populationZonesV2Runtime.js";
import { packageIdForPosition, zoneIdForPosition } from "./spatialZones.js";
import type { WalletService } from "./wallet.js";
import { coinwrightDumpBonusInTransaction } from "./utilityGear.js";

const GOBLIN_VILLAGE_NAME = "Goblin Village";
export const GOBLIN_BANNER_COLOR = "#174f2a";
const DEFENDER_ARCHER_COUNT = 4;

type Position = Readonly<{ lat: number; lon: number }>;
type SaleKind = "resource" | "equipment" | "backpack";

export class GoblinVillageError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "GoblinVillageError";
  }
}

export type GoblinVillageSpawnResult = Readonly<{
  replayed: boolean;
  city: CitySnapshot;
  flags: FlagSnapshot[];
  market: CityStructureSnapshot;
}>;

export type ActiveGoblinVillage = Readonly<{
  cityId: string;
  name: string;
  hallLat: number;
  hallLon: number;
  flagCount: number;
  createdAt: string;
}>;

export type GoblinVillageDeletionResult = Readonly<{
  replayed: boolean;
  city: Readonly<{ cityId: string; name: string; hallLat: number; hallLon: number }>;
  removedFlagIds: string[];
  structureIds: string[];
  affectedZoneIds: string[];
}>;

export type GoblinMarketSaleResult = Readonly<{
  replayed: boolean;
  offerGold: string;
  snapshot: GoblinMarketSnapshot;
  inventory: PlayerInventorySnapshot;
  equipment: EquipmentSnapshotV2;
  backpacks: BackpackSnapshot;
  walletGold: string;
  walletVersion: string;
}>;

export type GoblinMarketPurchaseResult = Readonly<{
  replayed: boolean;
  itemId: typeof GOBLIN_MARKET_WHEAT_SEED_ITEM_ID;
  quantity: number;
  totalGold: string;
  snapshot: GoblinMarketSnapshot;
  inventory: PlayerInventorySnapshot;
  walletGold: string;
  walletVersion: string;
}>;

export class GoblinVillageService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly config: AppConfig,
    private readonly worldLookup: WorldLookupClient,
    private readonly cities: CityService,
    private readonly flags: FlagService,
    private readonly inventory: InventoryService,
    private readonly equipment: EquipmentService,
    private readonly backpacks: BackpackService,
    private readonly wallet: WalletService,
    private readonly combat: CombatEngine,
    private readonly populationRuntime: PopulationZonesV2Runtime
  ) {}

  async spawn(
    player: PlayerRecord,
    requestId: string,
    center: Position
  ): Promise<GoblinVillageSpawnResult> {
    assertRequestId(requestId);
    const replay = await this.findSpawn(player.playerId, requestId, center);
    if (replay) {
      await this.convergeActiveVillageRuntime(replay.city.id);
      return replay;
    }
    const flagPositions = goblinVillageHexPositions(center, this.config.FLAG_CLAIM_RADIUS_M + 1);
    const populationZoneIds = populationZonesForClaims(
      flagPositions.map((position) => ({
        position,
        claimRadiusM: this.config.FLAG_CLAIM_RADIUS_M
      }))
    );
    const marketPlacement = goblinMarketPlacement(center, `${player.playerId}:${requestId}`);
    const marketPosition = marketPlacement.position;
    const environmentPoints = [...flagPositions, marketPosition];
    const worlds = await this.worldLookup.lookupGameplayEnvironments(environmentPoints, {
      caller: "city",
      priority: 1
    });
    for (const [index, world] of worlds.entries()) {
      if (!world.ok || classifyFlagPlacementTerrain(world) === "water") {
        throw new GoblinVillageError(
          "GOBLIN_VILLAGE_TERRAIN_UNAVAILABLE",
          `Goblin Village footprint point ${index + 1} requires authoritative available land`
        );
      }
    }

    const cityId = randomUUID();
    const flagIds = flagPositions.map(() => randomUUID());
    const marketId = randomUUID();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT id FROM players WHERE id=$1 FOR UPDATE", [player.playerId]);
      await lockFlagControlGeometry(client);
      const lockedReplay = await this.findSpawn(player.playerId, requestId, center, client);
      if (lockedReplay) {
        await client.query("COMMIT");
        await this.convergeActiveVillageRuntime(lockedReplay.city.id);
        return lockedReplay;
      }
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `goblin-village:${this.config.WORLD_ID}`
      ]);
      await assertFootprintAvailable(
        client,
        flagPositions,
        this.config.FLAG_CLAIM_RADIUS_M,
        marketPosition
      );

      const centerWorld = worlds[0]!;
      await client.query(
        `INSERT INTO cities (
           id,world_id,canonical_municipality_id,world_settlement_id,
           world_settlement_source,world_source_settlement_id,name,country_code,region_code,
           founder_player_id,founding_request_id,hall_lat,hall_lon,hall_geom,
           founding_annex_radius_m,active,jumpable,construction_phase,
           construction_completed_at,controller_kind,culture,banner_color,seat_flag_id
         ) VALUES (
           $1,$2,$3,$3,'system','goblin-village',$4,$5,$6,$7,$8,$9,$10,
           ST_SetSRID(ST_MakePoint($10,$9),4326),$11,true,true,'complete',now(),
           'npc','goblin',$12,NULL
         )`,
        [
          cityId,
          this.config.WORLD_ID,
          `npc:goblin:${cityId}`,
          GOBLIN_VILLAGE_NAME,
          centerWorld.countryCode ?? "XX",
          centerWorld.regionCode,
          player.playerId,
          requestId,
          center.lat,
          center.lon,
          annexRadiusM(flagPositions, center, this.config.FLAG_CLAIM_RADIUS_M),
          GOBLIN_BANNER_COLOR
        ]
      );

      for (const [index, position] of flagPositions.entries()) {
        const environment = prepareFlagEnvironmentPersistence(worlds[index]!);
        await client.query(
          `INSERT INTO flags (
             id,owner_id,name,lat,lon,package_id,elevation_m,terrain_class,biome,ecoregion,
             claim_radius_m,resource_vision_radius_m,environment_snapshot,geom,
             control_type,city_id,access_mode,jump_toll_gold,city_affiliated_at,
             reinforcement_level,health,maximum_health,presentation_color,system_controlled
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,
             ST_SetSRID(ST_MakePoint($5,$4),4326),$14,$15,'public',0,now(),3,200,200,$16,true
           )`,
          [
            flagIds[index],
            player.playerId,
            `${GOBLIN_VILLAGE_NAME}'s Tower`,
            position.lat,
            position.lon,
            environment.packageId,
            environment.elevationM,
            environment.terrainClass,
            environment.biome,
            environment.ecoregion,
            this.config.FLAG_CLAIM_RADIUS_M,
            this.config.FLAG_RESOURCE_VISION_RADIUS_M,
            environment.snapshotJson,
            index === 0 ? "city_seat" : "city",
            cityId,
            GOBLIN_BANNER_COLOR
          ]
        );
      }
      await client.query("UPDATE cities SET seat_flag_id=$2 WHERE id=$1", [cityId, flagIds[0]]);

      prepareFlagEnvironmentPersistence(worlds[worlds.length - 1]!);
      await client.query(
        `INSERT INTO city_structures (
           structure_id,city_id,structure_type,tier,district_type,owner_player_id,
           world_id,region_code,lat,lon,geom,footprint_geom,footprint_radius_m,
           state,build_operation_key,construction_started_at,construction_completes_at,built_at
         ) VALUES (
           $1,$2,'market',1,NULL,NULL,$3,$4,$5,$6,
           ST_SetSRID(ST_MakePoint($6,$5),4326),
           ST_Buffer(ST_SetSRID(ST_MakePoint($6,$5),4326)::geography,$7)::geometry,
           $7,'active',$8,NULL,NULL,now()
         )`,
        [
          marketId,
          cityId,
          this.config.WORLD_ID,
          worlds[worlds.length - 1]!.regionCode ?? centerWorld.regionCode,
          marketPosition.lat,
          marketPosition.lon,
          CITY_STRUCTURE_FOOTPRINT_RADIUS_M.market,
          `goblin-village:${cityId}:market`
        ]
      );
      await insertDefenderSlots(client, cityId, flagIds, flagPositions, marketPosition, centerWorld.regionCode);
      await persistPopulationOverrides(client, cityId, populationZoneIds);
      await recomputeMobSuppression(client, populationZoneIds);
      await client.query(
        `INSERT INTO goblin_village_spawns (player_id,request_id,city_id,center_lat,center_lon)
         VALUES ($1,$2,$3,$4,$5)`,
        [player.playerId, requestId, cityId, center.lat, center.lon]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    await this.refreshWarmZones(populationZoneIds);
    await this.materializeCityDefenders(cityId);
    return this.requireSpawn(cityId, false);
  }

  async reconcileActiveVillages(): Promise<void> {
    const active = await this.activeVillageClaims();
    const zonesByCity = new Map<string, PopulationZoneV2Id[]>();
    for (const village of active) {
      zonesByCity.set(village.cityId, populationZonesForClaims(
        village.flags
      ));
    }
    const client = await this.pool.connect();
    let affectedZoneIds: PopulationZoneV2Id[] = [];
    try {
      await client.query("BEGIN");
      const previous = await client.query<{ zone_id: PopulationZoneV2Id }>(
        "SELECT DISTINCT zone_id FROM goblin_village_population_overrides"
      );
      await client.query("DELETE FROM goblin_village_population_overrides");
      for (const [cityId, zoneIds] of zonesByCity) {
        await persistPopulationOverrides(client, cityId, zoneIds);
      }
      affectedZoneIds = uniqueSortedPopulationZones([
        ...previous.rows.map((row) => row.zone_id),
        ...[...zonesByCity.values()].flat()
      ]);
      await recomputeMobSuppression(client, affectedZoneIds);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    await this.refreshWarmZones(affectedZoneIds);
    for (const village of active) await this.materializeCityDefenders(village.cityId);
  }

  async listActiveVillages(): Promise<ActiveGoblinVillage[]> {
    const result = await this.pool.query<{
      city_id: string; name: string; hall_lat: number; hall_lon: number;
      flag_count: number; created_at: Date | string;
    }>(
      `SELECT city.id::text AS city_id,city.name,city.hall_lat,city.hall_lon,
              count(flag.id)::int AS flag_count,city.created_at
       FROM cities city
       LEFT JOIN flags flag ON flag.city_id=city.id
       WHERE city.active AND city.controller_kind='npc' AND city.culture='goblin'
       GROUP BY city.id ORDER BY city.created_at,city.id`
    );
    return result.rows.map((row) => ({
      cityId: row.city_id,
      name: row.name,
      hallLat: Number(row.hall_lat),
      hallLon: Number(row.hall_lon),
      flagCount: Number(row.flag_count),
      createdAt: new Date(row.created_at).toISOString()
    }));
  }

  async deleteVillage(
    actorPlayerId: string,
    requestId: string,
    cityId: string
  ): Promise<GoblinVillageDeletionResult> {
    assertRequestId(requestId);
    const client = await this.pool.connect();
    let result: GoblinVillageDeletionResult;
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `goblin-village-delete:${actorPlayerId}:${requestId}`
      ]);
      const replay = await client.query<{ city_id: string; result: GoblinVillageDeletionResult }>(
        `SELECT city_id::text,result FROM goblin_village_deletions
         WHERE actor_player_id=$1 AND request_id=$2 FOR UPDATE`,
        [actorPlayerId, requestId]
      );
      if (replay.rows[0]) {
        if (replay.rows[0].city_id !== cityId) {
          throw new GoblinVillageError(
            "GOBLIN_VILLAGE_DELETE_REQUEST_CONFLICT",
            "This request ID was already used for a different Goblin Village"
          );
        }
        const replayed = { ...replay.rows[0].result, replayed: true };
        await client.query("COMMIT");
        this.combat.despawnNpcCityDefenders(cityId);
        await this.refreshWarmZones(replayed.affectedZoneIds as PopulationZoneV2Id[]);
        return replayed;
      }
      const city = await client.query<{
        city_id: string; name: string; hall_lat: number; hall_lon: number;
        active: boolean; controller_kind: string; culture: string;
      }>(
        `SELECT id::text AS city_id,name,hall_lat,hall_lon,active,controller_kind,culture
         FROM cities WHERE id=$1 FOR UPDATE`,
        [cityId]
      );
      const village = city.rows[0];
      if (!village || !village.active || village.controller_kind !== "npc" || village.culture !== "goblin") {
        throw new GoblinVillageError(
          "GOBLIN_VILLAGE_DELETE_NOT_ALLOWED",
          "Only an active NPC Goblin Village can be deleted"
        );
      }
      await lockFlagControlGeometry(client);
      const flags = await client.query<{ id: string }>(
        "SELECT id::text FROM flags WHERE city_id=$1 ORDER BY id FOR UPDATE",
        [cityId]
      );
      const removedFlagIds = flags.rows.map((row) => row.id);
      const structures = await client.query<{ structure_id: string }>(
        "SELECT structure_id::text FROM city_structures WHERE city_id=$1 ORDER BY structure_id FOR UPDATE",
        [cityId]
      );
      const structureIds = structures.rows.map((row) => row.structure_id);
      const overrides = await client.query<{ zone_id: PopulationZoneV2Id }>(
        "SELECT zone_id FROM goblin_village_population_overrides WHERE city_id=$1 FOR UPDATE",
        [cityId]
      );
      const affectedZoneIds = uniqueSortedPopulationZones(overrides.rows.map((row) => row.zone_id));

      await client.query("DELETE FROM npc_city_defender_slots WHERE city_id=$1", [cityId]);
      await client.query("DELETE FROM npc_city_player_relations WHERE city_id=$1", [cityId]);
      await client.query("DELETE FROM goblin_village_population_overrides WHERE city_id=$1", [cityId]);
      if (removedFlagIds.length > 0) {
        await client.query("DELETE FROM travel_invites WHERE source_flag_id=ANY($1::uuid[])", [removedFlagIds]);
      }
      await client.query(
        `UPDATE city_structures
         SET state='destroyed',destroyed_at=COALESCE(destroyed_at,now()),updated_at=now()
         WHERE city_id=$1 AND state<>'destroyed'`,
        [cityId]
      );
      await client.query(
        `UPDATE cities
         SET active=false,jumpable=false,inactive_reason='destroyed',ended_at=now(),
             rebuild_available_at=now() + interval '7 days',seat_flag_id=NULL,updated_at=now()
         WHERE id=$1`,
        [cityId]
      );
      if (removedFlagIds.length > 0) {
        await client.query("DELETE FROM flags WHERE id=ANY($1::uuid[])", [removedFlagIds]);
      }
      await recomputeMobSuppression(client, affectedZoneIds);
      result = {
        replayed: false,
        city: {
          cityId,
          name: village.name,
          hallLat: Number(village.hall_lat),
          hallLon: Number(village.hall_lon)
        },
        removedFlagIds,
        structureIds,
        affectedZoneIds
      };
      await client.query(
        `INSERT INTO goblin_village_deletions (actor_player_id,request_id,city_id,result)
         VALUES ($1,$2,$3,$4::jsonb)`,
        [actorPlayerId, requestId, cityId, JSON.stringify(result)]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    this.combat.despawnNpcCityDefenders(cityId);
    await this.refreshWarmZones(result.affectedZoneIds as PopulationZoneV2Id[]);
    return result;
  }

  async relation(
    cityId: string,
    playerId: string,
    queryable: Pick<pg.Pool | pg.PoolClient, "query"> = this.pool
  ): Promise<"neutral" | "enemy"> {
    const result = await queryable.query(
      "SELECT 1 FROM npc_city_player_relations WHERE city_id=$1 AND player_id=$2",
      [cityId, playerId]
    );
    return result.rowCount ? "enemy" : "neutral";
  }

  async confirmHostility(cityId: string, playerId: string, requestId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockGoblinPlayer(client, playerId);
      await client.query(
        `INSERT INTO npc_city_player_relations (
         city_id,player_id,relation,first_hostile_request_id
       ) VALUES ($1,$2,'enemy',$3)
       ON CONFLICT (city_id,player_id) DO NOTHING`,
        [cityId, playerId, requestId]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    this.combat.markNpcCityPlayerEnemy(cityId, playerId);
  }

  canDefenderAttack(entityId: string, playerId: string): boolean | null {
    const faction = this.combat.npcFactionForEntity(entityId);
    return faction
      ? this.combat.isNpcCityPlayerEnemy(faction.cityId, playerId)
      : null;
  }

  defenderCity(entityId: string): string | null {
    return this.combat.npcFactionForEntity(entityId)?.cityId ?? null;
  }

  async openMarket(
    player: PlayerRecord,
    marketStructureId: string
  ): Promise<GoblinMarketSnapshot> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockGoblinPlayer(client, player.playerId);
      const market = await this.requireMarket(player, marketStructureId, client);
      const snapshot = await this.marketSnapshot(player.playerId, market, client);
      await client.query("COMMIT");
      return snapshot;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async sell(
    player: PlayerRecord,
    accountId: string,
    input: Readonly<{
      requestId: string;
      marketStructureId: string;
      itemKind: SaleKind;
      itemIdentity: string;
      quantity: number;
      expectedOfferGold: string;
    }>
  ): Promise<GoblinMarketSaleResult> {
    assertRequestId(input.requestId);
    // Save an applied but unsaved kit activation first, so an item worn only in memory is never
    // sold as carried.
    await this.equipment.flushPendingCheckpoint(player.playerId);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockGoblinPlayer(client, player.playerId);
      const replay = await client.query<{
        account_id: string;
        market_structure_id: string;
        item_kind: SaleKind;
        item_identity: string;
        quantity: string;
        offer_gold: string;
        result: GoblinMarketSaleResult | null;
      }>(
        `SELECT account_id,market_structure_id::text,item_kind,item_identity,
                quantity::text,offer_gold::text,result
         FROM goblin_market_sales
         WHERE player_id=$1 AND request_id=$2 FOR UPDATE`,
        [player.playerId, input.requestId]
      );
      const prior = replay.rows[0];
      if (prior && (
        prior.account_id !== accountId ||
        prior.market_structure_id !== input.marketStructureId ||
        prior.item_kind !== input.itemKind ||
        prior.item_identity !== input.itemIdentity ||
        Number(prior.quantity) !== input.quantity ||
        prior.offer_gold !== input.expectedOfferGold
      )) {
        throw new GoblinVillageError(
          "GOBLIN_MARKET_REQUEST_CONFLICT",
          "This request ID was already used for a different Goblin Market sale"
        );
      }
      if (prior?.result) {
        const result = { ...prior.result, replayed: true };
        await client.query("COMMIT");
        await this.equipment.syncUtilityGear(player.playerId);
        return result;
      }
      if (replay.rowCount) {
        throw new GoblinVillageError("GOBLIN_MARKET_REQUEST_INCOMPLETE", "Sale request is incomplete");
      }
      const market = await this.requireMarket(player, input.marketStructureId, client, accountId);
      const lines = await this.marketLines(player.playerId, client);
      const selected = lines.find(
        (line) => line.kind === input.itemKind && line.identity === input.itemIdentity
      );
      if (
        !selected || selected.quantity !== input.quantity ||
        selected.offerGold !== input.expectedOfferGold
      ) {
        throw new GoblinVillageError(
          "GOBLIN_MARKET_OFFER_CHANGED",
          "The carried item or server-authored offer changed"
        );
      }
      const offer = BigInt(selected.offerGold);
      await client.query(
        `INSERT INTO goblin_market_sales (
           player_id,request_id,account_id,city_id,market_structure_id,
           item_kind,item_identity,quantity,offer_gold
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          player.playerId,
          input.requestId,
          accountId,
          market.cityId,
          market.structureId,
          input.itemKind,
          input.itemIdentity,
          input.quantity,
          offer.toString()
        ]
      );

      if (input.itemKind === "resource") {
        const item = (await this.inventory.snapshotInTransaction(client, player.playerId)).items
          .find((candidate) => candidate.stackId === input.itemIdentity);
        if (!item || item.quantity !== input.quantity) {
          throw new GoblinVillageError("GOBLIN_MARKET_ITEM_CHANGED", "Resource stack changed");
        }
        await this.inventory.debitItemsForOperationInTransaction(client, {
          operationKey: `goblin-sale:${player.playerId}:${input.requestId}`,
          playerId: player.playerId,
          source: "goblin_market_sale",
          sourceEntityType: "city_structure",
          sourceEntityId: market.structureId,
          preferredStackId: item.stackId!,
          debits: [{ itemId: item.resourceType, variant: item.variant, quantity: item.quantity }]
        });
      } else if (input.itemKind === "equipment") {
        await this.equipment.destroyCarriedInstanceForGoblinSaleInTransaction(
          client,
          player.playerId,
          input.itemIdentity
        );
      } else {
        await this.backpacks.destroyCarriedInstanceForGoblinSaleInTransaction(
          client,
          player.playerId,
          input.itemIdentity
        );
      }
      // A worn Coinwright Glove: +22% (rounded down) per item, one use for this whole dump.
      const coinwright = await coinwrightDumpBonusInTransaction(client, player.playerId, [
        { unitGold: offer / BigInt(input.quantity), count: input.quantity }
      ]);
      const wallet = await this.wallet.creditForOperationInTransaction(client, {
        playerId: player.playerId,
        accountId,
        amount: offer + coinwright.bonusGold,
        operationKey: `goblin-sale:${player.playerId}:${input.requestId}`,
        reason: "goblin_market_sale",
        metadata: {
          cityId: market.cityId,
          marketStructureId: market.structureId,
          ...(coinwright.spent ? { coinwrightBonusGold: coinwright.bonusGold.toString() } : {})
        }
      });
      const inventory = await this.inventory.snapshotInTransaction(client, player.playerId);
      const equipment = await this.equipment.snapshotInTransaction(client, player.playerId);
      const backpacks = await this.backpacks.snapshotInTransaction(client, player.playerId);
      const snapshot = await this.marketSnapshot(player.playerId, market, client);
      const result: GoblinMarketSaleResult = {
        replayed: false,
        offerGold: offer.toString(),
        snapshot,
        inventory,
        equipment,
        backpacks,
        walletGold: wallet.goldBalance.toString(),
        walletVersion: wallet.version.toString()
      };
      await client.query(
        `UPDATE goblin_market_sales SET result=$3::jsonb,completed_at=now()
         WHERE player_id=$1 AND request_id=$2`,
        [player.playerId, input.requestId, JSON.stringify(result)]
      );
      await client.query("COMMIT");
      // Merge the sale (sold item gone, Coinwright Glove use) into the runtime without replacing it, so
      // an unsaved kit activation survives.
      return { ...result, equipment: await this.equipment.syncUtilityGear(player.playerId) };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async buy(
    player: PlayerRecord,
    accountId: string,
    input: Readonly<{
      requestId: string;
      marketStructureId: string;
      itemId: typeof GOBLIN_MARKET_WHEAT_SEED_ITEM_ID;
      quantity: number;
      expectedUnitPriceGold: string;
    }>
  ): Promise<GoblinMarketPurchaseResult> {
    assertRequestId(input.requestId);
    if (!Number.isSafeInteger(input.quantity) || input.quantity <= 0) {
      throw new GoblinVillageError("GOBLIN_MARKET_INVALID_QUANTITY", "Purchase quantity must be a positive safe integer");
    }
    if (input.itemId !== GOBLIN_MARKET_WHEAT_SEED_ITEM_ID) {
      throw new GoblinVillageError("GOBLIN_MARKET_ITEM_UNAVAILABLE", "This Goblin Market item is unavailable");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockGoblinPlayer(client, player.playerId);
      // Tradecraft lowers what NPC shops charge; the quoted price is the one the player saw.
      const quotedUnitPrice = wanderingMerchantUnitPrice(
        GOBLIN_MARKET_WHEAT_SEED_UNIT_PRICE_GOLD,
        await tradeSkillRank(client, player.playerId, "tradecraft")
      );
      if (input.expectedUnitPriceGold !== String(quotedUnitPrice)) {
        throw new GoblinVillageError("GOBLIN_MARKET_PRICE_CHANGED", "The Goblin Market price changed");
      }
      const replay = await client.query<{
        account_id: string;
        market_structure_id: string;
        item_id: typeof GOBLIN_MARKET_WHEAT_SEED_ITEM_ID;
        quantity: string;
        unit_price_gold: string;
        total_gold: string;
        result: GoblinMarketPurchaseResult | null;
      }>(
        `SELECT account_id,market_structure_id::text,item_id,
                quantity::text,unit_price_gold::text,total_gold::text,result
         FROM goblin_market_purchases
         WHERE player_id=$1 AND request_id=$2 FOR UPDATE`,
        [player.playerId, input.requestId]
      );
      const prior = replay.rows[0];
      if (prior && (
        prior.account_id !== accountId ||
        prior.market_structure_id !== input.marketStructureId ||
        prior.item_id !== input.itemId ||
        Number(prior.quantity) !== input.quantity ||
        prior.unit_price_gold !== input.expectedUnitPriceGold
      )) {
        throw new GoblinVillageError(
          "GOBLIN_MARKET_REQUEST_CONFLICT",
          "This request ID was already used for a different Goblin Market purchase"
        );
      }
      if (prior?.result) {
        const result = { ...prior.result, replayed: true };
        await client.query("COMMIT");
        return result;
      }
      if (replay.rowCount) {
        throw new GoblinVillageError("GOBLIN_MARKET_REQUEST_INCOMPLETE", "Purchase request is incomplete");
      }

      const market = await this.requireMarket(player, input.marketStructureId, client, accountId);
      await this.ensureMarketStock(market.structureId, client);
      const stock = await client.query<{ quantity: string }>(
        `SELECT quantity::text FROM goblin_market_stock
         WHERE market_structure_id=$1 AND item_id=$2 FOR UPDATE`,
        [market.structureId, GOBLIN_MARKET_WHEAT_SEED_ITEM_ID]
      );
      const available = Number(stock.rows[0]?.quantity ?? 0);
      if (!Number.isSafeInteger(available) || available < input.quantity) {
        throw new GoblinVillageError("GOBLIN_MARKET_OUT_OF_STOCK", "The Goblin Market does not have enough Wheat Seeds");
      }
      const unitPrice = BigInt(quotedUnitPrice);
      const quantity = BigInt(input.quantity);
      const totalGold = unitPrice * quantity;
      await client.query(
        `INSERT INTO goblin_market_purchases (
           player_id,request_id,account_id,city_id,market_structure_id,
           item_id,quantity,unit_price_gold,total_gold
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          player.playerId,
          input.requestId,
          accountId,
          market.cityId,
          market.structureId,
          input.itemId,
          input.quantity,
          unitPrice.toString(),
          totalGold.toString()
        ]
      );

      const wallet = await this.wallet.debitForOperationInTransaction(client, {
        playerId: player.playerId,
        accountId,
        amount: totalGold,
        operationKey: `goblin-purchase:${player.playerId}:${input.requestId}`,
        reason: "goblin_market_purchase",
        metadata: { cityId: market.cityId, marketStructureId: market.structureId, itemId: input.itemId }
      });
      const granted = await this.inventory.grantItemsForOperationInTransaction(client, {
        operationKey: `goblin-purchase:${player.playerId}:${input.requestId}:items`,
        playerId: player.playerId,
        source: "goblin_market_purchase",
        sourceEntityType: "city_structure",
        sourceEntityId: market.structureId,
        metadata: { itemId: input.itemId, quantity: input.quantity },
        grants: [{ itemId: input.itemId, variant: null, quantity: input.quantity }]
      });
      const stockUpdate = await client.query(
        `UPDATE goblin_market_stock
         SET quantity=quantity-$3,updated_at=now()
         WHERE market_structure_id=$1 AND item_id=$2 AND quantity >= $3`,
        [market.structureId, GOBLIN_MARKET_WHEAT_SEED_ITEM_ID, input.quantity]
      );
      if (stockUpdate.rowCount !== 1) {
        throw new GoblinVillageError("GOBLIN_MARKET_OUT_OF_STOCK", "The Goblin Market stock changed");
      }
      const snapshot = await this.marketSnapshot(player.playerId, market, client);
      const result: GoblinMarketPurchaseResult = {
        replayed: false,
        itemId: input.itemId,
        quantity: input.quantity,
        totalGold: totalGold.toString(),
        snapshot,
        inventory: granted.inventory,
        walletGold: wallet.goldBalance.toString(),
        walletVersion: wallet.version.toString()
      };
      await client.query(
        `UPDATE goblin_market_purchases SET result=$3::jsonb,completed_at=now()
         WHERE player_id=$1 AND request_id=$2`,
        [player.playerId, input.requestId, JSON.stringify(result)]
      );
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async requireMarket(
    player: PlayerRecord,
    structureId: string,
    queryable: Pick<pg.Pool | pg.PoolClient, "query"> = this.pool,
    accountId?: string
  ): Promise<CityStructureSnapshot> {
    const result = await queryable.query<{ city_id: string; lat: number; lon: number }>(
      `SELECT structure.city_id::text,structure.lat,structure.lon
       FROM city_structures structure
       JOIN cities city ON city.id=structure.city_id
       JOIN players player ON player.id=$2
       WHERE structure.structure_id=$1 AND structure.structure_type='market'
         AND structure.state='active' AND city.active
         AND city.controller_kind='npc' AND city.culture='goblin'
         AND player.account_id IS NOT NULL
         AND ($3::text IS NULL OR player.account_id::text=$3::text)
         AND NOT EXISTS (
           SELECT 1 FROM npc_city_player_relations relation
           WHERE relation.city_id=city.id AND relation.player_id=$2
         )`,
      [structureId, player.playerId, accountId ?? null]
    );
    const row = result.rows[0];
    if (!row || distanceMeters(player.position, { lat: Number(row.lat), lon: Number(row.lon) }) >
      CITY_MARKET_INTERACTION_RADIUS_M) {
      throw new GoblinVillageError(
        "GOBLIN_MARKET_ACCESS_DENIED",
        "Goblin Market requires a nearby neutral player"
      );
    }
    const cityId = row.city_id;
    const market = (await this.cities.structures?.listForCity(cityId))
      ?.find((structure) => structure.structureId === structureId);
    if (!market) throw new GoblinVillageError("GOBLIN_MARKET_NOT_FOUND", "Goblin Market is unavailable");
    return { ...market, cityControllerKind: "npc", cityCulture: "goblin" };
  }

  private async marketSnapshot(
    playerId: string,
    market: CityStructureSnapshot,
    queryable: Pick<pg.Pool | pg.PoolClient, "query"> = this.pool
  ): Promise<GoblinMarketSnapshot> {
    const city = await this.cities.getCity(market.cityId);
    if (!city) throw new GoblinVillageError("GOBLIN_MARKET_NOT_FOUND", "Goblin city is unavailable");
    await this.ensureMarketStock(market.structureId, queryable);
    return {
      cityId: city.id,
      cityName: city.name,
      marketStructureId: market.structureId,
      relation: await this.relation(city.id, playerId, queryable),
      lines: await this.marketLines(playerId, queryable),
      buyLines: await this.marketBuyLines(market.structureId, playerId, queryable)
    };
  }

  private async ensureMarketStock(
    marketStructureId: string,
    queryable: Pick<pg.Pool | pg.PoolClient, "query">
  ): Promise<void> {
    await queryable.query(
      `INSERT INTO goblin_market_stock (market_structure_id,item_id,quantity)
       VALUES ($1,$2,$3)
       ON CONFLICT (market_structure_id,item_id) DO NOTHING`,
      [marketStructureId, GOBLIN_MARKET_WHEAT_SEED_ITEM_ID, GOBLIN_MARKET_WHEAT_SEED_INITIAL_STOCK]
    );
  }

  private async marketBuyLines(
    marketStructureId: string,
    playerId: string,
    queryable: Pick<pg.Pool | pg.PoolClient, "query">
  ): Promise<GoblinMarketBuyLine[]> {
    const result = await queryable.query<{ quantity: string }>(
      `SELECT quantity::text FROM goblin_market_stock
       WHERE market_structure_id=$1 AND item_id=$2`,
      [marketStructureId, GOBLIN_MARKET_WHEAT_SEED_ITEM_ID]
    );
    const quantity = Number(result.rows[0]?.quantity ?? 0);
    if (!Number.isSafeInteger(quantity) || quantity <= 0) return [];
    const catalogItem = INVENTORY_CATALOG[GOBLIN_MARKET_WHEAT_SEED_ITEM_ID];
    if (!catalogItem) return [];
    return [{
      kind: "resource",
      itemId: GOBLIN_MARKET_WHEAT_SEED_ITEM_ID,
      identity: GOBLIN_MARKET_WHEAT_SEED_ITEM_ID,
      displayName: catalogItem.displayName,
      quantity,
      unitPriceGold: String(wanderingMerchantUnitPrice(
        GOBLIN_MARKET_WHEAT_SEED_UNIT_PRICE_GOLD,
        await tradeSkillRank(queryable, playerId, "tradecraft")
      ))
    }];
  }

  private async marketLines(
    playerId: string,
    queryable: Pick<pg.Pool | pg.PoolClient, "query">
  ): Promise<GoblinMarketSnapshot["lines"]> {
    const inventory = await this.inventory.snapshotInTransaction(queryable, playerId);
    const equipment = await this.equipment.snapshotInTransaction(queryable, playerId);
    const backpacks = await this.backpacks.snapshotInTransaction(queryable, playerId);
    return [
      ...inventory.items.flatMap((item) => {
        if (!item.stackId || item.resourceType === "shell" || item.resourceType === "repair_kit" ||
          item.resourceType === "raw_meat") {
          return [];
        }
        const resourceType = item.resourceType as ResourceType | typeof GOBLIN_MARKET_WHEAT_SEED_ITEM_ID;
        if (GOBLIN_MARKET_RESOURCE_UNIT_PRICES[resourceType] === undefined) return [];
        const catalogItem = INVENTORY_CATALOG[resourceType];
        if (!catalogItem) return [];
        return [{
          kind: "resource" as const,
          identity: item.stackId,
          displayName: catalogItem.displayName,
          quantity: item.quantity,
          offerGold: goblinMarketResourceOfferGold(resourceType, item.quantity)
        }];
      }),
      ...equipment.instances
        // Goblin resale destroys the exact instance. Keep damaged eligible
        // chest armor out of the offer list until it is fully repaired so
        // repair inputs cannot be bypassed through an NPC cash-out.
        .filter((item) => item.location === "inventory" && goblinEquipmentSaleEligible(item))
        .map((item) => ({
          kind: "equipment" as const,
          identity: item.instanceId,
          displayName: item.displayName,
          quantity: 1,
          offerGold: goblinMarketEquipmentOfferGold(item)
        })),
      ...backpacks.instances
        .filter((item) => item.location === "inventory")
        .map((item) => ({
          kind: "backpack" as const,
          identity: item.instanceId,
          displayName: item.displayName,
          quantity: 1,
          offerGold: goblinMarketBackpackOfferGold(item)
        }))
    ];
  }

  private async materializeCityDefenders(cityId: string): Promise<void> {
    const cityResult = await this.pool.query<{ founding_annex_radius_m: number }>(
      `SELECT founding_annex_radius_m FROM cities
       WHERE id=$1 AND active AND controller_kind='npc' AND culture='goblin'`,
      [cityId]
    );
    const annexRadiusM = Number(cityResult.rows[0]?.founding_annex_radius_m ?? 0);
    if (!(annexRadiusM > 0)) return;
    const relations = await this.pool.query<{ player_id: string }>(
      "SELECT player_id FROM npc_city_player_relations WHERE city_id=$1",
      [cityId]
    );
    for (const relation of relations.rows) this.combat.markNpcCityPlayerEnemy(cityId, relation.player_id);
    const slots = await this.pool.query<{
      defender_id: string;
      role: "basic" | "warrior" | "archer" | "healer";
      presentation_key: string;
      lat: number;
      lon: number;
      pack_id: string;
    }>(
      `SELECT defender_id::text,role,presentation_key,lat,lon,pack_id
       FROM npc_city_defender_slots WHERE city_id=$1 ORDER BY defender_id`,
      [cityId]
    );
    for (const slot of slots.rows) {
      const entityId = `goblin-defender:${slot.defender_id}`;
      if (this.combat.entity(entityId)) continue;
      this.combat.spawnMob({
        entityId,
        archetype: "goblin",
        position: { lat: Number(slot.lat), lon: Number(slot.lon) },
        homePosition: { lat: Number(slot.lat), lon: Number(slot.lon) },
        packId: slot.pack_id,
        worldAi: true,
        ...(slot.role === "archer" ? { movementSpeedMpsOverride: 0 } : {}),
        regionCode: packageIdForPosition({ lat: Number(slot.lat), lon: Number(slot.lon) }),
        zoneId: zoneIdForPosition({ lat: Number(slot.lat), lon: Number(slot.lon) }),
        ...(slot.role === "archer"
          ? { attackRangeMOverride: Math.max(300, annexRadiusM * 2) }
          : {}),
        npcFaction: {
          cityId,
          cityName: GOBLIN_VILLAGE_NAME,
          culture: "goblin",
          role: slot.role,
          presentationKey: slot.presentation_key,
          invulnerable: true,
          annexRadiusM
        }
      });
    }
  }

  private async activeVillageClaims(): Promise<Array<{
    cityId: string;
    flags: Array<{ position: Position; claimRadiusM: number }>;
  }>> {
    const result = await this.pool.query<{
      city_id: string;
      lat: number;
      lon: number;
      claim_radius_m: number;
    }>(
      `SELECT city.id::text AS city_id,flag.lat,flag.lon,flag.claim_radius_m
       FROM cities city
       JOIN flags flag ON flag.city_id=city.id
       WHERE city.active AND city.controller_kind='npc' AND city.culture='goblin'
       ORDER BY city.id,flag.id`
    );
    const grouped = new Map<string, Array<{ position: Position; claimRadiusM: number }>>();
    for (const row of result.rows) {
      const flags = grouped.get(row.city_id) ?? [];
      flags.push({
        position: { lat: Number(row.lat), lon: Number(row.lon) },
        claimRadiusM: Number(row.claim_radius_m)
      });
      grouped.set(row.city_id, flags);
    }
    return [...grouped].map(([cityId, flags]) => ({ cityId, flags }));
  }

  private async refreshWarmZones(zoneIds: readonly PopulationZoneV2Id[]): Promise<void> {
    for (const zoneId of zoneIds) await this.populationRuntime.notifyZoneReady(zoneId);
  }

  private async convergeActiveVillageRuntime(cityId: string): Promise<void> {
    const zones = await this.pool.query<{ zone_id: PopulationZoneV2Id }>(
      `SELECT override.zone_id
       FROM goblin_village_population_overrides override
       JOIN cities city ON city.id=override.city_id
       WHERE override.city_id=$1 AND city.active
       ORDER BY override.zone_id`,
      [cityId]
    );
    await this.refreshWarmZones(zones.rows.map((row) => row.zone_id));
    await this.materializeCityDefenders(cityId);
  }

  private async findSpawn(
    playerId: string,
    requestId: string,
    center: Position,
    queryable: Pick<pg.Pool | pg.PoolClient, "query"> = this.pool
  ): Promise<GoblinVillageSpawnResult | null> {
    const result = await queryable.query<{ city_id: string; center_lat: number; center_lon: number }>(
      `SELECT city_id::text,center_lat,center_lon FROM goblin_village_spawns
       WHERE player_id=$1 AND request_id=$2`,
      [playerId, requestId]
    );
    const row = result.rows[0];
    if (!row) return null;
    if (
      Math.abs(Number(row.center_lat) - center.lat) > 1e-9 ||
      Math.abs(Number(row.center_lon) - center.lon) > 1e-9
    ) {
      throw new GoblinVillageError(
        "GOBLIN_VILLAGE_REQUEST_CONFLICT",
        "This request ID was already used for a different Goblin Village coordinate"
      );
    }
    return this.requireSpawn(row.city_id, true);
  }

  private async requireSpawn(cityId: string, replayed: boolean): Promise<GoblinVillageSpawnResult> {
    const city = await this.cities.getCity(cityId);
    const structures = await this.cities.structures?.listForCity(cityId);
    const market = structures?.find((structure) => structure.type === "market");
    const ids = await this.pool.query<{ id: string }>(
      "SELECT id::text FROM flags WHERE city_id=$1 ORDER BY control_type DESC,id",
      [cityId]
    );
    const flags = (await Promise.all(ids.rows.map(({ id }) => this.flags.getMapFlag(id))))
      .filter((flag): flag is FlagSnapshot => flag !== null);
    if (!city || !market || flags.length !== 19) throw new Error("Goblin Village replay is incomplete");
    return {
      replayed,
      city,
      flags,
      market: { ...market, cityControllerKind: "npc", cityCulture: "goblin" }
    };
  }
}

function goblinEquipmentSaleEligible(item: EquipmentSnapshotV2["instances"][number]): boolean {
  if (item.category !== "chest_armor") return true;
  const familyId = requireEquipmentDefinition(item.definitionId).gameplayFamilyId;
  return equipmentRepairCostForFamily(familyId) === null ||
    (item.condition ?? EQUIPMENT_MAX_CONDITION) >= EQUIPMENT_MAX_CONDITION;
}

export function goblinVillageHexPositions(
  center: Position,
  spacingM: number,
  rings = 2
): Position[] {
  const axial: Array<readonly [number, number]> = [[0, 0]];
  for (let radius = 1; radius <= rings; radius += 1) {
    let q = -radius;
    let r = radius;
    const directions = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]] as const;
    for (const [dq, dr] of directions) {
      for (let step = 0; step < radius; step += 1) {
        axial.push([q, r]);
        q += dq;
        r += dr;
      }
    }
  }
  return axial.map(([q, r]) => {
    if (q === 0 && r === 0) return center;
    const eastM = spacingM * Math.sqrt(3) * (q + r / 2);
    const northM = spacingM * 1.5 * r;
    const distanceM = Math.hypot(eastM, northM);
    const bearing = (Math.atan2(eastM, northM) * 180 / Math.PI + 360) % 360;
    return destinationPoint(center, distanceM, bearing);
  });
}

export function goblinMarketPlacement(center: Position, stableSeed: string): {
  distanceM: number;
  bearing: number;
  position: Position;
} {
  const digest = createHash("sha256").update(stableSeed).digest();
  const distanceM = 300 + digest.readUInt32BE(0) % 151;
  const bearing = digest.readUInt32BE(4) % 360;
  return { distanceM, bearing, position: destinationPoint(center, distanceM, bearing) };
}

function annexRadiusM(positions: readonly Position[], center: Position, claimRadiusM: number): number {
  return Math.ceil(Math.max(...positions.map((position) => distanceMeters(center, position))) + claimRadiusM);
}

async function lockGoblinPlayer(
  queryable: Pick<pg.PoolClient, "query">,
  playerId: string
): Promise<void> {
  await queryable.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    `goblin-player:${playerId}`
  ]);
}

async function assertFootprintAvailable(
  queryable: Pick<pg.PoolClient, "query">,
  positions: readonly Position[],
  claimRadiusM: number,
  market: Position
): Promise<void> {
  const conflicts = await queryable.query(
    `SELECT id FROM flags existing
     WHERE EXISTS (
       SELECT 1 FROM unnest($1::double precision[],$2::double precision[]) point(lat,lon)
       WHERE ST_DWithin(
         existing.geom::geography,
         ST_SetSRID(ST_MakePoint(point.lon,point.lat),4326)::geography,
         existing.claim_radius_m + $3
       )
     ) LIMIT 1`,
    [positions.map(({ lat }) => lat), positions.map(({ lon }) => lon), claimRadiusM]
  );
  if (conflicts.rowCount) {
    throw new GoblinVillageError("GOBLIN_VILLAGE_TERRITORY_CONFLICT", "Village footprint overlaps existing territory");
  }
  const structureConflict = await queryable.query(
    `SELECT structure_id FROM city_structures
     WHERE state IN ('constructing','active') AND ST_DWithin(
       geom::geography,
       ST_SetSRID(ST_MakePoint($1,$2),4326)::geography,
       footprint_radius_m + $3 + 300
     ) LIMIT 1`,
    [market.lon, market.lat, CITY_STRUCTURE_FOOTPRINT_RADIUS_M.market]
  );
  if (structureConflict.rowCount) {
    throw new GoblinVillageError("GOBLIN_VILLAGE_STRUCTURE_CONFLICT", "Goblin Market placement conflicts with a structure");
  }
}

async function insertDefenderSlots(
  queryable: Pick<pg.PoolClient, "query">,
  cityId: string,
  flagIds: readonly string[],
  flagPositions: readonly Position[],
  market: Position,
  regionCode: string | null
): Promise<void> {
  const roles = [
    { role: "basic", key: "goblin", kind: "hall", position: destinationPoint(flagPositions[0]!, 30, 180), flagId: null },
    { role: "warrior", key: "goblin_warrior", kind: "hall", position: destinationPoint(flagPositions[0]!, 35, 220), flagId: null },
    { role: "healer", key: "goblin_healer", kind: "hall", position: destinationPoint(flagPositions[0]!, 32, 140), flagId: null },
    { role: "basic", key: "goblin", kind: "market", position: destinationPoint(market, 25, 180), flagId: null },
    ...Array.from({ length: DEFENDER_ARCHER_COUNT }, (_, index) => {
      const flagIndex = 1 + index * 3;
      return {
        role: "archer",
        key: "goblin_archer",
        kind: "tower",
        position: flagPositions[flagIndex]!,
        flagId: flagIds[flagIndex]!
      };
    })
  ] as const;
  for (const slot of roles) {
    await queryable.query(
      `INSERT INTO npc_city_defender_slots (
         defender_id,city_id,role,presentation_key,post_kind,post_flag_id,
         lat,lon,region_code,pack_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        randomUUID(),
        cityId,
        slot.role,
        slot.key,
        slot.kind,
        slot.flagId,
        slot.position.lat,
        slot.position.lon,
        regionCode,
        `goblin-city:${cityId}`
      ]
    );
  }
}

function populationZonesForClaims(
  claims: readonly Readonly<{ position: Position; claimRadiusM: number }>[]
): PopulationZoneV2Id[] {
  return uniqueSortedPopulationZones(claims.flatMap((claim) =>
    populationZonesV2IntersectingCircle(claim.position, claim.claimRadiusM)
  ));
}

function uniqueSortedPopulationZones(
  zoneIds: readonly PopulationZoneV2Id[]
): PopulationZoneV2Id[] {
  return [...new Set(zoneIds)].sort() as PopulationZoneV2Id[];
}

async function persistPopulationOverrides(
  queryable: Pick<pg.PoolClient, "query">,
  cityId: string,
  zoneIds: readonly PopulationZoneV2Id[]
): Promise<void> {
  if (zoneIds.length === 0) return;
  await queryable.query(
    `INSERT INTO goblin_village_population_overrides (city_id,zone_id)
     SELECT $1,zone_id FROM unnest($2::text[]) AS zone(zone_id)
     ON CONFLICT (city_id,zone_id) DO NOTHING`,
    [cityId, zoneIds]
  );
}

async function recomputeMobSuppression(
  queryable: Pick<pg.PoolClient, "query">,
  zoneIds: readonly PopulationZoneV2Id[]
): Promise<void> {
  if (zoneIds.length === 0) return;
  await queryable.query(
    `UPDATE generated_world_mobs AS mob
     SET population_flag_suppressed = EXISTS (
       SELECT 1 FROM goblin_village_population_overrides AS override
       WHERE override.zone_id=mob.physical_population_zone_v2_id
     )
     WHERE mob.physical_population_zone_v2_id=ANY($1::text[])
       AND mob.population_flag_suppressed IS DISTINCT FROM EXISTS (
         SELECT 1 FROM goblin_village_population_overrides AS override
         WHERE override.zone_id=mob.physical_population_zone_v2_id
       )`,
    [zoneIds]
  );
}

function assertRequestId(requestId: string): void {
  if (requestId.length < 1 || requestId.length > 128) {
    throw new GoblinVillageError("GOBLIN_REQUEST_INVALID", "Request ID is invalid");
  }
}
