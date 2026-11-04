import type { CategoryRecipeInput } from "./materialGrades.js";
import type { ShopProvenance } from "./shopProvenance.js";
import { z } from "zod";

import itemVariantCatalogJson from "./data/item-variant-catalog.json" with { type: "json" };
import type { ArmorCategory, WeaponCategory } from "./classes.js";
import type { ResourceType } from "./collectibles.js";
import type { RingInstanceView } from "./rings.js";
import type { InscriptionSnapshot } from "./inscription.js";
import type { MobDropItemId } from "./mobDropItems.js";
import { EQUIPMENT_LEVEL_CAP } from "./progression.js";
import type { DamageArmorType, DamageShieldType, DamageWeaponType } from "./damageMatrix.js";
import type {
  EquipmentCombatStats,
  EquipmentItemDerivedStats,
  EquipmentStatScope,
  EquipmentUtilityKind
} from "./equipmentBalanceContracts.js";
import type {
  EquipmentCategory,
  EquipmentSlot,
  EquipmentSlotRecord,
  GatheringToolSlot,
  ReadiedWeaponSlot
} from "./equipmentContracts.js";

export type { EquipmentCombatStats, EquipmentItemDerivedStats } from "./equipmentBalanceContracts.js";
export {
  EQUIPMENT_CATEGORIES,
  EQUIPMENT_SLOTS,
  GATHERING_TOOL_SLOTS,
  isGatheringToolSlot,
  READIED_WEAPON_SLOTS
} from "./equipmentContracts.js";
export type {
  EquipmentCategory,
  EquipmentSlot,
  EquipmentSlotRecord,
  GatheringToolSlot,
  ReadiedWeaponSlot
} from "./equipmentContracts.js";

export const BASE_EQUIPMENT_DEFINITION_IDS = [
  "starter_sword",
  "god_sword",
  "starter_bow",
  "starter_staff",
  "starter_shuriken",
  "starter_wand",
  "padded_tunic",
  "chain_armor",
  "training_axe",
  "training_spear",
  "training_dagger",
  "training_knuckles",
  "training_crossbow",
  "training_blowdart",
  "training_sling",
  "training_scepter",
  "training_heavy_helm",
  "training_heavy_chest",
  "training_heavy_gloves",
  "training_heavy_boots",
  "training_light_hood",
  "training_light_gloves",
  "training_light_boots",
  "training_ring",
  "chopping_ring",
  "mining_ring",
  "attack_ring",
  "ring_plain",
  "ring_fine",
  "ring_prime",
  "ring_peerless",
  "lumber_glove",
  "delver_glove",
  "artisan_glove",
  "lodestone_boot",
  "coinwright_glove",
  "tiller_boot",
  "pathfinder_boot",
  "training_shield",
  "ranged_shield",
  "wooden_axe",
  "stone_axe",
  "wooden_pickaxe",
  "stone_pickaxe",
  "starter_fishing_pole"
] as const;
export type BaseEquipmentDefinitionId =
  (typeof BASE_EQUIPMENT_DEFINITION_IDS)[number];
declare const itemVariantDefinitionIdBrand: unique symbol;
export type ItemVariantDefinitionId = string & {
  readonly [itemVariantDefinitionIdBrand]: true;
};
export type EquipmentDefinitionId =
  BaseEquipmentDefinitionId | ItemVariantDefinitionId;
export const EQUIPMENT_LOCATIONS = [
  "inventory",
  "equipped",
  "manor_storage",
  "market_escrow",
  "market_collection",
  "world_drop",
  "destroyed"
] as const;
export type EquipmentLocation = (typeof EQUIPMENT_LOCATIONS)[number];

export function isCarriedEquipmentLocation(
  location: EquipmentLocation
): location is "inventory" | "equipped" {
  return location === "inventory" || location === "equipped";
}

export const EQUIPMENT_BALANCE_VERSION = 2 as const;
export const MIN_EQUIPMENT_LEVEL = 0;
/** Equipment and monster levels share the equipment level cap (25), not the character cap. */
export const MAX_EQUIPMENT_LEVEL: number = EQUIPMENT_LEVEL_CAP;

export const EQUIPMENT_ITEM_ROLES = [
  "stock", "cosmetic", "special", "developer"
] as const;
export type EquipmentItemRole = (typeof EQUIPMENT_ITEM_ROLES)[number];

export type EquipmentDefinition = {
  definitionId: EquipmentDefinitionId;
  displayName: string;
  slot: EquipmentSlot;
  category: EquipmentCategory;
  statScope: EquipmentStatScope;
  utilityKind: EquipmentUtilityKind;
  basePveAttackContribution: number;
  basePveDefenseContribution: number;
  bypassPveDefense?: boolean;
  /**
   * Compatibility aliases for pre-progression consumers. These are the
   * definition-owned level-0 PvE contributions, not persisted final stats.
   */
  attackPowerBonus: number;
  defenseBonus: number;
  balanceVersion: number;
  weaponCategory: WeaponCategory | null;
  armorCategory: ArmorCategory | null;
  damageWeaponType?: DamageWeaponType | null | undefined;
  damageArmorType?: DamageArmorType | null | undefined;
  damageShieldType?: DamageShieldType | null | undefined;
  twoHanded: boolean;
  marketTradable: boolean;
  marketTaxTags: readonly ["equipment"];
  equipmentRole: EquipmentItemRole;
  baseDefinitionId?: EquipmentDefinitionId;
  appearanceId?: string;
  retired?: boolean;
  /** Stable mechanical family that owns every combat and upgrade property. */
  gameplayFamilyId: EquipmentGameplayFamilyId;
};

export const EQUIPMENT_GAMEPLAY_FAMILY_IDS = [
  "sword", "god_sword", "axe", "bow", "staff", "shuriken", "wand",
  "spear", "dagger", "brass_knuckles", "crossbow", "blowdart", "sling", "scepter", "hammer",
  "tunic", "leather", "chain_mail", "breastplate",
  "heavy_helm", "heavy_gloves", "heavy_boots",
  "light_hood", "light_gloves", "light_boots",
  "training_ring", "chopping_ring", "mining_ring", "attack_ring",
  "random_ring",
  "utility_glove",
  "utility_boot",
  "melee_shield", "ranged_shield",
  // Gathering tools: one family per kind + tier, so later tiers can own their own mechanics.
  "wooden_axe", "stone_axe", "wooden_pickaxe", "stone_pickaxe", "starter_fishing_pole"
] as const;
export type EquipmentGameplayFamilyId = (typeof EQUIPMENT_GAMEPLAY_FAMILY_IDS)[number];

export type EquipmentGameplayFamilyDefinition = Readonly<{
  familyId: EquipmentGameplayFamilyId;
  displayName: string;
  stockDefinitionId: EquipmentDefinitionId | null;
  /** Existing definition used only to route art into the correct appearance family. */
  authoringBaseDefinitionId: EquipmentDefinitionId;
  slot: EquipmentSlot;
  category: EquipmentCategory;
  statScope: EquipmentStatScope;
  utilityKind: EquipmentUtilityKind;
  basePveAttackContribution: number;
  basePveDefenseContribution: number;
  bypassPveDefense?: boolean;
  weaponCategory: WeaponCategory | null;
  armorCategory: ArmorCategory | null;
  damageWeaponType?: DamageWeaponType | null;
  damageArmorType?: DamageArmorType | null;
  damageShieldType?: DamageShieldType | null;
  twoHanded: boolean;
}>;

export type EquipmentCraftingMaterial = Readonly<{
  itemId: ResourceType;
  quantity: number;
}>;

