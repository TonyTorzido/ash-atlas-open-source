import type { ResourceType } from "./collectibles.js";
import type { EquipmentDefinitionId } from "./equipment.js";
import type {
  BackpackDefinitionId,
  BackpackInstanceSnapshot
} from "./backpacks.js";

export const DROPPED_ITEM_PICKUP_RADIUS_M = 20;
export const DROPPED_ITEM_PILE_MERGE_RADIUS_M = 100;
/** Local-room pickup radius for the bounded Manor floor-drop hook. */
export const MANOR_DROPPED_EQUIPMENT_PICKUP_RADIUS = 72;
/**
 * Manor floor drops are picked up only after the authoritative feet anchor
 * reaches the stored point. This small tolerance is for float transport
 * round-off, not a player-facing pickup radius.
 */
export const MANOR_DROPPED_ITEM_PICKUP_EPSILON = 0.01;

export const DROPPED_ITEM_STATUSES = [
  "active",
  "picked_up",
  "expired",
  "cancelled"
] as const;

export type DroppedItemStatus = (typeof DROPPED_ITEM_STATUSES)[number];

export type DroppedItemSnapshot = {
  dropId: string;
  droppedBy: string;
  regionCode: string;
  zoneId?: string;
  pileId?: string;
  pileOrder?: number;
  itemId: ResourceType | EquipmentDefinitionId | BackpackDefinitionId;
  equipmentInstanceId?: string;
  /** Present only for a unique backpack floor drop. */
  backpackInstanceId?: string;
  /** Full identity snapshot for a unique backpack floor drop. */
  backpack?: BackpackInstanceSnapshot;
  variant: string | null;
  quantity: number;
  /** Authoritative runtime limit supplied by the server item catalog. */
  maxStack?: number;
  status: DroppedItemStatus;
  lat: number;
  lon: number;
  createdAt: string;
  expiresAt: string;
  pickedUpBy: string | null;
  pickedUpAt: string | null;
  /** Present only for the bounded Manor-local equipment-drop projection. */
  manorId?: string;
  spaceId?: string;
  localX?: number;
  localY?: number;
};
