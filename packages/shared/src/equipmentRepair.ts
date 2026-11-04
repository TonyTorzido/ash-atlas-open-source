import type { EquipmentGameplayFamilyId } from "./equipment.js";
import type { ResourceType } from "./collectibles.js";
import type { CategoryRecipeInput } from "./materialGrades.js";

/** Durable condition is intentionally small, explicit, and extensible. */
export const EQUIPMENT_MAX_CONDITION = 100;
export const EQUIPMENT_DEATH_CONDITION_LOSS = 10;
export const EQUIPMENT_REPAIR_AMOUNT = 25;
export const REPAIR_KIT_ITEM_ID: ResourceType = "repair_kit";
/** Exact Repair Kit inputs; the kit now takes category inputs only (DROPS-PROGRESSION-DESIGN 2.2). */
export const REPAIR_KIT_CRAFT_COSTS: readonly Readonly<{ itemId: ResourceType; quantity: number }>[] = Object.freeze([]);
/** 2 any Scales (Chitin, carapaces, scutes) and 1 woody Plant (Frond Sap, Dryad Heartwood). */
export const REPAIR_KIT_CRAFT_CATEGORY_INPUTS: readonly CategoryRecipeInput[] = Object.freeze([
  Object.freeze({ category: Object.freeze({ groups: ["scales"] as const, label: "any Scales" }), quantity: 2 }),
  Object.freeze({ category: Object.freeze({ groups: ["plants"] as const, tag: "woody" as const, label: "any woody Plant" }), quantity: 1 })
]);

export const REPAIRABLE_EQUIPMENT_FAMILY_IDS = [
  "tunic",
  "leather",
  "chain_mail",
  "breastplate"
] as const satisfies readonly EquipmentGameplayFamilyId[];
export type RepairableEquipmentFamilyId =
  (typeof REPAIRABLE_EQUIPMENT_FAMILY_IDS)[number];

export type EquipmentRepairMaterial = Readonly<{
  itemId: "cloth" | "leather" | "iron_bar";
  quantity: number;
}>;

export type EquipmentRepairCost = Readonly<{
  familyId: RepairableEquipmentFamilyId;
  repairKitQuantity: 1;
  materials: readonly EquipmentRepairMaterial[];
}>;

export const EQUIPMENT_REPAIR_COSTS: Readonly<
  Record<RepairableEquipmentFamilyId, EquipmentRepairCost>
> = Object.freeze({
  tunic: Object.freeze({
    familyId: "tunic",
    repairKitQuantity: 1,
    materials: Object.freeze([{ itemId: "cloth" as const, quantity: 15 }])
  }),
  leather: Object.freeze({
    familyId: "leather",
    repairKitQuantity: 1,
    materials: Object.freeze([{ itemId: "leather" as const, quantity: 15 }])
  }),
  chain_mail: Object.freeze({
    familyId: "chain_mail",
    repairKitQuantity: 1,
    materials: Object.freeze([{ itemId: "iron_bar" as const, quantity: 1 }])
  }),
  breastplate: Object.freeze({
    familyId: "breastplate",
    repairKitQuantity: 1,
    materials: Object.freeze([{ itemId: "iron_bar" as const, quantity: 2 }])
  })
});

export function isRepairableEquipmentFamily(
  familyId: EquipmentGameplayFamilyId | null | undefined
): familyId is RepairableEquipmentFamilyId {
  return familyId !== null && familyId !== undefined &&
    (REPAIRABLE_EQUIPMENT_FAMILY_IDS as readonly string[]).includes(familyId);
}

export function equipmentRepairCostForFamily(
  familyId: EquipmentGameplayFamilyId | null | undefined
): EquipmentRepairCost | null {
  return isRepairableEquipmentFamily(familyId)
    ? EQUIPMENT_REPAIR_COSTS[familyId]
    : null;
}

export function clampEquipmentCondition(value: number | null | undefined): number {
  if (!Number.isFinite(value)) return EQUIPMENT_MAX_CONDITION;
  return Math.max(0, Math.min(EQUIPMENT_MAX_CONDITION, Math.trunc(value!)));
}

export function conditionAfterRepair(condition: number): number {
  return Math.min(
    EQUIPMENT_MAX_CONDITION,
    clampEquipmentCondition(condition) + EQUIPMENT_REPAIR_AMOUNT
  );
}

/** Chest armour at condition 0 is broken: it cannot be equipped until repaired. */
export function isEquipmentBroken(item: Readonly<{ category: string; condition?: number | null }>): boolean {
  return item.category === "chest_armor" && item.condition === 0;
}

export const BROKEN_EQUIP_REASON = "Repair this armor before equipping it.";
