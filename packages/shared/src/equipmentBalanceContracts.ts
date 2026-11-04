import type { ArmorCategory, ClassId, WeaponCategory } from "./classes.js";
import type {
  EquipmentCategory,
  EquipmentSlot,
  EquipmentSlotRecord,
  ReadiedWeaponSlot
} from "./equipmentContracts.js";

export const COMBAT_CONTEXTS = [
  "pve",
  "pvp_open_world",
  "pvp_ranked",
  "pvp_training"
] as const;
export type CombatContext = (typeof COMBAT_CONTEXTS)[number];

export const EQUIPMENT_STAT_SCOPES = [
  "universal",
  "pve_only",
  "pvp_only",
  "utility_only"
] as const;
export type EquipmentStatScope = (typeof EQUIPMENT_STAT_SCOPES)[number];

export const EQUIPMENT_UTILITY_KINDS = [
  "none",
  "resource_maximum",
  "resource_generation",
  "action_duration",
  "movement_and_cc",
  "chopping_duration",
  "mining_duration",
  "attack_bonus"
] as const;
export type EquipmentUtilityKind = (typeof EQUIPMENT_UTILITY_KINDS)[number];

export const MOB_CHALLENGE_TIERS = [
  "common",
  "uncommon",
  "rare",
  "epic",
  "legendary"
] as const;
export type MobChallengeTier = (typeof MOB_CHALLENGE_TIERS)[number];

export type EquipmentChallengeProfile = {
  balanceVersion: number;
  currentGearLevel: number;
  unlockedGearLevel: number;
  tier: MobChallengeTier;
  contributors: {
    melee: number;
    chest: number;
    secondary: number;
  };
};

export type EquipmentItemDerivedStats = {
  instanceId: string;
  definitionId: string;
  slot: EquipmentSlot;
  category: EquipmentCategory;
  weaponCategory: WeaponCategory | null;
  armorCategory: ArmorCategory | null;
  twoHanded: boolean;
  itemLevel: number;
  maximumItemLevel: number;
  condition?: number;
  maximumCondition?: number;
  requiredCharacterLevel: number;
  statScope: EquipmentStatScope;
  utilityKind: EquipmentUtilityKind;
  affinityBonus: number;
  effectiveItemLevel: number;
  pveLevelScaling: number;
  pveAttackContribution: number;
  pveDefenseContribution: number;
  pvpLevelContribution: number;
  universalAttackContribution: number;
  universalDefenseContribution: number;
  bypassPveDefense?: boolean;
  resourceMaximumBonus: number;
  resourceGenerationMultiplier: number;
  actionDurationMultiplier: number;
  choppingDurationMultiplier: number;
  miningDurationMultiplier: number;
  movementSpeedMultiplier: number;
  crowdControlDurationMultiplier: number;
  balanceVersion: number;
};

export type EquipmentCombatStats = {
  balanceVersion: number;
  context: CombatContext;
  maximumHealth: number;
  characterLevel: number;
  classId: ClassId;
  classRank: number;
  normalizedClassPower: number;
  readiedWeaponSlot: ReadiedWeaponSlot;
  readiedWeaponCategory: WeaponCategory | null;
  weaponItemLevel: number;
  effectiveWeaponLevel: number;
  weightedArmorLevel: number;
  shieldLevel: number | null;
  shieldGuardBonus: number;
  pvpOffense: number;
  pvpGuard: number;
  pveAttackPower: number;
  pveDefense: number;
  pveWeaponProficiencyMultiplier: number;
  universalAttackPower: number;
  universalDefense: number;
  bypassPveDefense?: boolean;
  weaponAttackPower: Record<ReadiedWeaponSlot, number>;
  weaponCategories: Record<ReadiedWeaponSlot, WeaponCategory | null>;
  resourceMaximumBonus: number;
  resourceGenerationMultiplier: number;
  actionDurationMultiplier: number;
  choppingDurationMultiplier: number;
  miningDurationMultiplier: number;
  movementSpeedMultiplier: number;
  crowdControlDurationMultiplier: number;
  challengeProfile: EquipmentChallengeProfile;
  /**
   * Effective worn-ring bonuses after non-stacking, keyed by bonus id (quarry rows add ":family").
   * Only wired rows appear; values come from rings.ts RING_BONUSES.
   */
  ringBonuses?: Readonly<Record<string, number>>;
  attackIntervalMs: number;
  attackRangeM: number;
  items: EquipmentSlotRecord<EquipmentItemDerivedStats | null>;
};
