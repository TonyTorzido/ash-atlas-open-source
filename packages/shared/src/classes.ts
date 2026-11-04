import {
  type ClassId,
  type ClassResourceDisplayName,
  type ClassResourceId,
  type ClassWeaponMode,
  type SubclassId,
  type PassiveTier,
  type TechniqueDefinition,
  type TechniqueWeaponRequirement,
  type WeaponCategory
} from "./classContracts.js";
import { MELEE_ATTACK_RANGE_M, RANGED_ATTACK_RANGE_M } from "./combatConstants.js";
import { resolvePlayerMaxHealth } from "./progression.js";
import {
  WARRIOR_XP_THRESHOLDS,
  CLASS_XP_THRESHOLDS,
  classRankForXp,
  warriorRankForXp,
  type ProfessionId
} from "./masteries.js";
import {
  DRUID_ACTIVE_DEFINITIONS,
  DRUID_PASSIVE_TIERS,
  KNIGHT_ACTIVE_DEFINITIONS,
  KNIGHT_PASSIVE_TIERS,
  LAUNCH_KIT_ACTIVE_DEFINITIONS,
  LAUNCH_KIT_PASSIVE_DEFINITIONS,
  WARRIOR_V2_ACTIVE_DEFINITIONS,
  WARRIOR_V2_PASSIVE_TIERS,
  WARRIOR_V2_ULTIMATE_DEFINITIONS,
  RANGER_ULTIMATE_DEFINITIONS,
  NINJA_ACTIVE_DEFINITIONS,
  NINJA_PASSIVE_TIERS,
  NINJA_ULTIMATE_DEFINITIONS,
  RANGER_ACTIVE_DEFINITIONS,
  RANGER_PASSIVE_TIERS
} from "./launchClassV1.js";

export { LAUNCH_CLASS_TITLES } from "./launchClassV1.js";

export { CLASS_IDS, SUBCLASS_IDS, WEAPON_CATEGORIES } from "./classContracts.js";
export type {
  ClassId,
  ClassResourceDisplayName,
  ClassResourceId,
  ClassWeaponMode,
  SubclassId,
  PassiveTier,
  TechniqueActivation,
  TechniqueDefinition,
  TechniqueDragTargetKind,
  TechniqueKind,
  TechniqueSupportKind,
  TechniqueTargetType,
  TechniqueWeaponRequirement,
  WeaponCategory
} from "./classContracts.js";

// Keep CLASS_IDS as the durable/historical catalog. Launch-facing selection must
// use this narrower roster so removed and historical class rows continue to deserialize.
export const LAUNCH_CLASS_IDS = ["warrior", "ranger", "ninja", "knight", "druid"] as const satisfies readonly ClassId[];
export type LaunchClassId = (typeof LAUNCH_CLASS_IDS)[number];
export type ClassInnateDefinition = Readonly<{
  id: string;
  classId: ClassId;
  name: string;
  description: string;
}>;

/** Warrior and Ninja innate tuning shared by the descriptions, the combat engine and the stat snapshot. */
export const WARRIOR_INNATE_BALANCE = {
  maxHealthPerLevel: 3,
  maxHealthMaximum: 36,
  damageTierHealthThresholds: [0.7, 0.45, 0.2]
} as const;
export const NINJA_INNATE_BALANCE = { dodgePerLevel: 0.025, dodgeMaximum: 0.28 } as const;
/** Legacy mastery ladders by automatic rank (0 = none yet). */
export const CLASS_MASTERY_ATTACK_BY_RANK = [0, 1, 2, 4] as const;
export const CLASS_MASTERY_DEFENSE_BY_RANK = [0, 2, 3, 4] as const;
export const CLASS_MASTERY_RANGE_BONUS_M_BY_RANK = [0, 25, 40, 55] as const;

export const CLASS_INNATE_DEFINITIONS = {
  warrior: {
    id: "warrior_unrelenting_rage",
    classId: "warrior",
    name: "Unrelenting Rage",
    description: "Gain +3 maximum HP per character level, up to +36, and deal +1, +2, or +3 damage while below 70%, 45%, or 20% HP respectively."
  },
  knight: {
    id: "shield_drill",
    classId: "knight",
    name: "Shield Drill",
    description: "Sword Attack and heavy armor Defense increase with Knight rank; a shield grants extra Defense against ranged attacks."
  },
  ranger: {
    id: "scout_drill",
    classId: "ranger",
    name: "Scout Drill",
    description: "Longbow Attack and range grow with Ranger rank; later ranks add Speed and Leather Defense against melee."
  },
  ninja: {
    id: "ninja_way_of_the_ninja",
    classId: "ninja",
    name: "Way of the Ninja",
    description: "While wearing a Tunic, gain +2.5% Dodge per character level, up to 28%."
  },
  druid: {
    id: "grove_drill",
    classId: "druid",
    name: "Grove Drill",
    description: "Use a Staff without Kestrel training; later ranks increase stored Tactics and grant Dodge without heavy armor or a shield."
  },
} as const satisfies Record<LaunchClassId, ClassInnateDefinition> & Partial<Record<ClassId, ClassInnateDefinition>>;
export const CLASS_SWITCH_REQUIRES_SCROLL = false;
export const CLASS_ABILITY_ACTIVATION_LOCKOUT_MS = 800;
export const ULTIMATE_UNLOCK_RANK = 14;

export function isLaunchClassId(classId: ClassId): classId is LaunchClassId {
  return (LAUNCH_CLASS_IDS as readonly ClassId[]).includes(classId);
}

export const SUBCLASS_CLASS_IDS = {
  reaver: "warrior",
  warden: "warrior",
  sharpshooter: "hunter",
  stalker: "hunter"
} as const satisfies Record<SubclassId, ClassId>;

export const LAUNCH_SUBCLASS_IDS = [] as const satisfies readonly SubclassId[];

export function isLaunchSubclassId(subclassId: SubclassId): boolean {
  void subclassId;
  return false;
}

export function subclassBelongsToClass(subclassId: SubclassId, classId: ClassId): boolean {
  return SUBCLASS_CLASS_IDS[subclassId] === classId;
}

export const DEV_PROGRESSION_TYPES = [
  "character_level", "warrior_level", "druid_level", "ranger_level", "hunter_level", "knight_level", "ninja_level",
  "woodcutter_level", "miner_level", "builder_level", "oil_worker_level", "metallurgy_level"
] as const;
export type DevProgressionType = (typeof DEV_PROGRESSION_TYPES)[number];

export const ARMOR_CATEGORIES = ["light", "medium", "heavy"] as const;
export type ArmorCategory = (typeof ARMOR_CATEGORIES)[number];

export function isSupportTechnique(
  definition: Pick<TechniqueDefinition, "supportKind">
): boolean {
  return definition.supportKind === "healing" || definition.supportKind === "buff";
}

export function isSingleTargetSupportTechnique(
  definition: Pick<TechniqueDefinition, "supportKind" | "targetType">
): boolean {
  return isSupportTechnique(definition) && (
    definition.targetType === "friendly" || definition.targetType === "friendly_or_hostile"
  );
}

