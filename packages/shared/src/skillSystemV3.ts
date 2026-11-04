import type { PvpDamageDefenseProfileV3, PvpDamageWeaponProfileV3 } from "./damageMatrixV3.js";
import { CURRENT_LEVEL_CAP, EQUIPMENT_LEVEL_CAP } from "./progression.js";

export const SKILL_SYSTEM_V3_VERSION = "skill_system_v3" as const;
export const ASH_PROVISIONAL_SKILL_POINT_SCHEDULE_V1 = "1_per_character_level_cap_25" as const;
export const SKILL_POINTS_PER_CHARACTER_LEVEL = 1;
export const SKILL_POINT_CHARACTER_LEVEL_CAP: number = CURRENT_LEVEL_CAP;
export const MAX_LEVEL_DERIVED_SKILL_POINTS = SKILL_POINT_CHARACTER_LEVEL_CAP * SKILL_POINTS_PER_CHARACTER_LEVEL;
export const GENERAL_SKILL_DEFAULT_RANK_COSTS = [1, 1, 1] as const;
export const SPECIALIZATION_MIN_CHARACTER_LEVEL = 9;
/** Stored Tactics: gain per step and ceiling, by general Tactics rank (index 0 = untrained). */
export const TACTICS_GAIN_BY_RANK = [0, 0.2, 0.3, 0.5] as const;
export const TACTICS_CAP_BY_RANK = [0, 1.2, 2.5, 3.8] as const;
export const SPECIALIZATION_MAX_RANK = 5;
/** Class rank N (1..5) unlocks at this character level, starter classes included. */
export const SPECIALIZATION_RANK_LEVEL_GATES = [9, 14, 21, 27, 33] as const;
export const DRUID_REPLENISH_BERRY_COST = 5;
/** Merchant Rank 1 action: pay this much Gold per character level (capped) to fill stored Tactics. */
export const MERCHANT_MAXIMIZE_TACTICS_ABILITY_ID = "v3_merchant_maximize_tactics" as const;
export const MERCHANT_MAXIMIZE_TACTICS_GOLD_PER_LEVEL = 9;
export const MERCHANT_MAXIMIZE_TACTICS_LEVEL_CAP = 33;
export function merchantMaximizeTacticsCostGold(characterLevel: number): number {
  return MERCHANT_MAXIMIZE_TACTICS_GOLD_PER_LEVEL * Math.max(1, Math.min(MERCHANT_MAXIMIZE_TACTICS_LEVEL_CAP, Math.floor(characterLevel)));
}
export const DRUID_REPLENISH_WITHERED_RATIO = 0.25;
export function druidReplenishTransferRatio(rank: number, withered: boolean): number {
  if (withered) return DRUID_REPLENISH_WITHERED_RATIO;
  return rank >= 5 ? 1.25 : rank >= 3 ? 0.95 : 0.65;
}

/** Merchant trade-post tax reduction, as a percent OF THE TAX (ranks 2/4/5: 8/20/40). */
export function merchantTradeTaxReductionPercent(rank: number): number {
  return rank >= 5 ? 40 : rank >= 4 ? 20 : rank >= 2 ? 8 : 0;
}
/** Reduces a buyer tax in basis points by the Merchant percent of the tax; never negative, never above the input. */
export function merchantReducedBuyerTaxBps(taxBps: number, rank: number): number {
  const percent = merchantTradeTaxReductionPercent(rank);
  if (!Number.isFinite(taxBps) || taxBps <= 0) return 0;
  if (percent <= 0) return taxBps;
  return Math.max(0, Math.ceil((taxBps * (100 - percent)) / 100));
}

/** Artificer crafting-time reduction in percent (R2 9, R4 18, R5 28). */
export function artificerCraftTimeReductionPercent(rank: number): number {
  return rank >= 5 ? 28 : rank >= 4 ? 18 : rank >= 2 ? 9 : 0;
}
/** Station job duration after the Artificer reduction; always at least 1 ms so a job never completes before it starts. */
export function artificerCraftDurationMs(durationMs: number, rank: number): number {
  const percent = artificerCraftTimeReductionPercent(rank);
  if (percent <= 0 || !Number.isFinite(durationMs)) return durationMs;
  return Math.max(1, Math.round((durationMs * (100 - percent)) / 100));
}
/** Bonus items for a bulk craft: +1 per 6 crafted at R3-R4, +1 per 4 at R5. */
export function artificerBulkBonusItems(craftedQuantity: number, rank: number): number {
  const per = rank >= 5 ? 4 : rank >= 3 ? 6 : 0;
  return per === 0 || !Number.isSafeInteger(craftedQuantity) || craftedQuantity < 0 ? 0 : Math.floor(craftedQuantity / per);
}

export const CONTENT_STATUSES = [
  "implemented",
  "future_content",
  "pending_dependency",
  "pending_design",
  "pending_source",
  "pending_economy_policy"
] as const;
export type ContentStatus = (typeof CONTENT_STATUSES)[number];

export const GENERAL_SKILL_IDS = [
  "cleave", "archery", "martial_arts", "tactics", "shield_charge", "cleanse",
  "taunt", "war_standard", "ricochet", "heroism", "quarry_sense", "huntsmans_edge",
  "perfect_strike", "pierce_armor", "blight_strike", "provoke", "pursuit", "scavenge",
  "calm_mind", "second_wind", "deathburst", "concentration", "companion_bond", "delvers_lore",
  "alchemy", "blacksmithing", "leatherworking", "cartography", "tradecraft"
] as const;
export type GeneralSkillId = (typeof GENERAL_SKILL_IDS)[number];

/* Flat per-rank values for the small General ladders, indexed by rank (index 0 = unlearned). */
export const ARCHERY_ATTACK_BY_RANK = [0, 1, 3, 4] as const;
export const MARTIAL_RANGED_ATTACK_BY_RANK = [0, 1, 2, 4] as const;
export const TAUNT_DEFENSE_BY_RANK = [0, 2, 3, 4] as const;
export const WAR_STANDARD_ATTACK_BY_RANK = [0, 1, 2, 3] as const;
export const PROVOKE_DEFENSE_DEBUFF_BY_RANK = [0, 0, 2, 3] as const;
export const HEROISM_BOSS_DEFENSE_BY_RANK = [0, 1, 3, 3] as const;
export const HEROISM_HERO_ATTACK_BY_RANK = [0, 1, 1, 3] as const;
/** Exposed: the extra damage fraction a marked monster takes until death (0.4 = 1.4x; rank 3 0.75). */
export const QUARRY_EXPOSED_DAMAGE_BONUS_BY_RANK = [0, 0.4, 0.4, 0.75] as const;
export const flatRankValue = (table: readonly number[], rank: number): number =>
  table[Math.max(0, Math.min(table.length - 1, Math.floor(rank)))] ?? 0;

/**
 * The durable V3 combat loadout currently exposes exactly two General Active
 * slots. Keep this policy in shared code so protocol, server, and UI cannot
 * drift into separate slot counts or numbering schemes.
 */
export const GENERAL_ACTIVE_SLOT_IDS = [1, 2] as const;
export type GeneralActiveSlotId = (typeof GENERAL_ACTIVE_SLOT_IDS)[number];
export const GENERAL_ACTIVE_SLOT_COUNT = GENERAL_ACTIVE_SLOT_IDS.length;
export type GeneralActiveLoadout = readonly [GeneralSkillId | null, GeneralSkillId | null];

export function isGeneralActiveSlotId(value: unknown): value is GeneralActiveSlotId {
  return typeof value === "number"
    && Number.isInteger(value)
    && (GENERAL_ACTIVE_SLOT_IDS as readonly number[]).includes(value);
}

export function generalActiveSlotIndex(slot: GeneralActiveSlotId): 0 | 1 {
  const index = GENERAL_ACTIVE_SLOT_IDS.indexOf(slot);
  if (index < 0) throw new Error(`Unknown General Active slot: ${slot}`);
  return index as 0 | 1;
}

export const SPECIALIZATION_IDS = [
  "warrior", "knight", "legionnaire", "ranger", "mercenary", "sentinel", "assassin", "ninja",
  "monk", "rogue", "druid", "merchant", "artificer", "voyager", "ronin"
] as const;
export type SpecializationId = (typeof SPECIALIZATION_IDS)[number];
/**
 * The player-selectable V3 class roster: Ronin and Warrior only (owner, 2026-10-21). Both are free-switch
 * classes: picking one, switching, or dropping back to no class is instant and free, with no rank, gateway,
 * writ, level gate or cooldown (SpecializationService.activateSpecialization). They exist so class-specific
 * weapon combos can be tested (the active class id is `activeSpecializationId`).
 *
 * Every other id stays defined (rank rows, migrations, audits keep their meaning) but is unavailable: a
 * player whose stored class is one of them reads as "no class" (loadSkillSnapshot / combat runtime).
 * Deliberately independent of the legacy V2 `LAUNCH_CLASS_IDS`.
 */
export const LAUNCH_SPECIALIZATION_IDS = ["ronin", "warrior"] as const satisfies readonly SpecializationId[];
/** Starter classes can be picked without their gateway general skill. */
export const STARTER_SPECIALIZATION_IDS = ["warrior", "ranger"] as const satisfies readonly SpecializationId[];
export function isStarterSpecializationId(id: SpecializationId): boolean {
  return (STARTER_SPECIALIZATION_IDS as readonly SpecializationId[]).includes(id);
}
export function isLaunchSpecializationId(id: SpecializationId): id is (typeof LAUNCH_SPECIALIZATION_IDS)[number] {
  return (LAUNCH_SPECIALIZATION_IDS as readonly SpecializationId[]).includes(id);
}

export type SkillSystemV3RuntimeCapabilities = Readonly<{
  fullClassRosterEnabled: boolean;
  ultimatesEnabled: boolean;
}>;

export const DEFAULT_SKILL_SYSTEM_V3_RUNTIME_CAPABILITIES: SkillSystemV3RuntimeCapabilities = Object.freeze({
  fullClassRosterEnabled: false,
  ultimatesEnabled: false
});

export const WORLD_KNOWLEDGE_SKILL_IDS = [
  "tidecraft", "rare_beast_mastery", "wildkin_lore", "deepstone_lore", "grove_lore", "edict_stride", "field_engineering"
] as const;
export type WorldKnowledgeSkillId = (typeof WORLD_KNOWLEDGE_SKILL_IDS)[number];

export type SkillKind = "active" | "passive" | "contextual";
export type SkillCategory = "gateway" | "combat" | "support" | "exploration" | "knowledge" | "trade";
export type GeneralSkillCatalogVisibility = "visible" | "hidden_until_dependency" | "hidden_for_launch";

export type SkillEffectDefinition = Readonly<{
  effectId: string;
  description: string;
  status?: ContentStatus;
}>;

export type SkillRankDefinition = Readonly<{
  rank: 1 | 2 | 3;
  cost: number;
  effects: readonly SkillEffectDefinition[];
  cooldownMs?: number;
  targeting?: "self" | "hostile" | "friendly" | "position" | "direction";
  rangeM?: number;
  prerequisites?: readonly SkillRankPrerequisite[];
}>;

export type SkillRankPrerequisite = Readonly<{ skillId: GeneralSkillId; rank: number }>;

