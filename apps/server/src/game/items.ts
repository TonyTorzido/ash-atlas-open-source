import {
  MANOR_SKIN_ITEM_ID,
  MANOR_SKIN_VARIANTS,
  isShopCopyId,
  isShopCopyItemId,
  premiumCurrencyForMarketItem,
  BALSAM_RESIN_HARVEST_DURATION_MS,
  BALSAM_RESIN_ITEM_ID,
  FLAX_FIBER_HARVEST_DURATION_MS,
  INVENTORY_CATALOG,
  MOB_DROP_ITEM_IDS,
  getItemWeightGrams,
  BACKPACK_LEVELS,
  BACKPACK_WEIGHT_GRAMS,
  DEFAULT_PLAYER_CARRY_CAPACITY_GRAMS,
  type InventoryCatalogItem,
  type ItemRarity,
  type InventoryItemType,
  type ResourceType
} from "@ash-atlas/shared";
import type pg from "pg";
import { greenhouseCropSupportsInventoryIdentity } from "./greenhouseCrops.js";

export type CompiledItemDefinition = {
  unitWeightGrams: number;
  itemId: string;
  displayName: string;
  category: "resource" | "consumable" | "currency" | "equipment";
  equipmentFamilyId: string | null;
  equipmentRole: string | null;
  rarity: ItemRarity;
  stackable: boolean;
  maxStack: number | null;
  droppable: boolean;
  manorStorable: boolean;
  marketTradable: boolean;
  marketFungible: boolean;
  marketIdentity: string | null;
  supportedVariants: readonly string[];
};

export type ItemDefinition = CompiledItemDefinition & {
  itemId: ResourceType;
  displayName: string;
  category: "resource" | "consumable" | "currency";
  stackable: boolean;
  maxStack: number | null;
  harvestDurationMs: number;
};

export type InventoryGrant = {
  itemId: InventoryItemType;
  variant: string | null;
  quantity: number;
};

export const DEFAULT_HARVEST_DURATION_MS = 5_000;

