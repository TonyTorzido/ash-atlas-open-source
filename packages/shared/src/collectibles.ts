import type { HarvestAccessMode } from "./harvestAccess.js";
import type { ShopProvenance } from "./shopProvenance.js";
import type { LatLon } from "./types.js";
import {
  DEFAULT_FLAG_PREPARE_RADIUS_M,
  DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M,
  DEFAULT_COLLECTIBLE_INTERACTION_RADIUS_M,
  DEFAULT_MOVE_LEASH_TO_VISION_GAP_M
} from "./gameplayArea.js";
import { MOB_DROP_ITEM_IDS, MOB_DROP_ITEMS, type MobDropItemId } from "./mobDropItems.js";
import { UNIVERSAL_FOOD_ITEM_IDS } from "./universalFood.js";

const RESOURCE_TYPES_BASE = [
  "wood",
  "stone",
  "coal",
  "iron",
  "sulfur",
  "slag",
  "iron_bar",
  "venomsteel_bar",
  "venomsteel_core",
  "fire_feather",
  "tempest_quill",
  "ice_feather",
  "fire_bar",
  "fire_core",
  "lightning_bar",
  "lightning_core",
  "ice_bar",
  "ice_core",
  "food",
  "bone",
  "fertilizer",
  "flux_plant",
  "simple_food",
  "freshwater_fish",
  "ashen_fish",
  "ore",
  "water",
  "flax_fiber",
  "cloth",
  "leather",
  "deer_hide",
  "hog_hide",
  "wolf_pelt",
  "bear_hide",
  "alligator_hide",
  "deer_carcass",
  "wolf_carcass",
  "hog_carcass",
  "bear_carcass",
  "alligator_carcass",
  "wild_carcass",
  "squid_flesh",
  "squid_meat",
  "deer_meat",
  "wolf_meat",
  "hog_meat",
  "bear_meat",
  "alligator_meat",
  "wild_meat",
  "crab_carapace",
  "raw_meat",
  "shell",
  "chitin",
  "giving_berry",
  "balsam_resin",
  "repair_kit",
  "torch",
  "shovel",
  "crude_oil",
  "jellyfish_venom",
  "brood_silk",
  "raptor_scale",
  "giant_egg",
  "brood_egg",
  "clutch_egg",
  "crawler_egg",
  "broken_whistle",
  "bonewrought_blade",
  "bonewrought_mail",
  "survey_stake_kit",
  "compass",
  "lamp_sheath",
  "cinder_lantern",
  "challengers_lantern",
  "anti_venom_tonic",
  "battle_draught",
  "ember_flask",
  "spark_tonic",
  "field_net",
  "field_trap",
  // Tidecraft crafted items (water game phase D, 1058).
  "tidewater_draught",
  "undertow_snare",
  "stillwater_orb",
  "free_step_ward",
  "masons_tome",
  "vigor_serum",
  "mending_resin",
  "loadout_scroll",
  "elder_acorn",
  "prison_key_fragment",
  "giving_tree_sapling",
  "zephyr",
  // Dungeon special-metal ingredients (1101); the infusion system that uses them comes later.
  "cave_lichen",
  "gale_plume",
  "heartsap",
  "wyrm_egg",
  "dragon_scale",
  "maw_bloom_petal",
  "refined_oil",
  "bricks",
  "crystal",
  "pearl",
  "atlas_shrine_shard",
  "lichen",
  "thistle",
  "umbral_essence",
  "dusk_heart",
  "bloom_petal",
  "gearwork_essence",
  "gale_splinter",
  "griffin_plume",
  "edict_seal",
  "skyrise_stone",
  "mist_drop",
  "revenant_bar",
  "expel_bar",
  "mirage_bar",
  "gale_bar",
  "fleet_bar",
  "whetted_bar",
  "vengeance_bar",
  "gloom_bar",
  "skyrise_bar",
  "vital_bar",
  "enchantment_stone",
  // Carried, droppable premium currency (0917). Only audited admin grants mint it.
  "lumen",
  // Bought for Gold and consumed when sending a player gift (1000).
  "gift_box",
  // Manor skin (variant = Manor type), bought with Glimmer and installed on a Manor.
  "manor_skin",
  // Face mask (variant = mask appearance id), bought in the Glimmer Shop and worn from the inventory.
  "face_mask",
  // Water game phase B (1052): the Shellback drop and the Tide Wraith / Gate Warden orb.
  "shellback_plate",
  "abyssal_orb",
  // Paid out by dumping a random-roll ring (rings.ts); tradable ring-economy material.
  "ring_shard",
  // Golem Forge (1103): Forge Spark token, Shard Grit ring-forging material, Amulet Clasp.
  "forge_spark",
  "shard_grit",
  "amulet_clasp",
  ...UNIVERSAL_FOOD_ITEM_IDS,
  // Mob value pass B1: regional, signature and trophy drops (mobDropItems.ts).
  ...MOB_DROP_ITEM_IDS
] as const;
/** Commodity resources used by the established economy. Rod instances have a
 * separate identity but remain an inventory item type below. */