export type EquipmentCraftRecipe = Readonly<{
  familyId: EquipmentGameplayFamilyId;
  definitionId: EquipmentDefinitionId;
  displayName: string;
  materials: readonly EquipmentCraftingMaterial[];
  /** World Knowledge rank the crafter needs (checked by the server). */
  requiresSkill?: Readonly<{ skillId: "rare_beast_mastery"; rank: number }>;
  /** Category inputs ("5 any Bones"), picked lowest grade first by the server. */
  categoryMaterials?: readonly CategoryRecipeInput[];
}>;

type FamilyInput = Omit<
  EquipmentGameplayFamilyDefinition,
  "familyId" | "displayName" | "stockDefinitionId" | "authoringBaseDefinitionId"
>;

export const GATHERING_TOOL_KINDS = ["chop", "mine", "fish"] as const;
/** The gathering action a tool is shown for: chop = trees, mine = stone/ore, fish = fishing. */
export type GatheringToolKind = (typeof GATHERING_TOOL_KINDS)[number];

/** Each tool kind has its own slot and category: an axe only fits the axe slot, and so on. */
export const GATHERING_TOOL_SLOT_BY_KIND: Readonly<Record<GatheringToolKind, GatheringToolSlot>> =
  Object.freeze({ chop: "tool_axe", mine: "tool_pickaxe", fish: "tool_fishing_pole" });
export const GATHERING_TOOL_CATEGORY_BY_KIND: Readonly<Record<GatheringToolKind, EquipmentCategory>> =
  Object.freeze({ chop: "gathering_axe", mine: "gathering_pickaxe", fish: "gathering_fishing_pole" });

/** Gathering tools are looks only: zero combat stats, no utility, never readied. */
function gatheringToolMechanics(kind: GatheringToolKind): FamilyInput {
  return {
    statScope: "utility_only",
    utilityKind: "none",
    basePveAttackContribution: 0,
    basePveDefenseContribution: 0,
    slot: GATHERING_TOOL_SLOT_BY_KIND[kind],
    category: GATHERING_TOOL_CATEGORY_BY_KIND[kind],
    weaponCategory: null,
    armorCategory: null,
    twoHanded: false
  };
}

const UNIVERSAL_EMPTY: Pick<
  FamilyInput,
  "statScope" | "utilityKind" | "basePveAttackContribution" | "basePveDefenseContribution"
> = {
  statScope: "universal",
  utilityKind: "none",
  basePveAttackContribution: 0,
  basePveDefenseContribution: 0
};

function gameplayFamily(
  familyId: EquipmentGameplayFamilyId,
  displayName: string,
  stockDefinitionId: EquipmentDefinitionId | null,
  authoringBaseDefinitionId: EquipmentDefinitionId,
  mechanics: FamilyInput
): EquipmentGameplayFamilyDefinition {
  return Object.freeze({
    familyId,
    displayName,
    stockDefinitionId,
    authoringBaseDefinitionId,
    ...mechanics
  });
}

export const EQUIPMENT_GAMEPLAY_FAMILIES: Readonly<
  Record<EquipmentGameplayFamilyId, EquipmentGameplayFamilyDefinition>