export type SkillDefinition = Readonly<{
  id: GeneralSkillId;
  displayName: string;
  category: SkillCategory;
  kind: SkillKind;
  rankDefinitions: readonly SkillRankDefinition[];
  prerequisites: readonly SkillRankPrerequisite[];
  useEquipmentRequirement?: readonly string[];
  worldUnlockRequirement?: string;
  status: ContentStatus;
  catalogVisibility: GeneralSkillCatalogVisibility;
  description: string;
  iconKey: string;
  tree: Readonly<{ group: string; x: number; y: number }>;
}>;

export type SpecializationRankDefinition = Readonly<{
  rank: 1 | 2 | 3 | 4 | 5;
  cost: number;
  effects: readonly SkillEffectDefinition[];
  actionUnlock?: string;
  description: string;
}>;

export type SpecializationDefinition = Readonly<{
  id: SpecializationId;
  displayName: string;
  gatewaySkillId: GeneralSkillId | null;
  gatewayStatus: "defined" | "pending_design";
  minimumCharacterLevel: 9;
  ranks: readonly SpecializationRankDefinition[];
  signature?: Readonly<{ id: string; displayName: string; status: ContentStatus; description: string }>;
  status: ContentStatus;
  availability: "launch" | "full_roster" | "backend_only";
}>;

const effect = (effectId: string, description: string, status?: ContentStatus): SkillEffectDefinition =>
  status === undefined ? { effectId, description } : { effectId, description, status };

function skillRank(
  rank: 1 | 2 | 3,
  effects: readonly SkillEffectDefinition[],
  options: Partial<Omit<SkillRankDefinition, "rank" | "effects">> = {}
): SkillRankDefinition {
  return { rank, cost: GENERAL_SKILL_DEFAULT_RANK_COSTS[rank - 1]!, effects, ...options };
}

function skill(
  id: GeneralSkillId,
  displayName: string,
  category: SkillCategory,
  kind: SkillKind,
  ranks: readonly SkillRankDefinition[],
  tree: SkillDefinition["tree"],
  description: string,
  options: Partial<Omit<SkillDefinition, "id" | "displayName" | "category" | "kind" | "rankDefinitions" | "tree" | "description" | "iconKey" | "prerequisites" | "status" | "catalogVisibility">> & {
    iconKey?: string;
    prerequisites?: readonly SkillRankPrerequisite[];
    status?: ContentStatus;
    catalogVisibility?: GeneralSkillCatalogVisibility;
  } = {}
): SkillDefinition {
  return {
    id, displayName, category, kind, rankDefinitions: ranks, tree, description,
    iconKey: options.iconKey ?? id,
    prerequisites: options.prerequisites ?? [],
    status: options.status ?? "implemented",
    catalogVisibility: options.catalogVisibility ?? "visible",
    ...(options.useEquipmentRequirement === undefined ? {} : { useEquipmentRequirement: options.useEquipmentRequirement }),
    ...(options.worldUnlockRequirement === undefined ? {} : { worldUnlockRequirement: options.worldUnlockRequirement }),
  };
}

