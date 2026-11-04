import {
  BASIC_ATTACK_INTERVAL_MS,
  MELEE_ATTACK_RANGE_M,
  RANGED_ATTACK_RANGE_M
} from "./combatConstants.js";
import {
  CURRENT_LEVEL_CAP,
  resolvePlayerMaxHealth
} from "./progression.js";
import {
  WARRIOR_MAX_RANK
} from "./masteries.js";
import {
  CLASS_DEFINITIONS,
  type ArmorCategory,
  type ClassEquipmentAffinitySnapshot,
  type ClassId,
  type WeaponCategory
} from "./classes.js";
import {
  MOB_CHALLENGE_TIERS,
  type CombatContext,
  type EquipmentChallengeProfile,
  type EquipmentCombatStats,
  type EquipmentItemDerivedStats,
  type MobChallengeTier
} from "./equipmentBalanceContracts.js";
import {
  EQUIPMENT_SLOTS,
  isGatheringToolSlot,
  type EquipmentSlot,
  type EquipmentSlotRecord,
  type ReadiedWeaponSlot
} from "./equipmentContracts.js";
import {
  EQUIPMENT_BALANCE_VERSION,
  MAX_EQUIPMENT_LEVEL,
  emptyEquipmentSlots,
  isEquipmentCategoryAllowedInSlot,
  requireEquipmentDefinition,
  requireEquipmentLevel,
  type EquipmentDefinition,
  type EquipmentInstanceV2
} from "./equipment.js";
import { parseEquipmentEnhancement } from "./equipmentEnhancements.js";
import {
  RING_GEAR_ATTUNEMENT_FAMILIES,
  ringTierForDefinitionId,
  resolveWornRingBonuses,
  type RingInstanceView,
  type WornRing
} from "./rings.js";
import {
  clampEquipmentCondition,
  equipmentRepairCostForFamily,
  EQUIPMENT_MAX_CONDITION
} from "./equipmentRepair.js";

export {
  COMBAT_CONTEXTS,
  EQUIPMENT_STAT_SCOPES,
  EQUIPMENT_UTILITY_KINDS,
  MOB_CHALLENGE_TIERS
} from "./equipmentBalanceContracts.js";
export type {
  CombatContext,
  EquipmentChallengeProfile,
  EquipmentCombatStats,
  EquipmentItemDerivedStats,
  EquipmentStatScope,
  EquipmentUtilityKind,
  MobChallengeTier
} from "./equipmentBalanceContracts.js";

export const EQUIPMENT_BASE_BASIC_ATTACK = 10;
export const EQUIPMENT_MITIGATION_SCALE = 9;
export const SHIELD_DEFENSE_PER_LEVEL = 0.4;
export const HEAD_RESOURCE_MAXIMUM_AT_CAP = 5;
export const HEAD_RESOURCE_GENERATION_BONUS_AT_CAP = 0.05;
export const GLOVES_ACTION_DURATION_REDUCTION_AT_CAP = 0.10;
export const BOOTS_MOVEMENT_SPEED_BONUS_AT_CAP = 0.05;
export const BOOTS_CC_DURATION_REDUCTION_AT_CAP = 0.10;
export const CHOPPING_RING_DURATION_MULTIPLIER = 0.8;
export const MINING_RING_DURATION_MULTIPLIER = 0.8;
export const ATTACK_RING_POWER_BONUS = 3;
export const WEAPON_SWITCH_HYSTERESIS_M = 5;
export const WEAPON_SWITCH_DELAY_MS = BASIC_ATTACK_INTERVAL_MS * 0.25;

export const WEAPON_SWITCH_POLICIES = [
  "melee_priority",
  "ranged_priority",
  "ranged_only"
] as const;
export type WeaponSwitchPolicy = (typeof WEAPON_SWITCH_POLICIES)[number];

/*
 * Deprecated V1 exports remain as neutral aliases for retained consumers. They
 * no longer participate in combat resolution.
 */