export function isHealthOnlyTechnique(
  definition: Pick<TechniqueDefinition, "healthOnly">
): boolean {
  return definition.healthOnly === true;
}

type WarriorTechniqueInput = Omit<
  TechniqueDefinition,
  "classId" | "resourceCost" | "weaponRequirement"
> & { weaponRequirement?: TechniqueWeaponRequirement };
type ResourceTechniqueInput = Omit<
  TechniqueDefinition,
  "classId" | "rageCost" | "weaponRequirement"
> & {
  resourceCost: number;
  weaponRequirement?: TechniqueWeaponRequirement;
};

function technique(definition: WarriorTechniqueInput): TechniqueDefinition {
  return {
    classId: "warrior",
    resourceCost: definition.rageCost,
    ...definition,
    targetType: definition.targetType ?? (definition.kind === "passive" ? "self" : "hostile"),
    weaponRequirement:
      definition.weaponRequirement ??
      defaultTechniqueWeaponRequirement("warrior", definition)
  };
}

function hunterTechnique(
  definition: ResourceTechniqueInput
): TechniqueDefinition {
  return {
    classId: "hunter",
    rageCost: definition.resourceCost,
    ...definition,
    targetType: definition.targetType ?? (definition.kind === "passive" ? "self" : "hostile"),
    weaponRequirement:
      definition.weaponRequirement ??
      defaultTechniqueWeaponRequirement("hunter", definition)
  };
}

const RANGED_TECHNIQUE_IDS = new Set([
  "sharpshooter_deadeye_shot",
  "hunter_volley"
]);
const MELEE_TECHNIQUE_IDS = new Set([
  "stalker_rending_strike",
  "hunter_predators_strike",
  "warrior_empowered_hit",
  "warrior_concussive_blow",
  "reaver_bloodletting_strike",
  "warden_guardians_reprisal"
]);
const SHIELD_TECHNIQUE_IDS = new Set([
  "warden_guardians_reprisal"
]);

function defaultTechniqueWeaponRequirement(
  classId: ClassId,
  definition: Pick<TechniqueDefinition, "id" | "kind" | "targetType">
): TechniqueWeaponRequirement {
  if (
    definition.kind === "passive" ||
    definition.targetType === "self" ||
    definition.targetType === "friendly"
  ) {
    return "any";
  }
  if (SHIELD_TECHNIQUE_IDS.has(definition.id)) return "shield";
  if (RANGED_TECHNIQUE_IDS.has(definition.id)) return "ranged";
  if (MELEE_TECHNIQUE_IDS.has(definition.id)) return "melee";
  return classId === "warrior" ? "melee" : "any";
}

export const WARRIOR_RESET_DEFINITIONS = [] as const satisfies readonly TechniqueDefinition[];

export const WARRIOR_NORMAL_DEFINITIONS = [
  technique({
    id: "warrior_empowered_hit",
    subclassId: null,
    name: "Empowered Hit",
    shortLabel: "Empowered Hit",
    kind: "normal",
    unlockLevel: 1,
    description: "Lose up to 11 HP, never dropping below 1, and empower the next basic attack to deal 123% damage.",
    rageCost: 0,
    cooldownMs: 15_000,
    targetType: "self",
    supportKind: "buff"
  }),
  technique({
    id: "warrior_anger_explosion",
    subclassId: null,
    name: "Anger Explosion",
    shortLabel: "Anger Explosion",
    kind: "normal",
    unlockLevel: 3,
    description: "Lose up to 8 HP, never dropping below 1, and deal 30% basic-attack damage to eligible PvE enemies within 140 meters.",
    rageCost: 0,
    cooldownMs: 20_000,
    targetType: "self"
  }),
  technique({
    id: "warrior_concussive_blow",
    subclassId: null,
    name: "Concussive Blow",
    shortLabel: "Concussive Blow",
    kind: "normal",
    unlockLevel: 8,
    description: "Concuss the focused PvE enemy so its next damaging attack against a player misses.",
    rageCost: 0,
    cooldownMs: 15_000,
    weaponRequirement: "any"
  }),
  technique({
    id: "warrior_battle_cry",
    subclassId: null,
    name: "Battle Cry",
    shortLabel: "Battle Cry",
    kind: "normal",
    unlockLevel: 11,
    description: "You and eligible nearby party members deal 9% more damage for 9 seconds. Multiple Battle Cries do not stack.",
    rageCost: 0,
    cooldownMs: 30_000,
    targetType: "self",
    supportKind: "buff",
    weaponRequirement: "any"
  })
] as const satisfies readonly TechniqueDefinition[];

export const WARRIOR_EMPOWER_ABILITY_IDS = WARRIOR_RESET_DEFINITIONS.map(({ id }) => id);
export const WARRIOR_TECHNIQUE_ABILITY_IDS = WARRIOR_NORMAL_DEFINITIONS.map(({ id }) => id);

export const WARRIOR_PASSIVE_TIERS = {
  0: [
    technique({
      id: "warrior_heavy_handed",
      subclassId: null,
      name: "Heavy Handed",
      shortLabel: "Heavy Handed",
      kind: "passive",
      unlockLevel: 2,
      passiveTier: 0,
      description: "Basic attacks deal +1 flat damage.",
      rageCost: 0,
      cooldownMs: 0
    }),
    technique({
      id: "warrior_bloodthirst",
      subclassId: null,
      name: "Bloodthirst",
      shortLabel: "Bloodthirst",
      kind: "passive",
      unlockLevel: 2,
      passiveTier: 0,
      description: "Defeating an eligible PvE enemy restores exactly 6 HP, up to maximum health.",
      rageCost: 0,
      cooldownMs: 0
    })
  ],
  10: [
    technique({
      id: "warrior_relentless",
      subclassId: null,
      name: "Relentless",
      shortLabel: "Relentless",
      kind: "passive",
      unlockLevel: 7,
      passiveTier: 10,
      description: "Every third basic attack against the same target deals 31% bonus damage.",
      rageCost: 0,
      cooldownMs: 0
    }),
    technique({
      id: "warrior_crowd_fighter",
      subclassId: null,
      name: "Crowd Fighter",
      shortLabel: "Crowd Fighter",
      kind: "passive",
      unlockLevel: 7,
      passiveTier: 10,
      description: "Gain +1 flat Attack and +1 flat Defense while fighting at least two eligible PvE enemies.",
      rageCost: 0,
      cooldownMs: 0
    })
  ],
  20: [
    technique({
      id: "warrior_desperate_fury",
      subclassId: null,
      name: "Desperate Fury",
      shortLabel: "Desperate Fury",
      kind: "passive",
      unlockLevel: 12,
      passiveTier: 20,
      description: "Deal +2 flat damage to enemies below 37% maximum health.",
      rageCost: 0,
      cooldownMs: 0
    }),
    technique({
      id: "warrior_last_stand",
      subclassId: null,
      name: "Last Stand",
      shortLabel: "Last Stand",
      kind: "passive",
      unlockLevel: 12,
      passiveTier: 20,
      description: "Gain +2 flat Defense while below 37% maximum health.",
      rageCost: 0,
      cooldownMs: 0
    })
  ]
} as const satisfies Record<PassiveTier, readonly TechniqueDefinition[]>;