export const GENERAL_SKILL_DEFINITIONS = {
  cleave: skill("cleave", "Cleave", "gateway", "passive", [
    skillRank(1, [effect("cleave", "4% melee-basic proc; splash 45% damage to up to 3 nearby enemies.")]),
    skillRank(2, [effect("cleave", "9% melee-basic proc; splash 45% damage to up to 4 nearby enemies.")]),
    skillRank(3, [effect("cleave", "13% melee-basic proc; splash 45% damage to up to 5 nearby enemies; unlocks eligible Cleave specializations.")], { cost: 1 })
  ], { group: "melee", x: -300, y: 0 }, "A melee gateway that can create one non-recursive splash per basic attack.", { useEquipmentRequirement: ["sword", "axe", "hammer", "dagger", "brass_knuckles", "spear", "staff"] }),
  archery: skill("archery", "Archery", "gateway", "passive", [
    skillRank(1, [effect("ranged_attack", "+1 flat Attack with Longbow and Crossbow profiles; enables relevant weapon permissions.")]),
    skillRank(2, [effect("ranged_attack_range", "Total +3 flat Attack with Longbow and Crossbow; +22m range.")]),
    skillRank(3, [effect("ranged_attack_range", "Total +4 flat Attack with Longbow and Crossbow; +45m range; unlocks eligible Archery specializations.")], { cost: 1 })
  ], { group: "ranged", x: -100, y: 0 }, "The shared Longbow and Crossbow gateway."),
  martial_arts: skill("martial_arts", "Martial Arts", "gateway", "contextual", [
    skillRank(1, [effect("martial_scaling", "Unarmed Attack and Defense scale from character level to 25; +1 Shuriken/Blowdart Attack and weapon permission.")]),
    skillRank(2, [effect("martial_dodge", "14 Dodge percentage points with Tunic/Cloth and no Shield; total +2 Shuriken/Blowdart Attack.")]),
    skillRank(3, [effect("martial_dodge", "28 Dodge percentage points with Tunic/Cloth and no Shield; total +4 Shuriken/Blowdart Attack; unlocks eligible Martial Arts specializations.")], { cost: 1 })
  ], { group: "martial", x: 100, y: 0 }, "The shared unarmed and evasive gateway."),
  tactics: skill("tactics", "Tactics", "gateway", "contextual", [
    skillRank(1, [effect("tactics", "Stored PvE Monster Attack gains +0.2 per chopped tree or every 27 peaceful seconds, decays -0.1 every 11 aggressive seconds, and caps at +1.2.")]),
    skillRank(2, [effect("tactics", "Stored PvE Monster Attack gains +0.3 per chopped tree or every 27 peaceful seconds, decays -0.1 every 11 aggressive seconds, and caps at +2.5.")]),
    skillRank(3, [effect("tactics", "Stored PvE Monster Attack gains +0.5 per chopped tree or every 27 peaceful seconds, decays -0.1 every 11 aggressive seconds, and caps at +3.8; unlocks eligible Tactics specializations.")], { cost: 1 })
  ], { group: "support", x: 300, y: 0 }, "Build and store PvE-only Monster Attack while peaceful; aggression decays it, and it never modifies PvP damage."),
  shield_charge: skill("shield_charge", "Shield Charge", "combat", "active", [
    skillRank(1, [effect("shield_charge", "Use requires a Shield and compatible melee stance; charge at 1.65x movement speed and engage the hostile target for 6 seconds.")], { cooldownMs: 36_000, targeting: "hostile" }),
    skillRank(2, [effect("shield_charge", "Use requires a Shield and compatible melee stance; charge at 1.65x and engage for 9 seconds.")], { cooldownMs: 36_000, targeting: "hostile" }),
    skillRank(3, [effect("shield_charge", "Use requires a Shield and compatible melee stance; charge at 2.35x, engage for 9 seconds, and reset cooldown when the engaged target is killed in time.")], { cooldownMs: 28_000, targeting: "hostile" })
  ], { group: "melee", x: -380, y: 140 }, "An authoritative anti-kite charge that requires a Shield and compatible melee stance when used, and never teleports.", { prerequisites: [{ skillId: "cleave", rank: 2 }] }),
  cleanse: skill("cleanse", "Cleanse", "support", "active", [
    skillRank(1, [effect("cleanse", "Remove harmful statuses and gain 2.5 seconds of immunity.")], { cooldownMs: 270_000, targeting: "self" }),
    skillRank(2, [effect("cleanse", "Remove harmful statuses and gain 5 seconds of immunity.")], { cooldownMs: 225_000, targeting: "self" }),
    skillRank(3, [effect("cleanse", "Remove harmful statuses and gain 8 seconds of immunity.")], { cooldownMs: 165_000, targeting: "self" })
  ], { group: "support", x: 380, y: 140 }, "Purge harmful effects and briefly prevent their return.", { prerequisites: [{ skillId: "tactics", rank: 2 }] }),
  taunt: skill("taunt", "Taunt", "support", "active", [
    skillRank(1, [effect("taunt", "Nearby mobs target you; +2 Defense against them for 36 seconds.")], { cooldownMs: 270_000, targeting: "self" }),
    skillRank(2, [effect("taunt", "+4 Defense against Taunted mobs for 36 seconds.")], { cooldownMs: 210_000, targeting: "self" }),
    skillRank(3, [effect("taunt", "+3 Defense against Taunted mobs for 36 seconds.")], { cooldownMs: 160_000, targeting: "self" })
  ], { group: "support", x: 300, y: 140 }, "Draw nearby monsters; never affects players.", { prerequisites: [{ skillId: "tactics", rank: 1 }] }),
  war_standard: skill("war_standard", "War Standard", "support", "active", [
    skillRank(1, [effect("war_standard", "+1 Attack to self and eligible party for 110 seconds; affected kills reduce cooldown by 25 seconds.")], { cooldownMs: 540_000, targeting: "self" }),
    skillRank(2, [effect("war_standard", "+2 Attack for 110 seconds; affected kills reduce the 7.5-minute cooldown.")], { cooldownMs: 450_000, targeting: "self" }),
    skillRank(3, [effect("war_standard", "+3 Attack for 110 seconds; standards do not stack infinitely.")], { cooldownMs: 420_000, targeting: "self" })
  ], { group: "support", x: 220, y: 140 }, "Raise a shared party combat standard.", { prerequisites: [{ skillId: "taunt", rank: 1 }, { skillId: "tactics", rank: 3 }] }),
  ricochet: skill("ricochet", "Ricochet", "combat", "passive", [
    skillRank(1, [effect("ricochet", "Bounce 18% normal damage to one eligible target within 180m.")]),
    skillRank(2, [effect("ricochet", "Bounce 36% normal damage within 230m.")]),
    skillRank(3, [effect("ricochet", "Bounce 55% normal damage within 280m; secondary hits cannot recurse.")])
  ], { group: "ranged", x: -180, y: 140 }, "A single non-recursive ranged basic-attack bounce.", { prerequisites: [{ skillId: "archery", rank: 1 }], useEquipmentRequirement: ["sling", "longbow", "crossbow", "blowdart", "shuriken"] }),
  heroism: skill("heroism", "Heroism", "combat", "contextual", [
    skillRank(1, [effect("heroism", "+1 Defense versus Bosses; Boss kill grants +1 Attack versus ordinary Monsters for 45 minutes.")]),
    skillRank(2, [effect("heroism", "+3 Defense versus Bosses/Legendary enemies; Hero buff lasts 7 hours.")]),
    skillRank(3, [effect("heroism", "Hero buff grants +3 Monster Attack and lasts 20 hours.")])
  ], { group: "support", x: 460, y: 260 }, "Turn victory over great monsters into durable PvE momentum.", { prerequisites: [{ skillId: "war_standard", rank: 1 }] }),
  quarry_sense: skill("quarry_sense", "Quarry Sense", "combat", "passive", [
    skillRank(1, [effect("opened_guard", "2.5% qualifying mob-hit chance to Expose a non-Boss for 1.4x damage until death.")]),
    skillRank(2, [effect("opened_guard", "5.5% chance to Expose a non-Boss for 1.4x damage.")]),
    skillRank(3, [effect("opened_guard", "8.5% chance to Expose a non-Boss for 1.75x damage.")])
  ], { group: "ranged", x: -20, y: 260 }, "Find weaknesses in ordinary monsters, never players or player-owned creatures.", { prerequisites: [{ skillId: "ricochet", rank: 1 }, { skillId: "archery", rank: 2 }] }),
  huntsmans_edge: skill("huntsmans_edge", "Huntsman's Edge", "combat", "contextual", [
    skillRank(1, [effect("species_hunt", "+2 Attack against the last killed mob species for 54 seconds; -1 Defense versus other mob types.")]),
    skillRank(2, [effect("species_hunt", "+3 Attack against that species; -1 Defense versus others.")]),
    skillRank(3, [effect("species_hunt", "+5 Attack against that species; -1 Defense versus others.")])
  ], { group: "ranged", x: -100, y: 260 }, "Commit briefly to hunting one monster species.", { prerequisites: [{ skillId: "quarry_sense", rank: 1 }, { skillId: "archery", rank: 3 }] }),
  perfect_strike: skill("perfect_strike", "Perfect Strike", "combat", "passive", [
    skillRank(1, [effect("perfect_strike", "2.5% chance for a qualifying first hit to defeat a full-health non-Boss mob.")]),
    skillRank(2, [effect("perfect_strike", "4.5% qualifying chance.")]),
    skillRank(3, [effect("perfect_strike", "7% qualifying chance; never affects players or Bosses.")])
  ], { group: "martial", x: 20, y: 260 }, "A server-randomized opening strike against ordinary mobs.", { prerequisites: [{ skillId: "martial_arts", rank: 3 }] }),
  pierce_armor: skill("pierce_armor", "Pierce Armor", "combat", "passive", [
    skillRank(1, [effect("pierce_armor", "Every 170 seconds, prime 22% remaining-HP damage capped at 22; do not consume if weaker than the normal hit.")]),
    skillRank(2, [effect("pierce_armor", "Prime 30% remaining-HP damage capped at 30.")]),
    skillRank(3, [effect("pierce_armor", "Prime 38% remaining-HP damage capped at 38.")])
  ], { group: "melee", x: -260, y: 260 }, "A patient armor-piercing hit that remains primed when ordinary damage is stronger.", { prerequisites: [{ skillId: "cleave", rank: 1 }], useEquipmentRequirement: ["sword", "axe", "hammer", "dagger", "brass_knuckles", "spear", "staff"] }),
  blight_strike: skill("blight_strike", "Blight Strike", "combat", "active", [
    skillRank(1, [effect("blight", "Arm a melee strike: 18 seconds, 1.2 DPS, +9% miss chance, half-duration contact spread, 4.5-minute target immunity.")], { cooldownMs: 390_000, targeting: "hostile" }),
    skillRank(2, [effect("blight", "1.7 average DPS and +14% miss chance with half-duration spread.")], { cooldownMs: 335_000, targeting: "hostile" }),
    skillRank(3, [effect("blight", "2.2 DPS and +22% miss chance with recursion-safe spread.")], { cooldownMs: 285_000, targeting: "hostile" })
  ], { group: "melee", x: -180, y: 380 }, "Arm the next melee strike with a spreading, immunity-limited blight.", { prerequisites: [{ skillId: "pierce_armor", rank: 3 }, { skillId: "cleave", rank: 3 }] }),
  provoke: skill("provoke", "Provoke", "combat", "passive", [
    skillRank(1, [effect("provoke", "45% chance for a mob that truly enters flee behavior within 180m to turn and attack.")]),
    skillRank(2, [effect("provoke", "70% chance; target suffers -2 Defense for 9 seconds.")]),
    skillRank(3, [effect("provoke", "100% chance; target suffers -3 Defense for 9 seconds.")])
  ], { group: "melee", x: -340, y: 380 }, "Punish genuine monster flight, not tactical repositioning.", { prerequisites: [{ skillId: "cleave", rank: 2 }] }),
  pursuit: skill("pursuit", "Pursuit", "combat", "contextual", [
    skillRank(1, [effect("pursuit", "A melee mob kill enables a +40% rush toward another mob and +1 Attack for 9 seconds.")]),
    skillRank(2, [effect("pursuit", "+90% rush and +2 Attack.")]),
    skillRank(3, [effect("pursuit", "+140% rush and +4 Attack.")])
  ], { group: "melee", x: -420, y: 380 }, "Carry melee momentum toward another monster using authoritative movement.", { prerequisites: [{ skillId: "shield_charge", rank: 1 }, { skillId: "cleave", rank: 3 }] }),
  scavenge: skill("scavenge", "Scavenge", "exploration", "passive", [
    skillRank(1, [effect("scavenge", "4% proc when a monster drops an item: find 1 Wood or Frond Sap.")]),
    skillRank(2, [effect("scavenge", "9% proc on a monster item drop; pool adds Leather and Iron Ore.")]),
    skillRank(3, [effect("scavenge", "14% proc on a monster item drop; pool adds Sulfur and Stone.")])
  ], { group: "support", x: 380, y: 380 }, "Find an extra canonical low-tier material on qualifying monster loot.", { prerequisites: [{ skillId: "tactics", rank: 1 }] }),
  calm_mind: skill("calm_mind", "Calm Mind", "support", "passive", [
    skillRank(1, [effect("aggression_duration", "Reduce aggression duration by 12%.")]),
    skillRank(2, [effect("aggression_duration", "Reduce aggression duration by 27%.")]),
    skillRank(3, [effect("aggression_duration", "Reduce aggression duration by 42%; a mob kill ends aggression immediately when no other enemies remain.")])
  ], { group: "support", x: 300, y: 500 }, "Regain composure sooner after combat.", { prerequisites: [{ skillId: "tactics", rank: 1 }] }),
  second_wind: skill("second_wind", "Second Wind", "combat", "passive", [
    skillRank(1, [effect("kill_heal", "A mob kill by you, your pet or your minion heals a random 1–4% maximum HP.")]),
    skillRank(2, [effect("kill_heal", "A qualifying kill heals 2–8% maximum HP.")]),
    skillRank(3, [effect("kill_heal", "A qualifying kill heals 4–13% maximum HP.")])
  ], { group: "melee", x: -260, y: 500 }, "Recover a variable share of health after personally defeating a monster.", { prerequisites: [{ skillId: "cleave", rank: 1 }] }),
  deathburst: skill("deathburst", "Deathburst", "combat", "passive", [
    skillRank(1, [effect("deathburst", "A killing blow deals 2.5% of the defeated target's max HP to enemies within 180m.")]),
    skillRank(2, [effect("deathburst", "A killing blow deals 5.5% in the area.")]),
    skillRank(3, [effect("deathburst", "A killing blow deals 9% in the area.")])
  ], { group: "melee", x: -100, y: 500 }, "Burst a defeated monster's remaining force across nearby PvE enemies.", { prerequisites: [{ skillId: "second_wind", rank: 3 }, { skillId: "cleave", rank: 3 }] }),
  concentration: skill("concentration", "Concentration", "combat", "contextual", [
    skillRank(1, [effect("concentration", "At least 65% of attacks stay on the focused target (all of them here); every third consecutive hit on one target gains +1 damage per 22% target HP missing.")]),
    skillRank(2, [effect("concentration", "At least 75% of attacks stay on the focused target; every third consecutive hit gains +1 damage per 13% target HP missing.")]),
    skillRank(3, [effect("concentration", "At least 85% of attacks stay on the focused target; every third consecutive hit gains +1 damage per 9% target HP missing.")])
  ], { group: "ranged", x: 60, y: 500 }, "Build precision across consecutive hits on one target.", { prerequisites: [{ skillId: "huntsmans_edge", rank: 1 }] }),
  companion_bond: skill("companion_bond", "Companion Bond", "support", "passive", [
    skillRank(1, [effect("companion_bond", "Pet attacks heal owner and pet 2; pet ability cooldowns -7%; pet max HP +25%.")]),
    skillRank(2, [effect("companion_bond", "Heal 4; ability cooldowns -13%; max HP +45%.")]),
    skillRank(3, [effect("companion_bond", "Heal 5; ability cooldowns -20%; max HP +75%.")])
  ], { group: "support", x: 460, y: 500 }, "Strengthen your authoritative combat companion.", { prerequisites: [{ skillId: "tactics", rank: 2 }] }),
  delvers_lore: skill("delvers_lore", "Delver's Lore", "exploration", "contextual", [
    skillRank(1, [effect("dungeon_speed", "+8 movement Speed in dungeons."), effect("dungeon_persistence", "Leaving an unfinished dungeon on your own returns the entry torch, only to the player who paid it (once per run).")]),
    skillRank(2, [effect("dungeon_speed", "+16 dungeon movement Speed."), effect("dungeon_repeat", "Same-dungeon repeat cooldown: 5 days.")]),
    skillRank(3, [effect("dungeon_speed", "+24 dungeon movement Speed."), effect("dungeon_repeat", "Same-dungeon repeat cooldown: 4 days.")])
  ], { group: "exploration", x: 540, y: 500 }, "Move confidently in dungeons and return sooner after completing them.", { prerequisites: [{ skillId: "tactics", rank: 2 }] }),
  alchemy: skill("alchemy", "Alchemy", "trade", "passive", [
    skillRank(1, [effect("alchemy", "Craft Spark Tonics and Anti-Venom Tonics; Giving Berries you eat heal 45% more.")]),
    skillRank(2, [effect("alchemy", "Craft Battle Draughts and Vigor Serums; your tonics last 40% longer.")]),
    skillRank(3, [effect("alchemy", "Craft Ember Bombs; they deal +22% damage and leave non-Boss monsters Exposed (1.4x damage until death).")])
  ], { group: "trades", x: -200, y: 0 }, "The alchemist's trade."),
  blacksmithing: skill("blacksmithing", "Blacksmithing", "trade", "passive", [
    skillRank(1, [effect("blacksmithing", "Repair gear with a Repair Kit; equipped gear lasts 1.4x longer.")]),
    skillRank(2, [effect("blacksmithing", "Equipped gear lasts 1.8x longer.")]),
    skillRank(3, [effect("blacksmithing", "Equipped gear lasts 2.6x longer; craft Field Traps.")])
  ], { group: "trades", x: -100, y: 0 }, "Repair and care for gear, and forge traps."),
  leatherworking: skill("leatherworking", "Leatherworking", "trade", "passive", [
    skillRank(1, [effect("leatherworking", "Craft Slings and Backpacks; +2 Defense versus monsters that drop leather.")]),
    skillRank(2, [effect("leatherworking", "Craft Field Nets; +2 Attack versus monsters that drop leather.")]),
    skillRank(3, [effect("leatherworking", "Craft Leather Armor; 22% chance of double leather from a drop; a used Field Net returns 70% of the time.")])
  ], { group: "trades", x: 0, y: 0 }, "The leatherworker's trade."),
  cartography: skill("cartography", "Cartography", "trade", "passive", [
    skillRank(1, [effect("cartography", "Craft the Compass and the Survey Stake Kit.")]),
    skillRank(2, [effect("cartography", "Craft the Shovel; see and dig silver treasure.")]),
    skillRank(3, [effect("cartography", "See and dig gold treasure.")])
  ], { group: "trades", x: 100, y: 0 }, "Chart the land, find buried treasure."),
  tradecraft: skill("tradecraft", "Tradecraft", "trade", "passive", [
    skillRank(1, [effect("tradecraft", "Prices from the Wandering Merchant and other NPC shops are 18% lower.")]),
    skillRank(2, [effect("tradecraft", "NPC shop prices are 27% lower.")]),
    skillRank(3, [effect("tradecraft", "NPC shop prices are 37% lower.")])
  ], { group: "trades", x: 200, y: 0 }, "Haggle with merchants for better prices.")
} as const satisfies Readonly<Record<GeneralSkillId, SkillDefinition>>;