export const PVP_CHARACTER_POWER_WEIGHT = 0;
export const PVP_CLASS_POWER_WEIGHT = 0;
export const PVP_EQUIPMENT_POWER_WEIGHT = 1;
export const PVP_BASE_BASIC_DAMAGE = EQUIPMENT_BASE_BASIC_ATTACK;
export const PVP_POWER_DIFFERENCE_MINIMUM = Number.NEGATIVE_INFINITY;
export const PVP_POWER_DIFFERENCE_MAXIMUM = Number.POSITIVE_INFINITY;
export const PVP_POWER_GROWTH_PER_POINT = 1;
export const PVP_ARMOR_SLOT_WEIGHTS = {
  head: 0,
  chest: 1,
  gloves: 0,
  boots: 0,
  ring: 0
} as const;
export const SHIELD_GUARD_BASE = 0;
export const SHIELD_GUARD_PER_EFFECTIVE_LEVEL = SHIELD_DEFENSE_PER_LEVEL;
export const SHIELD_GUARD_MAXIMUM =
  Math.round(MAX_EQUIPMENT_LEVEL * SHIELD_DEFENSE_PER_LEVEL);
export const PVE_BASE_ATTACK_POWER = EQUIPMENT_BASE_BASIC_ATTACK;
export const PVE_CHARACTER_TIER_SIZE = Number.POSITIVE_INFINITY;

/**
 * Version-one prices remain the authoritative V2 price schedule. Balance V2
 * changes effects and legality, not already-advertised upgrade prices.
 */
export const EQUIPMENT_UPGRADE_COSTS_V1 = [
  10, 15, 25, 40, 60,
  85, 115, 150, 190, 240,
  300, 370, 450, 540, 640,
  750, 875, 1_015, 1_170, 1_340,
  1_525, 1_725, 1_940, 2_170, 2_420,
  // Levels 25-39 continue the step schedule: +20 per step through 390, then +25.
  // Only the first MAX_EQUIPMENT_LEVEL entries are reachable at the current cap.
  2_690, 2_980, 3_290, 3_620, 3_970,
  4_340, 4_730, 5_145, 5_585, 6_050,
  6_540, 7_055, 7_595, 8_160, 8_750
] as const;

export type ClassEquipmentAffinity = {
  classId: ClassId;
  preferredMeleeWeaponCategories: readonly WeaponCategory[];
  preferredArmorCategories: readonly ArmorCategory[];
  effectiveLevelBonus: number;
};

/** Affinity is intentionally neutral in V2. Stored item levels are universal. */
export const CLASS_EQUIPMENT_AFFINITIES: Readonly<
  Partial<Record<ClassId, ClassEquipmentAffinity>>
> = {};

export function classEquipmentAffinitySnapshot(
  classId: ClassId
): ClassEquipmentAffinitySnapshot | null {
  const affinity = CLASS_EQUIPMENT_AFFINITIES[classId];
  if (!affinity) return null;
  return {
    balanceVersion: EQUIPMENT_BALANCE_VERSION,
    classId: affinity.classId,
    classDisplayName: CLASS_DEFINITIONS[classId].name,
    preferredMeleeWeaponCategories: affinity.preferredMeleeWeaponCategories,
    preferredArmorCategories: affinity.preferredArmorCategories,
    effectiveLevelBonus: 0
  };
}

export type EquipmentBalanceItem = {
  instanceId: string;
  definition: Omit<EquipmentDefinition, "definitionId"> & { definitionId: string };
  itemLevel: number;
  condition?: number;
  /** Random-roll rings: tier, Rough state and rolled bonuses (server view, never Rough-hidden). */
  ring?: RingInstanceView | null;
  /** Metal infusion identity; inflict ring bonuses need the matching metal on weapon or armor. */
  enchantmentIdentity?: string | null;
};

export type ActiveEquipmentLoadout = {
  active: EquipmentSlotRecord<EquipmentBalanceItem | null>;
  /** Retained durable preference; combat reconnect always starts on melee. */
  readiedWeaponSlot: ReadiedWeaponSlot;
};