> = Object.freeze({
  sword: gameplayFamily("sword", "Sword", "starter_sword", "starter_sword", {
    ...UNIVERSAL_EMPTY, slot: "melee", category: "melee_weapon",
    weaponCategory: "sword", armorCategory: null, damageWeaponType: "sword", twoHanded: false
  }),
  god_sword: gameplayFamily("god_sword", "God Sword", null, "god_sword", {
    ...UNIVERSAL_EMPTY, basePveAttackContribution: 990, bypassPveDefense: true,
    slot: "melee", category: "melee_weapon", weaponCategory: "sword",
    armorCategory: null, damageWeaponType: "sword", twoHanded: false
  }),
  // The Double Axe is the stock axe (class roster v2). training_axe is a retired tombstone.
  axe: gameplayFamily("axe", "Double Axe", "double_axe" as EquipmentDefinitionId, "double_axe" as EquipmentDefinitionId, {
    ...UNIVERSAL_EMPTY, slot: "melee", category: "melee_weapon",
    weaponCategory: "axe", armorCategory: null, damageWeaponType: "axe", twoHanded: false
  }),
  // The Paladin weapon (class roster v2): one-handed heavy melee, so it pairs with a shield. Hits like
  // the Double Axe on the V3 matrix (V1 fallback: axe row); matrix v4 gives it its own Blunt row.
  hammer: gameplayFamily("hammer", "Hammer", "hammer" as EquipmentDefinitionId, "hammer" as EquipmentDefinitionId, {
    ...UNIVERSAL_EMPTY, slot: "melee", category: "melee_weapon",
    weaponCategory: "hammer", armorCategory: null, damageWeaponType: "axe", twoHanded: false
  }),
  bow: gameplayFamily("bow", "Bow", "starter_bow", "starter_bow", {
    ...UNIVERSAL_EMPTY, slot: "secondary", category: "ranged_weapon",
    weaponCategory: "bow", armorCategory: null, damageWeaponType: "bow", twoHanded: true
  }),
  staff: gameplayFamily("staff", "Staff", "starter_staff", "starter_staff", {
    ...UNIVERSAL_EMPTY, slot: "melee", category: "melee_weapon",
    weaponCategory: "staff", armorCategory: null, damageWeaponType: "staff", twoHanded: true
  }),
  shuriken: gameplayFamily("shuriken", "Shuriken", "starter_shuriken", "starter_shuriken", {
    ...UNIVERSAL_EMPTY, slot: "secondary", category: "ranged_weapon",
    weaponCategory: "shuriken", armorCategory: null, damageWeaponType: "shuriken", twoHanded: true
  }),
  wand: gameplayFamily("wand", "Wand", "starter_wand", "starter_wand", {
    ...UNIVERSAL_EMPTY, slot: "secondary", category: "ranged_weapon",
    weaponCategory: "wand", armorCategory: null, damageWeaponType: "wand", twoHanded: true
  }),
  // New families resolve through the V3 matrix by family id; damageWeaponType is only the
  // legacy V1 fallback, so each borrows its nearest V1 row.
  spear: gameplayFamily("spear", "Spear", "training_spear", "starter_staff", {
    ...UNIVERSAL_EMPTY, slot: "melee", category: "melee_weapon",
    weaponCategory: "spear", armorCategory: null, damageWeaponType: "sword", twoHanded: false
  }),
  dagger: gameplayFamily("dagger", "Dagger", "training_dagger", "starter_sword", {
    ...UNIVERSAL_EMPTY, slot: "melee", category: "melee_weapon",
    weaponCategory: "dagger", armorCategory: null, damageWeaponType: "sword", twoHanded: false
  }),
  brass_knuckles: gameplayFamily("brass_knuckles", "Brass Knuckles", "training_knuckles", "starter_sword", {
    ...UNIVERSAL_EMPTY, slot: "melee", category: "melee_weapon",
    weaponCategory: "brass_knuckles", armorCategory: null, damageWeaponType: "sword", twoHanded: false
  }),
  crossbow: gameplayFamily("crossbow", "Crossbow", "training_crossbow", "starter_bow", {
    ...UNIVERSAL_EMPTY, slot: "secondary", category: "ranged_weapon",
    weaponCategory: "crossbow", armorCategory: null, damageWeaponType: "bow", twoHanded: true
  }),
  blowdart: gameplayFamily("blowdart", "Blowdart", "training_blowdart", "starter_wand", {
    ...UNIVERSAL_EMPTY, slot: "secondary", category: "ranged_weapon",
    weaponCategory: "blowdart", armorCategory: null, damageWeaponType: "wand", twoHanded: true
  }),
  sling: gameplayFamily("sling", "Sling", "training_sling", "starter_shuriken", {
    ...UNIVERSAL_EMPTY, slot: "secondary", category: "ranged_weapon",
    weaponCategory: "sling", armorCategory: null, damageWeaponType: "shuriken", twoHanded: true
  }),
  // The Cleric weapon (class roster v2): one-handed, so it pairs with an off-hand relic. With CLERIC_ARC_ENABLED it
  // casts the holy arc (actionCombat.ts HOLY_ARC_SHOT_PROFILE); otherwise it swings. Damage borrows the staff rows
  // (V1 and V3) until the scepter is tuned in the matrix. Art: the approved Cleric Scepter B, drawn on the staff's
  // 1254 canvas and placements (weapons/scepter.png, items/scepter.png).
  scepter: gameplayFamily("scepter", "Scepter", "training_scepter", "starter_staff", {
    ...UNIVERSAL_EMPTY, slot: "melee", category: "melee_weapon",
    weaponCategory: "scepter", armorCategory: null, damageWeaponType: "staff", twoHanded: false
  }),
  tunic: gameplayFamily("tunic", "Tunic", "padded_tunic", "padded_tunic", {
    ...UNIVERSAL_EMPTY, slot: "chest", category: "chest_armor",
    weaponCategory: null, armorCategory: "light", damageArmorType: "tunic", twoHanded: false
  }),
  leather: gameplayFamily("leather", "Leather", "leather_armor" as EquipmentDefinitionId, "leather_armor" as EquipmentDefinitionId, {
    ...UNIVERSAL_EMPTY, slot: "chest", category: "chest_armor",
    weaponCategory: null, armorCategory: "medium", damageArmorType: "leather", twoHanded: false
  }),
  chain_mail: gameplayFamily("chain_mail", "Chainmail Armor", "chain_armor", "chain_armor", {
    ...UNIVERSAL_EMPTY, slot: "chest", category: "chest_armor",
    weaponCategory: null, armorCategory: "heavy", damageArmorType: "chainmail", twoHanded: false
  }),
  breastplate: gameplayFamily("breastplate", "Breastplate", "breast_plate" as EquipmentDefinitionId, "breast_plate" as EquipmentDefinitionId, {
    ...UNIVERSAL_EMPTY, slot: "chest", category: "chest_armor",
    weaponCategory: null, armorCategory: "heavy", damageArmorType: "breastplate", twoHanded: false
  }),
  heavy_helm: gameplayFamily("heavy_helm", "Heavy Helm", "training_heavy_helm", "training_heavy_helm", {
    statScope: "utility_only", utilityKind: "resource_maximum",
    basePveAttackContribution: 0, basePveDefenseContribution: 0,
    slot: "head", category: "head_armor", weaponCategory: null, armorCategory: "heavy", twoHanded: false
  }),
  heavy_gloves: gameplayFamily("heavy_gloves", "Heavy Gloves", "training_heavy_gloves", "training_heavy_gloves", {
    statScope: "utility_only", utilityKind: "action_duration",
    basePveAttackContribution: 0, basePveDefenseContribution: 0,
    slot: "gloves", category: "gloves", weaponCategory: null, armorCategory: "heavy", twoHanded: false
  }),
  heavy_boots: gameplayFamily("heavy_boots", "Heavy Boots", "training_heavy_boots", "training_heavy_boots", {
    statScope: "utility_only", utilityKind: "movement_and_cc",
    basePveAttackContribution: 0, basePveDefenseContribution: 0,
    slot: "boots", category: "boots", weaponCategory: null, armorCategory: "heavy", twoHanded: false
  }),
  light_hood: gameplayFamily("light_hood", "Light Hood", "training_light_hood", "training_light_hood", {
    statScope: "utility_only", utilityKind: "resource_generation",
    basePveAttackContribution: 0, basePveDefenseContribution: 0,
    slot: "head", category: "head_armor", weaponCategory: null, armorCategory: "light", twoHanded: false
  }),
  light_gloves: gameplayFamily("light_gloves", "Light Gloves", "training_light_gloves", "training_light_gloves", {
    statScope: "utility_only", utilityKind: "action_duration",
    basePveAttackContribution: 0, basePveDefenseContribution: 0,
    slot: "gloves", category: "gloves", weaponCategory: null, armorCategory: "light", twoHanded: false
  }),
  light_boots: gameplayFamily("light_boots", "Light Boots", "training_light_boots", "training_light_boots", {
    statScope: "utility_only", utilityKind: "movement_and_cc",
    basePveAttackContribution: 0, basePveDefenseContribution: 0,
    slot: "boots", category: "boots", weaponCategory: null, armorCategory: "light", twoHanded: false
  }),
  training_ring: gameplayFamily("training_ring", "Training Ring", "training_ring", "training_ring", {
    statScope: "utility_only", utilityKind: "none",
    basePveAttackContribution: 0, basePveDefenseContribution: 0,
    slot: "ring", category: "ring", weaponCategory: null, armorCategory: null, twoHanded: false
  }),
  chopping_ring: gameplayFamily("chopping_ring", "Chopping Ring", "chopping_ring", "chopping_ring", {
    statScope: "utility_only", utilityKind: "chopping_duration",
    basePveAttackContribution: 0, basePveDefenseContribution: 0,
    slot: "ring", category: "ring", weaponCategory: null, armorCategory: null, twoHanded: false
  }),
  mining_ring: gameplayFamily("mining_ring", "Mining Ring", "mining_ring", "mining_ring", {
    statScope: "utility_only", utilityKind: "mining_duration",
    basePveAttackContribution: 0, basePveDefenseContribution: 0,
    slot: "ring", category: "ring", weaponCategory: null, armorCategory: null, twoHanded: false
  }),
  attack_ring: gameplayFamily("attack_ring", "Attack Ring", "attack_ring", "attack_ring", {
    statScope: "universal", utilityKind: "attack_bonus",
    basePveAttackContribution: 3, basePveDefenseContribution: 0,
    slot: "ring", category: "ring", weaponCategory: null, armorCategory: null, twoHanded: false
  }),
  // Random-roll rings: the tier is the item, the bonuses live on the instance (rings.ts).
  random_ring: gameplayFamily("random_ring", "Ring", null, "ring_plain", {
    statScope: "utility_only", utilityKind: "none",
    basePveAttackContribution: 0, basePveDefenseContribution: 0,
    slot: "ring", category: "ring", weaponCategory: null, armorCategory: null, twoHanded: false
  }),
  // Utility gloves (utilityGear.ts): effects are server rules, no combat stats and no wear.
  utility_glove: gameplayFamily("utility_glove", "Utility Glove", null, "lumber_glove", {
    statScope: "utility_only", utilityKind: "none",
    basePveAttackContribution: 0, basePveDefenseContribution: 0,
    slot: "gloves", category: "gloves", weaponCategory: null, armorCategory: null, twoHanded: false
  }),
  utility_boot: gameplayFamily("utility_boot", "Utility Boot", null, "lodestone_boot", {
    statScope: "utility_only", utilityKind: "none",
    basePveAttackContribution: 0, basePveDefenseContribution: 0,
    slot: "boots", category: "boots", weaponCategory: null, armorCategory: null, twoHanded: false
  }),
  melee_shield: gameplayFamily("melee_shield", "Melee Shield", "training_shield", "training_shield", {
    ...UNIVERSAL_EMPTY, slot: "secondary", category: "shield", weaponCategory: "shield",
    armorCategory: null, damageShieldType: "melee", twoHanded: false
  }),
  ranged_shield: gameplayFamily("ranged_shield", "Ranged Shield", "ranged_shield", "ranged_shield", {
    ...UNIVERSAL_EMPTY, slot: "secondary", category: "shield", weaponCategory: "shield",
    armorCategory: null, damageShieldType: "ranged", twoHanded: false
  }),
  wooden_axe: gameplayFamily("wooden_axe", "Wooden Hatchet", "wooden_axe", "wooden_axe", gatheringToolMechanics("chop")),
  stone_axe: gameplayFamily("stone_axe", "Stone Hatchet", "stone_axe", "stone_axe", gatheringToolMechanics("chop")),
  wooden_pickaxe: gameplayFamily("wooden_pickaxe", "Wooden Pickaxe", "wooden_pickaxe", "wooden_pickaxe", gatheringToolMechanics("mine")),
  stone_pickaxe: gameplayFamily("stone_pickaxe", "Stone Pickaxe", "stone_pickaxe", "stone_pickaxe", gatheringToolMechanics("mine")),
  starter_fishing_pole: gameplayFamily(
    "starter_fishing_pole", "Starter Fishing Pole", "starter_fishing_pole", "starter_fishing_pole",
    gatheringToolMechanics("fish")
  )
});

