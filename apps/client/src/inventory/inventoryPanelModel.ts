import {
  DEFAULT_PLAYER_CARRY_CAPACITY_GRAMS,
  FIELD_CONSUMABLE_NAMES,
  faceMaskDisplayName,
  manorSkinDisplayName,
  type ShopProvenance,
  getItemWeightGrams,
  isFieldConsumableItemId,
  INVENTORY_CATALOG,
  MOB_DROP_ITEMS,
  RESOURCE_TYPES,
  emptyInventoryTotals,
  requireBackpackLevel,
  type BackpackInstanceSnapshot,
  type InventoryProtectionSnapshot,
  type ItemRarity,
  type PlayerInventoryItem,
  type PlayerInventorySnapshot,
  type InventoryItemGroupId,
  type InventoryItemType,
  type ResourceType
} from "@ash-atlas/shared";

export type InventoryPanelTransition = "open" | "close" | "toggle";

export type InventoryPanelRow = {
  key: string;
  stackId: string;
  slotIndex: number;
  itemId: string;
  variant: string | null;
  name: string;
  rarity: ItemRarity;
  description?: string;
  quantity: number;
  unitWeightGrams: number;
  totalWeightGrams: string;
  maxStack: number;
  canDrop: boolean;
  canUse: boolean;
  rodId?: string;
  usesRemaining?: number;
  /** Per-copy shop items: the look (mask appearance / Manor type) and the copy's provenance. */
  look?: string;
  provenance?: ShopProvenance;
  equipped?: boolean;
  manualSplit: boolean;
};

export type InventoryDropSelection = Pick<
  InventoryPanelRow,
  "key" | "stackId" | "itemId" | "variant" | "name" | "maxStack"
>;

export type ActionableInventoryDropSelection = InventoryDropSelection & {
  quantity: number;
};

/**
 * A visual backpack row may represent more than one owned durable instance.
 * The representative item is used only for the row's presentation and the
 * instance list keeps every durable identity available to action callers.
 */
export type InventoryBackpackGroup = {
  key: string;
  item: BackpackInstanceSnapshot;
  items: BackpackInstanceSnapshot[];
  instanceIds: string[];
  quantity: number;
};

/**
 * Group only backpacks with the same player-visible identity. There is no
 * gameplay quantity cap here: every matching instance belongs to the same row.
 * Upgrade/capacity metadata are part of the key. Carried and equipped backpacks
 * all grant capacity, so they stack together.
 * The row's representative instance, which actions use, is the lowest instance id.
 */
export function groupBackpackInstances(
  instances: readonly BackpackInstanceSnapshot[]
): InventoryBackpackGroup[] {
  const groups = new Map<string, InventoryBackpackGroup>();
  for (const item of instances) {
    const key = backpackGroupingKey(item);
    const group = groups.get(key);
    if (group) {
      group.items.push(item);
      group.instanceIds.push(item.instanceId);
      group.quantity += 1;
      continue;
    }
    groups.set(key, {
      key,
      item,
      items: [item],
      instanceIds: [item.instanceId],
      quantity: 1
    });
  }
  for (const group of groups.values()) {
    group.item = group.items.reduce((lowest, candidate) => candidate.instanceId < lowest.instanceId ? candidate : lowest);
  }
  return [...groups.values()];
}

function backpackGroupingKey(item: BackpackInstanceSnapshot): string {
  // The capacity the row shows: explicit value, the legacy field, else the level's default.
  const capacityBonusGrams = item.capacityBonusGrams ?? item.capacityBonus
    ?? requireBackpackLevel(item.upgradeLevel ?? 0).capacityBonusGrams;
  // Only what the row shows decides a stack: name, level and capacity.
  return JSON.stringify([
    item.displayName,
    item.upgradeLevel ?? null,
    capacityBonusGrams
  ]);
}

/** A group collapses into one row only when the player holds more kinds than this. */
export const INVENTORY_GROUP_COLLAPSE_OVER = 4;