export type ResolveEquipmentCombatStatsInput = {
  context: CombatContext;
  characterLevel: number;
  classId: ClassId;
  classRank: number;
  loadout: ActiveEquipmentLoadout;
  pveWeaponProficiencyMultiplier?: number;
  unlockedGearLevel?: number;
};

export type PvpDamageResolution = {
  damageBeforePowerScaling: number;
  powerDifference: number;
  powerMultiplier: number;
  finalDamage: number;
};

export type WeaponProcResolverInput = {
  combatActionSequence: number;
  attackerEntityId: string;
  targetEntityId: string;
  combatContext: CombatContext;
  activeWeaponInstanceId: string;
  activeWeaponDefinitionId: string;
  enchantmentIdentity: string;
  random: () => number;
};

export type WeaponProcResolution = {
  statusApplicationIds: readonly string[];
  telemetryResult: string | null;
};

export type WeaponProcResolver = (
  input: WeaponProcResolverInput
) => WeaponProcResolution;

export function equipmentUpgradeCost(
  currentLevel: number,
  balanceVersion = EQUIPMENT_BALANCE_VERSION
): number {
  requireBalanceVersion(balanceVersion);
  const safeLevel = requireEquipmentLevel(currentLevel);
  if (safeLevel >= MAX_EQUIPMENT_LEVEL) {
    throw new Error(`Equipment is already at maximum level ${MAX_EQUIPMENT_LEVEL}`);
  }
  return EQUIPMENT_UPGRADE_COSTS_V1[safeLevel]!;
}

/** @deprecated V2 contributions are direct functions of the raw item level. */
export function equipmentLevelScaling(
  effectiveItemLevel: number,
  balanceVersion = EQUIPMENT_BALANCE_VERSION
): number {
  requireBalanceVersion(balanceVersion);
  if (!Number.isFinite(effectiveItemLevel) || effectiveItemLevel < 0) {
    throw new Error("Effective equipment level must be a nonnegative finite number");
  }
  return 1;
}

/** @deprecated Equipment affinity is neutral in V2. */
export function resolveEquipmentAffinityBonus(_input: {
  classId: ClassId;
  definition: Pick<
    EquipmentDefinition,
    "category" | "weaponCategory" | "armorCategory"
  >;
}): number {
  void _input;
  return 0;
}

