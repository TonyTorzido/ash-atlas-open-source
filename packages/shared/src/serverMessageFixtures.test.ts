import { describe, expect, it } from "vitest";
import { z, type ZodTypeAny } from "zod";

import {
  SERVER_MESSAGE_VALIDATION_ROUTES,
  parseServerMessage,
  type ServerMessage
} from "./protocol.js";
import { dungeonSceneRevision } from "./dungeon.js";

const SKILL_SNAPSHOT_FIXTURE = {
  playerId: "fixture",
  characterLevel: 0,
  pointState: { totalEarned: 0, totalSpent: 0, available: 0, revision: 0 },
  generalSkills: [],
  specializations: [],
  committedSpecializationId: null,
  activeSpecializationId: null,
  generalActiveLoadout: [null, null],
  ultimate: null,
  cooldownEndsAt: {},
  worldKnowledge: [],
  serverTime: 0,
  revision: 0
} as const;

const DUNGEON_ENTRANCE_FIXTURE = {
  entranceId: "fixture",
  dungeonId: "fixture",
  portalId: "fixture",
  portalRevision: "fixture",
  interactionLabel: "Enter Dungeon",
  name: "Fixture Dungeon",
  description: "Fixture dungeon entrance.",
  regionCode: "fixture",
  lat: 0,
  lon: 0,
  interactionRadiusM: 1,
  footprintRadiusM: 1,
  presentation: "door",
  assetKey: null
} as const;