export const ITEM_DEFINITIONS: Readonly<Record<ResourceType, ItemDefinition>> & Readonly<{ fishing_rod: ItemDefinition }> = ({
  wood: itemDefinition("wood", 3_000),
  stone: itemDefinition("stone", 10_000),
  coal: itemDefinition("coal", 10_000),
  iron: itemDefinition("iron", 10_000),
  sulfur: itemDefinition("sulfur", 10_000),
  slag: itemDefinition("slag", DEFAULT_HARVEST_DURATION_MS),
  iron_bar: itemDefinition("iron_bar", DEFAULT_HARVEST_DURATION_MS),
  venomsteel_bar: itemDefinition("venomsteel_bar", DEFAULT_HARVEST_DURATION_MS),
  venomsteel_core: itemDefinition("venomsteel_core", DEFAULT_HARVEST_DURATION_MS),
  fire_feather: itemDefinition("fire_feather", DEFAULT_HARVEST_DURATION_MS),
  tempest_quill: itemDefinition("tempest_quill", DEFAULT_HARVEST_DURATION_MS),
  ice_feather: itemDefinition("ice_feather", DEFAULT_HARVEST_DURATION_MS),
  fire_bar: itemDefinition("fire_bar", DEFAULT_HARVEST_DURATION_MS),
  fire_core: itemDefinition("fire_core", DEFAULT_HARVEST_DURATION_MS),
  lightning_bar: itemDefinition("lightning_bar", DEFAULT_HARVEST_DURATION_MS),
  lightning_core: itemDefinition("lightning_core", DEFAULT_HARVEST_DURATION_MS),
  ice_bar: itemDefinition("ice_bar", DEFAULT_HARVEST_DURATION_MS),
  ice_core: itemDefinition("ice_core", DEFAULT_HARVEST_DURATION_MS),
  food: itemDefinition("food", 4_000),
  bone: itemDefinition("bone", DEFAULT_HARVEST_DURATION_MS),
  fertilizer: itemDefinition("fertilizer", DEFAULT_HARVEST_DURATION_MS),
  flux_plant: itemDefinition("flux_plant", DEFAULT_HARVEST_DURATION_MS),
  simple_food: itemDefinition("simple_food", DEFAULT_HARVEST_DURATION_MS),
  freshwater_fish: itemDefinition("freshwater_fish", DEFAULT_HARVEST_DURATION_MS),
  ashen_fish: itemDefinition("ashen_fish", DEFAULT_HARVEST_DURATION_MS),
  fishing_rod: itemDefinition("fishing_rod" as ResourceType, DEFAULT_HARVEST_DURATION_MS),
  ore: itemDefinition("ore", 10_000),
  water: itemDefinition("water", 2_000),
  flax_fiber: itemDefinition("flax_fiber", FLAX_FIBER_HARVEST_DURATION_MS),
  cloth: itemDefinition("cloth", DEFAULT_HARVEST_DURATION_MS),
  leather: itemDefinition("leather", DEFAULT_HARVEST_DURATION_MS),
  deer_hide: itemDefinition("deer_hide", DEFAULT_HARVEST_DURATION_MS),
  hog_hide: itemDefinition("hog_hide", DEFAULT_HARVEST_DURATION_MS),
  wolf_pelt: itemDefinition("wolf_pelt", DEFAULT_HARVEST_DURATION_MS),
  bear_hide: itemDefinition("bear_hide", DEFAULT_HARVEST_DURATION_MS),
  alligator_hide: itemDefinition("alligator_hide", DEFAULT_HARVEST_DURATION_MS),
  squid_flesh: itemDefinition("squid_flesh", DEFAULT_HARVEST_DURATION_MS),
  squid_meat: itemDefinition("squid_meat", DEFAULT_HARVEST_DURATION_MS),
  deer_meat: itemDefinition("deer_meat", DEFAULT_HARVEST_DURATION_MS),
  wolf_meat: itemDefinition("wolf_meat", DEFAULT_HARVEST_DURATION_MS),
  hog_meat: itemDefinition("hog_meat", DEFAULT_HARVEST_DURATION_MS),
  bear_meat: itemDefinition("bear_meat", DEFAULT_HARVEST_DURATION_MS),
  alligator_meat: itemDefinition("alligator_meat", DEFAULT_HARVEST_DURATION_MS),
  wild_meat: itemDefinition("wild_meat", DEFAULT_HARVEST_DURATION_MS),
  crab_carapace: itemDefinition("crab_carapace", DEFAULT_HARVEST_DURATION_MS),
  raw_meat: itemDefinition("raw_meat", DEFAULT_HARVEST_DURATION_MS),
  shell: itemDefinition("shell", DEFAULT_HARVEST_DURATION_MS),
  chitin: itemDefinition("chitin", DEFAULT_HARVEST_DURATION_MS),
  giving_berry: itemDefinition("giving_berry", BALSAM_RESIN_HARVEST_DURATION_MS),
  balsam_resin: itemDefinition(BALSAM_RESIN_ITEM_ID, BALSAM_RESIN_HARVEST_DURATION_MS),
  repair_kit: itemDefinition("repair_kit", DEFAULT_HARVEST_DURATION_MS),
  torch: itemDefinition("torch", DEFAULT_HARVEST_DURATION_MS),
  shovel: itemDefinition("shovel", DEFAULT_HARVEST_DURATION_MS),
  crude_oil: itemDefinition("crude_oil", DEFAULT_HARVEST_DURATION_MS),
  jellyfish_venom: itemDefinition("jellyfish_venom", DEFAULT_HARVEST_DURATION_MS),
  brood_silk: itemDefinition("brood_silk", DEFAULT_HARVEST_DURATION_MS),
  raptor_scale: itemDefinition("raptor_scale", DEFAULT_HARVEST_DURATION_MS),
  giant_egg: itemDefinition("giant_egg", DEFAULT_HARVEST_DURATION_MS),
  brood_egg: itemDefinition("brood_egg", DEFAULT_HARVEST_DURATION_MS),
  clutch_egg: itemDefinition("clutch_egg", DEFAULT_HARVEST_DURATION_MS),
  crawler_egg: itemDefinition("crawler_egg", DEFAULT_HARVEST_DURATION_MS),
  broken_whistle: itemDefinition("broken_whistle", DEFAULT_HARVEST_DURATION_MS),
  bonewrought_blade: itemDefinition("bonewrought_blade", DEFAULT_HARVEST_DURATION_MS),
  bonewrought_mail: itemDefinition("bonewrought_mail", DEFAULT_HARVEST_DURATION_MS),
  survey_stake_kit: itemDefinition("survey_stake_kit", DEFAULT_HARVEST_DURATION_MS),
  compass: itemDefinition("compass", DEFAULT_HARVEST_DURATION_MS),
  lamp_sheath: itemDefinition("lamp_sheath", DEFAULT_HARVEST_DURATION_MS),
  cinder_lantern: itemDefinition("cinder_lantern", DEFAULT_HARVEST_DURATION_MS),
  challengers_lantern: itemDefinition("challengers_lantern", DEFAULT_HARVEST_DURATION_MS),
  anti_venom_tonic: itemDefinition("anti_venom_tonic", DEFAULT_HARVEST_DURATION_MS),
  battle_draught: itemDefinition("battle_draught", DEFAULT_HARVEST_DURATION_MS),
  ember_flask: itemDefinition("ember_flask", DEFAULT_HARVEST_DURATION_MS),
  spark_tonic: itemDefinition("spark_tonic", DEFAULT_HARVEST_DURATION_MS),
  field_net: itemDefinition("field_net", DEFAULT_HARVEST_DURATION_MS),
  field_trap: itemDefinition("field_trap", DEFAULT_HARVEST_DURATION_MS),
  tidewater_draught: itemDefinition("tidewater_draught", DEFAULT_HARVEST_DURATION_MS),
  undertow_snare: itemDefinition("undertow_snare", DEFAULT_HARVEST_DURATION_MS),
  stillwater_orb: itemDefinition("stillwater_orb", DEFAULT_HARVEST_DURATION_MS),
  free_step_ward: itemDefinition("free_step_ward", DEFAULT_HARVEST_DURATION_MS),
  masons_tome: itemDefinition("masons_tome", DEFAULT_HARVEST_DURATION_MS),
  vigor_serum: itemDefinition("vigor_serum", DEFAULT_HARVEST_DURATION_MS),
  mending_resin: itemDefinition("mending_resin", DEFAULT_HARVEST_DURATION_MS),
  loadout_scroll: itemDefinition("loadout_scroll", DEFAULT_HARVEST_DURATION_MS),
  elder_acorn: itemDefinition("elder_acorn", DEFAULT_HARVEST_DURATION_MS),
  prison_key_fragment: itemDefinition("prison_key_fragment", DEFAULT_HARVEST_DURATION_MS),
  giving_tree_sapling: itemDefinition("giving_tree_sapling", DEFAULT_HARVEST_DURATION_MS),
  zephyr: itemDefinition("zephyr", DEFAULT_HARVEST_DURATION_MS),
  cave_lichen: itemDefinition("cave_lichen", DEFAULT_HARVEST_DURATION_MS),
  gale_plume: itemDefinition("gale_plume", DEFAULT_HARVEST_DURATION_MS),
  heartsap: itemDefinition("heartsap", DEFAULT_HARVEST_DURATION_MS),
  wyrm_egg: itemDefinition("wyrm_egg", DEFAULT_HARVEST_DURATION_MS),
  dragon_scale: itemDefinition("dragon_scale", DEFAULT_HARVEST_DURATION_MS),
  maw_bloom_petal: itemDefinition("maw_bloom_petal", DEFAULT_HARVEST_DURATION_MS),
  refined_oil: itemDefinition("refined_oil", DEFAULT_HARVEST_DURATION_MS),
  crystal: itemDefinition("crystal", DEFAULT_HARVEST_DURATION_MS),
  pearl: itemDefinition("pearl", DEFAULT_HARVEST_DURATION_MS),
  bricks: itemDefinition("bricks", DEFAULT_HARVEST_DURATION_MS),
  atlas_shrine_shard: itemDefinition("atlas_shrine_shard", DEFAULT_HARVEST_DURATION_MS),
  lichen: itemDefinition("lichen", DEFAULT_HARVEST_DURATION_MS),
  thistle: itemDefinition("thistle", DEFAULT_HARVEST_DURATION_MS),
  umbral_essence: itemDefinition("umbral_essence", DEFAULT_HARVEST_DURATION_MS),
  dusk_heart: itemDefinition("dusk_heart", DEFAULT_HARVEST_DURATION_MS),
  bloom_petal: itemDefinition("bloom_petal", DEFAULT_HARVEST_DURATION_MS),
  gearwork_essence: itemDefinition("gearwork_essence", DEFAULT_HARVEST_DURATION_MS),
  gale_splinter: itemDefinition("gale_splinter", DEFAULT_HARVEST_DURATION_MS),
  griffin_plume: itemDefinition("griffin_plume", DEFAULT_HARVEST_DURATION_MS),
  edict_seal: itemDefinition("edict_seal", DEFAULT_HARVEST_DURATION_MS),
  skyrise_stone: itemDefinition("skyrise_stone", DEFAULT_HARVEST_DURATION_MS),
  mist_drop: itemDefinition("mist_drop", DEFAULT_HARVEST_DURATION_MS),
  revenant_bar: itemDefinition("revenant_bar", DEFAULT_HARVEST_DURATION_MS),
  expel_bar: itemDefinition("expel_bar", DEFAULT_HARVEST_DURATION_MS),
  mirage_bar: itemDefinition("mirage_bar", DEFAULT_HARVEST_DURATION_MS),
  gale_bar: itemDefinition("gale_bar", DEFAULT_HARVEST_DURATION_MS),
  fleet_bar: itemDefinition("fleet_bar", DEFAULT_HARVEST_DURATION_MS),
  whetted_bar: itemDefinition("whetted_bar", DEFAULT_HARVEST_DURATION_MS),
  vengeance_bar: itemDefinition("vengeance_bar", DEFAULT_HARVEST_DURATION_MS),
  gloom_bar: itemDefinition("gloom_bar", DEFAULT_HARVEST_DURATION_MS),
  skyrise_bar: itemDefinition("skyrise_bar", DEFAULT_HARVEST_DURATION_MS),
  vital_bar: itemDefinition("vital_bar", DEFAULT_HARVEST_DURATION_MS),
  enchantment_stone: itemDefinition("enchantment_stone", DEFAULT_HARVEST_DURATION_MS),
  lumen: itemDefinition("lumen", DEFAULT_HARVEST_DURATION_MS),
  gift_box: itemDefinition("gift_box", DEFAULT_HARVEST_DURATION_MS),
  manor_skin: itemDefinition("manor_skin", DEFAULT_HARVEST_DURATION_MS),
  face_mask: itemDefinition("face_mask", DEFAULT_HARVEST_DURATION_MS),
  shellback_plate: itemDefinition("shellback_plate", DEFAULT_HARVEST_DURATION_MS),
  abyssal_orb: itemDefinition("abyssal_orb", DEFAULT_HARVEST_DURATION_MS),
  ring_shard: itemDefinition("ring_shard", DEFAULT_HARVEST_DURATION_MS),
  forge_spark: itemDefinition("forge_spark", DEFAULT_HARVEST_DURATION_MS),
  shard_grit: itemDefinition("shard_grit", DEFAULT_HARVEST_DURATION_MS),
  amulet_clasp: itemDefinition("amulet_clasp", DEFAULT_HARVEST_DURATION_MS),
  frog_legs: itemDefinition("frog_legs", DEFAULT_HARVEST_DURATION_MS),
  frost_frog_legs: itemDefinition("frost_frog_legs", DEFAULT_HARVEST_DURATION_MS),
  poison_frog_legs: itemDefinition("poison_frog_legs", DEFAULT_HARVEST_DURATION_MS),
  desert_toad_legs: itemDefinition("desert_toad_legs", DEFAULT_HARVEST_DURATION_MS),
  crab_meat: itemDefinition("crab_meat", DEFAULT_HARVEST_DURATION_MS),
  ice_crab_meat: itemDefinition("ice_crab_meat", DEFAULT_HARVEST_DURATION_MS),
  sand_crab_meat: itemDefinition("sand_crab_meat", DEFAULT_HARVEST_DURATION_MS),
  mangrove_crab_meat: itemDefinition("mangrove_crab_meat", DEFAULT_HARVEST_DURATION_MS),
  small_catch: itemDefinition("small_catch", DEFAULT_HARVEST_DURATION_MS),
  jellyfish_jelly: itemDefinition("jellyfish_jelly", DEFAULT_HARVEST_DURATION_MS),
  crawler_flesh: itemDefinition("crawler_flesh", DEFAULT_HARVEST_DURATION_MS),
  squid_cut: itemDefinition("squid_cut", DEFAULT_HARVEST_DURATION_MS),
  wolf_cut: itemDefinition("wolf_cut", DEFAULT_HARVEST_DURATION_MS),
  frost_wolf_cut: itemDefinition("frost_wolf_cut", DEFAULT_HARVEST_DURATION_MS),
  dune_wolf_cut: itemDefinition("dune_wolf_cut", DEFAULT_HARVEST_DURATION_MS),
  jungle_wolf_cut: itemDefinition("jungle_wolf_cut", DEFAULT_HARVEST_DURATION_MS),
  bog_wolf_cut: itemDefinition("bog_wolf_cut", DEFAULT_HARVEST_DURATION_MS),
  deer_cut: itemDefinition("deer_cut", DEFAULT_HARVEST_DURATION_MS),
  frost_deer_cut: itemDefinition("frost_deer_cut", DEFAULT_HARVEST_DURATION_MS),
  jungle_deer_cut: itemDefinition("jungle_deer_cut", DEFAULT_HARVEST_DURATION_MS),
  marsh_deer_cut: itemDefinition("marsh_deer_cut", DEFAULT_HARVEST_DURATION_MS),
  sand_deer_cut: itemDefinition("sand_deer_cut", DEFAULT_HARVEST_DURATION_MS),
  hog_cut: itemDefinition("hog_cut", DEFAULT_HARVEST_DURATION_MS),
  woolly_hog_cut: itemDefinition("woolly_hog_cut", DEFAULT_HARVEST_DURATION_MS),
  warthog_cut: itemDefinition("warthog_cut", DEFAULT_HARVEST_DURATION_MS),
  jungle_hog_cut: itemDefinition("jungle_hog_cut", DEFAULT_HARVEST_DURATION_MS),
  mud_hog_cut: itemDefinition("mud_hog_cut", DEFAULT_HARVEST_DURATION_MS),
  javelina_cut: itemDefinition("javelina_cut", DEFAULT_HARVEST_DURATION_MS),
  alligator_tail: itemDefinition("alligator_tail", DEFAULT_HARVEST_DURATION_MS),
  caiman_tail: itemDefinition("caiman_tail", DEFAULT_HARVEST_DURATION_MS),
  crocodile_tail: itemDefinition("crocodile_tail", DEFAULT_HARVEST_DURATION_MS),
  bear_cut: itemDefinition("bear_cut", DEFAULT_HARVEST_DURATION_MS),
  snow_bear_cut: itemDefinition("snow_bear_cut", DEFAULT_HARVEST_DURATION_MS),
  black_bear_cut: itemDefinition("black_bear_cut", DEFAULT_HARVEST_DURATION_MS),
  sun_bear_cut: itemDefinition("sun_bear_cut", DEFAULT_HARVEST_DURATION_MS),
  jungle_tapir_cut: itemDefinition("jungle_tapir_cut", DEFAULT_HARVEST_DURATION_MS),
  jaguar_cut: itemDefinition("jaguar_cut", DEFAULT_HARVEST_DURATION_MS),
  mandrill_cut: itemDefinition("mandrill_cut", DEFAULT_HARVEST_DURATION_MS),
  capercaillie_meat: itemDefinition("capercaillie_meat", DEFAULT_HARVEST_DURATION_MS),
  elk_cut: itemDefinition("elk_cut", DEFAULT_HARVEST_DURATION_MS),
  red_squirrel_cut: itemDefinition("red_squirrel_cut", DEFAULT_HARVEST_DURATION_MS),
  badger_cut: itemDefinition("badger_cut", DEFAULT_HARVEST_DURATION_MS),
  grey_squirrel_cut: itemDefinition("grey_squirrel_cut", DEFAULT_HARVEST_DURATION_MS),
  stag_beetle_cut: itemDefinition("stag_beetle_cut", DEFAULT_HARVEST_DURATION_MS),
  great_grey_owl_meat: itemDefinition("great_grey_owl_meat", DEFAULT_HARVEST_DURATION_MS),
  flying_squirrel_cut: itemDefinition("flying_squirrel_cut", DEFAULT_HARVEST_DURATION_MS),
  plains_bison_cut: itemDefinition("plains_bison_cut", DEFAULT_HARVEST_DURATION_MS),
  prairie_dog_cut: itemDefinition("prairie_dog_cut", DEFAULT_HARVEST_DURATION_MS),
  burrowing_owl_meat: itemDefinition("burrowing_owl_meat", DEFAULT_HARVEST_DURATION_MS),
  giraffe_cut: itemDefinition("giraffe_cut", DEFAULT_HARVEST_DURATION_MS),
  lioness_cut: itemDefinition("lioness_cut", DEFAULT_HARVEST_DURATION_MS),
  spotted_hyena_cut: itemDefinition("spotted_hyena_cut", DEFAULT_HARVEST_DURATION_MS),
  sitatunga_cut: itemDefinition("sitatunga_cut", DEFAULT_HARVEST_DURATION_MS),
  emperor_dragonfly_cut: itemDefinition("emperor_dragonfly_cut", DEFAULT_HARVEST_DURATION_MS),
  mountain_ibex_cut: itemDefinition("mountain_ibex_cut", DEFAULT_HARVEST_DURATION_MS),
  wild_yak_cut: itemDefinition("wild_yak_cut", DEFAULT_HARVEST_DURATION_MS),
  alpine_marmot_cut: itemDefinition("alpine_marmot_cut", DEFAULT_HARVEST_DURATION_MS),
  wild_scrub_goat_cut: itemDefinition("wild_scrub_goat_cut", DEFAULT_HARVEST_DURATION_MS),
  crested_porcupine_cut: itemDefinition("crested_porcupine_cut", DEFAULT_HARVEST_DURATION_MS),
  spur_thighed_tortoise_cut: itemDefinition("spur_thighed_tortoise_cut", DEFAULT_HARVEST_DURATION_MS),
  dromedary_cut: itemDefinition("dromedary_cut", DEFAULT_HARVEST_DURATION_MS),
  fennec_fox_cut: itemDefinition("fennec_fox_cut", DEFAULT_HARVEST_DURATION_MS),
  sidewinder_cut: itemDefinition("sidewinder_cut", DEFAULT_HARVEST_DURATION_MS),
  field_hare_cut: itemDefinition("field_hare_cut", DEFAULT_HARVEST_DURATION_MS),
  arctic_hare_cut: itemDefinition("arctic_hare_cut", DEFAULT_HARVEST_DURATION_MS),
  capybara_cut: itemDefinition("capybara_cut", DEFAULT_HARVEST_DURATION_MS),
  armadillo_cut: itemDefinition("armadillo_cut", DEFAULT_HARVEST_DURATION_MS),
  red_fox_cut: itemDefinition("red_fox_cut", DEFAULT_HARVEST_DURATION_MS),
  wolverine_cut: itemDefinition("wolverine_cut", DEFAULT_HARVEST_DURATION_MS),
  ostrich_cut: itemDefinition("ostrich_cut", DEFAULT_HARVEST_DURATION_MS),
  golden_eagle_cut: itemDefinition("golden_eagle_cut", DEFAULT_HARVEST_DURATION_MS),
  musk_ox_cut: itemDefinition("musk_ox_cut", DEFAULT_HARVEST_DURATION_MS),
  seal_cut: itemDefinition("seal_cut", DEFAULT_HARVEST_DURATION_MS),
  desert_lion_cut: itemDefinition("desert_lion_cut", DEFAULT_HARVEST_DURATION_MS),
  saiga_cut: itemDefinition("saiga_cut", DEFAULT_HARVEST_DURATION_MS),
  wild_horse_cut: itemDefinition("wild_horse_cut", DEFAULT_HARVEST_DURATION_MS),
  steppe_marmot_cut: itemDefinition("steppe_marmot_cut", DEFAULT_HARVEST_DURATION_MS),
  lemming_cut: itemDefinition("lemming_cut", DEFAULT_HARVEST_DURATION_MS),
  snow_goose_meat: itemDefinition("snow_goose_meat", DEFAULT_HARVEST_DURATION_MS),
  mammoth_cut: itemDefinition("mammoth_cut", DEFAULT_HARVEST_DURATION_MS),
  dire_wolf_cut: itemDefinition("dire_wolf_cut", DEFAULT_HARVEST_DURATION_MS),
  drake_cut: itemDefinition("drake_cut", DEFAULT_HARVEST_DURATION_MS),
  dragon_cut: itemDefinition("dragon_cut", DEFAULT_HARVEST_DURATION_MS),
  grub_meat: itemDefinition("grub_meat", DEFAULT_HARVEST_DURATION_MS),
  emperor_penguin_meat: itemDefinition("emperor_penguin_meat", DEFAULT_HARVEST_DURATION_MS),
  peary_caribou_cut: itemDefinition("peary_caribou_cut", DEFAULT_HARVEST_DURATION_MS),
  ice_worm_cut: itemDefinition("ice_worm_cut", DEFAULT_HARVEST_DURATION_MS),
  sea_otter_cut: itemDefinition("sea_otter_cut", DEFAULT_HARVEST_DURATION_MS),
  herring_gull_meat: itemDefinition("herring_gull_meat", DEFAULT_HARVEST_DURATION_MS),
  spiny_lobster_tail: itemDefinition("spiny_lobster_tail", DEFAULT_HARVEST_DURATION_MS),
  hammerhead_shark_steak: itemDefinition("hammerhead_shark_steak", DEFAULT_HARVEST_DURATION_MS),
  manta_ray_wing: itemDefinition("manta_ray_wing", DEFAULT_HARVEST_DURATION_MS),
  humpback_whale_cut: itemDefinition("humpback_whale_cut", DEFAULT_HARVEST_DURATION_MS),
  muskellunge_fillet: itemDefinition("muskellunge_fillet", DEFAULT_HARVEST_DURATION_MS),
  mute_swan_meat: itemDefinition("mute_swan_meat", DEFAULT_HARVEST_DURATION_MS),
  pike_fillet: itemDefinition("pike_fillet", DEFAULT_HARVEST_DURATION_MS),
  snapping_turtle_cut: itemDefinition("snapping_turtle_cut", DEFAULT_HARVEST_DURATION_MS),
  beaver_cut: itemDefinition("beaver_cut", DEFAULT_HARVEST_DURATION_MS),
  otter_cut: itemDefinition("otter_cut", DEFAULT_HARVEST_DURATION_MS),
  salmon_fillet: itemDefinition("salmon_fillet", DEFAULT_HARVEST_DURATION_MS),
  elemental_ration: itemDefinition("elemental_ration", DEFAULT_HARVEST_DURATION_MS),
  scorching_bird_meat: itemDefinition("scorching_bird_meat", DEFAULT_HARVEST_DURATION_MS),
  zappy_bird_meat: itemDefinition("zappy_bird_meat", DEFAULT_HARVEST_DURATION_MS),
  freezing_bird_meat: itemDefinition("freezing_bird_meat", DEFAULT_HARVEST_DURATION_MS),
  field_ration: itemDefinition("field_ration", DEFAULT_HARVEST_DURATION_MS),
  hearty_ration: itemDefinition("hearty_ration", DEFAULT_HARVEST_DURATION_MS),
  xoral_essence: itemDefinition("xoral_essence", DEFAULT_HARVEST_DURATION_MS),
  ...Object.fromEntries(MOB_DROP_ITEM_IDS.map((itemId) => [
    itemId,
    itemDefinition(itemId, DEFAULT_HARVEST_DURATION_MS)
  ]))
} as unknown) as Readonly<Record<ResourceType, ItemDefinition>> & Readonly<{ fishing_rod: ItemDefinition }>;

