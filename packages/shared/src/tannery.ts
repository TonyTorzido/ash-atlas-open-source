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

export const TANNERY_MAX_MANOR_DISTANCE_M = 650;
export const TANNERY_INTERACTION_RADIUS_M = DEFAULT_INTERACTION_RADIUS_M;
export const TANNERY_PROCESS_DURATION_MS = 5_000;
export const TANNERY_BUILD_DURATION_MS = 30_000;
export const TANNERY_MIN_BATCH_SIZE = 1;
export const TANNERY_MAX_BATCH_SIZE = 25;
/** Maximum output of the largest supported rare-hide batch (25 Bear Hides). */
export const TANNERY_MAX_OUTPUT_QUANTITY = 30_000;
export const TANNERY_QUEUE_CAPACITY = 5;
export const TANNERY_BUILD_COST = Object.freeze({ wood: 25, stone: 10 });
export const TANNERY_SNAPSHOT_RADIUS_M = 50_000;

export const TANNERY_RARE_HIDE_IDS = [
  "deer_hide",
  "hog_hide",
  "wolf_pelt",
  "bear_hide",
  "alligator_hide"
] as const;
const TANNERY_BREAKDOWNS = stationBreakdowns("tannery");
/** Rare-hide tanning plus one breakdown recipe per graded material (recipe id = input item id). */
export const TANNERY_RECIPE_IDS: readonly [string, ...string[]] = [
  ...TANNERY_RARE_HIDE_IDS,
  ...TANNERY_BREAKDOWNS.map((entry) => entry.inputItemId)
];
export type TanneryRecipeId = (typeof TANNERY_RARE_HIDE_IDS)[number] | ResourceType;
export const TANNERY_OUTPUT_ITEM_IDS: readonly [string, ...string[]] = [
  "leather",
  ...new Set(TANNERY_BREAKDOWNS.map((entry) => entry.outputItemId).filter((id) => id !== "leather"))
];

export type TanneryRecipeDefinition = Readonly<{
  recipeId: TanneryRecipeId;
  displayName: string;
  inputItemId: ResourceType;
  inputDisplayName: string;
  outputItemId: ResourceType;
  outputDisplayName: string;
  outputPerInput: number;
  minimumQuantity: number;
  maximumQuantity: number;
  durationMs: number;
  /** Set on breakdown recipes: the input's grade (G4+ needs the high-grade confirmation). */
  breakdownGrade?: MaterialGrade;
}>;

function recipe(
  recipeId: (typeof TANNERY_RARE_HIDE_IDS)[number],
  inputDisplayName: string,
  outputPerInput: number
): TanneryRecipeDefinition {
  return Object.freeze({
    recipeId,
    displayName: `Tan ${inputDisplayName}`,
    inputItemId: recipeId,
    inputDisplayName,
    outputItemId: "leather",
    outputDisplayName: "Leather",
    outputPerInput,
    minimumQuantity: TANNERY_MIN_BATCH_SIZE,
    maximumQuantity: TANNERY_MAX_BATCH_SIZE,
    durationMs: TANNERY_PROCESS_DURATION_MS
  });
}

export const TANNERY_RECIPES: Readonly<Record<string, TanneryRecipeDefinition>> =
  Object.freeze({
    ...Object.fromEntries(TANNERY_BREAKDOWNS.map((entry) => {
      const inputDisplayName = INVENTORY_CATALOG[entry.inputItemId]!.displayName;
      return [entry.inputItemId, Object.freeze({
        recipeId: entry.inputItemId,
        displayName: `Break down ${inputDisplayName}`,
        inputItemId: entry.inputItemId,
        inputDisplayName,
        outputItemId: entry.outputItemId,
        outputDisplayName: INVENTORY_CATALOG[entry.outputItemId]!.displayName,
        outputPerInput: entry.outputPerInput,
        minimumQuantity: BREAKDOWN_MIN_BATCH_SIZE,
        maximumQuantity: BREAKDOWN_MAX_BATCH_SIZE,
        durationMs: BREAKDOWN_DURATION_MS,
        breakdownGrade: entry.grade
      } satisfies TanneryRecipeDefinition)];
    })),
    // Rare hides roll once per 100,000 kills. These payouts are scaled to the
    // existing species Leather rewards so a jackpot is substantial without
    // becoming a material share of ordinary Leather production.
    deer_hide: recipe("deer_hide", "Deer Hide", 250),
    hog_hide: recipe("hog_hide", "Hog Hide", 400),
    wolf_pelt: recipe("wolf_pelt", "Wolf Pelt", 800),
    bear_hide: recipe("bear_hide", "Bear Hide", 1_200),
    alligator_hide: recipe("alligator_hide", "Alligator Hide", 1_000)
  });

export type TanneryWorldSnapshot = Readonly<{
  tanneryId: string;
  manorId: string;
  ownerPlayerId: string;
  ownerUsername: string;
  regionCode: string;
  lat: number;
  lon: number;
  builtAt: string;
  placementRevision: number;
}>;

export type TanneryBuildSnapshot = Readonly<{
  buildId: string;
  position: Readonly<{ lat: number; lon: number }>;
  startedAt: number;
  completesAt: number;
  durationMs: number;
}>;

export type TanneryJobSnapshot = Readonly<{
  jobId: string;
  recipeId: TanneryRecipeId;
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

export type TanneryStateSnapshot = Readonly<{
  tannery: TanneryWorldSnapshot;
  jobs: readonly TanneryJobSnapshot[];
  queueCapacity: number;
  occupiedSlots: number;
  serverTime: number;
}>;

export function requireTanneryRecipe(recipeId: string): TanneryRecipeDefinition {
  const result = Object.hasOwn(TANNERY_RECIPES, recipeId) ? TANNERY_RECIPES[recipeId] : undefined;
  if (!result || result.recipeId !== recipeId) {
    throw new Error(`Unknown Tannery recipe: ${recipeId}`);
  }
  return result;
}

export function tanneryOutputQuantity(recipeId: TanneryRecipeId, inputQuantity: number): number {
  const selected = requireTanneryRecipe(recipeId);
  const quantity = Math.trunc(inputQuantity);
  if (quantity < selected.minimumQuantity || quantity > selected.maximumQuantity) {
    throw new Error(
      `Tannery quantity must be between ${selected.minimumQuantity} and ${selected.maximumQuantity}`
    );
  }
  return quantity * selected.outputPerInput;
}
