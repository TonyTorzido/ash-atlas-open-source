import catalogJson from "./data/runtime-png-presentation.json" with { type: "json" };

import { z } from "zod";
import { MOB_DROP_ITEM_IDS } from "./mobDropItems.js";
import { UNIVERSAL_FOOD_ITEM_IDS } from "./universalFood.js";

const positiveFinite = z.number().finite().positive();
const finite = z.number().finite();
const anchor = z.number().finite().min(0).max(1);
const hitCenter = z.number().finite().min(-1).max(2);
const itemHitGeometryMode = z.enum(["locked", "custom"]);

export const RUNTIME_PNG_MASTER_SCALE_MIN = 0.25;
export const RUNTIME_PNG_MASTER_SCALE_MAX = 4;
export const RUNTIME_PNG_MASTER_SCALE_STEP = 0.01;

/**
 * Item artwork uses the same authored pixel space as the small world-drop
 * sprites. Keeping this baseline in the shared contract lets UI surfaces
 * scale the artwork without copying a second item-size setting.
 */
export const RUNTIME_PNG_ITEM_DEFAULT_HEIGHT_PX = 28;

/**
 * Inventory rows use the compact mobile-equivalent art frame on every
 * profile. This is UI chrome, not another authored item-size setting.
 */
export const RUNTIME_PNG_ITEM_INVENTORY_FRAME_PX = 34;

const masterScale = z.number().finite()
  .min(RUNTIME_PNG_MASTER_SCALE_MIN)
  .max(RUNTIME_PNG_MASTER_SCALE_MAX);

const worldObjectZoomPolicySchema = z.object({
  baseZoom: finite,
  zoomStrength: finite.min(0).max(2),
  minScale: positiveFinite.max(1),
  maxScale: positiveFinite.min(1).nullable()
});

export const WORLD_OBJECT_ZOOM_POLICY = Object.freeze(
  worldObjectZoomPolicySchema.parse(catalogJson.worldObjectZoomPolicy)
);

/**
 * Fixed catalog entries that are rendered as persistent world buildings or
 * facilities. Their renderer must use WORLD_OBJECT_ZOOM_POLICY; destination
 * markers and transient UI feedback intentionally remain outside this set.
 */
export const RUNTIME_PNG_WORLD_OBJECT_FIXED_KEYS = Object.freeze([
  "atlasShrine",
  "city",
  "cityStructures.city_house",
  "cityStructures.city_kennel",
  "cityStructures.cistern_warrens",
  "cityStructures.barracks",
  "cityStructures.armory",
  "cityStructures.demolition_factory",
  "cityStructures.siege_workshop",
  "cityStructures.powder_works",
  "cityStructures.goblin_market",
  "cityStructures.market",
  "cityStructures.mayor_house",
  "cityStructures.monument_forestry",
  "cityStructures.monument_hunting",
  "cityStructures.monument_mining",
  "cityStructures.oil_well",
  "cityStructures.salon",
  "cityStructures.warehouse",
  "furnace",
  "greenhouse",
  "kitchen",
  "manor",
  "loom",
  "tannery"
] as const);

const runtimePngWorldObjectFixedKeySet = new Set<string>(
  RUNTIME_PNG_WORLD_OBJECT_FIXED_KEYS
);

export function isRuntimePngWorldObjectFixedKey(key: string): boolean {
  return runtimePngWorldObjectFixedKeySet.has(key);
}

export const runtimePngInteractionGeometrySchema = z.discriminatedUnion("shape", [
  z.object({
    shape: z.literal("circle"),
    centerX: hitCenter,
    centerY: hitCenter,
    radiusPx: positiveFinite.max(512)
  }),
  z.object({
    shape: z.literal("rectangle"),
    centerX: hitCenter,
    centerY: hitCenter,
    width: positiveFinite.max(4),
    height: positiveFinite.max(4)
  })
]);

