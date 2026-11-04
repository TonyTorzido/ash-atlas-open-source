import {
  ENCHANTMENT_STONE_VARIANTS,
  type EnchantmentStoneVariant
} from "./progression.js";
import type { EquipmentDefinition } from "./equipment.js";
import type { EquipmentCategory } from "./equipmentContracts.js";

export const POISON_IMBUEMENT_REQUIRED_ACHIEVEMENT_ID = "bitter_blood" as const;
export const EQUIPMENT_CORE_IDS = ["venomsteel"] as const;
export type EquipmentCoreId = (typeof EQUIPMENT_CORE_IDS)[number];

/** Bars consumed by one infusion; a reforge returns METAL_REFORGE_BARS_RETURNED of them. */
export const METAL_BARS_PER_INFUSION = 4;
export const METAL_REFORGE_BARS_RETURNED = 3;
/** Lumen (a carried item) charged to strip the metal, change the gem, or both at once. */
export const METAL_REFORGE_LUMEN_COST = 230;
export const GEM_CHANGE_LUMEN_COST = 120;
export function jewelReforgeLumenCost(changeMetal: boolean, changeGemstone: boolean): number {
  return changeMetal ? METAL_REFORGE_LUMEN_COST : changeGemstone ? GEM_CHANGE_LUMEN_COST : 0;
}
/** Infused equipment costs this much more gold per upgrade level (+30%). */
export const INFUSED_EQUIPMENT_UPGRADE_COST_MULTIPLIER = 1.3;

export const EQUIPMENT_METAL_IDS = [
  "venomsteel", "fire", "lightning", "ice",
  "revenant", "expel", "mirage", "gale", "fleet", "whetted",
  "vengeance", "gloom", "skyrise", "vital"
] as const;
export type EquipmentMetal = (typeof EQUIPMENT_METAL_IDS)[number];

/** Legacy elemental metals that already shipped with a Core item. */
export const LEGACY_CORE_METAL_IDS = ["venomsteel", "fire", "lightning", "ice"] as const;
export type LegacyCoreMetal = (typeof LEGACY_CORE_METAL_IDS)[number];

export const EQUIPMENT_EFFECT_IDS = [
  "poison", "burning", "storm", "slow",
  "raise_revenant", "expel", "blink", "knockback", "steal_speed", "whetted",
  "vengeance", "withered", "immobilize", "vitality"
] as const;
export type EquipmentEffectId = (typeof EQUIPMENT_EFFECT_IDS)[number];

/**
 * Proc chance on a landed hit. `missing_hp` is `base + perMissingHp * (1 - hp%)`
 * of the opposing target; `event` metals trigger on kills and deaths instead.
 * Effects are wired in a later phase; this is the authoritative data.
 */
export type MetalProcChance =
  | Readonly<{ kind: "fixed"; chance: number }>
  | Readonly<{ kind: "missing_hp"; base: number; perMissingHp: number }>
  | Readonly<{ kind: "event" }>;

export type EquipmentMetalDefinition = Readonly<{
  id: EquipmentMetal;
  displayName: string;
  /** Metallurgy profession rank needed to smelt a bar (ranks 1/2/3 map to 1/3/5). */
  metallurgyRank: 1 | 3 | 5;
  effect: EquipmentEffectId;
  weapon: MetalProcChance;
  armor: MetalProcChance;
  barItemId: `${EquipmentMetal}_bar`;
  /** Pre-framework Core item still accepted by the Jewel Station. */
  legacyCoreItemId: `${LegacyCoreMetal}_core` | null;
}>;

function fixed(chance: number): MetalProcChance {
  return Object.freeze({ kind: "fixed", chance });
}

function missingHp(base: number, perMissingHp: number): MetalProcChance {
  return Object.freeze({ kind: "missing_hp", base, perMissingHp });
}

const EVENT_PROC: MetalProcChance = Object.freeze({ kind: "event" });

function metal(
  id: EquipmentMetal,
  displayName: string,
  metallurgyRank: 1 | 3 | 5,
  effect: EquipmentEffectId,
  weapon: MetalProcChance,
  armor: MetalProcChance
): EquipmentMetalDefinition {
  return Object.freeze({
    id,
    displayName,
    metallurgyRank,
    effect,
    weapon,
    armor,
    barItemId: `${id}_bar`,
    legacyCoreItemId: (LEGACY_CORE_METAL_IDS as readonly string[]).includes(id)
      ? `${id as LegacyCoreMetal}_core`
      : null
  });
}

