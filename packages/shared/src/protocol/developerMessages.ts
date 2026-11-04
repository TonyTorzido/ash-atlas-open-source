import type { PlayerInventorySnapshot } from "../collectibles.js";
import type { MobAppearanceVariant, MobArchetypeKey } from "../combat.js";
import type { PlantBookKey } from "../creatureBook.js";
import type { PlayerSnapshot } from "../playerSnapshotContracts.js";
import type { CitySnapshot, FlagSnapshot } from "../types.js";
import type { CityStructureSnapshot } from "../citySystem.js";
import type { DungeonEntranceSnapshot } from "../dungeon.js";
import type { PremiumWalletSnapshot } from "../premiumCurrency.js";
import type { DeveloperTestFlagKind, DeveloperTestUnitType } from "./developerSchemas.js";

export type DeveloperServerMessage =
  | {
      type: "DEV_DUNGEON_ENTRANCES_SNAPSHOT";
      requestId: string;
      entrances: DungeonEntranceSnapshot[];
    }
  | {
      type: "DEV_DUNGEON_ENTRANCE_SPAWNED";
      requestId: string;
      replayed: boolean;
      entrance: DungeonEntranceSnapshot;
    }
  | {
      type: "DEV_DUNGEON_ENTRANCE_DELETED";
      requestId: string;
      replayed: boolean;
      entranceId: string;
    }
  | {
      type: "DEV_GOBLIN_VILLAGES_SNAPSHOT";
      villages: ActiveGoblinVillageSnapshot[];
    }
  | {
      type: "DEV_GOBLIN_VILLAGE_DELETED";
      requestId: string;
      result: GoblinVillageDeletionSnapshot;
    }
  | {
      type: "DEV_GOBLIN_VILLAGE_SPAWNED";
      requestId: string;
      replayed: boolean;
      city: CitySnapshot;
      flags: FlagSnapshot[];
      market: CityStructureSnapshot;
    }
  | {
      type: "DEV_TERRITORY_COLLAPSE_RESULT";
      requestId: string;
      kind: "city" | "kingdom";
      targetId: string;
      name: string;
      collapseId: string;
      flagCount: number;
    }
  | {
      type: "DEV_CAPITAL_FOUNDING_RESULT";
      requestId: string;
      dryRun: boolean;
      replayed: boolean;
      plan: DeveloperCapitalFoundingPlan;
      city: CitySnapshot | null;
    }
  | {
      type: "DEV_CLASS_COOLDOWNS_RESET";
      requestId: string;
      serverTime: number;
    }
  | {
      type: "DEV_ASSETS_GRANTED";
      requestId: string;
      replayed: boolean;
      walletGold: string;
      walletVersion?: string;
      premiumWallet?: PremiumWalletSnapshot;
      inventory: PlayerInventorySnapshot;
      cityCoins: {
        creditedAmount: number;
        cityId: string;
        cityName: string;
        treasuryBalance: string;
        playerContribution: string;
      } | null;
      grants: Array<{
        itemId: string;
        requestedQuantity: number;
        grantedQuantity: number;
        remainderQuantity: number;
      }>;
    }
  | { type: "DEV_MOB_SPAWNED"; requestId: string; mobEntityId: string; archetype: MobArchetypeKey; appearanceVariant: MobAppearanceVariant }
  | { type: "DEV_MOBS_CLEARED"; requestId: string; removedCount: number }
  | { type: "DEV_PLANT_SPAWNED"; requestId: string; plantEntityId: string; plantKey: PlantBookKey }
  | { type: "DEV_PLANTS_CLEARED"; requestId: string; removedCount: number }
  | {
      type: "DEV_TEST_FLAG_SPAWNED";
      requestId: string;
      replayed: boolean;
      targetKind: DeveloperTestFlagKind;
      flag: FlagSnapshot;
    }
  | {
      type: "DEV_TEST_UNIT_SPAWNED";
      requestId: string;
      replayed: boolean;
      unitType: DeveloperTestUnitType;
      unitId: string;
      groupId: string;
    }
  | {
      type: "DEV_TELEPORT_COMPLETED";
      requestId: string;
      player: PlayerSnapshot;
      packageId: string;
      zoneId: string;
      resourceVisionRevision?: number;
      serverTime: number;
    }
  | {
      type: "DEV_MINE_VISIT_COMPLETED";
      requestId: string;
      mineId: string;
      flagId: string;
      player: PlayerSnapshot;
      serverTime: number;
    };

export type DeveloperCapitalSkipReason =
  | "terrain_unavailable"
  | "world_edge"
  | "existing_territory"
  | "disconnected";

export type DeveloperCapitalExcludedReason =
  | "kingdom"
  | "other_city"
  | "atlas_shrine"
  | "tower"
  | "buoy"
  | "system_controlled"
  | "legendary_event"
  | "disconnected";

export type DeveloperCapitalStructureType = "mayor_house" | "warehouse" | "market";

export type DeveloperCapitalFoundingPlan = {
  cityName: string;
  municipalityId: string;
  municipalityLabel: string;
  hall: { lat: number; lon: number; snappedFromAnchorM: number };
  candidateFlagCount: number;
  placedFlags: Array<{ slot: number; lat: number; lon: number }>;
  skippedFlags: Array<{
    slot: number;
    lat: number;
    lon: number;
    reason: DeveloperCapitalSkipReason;
  }>;
  /** Personal flags inside the footprint that become capital city flags held by the Mayor. */
  annexedFlags: Array<{
    flagId: string;
    previousOwnerPlayerId: string;
    previousOwnerUsername: string | null;
    lat: number;
    lon: number;
    /** The slot this flag fills, so no new flag is placed there. */
    filledSlot: number | null;
  }>;
  /** Flags inside the footprint that are left untouched. */
  excludedFlags: Array<{
    flagId: string;
    ownerPlayerId: string;
    ownerUsername: string | null;
    lat: number;
    lon: number;
    reason: DeveloperCapitalExcludedReason;
  }>;
  structures: Array<{ type: DeveloperCapitalStructureType; lat: number; lon: number }>;
  marketVenueKey: string;
  /** The caller's current city, when they hold an active City House elsewhere. */
  currentCity: { cityId: string; cityName: string; role: "member" | "mayor" } | null;
  /** True when founding requires leaving currentCity first. */
  leaveRequired: boolean;
  /** What leaving the current city destroys, under normal City House destruction rules. */
  leave: {
    cityId: string;
    cityName: string;
    houseStructureId: string;
    houseType: "city_house" | "mayor_house";
    mayorRelinquished: boolean;
    destroyedStructures: Array<{ structureId: string; type: string; state: string }>;
    refundedLines: Array<{ itemId: string; quantity: number }>;
    droppedLines: Array<{ itemId: string; quantity: number }>;
  } | null;
};

export type ActiveGoblinVillageSnapshot = Readonly<{
  cityId: string;
  name: string;
  hallLat: number;
  hallLon: number;
  flagCount: number;
  createdAt: string;
}>;

export type GoblinVillageDeletionSnapshot = Readonly<{
  replayed: boolean;
  city: Readonly<{ cityId: string; name: string; hallLat: number; hallLon: number }>;
  removedFlagIds: string[];
  structureIds: string[];
  affectedZoneIds: string[];
}>;
