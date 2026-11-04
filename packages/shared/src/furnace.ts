import type { ResourceType } from "./collectibles.js";
import { DEFAULT_INTERACTION_RADIUS_M } from "./gameplayArea.js";
import {
  BREAKDOWN_MAX_BATCH_SIZE,
  CATEGORY,
  scaleCategoryInputs,
  stationBreakdowns,
  type CategoryRecipeInput
} from "./materialGrades.js";

export const FURNACE_MAX_MANOR_DISTANCE_M = 600;
export const FURNACE_INTERACTION_RADIUS_M = DEFAULT_INTERACTION_RADIUS_M;
export const FURNACE_BAR_DURATION_MS = 27 * 60 * 1_000;
export const FURNACE_BUILD_DURATION_MS = 27_000;
export const FURNACE_MIN_BATCH_SIZE = 1;
export const FURNACE_MAX_BATCH_SIZE = 5;
export const FURNACE_QUEUE_CAPACITY = 5;
export const FURNACE_IRON_ORE_PER_BAR = 6;
export const FURNACE_WOOD_PER_BAR = 90;
export const FURNACE_SLAG_RECOVERY_MIN_RANK = 2;
export const FURNACE_SLAG_RECOVERY_MAX_QUANTITY = 1;
/** Every special metal bar takes this long per bar (classic-style slow smelt). */
export const FURNACE_METAL_BAR_DURATION_MS = 54 * 60 * 1_000;
export const FURNACE_BUILD_COST = Object.freeze({
  stone: 22,
  wood: 90,
  coal: 12
});
export const FURNACE_SNAPSHOT_RADIUS_M = 50_000;

/**
 * Glimmer Oil (internal item id `refined_oil`) is refined instantly at a
 * Furnace from 1 Crude Oil + 1 Glimmer per unit. It never occupies the
 * smelting queue; the Glimmer debit and the item exchange commit together.
 */
export const FURNACE_GLIMMER_OIL_ITEM_ID = "refined_oil" as const;
export const FURNACE_GLIMMER_OIL_CRUDE_OIL_PER_UNIT = 1;
export const FURNACE_GLIMMER_OIL_GLIMMER_PER_UNIT = 1;
export const FURNACE_GLIMMER_OIL_MAX_QUANTITY = 100;

export const FURNACE_METAL_BAR_RECIPE_IDS = [
  "revenant_bar",
  "expel_bar",
  "mirage_bar",
  "gale_bar",
  "fleet_bar",
  "venomsteel_bar",
  "whetted_bar",
  "lightning_bar",
  "vengeance_bar",
  "gloom_bar",
  "fire_bar",
  "ice_bar",
  "vital_bar",
  "skyrise_bar"
] as const;
export type FurnaceMetalBarRecipeId = (typeof FURNACE_METAL_BAR_RECIPE_IDS)[number];

/**
 * Cores are no longer smelted. The ids stay so jobs queued before the metal
 * framework still settle; they cannot be started (see `retired`).
 */
export const FURNACE_LEGACY_CORE_RECIPE_IDS = [
  "venomsteel_core",
  "fire_core",
  "lightning_core",
  "ice_core"
] as const;

export const FURNACE_RECIPE_IDS = [
  "iron_bar",
  ...FURNACE_METAL_BAR_RECIPE_IDS,
  ...FURNACE_LEGACY_CORE_RECIPE_IDS,
  "slag_recovery"
] as const;
export type FurnaceRecipeId = (typeof FURNACE_RECIPE_IDS)[number];
export type FurnaceCompletionMode = "sequential" | "batch";

export type FurnaceRecipeInput = Readonly<{
  itemId: ResourceType;
  displayName: string;
  quantity: number;
}>;