export const EQUIPMENT_METAL_DEFINITIONS: Readonly<Record<EquipmentMetal, EquipmentMetalDefinition>> =
  Object.freeze({
    revenant: metal("revenant", "Revenant", 1, "raise_revenant", EVENT_PROC, EVENT_PROC),
    expel: metal("expel", "Expel", 1, "expel", missingHp(0, 0.12), missingHp(0, 0.12)),
    mirage: metal("mirage", "Mirage", 1, "blink", fixed(0.35), fixed(0.20)),
    gale: metal("gale", "Gale", 1, "knockback", fixed(0.27), fixed(0.24)),
    fleet: metal("fleet", "Fleet", 3, "steal_speed", fixed(0.34), fixed(0.17)),
    venomsteel: metal("venomsteel", "Venom", 3, "poison", fixed(0.22), fixed(0.13)),
    whetted: metal("whetted", "Whetted", 1, "whetted", fixed(0.18), fixed(0.08)),
    lightning: metal("lightning", "Storm", 3, "storm", fixed(0.52), fixed(0.45)),
    vengeance: metal("vengeance", "Vengeance", 5, "vengeance", fixed(0.44), fixed(0.34)),
    gloom: metal("gloom", "Gloom", 5, "withered", missingHp(0.22, 0.17), missingHp(0.28, 0.13)),
    fire: metal("fire", "Ember", 5, "burning", fixed(0.17), fixed(0.12)),
    ice: metal("ice", "Frost", 3, "slow", fixed(0.35), fixed(0.33)),
    skyrise: metal("skyrise", "Skyrise", 5, "immobilize", fixed(0.23), fixed(0.12)),
    vital: metal("vital", "Vital", 5, "vitality", fixed(0.26), fixed(0.18))
  });

export function equipmentMetalDefinition(id: EquipmentMetal): EquipmentMetalDefinition {
  return EQUIPMENT_METAL_DEFINITIONS[id];
}

/** Every metal is craftable; Skyrise smelts from Mana Shard in place of the missing Zephyr. */
export function equipmentMetalCraftable(_id: EquipmentMetal): boolean {
  return true;
}

export function isEquipmentMetal(value: string): value is EquipmentMetal {
  return (EQUIPMENT_METAL_IDS as readonly string[]).includes(value);
}

/** Gold cost of one upgrade step for an item with this enhancement identity. */
export function equipmentUpgradeCostForIdentity(
  baseCost: number,
  identity: string | null
): number {
  return parseEquipmentEnhancement(identity)?.metal
    ? Math.ceil(baseCost * INFUSED_EQUIPMENT_UPGRADE_COST_MULTIPLIER)
    : baseCost;
}

/** Proc quality multiplier bounds; tunable. */
export const METAL_PROC_QUALITY_MULTIPLIER_MIN = 0.5;
export const METAL_PROC_QUALITY_MULTIPLIER_MAX = 1.5;

/**
 * `(12 + Q1 - Q2) / 12`, clamped. Q1 is the level of the gear carrying the metal,
 * Q2 the level of the opposing piece. Mobs use `mobMetalProcQuality`.
 */
export function metalProcQualityMultiplier(q1: number, q2: number): number {
  const raw = (12 + q1 - q2) / 12;
  if (!Number.isFinite(raw)) return 1;
  return Math.min(
    METAL_PROC_QUALITY_MULTIPLIER_MAX,
    Math.max(METAL_PROC_QUALITY_MULTIPLIER_MIN, raw)
  );
}

export function mobMetalProcQuality(mobLevel: number): number {
  return Math.round(mobLevel / 5);
}

export type EquipmentAppearanceEnhancement = Readonly<{
  gemstone: EnchantmentStoneVariant;
  coreId: EquipmentCoreId | null;
}>;

const VENOMSTEEL_WEAPON_CATEGORIES: readonly EquipmentCategory[] = [
  "melee_weapon",
  "ranged_weapon"
];
const VENOMSTEEL_ARMOR_CATEGORIES: readonly EquipmentCategory[] = [
  "head_armor",
  "chest_armor",
  "gloves",
  "boots"
];

export type EquipmentEnhancementV1 = Readonly<{
  version: 1;
  /** Null for gem-less metal infusions (`enh:v1:none:<metal>`). */
  gemstone: EnchantmentStoneVariant | null;
  metal: null | EquipmentMetal;
  effect: null | EquipmentEffectId;
}>;

export function preparedEquipmentEnhancement(
  gemstone: EnchantmentStoneVariant
): EquipmentEnhancementV1 {
  return { version: 1, gemstone, metal: null, effect: null };
}

export function poisonEquipmentEnhancement(
  gemstone: EnchantmentStoneVariant | null
): EquipmentEnhancementV1 {
  return metalEquipmentEnhancement(gemstone, "venomsteel");
}

export type ElementalMetal = "fire" | "lightning" | "ice";

export function equipmentMetalDisplayName(metal: EquipmentMetal): string {
  return EQUIPMENT_METAL_DEFINITIONS[metal].displayName;
}

