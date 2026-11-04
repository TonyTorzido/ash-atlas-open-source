import type {
  CollectibleNode,
  CollectibleSnapshotAuthority,
  HarvestSessionSnapshot,
  PlayerInventorySnapshot,
  RepeatableResourceNode,
  ResourceGain,
  ResourceType,
  ResourceVision,
  ResourceVisionStatus,
  WaterKind,
  WaterSourceHighlight
} from "../collectibles.js";
import type { BalsamResinEffectSnapshot } from "../givingTrees.js";
import type { FieldBuffSnapshot, FieldConsumableItemId } from "../fieldConsumables.js";
import type { DroppedItemSnapshot } from "../droppedItems.js";
import type { EquipmentSnapshotV2 } from "../equipment.js";
import type { HarvestAccessMode, HarvestTollType } from "../harvestAccess.js";
import type { InventoryProtectionSnapshot } from "../inventoryProtection.js";
import type { WorldViewAuthority } from "../worldView.js";
import type { HungerSnapshot } from "../hunger.js";
import type { BackpackDefinitionId, BackpackSnapshot } from "../backpacks.js";
import type { WaterSiteSnapshot } from "../tidecraft.js";

export type HarvestingServerMessage =
  | {
      type: "COLLECTIBLES_SNAPSHOT";
      playerId: string;
      relocationRevision: number;
      resourceVisionRevision: number;
      authority: CollectibleSnapshotAuthority;
      worldViewAuthority?: WorldViewAuthority;
      serverTime: number;
      visibleRadiusM: number;
      activationRadiusM: number;
      resourceVision: ResourceVision | null;
      resourceVisionStatus?: ResourceVisionStatus | null;
      waterHighlights: WaterSourceHighlight[];
      nodes: CollectibleNode[];
      repeatableNodes: RepeatableResourceNode[];
    }
  | { type: "RESOURCE_VISION_LOADING"; serverTime: number; resourceVision: ResourceVision; status: ResourceVisionStatus | null; message: string }
  | { type: "RESOURCE_VISION_READY"; serverTime: number; resourceVision: ResourceVision; status: ResourceVisionStatus }
  | { type: "HARVEST_STARTED"; requestId: string; session: HarvestSessionSnapshot; serverTime: number }
  | {
      type: "HARVEST_COMPLETED";
      requestId: string;
      session: HarvestSessionSnapshot;
      nodeId: string;
      playerId: string;
      inventory: PlayerInventorySnapshot;
      node?: CollectibleNode;
      nodeRemoved?: boolean;
      replayed: boolean;
      professionResults?: { bonusYield: boolean; instant: boolean };
      serverTime: number;
    }
  | { type: "HARVEST_CANCELLED"; requestId: string; session: HarvestSessionSnapshot; serverTime: number }
  | {
      type: "REPEATABLE_RESOURCE_HARVESTED";
      requestId: string;
      node: RepeatableResourceNode;
      playerId: string;
      inventory: PlayerInventorySnapshot;
      replayed: boolean;
      professionResults?: { bonusYield: boolean; instant: boolean; unbrokenVein: boolean };
      tollGold?: string;
      walletGold?: string | null;
      walletRevision?: string | null;
      serverTime: number;
    }
  | { type: "REPEATABLE_RESOURCE_UPDATED"; node: RepeatableResourceNode; serverTime: number }
  | { type: "MINE_CLAIMED"; requestId: string; node: RepeatableResourceNode; inventory: PlayerInventorySnapshot; replayed: boolean; message: string; serverTime: number }
  | {
      type: "HARVEST_ACCESS_CHANGED";
      ownerPlayerId: string;
      harvestType: HarvestTollType;
      assetId: string | null;
      accessMode: HarvestAccessMode | null;
      accessRevision: string | null;
      tollGold: string;
      serverTime: number;
    }
  | { type: "RESOURCE_GAINED"; playerId: string; gain: ResourceGain; serverTime: number }
  | {
      type: "COLLECTIBLE_REMOVED";
      nodeId: string;
      playerId: string;
      stateRevision?: number;
      serverTime: number;
    }
  | { type: "COLLECTIBLE_UPDATED"; node: CollectibleNode; playerId: string; serverTime: number }
  | { type: "COLLECTIBLE_PICKED_UP"; requestId?: string; nodeId: string; playerId: string; inventory: PlayerInventorySnapshot; serverTime: number }
  | { type: "PLAYER_RESOURCES_UPDATED"; playerId: string; inventory: PlayerInventorySnapshot; walletGold?: string; walletVersion?: string; serverTime: number }
  | { type: "WATER_COLLECTED"; requestId: string; playerId: string; waterKind: WaterKind; inventory: PlayerInventorySnapshot; serverTime: number; message: string }
  | { type: "ITEM_DROP_RESULT"; requestId: string; drop: DroppedItemSnapshot; inventory: PlayerInventorySnapshot; replayed: boolean; serverTime: number; message: string }
  | { type: "EQUIPMENT_DROP_RESULT"; requestId: string; drop: DroppedItemSnapshot; equipment: EquipmentSnapshotV2; replayed: boolean; serverTime: number; message: string }
  | { type: "INVENTORY_STACK_UPDATED"; requestId: string; action: "split" | "restack" | "move" | "reorganize"; inventory: PlayerInventorySnapshot; equipment?: EquipmentSnapshotV2; serverTime: number; message: string; walletGold?: string; walletVersion?: string }
  | { type: "INVENTORY_PROTECTION_SNAPSHOT"; protection: InventoryProtectionSnapshot }
  | { type: "INVENTORY_PROTECTION_UPDATED"; requestId: string; protection: InventoryProtectionSnapshot; replayed: boolean; message: string }
  | {
      type: "DROPPED_ITEM_PICKUP_RESULT";
      requestId: string;
      itemId: ResourceType;
      requestedQuantity: number;
      drop: DroppedItemSnapshot;
      pickedUpQuantity: number;
      remainingQuantity: number;
      removed: boolean;
      inventory: PlayerInventorySnapshot;
      replayed: boolean;
      serverTime: number;
      message: string;
    }
  | {
      type: "DROPPED_EQUIPMENT_PICKUP_RESULT";
      requestId: string;
      itemId: EquipmentSnapshotV2["instances"][number]["definitionId"];
      drop: DroppedItemSnapshot;
      equipment: EquipmentSnapshotV2;
      replayed: boolean;
      serverTime: number;
      message: string;
    }
  | {
      type: "DROPPED_BACKPACK_PICKUP_RESULT";
      requestId: string;
      itemId: BackpackDefinitionId;
      drop: DroppedItemSnapshot;
      backpacks: BackpackSnapshot;
      inventory: PlayerInventorySnapshot;
      replayed: boolean;
      serverTime: number;
      message: string;
    }
  | { type: "DROPPED_ITEMS_SNAPSHOT"; drops: DroppedItemSnapshot[]; serverTime: number }
  | {
      type: "CONSUMABLE_USED";
      requestId: string;
      itemId: "giving_berry";
      playerId: string;
      inventory: PlayerInventorySnapshot;
      effect: BalsamResinEffectSnapshot;
      replayed: boolean;
      serverTime: number;
      message: string;
    }
  | {
      type: "SIMPLE_FOOD_CONSUMED";
      requestId: string;
      itemId: "simple_food";
      playerId: string;
      inventory: PlayerInventorySnapshot;
      hunger: HungerSnapshot;
      restoredQuantity: number;
      replayed: boolean;
      serverTime: number;
      message: string;
    }
  | {
      type: "FIELD_CONSUMABLE_USED";
      requestId: string;
      itemId: FieldConsumableItemId;
      playerId: string;
      inventory: PlayerInventorySnapshot;
      buffs: FieldBuffSnapshot[];
      replayed: boolean;
      serverTime: number;
      message: string;
    }
  | {
      type: "FIELD_CONSUMABLE_CRAFTED";
      requestId: string;
      itemId: FieldConsumableItemId;
      quantity: number;
      inventory: PlayerInventorySnapshot;
      replayed: boolean;
      message: string;
    }
  | { type: "FIELD_BUFFS"; buffs: FieldBuffSnapshot[]; serverTime: number }
  | {
      type: "WATER_SITES";
      requestId?: string;
      sites: WaterSiteSnapshot[];
      tidecraftRank: number;
      tidecraftDiscovered: boolean;
      serverTime: number;
    }
  | {
      type: "PEARL_DIVE_RESULT";
      requestId: string;
      siteId: string;
      pearls: number;
      diveReadyAt: number;
      inventory: PlayerInventorySnapshot;
      replayed: boolean;
      serverTime: number;
      message: string;
    };