export type ResourceType = (typeof RESOURCE_TYPES_BASE)[number];
export type FishingRodResourceType = "fishing_rod";
/**
 * Greenhouse commodities are inventory identities, but are not world
 * collectible resources. Keeping them out of ResourceType preserves the
 * narrow harvest/economy contracts while allowing inventory to carry them.
 */
export const GREENHOUSE_ITEM_TYPES = [
  "seed",
  "produce",
  "wheat_seed",
  "wheat",
  "gardening_bucket",
  "water_bucket"
] as const;
export type GreenhouseItemType = (typeof GREENHOUSE_ITEM_TYPES)[number];
export type InventoryItemType = ResourceType | FishingRodResourceType | GreenhouseItemType;

// Keep the public commodity list's static and runtime value free of the rod
// identity. A rod is an inventory item, but it must not enter harvest, market,
// or other resource-only APIs that consume RESOURCE_TYPES.
export const RESOURCE_TYPES = RESOURCE_TYPES_BASE;
export const INVENTORY_ITEM_TYPES = [...RESOURCE_TYPES_BASE, "fishing_rod", ...GREENHOUSE_ITEM_TYPES] as const;
export type MilitaryResourceType = ResourceType;
/** metal framework materials and bars; inventory totals carry them only when non-zero. */
export type MetalFrameworkItemType =
  | "lichen" | "thistle" | "umbral_essence" | "dusk_heart" | "bloom_petal"
  | "gearwork_essence" | "gale_splinter" | "griffin_plume" | "edict_seal"
  | "skyrise_stone" | "mist_drop"
  | "revenant_bar" | "expel_bar" | "mirage_bar" | "gale_bar" | "fleet_bar" | "whetted_bar"
  | "vengeance_bar" | "gloom_bar" | "skyrise_bar" | "vital_bar";
export type InventoryTotalResourceType = Exclude<
  ResourceType,
  "slag" | "chitin" | "repair_kit" | "flax_fiber" | "cloth" | "torch" | "shovel" | "bricks" |
    "deer_carcass" | "wolf_carcass" | "hog_carcass" | "bear_carcass" |
    "alligator_carcass" | "wild_carcass" | "squid_flesh" | "squid_meat" |
    "deer_meat" | "wolf_meat" | "hog_meat" | "bear_meat" |
  "alligator_meat" | "wild_meat" | "raw_meat" | "simple_food" |
    "bone" | "fertilizer" | "flux_plant" |
    (typeof UNIVERSAL_FOOD_ITEM_IDS)[number] | "freshwater_fish" | "ashen_fish" | "lumen" | "gift_box" | "manor_skin" | "face_mask" | "ring_shard" | "forge_spark" | "shard_grit" | "amulet_clasp" |
    "shellback_plate" | "abyssal_orb" | TidecraftCraftedItemType | MetalFrameworkItemType | MobDropItemId
>;
/** Tidecraft crafted items: optional in inventory totals, like the other water items. */
type TidecraftCraftedItemType = "tidewater_draught" | "undertow_snare" | "stillwater_orb" | "free_step_ward" | "masons_tome" | "vigor_serum" | "mending_resin" | "loadout_scroll";
export type InventoryTotals = Record<InventoryTotalResourceType, number> &
  Partial<Pick<Record<ResourceType, number>,
    "slag" | "chitin" | "repair_kit" | "flax_fiber" | "cloth" | "torch" | "shovel" | "bricks" |
    "squid_flesh" |
    "deer_carcass" | "wolf_carcass" | "hog_carcass" | "bear_carcass" |
    "alligator_carcass" | "wild_carcass" | "squid_meat" | "deer_meat" |
    "wolf_meat" | "hog_meat" | "bear_meat" | "alligator_meat" | "wild_meat" |
    "raw_meat" | "simple_food" | (typeof UNIVERSAL_FOOD_ITEM_IDS)[number] |
    "freshwater_fish" | "ashen_fish" | "bone" | "fertilizer" | "flux_plant" | "lumen" | "gift_box" | "manor_skin" | "face_mask" | "ring_shard" | "forge_spark" | "shard_grit" | "amulet_clasp" |
    "shellback_plate" | "abyssal_orb" | TidecraftCraftedItemType | MetalFrameworkItemType | MobDropItemId>> &
  Partial<Record<GreenhouseItemType, number>> & { fishing_rod?: number };

