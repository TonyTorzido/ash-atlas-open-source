import type { CategoryRecipeInput } from "./materialGrades.js";
import type { PlayerInventorySnapshot, ResourceType } from "./collectibles.js";
import type { DroppedItemSnapshot } from "./droppedItems.js";
import {
  GREENHOUSE_STUDIO_CATALOG,
  type GreenhousePlacementKind,
  type GreenhouseStudioWaterStorageAnchor
} from "./greenhouseStudio.js";

/** Canonical greenhouse constants. Water is represented in tenths of a gallon. */
export const GREENHOUSE_BUILD_DURATION_MS = 30_000;
export const GREENHOUSE_BUILD_COST = Object.freeze([
  Object.freeze({ itemId: "wood" as const, quantity: 100 }),
  Object.freeze({ itemId: "iron_bar" as const, quantity: 10 }),
  Object.freeze({ itemId: "stone" as const, quantity: 30 })
]);
/** Materials and carried water consumed when a player places one Farm Plot. */
export const GREENHOUSE_FARM_PLOT_PLACEMENT_COST = Object.freeze([
  Object.freeze({ itemId: "wood" as const, quantity: 100 }),
  Object.freeze({ itemId: "fertilizer" as const, quantity: 50 })
]);
export const GREENHOUSE_FERTILIZER_RECIPE = Object.freeze([
  Object.freeze({ itemId: "simple_food" as const, quantity: 5 }),
  Object.freeze({ itemId: "flux_plant" as const, quantity: 1 })
]);
/** Fertilizer also takes 1 any Bones (Bone, horns, fangs), lowest grade first. */
export const GREENHOUSE_FERTILIZER_CATEGORY_INPUTS: readonly CategoryRecipeInput[] = Object.freeze([
  Object.freeze({ category: Object.freeze({ groups: ["bones"] as const, label: "any Bones" }), quantity: 1 })
]);
export const GREENHOUSE_ROOM_COUNT = 1;
export const GREENHOUSE_INITIAL_ROWS = 3;
export const GREENHOUSE_INITIAL_COLUMNS = 5;
export const GREENHOUSE_INITIAL_ANCHOR_COUNT = GREENHOUSE_INITIAL_ROWS * GREENHOUSE_INITIAL_COLUMNS;
export const GREENHOUSE_TANK_CAPACITY_TENTHS = 200;
export const GREENHOUSE_STARTING_TANK_WATER_TENTHS = 50;
export const GREENHOUSE_GARDENING_BUCKET_CAPACITY_TENTHS = 10;
export const GREENHOUSE_WATER_BUCKET_CAPACITY_TENTHS = 50;
export const GREENHOUSE_WATERING_QUANTITY_TENTHS = 1;
export const GREENHOUSE_WATER_BUCKET_FILL_DURATION_MS = 3_000;
export const GREENHOUSE_WATER_BUCKET_MAX_RANGE_M = 200;
export const GREENHOUSE_TANK_INTERACTION_RADIUS = 90;
/** Indoor planter actions use the same authored-coordinate interaction model as the tank. */
export const GREENHOUSE_PLANTER_INTERACTION_RADIUS = 90;
export const GREENHOUSE_INTERACTION_APPROACH_INSET = 25;
export const GREENHOUSE_PLANT_ACTION_DURATION_MS = 2_000;
export const GREENHOUSE_WATER_ACTION_DURATION_MS = 4_000;
export const GREENHOUSE_PLANT_AND_WATER_ACTION_DURATION_MS = 6_000;
export const GREENHOUSE_CLIPPING_ACTION_DURATION_MS = 4_000;
export const GREENHOUSE_DESTROY_INTERACTION_RADIUS_M = 250;
export const GREENHOUSE_RIVERBANK_POLICY_ID = "canonical-water-surface-land-within-500m-v1";
export const GREENHOUSE_RIVERBANK_POLICY_DISTANCE_M = 500;

export const GREENHOUSE_LOCATION_TYPE = "greenhouse" as const;
export const GREENHOUSE_MAIN_ROOM = "greenhouse_main_room" as const;
export const GREENHOUSE_ANCHOR_PREFIX = "greenhouse-main-anchor" as const;
export const GREENHOUSE_ROOM_WIDTH = GREENHOUSE_STUDIO_CATALOG.roomWidth;
export const GREENHOUSE_ROOM_HEIGHT = GREENHOUSE_STUDIO_CATALOG.roomHeight;

export const GREENHOUSE_STAGE_IDS = ["seedling", "middle_2", "middle_3", "full"] as const;
export type GreenhouseStageId = (typeof GREENHOUSE_STAGE_IDS)[number];
export type GreenhousePlantStage = 1 | 2 | 3 | 4;
/** Stable, server-validated identity for a greenhouse crop. */
export type GreenhouseCropId = string;
/** Crop IDs are bounded lowercase slugs safe for persisted inventory variants. */
export const GREENHOUSE_CROP_ID_REGEX = /^[a-z][a-z0-9_]{0,47}$/;

export const GREENHOUSE_STAGE_ART_IDS: Readonly<Record<GreenhousePlantStage, string>> = Object.freeze({
  1: "wheat_seedling",
  2: "wheat_middle_2",
  3: "wheat_middle_3",
  4: "wheat_full"
});
export const GREENHOUSE_GIVING_BERRY_TREE_CROP_ID = "giving_berry_tree" as const;

export type GreenhouseBuildCost = Readonly<{
  itemId: Extract<ResourceType, "wood" | "iron_bar" | "stone">;
  quantity: number;
}>;