/**
 * Rare Beast Mastery rank 1 gates the dragon gear recipes: Chain Mail fights in Wyrm Scalemail
 * matrix column and the Ranged Shield in its Wyrm Shield column. Owned pieces stay usable and tradable.
 */
const DRAGON_GEAR_SKILL = Object.freeze({ skillId: "rare_beast_mastery", rank: 1 } as const);
export type GatheringToolDefinition = Readonly<{
  familyId: EquipmentGameplayFamilyId;
  kind: GatheringToolKind;
  /** 1 = wooden/starter, 2 = stone; later iron/steel tiers continue the ladder. */
  tier: number;
  /** Player appearance family that owns the art for every tier and skin of this kind. */
  appearanceFamilyId: "chopping_tool" | "mining_tool" | "fishing_tool";
  /**
   * True when the stock tool is crafted on the player, anywhere, from the Crafting app.
   * False keeps the craft at a Manor Smithing Station (later iron/steel tiers).
   */
  portableCraft: boolean;
}>;

/**
 * Gathering tools by gameplay family. Tools are looks only for now: they change nothing about
 * gathering speed or yield and nothing requires one. Skins later are cosmetic item variants of
 * these families, the same way swag weapons are variants of weapon families.
 */
export const GATHERING_TOOL_FAMILIES: Readonly<Partial<Record<EquipmentGameplayFamilyId, GatheringToolDefinition>>> =
  Object.freeze({
    wooden_axe: gatheringTool("wooden_axe", "chop", 1, "chopping_tool", true),
    stone_axe: gatheringTool("stone_axe", "chop", 2, "chopping_tool", true),
    wooden_pickaxe: gatheringTool("wooden_pickaxe", "mine", 1, "mining_tool", true),
    stone_pickaxe: gatheringTool("stone_pickaxe", "mine", 2, "mining_tool", true),
    starter_fishing_pole: gatheringTool("starter_fishing_pole", "fish", 1, "fishing_tool", true)
  });

function gatheringTool(
  familyId: EquipmentGameplayFamilyId,
  kind: GatheringToolKind,
  tier: number,
  appearanceFamilyId: GatheringToolDefinition["appearanceFamilyId"],
  portableCraft: boolean
): GatheringToolDefinition {
  return Object.freeze({ familyId, kind, tier, appearanceFamilyId, portableCraft });
}

/**
 * True when this craft needs no Smithing Station: a stock (non-swag) craft of a family marked
 * portableCraft. Everything else is crafted only at a Manor Smithing Station.
 */
export function isPortableEquipmentCraft(
  familyId: EquipmentGameplayFamilyId,
  swagDefinitionId?: string
): boolean {
  return swagDefinitionId === undefined && GATHERING_TOOL_FAMILIES[familyId]?.portableCraft === true;
}

/** Tool kind for an equipment definition, or null when it is not a gathering tool. */
export function gatheringToolKindForDefinition(definitionId: string): GatheringToolKind | null {
  const definition = EQUIPMENT_DEFINITIONS[definitionId as EquipmentDefinitionId];
  if (!definition) return null;
  return GATHERING_TOOL_FAMILIES[definition.gameplayFamilyId]?.kind ?? null;
}

export const EQUIPMENT_CRAFT_RECIPES: readonly EquipmentCraftRecipe[] =
  Object.freeze([
    craftRecipe("sword", [{ itemId: "iron_bar", quantity: 10 }, { itemId: "wood", quantity: 50 }]),
    craftRecipe("axe", [{ itemId: "iron_bar", quantity: 12 }, { itemId: "wood", quantity: 50 }]),
    craftRecipe("hammer", [{ itemId: "iron_bar", quantity: 14 }, { itemId: "wood", quantity: 40 }]),
    craftRecipe("bow", [{ itemId: "wood", quantity: 250 }]),
    craftRecipe("staff", [{ itemId: "wood", quantity: 250 }]),
    craftRecipe("shuriken", [{ itemId: "iron_bar", quantity: 10 }]),
    craftRecipe("wand", [{ itemId: "iron_bar", quantity: 3 }, { itemId: "wood", quantity: 200 }]),
    craftRecipe("spear", [{ itemId: "iron_bar", quantity: 10 }, { itemId: "wood", quantity: 100 }]),
    craftRecipe("dagger", [{ itemId: "iron_bar", quantity: 6 }, { itemId: "leather", quantity: 20 }]),
    craftRecipe("brass_knuckles", [{ itemId: "iron_bar", quantity: 8 }, { itemId: "leather", quantity: 10 }]),
    craftRecipe("crossbow", [
      { itemId: "iron_bar", quantity: 6 }, { itemId: "wood", quantity: 150 }, { itemId: "cloth", quantity: 10 }
    ]),
    craftRecipe("blowdart", [
      { itemId: "wood", quantity: 150 }, { itemId: "flax_fiber", quantity: 20 }
    ], undefined, [{ category: { groups: ["bones"], label: "any Bones" }, quantity: 5 }]),
    craftRecipe("sling", [{ itemId: "leather", quantity: 60 }, { itemId: "cloth", quantity: 20 }]),
    craftRecipe("scepter", [{ itemId: "iron_bar", quantity: 8 }, { itemId: "wood", quantity: 60 }, { itemId: "cloth", quantity: 10 }]),
    craftRecipe("tunic", [{ itemId: "cloth", quantity: 60 }]),
    craftRecipe("leather", [{ itemId: "leather", quantity: 150 }]),
    craftRecipe("chain_mail", [{ itemId: "dragon_scale", quantity: 10 }, { itemId: "iron_bar", quantity: 8 }], DRAGON_GEAR_SKILL),
    craftRecipe("breastplate", [{ itemId: "iron_bar", quantity: 15 }, { itemId: "leather", quantity: 50 }]),
    craftRecipe("ranged_shield", [
      { itemId: "dragon_scale", quantity: 6 }, { itemId: "iron_bar", quantity: 8 }, { itemId: "wood", quantity: 50 }
    ], DRAGON_GEAR_SKILL),
    // Starter gathering tools (looks only): cheap wood/stone/flax costs.
    craftRecipe("wooden_axe", [{ itemId: "wood", quantity: 20 }]),
    craftRecipe("stone_axe", [{ itemId: "wood", quantity: 15 }, { itemId: "stone", quantity: 20 }]),
    craftRecipe("wooden_pickaxe", [{ itemId: "wood", quantity: 20 }]),
    craftRecipe("stone_pickaxe", [{ itemId: "wood", quantity: 15 }, { itemId: "stone", quantity: 20 }]),
    craftRecipe("starter_fishing_pole", [{ itemId: "wood", quantity: 15 }, { itemId: "flax_fiber", quantity: 10 }])
  ]);