/**
 * These identities remain in the wire/inventory types only so retained
 * history and forward retirement migrations can be decoded. They are not
 * harvestable or catalogued runtime resources.
 */
export const RETIRED_RESOURCE_TYPES = [
  "food",
  "water",
  "deer_carcass",
  "wolf_carcass",
  "hog_carcass",
  "bear_carcass",
  "alligator_carcass",
  "wild_carcass",
  "squid_flesh", "squid_meat", "deer_meat", "wolf_meat", "hog_meat",
  "bear_meat", "alligator_meat", "wild_meat", "raw_meat"
] as const;
export type RetiredResourceType = (typeof RETIRED_RESOURCE_TYPES)[number];
const RETIRED_RESOURCE_TYPE_SET = new Set<string>(RETIRED_RESOURCE_TYPES);

export function isActiveResourceType(
  resourceType: ResourceType
): resourceType is Exclude<ResourceType, RetiredResourceType> {
  return !RETIRED_RESOURCE_TYPE_SET.has(resourceType);
}

export const RESOURCE_STACK_LIMITS: Readonly<Record<ResourceType | FishingRodResourceType, number>> = {
  wood: 500,
  stone: 250,
  coal: 250,
  iron: 250,
  sulfur: 250,
  slag: 250,
  iron_bar: 50,
  venomsteel_bar: 50,
  venomsteel_core: 1,
  fire_feather: 1,
  tempest_quill: 1,
  ice_feather: 1,
  fire_bar: 50,
  fire_core: 1,
  lightning_bar: 50,
  lightning_core: 1,
  ice_bar: 50,
  ice_core: 1,
  food: 100,
  bone: 250,
  fertilizer: 250,
  flux_plant: 250,
  simple_food: 250,
  freshwater_fish: 250,
  ashen_fish: 25,
  fishing_rod: 1,
  ore: 250,
  water: 100,
  flax_fiber: 250,
  cloth: 250,
  leather: 500,
  deer_hide: 125,
  hog_hide: 125,
  wolf_pelt: 125,
  bear_hide: 125,
  alligator_hide: 125,
  deer_carcass: 125,
  wolf_carcass: 125,
  hog_carcass: 125,
  bear_carcass: 125,
  alligator_carcass: 125,
  wild_carcass: 125,
  squid_flesh: 125,
  squid_meat: 500,
  deer_meat: 500,
  wolf_meat: 500,
  hog_meat: 500,
  bear_meat: 500,
  alligator_meat: 500,
  wild_meat: 500,
  crab_carapace: 125,
  raw_meat: 500,
  shell: 500,
  chitin: 500,
  giving_berry: 100,
  balsam_resin: 100,
  repair_kit: 50,
  torch: 250,
  shovel: 25,
  crude_oil: 250,
  jellyfish_venom: 25,
  brood_silk: 25,
  raptor_scale: 25,
  giant_egg: 25,
  brood_egg: 25,
  clutch_egg: 25,
  crawler_egg: 25,
  broken_whistle: 25,
  bonewrought_blade: 25,
  bonewrought_mail: 25,
  survey_stake_kit: 25,
  compass: 1,
  lamp_sheath: 10,
  cinder_lantern: 1,
  challengers_lantern: 1,
  anti_venom_tonic: 100,
  battle_draught: 100,
  ember_flask: 100,
  spark_tonic: 100,
  field_net: 100,
  field_trap: 100,
  tidewater_draught: 100,
  undertow_snare: 100,
  stillwater_orb: 100,
  free_step_ward: 100,
  masons_tome: 25,
  vigor_serum: 100,
  mending_resin: 100,
  loadout_scroll: 100,
  elder_acorn: 25,
  prison_key_fragment: 25,
  giving_tree_sapling: 25,
  zephyr: 25,
  cave_lichen: 25,
  gale_plume: 25,
  heartsap: 25,
  wyrm_egg: 25,
  dragon_scale: 25,
  maw_bloom_petal: 25,
  refined_oil: 250,
  bricks: 1000,
  crystal: 250,
  pearl: 25,
  atlas_shrine_shard: 25,
  lichen: 250,
  thistle: 250,
  umbral_essence: 250,
  dusk_heart: 25,
  bloom_petal: 250,
  gearwork_essence: 500,
  gale_splinter: 500,
  griffin_plume: 250,
  edict_seal: 500,
  skyrise_stone: 25,
  mist_drop: 1000,
  revenant_bar: 50,
  expel_bar: 50,
  mirage_bar: 50,
  gale_bar: 50,
  fleet_bar: 50,
  whetted_bar: 50,
  vengeance_bar: 50,
  gloom_bar: 50,
  skyrise_bar: 50,
  vital_bar: 50,
  enchantment_stone: 1,
  lumen: 1_000_000,
  gift_box: 100,
  manor_skin: 1,
  face_mask: 1,
  shellback_plate: 250,
  abyssal_orb: 25,
  ring_shard: 10_000,
  forge_spark: 500,
  shard_grit: 10_000,
  amulet_clasp: 100,
  frog_legs: 250,
  frost_frog_legs: 250,
  poison_frog_legs: 250,
  desert_toad_legs: 250,
  crab_meat: 250,
  ice_crab_meat: 250,
  sand_crab_meat: 250,
  mangrove_crab_meat: 250,
  small_catch: 250,
  jellyfish_jelly: 250,
  crawler_flesh: 250,
  squid_cut: 250,
  wolf_cut: 250,
  frost_wolf_cut: 250,
  dune_wolf_cut: 250,
  jungle_wolf_cut: 250,
  bog_wolf_cut: 250,
  deer_cut: 250,
  frost_deer_cut: 250,
  jungle_deer_cut: 250,
  marsh_deer_cut: 250,
  sand_deer_cut: 250,
  hog_cut: 250,
  woolly_hog_cut: 250,
  warthog_cut: 250,
  jungle_hog_cut: 250,
  mud_hog_cut: 250,
  javelina_cut: 250,
  alligator_tail: 250,
  caiman_tail: 250,
  crocodile_tail: 250,
  bear_cut: 250,
  snow_bear_cut: 250,
  black_bear_cut: 250,
  sun_bear_cut: 250,
  jungle_tapir_cut: 250,
  jaguar_cut: 250,
  mandrill_cut: 250,
  capercaillie_meat: 250,
  elk_cut: 250,
  red_squirrel_cut: 250,
  badger_cut: 250,
  grey_squirrel_cut: 250,
  stag_beetle_cut: 250,
  great_grey_owl_meat: 250,
  flying_squirrel_cut: 250,
  plains_bison_cut: 250,
  prairie_dog_cut: 250,
  burrowing_owl_meat: 250,
  giraffe_cut: 250,
  lioness_cut: 250,
  spotted_hyena_cut: 250,
  sitatunga_cut: 250,
  emperor_dragonfly_cut: 250,
  mountain_ibex_cut: 250,
  wild_yak_cut: 250,
  alpine_marmot_cut: 250,
  wild_scrub_goat_cut: 250,
  crested_porcupine_cut: 250,
  spur_thighed_tortoise_cut: 250,
  dromedary_cut: 250,
  fennec_fox_cut: 250,
  sidewinder_cut: 250,
  field_hare_cut: 250,
  arctic_hare_cut: 250,
  capybara_cut: 250,
  armadillo_cut: 250,
  red_fox_cut: 250,
  wolverine_cut: 250,
  ostrich_cut: 250,
  golden_eagle_cut: 250,
  musk_ox_cut: 250,
  seal_cut: 250,
  desert_lion_cut: 250,
  saiga_cut: 250,
  wild_horse_cut: 250,
  steppe_marmot_cut: 250,
  lemming_cut: 250,
  snow_goose_meat: 250,
  mammoth_cut: 250,
  dire_wolf_cut: 250,
  drake_cut: 250,
  dragon_cut: 250,
  grub_meat: 250,
  emperor_penguin_meat: 250,
  peary_caribou_cut: 250,
  ice_worm_cut: 250,
  sea_otter_cut: 250,
  herring_gull_meat: 250,
  spiny_lobster_tail: 250,
  hammerhead_shark_steak: 250,
  manta_ray_wing: 250,
  humpback_whale_cut: 250,
  muskellunge_fillet: 250,
  mute_swan_meat: 250,
  pike_fillet: 250,
  snapping_turtle_cut: 250,
  beaver_cut: 250,
  otter_cut: 250,
  salmon_fillet: 250,
  elemental_ration: 250,
  scorching_bird_meat: 250,
  zappy_bird_meat: 250,
  freezing_bird_meat: 250,
  field_ration: 250,
  hearty_ration: 250,
  xoral_essence: 250,
  ...mobDropStackLimits()
};