export type GreenhouseEligibilitySnapshot = Readonly<{
  isRiverbank: boolean;
  policyId: string;
  policyDistanceM: number;
  checkedAt: string;
}>;

export type GreenhouseAnchorSnapshot = Readonly<{
  anchorId: string;
  roomId: string;
  row: number;
  column: number;
  x: number;
  y: number;
  active: boolean;
  /** False means this stable slot is still available for player placement. */
  placed?: boolean;
  plant: GreenhousePlantSnapshot | null;
}>;

export type GreenhousePlantSnapshot = Readonly<{
  anchorId: string;
  cropId: GreenhouseCropId;
  stage: GreenhousePlantStage;
  artId: string;
  plantedAt: string;
  wateredAt: string | null;
  nextStageAt: string | null;
  dry: boolean;
  /** Giving trees keep their plant row after berries are gathered. */
  berriesRemaining?: number | null;
  resinHarvested?: boolean;
}>;

export type GreenhouseCropCatalogEntrySnapshot = Readonly<{
  cropId: GreenhouseCropId;
  displayName: string;
  seedDisplayName: string;
  seed: Readonly<{ itemId: "seed" | "wheat_seed" | "giving_berry"; variant: string | null }>;
  maxStage: GreenhousePlantStage;
  harvestQuantity: number;
  clippingStages: readonly GreenhousePlantStage[];
  plantingAvailable: boolean;
  stageArtIds: readonly [string, string, string, string];
}>;

export type GreenhouseCropCatalogSnapshot = Readonly<{
  packId: string | null;
  crops: readonly GreenhouseCropCatalogEntrySnapshot[];
}>;

export type GreenhouseSnapshot = Readonly<{
  greenhouseId: string;
  ownerPlayerId: string;
  ownerUsername?: string;
  regionCode: string;
  lat: number;
  lon: number;
  builtAt: string;
  placementRevision: number;
  roomCount: number;
  planterCapacity: number;
  tankWaterTenths: number;
  tankCapacityTenths: number;
  eligibility: GreenhouseEligibilitySnapshot;
  anchors: readonly GreenhouseAnchorSnapshot[];
  waterStorage: GreenhouseStudioWaterStorageAnchor & { placed: boolean };
}>;

export type GreenhouseBuildSnapshot = Readonly<{
  buildId: string;
  position: Readonly<{ lat: number; lon: number }>;
  eligibility: GreenhouseEligibilitySnapshot;
  startedAt: number;
  completesAt: number;
  durationMs: number;
}>;

export type GreenhouseBuildPreview = Readonly<{
  position: Readonly<{ lat: number; lon: number }>;
  eligibility: GreenhouseEligibilitySnapshot;
  stageDurationMs: number;
  serverTime: number;
}>;

export type GreenhouseStateSnapshot = Readonly<{
  greenhouse: GreenhouseSnapshot;
  serverTime: number;
  waterBucketGallons: number;
  gardeningBucketGallons: number;
  inventory: PlayerInventorySnapshot;
  /** Present for clients that advertise the verified crop-art catalog capability. */
  cropCatalog?: GreenhouseCropCatalogSnapshot;
}>;

export type GreenhouseBuildResult =
  | Readonly<{
      status: "constructing";
      build: GreenhouseBuildSnapshot;
      inventory: PlayerInventorySnapshot;
      replayed: boolean;
    }>
  | Readonly<{
      status: "completed";
      greenhouse: GreenhouseSnapshot;
      inventory: PlayerInventorySnapshot;
      replayed: boolean;
    }>;

export type GreenhouseBuildCancellation = Readonly<{
  playerId: string;
  requestId: string;
  buildId: string;
  inventory: PlayerInventorySnapshot;
  droppedItems: DroppedItemSnapshot[];
  message: string;
}>;

export type GreenhouseMutationResult = Readonly<{
  state: GreenhouseStateSnapshot;
  inventory: PlayerInventorySnapshot;
  replayed: boolean;
  message: string;
  yieldQuantity?: number;
  placementKind?: GreenhousePlacementKind;
  placedAnchorId?: string;
}>;

export function greenhouseAnchorId(roomId: string, row: number, column: number): string {
  if (!Number.isSafeInteger(row) || row < 0 || !Number.isSafeInteger(column) || column < 0) {
    throw new Error("Greenhouse anchor coordinates must be non-negative integers");
  }
  return `${GREENHOUSE_ANCHOR_PREFIX}:${roomId}:${row}:${column}`;
}

export function greenhouseInitialAnchors(): readonly GreenhouseAnchorSnapshot[] {
  const anchors: GreenhouseAnchorSnapshot[] = [];
  for (let row = 0; row < GREENHOUSE_INITIAL_ROWS; row += 1) {
    for (let column = 0; column < GREENHOUSE_INITIAL_COLUMNS; column += 1) {
      anchors.push({
        anchorId: greenhouseAnchorId(GREENHOUSE_MAIN_ROOM, row, column),
        roomId: GREENHOUSE_MAIN_ROOM,
        row,
        column,
        x: GREENHOUSE_ROOM_WIDTH * ((column + 1) / (GREENHOUSE_INITIAL_COLUMNS + 1)),
        y: GREENHOUSE_ROOM_HEIGHT * ((row + 1) / (GREENHOUSE_INITIAL_ROWS + 1)),
        active: true,
        placed: false,
        plant: null
      });
    }
  }
  return Object.freeze(anchors);
}

export function greenhouseWaterGallons(tenths: number): number {
  if (!Number.isSafeInteger(tenths) || tenths < 0) throw new Error("Water must be non-negative tenths");
  return tenths / 10;
}