export type FurnaceRecipeDefinition = Readonly<{
  recipeId: FurnaceRecipeId;
  displayName: string;
  outputItemId: ResourceType;
  outputDisplayName: string;
  minimumQuantity: number;
  maximumQuantity: number;
  durationMs: number;
  completionMode: FurnaceCompletionMode;
  /** Metallurgy profession rank required to start the recipe (0 = none). */
  minimumMetallurgyRank: number;
  /** True when the recipe can no longer be started (legacy cores). */
  retired?: boolean;
  inputs: readonly FurnaceRecipeInput[];
  /** Category inputs ("10 any Bones"), picked lowest grade first (materialGrades.ts). */
  categoryInputs?: readonly CategoryRecipeInput[];
}>;

function metalBar(
  metal: "venomsteel" | "fire" | "lightning" | "ice" | "revenant" | "expel" | "mirage" | "gale" |
    "fleet" | "whetted" | "vengeance" | "gloom" | "vital" | "skyrise",
  displayName: string,
  rank: 1 | 3 | 5,
  inputs: readonly FurnaceRecipeInput[],
  categoryInputs?: readonly CategoryRecipeInput[]
): FurnaceRecipeDefinition {
  return Object.freeze({
    recipeId: `${metal}_bar` as FurnaceMetalBarRecipeId,
    displayName: `Forge ${indefiniteArticle(displayName)} ${displayName} Bar`,
    outputItemId: `${metal}_bar` as ResourceType,
    outputDisplayName: `${displayName} Bar`,
    minimumQuantity: 1,
    maximumQuantity: FURNACE_MAX_BATCH_SIZE,
    durationMs: FURNACE_METAL_BAR_DURATION_MS,
    completionMode: "sequential" as const,
    minimumMetallurgyRank: rank,
    inputs: Object.freeze(inputs.map((input) => Object.freeze({ ...input }))),
    ...(categoryInputs === undefined ? {} : { categoryInputs: Object.freeze(categoryInputs) })
  });
}

function legacyCore(
  metal: "venomsteel" | "fire" | "lightning" | "ice",
  displayName: string
): FurnaceRecipeDefinition {
  return Object.freeze({
    recipeId: `${metal}_core` as FurnaceRecipeId,
    displayName: `Forge ${indefiniteArticle(displayName)} ${displayName} Core`,
    outputItemId: `${metal}_core` as ResourceType,
    outputDisplayName: `${displayName} Core`,
    minimumQuantity: 1,
    maximumQuantity: metal === "venomsteel" ? FURNACE_MAX_BATCH_SIZE : 1,
    durationMs: FURNACE_METAL_BAR_DURATION_MS,
    completionMode: "batch" as const,
    minimumMetallurgyRank: 0,
    retired: true,
    inputs: Object.freeze([
      { itemId: `${metal}_bar` as ResourceType, displayName: `${displayName} Bar`, quantity: 5 }
    ])
  });
}

const IRON_BAR = "iron_bar" as const;
const IRON_BAR_NAME = "Iron Bar";

/** Breakdown at the Furnace is instant (like Glimmer Oil) and never uses the smelt queue. */
export const FURNACE_BREAKDOWNS = stationBreakdowns("furnace");
export const FURNACE_BREAKDOWN_INPUT_IDS: readonly [string, ...string[]] =
  FURNACE_BREAKDOWNS.map((entry) => entry.inputItemId) as unknown as [string, ...string[]];
export const FURNACE_BREAKDOWN_MAX_QUANTITY = BREAKDOWN_MAX_BATCH_SIZE;