function craftRecipe(
  familyId: EquipmentGameplayFamilyId,
  materials: readonly EquipmentCraftingMaterial[],
  requiresSkill?: EquipmentCraftRecipe["requiresSkill"],
  categoryMaterials?: readonly CategoryRecipeInput[]
): EquipmentCraftRecipe {
  const family = EQUIPMENT_GAMEPLAY_FAMILIES[familyId];
  if (!family.stockDefinitionId) {
    throw new Error(`Equipment family ${familyId} does not have a stock item`);
  }
  return Object.freeze({
    familyId,
    definitionId: family.stockDefinitionId,
    displayName: family.displayName,
    materials: Object.freeze(materials.map((material) => Object.freeze(material))),
    ...(requiresSkill ? { requiresSkill } : {}),
    ...(categoryMaterials === undefined ? {} : { categoryMaterials: Object.freeze(categoryMaterials) })
  });
}

type BaseEquipmentItemDefinition = Readonly<{
  definitionId: BaseEquipmentDefinitionId;
  displayName: string;
  familyId: EquipmentGameplayFamilyId;
  role: EquipmentItemRole;
  marketTradable: boolean;
  retired?: boolean;
}>;

const BASE_EQUIPMENT_ITEMS: Readonly<Record<BaseEquipmentDefinitionId, BaseEquipmentItemDefinition>> = {
  starter_sword: baseItem("starter_sword", "Sword", "sword", "stock", false),
  god_sword: baseItem("god_sword", "God Sword", "god_sword", "developer", false),
  starter_bow: baseItem("starter_bow", "Bow", "bow", "stock", false),
  starter_staff: baseItem("starter_staff", "Staff", "staff", "stock", false),
  starter_shuriken: baseItem("starter_shuriken", "Shuriken", "shuriken", "stock", false),
  starter_wand: baseItem("starter_wand", "Wand", "wand", "stock", false),
  padded_tunic: baseItem("padded_tunic", "Tunic", "tunic", "stock", false),
  chain_armor: baseItem("chain_armor", "Chainmail Armor", "chain_mail", "stock", true),
  // Retired 2026-10: every copy became a Double Axe (migration 1216). Kept for history rows.
  training_axe: baseItem("training_axe", "Training Axe", "axe", "special", false, true),
  training_spear: baseItem("training_spear", "Spear", "spear", "stock", true),
  training_dagger: baseItem("training_dagger", "Dagger", "dagger", "stock", true),
  training_knuckles: baseItem("training_knuckles", "Brass Knuckles", "brass_knuckles", "stock", true),
  training_crossbow: baseItem("training_crossbow", "Crossbow", "crossbow", "stock", true),
  training_blowdart: baseItem("training_blowdart", "Blowdart", "blowdart", "stock", true),
  training_sling: baseItem("training_sling", "Sling", "sling", "stock", true),
  training_scepter: baseItem("training_scepter", "Scepter", "scepter", "stock", true),
  training_heavy_helm: baseItem("training_heavy_helm", "Heavy Helm", "heavy_helm", "stock", true),
  training_heavy_chest: baseItem(
    "training_heavy_chest",
    "Training Heavy Chest",
    "breastplate",
    "special",
    false,
    true
  ),
  training_heavy_gloves: baseItem("training_heavy_gloves", "Heavy Gloves", "heavy_gloves", "stock", true),
  training_heavy_boots: baseItem("training_heavy_boots", "Heavy Boots", "heavy_boots", "stock", true),
  training_light_hood: baseItem("training_light_hood", "Light Hood", "light_hood", "stock", true),
  training_light_gloves: baseItem("training_light_gloves", "Light Gloves", "light_gloves", "stock", true),
  training_light_boots: baseItem("training_light_boots", "Light Boots", "light_boots", "stock", true),
  // Retired 2026-10: every copy became a Plain ring (migration 1070). Kept for history rows.
  training_ring: baseItem("training_ring", "Training Ring", "training_ring", "stock", true, true),
  chopping_ring: baseItem("chopping_ring", "Chopping Ring", "chopping_ring", "stock", true, true),
  mining_ring: baseItem("mining_ring", "Mining Ring", "mining_ring", "stock", true, true),
  attack_ring: baseItem("attack_ring", "Attack Ring", "attack_ring", "stock", true, true),
  ring_plain: baseItem("ring_plain", "Plain Ring", "random_ring", "special", true),
  ring_fine: baseItem("ring_fine", "Fine Ring", "random_ring", "special", true),
  ring_prime: baseItem("ring_prime", "Prime Ring", "random_ring", "special", true),
  ring_peerless: baseItem("ring_peerless", "Peerless Ring", "random_ring", "special", true),
  lumber_glove: baseItem("lumber_glove", "Lumber Glove", "utility_glove", "special", true),
  delver_glove: baseItem("delver_glove", "Delver Glove", "utility_glove", "special", true),
  artisan_glove: baseItem("artisan_glove", "Artisan Glove", "utility_glove", "special", true),
  lodestone_boot: baseItem("lodestone_boot", "Lodestone Boot", "utility_boot", "special", true),
  tiller_boot: baseItem("tiller_boot", "Tiller Boot", "utility_boot", "special", true),
  pathfinder_boot: baseItem("pathfinder_boot", "Pathfinder Boot", "utility_boot", "special", true),
  coinwright_glove: baseItem("coinwright_glove", "Coinwright Glove", "utility_glove", "special", true),
  training_shield: baseItem("training_shield", "Melee Shield", "melee_shield", "stock", true),
  ranged_shield: baseItem("ranged_shield", "Ranged Shield", "ranged_shield", "stock", true),
  wooden_axe: baseItem("wooden_axe", "Wooden Hatchet", "wooden_axe", "stock", true),
  stone_axe: baseItem("stone_axe", "Stone Hatchet", "stone_axe", "stock", true),
  wooden_pickaxe: baseItem("wooden_pickaxe", "Wooden Pickaxe", "wooden_pickaxe", "stock", true),
  stone_pickaxe: baseItem("stone_pickaxe", "Stone Pickaxe", "stone_pickaxe", "stock", true),
  starter_fishing_pole: baseItem(
    "starter_fishing_pole", "Starter Fishing Pole", "starter_fishing_pole", "stock", true
  )
};

function baseItem(
  definitionId: BaseEquipmentDefinitionId,
  displayName: string,
  familyId: EquipmentGameplayFamilyId,
  role: EquipmentItemRole,
  marketTradable: boolean,
  retired = false
): BaseEquipmentItemDefinition {
  return Object.freeze({
    definitionId,
    displayName,
    familyId,
    role,
    marketTradable,
    ...(retired ? { retired: true } : {})
  });
}