export type InventoryItemGroup = { id: InventoryItemGroupId; name: string };

/** Display names of the inventory groups; an item declares its group in the catalog. */
export const INVENTORY_ITEM_GROUP_NAMES: Readonly<Record<InventoryItemGroupId, string>> = {
  meat: "Meat",
  hides: "Hides and pelts",
  feathers: "Feathers",
  bars: "Bars and cores",
  ores: "Ores and minerals",
  food: "Food",
  bones: "Bones, horns and teeth",
  scales: "Scales, shells and chitin",
  venoms: "Venoms and glands",
  essences: "Essences and cores",
  gems: "Gems and minerals",
  plants: "Plants and fungi",
  trinkets: "Cloth, gear and trinkets",
  trophies: "Trophies",
  eggs: "Eggs",
  fish: "Fish and seafood"
};

/** Group an item belongs to for collapsing in the Inventory list (its catalog group), or null. */
export function inventoryItemGroup(itemId: string): InventoryItemGroup | null {
  const id = INVENTORY_CATALOG[itemId]?.inventoryGroup;
  return id ? { id, name: INVENTORY_ITEM_GROUP_NAMES[id] } : null;
}

const RESOURCE_NAMES: Readonly<Partial<Record<InventoryItemType, string>>> = {
  ...FIELD_CONSUMABLE_NAMES,
  wood: "Wood",
  stone: "Stone",
  coal: "Coal",
  iron: "Iron Ore",
  sulfur: "Sulfur",
  slag: "Slag",
  iron_bar: "Iron Bar",
  venomsteel_bar: "Venom Bar",
  venomsteel_core: "Venom Core",
  fire_feather: "Ember Feather",
  tempest_quill: "Tempest Quill",
  ice_feather: "Frost Feather",
  fire_bar: "Ember Bar",
  fire_core: "Ember Core",
  lightning_bar: "Storm Bar",
  lightning_core: "Storm Core",
  ice_bar: "Frost Bar",
  ice_core: "Frost Core",
  food: "Food",
  simple_food: "Simple Food",
  freshwater_fish: "Freshwater Fish",
  ashen_fish: "Freshwater Fish",
  fishing_rod: "Fishing Rod",
  ore: "Ore",
  water: "Water",
  leather: "Leather",
  flax_fiber: "Flax Fiber",
  cloth: "Cloth",
  deer_hide: "Deer Hide",
  hog_hide: "Hog Hide",
  wolf_pelt: "Wolf Pelt",
  bear_hide: "Bear Hide",
  alligator_hide: "Alligator Hide",
  squid_flesh: "Squid Flesh",
  squid_meat: "Squid Meat",
  deer_meat: "Deer Meat",
  wolf_meat: "Wolf Meat",
  hog_meat: "Hog Meat",
  bear_meat: "Bear Meat",
  alligator_meat: "Alligator Meat",
  wild_meat: "Wild Meat",
  crab_carapace: "Crab Carapace",
  raw_meat: "Raw Meat (Legacy)",
  shell: "Shell (Legacy)",
  chitin: "Chitin",
  giving_berry: "Giving Berry",
  balsam_resin: "Frond Sap",
  repair_kit: "Repair Kit",
  torch: "Torch",
  shovel: "Shovel",
  crude_oil: "Crude Oil",
  jellyfish_venom: "Jellyfish Venom",
  brood_silk: "Brood Silk",
  raptor_scale: "Raptor Scale",
  giant_egg: "Giant Egg",
  brood_egg: "Brood Egg",
  clutch_egg: "Fangrock Clutch Egg",
  crawler_egg: "Crawler Egg",
  broken_whistle: "Broken Whistle",
  bonewrought_blade: "Bonewrought Blade",
  bonewrought_mail: "Bonewrought Mail",
  survey_stake_kit: "Survey Stake Kit",
  compass: "Compass",
  lamp_sheath: "Lamp Sheath",
  cinder_lantern: "Cinder Lantern",
  challengers_lantern: "Challenger's Lantern",
  loadout_scroll: "Loadout Scroll",
  elder_acorn: "Elder Acorn",
  prison_key_fragment: "Prison Key Fragment",
  zephyr: "Zephyr",
  cave_lichen: "Cave Lichen",
  gale_plume: "Gale Plume",
  heartsap: "Heartsap",
  wyrm_egg: "Wyrm Egg",
  dragon_scale: "Dragon Scale",
  maw_bloom_petal: "Maw Bloom Petal",
  refined_oil: "Glimmer Oil",
  bricks: "Bricks",
  crystal: "Crystal",
  pearl: "Pearl",
  atlas_shrine_shard: "Atlas Shrine Shard",
  lichen: "Lichen",
  thistle: "Thistle",
  umbral_essence: "Umbral Essence",
  dusk_heart: "Dusk Heart",
  bloom_petal: "Bloom Petal",
  gearwork_essence: "Gearwork Essence",
  gale_splinter: "Gale Splinter",
  griffin_plume: "Griffin Plume",
  edict_seal: "Edict Seal",
  skyrise_stone: "Skyrise Stone",
  mist_drop: "Mist Drop",
  revenant_bar: "Revenant Bar",
  expel_bar: "Expel Bar",
  mirage_bar: "Mirage Bar",
  gale_bar: "Gale Bar",
  fleet_bar: "Fleet Bar",
  whetted_bar: "Whetted Bar",
  vengeance_bar: "Vengeance Bar",
  gloom_bar: "Gloom Bar",
  skyrise_bar: "Skyrise Bar",
  vital_bar: "Vital Bar",
  enchantment_stone: "Enchantment Stone",
  lumen: "Lumen",
  gift_box: "Gift Box",
  manor_skin: "Skin",
  shellback_plate: "Shellback Plate",
  abyssal_orb: "Abyssal Orb",
  tidewater_draught: "Tidewater Draught",
  undertow_snare: "Undertow Snare",
  stillwater_orb: "Stillwater Orb",
  free_step_ward: "Free-Step Ward",
  masons_tome: "Mason's Tome",
  ring_shard: "Ring Shard",
  forge_spark: "Forge Spark",
  shard_grit: "Shard Grit",
  amulet_clasp: "Amulet Clasp",
  frog_legs: "Frog Legs",
  frost_frog_legs: "Frost Frog Legs",
  poison_frog_legs: "Poison Frog Legs",
  desert_toad_legs: "Desert Toad Legs",
  crab_meat: "Crab Meat",
  ice_crab_meat: "Ice Crab Meat",
  sand_crab_meat: "Sand Crab Meat",
  mangrove_crab_meat: "Mangrove Crab Meat",
  small_catch: "Small Catch",
  jellyfish_jelly: "Jellyfish Jelly",
  crawler_flesh: "Crawler Flesh",
  squid_cut: "Squid Cut",
  wolf_cut: "Wolf Cut",
  frost_wolf_cut: "Frost Wolf Cut",
  dune_wolf_cut: "Dune Wolf Cut",
  jungle_wolf_cut: "Jungle Wolf Cut",
  bog_wolf_cut: "Bog Wolf Cut",
  deer_cut: "Deer Cut",
  frost_deer_cut: "Frost Deer Cut",
  jungle_deer_cut: "Jungle Deer Cut",
  marsh_deer_cut: "Marsh Deer Cut",
  sand_deer_cut: "Sand Deer Cut",
  hog_cut: "Hog Cut",
  woolly_hog_cut: "Woolly Hog Cut",
  warthog_cut: "Warthog Cut",
  jungle_hog_cut: "Jungle Hog Cut",
  mud_hog_cut: "Mud Hog Cut",
  javelina_cut: "Javelina Cut",
  alligator_tail: "Alligator Tail",
  caiman_tail: "Caiman Tail",
  crocodile_tail: "Crocodile Tail",
  bear_cut: "Bear Cut",
  snow_bear_cut: "Snow Bear Cut",
  black_bear_cut: "Black Bear Cut",
  sun_bear_cut: "Sun Bear Cut",
  jungle_tapir_cut: "Jungle Tapir Cut",
  jaguar_cut: "Jaguar Cut",
  mandrill_cut: "Mandrill Cut",
  capercaillie_meat: "Capercaillie Meat",
  elk_cut: "Elk Cut",
  red_squirrel_cut: "Red Squirrel Cut",
  badger_cut: "Badger Cut",
  grey_squirrel_cut: "Grey Squirrel Cut",
  stag_beetle_cut: "Stag Beetle Cut",
  great_grey_owl_meat: "Great Grey Owl Meat",
  flying_squirrel_cut: "Flying Squirrel Cut",
  plains_bison_cut: "Plains Bison Cut",
  prairie_dog_cut: "Prairie Dog Cut",
  burrowing_owl_meat: "Burrowing Owl Meat",
  giraffe_cut: "Giraffe Cut",
  lioness_cut: "Lioness Cut",
  spotted_hyena_cut: "Spotted Hyena Cut",
  sitatunga_cut: "Sitatunga Cut",
  emperor_dragonfly_cut: "Emperor Dragonfly Cut",
  mountain_ibex_cut: "Mountain Ibex Cut",
  wild_yak_cut: "Wild Yak Cut",
  alpine_marmot_cut: "Alpine Marmot Cut",
  wild_scrub_goat_cut: "Wild Scrub Goat Cut",
  crested_porcupine_cut: "Crested Porcupine Cut",
  spur_thighed_tortoise_cut: "Spur-thighed Tortoise Cut",
  dromedary_cut: "Dromedary Cut",
  fennec_fox_cut: "Fennec Fox Cut",
  sidewinder_cut: "Sidewinder Cut",
  field_hare_cut: "Field Hare Cut",
  arctic_hare_cut: "Arctic Hare Cut",
  capybara_cut: "Capybara Cut",
  armadillo_cut: "Armadillo Cut",
  red_fox_cut: "Red Fox Cut",
  wolverine_cut: "Wolverine Cut",
  ostrich_cut: "Ostrich Cut",
  golden_eagle_cut: "Golden Eagle Cut",
  musk_ox_cut: "Musk Ox Cut",
  seal_cut: "Seal Cut",
  desert_lion_cut: "Desert Lion Cut",
  saiga_cut: "Saiga Cut",
  wild_horse_cut: "Steppe Wild Horse Cut",
  steppe_marmot_cut: "Steppe Marmot Cut",
  lemming_cut: "Lemming Cut",
  snow_goose_meat: "Snow Goose Meat",
  mammoth_cut: "Mammoth Cut",
  dire_wolf_cut: "Dire Wolf Cut",
  drake_cut: "Drake Cut",
  dragon_cut: "Dragon Cut",
  grub_meat: "Grub Meat",
  emperor_penguin_meat: "Penguin Meat",
  peary_caribou_cut: "Peary Caribou Cut",
  ice_worm_cut: "Ice Worm Cut",
  sea_otter_cut: "Sea Otter Cut",
  herring_gull_meat: "Gull Meat",
  spiny_lobster_tail: "Spiny Lobster Tail",
  hammerhead_shark_steak: "Hammerhead Steak",
  manta_ray_wing: "Manta Wing",
  humpback_whale_cut: "Whale Cut",
  muskellunge_fillet: "Muskellunge Fillet",
  mute_swan_meat: "Swan Meat",
  pike_fillet: "Pike Fillet",
  snapping_turtle_cut: "Turtle Cut",
  beaver_cut: "Beaver Cut",
  otter_cut: "Otter Cut",
  salmon_fillet: "Salmon Fillet",
  elemental_ration: "Elemental Ration",
  scorching_bird_meat: "Scorching Bird Meat",
  zappy_bird_meat: "Zappy Bird Meat",
  freezing_bird_meat: "Freezing Bird Meat",
  field_ration: "Field Ration",
  hearty_ration: "Hearty Ration",
  xoral_essence: "Xoral Essence",
  ...Object.fromEntries(Object.values(MOB_DROP_ITEMS).map((item) => [item.itemId, item.displayName]))
};
const RESOURCE_TYPE_SET = new Set<string>(RESOURCE_TYPES);
const DROPPABLE_GREENHOUSE_ITEM_SET = new Set(["gardening_bucket", "water_bucket"]);

