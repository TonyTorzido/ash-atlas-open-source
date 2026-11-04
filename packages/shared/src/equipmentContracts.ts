export const EQUIPMENT_SLOTS = [
  "head",
  "chest",
  "gloves",
  "boots",
  "ring",
  "ring_2",
  "melee",
  "secondary",
  /** Gathering tools, one slot per kind. Looks only: they never add combat stats. */
  "tool_axe",
  "tool_pickaxe",
  "tool_fishing_pole"
] as const;
export type EquipmentSlot = (typeof EQUIPMENT_SLOTS)[number];

/** Gathering tool slots: axe (chop), pickaxe (mine), fishing pole (fish). */
export const GATHERING_TOOL_SLOTS = ["tool_axe", "tool_pickaxe", "tool_fishing_pole"] as const;
export type GatheringToolSlot = (typeof GATHERING_TOOL_SLOTS)[number];

export function isGatheringToolSlot(slot: EquipmentSlot): slot is GatheringToolSlot {
  return (GATHERING_TOOL_SLOTS as readonly EquipmentSlot[]).includes(slot);
}

export const READIED_WEAPON_SLOTS = ["melee", "secondary"] as const;
export type ReadiedWeaponSlot = (typeof READIED_WEAPON_SLOTS)[number];

export const EQUIPMENT_CATEGORIES = [
  "melee_weapon",
  "ranged_weapon",
  "shield",
  "head_armor",
  "chest_armor",
  "gloves",
  "boots",
  "ring",
  "gathering_axe",
  "gathering_pickaxe",
  "gathering_fishing_pole"
] as const;
export type EquipmentCategory = (typeof EQUIPMENT_CATEGORIES)[number];

export type EquipmentSlotRecord<Value> = Record<EquipmentSlot, Value>;