const spritePresentationSchema = z.object({
  baseHeightPx: positiveFinite,
  /** Optional inventory/menu height; absent entries retain the ground height. */
  inventoryHeightPx: positiveFinite.optional(),
  horizontalScale: positiveFinite.optional(),
  minHeightPx: positiveFinite,
  maxHeightPx: positiveFinite.nullable(),
  zoomStrength: finite.min(0).max(2),
  anchorX: anchor,
  anchorY: anchor,
  hitGeometry: runtimePngInteractionGeometrySchema,
  /** Item ground hit geometry defaults to the visual frame for legacy entries. */
  hitGeometryMode: itemHitGeometryMode.optional()
}).superRefine((value, context) => {
  if (value.minHeightPx > value.baseHeightPx) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["minHeightPx"], message: "Minimum height cannot exceed base height" });
  }
  if (value.maxHeightPx !== null && value.baseHeightPx > value.maxHeightPx) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["maxHeightPx"], message: "Maximum height cannot be below base height" });
  }
});

const fixedPresentationSchema = z.object({
  width: positiveFinite,
  height: positiveFinite,
  anchorX: anchor,
  anchorY: anchor,
  hitGeometry: runtimePngInteractionGeometrySchema
});

export const runtimePngPresentationCatalogSchema = z.object({
  schemaVersion: z.literal(4),
  revision: z.number().int().nonnegative(),
  masterScale,
  worldObjectZoomPolicy: worldObjectZoomPolicySchema,
  sprites: z.record(z.string(), spritePresentationSchema),
  fixed: z.record(z.string(), fixedPresentationSchema)
}).superRefine((catalog, context) => {
  for (const [key, presentation] of Object.entries(catalog.sprites)) {
    const expectedMin = presentation.baseHeightPx * catalog.worldObjectZoomPolicy.minScale;
    if (Math.abs(presentation.minHeightPx - expectedMin) > 1e-9) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["sprites", key, "minHeightPx"], message: "Minimum height must follow the world-object zoom policy" });
    }
    const maxScale = catalog.worldObjectZoomPolicy.maxScale;
    const maximumMatchesPolicy = maxScale === null
      ? presentation.maxHeightPx === null
      : presentation.maxHeightPx !== null &&
        Math.abs(presentation.maxHeightPx - presentation.baseHeightPx * maxScale) <= 1e-9;
    if (!maximumMatchesPolicy) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["sprites", key, "maxHeightPx"], message: "Maximum height must follow the world-object zoom policy" });
    }
    if (presentation.zoomStrength !== catalog.worldObjectZoomPolicy.zoomStrength) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["sprites", key, "zoomStrength"], message: "Zoom strength must follow the world-object zoom policy" });
    }
  }
});

export type RuntimeSpritePresentation = z.infer<typeof spritePresentationSchema>;
export type RuntimeFixedPngPresentation = z.infer<typeof fixedPresentationSchema>;
export type RuntimePngInteractionGeometry = z.infer<typeof runtimePngInteractionGeometrySchema>;
export type RuntimePngItemHitGeometryMode = z.infer<typeof itemHitGeometryMode>;
export type RuntimePngPresentationCatalog = z.infer<typeof runtimePngPresentationCatalogSchema>;
type RuntimePngPresentationCatalogWithKnownKeys = Omit<
  RuntimePngPresentationCatalog,
  "sprites" | "fixed"
> & {
  sprites: { [K in keyof typeof catalogJson.sprites]: RuntimeSpritePresentation };
  fixed: { [K in keyof typeof catalogJson.fixed]: RuntimeFixedPngPresentation };
};

export function parseRuntimePngPresentationCatalog(
  value: unknown
): RuntimePngPresentationCatalog {
  return runtimePngPresentationCatalogSchema.parse(value);
}

export const RUNTIME_PNG_PRESENTATION_CATALOG: RuntimePngPresentationCatalogWithKnownKeys =
  parseRuntimePngPresentationCatalog(catalogJson) as RuntimePngPresentationCatalogWithKnownKeys;