export const FURNACE_RECIPES: Readonly<Record<FurnaceRecipeId, FurnaceRecipeDefinition>> =
  Object.freeze({
    iron_bar: Object.freeze({
      recipeId: "iron_bar",
      displayName: "Smelt Iron Bars",
      outputItemId: "iron_bar",
      outputDisplayName: "Iron Bar",
      minimumQuantity: 1,
      maximumQuantity: FURNACE_MAX_BATCH_SIZE,
      durationMs: FURNACE_BAR_DURATION_MS,
      completionMode: "sequential",
      minimumMetallurgyRank: 0,
      inputs: Object.freeze([
        { itemId: "iron" as const, displayName: "Iron Ore", quantity: FURNACE_IRON_ORE_PER_BAR },
        { itemId: "wood" as const, displayName: "Wood", quantity: FURNACE_WOOD_PER_BAR }
      ])
    }),
    revenant_bar: metalBar("revenant", "Revenant", 1, [
      { itemId: "lichen", displayName: "Lichen", quantity: 1 },
      { itemId: "umbral_essence", displayName: "Umbral Essence", quantity: 4 },
      { itemId: IRON_BAR, displayName: IRON_BAR_NAME, quantity: 4 }
    ], [{ category: CATEGORY.anyBones, quantity: 9 }]),
    expel_bar: metalBar("expel", "Expel", 1, [
      { itemId: "thistle", displayName: "Thistle", quantity: 2 },
      { itemId: "sulfur", displayName: "Sulfur", quantity: 4 },
      { itemId: IRON_BAR, displayName: IRON_BAR_NAME, quantity: 4 },
      { itemId: "atlas_shrine_shard", displayName: "Atlas Shrine Shard", quantity: 2 }
    ]),
    mirage_bar: metalBar("mirage", "Mirage", 1, [
      { itemId: IRON_BAR, displayName: IRON_BAR_NAME, quantity: 4 },
      { itemId: "gearwork_essence", displayName: "Gearwork Essence", quantity: 120 },
      { itemId: "atlas_shrine_shard", displayName: "Atlas Shrine Shard", quantity: 6 },
      { itemId: "crystal", displayName: "Crystal", quantity: 60 }
    ]),
    gale_bar: metalBar("gale", "Gale", 1, [
      { itemId: IRON_BAR, displayName: IRON_BAR_NAME, quantity: 6 },
      { itemId: "gale_splinter", displayName: "Gale Splinter", quantity: 120 },
      { itemId: "cloth", displayName: "Cloth", quantity: 8 }
    ]),
    fleet_bar: metalBar("fleet", "Fleet", 1, [
      { itemId: IRON_BAR, displayName: IRON_BAR_NAME, quantity: 4 },
      { itemId: "griffin_plume", displayName: "Griffin Plume", quantity: 30 },
      { itemId: "gale_splinter", displayName: "Gale Splinter", quantity: 60 },
      { itemId: "field_ration", displayName: "Field Ration", quantity: 3 }
    ]),
    venomsteel_bar: metalBar("venomsteel", "Venom", 3, [
      { itemId: "dusk_heart", displayName: "Dusk Heart", quantity: 1 },
      { itemId: FURNACE_GLIMMER_OIL_ITEM_ID, displayName: "Glimmer Oil", quantity: 9 },
      { itemId: IRON_BAR, displayName: IRON_BAR_NAME, quantity: 4 }
    ], [{ category: CATEGORY.anyVenomsG2, quantity: 1 }]),
    whetted_bar: metalBar("whetted", "Whetted", 3, [
      { itemId: FURNACE_GLIMMER_OIL_ITEM_ID, displayName: "Glimmer Oil", quantity: 22 },
      { itemId: "stone", displayName: "Stone", quantity: 24 },
      { itemId: IRON_BAR, displayName: IRON_BAR_NAME, quantity: 6 }
    ], [{ category: CATEGORY.anyScalesG2, quantity: 4 }]),
    lightning_bar: metalBar("lightning", "Storm", 3, [
      { itemId: "tempest_quill", displayName: "Tempest Quill", quantity: 1 },
      { itemId: "forge_spark", displayName: "Forge Spark", quantity: 135 },
      { itemId: IRON_BAR, displayName: IRON_BAR_NAME, quantity: 9 }
    ]),
    vengeance_bar: metalBar("vengeance", "Vengeance", 3, [
      { itemId: IRON_BAR, displayName: IRON_BAR_NAME, quantity: 4 },
      { itemId: "griffin_plume", displayName: "Griffin Plume", quantity: 44 },
      { itemId: "edict_seal", displayName: "Edict Seal", quantity: 230 }
    ]),
    gloom_bar: metalBar("gloom", "Gloom", 5, [
      { itemId: "bloom_petal", displayName: "Bloom Petal", quantity: 3 },
      { itemId: "umbral_essence", displayName: "Umbral Essence", quantity: 3 },
      { itemId: "flux_plant", displayName: "Flux Plant", quantity: 3 },
      { itemId: IRON_BAR, displayName: IRON_BAR_NAME, quantity: 4 }
    ]),
    fire_bar: metalBar("fire", "Ember", 5, [
      { itemId: "fire_feather", displayName: "Ember Feather", quantity: 1 },
      { itemId: "pearl", displayName: "Pearl", quantity: 3 },
      { itemId: "coal", displayName: "Coal", quantity: 24 },
      { itemId: IRON_BAR, displayName: IRON_BAR_NAME, quantity: 9 }
    ]),
    ice_bar: metalBar("ice", "Frost", 5, [
      { itemId: "ice_feather", displayName: "Frost Feather", quantity: 1 },
      { itemId: IRON_BAR, displayName: IRON_BAR_NAME, quantity: 9 }
    ], [{ category: CATEGORY.anyScales, quantity: 9 }, { category: CATEGORY.anyFish, quantity: 11 }]),
    vital_bar: metalBar("vital", "Vital", 5, [
      { itemId: IRON_BAR, displayName: IRON_BAR_NAME, quantity: 4 },
      { itemId: "griffin_plume", displayName: "Griffin Plume", quantity: 90 },
      { itemId: "mist_drop", displayName: "Mist Drop", quantity: 440 },
      { itemId: "giving_berry", displayName: "Giving Berry", quantity: 6 }
    ]),
    // Skyrise: Iron, 4 Skyrise Stones and 9 Zephyr (the Monastery token).
    skyrise_bar: metalBar("skyrise", "Skyrise", 5, [
      { itemId: IRON_BAR, displayName: IRON_BAR_NAME, quantity: 4 },
      { itemId: "skyrise_stone", displayName: "Skyrise Stone", quantity: 4 },
      { itemId: "zephyr", displayName: "Zephyr", quantity: 9 }
    ]),
    venomsteel_core: legacyCore("venomsteel", "Venom"),
    fire_core: legacyCore("fire", "Ember"),
    lightning_core: legacyCore("lightning", "Storm"),
    ice_core: legacyCore("ice", "Frost"),
    slag_recovery: Object.freeze({
      recipeId: "slag_recovery",
      displayName: "Recover Iron from Slag",
      outputItemId: "iron_bar",
      outputDisplayName: "Iron Bar",
      minimumQuantity: 1,
      maximumQuantity: FURNACE_SLAG_RECOVERY_MAX_QUANTITY,
      durationMs: 0,
      completionMode: "batch",
      minimumMetallurgyRank: 0,
      inputs: Object.freeze([
        { itemId: "slag" as const, displayName: "Slag", quantity: 5 }
      ])
    })
  });