export const WARRIOR_PASSIVE_DEFINITIONS = [
  ...WARRIOR_PASSIVE_TIERS[0],
  ...WARRIOR_PASSIVE_TIERS[10],
  ...WARRIOR_PASSIVE_TIERS[20]
] as const;

export const HUNTER_RESET_DEFINITIONS = [
  hunterTechnique({
    id: "hunter_predators_strike", subclassId: null, name: "Predator's Strike",
    shortLabel: "Predator", kind: "reset", unlockLevel: 5,
    description: "Empowers your next basic attack to deal 117% damage and regain 4 additional Focus after it lands.",
    resourceCost: 20, cooldownMs: 10_000, cooldownGroup: "basic_attack_reset", damageMultiplier: 1.17
  }),
  hunterTechnique({
    id: "hunter_marked_strike", subclassId: null, name: "Marked Strike",
    shortLabel: "Marked", kind: "reset", unlockLevel: 15,
    description: "Empowers your next basic attack to deal 112% damage and apply three owner-scoped Marked Quarry charges.",
    resourceCost: 30, cooldownMs: 10_000, cooldownGroup: "basic_attack_reset", damageMultiplier: 1.12
  }),
  hunterTechnique({
    id: "hunter_cull", subclassId: null, name: "Cull",
    shortLabel: "Cull", kind: "reset", unlockLevel: 25,
    description: "Empowers your next basic attack to deal 112% damage, or 158% below 33% health; a kill refunds 13 Focus.",
    resourceCost: 40, cooldownMs: 10_000, cooldownGroup: "basic_attack_reset", damageMultiplier: 1.12
  })
] as const satisfies readonly TechniqueDefinition[];

export const HUNTER_NORMAL_DEFINITIONS = [
  hunterTechnique({
    id: "hunter_sweep", subclassId: null, name: "Hunter's Sweep",
    shortLabel: "Sweep", kind: "normal", unlockLevel: 8,
    description: "Volley or sweep the focus and deterministic secondary targets in queue order.",
    resourceCost: 25, cooldownMs: 6_000, damageMultiplier: 1
  }),
  hunterTechnique({
    id: "hunter_snare_trap", subclassId: null, name: "Snare Trap",
    shortLabel: "Snare", kind: "normal", unlockLevel: 16,
    description: "Reduce movement by 45% and direct damage by 24% for two enemy opportunities.",
    resourceCost: 30, cooldownMs: 12_000
  })
] as const satisfies readonly TechniqueDefinition[];

export const HUNTER_PASSIVE_TIERS = {
  0: [
    hunterTechnique({ id: "hunter_keen_focus", subclassId: null, name: "Keen Focus", shortLabel: "Keen Focus", kind: "passive", unlockLevel: 0, passiveTier: 0, description: "Basic attacks, including empowered attacks, restore 3 additional Focus.", resourceCost: 0, cooldownMs: 0 }),
    hunterTechnique({ id: "hunter_hardened_leathers", subclassId: null, name: "Hardened Leathers", shortLabel: "Leathers", kind: "passive", unlockLevel: 0, passiveTier: 0, description: "Gain 7% effective defense in light or medium armor.", resourceCost: 0, cooldownMs: 0 })
  ],
  10: [
    hunterTechnique({ id: "hunter_lone_hunter", subclassId: null, name: "Lone Hunter", shortLabel: "Lone", kind: "passive", unlockLevel: 10, passiveTier: 10, description: "Deal 15% more direct damage while exactly one valid enemy remains queued.", resourceCost: 0, cooldownMs: 0 }),
    hunterTechnique({ id: "hunter_pack_hunter", subclassId: null, name: "Pack Hunter", shortLabel: "Pack", kind: "passive", unlockLevel: 10, passiveTier: 10, description: "Deal 3% more direct damage per additional queued enemy, up to 7%.", resourceCost: 0, cooldownMs: 0 })
  ],
  20: [
    hunterTechnique({ id: "hunter_patient_hunter", subclassId: null, name: "Patient Hunter", shortLabel: "Patient", kind: "passive", unlockLevel: 20, passiveTier: 20, description: "Every third qualifying attack against one focus deals 23% more damage.", resourceCost: 0, cooldownMs: 0 }),
    hunterTechnique({ id: "hunter_killer_instinct", subclassId: null, name: "Killer Instinct", shortLabel: "Killer", kind: "passive", unlockLevel: 20, passiveTier: 20, description: "Below 30% target health, gain 13% direct damage and 23% discrete Focus generation.", resourceCost: 0, cooldownMs: 0 })
  ]
} as const satisfies Record<PassiveTier, readonly TechniqueDefinition[]>;

export const HUNTER_PASSIVE_DEFINITIONS = [
  ...HUNTER_PASSIVE_TIERS[0], ...HUNTER_PASSIVE_TIERS[10], ...HUNTER_PASSIVE_TIERS[20]
] as const;

export const SKILL_SYSTEM_V3_CLASS_TECHNIQUE_DEFINITIONS = [
  { id: "v3_warrior_anger_explosion", classId: "warrior", subclassId: null, name: "Anger Explosion", shortLabel: "Explosion", kind: "normal", unlockLevel: 0, description: "Lose 10 HP and deal 10 damage to hostile mobs within 300m.", rageCost: 0, resourceCost: 0, cooldownMs: 90_000, targetType: "self", weaponRequirement: "any", activation: "instant" },
  { id: "v3_warrior_is_that_it", classId: "warrior", subclassId: null, name: "Is That It?", shortLabel: "Is That It?", kind: "normal", unlockLevel: 0, description: "Reduce final incoming damage by 50% for 5 seconds.", rageCost: 0, resourceCost: 0, cooldownMs: 90_000, targetType: "self", supportKind: "buff", weaponRequirement: "any", activation: "instant" },
  { id: "v3_ranger_double_tap", classId: "ranger", subclassId: null, name: "Double-tap", shortLabel: "Double-tap", kind: "normal", unlockLevel: 0, description: "Queue two independent hits for the next Longbow or Crossbow shot.", rageCost: 0, resourceCost: 0, cooldownMs: 75_000, targetType: "self", supportKind: "buff", weaponRequirement: "ranged", activation: "armed" },
  { id: "v3_ranger_explosive_arrow", classId: "ranger", subclassId: null, name: "Explosive Arrow", shortLabel: "Explosive", kind: "normal", unlockLevel: 0, description: "Queue a shot that splashes 5 damage within 300m.", rageCost: 0, resourceCost: 0, cooldownMs: 60_000, targetType: "self", supportKind: "buff", weaponRequirement: "ranged", activation: "armed" },
  { id: "v3_ninja_shadow_mark", classId: "ninja", subclassId: null, name: "Shadow Mark", shortLabel: "Mark", kind: "normal", unlockLevel: 0, description: "Echo 20% of this Ninja's damage after 5 seconds.", rageCost: 0, resourceCost: 0, cooldownMs: 60_000, targetType: "hostile", weaponRequirement: "any", activation: "instant" },
  { id: "v3_ninja_parkour", classId: "ninja", subclassId: null, name: "Parkour", shortLabel: "Parkour", kind: "normal", unlockLevel: 0, description: "Relocate up to 500m in the current location.", rageCost: 0, resourceCost: 0, cooldownMs: 90_000, targetType: "self", weaponRequirement: "any", activation: "drag", dragTargetKind: "position", targetRangeM: 500 }
] as const satisfies readonly TechniqueDefinition[];