export class InventoryDropRequestGate {
  private activeItemKey: string | null = null;

  begin(itemKey: string): boolean {
    if (this.activeItemKey !== null) {
      return false;
    }
    this.activeItemKey = itemKey;
    return true;
  }

  finish(): string | null {
    const itemKey = this.activeItemKey;
    this.activeItemKey = null;
    return itemKey;
  }
}

export type InventoryStackAction = "split" | "restack" | "move" | "reorganize";

export type PendingInventoryStackAction = {
  action: InventoryStackAction;
  startedAt: number;
};

export class InventoryStackActionRequestGate {
  private readonly pending = new Map<string, PendingInventoryStackAction>();

  begin(
    requestId: string,
    action: InventoryStackAction,
    startedAt = performance.now()
  ): void {
    this.pending.set(requestId, { action, startedAt });
  }

  finish(requestId: string | undefined): PendingInventoryStackAction | null {
    if (!requestId) return null;
    const action = this.pending.get(requestId) ?? null;
    this.pending.delete(requestId);
    return action;
  }

  has(requestId: string): boolean {
    return this.pending.has(requestId);
  }
}

export function inventoryDropSelection(row: InventoryPanelRow): InventoryDropSelection | null {
  return row.canDrop && row.quantity > 0 && row.stackId.length > 0
    ? {
        key: row.key,
        stackId: row.stackId,
        itemId: row.itemId,
        variant: row.variant,
        name: row.name,
        maxStack: row.maxStack
      }
    : null;
}