export const VISIBLE_GENERAL_SKILL_IDS: readonly GeneralSkillId[] = GENERAL_SKILL_IDS.filter((id) => GENERAL_SKILL_DEFINITIONS[id].catalogVisibility === "visible");

const specEffect = effect;
function specRank(rank: 1 | 2 | 3 | 4 | 5, cost: number, description: string, effects?: readonly SkillEffectDefinition[], actionUnlock?: string): SpecializationRankDefinition {
  return { rank, cost, description, effects: effects ?? [specEffect(`rank_${rank}`, description)], ...(actionUnlock === undefined ? {} : { actionUnlock }) };
}

export const SPECIALIZATION_DEFINITIONS = {
  warrior: { id: "warrior", displayName: "Warrior", gatewaySkillId: "cleave", gatewayStatus: "defined", minimumCharacterLevel: 9, status: "implemented", availability: "launch", ranks: [
    specRank(1,1,"+9 Max HP and +1 Axe Attack."), specRank(2,1,"Total +18 Max HP; +1 melee Attack below 46% HP."),
    specRank(3,1,"Total +27 Max HP; total +2 Axe Attack."), specRank(4,1,"Total +36 Max HP; +2 additional Axe Attack below 33% HP."),
    specRank(5,1,"Total +45 Max HP; total +4 Axe Attack; +3 melee Attack below 22% HP.")
  ], signature: { id: "unrelenting_rage", displayName: "Unrelenting Rage", status: "implemented", description: "Warrior identity label; retired V2 numeric innate must not stack." } },
  knight: { id: "knight", displayName: "Knight", gatewaySkillId: "cleave", gatewayStatus: "defined", minimumCharacterLevel: 9, status: "implemented", availability: "full_roster", ranks: [
    specRank(1,1,"+1 Sword Attack."), specRank(2,1,"+1 Heavy/Breastplate Defense and +1 Shield Defense versus ranged attacks."),
    specRank(3,1,"Total +2 Sword Attack and +2 ranged Shield Defense."), specRank(4,1,"Total +2 Heavy/Breastplate Defense."),
    specRank(5,1,"Total +4 Sword Attack, +3 Heavy/Breastplate Defense, and +3 ranged Shield Defense.")
  ] },
  legionnaire: { id: "legionnaire", displayName: "Legionnaire", gatewaySkillId: "cleave", gatewayStatus: "defined", minimumCharacterLevel: 9, status: "implemented", availability: "full_roster", ranks: [
    specRank(1,1,"+1 Spear Attack."), specRank(2,1,"+1 Shield Defense. Formation: each shield-carrying player within 225m who is not hostile to you adds +0.4 Shield Defense (formation total up to +2); each shield-carrying party ally within that range adds a further +0.2 (ally total up to +1.5)."),
    specRank(3,1,"Total +2 Spear Attack and total +2 Shield Defense."), specRank(4,1,"Formation entries now add +0.65 each (formation total up to +3); ally portion unchanged."),
    specRank(5,1,"Total +4 Spear Attack; formation entries add +0.9 each (formation total up to +5); ally portion unchanged.")
  ] },
  ranger: { id: "ranger", displayName: "Ranger", gatewaySkillId: "archery", gatewayStatus: "defined", minimumCharacterLevel: 9, status: "implemented", availability: "full_roster", ranks: [
    specRank(1,1,"+1 Longbow Attack and +1 Sword Attack."), specRank(2,1,"+4 movement Speed and +20m Longbow range."),
    specRank(3,1,"Total +2 Longbow Attack and +2 Sword Attack; +1 Leather Defense versus melee, disabled with Shield."), specRank(4,1,"Total +40m Longbow range."),
    specRank(5,1,"Total +4 Longbow Attack, +4 Sword Attack, +9 Speed, and +3 Leather Defense versus melee, disabled with Shield.")
  ] },
  mercenary: { id: "mercenary", displayName: "Mercenary", gatewaySkillId: "archery", gatewayStatus: "defined", minimumCharacterLevel: 9, status: "implemented", availability: "full_roster", ranks: [
    specRank(1,1,"+1 Spear Attack. PvP only: sustained successful hits against the same player grant +1 Spear Attack per 80 seconds, up to +2; resets on either death or 4.5 minutes without a successful hit.", [
      specEffect("mercenary_rank_1_combat", "+1 Spear Attack and PvP sustained-hit Spear Attack bonus up to +2."),
      specEffect("mercenary_folio_reward", "PvP kill bonus XP: coefficient 2 x min(your level, 33) x your current Momentum stacks against the victim.")
    ]), specRank(2,1,"PvP kill bonus XP coefficient 3.", [
      specEffect("mercenary_folio_reward", "PvP kill bonus XP: coefficient 3 x min(your level, 33) x your current Momentum stacks against the victim.")
    ]),
    specRank(3,2,"+1 Crossbow Attack and +1 Leather Defense without Shield. PvP only: sustained successful hits against the same player grant +1 Spear Attack per 80 seconds, up to +3; resets on either death or 4.5 minutes without a successful hit.", [
      specEffect("mercenary_rank_3_combat", "+1 Crossbow Attack and +1 Leather Defense without Shield."),
      specEffect("mercenary_momentum", "PvP only: sustained successful hits against the same player grant +1 Spear Attack per 80 seconds, up to +3; resets on either death or 4.5 minutes without a successful hit."),
      specEffect("mercenary_folio_reward", "PvP kill bonus XP coefficient rises to 4 (ranks 3 and up).")
    ]), specRank(4,3,"PvP only: sustained successful hits against the same player grant +1 Spear Attack per 80 seconds, up to +4; resets on either death or 4.5 minutes without a successful hit. Total +2 Spear Attack."),
    specRank(5,3,"PvP only: sustained successful hits against the same player grant +1 Spear Attack per 80 seconds, up to +6; resets on either death or 4.5 minutes without a successful hit. Total +3 Crossbow Attack and +3 Spear Attack; +1 additional Leather Defense versus melee without Shield.")
  ], signature: { id: "momentum", displayName: "Sustained PvP Spear Attack bonus", status: "implemented", description: "PvP only: sustained successful hits against the same player grant +1 Spear Attack per 80 seconds, capped by Mercenary rank (+2/+3/+4/+6); resets on either death or 4.5 minutes without a successful hit. PvP kills also grant bonus XP: coefficient (2/3/4 by rank) x min(level, 33) x current Momentum stacks." } },
  sentinel: { id: "sentinel", displayName: "Militia", gatewaySkillId: "archery", gatewayStatus: "defined", minimumCharacterLevel: 9, status: "implemented", availability: "full_roster", ranks: [
    specRank(1,1,"+1 Crossbow Attack; Crossbow works at close range."), specRank(2,1,"+2 Breastplate Defense versus ranged; reduce the Breastplate movement penalty by 2 percentage points.", [
      specEffect("sentinel_ranged_defense", "+2 Breastplate Defense versus ranged weapons."),
      specEffect("sentinel_heavy_speed_penalty", "Reduce the Breastplate movement penalty by 2 percentage points.")
    ]),
    specRank(3,2,"Total +2 Crossbow Attack; attacks reduce target Dodge by 9 percentage points."), specRank(4,2,"Total +3 Breastplate Defense versus ranged; reduce the Breastplate movement penalty by 4 percentage points.", [
      specEffect("sentinel_ranged_defense", "Total +3 Breastplate Defense versus ranged weapons."),
      specEffect("sentinel_heavy_speed_penalty", "Reduce the Breastplate movement penalty by 4 percentage points.")
    ]),
    specRank(5,3,"Total +4 Crossbow Attack, +4 Breastplate Defense versus ranged, -22 Dodge percentage points on attacks, and reduce the Breastplate movement penalty by 6 percentage points.", [
      specEffect("sentinel_rank_5_combat", "Total +4 Crossbow Attack, +4 Breastplate Defense versus ranged, and -22 Dodge percentage points on attacks."),
      specEffect("sentinel_heavy_speed_penalty", "Reduce the Breastplate movement penalty by 6 percentage points.")
    ])
  ] },
  assassin: { id: "assassin", displayName: "Assassin", gatewaySkillId: "martial_arts", gatewayStatus: "defined", minimumCharacterLevel: 9, status: "implemented", availability: "full_roster", ranks: [
    specRank(1,1,"+1 Dagger Attack; may Dodge with Dagger under compatible conditions."), specRank(2,1,"+1 Blowdart Attack; aggression duration -4%."),
    specRank(3,1,"Total +2 Dagger Attack; 2.5x qualifying attack against a nonaggressive player on an 18-second authoritative cooldown."),
    specRank(4,1,"Total +2 Blowdart Attack; aggression duration -9%; +1 Tunic Defense."),
    specRank(5,1,"Total +4 Dagger and Blowdart Attack; 3.5x qualifying nonaggressive-player attack; aggression duration -14%.")
  ] },
  ninja: { id: "ninja", displayName: "Ninja", gatewaySkillId: "martial_arts", gatewayStatus: "defined", minimumCharacterLevel: 9, status: "implemented", availability: "full_roster", ranks: [
    specRank(1,1,"+1 Shuriken Attack; Shuriken works at close range."), specRank(2,1,"+9 base movement Speed and +4 Dodge percentage points."),
    specRank(3,1,"Total +2 Shuriken Attack."), specRank(4,1,"Total +18 base Speed and +7 Dodge percentage points."),
    specRank(5,1,"Total +4 Shuriken Attack, +27 base Speed, +11 Dodge percentage points.")
  ] },
  monk: { id: "monk", displayName: "Monk", gatewaySkillId: "martial_arts", gatewayStatus: "defined", minimumCharacterLevel: 9, status: "implemented", availability: "full_roster", ranks: [
    specRank(1,1,"Dodge with Sling and +1 Staff/Sling Attack; nonaggressive Giving Berry healing +25%.", [
      specEffect("monk_rank_1_combat", "Dodge with Sling and +1 Staff/Sling Attack."),
      specEffect("monk_unaggressive_recovery", "While nonaggressive, Giving Berry heals 1.25x faster (+25%; +55% at rank 3, 1.8x at rank 5) and still heals exactly 24 HP.")
    ]), specRank(2,1,"+2 Tunic Defense; hostile base Speed -8 within 180m; Staff/Sling hits have a 4% chance to stun for 5 s.", [
      specEffect("monk_tunic_defense", "+2 Tunic Defense."),
      specEffect("monk_slow_aura", "Hostile base Speed -8 within 180m."),
      specEffect("monk_stun", "Staff/Sling hits have a 4% chance to stun the target for 5 s (then 10 s stun-immune).")
    ]),
    specRank(3,1,"Total +2 Staff/Sling Attack; nonaggressive Giving Berry healing +55%.", [
      specEffect("monk_weapon_attack", "Total +2 Staff/Sling Attack; nonaggressive Giving Berry healing +55%.")
    ]), specRank(4,1,"Total +3 Tunic Defense; hostile base Speed -16 within 180m; Staff/Sling hits have a 7% chance to stun for 5 s.", [
      specEffect("monk_tunic_defense", "Total +3 Tunic Defense."),
      specEffect("monk_slow_aura", "Hostile base Speed -16 within 180m."),
      specEffect("monk_stun", "Staff/Sling hits have a 7% chance to stun the target for 5 s (then 10 s stun-immune).")
    ]),
    specRank(5,1,"Total +4 Staff/Sling Attack and +4 Tunic Defense; hostile base Speed -26 within 180m; nonaggressive Giving Berry healing 1.8x.", [
      specEffect("monk_rank_5_combat", "Total +4 Staff/Sling Attack and +4 Tunic Defense."),
      specEffect("monk_slow_aura", "Hostile base Speed -26 within 180m.")
    ])
  ] },
  rogue: { id: "rogue", displayName: "Rogue", gatewaySkillId: "martial_arts", gatewayStatus: "defined", minimumCharacterLevel: 9, status: "implemented", availability: "full_roster", ranks: [
    specRank(1,1,"+7 Speed, +1 Dagger/Brass Knuckles, and Dodge with Leather and no Shield; 2.5% chance for 450 extra Gold on a humanoid kill.", [
      specEffect("rogue_rank_1_combat", "+7 Speed; +1 Dagger/Brass Knuckles Attack; Dodge with Leather and no Shield."),
      specEffect("rogue_humanoid_gold", "2.5% chance for 450 extra Gold when you defeat a humanoid.")
    ]),
    specRank(2,1,"+14 Speed; take 9% of a defeated player's Gold, up to 900.", [
      specEffect("rogue_speed", "+14 Speed."),
      specEffect("rogue_pvp_gold_theft", "Steal 9% of a defeated player's remaining Gold, up to 900.")
    ]),
    specRank(3,1,"+21 Speed; total +2 Dagger/Knuckles; 2.5% chance for 900 extra Gold on a humanoid kill.", [
      specEffect("rogue_rank_3_combat", "+21 Speed; total +2 Dagger/Brass Knuckles Attack."),
      specEffect("rogue_humanoid_gold", "2.5% chance for 900 extra Gold when you defeat a humanoid.")
    ]),
    specRank(4,1,"+28 Speed; player Gold theft cap rises to 2,200.", [
      specEffect("rogue_speed", "+28 Speed."),
      specEffect("rogue_pvp_gold_theft", "Steal 9% of a defeated player's remaining Gold, up to 2,200.")
    ]),
    specRank(5,1,"+35 Speed; total +4 Dagger/Knuckles; 2.5% chance for 1,350 extra Gold on a humanoid kill; player Gold theft cap 4,500.", [
      specEffect("rogue_rank_5_combat", "+35 Speed; total +4 Dagger/Brass Knuckles Attack."),
      specEffect("rogue_humanoid_gold", "2.5% chance for 1,350 extra Gold when you defeat a humanoid."),
      specEffect("rogue_pvp_gold_theft", "Steal 9% of a defeated player's remaining Gold, up to 4,500.")
    ])
  ] },
  druid: { id: "druid", displayName: "Druid", gatewaySkillId: "tactics", gatewayStatus: "defined", minimumCharacterLevel: 9, status: "implemented", availability: "full_roster", ranks: [
    specRank(1,1,"Staff use without Kestrel; +26m Healing Aura range; Replenish transfers health for five Giving Berries.", [
      specEffect("druid_staff_permission", "Staff can be used without Kestrel training."),
      specEffect("druid_healing_aura", "+26m Healing Aura range."),
      specEffect("druid_replenish", "Replenish spends 5 Giving Berries at melee range, transfers 0.65 ally HP per 1 own HP (0.25 on Withered), and stops at 1 own HP; caster becomes aggressive.")
    ]),
    specRank(2,1,"Stored PvE Monster Attack cap increases to +4.5; Healing Aura heals Withered targets at 40%; pets rest at most 7 hours.", [
      specEffect("druid_tactics_max", "Stored PvE Monster Attack cap increases to +4.5."),
      specEffect("druid_healing_aura", "Healing Aura heals Withered targets at 40%."),
      specEffect("druid_pet_rest", "Pets rest at most 7 hours.")
    ]),
    specRank(3,1,"13% Dodge without Heavy/Shield; Replenish heals unwithered targets 0.95:1; pet Tactics sharing dormant.", [
      specEffect("druid_dodge", "13% Dodge without Heavy Armor or Shield."),
      specEffect("druid_replenish", "Replenish heals unwithered targets 0.95:1 (Withered targets stay at 0.25:1)."),
      specEffect("druid_pet_tactics", "With a staff, pets and minions share 45% of your stored Tactics.")
    ]),
    specRank(4,1,"Stored PvE Monster Attack cap increases to +5.5; Healing Aura heals Withered targets at 80%.", [
      specEffect("druid_tactics_max", "Stored PvE Monster Attack cap increases to +5.5."),
      specEffect("druid_healing_aura", "Healing Aura heals Withered targets at 80%.")
    ]),
    specRank(5,1,"Stored PvE Monster Attack cap increases to +7 and 27% Dodge without Heavy/Shield; Replenish heals unwithered targets 1.25:1; pet Tactics sharing dormant.", [
      specEffect("druid_rank_5_supported", "Stored PvE Monster Attack cap increases to +7; grants 27% Dodge without Heavy Armor or Shield."),
      specEffect("druid_replenish", "Replenish heals unwithered targets 1.25:1 (Withered targets stay at 0.25:1)."),
      specEffect("druid_pet_tactics", "With a staff, pets and minions share 85% of your stored Tactics.")
    ])
  ] },
  merchant: { id: "merchant", displayName: "Merchant", gatewaySkillId: "tactics", gatewayStatus: "defined", minimumCharacterLevel: 9, status: "implemented", availability: "full_roster", ranks: [
    specRank(1,1,"Pay 9 Gold x character level (level capped at 33) to maximize stored Tactics; Bazaar Stall costs 180 Silk (dormant).", [
      specEffect("merchant_maximize_tactics", "Pay 9 Gold x character level (level capped at 33) to fill stored Tactics to your current maximum."),
      specEffect("merchant_bazaar_stall", "Bazaar Stall costs 180 Silk. Dormant: needs authoritative tent placement and interaction rules.", "pending_dependency")
    ]), specRank(2,1,"Tactics max +4.5; trade-post tax reduced by 8% of the tax.", [
      specEffect("merchant_tactics_max", "Tactics max +4.5."),
      specEffect("merchant_trade_tax", "Trade-post tax reduced by 8% of the tax.")
    ]),
    specRank(3,1,"City travel cost -45%; Bazaar Stall costs 140 Silk. Both dormant.", [
      specEffect("merchant_city_trade_cost", "City travel cost -45%. Dormant: the server has no city travel cost to reduce.", "pending_dependency"),
      specEffect("merchant_bazaar_stall", "Bazaar Stall costs 140 Silk. Dormant: needs authoritative tent placement and interaction rules.", "pending_dependency")
    ]), specRank(4,1,"Tactics max +5.5; trade-post tax reduced by 20% of the tax.", [
      specEffect("merchant_tactics_max", "Tactics max +5.5."),
      specEffect("merchant_trade_tax", "Trade-post tax reduced by 20% of the tax.")
    ]),
    specRank(5,1,"Tactics max +7; trade-post tax reduced by 40% of the tax; Bazaar Stall costs 90 Silk (Bazaar Stall dormant).", [
      specEffect("merchant_tactics_max", "Tactics max +7."),
      specEffect("merchant_trade_tax", "Trade-post tax reduced by 40% of the tax."),
      specEffect("merchant_bazaar_stall", "Bazaar Stall costs 90 Silk. Dormant: needs authoritative tent placement and interaction rules.", "pending_dependency")
    ])
  ] },
  artificer: { id: "artificer", displayName: "Artificer", gatewaySkillId: "tactics", gatewayStatus: "defined", minimumCharacterLevel: 9, status: "implemented", availability: "full_roster", ranks: [
    specRank(1,1,"Extra crafting XP of 2.5% x character level (level capped at 33), weekly limit; Robot access. Dormant.", [
      specEffect("artificer_crafting_reward", "Extra crafting XP of 2.5% x character level (level capped at 33), with a weekly limit. Dormant: crafting has no shared profession-XP seam to extend.", "pending_dependency"),
      specEffect("artificer_constructs", "Robot access. Dormant: no construct system exists.", "pending_dependency")
    ]),
    specRank(2,1,"Tactics max +4.5; extra crafting XP of 4% x level; crafting time -9% (crafting XP dormant).", [
      specEffect("artificer_tactics_max", "Tactics max +4.5."),
      specEffect("artificer_crafting_reward", "Extra crafting XP of 4% x character level (level capped at 33), with a weekly limit. Dormant: crafting has no shared profession-XP seam to extend.", "pending_dependency"),
      specEffect("artificer_crafting", "Crafting time -9% (Kitchen, Loom and Tannery; the Furnace is not covered yet)."),
      specEffect("artificer_robot_bonus", "Robot +1 Attack/Defense. Dormant: no construct system exists.", "pending_dependency")
    ]),
    specRank(3,1,"Extra crafting XP of 9% x level; +1 bonus item per 6 bulk-crafted.", [
      specEffect("artificer_crafting_reward", "Extra crafting XP of 9% x character level (level capped at 33), with a weekly limit. Dormant: crafting has no shared profession-XP seam to extend.", "pending_dependency"),
      specEffect("artificer_crafting", "+1 bonus item per 6 bulk-crafted (Kitchen, Loom and Tannery; the Furnace is not covered yet)."),
      specEffect("artificer_robot_tactics", "Robot Tactics sharing. Dormant: no construct system exists.", "pending_dependency"),
      specEffect("artificer_gadgets", "Additional gadgets. Dormant: no construct system exists.", "pending_dependency")
    ]),
    specRank(4,1,"Tactics max +5.5; crafting time -18%.", [
      specEffect("artificer_tactics_max", "Tactics max +5.5."),
      specEffect("artificer_crafting", "Crafting time -18% (Kitchen, Loom and Tannery; the Furnace is not covered yet)."),
      specEffect("artificer_robot_bonus", "Robot +2 Attack/Defense. Dormant: no construct system exists.", "pending_dependency")
    ]),
    specRank(5,1,"Tactics max +7; crafting time -28%; +1 bonus item per 4 bulk-crafted.", [
      specEffect("artificer_tactics_max", "Tactics max +7."),
      specEffect("artificer_crafting", "Crafting time -28% and +1 bonus item per 4 bulk-crafted (Kitchen, Loom and Tannery; the Furnace is not covered yet)."),
      specEffect("artificer_robot_tactics", "Robot Tactics sharing. Dormant: no construct system exists.", "pending_dependency")
    ])
  ] },
  voyager: { id: "voyager", displayName: "Voyager", gatewaySkillId: "tactics", gatewayStatus: "defined", minimumCharacterLevel: 9, status: "implemented", availability: "full_roster", ranks: [
    specRank(1,1,"+9 land/water Speed; distant compass waypoints (to recorded locations); record a location for 9 refined oil.", [
      specEffect("voyager_speed", "+9 land/water Speed."),
      specEffect("voyager_travel", "Compass waypoints to any recorded location, and recording up to 5 locations to travel back to for 9 refined oil.")
    ]), specRank(2,1,"Tactics max +4.5; recenter territory in unowned land for 90 Stormfeathers (dormant).", [
      specEffect("voyager_tactics_max", "Stored PvE Monster Attack cap increases to +4.5."),
      specEffect("voyager_travel", "Recenter territory in unowned land for 90 Stormfeathers. Dormant: no territory recenter exists and the catalog has no Stormfeather item.", "pending_dependency")
    ]),
    specRank(3,1,"+18 land/water Speed; Tactics builds 1.35x faster with no player buildings visible; recording costs 6 oil.", [
      specEffect("voyager_speed", "+18 land/water Speed."),
      specEffect("voyager_isolated_tactics", "Tactics builds 1.35x faster with no player buildings visible (none within 280 m)."),
      specEffect("voyager_travel", "Recording a location costs 6 refined oil.")
    ]),
    specRank(4,1,"Tactics max +5.5; recenter territory for 45 Stormfeathers (dormant).", [
      specEffect("voyager_tactics_max", "Stored PvE Monster Attack cap increases to +5.5."),
      specEffect("voyager_travel", "Recenter territory in unowned land for 45 Stormfeathers. Dormant: no territory recenter exists and the catalog has no Stormfeather item.", "pending_dependency")
    ]),
    specRank(5,1,"Tactics max +7; +27 land/water Speed; Tactics builds 1.7x faster with no player buildings visible; recording costs 3 oil.", [
      specEffect("voyager_rank_5_supported", "Stored PvE Monster Attack cap increases to +7; grants +27 land/water Speed."),
      specEffect("voyager_isolated_tactics", "Tactics builds 1.7x faster with no player buildings visible (none within 280 m)."),
      specEffect("voyager_travel", "Recording a location costs 3 refined oil.")
    ])
  ] },
  // Free-switch test class (owner, 2026-10-21): no ranks, perks or stat changes. Exists so the Ronin sword combo
  // (attack profile "sword:ronin") can be equipped and unequipped; Warrior is its counterpart.
  ronin: { id: "ronin", displayName: "Ronin", gatewaySkillId: null, gatewayStatus: "defined", minimumCharacterLevel: 9, status: "implemented", availability: "launch", ranks: [] }
} as const satisfies Readonly<Record<SpecializationId, SpecializationDefinition>>;