/** The one current class action is unlocked by Druid Rank 1, without a technique slot. */
export const DRUID_REPLENISH_DEFINITION = {
  id: "v3_druid_replenish", classId: "druid", subclassId: null,
  name: "Replenish", shortLabel: "Replenish", kind: "normal", unlockLevel: 0,
  description: "Spend five Giving Berries and transfer your health to a nearby injured ally, stopping at 1 HP.",
  rageCost: 0, resourceCost: 0, cooldownMs: 0, targetType: "friendly",
  supportKind: "healing", healthOnly: true, weaponRequirement: "any",
  activation: "instant", targetRangeM: MELEE_ATTACK_RANGE_M
} as const satisfies TechniqueDefinition;

export const SUBCLASS_RESET_DEFINITIONS = {
  reaver: technique({
    id: "reaver_bloodletting_strike",
    subclassId: "reaver",
    name: "Bloodletting Strike",
    shortLabel: "Bloodletting",
    kind: "reset",
    unlockLevel: 25,
    description: "Empowers your next basic attack to deal 113% damage and apply a three-turn Bleed; heal 2% maximum health if the target was already bleeding.",
    rageCost: 30,
    cooldownMs: 10_000,
    cooldownGroup: "basic_attack_reset",
    damageMultiplier: 1.13
  }),
  warden: technique({
    id: "warden_guardians_reprisal",
    subclassId: "warden",
    name: "Guardian's Reprisal",
    shortLabel: "Reprisal",
    kind: "reset",
    unlockLevel: 25,
    description: "Empowers your next basic attack to deal 112% damage, gain 21 Guard, and reduce the next valid enemy queue attack by 24%.",
    rageCost: 25,
    cooldownMs: 10_000,
    cooldownGroup: "basic_attack_reset",
    damageMultiplier: 1.12
  }),
  sharpshooter: hunterTechnique({
    id: "sharpshooter_deadeye_shot", subclassId: "sharpshooter", name: "Deadeye Shot",
    shortLabel: "Deadeye", kind: "reset", unlockLevel: 25,
    description: "Empowers your next ranged basic attack to deal 127% damage, or 158% at 75 meters or farther.",
    resourceCost: 35, cooldownMs: 10_000, cooldownGroup: "basic_attack_reset", damageMultiplier: 1.27
  }),
  stalker: hunterTechnique({
    id: "stalker_rending_strike", subclassId: "stalker", name: "Rending Strike",
    shortLabel: "Rending", kind: "reset", unlockLevel: 25,
    description: "Empowers your next melee basic attack to deal 118% damage and apply a three-turn deterministic Bleed.",
    resourceCost: 30, cooldownMs: 10_000, cooldownGroup: "basic_attack_reset", damageMultiplier: 1.18
  })
} as const satisfies Record<SubclassId, TechniqueDefinition>;

export const ALL_TECHNIQUE_DEFINITIONS = [
  DRUID_REPLENISH_DEFINITION,
  ...SKILL_SYSTEM_V3_CLASS_TECHNIQUE_DEFINITIONS,
  ...WARRIOR_RESET_DEFINITIONS,
  ...WARRIOR_NORMAL_DEFINITIONS,
  ...WARRIOR_PASSIVE_DEFINITIONS,
  ...WARRIOR_V2_ACTIVE_DEFINITIONS,
  ...Object.values(WARRIOR_V2_PASSIVE_TIERS).flat(),
  ...WARRIOR_V2_ULTIMATE_DEFINITIONS,
  ...LAUNCH_KIT_ACTIVE_DEFINITIONS,
  ...LAUNCH_KIT_PASSIVE_DEFINITIONS,
  ...HUNTER_RESET_DEFINITIONS,
  ...HUNTER_NORMAL_DEFINITIONS,
  ...HUNTER_PASSIVE_DEFINITIONS,
  SUBCLASS_RESET_DEFINITIONS.reaver,
  SUBCLASS_RESET_DEFINITIONS.warden,
  SUBCLASS_RESET_DEFINITIONS.sharpshooter,
  SUBCLASS_RESET_DEFINITIONS.stalker
] as const;

export const TECHNIQUE_BY_ID = Object.freeze(Object.fromEntries(
  ALL_TECHNIQUE_DEFINITIONS.map((definition) => [definition.id, definition])
)) as Readonly<Record<string, TechniqueDefinition>>;

export const LAUNCH_ACTIVE_ABILITY_IDS = {
  warrior: [], ranger: [], ninja: [], knight: [], druid: []
} as const satisfies Record<LaunchClassId, readonly string[]>;

const LAUNCH_TECHNIQUE_ID_SET = new Set<string>([
  ...Object.values(LAUNCH_ACTIVE_ABILITY_IDS).flat(),
  ...Object.values(WARRIOR_V2_PASSIVE_TIERS).flat().map((definition) => definition.id),
  ...LAUNCH_KIT_PASSIVE_DEFINITIONS
    .filter((definition) => isLaunchClassId(definition.classId))
    .map((definition) => definition.id)
]);

export function isLaunchTechniqueId(techniqueId: string): boolean {
  return LAUNCH_TECHNIQUE_ID_SET.has(techniqueId);
}

// Transitional aliases keep downstream imports compiling while exposing only the simplified catalog.
export const WARRIOR_ACTIVE_DEFINITIONS = [...WARRIOR_RESET_DEFINITIONS, ...WARRIOR_NORMAL_DEFINITIONS] as const;
export const REAVER_TECHNIQUE_DEFINITIONS = [SUBCLASS_RESET_DEFINITIONS.reaver] as const;
export const WARDEN_TECHNIQUE_DEFINITIONS = [SUBCLASS_RESET_DEFINITIONS.warden] as const;

export type GuaranteedTraitDefinition = {
  id: string;
  name: string;
  levels: readonly number[];
  description: string;
};

export const WARRIOR_GUARANTEED_TRAITS = [
  { id: "warrior_battle_hardened", name: "Battle Hardened", levels: [1], description: "Warrior class-skill HP costs cannot reduce health below 1." },
  { id: "warrior_double_axe_mastery", name: "Axe Mastery", levels: [5, 9, 13], description: "Gain +1, +2, then +4 flat Attack while the active weapon belongs to the Axe family." },
  { id: "warrior_breast_plate_mastery", name: "Breastplate Mastery", levels: [6, 10, 14], description: "Gain +2, +3, then +4 flat Defense while wearing the Breastplate family." }
] as const satisfies readonly GuaranteedTraitDefinition[];