export function resolveInventoryDropSelection(
  selection: InventoryDropSelection,
  inventory: PlayerInventorySnapshot,
  protection: InventoryProtectionSnapshot | null
): ActionableInventoryDropSelection | null {
  if (!protection) return null;
  const row = inventoryPanelRows(inventory).find(
    (candidate) =>
      candidate.stackId === selection.stackId &&
      candidate.itemId === selection.itemId &&
      candidate.variant === selection.variant
  );
  if (!row) return null;
  const allocation = protection.stackAllocations.find(
    (candidate) => candidate.stackId === selection.stackId
  );
  const quantity = Math.min(
    row.quantity,
    allocation?.movableQuantity ?? 0
  );
  return quantity > 0
    ? { ...selection, quantity }
    : null;
}

export function clampInventoryDropQuantity(value: number, ownedQuantity: number): number {
  const safeOwnedQuantity = Math.max(1, Math.floor(ownedQuantity));
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.min(Math.max(Math.floor(value), 1), safeOwnedQuantity);
}

export function nextInventoryPanelOpen(
  current: boolean,
  transition: InventoryPanelTransition
): boolean {
  switch (transition) {
    case "open":
      return true;
    case "close":
      return false;
    case "toggle":
      return !current;
  }
}

export function inventoryPanelTransitionForKey(
  key: string
): InventoryPanelTransition | null {
  if (key === "Escape") {
    return "close";
  }
  if (key.toLowerCase() === "i") {
    return "toggle";
  }
  return null;
}

