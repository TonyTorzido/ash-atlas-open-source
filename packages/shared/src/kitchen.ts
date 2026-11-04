import type { ResourceType } from "./collectibles.js";
import { DEFAULT_INTERACTION_RADIUS_M } from "./gameplayArea.js";
import { INVENTORY_CATALOG } from "./inventoryCatalog.js";
import {
  BREAKDOWN_MAX_BATCH_SIZE,
  BREAKDOWN_MIN_BATCH_SIZE,
  materialBreakdown,
  type CategoryRequirement,
  type MaterialGrade
} from "./materialGrades.js";
import {
  UNIVERSAL_FOOD_ITEMS,
  UNIVERSAL_FOOD_ITEM_IDS,
  type UniversalFoodItemId
} from "./universalFood.js";

/** A Kitchen is an outdoor production station owned by one Manor. */
export const KITCHEN_MAX_MANOR_DISTANCE_M = 650;
export const KITCHEN_INTERACTION_RADIUS_M = DEFAULT_INTERACTION_RADIUS_M;
export const KITCHEN_PROCESS_DURATION_MS = 5_000;
export const KITCHEN_BUILD_DURATION_MS = 30_000;
export const KITCHEN_MIN_BATCH_SIZE = 10;
export const KITCHEN_MAX_BATCH_SIZE = 50;
export const KITCHEN_INPUT_PER_OUTPUT = 10;
export const KITCHEN_OUTPUT_PER_BATCH = 1;
export const KITCHEN_QUEUE_CAPACITY = 5;
export const KITCHEN_BUILD_COST = Object.freeze({ wood: 25, stone: 10 });
export const KITCHEN_SNAPSHOT_RADIUS_M = 50_000;

/** Historical jobs may finish, but these inputs cannot start new work. */
export const LEGACY_KITCHEN_RECIPE_IDS = [
  "deer_meat",
  "wolf_meat",
  "hog_meat",
  "bear_meat",
  "alligator_meat",
  "wild_meat",
  "squid_meat"
] as const;
/** Rendering fats to Crude Oil (breakdown, Oil Worker XP). */
export const KITCHEN_RENDER_RECIPE_IDS = ["animal_fat", "blubber"] as const;
export const KITCHEN_RECIPE_IDS = [
  "freshwater_fish",
  ...UNIVERSAL_FOOD_ITEM_IDS,
  ...KITCHEN_RENDER_RECIPE_IDS
] as const;
export type KitchenRecipeId = (typeof KITCHEN_RECIPE_IDS)[number];
export const KITCHEN_INPUT_ITEM_IDS = KITCHEN_RECIPE_IDS;
export const KITCHEN_JOB_RECIPE_IDS = [...KITCHEN_RECIPE_IDS, ...LEGACY_KITCHEN_RECIPE_IDS] as const;
export type KitchenJobRecipeId = (typeof KITCHEN_JOB_RECIPE_IDS)[number];

export const KITCHEN_RECIPE_CATEGORIES = [
  { id: "raw", label: "Raw Ingredients" },
  { id: "simple", label: "Simple" },
  { id: "intermediate", label: "Intermediate" },
  { id: "advanced", label: "Advanced" },
  { id: "breakdown", label: "Breakdown" }
] as const;
export type KitchenRecipeCategory = (typeof KITCHEN_RECIPE_CATEGORIES)[number]["id"];

export function kitchenRecipeCategory(recipeId: KitchenRecipeId): KitchenRecipeCategory {
  if ((KITCHEN_RENDER_RECIPE_IDS as readonly string[]).includes(recipeId)) return "breakdown";
  if (recipeId === "field_ration" || recipeId === "small_catch") return "simple";
  if (recipeId === "hearty_ration") return "intermediate";
  if (recipeId === "elemental_ration" || recipeId === "xoral_essence" ||
      recipeId === "scorching_bird_meat" || recipeId === "zappy_bird_meat" ||
      recipeId === "freezing_bird_meat") return "advanced";
  return "raw";
}

export type KitchenRecipeDefinition = Readonly<{
  recipeId: KitchenRecipeId;
  displayName: string;
  inputItemId: KitchenRecipeId;
  inputDisplayName: string;
  outputItemId: "simple_food" | "crude_oil";
  outputDisplayName: string;
  inputPerOutput: number;
  outputPerBatch: number;
  minimumQuantity: number;
  maximumQuantity: number;
  durationMs: number;
  breakdownGrade?: MaterialGrade;
}>;

