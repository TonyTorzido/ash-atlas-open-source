import type { ResourceType } from "./collectibles.js";

/**
 * Field consumables: early potions plus Nets and Traps. The server is
 * authoritative for every effect; this file is the shared balance, recipe and
 * wording source for the server, the Crafting panel and the buff indicators.
 * The Tidecraft items (water game phase D) use the same framework and need a
 * Tidecraft rank to craft (FIELD_CONSUMABLE_SKILL_REQUIREMENTS).
 */
export const FIELD_CONSUMABLE_ITEM_IDS = [
  "anti_venom_tonic",
  "battle_draught",
  "ember_flask",
  "spark_tonic",
  "field_net",
  "field_trap",
  "tidewater_draught",
  "undertow_snare",
  "stillwater_orb",
  "free_step_ward",
  "masons_tome",
  "vigor_serum",
  "mending_resin"
] as const;
export type FieldConsumableItemId = (typeof FIELD_CONSUMABLE_ITEM_IDS)[number];

export function isFieldConsumableItemId(itemId: string): itemId is FieldConsumableItemId {
  return (FIELD_CONSUMABLE_ITEM_IDS as readonly string[]).includes(itemId);
}

export const FIELD_CONSUMABLE_NAMES: Readonly<Record<FieldConsumableItemId, string>> = Object.freeze({
  anti_venom_tonic: "Anti-Venom Tonic",
  battle_draught: "Battle Draught",
  ember_flask: "Ember Bomb",
  spark_tonic: "Spark Tonic",
  field_net: "Net",
  field_trap: "Trap",
  tidewater_draught: "Tidewater Draught",
  undertow_snare: "Undertow Snare",
  stillwater_orb: "Stillwater Orb",
  free_step_ward: "Free-Step Ward",
  masons_tome: "Mason's Tome",
  vigor_serum: "Vigor Serum",
  mending_resin: "Mending Resin"
});

/**
 * Timed buffs stored in the database (one row per player and buff). Anti-Venom
 * and the Spark Tonic last through death and logout; the Tidewater Draught lasts
 * through logout but is lost on death.
 */
export const FIELD_PERSISTENT_BUFF_IDS = ["anti_venom", "inspiration", "tidewater", "vigor_serum"] as const;
export type FieldPersistentBuffId = (typeof FIELD_PERSISTENT_BUFF_IDS)[number];
/** Every buff the indicator can show. The Battle Draught lives only in the combat engine. */
export type FieldBuffId = FieldPersistentBuffId | "battle_draught";

export const FIELD_BUFF_FOR_ITEM = Object.freeze({
  anti_venom_tonic: "anti_venom",
  spark_tonic: "inspiration",
  tidewater_draught: "tidewater",
  vigor_serum: "vigor_serum"
} as const satisfies Partial<Record<FieldConsumableItemId, FieldPersistentBuffId>>);
export type FieldBuffItemId = keyof typeof FIELD_BUFF_FOR_ITEM;

export const FIELD_BUFF_LABELS: Readonly<Record<FieldBuffId, Readonly<{ name: string; detail: string }>>> = Object.freeze({
  anti_venom: { name: "Anti-Venom", detail: "Immune to Venom." },
  inspiration: { name: "Spark Tonic", detail: "+12% Bricks and City Coins." },
  tidewater: { name: "Tidewater Draught", detail: "Full speed on water. Lost on death." },
  vigor_serum: { name: "Vigor Serum", detail: "+120 max health. Lost on death." },
  battle_draught: { name: "Battle Draught", detail: "+5 Attack, -3 Defense; you may travel while Aggressive." }
});

export const FIELD_BUFF_DURATION_MS = 55 * 60 * 1_000;
/** Vigor Serum lasts longer than the other tonics. */
export const VIGOR_SERUM_DURATION_MS = 75 * 60 * 1_000;
/**
 * Mending Resin repairs worn gear by this many condition points (condition is a 0-100 percentage),
 * or the Alchemy rank 1 amount. Condition is capped at EQUIPMENT_MAX_CONDITION (100): the stored
 * condition has a 0-100 check, so repairs above 100% are not supported.
 */
export const MENDING_RESIN_REPAIR_POINTS = 12;
export const MENDING_RESIN_ALCHEMY_REPAIR_POINTS = 17;
export const MENDING_RESIN_ALCHEMY_MIN_RANK = 1;

