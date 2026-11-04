import type { ResourceType } from "./collectibles.js";
import { DEFAULT_INTERACTION_RADIUS_M } from "./gameplayArea.js";
import { INVENTORY_CATALOG } from "./inventoryCatalog.js";
import {
  BREAKDOWN_DURATION_MS,
  BREAKDOWN_MAX_BATCH_SIZE,
  BREAKDOWN_MIN_BATCH_SIZE,
  stationBreakdowns,
  type MaterialGrade
} from "./materialGrades.js";

/** A Loom is an outdoor processing station owned by one Manor. */
export const LOOM_MAX_MANOR_DISTANCE_M = 650;
export const LOOM_INTERACTION_RADIUS_M = DEFAULT_INTERACTION_RADIUS_M;
export const LOOM_PROCESS_DURATION_MS = 5_000;
export const LOOM_BUILD_DURATION_MS = 30_000;
export const LOOM_MIN_BATCH_SIZE = 2;
export const LOOM_MAX_BATCH_SIZE = 24;
export const LOOM_QUEUE_CAPACITY = 5;
export const LOOM_BUILD_COST = Object.freeze({ wood: 25, stone: 10 });
export const LOOM_SNAPSHOT_RADIUS_M = 50_000;

const LOOM_BREAKDOWNS = stationBreakdowns("loom");
/** Weaving plus one breakdown recipe per graded material (recipe id = input item id). */
export const LOOM_RECIPE_IDS: readonly [string, ...string[]] = [
  "flax_fiber",
  ...LOOM_BREAKDOWNS.map((entry) => entry.inputItemId)
];
export type LoomRecipeId = "flax_fiber" | ResourceType;
export const LOOM_OUTPUT_ITEM_IDS: readonly [string, ...string[]] = [
  "cloth",
  ...new Set(LOOM_BREAKDOWNS.map((entry) => entry.outputItemId).filter((id) => id !== "cloth"))
];

export type LoomRecipeDefinition = Readonly<{
  recipeId: LoomRecipeId;
  displayName: string;
  inputItemId: ResourceType;
  inputDisplayName: string;
  outputItemId: ResourceType;
  outputDisplayName: string;
  /** Weaving: two fibers become one Cloth, so batches are submitted in pairs. */
  outputPerInput: number;
  /** Input quantity must be a multiple of this (2 for weaving, 1 for breakdown). */
  inputMultiple: number;
  minimumQuantity: number;
  maximumQuantity: number;
  durationMs: number;
  breakdownGrade?: MaterialGrade;
}>;

export const LOOM_RECIPES: Readonly<Record<string, LoomRecipeDefinition> & { flax_fiber: LoomRecipeDefinition }> =
  Object.freeze({
    flax_fiber: Object.freeze({
      recipeId: "flax_fiber",
      displayName: "Weave Cloth",
      inputItemId: "flax_fiber",
      inputDisplayName: "Flax Fiber",
      outputItemId: "cloth",
      outputDisplayName: "Cloth",
      outputPerInput: 0.5,
      inputMultiple: 2,
      minimumQuantity: LOOM_MIN_BATCH_SIZE,
      maximumQuantity: LOOM_MAX_BATCH_SIZE,
      durationMs: LOOM_PROCESS_DURATION_MS
    }),
    ...Object.fromEntries(LOOM_BREAKDOWNS.map((entry) => {
      const inputDisplayName = INVENTORY_CATALOG[entry.inputItemId]!.displayName;
      return [entry.inputItemId, Object.freeze({
        recipeId: entry.inputItemId,
        displayName: `Break down ${inputDisplayName}`,
        inputItemId: entry.inputItemId,
        inputDisplayName,
        outputItemId: entry.outputItemId,
        outputDisplayName: INVENTORY_CATALOG[entry.outputItemId]!.displayName,
        outputPerInput: entry.outputPerInput,
        inputMultiple: 1,
        minimumQuantity: BREAKDOWN_MIN_BATCH_SIZE,
        maximumQuantity: BREAKDOWN_MAX_BATCH_SIZE,
        durationMs: BREAKDOWN_DURATION_MS,
        breakdownGrade: entry.grade
      } satisfies LoomRecipeDefinition)];
    }))
  });

export type LoomWorldSnapshot = Readonly<{
  loomId: string;
  manorId: string;
  ownerPlayerId: string;
  ownerUsername: string;
  regionCode: string;
  lat: number;
  lon: number;
  builtAt: string;
  placementRevision: number;
}>;

export type LoomBuildSnapshot = Readonly<{
  buildId: string;
  position: Readonly<{ lat: number; lon: number }>;
  startedAt: number;
  completesAt: number;
  durationMs: number;
}>;

export type LoomJobSnapshot = Readonly<{
  jobId: string;
  recipeId: LoomRecipeId;
  inputItemId: ResourceType;
  outputItemId: ResourceType;
  outputDisplayName: string;
  requestedInputQuantity: number;
  outputQuantity: number;
  collectedQuantity: number;
  readyQuantity: number;
  startedAt: string;
  completesAt: string;
  productionFinished: boolean;
}>;

export type LoomStateSnapshot = Readonly<{
  loom: LoomWorldSnapshot;
  jobs: readonly LoomJobSnapshot[];
  queueCapacity: number;
  occupiedSlots: number;
  serverTime: number;
}>;

export function requireLoomRecipe(recipeId: string): LoomRecipeDefinition {
  const result = Object.hasOwn(LOOM_RECIPES, recipeId) ? LOOM_RECIPES[recipeId] : undefined;
  if (!result || result.recipeId !== recipeId) {
    throw new Error(`Unknown Loom recipe: ${recipeId}`);
  }
  return result;
}

export function loomOutputQuantity(recipeId: LoomRecipeId, inputQuantity: number): number {
  const selected = requireLoomRecipe(recipeId);
  if (
    !Number.isSafeInteger(inputQuantity)
    || inputQuantity < selected.minimumQuantity
    || inputQuantity > selected.maximumQuantity
    || inputQuantity % selected.inputMultiple !== 0
  ) {
    throw new Error(
      selected.inputMultiple === 2
        ? `Loom quantity must be an even number between ${selected.minimumQuantity} and ${selected.maximumQuantity}`
        : `Loom quantity must be between ${selected.minimumQuantity} and ${selected.maximumQuantity}`
    );
  }
  return inputQuantity * selected.outputPerInput;
}
