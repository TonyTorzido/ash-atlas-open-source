import type { ResourceType } from "./collectibles.js";
import type { EquipmentSlot } from "./equipmentContracts.js";

/**
 * Loadout Scrolls: gear sets for fast swaps. A scroll remembers equipment instance ids (never
 * copies) and equips whichever of them the player still carries. Crafting is limited to Atlas Pass
 * members; anyone can use one. Scrolls are an ordinary inventory item; each carried scroll is a
 * numbered position (1..count) whose memory belongs to its holder, so a traded or dropped scroll
 * always arrives empty.
 */
export const LOADOUT_SCROLL_ITEM_ID = "loadout_scroll" as const;
export const LOADOUT_SCROLL_DISPLAY_NAME = "Loadout Scroll";
export const LOADOUT_SCROLL_DESCRIPTION =
  "Remembers your weapons and armor, and your rings, then equips them again in one tap. Never used up.";

export const LOADOUT_SCROLL_MATERIALS: readonly Readonly<{ itemId: ResourceType; quantity: number }>[] = Object.freeze([
  { itemId: "lumen", quantity: 60 },
  { itemId: "gearwork_essence", quantity: 120 },
  { itemId: "cloth", quantity: 8 }
] as const);

/** Melee weapon, ranged weapon or shield, head and chest armor. Utility gloves and boots are never remembered. */
export const GEAR_SCROLL_WEAPON_ARMOR_SLOTS = ["melee", "secondary", "head", "chest"] as const satisfies readonly EquipmentSlot[];
export const GEAR_SCROLL_JEWELRY_SLOTS = ["ring", "ring_2"] as const satisfies readonly EquipmentSlot[];
export const GEAR_SCROLL_SLOTS = [...GEAR_SCROLL_WEAPON_ARMOR_SLOTS, ...GEAR_SCROLL_JEWELRY_SLOTS] as const;
export type GearScrollSlot = (typeof GEAR_SCROLL_SLOTS)[number];

export const GEAR_SCROLL_MEMORY_GROUPS = ["weapons_armor", "jewelry"] as const;
export type GearScrollMemoryGroup = (typeof GEAR_SCROLL_MEMORY_GROUPS)[number];

export function gearScrollSlotsForGroup(group: GearScrollMemoryGroup): readonly GearScrollSlot[] {
  return group === "weapons_armor" ? GEAR_SCROLL_WEAPON_ARMOR_SLOTS : GEAR_SCROLL_JEWELRY_SLOTS;
}

/** Scrolls the Gear quick slot fans out (positions 1..3). */
export const GEAR_SLOT_SCROLL_LIMIT = 3;

export type GearScrollRememberedItem = Readonly<{
  slot: GearScrollSlot;
  instanceId: string;
  definitionId: string | null;
  displayName: string | null;
  /** False when the item is no longer carried; an equip skips it. */
  carried: boolean;
}>;

export type GearScrollView = Readonly<{
  /** 1-based position among the carried scrolls. */
  position: number;
  items: readonly GearScrollRememberedItem[];
}>;

export type GearScrollsSnapshot = Readonly<{
  /** Carried Loadout Scrolls; positions 1..count are usable. */
  count: number;
  scrolls: readonly GearScrollView[];
  /** Position of the scroll most recently equipped this session, if any. */
  lastEquippedPosition: number | null;
}>;