function equipmentDefinitionFromItem(input: Readonly<{
  definitionId: EquipmentDefinitionId;
  displayName: string;
  familyId: EquipmentGameplayFamilyId;
  role: EquipmentItemRole;
  marketTradable: boolean;
  baseDefinitionId?: EquipmentDefinitionId;
  appearanceId?: string;
  retired?: boolean;
}>): EquipmentDefinition {
  const family = EQUIPMENT_GAMEPLAY_FAMILIES[input.familyId];
  return Object.freeze({
    definitionId: input.definitionId,
    displayName: input.displayName,
    slot: family.slot,
    category: family.category,
    statScope: family.statScope,
    utilityKind: family.utilityKind,
    basePveAttackContribution: family.basePveAttackContribution,
    basePveDefenseContribution: family.basePveDefenseContribution,
    ...(family.bypassPveDefense ? { bypassPveDefense: true } : {}),
    attackPowerBonus: family.basePveAttackContribution,
    defenseBonus: family.basePveDefenseContribution,
    balanceVersion: EQUIPMENT_BALANCE_VERSION,
    weaponCategory: family.weaponCategory,
    armorCategory: family.armorCategory,
    damageWeaponType: family.damageWeaponType ?? null,
    damageArmorType: family.damageArmorType ?? null,
    damageShieldType: family.damageShieldType ?? null,
    twoHanded: family.twoHanded,
    marketTradable: input.marketTradable,
    marketTaxTags: ["equipment"] as const,
    equipmentRole: input.role,
    gameplayFamilyId: input.familyId,
    ...(input.baseDefinitionId ? { baseDefinitionId: input.baseDefinitionId } : {}),
    ...(input.appearanceId ? { appearanceId: input.appearanceId } : {}),
    ...(input.retired ? { retired: true } : {})
  });
}

export const BASE_EQUIPMENT_DEFINITIONS: Readonly<
  Record<BaseEquipmentDefinitionId, EquipmentDefinition>
> = Object.freeze(Object.fromEntries(
  Object.values(BASE_EQUIPMENT_ITEMS).map((item) => [
    item.definitionId,
    equipmentDefinitionFromItem({
      definitionId: item.definitionId,
      displayName: item.displayName,
      familyId: item.familyId,
      role: item.role,
      marketTradable: item.marketTradable,
      ...(item.retired ? { retired: true } : {})
    })
  ])
)) as Readonly<Record<BaseEquipmentDefinitionId, EquipmentDefinition>>;

export const ITEM_VARIANT_SCHEMA_VERSION = 2 as const;

export type EquipmentLimitedSale = Readonly<{
  priceGold: string;
  startsAt: string;
  endsAt: string;
}>;

export type ItemVariantDefinition = Readonly<{
  definitionId: ItemVariantDefinitionId;
  displayName: string;
  familyId: EquipmentGameplayFamilyId;
  role: EquipmentItemRole;
  appearanceId: string;
  marketTradable?: boolean;
  limitedSale?: EquipmentLimitedSale;
  /** Hidden from normal authoring menus while retained for existing owned items. */
  retired?: boolean;
}>;

export type ItemVariantCatalog = Readonly<{
  schemaVersion: typeof ITEM_VARIANT_SCHEMA_VERSION;
  variants: readonly ItemVariantDefinition[];
}>;

const contentIdSchema = z.string().regex(
  /^[a-z0-9][a-z0-9_-]{0,63}$/u,
  "IDs use lowercase letters, digits, underscores, and hyphens"
);

const itemVariantCatalogSchema = z.object({
  schemaVersion: z.literal(ITEM_VARIANT_SCHEMA_VERSION),
  variants: z.array(z.object({
    definitionId: contentIdSchema,
    displayName: z.string().trim().min(1).max(80),
    familyId: z.enum(EQUIPMENT_GAMEPLAY_FAMILY_IDS),
    role: z.enum(EQUIPMENT_ITEM_ROLES),
    appearanceId: contentIdSchema,
    marketTradable: z.boolean().optional(),
    limitedSale: z.object({
      priceGold: z.string().regex(/^[1-9][0-9]{0,18}$/u),
      startsAt: z.string().datetime({ offset: true }),
      endsAt: z.string().datetime({ offset: true })
    }).strict().optional(),
    retired: z.boolean().optional()
  }).strict())
}).strict().superRefine((catalog, context) => {
  const seen = new Set<string>(BASE_EQUIPMENT_DEFINITION_IDS);
  for (const [index, variant] of catalog.variants.entries()) {
    if (seen.has(variant.definitionId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["variants", index, "definitionId"],
        message: "item variant IDs must be unique and cannot replace base equipment"
      });
    }
    seen.add(variant.definitionId);
    if (variant.limitedSale) {
      if (variant.role !== "cosmetic") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["variants", index, "limitedSale"],
          message: "limited sales may contain only cosmetic equipment"
        });
      }
      if (Date.parse(variant.limitedSale.endsAt) <= Date.parse(variant.limitedSale.startsAt)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["variants", index, "limitedSale", "endsAt"],
          message: "limited sale end must be after its start"
        });
      }
    }
  }
});

export function parseItemVariantCatalog(value: unknown): ItemVariantCatalog {
  return itemVariantCatalogSchema.parse(value) as unknown as ItemVariantCatalog;
}

export const ITEM_VARIANT_CATALOG = Object.freeze(
  parseItemVariantCatalog(itemVariantCatalogJson)
);

export type ActiveEquipmentLimitedSale = Readonly<{
  definitionId: EquipmentDefinitionId;
  displayName: string;
  familyId: EquipmentGameplayFamilyId;
  appearanceId: string;
  priceGold: string;
  startsAt: string;
  endsAt: string;
}>;

export function activeEquipmentLimitedSales(
  at: Date = new Date()
): readonly ActiveEquipmentLimitedSale[] {
  const now = at.getTime();
  return ITEM_VARIANT_CATALOG.variants.flatMap((variant) => {
    const sale = variant.limitedSale;
    if (
      !sale ||
      variant.retired ||
      Date.parse(sale.startsAt) > now ||
      Date.parse(sale.endsAt) <= now
    ) return [];
    return [{
      definitionId: variant.definitionId,
      displayName: variant.displayName,
      familyId: variant.familyId,
      appearanceId: variant.appearanceId,
      ...sale
    }];
  });
}

validateFamilyItemRoles();

function validateFamilyItemRoles(): void {
  const items = [
    ...Object.values(BASE_EQUIPMENT_ITEMS).map((item) => ({
      definitionId: item.definitionId as EquipmentDefinitionId,
      familyId: item.familyId,
      role: item.role
    })),
    ...ITEM_VARIANT_CATALOG.variants
  ];
  for (const family of Object.values(EQUIPMENT_GAMEPLAY_FAMILIES)) {
    const familyItems = items.filter((item) => item.familyId === family.familyId);
    if (family.stockDefinitionId === null) {
      if (familyItems.some((item) => item.role === "stock")) {
        throw new Error(`Equipment family ${family.familyId} cannot publish a stock item`);
      }
      continue;
    }
    const declared = familyItems.find(
      (item) => item.definitionId === family.stockDefinitionId
    );
    if (!declared) {
      throw new Error(
        `Equipment family ${family.familyId} references missing canonical item ${family.stockDefinitionId}`
      );
    }
    const stockItems = familyItems.filter((item) => item.role === "stock");
    const expectedStockCount = declared.role === "stock" ? 1 : 0;
    if (
      stockItems.length !== expectedStockCount ||
      (stockItems[0] && stockItems[0].definitionId !== family.stockDefinitionId)
    ) {
      throw new Error(`Equipment family ${family.familyId} must have one declared stock item`);
    }
  }
}

const variantEquipmentDefinitions = Object.fromEntries(
  ITEM_VARIANT_CATALOG.variants.map((variant) => {
    return [
      variant.definitionId,
      equipmentDefinitionFromItemVariant(variant)
    ];
  })
) as Readonly<Record<EquipmentDefinitionId, EquipmentDefinition>>;

