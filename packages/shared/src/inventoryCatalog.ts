import {
  EQUIPMENT_DEFINITIONS,
  type EquipmentDefinitionId,
  type EquipmentGameplayFamilyId,
  type EquipmentItemRole
} from "./equipment.js";
import {
  INVENTORY_STACK_LIMITS,
  type InventoryItemType,
  type ResourceType
} from "./collectibles.js";
import { FIELD_CONSUMABLE_DESCRIPTIONS } from "./fieldConsumables.js";
import { LOADOUT_SCROLL_DESCRIPTION, LOADOUT_SCROLL_DISPLAY_NAME } from "./gearScrolls.js";
import { ENCHANTMENT_STONE_VARIANTS } from "./progression.js";
import { FACE_MASK_VARIANTS } from "./faceMasks.js";
import { MANOR_SKIN_VARIANTS } from "./manorSkins.js";
import { MOB_DROP_ITEMS, type MobDropItemId } from "./mobDropItems.js";
import {
  UNIVERSAL_FOOD_ITEMS,
  type UniversalFoodItemId
} from "./universalFood.js";

export type InventoryCatalogKind = "resource" | "consumable" | "equipment";

export const ITEM_RARITIES = [
  "common",
  "uncommon",
  "rare",
  "epic",
  "legendary"
] as const;
export type ItemRarity = (typeof ITEM_RARITIES)[number];

/**
 * Inventory list groups. The inventory collapses a group into one row once the
 * player holds more than 4 kinds of it. The first six are in use; the rest are
 * reserved for new items (each has its icon in assets/items/groups).
 */
export const INVENTORY_ITEM_GROUP_IDS = [
  "meat",
  "hides",
  "feathers",
  "bars",
  "ores",
  "food",
  "bones",
  "scales",
  "venoms",
  "essences",
  "gems",
  "plants",
  "trinkets",
  "trophies",
  "eggs",
  "fish"
] as const;
export type InventoryItemGroupId = (typeof INVENTORY_ITEM_GROUP_IDS)[number];

export type InventoryCatalogItem = Readonly<{
  itemId: InventoryItemType | EquipmentDefinitionId;
  kind: InventoryCatalogKind;
  displayName: string;
  description?: string;
  /** Inventory list group; ungrouped when absent. */
  inventoryGroup?: InventoryItemGroupId;
  category: string;
  equipmentFamilyId: EquipmentGameplayFamilyId | null;
  equipmentRole: EquipmentItemRole | null;
  iconKey: string;
  rarity: ItemRarity;
  stackable: boolean;
  maxStack: number;
  droppable: boolean;
  manorStorable: boolean;
  marketTradable: boolean;
  marketFungible: boolean;
  marketIdentity: string | null;
  supportedVariants: readonly string[];
  packageGrantable: boolean;
}>;