export function normalizeInventorySnapshot(
  value: unknown,
  fallbackPlayerId: string
): PlayerInventorySnapshot {
  const snapshot = isRecord(value) ? value : {};
  const playerId = nonEmptyString(snapshot.playerId) ?? fallbackPlayerId;
  const items = Array.isArray(snapshot.items)
    ? snapshot.items
        .map((item, index) => normalizeInventoryItem(item, playerId, index))
        .filter((item): item is PlayerInventoryItem => item !== null)
    : [];
  const totalsSource = isRecord(snapshot.totals) ? snapshot.totals : {};
  const totals = emptyInventoryTotals();
  for (const resourceType of RESOURCE_TYPES) {
    totals[resourceType] = validQuantity(totalsSource[resourceType]) ?? 0;
  }
  const rodTotal = validQuantity(totalsSource.fishing_rod);
  if (rodTotal !== null) totals.fishing_rod = rodTotal;

  return {
    playerId,
    revision: validRevision(snapshot.revision) ?? 0,
    items,
    totals,
    currentWeightGrams: validGrams(snapshot.currentWeightGrams) ?? "0",
    maximumWeightGrams: validGrams(snapshot.maximumWeightGrams) ?? String(DEFAULT_PLAYER_CARRY_CAPACITY_GRAMS)
  };
}

