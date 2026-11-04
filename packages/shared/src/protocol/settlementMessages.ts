import type { BackpackSnapshot } from "../backpacks.js";
import type { EquipmentSnapshotV2 } from "../equipment.js";
import type {
  KingdomChatMessage,
  KingdomSpatialWireChange,
  KingdomStateSnapshot
} from "../kingdoms.js";
import type {
  CityAppSnapshot,
  CityStructureSnapshot,
  GoblinMarketSnapshot,
  CityWarehouseSnapshot,
  OilWellSnapshot
} from "../citySystem.js";
import type { DroppedItemSnapshot } from "../droppedItems.js";
import type { CityMarketDailySnapshot } from "../cityMarketDaily.js";
import type { PremiumWalletSnapshot } from "../premiumCurrency.js";
import type {
  CityConstructionAction,
  CityFoundingPreview,
  CityInfoSnapshot,
  CityMembershipSnapshot,
  CitySnapshot,
  FlagSnapshot
} from "../types.js";
import type { LibrarySnapshot, LibraryStudyResult } from "../library.js";
import type { PlayerInventorySnapshot } from "../collectibles.js";
import type { HollinHutShopSnapshot } from "../hollinHut.js";
import type { WanderingMerchantMapEntry, WanderingMerchantShopSnapshot } from "../wanderingMerchant.js";
import type { MilitaryIndustrySnapshot, MilitarySiegeVolleyCue, MilitaryBomberDetonationCue } from "../militaryIndustry.js";