export const SUBCLASS_GUARANTEED_TRAITS = {
  reaver: { id: "reaver_bloodlust", name: "Bloodlust", description: "Defeating bleeding enemies restores 4% maximum health and 16 Rage within per-action caps." },
  warden: { id: "warden_guardians_resolve", name: "Guardian's Resolve", description: "Authoritative actions build Guard, granting up to 13% deterministic mitigation." },
  sharpshooter: { id: "sharpshooter_steady_hand", name: "Steady Hand", description: "Consecutive ranged attacks against one focus build up to five deterministic 4% damage stacks." },
  stalker: { id: "stalker_blood_scent", name: "Blood Scent", description: "Direct attacks against a bleeding focus deal 11% more damage and basic attacks, including empowered attacks, restore 4 Focus." }
} as const satisfies Record<SubclassId, { id: string; name: string; description: string }>;

export const HUNTER_GUARANTEED_TRAITS = [
  { id: "hunter_drill", name: "Tracker Drill", levels: [0], description: "Enables Hunter combat, Focus, weapon-mode adaptation, and light or medium armor." },
  { id: "hunter_survival_instinct", name: "Survival Instinct", levels: [1, 6, 11, 16, 21], description: "Increases maximum health by 3% per rank, up to 15%." },
  { id: "hunter_weaponry", name: "Hunter Weaponry", levels: [2, 7, 12, 17, 22], description: "Increases Hunter basic-attack damage, including empowered attacks, by 1% per rank, up to 5%." },
  { id: "hunter_focus_control", name: "Focus Control", levels: [3, 8, 13, 18, 23], description: "Improves deterministic Focus regeneration in and out of combat." },
  { id: "hunter_quarry_sense", name: "Quarry Sense", levels: [4, 9, 14, 19, 24], description: "Increases direct damage to the authoritative focus by 3% per rank, up to 15%." },
  { id: "hunter_trailblazer", name: "Trailblazer", levels: [5, 10, 15, 20, 25], description: "Adds 1% movement speed and reduces hostile slows by 4% per rank." }
] as const satisfies readonly GuaranteedTraitDefinition[];

export const WARRIOR_SLOT_MILESTONES = {
  reset: [],
  normal: [1, 4],
  passiveTier: [2, 7, 12],
  ultimate: [14]
} as const;

/** @deprecated Use WARRIOR_SLOT_MILESTONES. */
export const CHARACTER_SLOT_MILESTONES = {
  basicAttack: 0,
  classResource: 0,
  basePassive: WARRIOR_SLOT_MILESTONES.passiveTier,
  baseActive: WARRIOR_SLOT_MILESTONES.normal,
  subclassActive: 25
} as const;

export const WARRIOR_LEVEL_XP: readonly number[] = WARRIOR_XP_THRESHOLDS;
const RETAINED_FUTURE_CLASS_LEVEL_XP = [
  0, 100, 300, 700, 1_200, 1_800, 2_500, 3_300, 4_200, 5_200, 6_300,
  7_500, 8_800, 10_200, 11_700, 13_300, 15_000, 16_800, 18_700, 20_700,
  22_800, 25_000, 27_500, 30_500, 34_000, 38_000
] as const;
export const HUNTER_LEVEL_XP = RETAINED_FUTURE_CLASS_LEVEL_XP;
export const CLASS_LEVEL_XP = RETAINED_FUTURE_CLASS_LEVEL_XP;

/** @deprecated Use WARRIOR_LEVEL_XP. */
export const WARRIOR_MASTERY_XP = WARRIOR_LEVEL_XP;
/** Historical subclass data remains persisted but does not gate simplified abilities. */
export const SUBCLASS_MASTERY_XP = [0, 700, 1_600, 2_800, 4_300, 6_100, 8_200, 10_600, 13_300, 16_500] as const;

export const WARRIOR_BALANCE = {
  version: 5,
  sharedResetCooldownMs: 0,
  rage: {
    maximum: 100,
    basicAttack: 0,
    receivedDirectDamage: 0,
    enemyDefeat: 0,
    multiTarget: 0,
    multiTargetMinimum: 3,
    decayDelayMs: 8_000,
    decayPerSecond: 0,
    weakEnemyLevelGap: 9
  },
  empoweredHitHealthCost: 11,
  empoweredHitMultiplier: 1.23,
  angerExplosionHealthCost: 8,
  angerExplosionMultiplier: 0.3,
  angerExplosionRadiusM: 140,
  battleCryDamageMultiplier: 1.09,
  battleCryDurationMs: 9_000,
  battleCryRadiusM: 110,
  bloodthirstHealing: 6,
  lowHealthThreshold: 0.37,
  hardenedBodyMaxHealthPerRank: 0,
  historicalHardenedBodyMaxHealthPerRank: 0.01,
  armorConditioningPerRank: 0.01,
  rageControl: [
    { decayPerSecond: 5.3, basicOrResetBonus: 0, basicAttackBonus: 0, retentionFloor: 0 },
    { decayPerSecond: 5, basicOrResetBonus: 0, basicAttackBonus: 0, retentionFloor: 0 },
    { decayPerSecond: 4.2, basicOrResetBonus: 2, basicAttackBonus: 2, retentionFloor: 0 },
    { decayPerSecond: 4, basicOrResetBonus: 2, basicAttackBonus: 2, retentionFloor: 0 },
    { decayPerSecond: 3, basicOrResetBonus: 3, basicAttackBonus: 3, retentionFloor: 0 }
  ],
  martialTrainingPerRank: 0.01,
  queueDisciplineCaps: [0.025, 0.045, 0.065, 0.085, 0.11],
  punishingStrikeAdditionalRage: 6,
  sunderingStrikeDefenseReduction: 0.09,
  sunderingStrikePlayerActions: 3,
  executionThreshold: 0.26,
  executionDamageMultiplier: 1.6,
  executionKillRageRefund: 16,
  cleaveSecondaryMultiplier: 0.73,
  cleaveMaximumSecondaryTargets: 3,
  fortifyMitigation: 0.23,
  fortifyMaximumProtectedAttacks: Number.MAX_SAFE_INTEGER,
  ragebornAdditionalRage: 3,
  ironhideDefenseMultiplier: 1.09,
  crowdBreakerPerAdditionalEnemy: 0.01,
  crowdBreakerMaximum: 0.09,
  bloodPriceCurrentHealthCost: 0.04,
  bloodPriceDamageMultiplier: 1.24,
  relentlessActionCount: 3,
  relentlessDamageMultiplier: 1.31,
  lastStandHealthThreshold: 0.4,
  lastStandDefenseMultiplier: 1.14,
  lastStandRageMultiplier: 1.19,
  bleedDamagePerTick: 4,
  bleedBaseTicks: 3,
  bloodlettingAlreadyBleedingHeal: 0.02,
  bloodlustKillHeal: 0.04,
  bloodlustKillRage: 16,
  bloodlustActionHealCap: 0.12,
  bloodlustActionRageCap: 32,
  guardMaximum: 100,
  guardIncomingAttack: 9,
  guardFortify: 13,
  guardReprisal: 21,
  guardMitigationPerPoint: 0.0013,
  guardMitigationMaximum: 0.13,
  guardPostCombatDecayPerSecond: 8,
  reprisalNextAttackMitigation: 0.24,
  legacyMaxHealthMultiplier: 1,
  historicalLegacyMaxHealthMultiplier: 1.02,
  // Compatibility-only keys for combat code being reconciled to the simplified model.
  battleRecovery: [
    { delayMs: 8_000, healthPercent: 0 },
    { delayMs: 8_000, healthPercent: 0 }
  ],
  armorReductionPerStack: 3,
  armorReductionMaxStacks: 4,
  guardDefenseMaximum: 12,
  unshakenMultiplier: 1
} as const;