export function resolveEquipmentItemDerivedStats(input: {
  item: EquipmentBalanceItem;
  slot: EquipmentSlot;
  classId: ClassId;
}): EquipmentItemDerivedStats {
  const definition = input.item.definition;
  if (!isEquipmentCategoryAllowedInSlot(definition.category, input.slot)) {
    throw new Error(
      `Equipment category ${definition.category} is not valid in slot ${input.slot}`
    );
  }
  const itemLevel = requireEquipmentLevel(input.item.itemLevel);
  const condition = clampEquipmentCondition(input.item.condition);
  const conditionRatio = definition.category === "chest_armor" &&
      equipmentRepairCostForFamily(definition.gameplayFamilyId)
    ? condition / EQUIPMENT_MAX_CONDITION
    : 1;
  const progress = itemLevel / MAX_EQUIPMENT_LEVEL;
  const universalAttackContribution =
    definition.basePveAttackContribution + (
      definition.category === "melee_weapon" ||
      definition.category === "ranged_weapon"
        ? itemLevel
        : 0
    );
  const universalDefenseContribution = definition.category === "chest_armor"
    ? Math.round(itemLevel * conditionRatio)
    : definition.category === "shield"
      ? Math.round(itemLevel * SHIELD_DEFENSE_PER_LEVEL)
      : 0;
  const resourceMaximumBonus = definition.utilityKind === "resource_maximum"
    ? Math.round(HEAD_RESOURCE_MAXIMUM_AT_CAP * progress)
    : 0;
  const resourceGenerationMultiplier = definition.utilityKind === "resource_generation"
    ? 1 + HEAD_RESOURCE_GENERATION_BONUS_AT_CAP * progress
    : 1;
  const actionDurationMultiplier = definition.utilityKind === "action_duration"
    ? 1 - GLOVES_ACTION_DURATION_REDUCTION_AT_CAP * progress
    : 1;
  const choppingDurationMultiplier = definition.utilityKind === "chopping_duration"
    ? CHOPPING_RING_DURATION_MULTIPLIER
    : 1;
  const miningDurationMultiplier = definition.utilityKind === "mining_duration"
    ? MINING_RING_DURATION_MULTIPLIER
    : 1;
  const movementSpeedMultiplier = definition.utilityKind === "movement_and_cc"
    ? 1 + BOOTS_MOVEMENT_SPEED_BONUS_AT_CAP * progress
    : 1;
  const crowdControlDurationMultiplier = definition.utilityKind === "movement_and_cc"
    ? 1 - BOOTS_CC_DURATION_REDUCTION_AT_CAP * progress
    : 1;

  return {
    instanceId: input.item.instanceId,
    definitionId: definition.definitionId,
    slot: input.slot,
    category: definition.category,
    weaponCategory: definition.weaponCategory,
    armorCategory: definition.armorCategory,
    twoHanded: definition.twoHanded,
    itemLevel,
    maximumItemLevel: MAX_EQUIPMENT_LEVEL,
    condition,
    maximumCondition: EQUIPMENT_MAX_CONDITION,
    requiredCharacterLevel: 0,
    statScope: definition.statScope,
    utilityKind: definition.utilityKind,
    affinityBonus: 0,
    effectiveItemLevel: itemLevel,
    pveLevelScaling: 1,
    pveAttackContribution: universalAttackContribution,
    pveDefenseContribution: universalDefenseContribution,
    pvpLevelContribution: universalAttackContribution + universalDefenseContribution,
    universalAttackContribution,
    universalDefenseContribution,
    bypassPveDefense: definition.bypassPveDefense === true,
    resourceMaximumBonus,
    resourceGenerationMultiplier,
    actionDurationMultiplier,
    choppingDurationMultiplier,
    miningDurationMultiplier,
    movementSpeedMultiplier,
    crowdControlDurationMultiplier,
    balanceVersion: EQUIPMENT_BALANCE_VERSION
  };
}