export function equipmentDefinitionFromItemVariant(
  variant: ItemVariantDefinition
): EquipmentDefinition {
  const family = EQUIPMENT_GAMEPLAY_FAMILIES[variant.familyId];
  return equipmentDefinitionFromItem({
    definitionId: variant.definitionId,
    displayName: variant.displayName,
    familyId: variant.familyId,
    role: variant.role,
    baseDefinitionId: family.authoringBaseDefinitionId,
    appearanceId: variant.appearanceId,
    marketTradable: variant.marketTradable ?? false,
    ...(variant.retired === undefined ? {} : { retired: variant.retired })
  });
}

export const EQUIPMENT_DEFINITIONS = Object.freeze({
  ...BASE_EQUIPMENT_DEFINITIONS,
  ...variantEquipmentDefinitions
}) as typeof BASE_EQUIPMENT_DEFINITIONS & Readonly<
  Record<EquipmentDefinitionId, EquipmentDefinition>
>;

export const EQUIPMENT_DEFINITION_IDS = Object.freeze(
  Object.keys(EQUIPMENT_DEFINITIONS) as EquipmentDefinitionId[]
);

export function isEquipmentDefinitionId(value: string): value is EquipmentDefinitionId {
  return Object.hasOwn(EQUIPMENT_DEFINITIONS, value);
}

export const equipmentDefinitionIdSchema = contentIdSchema.refine(
  isEquipmentDefinitionId,
  "unknown equipment definition"
);

/**
 * Swag weapons: cosmetic variants crafted at +0 with their family's stock recipe plus regional
 * mob drops. They keep the family's mechanics (stats come from the family), so these are the only
 * cosmetic items with a craft recipe; every other cosmetic stays uncraftable.
 */
export type EquipmentSwagCraftRecipe = EquipmentCraftRecipe & Readonly<{
  /** The stock weapon whose recipe and stats this swag weapon shares. */
  baseDefinitionId: EquipmentDefinitionId;
}>;

const SWAG_WEAPON_EXTRA_MATERIALS: Readonly<Record<string, readonly (readonly [MobDropItemId, number])[]>> = {
  legion_gladius: [["rusted_legion_blade", 3], ["ancient_coin", 3]],
  barrow_blade: [["barrow_torc", 3], ["rimed_draugr_mail", 2]],
  tidefang_sabre: [["shark_tooth", 3], ["merfolk_scale", 5]],
  troll_cleaver: [["troll_tooth", 3], ["river_troll_hide", 2]],
  rimebeard_axe: [["rimed_draugr_mail", 3], ["fur_pelt", 5]],
  packfang_axe: [["fang", 6], ["horn", 3]],
  owlfeather_longbow: [["owl_feather", 10], ["down_feather", 3]],
  grovewood_bow: [["living_heartwood", 2], ["dryad_blossom", 3]],
  steppe_horn_bow: [["horn", 5], ["steppe_horsehair_tassel", 3], ["sinew", 3]],
  kappa_shell_crossbow: [["kappa_shell_plate", 4], ["sinew", 3]],
  scrap_iron_arbalest: [["scrap_metal", 10], ["goblin_scrap_charm", 5]],
  stormlatch_crossbow: [["charged_core", 2], ["scrap_metal", 5]],
  merfolk_trident: [["merfolk_spearhead", 3], ["merfolk_scale", 5]],
  centaur_lance: [["centaur_horsehair", 5], ["horn", 3]],
  reefspear: [["coral_heartstone", 1], ["shark_tooth", 3]],
  livingwood_staff: [["living_heartwood", 2], ["dryad_heartwood", 5]],
  hexwood_crook: [["mana_shard", 5], ["grave_vine", 5]],
  pilgrim_staff: [["ibex_horn", 3], ["yakfolk_wool_bundle", 3]],
  pantherclaw_stars: [["claw", 5], ["pantherfolk_rosette_hide", 1]],
  runestar: [["rune_fragment", 2], ["scrap_metal", 5]],
  viper_stars: [["venom_sac", 3], ["fang", 5]],
  riverhide_sling: [["beaver_pelt", 1], ["otter_pelt", 2]],
  steppe_sling: [["steppe_horsehair_tassel", 3], ["fine_fur", 5]],
  nixie_sling: [["lakeglass_tear", 1], ["nixie_comb", 2]]
};

export const EQUIPMENT_SWAG_CRAFT_RECIPES: readonly EquipmentSwagCraftRecipe[] = Object.freeze(
  Object.entries(SWAG_WEAPON_EXTRA_MATERIALS).map(([definitionId, extras]) => {
    const variant = ITEM_VARIANT_CATALOG.variants.find(
      (candidate) => candidate.definitionId === definitionId
    );
    if (!variant || variant.role !== "cosmetic" || variant.retired) {
      throw new Error(`Swag weapon ${definitionId} must be a live cosmetic item variant`);
    }
    const base = EQUIPMENT_CRAFT_RECIPES.find((recipe) => recipe.familyId === variant.familyId);
    if (!base) throw new Error(`Swag weapon ${definitionId} has no base family recipe`);
    const materials: { itemId: ResourceType; quantity: number }[] =
      base.materials.map((material) => ({ ...material }));
    for (const [itemId, quantity] of extras) {
      const existing = materials.find((material) => material.itemId === itemId);
      if (existing) existing.quantity += quantity;
      else materials.push({ itemId, quantity });
    }
    return Object.freeze({
      familyId: variant.familyId,
      definitionId: variant.definitionId,
      displayName: variant.displayName,
      baseDefinitionId: base.definitionId,
      materials: Object.freeze(materials.map((material) => Object.freeze(material))),
      ...(base.categoryMaterials === undefined ? {} : { categoryMaterials: base.categoryMaterials })
    });
  })
);

export function equipmentSwagCraftRecipe(definitionId: string): EquipmentSwagCraftRecipe | null {
  return EQUIPMENT_SWAG_CRAFT_RECIPES.find((recipe) => recipe.definitionId === definitionId) ?? null;
}

export const COMBAT_KIT_INDICES = [1, 2, 3, 4, 5, 6] as const;
export type CombatKitIndex = (typeof COMBAT_KIT_INDICES)[number];

export const COMBAT_KIT_INVALID_REASONS = [
  "incomplete",
  "missing_item",
  "not_owned",
  "not_carried",
  "destroyed",
  "duplicate_item",
  "slot_incompatible",
  "secondary_not_ranged_or_shield",
  "readied_secondary_not_ranged",
  "character_level_required",
  "achievement_required"
] as const;
export type CombatKitInvalidReason = (typeof COMBAT_KIT_INVALID_REASONS)[number];

export const EQUIPMENT_UPGRADE_DISABLED_REASONS = [
  "maximum_level",
  "destroyed",
  "not_owned",
  "character_level_required"
] as const;
export type EquipmentUpgradeDisabledReason =
  (typeof EQUIPMENT_UPGRADE_DISABLED_REASONS)[number];