export type ProfessionRankV3 = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
export type AlchemyRecipeDefinitionV3 = Readonly<{
  id: string;
  displayName: string;
  requiredAlchemyRank: ProfessionRankV3;
  status: "future_content";
  ingredientItemDefinitionIds: readonly string[];
  outputItemDefinitionId: string;
}>;

/**
 * Deliberately empty until Ash has canonical alchemy items. This stable registry
 * is the integration seam for future recipes; placeholder consumables must not
 * be added merely to populate it.
 */
export const ALCHEMY_RECIPE_DEFINITIONS_V3 = Object.freeze(
  [] as AlchemyRecipeDefinitionV3[]
);

export type WorldKnowledgeSkillDefinition = Readonly<{
  id: WorldKnowledgeSkillId;
  displayName: string;
  /** Discovery and ranking need at least this character level. */
  minimumCharacterLevel?: number;
  hiddenUntilDiscovered: true;
  progressionCurrency: "general_skill_points_after_discovery";
  status: ContentStatus;
  unlockRequirement: string;
  ranks: readonly Readonly<{
    rank: 1 | 2 | 3;
    cost: number;
    description: string;
    status: ContentStatus;
    /** Parts of this rank that are defined but not live yet (they depend on content that does not exist). */
    pending?: readonly string[];
  }>[];
}>;

