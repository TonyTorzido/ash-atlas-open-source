import {
  FIELD_CONSUMABLE_NAMES,
  DEFAULT_PLAYER_CARRY_CAPACITY_GRAMS,
  getItemWeightGrams,
  DROPPED_ITEM_PICKUP_RADIUS_M,
  MANOR_DROPPED_ITEM_PICKUP_EPSILON,
  MOB_DROP_ITEMS,
  distanceMeters,
  requireBackpackDefinition,
  requireEquipmentDefinition,
  type DroppedItemSnapshot,
  type IndoorPoint,
  type LatLon,
  type ManorPosition,
  type PlayerInventorySnapshot,
  type ResourceType
} from "@ash-atlas/shared";

import { getClosestInteractionApproachPoint } from "../movement/interactionApproach.js";

export const DROPPED_ITEM_APPROACH_BUFFER_M = 2;

export type DroppedItemInteractionPhase = "approaching" | "ready" | "requesting";

export type DroppedItemPickupIntent =
  | { mode: "all" }
  | { mode: "quantity"; quantity: number };

export type DroppedItemPickupPlanEntry = Readonly<{
  dropId: string;
  intent: DroppedItemPickupIntent;
}>;

export type DroppedItemPileStack = Readonly<{
  key: string;
  drops: readonly DroppedItemSnapshot[];
  displayDrop: DroppedItemSnapshot;
}>;

export type DroppedItemInteraction = {
  dropId: string;
  phase: DroppedItemInteractionPhase;
  intent: DroppedItemPickupIntent;
  /** Exact authored Manor floor coordinate retained throughout an approach. */
  manorTarget?: IndoorPoint;
  /** Movement request that must settle before the pickup command is emitted. */
  manorMoveRequestId?: string;
};

export type DroppedItemInteractionCommand =
  | { type: "move-to-range"; target: LatLon }
  | { type: "move-to-manor-position"; target: IndoorPoint }
  | { type: "pickup"; dropId: string; intent: DroppedItemPickupIntent };

export type DroppedItemInteractionTransition = {
  interaction: DroppedItemInteraction | null;
  command: DroppedItemInteractionCommand | null;
};

export function selectDroppedItem(dropId: string): {
  selectedDropId: string;
  interaction: null;
  command: null;
} {
  return { selectedDropId: dropId, interaction: null, command: null };
}