function mobDropStackLimits(): Readonly<Record<MobDropItemId, number>> {
  return Object.fromEntries(
    MOB_DROP_ITEM_IDS.map((itemId) => [itemId, MOB_DROP_ITEMS[itemId].maxStack])
  ) as Record<MobDropItemId, number>;
}

export const INVENTORY_STACK_LIMITS: Readonly<Record<InventoryItemType, number>> = {
  ...RESOURCE_STACK_LIMITS,
  seed: 250,
  produce: 250,
  wheat_seed: 250,
  wheat: 250,
  gardening_bucket: 1,
  water_bucket: 1
};

export const GROUND_RESOURCE_TYPES = ["wood", "stone", "food", "ore"] as const;
export type GroundResourceType = (typeof GROUND_RESOURCE_TYPES)[number];
/** Temporary population generations exclude stone; permanent zone stone remains a ground resource. */
export const SPAWNABLE_GROUND_RESOURCE_TYPES = ["wood", "ore"] as const;
export type SpawnableGroundResourceType = (typeof SPAWNABLE_GROUND_RESOURCE_TYPES)[number];

export const SPAWN_CELL_SIZE_M = 250;
export const COLLECTIBLE_VISIBILITY_RADIUS_M = DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M;
export const FLAG_VISIT_VISIBLE_PREPARATION_RADIUS_M = DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M;
export const RESOURCE_PREPARATION_RADIUS_M = DEFAULT_FLAG_PREPARE_RADIUS_M;
export const OPEN_AREA_COLLECTIBLE_VISIBILITY_RADIUS_M = DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M;
export const MOVE_LEASH_TO_VISION_GAP_M = DEFAULT_MOVE_LEASH_TO_VISION_GAP_M;
export const COLLECTIBLE_PICKUP_RADIUS_M =
  DEFAULT_COLLECTIBLE_INTERACTION_RADIUS_M;