export function resolveEquipmentCombatStats(
  input: ResolveEquipmentCombatStatsInput
): EquipmentCombatStats {
  const characterLevel = clampInteger(input.characterLevel, 0, CURRENT_LEVEL_CAP);
  const classRankMaximum = input.classId === "warrior"
    ? WARRIOR_MAX_RANK
    : CURRENT_LEVEL_CAP;
  const classRank = clampInteger(input.classRank, 0, classRankMaximum);
  const items = emptyEquipmentSlots<EquipmentItemDerivedStats | null>(null);
  const seenInstanceIds = new Set<string>();

  for (const slot of EQUIPMENT_SLOTS) {
    const item = input.loadout.active[slot];
    if (!item) continue;
    if (seenInstanceIds.has(item.instanceId)) {
      throw new Error(`Equipment instance ${item.instanceId} occupies more than one active slot`);
    }
    seenInstanceIds.add(item.instanceId);
    items[slot] = resolveEquipmentItemDerivedStats({
      item,
      slot,
      classId: input.classId
    });
  }

  const secondary = items.secondary;
  if (
    input.loadout.readiedWeaponSlot === "secondary" &&
    secondary?.category !== "ranged_weapon"
  ) {
    throw new Error("The secondary slot can be readied only when it contains a ranged weapon");
  }
  if (items.melee !== null && items.melee.category !== "melee_weapon") {
    throw new Error("The melee slot must contain a melee weapon");
  }

  const ringAttackBonus = items.ring?.utilityKind === "attack_bonus"
    ? items.ring.universalAttackContribution
    : 0;
  const ringBonuses = resolveWornRingBonuses([
    wornRing(input.loadout.active.ring),
    wornRing(input.loadout.active.ring_2)
  ], wornRingMetals(EQUIPMENT_SLOTS
    .filter((slot) => slot !== "ring" && slot !== "ring_2" && !isGatheringToolSlot(slot))
    .map((slot) => input.loadout.active[slot]?.enchantmentIdentity ?? null))).totals;
  // Gear attunement (Peerless rings): extra damage with that weapon family, extra defense with that piece.
  const attunedTo = (familyId: string | undefined): number => {
    if (!familyId) return 0;
    let total = 0;
    for (const [key, value] of Object.entries(ringBonuses)) {
      if (RING_GEAR_ATTUNEMENT_FAMILIES[key]?.includes(familyId)) total += value;
    }
    return total;
  };
  const familyOf = (slot: EquipmentSlot): string | undefined =>
    input.loadout.active[slot]?.definition.gameplayFamilyId;
  const weaponAttackPower = {
    melee: EQUIPMENT_BASE_BASIC_ATTACK +
      (items.melee?.category === "melee_weapon"
        ? items.melee.universalAttackContribution + attunedTo(familyOf("melee"))
        : 0) + ringAttackBonus,
    secondary: EQUIPMENT_BASE_BASIC_ATTACK +
      (secondary?.category === "ranged_weapon"
        ? secondary.universalAttackContribution + attunedTo(familyOf("secondary"))
        : 0) + ringAttackBonus
  };
  const weaponCategories = {
    melee: items.melee?.weaponCategory ?? null,
    secondary: secondary?.category === "ranged_weapon"
      ? secondary.weaponCategory
      : null
  };
  const readiedWeaponSlot = input.loadout.readiedWeaponSlot;
  const readied = items[readiedWeaponSlot];
  const universalDefense =
    (items.chest ? items.chest.universalDefenseContribution + attunedTo(familyOf("chest")) : 0) +
    (secondary?.category === "shield"
      ? secondary.universalDefenseContribution + attunedTo(familyOf("secondary"))
      : 0);
  const resourceMaximumBonus = items.head?.resourceMaximumBonus ?? 0;
  const resourceGenerationMultiplier =
    items.head?.resourceGenerationMultiplier ?? 1;
  const actionDurationMultiplier = items.gloves?.actionDurationMultiplier ?? 1;
  const choppingDurationMultiplier = items.ring?.choppingDurationMultiplier ?? 1;
  const miningDurationMultiplier = items.ring?.miningDurationMultiplier ?? 1;
  // Land speed rings: +1.25/2.5/3.75% overworld speed.
  const movementSpeedMultiplier = (items.boots?.movementSpeedMultiplier ?? 1) *
    (1 + (ringBonuses.land_speed ?? 0) / 100);
  const crowdControlDurationMultiplier =
    items.boots?.crowdControlDurationMultiplier ?? 1;
  const challengeProfile = resolveEquipmentChallengeProfile({
    meleeLevel: items.melee?.itemLevel ?? null,
    chestLevel: items.chest?.itemLevel ?? null,
    secondaryLevel: items.secondary?.itemLevel ?? null,
    secondaryCategory: secondary?.category === "ranged_weapon"
      ? "weapon"
      : secondary?.category === "shield" ? "armor" : null,
    ...(input.unlockedGearLevel === undefined
      ? {}
      : { unlockedGearLevel: input.unlockedGearLevel })
  });
  const universalAttackPower = weaponAttackPower[readiedWeaponSlot];

  return {
    balanceVersion: EQUIPMENT_BALANCE_VERSION,
    context: input.context,
    maximumHealth: resolvePlayerMaxHealth() + Math.max(0, Math.round(ringBonuses.max_hp ?? 0)),
    characterLevel,
    classId: input.classId,
    classRank,
    normalizedClassPower: classRank,
    readiedWeaponSlot,
    readiedWeaponCategory: weaponCategories[readiedWeaponSlot],
    weaponItemLevel: readied?.itemLevel ?? 0,
    effectiveWeaponLevel: readied?.itemLevel ?? 0,
    weightedArmorLevel: items.chest?.itemLevel ?? 0,
    shieldLevel: secondary?.category === "shield" ? secondary.itemLevel : null,
    shieldGuardBonus: secondary?.category === "shield"
      ? secondary.universalDefenseContribution
      : 0,
    pvpOffense: universalAttackPower,
    pvpGuard: universalDefense,
    pveAttackPower: universalAttackPower,
    pveDefense: universalDefense,
    pveWeaponProficiencyMultiplier: 1,
    universalAttackPower,
    universalDefense,
    bypassPveDefense: readied?.bypassPveDefense === true,
    weaponAttackPower,
    weaponCategories,
    resourceMaximumBonus,
    resourceGenerationMultiplier,
    actionDurationMultiplier,
    choppingDurationMultiplier,
    miningDurationMultiplier,
    movementSpeedMultiplier,
    crowdControlDurationMultiplier,
    challengeProfile,
    ...(Object.keys(ringBonuses).length > 0 ? { ringBonuses } : {}),
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS,
    attackRangeM: readiedWeaponSlot === "secondary"
      ? RANGED_ATTACK_RANGE_M
      : MELEE_ATTACK_RANGE_M,
    items
  };
}