const ITEM_NAMES: Readonly<Partial<Record<ResourceType, string>>> = {
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
  manor_skin: "Manor Skin",
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

export class DroppedItemPickupRequestGate {
  private activeDropId: string | null = null;

  begin(dropId: string): boolean {
    if (this.activeDropId !== null) {
      return false;
    }
    this.activeDropId = dropId;
    return true;
  }

  finish(expectedDropId?: string): string | null {
    if (expectedDropId !== undefined && this.activeDropId !== expectedDropId) {
      return null;
    }
    const dropId = this.activeDropId;
    this.activeDropId = null;
    return dropId;
  }

  getActiveDropId(): string | null {
    return this.activeDropId;
  }
}

export function startDroppedItemInteraction(
  player: LatLon,
  drop: DroppedItemSnapshot,
  intent: DroppedItemPickupIntent
): DroppedItemInteractionTransition {
  const approachTarget = getClosestInteractionApproachPoint(
    player,
    drop,
    DROPPED_ITEM_PICKUP_RADIUS_M,
    DROPPED_ITEM_APPROACH_BUFFER_M
  );
  if (approachTarget) {
    return {
      interaction: { dropId: drop.dropId, phase: "approaching", intent },
      command: { type: "move-to-range", target: approachTarget }
    };
  }
  return {
    interaction: { dropId: drop.dropId, phase: "ready", intent },
    command: { type: "pickup", dropId: drop.dropId, intent }
  };
}

/**
 * Manor floor drops are approached at their authored coordinate, rather than
 * at a player-facing pickup radius. The server independently verifies the
 * same small arrival tolerance before changing inventory.
 */
export function startManorDroppedItemInteraction(
  player: ManorPosition,
  drop: DroppedItemSnapshot,
  intent: DroppedItemPickupIntent
): DroppedItemInteractionTransition {
  if (drop.status !== "active") return { interaction: null, command: null };
  const target = manorDropTarget(drop);
  if (!target) return { interaction: null, command: null };
  const interaction = {
    dropId: drop.dropId,
    intent,
    manorTarget: target
  } satisfies Omit<DroppedItemInteraction, "phase">;
  if (!player.moving && manorDistance(player, target) <= MANOR_DROPPED_ITEM_PICKUP_EPSILON) {
    return {
      interaction: { ...interaction, phase: "ready" },
      command: { type: "pickup", dropId: drop.dropId, intent }
    };
  }
  return {
    interaction: { ...interaction, phase: "approaching" },
    command: { type: "move-to-manor-position", target }
  };
}

export function advanceDroppedItemInteraction(
  interaction: DroppedItemInteraction,
  player: LatLon,
  drop: DroppedItemSnapshot | null
): DroppedItemInteractionTransition {
  if (!drop || drop.dropId !== interaction.dropId || drop.status !== "active") {
    return { interaction: null, command: null };
  }
  if (interaction.phase !== "approaching" || !canPickupDroppedItem(distanceToDroppedItem(player, drop))) {
    return { interaction, command: null };
  }
  return {
    interaction: { ...interaction, phase: "ready" },
    command: { type: "pickup", dropId: drop.dropId, intent: interaction.intent }
  };
}

export function advanceManorDroppedItemInteraction(
  interaction: DroppedItemInteraction,
  player: ManorPosition,
  drop: DroppedItemSnapshot | null
): DroppedItemInteractionTransition {
  const target = manorDropTarget(drop);
  if (
    !drop ||
    drop.dropId !== interaction.dropId ||
    drop.status !== "active" ||
    !interaction.manorTarget ||
    !target ||
    target.x !== interaction.manorTarget.x ||
    target.y !== interaction.manorTarget.y
  ) {
    return { interaction: null, command: null };
  }
  if (
    interaction.phase !== "approaching" ||
    player.moving ||
    manorDistance(player, interaction.manorTarget) > MANOR_DROPPED_ITEM_PICKUP_EPSILON
  ) {
    return { interaction, command: null };
  }
  return {
    interaction: { ...interaction, phase: "ready" },
    command: { type: "pickup", dropId: drop.dropId, intent: interaction.intent }
  };
}

export function markDroppedItemPickupRequesting(
  interaction: DroppedItemInteraction
): DroppedItemInteraction {
  return interaction.phase === "ready" ? { ...interaction, phase: "requesting" } : interaction;
}

export function clearDroppedItemInteraction(): DroppedItemInteractionTransition {
  return { interaction: null, command: null };
}

export function clampDroppedItemPickupQuantity(quantity: number, available: number): number {
  const max = Math.max(1, Math.floor(available));
  if (!Number.isFinite(quantity)) {
    return 1;
  }
  return Math.min(max, Math.max(1, Math.floor(quantity)));
}

export function recommendedDroppedItemPickupQuantity(
  drop: DroppedItemSnapshot,
  inventory: PlayerInventorySnapshot
): number {
  if (drop.equipmentInstanceId || drop.backpackInstanceId) return 1;
  const weight = BigInt(getItemWeightGrams(drop.itemId));
  const remaining = BigInt(inventory.maximumWeightGrams ?? DEFAULT_PLAYER_CARRY_CAPACITY_GRAMS) - BigInt(inventory.currentWeightGrams ?? "0");
  const fitting = weight === 0n ? BigInt(Math.floor(drop.quantity)) : remaining > 0n ? remaining / weight : 0n;
  const available = BigInt(Math.floor(drop.quantity));
  return clampDroppedItemPickupQuantity(Number(fitting < available ? fitting : available), drop.quantity);
}

export function activeDroppedItems(
  drops: DroppedItemSnapshot[],
  nowMs = Date.now()
): DroppedItemSnapshot[] {
  return drops.filter(
    (drop) => drop.status === "active" && Date.parse(drop.expiresAt) > nowMs
  );
}

export function stackDroppedItemPile(
  drops: readonly DroppedItemSnapshot[]
): DroppedItemPileStack[] {
  const ordered = [...drops].sort(compareDroppedItemPileOrder);
  const byItem = new Map<string, DroppedItemSnapshot[]>();
  for (const drop of ordered) {
    const key = drop.equipmentInstanceId ?? drop.backpackInstanceId ?? `${drop.itemId}:${drop.variant ?? ""}`;
    const stack = byItem.get(key);
    if (stack) stack.push(drop);
    else byItem.set(key, [drop]);
  }
  return [...byItem.entries()].map(([key, stack]) => ({
    key,
    drops: stack,
    displayDrop: {
      ...stack[0]!,
      quantity: stack.reduce((total, drop) => total + drop.quantity, 0)
    }
  }));
}

/**
 * Return every active Manor row that can be selected from one floor-drop hit.
 *
 * Pile IDs are authoritative for normal grouping. The coordinate fallback is
 * intentionally limited to transport-level float tolerance so legacy recovery
 * rows with a different pile ID are visible without swallowing nearby piles.
 */
export function manorDroppedItemSelectionCandidates(
  selected: DroppedItemSnapshot,
  drops: readonly DroppedItemSnapshot[]
): DroppedItemSnapshot[] {
  const selectedPileId = selected.pileId ?? selected.dropId;
  return drops
    .filter((drop) => drop.status === "active")
    .filter((drop) =>
      (drop.pileId ?? drop.dropId) === selectedPileId ||
      manorDropCoordinatesMatch(selected, drop)
    )
    .sort(compareDroppedItemPileOrder);
}

export function stackDroppedItemsForWorld(
  drops: readonly DroppedItemSnapshot[]
): DroppedItemPileStack[] {
  const piles = new Map<string, DroppedItemSnapshot[]>();
  for (const drop of drops) {
    const pileId = drop.pileId ?? drop.dropId;
    const pile = piles.get(pileId);
    if (pile) pile.push(drop);
    else piles.set(pileId, [drop]);
  }
  return [...piles.entries()].flatMap(([pileId, pile]) =>
    stackDroppedItemPile(pile).map((stack) => ({
      ...stack,
      key: `${pileId}:${stack.key}`
    }))
  );
}

export function planDroppedItemStackPickup(
  drops: readonly DroppedItemSnapshot[],
  quantity: number | "all"
): DroppedItemPickupPlanEntry[] {
  const ordered = [...drops].sort(compareDroppedItemPileOrder);
  if (quantity === "all") {
    return ordered.map((drop) => ({ dropId: drop.dropId, intent: { mode: "all" } }));
  }
  let remaining = clampDroppedItemPickupQuantity(
    quantity,
    ordered.reduce((total, drop) => total + drop.quantity, 0)
  );
  const plan: DroppedItemPickupPlanEntry[] = [];
  for (const drop of ordered) {
    if (remaining <= 0) break;
    const requested = Math.min(remaining, drop.quantity);
    plan.push({
      dropId: drop.dropId,
      intent: requested === drop.quantity
        ? { mode: "all" }
        : { mode: "quantity", quantity: requested }
    });
    remaining -= requested;
  }
  return plan;
}

export function droppedItemDisplayName(drop: Pick<DroppedItemSnapshot, "itemId" | "variant">): string {
  const baseName = ITEM_NAMES[drop.itemId as ResourceType] ?? (() => {
    try {
      return requireEquipmentDefinition(drop.itemId).displayName;
    } catch {
      return requireBackpackDefinition(drop.itemId).displayName;
    }
  })();
  if (!drop.variant) {
    return baseName;
  }
  return `${humanizeIdentifier(drop.variant)} ${baseName}`;
}

export function distanceToDroppedItem(player: LatLon, drop: DroppedItemSnapshot): number {
  return distanceMeters(player, drop);
}

export function canPickupDroppedItem(distanceM: number | null): boolean {
  return distanceM !== null && distanceM <= DROPPED_ITEM_PICKUP_RADIUS_M;
}

function manorDropTarget(drop: DroppedItemSnapshot | null): IndoorPoint | null {
  if (
    !drop ||
    !Number.isFinite(drop.localX) ||
    !Number.isFinite(drop.localY)
  ) return null;
  return { x: drop.localX!, y: drop.localY! };
}

function manorDistance(player: IndoorPoint, target: IndoorPoint): number {
  return Math.hypot(player.x - target.x, player.y - target.y);
}

function humanizeIdentifier(value: string): string {
  return value
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function compareDroppedItemPileOrder(
  left: DroppedItemSnapshot,
  right: DroppedItemSnapshot
): number {
  return (left.pileOrder ?? 0) - (right.pileOrder ?? 0)
    || left.dropId.localeCompare(right.dropId);
}

function manorDropCoordinatesMatch(
  left: DroppedItemSnapshot,
  right: DroppedItemSnapshot
): boolean {
  return Boolean(
    left.manorId && left.manorId === right.manorId &&
    left.spaceId && left.spaceId === right.spaceId &&
    Number.isFinite(left.localX) && Number.isFinite(left.localY) &&
    Number.isFinite(right.localX) && Number.isFinite(right.localY) &&
    Math.hypot(left.localX! - right.localX!, left.localY! - right.localY!)
      <= MANOR_DROPPED_ITEM_PICKUP_EPSILON
  );
}