const renderRecipe = (recipeId: (typeof KITCHEN_RENDER_RECIPE_IDS)[number]): KitchenRecipeDefinition => {
  const breakdown = materialBreakdown(recipeId)!;
  const inputDisplayName = INVENTORY_CATALOG[recipeId]!.displayName;
  return Object.freeze({
    recipeId,
    displayName: `Render ${inputDisplayName}`,
    inputItemId: recipeId,
    inputDisplayName,
    outputItemId: "crude_oil",
    outputDisplayName: "Crude Oil",
    inputPerOutput: 1,
    outputPerBatch: breakdown.outputPerInput,
    minimumQuantity: BREAKDOWN_MIN_BATCH_SIZE,
    maximumQuantity: BREAKDOWN_MAX_BATCH_SIZE,
    durationMs: KITCHEN_PROCESS_DURATION_MS,
    breakdownGrade: breakdown.grade
  });
};

const recipe = (
  recipeId: KitchenRecipeId,
  inputDisplayName: string
): KitchenRecipeDefinition => Object.freeze({
  recipeId,
  displayName: "Cook Simple Food",
  inputItemId: recipeId,
  inputDisplayName,
  outputItemId: "simple_food",
  outputDisplayName: "Simple Food",
  inputPerOutput: KITCHEN_INPUT_PER_OUTPUT,
  outputPerBatch: KITCHEN_OUTPUT_PER_BATCH,
  minimumQuantity: KITCHEN_MIN_BATCH_SIZE,
  maximumQuantity: KITCHEN_MAX_BATCH_SIZE,
  durationMs: KITCHEN_PROCESS_DURATION_MS
});

const universalRecipe = (recipeId: UniversalFoodItemId): KitchenRecipeDefinition => {
  const food = UNIVERSAL_FOOD_ITEMS[recipeId];
  return Object.freeze({
    recipeId,
    displayName: "Cook Simple Food",
    inputItemId: recipeId,
    inputDisplayName: food.displayName,
    outputItemId: "simple_food",
    outputDisplayName: "Simple Food",
    inputPerOutput: 1,
    outputPerBatch: food.kitchenYield,
    minimumQuantity: 1,
    maximumQuantity: KITCHEN_MAX_BATCH_SIZE,
    durationMs: KITCHEN_PROCESS_DURATION_MS
  });
};