/** discovery unlocks the skill, then each of 3 ranks costs 1 General Skill Point. */
const discoveredRanks = (ranks: readonly [
  Readonly<{ description: string; pending?: readonly string[] }>,
  Readonly<{ description: string; pending?: readonly string[] }>,
  Readonly<{ description: string; pending?: readonly string[] }>
]) => ranks.map((entry, index) => ({
  rank: (index + 1) as 1 | 2 | 3,
  cost: 1,
  description: entry.description,
  status: "implemented" as ContentStatus,
  ...(entry.pending ? { pending: entry.pending } : {})
})) as unknown as readonly Readonly<{ rank: 1 | 2 | 3; cost: number; description: string; status: ContentStatus; pending?: readonly string[] }>[];

const knowledgeRanks = (descriptions: readonly [string, string, string], status: ContentStatus) => [
  { rank: 1 as const, cost: 1, description: descriptions[0], status },
  { rank: 2 as const, cost: 1, description: descriptions[1], status },
  { rank: 3 as const, cost: 1, description: descriptions[2], status }
] as const;

export const WORLD_KNOWLEDGE_SKILL_DEFINITIONS = {
  tidecraft: { id: "tidecraft", displayName: "Tidecraft", hiddenUntilDiscovered: true, progressionCurrency: "general_skill_points_after_discovery", status: "implemented", unlockRequirement: "Present 20 Abyssal Orbs at a Drowned City site on the open sea", ranks: knowledgeRanks([
    "Dive Pearl Beds (1 pearl) and ride whirlpools; craft Undertow Snares and Tidewater Draughts; +2 Defense against Tide Wraiths and Drowned Citizens.",
    "45% chance of 2 pearls per dive; craft Stillwater Orbs (yours also block healing) and Free-Step Wards; +2 Attack against Tide Wraiths and Drowned Citizens.",
    "Always 2 pearls per dive; craft Mason's Tomes; Tidewater Draughts last 2.5 hours; +3 Defense and Attack against Tide Wraiths and Drowned Citizens; your snares spare allies and your wards protect only allies."
  ], "implemented") },
  rare_beast_mastery: { id: "rare_beast_mastery", displayName: "Rare Beast Mastery", hiddenUntilDiscovered: true, progressionCurrency: "general_skill_points_after_discovery", status: "implemented", unlockRequirement: "Reach level 27, then give 6 Wyrm Eggs plus 3 different trophies (Stormwing Talon, Chimera Horn, Patriarch Tusk, Elder Serpent Horn or Kraken Beak) at the Wyrm Nest in the Wyrm Hollow's Hatchery", ranks: discoveredRanks([
    { description: "Hatch and call the Ember Drake; craft Chain Mail and the Ranged Shield from Dragon Scales; +6 max health; +1 Defense against dragons." },
    { description: "Ember Drake stays out 40 minutes longer; +11 max health; +1 Attack against dragons." },
    { description: "Ember Drake stays out 75 minutes longer; +18 max health; +2 Defense and Attack against dragons." }
  ]) },
  wildkin_lore: { id: "wildkin_lore", displayName: "Hollin Lore", hiddenUntilDiscovered: true, progressionCurrency: "general_skill_points_after_discovery", status: "implemented", unlockRequirement: "Give 6 Giant Eggs plus 10 Cached Nuts, 2 Small Eggs, 2 Dryad Heartwood and 1 Beaver Pelt at a Hollin Hut (or the Giant Egg nest in the Eyrie's Nest Crown)", ranks: discoveredRanks([
    { description: "See and visit distant Hollin Huts on the World Map; 4% discount at hut shops." },
    { description: "Harvest guarded orchards without Hollin retaliation; 9% hut shop discount." },
    { description: "A Hollin helper follows you and forages; offer a berry to calm angry Hollins and lift your trade ban." }
  ]) },
  deepstone_lore: { id: "deepstone_lore", displayName: "Deepstone Lore", hiddenUntilDiscovered: true, progressionCurrency: "general_skill_points_after_discovery", status: "implemented", unlockRequirement: "Give 6 Raptor Scales plus 3 Troll Teeth, 3 Earthen Cores and 5 Crude Gems at the Scale Shrine in Fangrock Cavern", ranks: discoveredRanks([
    { description: "12% chance to double the yield when mining stone, ore, sulfur, coal or iron; see caves and mines outside your active circle.", pending: ["See mines outside your active circle (no mine locations exist yet)"] },
    { description: "22% double-yield; +2 Attack while near caves (140 m)." },
    { description: "28% double-yield; +2 Defense near caves (140 m); 0.85% chance of a rare find when mining." }
  ]) },
  grove_lore: { id: "grove_lore", displayName: "Grove Lore", hiddenUntilDiscovered: true, progressionCurrency: "general_skill_points_after_discovery", status: "implemented", unlockRequirement: "Give 28 Elder Acorns plus 2 Living Heartwood, 5 Dryad Blossoms and 10 Grave Vines to the Grove Hermit in Blightwood Grove", ranks: discoveredRanks([
    { description: "Healing aura for you and party members within 165 m while out of combat; control 1 tree companion; 6% chance to double wood and plant harvests." },
    { description: "Aura 240 m; control 3 tree companions; 11% double harvest; tended trees mature in 4 days instead of 6." },
    { description: "Aura 380 m; control 4 tree companions; 17% double harvest; pull saplings." }
  ]) },
  edict_stride: { id: "edict_stride", displayName: "Edict Stride", minimumCharacterLevel: 40, hiddenUntilDiscovered: true, progressionCurrency: "general_skill_points_after_discovery", status: "implemented", unlockRequirement: "Reach level 40, then offer 440 Edict Seals plus 5 Hangman's Ropes, 3 Barrow Torcs, 1 Reaper Shard and 1 Drowned Locket at the Verdict Altar in the Fallen Prison (after the Trifang Warden)", ranks: discoveredRanks([
    { description: "Active, targeted. After you use it the target has 12 s to move; once it does, it takes 4 damage per 100 m it travels for 6 s. Costs 2 Edict Seals. 2 min 15 s cooldown." },
    { description: "Rolls 4-9 (6.5 on average) damage per 100 m the target travels. 1 min 40 s cooldown." },
    { description: "9 damage per 100 m the target travels. 1 min 10 s cooldown." }
  ]) },
  field_engineering: { id: "field_engineering", displayName: "Field Engineering", hiddenUntilDiscovered: true, progressionCurrency: "general_skill_points_after_discovery", status: "implemented", unlockRequirement: "Offer 175 Forge Sparks at the Spark Forge in the Golem Forge hub (Lv 37 raid)", ranks: discoveredRanks([
    { description: "Build Healer and Reflection monoliths (540 m across, 20 h life). Healer heals allies 2.3x the Grove Lore aura; Reflection holds 7 debuffs instead of 3.", pending: ["Reflection effect"] },
    { description: "Build Gloom and Frenzy monoliths. Frenzy: allies +28% attack and allied Sieges +30% building damage.", pending: ["Gloom effect"] },
    { description: "Build Hunter and Fortified monoliths. Hunter: +27% Bricks and City Coins, +8% more for you. Fortified: allied structures take 45% less building damage." }
  ]) }
} as const satisfies Readonly<Record<WorldKnowledgeSkillId, WorldKnowledgeSkillDefinition>>;

export const LEGACY_EXECUTION_CLASSIFICATIONS = ["LIVE_V3", "LEGACY_EXECUTABLE", "LEGACY_INERT", "MIGRATION_ONLY"] as const;
export type LegacyExecutionClassification = (typeof LEGACY_EXECUTION_CLASSIFICATIONS)[number];
export const SKILL_SYSTEM_V3_EXECUTION_POLICY = Object.freeze({
  generalSkills: "LIVE_V3",
  v2NormalClassActives: "LEGACY_INERT",
  v2PassiveTierSelections: "LEGACY_INERT",
  explicitCompatibilityAllowlist: "LEGACY_EXECUTABLE",
  unclassifiedHistoricalTechniqueDefinitions: "LEGACY_INERT",
  migrationAliases: "MIGRATION_ONLY"
} as const satisfies Readonly<Record<string, LegacyExecutionClassification>>);