export function equipmentEffectDisplayName(effect: EquipmentEffectId): string {
  switch (effect) {
    case "poison": return "Poisoned";
    case "burning": return "Burning";
    case "storm": return "Electrified";
    case "slow": return "Slowed";
    case "raise_revenant": return "Raise Revenant";
    case "expel": return "Expelled";
    case "blink": return "Blink";
    case "knockback": return "Knockback";
    case "steal_speed": return "Speed Steal";
    case "whetted": return "Whetted";
    case "vengeance": return "Vengeance";
    case "withered": return "Withered";
    case "immobilize": return "Immobilized";
    case "vitality": return "Vitality";
  }
}

/**
 * Whether the Jewel Station lists the item at all: new infusion targets plus the
 * legacy head, glove and boot slots (so existing infusions can still be reforged).
 */
export function supportsJewelStationEnhancement(
  definition: Pick<EquipmentDefinition, "category" | "equipmentRole" | "retired">
): boolean {
  return definition.retired !== true &&
    (definition.equipmentRole === "stock" || definition.equipmentRole === "cosmetic") &&
    (metalInfusionKind(definition.category) !== null ||
      venomsteelImbuementKind(definition.category) !== null);
}

/**
 * New infusions: weapons, chest armor and shields. Head, glove and boot pieces
 * that were infused before the metal framework keep working but cannot be
 * infused again.
 */
export function metalInfusionKind(
  category: EquipmentCategory
): "weapon" | "armor" | null {
  if (category === "melee_weapon" || category === "ranged_weapon") return "weapon";
  if (category === "chest_armor" || category === "shield") return "armor";
  return null;
}

export function metalEquipmentEnhancement(
  gemstone: EnchantmentStoneVariant | null,
  metal: EquipmentMetal
): EquipmentEnhancementV1 {
  return {
    version: 1,
    gemstone,
    metal,
    effect: EQUIPMENT_METAL_DEFINITIONS[metal].effect
  };
}

export function elementalEquipmentEnhancement(
  gemstone: EnchantmentStoneVariant | null,
  metal: ElementalMetal
): EquipmentEnhancementV1 {
  return metalEquipmentEnhancement(gemstone, metal);
}

export function serializeEquipmentEnhancement(enhancement: EquipmentEnhancementV1): string {
  const stage = enhancement.metal ?? "prepared";
  return `enh:v1:${enhancement.gemstone ?? "none"}:${stage}`;
}

const ENHANCEMENT_IDENTITY_PATTERN = new RegExp(
  `^enh:v1:(diamond|onyx|opal|amethyst|topaz|sapphire|ruby|emerald|none):(prepared|${EQUIPMENT_METAL_IDS.join("|")})$`
);

export function parseEquipmentEnhancement(identity: string | null): EquipmentEnhancementV1 | null {
  if (!identity) return null;
  const match = ENHANCEMENT_IDENTITY_PATTERN.exec(identity);
  if (!match) return null;
  const stage = match[2]!;
  if (match[1] === "none") {
    return stage !== "prepared" && isEquipmentMetal(stage)
      ? metalEquipmentEnhancement(null, stage)
      : null;
  }
  const gemstone = match[1] as EnchantmentStoneVariant;
  if (!ENCHANTMENT_STONE_VARIANTS.includes(gemstone)) return null;
  if (stage !== "prepared" && isEquipmentMetal(stage)) {
    return metalEquipmentEnhancement(gemstone, stage);
  }
  return preparedEquipmentEnhancement(gemstone);
}

export function equipmentRequiredAchievementId(
  identity: string | null
): typeof POISON_IMBUEMENT_REQUIRED_ACHIEVEMENT_ID | null {
  return parseEquipmentEnhancement(identity)?.effect === "poison"
    ? POISON_IMBUEMENT_REQUIRED_ACHIEVEMENT_ID
    : null;
}

export function isVenomsteelPoisonEnhancement(identity: string | null): boolean {
  const enhancement = parseEquipmentEnhancement(identity);
  return enhancement?.metal === "venomsteel" && enhancement.effect === "poison";
}

export function equipmentAppearanceEnhancement(
  identity: string | null
): EquipmentAppearanceEnhancement | null {
  const enhancement = parseEquipmentEnhancement(identity);
  // Gem-less infusions have no gem presentation; metal-specific art comes later.
  if (!enhancement?.gemstone) return null;
  return {
    gemstone: enhancement.gemstone,
    coreId: enhancement.metal === "venomsteel" ? "venomsteel" : null
  };
}

export function venomsteelImbuementKind(
  category: EquipmentCategory
): "weapon" | "armor" | null {
  if (VENOMSTEEL_WEAPON_CATEGORIES.includes(category)) return "weapon";
  if (VENOMSTEEL_ARMOR_CATEGORIES.includes(category)) return "armor";
  return null;
}