export const COMPILED_ITEM_DEFINITIONS: ReadonlyMap<string, CompiledItemDefinition> = new Map(
  Object.values(INVENTORY_CATALOG).map((catalog) => [
    catalog.itemId,
    compiledDefinition(catalog)
  ])
);

// Historical item rows remain in PostgreSQL for FK-safe audit/replay history
// after a forward retirement migration, but are no longer runtime catalog
// entries and must not prevent the active catalog from starting.
const RETIRED_ITEM_DEFINITION_IDS = new Set([
  "demolition_charge",
  "deer_carcass",
  "wolf_carcass",
  "hog_carcass",
  "bear_carcass",
  "alligator_carcass",
  "wild_carcass"
]);

let runtimeItemDefinitions: ReadonlyMap<string, CompiledItemDefinition> =
  COMPILED_ITEM_DEFINITIONS;

export function requireItemDefinition(itemId: string): ItemDefinition {
  const compiled = runtimeItemDefinitions.get(itemId);
  const harvestDurationMs = ITEM_DEFINITIONS[itemId as ResourceType]?.harvestDurationMs;
  if (!compiled || harvestDurationMs === undefined || compiled.itemId !== itemId) {
    throw new Error(`Unknown inventory item: ${itemId}`);
  }
  return { ...compiled, itemId: itemId as ResourceType, harvestDurationMs } as ItemDefinition;
}