export const KITCHEN_RECIPES: Readonly<Record<KitchenRecipeId, KitchenRecipeDefinition>> =
  Object.freeze({
    frog_legs: universalRecipe("frog_legs"),
    frost_frog_legs: universalRecipe("frost_frog_legs"),
    poison_frog_legs: universalRecipe("poison_frog_legs"),
    desert_toad_legs: universalRecipe("desert_toad_legs"),
    crab_meat: universalRecipe("crab_meat"),
    ice_crab_meat: universalRecipe("ice_crab_meat"),
    sand_crab_meat: universalRecipe("sand_crab_meat"),
    mangrove_crab_meat: universalRecipe("mangrove_crab_meat"),
    small_catch: universalRecipe("small_catch"),
    jellyfish_jelly: universalRecipe("jellyfish_jelly"),
    crawler_flesh: universalRecipe("crawler_flesh"),
    squid_cut: universalRecipe("squid_cut"),
    wolf_cut: universalRecipe("wolf_cut"),
    frost_wolf_cut: universalRecipe("frost_wolf_cut"),
    dune_wolf_cut: universalRecipe("dune_wolf_cut"),
    jungle_wolf_cut: universalRecipe("jungle_wolf_cut"),
    bog_wolf_cut: universalRecipe("bog_wolf_cut"),
    deer_cut: universalRecipe("deer_cut"),
    frost_deer_cut: universalRecipe("frost_deer_cut"),
    jungle_deer_cut: universalRecipe("jungle_deer_cut"),
    marsh_deer_cut: universalRecipe("marsh_deer_cut"),
    sand_deer_cut: universalRecipe("sand_deer_cut"),
    hog_cut: universalRecipe("hog_cut"),
    woolly_hog_cut: universalRecipe("woolly_hog_cut"),
    warthog_cut: universalRecipe("warthog_cut"),
    jungle_hog_cut: universalRecipe("jungle_hog_cut"),
    mud_hog_cut: universalRecipe("mud_hog_cut"),
    javelina_cut: universalRecipe("javelina_cut"),
    alligator_tail: universalRecipe("alligator_tail"),
    caiman_tail: universalRecipe("caiman_tail"),
    crocodile_tail: universalRecipe("crocodile_tail"),
    bear_cut: universalRecipe("bear_cut"),
    snow_bear_cut: universalRecipe("snow_bear_cut"),
    black_bear_cut: universalRecipe("black_bear_cut"),
    sun_bear_cut: universalRecipe("sun_bear_cut"),
    jungle_tapir_cut: universalRecipe("jungle_tapir_cut"),
    jaguar_cut: universalRecipe("jaguar_cut"),
    mandrill_cut: universalRecipe("mandrill_cut"),
    capercaillie_meat: universalRecipe("capercaillie_meat"),
    elk_cut: universalRecipe("elk_cut"),
    red_squirrel_cut: universalRecipe("red_squirrel_cut"),
    badger_cut: universalRecipe("badger_cut"),
    grey_squirrel_cut: universalRecipe("grey_squirrel_cut"),
    stag_beetle_cut: universalRecipe("stag_beetle_cut"),
    great_grey_owl_meat: universalRecipe("great_grey_owl_meat"),
    flying_squirrel_cut: universalRecipe("flying_squirrel_cut"),
    plains_bison_cut: universalRecipe("plains_bison_cut"),
    prairie_dog_cut: universalRecipe("prairie_dog_cut"),
    burrowing_owl_meat: universalRecipe("burrowing_owl_meat"),
    giraffe_cut: universalRecipe("giraffe_cut"),
    lioness_cut: universalRecipe("lioness_cut"),
    spotted_hyena_cut: universalRecipe("spotted_hyena_cut"),
    sitatunga_cut: universalRecipe("sitatunga_cut"),
    emperor_dragonfly_cut: universalRecipe("emperor_dragonfly_cut"),
    mountain_ibex_cut: universalRecipe("mountain_ibex_cut"),
    wild_yak_cut: universalRecipe("wild_yak_cut"),
    alpine_marmot_cut: universalRecipe("alpine_marmot_cut"),
    wild_scrub_goat_cut: universalRecipe("wild_scrub_goat_cut"),
    crested_porcupine_cut: universalRecipe("crested_porcupine_cut"),
    spur_thighed_tortoise_cut: universalRecipe("spur_thighed_tortoise_cut"),
    dromedary_cut: universalRecipe("dromedary_cut"),
    fennec_fox_cut: universalRecipe("fennec_fox_cut"),
    sidewinder_cut: universalRecipe("sidewinder_cut"),
    field_hare_cut: universalRecipe("field_hare_cut"),
    arctic_hare_cut: universalRecipe("arctic_hare_cut"),
    capybara_cut: universalRecipe("capybara_cut"),
    armadillo_cut: universalRecipe("armadillo_cut"),
    red_fox_cut: universalRecipe("red_fox_cut"),
    wolverine_cut: universalRecipe("wolverine_cut"),
    ostrich_cut: universalRecipe("ostrich_cut"),
    golden_eagle_cut: universalRecipe("golden_eagle_cut"),
    musk_ox_cut: universalRecipe("musk_ox_cut"),
    seal_cut: universalRecipe("seal_cut"),
    desert_lion_cut: universalRecipe("desert_lion_cut"),
    saiga_cut: universalRecipe("saiga_cut"),
    wild_horse_cut: universalRecipe("wild_horse_cut"),
    steppe_marmot_cut: universalRecipe("steppe_marmot_cut"),
    lemming_cut: universalRecipe("lemming_cut"),
    snow_goose_meat: universalRecipe("snow_goose_meat"),
    mammoth_cut: universalRecipe("mammoth_cut"),
    dire_wolf_cut: universalRecipe("dire_wolf_cut"),
    drake_cut: universalRecipe("drake_cut"),
    dragon_cut: universalRecipe("dragon_cut"),
    grub_meat: universalRecipe("grub_meat"),
    emperor_penguin_meat: universalRecipe("emperor_penguin_meat"),
    peary_caribou_cut: universalRecipe("peary_caribou_cut"),
    ice_worm_cut: universalRecipe("ice_worm_cut"),
    sea_otter_cut: universalRecipe("sea_otter_cut"),
    herring_gull_meat: universalRecipe("herring_gull_meat"),
    spiny_lobster_tail: universalRecipe("spiny_lobster_tail"),
    hammerhead_shark_steak: universalRecipe("hammerhead_shark_steak"),
    manta_ray_wing: universalRecipe("manta_ray_wing"),
    humpback_whale_cut: universalRecipe("humpback_whale_cut"),
    muskellunge_fillet: universalRecipe("muskellunge_fillet"),
    mute_swan_meat: universalRecipe("mute_swan_meat"),
    pike_fillet: universalRecipe("pike_fillet"),
    snapping_turtle_cut: universalRecipe("snapping_turtle_cut"),
    beaver_cut: universalRecipe("beaver_cut"),
    otter_cut: universalRecipe("otter_cut"),
    salmon_fillet: universalRecipe("salmon_fillet"),
    elemental_ration: universalRecipe("elemental_ration"),
    scorching_bird_meat: universalRecipe("scorching_bird_meat"),
    zappy_bird_meat: universalRecipe("zappy_bird_meat"),
    freezing_bird_meat: universalRecipe("freezing_bird_meat"),
    field_ration: universalRecipe("field_ration"),
    hearty_ration: universalRecipe("hearty_ration"),
    xoral_essence: universalRecipe("xoral_essence"),
    freshwater_fish: recipe("freshwater_fish", "Freshwater Fish"),
    animal_fat: renderRecipe("animal_fat"),
    blubber: renderRecipe("blubber")
  });