export const MAX_VISIBLE_COLLECTIBLE_NODES = 150;
export const MAX_COLLECTIBLE_NODES_PER_CELL = 2;
export const RESOURCE_LAYOUT_VERSION = "resource-layout-v2";
export const RESOURCE_ENVIRONMENT_SAMPLE_BUDGET = 32;
/** Wild Flax is a modest, deterministic three-fiber harvest. */
export const FLAX_FIBER_HARVEST_YIELD_QUANTITY = 3;
export const FLAX_FIBER_HARVEST_DURATION_MS = 5_000;

export const WATER_KINDS = ["fresh", "salt", "unknown"] as const;
export type WaterKind = (typeof WATER_KINDS)[number];

export type CollectibleNodeState = "available" | "harvested";
export const WORLD_RESOURCE_PRESENTATION_DOMAINS = [
  "population",
  "repeatable-resource",
  "resource-vision"
] as const;
export type WorldResourcePresentationDomain =
  (typeof WORLD_RESOURCE_PRESENTATION_DOMAINS)[number];

export type HarvestStartAuthority = Readonly<{
  presentationOwner: WorldResourcePresentationDomain;
  entityRevision: number;
  relocationRevision: number;
  resourceVisionRevision: number;
  gameplayViewGeneration: number;
}>;

export const COLLECTIBLE_SNAPSHOT_COMPLETENESS = [
  "complete",
  "partial",
  "loading",
  "failed"
] as const;
export type CollectibleSnapshotCompleteness =
  (typeof COLLECTIBLE_SNAPSHOT_COMPLETENESS)[number];

export type CollectibleSnapshotScope =
  | { kind: "flag"; id: string }
  | { kind: "kingdom-seat"; id: string }
  | { kind: "open-area"; id: string }
  | { kind: "player-anchor"; id: string };

export type CollectibleSnapshotAuthority = {
  snapshotId: string;
  snapshotGeneration: number;
  gameplayViewGeneration: number;
  scope: CollectibleSnapshotScope;
  includedDomains: readonly WorldResourcePresentationDomain[];
  completeness: CollectibleSnapshotCompleteness;
  ordinaryNodesTruncated: boolean;
  returnedCount: number;
  authoritativeTotalCount: number | null;
};