export function requireRuntimeItemDefinition(itemId: string): CompiledItemDefinition {
  const definition = runtimeItemDefinitions.get(itemId);
  if (!definition || definition.itemId !== itemId) {
    throw new Error(`Unknown inventory item: ${itemId}`);
  }
  return definition;
}

export function supportsInventoryItemVariant(itemId: string, variant: string): boolean {
  const definition = runtimeItemDefinitions.get(itemId);
  if (!definition || definition.itemId !== itemId) return false;
  if (itemId === "seed" || itemId === "produce") {
    return greenhouseCropSupportsInventoryIdentity(itemId, variant);
  }
  // Masks and Manor skins are per-copy items (1202): the variant is the copy id; the database
  // refuses an unknown copy or a stacked copy.
  if (isShopCopyItemId(itemId)) return isShopCopyId(variant);
  return definition.supportedVariants.includes(variant);
}

export function collectibleReward(
  resourceType: ResourceType,
  quantity: number
): InventoryGrant {
  const definition = requireItemDefinition(resourceType);
  if (!Number.isSafeInteger(quantity) || quantity <= 0) {
    throw new Error("Inventory grant quantity must be a positive integer");
  }
  return {
    itemId: definition.itemId,
    variant: null,
    quantity
  };
}

export function collectibleHarvestDurationMs(resourceType: ResourceType | string): number {
  return ITEM_DEFINITIONS[resourceType as ResourceType]?.harvestDurationMs ?? DEFAULT_HARVEST_DURATION_MS;
}
/**
 * PostgreSQL owns runtime stack policy. Other gameplay metadata remains a
 * compiled contract and startup refuses traffic if that contract drifts.
 */