const SERVER_MESSAGE_FIXTURE_SEEDS = {
  MILITARY_INDUSTRY_STATE: { type: "MILITARY_INDUSTRY_STATE" },
  MILITARY_INDUSTRY_CHANGED: { type: "MILITARY_INDUSTRY_CHANGED" },
  DEV_TEST_FLAG_SPAWNED: { type: "DEV_TEST_FLAG_SPAWNED" },
  DEV_TEST_UNIT_SPAWNED: { type: "DEV_TEST_UNIT_SPAWNED" },
  PLAYER_DEATH_MESSAGE: { type: "PLAYER_DEATH_MESSAGE", message: "You have been killed by A's B" },
  PLAYER_ANNOUNCEMENT_PUBLISHED: {
    type: "PLAYER_ANNOUNCEMENT_PUBLISHED",
    announcement: {
      id: "00000000-0000-4000-8000-000000000001",
      title: "Fixture announcement",
      message: "Fixture message",
      publishedAt: "2026-01-01T00:00:00.000Z"
    }
  },
  ABILITY_QUEUE_UPDATED: { type: "ABILITY_QUEUE_UPDATED" },
  ACHIEVEMENT_SNAPSHOT: { type: "ACHIEVEMENT_SNAPSHOT" },
  ACHIEVEMENT_UNLOCKED: { type: "ACHIEVEMENT_UNLOCKED" },
  AUTH_SESSION_INVALID: { type: "AUTH_SESSION_INVALID" },
  BACKPACK_ERROR: {
    type: "BACKPACK_ERROR",
    requestId: null,
    code: "BACKPACK_INVALID_REQUEST"
  },
  BACKPACK_OPERATION_RESULT: {
    type: "BACKPACK_OPERATION_RESULT",
    result: {
      requestId: "fixture",
      action: "create",
      replayed: false,
      backpacks: {
        playerId: "fixture",
        revision: 0,
        baseSlots: 40,
        backpackBonusSlots: 0,
        effectiveSlots: 40,
        maximumSlots: 100,
        equipped: [null, null, null, null],
        instances: []
      },
      inventory: {
        playerId: "fixture",
        revision: 0,
        items: [],
        totals: {
          wood: 0,
          stone: 0,
          food: 0,
          ore: 0,
          water: 0,
          leather: 0,
          giving_berry: 0,
          balsam_resin: 0,
          crude_oil: 0,
          crystal: 0, pearl: 0, atlas_shrine_shard: 0,
          enchantment_stone: 0
        },
        unlockedSlots: 40
      },
      walletGold: "0",
      message: "Created."
    }
  },
  BACKPACK_SNAPSHOT: {
    type: "BACKPACK_SNAPSHOT",
    backpacks: {
      playerId: "fixture",
      revision: 0,
      baseSlots: 40,
      backpackBonusSlots: 0,
      effectiveSlots: 40,
      maximumSlots: 100,
      equipped: [null, null, null, null],
      instances: []
    }
  },
  BUG_REPORT_SUBMIT_RESULT: {
    type: "BUG_REPORT_SUBMIT_RESULT",
    requestId: "00000000-0000-4000-8000-000000000001",
    success: true,
    reportCode: "AA-ABC123"
  },
  CHAT_CHANNELS_SNAPSHOT: { type: "CHAT_CHANNELS_SNAPSHOT" },
  CHAT_PINNED_CHANNELS_UPDATED: { type: "CHAT_PINNED_CHANNELS_UPDATED" },
  ONLINE_PLAYER_COUNT: { type: "ONLINE_PLAYER_COUNT" },
  COLLECTIBLE_UPDATED: { type: "COLLECTIBLE_UPDATED" },
  CONSUMABLE_USED: { type: "CONSUMABLE_USED" },
  SIMPLE_FOOD_CONSUMED: { type: "SIMPLE_FOOD_CONSUMED" },
  FIELD_CONSUMABLE_USED: { type: "FIELD_CONSUMABLE_USED" },
  FIELD_CONSUMABLE_CRAFTED: { type: "FIELD_CONSUMABLE_CRAFTED" },
  FIELD_BUFFS: { type: "FIELD_BUFFS" },
  WATER_SITES: { type: "WATER_SITES" },
  PEARL_DIVE_RESULT: { type: "PEARL_DIVE_RESULT" },
  CHAT_CHANNEL_SELECTED: { type: "CHAT_CHANNEL_SELECTED" },
  CHAT_HISTORY_RESULT: { type: "CHAT_HISTORY_RESULT" },
  CHAT_MESSAGE: { type: "CHAT_MESSAGE" },
  CHAT_MESSAGE_DELETED: { type: "CHAT_MESSAGE_DELETED" },
  CHAT_MESSAGE_TRANSLATION: { type: "CHAT_MESSAGE_TRANSLATION" },
  CHAT_MUTE_SNAPSHOT: { type: "CHAT_MUTE_SNAPSHOT" },
  CHAT_PARTY_LISTING_STATES: { type: "CHAT_PARTY_LISTING_STATES" },
  CHAT_PARTY_JOIN_REQUESTS: { type: "CHAT_PARTY_JOIN_REQUESTS" },
  CHAT_PARTY_LISTING_NOTICE: { type: "CHAT_PARTY_LISTING_NOTICE" },
  CHAT_PREVIEW_UPDATE: { type: "CHAT_PREVIEW_UPDATE" },
  CHAT_READ_STATE: { type: "CHAT_READ_STATE" },
  CHAT_SEND_RESULT: { type: "CHAT_SEND_RESULT" },
  CHAT_UNAVAILABLE: { type: "CHAT_UNAVAILABLE" },
  CITIES_SNAPSHOT: { type: "CITIES_SNAPSHOT" },
  CITY_APP: { type: "CITY_APP" },
  GOBLIN_MARKET_SNAPSHOT: { type: "GOBLIN_MARKET_SNAPSHOT" },
  GOBLIN_MARKET_SOLD: { type: "GOBLIN_MARKET_SOLD" },
  GOBLIN_MARKET_PURCHASED: { type: "GOBLIN_MARKET_PURCHASED" },
  GOBLIN_MARKET_ERROR: { type: "GOBLIN_MARKET_ERROR" },
  HOLLIN_HUT_SHOP: { type: "HOLLIN_HUT_SHOP" },
  HOLLIN_HUT_PURCHASED: { type: "HOLLIN_HUT_PURCHASED" },
  HOLLIN_HUT_ERROR: { type: "HOLLIN_HUT_ERROR" },
  HOLLIN_HUT_PACIFIED: { type: "HOLLIN_HUT_PACIFIED" },
  HOLLIN_HUT_SERVICED: { type: "HOLLIN_HUT_SERVICED" },
  WANDERING_MERCHANTS: { type: "WANDERING_MERCHANTS" },
  WANDERING_MERCHANT_SHOP: { type: "WANDERING_MERCHANT_SHOP" },
  WANDERING_MERCHANT_ERROR: { type: "WANDERING_MERCHANT_ERROR" },
  WANDERING_MERCHANT_PURCHASED: { type: "WANDERING_MERCHANT_PURCHASED" },
  CINDER_LANTERN_CRAFTED: { type: "CINDER_LANTERN_CRAFTED" },
  GOBLIN_VILLAGE_REMOVED: { type: "GOBLIN_VILLAGE_REMOVED" },
  CITY_FACILITY_CHANGED: { type: "CITY_FACILITY_CHANGED" },
  CITY_FLAG_CONVERSION_STARTED: { type: "CITY_FLAG_CONVERSION_STARTED" },
  CITY_FLAG_CONVERTED: { type: "CITY_FLAG_CONVERTED" },
  CITY_FOUNDED: { type: "CITY_FOUNDED" },
  CITY_CONSTRUCTION_ADVANCED: { type: "CITY_CONSTRUCTION_ADVANCED" },
  CITY_FOUNDING_PREVIEW: { type: "CITY_FOUNDING_PREVIEW" },
  CITY_HOUSE_CHANGED: { type: "CITY_HOUSE_CHANGED" },
  CITY_INFO: { type: "CITY_INFO" },
  CITY_JOINED: { type: "CITY_JOINED" },
  CITY_STRUCTURES_SNAPSHOT: { type: "CITY_STRUCTURES_SNAPSHOT" },
  OWNER_OIL_WELL_PROJECTION: { type: "OWNER_OIL_WELL_PROJECTION" },
  OIL_WELL_OPENED: { type: "OIL_WELL_OPENED" },
  LIBRARY_STATE: { type: "LIBRARY_STATE" },
  OIL_WELL_HARVESTED: { type: "OIL_WELL_HARVESTED" },
  CITY_WAREHOUSE_OPENED: { type: "CITY_WAREHOUSE_OPENED" },
  CITY_WAREHOUSE_UPDATED: { type: "CITY_WAREHOUSE_UPDATED" },
  CITY_LEFT: { type: "CITY_LEFT" },
  CITY_MAYOR_UPDATED: { type: "CITY_MAYOR_UPDATED" },
  CITY_MEMBERSHIP_SNAPSHOT: { type: "CITY_MEMBERSHIP_SNAPSHOT" },
  CITY_MEMBERSHIP_UPDATED: { type: "CITY_MEMBERSHIP_UPDATED" },
  CITY_TERRITORY_SYNC: { type: "CITY_TERRITORY_SYNC" },
  CITY_VISITED: { type: "CITY_VISITED" },
  CLASS_MASTERY_GRANTED: { type: "CLASS_MASTERY_GRANTED" },
  CLASS_MUTATION_CONFIRMED: { type: "CLASS_MUTATION_CONFIRMED" },
  CLASS_SNAPSHOT: { type: "CLASS_SNAPSHOT" },
  COLLECTIBLES_SNAPSHOT: { type: "COLLECTIBLES_SNAPSHOT" },
  COLLECTIBLE_PICKED_UP: { type: "COLLECTIBLE_PICKED_UP" },
  COLLECTIBLE_REMOVED: { type: "COLLECTIBLE_REMOVED" },
  COMBAT_CANCELLED: { type: "COMBAT_CANCELLED" },
  COMBAT_DELTA: { type: "COMBAT_DELTA" },
  COMBAT_KIT_ACTIVATED: { type: "COMBAT_KIT_ACTIVATED" },
  COMBAT_KIT_INVALIDATED: { type: "COMBAT_KIT_INVALIDATED" },
  COMBAT_KIT_SNAPSHOT: { type: "COMBAT_KIT_SNAPSHOT" },
  COMBAT_REWARD_GRANTED: { type: "COMBAT_REWARD_GRANTED", gold: 0 },
  COMBAT_SNAPSHOT: { type: "COMBAT_SNAPSHOT" },
  CREATURE_BOOK_SNAPSHOT: { type: "CREATURE_BOOK_SNAPSHOT" },
  BIOME_DISCOVERY_SNAPSHOT: { type: "BIOME_DISCOVERY_SNAPSHOT", biomes: ["plains"], newlyDiscovered: null, current: { biome: "plains", tags: ["riverside"], heightWord: "Lowland", authority: "world" }, celebration: { biome: "plains", achievements: [{ id: "legend_region_plains", title: "Endless Horizon", points: 10 }, { id: "legend_regions_3", title: "New Horizons", points: 10, honor: "Trailblazer" }] } },
  COMBAT_STARTED: { type: "COMBAT_STARTED" },
  XORAL_EVENT_STARTED: { type: "XORAL_EVENT_STARTED" },
  XORAL_REWARD_GRANTED: {
    type: "XORAL_REWARD_GRANTED",
    ringDefinitionId: "chopping_ring",
    ringDelivery: "inventory"
  },
  LAND_BONUS_EARNED: { type: "LAND_BONUS_EARNED" },
  CITY_STRUCTURE_WARFARE_CHANGED: { type: "CITY_STRUCTURE_WARFARE_CHANGED" },
  XORAL_EVENT_CANCELLED: { type: "XORAL_EVENT_CANCELLED" },
  LEGENDARY_EVENT_ALERT: {
    type: "LEGENDARY_EVENT_ALERT",
    selectedAt: "2099-01-01T00:00:00.000Z"
  },
  XORAL_PARTICIPANT_EXITED: { type: "XORAL_PARTICIPANT_EXITED" },
  XORAL_RING_DROPS_SNAPSHOT: { type: "XORAL_RING_DROPS_SNAPSHOT", drops: [] },
  XORAL_RING_DROP_PICKED_UP: { type: "XORAL_RING_DROP_PICKED_UP" },
  DEV_ASSETS_GRANTED: { type: "DEV_ASSETS_GRANTED", grants: [] },
  DEV_CLASS_COOLDOWNS_RESET: { type: "DEV_CLASS_COOLDOWNS_RESET" },
  DEV_MINE_VISIT_COMPLETED: { type: "DEV_MINE_VISIT_COMPLETED" },
  DEV_MOBS_CLEARED: { type: "DEV_MOBS_CLEARED" },
  DEV_MOB_SPAWNED: { type: "DEV_MOB_SPAWNED" },
  DEV_PLANT_SPAWNED: { type: "DEV_PLANT_SPAWNED", requestId: "fixture", plantEntityId: "plant:dev:fixture", plantKey: "flax" },
  DEV_PLANTS_CLEARED: { type: "DEV_PLANTS_CLEARED", requestId: "fixture", removedCount: 0 },
  DEV_DUNGEON_ENTRANCES_SNAPSHOT: {
    type: "DEV_DUNGEON_ENTRANCES_SNAPSHOT",
    requestId: "fixture",
    entrances: []
  },
  DEV_DUNGEON_ENTRANCE_SPAWNED: {
    type: "DEV_DUNGEON_ENTRANCE_SPAWNED",
    requestId: "fixture",
    replayed: false,
    entrance: DUNGEON_ENTRANCE_FIXTURE
  },
  DEV_DUNGEON_ENTRANCE_DELETED: {
    type: "DEV_DUNGEON_ENTRANCE_DELETED",
    requestId: "fixture",
    replayed: false,
    entranceId: "fixture"
  },
  DEV_GOBLIN_VILLAGE_SPAWNED: { type: "DEV_GOBLIN_VILLAGE_SPAWNED" },
  DEV_CAPITAL_FOUNDING_RESULT: { type: "DEV_CAPITAL_FOUNDING_RESULT" },
  DEV_TERRITORY_COLLAPSE_RESULT: { type: "DEV_TERRITORY_COLLAPSE_RESULT" },
  DEV_GOBLIN_VILLAGES_SNAPSHOT: { type: "DEV_GOBLIN_VILLAGES_SNAPSHOT" },
  DEV_GOBLIN_VILLAGE_DELETED: { type: "DEV_GOBLIN_VILLAGE_DELETED" },
  DEV_PROGRESSION_ADJUSTED: { type: "DEV_PROGRESSION_ADJUSTED" },
  DEV_TELEPORT_COMPLETED: { type: "DEV_TELEPORT_COMPLETED" },
  DM_BOOTSTRAP_RESULT: { type: "DM_BOOTSTRAP_RESULT" },
  DM_DELIVERED_RESULT: { type: "DM_DELIVERED_RESULT" },
  DM_ERROR: { type: "DM_ERROR" },
  DM_EVENT: { type: "DM_EVENT" },
  DM_EVENT_ACKED: { type: "DM_EVENT_ACKED" },
  DM_HISTORY_RESULT: { type: "DM_HISTORY_RESULT" },
  DM_LIST_RESULT: { type: "DM_LIST_RESULT" },
  DM_MUTE_RESULT: { type: "DM_MUTE_RESULT" },
  DM_OPEN_RESULT: { type: "DM_OPEN_RESULT" },
  DM_PREFERENCES_RESULT: { type: "DM_PREFERENCES_RESULT" },
  DM_READ_RESULT: { type: "DM_READ_RESULT" },
  DM_SEND_RESULT: { type: "DM_SEND_RESULT" },
  DM_SYNC_RESULT: { type: "DM_SYNC_RESULT" },
  DROPPED_ITEMS_SNAPSHOT: { type: "DROPPED_ITEMS_SNAPSHOT" },
  DROPPED_ITEM_PICKUP_RESULT: { type: "DROPPED_ITEM_PICKUP_RESULT" },
  DROPPED_EQUIPMENT_PICKUP_RESULT: { type: "DROPPED_EQUIPMENT_PICKUP_RESULT" },
  DROPPED_BACKPACK_PICKUP_RESULT: { type: "DROPPED_BACKPACK_PICKUP_RESULT" },
  DUNGEON_ENTRANCES: { type: "DUNGEON_ENTRANCES" },
  DUNGEON_ENTRANCE_UPSERTED: {
    type: "DUNGEON_ENTRANCE_UPSERTED",
    entrance: DUNGEON_ENTRANCE_FIXTURE
  },
  DUNGEON_ENTRANCE_REMOVED: {
    type: "DUNGEON_ENTRANCE_REMOVED",
    entranceId: "fixture"
  },
  FALLEN_PRISON_HUNT: {
    type: "FALLEN_PRISON_HUNT",
    hint: { direction: "north-east", band: "far", smokeInSight: false },
    announcement: "A prison has fallen from the sky somewhere to the north-east."
  },
  DUNGEON_ENTERED: { type: "DUNGEON_ENTERED", snapshot: {
    catalogRevision: 1, dungeonRevision: "fixture", spaceId: "fixture",
    sceneRevision: dungeonSceneRevision(1, "fixture", "fixture")
  } },
  DUNGEON_ERROR: { type: "DUNGEON_ERROR" },
  DUNGEON_EXITED: { type: "DUNGEON_EXITED" },
  DUNGEON_REWARD_GRANTED: { type: "DUNGEON_REWARD_GRANTED" },
  DUNGEON_TORCH_LOBBY: { type: "DUNGEON_TORCH_LOBBY", lobby: null },
  DUNGEON_SNAPSHOT: { type: "DUNGEON_SNAPSHOT", snapshot: {
    catalogRevision: 1, dungeonRevision: "fixture", spaceId: "fixture",
    sceneRevision: dungeonSceneRevision(1, "fixture", "fixture")
  } },
  DUNGEON_RESOURCE_HARVESTED: {
    type: "DUNGEON_RESOURCE_HARVESTED", requestId: "fixture", resourceId: "fixture",
    resourceType: "wood", quantity: 1, snapshot: {
      catalogRevision: 1, dungeonRevision: "fixture", spaceId: "fixture",
      sceneRevision: dungeonSceneRevision(1, "fixture", "fixture")
    }
  },
  EQUIPMENT_SNAPSHOT: { type: "EQUIPMENT_SNAPSHOT" },
  EQUIPMENT_UPDATED: { type: "EQUIPMENT_UPDATED" },
  EQUIPMENT_UPGRADE_RESULT: { type: "EQUIPMENT_UPGRADE_RESULT", levelBefore: 0, levelAfter: 1 },
  EQUIPMENT_ACQUIRED: {
    type: "EQUIPMENT_ACQUIRED",
    action: "craft",
    definitionId: "starter_sword",
    materialCosts: [],
    goldCost: "0"
  },
  EQUIPMENT_REPAIRED: {
    type: "EQUIPMENT_REPAIRED",
    conditionBefore: 50,
    conditionAfter: 75,
    materialCosts: []
  },
  RING_OPERATION_RESULT: {
    type: "RING_OPERATION_RESULT",
    action: "polish",
    instanceId: "00000000-0000-4000-8000-000000000001",
    tier: "fine",
    oilSpent: 10,
    shardsGranted: 0
  },
  GEAR_SCROLLS_STATE: {
    type: "GEAR_SCROLLS_STATE",
    requestId: null,
    action: "snapshot",
    gearScrolls: { count: 0, scrolls: [], lastEquippedPosition: null }
  },
  REPAIR_KIT_CRAFTED: {
    type: "REPAIR_KIT_CRAFTED",
    quantity: 1,
    materialCosts: []
  },
  ERROR: { type: "ERROR" },
  FLAGS_SNAPSHOT: { type: "FLAGS_SNAPSHOT" },
  FLAG_ACCESS_CHANGED: { type: "FLAG_ACCESS_CHANGED" },
  FLAG_BUILD_CANCELLED: { type: "FLAG_BUILD_CANCELLED" },
  FLAG_BUILD_QUEUED: { type: "FLAG_BUILD_QUEUED" },
  FLAG_BUILD_STARTED: { type: "FLAG_BUILD_STARTED" },
  FLAG_REINFORCEMENT_STARTED: { type: "FLAG_REINFORCEMENT_STARTED" },
  FLAG_REINFORCEMENT_CANCELLED: { type: "FLAG_REINFORCEMENT_CANCELLED" },
  FLAG_BURN_STARTED: {
    type: "FLAG_BURN_STARTED",
    operationId: "burn-operation-1",
    requestId: "burn-request-1",
    flagId: "flag-1",
    flagName: "Fixture Flag",
    startedAt: 1_000,
    completesAt: 26_000,
    durationMs: 25_000,
    serverTime: 1_000,
    position: { lat: 39.7397, lon: -104.9903 }
  },
  FLAG_BURN_CANCELLED: {
    type: "FLAG_BURN_CANCELLED",
    operationId: "burn-operation-1",
    requestId: "burn-request-1",
    flagId: "flag-1",
    reason: "range_exit",
    serverTime: 2_000
  },
  FLAG_BURN_NOTICE: {
    type: "FLAG_BURN_NOTICE",
    operationId: "burn-operation-1",
    flagId: "flag-1",
    flagName: "Fixture Flag",
    message: "A player began burning your Flag.",
    completesAt: 26_000,
    serverTime: 1_000
  },
  FLAG_REPAIR_STARTED: { type: "FLAG_REPAIR_STARTED" },
  FLAG_REPAIR_CANCELLED: { type: "FLAG_REPAIR_CANCELLED" },
  FLAG_REPAIRED: { type: "FLAG_REPAIRED" },
  FLAG_REPAIR_DISRUPT_STARTED: { type: "FLAG_REPAIR_DISRUPT_STARTED" },
  FLAG_REPAIR_DISRUPT_CANCELLED: { type: "FLAG_REPAIR_DISRUPT_CANCELLED" },
  FLAG_REPAIR_DISRUPTED: { type: "FLAG_REPAIR_DISRUPTED" },
  FLAG_CREATED: { type: "FLAG_CREATED" },
  FLAG_DELETED: { type: "FLAG_DELETED" },
  FLAGS_COLLAPSED: { type: "FLAGS_COLLAPSED" },
  TERRITORY_COLLAPSE_STARTED: { type: "TERRITORY_COLLAPSE_STARTED" },
  FLAG_REINFORCED: { type: "FLAG_REINFORCED" },
  FLAG_TOLL_RECEIVED: { type: "FLAG_TOLL_RECEIVED" },
  FLAG_UPDATED: { type: "FLAG_UPDATED" },
  FLAG_UPSERTED: { type: "FLAG_UPSERTED" },
  FLAG_VISITED: { type: "FLAG_VISITED" },
  VISIBLE_FLAG_VISIT_PREPARED: {
    type: "VISIBLE_FLAG_VISIT_PREPARED",
    requestId: "prepare-flag-1",
    flagId: "flag-1",
    playerSpawnPosition: { lat: 39.7397, lon: -104.9903 },
    expiresInMs: 15_000
  },
  HARVEST_CANCELLED: { type: "HARVEST_CANCELLED" },
  HARVEST_COMPLETED: { type: "HARVEST_COMPLETED" },
  HARVEST_STARTED: { type: "HARVEST_STARTED" },
  ITEM_DROP_RESULT: { type: "ITEM_DROP_RESULT" },
  EQUIPMENT_DROP_RESULT: { type: "EQUIPMENT_DROP_RESULT" },
  INVENTORY_STACK_UPDATED: { type: "INVENTORY_STACK_UPDATED" },
  TORCHES_CRAFTED: {
    type: "TORCHES_CRAFTED",
    requestId: "torch-request-1",
    quantity: 25,
    replayed: false,
    inventory: {
      playerId: "fixture",
      revision: 0,
      items: [],
      totals: {
        wood: 0,
        stone: 0,
        food: 0,
        ore: 0,
        water: 0,
        leather: 0,
        giving_berry: 0,
        balsam_resin: 0,
        crude_oil: 0,
        crystal: 0, pearl: 0, atlas_shrine_shard: 0,
        enchantment_stone: 0
      },
      unlockedSlots: 40
    }
  },
  INVENTORY_PROTECTION_SNAPSHOT: { type: "INVENTORY_PROTECTION_SNAPSHOT" },
  INVENTORY_PROTECTION_UPDATED: { type: "INVENTORY_PROTECTION_UPDATED" },
  KINGDOM_CHAT_MESSAGE: { type: "KINGDOM_CHAT_MESSAGE" },
  KINGDOM_SPATIAL_CHANGES: { type: "KINGDOM_SPATIAL_CHANGES" },
  KINGDOM_STATE: { type: "KINGDOM_STATE" },
  KINGDOM_STATE_CHANGED: { type: "KINGDOM_STATE_CHANGED" },
  LEVEL_UP: { type: "LEVEL_UP" },
  FURNACES_SNAPSHOT: { type: "FURNACES_SNAPSHOT" },
  GREENHOUSES_SNAPSHOT: { type: "GREENHOUSES_SNAPSHOT" },
  GREENHOUSE_BUILD_PREVIEW: { type: "GREENHOUSE_BUILD_PREVIEW" },
  GREENHOUSE_BUILD_STARTED: { type: "GREENHOUSE_BUILD_STARTED" },
  GREENHOUSE_BUILD_RESULT: { type: "GREENHOUSE_BUILD_RESULT" },
  GREENHOUSE_BUILD_CANCELLED: { type: "GREENHOUSE_BUILD_CANCELLED" },
  GREENHOUSE_DESTROY_RESULT: { type: "GREENHOUSE_DESTROY_RESULT" },
  GREENHOUSE_STATE: { type: "GREENHOUSE_STATE" },
  GREENHOUSE_POSITION: { type: "GREENHOUSE_POSITION" },
  GREENHOUSE_MUTATION_RESULT: { type: "GREENHOUSE_MUTATION_RESULT" },
  GREENHOUSE_BUCKET_RESULT: { type: "GREENHOUSE_BUCKET_RESULT" },
  GREENHOUSE_FERTILIZER_RESULT: { type: "GREENHOUSE_FERTILIZER_RESULT" },
  GREENHOUSE_WATER_FILL_STARTED: { type: "GREENHOUSE_WATER_FILL_STARTED" },
  GREENHOUSE_WATER_FILL_RESULT: { type: "GREENHOUSE_WATER_FILL_RESULT" },
  GREENHOUSE_ERROR: { type: "GREENHOUSE_ERROR" },
  FURNACE_BUILD_STARTED: { type: "FURNACE_BUILD_STARTED", serverTime: 1_000 },
  FURNACE_BUILD_RESULT: { type: "FURNACE_BUILD_RESULT" },
  FURNACE_BUILD_CANCELLED: { type: "FURNACE_BUILD_CANCELLED" },
  FURNACE_STATE: { type: "FURNACE_STATE" },
  FURNACE_SMELT_STARTED: { type: "FURNACE_SMELT_STARTED" },
  FURNACE_OUTPUT_COLLECTED: { type: "FURNACE_OUTPUT_COLLECTED" },
  FURNACE_GLIMMER_OIL_REFINED: { type: "FURNACE_GLIMMER_OIL_REFINED" },
  FURNACE_ERROR: { type: "FURNACE_ERROR" },
  TANNERIES_SNAPSHOT: { type: "TANNERIES_SNAPSHOT" },
  TANNERY_BUILD_STARTED: { type: "TANNERY_BUILD_STARTED", serverTime: 1_000 },
  TANNERY_BUILD_RESULT: { type: "TANNERY_BUILD_RESULT" },
  TANNERY_BUILD_CANCELLED: { type: "TANNERY_BUILD_CANCELLED" },
  TANNERY_STATE: { type: "TANNERY_STATE" },
  TANNERY_BATCH_STARTED: { type: "TANNERY_BATCH_STARTED" },
  TANNERY_OUTPUT_COLLECTED: { type: "TANNERY_OUTPUT_COLLECTED" },
  TANNERY_ERROR: { type: "TANNERY_ERROR" },
  LOOMS_SNAPSHOT: { type: "LOOMS_SNAPSHOT" },
  LOOM_BUILD_STARTED: { type: "LOOM_BUILD_STARTED" },
  LOOM_BUILD_RESULT: { type: "LOOM_BUILD_RESULT" },
  LOOM_BUILD_CANCELLED: { type: "LOOM_BUILD_CANCELLED" },
  LOOM_STATE: { type: "LOOM_STATE" },
  LOOM_BATCH_STARTED: { type: "LOOM_BATCH_STARTED" },
  LOOM_OUTPUT_COLLECTED: { type: "LOOM_OUTPUT_COLLECTED" },
  LOOM_ERROR: { type: "LOOM_ERROR" },
  KITCHENS_SNAPSHOT: { type: "KITCHENS_SNAPSHOT" },
  KITCHEN_BUILD_STARTED: { type: "KITCHEN_BUILD_STARTED" },
  KITCHEN_BUILD_RESULT: { type: "KITCHEN_BUILD_RESULT" },
  KITCHEN_BUILD_CANCELLED: { type: "KITCHEN_BUILD_CANCELLED" },
  KITCHEN_STATE: { type: "KITCHEN_STATE" },
  KITCHEN_BATCH_STARTED: { type: "KITCHEN_BATCH_STARTED" },
  KITCHEN_OUTPUT_COLLECTED: { type: "KITCHEN_OUTPUT_COLLECTED" },
  KITCHEN_ERROR: { type: "KITCHEN_ERROR" },
  FISHING_HUTS_SNAPSHOT: { type: "FISHING_HUTS_SNAPSHOT" },
  FISHING_HUT_BUILD_STARTED: { type: "FISHING_HUT_BUILD_STARTED" },
  FISHING_HUT_BUILD_RESULT: { type: "FISHING_HUT_BUILD_RESULT" },
  FISHING_HUT_BUILD_CANCELLED: { type: "FISHING_HUT_BUILD_CANCELLED" },
  FISHING_STATE: { type: "FISHING_STATE" },
  FISHING_PROGRESS_RESULT: { type: "FISHING_PROGRESS_RESULT" },
  FISHING_PASSIVE_COLLECTED: { type: "FISHING_PASSIVE_COLLECTED" },
  FISHING_ENCOUNTER_STARTED: { type: "FISHING_ENCOUNTER_STARTED" },
  FISHING_ENCOUNTER_STATE: { type: "FISHING_ENCOUNTER_STATE" },
  FISHING_CAST_RESULT: { type: "FISHING_CAST_RESULT" },
  FISHING_HOOK_RESULT: { type: "FISHING_HOOK_RESULT" },
  FISHING_CONTROL_RESULT: { type: "FISHING_CONTROL_RESULT" },
  FISHING_CATCH_LANDED: { type: "FISHING_CATCH_LANDED" },
  FISHING_RECORDS: { type: "FISHING_RECORDS" },
  FISHING_ERROR: { type: "FISHING_ERROR" },
  JEWEL_STATION_STATE: { type: "JEWEL_STATION_STATE" },
  JEWEL_STATION_RESULT: { type: "JEWEL_STATION_RESULT" },
  JEWEL_STATION_ERROR: { type: "JEWEL_STATION_ERROR" },
  MANORS_SNAPSHOT: { type: "MANORS_SNAPSHOT" },
  MANOR_BUILD_RESULT: { type: "MANOR_BUILD_RESULT" },
  MANOR_UPGRADES_SNAPSHOT: { type: "MANOR_UPGRADES_SNAPSHOT" },
  MANOR_UPGRADE_RESULT: { type: "MANOR_UPGRADE_RESULT" },
  MANOR_DESTROY_RESULT: { type: "MANOR_DESTROY_RESULT" },
  MANOR_WARFARE_CHANGED: { type: "MANOR_WARFARE_CHANGED" },
  MANOR_WORLD_UPDATED: { type: "MANOR_WORLD_UPDATED" },
  MANOR_SKIN_RESULT: { type: "MANOR_SKIN_RESULT" },
  MANOR_ENTERED: { type: "MANOR_ENTERED" },
  MANOR_ENTRY_PENDING: { type: "MANOR_ENTRY_PENDING" },
  MANOR_ERROR: { type: "MANOR_ERROR" },
  MANOR_EXITED: { type: "MANOR_EXITED" },
  MANOR_GUESTS: { type: "MANOR_GUESTS" },
  MANOR_OCCUPANTS: { type: "MANOR_OCCUPANTS" },
  MANOR_POSITION: { type: "MANOR_POSITION" },
  MANOR_EQUIPMENT_DROPS_UPDATED: { type: "MANOR_EQUIPMENT_DROPS_UPDATED" },
  MANOR_DECORATIONS_SNAPSHOT: { type: "MANOR_DECORATIONS_SNAPSHOT" },
  MANOR_DECORATION_UPDATED: { type: "MANOR_DECORATION_UPDATED" },
  MANOR_STATUS: { type: "MANOR_STATUS" },
  MANOR_STORAGE_SNAPSHOT: { type: "MANOR_STORAGE_SNAPSHOT" },
  MANOR_STORAGE_VIEW_SNAPSHOT: { type: "MANOR_STORAGE_VIEW_SNAPSHOT" },
  MANOR_STORAGE_UPDATED: { type: "MANOR_STORAGE_UPDATED" },
  MARKET_BOOK_CHANGED: { type: "MARKET_BOOK_CHANGED", itemId: "wood" },
  MARKET_BOOK_RESULT: { type: "MARKET_BOOK_RESULT" },
  MARKET_ERROR: { type: "MARKET_ERROR" },
  MARKET_ITEM_SUMMARY_CHANGED: { type: "MARKET_ITEM_SUMMARY_CHANGED" },
  MARKET_MUTATION_RESULT: { type: "MARKET_MUTATION_RESULT" },
  MARKET_OPEN_RESULT: { type: "MARKET_OPEN_RESULT" },
  MARKET_BROWSE_RESULT: { type: "MARKET_BROWSE_RESULT" },
  MARKET_PLAYER_STATE_CHANGED: { type: "MARKET_PLAYER_STATE_CHANGED" },
  MARKET_ASSETS_CHANGED: { type: "MARKET_ASSETS_CHANGED" },
  MARKET_QUOTE_RESULT: { type: "MARKET_QUOTE_RESULT" },
  MARKET_SUBSCRIPTIONS_SET: { type: "MARKET_SUBSCRIPTIONS_SET" },
  MASTERY_SNAPSHOT: { type: "MASTERY_SNAPSHOT" },
  MOVE_ACCEPTED: { type: "MOVE_ACCEPTED" },
  DASH_ACCEPTED: { type: "DASH_ACCEPTED" },
  SWING_RESULT: { type: "SWING_RESULT" },
  PARTY_COMBAT_DELTA: {
    type: "PARTY_COMBAT_DELTA",
    members: [{ playerId: "fixture", currentHealth: 1 }]
  },
  PARTY_COMBAT_SNAPSHOT: { type: "PARTY_COMBAT_SNAPSHOT" },
  PARTY_READY_CHECK_SNAPSHOT: { type: "PARTY_READY_CHECK_SNAPSHOT" },
  PARTY_SNAPSHOT: { type: "PARTY_SNAPSHOT" },
  PET_ERROR: { type: "PET_ERROR" },
  PET_STATE: { type: "PET_STATE" },
  SAPLINGS_STATE: { type: "SAPLINGS_STATE" },
  SAPLING_ERROR: { type: "SAPLING_ERROR" },
  SAPLING_DELTA: { type: "SAPLING_DELTA" },
  SAPLING_DETAIL: { type: "SAPLING_DETAIL" },
  SAPLING_RESULT: { type: "SAPLING_RESULT" },
  PLAYER_DELTA: { type: "PLAYER_DELTA" },
  PLAYER_RESOURCES_UPDATED: { type: "PLAYER_RESOURCES_UPDATED" },
  PLAYER_PACKAGES_SNAPSHOT: { type: "PLAYER_PACKAGES_SNAPSHOT" },
  PLAYER_PACKAGE_AVAILABLE: { type: "PLAYER_PACKAGE_AVAILABLE" },
  PLAYER_PACKAGE_CLAIM_RESULT: { type: "PLAYER_PACKAGE_CLAIM_RESULT" },
  PLAYER_PACKAGE_ERROR: { type: "PLAYER_PACKAGE_ERROR" },
  GIFT_BOX_PURCHASE_RESULT: { type: "GIFT_BOX_PURCHASE_RESULT" },
  PLAYER_GIFT_SEND_RESULT: { type: "PLAYER_GIFT_SEND_RESULT" },
  PLAYER_GIFT_STATUS: { type: "PLAYER_GIFT_STATUS" },
  PLAYER_GIFT_ERROR: { type: "PLAYER_GIFT_ERROR" },
  SHOP_CATALOG: { type: "SHOP_CATALOG" },
  SHOP_PURCHASE_RESULT: { type: "SHOP_PURCHASE_RESULT" },
  SHOP_ERROR: { type: "SHOP_ERROR" },
  PLAYER_SNAPSHOT: { type: "PLAYER_SNAPSHOT" },
  PONG: { type: "PONG" },
  POPULATION_RESYNC_RESULT: {
    type: "POPULATION_RESYNC_RESULT",
    outcome: "republished",
    currentPreparationGeneration: null,
    preparationResult: null,
    visibleZoneCount: 0,
    readyVisibleZoneCount: 0,
    terminal: false
  },
  POPULATION_ZONE_DELTA: {
    type: "POPULATION_ZONE_DELTA",
    preparationScope: "required-visible",
    requiredForGameplay: true,
    preparationResult: "pending",
    terminal: false
  },
  PROGRESSION_SNAPSHOT: { type: "PROGRESSION_SNAPSHOT" },
  RAFT_REQUIRED: { type: "RAFT_REQUIRED" },
  PVP_STATUS: { type: "PVP_STATUS", timers: [], serverTime: 0 },
  PORTAL_TRANSITION_PLANNED: { type: "PORTAL_TRANSITION_PLANNED" },
  PORTAL_TRANSITION_PHASE: { type: "PORTAL_TRANSITION_PHASE" },
  PLAYER_LOCATION_SNAPSHOT: { type: "PLAYER_LOCATION_SNAPSHOT" },
  PORTAL_TRANSITION_FAILED: { type: "PORTAL_TRANSITION_FAILED" },
  REPEATABLE_RESOURCE_HARVESTED: { type: "REPEATABLE_RESOURCE_HARVESTED" },
  REPEATABLE_RESOURCE_UPDATED: { type: "REPEATABLE_RESOURCE_UPDATED" },
  MINE_CLAIMED: { type: "MINE_CLAIMED" },
  HARVEST_ACCESS_CHANGED: { type: "HARVEST_ACCESS_CHANGED" },
  RESOURCE_GAINED: { type: "RESOURCE_GAINED" },
  CITY_GOLD_DONATED: {
    type: "CITY_GOLD_DONATED",
    requestId: "fixture",
    warehouse: {},
    walletGold: "0",
    walletVersion: "0",
    replayed: false,
    donatedGold: "1"
  },
  CITY_MARKET_DAILY_PURCHASED: {
    type: "CITY_MARKET_DAILY_PURCHASED",
    requestId: "fixture",
    cityId: "00000000-0000-4000-8000-000000000000",
    marketDaily: {
      marketStructureId: "00000000-0000-4000-8000-000000000001",
      tier: 1,
      cityCoins: 100,
      glimmer: 3,
      day: "2099-01-01",
      purchasedToday: true
    },
    treasuryBalance: "100",
    premiumWallet: {
      accountId: "account",
      balances: {
        glimmer: { balance: "0", revision: "1" },
        lumen: { balance: "0", revision: "0" }
      }
    },
    replayed: false
  },
  RESOURCE_VISION_LOADING: { type: "RESOURCE_VISION_LOADING" },
  RESOURCE_VISION_READY: { type: "RESOURCE_VISION_READY" },
  PRESENTATION_SNAPSHOT_COMPLETE: {
    type: "PRESENTATION_SNAPSHOT_COMPLETE",
    connectionId: "connection-1",
    connectionGeneration: 1,
    gameplayViewGeneration: 1,
    relocationRevision: 1,
    resourceVisionRevision: 1,
    populationPreparationGeneration: 1
  },
  SALON_ENTERED: { type: "SALON_ENTERED" },
  SALON_POSITION: { type: "SALON_POSITION" },
  SALON_EDITOR_OPENED: { type: "SALON_EDITOR_OPENED" },
  SALON_EDITOR_CANCELLED: { type: "SALON_EDITOR_CANCELLED" },
  SALON_APPEARANCE_SAVED: { type: "SALON_APPEARANCE_SAVED" },
  SALON_EXITED: { type: "SALON_EXITED" },
  SALON_ERROR: { type: "SALON_ERROR" },
  MASK_EQUIPPED: { type: "MASK_EQUIPPED" },
  SESSION_REPLACED: { type: "SESSION_REPLACED" },
  SKILL_MUTATION_CONFIRMED: {
    type: "SKILL_MUTATION_CONFIRMED",
    requestId: "fixture",
    action: "spend",
    replayed: false,
    snapshot: SKILL_SNAPSHOT_FIXTURE
  },
  SKILL_TREE_SNAPSHOT: {
    type: "SKILL_TREE_SNAPSHOT",
    requestId: "fixture",
    snapshot: SKILL_SNAPSHOT_FIXTURE
  },
  SOCIAL_STATE_CHANGED: { type: "SOCIAL_STATE_CHANGED" },
  SPECIALIZATION_MUTATION_CONFIRMED: {
    type: "SPECIALIZATION_MUTATION_CONFIRMED",
    requestId: "fixture",
    action: "activate",
    specializationId: null,
    replayed: false,
    snapshot: SKILL_SNAPSHOT_FIXTURE
  },
  SKILL_UNLOCK_STATE: {
    type: "SKILL_UNLOCK_STATE",
    discoveredGeneralSkills: ["pierce_armor"],
    classWrits: ["knight"]
  },
  TRAVEL_INBOX_SNAPSHOT: { type: "TRAVEL_INBOX_SNAPSHOT" },
  TRAVEL_RESULT: { type: "TRAVEL_RESULT" },
  WATER_COLLECTED: { type: "WATER_COLLECTED" },
  WELCOME: { type: "WELCOME" },
  WORLD_MAP_DESTINATIONS: { type: "WORLD_MAP_DESTINATIONS" },
  MAP_MARKERS_STATE: { type: "MAP_MARKERS_STATE" },
  MAP_MARKERS_ERROR: { type: "MAP_MARKERS_ERROR" },
  XP_GRANTED: { type: "XP_GRANTED" }
} as const satisfies {
  [Type in ServerMessage["type"]]: Readonly<{ type: Type } & Record<string, unknown>>;
};