export const HUNTER_BALANCE = {
  version: 1,
  focus: {
    maximum: 100,
    initial: 100,
    inCombatPerSecond: 4,
    outOfCombatPerSecond: 11,
    basicOrReset: 3,
    enemyDefeat: 9,
    predatorBonus: 4,
    cullRefund: 13,
    keenFocusBonus: 3,
    bloodScentBonus: 4
  },
  focusControl: [
    { inCombatBonus: 0.55, outOfCombatBonus: 1.2 },
    { inCombatBonus: 1.1, outOfCombatBonus: 2.3 },
    { inCombatBonus: 1.6, outOfCombatBonus: 3.4 },
    { inCombatBonus: 2.2, outOfCombatBonus: 4.5 },
    { inCombatBonus: 2.7, outOfCombatBonus: 5.6 }
  ],
  meleeRangeM: MELEE_ATTACK_RANGE_M,
  rangedRangeM: RANGED_ATTACK_RANGE_M,
  survivalInstinctMaxHealthPerRank: 0.03,
  hunterWeaponryPerRank: 0.01,
  quarrySensePerRank: 0.03,
  trailblazerMovementPerRank: 0.01,
  trailblazerSlowReductionPerRank: 0.04,
  markedQuarryDamageMultiplier: 1.09,
  markedQuarryCharges: 3,
  cullThreshold: 0.33,
  cullDamageMultiplier: 1.58,
  sweepRangedSecondaryMultiplier: 0.37,
  sweepRangedMaximumSecondaryTargets: 4,
  sweepMeleeSecondaryMultiplier: 0.53,
  sweepMeleeMaximumSecondaryTargets: 3,
  snareCharges: 2,
  snareMovementMultiplier: 0.55,
  snareDamageMultiplier: 0.76,
  loneHunterDamageMultiplier: 1.15,
  packHunterPerAdditionalEnemy: 0.03,
  packHunterMaximum: 0.07,
  patientHunterActionCount: 3,
  patientHunterDamageMultiplier: 1.23,
  killerInstinctThreshold: 0.3,
  killerInstinctDamageMultiplier: 1.13,
  killerInstinctResourceMultiplier: 1.23,
  deadeyeLongRangeM: 75,
  deadeyeLongRangeMultiplier: 1.58,
  steadyHandPerStack: 0.04,
  steadyHandMaximumStacks: 5,
  rendingBleedDirectDamageMultiplier: 0.18,
  rendingBleedTicks: 3,
  bloodScentDamageMultiplier: 1.11
} as const;

export type HunterWeaponMode = ClassWeaponMode;
export type ClassResourceView = {
  classId: ClassId;
  resourceId: ClassResourceId;
  displayName: ClassResourceDisplayName;
  current: number;
  maximum: number;
  reserved: number;
  updatedAt: string;
};

export type ClassProgressView = {
  classId: ClassId;
  level: number;
  xp: number;
  nextLevelXp: number | null;
  completedAt: string | null;
};

export type SubclassProgressView = {
  classId?: ClassId;
  subclassId: SubclassId;
  unlocked: boolean;
};

export type ClassLoadoutView = {
  resetActives: readonly (string | null)[];
  normalActives: readonly (string | null)[];
  passiveTiers: readonly (string | null)[];
  ultimateActive: string | null;
};

export type WarriorActiveLoadoutView = {
  equippedEmpowerAbilityId: string | null;
  equippedTechniqueAbilityId: string | null;
};

export function warriorActiveLoadout(loadout: ClassLoadoutView): WarriorActiveLoadoutView {
  const techniqueIds = new Set<string>(WARRIOR_TECHNIQUE_ABILITY_IDS);
  const skills = loadout.normalActives.filter(
    (id): id is string => id !== null && techniqueIds.has(id)
  );
  return {
    equippedEmpowerAbilityId: skills[0] ?? null,
    equippedTechniqueAbilityId: skills[1] ?? null
  };
}

export function withWarriorActiveLoadout(
  loadout: ClassLoadoutView,
  active: WarriorActiveLoadoutView
): ClassLoadoutView {
  return {
    resetActives: [null, null],
    normalActives: [active.equippedEmpowerAbilityId, active.equippedTechniqueAbilityId],
    passiveTiers: [...loadout.passiveTiers],
    ultimateActive: loadout.ultimateActive
  };
}

export type QueuedAbilityView = {
  abilityId: string;
  targetEntityId: string | null;
  reservedRage: number;
  reservedResource: number;
  queuedAtTick: number;
};

export type ClassLegacyDefinition = {
  id: string;
  classId: ClassId;
  name: string;
  description: string;
  requiredClassLevel: 25;
  requiredSubclassIds: readonly SubclassId[];
};

export type ClassEquipmentAffinitySnapshot = {
  balanceVersion: number;
  classId: ClassId;
  classDisplayName: string;
  preferredMeleeWeaponCategories: readonly WeaponCategory[];
  preferredArmorCategories: readonly ArmorCategory[];
  effectiveLevelBonus: number;
};

export type ClassSnapshot = {
  playerId: string;
  characterLevel: number;
  activeClassId: ClassId;
  unlockedClassIds?: LaunchClassId[];
  activeSubclassId: SubclassId | null;
  /** Optional only so retained pre-equipment snapshots remain deserializable. */
  equipmentAffinity?: ClassEquipmentAffinitySnapshot | null;
  warrior: ClassProgressView;
  druid?: ClassProgressView;
  ranger?: ClassProgressView;
  hunter?: ClassProgressView;
  knight?: ClassProgressView;
  ninja?: ClassProgressView;
  classes?: ClassProgressView[];
  subclasses: SubclassProgressView[];
  selectedSubclasses?: Partial<Record<ClassId, SubclassId | null>>;
  loadout: ClassLoadoutView;
  resource?: ClassResourceView;
  resources?: ClassResourceView[];
  weaponMode?: ClassWeaponMode | null;
  legacyIds: string[];
  rage: number;
  maximumRage: number;
  queuedAbility: QueuedAbilityView | null;
  cooldownEndsAt: Record<string, number>;
  serverTime: number;
  revision: number;
  professionRanks?: Record<ProfessionId, number>;
};

export function warriorLevelForXp(xp: number): number {
  return warriorRankForXp(xp);
}
export function classLevelForXp(xp: number, classId: ClassId = "warrior"): number {
  if (isLaunchClassId(classId)) return classRankForXp(xp);
  const normalized = Math.max(0, Math.trunc(xp));
  for (let level = RETAINED_FUTURE_CLASS_LEVEL_XP.length - 1; level >= 0; level -= 1) {
    if (normalized >= RETAINED_FUTURE_CLASS_LEVEL_XP[level]!) return level;
  }
  return 0;
}
export const hunterLevelForXp = (xp: number) => classLevelForXp(xp, "hunter");