export type EquipmentInstance = {
  instanceId: string;
  definitionId: EquipmentDefinitionId;
  displayName: string;
  ownerPlayerId: string;
  location: EquipmentLocation;
  inventorySlotIndex?: number;
  manorId?: string;
  manorSlotIndex?: number;
  droppable?: boolean;
  manorStorable?: boolean;
  /** `"weapon"` remains read-compatible for retained pre-v2 fixtures and rows. */
  equippedSlot: EquipmentSlot | "weapon" | null;
  itemLevel?: number;
  maximumItemLevel?: number;
  /** 0 means broken; omitted only for retained pre-repair fixtures. */
  condition?: number;
  maximumCondition?: number;
  category?: EquipmentCategory;
  balanceVersion?: number;
  enchantmentIdentity?: string | null;
  /** Random-roll rings only. Rough rings carry no bonuses here (tier only). */
  ring?: RingInstanceView | null;
  /** Utility gear only: uses left (null for every other item). Server-tracked, destroyed at 0. */
  usesRemaining?: number | null;
  /** Present once a weapon, armor piece or shield has been inscribed. */
  inscription?: InscriptionSnapshot | null;
  /** Glimmer Shop copies only: permanent tag and original buyer (crafted copies have none). */
  provenance?: ShopProvenance | null;
  requiredAchievementId?: "bitter_blood" | null;
  achievementRequirementMet?: boolean;
  attackPowerBonus: number;
  defenseBonus: number;
  weaponCategory: WeaponCategory | null;
  armorCategory: ArmorCategory | null;
  twoHanded: boolean;
  savedKitIndices?: CombatKitIndex[];
  derived?: EquipmentItemDerivedStats;
  nextUpgradeLevel?: number | null;
  nextUpgradeCost?: string | null;
  upgradeDisabledReason?: EquipmentUpgradeDisabledReason | null;
  createdAt: string;
  updatedAt: string;
};

/** Complete authoritative v2 instance emitted by equipment services/protocols. */
export type EquipmentInstanceV2 = Omit<
  EquipmentInstance,
  | "equippedSlot"
  | "itemLevel"
  | "maximumItemLevel"
  | "category"
  | "balanceVersion"
  | "enchantmentIdentity"
  | "requiredAchievementId"
  | "achievementRequirementMet"
  | "savedKitIndices"
  | "derived"
  | "nextUpgradeLevel"
  | "nextUpgradeCost"
  | "upgradeDisabledReason"
> & {
  equippedSlot: EquipmentSlot | null;
  itemLevel: number;
  maximumItemLevel: number;
  category: EquipmentCategory;
  balanceVersion: number;
  enchantmentIdentity: string | null;
  requiredAchievementId?: "bitter_blood" | null;
  achievementRequirementMet?: boolean;
  savedKitIndices: CombatKitIndex[];
  derived: EquipmentItemDerivedStats;
  nextUpgradeLevel: number | null;
  nextUpgradeCost: string | null;
  upgradeDisabledReason: EquipmentUpgradeDisabledReason | null;
  condition?: number;
  maximumCondition?: number;
};

/** Durable kit references. Saving a kit never changes active equipment state. */
export type CombatKit = {
  kitIndex: CombatKitIndex;
  name: string;
  readiedWeaponSlot: ReadiedWeaponSlot;
  items: EquipmentSlotRecord<string | null>;
  revision: number;
};

/** Server-authored kit view with current item state and validity. */
export type CombatKitSnapshot = {
  kitIndex: CombatKitIndex;
  name: string;
  readiedWeaponSlot: ReadiedWeaponSlot;
  items: EquipmentSlotRecord<EquipmentInstanceV2 | null>;
  valid: boolean;
  invalidReason: CombatKitInvalidReason | null;
  revision: number;
};

export type EquipmentSnapshot = {
  playerId: string;
  instances: EquipmentInstance[];
  snapshotVersion?: 2;
  balanceVersion?: number;
  active?: EquipmentSlotRecord<EquipmentInstanceV2 | null>;
  readiedWeaponSlot?: ReadiedWeaponSlot;
  activeKitIndex?: CombatKitIndex | null;
  kits?: CombatKitSnapshot[];
  inventoryRevision?: number;
  activeRevision?: number;
  checkpointRevision?: number;
  derivedStats?: EquipmentCombatStats;
  characterLevel?: number;
  repairMessage?: string | null;
  /**
   * Compatibility views used by existing class/combat code during migration.
   * `weapon` is always the readied attacking weapon and is never a shield.
   */
  weapon: EquipmentInstance | null;
  chest: EquipmentInstance | null;
  totalAttackPowerBonus: number;
  totalDefenseBonus: number;
};

/** Complete server-authored snapshot. Legacy optionality exists only on EquipmentSnapshot. */
export type EquipmentSnapshotV2 = Omit<
  EquipmentSnapshot,
  | "instances"
  | "snapshotVersion"
  | "balanceVersion"
  | "active"
  | "readiedWeaponSlot"
  | "activeKitIndex"
  | "kits"
  | "inventoryRevision"
  | "activeRevision"
  | "checkpointRevision"
  | "derivedStats"
  | "characterLevel"
  | "repairMessage"
  | "weapon"
  | "chest"
> & {
  snapshotVersion: 2;
  balanceVersion: number;
  instances: EquipmentInstanceV2[];
  active: EquipmentSlotRecord<EquipmentInstanceV2 | null>;
  readiedWeaponSlot: ReadiedWeaponSlot;
  activeKitIndex: CombatKitIndex | null;
  kits: CombatKitSnapshot[];
  inventoryRevision: number;
  activeRevision: number;
  checkpointRevision: number;
  derivedStats: EquipmentCombatStats;
  characterLevel: number;
  repairMessage: string | null;
  weapon: EquipmentInstanceV2 | null;
  chest: EquipmentInstanceV2 | null;
};

export function emptyEquipmentSlots<Value>(value: Value): EquipmentSlotRecord<Value> {
  return {
    head: value,
    chest: value,
    gloves: value,
    boots: value,
    ring: value,
    ring_2: value,
    melee: value,
    secondary: value,
    tool_axe: value,
    tool_pickaxe: value,
    tool_fishing_pole: value
  };
}

export function equipmentSlotForCategory(category: EquipmentCategory): EquipmentSlot {
  switch (category) {
    case "melee_weapon": return "melee";
    case "ranged_weapon":
    case "shield": return "secondary";
    case "head_armor": return "head";
    case "chest_armor": return "chest";
    case "gloves": return "gloves";
    case "boots": return "boots";
    case "ring": return "ring";
    case "gathering_axe": return "tool_axe";
    case "gathering_pickaxe": return "tool_pickaxe";
    case "gathering_fishing_pole": return "tool_fishing_pole";
  }
}

export function isEquipmentCategoryAllowedInSlot(
  category: EquipmentCategory,
  slot: EquipmentSlot
): boolean {
  if (category === "ring") return slot === "ring" || slot === "ring_2";
  return equipmentSlotForCategory(category) === slot;
}

export function requireEquipmentLevel(level: number): number {
  if (
    !Number.isInteger(level) ||
    level < MIN_EQUIPMENT_LEVEL ||
    level > MAX_EQUIPMENT_LEVEL
  ) {
    throw new Error(
      `Equipment level must be between ${MIN_EQUIPMENT_LEVEL} and ${MAX_EQUIPMENT_LEVEL}`
    );
  }
  return level;
}

export function requireEquipmentDefinition(definitionId: string): EquipmentDefinition {
  const definition = EQUIPMENT_DEFINITIONS[definitionId as EquipmentDefinitionId];
  if (!definition || definition.definitionId !== definitionId) {
    throw new Error(`Unknown equipment definition: ${definitionId}`);
  }
  return definition;
}

export function stockEquipmentDefinitionForFamily(
  familyId: EquipmentGameplayFamilyId
): EquipmentDefinition {
  const definitionId = EQUIPMENT_GAMEPLAY_FAMILIES[familyId].stockDefinitionId;
  if (definitionId === null) {
    throw new Error(`Equipment family ${familyId} has no stock item`);
  }
  return requireEquipmentDefinition(definitionId);
}

export function isStockEquipmentDefinition(definitionId: string): boolean {
  return isEquipmentDefinitionId(definitionId) &&
    requireEquipmentDefinition(definitionId).equipmentRole === "stock";
}