const RESOURCE_CATALOG = {
  wood: resource("wood", "Wood", { marketTradable: true }),
  stone: resource("stone", "Stone", { group: "ores", marketTradable: true }),
  coal: resource("coal", "Coal", { group: "ores", marketTradable: false }),
  iron: resource("iron", "Iron Ore", { group: "ores", marketTradable: false }),
  sulfur: resource("sulfur", "Sulfur", {
    group: "ores",
    marketTradable: true,
    description: "A volatile yellow mineral used in explosives and advanced industrial crafting."
  }),
  slag: resource("slag", "Slag", {
    group: "ores",
    marketTradable: false,
    description: "A recoverable smelting byproduct. Refine it through Metallurgy to recover Iron Bars."
  }),
  iron_bar: resource("iron_bar", "Iron Bar", { group: "bars", marketTradable: false }),
  venomsteel_bar: resource("venomsteel_bar", "Venom Bar", { group: "bars", marketTradable: true }),
  venomsteel_core: resource("venomsteel_core", "Venom Core", {
    group: "bars",
    marketTradable: true,
    stackable: false,
    maxStack: 1
  }),
  fire_feather: legendary("fire_feather", "Ember Feather", "feathers"),
  tempest_quill: legendary("tempest_quill", "Tempest Quill", "feathers"),
  ice_feather: legendary("ice_feather", "Frost Feather", "feathers"),
  fire_bar: resource("fire_bar", "Ember Bar", { group: "bars", marketTradable: true, rarity: "legendary" }),
  fire_core: legendary("fire_core", "Ember Core", "bars"),
  lightning_bar: resource("lightning_bar", "Storm Bar", { group: "bars", marketTradable: true, rarity: "legendary" }),
  lightning_core: legendary("lightning_core", "Storm Core", "bars"),
  ice_bar: resource("ice_bar", "Frost Bar", { group: "bars", marketTradable: true, rarity: "legendary" }),
  ice_core: legendary("ice_core", "Frost Core", "bars"),
  food: resource("food", "Food", { group: "food", marketTradable: false, packageGrantable: false }),
  bone: resource("bone", "Bone", {
    marketTradable: false,
    packageGrantable: false,
    description: "A sturdy bone dropped by a defeated Skeleton."
  }),
  fertilizer: resource("fertilizer", "Fertilizer", {
    marketTradable: false,
    packageGrantable: true,
    description: "A prepared greenhouse growing medium."
  }),
  flux_plant: resource("flux_plant", "Flux Plant", {
    marketTradable: false,
    packageGrantable: false,
    description: "A greenhouse crafting plant reserved for Fertilizer."
  }),
  simple_food: resource("simple_food", "Simple Food", {
    group: "food",
    kind: "consumable",
    marketTradable: true,
    description: "Basic cooked food. Restores Hunger but provides no additional benefits."
  }),
  freshwater_fish: resource("freshwater_fish", "Freshwater Fish", {
    marketTradable: true,
    description: "A whole freshwater fish. Cook 10 at a Kitchen to make 1 Simple Food."
  }),
  // Legacy id kept so stored holdings still resolve; it presents as an ordinary fish.
  ashen_fish: resource("ashen_fish", "Freshwater Fish", {
    marketTradable: true,
    packageGrantable: false,
    description: "A whole freshwater fish."
  }),
  fishing_rod: resource("fishing_rod" as ResourceType, "Fishing Rod", {
    stackable: false,
    maxStack: 1,
    droppable: false,
    marketTradable: true,
    marketFungible: false,
    marketIdentity: "fishing_rod",
    packageGrantable: true,
    description: "A durable rod with 100 casts. Use it anywhere there is authoritative water."
  }),
  ore: resource("ore", "Ore", { group: "ores", marketTradable: false }),
  water: resource("water", "Water", {
    marketTradable: false,
    packageGrantable: false,
    supportedVariants: ["default", "fresh", "salt"]
  }),
  // Crop IDs are dynamic server-owned variants for these generic items.
  seed: resource("seed", "Seed", {
    droppable: false,
    marketTradable: false,
    packageGrantable: false
  }),
  produce: resource("produce", "Produce", {
    group: "food",
    droppable: false,
    marketTradable: false,
    packageGrantable: false
  }),
  wheat_seed: resource("wheat_seed", "Wheat Seed", {
    marketTradable: true,
    description: "A seed ready for planting in a greenhouse."
  }),
  wheat: resource("wheat", "Wheat", {
    marketTradable: true,
    description: "Harvested greenhouse wheat."
  }),
  gardening_bucket: resource("gardening_bucket", "Gardening Bucket", {
    marketTradable: false,
    stackable: false,
    maxStack: 1,
    description: "A one-gallon bucket used to water greenhouse anchors."
  }),
  water_bucket: resource("water_bucket", "Water Bucket", {
    marketTradable: false,
    stackable: false,
    maxStack: 1,
    description: "A five-gallon bucket used to collect fresh river water."
  }),
  flax_fiber: resource("flax_fiber", "Flax Fiber", { marketTradable: true }),
  cloth: resource("cloth", "Cloth", { marketTradable: true }),
  leather: resource("leather", "Leather", { marketTradable: true }),
  deer_hide: resource("deer_hide", "Deer Hide", { group: "hides", marketTradable: true }),
  hog_hide: resource("hog_hide", "Hog Hide", { group: "hides", marketTradable: true }),
  wolf_pelt: resource("wolf_pelt", "Wolf Pelt", {
    group: "hides",
    marketTradable: true,
    rarity: "uncommon"
  }),
  bear_hide: resource("bear_hide", "Bear Hide", {
    group: "hides",
    marketTradable: true,
    rarity: "uncommon"
  }),
  alligator_hide: resource("alligator_hide", "Alligator Hide", {
    group: "hides",
    marketTradable: true,
    rarity: "uncommon"
  }),
  squid_flesh: resource("squid_flesh", "Squid Flesh (Legacy)", { marketTradable: false, droppable: false, packageGrantable: false }),
  squid_meat: resource("squid_meat", "Squid Meat (Legacy)", {
    group: "meat",
    marketTradable: false, droppable: false, packageGrantable: false,
    description: "Retired ingredient; retained only for historical records."
  }),
  deer_meat: resource("deer_meat", "Deer Meat (Legacy)", {
    group: "meat",
    marketTradable: false, droppable: false, packageGrantable: false,
    description: "Retired ingredient; retained only for historical records."
  }),
  wolf_meat: resource("wolf_meat", "Wolf Meat (Legacy)", {
    group: "meat",
    marketTradable: false, droppable: false, packageGrantable: false,
    description: "Retired ingredient; retained only for historical records."
  }),
  hog_meat: resource("hog_meat", "Hog Meat (Legacy)", {
    group: "meat",
    marketTradable: false, droppable: false, packageGrantable: false,
    description: "Retired ingredient; retained only for historical records."
  }),
  bear_meat: resource("bear_meat", "Bear Meat (Legacy)", {
    group: "meat",
    marketTradable: false, droppable: false, packageGrantable: false,
    description: "Retired ingredient; retained only for historical records."
  }),
  alligator_meat: resource("alligator_meat", "Alligator Meat (Legacy)", {
    group: "meat",
    marketTradable: false, droppable: false, packageGrantable: false,
    description: "Retired ingredient; retained only for historical records."
  }),
  wild_meat: resource("wild_meat", "Wild Meat (Legacy)", {
    group: "meat",
    marketTradable: false, droppable: false, packageGrantable: false,
    description: "Retired ingredient; retained only for historical records."
  }),
  crab_carapace: resource("crab_carapace", "Crab Carapace", { marketTradable: true }),
  // Retained only for historical custody/event compatibility after 0818.
  raw_meat: resource("raw_meat", "Raw Meat (Legacy)", {
    group: "meat",
    marketTradable: false,
    packageGrantable: false,
    droppable: false
  }),
  // Retained only for historical custody/event compatibility after 0811.
  shell: resource("shell", "Shell (Legacy)", {
    marketTradable: false,
    packageGrantable: false,
    droppable: false
  }),
  chitin: resource("chitin", "Chitin", { marketTradable: true }),
  giving_berry: resource("giving_berry", "Giving Berry", {
    group: "food",
    kind: "consumable",
    marketTradable: true,
    rarity: "uncommon",
    description: "Restores 4 health immediately and every 1.4 seconds, up to 24 health. Only one Giving Berry effect may be active at a time."
  }),
  balsam_resin: resource("balsam_resin", "Frond Sap", {
    marketTradable: true,
    rarity: "uncommon",
    description: "Sap tapped from a Elder Fern. A fern refills 6 hours after it is tapped."
  }),
  repair_kit: resource("repair_kit", "Repair Kit", {
    kind: "consumable",
    marketTradable: true,
    rarity: "uncommon",
    maxStack: INVENTORY_STACK_LIMITS.repair_kit
  }),
  torch: resource("torch", "Torch", {
    kind: "consumable",
    marketTradable: false,
    rarity: "common",
    maxStack: INVENTORY_STACK_LIMITS.torch
  }),
  shovel: resource("shovel", "Shovel", {
    kind: "consumable",
    marketTradable: false,
    rarity: "common",
    description: "Digs up buried treasure. Wears out after 20 digs.",
    maxStack: INVENTORY_STACK_LIMITS.shovel
  }),
  crude_oil: resource("crude_oil", "Crude Oil", {
    marketTradable: true
  }),
  jellyfish_venom: resource("jellyfish_venom", "Jellyfish Venom", {
    marketTradable: true,
    rarity: "rare"
  }),
  brood_silk: resource("brood_silk", "Brood Silk", {
    marketTradable: true,
    rarity: "rare"
  }),
  raptor_scale: resource("raptor_scale", "Raptor Scale", {
    marketTradable: true,
    rarity: "rare"
  }),
  giant_egg: resource("giant_egg", "Giant Egg", {
    marketTradable: true,
    rarity: "rare"
  }),
  brood_egg: resource("brood_egg", "Brood Egg", {
    marketTradable: true,
    rarity: "rare",
    description: "Hatch at Pets for a Brood Spinner."
  }),
  clutch_egg: resource("clutch_egg", "Fangrock Clutch Egg", {
    marketTradable: true,
    rarity: "rare",
    description: "Hatch at Pets for an Emberclaw Raptor."
  }),
  crawler_egg: resource("crawler_egg", "Crawler Egg", {
    marketTradable: true,
    rarity: "rare",
    description: "Hatches into a Deep Crawler once the Drowned City opens."
  }),
  broken_whistle: resource("broken_whistle", "Broken Whistle", {
    marketTradable: true,
    rarity: "rare",
    description: "A cracked whistle. Repairing it will call a Glade Wisp."
  }),
  bonewrought_blade: resource("bonewrought_blade", "Bonewrought Blade", {
    marketTradable: true,
    rarity: "rare",
    description: "Carry it: your killing blows raise a Bone Thrall."
  }),
  bonewrought_mail: resource("bonewrought_mail", "Bonewrought Mail", {
    marketTradable: true,
    rarity: "rare",
    description: "Carry it: dying usually raises a Grave Echo of you."
  }),
  survey_stake_kit: resource("survey_stake_kit", "Survey Stake Kit", {
    kind: "consumable",
    marketTradable: false,
    rarity: "uncommon",
    packageGrantable: false,
    description: "Mark your spot or a building you tap and name it. The marker is yours to reuse, rename or delete."
  }),
  compass: resource("compass", "Compass", {
    marketTradable: false,
    stackable: false,
    maxStack: 1,
    droppable: false,
    rarity: "uncommon",
    packageGrantable: false,
    description: "Unlocks the worldwide overview and one waypoint arrow. Lasts 30 days of use."
  }),
  lamp_sheath: resource("lamp_sheath", "Lamp Sheath", {
    marketTradable: true,
    rarity: "rare",
    description: "A sturdy case for a dungeon lantern. Sold by the Wandering Merchant."
  }),
  cinder_lantern: resource("cinder_lantern", "Cinder Lantern", {
    marketTradable: false,
    droppable: false,
    rarity: "rare",
    description: "Pays a dungeon's entry cost instead of a torch and triples monster drops inside. 9 charges."
  }),
  challengers_lantern: resource("challengers_lantern", "Challenger's Lantern", {
    marketTradable: false,
    droppable: false,
    rarity: "rare",
    description: "Pays a dungeon's entry cost instead of a torch and grants +3 Attack and +1 Defense against monsters inside. 12 charges."
  }),
  anti_venom_tonic: resource("anti_venom_tonic", "Anti-Venom Tonic", {
    kind: "consumable",
    marketTradable: true,
    rarity: "uncommon",
    description: FIELD_CONSUMABLE_DESCRIPTIONS.anti_venom_tonic
  }),
  battle_draught: resource("battle_draught", "Battle Draught", {
    kind: "consumable",
    marketTradable: true,
    rarity: "uncommon",
    description: FIELD_CONSUMABLE_DESCRIPTIONS.battle_draught
  }),
  ember_flask: resource("ember_flask", "Ember Bomb", {
    kind: "consumable",
    marketTradable: true,
    rarity: "uncommon",
    description: FIELD_CONSUMABLE_DESCRIPTIONS.ember_flask
  }),
  spark_tonic: resource("spark_tonic", "Spark Tonic", {
    kind: "consumable",
    marketTradable: true,
    rarity: "uncommon",
    description: FIELD_CONSUMABLE_DESCRIPTIONS.spark_tonic
  }),
  field_net: resource("field_net", "Net", {
    kind: "consumable",
    marketTradable: true,
    rarity: "uncommon",
    description: FIELD_CONSUMABLE_DESCRIPTIONS.field_net
  }),
  field_trap: resource("field_trap", "Trap", {
    kind: "consumable",
    marketTradable: true,
    rarity: "uncommon",
    description: FIELD_CONSUMABLE_DESCRIPTIONS.field_trap
  }),
  // Tidecraft crafted items (water game phase D).
  tidewater_draught: resource("tidewater_draught", "Tidewater Draught", {
    kind: "consumable",
    marketTradable: true,
    rarity: "rare",
    description: FIELD_CONSUMABLE_DESCRIPTIONS.tidewater_draught
  }),
  undertow_snare: resource("undertow_snare", "Undertow Snare", {
    kind: "consumable",
    marketTradable: true,
    rarity: "rare",
    description: FIELD_CONSUMABLE_DESCRIPTIONS.undertow_snare
  }),
  stillwater_orb: resource("stillwater_orb", "Stillwater Orb", {
    kind: "consumable",
    marketTradable: true,
    rarity: "rare",
    description: FIELD_CONSUMABLE_DESCRIPTIONS.stillwater_orb
  }),
  free_step_ward: resource("free_step_ward", "Free-Step Ward", {
    kind: "consumable",
    marketTradable: true,
    rarity: "epic",
    description: FIELD_CONSUMABLE_DESCRIPTIONS.free_step_ward
  }),
  vigor_serum: resource("vigor_serum", "Vigor Serum", {
    kind: "consumable",
    marketTradable: true,
    rarity: "rare",
    description: FIELD_CONSUMABLE_DESCRIPTIONS.vigor_serum
  }),
  mending_resin: resource("mending_resin", "Mending Resin", {
    kind: "consumable",
    marketTradable: true,
    rarity: "uncommon",
    description: FIELD_CONSUMABLE_DESCRIPTIONS.mending_resin
  }),
  loadout_scroll: resource("loadout_scroll", LOADOUT_SCROLL_DISPLAY_NAME, {
    marketTradable: true,
    rarity: "rare",
    description: LOADOUT_SCROLL_DESCRIPTION
  }),
  masons_tome: resource("masons_tome", "Mason's Tome", {
    kind: "consumable",
    marketTradable: true,
    rarity: "epic",
    description: FIELD_CONSUMABLE_DESCRIPTIONS.masons_tome
  }),
  elder_acorn: resource("elder_acorn", "Elder Acorn", {
    marketTradable: true,
    rarity: "rare"
  }),
  prison_key_fragment: resource("prison_key_fragment", "Prison Key Fragment", {
    marketTradable: true,
    rarity: "rare"
  }),
  giving_tree_sapling: resource("giving_tree_sapling", "Giving Tree Sapling", {
    marketTradable: true,
    rarity: "uncommon",
    description: "Pulled with Grove Lore. Plant it on open land with the Plant action; it grows as a fresh sapling."
  }),
  wyrm_egg: resource("wyrm_egg", "Wyrm Egg", {
    group: "eggs",
    marketTradable: true,
    rarity: "rare",
    description: "Hatch at Pets for an Ember Drake (needs Rare Beast Mastery). Six at the Wyrm Nest, with three different boss trophies, discover Rare Beast Mastery."
  }),
  zephyr: resource("zephyr", "Zephyr", {
    marketTradable: true,
    rarity: "rare"
  }),
  // Dungeon special-metal ingredients (1101). Special-metal infusion is a later system; until then
  // they are tradeable materials.
  cave_lichen: resource("cave_lichen", "Cave Lichen", {
    marketTradable: true,
    rarity: "rare",
    description: "Pale lichen from deep in Fangrock Cavern. Used in special-metal infusion for revenant metal."
  }),
  gale_plume: resource("gale_plume", "Gale Plume", {
    marketTradable: true,
    rarity: "rare",
    description: "A wind-swept plume from the Eyrie. An ingredient for a future Gale metal."
  }),
  heartsap: resource("heartsap", "Heartsap", {
    marketTradable: true,
    rarity: "rare",
    description: "Living sap from the Blightwood Grove's heartwood. Used in special-metal infusion for Vital metal."
  }),
  dragon_scale: resource("dragon_scale", "Dragon Scale", {
    group: "scales",
    marketTradable: true,
    rarity: "rare",
    description: "A heat-scarred scale from the Wyrm Hollow. Forged into Chain Mail and the Ranged Shield (needs Rare Beast Mastery); also used in fire metal."
  }),
  maw_bloom_petal: resource("maw_bloom_petal", "Maw Bloom Petal", {
    marketTradable: true,
    rarity: "rare",
    description: "A dark petal from the Drowned City. Used in special-metal infusion for Gloom metal."
  }),
  refined_oil: resource("refined_oil", "Glimmer Oil", {
    marketTradable: true
  }),
  // Kingdom building material: earned on kingdom land, deposited (taxed 12%)
  // into a kingdom treasury. Not market tradable.
  bricks: resource("bricks", "Bricks", { marketTradable: false, packageGrantable: false }),
  // Produced by a member's Quartz Hut (citySystem.ts QUARTZ_HUT_*); Kingdom Tower material.
  crystal: resource("crystal", "Crystal", {
    group: "ores",
    marketTradable: true
  }),
  // Rare drop from Jellyfish (the Jellyfish Venom source); Command Board material.
  pearl: resource("pearl", "Pearl", {
    marketTradable: true,
    rarity: "rare"
  }),
  lichen: resource("lichen", "Lichen", { marketTradable: true, rarity: "common" }),
  thistle: resource("thistle", "Thistle", { marketTradable: true, rarity: "common" }),
  umbral_essence: resource("umbral_essence", "Umbral Essence", { marketTradable: true, rarity: "uncommon" }),
  dusk_heart: resource("dusk_heart", "Dusk Heart", { marketTradable: true, rarity: "rare" }),
  bloom_petal: resource("bloom_petal", "Bloom Petal", { marketTradable: true, rarity: "uncommon" }),
  gearwork_essence: resource("gearwork_essence", "Gearwork Essence", { marketTradable: true, rarity: "common" }),
  gale_splinter: resource("gale_splinter", "Gale Splinter", { marketTradable: true, rarity: "common" }),
  griffin_plume: resource("griffin_plume", "Griffin Plume", { marketTradable: true, rarity: "rare" }),
  edict_seal: resource("edict_seal", "Edict Seal", { marketTradable: true, rarity: "uncommon" }),
  skyrise_stone: resource("skyrise_stone", "Skyrise Stone", { marketTradable: true, rarity: "rare" }),
  mist_drop: resource("mist_drop", "Mist Drop", { marketTradable: true, rarity: "common" }),
  revenant_bar: resource("revenant_bar", "Revenant Bar", { group: "bars", marketTradable: true, rarity: "rare" }),
  expel_bar: resource("expel_bar", "Expel Bar", { group: "bars", marketTradable: true, rarity: "rare" }),
  mirage_bar: resource("mirage_bar", "Mirage Bar", { group: "bars", marketTradable: true, rarity: "rare" }),
  gale_bar: resource("gale_bar", "Gale Bar", { group: "bars", marketTradable: true, rarity: "rare" }),
  fleet_bar: resource("fleet_bar", "Fleet Bar", { group: "bars", marketTradable: true, rarity: "rare" }),
  whetted_bar: resource("whetted_bar", "Whetted Bar", { group: "bars", marketTradable: true, rarity: "rare" }),
  vengeance_bar: resource("vengeance_bar", "Vengeance Bar", { group: "bars", marketTradable: true, rarity: "rare" }),
  gloom_bar: resource("gloom_bar", "Gloom Bar", { group: "bars", marketTradable: true, rarity: "rare" }),
  skyrise_bar: resource("skyrise_bar", "Skyrise Bar", { group: "bars", marketTradable: true, rarity: "rare" }),
  vital_bar: resource("vital_bar", "Vital Bar", { group: "bars", marketTradable: true, rarity: "rare" }),
  atlas_shrine_shard: resource("atlas_shrine_shard", "Atlas Shrine Shard", {
    marketTradable: true,
    rarity: "rare"
  }),
  enchantment_stone: resource("enchantment_stone", "Enchantment Stone", {
    marketTradable: true,
    stackable: false,
    maxStack: 1,
    droppable: true,
    supportedVariants: ENCHANTMENT_STONE_VARIANTS
  }),
  // Premium currency carried as an item. Never package-granted: the only
  // source is the audited admin grant (and later the Atlas Pass).
  lumen: resource("lumen", "Lumen", {
    marketTradable: true,
    category: "currency",
    packageGrantable: false
  }),
  // Bought for Gold anywhere and consumed by sending a player gift. Never
  // traded, dropped, gifted or package-granted: Gold is its only source.
  gift_box: resource("gift_box", "Gift Box", {
    marketTradable: false,
    droppable: false,
    packageGrantable: false,
    description: "Wraps items as a gift for another player. Each gift uses one Gift Box."
  }),
  ring_shard: resource("ring_shard", "Ring Shard", {
    marketTradable: true,
    rarity: "uncommon",
    description: "Left over when a ring is dumped. Ring forging material."
  }),
  forge_spark: resource("forge_spark", "Forge Spark", {
    marketTradable: true,
    rarity: "rare",
    description: "A crackling spark from the Golem Forge. Unlocks Field Engineering at the Spark Forge, powers monoliths and makes Storm Bars."
  }),
  shard_grit: resource("shard_grit", "Shard Grit", {
    marketTradable: false,
    rarity: "uncommon",
    description: "Crushed from gemstones and shed by golems. Used in jewelcraft."
  }),
  amulet_clasp: resource("amulet_clasp", "Amulet Clasp", {
    marketTradable: true,
    rarity: "rare",
    description: "A forged link from the Golem Forge. Amulets are crafted from twenty of them."
  }),
  // One item per non-default Manor type (variant = type id). Bought with
  // Glimmer; equipped on the Manor from the inventory (it stays there, locked while equipped).
  manor_skin: resource("manor_skin", "Skin", {
    marketTradable: true,
    // Per-copy item (1202): each copy has its own market book, like Fishing Rods.
    marketFungible: false,
    stackable: false,
    maxStack: 1,
    droppable: true,
    rarity: "rare",
    packageGrantable: false,
    supportedVariants: MANOR_SKIN_VARIANTS,
    description: "Equip it on your Manor from the inventory to give your Manor this look. It stays in your inventory; unequip it before dropping, trading or storing it."
  }),
  // One item per mask (variant = mask appearance id). Bought in the Glimmer Shop; worn from the
  // inventory (it stays there, locked while worn). Extra copies trade like any item.
  face_mask: resource("face_mask", "Mask", {
    marketTradable: true,
    // Per-copy item (1202): each copy has its own market book, like Fishing Rods.
    marketFungible: false,
    stackable: false,
    maxStack: 1,
    droppable: true,
    rarity: "rare",
    packageGrantable: false,
    supportedVariants: FACE_MASK_VARIANTS,
    description: "Wear it from the inventory to put this mask on. It stays in your inventory; take it off before dropping, trading or storing it."
  }),
  // Water game phase B (docs/design/WATER_GAME_PLAN.md): the water currency
  // (whirlpool trips and Tidecraft recipes) and the Tidecraft unlock orb.
  shellback_plate: resource("shellback_plate", "Shellback Plate", {
    group: "scales",
    marketTradable: true,
    rarity: "uncommon",
    description: "A thick plate from a Shellback's shell. Paid for whirlpool travel and water crafting."
  }),
  abyssal_orb: resource("abyssal_orb", "Abyssal Orb", {
    group: "essences",
    marketTradable: true,
    rarity: "epic",
    description: "A dark orb from the deep sea. Presented to unlock Tidecraft."
  }),
  frog_legs: universalFoodResource("frog_legs", "meat"),
  frost_frog_legs: universalFoodResource("frost_frog_legs", "meat"),
  poison_frog_legs: universalFoodResource("poison_frog_legs", "meat"),
  desert_toad_legs: universalFoodResource("desert_toad_legs", "meat"),
  crab_meat: universalFoodResource("crab_meat", "meat"),
  ice_crab_meat: universalFoodResource("ice_crab_meat", "meat"),
  sand_crab_meat: universalFoodResource("sand_crab_meat", "meat"),
  mangrove_crab_meat: universalFoodResource("mangrove_crab_meat", "meat"),
  small_catch: universalFoodResource("small_catch"),
  jellyfish_jelly: universalFoodResource("jellyfish_jelly"),
  crawler_flesh: universalFoodResource("crawler_flesh"),
  squid_cut: universalFoodResource("squid_cut", "meat"),
  wolf_cut: universalFoodResource("wolf_cut", "meat"),
  frost_wolf_cut: universalFoodResource("frost_wolf_cut", "meat"),
  dune_wolf_cut: universalFoodResource("dune_wolf_cut", "meat"),
  jungle_wolf_cut: universalFoodResource("jungle_wolf_cut", "meat"),
  bog_wolf_cut: universalFoodResource("bog_wolf_cut", "meat"),
  deer_cut: universalFoodResource("deer_cut", "meat"),
  frost_deer_cut: universalFoodResource("frost_deer_cut", "meat"),
  jungle_deer_cut: universalFoodResource("jungle_deer_cut", "meat"),
  marsh_deer_cut: universalFoodResource("marsh_deer_cut", "meat"),
  sand_deer_cut: universalFoodResource("sand_deer_cut", "meat"),
  hog_cut: universalFoodResource("hog_cut", "meat"),
  woolly_hog_cut: universalFoodResource("woolly_hog_cut", "meat"),
  warthog_cut: universalFoodResource("warthog_cut", "meat"),
  jungle_hog_cut: universalFoodResource("jungle_hog_cut", "meat"),
  mud_hog_cut: universalFoodResource("mud_hog_cut", "meat"),
  javelina_cut: universalFoodResource("javelina_cut", "meat"),
  alligator_tail: universalFoodResource("alligator_tail", "meat"),
  caiman_tail: universalFoodResource("caiman_tail", "meat"),
  crocodile_tail: universalFoodResource("crocodile_tail", "meat"),
  bear_cut: universalFoodResource("bear_cut", "meat"),
  snow_bear_cut: universalFoodResource("snow_bear_cut", "meat"),
  black_bear_cut: universalFoodResource("black_bear_cut", "meat"),
  sun_bear_cut: universalFoodResource("sun_bear_cut", "meat"),
  jungle_tapir_cut: universalFoodResource("jungle_tapir_cut", "meat"),
  jaguar_cut: universalFoodResource("jaguar_cut", "meat"),
  mandrill_cut: universalFoodResource("mandrill_cut", "meat"),
  capercaillie_meat: universalFoodResource("capercaillie_meat", "meat"),
  elk_cut: universalFoodResource("elk_cut", "meat"),
  red_squirrel_cut: universalFoodResource("red_squirrel_cut", "meat"),
  badger_cut: universalFoodResource("badger_cut", "meat"),
  grey_squirrel_cut: universalFoodResource("grey_squirrel_cut", "meat"),
  stag_beetle_cut: universalFoodResource("stag_beetle_cut", "meat"),
  great_grey_owl_meat: universalFoodResource("great_grey_owl_meat", "meat"),
  flying_squirrel_cut: universalFoodResource("flying_squirrel_cut", "meat"),
  plains_bison_cut: universalFoodResource("plains_bison_cut", "meat"),
  prairie_dog_cut: universalFoodResource("prairie_dog_cut", "meat"),
  burrowing_owl_meat: universalFoodResource("burrowing_owl_meat", "meat"),
  giraffe_cut: universalFoodResource("giraffe_cut", "meat"),
  lioness_cut: universalFoodResource("lioness_cut", "meat"),
  spotted_hyena_cut: universalFoodResource("spotted_hyena_cut", "meat"),
  sitatunga_cut: universalFoodResource("sitatunga_cut", "meat"),
  emperor_dragonfly_cut: universalFoodResource("emperor_dragonfly_cut", "meat"),
  mountain_ibex_cut: universalFoodResource("mountain_ibex_cut", "meat"),
  wild_yak_cut: universalFoodResource("wild_yak_cut", "meat"),
  alpine_marmot_cut: universalFoodResource("alpine_marmot_cut", "meat"),
  wild_scrub_goat_cut: universalFoodResource("wild_scrub_goat_cut", "meat"),
  crested_porcupine_cut: universalFoodResource("crested_porcupine_cut", "meat"),
  spur_thighed_tortoise_cut: universalFoodResource("spur_thighed_tortoise_cut", "meat"),
  dromedary_cut: universalFoodResource("dromedary_cut", "meat"),
  fennec_fox_cut: universalFoodResource("fennec_fox_cut", "meat"),
  sidewinder_cut: universalFoodResource("sidewinder_cut", "meat"),
  field_hare_cut: universalFoodResource("field_hare_cut", "meat"),
  arctic_hare_cut: universalFoodResource("arctic_hare_cut", "meat"),
  capybara_cut: universalFoodResource("capybara_cut", "meat"),
  armadillo_cut: universalFoodResource("armadillo_cut", "meat"),
  red_fox_cut: universalFoodResource("red_fox_cut", "meat"),
  wolverine_cut: universalFoodResource("wolverine_cut", "meat"),
  ostrich_cut: universalFoodResource("ostrich_cut", "meat"),
  golden_eagle_cut: universalFoodResource("golden_eagle_cut", "meat"),
  musk_ox_cut: universalFoodResource("musk_ox_cut", "meat"),
  seal_cut: universalFoodResource("seal_cut", "meat"),
  desert_lion_cut: universalFoodResource("desert_lion_cut", "meat"),
  saiga_cut: universalFoodResource("saiga_cut", "meat"),
  wild_horse_cut: universalFoodResource("wild_horse_cut", "meat"),
  steppe_marmot_cut: universalFoodResource("steppe_marmot_cut", "meat"),
  lemming_cut: universalFoodResource("lemming_cut", "meat"),
  snow_goose_meat: universalFoodResource("snow_goose_meat", "meat"),
  // A world-boss cut (Mammoth Patriarch): Legendary, so simple recipes ask before using it.
  mammoth_cut: universalFoodResource("mammoth_cut", "meat", "legendary"),
  dire_wolf_cut: universalFoodResource("dire_wolf_cut", "meat", "uncommon"),
  drake_cut: universalFoodResource("drake_cut", "meat", "uncommon"),
  dragon_cut: universalFoodResource("dragon_cut", "meat", "rare"),
  grub_meat: universalFoodResource("grub_meat", "meat", "uncommon"),
  emperor_penguin_meat: universalFoodResource("emperor_penguin_meat", "meat"),
  peary_caribou_cut: universalFoodResource("peary_caribou_cut", "meat"),
  ice_worm_cut: universalFoodResource("ice_worm_cut", "meat"),
  sea_otter_cut: universalFoodResource("sea_otter_cut", "meat"),
  herring_gull_meat: universalFoodResource("herring_gull_meat", "meat"),
  spiny_lobster_tail: universalFoodResource("spiny_lobster_tail", "fish"),
  hammerhead_shark_steak: universalFoodResource("hammerhead_shark_steak", "fish"),
  manta_ray_wing: universalFoodResource("manta_ray_wing", "fish"),
  humpback_whale_cut: universalFoodResource("humpback_whale_cut", "meat"),
  muskellunge_fillet: universalFoodResource("muskellunge_fillet", "fish"),
  mute_swan_meat: universalFoodResource("mute_swan_meat", "meat"),
  pike_fillet: universalFoodResource("pike_fillet", "fish"),
  snapping_turtle_cut: universalFoodResource("snapping_turtle_cut", "meat"),
  beaver_cut: universalFoodResource("beaver_cut", "meat"),
  otter_cut: universalFoodResource("otter_cut", "meat"),
  salmon_fillet: universalFoodResource("salmon_fillet", "fish"),
  elemental_ration: universalFoodResource("elemental_ration", "food"),
  scorching_bird_meat: universalFoodResource("scorching_bird_meat", "meat"),
  zappy_bird_meat: universalFoodResource("zappy_bird_meat", "meat"),
  freezing_bird_meat: universalFoodResource("freezing_bird_meat", "meat"),
  field_ration: universalFoodResource("field_ration", "food"),
  hearty_ration: universalFoodResource("hearty_ration", "food"),
  xoral_essence: universalFoodResource("xoral_essence"),
  ...mobDropCatalog()
} as const satisfies Readonly<Partial<Record<InventoryItemType, InventoryCatalogItem>>> & Readonly<{ fishing_rod: InventoryCatalogItem }>;