export const CLASS_SLOT_MILESTONES = WARRIOR_SLOT_MILESTONES;

function launchMasteryTraits(className: string, weaponName: string, armorName: string): readonly GuaranteedTraitDefinition[] {
  const slug = className.toLowerCase();
  return [
    { id: `${slug}_weapon_mastery`, name: `${weaponName} Mastery`, levels: [5, 9, 13], description: `Gain +1, +2, then +4 flat Attack while using ${weaponName}-family equipment.` },
    { id: `${slug}_armor_mastery`, name: `${armorName} Mastery`, levels: [6, 10, 14], description: `Gain +2, +3, then +4 flat Defense while wearing ${armorName}-family equipment.` }
  ];
}

export const NINJA_GUARANTEED_TRAITS = [
  {
    id: "ninja_close_quarters_shuriken",
    name: "Close-Quarters Shuriken",
    levels: [1],
    description: "Shuriken remain usable and readied in melee range; the Ninja does not automatically switch to a melee weapon."
  },
  launchMasteryTraits("Ninja", "Shuriken", "Cloth/Tunic")[0]!
] as const satisfies readonly GuaranteedTraitDefinition[];

export const CLASS_DEFINITIONS = {
  warrior: {
    classId: "warrior",
    name: "Warrior",
    resourceId: "none",
    resourceDisplayName: "None",
    initialResource: 0,
    innate: CLASS_INNATE_DEFINITIONS.warrior,
    resets: WARRIOR_RESET_DEFINITIONS,
    normals: WARRIOR_V2_ACTIVE_DEFINITIONS,
    ultimates: WARRIOR_V2_ULTIMATE_DEFINITIONS,
    passiveTiers: WARRIOR_V2_PASSIVE_TIERS,
    guaranteedTraits: WARRIOR_GUARANTEED_TRAITS,
    subclasses: []
  },
  druid: {
    classId: "druid", name: "Druid", resourceId: "none", resourceDisplayName: "None", initialResource: 0,
    innate: CLASS_INNATE_DEFINITIONS.druid,
    resets: [], normals: DRUID_ACTIVE_DEFINITIONS, ultimates: [], passiveTiers: DRUID_PASSIVE_TIERS,
    guaranteedTraits: launchMasteryTraits("Druid", "Staff", "Leather Armor"), subclasses: []
  },
  ranger: {
    classId: "ranger", name: "Ranger", resourceId: "none", resourceDisplayName: "None", initialResource: 0,
    innate: CLASS_INNATE_DEFINITIONS.ranger,
    resets: [], normals: RANGER_ACTIVE_DEFINITIONS, ultimates: RANGER_ULTIMATE_DEFINITIONS, passiveTiers: RANGER_PASSIVE_TIERS,
    guaranteedTraits: [
      { ...launchMasteryTraits("Ranger", "Bow", "Leather Armor")[0]!, description: "Gain +1, +2, then +4 flat Attack and +25, +40, then +55 meters range while using Bow-family equipment." },
      launchMasteryTraits("Ranger", "Bow", "Leather Armor")[1]!
    ], subclasses: []
  },
  knight: {
    classId: "knight", name: "Knight", resourceId: "none", resourceDisplayName: "None", initialResource: 0,
    innate: CLASS_INNATE_DEFINITIONS.knight,
    resets: [], normals: KNIGHT_ACTIVE_DEFINITIONS, ultimates: [], passiveTiers: KNIGHT_PASSIVE_TIERS,
    guaranteedTraits: launchMasteryTraits("Knight", "Sword", "Breastplate"), subclasses: []
  },
  ninja: {
    classId: "ninja",
    name: "Ninja",
    resourceId: "none",
    resourceDisplayName: "None",
    initialResource: 0,
    innate: CLASS_INNATE_DEFINITIONS.ninja,
    resets: [],
    normals: NINJA_ACTIVE_DEFINITIONS,
    ultimates: NINJA_ULTIMATE_DEFINITIONS,
    passiveTiers: NINJA_PASSIVE_TIERS,
    guaranteedTraits: NINJA_GUARANTEED_TRAITS,
    subclasses: []
  },
  hunter: {
    classId: "hunter", name: "Hunter (Legacy)", resourceId: "focus", resourceDisplayName: "Focus",
    initialResource: HUNTER_BALANCE.focus.initial, resets: HUNTER_RESET_DEFINITIONS,
    normals: HUNTER_NORMAL_DEFINITIONS, passiveTiers: HUNTER_PASSIVE_TIERS,
    guaranteedTraits: HUNTER_GUARANTEED_TRAITS, subclasses: ["sharpshooter", "stalker"]
  }
} as const;

export function classDefinition(classId: ClassId) {
  return CLASS_DEFINITIONS[classId];
}

export function classResourceId(classId: ClassId): ClassResourceId {
  return CLASS_DEFINITIONS[classId].resourceId;
}

export function classResourceDisplayName(classId: ClassId): ClassResourceDisplayName {
  return CLASS_DEFINITIONS[classId].resourceDisplayName;
}

export function classInitialResource(classId: ClassId): number {
  return CLASS_DEFINITIONS[classId].initialResource;
}

export function classLevelXp(classId: ClassId): readonly number[] {
  return isLaunchClassId(classId) ? CLASS_XP_THRESHOLDS : RETAINED_FUTURE_CLASS_LEVEL_XP;
}

export function classSubclasses(classId: ClassId): readonly SubclassId[] {
  return CLASS_DEFINITIONS[classId].subclasses as readonly SubclassId[];
}

export function classProgress(snapshot: ClassSnapshot, classId: ClassId): ClassProgressView | undefined {
  const listed = snapshot.classes?.find((entry) => entry.classId === classId);
  if (listed) return listed;
  if (classId === "warrior") return snapshot.warrior;
  return snapshot[classId];
}

/** Historical helper retained for inert subclass mastery records. */
export function rankForMasteryXp(xp: number, thresholds: readonly number[]): number {
  const normalized = Math.max(0, Math.trunc(xp));
  for (let index = thresholds.length - 1; index >= 0; index -= 1) {
    if (normalized >= (thresholds[index] ?? 0)) return index + 1;
  }
  return 1;
}

/** @deprecated Training Points are not part of simplified Warrior progression. */
export function trainingPointsThroughRank(_rank: number, _subclass = false): number {
  void _rank;
  void _subclass;
  return 0;
}

export function unlockedResetSlots(warriorLevel: number): number {
  return WARRIOR_SLOT_MILESTONES.reset.filter((level) => warriorLevel >= level).length;
}

export function unlockedNormalSlots(warriorLevel: number): number {
  return WARRIOR_SLOT_MILESTONES.normal.filter((level) => warriorLevel >= level).length;
}

export function unlockedPassiveTierSlots(warriorLevel: number): number {
  return WARRIOR_SLOT_MILESTONES.passiveTier.filter((level) => warriorLevel >= level).length;
}

export function unlockedUltimateSlots(classLevel: number): number {
  return classLevel >= ULTIMATE_UNLOCK_RANK ? 1 : 0;
}