/** Recipes a player can start now (legacy Core recipes are excluded). */
export function startableFurnaceRecipes(): readonly FurnaceRecipeDefinition[] {
  return Object.values(FURNACE_RECIPES).filter((recipe) => recipe.retired !== true);
}

function indefiniteArticle(value: string): "a" | "an" {
  return /^[aeiou]/i.test(value) ? "an" : "a";
}

export type FurnaceWorldSnapshot = Readonly<{
  furnaceId: string;
  manorId: string;
  ownerPlayerId: string;
  ownerUsername: string;
  regionCode: string;
  lat: number;
  lon: number;
  builtAt: string;
  placementRevision: number;
}>;

export type FurnaceBuildSnapshot = Readonly<{
  buildId: string;
  position: Readonly<{ lat: number; lon: number }>;
  startedAt: number;
  completesAt: number;
  durationMs: number;
}>;

export type FurnaceJobSnapshot = Readonly<{
  jobId: string;
  recipeId: FurnaceRecipeId;
  outputItemId: FurnaceRecipeDefinition["outputItemId"];
  outputDisplayName: string;
  requestedQuantity: number;
  completedQuantity: number;
  collectedQuantity: number;
  readyQuantity: number;
  startedAt: string;
  nextCompletesAt: string | null;
  productionFinished: boolean;
  readySuccessQuantity?: number;
  readyFailureQuantity?: number;
}>;