/** Vigor Serum: flat max-health bonus while the buff lasts (the drink heals that much too). */
export const VIGOR_SERUM_MAX_HEALTH_BONUS = 120;
/** Spark Tonic bonus to Bricks and City Coins earned, in percent. */
export const INSPIRATION_BONUS_PERCENT = 12;

/** Battle Draught: costs this share of max health to drink, then lasts while you stay Aggressive. */
export const BATTLE_DRAUGHT_HEALTH_COST_FRACTION = 0.12;
/** Attack and Defense stat points (the units weapons, rings and the Challenger's Lantern use) while the draught lasts. */
export const BATTLE_DRAUGHT_ATTACK_BONUS = 5;
export const BATTLE_DRAUGHT_DEFENSE_PENALTY = 3;
/** Time to become Aggressive after drinking before the draught is wasted. */
export const BATTLE_DRAUGHT_ENGAGE_WINDOW_MS = 30_000;

export const EMBER_FLASK_RADIUS_M = 9;
export const EMBER_FLASK_DAMAGE = 46;

export const NET_RANGE_M = 12;
export const NET_HOLD_MS = 7_000;
export const TRAP_TRIGGER_RADIUS_M = 2.5;
export const TRAP_HOLD_MS = 5_000;
export const TRAP_LIFETIME_MS = 12 * 60 * 1_000;

export type FieldBuffSnapshot = Readonly<{
  buffId: FieldBuffId;
  /** Epoch milliseconds. */
  startedAt: number;
  /** Epoch milliseconds, or null when the buff lasts while you stay Aggressive. */
  endsAt: number | null;
}>;

export type FieldConsumableRecipe = Readonly<{
  itemId: FieldConsumableItemId;
  output: number;
  inputs: readonly Readonly<{ itemId: ResourceType; quantity: number }>[];
}>;

/**
 * Recipes use existing resources and are crafted from the personal Crafting
 * panel. Alchemy gating is a follow-up.
 */
export const FIELD_CONSUMABLE_RECIPES: Readonly<Record<FieldConsumableItemId, FieldConsumableRecipe>> = Object.freeze({
  anti_venom_tonic: {
    itemId: "anti_venom_tonic",
    output: 1,
    inputs: [
      { itemId: "jellyfish_venom", quantity: 1 },
      { itemId: "flux_plant", quantity: 4 },
      { itemId: "lichen", quantity: 1 },
      { itemId: "balsam_resin", quantity: 1 }
    ]
  },
  battle_draught: {
    itemId: "battle_draught",
    output: 1,
    inputs: [
      { itemId: "crystal", quantity: 1 },
      { itemId: "sulfur", quantity: 4 },
      { itemId: "chitin", quantity: 2 },
      { itemId: "balsam_resin", quantity: 1 }
    ]
  },
  ember_flask: {
    itemId: "ember_flask",
    output: 5,
    inputs: [
      { itemId: "crude_oil", quantity: 2 },
      { itemId: "sulfur", quantity: 4 },
      { itemId: "balsam_resin", quantity: 2 }
    ]
  },
  spark_tonic: {
    itemId: "spark_tonic",
    output: 1,
    inputs: [
      { itemId: "flux_plant", quantity: 7 },
      { itemId: "chitin", quantity: 1 },
      { itemId: "balsam_resin", quantity: 2 }
    ]
  },
  field_net: {
    itemId: "field_net",
    output: 1,
    inputs: [
      { itemId: "stone", quantity: 2 },
      { itemId: "cloth", quantity: 10 },
      { itemId: "leather", quantity: 3 }
    ]
  },
  field_trap: {
    itemId: "field_trap",
    output: 1,
    inputs: [{ itemId: "iron_bar", quantity: 2 }]
  },
  tidewater_draught: {
    itemId: "tidewater_draught",
    output: 1,
    inputs: [
      { itemId: "pearl", quantity: 1 },
      { itemId: "shellback_plate", quantity: 24 },
      { itemId: "lichen", quantity: 2 }
    ]
  },
  undertow_snare: {
    itemId: "undertow_snare",
    output: 1,
    inputs: [
      { itemId: "pearl", quantity: 2 },
      { itemId: "bloom_petal", quantity: 1 },
      { itemId: "shellback_plate", quantity: 26 }
    ]
  },
  stillwater_orb: {
    itemId: "stillwater_orb",
    output: 4,
    inputs: [
      { itemId: "sulfur", quantity: 3 },
      { itemId: "pearl", quantity: 2 },
      { itemId: "shellback_plate", quantity: 56 }
    ]
  },
  free_step_ward: {
    itemId: "free_step_ward",
    output: 1,
    inputs: [
      { itemId: "abyssal_orb", quantity: 1 },
      { itemId: "pearl", quantity: 2 },
      { itemId: "griffin_plume", quantity: 6 }
    ]
  },
  vigor_serum: {
    itemId: "vigor_serum",
    output: 1,
    inputs: [
      { itemId: "bloom_petal", quantity: 2 },
      { itemId: "balsam_resin", quantity: 1 },
      { itemId: "thistle", quantity: 2 }
    ]
  },
  mending_resin: {
    itemId: "mending_resin",
    output: 4,
    inputs: [
      { itemId: "balsam_resin", quantity: 2 },
      { itemId: "grub_meat", quantity: 1 }
    ]
  },
  masons_tome: {
    itemId: "masons_tome",
    output: 1,
    inputs: [
      { itemId: "pearl", quantity: 4 },
      { itemId: "iron", quantity: 6 },
      { itemId: "shellback_plate", quantity: 90 }
    ]
  }
});

