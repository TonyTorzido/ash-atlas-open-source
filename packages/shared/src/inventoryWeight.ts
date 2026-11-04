import { INVENTORY_CATALOG } from './inventoryCatalog.js';
import { MOB_DROP_ITEMS } from './mobDropItems.js';
/** Integer grams are the authority; kilograms are presentation only. */
export const DEFAULT_PLAYER_CARRY_CAPACITY_GRAMS = 1_000_000;
export const MANOR_STORAGE_CAPACITY_GRAMS = 10_000_000;
export const CITY_WAREHOUSE_CAPACITY_GRAMS = 1_000_000;
export const LEGACY_CAPACITY_GRAMS_PER_SLOT = 2500;
/** Backpacks are utility capacity, not carried cargo; their own weight is zero. */
export const BACKPACK_WEIGHT_GRAMS = 0;
/** Provisional gameplay weights. Balance changes belong here and in a forward catalog migration. */
const RESOURCE_WEIGHTS: Readonly<Record<string, number>> = Object.freeze({
  wood: 100,
  stone: 250,
  coal: 200,
  iron: 250,
  sulfur: 200,
  slag: 250,
  ore: 250,
  iron_bar: 500,
  venomsteel_bar: 500,
  venomsteel_core: 250,
  fire_feather: 10,
  tempest_quill: 10,
  ice_feather: 10,
  fire_bar: 500,
  lightning_bar: 500,
  ice_bar: 500,
  fire_core: 250,
  lightning_core: 250,
  ice_core: 250,
  water: 250,
  // Seeds are intentionally nearly weightless so greenhouse farming does not
  // consume a meaningful share of the player's carried capacity.
  seed: 1,
  wheat_seed: 1,
  produce: 250,
  food: 250,
  bone: 100,
  fertilizer: 250,
  flux_plant: 25,
  simple_food: 250,
  flax_fiber: 25,
  cloth: 100,
  leather: 100,
  deer_hide: 500,
  hog_hide: 500,
  wolf_pelt: 500,
  bear_hide: 1000,
  alligator_hide: 1000,
  squid_flesh: 250,
  crab_carapace: 100,
  raw_meat: 250,
  shell: 25,
  chitin: 25,
  giving_berry: 25,
  balsam_resin: 25,
  repair_kit: 500,
  torch: 200,
  shovel: 2000,
  crude_oil: 250,
  jellyfish_venom: 10,
  brood_silk: 10,
  raptor_scale: 10,
  giant_egg: 10,
  brood_egg: 10,
  clutch_egg: 10,
  crawler_egg: 10,
  broken_whistle: 10,
  bonewrought_blade: 10,
  bonewrought_mail: 10,
  survey_stake_kit: 10,
  compass: 1000,
  lamp_sheath: 10,
  cinder_lantern: 10,
  challengers_lantern: 10,
  anti_venom_tonic: 100,
  battle_draught: 100,
  ember_flask: 100,
  spark_tonic: 100,
  field_net: 500,
  field_trap: 1000,
  tidewater_draught: 100,
  undertow_snare: 1000,
  stillwater_orb: 200,
  free_step_ward: 300,
  masons_tome: 500,
  vigor_serum: 100,
  mending_resin: 100,
  loadout_scroll: 50,
  elder_acorn: 10,
  prison_key_fragment: 5,
  giving_tree_sapling: 500,
  zephyr: 10,
  cave_lichen: 10,
  gale_plume: 10,
  heartsap: 10,
  wyrm_egg: 10,
  dragon_scale: 10,
  maw_bloom_petal: 10,
  refined_oil: 250,
  // Bricks are carried by the hundreds between obelisk land and the treasury.
  bricks: 10,
  // Crystal matches Crude Oil: both come from a 10/h city producer.
  crystal: 250,
  // Pearl matches Jellyfish Venom, its sibling drop.
  pearl: 10,
  atlas_shrine_shard: 50,
  lichen: 10,
  thistle: 10,
  umbral_essence: 10,
  dusk_heart: 10,
  bloom_petal: 10,
  gearwork_essence: 5,
  gale_splinter: 5,
  griffin_plume: 10,
  edict_seal: 5,
  skyrise_stone: 100,
  mist_drop: 2,
  revenant_bar: 500,
  expel_bar: 500,
  mirage_bar: 500,
  gale_bar: 500,
  fleet_bar: 500,
  whetted_bar: 500,
  vengeance_bar: 500,
  gloom_bar: 500,
  skyrise_bar: 500,
  vital_bar: 500,
  enchantment_stone: 50,
  // Currency: weightless, so carried Lumen never counts against capacity.
  lumen: 0,
  gift_box: 100,
  manor_skin: 100,
  face_mask: 100,
  shellback_plate: 250,
  abyssal_orb: 100,
  ring_shard: 1,
  forge_spark: 5,
  shard_grit: 1,
  amulet_clasp: 5,
  deer_carcass: 12000,
  wolf_carcass: 10000,
  hog_carcass: 20000,
  bear_carcass: 35000,
  alligator_carcass: 30000,
  wild_carcass: 15000,
  ...Object.fromEntries(Object.values(MOB_DROP_ITEMS).map((item) => [item.itemId, item.unitWeightGrams]))
});
export const ITEM_WEIGHT_GRAMS: Readonly<Record<string, number>> = Object.freeze(
  Object.fromEntries(Object.values(INVENTORY_CATALOG).map((item) => [
    item.itemId,
    RESOURCE_WEIGHTS[item.itemId] ?? (
      item.kind === "equipment" ? (item.category === "ring" ? 50 : 1500) : 250
    )
  ]))
);


export function getItemWeightGrams(itemId: string): number {
  const grams = ITEM_WEIGHT_GRAMS[itemId] ?? RESOURCE_WEIGHTS[itemId];
  if (grams === undefined) {
    throw new Error("Unknown item weight: " + itemId);
  }
  return grams;
}

export function getBackpackWeightGrams(): number {
  return BACKPACK_WEIGHT_GRAMS;
}

export function formatWeightKg(value: string | bigint | number): string {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) {
    throw new Error('Weight must be nonnegative integer grams');
  }
  const grams = BigInt(value);
  if (grams < 0n) {
    throw new Error("Weight must be nonnegative integer grams");
  }
  const fraction = (grams % 1000n).toString().padStart(3, '0').replace(/0+$/u, '');
  return (grams / 1000n).toLocaleString('en-US') + (fraction ? '.' + fraction : '');
}