export type FurnaceStateSnapshot = Readonly<{
  furnace: FurnaceWorldSnapshot;
  jobs: readonly FurnaceJobSnapshot[];
  queueCapacity: number;
  occupiedSlots: number;
  serverTime: number;
  metallurgyRank?: number;
}>;

export function furnaceRecipe(quantity: number): Readonly<{
  ironOre: number;
  wood: number;
  durationMs: number;
}> {
  return {
    ironOre: quantity * FURNACE_IRON_ORE_PER_BAR,
    wood: quantity * FURNACE_WOOD_PER_BAR,
    durationMs: quantity * FURNACE_BAR_DURATION_MS
  };
}

export function completedFurnaceBars(
  startedAtMs: number,
  requestedQuantity: number,
  nowMs: number
): number {
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(nowMs)) return 0;
  return Math.min(
    Math.max(Math.trunc(requestedQuantity), 0),
    Math.max(0, Math.floor((nowMs - startedAtMs) / FURNACE_BAR_DURATION_MS))
  );
}

export function requireFurnaceRecipe(recipeId: string): FurnaceRecipeDefinition {
  const recipe = FURNACE_RECIPES[recipeId as FurnaceRecipeId];
  if (!recipe || recipe.recipeId !== recipeId) {
    throw new Error(`Unknown Furnace recipe: ${recipeId}`);
  }
  return recipe;
}

export function furnaceRecipeInputs(
  recipeId: FurnaceRecipeId,
  quantity: number,
  options?: Readonly<{ metallurgyRank?: number }>
): readonly FurnaceRecipeInput[] {
  const recipe = requireFurnaceRecipe(recipeId);
  const recoveryCost = recipeId === "slag_recovery"
    ? slagRecoveryCostForMetallurgyRank(options?.metallurgyRank ?? 0) ?? 5
    : null;
  return recipe.inputs.map((input) => ({
    ...input,
    quantity: (recoveryCost ?? input.quantity) * quantity
  }));
}

export function furnaceCategoryInputs(
  recipeId: FurnaceRecipeId,
  quantity: number
): readonly CategoryRecipeInput[] {
  return scaleCategoryInputs(requireFurnaceRecipe(recipeId).categoryInputs ?? [], quantity);
}

export function slagRecoveryCostForMetallurgyRank(rank: number): number | null {
  const safe = Math.max(0, Math.trunc(Number.isFinite(rank) ? rank : 0));
  return safe >= 8 ? 3 : safe >= 5 ? 4 : safe >= FURNACE_SLAG_RECOVERY_MIN_RANK ? 5 : null;
}

export function completedFurnaceOutput(
  recipeId: FurnaceRecipeId,
  startedAtMs: number,
  requestedQuantity: number,
  nowMs: number,
  /** Per-job duration (utility gear); the recipe duration when omitted. */
  durationOverrideMs?: number | null
): number {
  const recipe = requireFurnaceRecipe(recipeId);
  const durationMs = durationOverrideMs ?? recipe.durationMs;
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(nowMs)) return 0;
  const requested = Math.min(
    recipe.maximumQuantity,
    Math.max(recipe.minimumQuantity, Math.trunc(requestedQuantity))
  );
  if (recipe.completionMode === "batch") {
    return nowMs - startedAtMs >= durationMs ? requested : 0;
  }
  return Math.min(requested, Math.max(0, Math.floor((nowMs - startedAtMs) / durationMs)));
}