export type CollectibleNode = {
  id: string;
  type: ResourceType;
  lat: number;
  lon: number;
  quantity: number;
  state: CollectibleNodeState;
  createdAt: string;
  harvestedAt: string | null;
  sourceCellId: string;
  waterKind: WaterKind | null;
  presentationOwner?: WorldResourcePresentationDomain;
  /** Client projection for a separately persisted repeatable node. */
  repeatableNodeType?: RepeatableResourceNodeType;
  repeatableState?: RepeatableResourceNodeState;
  repeatableReadyAt?: string | null;
  repeatableTimerVisibility?: RepeatableResourceTimerVisibility;
  repeatableRevision?: number;
  repeatableOwnerPlayerId?: string | null;
  repeatableOwnerUsername?: string | null;
  repeatableAccessMode?: HarvestAccessMode | null;
  repeatableAccessRevision?: number;
  repeatableTollGold?: string;
  repeatableCanManage?: boolean;
  repeatableBonusExtractionAvailable?: boolean;
  /** Stable tree-life identity used to reconcile resin state across AOI streams. */
  treeLifeRevision?: number;
  /** True only while deterministic resin is still available in this tree life. */
  resinAvailable?: boolean;
  /** Berry availability on non-resin Giving Trees in the current tree life. */
  berryAvailable?: boolean;
  /**
   * Elder Ferns only: when the sap refills after the last tap (null: never tapped).
   * Availability is time-based, see elderFrondSapAvailable.
   */
  sapReadyAt?: string | null;
};

export const REPEATABLE_RESOURCE_NODE_TYPES = [
  "stone_mine",
  "coal_mine",
  "iron_mine",
  "sulfur_mine"
] as const;
export type RepeatableResourceNodeType = (typeof REPEATABLE_RESOURCE_NODE_TYPES)[number];
export type RepeatableResourceNodeState = "ready" | "depleted";
export type RepeatableResourceTimerVisibility = "visible" | "redacted";
export const PERMANENT_MINE_BASE_YIELD_QUANTITY = 1;
export const STONE_MINE_YIELD_QUANTITY = 3;

export type RepeatableResourceNode = {
  id: string;
  nodeType: RepeatableResourceNodeType;
  lat: number;
  lon: number;
  yieldItemId: ResourceType;
  yieldQuantity: number;
  state: RepeatableResourceNodeState;
  /** Monotonic durable population/repeatable lifecycle revision. */
  authorityRevision: number;
  /** Public cooldown boundary used only for the depleted countdown. */
  readyAt: string | null;
  /** Distinguishes an intentionally private deadline from a malformed visible timer. */
  timerVisibility: RepeatableResourceTimerVisibility;
  ownerPlayerId?: string | null;
  ownerUsername?: string | null;
  accessMode?: HarvestAccessMode | null;
  accessRevision?: number;
  tollGold?: string;
  canManage?: boolean;
  bonusExtractionAvailable?: boolean;
};

export type ResourceGain = {
  eventId: string;
  itemId: ResourceType;
  quantity: number;
};

export type ResourceVision = {
  flagId: string;
  flagName: string;
  destinationKind?: "flag" | "kingdom_seat" | "area";
  center: LatLon;
  movementLeashRadiusM: number;
  paddingM: number;
  radiusM: number;
};

export type ResourceVisionGenerationStatus = "pending" | "generating" | "ready" | "failed";

export type ResourceVisionStatus = {
  flagId: string;
  layoutVersion: string;
  status: ResourceVisionGenerationStatus;
  radiusM: number;
  nodeCount: number;
  waterHighlightCount: number;
  requestedAt: string;
  generatedAt: string | null;
  lastError: string | null;
  updatedAt: string;
};

export type WaterSourceHighlight = {
  id: string;
  name: string | null;
  sourceDataset: string | null;
  waterSourceType: string;
  waterKind: string;
  collectible: boolean;
  lat: number;
  lon: number;
};