export const GRANTABLE_RESOURCE_CATALOG: readonly InventoryCatalogItem[] =
  Object.freeze(
    Object.values(RESOURCE_CATALOG)
      .filter((item) => item.packageGrantable)
      .sort((left, right) => left.displayName.localeCompare(right.displayName))
  );

const EQUIPMENT_CATALOG = Object.fromEntries(
  Object.values(EQUIPMENT_DEFINITIONS).map((definition) => [
    definition.definitionId,
    {
      itemId: definition.definitionId,
      kind: "equipment",
      displayName: definition.displayName,
      category: definition.category,
      equipmentFamilyId: definition.gameplayFamilyId,
      equipmentRole: definition.equipmentRole,
      iconKey: definition.definitionId,
      rarity: "common",
      stackable: false,
      maxStack: 1,
      droppable: true,
      manorStorable: true,
      marketTradable: false,
      marketFungible: false,
      marketIdentity: null,
      supportedVariants: ["default"],
      packageGrantable: true
    } satisfies InventoryCatalogItem
  ])
) as unknown as Readonly<Record<EquipmentDefinitionId, InventoryCatalogItem>>;

export const INVENTORY_CATALOG: Readonly<Record<string, InventoryCatalogItem>> =
  Object.freeze({
    ...RESOURCE_CATALOG,
    ...EQUIPMENT_CATALOG
  });