export type SkillSystemV3Snapshot = Readonly<{
  playerId: string;
  characterLevel: number;
  pointState: Readonly<{ totalEarned: number; totalSpent: number; available: number; revision: number }>;
  generalSkills: readonly Readonly<{ skillId: GeneralSkillId; rank: number; pointsSpent: number }>[];
  specializations: readonly Readonly<{ specializationId: SpecializationId; rank: number; pointsSpent: number; grandfathered: boolean; masteryQuestCompleted: boolean }>[];
  committedSpecializationId: SpecializationId | null;
  activeSpecializationId: SpecializationId | null;
  equippedClassTechniqueId: null;
  fullBuildRespecAvailable: boolean;
  fullClassRosterEnabled: boolean;
  ultimatesEnabled: boolean;
  generalActiveLoadout: GeneralActiveLoadout;
  ultimate: Readonly<{ id: string; specializationId: SpecializationId; status: "ready" | "cooldown" | "pending_design" }> | null;
  cooldownEndsAt: Readonly<Record<string, number>>;
  worldKnowledge: readonly Readonly<{ skillId: WorldKnowledgeSkillId; revealed: boolean; rank: number; pointsSpent: number }>[];
  serverTime: number;
  revision: number;
}>;

export function earnedSkillPointsForCharacterLevel(characterLevel: number): number {
  if (!Number.isInteger(characterLevel) || characterLevel < 1) throw new Error("character level must be a positive integer");
  return Math.min(characterLevel, SKILL_POINT_CHARACTER_LEVEL_CAP) * SKILL_POINTS_PER_CHARACTER_LEVEL;
}

export function requireGeneralSkillDefinition(skillId: string): SkillDefinition {
  const definition = GENERAL_SKILL_DEFINITIONS[skillId as GeneralSkillId];
  if (definition === undefined) throw new Error(`Unknown V3 general skill: ${skillId}`);
  return definition;
}

export function requireSpecializationDefinition(specializationId: string): SpecializationDefinition {
  const definition = SPECIALIZATION_DEFINITIONS[specializationId as SpecializationId];
  if (definition === undefined) throw new Error(`Unknown V3 specialization: ${specializationId}`);
  return definition;
}

/** Rogue: chance, on a humanoid kill that pays Gold, of extra Gold. */
export const ROGUE_HUMANOID_GOLD_PROC_CHANCE = 0.025;
/** Extra Gold of a Rogue humanoid-kill proc, by Rogue rank (index 0 = no rank). */
export const ROGUE_HUMANOID_GOLD_BY_RANK = [0, 450, 450, 900, 900, 1_350] as const;
/** Share of a defeated player's remaining Gold a Rogue (rank 2+) steals on top of the normal PvP death loss. */
export const ROGUE_PVP_THEFT_PERCENT = 9;
/** Most Gold one Rogue theft can take, by Rogue rank (index 0 = no rank; rank 1 steals nothing). */
export const ROGUE_PVP_THEFT_CAP_BY_RANK = [0, 0, 900, 900, 2_200, 4_500] as const;

function rogueRankIndex(rank: number): number {
  return Number.isInteger(rank) ? Math.min(5, Math.max(0, rank)) : 0;
}

export function rogueHumanoidGoldAmount(rank: number): number {
  return ROGUE_HUMANOID_GOLD_BY_RANK[rogueRankIndex(rank)] ?? 0;
}

/** Rogue PvP theft: 9% (rounded down) of the Gold the victim still has, capped by rank. */
export function rogueTheftAmount(rank: number, victimGoldRemaining: bigint): bigint {
  const cap = BigInt(ROGUE_PVP_THEFT_CAP_BY_RANK[rogueRankIndex(rank)] ?? 0);
  if (cap === 0n || victimGoldRemaining <= 0n) return 0n;
  const share = victimGoldRemaining * BigInt(ROGUE_PVP_THEFT_PERCENT) / 100n;
  return share < cap ? share : cap;
}

/**
 * Whether a class can be held on this server. The launch roster (Ronin, Warrior) always; the hidden classes only
 * with `fullClassRosterEnabled` (off in every deployed config; tests and developer tooling use it to keep the old
 * ranked classes reachable).
 */
export function isSpecializationAvailable(
  specializationId: SpecializationId,
  capabilities: SkillSystemV3RuntimeCapabilities = DEFAULT_SKILL_SYSTEM_V3_RUNTIME_CAPABILITIES
): boolean {
  return isLaunchSpecializationId(specializationId) || capabilities.fullClassRosterEnabled;
}

/** Free-switch classes (the launch roster): chosen, switched or dropped instantly with no rank or cost. */
export function isFreeSwitchSpecializationId(specializationId: SpecializationId): boolean {
  return isLaunchSpecializationId(specializationId);
}

/**
 * Whether a general skill is live on this server. The old combat disciplines (Cleave, Archery, Martial Arts,
 * Tactics) and every skill under them are hidden while new skills are built (owner, 2026-10-21), the same way the
 * old classes are: their rank rows stay, but they give no effect, take no Skill Points, and the points already spent
 * on them read as available again (skillAuthority). The five Trades stay live: they are crafting, repair, treasure
 * and shop-price perks, not combat skills. `fullClassRosterEnabled` (the hidden-class dev flag) brings them all back.
 */
export function isGeneralSkillAvailable(
  skillId: GeneralSkillId,
  capabilities: SkillSystemV3RuntimeCapabilities = DEFAULT_SKILL_SYSTEM_V3_RUNTIME_CAPABILITIES
): boolean {
  return GENERAL_SKILL_DEFINITIONS[skillId].category === "trade" || capabilities.fullClassRosterEnabled;
}

export function costForNextGeneralSkillRank(skillId: GeneralSkillId, currentRank: number): number | null {
  if (!Number.isInteger(currentRank) || currentRank < 0) throw new Error("current general skill rank must be a non-negative integer");
  return requireGeneralSkillDefinition(skillId).rankDefinitions[currentRank]?.cost ?? null;
}

export function costForNextSpecializationRank(specializationId: SpecializationId, currentRank: number): number | null {
  if (!Number.isInteger(currentRank) || currentRank < 0) throw new Error("current specialization rank must be a non-negative integer");
  return requireSpecializationDefinition(specializationId).ranks[currentRank]?.cost ?? null;
}

export function gatewaySatisfied(
  specializationId: SpecializationId,
  characterLevel: number,
  generalSkillRanks: Readonly<Partial<Record<GeneralSkillId, number>>>,
  grandfathered = false
): boolean {
  if (grandfathered || isStarterSpecializationId(specializationId)) return true;
  const definition = requireSpecializationDefinition(specializationId);
  if ((!isLaunchSpecializationId(specializationId) && characterLevel < definition.minimumCharacterLevel) || definition.gatewaySkillId === null) return false;
  return (generalSkillRanks[definition.gatewaySkillId] ?? 0) >= 3;
}

export function levelGateForNextSpecializationRank(currentRank: number): number | null {
  if (!Number.isInteger(currentRank) || currentRank < 0) throw new Error("current specialization rank must be a non-negative integer");
  return SPECIALIZATION_RANK_LEVEL_GATES[currentRank] ?? null;
}

export type SkillSystemV3CombatStats = Readonly<{
  maxHp: number;
  attack: number;
  defense: number;
  movementSpeed: number;
  attackRangeM: number;
  dodgeProbability: number;
  directHealingMultiplier: number;
  healingOverTimeMultiplier: number;
}>;

export type SkillSystemV3CombatEquipment = Readonly<{
  weaponProfile: PvpDamageWeaponProfileV3;
  bodyDefenseProfile: PvpDamageDefenseProfileV3;
  bodyArmorFamilyId?: string | null;
  shieldEquipped: boolean;
  martialArtsDodgeEligible: boolean;
}>;

export type SkillSystemV3RuntimeModifier = Readonly<{
  modifierId: string;
  description: string;
  value: number;
  unit: "flat_attack" | "flat_defense" | "probability_points" | "percentage_points" | "multiplier" | "tactics_cap";
  condition: string;
}>;

export type SkillSystemV3CombatModifierResolution = Readonly<{
  flatMaxHp: number;
  flatAttack: number;
  flatDefense: number;
  flatMovementSpeed: number;
  flatAttackRangeM: number;
  dodgeProbabilityPoints: number;
  directHealingMultiplier: number;
  healingOverTimeMultiplier: number;
  runtimeModifiers: readonly SkillSystemV3RuntimeModifier[];
}>;

/**
 * Resolves only modifiers whose conditions are present in a persisted snapshot and equipment.
 * Target, proximity, health-threshold, attack-delivery, Ward, and combat-event effects remain
 * explicit runtime metadata for the authoritative combat service to evaluate.
 */