const RUNTIME_PNG_ITEM_ARTWORK_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  simple_food: "food",
  ashen_fish: "freshwater_fish",
  squid_meat: "generic",
  deer_meat: "generic",
  wolf_meat: "generic",
  hog_meat: "generic",
  bear_meat: "generic",
  alligator_meat: "generic",
  wild_meat: "generic",
  frog_legs: "food",
  frost_frog_legs: "food",
  poison_frog_legs: "food",
  desert_toad_legs: "food",
  crab_meat: "food",
  ice_crab_meat: "food",
  sand_crab_meat: "food",
  mangrove_crab_meat: "food",
  small_catch: "food",
  jellyfish_jelly: "food",
  crawler_flesh: "food",
  squid_cut: "food",
  wolf_cut: "food",
  frost_wolf_cut: "food",
  dune_wolf_cut: "food",
  jungle_wolf_cut: "food",
  bog_wolf_cut: "food",
  deer_cut: "food",
  frost_deer_cut: "food",
  jungle_deer_cut: "food",
  marsh_deer_cut: "food",
  sand_deer_cut: "food",
  hog_cut: "food",
  woolly_hog_cut: "food",
  warthog_cut: "food",
  jungle_hog_cut: "food",
  mud_hog_cut: "food",
  javelina_cut: "food",
  alligator_tail: "food",
  caiman_tail: "food",
  crocodile_tail: "food",
  bear_cut: "food",
  snow_bear_cut: "food",
  black_bear_cut: "food",
  sun_bear_cut: "food",
  jungle_tapir_cut: "food",
  jaguar_cut: "food",
  mandrill_cut: "food",
  capercaillie_meat: "food",
  elk_cut: "food",
  red_squirrel_cut: "food",
  badger_cut: "food",
  grey_squirrel_cut: "food",
  stag_beetle_cut: "food",
  great_grey_owl_meat: "food",
  flying_squirrel_cut: "food",
  plains_bison_cut: "food",
  prairie_dog_cut: "food",
  burrowing_owl_meat: "food",
  giraffe_cut: "food",
  lioness_cut: "food",
  spotted_hyena_cut: "food",
  sitatunga_cut: "food",
  emperor_dragonfly_cut: "food",
  mountain_ibex_cut: "food",
  wild_yak_cut: "food",
  alpine_marmot_cut: "food",
  wild_scrub_goat_cut: "food",
  crested_porcupine_cut: "food",
  spur_thighed_tortoise_cut: "food",
  dromedary_cut: "food",
  fennec_fox_cut: "food",
  sidewinder_cut: "food",
  field_hare_cut: "food",
  arctic_hare_cut: "food",
  capybara_cut: "food",
  armadillo_cut: "food",
  red_fox_cut: "food",
  wolverine_cut: "food",
  ostrich_cut: "food",
  golden_eagle_cut: "food",
  musk_ox_cut: "food",
  seal_cut: "food",
  desert_lion_cut: "food",
  saiga_cut: "food",
  wild_horse_cut: "food",
  steppe_marmot_cut: "food",
  lemming_cut: "food",
  snow_goose_meat: "food",
  mammoth_cut: "food",
  dire_wolf_cut: "food",
  drake_cut: "food",
  dragon_cut: "food",
  grub_meat: "food",
  emperor_penguin_meat: "food",
  peary_caribou_cut: "food",
  ice_worm_cut: "food",
  sea_otter_cut: "food",
  herring_gull_meat: "food",
  spiny_lobster_tail: "food",
  hammerhead_shark_steak: "food",
  manta_ray_wing: "food",
  humpback_whale_cut: "food",
  muskellunge_fillet: "food",
  mute_swan_meat: "food",
  pike_fillet: "food",
  snapping_turtle_cut: "food",
  beaver_cut: "food",
  otter_cut: "food",
  salmon_fillet: "food",
  elemental_ration: "food",
  scorching_bird_meat: "food",
  zappy_bird_meat: "food",
  freezing_bird_meat: "food",
  field_ration: "food",
  hearty_ration: "food",
  xoral_essence: "food",
  ...Object.fromEntries(UNIVERSAL_FOOD_ITEM_IDS.map((itemId) => [itemId, "food"])),
  // Mob drops share the standard item size.
  ...Object.fromEntries(MOB_DROP_ITEM_IDS.map((itemId) => [itemId, "generic"]))
});