export async function validateItemDefinitionCatalog(queryable: Pick<pg.Pool | pg.PoolClient, "query">): Promise<void> {
  // Manor skins are the one data-driven variant list: every shipped Manor type
  // (except the default) is a skin variant, so a Studio-made type needs no
  // migration. Keep the row in step before the contract check below.
  await queryable.query(
    `UPDATE item_definitions SET supported_variants=$1::text[], updated_at=now()
     WHERE item_id=$2 AND supported_variants IS DISTINCT FROM $1::text[]`,
    [[...MANOR_SKIN_VARIANTS], MANOR_SKIN_ITEM_ID]
  );
  const result = await queryable.query<{
    item_id: string;
    unit_weight_grams: number;
    display_name: string;
    category: string;
    equipment_family_id: string | null;
    equipment_role: string | null;
    rarity: ItemRarity;
    stackable: boolean;
    max_stack: number | null;
    market_tradable: boolean;
    market_fungible: boolean;
    market_identity: string | null;
    droppable: boolean;
    manor_storable: boolean;
    supported_variants: string[];
  }>(`SELECT item_id, display_name, unit_weight_grams, category, equipment_family_id, equipment_role, rarity,
      stackable, max_stack,
      droppable, manor_storable, market_tradable, market_fungible,
      market_identity, supported_variants
   FROM item_definitions
   ORDER BY item_id`);
  // The Glimmer row only anchors its order book (0917); it is never a
  // runtime inventory item, so inventory paths keep rejecting it.
  const liveRows = result.rows.filter((row) =>
    !RETIRED_ITEM_DEFINITION_IDS.has(row.item_id) &&
    !(row.category === "currency" && premiumCurrencyForMarketItem(row.item_id))
  );
  const databaseIds = new Set(liveRows.map((row) => row.item_id));
  const compiledIds = new Set(COMPILED_ITEM_DEFINITIONS.keys());
  const missing = [...compiledIds].filter((itemId) => !databaseIds.has(itemId));
  const unexpected = [...databaseIds].filter((itemId) => !compiledIds.has(itemId));
  const mismatches: string[] = [];
  const invalidStackPolicies: string[] = [];
  const nextRuntimeDefinitions = new Map<string, CompiledItemDefinition>();
  for (const row of liveRows) {
    const compiled = COMPILED_ITEM_DEFINITIONS.get(row.item_id);
    if (!compiled)
      continue;
    const actual = {
      itemId: row.item_id,
      unitWeightGrams: row.unit_weight_grams,
      displayName: row.display_name,
      category: row.category,
      equipmentFamilyId: row.equipment_family_id,
      equipmentRole: row.equipment_role,
      rarity: row.rarity,
      droppable: row.droppable,
      manorStorable: row.manor_storable,
      marketTradable: row.market_tradable,
      marketFungible: row.market_fungible,
      marketIdentity: row.market_identity,
      supportedVariants: [...row.supported_variants].sort()
    };
    const expected = {
      itemId: compiled.itemId,
      unitWeightGrams: compiled.unitWeightGrams,
      displayName: compiled.displayName,
      category: compiled.category,
      equipmentFamilyId: compiled.equipmentFamilyId,
      equipmentRole: compiled.equipmentRole,
      rarity: compiled.rarity,
      droppable: compiled.droppable,
      manorStorable: compiled.manorStorable,
      marketTradable: compiled.marketTradable,
      marketFungible: compiled.marketFungible,
      marketIdentity: compiled.marketIdentity,
      supportedVariants: [...compiled.supportedVariants].sort()
    };
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      mismatches.push(row.item_id);
    if (!Number.isSafeInteger(row.max_stack) ||
      row.max_stack === null ||
      row.max_stack <= 0 ||
      (!row.stackable && row.max_stack !== 1)) {
      invalidStackPolicies.push(row.item_id);
      continue;
    }
    nextRuntimeDefinitions.set(row.item_id, {
      ...compiled,
      stackable: row.stackable,
      maxStack: row.max_stack
    });
  }
  if (missing.length > 0 ||
    unexpected.length > 0 ||
    mismatches.length > 0 ||
    invalidStackPolicies.length > 0) {
    throw new Error(`Item definition catalog mismatch (missing=${missing.join(",") || "none"}; ` +
      `unexpected=${unexpected.join(",") || "none"}; mismatched=${mismatches.join(",") || "none"}; ` +
      `invalidStackPolicy=${invalidStackPolicies.join(",") || "none"})`);
  }
  const levels = await queryable.query<{
    level: number;
    capacity_bonus_grams: string;
    leather_cost: string;
    gold_cost: string;
    effects: unknown;
  }>('SELECT level,capacity_bonus_grams::text,leather_cost::text,gold_cost::text,effects FROM backpack_level_definitions ORDER BY level');
  if (levels.rows.length !== BACKPACK_LEVELS.length || levels.rows.some((row, index) => {
    const expected = BACKPACK_LEVELS[index]!;
    return row.level !== expected.level || row.capacity_bonus_grams !== String(expected.capacityBonusGrams) ||
      row.leather_cost !== String(expected.upgradeCost.leather) || row.gold_cost !== String(expected.upgradeCost.gold) ||
      JSON.stringify(row.effects) !== JSON.stringify(expected.effects);
  }))
    throw new Error('Backpack level catalog mismatch');
  const rules = await queryable.query<{
    default_base_capacity_grams: string;
    backpack_unit_weight_grams: number;
  }>("SELECT default_base_capacity_grams::text, backpack_unit_weight_grams FROM inventory_carry_rules");
  if (rules.rows.length !== 1 ||
    rules.rows[0]!.default_base_capacity_grams !== String(DEFAULT_PLAYER_CARRY_CAPACITY_GRAMS) ||
    rules.rows[0]!.backpack_unit_weight_grams !== BACKPACK_WEIGHT_GRAMS) {
    throw new Error("Inventory carry rules mismatch");
  }
  runtimeItemDefinitions = nextRuntimeDefinitions;
}