export function resolveSkillSystemV3CombatModifiers(
  snapshot: SkillSystemV3Snapshot,
  equipment: SkillSystemV3CombatEquipment
): SkillSystemV3CombatModifierResolution {
  let flatMaxHp = rareBeastMasteryMaxHealthBonus(worldKnowledgeRank(snapshot, "rare_beast_mastery"));
  let flatAttack = 0;
  let flatDefense = 0;
  let flatMovementSpeed = 0;
  let flatAttackRangeM = 0;
  let dodgeProbabilityPoints = 0;
  const directHealingMultiplier = 1;
  const healingOverTimeMultiplier = 1;
  const runtimeModifiers: SkillSystemV3RuntimeModifier[] = [];
  const generalRank = (skillId: GeneralSkillId): number => snapshot.generalSkills.find((entry) => entry.skillId === skillId)?.rank ?? 0;
  const active = snapshot.activeSpecializationId === null
    ? null
    : snapshot.specializations.find((entry) => entry.specializationId === snapshot.activeSpecializationId) ?? null;

  const archeryRank = generalRank("archery");
  if ((equipment.weaponProfile === "longbow" || equipment.weaponProfile === "crossbow") && archeryRank > 0) {
    flatAttack += flatRankValue(ARCHERY_ATTACK_BY_RANK, archeryRank);
    flatAttackRangeM += archeryRank === 1 ? 0 : archeryRank === 2 ? 22 : 45;
  }
  const martialRank = generalRank("martial_arts");
  if ((equipment.weaponProfile === "shuriken" || equipment.weaponProfile === "blowdart") && martialRank > 0) flatAttack += flatRankValue(MARTIAL_RANGED_ATTACK_BY_RANK, martialRank);
  const generalMartialDodgeWeapon = ["unarmed", "martial_arts", "shuriken", "blowdart", "brass_knuckles"]
    .includes(equipment.weaponProfile);
  const tunicSpecializationDodgePermission =
    (active?.specializationId === "assassin" && equipment.weaponProfile === "dagger") ||
    (active?.specializationId === "monk" && equipment.weaponProfile === "sling");
  const tunicDodgePermission =
    equipment.bodyDefenseProfile === "martial_tunic"
    && !equipment.shieldEquipped
    && (generalMartialDodgeWeapon || tunicSpecializationDodgePermission);
  const rogueLeatherDodgePermission =
    active?.specializationId === "rogue"
    && equipment.bodyDefenseProfile === "leather"
    && !equipment.shieldEquipped;
  if (
    equipment.martialArtsDodgeEligible
    && (tunicDodgePermission || rogueLeatherDodgePermission)
    && martialRank >= 2
  ) {
    dodgeProbabilityPoints += martialRank >= 3 ? 0.28 : 0.14;
  }
  if (equipment.weaponProfile === "unarmed" && equipment.martialArtsDodgeEligible && martialRank >= 1) {
    const levelScaling = Math.min(snapshot.characterLevel, EQUIPMENT_LEVEL_CAP);
    flatAttack += levelScaling;
    flatDefense += levelScaling;
    runtimeModifiers.push({
      modifierId: "martial_arts_character_level_scaling",
      description: `Unarmed Attack and Defense scale from character level under compatible equipment rules, capped at level ${EQUIPMENT_LEVEL_CAP}.`,
      value: levelScaling, unit: "multiplier", condition: "authoritative martial equipment compatibility"
    });
  }
  const tacticsRank = generalRank("tactics");
  if (tacticsRank > 0) runtimeModifiers.push({
    modifierId: "tactics_pve_attack",
    description: "Apply stored Tactics as Monster Attack only to PvE damage.", value: tacticsRank, unit: "tactics_cap",
    condition: "current authoritative stored Tactics and PvE target"
  });

  const rank = Math.max(0, Math.min(5, active?.rank ?? 0));
  const weapon = equipment.weaponProfile;
  const body = equipment.bodyDefenseProfile;
  const addWeapon = (profile: PvpDamageWeaponProfileV3, amount: number): void => { if (weapon === profile) flatAttack += amount; };
  const totalAtRanks = (r1: number, r3 = r1, r5 = r3): number => rank >= 5 ? r5 : rank >= 3 ? r3 : rank >= 1 ? r1 : 0;

  switch (active?.specializationId) {
    case "warrior":
      flatMaxHp += rank * 9;
      addWeapon("axe", totalAtRanks(1, 2, 4));
      if (rank >= 2) runtimeModifiers.push({ modifierId: "warrior_low_health_melee", description: rank >= 5 ? "+3 melee Attack below 22% HP (with lower-rank thresholds resolved authoritatively)." : rank >= 4 ? "+2 Axe Attack below 33% HP and +1 melee Attack below 46% HP." : "+1 melee Attack below 46% HP.", value: rank >= 5 ? 3 : rank >= 4 ? 2 : 1, unit: "flat_attack", condition: "qualifying current HP threshold and melee attack" });
      break;
    case "knight":
      addWeapon("sword", totalAtRanks(1, 2, 4));
      if ((body === "breastplate" || equipment.bodyArmorFamilyId === "wyrm_scalemail") && rank >= 2) flatDefense += rank >= 5 ? 3 : rank >= 4 ? 2 : 1;
      if (equipment.shieldEquipped && rank >= 2) runtimeModifiers.push({ modifierId: "knight_ranged_shield_defense", description: "Shield Defense versus ranged weapon attacks.", value: rank >= 5 ? 3 : rank >= 3 ? 2 : 1, unit: "flat_defense", condition: "incoming ranged weapon attack" });
      break;
    case "legionnaire":
      addWeapon("spear", totalAtRanks(1, 2, 4));
      if (equipment.shieldEquipped && rank >= 2) flatDefense += rank >= 3 ? 2 : 1;
      if (equipment.shieldEquipped && rank >= 2) runtimeModifiers.push({ modifierId: "legionnaire_formation", description: "Fractional Shield Defense per nearby living party ally with Shield within 225m.", value: rank >= 5 ? 0.9 : rank >= 4 ? 0.65 : 0.4, unit: "flat_defense", condition: `per qualifying ally; maximum ${rank >= 5 ? 5 : rank >= 4 ? 3 : 2}` });
      break;
    case "ranger":
      addWeapon("longbow", totalAtRanks(1, 2, 4)); addWeapon("sword", totalAtRanks(1, 2, 4));
      flatMovementSpeed += rank >= 5 ? 9 : rank >= 2 ? 4 : 0;
      if (weapon === "longbow") flatAttackRangeM += rank >= 4 ? 40 : rank >= 2 ? 20 : 0;
      if (body === "leather" && !equipment.shieldEquipped && rank >= 3) runtimeModifiers.push({ modifierId: "ranger_leather_melee_defense", description: "Leather Defense versus melee, disabled with Shield.", value: rank >= 5 ? 3 : 1, unit: "flat_defense", condition: "incoming melee attack" });
      break;
    case "mercenary":
      addWeapon("spear", rank >= 5 ? 3 : rank >= 4 ? 2 : rank >= 1 ? 1 : 0); addWeapon("crossbow", rank >= 5 ? 3 : rank >= 3 ? 1 : 0);
      if (body === "leather" && !equipment.shieldEquipped && rank >= 3) flatDefense += 1;
      if (body === "leather" && !equipment.shieldEquipped && rank >= 5) runtimeModifiers.push({ modifierId: "mercenary_leather_melee_defense", description: "+1 additional Leather Defense versus melee without Shield.", value: 1, unit: "flat_defense", condition: "incoming melee attack" });
      if (rank >= 1) runtimeModifiers.push({ modifierId: "mercenary_momentum", description: "PvP only: sustained successful hits against the same player grant +1 Spear Attack per 80 seconds.", value: rank >= 5 ? 6 : rank >= 4 ? 4 : rank >= 3 ? 3 : 2, unit: "flat_attack", condition: "capped by Mercenary rank (+2/+3/+4/+6); resets on either death or 4.5 minutes without a successful hit" });
      break;
    case "sentinel":
      addWeapon("crossbow", totalAtRanks(1, 2, 4));
      if (rank >= 2) runtimeModifiers.push({ modifierId: "sentinel_heavy_ranged_defense", description: "Breastplate Defense versus ranged attacks.", value: rank >= 5 ? 4 : rank >= 4 ? 3 : 2, unit: "flat_defense", condition: "Breastplate and incoming ranged attack" });
      if (rank >= 2) runtimeModifiers.push({ modifierId: "sentinel_heavy_speed_penalty", description: "Reduce the base Breastplate movement penalty by percentage points.", value: rank >= 5 ? 6 : rank >= 4 ? 4 : 2, unit: "percentage_points", condition: "Breastplate base movement penalty" });
      if (rank >= 3) runtimeModifiers.push({ modifierId: "sentinel_anti_dodge", description: "Crossbow attacks subtract Dodge percentage points.", value: rank >= 5 ? 0.22 : 0.09, unit: "probability_points", condition: "qualifying Crossbow attack" });
      break;
    case "assassin":
      addWeapon("dagger", totalAtRanks(1, 2, 4)); addWeapon("blowdart", rank >= 5 ? 4 : rank >= 4 ? 2 : rank >= 2 ? 1 : 0);
      if (body === "martial_tunic" && rank >= 4) flatDefense += 1;
      break;
    case "ninja":
      addWeapon("shuriken", totalAtRanks(1, 2, 4)); flatMovementSpeed += rank >= 5 ? 27 : rank >= 4 ? 18 : rank >= 2 ? 9 : 0;
      dodgeProbabilityPoints += rank >= 5 ? 0.11 : rank >= 4 ? 0.07 : rank >= 2 ? 0.04 : 0;
      break;
    case "monk":
      addWeapon("staff", totalAtRanks(1, 2, 4)); addWeapon("sling", totalAtRanks(1, 2, 4));
      if (body === "martial_tunic" && rank >= 2) flatDefense += rank >= 5 ? 4 : rank >= 4 ? 3 : 2;
      if (rank >= 1) runtimeModifiers.push({ modifierId: "monk_balsam_resin_recovery", description: "While nonaggressive, Giving Berry completes exactly six ticks and heals exactly 24 HP at 1.25x tick cadence (1.55x at rank 3, 1.8x at rank 5).", value: 1.25, unit: "multiplier", condition: "nonaggressive Giving Berry recovery" });
      if (rank >= 2) runtimeModifiers.push({ modifierId: "monk_enemy_speed_aura", description: "Reduce hostile movement Speed within 180m; never allies.", value: rank >= 5 ? 0.87 : rank >= 4 ? 0.92 : 0.96, unit: "multiplier", condition: "hostile entity within 180m" });
      break;
    case "rogue":
      addWeapon("dagger", totalAtRanks(1, 2, 4)); addWeapon("brass_knuckles", totalAtRanks(1, 2, 4)); flatMovementSpeed += rank * 7;
      break;
    case "druid":
      if (rank >= 1 && weapon === "staff") runtimeModifiers.push({ modifierId: "druid_staff_permission", description: "Staff use does not require Kestrel training.", value: 1, unit: "multiplier", condition: "Staff equipped" });
      if (!equipment.shieldEquipped && body !== "breastplate" && body !== "chainmail" && equipment.bodyArmorFamilyId !== "wyrm_scalemail" && rank >= 3) dodgeProbabilityPoints += rank >= 5 ? 0.27 : 0.13;
      if (rank >= 2) runtimeModifiers.push({ modifierId: "druid_tactics_cap", description: "Druid stored PvE Monster Attack cap.", value: rank >= 5 ? 7 : rank >= 4 ? 5.5 : 4.5, unit: "tactics_cap", condition: "authoritative stored Tactics" });
      break;
    case "merchant": case "artificer":
      if (rank >= 2) runtimeModifiers.push({ modifierId: `${active.specializationId}_tactics_cap`, description: "Specialization Tactics maximum.", value: rank >= 5 ? 7 : rank >= 4 ? 5.5 : 4.5, unit: "tactics_cap", condition: "authoritative Tactics accumulation" });
      break;
    case "voyager":
      flatMovementSpeed += rank >= 5 ? 27 : rank >= 3 ? 18 : rank >= 1 ? 9 : 0;
      if (rank >= 2) runtimeModifiers.push({ modifierId: "voyager_tactics_cap", description: "Voyager stored PvE Monster Attack cap.", value: rank >= 5 ? 7 : rank >= 4 ? 5.5 : 4.5, unit: "tactics_cap", condition: "authoritative stored Tactics" });
      break;
  }
  return { flatMaxHp, flatAttack, flatDefense, flatMovementSpeed, flatAttackRangeM, dodgeProbabilityPoints, directHealingMultiplier, healingOverTimeMultiplier, runtimeModifiers };
}

/** Rare Beast Mastery max health by rank (each rank's total, not cumulative). */
export const RARE_BEAST_MASTERY_MAX_HEALTH = [0, 6, 11, 18] as const;

export function rareBeastMasteryMaxHealthBonus(rank: number): number {
  return RARE_BEAST_MASTERY_MAX_HEALTH[Math.max(0, Math.min(3, Math.trunc(rank))) as 0 | 1 | 2 | 3];
}

export function worldKnowledgeRank(snapshot: Pick<SkillSystemV3Snapshot, "worldKnowledge">, skillId: WorldKnowledgeSkillId): number {
  return snapshot.worldKnowledge?.find((entry) => entry.skillId === skillId)?.rank ?? 0;
}

/**
 * Applies only the skill modifiers the combat engine does not resolve itself (movement, range,
 * dodge, healing). Flat Attack, flat Defense and Warrior max HP are intentionally NOT added: the
 * authoritative combat engine resolves them per readied weapon and attacker/target, so adding them
 * here as well would count each of them twice in PvE.
 */
export function applySkillSystemV3CombatStats(
  base: SkillSystemV3CombatStats,
  snapshot: SkillSystemV3Snapshot,
  equipment: SkillSystemV3CombatEquipment
): SkillSystemV3CombatStats {
  const modifiers = resolveSkillSystemV3CombatModifiers(snapshot, equipment);
  return {
    maxHp: base.maxHp,
    attack: base.attack,
    defense: base.defense,
    movementSpeed: base.movementSpeed + modifiers.flatMovementSpeed,
    attackRangeM: base.attackRangeM + modifiers.flatAttackRangeM,
    dodgeProbability: Math.max(0, Math.min(1, base.dodgeProbability + modifiers.dodgeProbabilityPoints)),
    directHealingMultiplier: base.directHealingMultiplier * modifiers.directHealingMultiplier,
    healingOverTimeMultiplier: base.healingOverTimeMultiplier * modifiers.healingOverTimeMultiplier
  };
}