export const PLAYER_PACKAGE_ITEM_CATALOG: readonly InventoryCatalogItem[] =
  Object.freeze(
    Object.values(INVENTORY_CATALOG)
      .filter((item) => item.packageGrantable)
      .sort((left, right) =>
        left.kind.localeCompare(right.kind) ||
        left.displayName.localeCompare(right.displayName)
      )
  );

export function requireInventoryCatalogItem(itemId: string): InventoryCatalogItem {
  const item = INVENTORY_CATALOG[itemId];
  if (!item || item.itemId !== itemId) {
    throw new Error(`Unknown inventory item: ${itemId}`);
  }
  return item;
}

function resource(
  itemId: InventoryItemType,
  displayName: string,
  metadata: Readonly<{
    kind?: "resource" | "consumable";
    /** Market and inventory category when it differs from the kind. */
    category?: string;
    group?: InventoryItemGroupId;
    marketTradable: boolean;
    marketFungible?: boolean;
    marketIdentity?: string | null;
    description?: string;
    rarity?: ItemRarity;
    stackable?: boolean;
    maxStack?: number;
    droppable?: boolean;
    supportedVariants?: readonly string[];
    packageGrantable?: boolean;
  }>
): InventoryCatalogItem {
  const kind = metadata.kind ?? "resource";
  return {
    itemId,
    kind,
    displayName,
    ...(metadata.description === undefined
      ? {}
      : { description: metadata.description }),
    ...(metadata.group === undefined ? {} : { inventoryGroup: metadata.group }),
    category: metadata.category ?? kind,
    equipmentFamilyId: null,
    equipmentRole: null,
    iconKey: itemId,
    rarity: metadata.rarity ?? "common",
    stackable: metadata.stackable ?? true,
    maxStack: metadata.maxStack ?? INVENTORY_STACK_LIMITS[itemId],
    droppable: metadata.droppable ?? true,
    manorStorable: true,
    marketTradable: metadata.marketTradable,
    marketFungible: metadata.marketFungible ?? metadata.marketTradable,
    marketIdentity: metadata.marketIdentity === undefined
      ? metadata.marketTradable ? itemId : null
      : metadata.marketIdentity,
    supportedVariants: metadata.supportedVariants ?? ["default"],
    packageGrantable: metadata.packageGrantable ?? true
  };
}