/** Metals carried by the worn weapon and armor (their infusion identities). */
export function wornRingMetals(enchantmentIdentities: readonly (string | null | undefined)[]): Set<string> {
  const metals = new Set<string>();
  for (const identity of enchantmentIdentities) {
    const metal = parseEquipmentEnhancement(identity ?? null)?.metal;
    if (metal) metals.add(metal);
  }
  return metals;
}

function wornRing(item: EquipmentBalanceItem | null): WornRing | null {
  if (!item?.ring) return null;
  const tier = ringTierForDefinitionId(item.definition.definitionId);
  if (!tier) return null;
  return { instanceId: item.instanceId, tier, rough: item.ring.rough, bonuses: item.ring.bonuses };
}

export function resolveEquipmentChallengeProfile(input: {
  /** Equipped item levels; null when the slot is empty. */
  meleeLevel: number | null;
  chestLevel: number | null;
  secondaryLevel: number | null;
  /** Ranged weapons count toward the weapon category, shields toward armor. */
  secondaryCategory?: "weapon" | "armor" | null;
  unlockedGearLevel?: number;
}): EquipmentChallengeProfile {
  const contributors = {
    melee: requireEquipmentLevel(input.meleeLevel ?? 0),
    chest: requireEquipmentLevel(input.chestLevel ?? 0),
    secondary: requireEquipmentLevel(input.secondaryLevel ?? 0)
  };
  const secondaryCategory = input.secondaryLevel === null
    ? null
    : input.secondaryCategory ?? null;
  // Effective level: ceil(mean(best weapon, best armor)),
  // omitting an absent category. No combat gear at all is level 0.
  const weaponLevels = [
    ...(input.meleeLevel === null ? [] : [contributors.melee]),
    ...(secondaryCategory === "weapon" ? [contributors.secondary] : [])
  ];
  const armorLevels = [
    ...(input.chestLevel === null ? [] : [contributors.chest]),
    ...(secondaryCategory === "armor" ? [contributors.secondary] : [])
  ];
  const categoryLevels = [weaponLevels, armorLevels]
    .filter((levels) => levels.length > 0)
    .map((levels) => Math.max(...levels));
  const currentGearLevel = categoryLevels.length === 0
    ? 0
    : Math.ceil(
      categoryLevels.reduce((sum, level) => sum + level, 0) / categoryLevels.length
    );
  const unlockedGearLevel = Math.max(
    currentGearLevel,
    clampInteger(input.unlockedGearLevel ?? currentGearLevel, 0, MAX_EQUIPMENT_LEVEL)
  );
  return {
    balanceVersion: EQUIPMENT_BALANCE_VERSION,
    currentGearLevel,
    unlockedGearLevel,
    tier: mobChallengeTier(unlockedGearLevel),
    contributors
  };
}