export function shouldAcceptInventorySnapshot(
  snapshot: PlayerInventorySnapshot,
  expectedPlayerId: string,
  highestAcceptedRevision: number
): boolean {
  return snapshot.playerId === expectedPlayerId &&
    snapshot.revision > highestAcceptedRevision;
}

export function inventoryPanelRows(
  snapshot: PlayerInventorySnapshot
): InventoryPanelRow[] {
  return snapshot.items
    .map((item, index) => ({
      key: item.entryId ?? item.stackId ?? `${String(item.resourceType)}:${item.variant ?? "default"}:${index}`,
      stackId: item.entryId ?? item.stackId ?? "",
      slotIndex: validSlotIndex(item.slotIndex) ?? index,
      itemId: String(item.resourceType),
      variant: item.variant,
      name: item.resourceType === "fishing_rod"
        ? INVENTORY_CATALOG[item.resourceType]?.displayName ?? "Fishing Rod"
        : item.resourceType === "face_mask" && item.look ? faceMaskDisplayName(item.look)
        : item.resourceType === "manor_skin" && item.look ? manorSkinDisplayName(item.look)
        : item.variant ? inventoryItemName(String(item.resourceType), item.variant) : INVENTORY_CATALOG[item.resourceType]?.displayName ?? inventoryItemName(String(item.resourceType), null),
      rarity: INVENTORY_CATALOG[item.resourceType]?.rarity ?? "common",
      ...(INVENTORY_CATALOG[item.resourceType]?.description !== undefined
        ? { description: INVENTORY_CATALOG[item.resourceType]!.description }
        : item.resourceType === "atlas_shrine_shard"
        ? {
            description:
              "A rare shard dropped by ogres. Permanently consumed only when unlocking an Atlas Shrine slot."
          }
        : {}),
      quantity: validQuantity(item.quantity) ?? 0,
      unitWeightGrams: item.unitWeightGrams ?? presentationItemWeightGrams(String(item.resourceType)),
      totalWeightGrams: item.totalWeightGrams ?? String(BigInt(Math.floor(item.quantity)) * BigInt(item.unitWeightGrams ?? presentationItemWeightGrams(String(item.resourceType)))),
      maxStack: validQuantity(item.maxStack) ?? INVENTORY_CATALOG[item.resourceType]?.maxStack ?? 1,
      canDrop: item.resourceType !== "fishing_rod" &&
        (RESOURCE_TYPE_SET.has(String(item.resourceType)) || DROPPABLE_GREENHOUSE_ITEM_SET.has(String(item.resourceType))) &&
        INVENTORY_CATALOG[item.resourceType]?.droppable === true &&
        item.quantity > 0,
      canUse: (item.resourceType === "giving_berry" || item.resourceType === "lamp_sheath" || isFieldConsumableItemId(String(item.resourceType)) || item.resourceType === "simple_food" || item.resourceType === "fishing_rod" || item.resourceType === "gardening_bucket" || item.resourceType === "water_bucket" || item.resourceType === "survey_stake_kit" || item.resourceType === "compass" || item.resourceType === "shovel") && item.quantity > 0 && (item.resourceType !== "fishing_rod" || (item.usesRemaining ?? 0) > 0),
      ...(item.resourceType === "fishing_rod" ? { usesRemaining: item.usesRemaining ?? 0 } : {}),
      ...(item.resourceType === "fishing_rod" && (item.rodId ?? item.variant) ? { rodId: item.rodId ?? item.variant! } : {}),
      ...(item.look ? { look: item.look } : {}),
      ...(item.provenance ? { provenance: item.provenance } : {}),
      ...(item.equipped ? { equipped: true } : {}),
      manualSplit: item.manualSplit === true
    }))
    .filter((item) => item.quantity > 0)
    .sort((left, right) => left.name.localeCompare(right.name) || left.key.localeCompare(right.key));
}