function legendary(
  itemId: ResourceType,
  displayName: string,
  group?: InventoryItemGroupId
): InventoryCatalogItem {
  return resource(itemId, displayName, {
    ...(group === undefined ? {} : { group }),
    marketTradable: true,
    rarity: "legendary",
    stackable: false,
    maxStack: 1
  });
}

/** Mob value pass B1 drops (mobDropItems.ts): market tradable, grouped by kind. */
function mobDropCatalog(): Readonly<Record<MobDropItemId, InventoryCatalogItem>> {
  return Object.fromEntries(Object.values(MOB_DROP_ITEMS).map((item) => [
    item.itemId,
    resource(item.itemId, item.displayName, {
      ...(item.group === null ? {} : { group: item.group }),
      marketTradable: true,
      rarity: item.rarity
    })
  ])) as Record<MobDropItemId, InventoryCatalogItem>;
}

function universalFoodResource(
  itemId: UniversalFoodItemId,
  group?: InventoryItemGroupId,
  rarity?: ItemRarity
): InventoryCatalogItem {
  const definition = UNIVERSAL_FOOD_ITEMS[itemId];
  return resource(itemId, definition.displayName, {
    ...(group === undefined ? {} : { group }),
    ...(rarity === undefined ? {} : { rarity }),
    marketTradable: true,
    description: definition.description
  });
}