/**
 * "Cook any Meat / Fish": raw cuts whose recipe takes one item per batch. A request expands into
 * one job per concrete item through its per-item recipe, lowest grade first.
 */
export const KITCHEN_COOK_ANY_CATEGORY: CategoryRequirement = Object.freeze({
  groups: ["meat", "fish"] as const,
  label: "any Meat / Fish",
  onlyItemIds: Object.freeze(KITCHEN_RECIPE_IDS.filter((recipeId) => {
    const selected = KITCHEN_RECIPES[recipeId];
    return kitchenRecipeCategory(recipeId) === "raw" && selected.outputItemId === "simple_food" &&
      selected.inputPerOutput === 1;
  }))
});
/** START_KITCHEN_BATCH recipe id for the category request ("Cook any Meat / Fish"). */
export const KITCHEN_COOK_ANY_RECIPE_ID = "cook_any" as const;
export const KITCHEN_COOK_ANY_MAX_QUANTITY = KITCHEN_MAX_BATCH_SIZE * KITCHEN_QUEUE_CAPACITY;

export type KitchenWorldSnapshot = Readonly<{
  kitchenId: string;
  manorId: string;
  ownerPlayerId: string;
  ownerUsername: string;
  regionCode: string;
  lat: number;
  lon: number;
  builtAt: string;
  placementRevision: number;
}>;

export type KitchenBuildSnapshot = Readonly<{
  buildId: string;
  position: Readonly<{ lat: number; lon: number }>;
  startedAt: number;
  completesAt: number;
  durationMs: number;
}>;

export type KitchenJobSnapshot = Readonly<{
  jobId: string;
  recipeId: KitchenJobRecipeId;
  inputItemId: ResourceType;
  outputItemId: "simple_food" | "crude_oil";
  outputDisplayName: string;
  requestedInputQuantity: number;
  outputQuantity: number;
  collectedQuantity: number;
  readyQuantity: number;
  startedAt: string;
  completesAt: string;
  productionFinished: boolean;
}>;

export type KitchenStateSnapshot = Readonly<{
  kitchen: KitchenWorldSnapshot;
  jobs: readonly KitchenJobSnapshot[];
  queueCapacity: number;
  occupiedSlots: number;
  serverTime: number;
}>;

export function requireKitchenRecipe(recipeId: string): KitchenRecipeDefinition {
  const selected = KITCHEN_RECIPES[recipeId as KitchenRecipeId];
  if (!selected || selected.recipeId !== recipeId) {
    throw new Error(`Unknown Kitchen recipe: ${recipeId}`);
  }
  return selected;
}

export function kitchenOutputQuantity(recipeId: KitchenRecipeId, inputQuantity: number): number {
  const selected = requireKitchenRecipe(recipeId);
  if (
    !Number.isSafeInteger(inputQuantity) ||
    inputQuantity < selected.minimumQuantity ||
    inputQuantity > selected.maximumQuantity ||
    inputQuantity % selected.inputPerOutput !== 0
  ) {
    throw new Error(
      `Kitchen quantity must be a multiple of ${selected.inputPerOutput} between ${selected.minimumQuantity} and ${selected.maximumQuantity}`
    );
  }
  return (inputQuantity / selected.inputPerOutput) * selected.outputPerBatch;
}