export type PlayerInventoryItem = {
  /** One durable identity per commodity balance; stackId is its legacy wire alias. */
  entryId?: string;
  unitWeightGrams?: number;
  totalWeightGrams?: string;
  playerId: string;
  resourceType: InventoryItemType;
  variant: string | null;
  quantity: number;
  /** Authoritative runtime limit supplied by the server item catalog. */
  maxStack?: number;
  stackId?: string;
  slotIndex?: number;
  manualSplit?: boolean;
  /** Stable rod identity and server-owned durability, when this is a rod. */
  rodId?: string;
  usesRemaining?: number;
  /** Per-copy shop items (face_mask / manor_skin): the copy's look (mask appearance or Manor type). */
  look?: string;
  /** Per-copy shop items: permanent tag and original buyer. */
  provenance?: ShopProvenance;
  /** Per-copy shop items: this copy is worn (mask) or equipped on the Manor (skin), so it is locked. */
  equipped?: boolean;
};

export type PlayerInventorySnapshot = {
  currentWeightGrams?: string;
  maximumWeightGrams?: string;
  playerId: string;
  /** Player-wide monotonic revision for every authoritative inventory mutation. */
  revision: number;
  items: PlayerInventoryItem[];
  totals: InventoryTotals;
  unlockedSlots?: number;
};

export type HarvestSessionStatus = "active" | "completed" | "cancelled" | "expired";

export type HarvestSessionSnapshot = {
  sessionId: string;
  playerId: string;
  nodeId: string;
  resourceType: ResourceType;
  operationKey: string;
  status: HarvestSessionStatus;
  startedAt: string;
  completesAt: string;
  expiresAt: string;
  completedAt: string | null;
  cancelledAt: string | null;
};