/** Resolve an item id/artwork key to the canonical shared presentation key. */
export function runtimePngItemPresentationKey(artworkKey: string): string {
  return RUNTIME_PNG_ITEM_ARTWORK_ALIASES[artworkKey] ?? artworkKey;
}

/**
 * Returns the authored item presentation, or null for older/unknown item
 * artwork that has not received a metadata entry yet. Callers should retain
 * the safe default when this returns null.
 */
export function runtimePngItemPresentation(
  artworkKey: string
): RuntimeSpritePresentation | null {
  const key = runtimePngItemPresentationKey(artworkKey);
  return (RUNTIME_PNG_PRESENTATION_CATALOG.sprites as Record<string, RuntimeSpritePresentation>)[key]
    ?? null;
}

/**
 * Shared UI scale for item artwork. The default is deliberately one so
 * existing assets without metadata remain safe and unchanged.
 */
export function runtimePngItemDisplayScale(artworkKey: string): number {
  const presentation = runtimePngItemPresentation(artworkKey);
  return presentation
    ? (presentation.inventoryHeightPx ?? presentation.baseHeightPx) /
      RUNTIME_PNG_ITEM_DEFAULT_HEIGHT_PX
    : 1;
}

/**
 * Project an authored world ground height into an indoor scene's player-local
 * units. Indoor PlayerRenderer roots use `playerVisualHeightUnits` as the
 * canonical pre-transform target, while the world item contract is authored
 * against the 28px world player sprite. Keeping this ratio in shared code
 * prevents Manor and dungeon from inventing location-specific item sizes.
 */
export function runtimePngItemGroundVisualHeight(
  groundHeightPx: number,
  playerVisualHeightUnits: number
): number {
  const safeGroundHeight = Number.isFinite(groundHeightPx) && groundHeightPx > 0
    ? groundHeightPx
    : RUNTIME_PNG_ITEM_DEFAULT_HEIGHT_PX;
  const safePlayerHeight = Number.isFinite(playerVisualHeightUnits) && playerVisualHeightUnits > 0
    ? playerVisualHeightUnits
    : RUNTIME_PNG_ITEM_DEFAULT_HEIGHT_PX;
  return safePlayerHeight * safeGroundHeight / RUNTIME_PNG_ITEM_DEFAULT_HEIGHT_PX;
}

/**
 * Return the effective normalized ground hit geometry. Legacy item entries
 * have no mode and therefore lock their hit frame to the visual frame.
 */
export function runtimePngItemGroundHitGeometry(
  presentation: RuntimeSpritePresentation
): RuntimePngInteractionGeometry {
  if (presentation.hitGeometryMode === "custom") return presentation.hitGeometry;
  if (
    presentation.hitGeometry.shape === "rectangle" &&
    presentation.hitGeometry.centerX === 0.5 &&
    presentation.hitGeometry.centerY === 0.5 &&
    presentation.hitGeometry.width === 1 &&
    presentation.hitGeometry.height === 1
  ) return presentation.hitGeometry;
  return {
    shape: "rectangle",
    centerX: 0.5,
    centerY: 0.5,
    width: 1,
    height: 1
  };
}

/** Every world PNG, including the player, flags and buoys, follows the master scale. */
export function isRuntimePngMasterScaleEligible(
  _kind: "sprite" | "fixed",
  _key: string
): boolean {
  return true;
}

export function clampRuntimePngMasterScale(value: number): number {
  const finiteValue = Number.isFinite(value)
    ? value
    : RUNTIME_PNG_PRESENTATION_CATALOG.masterScale;
  const clamped = Math.min(
    RUNTIME_PNG_MASTER_SCALE_MAX,
    Math.max(RUNTIME_PNG_MASTER_SCALE_MIN, finiteValue)
  );
  return Math.round(clamped / RUNTIME_PNG_MASTER_SCALE_STEP) *
    RUNTIME_PNG_MASTER_SCALE_STEP;
}