export type SettlementServerMessage =
  | {
      type: "MILITARY_INDUSTRY_STATE";
      requestId: string;
      snapshot: MilitaryIndustrySnapshot;
      siegeVolleys?: readonly MilitarySiegeVolleyCue[];
      bomberDetonations?: readonly MilitaryBomberDetonationCue[];
    }
  | {
      type: "MILITARY_INDUSTRY_CHANGED";
      requestId: string;
      snapshot: MilitaryIndustrySnapshot;
      replayed: boolean;
      inventory?: PlayerInventorySnapshot;
      walletGold?: string;
      walletVersion?: string;
      damage?: number;
      siegeVolleys?: readonly MilitarySiegeVolleyCue[];
      bomberDetonations?: readonly MilitaryBomberDetonationCue[];
    }
  | { type: "GOBLIN_VILLAGE_REMOVED"; cityId: string; structureIds: string[] }
  | { type: "GOBLIN_MARKET_SNAPSHOT"; requestId: string; snapshot: GoblinMarketSnapshot }
  | { type: "GOBLIN_MARKET_ERROR"; requestId: string; code: string; message: string }
  | {
      type: "GOBLIN_MARKET_SOLD";
      requestId: string;
      replayed: boolean;
      offerGold: string;
      snapshot: GoblinMarketSnapshot;
      inventory: PlayerInventorySnapshot;
      equipment: EquipmentSnapshotV2;
      backpacks: BackpackSnapshot;
      walletGold: string;
      walletVersion: string;
    }
  | {
      type: "GOBLIN_MARKET_PURCHASED";
      requestId: string;
      replayed: boolean;
      itemId: "wheat_seed";
      quantity: number;
      totalGold: string;
      snapshot: GoblinMarketSnapshot;
      inventory: PlayerInventorySnapshot;
      walletGold: string;
      walletVersion: string;
    }
  | { type: "HOLLIN_HUT_SHOP"; requestId: string; snapshot: HollinHutShopSnapshot }
  | { type: "HOLLIN_HUT_ERROR"; requestId: string; code: string; message: string }
  | {
      type: "HOLLIN_HUT_SERVICED";
      requestId: string;
      hutId: string;
      service: "heal" | "turn_in_eggs";
      message: string;
      snapshot: HollinHutShopSnapshot;
      inventory?: PlayerInventorySnapshot;
      walletGold?: string;
      walletVersion?: string;
    }
  | { type: "HOLLIN_HUT_PACIFIED"; requestId: string; hutId: string; message: string; snapshot: HollinHutShopSnapshot; inventory: PlayerInventorySnapshot }
  | {
      type: "HOLLIN_HUT_PURCHASED";
      requestId: string;
      replayed: boolean;
      itemId: string;
      quantity: number;
      totalGold: string;
      snapshot: HollinHutShopSnapshot;
      inventory: PlayerInventorySnapshot;
      walletGold: string;
      walletVersion: string;
    }
  | { type: "WANDERING_MERCHANTS"; merchants: WanderingMerchantMapEntry[] }
  | { type: "WANDERING_MERCHANT_SHOP"; requestId: string; snapshot: WanderingMerchantShopSnapshot }
  | { type: "WANDERING_MERCHANT_ERROR"; requestId: string; code: string; message: string }
  | {
      type: "WANDERING_MERCHANT_PURCHASED";
      requestId: string;
      replayed: boolean;
      itemId: string;
      quantity: number;
      totalGold: string;
      snapshot: WanderingMerchantShopSnapshot;
      inventory: PlayerInventorySnapshot;
      walletGold: string;
      walletVersion: string;
    }
  | { type: "CINDER_LANTERN_CRAFTED"; requestId: string; replayed: boolean; charges: number; message: string; inventory: PlayerInventorySnapshot }
  | { type: "KINGDOM_STATE"; state: KingdomStateSnapshot }
  | { type: "KINGDOM_STATE_CHANGED"; playerId: string }
  | { type: "KINGDOM_SPATIAL_CHANGES"; changes: KingdomSpatialWireChange[] }
  | { type: "KINGDOM_CHAT_MESSAGE"; message: KingdomChatMessage }
  | { type: "CITIES_SNAPSHOT"; cities: CitySnapshot[] }
  | { type: "CITY_MEMBERSHIP_SNAPSHOT"; membership: CityMembershipSnapshot | null }
  | { type: "CITY_APP"; requestId: string; snapshot: CityAppSnapshot }
  | { type: "CITY_STRUCTURES_SNAPSHOT"; structures: CityStructureSnapshot[] }
  | { type: "OWNER_OIL_WELL_PROJECTION"; structure: CityStructureSnapshot | null }
  | {
      type: "CITY_STRUCTURE_WARFARE_CHANGED";
      requestId: string;
      action: "attack" | "repair_started" | "repair_stopped";
      structureId: string;
      damage?: number;
      replayed: boolean;
    }
  | {
      type: "CITY_HOUSE_CHANGED";
      requestId: string;
      structure: CityStructureSnapshot;
      membership: CityMembershipSnapshot | null;
      replayed: boolean;
      inventory?: PlayerInventorySnapshot;
      droppedItems?: DroppedItemSnapshot[];
    }
  | {
      type: "CITY_FACILITY_CHANGED";
      requestId: string;
      structure: CityStructureSnapshot;
      droppedItems?: DroppedItemSnapshot[];
    }
  | {
      type: "LIBRARY_STATE";
      requestId: string;
      library: LibrarySnapshot;
      /** Present after a study request. */
      result?: LibraryStudyResult;
      walletGold?: string;
      walletVersion?: string;
    }
  | {
      type: "OIL_WELL_OPENED";
      requestId: string;
      well: OilWellSnapshot;
    }
  | {
      type: "OIL_WELL_HARVESTED";
      requestId: string;
      well: OilWellSnapshot;
      inventory: PlayerInventorySnapshot;
      harvestedQuantity: number;
      replayed: boolean;
      message: string;
      tollGold?: string;
      walletGold?: string;
      walletVersion?: string;
    }
  | {
      type: "CITY_WAREHOUSE_OPENED";
      requestId: string;
      warehouse: CityWarehouseSnapshot;
    }
  | {
      type: "CITY_WAREHOUSE_UPDATED";
      requestId: string;
      warehouse: CityWarehouseSnapshot;
      inventory: PlayerInventorySnapshot;
      replayed: boolean;
      donatedQuantity: number;
    }
  | {
      type: "CITY_GOLD_DONATED";
      requestId: string;
      warehouse: CityWarehouseSnapshot;
      walletGold: string;
      walletVersion: string;
      replayed: boolean;
      donatedGold: string;
    }
  | {
      type: "CITY_MARKET_DAILY_PURCHASED";
      requestId: string;
      cityId: string;
      marketDaily: CityMarketDailySnapshot;
      treasuryBalance: string;
      premiumWallet: PremiumWalletSnapshot;
      replayed: boolean;
    }
  | { type: "CITY_FOUNDING_PREVIEW"; requestId: string; preview: CityFoundingPreview }
  | { type: "CITY_INFO"; requestId: string; info: CityInfoSnapshot }
  | {
      type: "CITY_FOUNDED";
      requestId: string;
      city: CitySnapshot;
      seatFlag: FlagSnapshot;
      territoryFlags: FlagSnapshot[];
      replayed: boolean;
      materialCost: 0;
    }
  | {
      type: "CITY_CONSTRUCTION_ADVANCED";
      requestId: string;
      action: CityConstructionAction;
      city: CitySnapshot;
      replayed: boolean;
      inventory?: PlayerInventorySnapshot;
      walletGold?: string;
      walletVersion?: string;
    }
  | { type: "CITY_TERRITORY_SYNC"; cityId: string; flags: FlagSnapshot[] }
  | {
      type: "CITY_JOINED";
      requestId: string;
      info: CityInfoSnapshot;
      membership: CityMembershipSnapshot;
      replayed: boolean;
    }
  | { type: "CITY_LEFT"; requestId: string; info: CityInfoSnapshot; cityId: string; replayed: boolean }
  | {
      type: "CITY_MEMBERSHIP_UPDATED";
      cityId: string;
      playerId: string;
      memberCount: number;
      expansionFlagCount: number;
      expansionFlagLimit: number;
      action: "joined" | "left" | "flag_converted";
    }
  | {
      type: "CITY_MAYOR_UPDATED";
      requestId: string;
      city: CitySnapshot;
      actorPlayerId: string;
      action: "claimed" | "relinquished";
      replayed: boolean;
    }
  | {
      type: "CITY_FLAG_CONVERSION_STARTED";
      conversionId: string;
      requestId: string;
      flagId: string;
      flagName: string;
      cityId: string;
      cityName: string;
      position: { lat: number; lon: number };
      startedAt: number;
      completesAt: number;
      durationMs: number;
      serverTime: number;
    }
  | {
      type: "CITY_FLAG_CONVERTED";
      conversionId: string;
      requestId: string;
      flag: FlagSnapshot;
      expansionFlagCount: number;
      expansionFlagLimit: number;
      replayed: boolean;
    };