export function emptyInventoryTotals(): InventoryTotals {
  return {
    wood: 0,
    stone: 0,
    coal: 0,
    iron: 0,
    sulfur: 0,
    slag: 0,
    iron_bar: 0,
    venomsteel_bar: 0,
    venomsteel_core: 0,
    fire_feather: 0,
    tempest_quill: 0,
    ice_feather: 0,
    fire_bar: 0,
    fire_core: 0,
    lightning_bar: 0,
    lightning_core: 0,
    ice_bar: 0,
    ice_core: 0,
    food: 0,
    bone: 0,
    fertilizer: 0,
    flux_plant: 0,
    simple_food: 0,
    freshwater_fish: 0,
    ashen_fish: 0,
    ore: 0,
    water: 0,
    seed: 0,
    produce: 0,
    wheat_seed: 0,
    wheat: 0,
    gardening_bucket: 0,
    water_bucket: 0,
    flax_fiber: 0,
    cloth: 0,
    leather: 0,
    deer_hide: 0,
    hog_hide: 0,
    wolf_pelt: 0,
    bear_hide: 0,
    alligator_hide: 0,
    deer_carcass: 0,
    wolf_carcass: 0,
    hog_carcass: 0,
    bear_carcass: 0,
    alligator_carcass: 0,
    wild_carcass: 0,
    squid_flesh: 0,
    squid_meat: 0,
    deer_meat: 0,
    wolf_meat: 0,
    hog_meat: 0,
    bear_meat: 0,
    alligator_meat: 0,
    wild_meat: 0,
    crab_carapace: 0,
    raw_meat: 0,
    shell: 0,
    chitin: 0,
    giving_berry: 0,
    balsam_resin: 0,
    repair_kit: 0,
    torch: 0,
    shovel: 0,
    crude_oil: 0,
    jellyfish_venom: 0,
    brood_silk: 0, refined_oil: 0, raptor_scale: 0, giant_egg: 0, brood_egg: 0, clutch_egg: 0, crawler_egg: 0, broken_whistle: 0, bonewrought_blade: 0, bonewrought_mail: 0, anti_venom_tonic: 0, battle_draught: 0, ember_flask: 0, spark_tonic: 0, field_net: 0, field_trap: 0, lamp_sheath: 0, cinder_lantern: 0, challengers_lantern: 0, survey_stake_kit: 0, compass: 0, elder_acorn: 0, zephyr: 0, cave_lichen: 0, gale_plume: 0, heartsap: 0, wyrm_egg: 0, dragon_scale: 0, maw_bloom_petal: 0, giving_tree_sapling: 0, edict_seal: 0, prison_key_fragment: 0, bricks: 0,
    tidewater_draught: 0, undertow_snare: 0, stillwater_orb: 0, free_step_ward: 0, masons_tome: 0, vigor_serum: 0, mending_resin: 0, loadout_scroll: 0,
    crystal: 0,
    pearl: 0,
    atlas_shrine_shard: 0,
    lichen: 0,
    thistle: 0,
    umbral_essence: 0,
    dusk_heart: 0,
    bloom_petal: 0,
    gearwork_essence: 0,
    gale_splinter: 0,
    griffin_plume: 0,
    skyrise_stone: 0,
    mist_drop: 0,
    revenant_bar: 0,
    expel_bar: 0,
    mirage_bar: 0,
    gale_bar: 0,
    fleet_bar: 0,
    whetted_bar: 0,
    vengeance_bar: 0,
    gloom_bar: 0,
    skyrise_bar: 0,
    vital_bar: 0,
    enchantment_stone: 0,
    lumen: 0,
    shellback_plate: 0,
    abyssal_orb: 0,
    frog_legs: 0,
    frost_frog_legs: 0,
    poison_frog_legs: 0,
    desert_toad_legs: 0,
    crab_meat: 0,
    ice_crab_meat: 0,
    sand_crab_meat: 0,
    mangrove_crab_meat: 0,
    small_catch: 0,
    jellyfish_jelly: 0,
    crawler_flesh: 0,
    squid_cut: 0,
    wolf_cut: 0,
    frost_wolf_cut: 0,
    dune_wolf_cut: 0,
    jungle_wolf_cut: 0,
    bog_wolf_cut: 0,
    deer_cut: 0,
    frost_deer_cut: 0,
    jungle_deer_cut: 0,
    marsh_deer_cut: 0,
    sand_deer_cut: 0,
    hog_cut: 0,
    woolly_hog_cut: 0,
    warthog_cut: 0,
    jungle_hog_cut: 0,
    mud_hog_cut: 0,
    javelina_cut: 0,
    alligator_tail: 0,
    caiman_tail: 0,
    crocodile_tail: 0,
    bear_cut: 0,
    snow_bear_cut: 0,
    black_bear_cut: 0,
    sun_bear_cut: 0,
    jungle_tapir_cut: 0,
    jaguar_cut: 0,
    mandrill_cut: 0,
    capercaillie_meat: 0,
    elk_cut: 0,
    red_squirrel_cut: 0,
    badger_cut: 0,
    grey_squirrel_cut: 0,
    stag_beetle_cut: 0,
    great_grey_owl_meat: 0,
    flying_squirrel_cut: 0,
    plains_bison_cut: 0,
    prairie_dog_cut: 0,
    burrowing_owl_meat: 0,
    giraffe_cut: 0,
    lioness_cut: 0,
    spotted_hyena_cut: 0,
    sitatunga_cut: 0,
    emperor_dragonfly_cut: 0,
    mountain_ibex_cut: 0,
    wild_yak_cut: 0,
    alpine_marmot_cut: 0,
    wild_scrub_goat_cut: 0,
    crested_porcupine_cut: 0,
    spur_thighed_tortoise_cut: 0,
    dromedary_cut: 0,
    fennec_fox_cut: 0,
    sidewinder_cut: 0,
    field_hare_cut: 0,
    arctic_hare_cut: 0,
    capybara_cut: 0,
    armadillo_cut: 0,
    red_fox_cut: 0,
    wolverine_cut: 0,
    ostrich_cut: 0,
    golden_eagle_cut: 0,
    musk_ox_cut: 0,
    seal_cut: 0,
    desert_lion_cut: 0,
    saiga_cut: 0,
    wild_horse_cut: 0,
    steppe_marmot_cut: 0,
    lemming_cut: 0,
    snow_goose_meat: 0,
    mammoth_cut: 0,
    dire_wolf_cut: 0,
    drake_cut: 0,
    dragon_cut: 0,
    grub_meat: 0,
    emperor_penguin_meat: 0,
    peary_caribou_cut: 0,
    ice_worm_cut: 0,
    sea_otter_cut: 0,
    herring_gull_meat: 0,
    spiny_lobster_tail: 0,
    hammerhead_shark_steak: 0,
    manta_ray_wing: 0,
    humpback_whale_cut: 0,
    muskellunge_fillet: 0,
    mute_swan_meat: 0,
    pike_fillet: 0,
    snapping_turtle_cut: 0,
    beaver_cut: 0,
    otter_cut: 0,
    salmon_fillet: 0,
    elemental_ration: 0,
    scorching_bird_meat: 0,
    zappy_bird_meat: 0,
    freezing_bird_meat: 0,
    field_ration: 0,
    hearty_ration: 0,
    xoral_essence: 0
  };
}

export function resourceVisionRadiusForLeash(movementLeashRadiusM: number): number {
  return movementLeashRadiusM + MOVE_LEASH_TO_VISION_GAP_M;
}