describe("ServerMessage exhaustive fixtures", () => {
  it("parses map marker state with and without the Voyager block", () => {
    const base = {
      markers: [], waypoint: null, compass: { held: false, daysUsed: 0, maxDays: 30 },
      kitCount: 0, cartographyRank: 0, markerCap: 50
    };
    const plain = parseServerMessage(JSON.stringify({ type: "MAP_MARKERS_STATE", requestId: "m1", state: base }));
    expect(plain).toMatchObject({ type: "MAP_MARKERS_STATE", state: base });
    expect((plain as { state: object }).state).not.toHaveProperty("voyager");
    const voyager = { rank: 3, recordCost: 7, recordCap: 5, locations: [{ id: "l1", name: "Camp", lat: 35, lon: -106, createdAt: 1 }] };
    expect(parseServerMessage(JSON.stringify({ type: "MAP_MARKERS_STATE", requestId: "m2", state: { ...base, voyager } })))
      .toMatchObject({ state: { voyager } });
  });

  it("accepts pet open-land travel results", () => {
    expect(parseServerMessage(JSON.stringify({
      type: "TRAVEL_RESULT",
      requestId: "pet-travel-1",
      kind: "pet_open_land",
      success: true,
      message: "Travelled to open land."
    }))).toMatchObject({ type: "TRAVEL_RESULT", kind: "pet_open_land", success: true });
  });

  it("owns exactly one runtime validation route and one valid fixture per discriminant", () => {
    const routeTypes = Object.keys(SERVER_MESSAGE_VALIDATION_ROUTES).sort();
    const fixtureTypes = Object.keys(SERVER_MESSAGE_FIXTURE_SEEDS).sort();
    expect(routeTypes.length).toBeGreaterThan(0);
    expect(routeTypes).toEqual(fixtureTypes);

    for (const type of fixtureTypes as ServerMessage["type"][]) {
      const schema = SERVER_MESSAGE_VALIDATION_ROUTES[type];
      try {
        const fixture = validFixture(schema, SERVER_MESSAGE_FIXTURE_SEEDS[type]);
        expect(parseServerMessage(JSON.stringify(fixture)).type).toBe(type);
      } catch (error) {
        throw new Error(`${type}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  });
});

const STRING_CANDIDATES = [
  "fixture",
  "1",
  "0",
  "00000000-0000-4000-8000-000000000001",
  "2026-01-01T00:00:00.000Z",
  "public:general",
  "local:map",
  "wood",
  "warrior",
  "#000000",
  "https://example.com",
  "NM",
  "zone-1",
  "ash-atlas"
];

function validFixture(schema: ZodTypeAny, seed: unknown): unknown {
  const candidate = fixtureCandidate(schema, seed);
  const result = schema.safeParse(candidate);
  if (!result.success) {
    throw new Error(`Fixture generation failed: ${result.error.message}`);
  }
  return result.data;
}

function fixtureCandidate(schema: ZodTypeAny, seed: unknown): unknown {
  if (schema instanceof z.ZodLiteral) return schema.value;
  if (schema instanceof z.ZodEnum) return schema.options[0];
  if (schema instanceof z.ZodNativeEnum) {
    return Object.values(schema.enum).find((value) => typeof value === "string");
  }
  if (schema instanceof z.ZodString) {
    if (typeof seed === "string" && schema.safeParse(seed).success) return seed;
    const candidate = STRING_CANDIDATES.find((value) => schema.safeParse(value).success);
    if (candidate !== undefined) return candidate;
  }
  if (schema instanceof z.ZodNumber) {
    if (typeof seed === "number" && schema.safeParse(seed).success) return seed;
    const candidate = [1, 0, 35, 40, 60, 100, -106, 1_000]
      .find((value) => schema.safeParse(value).success);
    if (candidate !== undefined) return candidate;
  }
  if (schema instanceof z.ZodBoolean) return typeof seed === "boolean" ? seed : false;
  if (schema instanceof z.ZodNull) return null;
  if (schema instanceof z.ZodUndefined || schema instanceof z.ZodVoid) return undefined;
  if (schema instanceof z.ZodDate) return new Date("2026-01-01T00:00:00.000Z");
  if (schema instanceof z.ZodBigInt) return 1n;
  if (schema instanceof z.ZodNaN) return Number.NaN;
  if (schema instanceof z.ZodAny || schema instanceof z.ZodUnknown) return seed ?? {};
  if (schema instanceof z.ZodOptional) return seed === undefined
    ? undefined
    : fixtureCandidate(schema.unwrap(), seed);
  if (schema instanceof z.ZodNullable) return seed === undefined || seed === null
    ? null
    : fixtureCandidate(schema.unwrap(), seed);
  if (schema instanceof z.ZodDefault) return seed === undefined
    ? schema.parse(undefined)
    : fixtureCandidate(schema.removeDefault(), seed);
  if (schema instanceof z.ZodCatch) return fixtureCandidate(schema.removeCatch(), seed);
  if (schema instanceof z.ZodReadonly) return fixtureCandidate(schema.unwrap(), seed);
  if (schema instanceof z.ZodBranded) return fixtureCandidate(schema.unwrap(), seed);
  if (schema instanceof z.ZodEffects) {
    if (seed !== undefined && safelyAccepts(schema, seed)) return seed;
    for (const candidate of [...STRING_CANDIDATES, 1, 0]) {
      if (safelyAccepts(schema, candidate)) return candidate;
    }
    return fixtureCandidate(schema.innerType(), seed);
  }
  if (schema instanceof z.ZodPipeline) return fixtureCandidate(schema._def.in, seed);
  if (schema instanceof z.ZodLazy) return fixtureCandidate(schema.schema, seed);
  if (schema instanceof z.ZodArray) {
    if (Array.isArray(seed)) return seed.map((value) => fixtureCandidate(schema.element, value));
    const count = schema._def.exactLength?.value ?? schema._def.minLength?.value ?? 0;
    return Array.from({ length: count }, (_, index) => fixtureCandidate(schema.element, {
      kitIndex: index + 1,
      valid: true,
      invalidReason: null
    }));
  }
  if (schema instanceof z.ZodTuple) {
    return (schema.items as ZodTypeAny[]).map((item: ZodTypeAny, index: number) =>
      fixtureCandidate(item, Array.isArray(seed) ? seed[index] : undefined)
    );
  }
  if (schema instanceof z.ZodRecord) return {};
  if (schema instanceof z.ZodMap) return new Map();
  if (schema instanceof z.ZodSet) return new Set();
  if (schema instanceof z.ZodObject) {
    const source = typeof seed === "object" && seed !== null
      ? seed as Record<string, unknown>
      : {};
    const fixture: Record<string, unknown> = {};
    for (const [key, propertySchema] of Object.entries(schema.shape) as [string, ZodTypeAny][]) {
      if (Object.prototype.hasOwnProperty.call(source, key)) {
        fixture[key] = fixtureCandidate(propertySchema, source[key]);
      } else if (!(propertySchema.isOptional() || propertySchema instanceof z.ZodDefault)) {
        fixture[key] = fixtureCandidate(propertySchema, undefined);
      }
    }
    return fixture;
  }
  if (schema instanceof z.ZodDiscriminatedUnion || schema instanceof z.ZodUnion) {
    if (seed !== undefined && schema.safeParse(seed).success) return seed;
    const options: readonly ZodTypeAny[] = schema instanceof z.ZodDiscriminatedUnion
      ? [...schema.options]
      : schema.options;
    for (const option of options) {
      try {
        const candidate = fixtureCandidate(option, seed);
        if (
          typeof seed === "object" && seed !== null && "type" in seed &&
          typeof candidate === "object" && candidate !== null && "type" in candidate &&
          candidate.type !== seed.type
        ) continue;
        if (schema.safeParse(candidate).success) return candidate;
      } catch {
        // Try the next concrete member.
      }
    }
  }
  if (schema instanceof z.ZodIntersection) {
    return {
      ...fixtureCandidate(schema._def.left, seed) as object,
      ...fixtureCandidate(schema._def.right, seed) as object
    };
  }
  throw new Error(`No fixture generator for ${schema._def.typeName}`);
}

function safelyAccepts(schema: ZodTypeAny, candidate: unknown): boolean {
  try {
    return schema.safeParse(candidate).success;
  } catch {
    return false;
  }
}