/**
 * Challenge tiers split the equipment level cap into equal bands: 0-5/6-10/11-15/16-20/21-25
 * at cap 25, 0-8/9-16/17-24/25-32/33-40 at cap 40. The generated_world_mobs tier
 * check constraint mirrors these bands, so a cap change needs a migration.
 */
export const MOB_CHALLENGE_TIER_BAND_WIDTH = MAX_EQUIPMENT_LEVEL / MOB_CHALLENGE_TIERS.length;

export function mobChallengeTier(level: number): MobChallengeTier {
  const safeLevel = clampInteger(level, 0, MAX_EQUIPMENT_LEVEL);
  const band = Math.max(0, Math.ceil(safeLevel / MOB_CHALLENGE_TIER_BAND_WIDTH) - 1);
  return MOB_CHALLENGE_TIERS[band]!;
}

export function resolveVersionedCombatDamage(input: {
  rawAttack: number;
  defense: number;
  balanceVersion?: number;
}): number {
  requireBalanceVersion(input.balanceVersion ?? EQUIPMENT_BALANCE_VERSION);
  const rawAttack = Math.max(0, requireFinite(input.rawAttack, "raw attack"));
  const defense = Math.max(0, requireFinite(input.defense, "defense"));
  return Math.max(
    1,
    Math.round(rawAttack * EQUIPMENT_MITIGATION_SCALE /
      (EQUIPMENT_MITIGATION_SCALE + defense))
  );
}

export function resolvePvpDamage(input: {
  attackerOffense: number;
  defenderGuard: number;
  damageBeforePowerScaling?: number;
  damageMultiplier?: number;
}): PvpDamageResolution {
  const rawAttack = Math.max(
    0,
    requireFinite(
      input.damageBeforePowerScaling ?? input.attackerOffense,
      "raw PvP attack"
    ) * requirePositiveFiniteMultiplier(input.damageMultiplier ?? 1)
  );
  const defenderGuard = Math.max(
    0,
    requireFinite(input.defenderGuard, "PvP defense")
  );
  const finalDamage = resolveVersionedCombatDamage({
    rawAttack,
    defense: defenderGuard
  });
  return {
    damageBeforePowerScaling: rawAttack,
    powerDifference: input.attackerOffense - defenderGuard,
    powerMultiplier: rawAttack === 0 ? 1 : finalDamage / rawAttack,
    finalDamage
  };
}

export function activeEquipmentLoadoutFromSnapshot(input: {
  active: EquipmentSlotRecord<EquipmentInstanceV2 | null>;
  readiedWeaponSlot: ReadiedWeaponSlot;
}): ActiveEquipmentLoadout {
  return {
    readiedWeaponSlot: input.readiedWeaponSlot,
    active: Object.fromEntries(EQUIPMENT_SLOTS.map((slot) => {
      const item = input.active[slot];
      return [slot, item
        ? {
            instanceId: item.instanceId,
            definition: requireEquipmentDefinition(item.definitionId),
            itemLevel: item.itemLevel,
            ...(item.condition === undefined ? {} : { condition: item.condition }),
            ...(item.ring ? { ring: item.ring } : {}),
            ...(item.enchantmentIdentity ? { enchantmentIdentity: item.enchantmentIdentity } : {})
          }
        : null];
    })) as EquipmentSlotRecord<EquipmentBalanceItem | null>
  };
}

function requireBalanceVersion(balanceVersion: number): void {
  if (balanceVersion !== EQUIPMENT_BALANCE_VERSION) {
    throw new Error(`Unsupported equipment balance version: ${balanceVersion}`);
  }
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
}

function requireFinite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite`);
  return value;
}

function requirePositiveFiniteMultiplier(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("Combat multiplier must be a positive finite number");
  }
  return value;
}