export function inventoryDropFeedback(message: unknown): string {
  return typeof message === "string" && message.trim() ? message.trim() : "Item dropped.";
}

function normalizeInventoryItem(
  value: unknown,
  fallbackPlayerId: string,
  fallbackSlotIndex: number
): PlayerInventoryItem | null {
  if (!isRecord(value)) {
    return null;
  }
  const resourceType = nonEmptyString(value.resourceType);
  const quantity = validQuantity(value.quantity);
  if (!resourceType || quantity === null || quantity === 0) {
    return null;
  }
  return {
    playerId: nonEmptyString(value.playerId) ?? fallbackPlayerId,
    resourceType: resourceType as InventoryItemType,
    variant: nonEmptyString(value.variant),
    quantity,
    entryId: nonEmptyString(value.entryId) ?? nonEmptyString(value.stackId) ?? "",
    unitWeightGrams: validQuantity(value.unitWeightGrams) ?? presentationItemWeightGrams(resourceType),
    totalWeightGrams: validGrams(value.totalWeightGrams) ?? String(BigInt(Math.floor(quantity)) * BigInt(presentationItemWeightGrams(resourceType))),
    maxStack: validQuantity(value.maxStack) ?? INVENTORY_CATALOG[resourceType]?.maxStack ?? 1,
    ...(nonEmptyString(value.stackId) ? { stackId: nonEmptyString(value.stackId)! } : {}),
    slotIndex: validSlotIndex(value.slotIndex) ?? fallbackSlotIndex,
    ...(nonEmptyString(value.look) ? { look: nonEmptyString(value.look)! } : {}),
    ...(isRecord(value.provenance) && nonEmptyString(value.provenance.tag) && nonEmptyString(value.provenance.originalBuyerName)
      ? { provenance: { tag: nonEmptyString(value.provenance.tag)!, originalBuyerName: nonEmptyString(value.provenance.originalBuyerName)! } }
      : {}),
    ...(value.equipped === true ? { equipped: true } : {}),
    manualSplit: value.manualSplit === true,
    ...(typeof value.rodId === "string" ? { rodId: value.rodId } : {}),
    ...(typeof value.usesRemaining === "number" && Number.isFinite(value.usesRemaining) ? { usesRemaining: Math.max(0, Math.floor(value.usesRemaining)) } : {})
  };
}

function inventoryItemName(itemId: string, variant: string | null): string {
  const baseName = RESOURCE_NAMES[itemId as ResourceType] ?? humanizeIdentifier(itemId);
  const safeBaseName = baseName || "Unknown item";
  const variantName = variant ? humanizeIdentifier(variant) : "";
  return variantName ? `${variantName} ${safeBaseName}` : safeBaseName;
}

function humanizeIdentifier(value: string): string {
  return value
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function validQuantity(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function validSlotIndex(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function validGrams(value: unknown): string | null {
  return typeof value === "string" && /^\d+$/.test(value) ? value : null;
}

function validRevision(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : null;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// Unknown legacy presentation metadata must not hide retained items. Live capacity remains server-owned.
function presentationItemWeightGrams(itemId: string): number {
  return INVENTORY_CATALOG[itemId] ? getItemWeightGrams(itemId) : 0;
}