/** @deprecated Slots now use Warrior Rank. */
export const unlockedBaseActiveSlots = unlockedNormalSlots;
/** @deprecated Slots now use Warrior Rank. */
export const unlockedBasePassiveSlots = unlockedPassiveTierSlots;
/** @deprecated Simplified subclasses have no mastery-gated passive slots. */
export function unlockedSubclassPassiveSlots(_subclassMastery: number): number {
  void _subclassMastery;
  return 0;
}

export function requireTechniqueDefinition(id: string): TechniqueDefinition {
  const definition = TECHNIQUE_BY_ID[id];
  if (!definition) throw new Error(`Unknown class technique: ${id}`);
  return definition;
}

export function automaticTraitRank(warriorLevel: number, unlockLevels: readonly number[]): number {
  return unlockLevels.filter((level) => warriorLevel >= level).length;
}

export function availableTechniqueIds(input: Pick<ClassSnapshot, "warrior" | "subclasses"> &
  Partial<Pick<ClassSnapshot, "activeClassId" | "druid" | "ranger" | "hunter" | "knight" | "ninja" | "classes">>): string[] {
  const activeClassId = input.activeClassId ?? "warrior";
  if (isLaunchClassId(activeClassId)) return [];
  const listed = input.classes?.find((entry) => entry.classId === activeClassId);
  const direct = input[activeClassId];
  const level = listed?.level ?? direct?.level ?? 0;
  const unlockedSubclasses = new Set(input.subclasses
    .filter((entry) => entry.unlocked && subclassBelongsToClass(entry.subclassId, activeClassId))
    .map((entry) => entry.subclassId));
  return ALL_TECHNIQUE_DEFINITIONS
    .filter((definition) => definition.classId === activeClassId)
    .filter((definition) => definition.subclassId
      ? level >= 25 && unlockedSubclasses.has(definition.subclassId)
      : level >= definition.unlockLevel)
    .map((definition) => definition.id);
}

export function hunterWeaponMode(category: WeaponCategory | null): HunterWeaponMode | null {
  if (category === "bow" || category === "crossbow") return "ranged";
  if (category === "sword" || category === "dagger" || category === "spear") return "melee";
  return null;
}

export function classWeaponMode(classId: ClassId, category: WeaponCategory | null): ClassWeaponMode | null {
  if (classId === "ranger") return category === "bow" || category === "crossbow" || category === "sling" ? "ranged" : category === null ? null : "melee";
  if (classId === "ninja") return category === "shuriken" ? "ranged" : category === null ? null : "melee";
  if (classId === "druid") return category === "staff" ? "ranged" : category === null ? null : "melee";
  if (classId === "hunter") return hunterWeaponMode(category);
  return null;
}

export function classEquipmentCompatibility(input: {
  classId: ClassId;
  subclassId: SubclassId | null;
  weaponCategory: WeaponCategory | null;
  armorCategory: ArmorCategory | null;
}): { compatible: true; weaponMode: ClassWeaponMode | null } | { compatible: false; code: string; message: string } {
  if (input.subclassId !== null && !subclassBelongsToClass(input.subclassId, input.classId)) {
    return { compatible: false, code: "SUBCLASS_CLASS_INVALID", message: "Subclass does not belong to the selected class" };
  }
  if (isLaunchClassId(input.classId)) {
    return { compatible: true, weaponMode: classWeaponMode(input.classId, input.weaponCategory) };
  }
  if (input.armorCategory === "heavy") {
    return { compatible: false, code: "CLASS_ARMOR_INCOMPATIBLE", message: "Hunter cannot use heavy armor" };
  }
  const weaponMode = hunterWeaponMode(input.weaponCategory);
  if (input.weaponCategory !== null && weaponMode === null) {
    return { compatible: false, code: "CLASS_WEAPON_INCOMPATIBLE", message: "That weapon is not compatible with Hunter" };
  }
  if (input.subclassId === "sharpshooter" && weaponMode !== "ranged") {
    return { compatible: false, code: "SUBCLASS_WEAPON_REQUIRED", message: "Sharpshooter requires a bow or crossbow" };
  }
  if (input.subclassId === "stalker" && weaponMode !== "melee") {
    return { compatible: false, code: "SUBCLASS_WEAPON_REQUIRED", message: "Stalker requires a sword, dagger, or spear" };
  }
  return { compatible: true, weaponMode };
}

export function warriorStatModifiers(input: {
  warriorLevel: number;
  activeClassId: ClassId;
  armorCategory: ArmorCategory | null;
  hasLegacy: boolean;
}): { maxHealthMultiplier: number; armorDefenseMultiplier: number } {
  void input;
  return {
    maxHealthMultiplier: 1,
    armorDefenseMultiplier: 1
  };
}

export function applyClassCombatStats(
  base: { maxHealth: number; attackPower: number; defense: number; attackIntervalMs: number; attackRangeM: number },
  snapshot: ClassSnapshot,
  equipment: {
    totalDefenseBonus: number;
    weapon: { weaponCategory: WeaponCategory | null; defenseBonus?: number } | null;
    chest: { armorCategory: ArmorCategory | null; defenseBonus?: number } | null;
  }
): typeof base {
  const hasWarriorLegacy = snapshot.legacyIds.includes("warrior_legacy_iron_constitution");
  if (snapshot.activeClassId === "hunter") {
    const mode = hunterWeaponMode(equipment.weapon?.weaponCategory ?? null);
    const hardenedLeathers = snapshot.loadout.passiveTiers.includes("hunter_hardened_leathers") &&
      (equipment.chest?.armorCategory === "light" || equipment.chest?.armorCategory === "medium");
    const baseDefenseWithoutEquipment = Math.max(0, base.defense - equipment.totalDefenseBonus);
    return {
      ...base,
      maxHealth: resolvePlayerMaxHealth(),
      defense: Math.max(0, Math.round(
        baseDefenseWithoutEquipment + equipment.totalDefenseBonus * (hardenedLeathers ? 1.07 : 1)
      )),
      attackRangeM: mode === "ranged" ? HUNTER_BALANCE.rangedRangeM : HUNTER_BALANCE.meleeRangeM
    };
  }
  const baseDefenseWithoutEquipment = Math.max(0, base.defense - equipment.totalDefenseBonus);
  const maxHealth = snapshot.activeClassId === "warrior"
    ? resolvePlayerMaxHealth({
        exceptionalModifiers: [{
          source: "class",
          sourceId: CLASS_INNATE_DEFINITIONS.warrior.id,
          flatBonus: Math.min(
            WARRIOR_INNATE_BALANCE.maxHealthMaximum,
            Math.max(0, Math.trunc(snapshot.characterLevel)) * WARRIOR_INNATE_BALANCE.maxHealthPerLevel
          )
        }]
      })
    : resolvePlayerMaxHealth();
  const modifiers = warriorStatModifiers({
    warriorLevel: snapshot.warrior.level,
    activeClassId: snapshot.activeClassId,
    armorCategory: equipment.chest?.armorCategory ?? null,
    hasLegacy: hasWarriorLegacy
  });
  return {
    ...base,
    maxHealth,
    defense: Math.max(0, Math.round(
      baseDefenseWithoutEquipment + equipment.totalDefenseBonus * modifiers.armorDefenseMultiplier
    ))
  };
}