function itemDefinition(itemId: ResourceType, harvestDurationMs: number): ItemDefinition {
  const catalog = INVENTORY_CATALOG[itemId]!;
  return {
    itemId,
    displayName: catalog.displayName,
    unitWeightGrams: getItemWeightGrams(catalog.itemId),
    category: catalog.category as "resource" | "consumable" | "currency",
    equipmentFamilyId: null,
    equipmentRole: null,
    rarity: catalog.rarity,
    stackable: catalog.stackable,
    maxStack: catalog.maxStack,
    droppable: catalog.droppable,
    manorStorable: catalog.manorStorable,
    harvestDurationMs,
    marketTradable: catalog.marketTradable,
    marketFungible: catalog.marketFungible,
    marketIdentity: catalog.marketIdentity,
    supportedVariants: catalog.supportedVariants
  };
}

function compiledDefinition(catalog: InventoryCatalogItem): CompiledItemDefinition {
  const resource = ITEM_DEFINITIONS[catalog.itemId as ResourceType];
  if (resource)
    return resource;
  return {
    itemId: catalog.itemId,
    displayName: catalog.displayName,
    unitWeightGrams: getItemWeightGrams(catalog.itemId),
    category: catalog.kind,
    equipmentFamilyId: catalog.equipmentFamilyId,
    equipmentRole: catalog.equipmentRole,
    rarity: catalog.rarity,
    stackable: catalog.stackable,
    maxStack: catalog.maxStack,
    droppable: catalog.droppable,
    manorStorable: catalog.manorStorable,
    marketTradable: catalog.marketTradable,
    marketFungible: catalog.marketFungible,
    marketIdentity: catalog.marketIdentity,
    supportedVariants: catalog.supportedVariants
  };
}