/** World Knowledge rank needed to craft an item (the other recipes are open to everyone). */
export const FIELD_CONSUMABLE_SKILL_REQUIREMENTS: Readonly<Partial<Record<
  FieldConsumableItemId,
  Readonly<{ skillId: "tidecraft"; rank: 1 | 2 | 3 }>
>>> = Object.freeze({
  tidewater_draught: { skillId: "tidecraft", rank: 1 },
  undertow_snare: { skillId: "tidecraft", rank: 1 },
  stillwater_orb: { skillId: "tidecraft", rank: 2 },
  free_step_ward: { skillId: "tidecraft", rank: 2 },
  masons_tome: { skillId: "tidecraft", rank: 3 }
});

export const FIELD_CONSUMABLE_DESCRIPTIONS: Readonly<Record<FieldConsumableItemId, string>> = Object.freeze({
  anti_venom_tonic: "Grants immunity to Venom for 55 minutes. Lasts through death.",
  battle_draught: "Costs 12% of your max health. While you stay Aggressive, you gain +5 Attack and -3 Defense and may travel.",
  ember_flask: "Throw it at your feet: it burns everything hostile within 9 meters, structures included.",
  spark_tonic: "For 55 minutes, earn 12% more Bricks and City Coins. Lasts through death.",
  field_net: "Use on a monster to hold it in place for 7 seconds. It cannot move or attack. Bosses and players are immune.",
  field_trap: "Set at your feet. The first hostile monster to walk in is held for 5 seconds. Lasts 12 minutes; one at a time. Bosses are immune.",
  tidewater_draught: "Full land speed on water for 75 minutes (150 minutes at Tidecraft rank 3). Lost on death.",
  undertow_snare: "Set at your feet. For 6 minutes it pulls nearby creatures and players toward it. At Tidecraft rank 3 it spares your allies.",
  stillwater_orb: "Throw it at your target (or your feet): everything hostile within 7 meters is rooted for 13 seconds. Thrown at Tidecraft rank 2 or higher, it also blocks their healing.",
  free_step_ward: "Raise a ward as wide as a flag's claim for 12 minutes. Nobody inside can be rooted, netted or trapped. At Tidecraft rank 3 it protects only your allies.",
  mending_resin: "Use on worn or carried chest armor to restore 12% condition (17% at Alchemy rank 1).",
  vigor_serum: "Drink for +120 max health for 75 minutes (105 minutes at Alchemy rank 2). It heals you by 120 as your maximum rises. Lost on death; lasts through logout.",
  masons_tome: "Use while you repair a building: the rest of that repair takes half the time. One tome per repair."
});

/** Items that need a selected monster. */
export function fieldConsumableNeedsTarget(itemId: FieldConsumableItemId): boolean {
  return itemId === "field_net";
}
