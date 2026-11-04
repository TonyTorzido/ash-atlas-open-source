import type { InscriptionCounters } from "../inscriptionStats.js";
import {
  AGGRESSIVE_FLAG_TRAVEL_LOCK_MS,
  pvpDefeatSafetyRefusal,
  pvpStrikeBlockRefusal,
  isStillHandMonasteryZone,
  STILL_HAND_GRANTED_SKILL_RANKS,
  isDeerFamilyArchetype,
  isMobFamilyArchetype,
  isWolfFamilyArchetype,
  mobBehaviorArchetype,
  mobGimmickArchetype,
  mobMovementHabitat,
  WOLF_FAMILY_ARCHETYPES,
  CURRENT_LEVEL_CAP,
  EQUIPMENT_LEVEL_CAP,
  rareBeastDragonAttackBonus,
  rareBeastDragonDefenseBonus,
  worldKnowledgeRank,
  FLAG_ARRIVAL_PROTECTION_MS,
  BASIC_ATTACK_APPROACH_M,
  BASIC_ATTACK_INTERVAL_MS,
  beatAlignedAmountScale,
  beatAlignedIntervalMs,
  BASIC_ATTACK_RESET_COOLDOWN_GROUP,
  BASIC_ATTACK_RESET_COOLDOWN_MS,
  BASIC_ATTACK_RANGE_M,
  MELEE_ATTACK_RANGE_M,
  druidReplenishTransferRatio,
  MOB_ATTACK_HOLD_RANGE_BUFFER_M,
  RANGED_ATTACK_RANGE_M,
  COMBAT_CHASE_REEVALUATE_TICKS,
  DEFAULT_COMBAT_INTEREST_RADIUS_M,
  DEFAULT_COMBAT_SPATIAL_CELL_M,
  DEFAULT_PLAYER_SPEED_MPS,
  DEFAULT_PLAYER_BASIC_DAMAGE,
  DEFAULT_PLAYER_MAX_HEALTH,
  FRIENDLY_TARGET_RANGE_M,
  MAX_PVE_ENEMY_QUEUE_SIZE,
  PVE_AGGRO_ABANDON_TIMEOUT_MS,
  PVE_TURN_STEP_MS,
  PVP_BASE_BASIC_DAMAGE,
  WEAPON_SWITCH_DELAY_MS,
  WEAPON_SWITCH_HYSTERESIS_M,
  RESET_ACTIVE_IDS,
  TECHNIQUE_BY_ID,
  UNIVERSAL_TAUNT_COOLDOWN_MS,
  UNIVERSAL_TAUNT_ID,
  universalTauntRadiusM,
  HUNTER_BALANCE,
  BALSAM_RESIN_HEAL_PER_TICK,
  BATTLE_DRAUGHT_ATTACK_BONUS,
  TACTICS_CAP_BY_RANK,
  TACTICS_GAIN_BY_RANK,
  VIGOR_SERUM_MAX_HEALTH_BONUS,
  BATTLE_DRAUGHT_DEFENSE_PENALTY,
  BATTLE_DRAUGHT_ENGAGE_WINDOW_MS,
  BATTLE_DRAUGHT_HEALTH_COST_FRACTION,
  EMBER_FLASK_DAMAGE,
  EMBER_FLASK_RADIUS_M,
  NET_HOLD_MS,
  FREE_STEP_WARD_LIFETIME_MS,
  FREE_STEP_WARD_RADIUS_M,
  STILLWATER_ORB_HEAL_BLOCK_MIN_RANK,
  STILLWATER_ORB_RADIUS_M,
  STILLWATER_ORB_RANGE_M,
  STILLWATER_ORB_ROOT_MS,
  TIDECRAFT_ALLY_FILTER_MIN_RANK,
  TIDECRAFT_ATTACK_BONUS,
  TIDECRAFT_DEFENSE_BONUS,
  ALCHEMY_EMBER_DAMAGE_MULTIPLIER,
  ALCHEMY_EMBER_MIN_RANK,
  ALCHEMY_OPENED_GUARD_AMOUNT,
  ARCHERY_ATTACK_BY_RANK,
  HEROISM_BOSS_DEFENSE_BY_RANK,
  HEROISM_HERO_ATTACK_BY_RANK,
  MARTIAL_RANGED_ATTACK_BY_RANK,
  PROVOKE_DEFENSE_DEBUFF_BY_RANK,
  QUARRY_EXPOSED_DAMAGE_BONUS_BY_RANK,
  TAUNT_DEFENSE_BY_RANK,
  WAR_STANDARD_ATTACK_BY_RANK,
  flatRankValue,
  LEATHERWORKING_MATCHUP_BONUS,
  ALCHEMY_RESIN_MIN_RANK,
  ALCHEMY_RESIN_MULTIPLIER,
  LEATHERWORKING_ATTACK_MIN_RANK,
  LEATHERWORKING_DEFENSE_MIN_RANK,
  TIDECRAFT_MATCHUP_MOB_KEYS,
  UNDERTOW_SNARE_HOLD_M,
  UNDERTOW_SNARE_LIFETIME_MS,
  UNDERTOW_SNARE_PULL_INTERVAL_MS,
  UNDERTOW_SNARE_PULL_MPS,
  UNDERTOW_SNARE_RADIUS_M,
  NET_RANGE_M,
  TRAP_HOLD_MS,
  TRAP_LIFETIME_MS,
  TRAP_TRIGGER_RADIUS_M,
  type FieldBuffSnapshot,
  type FieldConsumableItemId,
  BALSAM_RESIN_TICK_INTERVAL_MS,
  balsamResinTickIntervalMs,
  balsamResinTickHeal,
  BALSAM_RESIN_TOTAL_TICKS,
  GIVING_TREE_AURA_HEAL,
  GIVING_TREE_AURA_INTERVAL_MS,
  GIVING_TREE_AURA_RADIUS_M,
  treeVarietyForStableId,
  PLAYER_RESPAWN_DELAY_MS,
  WARRIOR_BALANCE,
  WARRIOR_INNATE_BALANCE,
  NINJA_INNATE_BALANCE,
  CLASS_MASTERY_ATTACK_BY_RANK,
  CLASS_MASTERY_DEFENSE_BY_RANK,
  CLASS_MASTERY_RANGE_BONUS_M_BY_RANK,
  CLASS_XP_PER_TARGET_BASIC_HIT,
  CLASS_XP_POLICY_VERSION,
  warriorEffects,
  isHealthOnlyTechnique,
  isSingleTargetSupportTechnique,
  isSupportTechnique,
  classWeaponMode,
  classResourceId,
  damageFromStats,
  destinationPoint,
  EDICT_STRIDE,
  distanceMeters,
  millisecondsToTicks,
  edictStrideDamage,
  longitudeDeltaDegrees,
  moveToward,
  normalizeLongitude,
  preserveCurrentHealthPercentage,
  applyMaxHealthDebuff,
  effectiveMaxHealthPenalty,
  resolveDamageMatrixV1,
  resolveDamageMatrixV3,
  resolveV3DefenseProfileForEquipmentFamily,
  towerAttackDamageAgainstPlayer,
  warTowerArrowDamage,
  towerCombatSourceId,
  resolveV3WeaponProfileForEquipmentFamily,
  resolveMatchupDamage,
  mobMatchup,
  resolveDamageMatrixV4,
  resolveV4DefenseForEquipmentFamily,
  resolveV4WeaponProfileForEquipmentFamily,
  mobV4Profile,
  V3_BODY_PROFILE_TO_V4_ARMOUR,
  WEAPON_PROFILES_V4,
  EQUIPMENT_BASE_BASIC_ATTACK,
  type MobMatchup,
  type MobV4Profile,
  type PvpDamageWeaponProfileV3,
  type PvpDamageDefenseProfileV3,
  resolvePvpDamage,
  isEquipmentDefinitionId,
  isSpecializationAvailable,
  requireGeneralSkillDefinition,
  requireTechniqueDefinition,
  requireEquipmentDefinition,
  parseEquipmentEnhancement,
  mobMetalProcQuality,
  type ArmorCategory,
  type ClassCombatState,
  type ClassId,
  type ClassResourceId,
  type ClassSnapshot,
  type CombatActivityState,
  type CombatContext,
  type CombatEntityKind,
  type CombatEntitySnapshot,
  type CombatEvent,
  type CombatLifeState,
  type CombatStateBatch,
  type CompanionSpeciesId,
  type DogCompanionMode,
  type LatLon,
  type MobArchetypeKey,
  type MobAppearanceVariant,
  type MobChallengeTier,
  type PveCombatPhase,
  type PveCombatSessionSnapshot,
  type SubclassId,
  type TechniqueDefinition,
  type TechniqueWeaponRequirement,
  type WeaponCategory,
  type ReadiedWeaponSlot,
  type EquipmentSnapshot,
  type GeneralActiveLoadout,
  type GeneralSkillId,
  type BalsamResinEffectSnapshot,
  type BossEntityOwnership,
  type BossEncounterProjection,
  type BossCastSnapshot,
  type BossTelegraphGeometry,
  type MobBuffSnapshot,
  type BossLifecycleState,
  type HarmfulStatusId,
  type SkillSystemV3Snapshot,
  type SpecializationId,
  SWING_BUFFER_EARLY_TICKS,
  SWING_HITSTUN_TICKS,
  attackComboNextIndex,
  attackProfileForStyle,
  combatStyleFor,
  type CombatStyleId,
  attackProfileStep,
  attackStepCycleTicks,
  attackStepServerHitDelayTicks,
  swingEventAbilityId,
  type AttackProfile,
  type AttackSwingStep,
  MOB_MELEE_WINDUP_ANGLE_DEG,
  MOB_MELEE_WINDUP_ID,
  MOB_MELEE_WINDUP_MAX_RANGE_M,
  MOB_MELEE_WINDUP_MS,
  circleVsCircle,
  circleVsCone,
  circleVsRect,
  circleVsSegment,
  hurtShapeReachM,
  mobHurtRadiusM,
  MOB_HURT_RADIUS_MAX_M,
  PLAYER_HURT_RADIUS_M,
  MOB_MELEE_WINDUP_POINT_BLANK_M,
  MOB_MELEE_WINDUP_RANGE_SLACK_M,
  toLocalMeters,
  fromLocalMeters,
  type LocalMetersOut,
  MOB_RANGED_AIM_ID,
  MOB_RANGED_AIM_MS,
  MOB_RANGED_AIM_WIDTH_M,
  MOB_RHYTHM_OVERRIDES,
  MOB_ARCH_MAX_SPEED_SHARE,
  MOB_ARCH_SIGNATURE_LANDING_GAP_MS,
  MOB_ARCH_WAVE_MAX_MEMBERS,
  MOB_ARCH_READY_BAND_M,
  MOB_ARCH_CASTER_RANGED_TOKENS,
  MOB_TACTICS_RANGED_TOKENS,
  MOB_ARCHETYPE_RETREAT,
  MOB_SIGNATURES,
  MOB_TACTICS_WAIT_BAND_BASE_M,
  isMobSignatureAbilityId,
  type MobArchetypeId,
  type MobSignatureParams,
  MOB_TACTICS_ARRIVAL_GRACE_MS,
  MOB_TACTICS_ATTACK_VIEW_RADIUS_M,
  MOB_TACTICS_DASH_OUT_SLACK_M,
  MOB_TACTICS_ENGAGE_SEATS,
  MOB_TACTICS_MAX_PER_TICK,
  MOB_TACTICS_MAX_ROSTER,
  MOB_TACTICS_SEAT_HOLD_BONUS_MS,
  MOB_TACTICS_SLOT_LEASH_MARGIN_M,
  MOB_TACTICS_MELEE_REACH_M,
  MOB_TACTICS_MELEE_REACH_SLACK_M,
  mobTacticsEngageRadiusM,
  mobTacticsMeleeReachM,
  mobTacticsPackedSpacingM,
  mobTacticsWaitBandRadiusM,
  MOB_TACTICS_ENGAGE_SEATS_MAX,
  MOB_TACTICS_PACKED_GAP_M,
  MOB_TACTICS_BODY_GAP_M,
  MOB_TACTICS_STARVATION_MS,
  mobTacticsBodyWidthM,
  mobTacticsSpacingM,
  ringCapacity,
  minSlotAngleDeg,
  reachableArcHalfDeg,
  MOB_TACTICS_GRAB_MAX_RANGE_FACTOR,
  MOB_TACTICS_SLOT_ARRIVE_M,
  MOB_TACTICS_SLOT_REASSIGN_TICKS,
  MOB_TACTICS_STRAFE_SPEED_FACTOR,
  MOB_TACTICS_TARGET_SWAP_PENALTY_MS,
  deriveMobRhythm,
  scaleMobRhythm,
  clampMobTelegraphScale,
  jitteredCooldownMs,
  normalizeAngleDeg,
  tacticsHash01,
  tacticsMsToTicks,
  tacticsPool,
  tacticsRingRadiusM,
  tacticsTokenCost,
  SWING_LAG_COMP_MAX_MS,
  SWING_RANGE_M,
  SHOT_RANGE_M,
  shotProfileForWeapon,
  DEFAULT_HEAL_TARGET_SETTINGS,
  HOLY_ARC_XP_CREDIT_WINDOW_MS,
  holyArcHealAmount,
  holyArcHealsPlayer,
  resolveHolyArcPath,
  type HealTargetSettings,
  type HolyArcAllyRelation,
  type HolyArcLineEntry,
  type ShotProfile,
  type SwingComboIndex,
  type SwingRejectReason
} from "@ash-atlas/shared";
import { randomUUID } from "node:crypto";

import { PositionHistory, type PositionOut } from "./positionHistory.js";
import {
  MobTacticsCoordinator,
  assignRings,
  enforceMinSpacing,
  relaxSlotsInto,
  separationPush,
  steerStep,
  strafeDirection,
  strafeFlipTicks,
  type ArchetypeTacticsState,
  type MobTacticsState,
  type RingItem,
  type TokenLedger
} from "./mobTactics.js";
import {
  PACK_ORBIT_FLIP_MAX_MS,
  PACK_ORBIT_FLIP_MIN_MS,
  SIGNATURE_CANCEL_LOCKOUT_MS,
  SIGNATURE_LANE_SAMPLE_M,
  archetypeTokenCost,
  inLungeRearArc,
  parseArchetypesOnly,
  resolveArchetypeTactics,
  signatureCircleContains,
  signatureDrawnM,
  signatureConeContains,
  signatureDamageFactor,
  signatureKnockbackM,
  signatureLaneContains,
  signatureLaneLengthM,
  signatureDropsIn,
  signatureNeedsClearLane,
  signatureTriggerMaxM,
  volleyFacings
} from "./mobArchetypeSignatures.js";
import {
  collectShotLineEntries,
  createSwingTargetScratch,
  selectShotTarget,
  selectSwingTargets,
  type SwingCandidateSample
} from "./swingResolver.js";

import {
  normalizePlayerEquipmentCombatState,
  telemetryEquipmentState,
  type PlayerEquipmentCombatState
} from "./playerEquipmentCombatState.js";
export { playerEquipmentCombatStateFromSnapshot } from "./playerEquipmentCombatState.js";
export type { PlayerEquipmentCombatState } from "./playerEquipmentCombatState.js";

import { developmentCombatRules, type CombatRules } from "./combatRules.js";
import { resolveDodgeChance } from "./dodgeResolver.js";
import {
  GOBLIN_DEFENDER_ATTENTION_COOLDOWN_MS,
  GOBLIN_DEFENDER_CHATTER_CHANCE,
  GOBLIN_DEFENDER_CHATTER_INTERVAL_MS,
  GOBLIN_DEFENDER_OBSERVATION_CHANCE,
  GOBLIN_DEFENDER_OBSERVATION_DURATION_MS,
  GOBLIN_DEFENDER_OBSERVATION_RADIUS_M,
  GOBLIN_DEFENDER_OBSERVATION_ROLL_INTERVAL_MS,
  GOBLIN_DEFENDER_SPEECH_DURATION_MS,
  GOBLIN_DEFENDER_WANDER_PAUSE_MS,
  GOBLIN_DEFENDER_WANDER_RADIUS_M,
  goblinDefenderDialogueForRoll
} from "./goblinDefenderAmbient.js";
import {
  CombatTelemetryAccumulator,
  type CombatBalanceSummary,
  type CombatMitigationSource
} from "./combatTelemetry.js";
import {
  combatXpAnchor,
  COMBAT_ITEM_REWARD_POLICY_VERSION,
  mobDropsLeather,
  mobMovementSpeedMps,
  requireMobDefinition,
  resolveMobCombatProfile,
  WOLF_HOME_TOLERANCE_M,
  requireMobAiProfile,
  type MobAiIntent,
  type MobAiProfile
} from "./mobDefinitions.js";
import { DueTickScheduler, type ScheduledWork } from "./scheduler.js";
import {
  GOLEM_ARCHETYPES,
  GOLEM_FORGE_ARCHETYPES,
  IMMUNE_FEEDBACK_INTERVAL_MS,
  MENDER_HEAL,
  SMITH_REVIVE,
  SPARK_CHAIN,
  golemForgeSuppressesStrike,
  type GolemRubble,
  SENTINEL_HOME_RADIUS_M,
  SENTINEL_STATUE,
  SLAG_TRAIL,
  SPARK_WISP_BURST,
  isGemImmuneArchetype,
  newGolemForgeMobState,
  slagTrailDue,
  weaponCarriesGem,
  type GolemForgeMobState
} from "./golemForgeMobs.js";
import { SpatialHashGrid } from "./spatialGrid.js";
import {
  BLIGHTED_STAG,
  BLIGHT_SPRITE,
  ACID_ZONE_DESIGN_TICK_MS,
  acidZoneTickDamageScale,
  BLIGHT_TREANT,
  THORNFERN,
  chargeLengthTo,
  isStunned,
  packDamageFactor,
  shouldStagCharge,
  treantMayRegenerate,
  CARRION_SCREECH_RADIUS_M,
  CLIFF_HAWK,
  NEST_MOUSE_HOP,
  NEST_MOUSE_SLOW,
  hawkClimbDestination,
  hawkKeepsRange,
  shouldScreech,
  shouldStartHawkDive,
  CAVE_BAT_HOP,
  CAVE_RAPTOR_POUNCE,
  RAPTOR_FAMILY,
  RAPTOR_RUNT,
  RAPTOR_SPITTER,
  WAR_ROAR_DAMAGE_MULTIPLIER,
  caveBatLifesteal,
  flankSlotPosition,
  isWarRoared,
  runtFleeDestination,
  shouldRuntFlee,
  shouldSpit,
  shouldSpitterBackOff,
  spitterBackoffDestination,
  type AcidZone,
  type HopProfile,
  DUNE_TICK_HOP,
  SEWER_SPIDER_WEB,
  SHELLBACK_TURTLE,
  fleaHopCandidates,
  fleaLeapDue,
  isRetreatingToGuard,
  isShelled,
  newMobSpecialState,
  POISON_BITE_CHANCE,
  SPIDERLING_RETREAT,
  shouldSpiderlingRetreat,
  shouldWebTarget,
  shouldWithdrawIntoShell,
  spiderlingSwarmDamageFactor,
  SPIDERLING_SWARM,
  HOG_CHARGE,
  DODGE_REWARD,
  HOG_CHARGE_ANIMAL,
  type ChargeProfile,
  type MobSpecialState,
  type PendingBasicStrike,
  type PendingSignature
} from "./mobSpecialBehaviors.js";
import {
  BELL_SPIRIT_TOLL,
  INITIATE_MONK_COMBO,
  IRON_STATUE,
  MONASTERY_MOB_ARCHETYPES,
  SHADOW_ACROBAT,
  STAFF_ADEPT_SWEEP,
  behindTarget,
  countAcrobatHit,
  countComboHit,
  dashStop,
  isDisplacementImmune,
  isWindingUp,
  MONASTERY_MARTIAL_WEAPON_FAMILIES,
  newMonasteryMobState,
  shouldAwaken,
  type MonasteryMobState
} from "./monasteryBehaviors.js";
import {
  EMBER_SHADE_GRASP,
  EMBER_SHADE_WAIL,
  REVENANT_DOUBLE_STRIKE,
  REVENANT_FLANK_LUNGE,
  VAULT_MOB_ARCHETYPES,
  VAULT_MOVE_GAP_MS,
  WARDEN_CHARGE,
  WARDEN_HEARTBEAT,
  WARDEN_HEARTBEAT_TRAVEL_MS,
  WARDEN_SLAM,
  WARDEN_STRIKES,
  chooseWardenStrike,
  heartbeatContact,
  heartbeatFrontM,
  isVaultWarded,
  isVaultWindingUp,
  mayFlankLunge,
  newVaultMobState,
  vaultLaneLengthM,
  type RevenantPosition,
  type VaultMobState,
  type VaultStrikeKind
} from "./vaultBehaviors.js";
import {
  ALLIGATOR_DEATH_ROLL,
  BANDIT_BACKSTAB,
  BEAR_MAUL,
  BIRD_PROC,
  CRAB_SHELL,
  DARTER_BURST,
  GATE_WARDEN_RIFT,
  GATE_WARDEN_RIFT_CULTIST,
  INK_POOL_DRIFT,
  SHELLBACK_BLUNT,
  FROG_TONGUE,
  GOBLIN_BOMB,
  OGRE_SLAM,
  OPEN_ENDED_BUFF_MS,
  ORC_ENRAGE,
  SAP_CRAWLER_STICK,
  SEWER_RAT_SQUEAK,
  SICK_RAT_BURST,
  SKELETON_REASSEMBLE,
  SLIME_SPLIT,
  SLOW_STATUS_TECHNIQUE_ID,
  SQUID_INK,
  WOLF_HOWL,
  POUNCE,
  QUILL_ARCHETYPES,
  QUILL_REFLECT,
  hasOwnGimmick,
  hasShellGuard,
  SWOOP,
  bearMaulDamageFactor,
  deathRollBonusFactor,
  isAnimalMob,
  pounceReady,
  quillDamage,
  roarDamageMultiplier,
  shellGuardFor,
  belowHealthRatio,
  birdProcKind,
  deathRollPrimed,
  gimmickStrikeFor,
  isDeathRollBite,
  roarBuffKind,
  strikeInRange
} from "./mobGimmicks.js";
import {
  ASH_WYVERN,
  DRAKELING_SPIT,
  DRAKE_BROODGUARD,
  LAVA_SLIME_TRAIL,
  MAGMA_SALAMANDER
} from "./wyrmHollowBehaviors.js";
import { EquipmentWeaponProcResolver, type EquipmentProcResolution } from "./equipmentProc.js";
import { METAL_PROC_BALANCE, distinctArmorMetals, metalProcHandlers } from "./metalProcs.js";
import type { PartyAuthority } from "../party/PartyAuthority.js";
import { spawnCellForPoint } from "../collectibles.js";
import { RollingStats, type RollingStatsSummary } from "../../diagnostics/rollingStats.js";
import { packageIdForPosition, zoneIdForPosition } from "../spatialZones.js";
import type { KingdomCombatFootprint, KingdomCombatPerkEffects } from "../kingdomCombatPerks.js";

const JELLYFISH_RETREAT_DISTANCE_M = 650;
/** Design pulse: 5 poison damage every 2 s for 12 s. Ticks run on the beat (see `beatAlignedIntervalMs`). */
const HARMFUL_STATUS_PULSE_INTERVAL_MS = 2_000;
const HARMFUL_STATUS_DURATION_MS = 12_000;
const POISON_DAMAGE_PER_PULSE = 5;
/** Blight's design tick: its damage is spread over one tick per second of its duration. */
const V3_BLIGHT_TICK_MS = 1_000;
export const SICK_SEWER_RAT_POISON_CHANCE = 0.5;
const NINJA_INVISIBLE_KEY = "ninja_innate_invisible";
const V3_GENERAL_COOLDOWN_PREFIX = "v3:general:";
const V3_SHIELD_CHARGE_MOVEMENT_ID = "v3_general_shield_charge";
const V3_CLEANSE_IMMUNITY_ID = "v3_general_cleanse_immunity";
const V3_TAUNT_DEFENSE_ID = "v3_general_taunt_defense";
const V3_WAR_STANDARD_ID = "v3_general_war_standard";
const V3_BLIGHT_ID = "v3_general_blight_strike";
const V3_BLIGHT_IMMUNITY_ID = "v3_general_blight_immunity";
const V3_BLIGHT_ARM_WINDOW_MS = 18_000;
const V3_BLIGHT_IMMUNITY_MS = 270_000;
const V3_TAUNT_DEFENSE_MS = 36_000;
const V3_MONK_SLOW_AURA_RADIUS_M = 180;
const V3_WAR_STANDARD_DURATION_MS = 110_000;
const V3_WAR_STANDARD_KILL_REDUCTION_MS = 25_000;
const V3_QUARRY_EXPOSURE_ID = "v3_general_quarry_exposure";
const V3_PIERCE_ARMOR_COOLDOWN_MS = 170_000;
const V3_PURSUIT_DURATION_MS = 9_000;
const V3_PROVOKE_RANGE_M = 180;
const DEEPSTONE_ATTACK_MIN_RANK = 2;
const DEEPSTONE_DEFENSE_MIN_RANK = 3;
const DEEPSTONE_CAVE_BONUS_RADIUS_M = 140;
/** Monk (Kestrel Master): Staff/Sling hits stun for 5 s (4% ranks 2-3, 7% ranks 4-5), then 10 s immune (once per 15 s). */
const MONK_STUN = Object.freeze({ chanceByRank: [0, 0, 0.04, 0.04, 0.07, 0.07] as readonly number[], durationMs: 5_000, immunityMs: 10_000 });
const V3_PROVOKE_DEBUFF_MS = 9_000;
const V3_HUNTSMAN_DURATION_MS = 54_000;
const V3_MERCENARY_MOMENTUM_INTERVAL_MS = 80_000;
const V3_MERCENARY_MOMENTUM_INACTIVITY_MS = 270_000;
const V3_LEGIONNAIRE_FORMATION_RANGE_M = 225;
const V3_ASSASSIN_SURPRISE_COOLDOWN_MS = 18_000;
const V3_CLEAVE_RADIUS_M = 60;
const FORMER_ARMED_V2_TECHNIQUE_IDS: ReadonlySet<string> = new Set([
  "ranger_v2_threefold_volley",
  "ranger_v2_snare_shot",
  "ninja_v2_twin_fang",
  "ninja_v2_shuriken_fan"
]);
export { FLAG_ARRIVAL_PROTECTION_MS } from "@ash-atlas/shared";

export type PlayerCombatProfile = {
  playerId: string;
  maxHealth: number;
  currentHealth: number;
  baseAttackDamage: number;
  defense?: number;
  level?: number;
  persistenceVersion?: number;
  lifeState?: CombatLifeState;
  downedUntil?: number | null;
  deathPenaltyOperationKey?: string | null;
  respawnAvailableAt?: number | null;
};

/**
 * Host hook for the Expel metal. The host owns the long-range relocation (Manor
 * entrance, falling back to the respawn point) and refuses it inside dungeons.
 * `lethal` is true when the expel came from a killing blow (the victim then respawns at home).
 */
export type MetalExpelHandler = Readonly<{
  canExpel(playerId: string): boolean;
  expel(playerId: string, lethal: boolean): boolean | Promise<boolean>;
}>;

/** The Lich's combat stats, copied from its owner at the moment of death. */
export type LichCombatSnapshot = Readonly<{
  name: string;
  level: number;
  maxHealth: number;
  attack: number;
  defense: number;
  weaponProfile: PvpDamageWeaponProfileV3;
  weaponLevel: number;
  bodyProfile: Exclude<PvpDamageDefenseProfileV3, "shield" | "wyrm_shield">;
  bodyLevel: number;
  shieldProfile: "shield" | "wyrm_shield" | null;
  shieldLevel: number;
}>;

export type UndeadKind = "skeleton" | "lich";

/**
 * Host hook for Revenant Metal. The engine reports the two triggers; the host owns
 * spawning, upgrading, AI and persistence of the undead.
 */
export type RevenantMetalHandler = Readonly<{
  /** The owner landed a killing blow with a direct attack from a Revenant-infused weapon. */
  onRevenantWeaponKillingBlow(input: Readonly<{
    ownerPlayerId: string; position: LatLon; regionCode: string; zoneId: string;
  }>): void;
  /** The owner died wearing Revenant armor. */
  onRevenantArmorDeath(input: Readonly<{
    ownerPlayerId: string; deathOperationKey: string; position: LatLon; regionCode: string; zoneId: string;
    killerEntityId: string | null; snapshot: LichCombatSnapshot;
  }>): void;
}>;

export const REVENANT_METAL_SKELETON_TECHNIQUE_ID = "metal_revenant_skeleton";
export const REVENANT_METAL_LICH_TECHNIQUE_ID = "metal_revenant_lich";

export type MilitaryAttackInput = Readonly<{
  attackerPlayerId: string;
  targetEntityId: string;
  damage: number;
  rangeM: number;
  attackOrigin?: LatLon;
  sourceTechniqueId: string;
}>;

export type DirtyCombatProfile = PlayerCombatProfile & {
  persistenceVersion: number;
};

export type ReplenishPlan = Readonly<{
  casterId: string;
  targetId: string;
  casterBefore: number;
  targetBefore: number;
  casterAfter: number;
  targetAfter: number;
  casterProfile: DirtyCombatProfile;
  targetProfile: DirtyCombatProfile;
}>;

export function isAggressionTravelLocked(
  lastCombatAtMs: number | null | undefined,
  inCombat: boolean,
  now = Date.now(),
  lockDurationMs = AGGRESSIVE_FLAG_TRAVEL_LOCK_MS
): boolean {
  return inCombat || (
    lastCombatAtMs !== null &&
    lastCombatAtMs !== undefined &&
    now - lastCombatAtMs < lockDurationMs
  );
}

type Combatant = {
  entityId: string;
  kind: CombatEntityKind;
  originFlagId: string | null;
  /** The mob that called this one (a boss's adds, a Gate Warden's rift cultists); hosts scope it like its summoner. */
  summonedByEntityId?: string;
  archetypeKey: MobArchetypeKey | null;
  appearanceVariant: MobAppearanceVariant | null;
  name: string;
  level: number;
  challengeTier: MobChallengeTier | null;
  combatBalanceVersion: number | null;
  regionCode: string;
  zoneId: string;
  position: LatLon;
  homePosition: LatLon;
  populationCellId: string | null;
  packId: string | null;
  npcFaction: Readonly<{
    cityId: string;
    cityName: string;
    culture: "goblin";
    role: "basic" | "warrior" | "archer" | "healer";
    presentationKey: string;
    invulnerable: true;
    annexRadiusM: number;
  }> | null;
  companionOwnerPlayerId?: string | null;
  companionDogId?: string | null;
  companionSpecies?: CompanionSpeciesId | null;
  companionBaseMaxHealth?: number | null;
  companionMode?: DogCompanionMode | null;
  /**
   * Spawned by another entity or system (boss adds, raid defenders, minions, pets, helpers, split
   * children). Its settlement carries `summoned`, so it never drops a ring.
   */
  summoned?: boolean;
  /** A scripted spawn that pays nothing when killed: no XP, gold or drops, and it leaves no revivable rubble. */
  noRewards?: boolean;
  /** Revenant Metal undead fighting for a player. Never heals; never rewards its killer. */
  undead?: {
    ownerPlayerId: string;
    kind: UndeadKind;
    /** Skeleton level 1-6 (the Lich reports 1). */
    level: number;
    expiresAt: number;
    lich: LichCombatSnapshot | null;
  } | null;
  /** Players: max HP currently removed by the PvP death penalty. */
  maxHealthPenaltyApplied?: number;
  /** Players: kingdom perk effects resolved by the periodic kingdom sync (position-aware perks). */
  kingdomPerkEffects?: KingdomCombatPerkEffects;
  /** Players: the kingdom attack bonus currently folded into attackDamage / equipmentAttackAdjustment. */
  kingdomAttackApplied?: number;
  worldAi: boolean;
  mobAi: MobAiRuntime | null;
  jellyfishRuntime: JellyfishRuntime | null;
  /** Lazily created per-mob state for the Cistern Warrens archetype behaviors. */
  special?: MobSpecialState;
  /** Lazily created per-mob state for the Monastery of the Still Hand archetypes. */
  monastery?: MonasteryMobState;
  /** Lazily created per-mob state for the Tilted Vault story mobs (vaultBehaviors.ts). */
  vault?: VaultMobState;
  maxHealth: number;
  currentHealth: number;
  attackDamage: number;
  defense: number;
  equipmentCombatState: PlayerEquipmentCombatState | null;
  equipmentAttackAdjustment: number;
  equipmentDefenseAdjustment: number;
  attackIntervalTicks: number;
  attackRangeM: number;
  movementSpeedMps: number;
  leashRadiusM: number;
  retaliates: boolean;
  bossEventState: "dormant" | "active" | null;
  bossLifecycleState: BossLifecycleState | null;
  bossOwnership: BossEntityOwnership | null;
  lifeState: CombatLifeState;
  activityState: CombatActivityState;
  targetEntityId: string | null;
  nextEligibleAttackTick: number;
  scheduledAttackTick: number | null;
  attackScheduleGeneration: number;
  v2SkipNextAttackSourceId?: string;
  lifeGeneration: number;
  downedUntil: number | null;
  deathPenaltyOperationKey: string | null;
  respawnAvailableAt: number | null;
  populationAuthority: CombatPopulationAuthorityToken | null;
  revision: number;
  aggressiveUntilMs: number;
  lastChaseUpdateTick: number;
  chaseDestination: LatLon | null;
  accountId: string | null;
  connectionId: string | null;
  classRuntime: ClassCombatRuntime | null;
  aggroOwnerPlayerId: string | null;
  aggroOwnerSessionId: string | null;
  aggroOwnerSessionGeneration: number | null;
  aggroViewGeneration: number | null;
  tauntCooldownEndsAt: number;
  threatPriorityPlayerId: string | null;
  threatPriorityRemainingActions: number;
};

type MobAiRuntime = {
  phase: "idle" | "acquiring" | "observing" | "engaging" | "returning";
  intent: MobAiIntent | null;
  targetPlayerId: string | null;
  deadlineTick: number | null;
  deadlineAtMs: number | null;
  nextAmbientSpeechRollAtMs: number;
  ambientSpeech: { text: string; expiresAt: number } | null;
  observationCooldownUntilMs: number;
  wanderTarget: LatLon | null;
  nextWanderAtMs: number;
};

type JellyfishRuntime = {
  revision: number;
  stage: 1 | 2 | 3;
  retreatTriggered: boolean;
  secondRetreatTriggered: boolean;
  retreatsCompleted: 0 | 1 | 2;
  shadeEnabled: boolean;
  retreatPhase: "idle" | "preparing" | "moving" | "complete";
  retreatStartPosition: LatLon | null;
  retreatDestination: LatLon | null;
  retreatStartedAtMs: number | null;
};

export type PopulationMobCombatRuntimeState = Readonly<{
  schemaVersion: 1;
  revision: number;
  archetype: "jellyfish";
  currentHealth: number;
  maxHealth: number;
  position: LatLon;
  jellyfish: Readonly<{
    stage: 1 | 2 | 3;
    retreatTriggered: boolean;
    secondRetreatTriggered: boolean;
    retreatsCompleted: 0 | 1 | 2;
    shadeEnabled: boolean;
    retreatPhase: "idle" | "preparing" | "moving" | "complete";
    retreatStartPosition: LatLon | null;
    retreatDestination: LatLon | null;
    retreatStartedAtMs: number | null;
  }>;
}>;

export type PopulationMobRuntimeStateSink = (
  entityId: string,
  state: PopulationMobCombatRuntimeState
) => void;

const METAL_VENOM_POISON_ID = "metal_venom_poison";
const METAL_EMBER_BURN_ID = "metal_ember_burning";
const METAL_STORM_ID = "elemental_lightning_storm";
/** Mob fire-bird burn: a short fixed burn, unrelated to the Ember metal. */
const ELEMENTAL_BIRD_BURN = Object.freeze({ damagePerTick: 3, tickMs: 2_000, durationMs: 8_000 });

type CombatEffectKind =
  | "poison"
  | "burning"
  | "storm"
  | "gloom"
  | "bleed"
  | "healing_over_time"
  | "incoming_mitigation"
  | "outgoing_damage"
  | "defense_reduction"
  | "movement_slow"
  | "rage_generation"
  | "out_of_combat_movement"
  | "guard"
  | "bloodlust"
  | "queue_bleed"
  | "marked_quarry"
  | "hunter_snare"
  | "player_action_defense_reduction"
  | "healing_shield"
  | "concussed"
  | "rooted"
  | "flat_attack"
  | "flat_defense"
  | "cleanse_immunity"
  | "taunt_defense"
  | "blight"
  | "blight_immunity"
  | "quarry_exposure"
  | "provoke_exposure"
  | "intervene"
  | "whetted_defense"
  | "whetted_attack"
  | "immobilized"
  | "immobilize_immunity"
  | "stunned"
  | "stun_immunity"
  | "vengeance_mark";

type CombatEffect = {
  id: string;
  kind: CombatEffectKind;
  sourceTechniqueId: string;
  sourceEntityId: string;
  startTick: number;
  endTick: number;
  nextTick: number;
  stacks: number;
  maximumStacks: number;
  amount: number;
  remainingActions?: number;
  enemyIds?: string[];
  completedTicks?: number;
  resourceGranted?: boolean;
  remainingAmount?: number;
  /** Fraction of a point a beat-scaled periodic tick still owes; paid with the next tick. */
  amountCarry?: number;
  cleansable?: boolean;
  minor?: boolean;
  sourceClassId?: ClassId;
  sourceSubclassId?: SubclassId | null;
  sourceActionSequence?: number;
  controlTag?: "movement_impairing_cc";
  spreadApplied?: boolean;
};

type AttackResolutionContext = {
  damageEvent?: CombatEvent;
  presentationSourceEntityId?: string;
  resolvedTargetEntityId?: string;
  suppressed?: boolean;
  battleHardenedResolved?: boolean;
  battleHardenedMitigationRemaining?: number;
  juggernautResolved?: boolean;
  juggernautMitigationRemaining?: number;
  fixedFinalDamage?: number;
  /** Extra factor on basic-attack power (action combat swing combo step); 1 when absent. */
  damageMultiplier?: number;
};

type ClassCombatRuntime = {
  skillV3: SkillCombatRuntimeV3 | null;
  activeClassId: ClassId;
  resourceId: ClassResourceId;
  weaponMode: "ranged" | "melee" | null;
  masteryRank: number;
  subclassId: SubclassId | null;
  subclassMasteryRank: number;
  learned: Set<string>;
  equippedActives: Set<string>;
  equippedPassives: Set<string>;
  legacyIds: Set<string>;
  weaponCategory: WeaponCategory | null;
  armorCategory: ArmorCategory | null;
  weaponDefinitionId: string | null;
  chestDefinitionId: string | null;
  hasShield: boolean;
  heavyArmorPieces: number;
  rage: number;
  reservedRage: number;
  guard: number;
  bloodlust: number;
  queuedAbility: {
    abilityId: string;
    targetEntityId: string | null;
    queuedAtTick: number;
    reservedRage: number;
    activationCommitted?: boolean;
  } | null;
  cooldownEndsAt: Record<string, number>;
  effects: CombatEffect[];
  counters: Record<string, number | string | boolean>;
  lastCombatAtMs: number | null;
  combatGeneration: number;
  dirtyVersion: number;
};

type SkillCombatRuntimeV3 = {
  snapshotRevision: number;
  activeSpecializationId: SpecializationId | null;
  specializationRank: number;
  generalSkillRanks: Partial<Record<GeneralSkillId, number>>;
  generalActiveLoadout: GeneralActiveLoadout;
  /** World Knowledge rank for the vs-dragon bonuses. */
  rareBeastMasteryRank: number;
};

type PendingNormalAction =
  | { kind: "ability"; abilityId: string; targetEntityId?: string; targetMode?: AbilityTargetMode }
  | { kind: "taunt" };

type AbilityTargetMode = "hostile" | "friendly" | "self";

type PveCombatSession = {
  sessionId: string;
  generation: number;
  playerId: string;
  playerAggroActive: boolean;
  focusTargetEntityId: string | null;
  focusPackId: string | null;
  enemyQueue: string[];
  enemyIds: Set<string>;
  pursuingEnemyIds: Set<string>;
  tauntedEnemyIds: Set<string>;
  enemyQueueJoinedAtTick: Map<string, number>;
  queueCursor: number;
  phase: PveCombatPhase;
  playerTurnAnchorTick: number | null;
  nextBasicAttackTick: number | null;
  enemyActionAtTick: number | null;
  pendingNormal: PendingNormalAction | null;
  pendingResetAbilityId: string | null;
  pendingResetTargetEntityId: string | null;
  pendingResetTargetMode: AbilityTargetMode | null;
  pendingResetActionSequence: number | null;
  playerActionSequence: number;
  fortify: {
    remainingEnemyIds: Set<string>;
    remainingProtectedHits: number;
  } | null;
  telemetry: CombatTelemetryAccumulator;
  telemetryStartedAtMs: number;
  telemetryStartedAtTick: number;
  requestedEndReason: string | null;
  viewCenter: LatLon;
  viewRadiusM: number;
  viewGeneration: number;
  lastMeaningfulEngagementAtMs: number;
  lastTauntExcludedByCap: number;
  hadEnemyParticipation: boolean;
};

export type AuthoritativeCombatViewCircle = {
  anchorType?: "normal" | "flag";
  anchorId?: string;
  center: LatLon;
  radiusM: number;
  generation: number;
  eligibleRegionCodes?: readonly string[];
  eligibleZoneIds?: readonly string[];
};

type DefenseMitigation = Partial<Record<CombatMitigationSource, number>>;

type CombatDamageResolution = {
  context: CombatContext;
  damageBeforePowerScaling: number;
  powerMultiplier: number;
  finalDamage: number;
};

export type CombatAnalyticsEvent = Readonly<{
  kind: "damage_applied" | "defeat";
  context: CombatContext;
  actorId: string;
  actorKind: "player" | "mob" | "system";
  targetId: string;
  targetKind: "player" | "mob";
  actorLevel: number | null;
  targetLevel: number;
  actorClassId: string | null;
  actorSubclassId: string | null;
  targetClassId: string | null;
  targetSubclassId: string | null;
  actorWeaponInstanceId: string | null;
  damageBeforeMitigation: number | null;
  damageApplied: number | null;
  mitigationBySource: Readonly<Record<string, number>>;
  sourceTechniqueId: string | null;
  distanceM: number | null;
  targetHealthAfter: number;
}>;

export type CombatActionResult = {
  classCombat: ClassCombatState | null;
  pveCombat: PveCombatSessionSnapshot | null;
};

export type EquipmentCombatUpdateKind =
  | "kit_activation"
  | "readied_weapon"
  | "active_item_upgrade"
  | "direct_equipment"
  | "gear_scroll";

export type StagedEquipmentCombatUpdate = {
  requestId: string;
  kind: EquipmentCombatUpdateKind;
  state: PlayerEquipmentCombatState;
  /**
   * Max health with the new gear before Vigor Serum and the PvP penalty (the stats value
   * `updatePlayerPveStats` takes). When set, max HP is rebuilt from it at the tick boundary.
   */
  maxHealth?: number;
};

export type AppliedEquipmentCombatUpdates = {
  playerId: string;
  activationTick: number;
  updates: readonly StagedEquipmentCombatUpdate[];
  state: PlayerEquipmentCombatState;
};

export type DirtyClassRuntime = {
  playerId: string;
  version: number;
  skillV3: boolean;
  engagedTarget: Readonly<{ targetEntityId: string; expiresAt: number }> | null;
  activeClassId: ClassId;
  resourceId: ClassResourceId;
  resourceCurrent: number;
  resourceReserved: number;
  rage: number;
  rageReserved: number;
  queuedAbilityId: string | null;
  queuedTargetEntityId: string | null;
  queuedAtTick: number | null;
  cooldownEndsAt: Record<string, number>;
  statusEffects: CombatEffect[];
  counters: Record<string, number | string | boolean>;
  combatGeneration: number;
  lastCombatAt: number | null;
};

/** What the holy arc needs to know about one online player, pushed in by a periodic sync (healTargets.ts). */
export type HolyArcPlayerRelations = Readonly<{
  kingdomId: string | null;
  cityId: string | null;
  friendIds: ReadonlySet<string>;
  /** Kingdoms and cities at war with this player's kingdom or city. */
  enemyKingdomIds: ReadonlySet<string>;
  enemyCityIds: ReadonlySet<string>;
  settings: HealTargetSettings;
}>;

export type CombatEngineOptions = {
  tickRateHz: number;
  /** Per-item counters for inscribed equipment (in memory; the host flushes them in batches). */
  inscriptionStats?: InscriptionCounters;
  /** Injectable host clock; production uses wall time. */
  now?: () => number;
  /** Optional host controls. Their absence preserves ordinary live simulation. */
  mobAiEnabled?: () => boolean;
  isEntityInvulnerable?: (entityId: string) => boolean;
  /** Dev/e2e only: player hits on mobs are multiplied by this (DEV_PLAYER_DAMAGE_MULTIPLIER; default 1). */
  devPlayerDamageMultiplier?: number;
  /** Action combat (swing-to-hit) master flag, ACTION_COMBAT_ENABLED. Off or absent: every swing is rejected "disabled". */
  actionCombatEnabled?: () => boolean;
  /** CLERIC_ARC_ENABLED: a readied scepter casts the holy arc (heals allies on the line). Off or absent: it swings. */
  clericArcEnabled?: () => boolean;
  /**
   * Mob tactics sub-flag, MOB_TACTICS_ENABLED (docs/plans/mob-ai-phase1.md). Applies only while
   * `actionCombatEnabled` is also on. Off or absent: today's PvE queue, byte for byte.
   */
  mobTacticsEnabled?: () => boolean;
  /**
   * Damage matrix v4, DAMAGE_MATRIX_V4_ENABLED (docs/plans/class-roster-v2.md section 6): PvE, PvP and mob-versus-mob
   * hits use the v4 multipliers and the 5%-per-level rule. Off or absent: today's v3 table, byte for byte.
   */
  damageMatrixV4Enabled?: () => boolean;
  /**
   * Mob archetypes sub-flag, MOB_ARCHETYPES_ENABLED (docs/plans/mob-ai-phase2.md). Applies only while
   * action combat and mob tactics are also on. Off or absent: Phase 1 tactics, unchanged.
   */
  mobArchetypesEnabled?: () => boolean;
  /** Optional rollout list, MOB_ARCHETYPES_ONLY: comma list of archetype ids; empty or absent = every archetype. */
  mobArchetypesOnly?: () => string;
  /**
   * MOB_TELEGRAPH_SCALE (docs/plans/telegraph-time.md): multiplies every managed-mob windup and telegraph (basic
   * melee, ranged aim, swarm wave, every signature part) and the token fail-safe, clamped to 1-3. Applies only while
   * action combat and mob tactics are on (only managed mobs read it). Absent: 1.
   */
  mobTelegraphScale?: () => number;
  /**
   * True while the player's dash is still travelling (swings buffer until it lands). Absent: the
   * dash i-frame hook `isEntityInvulnerable` stands in for it.
   */
  isEntityDashing?: (entityId: string) => boolean;
  /**
   * Delivers the result of a swing that `resolveSwing` buffered (returned `buffered: true`): it
   * runs on a later tick inside `beginTick`, after the dash lands or the recovery ends, and its
   * result (resolved or rejected) arrives here exactly once, with the original seq and requestId.
   */
  onSwingResolved?: (playerId: string, result: SwingResolution) => void;
  playerMaxHealth?: number;
  playerAttackDamage?: number;
  playerMovementSpeedMps?: number;
  spatialCellSizeM?: number;
  interestRadiusM?: number;
  maxChasesPerTick?: number;
  /** Ceiling on managed mobs advanced by mob tactics per tick (round robin over target players). */
  maxTacticsPerTick?: number;
  rules?: CombatRules;
  isMobPositionTraversable?(position: LatLon, regionCode: string): boolean;
  resolveMobRetreatDestination?(input: Readonly<{
    entityId: string;
    archetype: MobArchetypeKey;
    anchor: LatLon;
    distanceM: number;
    retreatIndex: 1 | 2;
  }>): Promise<LatLon | null>;
  random?: () => number;
  equipmentProcResolver?: EquipmentWeaponProcResolver;
  isPlayerAuthorityActive?(playerId: string, accountId: string, connectionId: string): boolean;
  movePlayerToward?(playerId: string, target: LatLon): void;
  stopPlayer?(playerId: string): void;
  /** requireClearPath: the straight line to the target must be open too (pushes and pulls never cross a wall). */
  repositionPlayer?(playerId: string, target: LatLon, maximumDistanceM?: number, requireClearPath?: boolean): boolean;
  /**
   * killerPlayerId: the defeating player, or the owner of the undead that landed the blow.
   * goldEligible: the killer landed the killing blow themself (not undead, a military unit,
   * a tower, or the world), so the PvP death gold may move.
   */
  onPlayerDefeated?(
    playerId: string,
    deathId: string,
    killerPlayerId: string | null,
    details?: Readonly<{
      revenantArmor: boolean;
      /** The victim was killed by a player's inscribed weapon. */
      killedByInscription?: Readonly<{ wielderName: string; inscription: string }>;
      goldEligible?: boolean;
      /** The killing Mercenary's rank and Momentum stacks against the victim, for the kill XP. */
      mercenaryMomentum?: Readonly<{ rank: number; stacks: number }>;
    }>
  ): void;
  onPlayerRespawn?(playerId: string): LatLon | void;
  onCompanionHealthChanged?(event: Readonly<{
    ownerPlayerId: string;
    dogId: string;
    currentHealth: number;
    maxHealth: number;
    baseMaxHealth: number;
    defeated: boolean;
  }>): void;
  onDefeatSettlementCandidate?(
    candidate: CombatDefeatSettlementCandidate
  ): boolean | void | Promise<boolean>;
  onCombatSummary?(summary: CombatBalanceSummary): void;
  onCombatAnalyticsEvent?(event: CombatAnalyticsEvent): void;
  onHarmfulStatusDamage?(event: Readonly<{
    operationId: string;
    playerId: string;
    harmfulStatusId: HarmfulStatusId;
    appliedDamage: number;
  }>): void;
  onEquipmentCombatUpdatesApplied?(result: AppliedEquipmentCombatUpdates): void;
  onWeaponSwitchCompleted?(
    playerId: string,
    activeWeaponSlot: ReadiedWeaponSlot
  ): void;
  /** A buff that lives in the engine (Battle Draught) started or ended; the owner needs a fresh indicator. */
  onFieldBuffsChanged?(playerId: string): void;
  /** Tidecraft rank (0-3) of an online player, from a short cache. */
  tidecraftRank?(playerId: string): number;
  /** Deepstone Lore rank (0-3) of an online player, from a short cache. */
  deepstoneRank?(playerId: string): number;
  /** Whether a world position is within `radiusM` of a cave entrance. */
  isNearCave?(position: LatLon, radiusM: number): boolean;
  /** The Tidewater Draught is lost on death; the owner clears the stored buff. */
  onTidewaterLost?(playerId: string): void;
  /** Vigor Serum is lost on death; the owner clears the stored buff. */
  onVigorSerumLost?(playerId: string): void;
  onBalsamResinEffectFinished?(
    playerId: string,
    effectId: string,
    reason: "completed" | "death"
  ): void | Promise<void>;
  getAuthoritativeViewCircle?(playerId: string): AuthoritativeCombatViewCircle | null;
  isPlayerMobAttackAuthorized?(playerId: string, mobEntityId: string): boolean;
  /** Flat Attack and Defense a player has against monsters inside their current dungeon run (Challenger's Lantern). */
  dungeonLanternStatBonus?(playerId: string): Readonly<{ attack: number; defense: number }>;
  isMobPlayerAttackAuthorized?(mobEntityId: string, playerId: string): boolean;
  isSharedMobCombat?(mobEntityId: string): boolean;
  canMobProactivelyAcquire?(mobEntityId: string, playerId: string): boolean;
  canMobContinueIntent?(mobEntityId: string, playerId: string): boolean;
  /** Frenzy monolith attack bonus for a player (0.28 inside an allied Frenzy monolith's range, else 0). */
  getMonolithOutgoingDamageBonus?(playerId: string): number;
  getCityDistrictCombatBenefits?(playerId: string): Readonly<{
    directPveDamageBonus: number;
    pveDefenseBonus: number;
  }>;
  partyAuthority?: PartyAuthority;
  /**
   * Trust hostile-action gate (two-way PvP shield for accounts that are not
   * Settled). True refuses every player-versus-player hit, ability and effect.
   */
  isPvpBlocked?(attackerPlayerId: string, targetPlayerId: string): boolean;
  /**
   * PvP strike-block rule: remaining ms of the attacker's strike block against the
   * target when it refuses the attack (one swing used, the target has not
   * fought back, and the two are not fighting), else null.
   */
  pvpStrikeBlockMs?(attackerPlayerId: string, targetPlayerId: string): number | null;
  /** Display name for PvP refusal text. */
  pvpPlayerName?(playerId: string): string | null;
  /**
   * PvP strike-block rule: remaining ms of this player's post-kill safety (no player
   * may attack them unless they are Aggressive), else null.
   */
  pvpDefeatSafetyMs?(playerId: string): number | null;
  /** PvP strike-block rule: true while the two players are fighting (aggression up between them). */
  pvpIsFighting?(a: string, b: string): boolean;
  /**
   * A player landed damage on another player. aggressiveUntilMs is the
   * attacker's combat aggression expiry after this hit; targetAggressive is
   * whether the target was Aggressive when it landed (they hit back
   * automatically, so the strike starts a fight rather than a one-swing block).
   */
  onPvpHit?(attackerPlayerId: string, targetPlayerId: string, aggressiveUntilMs: number, targetAggressive: boolean): void;
  /** True when this player's friendly effects must not reach players fighting players. */
  isPvpSupportRestricted?(playerId: string): boolean;
};

/** Live, server-owned modifiers supplied by the shared boss encounter host. */
export type BossCombatModifiers = Readonly<{
  movementSpeedMps?: number;
  movementSpeedMultiplier?: number;
  outgoingDamageMultiplier?: number;
  incomingDamageMultiplier?: number;
}>;
export type BossCombatModifierProvider = (
  mobEntityId: string
) => BossCombatModifiers | null;

/**
 * Mob habitat surfaces for the combat tick. `surfaceAt` must be synchronous
 * and cheap (cache only; null when unknown); `prewarm` may fetch in the
 * background and is called once when a chase starts, never per tick.
 */
export type MobSurfaceLookup = Readonly<{
  surfaceAt(position: LatLon): "land" | "water" | null;
  prewarm(from: LatLon, to: LatLon): void;
}>;

export type CombatDeltaFrame = {
  serverTick: number;
  serverTime: number;
  dirtyEntityIds: ReadonlySet<string>;
  removedEntityIds: ReadonlySet<string>;
  events: CombatEvent[];
};

export type CombatInterestFrame = {
  nearbyIdsByPlayer: ReadonlyMap<string, ReadonlySet<string>>;
  cacheHits: number;
  cacheMisses: number;
};

export type CombatDefeatSettlementCandidate = {
  settlementKey: string;
  defeatedEntityId: string;
  defeatGeneration: number;
  eligibleParticipantIds: string[];
  contributions: Array<{ entityId: string; damage: number }>;
  serverTick: number;
  mobArchetype: MobArchetypeKey;
  bossOwnership?: BossEntityOwnership;
  mobLevel?: number;
  mobTier?: MobChallengeTier;
  mobBalanceVersion?: number;
  xpPolicyVersion?: number;
  itemRewardPolicyVersion?: number;
  targetBasicHitCount?: number;
  baseXpPool?: number;
  participantClassIds?: Record<string, ClassId>;
  classXpPolicyVersion?: number;
  baseClassXpPool?: number;
  defeatingPlayerId?: string;
  lootLocation?: Readonly<{
    regionCode: string;
    zoneId: string;
    position: LatLon;
  }>;
  populationAuthority?: CombatPopulationAuthorityToken;
  /** The defeated mob was summoned (see Combatant.summoned): no ring drop. */
  summoned?: boolean;
  /**
   * Golem Forge group gold bonus (1.4 to 2.55) on this kill's mob gold, frozen when the defeat is accepted
   * from the killer's party members present; absent means 1. Never applies to chest gold.
   */
  groupGoldMultiplier?: number;
};

export type CombatPopulationAuthorityToken = Readonly<{
  ownerToken: string;
  fencingGeneration: number;
  cutoverRevision: number;
}>;

/** One SWING press as the engine sees it (the runtime has already validated the schema). */
export type SwingInput = {
  /** Per-connection monotonic; a seq at or below the last accepted one is refused. */
  seq: number;
  /** World-space unit aim: east, north. */
  dirX: number;
  dirY: number;
  /** Client lag hint; clamped to SWING_LAG_COMP_MAX_MS before rewinding mob positions. */
  lagMs: number;
  /** Echoed in the result so a buffered swing's deferred result can be addressed. */
  requestId?: string;
  /** A new connection restarts the seq sequence (the client resets seq on reconnect). */
  connectionId?: string;
};

export type SwingHit = { entityId: string; damage: number; currentHealth: number };

/**
 * Outcome of a swing. `buffered: true` means nothing happened yet: the swing waits in the
 * player's single buffer slot (dash in flight, or pressed up to SWING_BUFFER_EARLY_TICKS early)
 * and its real result is delivered later through `CombatEngineOptions.onSwingResolved`.
 */
export type SwingResolution = {
  seq: number;
  requestId: string | null;
  serverTick: number;
  comboIndex: SwingComboIndex;
  /** Server epoch ms the next swing is accepted at. */
  nextSwingAtMs: number;
  hits: SwingHit[];
  rejected?: SwingRejectReason;
  buffered?: true;
};

type PendingSwing = {
  seq: number;
  dirX: number;
  dirY: number;
  lagMs: number;
  requestId: string | null;
  bufferedAtTick: number;
};

/** A swing with "contact" hit timing between press and contact: its hit lands on `dueTick` (attackProfiles.ts). */
type SwingWindup = {
  swing: PendingSwing;
  comboIndex: SwingComboIndex;
  step: AttackSwingStep;
  dueTick: number;
  /** What the swing was pressed with and where: a change before contact cancels the hit instead of landing it. */
  style: CombatStyleId;
  weaponInstanceId: string | null;
  regionCode: string;
  zoneId: string;
};

type PlayerSwingState = {
  lastSeq: number;
  connectionId: string | null;
  nextSwingTick: number;
  lastSwingAtMs: number;
  lastCombo: SwingComboIndex;
  pending: PendingSwing | null;
  /** At most one windup in flight: a step's cadence always outlasts its server windup. */
  windup: SwingWindup | null;
};

/** A buffered swing still waiting after this many ticks (2 s) is refused instead of resolved. */
const SWING_PENDING_MAX_TICKS = 40;
/** Extra grid query radius per rewound tick, so a mob that has since moved away is still a candidate (100 m/s). */
const SWING_REWIND_QUERY_MARGIN_M_PER_TICK = 5;

export type CombatMetrics = {
  currentServerTick: number;
  lastTickDurationMs: number;
  longestRecentTickMs: number;
  activeCombatants: number;
  activeEngagements: number;
  activeChases: number;
  /** Mob tactics: managed mobs and token points held (0 while MOB_TACTICS_ENABLED is off). */
  tacticsManaged: number;
  tacticsTokensInUse: number;
  dueAttacksProcessed: number;
  spatialGridQueries: number;
  dirtyCombatEntities: number;
  combatEventsEmitted: number;
  combatSnapshotsSent: number;
  combatDeltasSent: number;
  entitiesPerDelta: number;
  averageEntitiesPerDelta: number;
  maximumEntitiesPerDelta: number;
  aoiCacheHits: number;
  aoiCacheMisses: number;
  resyncRequests: number;
  persistenceDirtyCount: number;
  persistenceFailures: number;
  persistenceRetries: number;
  scheduledWorkCount: number;
  /** Action combat swings resolved (hit or miss), hits landed, swings refused, and resolve cost. */
  swingsResolved: number;
  swingHits: number;
  swingRejected: number;
  swingResolveMsMax: number;
  swingResolveMsTotal: number;
};

export type CombatValidationPredicate =
  | "self-attack"
  | "attacker-world-absent"
  | "target-world-absent"
  | "attacker-not-alive"
  | "target-not-alive"
  | "attacker-pending-defeat"
  | "target-pending-defeat"
  | "mob-retreating"
  | "attacker-authority-stale"
  | "target-authority-stale"
  | "pvp-region-mismatch"
  | "pvp-zone-mismatch"
  | "pvp-outside-authoritative-view"
  | "pvp-trust-shield"
  | "pvp-strike-block"
  | "pvp-defeat-safety"
  | "pve-outside-authoritative-view"
  | "pve-encounter-authority"
  | "target-flag-arrival-protected"
  | "non-player-region-mismatch"
  | "non-player-zone-mismatch"
  | "combat-rules";

export type CombatRequestErrorDetails = Readonly<{
  combatValidationPredicate?: CombatValidationPredicate;
  attackerId?: string;
  targetEntityId?: string;
  attackerZoneId?: string;
  targetZoneId?: string;
  attackerRegionCode?: string;
  targetRegionCode?: string;
  gameplayViewGeneration?: number;
  attackerInsideAuthoritativeView?: boolean;
  targetInsideAuthoritativeView?: boolean;
}>;

const PVP_SUPPORT_ENGAGEMENT_RADIUS_M = 100;
const OGRE_SWAMP_SHOUT_CHANCE = 0.01;
const OGRE_SWAMP_SHOUT_TEXT = "THIS IS MY SWAMP!";
const OGRE_SWAMP_SHOUT_DURATION_MS = 3_000;

export class CombatRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: CombatRequestErrorDetails = {}
  ) {
    super(message);
    this.name = "CombatRequestError";
  }
}

export class CombatEngine {
  private now(): number { return this.options.now?.() ?? Date.now(); }
  private readonly npcCityEnemyPlayers = new Map<string, Set<string>>();
  private readonly entities = new Map<string, Combatant>();
  private readonly linkDeadPlayerIds = new Set<string>();
  private readonly worldAbsentPlayerIds = new Set<string>();
  private readonly entityIdsByOriginFlag = new Map<string, Set<string>>();
  private readonly grid: SpatialHashGrid;
  private readonly givingTreeGrid: SpatialHashGrid;
  private readonly givingTreePositions = new Map<string, LatLon>();
  private readonly givingTreeSources = new Map<string, Map<string, LatLon>>();
  private readonly givingTreeReferenceCounts = new Map<string, number>();
  private readonly givingTreeAuraDueTicks = new Map<string, number>();
  private readonly balsamResinEffects = new Map<string, {
    effect: BalsamResinEffectSnapshot;
    nextTickIndex: number;
    nextTickAtMs: number;
    tickIntervalMs: number;
    /** Tick k is due at anchorMs + (k - anchorIndex) * tickIntervalMs, so lag never accumulates. */
    anchorMs: number;
    anchorIndex: number;
  }>();
  /** Battle Draught: lasts while the drinker stays Aggressive (engine memory only). */
  private readonly battleDraughts = new Map<string, { startedAtMs: number; engaged: boolean }>();
  /** Anti-Venom expiry per online player; the database row is the source of truth. */
  private readonly antiVenomUntilMs = new Map<string, number>();
  /** One Trap per player; traps do not survive a server restart. */
  private readonly fieldTraps = new Map<string, { position: LatLon; expiresAtMs: number }>();
  /** Tidewater Draught expiry per online player; the database row is the source of truth. */
  private readonly tidewaterUntilMs = new Map<string, number>();
  /** Vigor Serum: when it ends, and the max-health bonus currently added to the player. */
  private readonly vigorSerumUntilMs = new Map<string, number>();
  private readonly vigorSerumApplied = new Map<string, number>();
  /** Tidecraft fields, one of each per owner; they do not survive a server restart. */
  private readonly undertowSnares = new Map<string, TidecraftField>();
  private readonly freeStepWards = new Map<string, TidecraftField>();
  private readonly scheduler = new DueTickScheduler();
  private readonly pendingEquipmentCombatUpdates = new Map<
    string,
    { state: PlayerEquipmentCombatState; updates: StagedEquipmentCombatUpdate[] }
  >();
  private readonly activeChases = new Set<string>();
  private readonly pendingPlayerAttackApproachStops = new Map<string, string>();
  /** Victim player id -> attacker player id they auto-targeted by PvP auto-retaliation. */
  private readonly pvpAutoRetaliationTargets = new Map<string, string>();
  private readonly targetersByEntity = new Map<string, Set<string>>();
  private readonly dirtyEntityIds = new Set<string>();
  private immediateFlushPending = false;
  /**
   * Position history for lag-compensated swings: every mob position write records here, and every player move
   * synced through `syncPlayer` (the holy arc rewinds the allies it passes through the same way).
   */
  private readonly positionHistory = new PositionHistory();
  /** Holy arc: each online player's kingdom, city, friends, war enemies and heal-target settings (periodic sync). */
  private readonly holyArcRelations = new Map<string, HolyArcPlayerRelations>();
  /** Holy arc kill credit: mob id -> Cleric id -> healing given to allies fighting it, and when (ms) last. */
  private readonly holyArcHealCredits = new Map<string, Map<string, { amount: number; atMs: number }>>();
  /** Per-player action combat swing state, created on the first swing. */
  private readonly swingStates = new Map<string, PlayerSwingState>();
  /** Players holding a buffered swing (dash landing or early press), resolved in beginTick. */
  private readonly pendingSwingIds = new Set<string>();
  /** Players with a swing windup in flight ("contact" hit timing), landed in beginTick. */
  private readonly windupSwingIds = new Set<string>();
  private readonly swingTargets = createSwingTargetScratch();
  private readonly swingRewindPosition: PositionOut = { lat: 0, lon: 0 };
  private swingAttacker: Combatant | null = null;
  private swingSampleTick = 0;
  private readonly removedEntityIds = new Set<string>();
  private readonly pendingEvents: CombatEvent[] = [];
  private readonly knownEntityRevisionsByPlayer = new Map<string, Map<string, number>>();
  private readonly networkSequenceByPlayer = new Map<string, number>();
  private readonly forceSnapshotPlayers = new Set<string>();
  private readonly seenRequestTicks = new Map<string, number>();
  private readonly dirtyProfiles = new Map<string, DirtyCombatProfile>();
  private readonly profileVersions = new Map<string, number>();
  private readonly replenishReservations = new Set<string>();
  private readonly replenishStartedAtTick = new Map<string, number>();
  private readonly deferredReplenishEffects: Array<() => void> = [];
  private readonly contributionsByMob = new Map<string, Map<string, number>>();
  private readonly returningMobs = new Set<string>();
  private readonly retreatingMobs = new Set<string>();
  private readonly pendingMobRetreats = new Map<string, symbol>();
  private readonly pendingMobDefeats = new Map<string, symbol>();
  private readonly dirtyClassRuntimes = new Map<string, DirtyClassRuntime>();
  private readonly pveSessions = new Map<string, PveCombatSession>();
  /** Edict Stride marks by caster: waiting for the target to move, then damaging per metre moved. */
  private readonly edictStrides = new Map<string, {
    targetId: string; rank: number; armedUntil: number; activeUntil: number | null;
    last: LatLon; pendingDamage: number;
  }>();
  private readonly pveSessionGenerations = new Map<string, number>();
  private readonly flagArrivalProtectionUntilByPlayer = new Map<string, number>();
  private readonly flagArrivalProtectionRevisionByPlayer = new Map<string, number>();
  private readonly rules: CombatRules;
  private readonly equipmentProcResolver: EquipmentWeaponProcResolver;
  private expelHandler: MetalExpelHandler | null = null;
  private revenantMetalHandler: RevenantMetalHandler | null = null;
  /** Stored PvP max-HP penalties; the effective value recovers lazily from the anchor. */
  private readonly maxHealthPenalties = new Map<string, { penalty: number; recoveryAnchorMs: number }>();
  private readonly expelImmuneUntilMs = new Map<string, number>();
  private readonly classAbilityZones = new Map<string, {
    id: string;
    sourceEntityId: string;
    abilityId: string;
    position: LatLon;
    radiusM: number;
    endTick: number;
    nextTick: number;
    intervalTicks: number;
    amount: number;
    kind: "smoke" | "hostile" | "banner" | "trap";
    sourceActionSequence: number;
    enteredEntityIds: Set<string>;
    hitCounts: Map<string, number>;
    /** Fraction of a hostile tick's damage not yet dealt, per enemy. */
    carry: Map<string, number>;
  }>();
  private readonly attackIntervalTicks: number;
  private readonly pveTurnStepTicks: number;
  /** Action combat: ticks a melee mob's basic strike is telegraphed before it resolves. */
  private readonly meleeWindupTicks: number;
  private readonly meleeWindupLocal: LocalMetersOut = { x: 0, y: 0 };
  /**
   * Mobs whose wound-up strike lost its normal resolver (the mob left the session queue or the session
   * itself, e.g. the target dashed out of the view radius). `resolveOrphanedMeleeStrikes` still lands or
   * dodges each one on its due tick, so a telegraphed strike never vanishes silently.
   */
  private readonly orphanedMeleeStrikeMobIds = new Set<string>();
  /** Mob tactics (MOB_TACTICS_ENABLED): token ledgers and managed-mob state. Empty while the flag is off. */
  private readonly mobTactics: MobTacticsCoordinator;
  private readonly tacticsLocal: LocalMetersOut = { x: 0, y: 0 };
  private readonly tacticsArrivalGraceTicks: number;
  private readonly tacticsSwapPenaltyTicks: number;
  private readonly weaponSwitchDelayTicks: number;
  private readonly interestRadiusM: number;
  private eventSequence = 0;
  private populationMobRuntimeStateSink: PopulationMobRuntimeStateSink | null = null;
  private currentTick = 0;
  private tickStartedAt = 0;
  /** Last 60 s of tick durations at 20 Hz, for perf-server stats. */
  private readonly tickDurations = new RollingStats(1200);
  private chaseCursor = 0;
  private metrics: CombatMetrics;
  private bossEncounterProjectionProvider: ((entityId: string, recipientPlayerId?: string) => BossEncounterProjection | null) | null = null;
  private bossCombatModifierProvider: BossCombatModifierProvider | null = null;
  /** Told after every hit a boss mob survives (bossFramework notifyDamage); controllers react (Granite Bull monoliths heal). */
  private bossDamageListener: ((bossEntityId: string, amount: number, sourceEntityId: string) => void) | null = null;
  private mobCombatModifierProvider: BossCombatModifierProvider | null = null;
  private mobSurfaceLookup: MobSurfaceLookup | null = null;
  /** Cached "is a player building visible here" lookup for the Voyager isolated Tactics build speed. */
  private playerBuildingLookup: ((position: LatLon) => boolean) | null = null;
  private acidZones: AcidZone[] = [];
  /** Golem Forge per-mob runtime (golemForgeMobs.ts); dropped when the mob leaves the world. */
  private readonly golemForgeState = new Map<string, GolemForgeMobState>();
  /** Mobs scripted to take no damage (dormant husks, the possessing Corrupted Core); see setMobInvulnerable. */
  private readonly invulnerableMobs = new Set<string>();
  /** Mobs whose own basic attacks land nothing (the Corrupted Core); scripted damage and zones still land. */
  private readonly passiveMobs = new Set<string>();
  /** Golems that died in the last few seconds, for the Golem Smith's rebuild. */
  private golemRubble: GolemRubble[] = [];
  /** Mobs reflecting damage back at attackers (the Grandmaster's Crane glow): fraction reflected. */
  private readonly damageReflect = new Map<string, number>();
  /** Players silenced (no general actives) until this tick, by a Bell Spirit toll. */
  private readonly silencedUntilTick = new Map<string, number>();
  /** Telegraphs from ordinary mobs; carried by the source mob, or by nearby players once it is gone. */
  private mobCasts: { cast: BossCastSnapshot; sourceEntityId: string; zoneId: string }[] = [];

  constructor(private readonly options: CombatEngineOptions) {
    this.attackIntervalTicks = millisecondsToTicks(BASIC_ATTACK_INTERVAL_MS, options.tickRateHz);
    this.pveTurnStepTicks = millisecondsToTicks(PVE_TURN_STEP_MS, options.tickRateHz);
    this.meleeWindupTicks = millisecondsToTicks(MOB_MELEE_WINDUP_MS, options.tickRateHz);
    this.mobTactics = new MobTacticsCoordinator(options.tickRateHz, () => this.mobTelegraphScale());
    this.tacticsArrivalGraceTicks = tacticsMsToTicks(MOB_TACTICS_ARRIVAL_GRACE_MS, options.tickRateHz);
    this.tacticsSwapPenaltyTicks = tacticsMsToTicks(MOB_TACTICS_TARGET_SWAP_PENALTY_MS, options.tickRateHz);
    this.weaponSwitchDelayTicks = millisecondsToTicks(
      WEAPON_SWITCH_DELAY_MS,
      options.tickRateHz
    );
    this.interestRadiusM = options.interestRadiusM ?? DEFAULT_COMBAT_INTEREST_RADIUS_M;
    this.grid = new SpatialHashGrid(options.spatialCellSizeM ?? DEFAULT_COMBAT_SPATIAL_CELL_M);
    this.givingTreeGrid = new SpatialHashGrid(
      options.spatialCellSizeM ?? DEFAULT_COMBAT_SPATIAL_CELL_M
    );
    this.rules = options.rules ?? developmentCombatRules;
    this.equipmentProcResolver = options.equipmentProcResolver ??
      new EquipmentWeaponProcResolver(metalProcHandlers(), options.random ?? Math.random);
    this.metrics = this.emptyMetrics();
  }

  isPlayerReserved(playerId: string): boolean {
    return this.replenishReservations.has(playerId);
  }

  validateReplenishAuthority(playerId: string, accountId: string, connectionId: string): void {
    this.requirePlayerAuthority(this.requireEntity(playerId, "COMBAT_PLAYER_NOT_FOUND"), accountId, connectionId);
  }

  validateReplenishCandidate(input: {
    playerId: string; targetPlayerId: string; accountId: string; connectionId: string;
  }): void {
    this.planReplenish(input, false);
  }

  replenishActionState(playerId: string): CombatActionResult {
    return this.combatActionState(this.requireEntity(playerId, "COMBAT_PLAYER_NOT_FOUND"));
  }

  reserveReplenish(input: {
    playerId: string;
    targetPlayerId: string;
    accountId: string;
    connectionId: string;
  }): ReplenishPlan {
    return this.planReplenish(input, true);
  }

  private planReplenish(input: {
    playerId: string; targetPlayerId: string; accountId: string; connectionId: string;
  }, reserve: boolean): ReplenishPlan {
    const caster = this.requireEntity(input.playerId, "COMBAT_PLAYER_NOT_FOUND");
    this.requirePlayerAuthority(caster, input.accountId, input.connectionId);
    this.requireNotStunned(caster);
    const target = this.requireEntity(input.targetPlayerId, "COMBAT_TARGET_NOT_FOUND");
    const rank = caster.classRuntime?.skillV3?.activeSpecializationId === "druid"
      ? caster.classRuntime.skillV3.specializationRank : 0;
    if (rank < 1) throw new CombatRequestError("ABILITY_CLASS_INVALID", "Replenish requires an active Druid rank");
    if (caster.entityId === target.entityId || target.kind !== "player" ||
      caster.lifeState !== "alive" || target.lifeState !== "alive" ||
      !this.isValidNearbyVisibleAlly(caster, target, MELEE_ATTACK_RANGE_M)) {
      throw new CombatRequestError("ABILITY_FRIENDLY_TARGET_INVALID", "Replenish requires a living nearby party member");
    }
    const runtime = requireClassCombatRuntime(caster);
    if (Number(runtime.counters.abilityActivationLockoutEndsAt ?? 0) > this.now()) {
      throw new CombatRequestError("ABILITY_ACTIVATION_LOCKOUT", "Ability activation is locked briefly");
    }
    const definition = requireTechniqueDefinition("v3_druid_replenish");
    this.validateAbilityEquipment(caster, runtime, definition);
    if (reserve) this.requireImmediateAbilityWeaponReady(caster, target, definition);
    else if (caster.equipmentCombatState?.switchingToSlot &&
      this.desiredWeaponSlot(caster.equipmentCombatState,
        distanceMeters(caster.position, target.position), definition.weaponRequirement) !==
        caster.equipmentCombatState.activeWeaponSlot) {
      throw new CombatRequestError("WEAPON_SWITCH_IN_PROGRESS", "The required weapon is still being readied");
    }
    if (this.isPlayerReserved(caster.entityId) || this.isPlayerReserved(target.entityId)) {
      throw new CombatRequestError("ABILITY_PENDING", "One participant is resolving another action");
    }
    const missing = target.maxHealth - target.currentHealth;
    const available = caster.currentHealth - 1;
    const ratioTenths = Math.round(druidReplenishTransferRatio(rank, this.hasEffect(target, "gloom")) * 10);
    const spend = Math.min(available, Math.ceil(missing * 10 / ratioTenths));
    const heal = Math.min(missing, Math.floor(spend * ratioTenths / 10));
    if (spend <= 0 || heal <= 0) {
      throw new CombatRequestError("ABILITY_HEALTH_INSUFFICIENT", "Replenish needs missing target HP and spendable Druid HP");
    }
    const profile = (entity: Combatant, currentHealth: number): DirtyCombatProfile => ({
      playerId: entity.entityId,
      maxHealth: entity.maxHealth,
      currentHealth,
      baseAttackDamage: entity.attackDamage,
      lifeState: entity.lifeState,
      downedUntil: entity.downedUntil,
      deathPenaltyOperationKey: entity.deathPenaltyOperationKey,
      respawnAvailableAt: entity.respawnAvailableAt,
      persistenceVersion: (this.profileVersions.get(entity.entityId) ?? 0) + 1
    });
    if (reserve) {
      this.replenishReservations.add(caster.entityId);
      this.replenishReservations.add(target.entityId);
      this.replenishStartedAtTick.set(caster.entityId, this.currentTick);
      this.replenishStartedAtTick.set(target.entityId, this.currentTick);
    }
    return {
      casterId: caster.entityId, targetId: target.entityId,
      casterBefore: caster.currentHealth, targetBefore: target.currentHealth,
      casterAfter: caster.currentHealth - spend, targetAfter: target.currentHealth + heal,
      casterProfile: profile(caster, caster.currentHealth - spend),
      targetProfile: profile(target, target.currentHealth + heal)
    };
  }

  completeReplenish(plan: ReplenishPlan, versions?: Readonly<{ caster: number; target: number }>): void {
    try {
      if (!versions) return;
      for (const [playerId, health, version] of [
        [plan.casterId, plan.casterAfter, versions.caster],
        [plan.targetId, plan.targetAfter, versions.target]
      ] as const) {
        const player = this.entities.get(playerId);
        if (player?.kind !== "player") continue;
        player.currentHealth = health;
        this.profileVersions.set(playerId, version);
        this.dirtyProfiles.delete(playerId);
        this.markDirty(player);
      }
      const caster = this.entities.get(plan.casterId);
      if (caster) {
        caster.aggressiveUntilMs = Math.max(caster.aggressiveUntilMs, this.now() + AGGRESSIVE_FLAG_TRAVEL_LOCK_MS);
        this.emitEvent("DAMAGE", plan.casterId, plan.casterId, plan.casterBefore - plan.casterAfter, plan.casterAfter);
        this.emitEvent("HEAL", plan.casterId, plan.targetId, plan.targetAfter - plan.targetBefore, plan.targetAfter);
      }
    } finally {
      for (const playerId of [plan.casterId, plan.targetId]) {
        const started = this.replenishStartedAtTick.get(playerId);
        this.replenishStartedAtTick.delete(playerId);
        if (started === undefined) continue;
        const elapsed = this.currentTick - started;
        if (elapsed <= 0) continue;
        const runtime = this.entities.get(playerId)?.classRuntime;
        for (const effect of runtime?.effects ?? []) {
          if (effect.endTick !== Number.MAX_SAFE_INTEGER) effect.endTick += elapsed;
          if (effect.nextTick !== Number.MAX_SAFE_INTEGER) effect.nextTick += elapsed;
        }
        for (const zone of this.classAbilityZones.values()) {
          if (zone.sourceEntityId !== playerId) continue;
          zone.endTick += elapsed;
          zone.nextTick += elapsed;
        }
      }
      this.replenishReservations.delete(plan.casterId);
      this.replenishReservations.delete(plan.targetId);
      const deferred = this.deferredReplenishEffects.splice(0);
      for (const effect of deferred) effect();
    }
  }

  connectPlayer(input: {
    playerId: string;
    name: string;
    regionCode: string;
    zoneId: string;
    position: LatLon;
    accountId: string;
    connectionId: string;
    profile: PlayerCombatProfile;
  }): CombatEntitySnapshot {
    const existing = this.entities.get(input.playerId);
    if (existing?.kind === "player" && this.isPlayerReserved(input.playerId)) {
      this.deferredReplenishEffects.push(() => {
        const current = this.entities.get(input.playerId);
        const version = this.profileVersions.get(input.playerId) ?? input.profile.persistenceVersion;
        this.connectPlayer({ ...input, profile: {
          ...input.profile,
          currentHealth: current?.currentHealth ?? input.profile.currentHealth,
          ...(version === undefined ? {} : { persistenceVersion: version })
        } });
      });
      return this.snapshot(existing);
    }
    const maxHealth = positiveInteger(input.profile.maxHealth, this.options.playerMaxHealth ?? DEFAULT_PLAYER_MAX_HEALTH);
    const currentHealth = Math.max(0, Math.min(maxHealth, Math.trunc(input.profile.currentHealth)));
    const entity: Combatant = existing
      ? {
          ...existing,
          name: input.name,
          regionCode: input.regionCode,
          zoneId: input.zoneId,
          position: { ...input.position },
          homePosition: { ...input.position },
          level: input.profile.level ?? existing.level,
          maxHealth,
          currentHealth,
          attackDamage: positiveInteger(
            input.profile.baseAttackDamage,
            this.options.playerAttackDamage ?? DEFAULT_PLAYER_BASIC_DAMAGE
          ),
          defense: Math.max(0, Math.trunc(input.profile.defense ?? existing.defense)),
          accountId: input.accountId,
          connectionId: input.connectionId,
          deathPenaltyOperationKey: input.profile.deathPenaltyOperationKey ?? null,
          respawnAvailableAt: input.profile.respawnAvailableAt ?? null,
          revision: existing.revision + 1
        }
      : this.createPlayerCombatant(input, maxHealth, currentHealth);
    this.entities.set(entity.entityId, entity);
    this.grid.insert(entity.entityId, entity.position);
    // A (re)connect may land anywhere: start the lag-rewind history over from here.
    this.positionHistory.reset(entity.entityId);
    this.positionHistory.record(entity.entityId, this.currentTick, entity.position.lat, entity.position.lon);
    this.knownEntityRevisionsByPlayer.delete(entity.entityId);
    this.networkSequenceByPlayer.set(entity.entityId, 0);
    this.forceSnapshotPlayers.delete(entity.entityId);
    this.profileVersions.set(entity.entityId, input.profile.persistenceVersion ?? 0);
    if (input.profile.lifeState === "downed") {
      const downedUntil = input.profile.downedUntil ?? 0;
      if (downedUntil > this.now()) {
        entity.lifeState = "downed";
        entity.downedUntil = downedUntil;
        entity.lifeGeneration += 1;
        this.scheduler.schedule({
          dueTick: this.currentTick + millisecondsToTicks(downedUntil - this.now(), this.options.tickRateHz),
          kind: "downed-recovery",
          entityId: entity.entityId,
          generation: entity.lifeGeneration
        });
        this.options.stopPlayer?.(entity.entityId);
      } else {
        entity.lifeState = "alive";
        entity.downedUntil = null;
        entity.currentHealth = Math.max(1, Math.round(entity.maxHealth * 0.25));
      }
    } else if (input.profile.lifeState === "respawning" || entity.currentHealth <= 0) {
      entity.currentHealth = 0;
      entity.lifeState = "respawning";
      entity.deathPenaltyOperationKey ??= `player-death:${randomUUID()}`;
      entity.respawnAvailableAt ??= this.now();
      entity.lifeGeneration += 1;
      this.options.stopPlayer?.(entity.entityId);
    }
    this.markDirty(entity);
    this.rememberProfile(entity);
    return this.snapshot(entity);
  }

  rotatePlayerAuthority(
    playerId: string,
    accountId: string,
    connectionId: string
  ): CombatEntitySnapshot | null {
    const player = this.entities.get(playerId);
    if (!player || player.kind !== "player") return null;
    player.accountId = accountId;
    player.connectionId = connectionId;
    this.linkDeadPlayerIds.delete(playerId);
    if (this.worldAbsentPlayerIds.delete(playerId)) {
      this.grid.insert(playerId, player.position);
      this.removedEntityIds.delete(playerId);
      this.markDirty(player);
    }
    return this.snapshot(player);
  }

  suspendPlayerAuthority(playerId: string): void {
    const player = this.entities.get(playerId);
    if (!player || player.kind !== "player") return;
    this.linkDeadPlayerIds.add(playerId);
    this.pendingPlayerAttackApproachStops.delete(playerId);
    player.connectionId = null;
    this.invalidateScheduledAttack(player);
    this.clearTarget(player);
    const session = this.pveSessions.get(playerId);
    if (session) {
      session.pendingNormal = null;
      this.clearPendingEmpowerment(session);
      if (session.enemyQueue.length > 0) {
        session.phase = "enemy_pending";
        session.enemyActionAtTick ??= this.currentTick + 1;
      }
      this.noteSessionChanged(player, session);
    }
    this.cancelPendingEquipmentCombatUpdates(playerId);
    this.markDirty(player);
  }

  endLinkDeadWorldPresence(playerId: string): void {
    const player = this.entities.get(playerId);
    if (!player || player.kind !== "player") return;
    this.linkDeadPlayerIds.delete(playerId);
    this.worldAbsentPlayerIds.add(playerId);
    const session = this.pveSessions.get(playerId);
    if (session) session.requestedEndReason = "linkdead_presence_ended";
    this.endPveSession(player, true, "linkdead_presence_ended");
    this.invalidateMobAiPlayer(playerId);
    this.cancelTargeters(playerId);
    this.grid.remove(playerId);
    this.removedEntityIds.add(playerId);
  }

  updatePlayerPveStats(
    playerId: string,
    stats: { level: number; maxHealth: number; attackPower: number; defense: number },
    options: { preserveCurrentHealth?: boolean } = {}
  ): CombatEntitySnapshot | null {
    const player = this.entities.get(playerId);
    if (!player || player.kind !== "player") return null;
    if (this.isPlayerReserved(playerId)) {
      this.deferredReplenishEffects.push(() => { this.updatePlayerPveStats(playerId, stats, options); });
      return this.snapshot(player);
    }
    const previousMaxHealth = player.maxHealth;
    player.level = Math.max(0, Math.trunc(stats.level));
    player.maxHealth = this.penalizedMaxHealth(player, Math.max(
      1,
      Math.trunc(stats.maxHealth) + this.v3WarriorMaxHealthBonus(player.classRuntime?.skillV3 ?? null) +
        (this.vigorSerumApplied.get(playerId) ?? 0)
    ));
    // A staged scroll swap carries an absolute max health; these stats are newer (a level-up, a
    // class, skill or kingdom change), so the swap applies them instead of a stale value.
    for (const update of this.pendingEquipmentCombatUpdates.get(playerId)?.updates ?? []) {
      if (update.maxHealth !== undefined) update.maxHealth = Math.max(1, Math.trunc(stats.maxHealth));
    }
    // While a scroll swap waits for the tick, a refresh (which already sees the new gear) must not
    // scale current health up: swapping gear back and forth would heal.
    const swapPending = this.pendingEquipmentCombatUpdates.get(playerId)?.updates
      .some((update) => update.kind === "gear_scroll") ?? false;
    player.currentHealth = options.preserveCurrentHealth || swapPending
      ? Math.min(player.maxHealth, player.currentHealth)
      : preserveCurrentHealthPercentage(
          player.currentHealth,
          previousMaxHealth,
          player.maxHealth
        );
    player.attackDamage = Math.max(1, Math.trunc(stats.attackPower));
    // The fresh stats carry no Breach Company bonus; the next kingdom sync re-applies it.
    player.kingdomAttackApplied = 0;
    player.defense = Math.max(0, Math.trunc(stats.defense));
    if (player.equipmentCombatState) {
      player.equipmentAttackAdjustment =
        player.attackDamage -
        player.equipmentCombatState.stats.weaponAttackPower[
          player.equipmentCombatState.activeWeaponSlot
        ];
      player.equipmentDefenseAdjustment =
        player.defense - player.equipmentCombatState.stats.universalDefense;
      player.attackDamage = Math.max(
        1,
        Math.round(
          player.equipmentCombatState.stats.weaponAttackPower[
            player.equipmentCombatState.activeWeaponSlot
          ] + player.equipmentAttackAdjustment
        )
      );
    }
    this.markDirty(player);
    this.rememberProfile(player);
    return this.snapshot(player);
  }

  /** Live players' positions, for the periodic kingdom perk sync. */
  kingdomPerkFootprints(): KingdomCombatFootprint[] {
    const footprints: KingdomCombatFootprint[] = [];
    for (const entity of this.entities.values()) {
      if (entity.kind !== "player" || entity.lifeState !== "alive") continue;
      footprints.push({
        playerId: entity.entityId,
        lat: entity.position.lat,
        lon: entity.position.lon,
        regionCode: entity.regionCode
      });
    }
    return footprints;
  }

  /** Stores the kingdom perk effects the periodic sync resolved for a player. */
  setPlayerKingdomPerkEffects(playerId: string, effects: KingdomCombatPerkEffects): void {
    const player = this.entities.get(playerId);
    if (!player || player.kind !== "player") return;
    if (this.isPlayerReserved(playerId)) return; // retried by the next sync
    player.kingdomPerkEffects = effects;
    const delta = effects.attackBonus - (player.kingdomAttackApplied ?? 0);
    if (delta === 0) return;
    player.kingdomAttackApplied = effects.attackBonus;
    player.attackDamage = Math.max(1, player.attackDamage + delta);
    if (player.equipmentCombatState) player.equipmentAttackAdjustment += delta;
    this.markDirty(player);
  }

  /**
   * Installs the authoritative equipment runtime during connection or an
   * out-of-combat mutation. Existing resolved PvE stats remain authoritative;
   * their non-equipment delta is retained for later tick-boundary swaps.
   */
  syncPlayerEquipmentCombatState(
    playerId: string,
    state: PlayerEquipmentCombatState
  ): CombatEntitySnapshot | null {
    const player = this.entities.get(playerId);
    if (!player || player.kind !== "player") return null;
    const normalized = normalizePlayerEquipmentCombatState(state);
    const previousEquipmentState = player.equipmentCombatState;
    if (previousEquipmentState === null) {
      player.equipmentAttackAdjustment =
        player.attackDamage -
        normalized.stats.weaponAttackPower[normalized.activeWeaponSlot];
      player.equipmentDefenseAdjustment =
        player.defense - normalized.stats.universalDefense;
    }
    player.equipmentCombatState = normalized;
    player.attackDamage = Math.max(
      1,
      Math.round(
        normalized.stats.weaponAttackPower[normalized.activeWeaponSlot]
        + player.equipmentAttackAdjustment
      )
    );
    player.defense = Math.max(
      0,
      Math.round(
        normalized.stats.universalDefense + player.equipmentDefenseAdjustment
      )
    );
    if (player.classRuntime) {
      player.classRuntime.rage = Math.min(
        player.classRuntime.rage,
        this.classResourceMaximum(player)
      );
    }
    this.applyEquipmentClassIdentity(player, normalized);
    this.markDirty(player);
    return this.snapshot(player);
  }

  stageEquipmentCombatUpdate(
    playerId: string,
    update: StagedEquipmentCombatUpdate
  ): { staged: boolean; acceptedTick: number } {
    const requestId = requireBoundedStableId(update.requestId, "equipment request ID");
    const normalized: StagedEquipmentCombatUpdate = {
      requestId,
      kind: update.kind,
      state: normalizePlayerEquipmentCombatState(update.state),
      ...(typeof update.maxHealth === "number" && Number.isFinite(update.maxHealth)
        ? { maxHealth: Math.max(1, Math.trunc(update.maxHealth)) }
        : {})
    };
    const existing = this.pendingEquipmentCombatUpdates.get(playerId);
    const duplicate = existing?.updates.find((candidate) => candidate.requestId === requestId);
    if (duplicate && existing) {
      if (duplicate.kind !== normalized.kind) {
        throw new CombatRequestError(
          "EQUIPMENT_UPDATE_IDEMPOTENCY_CONFLICT",
          "Equipment update request ID was reused for another update kind"
        );
      }
      duplicate.state = normalized.state;
      if (normalized.maxHealth === undefined) delete duplicate.maxHealth;
      else duplicate.maxHealth = normalized.maxHealth;
      existing.state = normalized.state;
      return { staged: false, acceptedTick: this.currentTick };
    }
    if ((existing?.updates.length ?? 0) >= 16) {
      throw new CombatRequestError(
        "EQUIPMENT_UPDATE_QUEUE_FULL",
        "Too many equipment updates are awaiting the next combat tick"
      );
    }
    if (existing) {
      existing.state = normalized.state;
      existing.updates.push(normalized);
    } else {
      this.pendingEquipmentCombatUpdates.set(playerId, {
        state: normalized.state,
        updates: [normalized]
      });
    }
    return { staged: true, acceptedTick: this.currentTick };
  }

  cancelPendingEquipmentCombatUpdates(playerId: string): void {
    this.pendingEquipmentCombatUpdates.delete(playerId);
  }

  recordInvalidKitActivation(playerId: string): void {
    this.pveSessions.get(playerId)?.telemetry.recordInvalidKitActivation();
  }

  updatePlayerClassState(
    playerId: string,
    snapshot: ClassSnapshot,
    equipment: EquipmentSnapshot,
    persisted?: {
      activeClassId?: ClassId;
      resourceId?: ClassResourceId;
      resourceCurrent?: number;
      resourceReserved?: number;
      rage: number;
      rageReserved: number;
      queuedAbilityId: string | null;
      queuedTargetEntityId: string | null;
      queuedAtTick: number | null;
      cooldownEndsAt: Record<string, number>;
      statusEffects: unknown[];
      counters: Record<string, unknown>;
      combatGeneration: number;
      version?: number;
      lastCombatAt: number | null;
      savedAt?: number;
    }
  ): CombatEntitySnapshot | null {
    const player = this.entities.get(playerId);
    if (!player || player.kind !== "player") return null;
    const subclass = snapshot.subclasses.find((entry) => entry.subclassId === snapshot.activeSubclassId) as
      | ({ masteryRank?: number } & (typeof snapshot.subclasses)[number])
      | undefined;
    const previous = player.classRuntime;
    const loadout = snapshot.loadout as unknown as {
      resetActives?: readonly (string | null)[];
      normalActives?: readonly (string | null)[];
      passiveTiers?: readonly (string | null)[];
      baseActives?: readonly (string | null)[];
      basePassives?: readonly (string | null)[];
      subclassActive?: string | null;
      subclassPassives?: readonly (string | null)[];
      ultimateActive?: string | null;
    };
    const equippedActives = new Set([
      ...(loadout.resetActives ?? []),
      ...(loadout.normalActives ?? []),
      ...(loadout.baseActives ?? []),
      loadout.subclassActive ?? null,
      loadout.ultimateActive ?? null
    ].filter((id): id is string => id !== null));
    const equippedPassives = new Set([
      ...(loadout.passiveTiers ?? []),
      ...(loadout.basePassives ?? []),
      ...(loadout.subclassPassives ?? [])
    ].filter((id): id is string => id !== null));
    const activeProgress = snapshot.classes?.find((entry) => entry.classId === snapshot.activeClassId)
      ?? snapshot[snapshot.activeClassId]
      ?? snapshot.warrior;
    const classProgress = activeProgress as typeof activeProgress & { masteryRank?: number };
    const learnedTechniqueIds = (snapshot as ClassSnapshot & { learnedTechniqueIds?: readonly string[] })
      .learnedTechniqueIds ?? [...equippedActives, ...equippedPassives];
    const persistedCounters = persisted?.counters ?? previous?.counters ?? {};
    const savedTick = Number(persistedCounters.persistedServerTick ?? this.currentTick);
    const elapsedTicks = persisted?.savedAt
      ? Math.max(0, Math.floor((this.now() - persisted.savedAt) / 1_000 * this.options.tickRateHz))
      : 0;
    const restoredPersistentEffects = (persisted?.statusEffects ?? previous?.effects ?? [])
      .filter(isCombatEffect)
      .filter((effect) => !isHarmfulStatusKind(effect.kind))
      .filter((effect) =>
        effect.sourceEntityId !== playerId ||
        isCurrentTechniqueId(effect.sourceTechniqueId, learnedTechniqueIds)
      )
      .map((effect) => ({
        ...effect,
        startTick: this.currentTick - Math.max(0, savedTick - effect.startTick),
        endTick: this.currentTick + effect.endTick - savedTick - elapsedTicks,
        nextTick: this.currentTick + Math.max(1, effect.nextTick - savedTick - elapsedTicks)
      }))
      .filter((effect) => effect.endTick >= this.currentTick);
    const restoredEffects = [
      ...restoredPersistentEffects,
      ...(previous?.effects.filter((effect) =>
        isHarmfulStatusKind(effect.kind) &&
        effect.stacks > 0 && effect.endTick >= this.currentTick
      ) ?? [])
    ];
    const readiedWeaponSlot = equipment.readiedWeaponSlot ?? "melee";
    const nextWeaponCategory =
      player.equipmentCombatState?.weaponCategory ??
      equipment.active?.[readiedWeaponSlot]?.weaponCategory ??
      equipment.weapon?.weaponCategory ??
      null;
    const activeChest = equipment.active?.chest ?? equipment.chest;
    const activeSecondary = equipment.active?.secondary ?? null;
    const activeWeapon = equipment.active?.[readiedWeaponSlot] ?? equipment.weapon;
    const heavyArmorPieces = equipment.active
      ? (["head", "chest", "gloves", "boots"] as const)
          .filter((slot) => equipment.active?.[slot]?.armorCategory === "heavy")
          .length
      : equipment.chest?.armorCategory === "heavy" ? 1 : 0;
    const classChanged = previous?.activeClassId !== undefined && previous.activeClassId !== snapshot.activeClassId;
    const subclassChanged = previous !== null && previous.subclassId !== snapshot.activeSubclassId;
    const loadoutChanged = previous !== null && (
      !sameStringSet(previous.equippedActives, equippedActives) ||
      !sameStringSet(previous.equippedPassives, equippedPassives)
    );
    if (classChanged || subclassChanged || loadoutChanged) {
      const session = this.pveSessions.get(playerId);
      if (session) this.clearPendingEmpowerment(session);
      this.clearV2TransientState(player);
    }
    const counters = classChanged ? {} : normalizeCounters(persistedCounters);
    const restoredQueuedAbility = persisted?.queuedAbilityId &&
      persisted.queuedAtTick !== null &&
      !FORMER_ARMED_V2_TECHNIQUE_IDS.has(persisted.queuedAbilityId) &&
      equippedActives.has(persisted.queuedAbilityId) &&
      isCurrentTechniqueId(persisted.queuedAbilityId, learnedTechniqueIds)
      ? {
          abilityId: persisted.queuedAbilityId,
          targetEntityId: persisted.queuedTargetEntityId ?? null,
          queuedAtTick: persisted.queuedAtTick,
          reservedRage: persisted.rageReserved,
          ...(requireTechniqueDefinition(persisted.queuedAbilityId).activation === "armed"
            ? { activationCommitted: true }
            : {})
        }
      : null;
    if (previous && previous.weaponCategory !== nextWeaponCategory) {
      counters.axeActions = 0;
      counters.swordTarget = "";
      counters.swordStacks = 0;
      counters.greatweaponActions = 0;
      counters.greatweaponEmpowered = false;
    }
    const resourceMaximum =
      WARRIOR_BALANCE.rage.maximum +
      (equipment.derivedStats?.resourceMaximumBonus ?? 0);
    player.classRuntime = {
      skillV3: previous?.skillV3 ?? null,
      activeClassId: snapshot.activeClassId,
      resourceId: snapshot.resource?.resourceId ?? classResourceId(snapshot.activeClassId),
      weaponMode: snapshot.weaponMode ?? classWeaponMode(snapshot.activeClassId, nextWeaponCategory),
      masteryRank: classProgress.level ?? classProgress.masteryRank ?? 0,
      subclassId: snapshot.activeSubclassId,
      subclassMasteryRank: subclass?.masteryRank ?? 1,
      learned: new Set(learnedTechniqueIds),
      equippedActives,
      equippedPassives,
      legacyIds: new Set(snapshot.legacyIds),
      weaponCategory: nextWeaponCategory,
      armorCategory: activeChest?.armorCategory ?? null,
      weaponDefinitionId: activeWeapon?.definitionId ?? null,
      chestDefinitionId: activeChest?.definitionId ?? null,
      hasShield:
        activeSecondary?.category === "shield" ||
        equipment.weapon?.weaponCategory === "shield",
      heavyArmorPieces,
      rage: clampRage(
        snapshot.activeClassId === "warrior" ? 0 : persisted?.resourceCurrent ?? persisted?.rage ??
        (!classChanged ? previous?.rage : undefined) ?? snapshot.resource?.current ??
        (snapshot.activeClassId === "hunter" ? HUNTER_BALANCE.focus.initial : snapshot.rage),
        resourceMaximum
      ),
      reservedRage: clampRage(
        snapshot.activeClassId === "warrior" ? 0 : persisted?.resourceReserved ?? persisted?.rageReserved ??
        (!classChanged ? previous?.reservedRage : undefined) ?? snapshot.resource?.reserved ?? 0,
        resourceMaximum
      ),
      guard: clampRage(Number(persisted?.counters.guard ?? previous?.guard ?? 0)),
      bloodlust: clampRage(Number(persisted?.counters.bloodlust ?? previous?.bloodlust ?? 0)),
      queuedAbility: persisted ? restoredQueuedAbility : previous?.queuedAbility ?? null,
      cooldownEndsAt: normalizeCooldownEndsAt(
        persisted?.cooldownEndsAt ??
          (classChanged ? snapshot.cooldownEndsAt : previous?.cooldownEndsAt ?? snapshot.cooldownEndsAt),
        learnedTechniqueIds,
        this.now()
      ),
      effects: classChanged
        ? restoredEffects.filter((effect) => effect.sourceEntityId !== playerId)
        : restoredEffects,
      counters,
      lastCombatAtMs: persisted?.lastCombatAt ?? previous?.lastCombatAtMs ?? null,
      combatGeneration: persisted?.combatGeneration ??
        (classChanged ? (previous?.combatGeneration ?? 0) + 1 : previous?.combatGeneration ?? 0),
      // A class switch advances the durable runtime revision in ClassService;
      // reserve that step locally before rememberClassRuntime increments the
      // next writable snapshot version.
      dirtyVersion: persisted?.version ??
        (classChanged ? (previous?.dirtyVersion ?? 0) + 1 : previous?.dirtyVersion ?? 0)
    };
    if (previous?.skillV3) {
      player.classRuntime.masteryRank = 0;
      player.classRuntime.subclassId = null;
      player.classRuntime.subclassMasteryRank = 0;
      player.classRuntime.learned = new Set(
        Object.entries(previous.skillV3.generalSkillRanks)
          .filter(([, rank]) => (rank ?? 0) > 0)
          .map(([skillId]) => skillId)
      );
      player.classRuntime.equippedActives = new Set<string>(
        previous.skillV3.generalActiveLoadout.filter((id): id is GeneralSkillId => id !== null)
      );
      player.classRuntime.equippedPassives = new Set(player.classRuntime.learned);
      player.classRuntime.queuedAbility = null;
      player.classRuntime.reservedRage = 0;
      player.classRuntime.rage = 0;
      player.classRuntime.guard = 0;
      player.classRuntime.bloodlust = 0;
      player.classRuntime.effects = previous.effects.filter((effect) =>
        effect.endTick >= this.currentTick && effect.sourceTechniqueId.startsWith("v3_")
      );
      player.classRuntime.counters = Object.fromEntries(
        Object.entries(previous.counters).filter(([key]) =>
          key.startsWith("skillV3") || key.startsWith("v3")
        )
      );
      if (player.equipmentCombatState) player.equipmentCombatState.switchPolicy = "melee_priority";
      this.markDirty(player);
      return this.snapshot(player);
    }
    if (player.equipmentCombatState) {
      player.equipmentCombatState.switchPolicy =
        snapshot.activeSubclassId === "sharpshooter"
          ? "ranged_only"
          : snapshot.activeClassId === "hunter"
            ? "ranged_priority"
            : "melee_priority";
    }
    if (classChanged || subclassChanged) {
      this.purgeIncompatibleSourceEffects(playerId, snapshot.activeClassId, snapshot.activeSubclassId);
    }
    if (snapshot.activeClassId === "hunter") {
      player.attackRangeM = player.classRuntime.weaponMode === "ranged"
        ? HUNTER_BALANCE.rangedRangeM
        : HUNTER_BALANCE.meleeRangeM;
      if (persisted?.savedAt && player.lifeState === "alive" && !this.isInCombat(playerId)) {
        const rank = automaticRank(player.classRuntime.masteryRank, [3, 8, 13, 18, 23]);
        const bonus = rank > 0 ? HUNTER_BALANCE.focusControl[rank - 1]!.outOfCombatBonus : 0;
        const elapsedSeconds = Math.max(0, (this.now() - persisted.savedAt) / 1_000);
        const generationMultiplier =
          equipment.derivedStats?.resourceGenerationMultiplier ?? 1;
        const regenerated = Math.floor(
          elapsedSeconds *
          (HUNTER_BALANCE.focus.outOfCombatPerSecond + bonus) *
          generationMultiplier
        );
        player.classRuntime.rage = clampRage(
          player.classRuntime.rage + regenerated,
          resourceMaximum
        );
        player.classRuntime.counters.focusRegenerated =
          Number(player.classRuntime.counters.focusRegenerated ?? 0) + regenerated;
      }
    } else {
      player.attackRangeM = this.launchClassAttackRange(player.classRuntime, player.equipmentCombatState ?? undefined);
    }
    if (player.classRuntime.subclassId !== "warden") {
      player.classRuntime.guard = 0;
      player.classRuntime.counters.reprisalReady = false;
    }
    if (player.classRuntime.queuedAbility && player.targetEntityId === null &&
      player.classRuntime.queuedAbility.activationCommitted !== true) {
      this.refundQueue(player.classRuntime);
    }
    this.markDirty(player);
    this.rememberClassRuntime(player);
    return this.snapshot(player);
  }

  updatePlayerSkillState(
    playerId: string,
    snapshot: SkillSystemV3Snapshot
  ): CombatEntitySnapshot | null {
    const player = this.entities.get(playerId);
    if (!player || player.kind !== "player") return null;
    const runtime = player.classRuntime ?? emptyRuntime();
    if (runtime.skillV3 && snapshot.revision < runtime.skillV3.snapshotRevision) {
      return this.snapshot(player);
    }
    const activeSpecializationId = snapshot.activeSpecializationId !== null && isSpecializationAvailable(
      snapshot.activeSpecializationId,
      snapshot
    )
      ? snapshot.activeSpecializationId
      : null;
    const activeSpecialization = snapshot.specializations.find(
      (entry) => entry.specializationId === activeSpecializationId
    );
    const generalSkillRanks = Object.fromEntries(
      snapshot.generalSkills.map((entry) => [entry.skillId, entry.rank])
    ) as Partial<Record<GeneralSkillId, number>>;
    const previousSkillV3 = runtime.skillV3;
    const enteringV3 = previousSkillV3 === null;
    const sameRevision = previousSkillV3?.snapshotRevision === snapshot.revision;
    if (enteringV3) {
      const session = this.pveSessions.get(playerId);
      if (session) this.clearPendingEmpowerment(session);
      this.clearV2TransientState(player);
    }
    runtime.skillV3 = {
      snapshotRevision: snapshot.revision,
      activeSpecializationId,
      specializationRank: activeSpecialization?.rank ?? 0,
      generalSkillRanks,
      generalActiveLoadout: snapshot.generalActiveLoadout,
      rareBeastMasteryRank: worldKnowledgeRank(snapshot, "rare_beast_mastery")
    };
    this.applyV3WarriorMaxHealthTransition(player, previousSkillV3, runtime.skillV3);
    runtime.masteryRank = 0;
    runtime.subclassId = null;
    runtime.subclassMasteryRank = 0;
    runtime.learned = new Set(snapshot.generalSkills.filter((entry) => entry.rank > 0).map((entry) => entry.skillId));
    runtime.equippedActives = new Set<string>(
      snapshot.generalActiveLoadout.filter((id): id is GeneralSkillId => id !== null)
    );
    runtime.equippedPassives = new Set(
      snapshot.generalSkills.filter((entry) => entry.rank > 0).map((entry) => entry.skillId)
    );
    runtime.queuedAbility = null;
    runtime.reservedRage = 0;
    runtime.rage = 0;
    runtime.guard = 0;
    runtime.bloodlust = 0;
    runtime.cooldownEndsAt = Object.fromEntries(
      [...new Set([...Object.keys(runtime.cooldownEndsAt), ...Object.keys(snapshot.cooldownEndsAt)])]
        .map((key) => [key, Math.max(runtime.cooldownEndsAt[key] ?? 0, snapshot.cooldownEndsAt[key] ?? 0)])
    );
    const shieldChargeLearned = snapshot.generalActiveLoadout.includes("shield_charge");
    if (previousSkillV3 && snapshot.revision > previousSkillV3.snapshotRevision) {
      for (const skillId of ["shield_charge", "cleanse", "taunt", "war_standard", "blight_strike"] as const) {
        if (!snapshot.generalActiveLoadout.includes(skillId)) {
          delete runtime.cooldownEndsAt[`${V3_GENERAL_COOLDOWN_PREFIX}${skillId}`];
        }
      }
    }
    player.attackRangeM = this.launchClassAttackRange(runtime, player.equipmentCombatState ?? undefined);
    if (!sameRevision) {
      runtime.effects = runtime.effects.filter((effect) => {
        if (effect.endTick < this.currentTick) return false;
        if (effect.sourceTechniqueId === V3_WAR_STANDARD_ID) return true;
        if (effect.sourceTechniqueId === V3_BLIGHT_ID || effect.sourceTechniqueId === V3_BLIGHT_IMMUNITY_ID) {
          return true;
        }
        if (effect.sourceTechniqueId === V3_SHIELD_CHARGE_MOVEMENT_ID) {
          return shieldChargeLearned;
        }
        if (effect.sourceTechniqueId === V3_CLEANSE_IMMUNITY_ID) {
          return snapshot.generalActiveLoadout.includes("cleanse");
        }
        if (effect.sourceTechniqueId === V3_TAUNT_DEFENSE_ID) {
          return snapshot.generalActiveLoadout.includes("taunt");
        }
        return effect.sourceTechniqueId.startsWith("v3_");
      });
      runtime.counters = Object.fromEntries(
        Object.entries(runtime.counters).filter(([key]) => key.startsWith("skillV3") || key.startsWith("v3"))
      );
      if (!shieldChargeLearned) {
        delete runtime.counters.skillV3ShieldChargeTarget;
        delete runtime.counters.skillV3ShieldChargeEndsAt;
        delete runtime.counters.skillV3ShieldChargeResetEligible;
      }
      if (!snapshot.generalActiveLoadout.includes("blight_strike")) {
        delete runtime.counters.skillV3BlightArmedUntil;
        delete runtime.counters.skillV3BlightRank;
      }
    }
    if (enteringV3) runtime.combatGeneration += 1;
    runtime.dirtyVersion += 1;
    player.classRuntime = runtime;
    if (player.equipmentCombatState) player.equipmentCombatState.switchPolicy = "melee_priority";
    this.markDirty(player);
    return this.snapshot(player);
  }

  isInCombat(playerId: string): boolean {
    const player = this.entities.get(playerId);
    if (!player) return false;
    const session = this.pveSessions.get(playerId);
    return Boolean(
      (session && (
        session.enemyQueue.length > 0 ||
        session.pendingNormal ||
        session.pendingResetAbilityId ||
        session.phase !== "waiting_player"
      )) ||
      player.targetEntityId !== null
    );
  }

  aggressiveUntil(playerId: string): number | null {
    const player = this.entities.get(playerId);
    if (!player || player.kind !== "player") return null;
    return player.aggressiveUntilMs > this.now() ? player.aggressiveUntilMs : null;
  }

  aggressionRemainingMs(playerId: string): number {
    return Math.max(0, (this.aggressiveUntil(playerId) ?? 0) - this.now());
  }

  flagArrivalProtectionUntil(playerId: string): number | null {
    const until = this.flagArrivalProtectionUntilByPlayer.get(playerId) ?? 0;
    if (until > this.now()) return until;
    this.flagArrivalProtectionUntilByPlayer.delete(playerId);
    return null;
  }

  grantFlagArrivalProtection(
    playerId: string,
    relocationRevision: number,
    durationMs = FLAG_ARRIVAL_PROTECTION_MS
  ): number | null {
    const player = this.entities.get(playerId);
    if (
      !player ||
      player.kind !== "player" ||
      player.lifeState !== "alive" ||
      !Number.isSafeInteger(relocationRevision) ||
      relocationRevision < 0 ||
      !Number.isFinite(durationMs) ||
      durationMs <= 0
    ) return null;
    const previousRevision = this.flagArrivalProtectionRevisionByPlayer.get(playerId);
    if (previousRevision !== undefined && relocationRevision <= previousRevision) {
      return relocationRevision === previousRevision
        ? this.flagArrivalProtectionUntil(playerId)
        : null;
    }
    this.flagArrivalProtectionRevisionByPlayer.set(playerId, relocationRevision);
    return this.grantArrivalProtection(player, durationMs);
  }

  grantRespawnArrivalProtection(
    playerId: string,
    durationMs = FLAG_ARRIVAL_PROTECTION_MS
  ): number | null {
    const player = this.entities.get(playerId);
    if (!player || player.kind !== "player" || player.lifeState !== "alive") return null;
    return this.grantArrivalProtection(player, durationMs);
  }

  private grantArrivalProtection(player: Combatant, durationMs: number): number | null {
    if (!Number.isFinite(durationMs) || durationMs <= 0) return null;
    const until = this.now() + durationMs;
    this.flagArrivalProtectionUntilByPlayer.set(player.entityId, until);
    const playerId = player.entityId;
    this.invalidateMobAiPlayer(playerId);
    for (const targeterId of [...(this.targetersByEntity.get(playerId) ?? [])]) {
      const targeter = this.entities.get(targeterId);
      if (targeter?.kind === "mob") this.clearTarget(targeter);
    }
    this.markDirty(player);
    return until;
  }

  breakFlagArrivalProtection(playerId: string): boolean {
    if (!this.flagArrivalProtectionUntilByPlayer.delete(playerId)) return false;
    const player = this.entities.get(playerId);
    if (player?.kind === "player") this.markDirty(player);
    return true;
  }

  isPlayerAggressive(playerId: string): boolean {
    return this.aggressionRemainingMs(playerId) > 0;
  }

  isPlayerAlive(playerId: string): boolean {
    return this.entities.get(playerId)?.lifeState === "alive";
  }

  isPlayerVisibleToPlayer(viewerPlayerId: string, targetPlayerId: string): boolean {
    const viewer = this.entities.get(viewerPlayerId);
    const target = this.entities.get(targetPlayerId);
    return Boolean(
      viewer
      && target
      && viewer.kind === "player"
      && target.kind === "player"
      && this.hasActiveAuthority(target)
      && this.isInsideAuthoritativeView(viewer, target)
      && (
        viewer.entityId === target.entityId
        || !this.isNinjaInvisible(target)
        || this.options.partyAuthority?.sameParty(viewer.entityId, target.entityId) === true
      )
    );
  }

  isTravelLocked(
    playerId: string,
    lockDurationMs = AGGRESSIVE_FLAG_TRAVEL_LOCK_MS,
    now = this.now()
  ): boolean {
    const player = this.entities.get(playerId);
    if (!player) return true;
    return isAggressionTravelLocked(
      player.classRuntime?.lastCombatAtMs,
      this.isInCombat(playerId),
      now,
      lockDurationMs
    );
  }

  hasQueuedAbility(playerId: string): boolean {
    const session = this.pveSessions.get(playerId);
    return Boolean(
      this.entities.get(playerId)?.classRuntime?.queuedAbility ||
      session?.pendingNormal ||
      session?.pendingResetAbilityId
    );
  }

  resetPlayerClassAbilityCooldowns(playerId: string): boolean {
    const player = this.entities.get(playerId);
    if (!player || player.kind !== "player" || !player.classRuntime) return false;
    player.classRuntime.cooldownEndsAt = {};
    player.tauntCooldownEndsAt = 0;
    this.markDirty(player);
    this.rememberClassRuntime(player);
    return true;
  }

  playerMovementMultiplier(playerId: string): number {
    const base = this.basePlayerMovementMultiplier(playerId);
    const player = this.entities.get(playerId);
    // Frost and Fleet slow players; other movement_slow sources are mob-chase only.
    const slow = player?.classRuntime?.effects
      .filter((effect) =>
        effect.kind === "movement_slow" && effect.endTick >= this.currentTick &&
        (effect.sourceTechniqueId === "elemental_ice_slow" || effect.sourceTechniqueId === "metal_fleet_slow")
      )
      .reduce((total, effect) => total + effect.amount * effect.stacks, 0) ?? 0;
    return slow > 0 ? Math.max(0.2, base * Math.max(0.2, 1 - slow)) : base;
  }

  private basePlayerMovementMultiplier(playerId: string): number {
    const player = this.entities.get(playerId);
    if (!player) return 1;
    // The Spearhead: flat speed, scaled by the same authoritative base the class speed bonuses use.
    const kingdomSpeed = (player.kingdomPerkEffects?.speedBonus ?? 0) /
      Math.max(1, this.options.playerMovementSpeedMps ?? DEFAULT_PLAYER_SPEED_MPS);
    const skillV3 = player.classRuntime?.skillV3;
    if (skillV3) {
      const rank = skillV3.specializationRank;
      const flatSpecializationSpeed = (() => {
        switch (skillV3.activeSpecializationId) {
          case "ranger": return rank >= 5 ? 9 : rank >= 2 ? 4 : 0;
          case "ninja": return rank >= 5 ? 27 : rank >= 4 ? 18 : rank >= 2 ? 9 : 0;
          case "rogue": return rank * 7;
          case "voyager": return rank >= 5 ? 27 : rank >= 3 ? 18 : rank >= 1 ? 9 : 0;
          default: return 0;
        }
      })();
      const authoritativeBase = this.options.playerMovementSpeedMps ?? DEFAULT_PLAYER_SPEED_MPS;
      const bodyFamily = equipmentGameplayFamily(player.classRuntime?.chestDefinitionId ?? null);
      const baseBodyPenalty = bodyFamily === "breastplate" || bodyFamily === "chain_mail"
        ? 0.10
        : bodyFamily === "leather" ? 0.05 : 0;
      const sentinelBreastplateRelief = bodyFamily === "breastplate" &&
        skillV3.activeSpecializationId === "sentinel"
          ? rank >= 5 ? 0.60 : rank >= 4 ? 0.40 : rank >= 2 ? 0.20 : 0
          : 0;
      const bodyPenalty = baseBodyPenalty * (1 - sentinelBreastplateRelief);
      const shieldPenalty = player.classRuntime?.hasShield ? 0.05 : 0;
      const armorMovement = Math.max(0.2, 1 - bodyPenalty - shieldPenalty);
      const equipmentMovement = player.equipmentCombatState?.stats.movementSpeedMultiplier ?? 1;
      const monkAuraMovement = Math.max(0.2, 1 - this.v3MonkSlowAura(player) / Math.max(1, authoritativeBase));
      return Math.max(
        0.2,
        (1 + flatSpecializationSpeed / Math.max(1, authoritativeBase) + kingdomSpeed +
          this.effectTotal(player, "out_of_combat_movement")) * armorMovement * equipmentMovement *
          monkAuraMovement
      );
    }
    const hunterMovement = player.classRuntime?.activeClassId === "hunter"
      ? automaticRank(player.classRuntime.masteryRank, [5, 10, 15, 20, 25]) *
        HUNTER_BALANCE.trailblazerMovementPerRank
      : 0;
    const equipmentMovement =
      player.equipmentCombatState?.stats.movementSpeedMultiplier ?? 1;
    const launchClassMovement = player.classRuntime?.activeClassId === "ranger" &&
      player.classRuntime.equippedPassives.has("ranger_v2_clear_shot") &&
      equipmentGameplayFamily(player.classRuntime.chestDefinitionId) === "leather" &&
      !player.classRuntime.hasShield
        ? 0.1
        : player.classRuntime?.activeClassId === "ninja" &&
          player.classRuntime.equippedPassives.has("ninja_v2_light_feet") &&
          equipmentGameplayFamily(player.classRuntime.chestDefinitionId) === "tunic"
          ? 0.1
          : 0;
    return Math.max(
      0.2,
      (
        1 +
        hunterMovement +
        launchClassMovement +
        kingdomSpeed +
        this.effectTotal(player, "out_of_combat_movement")
      ) * equipmentMovement
    );
  }

  resetPlayerSkillV3Runtime(playerId: string): boolean {
    const player = this.entities.get(playerId);
    const runtime = player?.classRuntime;
    if (!player || player.kind !== "player" || !runtime) return false;
    const priorSkillV3SourceIds = new Set([
      ...Object.keys(runtime.skillV3?.generalSkillRanks ?? {})
    ]);
    const previousSkillV3 = runtime.skillV3;
    runtime.skillV3 = null;
    this.applyV3WarriorMaxHealthTransition(player, previousSkillV3, null);
    runtime.queuedAbility = null;
    runtime.cooldownEndsAt = {};
    runtime.combatGeneration += 1;
    for (const key of Object.keys(runtime.counters)) {
      if (key.startsWith("skillV3") || key.startsWith("v3")) delete runtime.counters[key];
    }
    for (const entity of this.entities.values()) {
      const targetRuntime = entity.classRuntime;
      if (!targetRuntime) continue;
      const previousEffectCount = targetRuntime.effects.length;
      targetRuntime.effects = targetRuntime.effects.filter((effect) =>
        effect.sourceEntityId !== playerId ||
        (
          !priorSkillV3SourceIds.has(effect.sourceTechniqueId) &&
          !effect.sourceTechniqueId.startsWith("skill_v3") &&
          !effect.sourceTechniqueId.startsWith("v3")
        )
      );
      if (targetRuntime.effects.length !== previousEffectCount) {
        this.markDirty(entity);
        this.rememberClassRuntime(entity);
      }
    }
    for (const zone of [...this.classAbilityZones.values()]) {
      if (zone.sourceEntityId !== playerId) continue;
      this.removeBannerDefense(zone);
      this.classAbilityZones.delete(zone.id);
      this.emitClassAbilityZoneEvent("CLASS_ABILITY_ZONE_ENDED", zone);
    }
    this.markDirty(player);
    this.rememberClassRuntime(player);
    return true;
  }

  useGeneralActive(input: {
    playerId: string;
    skillId: GeneralSkillId;
    accountId: string;
    connectionId: string;
    targetEntityId?: string;
    targetMode?: "hostile" | "friendly" | "self" | "position" | "direction";
    targetPosition?: LatLon;
    directionDegrees?: number;
  }): CombatActionResult {
    const player = this.requireEntity(input.playerId, "COMBAT_PLAYER_NOT_FOUND");
    this.requirePlayerAuthority(player, input.accountId, input.connectionId);
    this.requireNotStunned(player);
    if (player.kind !== "player" || player.lifeState !== "alive") {
      throw new CombatRequestError("COMBAT_ACTOR_INVALID", "Defeated players cannot use general actives");
    }
    const runtime = player.classRuntime;
    const skillState = runtime?.skillV3;
    if (!runtime || !skillState) {
      throw new CombatRequestError("SKILL_RUNTIME_UNAVAILABLE", "V3 skill combat state is unavailable");
    }
    const silencedUntil = this.silencedUntilTick.get(player.entityId);
    if (silencedUntil !== undefined) {
      if (silencedUntil > this.currentTick) throw new CombatRequestError("ABILITY_COOLDOWN", "You are silenced by the bell's toll");
      this.silencedUntilTick.delete(player.entityId);
    }
    if (!["shield_charge", "cleanse", "taunt", "war_standard", "blight_strike"].includes(input.skillId)) {
      throw new CombatRequestError("ABILITY_NOT_IMPLEMENTED", "That V3 general active is not implemented");
    }
    const rank = skillState.generalSkillRanks[input.skillId] ?? 0;
    if (rank < 1 || rank > 3) {
      throw new CombatRequestError("ABILITY_RANK_LOCKED", "General active rank is not learned");
    }
    if (!skillState.generalActiveLoadout.includes(input.skillId)) {
      throw new CombatRequestError("ABILITY_NOT_EQUIPPED", "General active is not equipped");
    }
    const definition = requireGeneralSkillDefinition(input.skillId);
    const rankDefinition = definition.rankDefinitions[rank - 1];
    const cooldownMs = rankDefinition?.cooldownMs;
    if (!rankDefinition || cooldownMs === undefined || cooldownMs <= 0) {
      throw new CombatRequestError("ABILITY_NOT_IMPLEMENTED", "General active has no executable rank definition");
    }
    const now = this.now();
    const cooldownKey = `${V3_GENERAL_COOLDOWN_PREFIX}${input.skillId}`;
    if ((runtime.cooldownEndsAt[cooldownKey] ?? 0) > now) {
      throw new CombatRequestError("ABILITY_COOLDOWN", "General active is still cooling down");
    }

    if (input.skillId === "shield_charge") {
      if (!runtime.hasShield) {
        throw new CombatRequestError("ABILITY_EQUIPMENT_REQUIRED", "Shield Charge requires an equipped shield");
      }
      if (runtime.weaponMode === "ranged") {
        throw new CombatRequestError(
          "ABILITY_EQUIPMENT_REQUIRED",
          "Shield Charge requires a compatible melee stance"
        );
      }
      const target = this.resolveV3HostileTarget(player, input.targetEntityId, input.targetMode);
      const durationMs = rank >= 2 ? 9_000 : 6_000;
      this.addTimedEffect(
        player,
        player,
        "out_of_combat_movement",
        V3_SHIELD_CHARGE_MOVEMENT_ID,
        durationMs,
        rank >= 3 ? 1.35 : 0.65
      );
      runtime.counters.skillV3ShieldChargeTarget = target.entityId;
      runtime.counters.skillV3ShieldChargeEndsAt = now + durationMs;
      runtime.counters.skillV3ShieldChargeResetEligible = rank >= 3;
      this.setTarget(player, target.entityId);
      this.options.movePlayerToward?.(player.entityId, target.position);
      if (target.kind === "player") {
        // The charge engages: the first landed hit is the one swing, or starts a
        // fight when the target is Aggressive (they hit back automatically).
        this.scheduleAttack(player, Math.max(this.currentTick + 1, player.nextEligibleAttackTick));
      }
      if (target.kind === "mob") {
        const session = this.pveSessions.get(player.entityId);
        if (session) {
          this.engageHostileMob(target, player, session);
          target.threatPriorityPlayerId = player.entityId;
          target.threatPriorityRemainingActions = Math.max(
            target.threatPriorityRemainingActions,
            Math.ceil(durationMs / PVE_TURN_STEP_MS)
          );
        }
      }
      this.breakFlagArrivalProtection(player.entityId);
    } else if (input.skillId === "cleanse") {
      if (input.targetMode !== undefined && input.targetMode !== "self") {
        throw new CombatRequestError("ABILITY_TARGET_MODE_INVALID", "Cleanse only targets self");
      }
      runtime.effects = runtime.effects.filter((effect) =>
        effect.cleansable === false || !isV3HarmfulEffectKind(effect.kind)
      );
      this.addTimedEffect(
        player,
        player,
        "cleanse_immunity",
        V3_CLEANSE_IMMUNITY_ID,
        ([2_500, 5_000, 8_000][rank - 1] ?? 8_000),
        1
      );
      const immunity = runtime.effects.find((effect) =>
        effect.kind === "cleanse_immunity" && effect.sourceTechniqueId === V3_CLEANSE_IMMUNITY_ID
      );
      if (immunity) immunity.cleansable = false;
    } else if (input.skillId === "taunt") {
      if (input.targetMode !== undefined && input.targetMode !== "self") {
        throw new CombatRequestError("ABILITY_TARGET_MODE_INVALID", "Taunt only targets self");
      }
      const session = this.requirePveSession(player);
      const oldTauntCooldown = player.tauntCooldownEndsAt;
      const oldRuntimeCooldown = runtime.cooldownEndsAt[UNIVERSAL_TAUNT_ID];
      player.tauntCooldownEndsAt = 0;
      delete runtime.cooldownEndsAt[UNIVERSAL_TAUNT_ID];
      try {
        this.resolveTauntAction(player, session);
      } catch (error) {
        player.tauntCooldownEndsAt = oldTauntCooldown;
        if (oldRuntimeCooldown === undefined) delete runtime.cooldownEndsAt[UNIVERSAL_TAUNT_ID];
        else runtime.cooldownEndsAt[UNIVERSAL_TAUNT_ID] = oldRuntimeCooldown;
        throw error;
      }
      player.tauntCooldownEndsAt = 0;
      delete runtime.cooldownEndsAt[UNIVERSAL_TAUNT_ID];
      this.addTimedEffect(
        player,
        player,
        "taunt_defense",
        V3_TAUNT_DEFENSE_ID,
        V3_TAUNT_DEFENSE_MS,
        flatRankValue(TAUNT_DEFENSE_BY_RANK, rank),
        [...session.tauntedEnemyIds]
      );
    } else if (input.skillId === "war_standard") {
      if (input.targetMode !== undefined && input.targetMode !== "self") {
        throw new CombatRequestError("ABILITY_TARGET_MODE_INVALID", "War Standard only targets self");
      }
      const amount = flatRankValue(WAR_STANDARD_ATTACK_BY_RANK, rank);
      for (const memberId of this.partyMemberIds(player.entityId)) {
        const member = this.entities.get(memberId);
        if (!member || member.kind !== "player" || member.lifeState !== "alive") continue;
        if (member.entityId !== player.entityId && !this.isValidNearbyVisibleAlly(player, member, FRIENDLY_TARGET_RANGE_M)) {
          continue;
        }
        const existing = member.classRuntime?.effects.find((effect) =>
          effect.kind === "flat_attack" && effect.sourceTechniqueId === V3_WAR_STANDARD_ID &&
          effect.endTick >= this.currentTick
        );
        if (existing && existing.amount > amount) continue;
        this.addTimedEffect(
          player,
          member,
          "flat_attack",
          V3_WAR_STANDARD_ID,
          V3_WAR_STANDARD_DURATION_MS,
          amount
        );
      }
    } else {
      this.resolveV3HostileTarget(player, input.targetEntityId, input.targetMode);
      if (Number(runtime.counters.skillV3BlightArmedUntil ?? 0) > now) {
        throw new CombatRequestError("EMPOWERMENT_ALREADY_ARMED", "Blight Strike is already armed");
      }
      runtime.counters.skillV3BlightArmedUntil = now + V3_BLIGHT_ARM_WINDOW_MS;
      runtime.counters.skillV3BlightRank = rank;
    }

    runtime.cooldownEndsAt[cooldownKey] = now + cooldownMs;
    this.markDirty(player);
    this.rememberClassRuntime(player);
    return this.combatActionState(player);
  }

  /**
   * Edict Stride (World Knowledge, active, targeted). Checks everything that can reject the use, without
   * side effects, so the caller can charge the Edict Seal only for a use that will resolve.
   */
  checkEdictStride(input: {
    playerId: string;
    targetEntityId?: string;
    targetMode?: "hostile" | "friendly" | "self" | "position" | "direction";
  }): Combatant {
    const player = this.requireEntity(input.playerId, "COMBAT_PLAYER_NOT_FOUND");
    if (player.kind !== "player" || player.lifeState !== "alive") {
      throw new CombatRequestError("COMBAT_ACTOR_INVALID", "Defeated players cannot use Edict Stride");
    }
    const runtime = player.classRuntime;
    if (!runtime) throw new CombatRequestError("SKILL_RUNTIME_UNAVAILABLE", "V3 skill combat state is unavailable");
    if ((runtime.cooldownEndsAt[`${V3_GENERAL_COOLDOWN_PREFIX}edict_stride`] ?? 0) > this.now()) {
      throw new CombatRequestError("ABILITY_COOLDOWN", "Edict Stride is still cooling down");
    }
    return this.resolveV3HostileTarget(player, input.targetEntityId, input.targetMode);
  }

  useEdictStride(input: {
    playerId: string;
    accountId: string;
    connectionId: string;
    rank: number;
    targetEntityId?: string;
    targetMode?: "hostile" | "friendly" | "self" | "position" | "direction";
  }): CombatActionResult {
    const player = this.requireEntity(input.playerId, "COMBAT_PLAYER_NOT_FOUND");
    this.requirePlayerAuthority(player, input.accountId, input.connectionId);
    this.requireNotStunned(player);
    const rank = Math.trunc(input.rank);
    if (rank < 1 || rank > 3) throw new CombatRequestError("ABILITY_RANK_LOCKED", "Edict Stride is not learned");
    const target = this.checkEdictStride(input);
    const now = this.now();
    this.edictStrides.set(player.entityId, {
      targetId: target.entityId, rank, armedUntil: now + EDICT_STRIDE.armWindowMs, activeUntil: null,
      last: { lat: target.position.lat, lon: target.position.lon }, pendingDamage: 0
    });
    player.classRuntime!.cooldownEndsAt[`${V3_GENERAL_COOLDOWN_PREFIX}edict_stride`] = now + EDICT_STRIDE.cooldownMs[rank]!;
    this.setTarget(player, target.entityId);
    this.markDirty(player);
    this.rememberClassRuntime(player);
    return this.combatActionState(player);
  }

  /** Undoes an accepted use (e.g. the Edict Seal could not be charged): drops the mark and its cooldown. */
  cancelEdictStride(playerId: string): void {
    this.edictStrides.delete(playerId);
    const runtime = this.entities.get(playerId)?.classRuntime;
    if (runtime) delete runtime.cooldownEndsAt[`${V3_GENERAL_COOLDOWN_PREFIX}edict_stride`];
  }

  /** Waits up to 12 s for the mark to move, then damages it on each move for 6 s. */
  private processEdictStrides(): void {
    if (this.edictStrides.size === 0) return;
    const now = this.now();
    for (const [casterId, stride] of [...this.edictStrides]) {
      const caster = this.entities.get(casterId);
      const target = this.entities.get(stride.targetId);
      const expired = stride.activeUntil === null ? now > stride.armedUntil : now > stride.activeUntil;
      if (!caster || !target || caster.lifeState !== "alive" || target.lifeState !== "alive" || expired) {
        this.edictStrides.delete(casterId);
        continue;
      }
      const movedM = distanceMeters(stride.last, target.position);
      if (movedM < 0.5) continue;
      stride.last = { lat: target.position.lat, lon: target.position.lon };
      if (stride.activeUntil === null) stride.activeUntil = now + EDICT_STRIDE.effectMs;
      stride.pendingDamage += edictStrideDamage(stride.rank, movedM, (this.options.random ?? Math.random)());
      const damage = Math.floor(stride.pendingDamage);
      if (damage < 1) continue;
      stride.pendingDamage -= damage;
      this.applyDamage(caster, target, damage, "v3_edict_stride", false, {}, 0, false, "area", { fixedFinalDamage: damage });
    }
  }

  useNormalAbility(input: {
    playerId: string;
    abilityId: string;
    accountId: string;
    connectionId: string;
    targetEntityId?: string;
    targetMode?: AbilityTargetMode;
    targetPosition?: LatLon;
  }): CombatActionResult {
    const player = this.requireEntity(input.playerId, "COMBAT_PLAYER_NOT_FOUND");
    this.requirePlayerAuthority(player, input.accountId, input.connectionId);
    this.requireNotStunned(player);
    if (input.abilityId === "knight_taunt" && player.classRuntime?.activeClassId !== "knight") {
      throw new CombatRequestError("ABILITY_CLASS_INVALID", "Taunt is a Knight class skill");
    }
    const directDefinition = this.validateAbilityInput(
      player,
      input.abilityId,
      false,
      { skipReadiness: true }
    );
    if (directDefinition.activation === "armed") {
      const definition = this.validateAbilityInput(player, input.abilityId, false);
      const result = this.armV2Ability(player, definition);
      if (this.isHostileV2Activation(definition)) this.breakFlagArrivalProtection(player.entityId);
      return result;
    }
    if (directDefinition.activation === "instant" || directDefinition.activation === "drag") {
      const readyDefinition = this.validateAbilityInput(player, input.abilityId, false);
      const directTarget = this.resolveV2ImmediateTarget(
        player, readyDefinition, input.targetEntityId, input.targetMode
      );
      this.validateDragTarget(player, readyDefinition, input.targetPosition);
      let resolvedPosition = input.targetPosition;
      if (readyDefinition.id === "warrior_v2_faultline") {
        resolvedPosition = destinationPoint(
          directTarget.position,
          Math.min(MELEE_ATTACK_RANGE_M, player.attackRangeM),
          initialBearingDegrees(directTarget.position, player.position)
        );
      } else if (readyDefinition.id === "ranger_v2_threefold_volley") {
        resolvedPosition = destinationPoint(
          player.position,
          120,
          initialBearingDegrees(directTarget.position, player.position)
        );
      }
      const requiresReposition = [
        "ninja_v2_shadowstep", "warrior_v2_faultline", "ranger_v2_threefold_volley"
      ].includes(readyDefinition.id);
      const repositionAccepted = requiresReposition
        ? Boolean(resolvedPosition && this.options.repositionPlayer?.(player.entityId, resolvedPosition))
        : undefined;
      if (requiresReposition && !repositionAccepted) {
        throw new CombatRequestError("ABILITY_POSITION_REJECTED", "That combat reposition is not traversable");
      }
      this.resolveAbility(player, directTarget, readyDefinition, {
        ...(resolvedPosition === undefined ? {} : { targetPosition: resolvedPosition }),
        ...(repositionAccepted === undefined ? {} : { repositionAccepted })
      });
      if (this.isHostileV2Activation(readyDefinition)) this.breakFlagArrivalProtection(player.entityId);
      return this.combatActionState(player);
    }
    const directSupportTarget = isSupportTechnique(directDefinition)
      ? this.resolveDirectSupportTarget(
          player,
          directDefinition,
          input.targetEntityId,
          input.targetMode
        )
      : null;
    if (directSupportTarget) {
      const definition = this.validateAbilityInput(player, input.abilityId, false);
      this.requireImmediateAbilityWeaponReady(player, directSupportTarget, definition);
      this.resolveAbility(player, directSupportTarget, definition);
      return this.combatActionState(player);
    }
    const currentTarget = player.targetEntityId
      ? this.entities.get(player.targetEntityId)
      : null;
    if (currentTarget?.kind === "player") {
      const pvpDefinition = this.validateAbilityInput(
        player,
        input.abilityId,
        false,
        { skipReadiness: true }
      );
      if (this.techniqueTargetType(pvpDefinition) === "self") {
        this.validateAbilityInput(player, input.abilityId, false);
        this.resolveAbility(player, player, pvpDefinition);
        return this.combatActionState(player);
      }
      const pvpTarget = this.currentPvpAbilityTarget(
        player,
        pvpDefinition,
        input.targetEntityId,
        input.targetMode
      );
      if (pvpTarget) {
        const result = this.queuePvpAbility(player, pvpTarget, pvpDefinition, false);
        this.breakFlagArrivalProtection(player.entityId);
        return result;
      }
    }
    const definition = this.validateAbilityInput(player, input.abilityId, false);
    const targetType = this.techniqueTargetType(definition);
    const session = targetType === "hostile"
      ? this.requirePveSession(player)
      : this.ensurePveSession(player);
    const hostileAction =
      targetType === "hostile" ||
      (targetType === "friendly_or_hostile" &&
        (input.targetMode ?? "hostile") === "hostile");
    const pending: PendingNormalAction = {
      kind: "ability",
      abilityId: definition.id,
      ...(input.targetEntityId !== undefined ? { targetEntityId: input.targetEntityId } : {}),
      ...(input.targetMode !== undefined ? { targetMode: input.targetMode } : {})
    };
    if (!this.tryResolveNormalAction(player, session, pending)) {
      session.pendingNormal = pending;
      this.recomputeInProgressWeaponSwitch(player);
    }
    if (hostileAction) this.breakFlagArrivalProtection(player.entityId);
    this.noteSessionChanged(player, session);
    return this.combatActionState(player);
  }

  useUltimateAbility(input: {
    playerId: string;
    abilityId: string;
    accountId: string;
    connectionId: string;
    targetEntityId?: string;
    targetMode?: AbilityTargetMode;
    targetPosition?: LatLon;
  }): CombatActionResult {
    const player = this.requireEntity(input.playerId, "COMBAT_PLAYER_NOT_FOUND");
    this.requirePlayerAuthority(player, input.accountId, input.connectionId);
    throw new CombatRequestError(
      "ULTIMATE_DISABLED",
      "Ultimate abilities are disabled under the current Skill System V3 rules"
    );
  }

  private armV2Ability(player: Combatant, definition: TechniqueDefinition): CombatActionResult {
    const session = this.pveSessions.get(player.entityId);
    const runtime = requireClassCombatRuntime(player);
    if (session?.pendingResetAbilityId || runtime.queuedAbility) {
      throw new CombatRequestError("EMPOWERMENT_ALREADY_ARMED", "A next-attack ability is already armed");
    }
    this.beginPlayerAction(player);
    this.commitAbilityActivation(player, definition);
    this.onV2RegularCast(player, definition);
    if (session) {
      session.pendingResetAbilityId = definition.id;
      session.pendingResetTargetEntityId = null;
      session.pendingResetTargetMode = null;
      session.pendingResetActionSequence = this.playerActionSequence(player);
    }
    runtime.queuedAbility = {
      abilityId: definition.id,
      targetEntityId: null,
      queuedAtTick: this.currentTick,
      reservedRage: 0,
      activationCommitted: true
    };
    runtime.counters.v2ArmedActionSequence = this.playerActionSequence(player);
    if (session) this.noteSessionChanged(player, session);
    this.rememberClassRuntime(player);
    return this.combatActionState(player);
  }

  private resolveV2ImmediateTarget(
    player: Combatant,
    definition: TechniqueDefinition,
    targetEntityId?: string,
    targetMode?: AbilityTargetMode
  ): Combatant {
    const expected = this.techniqueTargetType(definition);
    if (expected === "self") {
      if ((targetEntityId && targetEntityId !== player.entityId) || (targetMode && targetMode !== "self")) {
        throw new CombatRequestError("ABILITY_TARGET_MODE_INVALID", "This ability only targets self");
      }
      return player;
    }
    const requested = targetEntityId ?? player.targetEntityId;
    if (!requested) throw new CombatRequestError("ABILITY_TARGET_REQUIRED", "Choose a target");
    const target = this.requireEntity(requested, "COMBAT_TARGET_NOT_FOUND");
    const actualMode: AbilityTargetMode = target.entityId === player.entityId
      ? "self"
      : this.isValidVisibleAlly(player, target) ? "friendly" : "hostile";
    const mode = targetMode ?? actualMode;
    if (mode !== actualMode || (expected !== "friendly_or_hostile" && !(expected === "friendly" && mode === "self") && expected !== mode)) {
      throw new CombatRequestError("ABILITY_TARGET_MODE_INVALID", "Target relationship does not match the requested mode");
    }
    if (mode === "self") return player;
    if (mode === "friendly") {
      if (!this.isValidNearbyVisibleAlly(player, target, FRIENDLY_TARGET_RANGE_M)) {
        throw new CombatRequestError("ABILITY_FRIENDLY_TARGET_INVALID", "Friendly target is not a nearby visible eligible party member");
      }
      return target;
    }
    this.validateAttackPair(player, target, false);
    if (!this.grid.query(player.position, definition.targetRangeM ?? player.attackRangeM).includes(target.entityId)) {
      throw new CombatRequestError("ABILITY_TARGET_OUT_OF_RANGE", "Ability target is out of range");
    }
    return target;
  }

  private validateDragTarget(
    player: Combatant,
    definition: TechniqueDefinition,
    targetPosition?: LatLon
  ): void {
    if (definition.activation !== "drag") return;
    if (!targetPosition || !Number.isFinite(targetPosition.lat) || !Number.isFinite(targetPosition.lon)) {
      throw new CombatRequestError("ABILITY_POSITION_REQUIRED", "Choose a valid ability position");
    }
    if (distanceMeters(player.position, targetPosition) > (definition.targetRangeM ?? 120)) {
      throw new CombatRequestError("ABILITY_POSITION_OUT_OF_RANGE", "Ability position is out of range");
    }
  }

  useResetAbility(input: {
    playerId: string;
    abilityId: string;
    accountId: string;
    connectionId: string;
    targetEntityId?: string;
    targetMode?: AbilityTargetMode;
  }): CombatActionResult {
    const player = this.requireEntity(input.playerId, "COMBAT_PLAYER_NOT_FOUND");
    this.requirePlayerAuthority(player, input.accountId, input.connectionId);
    this.requireNotStunned(player);
    const directDefinition = this.validateAbilityInput(
      player,
      input.abilityId,
      true,
      { skipReadiness: true }
    );
    const directSupportTarget = isSupportTechnique(directDefinition)
      ? this.resolveDirectSupportTarget(
          player,
          directDefinition,
          input.targetEntityId,
          input.targetMode
        )
      : null;
    if (directSupportTarget) {
      const definition = this.validateAbilityInput(player, input.abilityId, true);
      this.requireImmediateAbilityWeaponReady(player, directSupportTarget, definition);
      this.resolveAbility(player, directSupportTarget, definition);
      return this.combatActionState(player);
    }
    const currentTarget = player.targetEntityId
      ? this.entities.get(player.targetEntityId)
      : null;
    if (currentTarget?.kind === "player") {
      const pvpDefinition = this.validateAbilityInput(
        player,
        input.abilityId,
        true,
        { skipReadiness: true }
      );
      const pvpTarget = this.currentPvpAbilityTarget(
        player,
        pvpDefinition,
        input.targetEntityId,
        input.targetMode
      );
      if (pvpTarget) {
        if (this.pveSessions.get(player.entityId)?.pendingResetAbilityId) {
          throw new CombatRequestError(
            "EMPOWERMENT_ALREADY_ARMED",
            "A next-attack empowerment is already armed"
          );
        }
        const result = this.queuePvpAbility(player, pvpTarget, pvpDefinition, true);
        this.breakFlagArrivalProtection(player.entityId);
        return result;
      }
    }
    const session = this.requirePveSession(player);
    if (session.pendingResetAbilityId || player.classRuntime?.queuedAbility) {
      throw new CombatRequestError("EMPOWERMENT_ALREADY_ARMED", "A next-attack empowerment is already armed");
    }
    const definition = this.validateAbilityInput(player, input.abilityId, true);
    this.repairFocus(session);
    // Validate the requested branch now, but let the normal basic-attack resolver
    // repeat all authority, target, and range checks at the scheduled beat.
    const target = this.resolveTechniqueTarget(
      player,
      session,
      definition,
      input.targetEntityId,
      input.targetMode
    );
    this.requireImmediateAbilityWeaponReady(player, target, definition);
    this.commitAbilityActivation(player, definition, { target });
    session.pendingResetAbilityId = input.abilityId;
    session.pendingResetTargetEntityId = input.targetEntityId ?? null;
    session.pendingResetTargetMode = input.targetMode ?? null;
    session.pendingResetActionSequence = null;
    if (this.resolvedTargetMode(player, target) === "hostile") {
      this.breakFlagArrivalProtection(player.entityId);
    }
    this.noteSessionChanged(player, session);
    return this.combatActionState(player);
  }

  useUniversalTaunt(input: {
    playerId: string;
    accountId: string;
    connectionId: string;
    viewGeneration?: number;
  }): CombatActionResult {
    const player = this.requireEntity(input.playerId, "COMBAT_PLAYER_NOT_FOUND");
    this.requirePlayerAuthority(player, input.accountId, input.connectionId);
    this.requireNotStunned(player);
    if (player.classRuntime?.activeClassId !== "knight") {
      throw new CombatRequestError("ABILITY_CLASS_INVALID", "Taunt is a Knight class skill");
    }
    if (player.lifeState !== "alive") {
      throw new CombatRequestError("COMBAT_ACTOR_INVALID", "Defeated players cannot Taunt");
    }
    if (this.tauntCooldownEnd(player) > this.now()) {
      throw new CombatRequestError("ABILITY_COOLDOWN", "Universal Taunt is still cooling down");
    }
    const view = this.authoritativeViewCircle(player);
    if (input.viewGeneration !== undefined && input.viewGeneration !== view.generation) {
      throw new CombatRequestError("TAUNT_VIEW_GENERATION_STALE", "The active view circle changed before Taunt resolved");
    }
    const session = this.ensurePveSession(player);
    if (session.viewGeneration !== view.generation) {
      throw new CombatRequestError("TAUNT_VIEW_GENERATION_STALE", "The PvE session belongs to an obsolete view circle");
    }
    this.resolveTauntAction(player, session);
    this.breakFlagArrivalProtection(player.entityId);
    return this.combatActionState(player);
  }

  peekDirtyClassRuntimes(): DirtyClassRuntime[] {
    return [...this.dirtyClassRuntimes.values()].map((runtime) => structuredClone(runtime));
  }

  markClassRuntimesPersisted(persisted: Array<{ playerId: string; version: number }>): void {
    for (const entry of persisted) {
      if (this.dirtyClassRuntimes.get(entry.playerId)?.version === entry.version) {
        this.dirtyClassRuntimes.delete(entry.playerId);
      }
    }
  }

  disconnectPlayer(playerId: string): void {
    if (this.isPlayerReserved(playerId)) {
      this.deferredReplenishEffects.push(() => { this.disconnectPlayer(playerId); });
      return;
    }
    this.linkDeadPlayerIds.delete(playerId);
    this.pendingPlayerAttackApproachStops.delete(playerId);
    this.worldAbsentPlayerIds.delete(playerId);
    this.cancelPendingEquipmentCombatUpdates(playerId);
    this.replaceGivingTreeSource(playerId, []);
    this.balsamResinEffects.delete(playerId);
    this.battleDraughts.delete(playerId);
    this.antiVenomUntilMs.delete(playerId);
    this.vigorSerumUntilMs.delete(playerId);
    this.vigorSerumApplied.delete(playerId);
    this.fieldTraps.delete(playerId);
    this.givingTreeAuraDueTicks.delete(playerId);
    this.flagArrivalProtectionUntilByPlayer.delete(playerId);
    this.flagArrivalProtectionRevisionByPlayer.delete(playerId);
    this.maxHealthPenalties.delete(playerId);
    const entity = this.entities.get(playerId);
    if (!entity || entity.kind !== "player") {
      return;
    }
    const session = this.pveSessions.get(entity.entityId);
    if (session) session.requestedEndReason = "disconnect";
    this.rememberProfile(entity);
    this.endPveSession(entity, true, "disconnect");
    this.invalidateMobAiPlayer(playerId);
    const inscribed = [
      entity.equipmentCombatState?.inscribedWeapon?.instanceId,
      ...(entity.equipmentCombatState?.inscribedArmorIds ?? [])
    ].filter((id): id is string => typeof id === "string");
    if (inscribed.length > 0) void this.options.inscriptionStats?.flush?.(inscribed).catch(() => undefined);
    this.removeEntity(playerId, false);
    this.knownEntityRevisionsByPlayer.delete(playerId);
    this.networkSequenceByPlayer.delete(playerId);
    this.forceSnapshotPlayers.delete(playerId);
  }

  syncPlayer(input: {
    playerId: string;
    position: LatLon;
    regionCode: string;
    zoneId: string;
    name?: string;
  }): void {
    if (this.isPlayerReserved(input.playerId)) {
      this.deferredReplenishEffects.push(() => { this.syncPlayer(input); });
      return;
    }
    const entity = this.entities.get(input.playerId);
    if (!entity || entity.kind !== "player") {
      return;
    }
    const changed =
      entity.position.lat !== input.position.lat ||
      entity.position.lon !== input.position.lon ||
      entity.regionCode !== input.regionCode ||
      entity.zoneId !== input.zoneId ||
      (input.name !== undefined && input.name !== entity.name);
    const moved =
      entity.position.lat !== input.position.lat ||
      entity.position.lon !== input.position.lon;
    if (moved) this.breakFlagArrivalProtection(entity.entityId);
    if (moved) this.positionHistory.record(entity.entityId, this.currentTick, input.position.lat, input.position.lon);
    entity.position = { ...input.position };
    entity.regionCode = input.regionCode;
    entity.zoneId = input.zoneId;
    if (input.name !== undefined) {
      entity.name = input.name;
    }
    this.grid.update(entity.entityId, entity.position);
    if (changed) {
      this.recomputeInProgressWeaponSwitch(entity);
      this.markDirty(entity);
    }
  }

  spawnMob(input: {
    entityId?: string;
    archetype: MobArchetypeKey;
    appearanceVariant?: MobAppearanceVariant;
    position: LatLon;
    homePosition?: LatLon;
    populationCellId?: string | null;
    packId?: string | null;
    npcFaction?: Readonly<{
      cityId: string;
      cityName: string;
      culture: "goblin";
      role: "basic" | "warrior" | "archer" | "healer";
      presentationKey: string;
      invulnerable: true;
      annexRadiusM?: number;
    }>;
    lifeGeneration?: number;
    populationAuthority?: CombatPopulationAuthorityToken;
    worldAi?: boolean;
    regionCode: string;
    zoneId: string;
    originFlagId?: string | null;
    summonedByEntityId?: string;
    combatProfile?: {
      level: number;
      tier: MobChallengeTier;
      balanceVersion: number;
    };
    maxHealthMultiplier?: number;
    defenseOverride?: number;
    movementSpeedMpsOverride?: number;
    attackRangeMOverride?: number;
    bossEventState?: "dormant" | "active";
    bossLifecycleState?: BossLifecycleState;
    bossOwnership?: BossEntityOwnership;
    companion?: { ownerPlayerId: string; dogId: string; name: string; species: CompanionSpeciesId; baseMaxHealth: number; maxHealth: number; currentHealth: number; damage: number; mode?: DogCompanionMode };
    undead?: {
      ownerPlayerId: string;
      kind: UndeadKind;
      level: number;
      expiresAt: number;
      lich?: LichCombatSnapshot;
      currentHealth?: number;
    };
    populationRuntimeState?: unknown;
    /** Boss adds, raid defenders, minions, pets, helpers and split children: never ring sources. */
    summoned?: boolean;
    /** Pays no XP, gold or drops when killed, and leaves no revivable rubble (boss adds, rebuilt golems). */
    noRewards?: boolean;
  }): CombatEntitySnapshot {
    const definition = requireMobDefinition(input.archetype);
    const profile = resolveMobCombatProfile(
      input.archetype,
      input.combatProfile?.level ?? definition.level
    );
    if (
      input.combatProfile &&
      (
        input.combatProfile.tier !== profile.tier ||
        input.combatProfile.balanceVersion !== profile.balanceVersion
      )
    ) {
      throw new Error("Mob combat profile tier or balance version is inconsistent");
    }
    if (
      input.lifeGeneration !== undefined &&
      (!Number.isSafeInteger(input.lifeGeneration) || input.lifeGeneration < 0)
    ) {
      throw new Error("mob life generation must be a non-negative safe integer");
    }
    const populationAuthority = input.populationAuthority
      ? validatedPopulationAuthority(input.populationAuthority)
      : null;
    const entityId = input.entityId ?? `mob:${crypto.randomUUID()}`;
    const isTrueMob = !input.companion && !input.npcFaction && !input.undead;
    const appearanceVariant: MobAppearanceVariant = "normal";
    const worldAi = input.worldAi === true;
    const legacyRuntime = worldAi ? undefined : definition.legacyRuntime;
    if (this.entities.has(entityId)) {
      throw new Error(`Combat entity ${entityId} already exists`);
    }
    const maxHealthMultiplier = Number.isFinite(input.maxHealthMultiplier)
      ? Math.max(1, input.maxHealthMultiplier ?? 1)
      : 1;
    const normalMaxHealth = Math.max(1, Math.round(profile.maxHealth * maxHealthMultiplier));
    const scaledMaxHealth = normalMaxHealth;
    const restoredJellyfish = input.archetype === "jellyfish"
      ? restoreJellyfishRuntimeState(
          input.populationRuntimeState,
          scaledMaxHealth,
          normalMaxHealth,
          input.position,
          input.movementSpeedMpsOverride === undefined
            ? worldAi
              ? mobMovementSpeedMps(
                  definition.key,
                  this.options.playerMovementSpeedMps ?? DEFAULT_PLAYER_SPEED_MPS
                )
              : (legacyRuntime?.movementSpeedMultiplier ?? definition.movementSpeedMultiplier) *
                (this.options.playerMovementSpeedMps ?? DEFAULT_PLAYER_SPEED_MPS)
            : Math.max(0, input.movementSpeedMpsOverride),
          this.now()
        )
      : null;
    const initialPosition = restoredJellyfish?.position ?? input.position;
    const entity: Combatant = {
      entityId,
      kind: "mob",
      originFlagId: input.originFlagId ?? null,
      ...(input.summonedByEntityId ? { summonedByEntityId: input.summonedByEntityId } : {}),
      archetypeKey: definition.key,
      appearanceVariant,
      name: input.companion?.name ?? input.undead?.lich?.name ?? (input.npcFaction
        ? `Goblin ${input.npcFaction.role === "basic" ? "Defender" : input.npcFaction.role[0]!.toUpperCase() + input.npcFaction.role.slice(1)}`
        : definition.name),
      level: input.undead?.lich?.level ?? profile.level,
      challengeTier: profile.tier,
      combatBalanceVersion: profile.balanceVersion,
      regionCode: restoredJellyfish ? packageIdForPosition(initialPosition) : input.regionCode,
      zoneId: restoredJellyfish ? zoneIdForPosition(initialPosition) : input.zoneId,
      position: { ...initialPosition },
      homePosition: { ...(input.homePosition ?? input.position) },
      populationCellId: input.populationCellId ??
        spawnCellForPoint(input.position, input.regionCode).id,
      packId: input.packId ?? null,
      npcFaction: input.npcFaction
        ? { ...input.npcFaction, annexRadiusM: input.npcFaction.annexRadiusM ?? 300 }
        : null,
      companionOwnerPlayerId: input.companion?.ownerPlayerId ?? null,
      companionDogId: input.companion?.dogId ?? null,
      companionSpecies: input.companion?.species ?? null,
      companionBaseMaxHealth: input.companion?.baseMaxHealth ?? null,
      companionMode: input.companion?.mode ?? (input.companion ? "play" : null),
      ...(input.summoned || input.summonedByEntityId || input.companion || input.undead ? { summoned: true } : {}),
      ...(input.noRewards ? { noRewards: true } : {}),
      undead: input.undead
        ? {
            ownerPlayerId: input.undead.ownerPlayerId,
            kind: input.undead.kind,
            level: input.undead.level,
            expiresAt: input.undead.expiresAt,
            lich: input.undead.lich ?? null
          }
        : null,
      worldAi,
      mobAi: worldAi ? {
        phase: "idle",
        intent: null,
        targetPlayerId: null,
        deadlineTick: null,
        deadlineAtMs: null,
        nextAmbientSpeechRollAtMs: this.now() + GOBLIN_DEFENDER_CHATTER_INTERVAL_MS,
        ambientSpeech: null,
        observationCooldownUntilMs: 0,
        wanderTarget: null,
        nextWanderAtMs: this.now()
      } : null,
      jellyfishRuntime: restoredJellyfish?.runtime ??
        (input.archetype === "jellyfish" ? emptyJellyfishRuntime() : null),
      maxHealth: input.companion?.maxHealth ?? input.undead?.lich?.maxHealth ?? scaledMaxHealth,
      currentHealth: input.companion
        ? Math.max(0, Math.min(input.companion.maxHealth, input.companion.currentHealth))
        : input.undead
          ? Math.max(1, Math.min(
              input.undead.lich?.maxHealth ?? scaledMaxHealth,
              Math.trunc(input.undead.currentHealth ?? input.undead.lich?.maxHealth ?? scaledMaxHealth)
            ))
          : restoredJellyfish?.currentHealth ?? scaledMaxHealth,
      attackDamage: input.companion?.damage ?? input.undead?.lich?.attack ?? profile.attackPower,
      defense: input.undead?.lich
        ? input.undead.lich.defense
        : input.defenseOverride === undefined
          ? profile.defense
          : Math.max(0, Math.trunc(input.defenseOverride)),
      equipmentCombatState: null,
      equipmentAttackAdjustment: 0,
      equipmentDefenseAdjustment: 0,
      attackIntervalTicks: millisecondsToTicks(definition.attackIntervalMs, this.options.tickRateHz),
      attackRangeM: input.attackRangeMOverride === undefined
        ? definition.attackRangeM
        : Math.max(0, input.attackRangeMOverride),
      movementSpeedMps: input.movementSpeedMpsOverride === undefined
        ? legacyRuntime
          ? legacyRuntime.movementSpeedMultiplier *
            (this.options.playerMovementSpeedMps ?? DEFAULT_PLAYER_SPEED_MPS)
          : mobMovementSpeedMps(
              definition.key,
              this.options.playerMovementSpeedMps ?? DEFAULT_PLAYER_SPEED_MPS
            )
        : Math.max(0, input.movementSpeedMpsOverride),
      leashRadiusM: worldAi ? 0 : legacyRuntime?.leashRadiusM ?? definition.leashRadiusM,
      retaliates: definition.retaliates,
      bossEventState: input.bossEventState ?? null,
      bossLifecycleState: input.bossLifecycleState ??
        (input.bossEventState === "dormant" ? "dormant" : input.bossOwnership ? "active" : null),
      bossOwnership: input.bossOwnership
        ? {
            ...input.bossOwnership,
            ...(input.bossOwnership.appearanceVariant === undefined
              ? { appearanceVariant }
              : {})
          }
        : null,
      lifeState: "alive",
      activityState: "idle",
      targetEntityId: null,
      nextEligibleAttackTick: this.currentTick,
      scheduledAttackTick: null,
      attackScheduleGeneration: 0,
      lifeGeneration: input.lifeGeneration ?? 0,
      downedUntil: null,
      deathPenaltyOperationKey: null,
      respawnAvailableAt: null,
      populationAuthority,
      revision: 1,
      aggressiveUntilMs: 0,
      lastChaseUpdateTick: -COMBAT_CHASE_REEVALUATE_TICKS,
      chaseDestination: null,
      accountId: null,
      connectionId: null,
      classRuntime: null,
      aggroOwnerPlayerId: null,
      aggroOwnerSessionId: null,
      aggroOwnerSessionGeneration: null,
      aggroViewGeneration: null,
      tauntCooldownEndsAt: 0,
      threatPriorityPlayerId: null,
      threatPriorityRemainingActions: 0
    };
    this.entities.set(entity.entityId, entity);
    if (entity.originFlagId) {
      const flagEntityIds = this.entityIdsByOriginFlag.get(entity.originFlagId) ?? new Set<string>();
      flagEntityIds.add(entity.entityId);
      this.entityIdsByOriginFlag.set(entity.originFlagId, flagEntityIds);
    }
    this.grid.insert(entity.entityId, entity.position);
    this.setMobPosition(entity, entity.position, true);
    if (entity.jellyfishRuntime?.retreatPhase === "moving") {
      this.retreatingMobs.add(entity.entityId);
    } else if (entity.jellyfishRuntime?.retreatPhase === "preparing") {
      this.prepareJellyfishRetreat(entity);
    } else if (
      entity.jellyfishRuntime &&
      entity.jellyfishRuntime.retreatsCompleted < jellyfishRetreatsTriggered(entity.jellyfishRuntime)
    ) {
      this.startNextJellyfishRetreat(entity);
    }
    this.contributionsByMob.set(entity.entityId, new Map());
    this.markDirty(entity, false);
    this.emitEvent("MOB_SPAWNED", entity.entityId, entity.entityId);
    return this.snapshot(entity);
  }

  clearMobs(): number {
    const mobIds = [...this.entities.values()]
      .filter((entity) =>
        entity.kind === "mob" && !entity.companionDogId && !entity.npcFaction && !entity.undead
      )
      .map((entity) => entity.entityId)
      .sort();
    for (const mobId of mobIds) {
      this.emitEvent("MOB_REMOVED", mobId, mobId);
      this.removeEntity(mobId, true);
    }
    for (const session of [...this.pveSessions.values()]) {
      if (session.enemyIds.size > 0) continue;
      const player = this.entities.get(session.playerId);
      if (player) this.endPveSession(player, true, "enemies_cleared");
    }
    return mobIds.length;
  }

  relocateMob(entityId: string, position: LatLon): boolean {
    const entity = this.entities.get(entityId);
    if (!entity || entity.kind !== "mob" || entity.lifeState !== "alive") return false;
    this.setMobPosition(entity, { ...position }, true);
    entity.homePosition = { ...position };
    entity.chaseDestination = null;
    this.markDirty(entity);
    return true;
  }

  /** `scope` keeps a companion in its owner's interior (dungeon regions are not position-derived). */
  relocateCompanion(entityId: string, position: LatLon, scope?: Readonly<{ regionCode: string; zoneId: string }>): boolean {
    const entity = this.entities.get(entityId);
    if (!(entity?.companionDogId || entity?.undead) || entity.kind !== "mob" || entity.lifeState !== "alive") return false;
    entity.homePosition = { ...position };
    entity.chaseDestination = null;
    entity.regionCode = scope?.regionCode ?? packageIdForPosition(position);
    entity.zoneId = scope?.zoneId ?? zoneIdForPosition(position);
    this.setMobPosition(entity, { ...position }, true);
    this.markDirty(entity);
    return true;
  }

  setCompanionMode(
    entityId: string,
    mode: DogCompanionMode,
  ): boolean {
    const entity = this.entities.get(entityId);
    if (!entity?.companionDogId || entity.companionMode === mode) return Boolean(entity?.companionDogId);
    entity.companionMode = mode;
    this.markDirty(entity);
    return true;
  }

  nearbyKnownGivingTrees(position: LatLon, radiusM: number): readonly Readonly<{ id: string; position: LatLon }>[] {
    return this.givingTreeGrid.query(position, radiusM)
      .map((id) => ({ id, position: this.givingTreePositions.get(id) }))
      .filter((entry): entry is { id: string; position: LatLon } => entry.position !== undefined)
      .map(({ id, position: treePosition }) => ({ id, position: { ...treePosition } }));
  }

  lockMobMaxHealthMultiplier(entityId: string, multiplier: number): boolean {
    const entity = this.entities.get(entityId);
    if (
      !entity ||
      entity.kind !== "mob" ||
      entity.lifeState !== "alive" ||
      entity.currentHealth !== entity.maxHealth ||
      !Number.isFinite(multiplier) ||
      multiplier < 1
    ) return false;
    const scaled = Math.max(1, Math.round(entity.maxHealth * multiplier));
    entity.maxHealth = scaled;
    entity.currentHealth = scaled;
    this.markDirty(entity);
    return true;
  }

  /** Spawn-time stat tweak for a fresh mob (dungeon elites and split copies); health may shrink here. */
  scaleFreshMobStats(entityId: string, factors: Readonly<{ maxHealth?: number; movementSpeed?: number }>): boolean {
    const entity = this.entities.get(entityId);
    if (!entity || entity.kind !== "mob" || entity.lifeState !== "alive" ||
        entity.currentHealth !== entity.maxHealth) return false;
    if (factors.maxHealth !== undefined && Number.isFinite(factors.maxHealth) && factors.maxHealth > 0) {
      const scaled = Math.max(1, Math.round(entity.maxHealth * factors.maxHealth));
      entity.maxHealth = scaled;
      entity.currentHealth = scaled;
    }
    if (factors.movementSpeed !== undefined && Number.isFinite(factors.movementSpeed) && factors.movementSpeed > 0) {
      entity.movementSpeedMps *= factors.movementSpeed;
    }
    this.markDirty(entity);
    return true;
  }

  applyScriptedDamage(
    sourceEntityId: string,
    targetEntityId: string,
    damage: number,
    sourceTechniqueId: string,
    presentationSourceEntityId?: string
  ): number {
    const source = this.entities.get(sourceEntityId);
    const target = this.entities.get(targetEntityId);
    if (!source || !target || !Number.isFinite(damage) || damage <= 0) return 0;
    return this.applyDamage(
      source,
      target,
      Math.max(1, Math.round(damage)),
      sourceTechniqueId,
      true,
      {},
      0,
      true,
      undefined,
      presentationSourceEntityId === undefined ? {} : { presentationSourceEntityId }
    );
  }

  /** Resolve one owner-commanded military group hit through the normal combat authority. */
  applyMilitaryAttack(input: MilitaryAttackInput): number {
    const attacker = this.entities.get(input.attackerPlayerId);
    if (!attacker || attacker.kind !== "player") {
      throw new CombatRequestError("COMBAT_ATTACKER_NOT_FOUND", "Military attack owner is unavailable");
    }
    const target = this.entities.get(input.targetEntityId);
    if (!target) throw new CombatRequestError("COMBAT_TARGET_NOT_FOUND", "Target cannot be attacked");
    if (!Number.isFinite(input.damage) || input.damage <= 0 || !Number.isFinite(input.rangeM) || input.rangeM <= 0) {
      throw new CombatRequestError("COMBAT_ATTACK_INVALID", "Military attack values are invalid");
    }
    if (
      target.npcFaction &&
      !this.isNpcCityPlayerEnemy(target.npcFaction.cityId, attacker.entityId)
    ) {
      throw new CombatRequestError(
        "NPC_HOSTILITY_CONFIRMATION_REQUIRED",
        "Confirm hostility before attacking this neutral Goblin defender"
      );
    }
    if (this.isNinjaInvisible(target)) {
      throw new CombatRequestError("COMBAT_TARGET_NOT_FOUND", "Target is not visible");
    }
    if (
      target.kind === "mob" &&
      this.options.isPlayerMobAttackAuthorized &&
      !this.options.isPlayerMobAttackAuthorized(attacker.entityId, target.entityId)
    ) {
      throw new CombatRequestError(
        "DUNGEON_CHALLENGE_REQUIRED",
        "Confirm the encounter action before attacking this enemy"
      );
    }
    this.validateAttackPair(attacker, target, false);
    if (
      target.kind === "mob" &&
      target.aggroOwnerPlayerId !== null &&
      target.aggroOwnerPlayerId !== attacker.entityId &&
      !this.options.partyAuthority?.sameParty(target.aggroOwnerPlayerId, attacker.entityId) &&
      !this.options.isSharedMobCombat?.(target.entityId)
    ) {
      throw new CombatRequestError(
        "MOB_AGGRO_OWNED",
        "Enemy is already owned by another player's PvE combat session"
      );
    }
    const attackOrigin = input.attackOrigin ?? attacker.position;
    if (distanceMeters(attackOrigin, target.position) > input.rangeM) {
      throw new CombatRequestError(
        "COMBAT_TARGET_OUT_OF_RANGE",
        `Target is outside the military attack range of ${input.rangeM} meters`
      );
    }
    return this.applyDamage(
      attacker,
      target,
      Math.max(1, Math.round(input.damage)),
      input.sourceTechniqueId,
      true,
      {},
      0,
      true,
      "targeted"
    );
  }

  /**
   * One tower arrow against a player (structure warfare). The tower is not a
   * combatant: damage is the Guard Tower matrix row against the
   * target's armor, and the hit is announced as ATTACK_LANDED / DAMAGE from
   * the tower's combat source id so it shows in the target's combat feedback.
   * Returns the applied damage (0 when the player cannot be hit right now).
   */
  applyTowerAttack(input: Readonly<{
    flagId: string;
    targetPlayerId: string;
    damageMultiplier: number;
    /** Flat raw damage added before the multiplier (Beacon Wardens). */
    attackBonus?: number;
    /** Tower position; carried on ATTACK_LANDED so clients aim the arrow from the tower. */
    origin?: LatLon;
    /** Flat damage after the matrix (War Towers: base + Forward Sappers). */
    flatDamageBonus?: number;
  }>): number {
    const target = this.entities.get(input.targetPlayerId);
    if (!target || target.kind !== "player" || target.lifeState !== "alive") return 0;
    if (this.isPlayerReserved(target.entityId) || this.options.isEntityInvulnerable?.(target.entityId)) return 0;
    if (this.flagArrivalProtectionUntil(target.entityId) !== null || this.isNinjaInvisible(target)) return 0;
    const items = target.equipmentCombatState?.stats.items;
    const chest = items?.chest ?? null;
    const shield = items?.secondary?.category === "shield" ? items.secondary : null;
    const bodyProfile = resolveV3DefenseProfileForEquipmentFamily(
      equipmentGameplayFamily(chest?.definitionId ?? null)
    ).profile ?? "unarmored";
    const shieldProfile = shield
      ? resolveV3DefenseProfileForEquipmentFamily(equipmentGameplayFamily(shield.definitionId)).profile
      : null;
    let damage = towerAttackDamageAgainstPlayer(
      bodyProfile,
      shieldProfile === "shield" || shieldProfile === "wyrm_shield" ? shieldProfile : null,
      input.damageMultiplier,
      input.attackBonus ?? 0
    );
    if (input.flatDamageBonus !== undefined && input.flatDamageBonus > 0) {
      damage = warTowerArrowDamage(damage, input.flatDamageBonus);
    }
    const sourceEntityId = towerCombatSourceId(input.flagId);
    const healthBeforeDamage = target.currentHealth;
    const shields = target.classRuntime?.effects.filter((effect) =>
      effect.kind === "healing_shield" && effect.amount > 0 && effect.endTick >= this.currentTick &&
      !effect.enemyIds
    ).sort((left, right) => left.id.localeCompare(right.id)) ?? [];
    for (const absorbShield of shields) {
      const absorbed = Math.min(damage, Math.round(absorbShield.amount));
      damage -= absorbed;
      absorbShield.amount -= absorbed;
      if (absorbShield.amount <= 0 && target.classRuntime) {
        target.classRuntime.effects = target.classRuntime.effects.filter((effect) => effect !== absorbShield);
      }
      if (absorbed > 0) this.rememberClassRuntime(target);
      if (damage <= 0) break;
    }
    const appliedDamage = Math.min(target.currentHealth, damage);
    target.currentHealth = Math.max(0, target.currentHealth - damage);
    if (appliedDamage > 0 && target.classRuntime) {
      target.classRuntime.lastCombatAtMs = this.now();
      this.rememberClassRuntime(target);
    }
    this.markDirty(target);
    this.rememberProfile(target);
    const landed = this.emitEvent("ATTACK_LANDED", sourceEntityId, target.entityId, appliedDamage, target.currentHealth);
    if (input.origin) landed.position = { lat: input.origin.lat, lon: input.origin.lon };
    this.emitEvent("DAMAGE", sourceEntityId, target.entityId, appliedDamage, target.currentHealth);
    if (target.currentHealth <= 0 && target.lifeState === "alive") this.defeat(target, sourceEntityId);
    return appliedDamage;
  }

  /** `witheredFraction`: the share of the heal that still lands on a Withered target (default none). */
  healEntity(entityId: string, amount: number, sourceEntityId = entityId, witheredFraction = 0): number {
    const entity = this.entities.get(entityId);
    if (!entity || entity.lifeState !== "alive" || !Number.isFinite(amount) || amount <= 0) return 0;
    const effective = this.commitNormalHealing(sourceEntityId, entity, amount, witheredFraction).effective;
    if (effective > 0) this.persistCompanionHealth(entity);
    return effective;
  }

  /** Druid specialization effects on a Healing Aura: extra range and the share that heals Withered targets. */
  druidHealingAuraTraits(playerId: string): { extraRangeM: number; witheredFraction: number } {
    const skill = this.entities.get(playerId)?.classRuntime?.skillV3;
    if (skill?.activeSpecializationId !== "druid") return { extraRangeM: 0, witheredFraction: 0 };
    const rank = skill.specializationRank;
    return { extraRangeM: rank >= 1 ? 26 : 0, witheredFraction: rank >= 4 ? 0.8 : rank >= 2 ? 0.4 : 0 };
  }

  /**
   * The player's active class, server-authoritative (null = no class, or a hidden class). Same value as
   * classRuntime.skillV3.activeSpecializationId; GameState publishes it as PlayerSnapshot.classId.
   */
  playerActiveSpecializationId(playerId: string): SpecializationId | null {
    return this.entities.get(playerId)?.classRuntime?.skillV3?.activeSpecializationId ?? null;
  }

  generalSkillRank(playerId: string, skillId: GeneralSkillId): number {
    const rank = this.entities.get(playerId)?.classRuntime?.skillV3?.generalSkillRanks[skillId] ?? 0;
    return Math.max(0, Math.min(3, Math.trunc(rank)));
  }

  rescaleCompanionHealth(entityId: string, maxHealthMultiplier: number): boolean {
    const entity = this.entities.get(entityId);
    const baseMaxHealth = entity?.companionBaseMaxHealth;
    if (
      !entity || entity.kind !== "mob" || !entity.companionDogId ||
      !Number.isFinite(baseMaxHealth) || !baseMaxHealth || baseMaxHealth <= 0 ||
      !Number.isFinite(maxHealthMultiplier) || maxHealthMultiplier < 1
    ) return false;
    const ratio = entity.maxHealth > 0 ? entity.currentHealth / entity.maxHealth : 0;
    entity.maxHealth = Math.max(1, Math.round(baseMaxHealth * maxHealthMultiplier));
    entity.currentHealth = Math.max(0, Math.min(entity.maxHealth, Math.round(entity.maxHealth * ratio)));
    this.markDirty(entity);
    this.persistCompanionHealth(entity);
    return true;
  }

  despawnMob(entityId: string): boolean {
    const entity = this.entities.get(entityId);
    if (!entity || entity.kind !== "mob") return false;
    this.emitEvent("MOB_REMOVED", entityId, entityId);
    this.removeEntity(entityId, true);
    return true;
  }

  despawnPopulationManagedMob(entityId: string): boolean {
    const entity = this.entities.get(entityId);
    if (!entity || entity.kind !== "mob" || entity.populationAuthority === null) {
      return false;
    }
    return this.despawnMob(entityId);
  }

  despawnNpcCityDefenders(cityId: string): number {
    const entityIds = [...this.entities.values()]
      .filter((entity) => entity.kind === "mob" && entity.npcFaction?.cityId === cityId)
      .map((entity) => entity.entityId);
    for (const entityId of entityIds) this.despawnMob(entityId);
    this.npcCityEnemyPlayers.delete(cityId);
    return entityIds.length;
  }

  rebindPopulationAuthority(
    entityId: string,
    authority: CombatPopulationAuthorityToken
  ): boolean {
    const entity = this.entities.get(entityId);
    if (!entity || entity.kind !== "mob" || entity.populationAuthority === null) {
      return false;
    }
    entity.populationAuthority = validatedPopulationAuthority(authority);
    return true;
  }

  startAttack(input: {
    attackerId: string;
    targetEntityId: string;
    requestId: string;
    accountId: string;
    connectionId: string;
  }): { duplicate: boolean; attacker: CombatEntitySnapshot } {
    const requestKey = `${input.attackerId}:${input.requestId}`;
    if (this.seenRequestTicks.has(requestKey)) {
      const attacker = this.requireEntity(input.attackerId, "COMBAT_ATTACKER_NOT_FOUND");
      return { duplicate: true, attacker: this.snapshot(attacker) };
    }
    const attacker = this.requireEntity(input.attackerId, "COMBAT_ATTACKER_NOT_FOUND");
    const target = this.requireEntity(input.targetEntityId, "COMBAT_TARGET_NOT_FOUND");
    this.requirePlayerAuthority(attacker, input.accountId, input.connectionId);
    this.requireNotStunned(attacker);
    if (
      attacker.kind === "player" && target.npcFaction &&
      !this.isNpcCityPlayerEnemy(target.npcFaction.cityId, attacker.entityId)
    ) {
      throw new CombatRequestError(
        "NPC_HOSTILITY_CONFIRMATION_REQUIRED",
        "Confirm hostility before attacking this neutral Goblin defender"
      );
    }
    if (this.isNinjaInvisible(target)) {
      throw new CombatRequestError("COMBAT_TARGET_NOT_FOUND", "Target is not visible");
    }
    if (
      attacker.kind === "player" &&
      target.kind === "mob" &&
      this.options.isPlayerMobAttackAuthorized &&
      !this.options.isPlayerMobAttackAuthorized(attacker.entityId, target.entityId)
    ) {
      throw new CombatRequestError(
        "DUNGEON_CHALLENGE_REQUIRED",
        "Confirm the encounter action before attacking this enemy"
      );
    }
    this.validateAttackPair(attacker, target, false);
    if (attacker.kind === "player" && target.kind === "mob" && this.isArmedInMonastery(attacker)) {
      throw new CombatRequestError(
        "MONASTERY_UNARMED_ONLY",
        "Weapons are useless in the Monastery. Unequip your weapon to fight unarmed."
      );
    }
    if (
      attacker.kind === "player" &&
      target.kind === "mob" &&
      target.aggroOwnerPlayerId !== null &&
      target.aggroOwnerPlayerId !== attacker.entityId &&
      !this.options.partyAuthority?.sameParty(target.aggroOwnerPlayerId, attacker.entityId) &&
      !this.options.isSharedMobCombat?.(target.entityId)
    ) {
      throw new CombatRequestError(
        "MOB_AGGRO_OWNED",
        "Enemy is already owned by another player's PvE combat session"
      );
    }
    this.seenRequestTicks.set(requestKey, this.currentTick);
    this.pruneRequestIds();
    const swingState = this.swingStates.get(attacker.entityId);
    if (swingState) swingState.nextSwingTick = this.currentTick;

    if (attacker.kind === "player" && target.kind === "mob") {
      const session = this.ensurePveSession(attacker);
      if (
        !session.enemyIds.has(target.entityId) &&
        session.enemyQueue.length >= MAX_PVE_ENEMY_QUEUE_SIZE
      ) {
        throw new CombatRequestError("PVE_QUEUE_FULL", "PvE enemy queue is full");
      }
      this.breakFlagArrivalProtection(attacker.entityId);
      if (target.npcFaction && target.packId) {
        this.engageHostileGroup(target, attacker, session);
      }
      if (attacker.targetEntityId !== target.entityId) {
        const previousFocus = session.focusTargetEntityId;
        this.setTarget(attacker, target.entityId);
        session.focusTargetEntityId = target.entityId;
        if (previousFocus && previousFocus !== target.entityId) {
          session.telemetry.recordFocusSwitch(this.telemetryTime(session));
          this.resetFocusBoundClassState(attacker);
        }
      }
      session.focusPackId = target.packId;
      this.approachAttackTarget(attacker, target);
      const preservedScheduledTick = attacker.scheduledAttackTick;
      const dueTick = Math.max(
        this.currentTick + 1,
        attacker.nextEligibleAttackTick,
        session.nextBasicAttackTick ?? this.currentTick + 1,
        preservedScheduledTick ?? this.currentTick + 1
      );
      session.nextBasicAttackTick = dueTick;
      if (session.phase === "waiting_player") this.scheduleAttack(attacker, dueTick);
      this.noteSessionChanged(attacker, session);
      return { duplicate: false, attacker: this.snapshot(attacker) };
    }

    if (attacker.kind === "player") {
      this.breakFlagArrivalProtection(attacker.entityId);
      // An explicit Attack turns an automatic retaliation target into the player's own.
      this.pvpAutoRetaliationTargets.delete(attacker.entityId);
      // Walk to weapon range, then the scheduled attack swings.
      if (target.kind === "player") this.approachAttackTarget(attacker, target);
    }
    if (attacker.targetEntityId === target.entityId) {
      return { duplicate: false, attacker: this.snapshot(attacker) };
    }

    const preservedScheduledTick = attacker.scheduledAttackTick;
    this.setTarget(attacker, target.entityId);
    const dueTick = Math.max(
      this.currentTick + 1,
      attacker.nextEligibleAttackTick,
      preservedScheduledTick ?? this.currentTick + 1
    );
    this.scheduleAttack(attacker, dueTick);
    return { duplicate: false, attacker: this.snapshot(attacker) };
  }

  /** Walks a player to weapon range of the target; the first basic hit stops the walk. */
  private approachAttackTarget(attacker: Combatant, target: Combatant): void {
    const targetDistanceM = distanceMeters(attacker.position, target.position);
    const desiredWeaponSlot = attacker.equipmentCombatState
      ? this.desiredWeaponSlot(
          attacker.equipmentCombatState,
          targetDistanceM,
          "any"
        )
      : null;
    const prospectiveAttackRangeM = desiredWeaponSlot === "secondary"
      ? RANGED_ATTACK_RANGE_M
      : attacker.attackRangeM;
    this.pendingPlayerAttackApproachStops.set(attacker.entityId, target.entityId);
    if (targetDistanceM > prospectiveAttackRangeM) {
      this.options.movePlayerToward?.(
        attacker.entityId,
        moveToward(
          target.position,
          attacker.position,
          Math.max(0, prospectiveAttackRangeM - 0.1)
        )
      );
    }
  }

  cancelCombat(entityId: string): boolean {
    const entity = this.entities.get(entityId);
    if (!entity) {
      return false;
    }
    this.pendingPlayerAttackApproachStops.delete(entityId);
    const session = entity.kind === "player" ? this.pveSessions.get(entity.entityId) : null;
    if (session) {
      session.requestedEndReason = "cancelled";
      session.pendingNormal = null;
      session.pendingResetAbilityId = null;
      session.pendingResetTargetEntityId = null;
      session.pendingResetTargetMode = null;
      session.pendingResetActionSequence = null;
      this.endPveSession(entity, true, "cancelled");
      this.invalidateMobAiPlayer(entity.entityId);
      return true;
    }
    if (entity.kind === "player" && this.invalidateMobAiPlayer(entity.entityId)) {
      return true;
    }
    if (entity.targetEntityId === null) return false;
    this.clearTarget(entity);
    return true;
  }

  invalidateMobAiPlayer(playerId: string): boolean {
    let changed = false;
    for (const mob of [...this.entities.values()].sort((left, right) =>
      left.entityId.localeCompare(right.entityId)
    )) {
      if (
        mob.kind !== "mob" ||
        !mob.mobAi ||
        mob.mobAi.targetPlayerId !== playerId ||
        mob.aggroOwnerPlayerId !== null
      ) continue;
      this.cancelMobAiIntent(mob);
      changed = true;
    }
    return changed;
  }

  cancelAttack(entityId: string): boolean {
    this.pendingPlayerAttackApproachStops.delete(entityId);
    const entity = this.entities.get(entityId);
    if (!entity) return false;
    const hasCommittedV2Arm = entity.classRuntime?.queuedAbility?.activationCommitted === true &&
      requireTechniqueDefinition(entity.classRuntime.queuedAbility.abilityId).activation === "armed";
    if (entity.targetEntityId === null && !hasCommittedV2Arm) return false;
    this.invalidateScheduledAttack(entity);
    this.clearCommittedV2Armed(entity);
    if (entity.targetEntityId !== null) this.clearTarget(entity);
    return true;
  }

  cancelPlayerAttackApproach(playerId: string): void {
    this.pendingPlayerAttackApproachStops.delete(playerId);
  }

  /**
   * Action combat (plan §2): resolves one SWING press on the current tick, server-authoritatively.
   *
   * Gates, in order: the flag (`disabled`), a live, present, unstunned overworld player and a
   * monotonic seq (`unavailable`), a dash in flight (buffered until it lands, else `dashing`), and
   * the recovery gate (a press up to SWING_BUFFER_EARLY_TICKS early is buffered, else `too_soon`).
   * One buffer slot per player. A buffered swing returns `buffered: true` with no hits; its real
   * result is delivered once, on a later tick, through `options.onSwingResolved`.
   *
   * A resolved swing cancels the queued auto-attack, rewinds mob positions by the clamped lag hint,
   * hits up to SWING_MAX_TARGETS mobs inside the arc (nearest first) through the normal basic-attack
   * path scaled by the combo step's damage factor, and applies hitstun plus knockback to survivors.
   */
  resolveSwing(playerId: string, input: SwingInput): SwingResolution {
    const requestId = input.requestId ?? null;
    if (this.options.actionCombatEnabled?.() !== true) {
      return this.rejectSwing(playerId, input.seq, requestId, "disabled");
    }
    const player = this.entities.get(playerId);
    if (!player || player.kind !== "player") return this.rejectSwing(playerId, input.seq, requestId, "unavailable");
    const state = this.swingStateFor(player.entityId, input.connectionId);
    if (!(input.seq > state.lastSeq)) return this.rejectSwing(playerId, input.seq, requestId, "unavailable");
    state.lastSeq = input.seq;
    if (this.isSwingUnavailable(player) || !(Math.hypot(input.dirX, input.dirY) > 0.5)) {
      return this.rejectSwing(playerId, input.seq, requestId, "unavailable");
    }
    // A buffered swing that is already due resolves first, so presses keep their order.
    if (state.pending && !this.isSwingAttackerDashing(player) && this.currentTick >= state.nextSwingTick) {
      this.runPendingSwing(player, state);
    }
    const pending: PendingSwing = {
      seq: input.seq,
      dirX: input.dirX,
      dirY: input.dirY,
      lagMs: input.lagMs,
      requestId,
      bufferedAtTick: this.currentTick
    };
    if (this.isSwingAttackerDashing(player)) {
      if (state.pending) return this.rejectSwing(playerId, input.seq, requestId, "dashing");
      return this.bufferSwing(player.entityId, state, pending);
    }
    if (this.currentTick < state.nextSwingTick) {
      if (state.pending || state.nextSwingTick - this.currentTick > SWING_BUFFER_EARLY_TICKS) {
        return this.rejectSwing(playerId, input.seq, requestId, "too_soon");
      }
      return this.bufferSwing(player.entityId, state, pending);
    }
    return this.performSwing(player, state, pending);
  }

  /**
   * A dash clears swing recovery (dash-cancel); a swing pressed during the dash still waits for the landing.
   * A windup still in flight is cancelled too: its hit never lands (its combo step stays spent).
   */
  notePlayerDashed(playerId: string): void {
    const state = this.swingStates.get(playerId);
    if (!state) return;
    state.nextSwingTick = 0;
    if (state.windup) this.settleSwingWindup(playerId, state, false);
  }

  /** Swing counters for the once-a-minute `perf-server` line. */
  swingMetricsSnapshot(): Pick<
    CombatMetrics,
    "swingsResolved" | "swingHits" | "swingRejected" | "swingResolveMsMax" | "swingResolveMsTotal"
  > {
    return {
      swingsResolved: this.metrics.swingsResolved,
      swingHits: this.metrics.swingHits,
      swingRejected: this.metrics.swingRejected,
      swingResolveMsMax: this.metrics.swingResolveMsMax,
      swingResolveMsTotal: this.metrics.swingResolveMsTotal
    };
  }

  private swingStateFor(playerId: string, connectionId: string | undefined): PlayerSwingState {
    let state = this.swingStates.get(playerId);
    if (!state) {
      state = {
        lastSeq: -1,
        connectionId: connectionId ?? null,
        nextSwingTick: 0,
        lastSwingAtMs: 0,
        lastCombo: 0,
        pending: null,
        windup: null
      };
      this.swingStates.set(playerId, state);
    } else if (connectionId !== undefined && connectionId !== state.connectionId) {
      // A reconnect restarts the client's seq; a swing buffered on the old connection is dropped.
      state.connectionId = connectionId;
      state.lastSeq = -1;
      state.pending = null;
      this.pendingSwingIds.delete(playerId);
      state.windup = null;
      this.windupSwingIds.delete(playerId);
    }
    return state;
  }

  private isSwingUnavailable(player: Combatant): boolean {
    return player.lifeState !== "alive" ||
      this.worldAbsentPlayerIds.has(player.entityId) ||
      this.isPlayerReserved(player.entityId) ||
      this.stunEndTick(player) !== null ||
      this.isArmedInMonastery(player);
  }

  private isSwingAttackerDashing(player: Combatant): boolean {
    return this.options.isEntityDashing
      ? this.options.isEntityDashing(player.entityId)
      : this.options.isEntityInvulnerable?.(player.entityId) === true;
  }

  private bufferSwing(playerId: string, state: PlayerSwingState, pending: PendingSwing): SwingResolution {
    state.pending = pending;
    this.pendingSwingIds.add(playerId);
    return { ...this.swingResultBase(state, pending.seq, pending.requestId), hits: [], buffered: true };
  }

  private rejectSwing(
    playerId: string,
    seq: number,
    requestId: string | null,
    reason: SwingRejectReason
  ): SwingResolution {
    this.metrics.swingRejected += 1;
    const state = this.swingStates.get(playerId);
    return { ...this.swingResultBase(state, seq, requestId), hits: [], rejected: reason };
  }

  private swingResultBase(
    state: PlayerSwingState | undefined,
    seq: number,
    requestId: string | null
  ): Omit<SwingResolution, "hits"> {
    const nextSwingTick = Math.max(this.currentTick, state?.nextSwingTick ?? 0);
    return {
      seq,
      requestId,
      serverTick: this.currentTick,
      comboIndex: state?.lastCombo ?? 0,
      nextSwingAtMs: this.now() + (nextSwingTick - this.currentTick) * 1_000 / this.options.tickRateHz
    };
  }

  /** beginTick: resolves (or refuses) buffered swings whose dash has landed or whose recovery has ended. */
  private processPendingSwings(): void {
    for (const playerId of this.pendingSwingIds) {
      const player = this.entities.get(playerId);
      const state = this.swingStates.get(playerId);
      const pending = state?.pending;
      if (!player || !state || !pending) {
        this.pendingSwingIds.delete(playerId);
        if (state) state.pending = null;
        continue;
      }
      if (this.isSwingUnavailable(player)) {
        this.finishPendingSwing(playerId, state, "unavailable");
        continue;
      }
      const dashing = this.isSwingAttackerDashing(player);
      if (dashing || this.currentTick < state.nextSwingTick) {
        if (this.currentTick - pending.bufferedAtTick > SWING_PENDING_MAX_TICKS) {
          this.finishPendingSwing(playerId, state, dashing ? "dashing" : "too_soon");
        }
        continue;
      }
      this.runPendingSwing(player, state);
    }
  }

  private finishPendingSwing(playerId: string, state: PlayerSwingState, reason: SwingRejectReason): void {
    const pending = state.pending!;
    state.pending = null;
    this.pendingSwingIds.delete(playerId);
    this.options.onSwingResolved?.(playerId, this.rejectSwing(playerId, pending.seq, pending.requestId, reason));
  }

  private runPendingSwing(player: Combatant, state: PlayerSwingState): void {
    const pending = state.pending!;
    state.pending = null;
    this.pendingSwingIds.delete(player.entityId);
    const result = this.performSwing(player, state, pending);
    // A swing that started a windup answers `buffered` again: its one real result comes at contact (settleSwingWindup).
    if (!result.buffered) this.options.onSwingResolved?.(player.entityId, result);
  }

  /** Candidate filter for `selectSwingTargets`: game rules plus the rewound position. Allocation-free. */
  private readonly readSwingCandidate = (entityId: string, out: SwingCandidateSample): boolean => {
    const attacker = this.swingAttacker;
    const mob = this.entities.get(entityId);
    if (!attacker || !mob || mob.kind !== "mob" || mob.lifeState !== "alive") return false;
    if (mob.companionDogId || mob.undead?.ownerPlayerId === attacker.entityId) return false;
    if (this.isTacticsHopping(entityId)) return false;
    if (
      mob.npcFaction?.invulnerable === true ||
      this.invulnerableMobs.has(entityId) ||
      this.options.isEntityInvulnerable?.(entityId) === true
    ) return false;
    if (mob.npcFaction && !this.isNpcCityPlayerEnemy(mob.npcFaction.cityId, attacker.entityId)) return false;
    // Same ownership rule as startAttack: another (non-party) player's PvE session owns this mob.
    if (
      mob.aggroOwnerPlayerId !== null &&
      mob.aggroOwnerPlayerId !== attacker.entityId &&
      !this.options.partyAuthority?.sameParty(mob.aggroOwnerPlayerId, attacker.entityId) &&
      !this.options.isSharedMobCombat?.(entityId)
    ) return false;
    if (
      this.options.isPlayerMobAttackAuthorized &&
      !this.options.isPlayerMobAttackAuthorized(attacker.entityId, entityId)
    ) return false;
    // Every run is drawn around (0, 0): inside an interior only mobs of the attacker's own run can be hit.
    if (
      (attacker.regionCode.startsWith("interior:") || mob.regionCode.startsWith("interior:")) &&
      attacker.regionCode !== mob.regionCode
    ) return false;
    if (!this.isAttackPairValid(attacker, mob)) return false;
    const position = this.positionHistory.positionAtTick(
      entityId, this.swingSampleTick, mob.position, this.swingRewindPosition
    );
    out.lat = position.lat;
    out.lon = position.lon;
    // The mob's ground hurt circle (art-derived, hitGeometry.ts): big bodies are easier to hit, as on screen.
    out.radiusM = this.hurtRadiusM(mob);
    return true;
  };

  /** Candidate filter for the holy arc's allies: an eligible ally at their rewound position. Allocation-free. */
  private readonly readHolyArcAlly = (entityId: string, out: SwingCandidateSample): boolean => {
    const caster = this.swingAttacker;
    const ally = this.entities.get(entityId);
    if (!caster || !ally || !this.isHolyArcHealTarget(caster, ally)) return false;
    const position = this.positionHistory.positionAtTick(
      entityId, this.swingSampleTick, ally.position, this.swingRewindPosition
    );
    out.lat = position.lat;
    out.lon = position.lon;
    out.radiusM = PLAYER_HURT_RADIUS_M;
    return true;
  };

  /** Holy arc relations of an online player (null clears them, e.g. on disconnect). */
  setHolyArcRelations(playerId: string, relations: HolyArcPlayerRelations | null): void {
    if (relations) this.holyArcRelations.set(playerId, relations);
    else this.holyArcRelations.delete(playerId);
  }

  /**
   * How `target` relates to the Cleric `caster` for the holy arc: party, friend, same kingdom, same city, and enemy
   * (their kingdom or city is at war with the caster's, or they are fighting the caster or the caster's party).
   */
  holyArcRelation(caster: Combatant, target: Combatant): HolyArcAllyRelation {
    const own = this.holyArcRelations.get(caster.entityId);
    const theirs = this.holyArcRelations.get(target.entityId);
    const side = new Set([caster.entityId, ...this.partyMemberIds(caster.entityId)]);
    side.delete(target.entityId);
    // "Fighting" is the PvP rule's aggression between the two (pvpTimers), not a selected target: a support target
    // is selected too.
    const fighting = [...side].some((memberId) => this.options.pvpIsFighting?.(memberId, target.entityId) === true);
    const atWar = Boolean(own && theirs && (
      (theirs.kingdomId !== null && own.enemyKingdomIds.has(theirs.kingdomId)) ||
      (theirs.cityId !== null && own.enemyCityIds.has(theirs.cityId))
    ));
    return {
      party: this.options.partyAuthority?.sameParty(caster.entityId, target.entityId) === true,
      friend: own?.friendIds.has(target.entityId) === true,
      kingdom: Boolean(own?.kingdomId && own.kingdomId === theirs?.kingdomId),
      city: Boolean(own?.cityId && own.cityId === theirs?.cityId),
      enemy: fighting || atWar
    };
  }

  /** True when the Cleric's holy arc heals this player: never the caster, never an enemy, per the caster's settings. */
  private isHolyArcHealTarget(caster: Combatant, target: Combatant): boolean {
    if (caster.kind !== "player" || target.kind !== "player" || target.entityId === caster.entityId) return false;
    if (target.lifeState !== "alive" || !this.hasActiveAuthority(target)) return false;
    if (
      (caster.regionCode.startsWith("interior:") || target.regionCode.startsWith("interior:")) &&
      caster.regionCode !== target.regionCode
    ) return false;
    if (this.options.isPvpSupportRestricted?.(caster.entityId) === true && this.isEngagedInPvp(target)) return false;
    const settings = this.holyArcRelations.get(caster.entityId)?.settings ?? DEFAULT_HEAL_TARGET_SETTINGS;
    return holyArcHealsPlayer(this.holyArcRelation(caster, target), settings);
  }

  /**
   * Heals each ally the holy arc passed through (authoritative healEntity path, HEAL event with the Cleric as source)
   * and books the Cleric's kill credit on the mobs those allies are fighting.
   */
  private healHolyArcAllies(caster: Combatant, allyIds: readonly string[]): void {
    const amount = holyArcHealAmount(caster.attackDamage);
    if (amount <= 0) return;
    const nowMs = this.now();
    for (const allyId of allyIds) {
      const healed = this.healEntity(allyId, amount, caster.entityId);
      if (healed <= 0) continue;
      const session = this.pveSessions.get(allyId);
      if (!session) continue;
      for (const enemyId of session.enemyIds) {
        if (!this.isEnemyValidForSession(session, enemyId)) continue;
        const credits = this.holyArcHealCredits.get(enemyId) ?? new Map<string, { amount: number; atMs: number }>();
        const credit = credits.get(caster.entityId);
        credits.set(caster.entityId, { amount: (credit?.amount ?? 0) + healed, atMs: nowMs });
        this.holyArcHealCredits.set(enemyId, credits);
      }
    }
  }

  /** Adds the holy arc credits still inside HOLY_ARC_XP_CREDIT_WINDOW_MS to a dying mob's contributions, then drops them. */
  private mergeHolyArcHealCredits(mobId: string): void {
    const credits = this.holyArcHealCredits.get(mobId);
    if (!credits) return;
    this.holyArcHealCredits.delete(mobId);
    const nowMs = this.now();
    let contributions = this.contributionsByMob.get(mobId);
    for (const [casterId, credit] of credits) {
      if (nowMs - credit.atMs > HOLY_ARC_XP_CREDIT_WINDOW_MS || credit.amount <= 0) continue;
      contributions ??= new Map<string, number>();
      contributions.set(casterId, (contributions.get(casterId) ?? 0) + credit.amount);
    }
    if (contributions) this.contributionsByMob.set(mobId, contributions);
  }

  /** Ground hurt circle of a combatant, anchored at its feet: the player's fixed circle, or a mob's art-derived one. */
  private hurtRadiusM(entity: Combatant): number {
    if (entity.kind !== "mob") return PLAYER_HURT_RADIUS_M;
    const archetype = entity.archetypeKey ?? null;
    const spriteKey = archetype ? (requireMobDefinition(archetype) as { spriteKey?: string } | undefined)?.spriteKey ?? null : null;
    return mobHurtRadiusM(archetype, spriteKey);
  }

  /**
   * The readied weapon's shot rules (actionCombat.ts `shotProfileForWeapon`), or null when it swings: a staff or wand
   * casts the arcane blast, any other ranged weapon shoots the bow's arrow (plan §6).
   */
  private activeShotProfile(player: Combatant): ShotProfile | null {
    const state = player.equipmentCombatState;
    if (!state) return null;
    return shotProfileForWeapon(
      state.weaponCategory,
      state.stats.items[state.activeWeaponSlot]?.category === "ranged_weapon",
      { holyArc: this.options.clericArcEnabled?.() === true }
    );
  }

  /**
   * The combat style of a player (attackProfiles.ts `combatStyleFor`): its active specialization (else class) id and
   * readied weapon family. Swings play its profile; the combat snapshot carries it so every client animates the same.
   */
  private combatStyleOf(player: Combatant): CombatStyleId {
    if (player.kind !== "player") return "default";
    return combatStyleFor(
      player.classRuntime?.skillV3?.activeSpecializationId ?? player.classRuntime?.activeClassId ?? null,
      player.equipmentCombatState?.weaponCategory ?? null
    );
  }

  /**
   * Resolves one swing, or one shot when the readied weapon shoots (a ranged weapon, a staff or a wand). A shot is a
   * hitscan line (its ShotProfile's range x width) against the same rewound candidates that hits only the first mob on
   * the line, for the profile's damage factor, with hitstun but no knockback and the profile's recovery.
   * Shots have no combo: comboIndex is always 0, and a shot resets the melee chain (the next swing opens at 0).
   *
   * A swing plays its attack profile step (combo, cadence, damage factor, knockback). With "contact" hit timing the
   * swing is committed now (combo, recovery, SWING event) and its hit lands at contact, `windupMs` later, in
   * beginTick; its result then comes back like a buffered swing's (`buffered: true` now, the real one through
   * `onSwingResolved`). The default profile ("press") lands on the press, as before profiles.
   */
  private performSwing(player: Combatant, state: PlayerSwingState, swing: PendingSwing): SwingResolution {
    const startedAt = performance.now();
    const now = this.now();
    const tickMs = 1_000 / this.options.tickRateHz;
    const shotProfile = this.activeShotProfile(player);
    const shot = shotProfile !== null;
    // Defensive: a dash cancels a windup in flight, and recovery always outlasts one, so none should be left here.
    if (state.windup) this.settleSwingWindup(player.entityId, state, false);
    const style = this.combatStyleOf(player);
    const profile: AttackProfile = attackProfileForStyle(style);
    const comboIndex = (shot ? 0 : attackComboNextIndex(profile, state.lastCombo, state.lastSwingAtMs, now)) as SwingComboIndex;
    const step = attackProfileStep(profile, comboIndex);
    // Swings and the queued auto-attack never stack: a swing drops the queued target and its scheduled hit.
    this.cancelAttack(player.entityId);
    this.beginPlayerAction(player);
    const dirLength = Math.hypot(swing.dirX, swing.dirY);
    const dirX = swing.dirX / dirLength;
    const dirY = swing.dirY / dirLength;
    const windupTicks = shot ? 0 : attackStepServerHitDelayTicks(profile, step);
    if (windupTicks > 0) {
      state.nextSwingTick = this.currentTick + attackStepCycleTicks(step);
      state.lastSwingAtMs = now;
      state.lastCombo = comboIndex;
      state.windup = {
        swing,
        comboIndex,
        step,
        dueTick: this.currentTick + windupTicks,
        style,
        weaponInstanceId: player.equipmentCombatState?.activeWeaponInstanceId ?? null,
        regionCode: player.regionCode,
        zoneId: player.zoneId
      };
      this.windupSwingIds.add(player.entityId);
      // Other clients start the swing on the press; the DAMAGE events follow at contact.
      this.emitSwingEvent(player, swingEventAbilityId(comboIndex, profile), dirX, dirY, SWING_RANGE_M, null);
      this.immediateFlushPending = true;
      this.metrics.swingsResolved += 1;
      return { ...this.swingResultBase(state, swing.seq, swing.requestId), comboIndex, hits: [], buffered: true };
    }
    const { hits, shotReachM, shotTargetId } = this.resolveSwingHits(player, shotProfile, step, swing.lagMs, dirX, dirY);
    state.nextSwingTick = this.currentTick + (shotProfile ? shotProfile.recoveryTicks : attackStepCycleTicks(step));
    state.lastSwingAtMs = shot ? 0 : now;
    state.lastCombo = comboIndex;
    if (shot) this.emitSwingEvent(player, "shot", dirX, dirY, shotReachM, shotTargetId);
    else this.emitSwingEvent(player, swingEventAbilityId(comboIndex, profile), dirX, dirY, SWING_RANGE_M, null);
    // DAMAGE events and the SWING event ship this tick, not at the next 10 Hz delta slot.
    this.immediateFlushPending = true;
    const elapsedMs = performance.now() - startedAt;
    this.metrics.swingsResolved += 1;
    this.metrics.swingHits += hits.length;
    this.metrics.swingResolveMsTotal += elapsedMs;
    this.metrics.swingResolveMsMax = Math.max(this.metrics.swingResolveMsMax, elapsedMs);
    return {
      seq: swing.seq,
      requestId: swing.requestId,
      serverTick: this.currentTick,
      comboIndex,
      nextSwingAtMs: now + (state.nextSwingTick - this.currentTick) * tickMs,
      hits
    };
  }

  /**
   * The hit half of a swing or shot, on the current tick: rewinds mobs by the clamped lag hint, picks the targets in
   * the arc (or the first on the shot line) and deals the step's damage factor, hitstun and knockback. `shotProfile`
   * null = a swing.
   */
  private resolveSwingHits(
    player: Combatant,
    shotProfile: ShotProfile | null,
    step: AttackSwingStep,
    lagMs: number,
    dirX: number,
    dirY: number
  ): { hits: SwingHit[]; shotReachM: number; shotTargetId: string | null } {
    const shot = shotProfile !== null;
    const tickMs = 1_000 / this.options.tickRateHz;
    const rewindTicks = Math.round(Math.min(Math.max(0, lagMs), SWING_LAG_COMP_MAX_MS) / tickMs);
    const origin = player.position;
    const candidateIds = this.grid.query(
      origin,
      (shotProfile ? shotProfile.rangeM : SWING_RANGE_M) + MOB_HURT_RADIUS_MAX_M + rewindTicks * SWING_REWIND_QUERY_MARGIN_M_PER_TICK
    );
    if (!shot && this.mobTactics.mobs.size > 0 && this.mobArchetypesActive()) {
      this.triggerSkirmisherHops(player, dirX, dirY, candidateIds);
    }
    this.swingAttacker = player;
    this.swingSampleTick = this.currentTick - rewindTicks;
    let targetCount: number;
    let holyArcAllies: Array<{ id: string; alongM: number }> | null = null;
    try {
      targetCount = shotProfile
        ? selectShotTarget(origin.lat, origin.lon, dirX, dirY, candidateIds, this.readSwingCandidate, this.swingTargets, shotProfile)
        : selectSwingTargets(origin.lat, origin.lon, dirX, dirY, candidateIds, this.readSwingCandidate, this.swingTargets);
      if (shotProfile?.id === "holy_arc") {
        holyArcAllies = collectShotLineEntries(
          origin.lat, origin.lon, dirX, dirY, candidateIds, this.readHolyArcAlly, this.swingTargets, shotProfile
        );
      }
    } finally {
      this.swingAttacker = null;
    }
    // Shot reach for the client's projectile: distance along the line to the (rewound) target, or full range.
    const shotTargetId = shot && targetCount > 0 ? this.swingTargets.ids[0]! : null;
    const shotReachM = shotTargetId !== null ? this.swingTargets.distancesM[0]! : shotProfile?.rangeM ?? SHOT_RANGE_M;
    if (holyArcAllies !== null && holyArcAllies.length > 0) {
      // The holy arc heals every eligible ally on the line before the first enemy (the mob picked above).
      const entries: HolyArcLineEntry[] = holyArcAllies.map((ally) => ({ id: ally.id, alongM: ally.alongM, role: "ally" }));
      if (shotTargetId !== null) entries.push({ id: shotTargetId, alongM: shotReachM, role: "enemy" });
      this.healHolyArcAllies(player, resolveHolyArcPath(entries, shotProfile!.rangeM).healIds);
    }
    const hits: SwingHit[] = [];
    if (targetCount > 0) {
      this.breakFlagArrivalProtection(player.entityId);
      const session = this.ensurePveSession(player);
      const damageMultiplier = shotProfile ? shotProfile.damageFactor : step.damageMultiplier;
      for (let index = 0; index < targetCount; index += 1) {
        const mob = this.entities.get(this.swingTargets.ids[index]!);
        // An earlier hit in this swing (a proc, a chain) may already have finished this one.
        if (!mob || mob.lifeState !== "alive" || player.lifeState !== "alive") continue;
        if (!session.enemyIds.has(mob.entityId) && session.enemyQueue.length >= MAX_PVE_ENEMY_QUEUE_SIZE) continue;
        // Claim before damage (as startAttack + establishRetaliation do), so a kill routes loot and XP through the session.
        if (mob.npcFaction && mob.packId) this.engageHostileGroup(mob, player, session);
        if (mob.aggroOwnerPlayerId === null && this.claimMobAggro(mob, player, session)) {
          this.appendEnemy(session, mob.entityId);
        }
        const damage = this.resolveBasicAttack(player, mob, true, { damageMultiplier });
        if (this.mobTactics.mobs.size > 0) this.grabMobTactics(mob, player);
        hits.push({ entityId: mob.entityId, damage, currentHealth: Math.max(0, mob.currentHealth) });
        if (mob.lifeState !== "alive" || !this.entities.has(mob.entityId) || this.isBossMob(mob)) continue;
        const special = this.mobSpecial(mob);
        special.hitstunUntilTick = Math.max(special.hitstunUntilTick, this.currentTick + SWING_HITSTUN_TICKS);
        const knockbackM = shot ? 0 : step.knockbackM;
        if (knockbackM > 0 && !isDisplacementImmune(mob.archetypeKey)) {
          this.pushAwayFrom(origin, mob, knockbackM);
        }
        this.markDirty(mob);
      }
    }
    return { hits, shotReachM, shotTargetId };
  }

  /** beginTick: lands the hits of swing windups that reached contact. */
  private processSwingWindups(): void {
    for (const playerId of this.windupSwingIds) {
      const state = this.swingStates.get(playerId);
      if (!state?.windup) {
        this.windupSwingIds.delete(playerId);
        continue;
      }
      if (this.currentTick >= state.windup.dueTick) this.settleSwingWindup(playerId, state, true);
    }
  }

  /** The swing is still the one pressed: same style and weapon instance, same region and zone (no swap, no travel). */
  private windupStillValid(player: Combatant, windup: SwingWindup): boolean {
    return this.combatStyleOf(player) === windup.style &&
      (player.equipmentCombatState?.activeWeaponInstanceId ?? null) === windup.weaponInstanceId &&
      player.regionCode === windup.regionCode &&
      player.zoneId === windup.zoneId;
  }

  /**
   * Ends a windup and delivers its deferred result through `onSwingResolved`. With `land` (contact reached) and the
   * player still able to swing the same way, its hit resolves now; otherwise (dash, death, stun, weapon or style swap,
   * region or zone change) it lands nothing. Either way the
   * swing happened: the result is never `rejected`, so the client keeps the combo step.
   */
  private settleSwingWindup(playerId: string, state: PlayerSwingState, land: boolean): void {
    const windup = state.windup!;
    state.windup = null;
    this.windupSwingIds.delete(playerId);
    const player = this.entities.get(playerId);
    let hits: SwingHit[] = [];
    if (
      land && player?.kind === "player" && !this.isSwingUnavailable(player) && !this.isSwingAttackerDashing(player) &&
      this.windupStillValid(player, windup)
    ) {
      const dirLength = Math.hypot(windup.swing.dirX, windup.swing.dirY);
      hits = this.resolveSwingHits(
        player, null, windup.step, windup.swing.lagMs, windup.swing.dirX / dirLength, windup.swing.dirY / dirLength
      ).hits;
      this.metrics.swingHits += hits.length;
      if (hits.length > 0) this.immediateFlushPending = true;
    }
    const nextSwingTick = Math.max(this.currentTick, state.nextSwingTick);
    this.options.onSwingResolved?.(playerId, {
      seq: windup.swing.seq,
      requestId: windup.swing.requestId,
      serverTick: this.currentTick,
      comboIndex: windup.comboIndex,
      nextSwingAtMs: this.now() + (nextSwingTick - this.currentTick) * 1_000 / this.options.tickRateHz,
      hits
    });
  }

  /**
   * The SWING combat event: `position` = origin, `facingDegrees` = aim bearing, `radiusM` = reach. For a shot
   * the reach is the distance along the line to the mob it hit (also `targetEntityId`) or SHOT_RANGE_M on a
   * miss, so other clients can fly the projectile to the impact.
   */
  private emitSwingEvent(
    player: Combatant,
    abilityId: string,
    dirX: number,
    dirY: number,
    reachM: number,
    targetEntityId: string | null
  ): void {
    this.metrics.combatEventsEmitted += 1;
    this.pendingEvents.push({
      eventId: `${this.currentTick}:${++this.eventSequence}`,
      type: "SWING",
      tick: this.currentTick,
      sourceEntityId: player.entityId,
      targetEntityId,
      position: { lat: player.position.lat, lon: player.position.lon },
      radiusM: reachM,
      abilityId,
      facingDegrees: normalizeBearingDegrees(Math.atan2(dirX, dirY) * 180 / Math.PI)
    });
  }

  beginTick(): void {
    this.tickStartedAt = performance.now();
    this.currentTick += 1;
    this.applyPendingEquipmentCombatUpdates();
    if (this.windupSwingIds.size > 0) this.processSwingWindups();
    if (this.pendingSwingIds.size > 0) this.processPendingSwings();
    this.processGivingTreeAuras();
    this.processBalsamResinEffects();
    this.processFieldConsumables();
    this.processClassRuntimeTick();
    this.processEdictStrides();
    if (this.options.mobAiEnabled?.() !== false) {
      this.processMobRetreats();
      this.processWorldMobAi();
      this.processChases();
      this.processMobSpecials();
      if (this.mobTactics.mobs.size > 0) this.processMobTactics();
    }
    this.reconcilePveEnemyMembership();
    this.processPveSessions();
    if (this.orphanedMeleeStrikeMobIds.size > 0) this.resolveOrphanedMeleeStrikes();
  }

  replaceGivingTreeSource(
    sourceId: string,
    trees: readonly Readonly<{ id: string; lat: number; lon: number }>[]
  ): void {
    const previous = this.givingTreeSources.get(sourceId) ?? new Map();
    const next = new Map(
      trees.map((tree) => [
        tree.id,
        { lat: tree.lat, lon: tree.lon }
      ])
    );
    for (const treeId of previous.keys()) {
      if (next.has(treeId)) continue;
      this.releaseGivingTree(treeId);
    }
    for (const [treeId, position] of next) {
      const previousPosition = previous.get(treeId);
      if (
        previousPosition?.lat === position.lat &&
        previousPosition.lon === position.lon
      ) {
        continue;
      }
      if (!previousPosition) {
        const references = this.givingTreeReferenceCounts.get(treeId) ?? 0;
        this.givingTreeReferenceCounts.set(treeId, references + 1);
      }
      const currentPosition = this.givingTreePositions.get(treeId);
      if (!currentPosition) {
        this.givingTreePositions.set(treeId, position);
        this.givingTreeGrid.insert(treeId, position);
      } else if (
        currentPosition.lat !== position.lat ||
        currentPosition.lon !== position.lon
      ) {
        this.givingTreePositions.set(treeId, position);
        this.givingTreeGrid.update(treeId, position);
      }
    }
    if (next.size === 0) {
      this.givingTreeSources.delete(sourceId);
    } else {
      this.givingTreeSources.set(sourceId, next);
    }
  }

  /**
   * Adds or moves one tree in a source without touching the rest of it (player saplings change one
   * tree at a time; replacing the whole list would cost the whole world on every change).
   */
  upsertGivingTreeInSource(
    sourceId: string,
    tree: Readonly<{ id: string; lat: number; lon: number }>
  ): void {
    const trees = this.givingTreeSources.get(sourceId) ?? new Map<string, LatLon>();
    const previousPosition = trees.get(tree.id);
    const position = { lat: tree.lat, lon: tree.lon };
    if (previousPosition?.lat === position.lat && previousPosition.lon === position.lon) return;
    trees.set(tree.id, position);
    this.givingTreeSources.set(sourceId, trees);
    if (!previousPosition) {
      this.givingTreeReferenceCounts.set(tree.id, (this.givingTreeReferenceCounts.get(tree.id) ?? 0) + 1);
    }
    const currentPosition = this.givingTreePositions.get(tree.id);
    if (!currentPosition) {
      this.givingTreePositions.set(tree.id, position);
      this.givingTreeGrid.insert(tree.id, position);
    } else if (currentPosition.lat !== position.lat || currentPosition.lon !== position.lon) {
      this.givingTreePositions.set(tree.id, position);
      this.givingTreeGrid.update(tree.id, position);
    }
  }

  /** Removes one tree from one source (no-op when it is not there). */
  removeGivingTreeFromSource(sourceId: string, treeId: string): void {
    const trees = this.givingTreeSources.get(sourceId);
    if (!trees?.delete(treeId)) return;
    if (trees.size === 0) this.givingTreeSources.delete(sourceId);
    this.releaseGivingTree(treeId);
  }

  removeGivingTree(treeId: string): void {
    for (const [sourceId, trees] of this.givingTreeSources) {
      if (!trees.delete(treeId)) continue;
      if (trees.size === 0) this.givingTreeSources.delete(sourceId);
    }
    this.givingTreeReferenceCounts.delete(treeId);
    this.givingTreePositions.delete(treeId);
    this.givingTreeGrid.remove(treeId);
  }

  stageBalsamResinEffect(
    effect: BalsamResinEffectSnapshot,
    options: Readonly<{ fresh: boolean }>
  ): void {
    const now = this.now();
    const startedAt = Date.parse(effect.startedAt);
    const endsAt = Date.parse(effect.endsAt);
    if (!Number.isFinite(startedAt) || !Number.isFinite(endsAt)) return;
    if (now > endsAt) {
      void this.options.onBalsamResinEffectFinished?.(
        effect.playerId,
        effect.effectId,
        "completed"
      );
      return;
    }
    const player = this.entities.get(effect.playerId);
    const intervalMs = player?.kind === "player"
      ? this.v3BalsamResinTickIntervalMs(player, now)
      : BALSAM_RESIN_TICK_INTERVAL_MS;
    const nextTickIndex = options.fresh
      ? 0
      : Math.max(0, Math.floor((now - startedAt) / intervalMs) + 1);
    if (nextTickIndex >= BALSAM_RESIN_TOTAL_TICKS) return;
    this.balsamResinEffects.set(effect.playerId, {
      effect,
      nextTickIndex,
      nextTickAtMs: startedAt + nextTickIndex * intervalMs,
      tickIntervalMs: intervalMs,
      anchorMs: startedAt,
      anchorIndex: 0
    });
  }

  /** Anti-Venom Tonic state from the database: immunity, and the drink also clears Venom already running. */
  stageFieldBuffs(playerId: string, buffs: readonly FieldBuffSnapshot[], options: { drank?: boolean } = {}): void {
    const now = this.now();
    const serum = buffs.find((buff) => buff.buffId === "vigor_serum");
    if (serum?.endsAt && serum.endsAt > now) {
      this.vigorSerumUntilMs.set(playerId, serum.endsAt);
      this.setVigorSerumBonus(playerId, VIGOR_SERUM_MAX_HEALTH_BONUS, options.drank === true);
    } else {
      this.vigorSerumUntilMs.delete(playerId);
      this.setVigorSerumBonus(playerId, 0, false);
    }
    const antiVenom = buffs.find((buff) => buff.buffId === "anti_venom");
    if (antiVenom?.endsAt && antiVenom.endsAt > now) {
      this.antiVenomUntilMs.set(playerId, antiVenom.endsAt);
      const player = this.entities.get(playerId);
      const runtime = player?.classRuntime;
      if (player && runtime?.effects.some((effect) => effect.kind === "poison")) {
        runtime.effects = runtime.effects.filter((effect) => effect.kind !== "poison");
        this.markDirty(player);
      }
    } else {
      this.antiVenomUntilMs.delete(playerId);
    }
    const tidewater = buffs.find((buff) => buff.buffId === "tidewater");
    if (tidewater?.endsAt && tidewater.endsAt > now) this.tidewaterUntilMs.set(playerId, tidewater.endsAt);
    else this.tidewaterUntilMs.delete(playerId);
  }

  /**
   * Vigor Serum: sets the flat max-health bonus on the player (0 removes it). A fresh drink also heals by
   * the amount the maximum grew; ending it only clamps current health. The PvP penalty is computed on the
   * unpenalized maximum, so it stacks with this bonus the same way as the Warrior's.
   */
  private setVigorSerumBonus(playerId: string, target: number, heal: boolean): void {
    const player = this.entities.get(playerId);
    if (!player || player.kind !== "player") {
      if (target === 0) this.vigorSerumApplied.delete(playerId);
      return;
    }
    const applied = this.vigorSerumApplied.get(playerId) ?? 0;
    const delta = target - applied;
    if (delta === 0) return;
    if (this.isPlayerReserved(playerId)) {
      this.deferredReplenishEffects.push(() => { this.setVigorSerumBonus(playerId, target, heal); });
      return;
    }
    const previousMaxHealth = player.maxHealth;
    player.maxHealth = this.penalizedMaxHealth(
      player,
      Math.max(1, player.maxHealth + (player.maxHealthPenaltyApplied ?? 0) + delta)
    );
    if (target === 0) this.vigorSerumApplied.delete(playerId);
    else this.vigorSerumApplied.set(playerId, target);
    if (delta > 0 && heal && player.lifeState === "alive") {
      player.currentHealth = Math.min(player.maxHealth, player.currentHealth + Math.max(0, player.maxHealth - previousMaxHealth));
    } else if (delta < 0) {
      player.currentHealth = Math.min(player.currentHealth, player.maxHealth);
    }
    this.markDirty(player);
    this.rememberProfile(player);
  }

  /** Vigor Serum ends on expiry or death. */
  private processVigorSerum(): void {
    if (this.vigorSerumUntilMs.size === 0) return;
    const now = this.now();
    for (const [playerId, until] of this.vigorSerumUntilMs) {
      const player = this.entities.get(playerId);
      if (until <= now) {
        this.vigorSerumUntilMs.delete(playerId);
        this.setVigorSerumBonus(playerId, 0, false);
        this.options.onFieldBuffsChanged?.(playerId);
      } else if (player && player.lifeState !== "alive") {
        this.vigorSerumUntilMs.delete(playerId);
        this.setVigorSerumBonus(playerId, 0, false);
        this.options.onVigorSerumLost?.(playerId);
      }
    }
  }

  /** Tidewater Draught: full land speed while afloat. */
  hasTidewaterDraught(playerId: string): boolean {
    const until = this.tidewaterUntilMs.get(playerId);
    return until !== undefined && until > this.now();
  }

  isVenomImmune(entity: Combatant): boolean {
    if (entity.kind !== "player") return false;
    const until = this.antiVenomUntilMs.get(entity.entityId);
    return until !== undefined && until > this.now();
  }

  /** Whether a Battle Draught is running; the travel lock does not apply while it is. */
  hasBattleDraught(playerId: string): boolean {
    return this.battleDraughts.has(playerId);
  }

  /** Engine-held buffs for the indicator (the persistent ones come from the database). */
  fieldBuffSnapshots(playerId: string): FieldBuffSnapshot[] {
    const draught = this.battleDraughts.get(playerId);
    return draught ? [{ buffId: "battle_draught", startedAt: draught.startedAtMs, endsAt: null }] : [];
  }

  /** Read-only validation so nothing is debited for a use that cannot land. */
  checkFieldConsumable(
    playerId: string,
    itemId: FieldConsumableItemId,
    targetEntityId: string | null
  ): FieldConsumableRejection | null {
    const player = this.entities.get(playerId);
    if (!player || player.kind !== "player" || player.lifeState !== "alive" || this.worldAbsentPlayerIds.has(playerId)) {
      return { code: "FIELD_CONSUMABLE_PLAYER_UNAVAILABLE", message: "You cannot use that right now." };
    }
    switch (itemId) {
      case "battle_draught": {
        if (this.battleDraughts.has(playerId)) {
          return { code: "BATTLE_DRAUGHT_ACTIVE", message: "A Battle Draught is already active." };
        }
        if (player.currentHealth <= battleDraughtHealthCost(player)) {
          return { code: "BATTLE_DRAUGHT_TOO_WOUNDED", message: "You are too wounded to drink that." };
        }
        return null;
      }
      case "field_net": {
        const target = targetEntityId ? this.entities.get(targetEntityId) : undefined;
        if (!target) return { code: "FIELD_NET_NO_TARGET", message: "Select a monster to throw the Net at." };
        if (target.kind === "player") return { code: "FIELD_NET_TARGET_PLAYER", message: "A Net cannot hold a player." };
        if (target.kind !== "mob" || target.lifeState !== "alive") {
          return { code: "FIELD_NET_TARGET_INVALID", message: "That target cannot be netted." };
        }
        if (this.isBossMob(target)) return { code: "FIELD_NET_TARGET_BOSS", message: "A boss is too strong to be netted." };
        if (distanceMeters(player.position, target.position) > NET_RANGE_M) {
          return { code: "FIELD_NET_OUT_OF_RANGE", message: "That monster is too far away." };
        }
        if (!this.isAttackPairValid(player, target)) {
          return { code: "FIELD_NET_TARGET_INVALID", message: "That target cannot be netted." };
        }
        return null;
      }
      case "field_trap": {
        const existing = this.fieldTraps.get(playerId);
        if (existing && existing.expiresAtMs > this.now()) {
          return { code: "FIELD_TRAP_ALREADY_SET", message: "You already have a Trap set." };
        }
        return null;
      }
      case "undertow_snare": {
        const existing = this.undertowSnares.get(playerId);
        if (existing && existing.expiresAtMs > this.now()) {
          return { code: "UNDERTOW_SNARE_ALREADY_SET", message: "You already have an Undertow Snare set." };
        }
        return null;
      }
      case "free_step_ward": {
        const existing = this.freeStepWards.get(playerId);
        if (existing && existing.expiresAtMs > this.now()) {
          return { code: "FREE_STEP_WARD_ALREADY_SET", message: "Your Free-Step Ward is still standing." };
        }
        return null;
      }
      case "stillwater_orb": {
        if (!targetEntityId) return null;
        const target = this.entities.get(targetEntityId);
        if (!target || target.lifeState !== "alive") {
          return { code: "STILLWATER_ORB_TARGET_INVALID", message: "That target cannot be reached." };
        }
        if (distanceMeters(player.position, target.position) > STILLWATER_ORB_RANGE_M) {
          return { code: "STILLWATER_ORB_OUT_OF_RANGE", message: "That target is too far away to throw at." };
        }
        return null;
      }
      default:
        return null;
    }
  }

  /** Whether a Free-Step Ward shields this entity from roots, nets and traps. */
  isFreeStepProtected(target: Combatant): boolean {
    if (this.freeStepWards.size === 0) return false;
    const now = this.now();
    for (const [ownerId, ward] of this.freeStepWards) {
      if (ward.expiresAtMs <= now || ward.zoneId !== target.zoneId) continue;
      if (distanceMeters(ward.position, target.position) > FREE_STEP_WARD_RADIUS_M) continue;
      if (!ward.alliesOnly) return true;
      if (target.kind === "player" && this.isTidecraftAlly(ownerId, target.entityId, ward.allyPlayerIds)) return true;
    }
    return false;
  }

  /** The owner, a party member, or a kingdom member at placement. */
  private isTidecraftAlly(ownerId: string, playerId: string, kingdomAllies: ReadonlySet<string>): boolean {
    return ownerId === playerId || kingdomAllies.has(playerId) ||
      this.options.partyAuthority?.sameParty(ownerId, playerId) === true;
  }

  private tidecraftRankOf(playerId: string): number {
    return Math.max(0, Math.min(3, Math.trunc(this.options.tidecraftRank?.(playerId) ?? 0)));
  }

  /** Defense +1/+1/+2 and Attack +0/+1/+2 by rank against Tide Wraiths and Drowned Citizens. */
  private tidecraftMatchupBonus(player: Combatant, mob: Combatant | undefined, stat: "attack" | "defense"): number {
    if (player.kind !== "player" || mob?.kind !== "mob" || !TIDECRAFT_MATCHUP_MOB_KEYS.includes(mob.archetypeKey ?? "")) return 0;
    const rank = this.tidecraftRankOf(player.entityId);
    return (stat === "attack" ? TIDECRAFT_ATTACK_BONUS : TIDECRAFT_DEFENSE_BONUS)[rank] ?? 0;
  }

  /** Leatherworking: rank 1 +2 Defense and rank 2 +2 Attack against monsters whose drop table includes leather. */
  private leatherworkingMatchupBonus(player: Combatant, mob: Combatant | undefined, stat: "attack" | "defense"): number {
    if (player.kind !== "player" || mob?.kind !== "mob" || !mobDropsLeather(mob.archetypeKey)) return 0;
    const rank = player.classRuntime?.skillV3?.generalSkillRanks.leatherworking ?? 0;
    return rank >= (stat === "attack" ? LEATHERWORKING_ATTACK_MIN_RANK : LEATHERWORKING_DEFENSE_MIN_RANK) ? LEATHERWORKING_MATCHUP_BONUS : 0;
  }

  /** Deepstone Lore: rank 2 +2 Attack and rank 3 +2 Defense (PvE and PvP) within 140 m of a cave entrance. */
  private deepstoneCaveBonus(player: Combatant, stat: "attack" | "defense"): number {
    if (player.kind !== "player" || !this.options.deepstoneRank || !this.options.isNearCave) return 0;
    const rank = Math.max(0, Math.min(3, Math.trunc(this.options.deepstoneRank(player.entityId))));
    if (rank < (stat === "attack" ? DEEPSTONE_ATTACK_MIN_RANK : DEEPSTONE_DEFENSE_MIN_RANK)) return 0;
    return this.options.isNearCave(player.position, DEEPSTONE_CAVE_BONUS_RADIUS_M) ? 2 : 0;
  }

  /** Last tick of an active stun on the entity, or null when it is not stunned. */
  private stunEndTick(entity: Combatant): number | null {
    let end: number | null = null;
    for (const effect of entity.classRuntime?.effects ?? []) {
      if (effect.kind === "stunned" && effect.endTick >= this.currentTick) end = Math.max(end ?? 0, effect.endTick);
    }
    return end;
  }

  /** A stunned player cannot attack or use actives. */
  private requireNotStunned(player: Combatant): void {
    if (player.kind === "player" && this.stunEndTick(player) !== null) {
      throw new CombatRequestError("PLAYER_STUNNED", "You are stunned");
    }
  }

  /** Stuns a target for `durationMs` unless it is held-immune; players stop moving, mobs are rooted and silenced. */
  private applyStun(source: Combatant, target: Combatant, durationMs: number, immunityMs: number, techniqueId: string): boolean {
    if (target.lifeState !== "alive" || this.hasEffect(target, "stunned") || this.hasEffect(target, "stun_immunity")) return false;
    if (target.kind === "mob" && this.isBossMob(target)) return false;
    if (this.isFreeStepProtected(target)) return false;
    if (target.kind === "mob") this.holdMob(source, target, durationMs, techniqueId);
    this.addTimedEffect(source, target, "stunned", techniqueId, durationMs, 1);
    this.addTimedEffect(source, target, "stun_immunity", `${techniqueId}_immunity`, durationMs + immunityMs, 1);
    if (target.kind === "player") this.options.stopPlayer?.(target.entityId);
    return true;
  }

  /** Monk ranks 2-5: a Staff/Sling hit may stun its target (PvE and PvP). */
  private rollMonkStun(attacker: Combatant, target: Combatant, appliedDamage: number): void {
    const skill = attacker.classRuntime?.skillV3;
    if (attacker.kind !== "player" || appliedDamage <= 0 || skill?.activeSpecializationId !== "monk") return;
    const chance = MONK_STUN.chanceByRank[Math.min(5, Math.max(0, skill.specializationRank))] ?? 0;
    if (chance <= 0) return;
    const family = equipmentGameplayFamily(attacker.classRuntime?.weaponDefinitionId ?? null) ??
      attacker.classRuntime?.weaponCategory ?? null;
    if (family !== "staff" && family !== "sling") return;
    if (target.lifeState !== "alive" || !this.metalProcTargetable(attacker, target)) return;
    if ((this.options.random?.() ?? Math.random()) >= chance) return;
    this.applyStun(attacker, target, MONK_STUN.durationMs, MONK_STUN.immunityMs, "monk_stun");
  }

  /** Applies a debited field consumable; a rejection means the caller refunds it. */
  applyFieldConsumable(
    playerId: string,
    itemId: FieldConsumableItemId,
    targetEntityId: string | null,
    useOptions: FieldConsumableUseOptions = {}
  ): FieldConsumableOutcome | FieldConsumableRejection {
    const rejection = this.checkFieldConsumable(playerId, itemId, targetEntityId);
    if (rejection) return rejection;
    const player = this.entities.get(playerId)!;
    const now = this.now();
    switch (itemId) {
      case "battle_draught": {
        player.currentHealth = Math.max(1, player.currentHealth - battleDraughtHealthCost(player));
        this.markDirty(player);
        this.battleDraughts.set(playerId, { startedAtMs: now, engaged: false });
        return { itemId, hits: 0 };
      }
      case "field_net": {
        const target = this.entities.get(targetEntityId!)!;
        this.holdMob(player, target, NET_HOLD_MS, "field_net");
        return { itemId, hits: 1 };
      }
      case "field_trap": {
        this.fieldTraps.set(playerId, {
          position: { ...player.position },
          expiresAtMs: now + TRAP_LIFETIME_MS
        });
        return { itemId, hits: 0 };
      }
      case "ember_flask": {
        const origin = { ...player.position };
        let hits = 0;
        // Alchemy rank 3: +22% damage, and surviving non-boss monsters are left with Opened Guard.
        const alchemist = (player.classRuntime?.skillV3?.generalSkillRanks.alchemy ?? 0) >= ALCHEMY_EMBER_MIN_RANK;
        const emberDamage = alchemist ? Math.round(EMBER_FLASK_DAMAGE * ALCHEMY_EMBER_DAMAGE_MULTIPLIER) : EMBER_FLASK_DAMAGE;
        for (const id of this.nearbyEntityIds(origin, EMBER_FLASK_RADIUS_M).sort()) {
          const entity = this.entities.get(id);
          if (!entity || entity.lifeState !== "alive" || !this.isAttackPairValid(player, entity)) continue;
          if (distanceMeters(origin, entity.position) > EMBER_FLASK_RADIUS_M) continue;
          this.applyDamage(
            player, entity, emberDamage, "ember_flask", false, {}, 0, false, "area",
            { fixedFinalDamage: emberDamage }
          );
          if (alchemist && entity.kind === "mob" && entity.lifeState === "alive" && !this.isBossMob(entity)) {
            this.applyOpenedGuard(player, entity, ALCHEMY_OPENED_GUARD_AMOUNT);
          }
          hits += 1;
        }
        return { itemId, hits, origin, radiusM: EMBER_FLASK_RADIUS_M, damage: emberDamage };
      }
      case "undertow_snare":
      case "free_step_ward": {
        const field: TidecraftField = {
          position: { ...player.position },
          zoneId: player.zoneId,
          expiresAtMs: now + (itemId === "undertow_snare" ? UNDERTOW_SNARE_LIFETIME_MS : FREE_STEP_WARD_LIFETIME_MS),
          alliesOnly: this.tidecraftRankOf(playerId) >= TIDECRAFT_ALLY_FILTER_MIN_RANK,
          allyPlayerIds: new Set(useOptions.allyPlayerIds ?? []),
          nextPullAtMs: now
        };
        (itemId === "undertow_snare" ? this.undertowSnares : this.freeStepWards).set(playerId, field);
        return {
          itemId, hits: 0, origin: field.position,
          radiusM: itemId === "undertow_snare" ? UNDERTOW_SNARE_RADIUS_M : FREE_STEP_WARD_RADIUS_M
        };
      }
      case "stillwater_orb": {
        const target = targetEntityId ? this.entities.get(targetEntityId) : undefined;
        const origin = { ...(target?.position ?? player.position) };
        const blocksHealing = this.tidecraftRankOf(playerId) >= STILLWATER_ORB_HEAL_BLOCK_MIN_RANK;
        let hits = 0;
        for (const id of this.nearbyEntityIds(origin, STILLWATER_ORB_RADIUS_M).sort()) {
          const entity = this.entities.get(id);
          if (!entity || entity.lifeState !== "alive" || this.isBossMob(entity) || !this.isAttackPairValid(player, entity)) continue;
          if (distanceMeters(origin, entity.position) > STILLWATER_ORB_RADIUS_M) continue;
          if (blocksHealing) this.addTimedEffect(player, entity, "gloom", "stillwater_orb", STILLWATER_ORB_ROOT_MS, 1);
          if (this.isFreeStepProtected(entity)) continue;
          this.addTimedEffect(player, entity, "rooted", "stillwater_orb", STILLWATER_ORB_ROOT_MS, 1);
          if (entity.kind === "player") {
            // Players are held in place (the movement tick skips them) for the whole root.
            this.addTimedEffect(player, entity, "immobilized", "stillwater_orb", STILLWATER_ORB_ROOT_MS, 1);
            this.options.stopPlayer?.(entity.entityId);
          }
          hits += 1;
        }
        return { itemId, hits, origin, radiusM: STILLWATER_ORB_RADIUS_M };
      }
      default:
        return { code: "FIELD_CONSUMABLE_NOT_ENGINE", message: "That item has no combat effect." };
    }
  }

  /** Holds a monster in place: it cannot move (rooted) or deal damage (stunned). */
  private holdMob(source: Combatant, mob: Combatant, durationMs: number, techniqueId: string): void {
    if (this.isFreeStepProtected(mob)) return;
    this.addTimedEffect(source, mob, "rooted", techniqueId, durationMs, 1);
    const state = this.mobSpecial(mob);
    state.stunUntilTick = Math.max(
      state.stunUntilTick,
      this.currentTick + millisecondsToTicks(durationMs, this.options.tickRateHz)
    );
    this.markDirty(mob);
  }

  private processFieldConsumables(): void {
    this.processTidecraftFields();
    this.processVigorSerum();
    if (this.battleDraughts.size === 0 && this.fieldTraps.size === 0) return;
    const now = this.now();
    for (const [playerId, draught] of this.battleDraughts) {
      const player = this.entities.get(playerId);
      const aggressive = player?.kind === "player" && player.aggressiveUntilMs > now;
      if (!player || player.lifeState !== "alive") {
        this.endBattleDraught(playerId);
      } else if (aggressive) {
        draught.engaged = true;
      } else if (draught.engaged || now - draught.startedAtMs > BATTLE_DRAUGHT_ENGAGE_WINDOW_MS) {
        this.endBattleDraught(playerId);
      }
    }
    for (const [playerId, trap] of this.fieldTraps) {
      const owner = this.entities.get(playerId);
      if (!owner || trap.expiresAtMs <= now) {
        this.fieldTraps.delete(playerId);
        continue;
      }
      const victim = this.nearbyEntityIds(trap.position, TRAP_TRIGGER_RADIUS_M).sort()
        .map((id) => this.entities.get(id))
        .find((entity): entity is Combatant =>
          entity !== undefined && entity.kind === "mob" && entity.lifeState === "alive" &&
          !this.isBossMob(entity) && this.isAttackPairValid(owner, entity) &&
          distanceMeters(trap.position, entity.position) <= TRAP_TRIGGER_RADIUS_M
        );
      if (!victim) continue;
      this.fieldTraps.delete(playerId);
      this.holdMob(owner, victim, TRAP_HOLD_MS, "field_trap");
    }
  }

  /** Tidewater loss on death and expiry, ward expiry, and the Undertow Snare pull. */
  private processTidecraftFields(): void {
    if (this.tidewaterUntilMs.size === 0 && this.undertowSnares.size === 0 && this.freeStepWards.size === 0) return;
    const now = this.now();
    for (const [playerId, until] of this.tidewaterUntilMs) {
      const player = this.entities.get(playerId);
      if (until <= now) {
        this.tidewaterUntilMs.delete(playerId);
        this.options.onFieldBuffsChanged?.(playerId);
      } else if (player && player.lifeState !== "alive") {
        this.tidewaterUntilMs.delete(playerId);
        this.options.onTidewaterLost?.(playerId);
      }
    }
    for (const [ownerId, ward] of this.freeStepWards) {
      if (ward.expiresAtMs <= now) this.freeStepWards.delete(ownerId);
    }
    for (const [ownerId, snare] of this.undertowSnares) {
      const owner = this.entities.get(ownerId);
      if (!owner || snare.expiresAtMs <= now) {
        this.undertowSnares.delete(ownerId);
        continue;
      }
      if (now < snare.nextPullAtMs) continue;
      snare.nextPullAtMs = now + UNDERTOW_SNARE_PULL_INTERVAL_MS;
      const stepM = UNDERTOW_SNARE_PULL_MPS * UNDERTOW_SNARE_PULL_INTERVAL_MS / 1_000;
      for (const id of this.nearbyEntityIds(snare.position, UNDERTOW_SNARE_RADIUS_M).sort()) {
        const entity = this.entities.get(id);
        if (!entity || entity.entityId === ownerId || entity.lifeState !== "alive" || entity.zoneId !== snare.zoneId) continue;
        if (this.isBossMob(entity) || !this.isAttackPairValid(owner, entity) || this.isFreeStepProtected(entity)) continue;
        if (snare.alliesOnly && entity.kind === "player" && this.isTidecraftAlly(ownerId, entity.entityId, snare.allyPlayerIds)) continue;
        const distanceM = distanceMeters(entity.position, snare.position);
        if (distanceM > UNDERTOW_SNARE_RADIUS_M || distanceM <= UNDERTOW_SNARE_HOLD_M) continue;
        const stopM = Math.max(UNDERTOW_SNARE_HOLD_M, distanceM - stepM);
        if (entity.kind === "player") {
          this.pullPlayer(entity.entityId, snare.position, stopM);
          continue;
        }
        const next = moveToward(entity.position, snare.position, distanceM - stopM);
        if (!this.isMobHabitatStepAllowed(entity, next)) continue;
        this.setMobPosition(entity, next);
        this.markDirty(entity);
      }
    }
  }

  private endBattleDraught(playerId: string): void {
    if (!this.battleDraughts.delete(playerId)) return;
    this.options.onFieldBuffsChanged?.(playerId);
  }

  private releaseGivingTree(treeId: string): void {
    const references = (this.givingTreeReferenceCounts.get(treeId) ?? 1) - 1;
    if (references > 0) {
      this.givingTreeReferenceCounts.set(treeId, references);
      return;
    }
    this.givingTreeReferenceCounts.delete(treeId);
    this.givingTreePositions.delete(treeId);
    this.givingTreeGrid.remove(treeId);
  }

  private processGivingTreeAuras(): void {
    // A reserved actor's health is being committed with an inventory debit.
    if (this.givingTreeGrid.size === 0) {
      this.givingTreeAuraDueTicks.clear();
      return;
    }
    const intervalTicks = millisecondsToTicks(
      GIVING_TREE_AURA_INTERVAL_MS,
      this.options.tickRateHz
    );
    for (const entity of this.entities.values()) {
      if (this.isPlayerReserved(entity.entityId)) continue;
      const nearbyGivingTrees = this.givingTreeGrid
        .query(entity.position, GIVING_TREE_AURA_RADIUS_M)
        .filter((treeId) => treeVarietyForStableId(treeId) === "giving_tree");
      if (
        entity.lifeState !== "alive"
        || nearbyGivingTrees.length === 0
      ) {
        this.givingTreeAuraDueTicks.delete(entity.entityId);
        continue;
      }
      const dueTick = this.givingTreeAuraDueTicks.get(entity.entityId);
      if (dueTick === undefined) {
        this.applyAmbientHealing(entity, GIVING_TREE_AURA_HEAL);
        this.givingTreeAuraDueTicks.set(
          entity.entityId,
          this.currentTick + intervalTicks
        );
        continue;
      }
      if (this.currentTick < dueTick) continue;
      this.applyAmbientHealing(entity, GIVING_TREE_AURA_HEAL);
      this.givingTreeAuraDueTicks.set(
        entity.entityId,
        this.currentTick + intervalTicks
      );
    }
  }

  private processBalsamResinEffects(): void {
    const now = this.now();
    for (const [playerId, active] of this.balsamResinEffects) {
      if (this.isPlayerReserved(playerId)) continue;
      const player = this.entities.get(playerId);
      if (!player || player.kind !== "player") continue;
      if (player.lifeState !== "alive") {
        this.balsamResinEffects.delete(playerId);
        void this.options.onBalsamResinEffectFinished?.(
          playerId,
          active.effect.effectId,
          "death"
        );
        continue;
      }
      const intervalMs = this.v3BalsamResinTickIntervalMs(player, now);
      if (intervalMs !== active.tickIntervalMs) {
        // A cadence change (Monk aggression toggling) restarts the spacing from now, as before.
        active.tickIntervalMs = intervalMs;
        active.nextTickAtMs = now + intervalMs;
        active.anchorMs = active.nextTickAtMs;
        active.anchorIndex = active.nextTickIndex;
      }
      if (now < active.nextTickAtMs) continue;
      const resinMultiplier = (player.classRuntime?.skillV3?.generalSkillRanks.alchemy ?? 0) >= ALCHEMY_RESIN_MIN_RANK
        ? ALCHEMY_RESIN_MULTIPLIER
        : 1;
      this.applyAmbientHealing(player, balsamResinTickHeal(active.nextTickIndex, resinMultiplier));
      const nextTickIndex = active.nextTickIndex + 1;
      if (nextTickIndex >= BALSAM_RESIN_TOTAL_TICKS) {
        this.balsamResinEffects.delete(playerId);
        void this.options.onBalsamResinEffectFinished?.(
          playerId,
          active.effect.effectId,
          "completed"
        );
      } else {
        active.nextTickIndex = nextTickIndex;
        // Absolute schedule: engine-loop lateness on one tick does not push the next one back.
        let dueAtMs = active.anchorMs + (nextTickIndex - active.anchorIndex) * intervalMs;
        if (dueAtMs <= now) {
          // A whole interval was missed: skip it rather than burst, restarting the spacing here.
          dueAtMs = now + intervalMs;
          active.anchorMs = dueAtMs;
          active.anchorIndex = nextTickIndex;
        }
        active.nextTickAtMs = dueAtMs;
      }
    }
  }

  private v3BalsamResinTickIntervalMs(player: Combatant, now = this.now()): number {
    const skill = player.classRuntime?.skillV3;
    return balsamResinTickIntervalMs(
      skill
        ? {
            activeSpecializationId: skill.activeSpecializationId,
            specializationRank: skill.specializationRank,
            aggressiveUntilMs: player.aggressiveUntilMs
          }
        : null,
      now
    );
  }

  private applyAmbientHealing(entity: Combatant, amount: number): void {
    this.commitNormalHealing(null, entity, amount);
  }

  finishTick(): void {
    this.processMaxHealthPenaltyRecovery();
    let dueAttacksProcessed = 0;
    for (const work of this.scheduler.takeDue(this.currentTick)) {
      if (this.isPlayerReserved(work.entityId)) {
        if (work.kind === "attack") {
          const attacker = this.entities.get(work.entityId);
          if (attacker && attacker.scheduledAttackTick === work.dueTick &&
              attacker.attackScheduleGeneration === work.generation) {
            this.scheduleAttack(attacker, this.currentTick + 1);
          }
        } else {
          this.scheduler.schedule({ ...work, dueTick: this.currentTick + 1 });
        }
        continue;
      }
      if (work.kind === "attack") {
        dueAttacksProcessed += 1;
        this.resolveAttack(work);
      } else if (work.kind === "downed-recovery") {
        this.recoverDownedPlayer(work);
      }
    }
    this.metrics = {
      ...this.metrics,
      currentServerTick: this.currentTick,
      lastTickDurationMs: performance.now() - this.tickStartedAt,
      longestRecentTickMs:
        this.currentTick % (this.options.tickRateHz * 60) === 0
          ? performance.now() - this.tickStartedAt
          : Math.max(
              this.metrics.longestRecentTickMs,
              performance.now() - this.tickStartedAt
            ),
      activeCombatants: this.entities.size,
      activeEngagements: [...this.entities.values()].filter((entity) => entity.targetEntityId).length,
      activeChases: this.activeChases.size,
      tacticsManaged: this.mobTactics.mobs.size,
      tacticsTokensInUse: this.mobTactics.mobs.size === 0 ? 0 : this.mobTactics.tokensInUse(),
      dueAttacksProcessed,
      spatialGridQueries: this.metrics.spatialGridQueries + this.grid.consumeQueryCount(),
      dirtyCombatEntities: this.dirtyEntityIds.size,
      persistenceDirtyCount: this.dirtyProfiles.size,
      scheduledWorkCount: this.scheduler.size
    };
    this.tickDurations.push(performance.now() - this.tickStartedAt);
  }

  tick(): void {
    this.beginTick();
    this.finishTick();
  }

  private applyPendingEquipmentCombatUpdates(): void {
    const pending = [...this.pendingEquipmentCombatUpdates.entries()]
      .sort(([left], [right]) => left.localeCompare(right));
    this.pendingEquipmentCombatUpdates.clear();
    for (const [playerId, entry] of pending) {
      if (this.isPlayerReserved(playerId)) {
        this.pendingEquipmentCombatUpdates.set(playerId, entry);
        continue;
      }
      const player = this.entities.get(playerId);
      if (player?.kind === "player") {
        const previousEquipmentState = player.equipmentCombatState;
        if (previousEquipmentState?.switchingToSlot) {
          this.emitWeaponSwitchEvent(
            "WEAPON_SWITCH_CANCELLED",
            player,
            previousEquipmentState.switchingToSlot,
            previousEquipmentState.activeWeaponSlot
          );
        }
        // Max health follows a scroll swap at the tick boundary, rebuilt from scratch (gear stats,
        // then Vigor Serum, then the PvP penalty) so a stats refresh in between cannot apply it
        // twice. Current health never rises with it, so swapping gear back and forth cannot heal.
        // Only the final gear counts. When the last update carries no max health but an earlier one
        // in this batch does, move that from-scratch value by the gear's own max-health difference.
        const lastUpdate = entry.updates[entry.updates.length - 1];
        const anchor = [...entry.updates].reverse().find((update) => update.maxHealth !== undefined);
        const swapMaxHealth = lastUpdate?.maxHealth !== undefined
          ? lastUpdate.maxHealth
          : anchor?.maxHealth !== undefined
            ? Math.max(1, anchor.maxHealth + entry.state.stats.maximumHealth - anchor.state.stats.maximumHealth)
            : undefined;
        if (swapMaxHealth !== undefined) {
          player.maxHealth = this.penalizedMaxHealth(player, Math.max(
            1,
            swapMaxHealth + this.v3WarriorMaxHealthBonus(player.classRuntime?.skillV3 ?? null) +
              (this.vigorSerumApplied.get(playerId) ?? 0)
          ));
          player.currentHealth = Math.min(player.currentHealth, player.maxHealth);
        }
        player.equipmentCombatState = entry.state;
        player.attackDamage = Math.max(
          1,
          Math.round(
            entry.state.stats.weaponAttackPower[entry.state.activeWeaponSlot] +
            player.equipmentAttackAdjustment
          )
        );
        player.defense = Math.max(
          0,
          Math.round(
            entry.state.stats.universalDefense
            + player.equipmentDefenseAdjustment
          )
        );
        if (player.classRuntime) {
          player.classRuntime.rage = Math.min(
            player.classRuntime.rage,
            this.classResourceMaximum(player)
          );
        }
        this.applyEquipmentClassIdentity(player, entry.state);
        this.markDirty(player);
        const session = this.pveSessions.get(playerId);
        session?.telemetry.recordEquipmentState(telemetryEquipmentState(entry.state));
        for (const update of entry.updates) {
          if (update.kind !== "kit_activation") continue;
          session?.telemetry.recordKitActivation({
            activationTick: this.currentTick,
            atMs: session ? this.telemetryTime(session) : this.now(),
            equipment: telemetryEquipmentState(entry.state)
          });
        }
      }
      this.options.onEquipmentCombatUpdatesApplied?.({
        playerId,
        activationTick: this.currentTick,
        updates: entry.updates,
        state: entry.state
      });
    }
  }

  private applyEquipmentClassIdentity(
    player: Combatant,
    state: PlayerEquipmentCombatState
  ): void {
    const runtime = player.classRuntime;
    if (!runtime) {
      player.attackRangeM = state.activeWeaponSlot === "secondary"
        ? RANGED_ATTACK_RANGE_M
        : MELEE_ATTACK_RANGE_M;
      return;
    }
    runtime.weaponCategory = state.weaponCategory;
    runtime.armorCategory = state.chestArmorCategory;
    runtime.weaponDefinitionId = state.weaponSlots[state.activeWeaponSlot].definitionId ?? null;
    runtime.chestDefinitionId = state.chestDefinitionId ?? null;
    runtime.hasShield = state.hasShield;
    runtime.heavyArmorPieces = state.heavyArmorPieces;
    runtime.weaponMode = classWeaponMode(runtime.activeClassId, state.weaponCategory);
    if (
      runtime.activeClassId === "ninja"
      && equipmentGameplayFamily(runtime.chestDefinitionId) !== "tunic"
      && runtime.counters.ninjaInvisibleUntil !== undefined
    ) {
      delete runtime.counters.ninjaInvisibleUntil;
      this.rememberClassRuntime(player);
    }
    player.attackRangeM = runtime.activeClassId === "hunter"
      ? runtime.weaponMode === "ranged" ? HUNTER_BALANCE.rangedRangeM : HUNTER_BALANCE.meleeRangeM
      : this.launchClassAttackRange(runtime, state);
    // Equipment swaps intentionally do not remember the class runtime: weapon
    // identity is reconstructed from the durable equipment checkpoint, while
    // resources, counters, effects, cooldowns, and timing remain untouched.
  }

  private classResourceMaximum(entity: Combatant): number {
    return WARRIOR_BALANCE.rage.maximum +
      (entity.equipmentCombatState?.stats.resourceMaximumBonus ?? 0);
  }

  private resolveAutomaticWeaponSwitch(
    player: Combatant,
    target: Combatant
  ): boolean {
    const state = player.equipmentCombatState;
    if (!state) return false;
    if (
      player.classRuntime?.activeClassId === "ninja" &&
      state.activeWeaponSlot === "secondary" &&
      state.weaponSlots.secondary.category === "shuriken"
    ) {
      return false;
    }
    const desired = this.desiredWeaponSlot(
      state,
      distanceMeters(player.position, target.position),
      this.pendingWeaponRequirement(player)
    );

    if (state.switchingToSlot !== null) {
      if (desired !== state.switchingToSlot) {
        this.cancelInProgressWeaponSwitch(player);
        this.scheduleAttack(player, this.currentTick + 1);
        return true;
      }
      if (
        state.switchCompletesAtTick !== null &&
        this.currentTick < state.switchCompletesAtTick
      ) {
        this.scheduleAttack(player, state.switchCompletesAtTick);
        return true;
      }
      const previous = state.activeWeaponSlot;
      const completed = state.switchingToSlot;
      this.activateEquipmentWeapon(player, completed);
      state.switchingToSlot = null;
      state.switchStartedAtTick = null;
      state.switchCompletesAtTick = null;
      this.emitWeaponSwitchEvent(
        "WEAPON_SWITCH_COMPLETED",
        player,
        completed,
        previous
      );
      this.options.onWeaponSwitchCompleted?.(player.entityId, completed);
      this.markDirty(player);
    }

    if (desired === null) return state.switchPolicy === "ranged_only";
    if (desired === state.activeWeaponSlot) return false;

    state.switchingToSlot = desired;
    state.switchStartedAtTick = this.currentTick;
    state.switchCompletesAtTick =
      this.currentTick + this.weaponSwitchDelayTicks;
    this.emitWeaponSwitchEvent(
      "WEAPON_SWITCH_STARTED",
      player,
      desired,
      state.activeWeaponSlot
    );
    this.markDirty(player);
    this.scheduleAttack(player, state.switchCompletesAtTick);
    return true;
  }

  private recomputeInProgressWeaponSwitch(player: Combatant): void {
    if (player.equipmentCombatState?.switchingToSlot === null) return;
    const target = player.targetEntityId
      ? this.entities.get(player.targetEntityId)
      : null;
    if (!target || target.lifeState !== "alive") {
      this.cancelInProgressWeaponSwitch(player);
      return;
    }
    this.resolveAutomaticWeaponSwitch(player, target);
  }

  private cancelInProgressWeaponSwitch(player: Combatant): void {
    const state = player.equipmentCombatState;
    if (!state?.switchingToSlot) return;
    const cancelledSlot = state.switchingToSlot;
    state.switchingToSlot = null;
    state.switchStartedAtTick = null;
    state.switchCompletesAtTick = null;
    this.emitWeaponSwitchEvent(
      "WEAPON_SWITCH_CANCELLED",
      player,
      cancelledSlot,
      state.activeWeaponSlot
    );
    this.markDirty(player);
  }

  private requireImmediateAbilityWeaponReady(
    player: Combatant,
    target: Combatant,
    definition: TechniqueDefinition
  ): void {
    const state = player.equipmentCombatState;
    if (!state?.switchingToSlot) return;
    const desired = this.desiredWeaponSlot(
      state,
      distanceMeters(player.position, target.position),
      definition.weaponRequirement
    );
    if (desired === state.activeWeaponSlot) {
      this.cancelInProgressWeaponSwitch(player);
      return;
    }
    throw new CombatRequestError(
      "WEAPON_SWITCH_IN_PROGRESS",
      "The required weapon is still being readied"
    );
  }

  private desiredWeaponSlot(
    state: PlayerEquipmentCombatState,
    targetDistanceM: number,
    requirement: TechniqueWeaponRequirement
  ): ReadiedWeaponSlot | null {
    const hasMelee = state.weaponSlots.melee.instanceId !== null;
    const hasRanged = state.weaponSlots.secondary.instanceId !== null &&
      state.weaponSlots.secondary.category !== null;
    if (requirement === "melee" || requirement === "shield") {
      return hasMelee ? "melee" : null;
    }
    if (requirement === "ranged") {
      return hasRanged ? "secondary" : null;
    }
    if (
      requirement === "any" &&
      state.weaponSlots.melee.definitionId === "god_sword"
    ) {
      return "melee";
    }
    if (requirement === "any" && !hasMelee && !hasRanged) {
      return "melee";
    }
    if (state.switchPolicy === "ranged_only") {
      return hasRanged ? "secondary" : null;
    }
    if (state.switchPolicy === "ranged_priority") {
      return hasRanged ? "secondary" : hasMelee ? "melee" : null;
    }
    if (!hasMelee) return hasRanged ? "secondary" : null;
    if (!hasRanged) return "melee";
    if (state.activeWeaponSlot === "secondary") {
      return targetDistanceM <= MELEE_ATTACK_RANGE_M
        ? "melee"
        : "secondary";
    }
    return targetDistanceM > MELEE_ATTACK_RANGE_M + WEAPON_SWITCH_HYSTERESIS_M
      ? "secondary"
      : "melee";
  }

  private pendingWeaponRequirement(
    player: Combatant
  ): TechniqueWeaponRequirement {
    const session = this.pveSessions.get(player.entityId);
    const abilityId = session?.pendingNormal?.kind === "ability"
      ? session.pendingNormal.abilityId
      : player.classRuntime?.queuedAbility?.abilityId ??
        session?.pendingResetAbilityId ??
        null;
    if (!abilityId) return "any";
    try {
      return requireTechniqueDefinition(abilityId).weaponRequirement;
    } catch {
      return "any";
    }
  }

  private activateEquipmentWeapon(
    player: Combatant,
    slot: ReadiedWeaponSlot
  ): void {
    const state = player.equipmentCombatState;
    if (!state) return;
    const weapon = state.weaponSlots[slot];
    state.activeWeaponSlot = slot;
    state.activeWeaponInstanceId = weapon.instanceId;
    if (player.classRuntime) player.classRuntime.weaponDefinitionId = weapon.definitionId ?? null;
    state.activeWeaponEnchantmentIdentity = weapon.enchantmentIdentity;
    state.weaponCategory = weapon.category;
    player.attackDamage = Math.max(
      1,
      Math.round(
        state.stats.weaponAttackPower[slot] +
        player.equipmentAttackAdjustment
      )
    );
    this.applyEquipmentClassIdentity(player, state);
  }

  private emitWeaponSwitchEvent(
    type:
      | "WEAPON_SWITCH_STARTED"
      | "WEAPON_SWITCH_COMPLETED"
      | "WEAPON_SWITCH_CANCELLED",
    player: Combatant,
    slot: ReadiedWeaponSlot,
    previousSlot: ReadiedWeaponSlot
  ): void {
    this.metrics.combatEventsEmitted += 1;
    this.pendingEvents.push({
      eventId: `${this.currentTick}:${++this.eventSequence}`,
      type,
      tick: this.currentTick,
      sourceEntityId: player.entityId,
      targetEntityId: player.targetEntityId,
      weaponSlot: slot,
      previousWeaponSlot: previousSlot
    });
  }

  snapshotForPlayer(
    playerId: string,
    interestFrame?: CombatInterestFrame
  ): CombatStateBatch {
    const player = this.requireEntity(playerId, "COMBAT_PLAYER_NOT_FOUND");
    const nearbyIds = new Set(
      interestFrame?.nearbyIdsByPlayer.get(playerId) ??
        this.grid.query(player.position, this.interestRadiusM)
    );
    nearbyIds.add(playerId);
    this.knownEntityRevisionsByPlayer.set(playerId, this.revisionsForIds(nearbyIds));
    this.forceSnapshotPlayers.delete(playerId);
    this.metrics.combatSnapshotsSent += 1;
    return {
      serverTick: this.currentTick,
      serverTime: this.now(),
      sequence: this.nextNetworkSequence(playerId),
      upserts: this.snapshotsForIds(nearbyIds, playerId),
      removedEntityIds: [],
      events: []
    };
  }

  beginDeltaFlush(): CombatDeltaFrame {
    const frame: CombatDeltaFrame = {
      serverTick: this.currentTick,
      serverTime: this.now(),
      dirtyEntityIds: new Set(this.dirtyEntityIds),
      removedEntityIds: new Set(this.removedEntityIds),
      events: [...this.pendingEvents]
    };
    this.dirtyEntityIds.clear();
    this.removedEntityIds.clear();
    this.pendingEvents.length = 0;
    return frame;
  }

  deltaForPlayer(playerId: string, frame: CombatDeltaFrame): CombatStateBatch | null {
    return this.deltaForPlayerWithInterest(playerId, frame);
  }

  deltaForPlayerWithInterest(
    playerId: string,
    frame: CombatDeltaFrame,
    interestFrame?: CombatInterestFrame
  ): CombatStateBatch | null {
    if (this.forceSnapshotPlayers.has(playerId)) {
      return this.snapshotForPlayer(playerId, interestFrame);
    }
    const player = this.entities.get(playerId);
    if (!player) {
      return null;
    }
    const previousRevisions = this.knownEntityRevisionsByPlayer.get(playerId) ?? new Map();
    const previous = new Set(previousRevisions.keys());
    const nearby = new Set(
      interestFrame?.nearbyIdsByPlayer.get(playerId) ??
        this.grid.query(player.position, this.interestRadiusM)
    );
    nearby.add(playerId);
    const upsertIds = new Set<string>();
    for (const entityId of nearby) {
      const entity = this.entities.get(entityId);
      if (
        entity &&
        (!previous.has(entityId) ||
          frame.dirtyEntityIds.has(entityId) ||
          previousRevisions.get(entityId) !== entity.revision)
      ) {
        upsertIds.add(entityId);
      }
    }
    const removed = new Set<string>();
    for (const entityId of previous) {
      if (!nearby.has(entityId) || frame.removedEntityIds.has(entityId)) {
        removed.add(entityId);
      }
    }
    const relevantIds = new Set([...nearby, ...previous]);
    const events = frame.events.filter(
      (event) =>
        ((event.sourceEntityId !== null && relevantIds.has(event.sourceEntityId)) ||
          (event.targetEntityId !== null && relevantIds.has(event.targetEntityId))) &&
        !this.isPetEffectHiddenFrom(event, playerId)
    );
    if (upsertIds.size === 0 && removed.size === 0 && events.length === 0) {
      return null;
    }
    this.knownEntityRevisionsByPlayer.set(playerId, this.revisionsForIds(nearby));
    this.metrics.combatDeltasSent += 1;
    this.metrics.entitiesPerDelta += upsertIds.size;
    this.metrics.maximumEntitiesPerDelta = Math.max(
      this.metrics.maximumEntitiesPerDelta,
      upsertIds.size
    );
    return {
      serverTick: frame.serverTick,
      serverTime: frame.serverTime,
      sequence: this.nextNetworkSequence(playerId),
      upserts: this.snapshotsForIds(upsertIds, playerId),
      removedEntityIds: [...removed].sort(),
      events
    };
  }

  markNpcCityPlayerEnemy(cityId: string, playerId: string): void {
    const enemies = this.npcCityEnemyPlayers.get(cityId) ?? new Set<string>();
    enemies.add(playerId);
    this.npcCityEnemyPlayers.set(cityId, enemies);
    for (const entity of this.entities.values()) {
      if (entity.npcFaction?.cityId !== cityId) continue;
      if (
        entity.mobAi?.phase === "observing" &&
        entity.mobAi.targetPlayerId === playerId
      ) this.cancelMobAiIntent(entity);
      else this.markDirty(entity);
    }
  }

  isNpcCityPlayerEnemy(cityId: string, playerId: string): boolean {
    return this.npcCityEnemyPlayers.get(cityId)?.has(playerId) === true;
  }

  npcFactionForEntity(entityId: string): CombatEntitySnapshot["npcFaction"] {
    const entity = this.entities.get(entityId);
    return entity?.npcFaction
      ? {
          cityId: entity.npcFaction.cityId,
          cityName: entity.npcFaction.cityName,
          culture: entity.npcFaction.culture,
          role: entity.npcFaction.role,
          presentationKey: entity.npcFaction.presentationKey,
          relation: "neutral",
          protected: true
        }
      : null;
  }

  /** Cheap kind lookup (no snapshot), for host hooks. */
  entityKind(entityId: string): "player" | "mob" | null {
    return this.entities.get(entityId)?.kind ?? null;
  }

  entity(entityId: string): CombatEntitySnapshot | null {
    const entity = this.entities.get(entityId);
    return entity ? this.snapshot(entity) : null;
  }

  /** Read-only origin for authoring/debug overlays; never used as movement authority. */
  entityHomePosition(entityId: string): LatLon | null {
    const entity = this.entities.get(entityId);
    return entity ? { ...entity.homePosition } : null;
  }

  setPopulationMobRuntimeStateSink(
    sink: PopulationMobRuntimeStateSink | null
  ): void {
    this.populationMobRuntimeStateSink = sink;
  }

  isPopulationManagedMob(entityId: string): boolean {
    const entity = this.entities.get(entityId);
    return entity?.kind === "mob" && entity.populationAuthority !== null;
  }

  setBossEventState(
    entityId: string,
    state: "dormant" | "active"
  ): CombatEntitySnapshot {
    const entity = this.entities.get(entityId);
    if (!entity || entity.kind !== "mob" || entity.archetypeKey !== "xoral") {
      throw new Error("Xoral combat entity does not exist");
    }
    entity.bossEventState = state;
    entity.bossLifecycleState = state;
    this.markDirty(entity);
    return this.snapshot(entity);
  }

  setBossEncounterProjectionProvider(
    provider: ((entityId: string, recipientPlayerId?: string) => BossEncounterProjection | null) | null
  ): void {
    this.bossEncounterProjectionProvider = provider;
    this.refreshBossEncounterProjections();
  }

  /** Mark explicit boss entities dirty after lifecycle/cast projection changes. */
  refreshBossEncounterProjections(): void {
    for (const entity of this.entities.values()) {
      if (entity.kind === "mob" && entity.bossOwnership !== null) this.markDirty(entity);
    }
  }

  setBossLifecycleState(
    entityId: string,
    state: BossLifecycleState
  ): CombatEntitySnapshot {
    const entity = this.entities.get(entityId);
    if (!entity || entity.kind !== "mob" || entity.bossOwnership === null) {
      throw new Error("Boss combat entity does not exist");
    }
    entity.bossLifecycleState = state;
    entity.bossEventState = state === "dormant" || state === "active" ? state : null;
    this.markDirty(entity);
    return this.snapshot(entity);
  }

  directMobTarget(mobEntityId: string, playerEntityId: string): boolean {
    const mob = this.entities.get(mobEntityId);
    const player = this.entities.get(playerEntityId);
    if (
      !mob || mob.kind !== "mob" || mob.lifeState !== "alive" ||
      !player || player.kind !== "player" || player.lifeState !== "alive" ||
      !this.isAttackPairValid(mob, player) ||
      this.options.isMobPlayerAttackAuthorized?.(mob.entityId, player.entityId) === false
    ) return false;
    this.returningMobs.delete(mob.entityId);
    this.invalidateScheduledAttack(mob);
    this.setTarget(mob, player.entityId);
    // A managed mob attacks only through tactics, never also through scheduleAttack (no double attacker).
    if (this.joinMobTactics(mob, player)) return true;
    if (this.isWithinMobAttackHoldRange(mob, player)) {
      this.activeChases.delete(mob.entityId);
      mob.activityState = "attacking";
      this.scheduleAttack(mob, Math.max(this.currentTick + 1, mob.nextEligibleAttackTick));
      this.markDirty(mob);
    } else {
      this.startChasing(mob);
      this.scheduleAttack(mob, Math.max(this.currentTick + 1, mob.nextEligibleAttackTick));
    }
    return true;
  }

  /** Sets a player burning from a scripted (boss) hit. */
  applyScriptedBurning(sourceEntityId: string, playerEntityId: string): boolean {
    const source = this.entities.get(sourceEntityId);
    const player = this.entities.get(playerEntityId);
    if (!source || source.kind !== "mob" || !player || player.kind !== "player" || player.lifeState !== "alive") return false;
    return this.applyHarmfulStatus(source, player, "burning", 1);
  }

  applyScriptedRoot(
    sourceEntityId: string,
    playerEntityId: string,
    durationMs: number,
    sourceTechniqueId = "xoral_root"
  ): boolean {
    const source = this.entities.get(sourceEntityId);
    const player = this.entities.get(playerEntityId);
    if (
      !source || source.kind !== "mob" || source.lifeState !== "alive" ||
      !player || player.kind !== "player" || player.lifeState !== "alive" ||
      this.flagArrivalProtectionUntil(player.entityId) !== null ||
      !Number.isFinite(durationMs) || durationMs <= 0
    ) return false;
    // Root ward rings shorten web roots; Snare ward rings shorten every other scripted root.
    durationMs = this.ringWardedRootMs(player, sourceTechniqueId, durationMs);
    if (durationMs <= 0) return false;
    this.addTimedEffect(source, player, "rooted", sourceTechniqueId, durationMs, 1);
    this.options.stopPlayer?.(player.entityId);
    return true;
  }

  /**
   * Pet abilities: one status effect from a pet entity onto a target. Poison and Shade use the
   * shared harmful-status pulse; the rest are timed effects. PvP lengths are capped by the caller.
   */
  applyPetEffect(
    sourceEntityId: string,
    targetEntityId: string,
    effect: "rooted" | "movement_slow" | "poison" | "gloom" | "bleed" | "defense_reduction" | "flat_defense" | "outgoing_damage" | "whetted_attack",
    durationMs: number,
    amount = 1
  ): boolean {
    const source = this.entities.get(sourceEntityId);
    const target = this.entities.get(targetEntityId);
    if (!source || !target || target.lifeState !== "alive" || !Number.isFinite(durationMs) || durationMs <= 0) return false;
    const harmful = effect !== "flat_defense" && effect !== "outgoing_damage";
    if (harmful && target.kind === "player" && this.flagArrivalProtectionUntil(target.entityId) !== null) return false;
    if (effect === "poison" || effect === "gloom") return this.applyHarmfulStatus(source, target, effect, 1);
    if (effect === "rooted" && target.kind === "player") {
      durationMs = this.ringWardedRootMs(target, "pet_rooted", durationMs);
      if (durationMs <= 0) return false;
    }
    const techniqueId = `pet_${effect}`;
    this.addTimedEffect(source, target, effect, techniqueId, durationMs, amount);
    if (effect === "bleed") {
      const bleed = target.classRuntime?.effects.find((entry) => entry.id === `${target.entityId}:${techniqueId}:bleed`);
      if (bleed) bleed.nextTick = this.currentTick + this.attackIntervalTicks;
    }
    if (effect === "rooted" && target.kind === "player") this.options.stopPlayer?.(target.entityId);
    return true;
  }

  /** Effective worn-ring bonus (after non-stacking) for a player; 0 for everything else. */
  private ringBonus(entity: Combatant, key: string): number {
    if (entity.kind !== "player") return 0;
    return entity.equipmentCombatState?.stats.ringBonuses?.[key] ?? 0;
  }

  /** Root ward (webs) and Snare ward (nets, traps, other roots): negative seconds off the root. */
  private ringWardedRootMs(player: Combatant, sourceTechniqueId: string, durationMs: number): number {
    const ward = sourceTechniqueId.includes("web")
      ? this.ringBonus(player, "root_ward")
      : this.ringBonus(player, "snare_ward");
    return ward < 0 ? durationMs + ward * 1_000 : durationMs;
  }

  /** Base attack damage of an entity (the Grave Echo copies its owner's). */
  attackDamageOf(entityId: string): number | null {
    return this.entities.get(entityId)?.attackDamage ?? null;
  }

  /** Druid R3/R5 with a staff: pets and minions share 45%/85% of the owner's stored Tactics. */
  petTacticsShare(ownerPlayerId: string): number {
    const owner = this.entities.get(ownerPlayerId);
    const skill = owner?.classRuntime?.skillV3;
    if (!owner || skill?.activeSpecializationId !== "druid" || skill.specializationRank < 3) return 0;
    if (owner.equipmentCombatState?.weaponCategory !== "staff") return 0;
    const tactics = Math.max(0, Number(owner.classRuntime?.counters.skillV3TacticsValue ?? 0));
    return Math.floor(tactics * (skill.specializationRank >= 5 ? 0.85 : 0.45));
  }

  /** Whether a pet owned by `ownerPlayerId` may harm `targetPlayerId` (same rules as the owner attacking). */
  canOwnerHarmPlayer(ownerPlayerId: string, targetPlayerId: string): boolean {
    const owner = this.entities.get(ownerPlayerId);
    const target = this.entities.get(targetPlayerId);
    return Boolean(owner && target && owner.kind === "player" && target.kind === "player" &&
      target.lifeState === "alive" && this.isAttackPairValid(owner, target));
  }

  /** Shadow Hide hides the owner's pet from everyone the owner is hidden from. */
  /** Pet effects never reveal a hidden pet, or an invisible player they land on, to other viewers. */
  private isPetEffectHiddenFrom(event: CombatEvent, viewerPlayerId: string): boolean {
    if (event.type !== "PET_ABILITY_EFFECT") return false;
    const source = event.sourceEntityId ? this.entities.get(event.sourceEntityId) : undefined;
    if (source && this.isPetHiddenFrom(source, viewerPlayerId)) return true;
    const target = event.targetEntityId ? this.entities.get(event.targetEntityId) : undefined;
    return target?.kind === "player" && target.entityId !== viewerPlayerId && this.isNinjaInvisible(target) &&
      this.options.partyAuthority?.sameParty(viewerPlayerId, target.entityId) !== true;
  }

  private isPetHiddenFrom(pet: Combatant, viewerPlayerId: string): boolean {
    const ownerId = pet.companionOwnerPlayerId;
    if (!ownerId || ownerId === viewerPlayerId || !pet.entityId.startsWith("pet-companion:")) return false;
    const owner = this.entities.get(ownerId);
    if (!owner || Number(owner.classRuntime?.counters.petShadowHideUntil ?? 0) <= this.now()) return false;
    return this.isNinjaInvisible(owner) &&
      this.options.partyAuthority?.sameParty(viewerPlayerId, ownerId) !== true;
  }

  /** The hidden wolf acted: owner and wolf reappear together. */
  breakPetShadowHide(ownerPlayerId: string): void {
    const owner = this.entities.get(ownerPlayerId);
    if (!owner || Number(owner.classRuntime?.counters.petShadowHideUntil ?? 0) <= this.now()) return;
    delete owner.classRuntime!.counters.petShadowHideUntil;
    this.breakNinjaInvisible(owner);
  }

  /** Shadow Hide: the owner slips out of sight until they act (same invisibility as the ninja tunic). */
  grantPetShadowHide(playerId: string, durationMs: number): boolean {
    const player = this.entities.get(playerId);
    if (!player || player.kind !== "player" || player.lifeState !== "alive") return false;
    const runtime = player.classRuntime ?? (player.classRuntime = emptyRuntime());
    const until = this.now() + durationMs;
    runtime.counters.petShadowHideUntil = until;
    runtime.counters.ninjaInvisibleUntil = until;
    this.cancelTargeters(player.entityId);
    for (const mob of this.entities.values()) {
      if (mob.kind === "mob" && mob.targetEntityId === player.entityId) this.clearTarget(mob);
    }
    this.markDirty(player);
    this.rememberClassRuntime(player);
    return true;
  }

  nearbyEntityIds(position: LatLon, radiusM: number): string[] {
    return this.grid.query(position, radiusM);
  }

  buildInterestFrame(playerIds: Iterable<string>): CombatInterestFrame {
    const nearbyIdsByPlayer = new Map<string, ReadonlySet<string>>();
    const candidatesByCell = new Map<string, string[]>();
    let cacheHits = 0;
    let cacheMisses = 0;
    for (const playerId of [...playerIds].sort()) {
      const player = this.entities.get(playerId);
      if (!player) {
        continue;
      }
      const configuredView = this.options.getAuthoritativeViewCircle?.(playerId) ?? null;
      const hasAuthoritativeView = Boolean(
        configuredView &&
        Number.isFinite(configuredView.center.lat) &&
        Number.isFinite(configuredView.center.lon) &&
        Number.isFinite(configuredView.radiusM) &&
        configuredView.radiusM > 0
      );
      const viewCenter = hasAuthoritativeView ? configuredView!.center : player.position;
      const viewRadiusM = hasAuthoritativeView ? configuredView!.radiusM : this.interestRadiusM;
      const eligibleRegionCodes = new Set(
        hasAuthoritativeView && configuredView!.eligibleRegionCodes?.length
          ? configuredView!.eligibleRegionCodes
          : [player.regionCode]
      );
      const eligibleZoneIds = new Set(
        hasAuthoritativeView && configuredView!.eligibleZoneIds?.length
          ? configuredView!.eligibleZoneIds
          : [player.zoneId]
      );
      const cellKey = this.grid.cellKeyFor(viewCenter);
      const candidateCacheKey = `${cellKey}:${viewRadiusM}`;
      let candidates = candidatesByCell.get(candidateCacheKey);
      if (candidates) {
        cacheHits += 1;
      } else {
        candidates = this.grid.candidatesForPosition(viewCenter, viewRadiusM);
        candidatesByCell.set(candidateCacheKey, candidates);
        cacheMisses += 1;
      }
      const nearby = new Set(
        this.grid
          .filterCandidates(viewCenter, viewRadiusM, candidates)
          .filter((entityId) => {
            const entity = this.entities.get(entityId);
            if (
              !entity ||
              !eligibleRegionCodes.has(entity.regionCode) ||
              !eligibleZoneIds.has(entity.zoneId)
            ) {
              return false;
            }
            if (entity.kind === "player") {
              return entity.entityId === playerId
                || !this.isNinjaInvisible(entity)
                || this.options.partyAuthority?.sameParty(playerId, entity.entityId) === true;
            }
            if (entity.companionOwnerPlayerId && this.isPetHiddenFrom(entity, playerId)) return false;
            return (hasAuthoritativeView && configuredView?.anchorType === "flag") ||
              entity.originFlagId === null;
          })
      );
      nearby.add(playerId);
      nearbyIdsByPlayer.set(playerId, nearby);
    }
    this.metrics.aoiCacheHits += cacheHits;
    this.metrics.aoiCacheMisses += cacheMisses;
    return { nearbyIdsByPlayer, cacheHits, cacheMisses };
  }

  requestResync(playerId: string): void {
    if (this.entities.has(playerId)) {
      this.forceSnapshotPlayers.add(playerId);
      this.metrics.resyncRequests += 1;
    }
  }

  needsSnapshot(playerId: string): boolean {
    return this.forceSnapshotPlayers.has(playerId);
  }

  notePersistenceFailure(retrying: boolean): void {
    this.metrics.persistenceFailures += 1;
    if (retrying) {
      this.metrics.persistenceRetries += 1;
    }
  }

  peekDirtyProfiles(): DirtyCombatProfile[] {
    return [...this.dirtyProfiles.values()].map((profile) => ({ ...profile }));
  }

  markProfilesPersisted(
    profiles: Array<{ playerId: string; persistenceVersion: number }>
  ): void {
    for (const profile of profiles) {
      if (
        this.dirtyProfiles.get(profile.playerId)?.persistenceVersion ===
        profile.persistenceVersion
      ) {
        this.dirtyProfiles.delete(profile.playerId);
      }
    }
  }

  /** Rolling tick-duration p50/p95/max over roughly the last minute, plus current combatants. */
  tickHistorySnapshot(): { tickMs: RollingStatsSummary; activeCombatants: number } {
    return { tickMs: this.tickDurations.summary(), activeCombatants: this.entities.size };
  }

  metricsSnapshot(): CombatMetrics {
    return {
      ...this.metrics,
      activeCombatants: this.entities.size,
      activeEngagements: [...this.entities.values()].filter((entity) => entity.targetEntityId).length,
      activeChases: this.activeChases.size,
      dirtyCombatEntities: this.dirtyEntityIds.size,
      persistenceDirtyCount: this.dirtyProfiles.size,
      averageEntitiesPerDelta:
        this.metrics.combatDeltasSent === 0
          ? 0
          : this.metrics.entitiesPerDelta / this.metrics.combatDeltasSent,
      scheduledWorkCount: this.scheduler.size
    };
  }

  telemetryEncounterSnapshot(): Readonly<{
    activeCombatEncounters: number;
    activePveEncounters: number;
    activePvpEncounters: number;
  }> {
    const pve = new Set<string>();
    const pvp = new Set<string>();
    for (const entity of this.entities.values()) {
      if (!entity.targetEntityId) continue;
      const target = this.entities.get(entity.targetEntityId);
      if (!target) continue;
      const key = [entity.entityId, target.entityId].sort().join(":");
      if (entity.kind === "player" && target.kind === "player") pvp.add(key);
      else pve.add(key);
    }
    return {
      activeCombatEncounters: new Set([...pve, ...pvp]).size,
      activePveEncounters: pve.size,
      activePvpEncounters: pvp.size
    };
  }

  get serverTick(): number {
    return this.currentTick;
  }

  private createPlayerCombatant(
    input: Parameters<CombatEngine["connectPlayer"]>[0],
    maxHealth: number,
    currentHealth: number
  ): Combatant {
    return {
      entityId: input.playerId,
      kind: "player",
      originFlagId: null,
      archetypeKey: null,
      appearanceVariant: null,
      name: input.name,
      level: Math.max(0, Math.trunc(input.profile.level ?? 0)),
      challengeTier: null,
      combatBalanceVersion: null,
      regionCode: input.regionCode,
      zoneId: input.zoneId,
      position: { ...input.position },
      homePosition: { ...input.position },
      populationCellId: null,
      packId: null,
      npcFaction: null,
      worldAi: false,
      mobAi: null,
      jellyfishRuntime: null,
      maxHealth,
      currentHealth,
      attackDamage: positiveInteger(
        input.profile.baseAttackDamage,
        this.options.playerAttackDamage ?? DEFAULT_PLAYER_BASIC_DAMAGE
      ),
      defense: Math.max(0, Math.trunc(input.profile.defense ?? 0)),
      equipmentCombatState: null,
      equipmentAttackAdjustment: 0,
      equipmentDefenseAdjustment: 0,
      attackIntervalTicks: this.attackIntervalTicks,
      attackRangeM: BASIC_ATTACK_RANGE_M,
      movementSpeedMps: this.options.playerMovementSpeedMps ?? 0,
      leashRadiusM: Number.POSITIVE_INFINITY,
      retaliates: true,
      bossEventState: null,
      bossLifecycleState: null,
      bossOwnership: null,
      lifeState: currentHealth > 0 ? "alive" : "respawning",
      activityState: "idle",
      targetEntityId: null,
      nextEligibleAttackTick: this.currentTick,
      scheduledAttackTick: null,
      attackScheduleGeneration: 0,
      lifeGeneration: 0,
      downedUntil: null,
      deathPenaltyOperationKey: input.profile.deathPenaltyOperationKey ?? null,
      respawnAvailableAt: input.profile.respawnAvailableAt ?? null,
      populationAuthority: null,
      revision: 1,
      aggressiveUntilMs: 0,
      lastChaseUpdateTick: -COMBAT_CHASE_REEVALUATE_TICKS,
      chaseDestination: null,
      accountId: input.accountId,
      connectionId: input.connectionId,
      classRuntime: null,
      aggroOwnerPlayerId: null,
      aggroOwnerSessionId: null,
      aggroOwnerSessionGeneration: null,
      aggroViewGeneration: null,
      tauntCooldownEndsAt: 0,
      threatPriorityPlayerId: null,
      threatPriorityRemainingActions: 0
    };
  }

  private processWorldMobAi(): void {
    const now = this.now();
    for (const mob of this.entities.values()) {
      if (!this.isAmbientGoblinDefender(mob) || mob.lifeState !== "alive") continue;
      this.processGoblinDefenderSpeech(mob, now);
      if (mob.mobAi?.phase === "observing" && this.hasEligibleGoblinDefenderEnemy(mob)) {
        this.cancelMobAiIntent(mob);
      }
    }
    this.acquireWorldMobIntents();
    const mobs = [...this.entities.values()]
      .filter((entity) => entity.kind === "mob" && entity.worldAi && entity.mobAi)
      .sort((left, right) => left.entityId.localeCompare(right.entityId));
    for (const mob of mobs) {
      if (isMobRetreating(mob)) continue;
      if (mob.lifeState !== "alive") {
        this.cancelMobAiIntent(mob);
        continue;
      }
      const runtime = mob.mobAi!;
      const profile = this.mobAiProfile(mob);
      if (runtime.phase === "acquiring") {
        const player = runtime.targetPlayerId
          ? this.entities.get(runtime.targetPlayerId)
          : null;
        const acquisition = profile.proactive;
        if (
          !player ||
          player.kind !== "player" ||
          player.lifeState !== "alive" ||
          !acquisition ||
          distanceMeters(mob.position, player.position) > acquisition.radiusM ||
          !this.canMobAcquire(mob, player)
        ) {
          this.cancelMobAiIntent(mob);
          continue;
        }
        if (runtime.deadlineTick !== null && this.currentTick < runtime.deadlineTick) continue;
        if (acquisition.intent === "observe") this.beginMobObservation(mob, player);
        else this.beginProactiveCombat(mob, player);
      }
      if (runtime.phase === "observing") {
        this.processMobObservation(mob, profile);
      } else if (runtime.phase === "engaging") {
        this.processMobDisengagement(mob, profile);
      }
      if (runtime.phase === "idle") this.processGoblinDefenderWander(mob, now);
    }

    for (const entityId of [...this.returningMobs].sort()) {
      const mob = this.entities.get(entityId);
      if (!mob || mob.kind !== "mob" || mob.lifeState !== "alive") {
        this.returningMobs.delete(entityId);
        continue;
      }
      if (mob.targetEntityId || mob.aggroOwnerPlayerId) {
        this.returningMobs.delete(entityId);
        continue;
      }
      // A rooted, immobilized or staggered mob holds its ground on the way home too.
      if (this.isMobMovementHeld(mob)) continue;
      const maxStepM = this.effectiveMobMovementSpeedMps(mob) / this.options.tickRateHz;
      const remainingM = distanceMeters(mob.position, mob.homePosition);
      if (remainingM <= Math.max(maxStepM, WOLF_HOME_TOLERANCE_M)) {
        this.setMobPosition(mob, { ...mob.homePosition });
        mob.activityState = "idle";
        if (mob.mobAi) mob.mobAi.phase = "idle";
        this.returningMobs.delete(entityId);
      } else {
        this.setMobPosition(mob, this.moveMobWithPackSeparation(mob, mob.homePosition, maxStepM));
        mob.activityState = "returning";
      }
      this.markDirty(mob);
    }
  }

  private processMobRetreats(): void {
    for (const entityId of [...this.retreatingMobs].sort()) {
      const mob = this.entities.get(entityId);
      const runtime = mob?.jellyfishRuntime;
      const destination = runtime?.retreatDestination;
      if (
        !mob || mob.kind !== "mob" || mob.lifeState !== "alive" ||
        !runtime || runtime.retreatPhase !== "moving" || !destination
      ) {
        this.retreatingMobs.delete(entityId);
        continue;
      }
      const maxStepM = this.effectiveMobMovementSpeedMps(mob) / this.options.tickRateHz;
      const remainingM = distanceMeters(mob.position, destination);
      const next = remainingM <= maxStepM
        ? destination
        : moveToward(mob.position, destination, maxStepM);
      this.commitMobPhysicalPosition(mob, next);
      if (remainingM <= maxStepM) {
        this.completeCurrentJellyfishRetreat(mob);
      } else {
        mob.activityState = "fleeing";
        mob.chaseDestination = { ...destination };
      }
    }
  }

  private queueJellyfishRetreat(mob: Combatant, retreatIndex: 1 | 2): void {
    const runtime = mob.jellyfishRuntime;
    if (!runtime) return;
    if (retreatIndex === 1) {
      if (runtime.retreatTriggered) return;
      runtime.retreatTriggered = true;
    } else {
      if (runtime.secondRetreatTriggered) return;
      runtime.secondRetreatTriggered = true;
    }
    if (runtime.retreatPhase === "preparing" || runtime.retreatPhase === "moving") return;
    this.startNextJellyfishRetreat(mob);
  }

  private startNextJellyfishRetreat(mob: Combatant): void {
    const runtime = mob.jellyfishRuntime;
    if (
      !runtime || runtime.retreatPhase === "preparing" || runtime.retreatPhase === "moving" ||
      runtime.retreatsCompleted >= jellyfishRetreatsTriggered(runtime)
    ) return;
    runtime.retreatPhase = "preparing";
    runtime.retreatStartPosition = null;
    runtime.retreatDestination = null;
    runtime.retreatStartedAtMs = null;
    this.disengageMobForRetreat(mob);
    this.prepareJellyfishRetreat(mob);
  }

  /** Drops a mob out of combat so a scripted retreat can move it freely. */
  private disengageMobForRetreat(mob: Combatant): void {
    this.removeEnemyFromAllSessions(mob.entityId);
    this.invalidateScheduledAttack(mob);
    this.activeChases.delete(mob.entityId);
    this.returningMobs.delete(mob.entityId);
    mob.aggroOwnerPlayerId = null;
    mob.aggroOwnerSessionId = null;
    mob.aggroOwnerSessionGeneration = null;
    mob.aggroViewGeneration = null;
    if (mob.targetEntityId) this.clearTarget(mob);
    if (mob.mobAi) {
      mob.mobAi.phase = "idle";
      mob.mobAi.intent = null;
      mob.mobAi.targetPlayerId = null;
      mob.mobAi.deadlineTick = null;
      mob.mobAi.deadlineAtMs = null;
    }
    mob.activityState = "fleeing";
    mob.chaseDestination = null;
    this.markDirty(mob);
  }

  private completeCurrentJellyfishRetreat(mob: Combatant): void {
    const runtime = mob.jellyfishRuntime;
    if (!runtime) return;
    runtime.retreatsCompleted = Math.min(
      2,
      runtime.retreatsCompleted + 1
    ) as 0 | 1 | 2;
    runtime.retreatPhase = "complete";
    mob.activityState = "idle";
    mob.chaseDestination = null;
    if (mob.mobAi) mob.mobAi.phase = "idle";
    this.retreatingMobs.delete(mob.entityId);
    this.persistPopulationMobRuntimeState(mob);
    if (runtime.retreatsCompleted < jellyfishRetreatsTriggered(runtime)) {
      this.startNextJellyfishRetreat(mob);
      this.persistPopulationMobRuntimeState(mob);
    }
  }

  private processJellyfishHealthThresholds(
    mob: Combatant,
    previousHealth: number
  ): void {
    const runtime = mob.jellyfishRuntime;
    if (!runtime) return;
    if (runtime.stage === 1 && mob.currentHealth * 3 <= mob.maxHealth * 2) {
      runtime.stage = 2;
    }
    if (
      previousHealth * 3 > mob.maxHealth * 2 &&
      mob.currentHealth * 3 <= mob.maxHealth * 2
    ) {
      this.queueJellyfishRetreat(mob, 1);
    }
    if (runtime.stage < 3 && mob.currentHealth * 3 <= mob.maxHealth) {
      runtime.stage = 3;
      runtime.shadeEnabled = true;
    }
    if (
      previousHealth * 3 > mob.maxHealth &&
      mob.currentHealth * 3 <= mob.maxHealth
    ) {
      this.queueJellyfishRetreat(mob, 2);
    }
  }

  private persistPopulationMobRuntimeState(mob: Combatant): void {
    const runtime = mob.jellyfishRuntime;
    if (!runtime || mob.populationAuthority === null) return;
    runtime.revision += 1;
    this.populationMobRuntimeStateSink?.(mob.entityId, {
      schemaVersion: 1,
      revision: runtime.revision,
      archetype: "jellyfish",
      currentHealth: mob.currentHealth,
      maxHealth: mob.maxHealth,
      position: { ...mob.position },
      jellyfish: {
        stage: runtime.stage,
        retreatTriggered: runtime.retreatTriggered,
        secondRetreatTriggered: runtime.secondRetreatTriggered,
        retreatsCompleted: runtime.retreatsCompleted,
        shadeEnabled: runtime.shadeEnabled,
        retreatPhase: runtime.retreatPhase,
        retreatStartPosition: runtime.retreatStartPosition
          ? { ...runtime.retreatStartPosition }
          : null,
        retreatDestination: runtime.retreatDestination
          ? { ...runtime.retreatDestination }
          : null,
        retreatStartedAtMs: runtime.retreatStartedAtMs
      }
    });
  }

  private prepareJellyfishRetreat(mob: Combatant): void {
    const runtime = mob.jellyfishRuntime;
    if (!runtime || runtime.retreatPhase !== "preparing") return;
    const resolver = this.options.resolveMobRetreatDestination;
    if (!resolver) {
      this.completeCurrentJellyfishRetreat(mob);
      return;
    }
    const retreatIndex = (runtime.retreatsCompleted + 1) as 1 | 2;
    const token = Symbol(mob.entityId);
    this.pendingMobRetreats.set(mob.entityId, token);
    void resolver({
      entityId: mob.entityId,
      archetype: "jellyfish",
      anchor: { ...mob.homePosition },
      distanceM: JELLYFISH_RETREAT_DISTANCE_M,
      retreatIndex
    }).then((destination) => {
      const current = this.entities.get(mob.entityId);
      if (
        !current || current !== mob || current.lifeState !== "alive" ||
        this.pendingMobRetreats.get(mob.entityId) !== token ||
        current.jellyfishRuntime?.retreatPhase !== "preparing"
      ) return;
      this.pendingMobRetreats.delete(mob.entityId);
      if (!destination) {
        this.completeCurrentJellyfishRetreat(current);
        return;
      }
      current.jellyfishRuntime.retreatStartPosition = { ...current.position };
      current.jellyfishRuntime.retreatDestination = { ...destination };
      current.jellyfishRuntime.retreatStartedAtMs = this.now();
      current.jellyfishRuntime.retreatPhase = "moving";
      current.activityState = "fleeing";
      current.chaseDestination = { ...destination };
      this.retreatingMobs.add(current.entityId);
      this.markDirty(current);
      this.persistPopulationMobRuntimeState(current);
    }).catch(() => {
      const current = this.entities.get(mob.entityId);
      if (
        !current || current !== mob ||
        this.pendingMobRetreats.get(mob.entityId) !== token ||
        current.jellyfishRuntime?.retreatPhase !== "preparing"
      ) return;
      this.pendingMobRetreats.delete(mob.entityId);
      this.completeCurrentJellyfishRetreat(current);
    });
  }

  private commitMobPhysicalPosition(mob: Combatant, position: LatLon): void {
    if (!mob.regionCode.startsWith("interior:")) {
      mob.regionCode = packageIdForPosition(position);
      mob.zoneId = zoneIdForPosition(position);
    }
    this.setMobPosition(mob, { ...position });
    this.markDirty(mob);
  }

  /**
   * The one write path for a mob's physical position: assigns it (the caller passes an object the
   * mob may own), records it in the lag-compensation history and updates the spatial grid.
   * `teleport` forgets the history first, so a rewind never interpolates across the jump.
   */
  private setMobPosition(mob: Combatant, position: LatLon, teleport = false): void {
    mob.position = position;
    if (teleport) this.positionHistory.reset(mob.entityId);
    this.positionHistory.record(mob.entityId, this.currentTick, position.lat, position.lon);
    this.grid.update(mob.entityId, position);
  }

  private acquireWorldMobIntents(): void {
    const entities = [...this.entities.values()];
    if (!entities.some((entity) => entity.kind === "mob" && entity.worldAi && entity.mobAi)) {
      return;
    }
    const candidates: Array<{
      mob: Combatant;
      player: Combatant;
      distanceM: number;
      intent: MobAiIntent;
      acquisitionDelayMs: number;
    }> = [];
    const neutralGoblinCandidates = new Map<string, {
      mob: Combatant;
      player: Combatant;
      distanceM: number;
    }>();
    const combatCandidateMobIds = new Set<string>();
    const players = entities
      .filter((entity) =>
        entity.kind === "player" &&
        entity.lifeState === "alive" &&
        !this.linkDeadPlayerIds.has(entity.entityId) &&
        !this.worldAbsentPlayerIds.has(entity.entityId)
      )
      .sort((left, right) => left.entityId.localeCompare(right.entityId));
    for (const player of players) {
      for (const entityId of this.grid.query(player.position, 400)) {
        const mob = this.entities.get(entityId);
        if (
          !mob ||
          mob.kind !== "mob" ||
          !mob.worldAi ||
          !mob.mobAi ||
          mob.mobAi.phase !== "idle" ||
          isMobRetreating(mob) ||
          mob.lifeState !== "alive" ||
          mob.targetEntityId !== null ||
          mob.aggroOwnerPlayerId !== null
        ) continue;
        const distanceM = distanceMeters(mob.position, player.position);
        const proactive = this.mobAiProfile(mob).proactive;
        if (proactive && distanceM <= proactive.radiusM && this.canMobAcquire(mob, player)) {
          candidates.push({
            mob, player, distanceM, intent: proactive.intent,
            acquisitionDelayMs: proactive.acquisitionDelayMs
          });
          if (proactive.intent === "combat") combatCandidateMobIds.add(mob.entityId);
          continue;
        }
        if (this.canGoblinDefenderRollForObservation(mob, player, distanceM)) {
          const current = neutralGoblinCandidates.get(mob.entityId);
          if (
            !current || distanceM < current.distanceM ||
            (distanceM === current.distanceM && player.entityId < current.player.entityId)
          ) neutralGoblinCandidates.set(mob.entityId, { mob, player, distanceM });
        }
      }
    }
    const now = this.now();
    const random = this.options.random ?? Math.random;
    for (const { mob, player, distanceM } of [...neutralGoblinCandidates.values()]
      .sort((left, right) => left.mob.entityId.localeCompare(right.mob.entityId))) {
      if (combatCandidateMobIds.has(mob.entityId) || mob.mobAi?.phase !== "idle") continue;
      mob.mobAi.observationCooldownUntilMs = now + GOBLIN_DEFENDER_OBSERVATION_ROLL_INTERVAL_MS;
      if (random() < GOBLIN_DEFENDER_OBSERVATION_CHANCE) {
        candidates.push({ mob, player, distanceM, intent: "observe", acquisitionDelayMs: 0 });
      }
    }
    candidates.sort((left, right) =>
      (left.intent === "combat" ? 0 : 1) - (right.intent === "combat" ? 0 : 1) ||
      left.distanceM - right.distanceM ||
      left.player.entityId.localeCompare(right.player.entityId) ||
      left.mob.entityId.localeCompare(right.mob.entityId)
    );
    const claimedMobs = new Set<string>();
    for (const { mob, player, intent, acquisitionDelayMs } of candidates) {
      if (claimedMobs.has(mob.entityId) || mob.mobAi?.phase !== "idle") continue;
      claimedMobs.add(mob.entityId);
      mob.mobAi.phase = acquisitionDelayMs > 0 ? "acquiring" :
        intent === "observe" ? "observing" : "engaging";
      mob.mobAi.intent = intent;
      mob.mobAi.targetPlayerId = player.entityId;
      mob.mobAi.deadlineTick = acquisitionDelayMs > 0
        ? this.currentTick + millisecondsToTicks(acquisitionDelayMs, this.options.tickRateHz)
        : null;
      mob.mobAi.deadlineAtMs = acquisitionDelayMs > 0
        ? this.now() + acquisitionDelayMs
        : null;
      // Easter egg: one roll per acquisition start, never per tick.
      if (
        acquisitionDelayMs > 0 && intent === "combat" && mob.archetypeKey === "ogre" &&
        (this.options.random ?? Math.random)() < OGRE_SWAMP_SHOUT_CHANCE
      ) {
        mob.mobAi.ambientSpeech = {
          text: OGRE_SWAMP_SHOUT_TEXT,
          expiresAt: this.now() + OGRE_SWAMP_SHOUT_DURATION_MS
        };
      }
      this.markDirty(mob);
      if (acquisitionDelayMs > 0) continue;
      if (intent === "observe") this.beginMobObservation(mob, player);
      else this.beginProactiveCombat(mob, player);
    }
  }

  private isAmbientGoblinDefender(entity: Combatant): boolean {
    return entity.kind === "mob" && entity.worldAi && entity.archetypeKey === "goblin" &&
      entity.npcFaction?.culture === "goblin" && entity.mobAi !== null;
  }

  private isGoblinDefenderNeutralObservationValid(
    mob: Combatant,
    player: Combatant,
    distanceM: number
  ): boolean {
    return this.isAmbientGoblinDefender(mob) &&
      player.lifeState === "alive" &&
      this.hasActiveAuthority(player) &&
      !this.linkDeadPlayerIds.has(player.entityId) &&
      !this.worldAbsentPlayerIds.has(player.entityId) &&
      !this.isNpcCityPlayerEnemy(mob.npcFaction!.cityId, player.entityId) &&
      mob.regionCode === player.regionCode && mob.zoneId === player.zoneId &&
      distanceM <= GOBLIN_DEFENDER_OBSERVATION_RADIUS_M &&
      this.flagArrivalProtectionUntil(player.entityId) === null &&
      !this.isNinjaInvisible(player);
  }

  private canGoblinDefenderRollForObservation(
    mob: Combatant,
    player: Combatant,
    distanceM: number
  ): boolean {
    return this.isGoblinDefenderNeutralObservationValid(mob, player, distanceM) &&
      mob.mobAi!.observationCooldownUntilMs <= this.now();
  }

  private hasEligibleGoblinDefenderEnemy(mob: Combatant): boolean {
    if (!this.isAmbientGoblinDefender(mob)) return false;
    const proactive = this.mobAiProfile(mob).proactive;
    if (!proactive || proactive.intent !== "combat") return false;
    return this.grid.query(mob.position, proactive.radiusM).some((entityId) => {
      const player = this.entities.get(entityId);
      return player?.kind === "player" &&
        player.lifeState === "alive" &&
        !this.linkDeadPlayerIds.has(player.entityId) &&
        !this.worldAbsentPlayerIds.has(player.entityId) &&
        distanceMeters(mob.position, player.position) <= proactive.radiusM &&
        this.canMobAcquire(mob, player);
    });
  }

  private processGoblinDefenderSpeech(mob: Combatant, now: number): void {
    const runtime = mob.mobAi!;
    if (now < runtime.nextAmbientSpeechRollAtMs) return;
    runtime.nextAmbientSpeechRollAtMs += GOBLIN_DEFENDER_CHATTER_INTERVAL_MS * Math.max(
      1,
      Math.floor((now - runtime.nextAmbientSpeechRollAtMs) / GOBLIN_DEFENDER_CHATTER_INTERVAL_MS) + 1
    );
    const random = this.options.random ?? Math.random;
    if (random() >= GOBLIN_DEFENDER_CHATTER_CHANCE) return;
    runtime.ambientSpeech = {
      text: goblinDefenderDialogueForRoll(random()),
      expiresAt: now + GOBLIN_DEFENDER_SPEECH_DURATION_MS
    };
    this.markDirty(mob);
  }

  private processGoblinDefenderWander(mob: Combatant, now: number): void {
    if (!this.isAmbientGoblinDefender(mob) || this.effectiveMobMovementSpeedMps(mob) <= 0) return;
    const runtime = mob.mobAi!;
    if (runtime.wanderTarget === null) {
      if (now < runtime.nextWanderAtMs) return;
      const random = this.options.random ?? Math.random;
      const candidate = destinationPoint(
        mob.homePosition,
        Math.sqrt(random()) * GOBLIN_DEFENDER_WANDER_RADIUS_M,
        random() * 360
      );
      if (!this.isMobPositionTraversable(candidate, mob.regionCode)) {
        runtime.nextWanderAtMs = now + GOBLIN_DEFENDER_WANDER_PAUSE_MS;
        return;
      }
      runtime.wanderTarget = candidate;
    }
    if (this.isMobMovementHeld(mob)) return;
    const target = runtime.wanderTarget;
    const maximumStepM = this.effectiveMobMovementSpeedMps(mob) / this.options.tickRateHz;
    const remainingM = distanceMeters(mob.position, target);
    const next = this.moveMobWithPackSeparation(mob, target, maximumStepM);
    if (
      !this.isMobPositionTraversable(next, mob.regionCode) ||
      distanceMeters(mob.homePosition, next) > GOBLIN_DEFENDER_WANDER_RADIUS_M
    ) {
      runtime.wanderTarget = null;
      runtime.nextWanderAtMs = now + GOBLIN_DEFENDER_WANDER_PAUSE_MS;
      return;
    }
    this.commitMobPhysicalPosition(mob, next);
    if (remainingM <= maximumStepM) {
      runtime.wanderTarget = null;
      runtime.nextWanderAtMs = now + GOBLIN_DEFENDER_WANDER_PAUSE_MS;
      mob.activityState = "idle";
      mob.chaseDestination = null;
    } else {
      mob.activityState = "chasing";
      mob.chaseDestination = target;
    }
  }

  private canMobAcquire(mob: Combatant, player: Combatant): boolean {
    return (!mob.npcFaction || this.isNpcCityPlayerEnemy(mob.npcFaction.cityId, player.entityId)) &&
      this.flagArrivalProtectionUntil(player.entityId) === null &&
      !this.isNinjaInvisible(player) &&
      this.options.canMobProactivelyAcquire?.(mob.entityId, player.entityId) === true;
  }

  private canMobContinueIntent(mob: Combatant, player: Combatant): boolean {
    return (!mob.npcFaction || this.isNpcCityPlayerEnemy(mob.npcFaction.cityId, player.entityId)) &&
      this.flagArrivalProtectionUntil(player.entityId) === null &&
      !this.isNinjaInvisible(player) &&
      !this.worldAbsentPlayerIds.has(player.entityId) &&
      (this.options.canMobContinueIntent?.(mob.entityId, player.entityId) ??
        this.options.canMobProactivelyAcquire?.(mob.entityId, player.entityId)) === true;
  }

  private beginProactiveCombat(mob: Combatant, player: Combatant): void {
    const profile = this.mobAiProfile(mob);
    const session = this.ensurePveSession(player);
    if (profile.onAttacked?.group === "exact_pack" && mob.packId) {
      this.engageHostileGroup(mob, player, session);
    } else {
      this.engageHostileMob(mob, player, session);
    }
    if (session.enemyQueue.length > 0) this.scheduleEnemyPhaseAfterArrival(player, session);
  }

  private beginMobObservation(mob: Combatant, player: Combatant): void {
    const runtime = mob.mobAi;
    if (!runtime) return;
    runtime.phase = "observing";
    runtime.intent = "observe";
    runtime.targetPlayerId = player.entityId;
    const ambientGoblin = this.isAmbientGoblinDefender(mob);
    runtime.deadlineTick = ambientGoblin
      ? this.currentTick + millisecondsToTicks(
          GOBLIN_DEFENDER_OBSERVATION_DURATION_MS,
          this.options.tickRateHz
        )
      : null;
    runtime.deadlineAtMs = ambientGoblin
      ? this.now() + GOBLIN_DEFENDER_OBSERVATION_DURATION_MS
      : null;
    runtime.wanderTarget = null;
    mob.activityState = "idle";
    mob.chaseDestination = null;
    this.activeChases.delete(mob.entityId);
    this.markDirty(mob);
  }

  private processMobObservation(mob: Combatant, profile: MobAiProfile): void {
    const runtime = mob.mobAi!;
    const player = runtime.targetPlayerId ? this.entities.get(runtime.targetPlayerId) : null;
    if (this.isAmbientGoblinDefender(mob)) {
      const distanceM = player?.kind === "player"
        ? distanceMeters(mob.position, player.position)
        : Number.POSITIVE_INFINITY;
      if (
        !player || player.kind !== "player" || player.lifeState !== "alive" ||
        !this.isGoblinDefenderNeutralObservationValid(mob, player, distanceM)
      ) {
        this.cancelMobAiIntent(mob);
        return;
      }
      if (runtime.deadlineAtMs !== null && this.now() >= runtime.deadlineAtMs) {
        runtime.observationCooldownUntilMs = this.now() + GOBLIN_DEFENDER_ATTENTION_COOLDOWN_MS;
        this.cancelMobAiIntent(mob);
      }
      return;
    }
    if (
      !player ||
      player.kind !== "player" ||
      player.lifeState !== "alive" ||
      profile.movement.kind !== "standoff" ||
      !this.canMobContinueIntent(mob, player)
    ) {
      this.cancelMobAiIntent(mob);
      return;
    }
    const distanceM = distanceMeters(mob.position, player.position);
    const offsetM = Math.abs(distanceM - profile.movement.distanceM);
    if (offsetM <= profile.movement.deadbandM) {
      if (mob.activityState !== "idle" || mob.chaseDestination !== null) {
        mob.activityState = "idle";
        mob.chaseDestination = null;
        this.markDirty(mob);
      }
      return;
    }
    if (this.isMobMovementHeld(mob)) return;
    const bearing = initialBearingDegrees(player.position, mob.position);
    const desiredDestination = destinationPoint(
      player.position,
      profile.movement.distanceM,
      bearing
    );
    const view = this.options.getAuthoritativeViewCircle?.(player.entityId);
    const destination = view &&
        distanceMeters(view.center, desiredDestination) > view.radiusM
      ? destinationPoint(
          view.center,
          view.radiusM,
          initialBearingDegrees(view.center, desiredDestination)
        )
      : desiredDestination;
    const next = moveToward(
      mob.position,
      destination,
      this.effectiveMobMovementSpeedMps(mob) / this.options.tickRateHz
    );
    if (!this.isMobPositionTraversable(next, mob.regionCode)) {
      mob.activityState = "idle";
      mob.chaseDestination = null;
      this.markDirty(mob);
      return;
    }
    this.setMobPosition(mob, next);
    mob.activityState = "chasing";
    mob.chaseDestination = destination;
    this.markDirty(mob);
  }

  private processMobDisengagement(mob: Combatant, profile: MobAiProfile): void {
    if (profile.disengagement.kind !== "outside_radius") return;
    const runtime = mob.mobAi!;
    const player = runtime.targetPlayerId ? this.entities.get(runtime.targetPlayerId) : null;
    if (!player || player.kind !== "player" || player.lifeState !== "alive") return;
    if (distanceMeters(mob.position, player.position) <= profile.disengagement.radiusM) {
      if (runtime.deadlineTick !== null) {
        runtime.deadlineTick = null;
        runtime.deadlineAtMs = null;
        this.markDirty(mob);
      }
      return;
    }
    if (runtime.deadlineTick === null) {
      runtime.deadlineTick = this.currentTick + millisecondsToTicks(
        profile.disengagement.graceMs,
        this.options.tickRateHz
      );
      runtime.deadlineAtMs = this.now() + profile.disengagement.graceMs;
      this.markDirty(mob);
      return;
    }
    if (this.currentTick < runtime.deadlineTick) return;
    const session = mob.aggroOwnerPlayerId
      ? this.pveSessions.get(mob.aggroOwnerPlayerId)
      : null;
    if (session) this.removeEnemy(session, mob.entityId);
    else this.finishMobAiEngagement(mob);
  }

  private cancelMobAiIntent(mob: Combatant): void {
    if (!mob.mobAi) return;
    mob.mobAi.phase = "idle";
    mob.mobAi.intent = null;
    mob.mobAi.targetPlayerId = null;
    mob.mobAi.deadlineTick = null;
    mob.mobAi.deadlineAtMs = null;
    mob.mobAi.wanderTarget = null;
    mob.activityState = "idle";
    mob.chaseDestination = null;
    this.activeChases.delete(mob.entityId);
    this.markDirty(mob);
  }

  private processChases(): void {
    const activeChaseIds = [...this.activeChases].sort();
    const count = Math.min(
      activeChaseIds.length,
      this.options.maxChasesPerTick ?? 2_048
    );
    const start = activeChaseIds.length === 0 ? 0 : this.chaseCursor % activeChaseIds.length;
    for (let offset = 0; offset < count; offset += 1) {
      const entityId = activeChaseIds[(start + offset) % activeChaseIds.length];
      if (!entityId) {
        continue;
      }
      // Mob tactics moves the mobs it manages (empty, so a no-op, while the flag is off).
      if (this.mobTactics.has(entityId)) {
        this.activeChases.delete(entityId);
        continue;
      }
      const attacker = this.entities.get(entityId);
      const target = attacker?.targetEntityId
        ? this.entities.get(attacker.targetEntityId)
        : undefined;
      if (this.isPlayerReserved(attacker?.entityId ?? "") || this.isPlayerReserved(target?.entityId ?? "")) continue;
      if (!attacker || !target || !this.isAttackPairValid(attacker, target)) {
        if (attacker) {
          this.clearTarget(attacker);
        }
        continue;
      }
      if (attacker.kind !== "mob") {
        this.activeChases.delete(attacker.entityId);
        attacker.chaseDestination = null;
        this.markDirty(attacker);
        continue;
      }
      const chaseTargetPosition = target.position;
      const encounterPursuit = this.isEncounterPursuitWithinView(attacker, target);
      if (
        attacker.kind === "mob" &&
        !encounterPursuit &&
        attacker.leashRadiusM > 0 &&
        distanceMeters(attacker.homePosition, chaseTargetPosition) >
          attacker.leashRadiusM + attacker.attackRangeM
      ) {
        this.clearTarget(attacker);
        continue;
      }
      const distanceM = distanceMeters(attacker.position, chaseTargetPosition);
      if (distanceM <= attacker.attackRangeM) {
        this.activeChases.delete(attacker.entityId);
        attacker.activityState = "attacking";
        attacker.chaseDestination = null;
        this.markDirty(attacker);
        continue;
      }
      if (
        this.currentTick - attacker.lastChaseUpdateTick >=
        COMBAT_CHASE_REEVALUATE_TICKS
      ) {
        attacker.lastChaseUpdateTick = this.currentTick;
        attacker.chaseDestination = moveToward(
          chaseTargetPosition,
          attacker.position,
          Math.min(BASIC_ATTACK_APPROACH_M, Math.max(0, distanceM - 0.1))
        );
      }
      if (attacker.chaseDestination) {
        if (this.stepMobToward(attacker, attacker.chaseDestination, encounterPursuit) === "leashed") {
          this.clearTarget(attacker);
        }
      }
    }
    this.chaseCursor = activeChaseIds.length === 0 ? 0 : (start + count) % activeChaseIds.length;
  }

  /** One tick of mob travel: base speed with slows, Monk aura and Hunter snare applied. */
  private mobChaseStepM(mob: Combatant): number {
    return this.effectiveMobMovementSpeedMps(mob) * Math.max(
      0.2,
      1 - this.effectTotal(mob, "movement_slow") -
        this.v3MonkSlowAura(mob) / Math.max(1, this.effectiveMobMovementSpeedMps(mob))
    ) *
      (this.hunterSnareEffect(mob) ? HUNTER_BALANCE.snareMovementMultiplier : 1) /
      this.options.tickRateHz;
  }

  /**
   * The shared chase step (processChases and mob tactics): hold check, one step toward
   * `destination` at chase speed (pack separation included), then `commitMobStep`.
   */
  private stepMobToward(
    mob: Combatant,
    destination: LatLon,
    ignoreLeash: boolean
  ): "held" | "blocked" | "moved" | "leashed" {
    if (this.isMobMovementHeld(mob)) return "held";
    const next = this.moveMobWithPackSeparation(mob, destination, this.mobChaseStepM(mob));
    return this.commitMobStep(mob, next, ignoreLeash);
  }

  /**
   * Writes a mob step through setMobPosition after the habitat and leash checks. A wrong surface
   * ahead (a land mob at the shore, a water mob at the beach) holds the step; a step past the
   * leash is refused and reported so the caller can drop the target.
   */
  private commitMobStep(mob: Combatant, next: LatLon, ignoreLeash: boolean, extraLeashM = 0): "blocked" | "moved" | "leashed" {
    if (!this.isMobHabitatStepAllowed(mob, next)) return "blocked";
    if (
      ignoreLeash ||
      mob.leashRadiusM <= 0 ||
      distanceMeters(mob.homePosition, next) <= mob.leashRadiusM + extraLeashM
    ) {
      this.setMobPosition(mob, next);
      this.markDirty(mob);
      return "moved";
    }
    return "leashed";
  }

  private reconcilePveEnemyMembership(): void {
    for (const session of [...this.pveSessions.values()].sort((left, right) =>
      left.playerId.localeCompare(right.playerId)
    )) {
      if (this.pveSessions.get(session.playerId) !== session) continue;
      const player = this.entities.get(session.playerId);
      if (!player || player.lifeState !== "alive") continue;

      for (const enemyId of [...session.enemyIds]) {
        if (!this.isEnemyValidForSession(session, enemyId)) this.removeEnemy(session, enemyId);
      }
      if (this.pveSessions.get(session.playerId) !== session) continue;

      for (const enemyId of [...session.enemyQueue]) {
        const enemy = this.entities.get(enemyId);
        if (!enemy || enemy.aggroOwnerPlayerId !== session.playerId) continue;
        const target = enemy.targetEntityId ? this.entities.get(enemy.targetEntityId) : player;
        if (!target || this.isWithinMobAttackHoldRange(enemy, target)) continue;
        if (this.removeEnemyFromQueue(session, enemyId)) {
          session.pursuingEnemyIds.add(enemyId);
          this.startChasing(enemy);
        }
      }

      const arrivals = [...session.pursuingEnemyIds]
        .map((enemyId) => this.entities.get(enemyId))
        .filter((enemy): enemy is Combatant => Boolean(
          enemy &&
          enemy.aggroOwnerPlayerId === session.playerId &&
          this.isEnemyValidForSession(session, enemy.entityId) &&
          distanceMeters(
            enemy.position,
            (enemy.targetEntityId ? this.entities.get(enemy.targetEntityId) : player)?.position ?? player.position
          ) <= enemy.attackRangeM
        ))
        .sort((left, right) =>
          distanceMeters(
            left.position,
            (left.targetEntityId ? this.entities.get(left.targetEntityId) : player)?.position ?? player.position
          ) - distanceMeters(
            right.position,
            (right.targetEntityId ? this.entities.get(right.targetEntityId) : player)?.position ?? player.position
          ) ||
          left.entityId.localeCompare(right.entityId)
        );
      for (const enemy of arrivals) {
        const queueWasEmpty = session.enemyQueue.length === 0;
        if (!this.appendEnemy(session, enemy.entityId)) continue;
        this.activeChases.delete(enemy.entityId);
        enemy.activityState = "attacking";
        enemy.chaseDestination = null;
        this.markDirty(enemy);
        const playerHasPendingOpeningAttack =
          player.targetEntityId === enemy.entityId && player.scheduledAttackTick !== null;
        if (queueWasEmpty && !playerHasPendingOpeningAttack) {
          this.scheduleEnemyPhaseAfterArrival(player, session);
        }
      }
    }
  }

  private scheduleEnemyPhaseAfterArrival(player: Combatant, session: PveCombatSession): void {
    if (session.phase !== "waiting_player" || session.enemyActionAtTick !== null) return;
    const anchorTick = session.playerTurnAnchorTick ?? this.currentTick;
    let nextEnemyTick = anchorTick + this.pveTurnStepTicks;
    while (nextEnemyTick <= this.currentTick) nextEnemyTick += this.pveTurnStepTicks * 2;
    session.phase = "enemy_pending";
    session.enemyActionAtTick = nextEnemyTick;
    this.noteSessionChanged(player, session);
  }

  private processClassRuntimeTick(): void {
    this.processClassAbilityZones();
    const now = this.now();
    for (const entity of [...this.entities.values()].sort((left, right) => left.entityId.localeCompare(right.entityId))) {
      if (this.isPlayerReserved(entity.entityId)) continue;
      const runtime = entity.classRuntime;
      if (!runtime) continue;
      let changed = this.updateV3Tactics(entity, now);
      const effects = [...runtime.effects];
      for (const effect of effects) {
        if (this.currentTick > effect.endTick) continue;
        if (effect.kind === "gloom" && this.currentTick >= effect.endTick) {
          effect.stacks = 0;
          this.markDirty(entity);
          continue;
        }
        if (this.currentTick < effect.nextTick) continue;
        if (!this.periodicTickOnPhase(entity, effect)) continue;
        const metalTick = metalStatusTick(effect);
        if (
          (effect.kind === "poison" || effect.kind === "burning" || (effect.kind === "storm" && metalTick)) &&
          entity.lifeState === "alive" && effect.stacks > 0
        ) {
          const stormSource = effect.kind === "storm" ? this.entities.get(effect.sourceEntityId) : undefined;
          // Electrified enemies only take the pulse while within range of the player who shocked them.
          const pulses = effect.kind !== "storm" || (
            stormSource !== undefined &&
            distanceMeters(stormSource.position, entity.position) <= METAL_PROC_BALANCE.storm.radiusM
          );
          if (pulses) {
            // Metal rolls keep their per-second range: the roll scales to the beat interval.
            // Venom and Ember ward rings take their per-second amount off each tick, on the same scale.
            const wardScale = metalTick ? beatAlignedAmountScale(metalTick.tickMs) : 1;
            const ward = effect.kind === "poison"
              ? this.ringBonus(entity, "venom_ward")
              : effect.kind === "burning" ? this.ringBonus(entity, "ember_ward") : 0;
            const tickDamage = this.carryPeriodicAmount(effect, Math.max(0, (metalTick
              ? this.randomMetalDamage(metalTick.damageMin, metalTick.damageMax) * wardScale
              : effect.amount) - ward * wardScale));
            if (tickDamage > 0) {
              this.applyStatusDamage(effect.sourceEntityId, entity, tickDamage, effect.sourceTechniqueId, effect.kind);
            }
          }
          effect.stacks -= 1;
          this.advancePeriodicTick(effect, this.periodicIntervalTicks(
            metalTick?.tickMs ??
              (effect.kind === "burning" && effect.sourceTechniqueId === "elemental_fire_burning"
                ? ELEMENTAL_BIRD_BURN.tickMs
                : HARMFUL_STATUS_PULSE_INTERVAL_MS)
          ));
          if (effect.stacks <= 0) effect.endTick = this.currentTick - 1;
          this.markDirty(entity);
          if (effect.kind === "burning" && metalTick && entity.lifeState === "alive") {
            this.spreadMetalBurn(entity, effect);
          }
        } else if (effect.kind === "blight" && entity.lifeState === "alive" && effect.stacks > 0) {
          const source = this.entities.get(effect.sourceEntityId);
          const tickAmount = this.nextDistributedEffectAmount(effect);
          if (source?.lifeState === "alive" && tickAmount > 0) {
            this.resolvePeriodicDamage(source, entity, tickAmount, V3_BLIGHT_ID);
          }
          effect.stacks -= 1;
          this.advancePeriodicTick(effect, this.periodicIntervalTicks(V3_BLIGHT_TICK_MS));
          if (effect.stacks <= 0) effect.endTick = this.currentTick - 1;
          changed = true;
        } else if (effect.kind === "healing_over_time" && entity.lifeState === "alive") {
          const source = this.entities.get(effect.sourceEntityId);
          const tickHeal = this.carryPeriodicAmount(effect, effect.amount * effect.stacks);
          if (source?.kind === "player" && source.lifeState === "alive" && tickHeal > 0) {
            this.applyHealing(source, entity, tickHeal);
          }
          this.advancePeriodicTick(effect, effect.remainingActions ?? this.attackIntervalTicks);
          changed = true;
        } else if (effect.kind === "bleed" && entity.lifeState === "alive") {
          const source = this.entities.get(effect.sourceEntityId);
          if (source?.lifeState === "alive") {
            this.resolvePeriodicDamage(
              source,
              entity,
              effect.amount * effect.stacks,
              effect.sourceTechniqueId
            );
            if (source.classRuntime?.subclassId === "reaver") {
              source.classRuntime.bloodlust = clampRage(source.classRuntime.bloodlust + 5);
              this.markDirty(source);
              this.rememberClassRuntime(source);
            }
          }
          this.advancePeriodicTick(effect, this.attackIntervalTicks);
          changed = true;
        }
      }
      const retained = runtime.effects.filter((effect) => this.currentTick <= effect.endTick && effect.stacks > 0);
      if (retained.length !== runtime.effects.length) {
        if (runtime.effects.some((effect) =>
          !retained.includes(effect) && !isHarmfulStatusKind(effect.kind)
        )) changed = true;
        else this.markDirty(entity);
      }
      runtime.effects = retained;


      const inCombat = this.isInCombat(entity.entityId);
      if (inCombat) {
        runtime.lastCombatAtMs = now;
        runtime.counters.rageDecayAccumulator = 0;
        runtime.counters.guardDecayAccumulator = 0;
      }
      if (
        runtime.activeClassId === "hunter" && entity.lifeState === "alive" &&
        this.currentTick % this.options.tickRateHz === 0 &&
        runtime.rage < this.classResourceMaximum(entity)
      ) {
        const rank = automaticRank(runtime.masteryRank, [3, 8, 13, 18, 23]);
        const tuning = rank > 0 ? HUNTER_BALANCE.focusControl[rank - 1]! : null;
        const perSecond = inCombat
          ? HUNTER_BALANCE.focus.inCombatPerSecond + (tuning?.inCombatBonus ?? 0)
          : HUNTER_BALANCE.focus.outOfCombatPerSecond + (tuning?.outOfCombatBonus ?? 0);
        const accumulated =
          Number(runtime.counters.focusRegenerationAccumulator ?? 0) +
          perSecond;
        const wholeFocus = Math.floor(accumulated);
        runtime.counters.focusRegenerationAccumulator = accumulated - wholeFocus;
        if (wholeFocus > 0) {
          this.addRage(entity, wholeFocus, "regeneration");
          changed = true;
        }
      } else if (
        runtime.activeClassId === "warrior" &&
        !inCombat && runtime.lastCombatAtMs !== null
      ) {
        const warriorMastery = warriorEffects(runtime.masteryRank);
        const tuning = { decayPerSecond: WARRIOR_BALANCE.rage.decayPerSecond * warriorMastery.rageDecayRateMultiplier };
        const decayDelayMs = WARRIOR_BALANCE.rage.decayDelayMs + warriorMastery.rageDecayDelayBonusMs;
        if (
          now - runtime.lastCombatAtMs >= decayDelayMs &&
          this.currentTick % this.options.tickRateHz === 0 &&
          runtime.rage > 0
        ) {
          const accumulated = Number(runtime.counters.rageDecayAccumulator ?? 0) + tuning.decayPerSecond;
          const wholeRage = Math.floor(accumulated);
          runtime.counters.rageDecayAccumulator = accumulated - wholeRage;
          runtime.rage = Math.max(0, runtime.rage - wholeRage);
          changed = true;
        }
      }
      if (runtime.subclassId !== "warden") {
        if (runtime.guard !== 0 || runtime.counters.reprisalReady === true) {
          runtime.guard = 0;
          runtime.counters.reprisalReady = false;
          changed = true;
        }
      } else if (
        !inCombat &&
        runtime.guard > 0 &&
        this.currentTick % this.options.tickRateHz === 0
      ) {
        runtime.guard = Math.max(
          0,
          runtime.guard - WARRIOR_BALANCE.guardPostCombatDecayPerSecond
        );
        changed = true;
      }
      if (changed) {
        this.markDirty(entity);
        this.rememberClassRuntime(entity);
      }
    }
  }

  /** Ticks between two beats of a periodic effect designed at `designIntervalMs`. */
  private periodicIntervalTicks(designIntervalMs: number): number {
    return Math.max(1, millisecondsToTicks(beatAlignedIntervalMs(designIntervalMs), this.options.tickRateHz));
  }

  /**
   * The beat a periodic effect follows: a player-applied effect ticks on its source's player half
   * of the PvE turn, a monster-applied one on its player victim's enemy half. Null when no PvE turn
   * anchors either side (PvP, out of combat): the effect then keeps its own whole-beat spacing.
   */
  private periodicPhase(sourceEntityId: string, target: Combatant): { anchorTick: number; sideOffsetTicks: number } | null {
    const source = this.entities.get(sourceEntityId);
    if (source?.kind === "player") {
      const anchorTick = this.pveSessions.get(source.entityId)?.playerTurnAnchorTick ?? null;
      return anchorTick === null ? null : { anchorTick, sideOffsetTicks: 0 };
    }
    if (target.kind !== "player") return null;
    const anchorTick = this.pveSessions.get(target.entityId)?.playerTurnAnchorTick ?? null;
    return anchorTick === null ? null : { anchorTick, sideOffsetTicks: this.pveTurnStepTicks };
  }

  /** Ticks past the owning side's beat point, in [0, one beat). */
  private periodicBeatOffset(tick: number, phase: { anchorTick: number; sideOffsetTicks: number }): number {
    const beat = Math.max(1, this.attackIntervalTicks);
    return ((tick - phase.anchorTick - phase.sideOffsetTicks) % beat + beat) % beat;
  }

  /** First tick of a periodic effect: one interval out, snapped to the nearest owning-side beat point. */
  private firstPeriodicTick(sourceEntityId: string, target: Combatant, intervalTicks: number): number {
    const nominal = this.currentTick + intervalTicks;
    const phase = this.periodicPhase(sourceEntityId, target);
    if (!phase) return nominal;
    const beat = Math.max(1, this.attackIntervalTicks);
    const offset = this.periodicBeatOffset(nominal, phase);
    const aligned = offset <= beat / 2 ? nominal - offset : nominal + beat - offset;
    return aligned > this.currentTick ? aligned : aligned + beat;
  }

  /**
   * A due periodic tick fires only inside its owning side's half of the turn, so it never shares a
   * tick with an opposing attack. If the turn re-anchored since, it waits for the next owning beat
   * point and its end moves by the same delay, so no pulse is lost.
   */
  private periodicTickOnPhase(target: Combatant, effect: CombatEffect): boolean {
    if (!isPeriodicEffectKind(effect.kind)) return true;
    const phase = this.periodicPhase(effect.sourceEntityId, target);
    if (!phase) return true;
    const offset = this.periodicBeatOffset(this.currentTick, phase);
    if (offset < this.pveTurnStepTicks) return true;
    const resumeTick = this.currentTick + Math.max(1, this.attackIntervalTicks) - offset;
    if (effect.endTick !== Number.MAX_SAFE_INTEGER) effect.endTick += resumeTick - effect.nextTick;
    effect.nextTick = resumeTick;
    return false;
  }

  /** Steps a periodic effect one interval on; a late tick never fires twice to catch up. */
  private advancePeriodicTick(effect: CombatEffect, intervalTicks: number): void {
    effect.nextTick += intervalTicks;
    while (effect.nextTick <= this.currentTick) effect.nextTick += intervalTicks;
  }

  /** Whole points for one tick of a beat-scaled amount; the remaining fraction carries forward. */
  private carryPeriodicAmount(effect: CombatEffect, exactAmount: number): number {
    const owed = Math.max(0, exactAmount) + (effect.amountCarry ?? 0);
    const whole = Math.floor(owed + 1e-9);
    effect.amountCarry = Math.max(0, owed - whole);
    return whole;
  }

  private nextDistributedEffectAmount(effect: CombatEffect): number {
    const remainingTicks = Math.max(1, effect.stacks);
    const remainingAmount = Math.max(
      0,
      Math.trunc(effect.remainingAmount ?? effect.amount * remainingTicks)
    );
    const amount = Math.ceil(remainingAmount / remainingTicks);
    effect.remainingAmount = Math.max(0, remainingAmount - amount);
    return amount;
  }

  private resolveBasicAttack(
    attacker: Combatant,
    target: Combatant,
    embeddedAction = false,
    attackContext: AttackResolutionContext = {}
  ): number {
    if (
      attacker.kind === "mob" &&
      target.kind === "player" &&
      this.options.isMobPlayerAttackAuthorized &&
      !this.options.isMobPlayerAttackAuthorized(attacker.entityId, target.entityId)
    ) return 0;
    const runtime = attacker.classRuntime;
    const session = attacker.kind === "player" ? this.pveSessions.get(attacker.entityId) : null;
    if (attacker.kind === "player") {
      this.breakNinjaInvisible(attacker);
      if (!embeddedAction) this.beginPlayerAction(attacker);
    }
    const activeBlight = runtime?.effects.find((effect) =>
      effect.kind === "blight" && effect.endTick >= this.currentTick && effect.stacks > 0
    );
    if (activeBlight && (this.options.random?.() ?? Math.random()) < activeBlight.amount) {
      attackContext.suppressed = true;
      attackContext.damageEvent = this.emitEvent(
        "DAMAGE",
        attacker.entityId,
        target.entityId,
        0,
        target.currentHealth
      );
      return 0;
    }
    // Generic outgoing effects are applied exactly once in applyDamage.
    const multiplier = (attacker.kind === "player" && runtime
      ? this.basicOrResetMultiplier(attacker, target)
      : 1) * (attackContext.damageMultiplier ?? 1);
    const attackPowerBeforeMultiplier = Math.max(
      1,
      attacker.attackDamage + this.warriorFlatAttackBonus(attacker, true, target)
    );
    const attackPower = Math.max(1, Math.round(attackPowerBeforeMultiplier * multiplier));
    let defenseMitigation: DefenseMitigation = {};
    let defense = 0;
    let raw: number;
    let damageResolution: CombatDamageResolution;
    if (attacker.kind === "player" && target.kind === "player") {
      damageResolution = this.resolveContextDamage(attacker, target, {
        pveDamage: attackPower,
        pvpDamageBeforePowerScaling: attackPowerBeforeMultiplier,
        pvpDamageMultiplier: multiplier,
        pvpUseEquipmentMatrix: true
      });
      raw = damageResolution.finalDamage;
    } else if (attacker.kind === "mob" && target.kind === "player") {
      const mobMatrix = this.pveMatrixMobProfile(attacker);
      const matrixDamage = mobMatrix
        ? this.resolveMobToPlayerPveMatrixDamage(attacker, target, mobMatrix)
        : null;
      // Matrix hits already account for armor type and level, so equipment
      // defense is excluded; class, taunt, and district defense still apply.
      const baseStages = this.effectiveDefenseStages(target, matrixDamage !== null);
      const tauntDefense = this.effectTotalForTarget(target, "taunt_defense", attacker.entityId);
      const classDefense = this.v3ClassDefenseBonuses(target, attacker);
      const contextualDefense = this.v3PveContextualDefenseBonus(target, attacker) +
        classDefense.body + classDefense.shield;
      const stages = {
        armor: Math.max(0, baseStages.armor + tauntDefense + contextualDefense),
        ironhide: Math.max(0, baseStages.ironhide + tauntDefense + contextualDefense),
        lastStand: Math.max(0, baseStages.lastStand + tauntDefense + contextualDefense)
      };
      const incomingDamage = matrixDamage ?? attackPower;
      const beforeDefense = damageFromStats(incomingDamage, 0);
      const afterDefense = damageFromStats(incomingDamage, stages.lastStand);
      const totalMitigated = Math.max(0, beforeDefense - afterDefense);
      const defenseDenominator = Math.max(1, stages.lastStand);
      defenseMitigation = {
        armor: totalMitigated * stages.armor / defenseDenominator,
        ironhide: totalMitigated * Math.max(0, stages.ironhide - stages.armor) / defenseDenominator,
        last_stand: totalMitigated * Math.max(0, stages.lastStand - stages.ironhide) / defenseDenominator
      };
      raw = incomingDamage;
      defense = stages.lastStand;
      damageResolution = {
        context: "pve",
        damageBeforePowerScaling: raw,
        powerMultiplier: 1,
        finalDamage: raw
      };
    } else if (attacker.kind === "mob" && target.undead && this.mobVersusMobMatrixDamage(attacker, target) > 0) {
      // Monsters fight Revenant Metal undead through the universal matrix (armor type and level).
      raw = this.mobVersusMobMatrixDamage(attacker, target);
      damageResolution = { context: "pve", damageBeforePowerScaling: raw, powerMultiplier: 1, finalDamage: raw };
    } else {
      raw = attackPower;
      defense = attacker.equipmentCombatState?.stats.bypassPveDefense === true
        ? 0
        : this.effectiveDefense(target);
      damageResolution = this.resolveContextDamage(attacker, target, {
        pveDamage: raw,
        pveDamageBeforeMultiplier: attackPowerBeforeMultiplier,
        pveDamageMultiplier: multiplier
      });
      raw = damageResolution.finalDamage;
    }
    const appliedDamage = this.applyDamage(
      attacker,
      target,
      raw,
      attacker.kind === "player"
          ? ({
            warrior: "warrior_basic_attack",
            druid: "druid_basic_attack",
            ranger: "ranger_basic_attack",
            hunter: "hunter_basic_attack",
            knight: "knight_basic_attack",
            ninja: "ninja_basic_attack"
          } as Record<ClassId, string>)[runtime?.activeClassId ?? "warrior"]
        : "enemy_basic_attack",
      true,
      defenseMitigation,
      defense,
      true,
      undefined,
      attackContext
    );
    const resolvedTarget = this.entities.get(attackContext.resolvedTargetEntityId ?? target.entityId) ?? target;
    if (appliedDamage > 0) {
      this.resolveV3BasicAttackProcs(attacker, resolvedTarget, appliedDamage);
    }
    if (runtime && attacker.kind === "player") {
      this.resolveV2ScheduledAttackPassives(attacker, resolvedTarget, appliedDamage, attackContext);
      for (const effect of runtime.effects.filter((effect) =>
        effect.kind === "flat_attack" && effect.sourceTechniqueId.includes("_v2_") &&
        this.v2ScheduledBonusApplies(runtime, effect.sourceTechniqueId)
      )) {
        effect.stacks -= 1;
      }
      runtime.effects = runtime.effects.filter((effect) => effect.stacks > 0);
    }
    session?.telemetry.recordPowerResolution({
      damageBeforePowerScaling: damageResolution.damageBeforePowerScaling,
      powerMultiplier: damageResolution.powerMultiplier,
      finalPowerScaledDamage: damageResolution.finalDamage,
      resolvedTick: this.currentTick
    });
    if (attacker.kind === "player") {
      this.applyEquipmentProcResolution(
        attacker,
        resolvedTarget,
        this.resolveEquipmentProc(attacker, resolvedTarget, appliedDamage, true)
      );
      this.rollMonkStun(attacker, resolvedTarget, appliedDamage);
    }
    if (attacker.kind === "player") this.consumePlayerActionDefenseReduction(resolvedTarget);
    if (runtime && attacker.kind === "player") {
      if (runtime.activeClassId === "hunter") {
        const keen = runtime.equippedPassives.has("hunter_keen_focus") ? HUNTER_BALANCE.focus.keenFocusBonus : 0;
        const bloodScent = runtime.subclassId === "stalker" && this.hasQueueBleed(resolvedTarget)
          ? HUNTER_BALANCE.focus.bloodScentBonus
          : 0;
        this.addRage(attacker, HUNTER_BALANCE.focus.basicOrReset + keen, "attack");
        if (bloodScent > 0) this.addRage(attacker, bloodScent, "blood_scent");
        this.advanceSteadyHand(attacker, resolvedTarget);
      }
      this.rememberClassRuntime(attacker);
    }
    if (!embeddedAction) {
      session?.telemetry.recordPlayerAction({
        action: "basic_attack",
        atMs: this.telemetryTime(session),
        damage: appliedDamage
      });
    }
    return appliedDamage;
  }

  private commitAbilityActivation(
    attacker: Combatant,
    definition: TechniqueDefinition,
    presentation: { target?: Combatant; targetPosition?: LatLon } = {}
  ): void {
    const runtime = requireClassCombatRuntime(attacker);
    const reset = this.isResetAbility(definition.id);
    const reserved = runtime.queuedAbility?.reservedRage ?? 0;
    runtime.queuedAbility = null;
    runtime.reservedRage = 0;
    const cost = this.rageCost(runtime, definition);
    if (reserved === 0) {
      if (runtime.rage < cost) {
        throw new CombatRequestError(
          `${runtime.resourceId.toUpperCase()}_INSUFFICIENT`,
          `Not enough ${runtime.resourceId.charAt(0).toUpperCase()}${runtime.resourceId.slice(1)}`
        );
      }
      runtime.rage -= cost;
      if (runtime.activeClassId === "hunter") {
        runtime.counters.focusSpent = Number(runtime.counters.focusSpent ?? 0) + cost;
      }
      this.pveSessions.get(attacker.entityId)?.telemetry.recordResource({ spent: cost });
    }
    let configuredCooldown = reset ? BASIC_ATTACK_RESET_COOLDOWN_MS : definition.cooldownMs;
    if (runtime.equippedPassives.has("ninja_v2_quick_hands") &&
      ["ninja_v2_twin_fang", "ninja_v2_shuriken_fan"].includes(definition.id)) configuredCooldown -= 3_000;
    if (runtime.equippedPassives.has("ninja_v2_elusive") &&
      ["ninja_v2_smoke_bomb", "ninja_v2_shadowstep"].includes(definition.id)) configuredCooldown -= 3_000;
    const cooldownEnd = this.now() + configuredCooldown;
    if (this.isResetAbility(definition.id)) {
      runtime.cooldownEndsAt[BASIC_ATTACK_RESET_COOLDOWN_GROUP] = cooldownEnd;
      for (const resetId of RESET_ACTIVE_IDS) runtime.cooldownEndsAt[resetId] = cooldownEnd;
    } else {
      runtime.cooldownEndsAt[definition.id] = cooldownEnd;
    }
    runtime.counters.abilityActivationLockoutEndsAt = this.now() + PVE_TURN_STEP_MS;
    if (definition.id === "warrior_empowered_hit" || definition.id === "warrior_anger_explosion") {
      const requested = definition.id === "warrior_empowered_hit"
        ? WARRIOR_BALANCE.empoweredHitHealthCost
        : WARRIOR_BALANCE.angerExplosionHealthCost;
      attacker.currentHealth -= Math.min(Math.max(0, attacker.currentHealth - 1), requested);
      this.markDirty(attacker);
      this.rememberProfile(attacker);
    }
    this.markDirty(attacker);
    this.rememberClassRuntime(attacker);
    this.emitClassAbilityActivatedEvent(attacker, definition, presentation);
  }

  private resolveAbility(
    attacker: Combatant,
    target: Combatant,
    definition: TechniqueDefinition,
    options: { activationCommitted?: boolean; targetPosition?: LatLon; repositionAccepted?: boolean;
      scheduledArmed?: boolean; sourceActionSequence?: number; attackContext?: AttackResolutionContext } = {}
  ): void {
    const runtime = requireClassCombatRuntime(attacker);
    if (
      target.kind === "player"
      && isHealthOnlyTechnique(definition)
      && definition.activation !== "drag"
      && (
        target.entityId === attacker.entityId
        || this.options.partyAuthority?.sameParty(attacker.entityId, target.entityId) === true
      )
      && target.currentHealth >= target.maxHealth
    ) {
      throw new CombatRequestError("ABILITY_TARGET_FULL_HEALTH", "Full HP");
    }
    if (!options.scheduledArmed) {
      if (
        definition.classId === "ninja"
        && !isSupportTechnique(definition)
        && this.techniqueTargetType(definition) !== "self"
      ) this.breakNinjaInvisible(attacker);
      this.beginPlayerAction(attacker);
    }
    const activeSession = this.pveSessions.get(attacker.entityId);
    const reset = this.isResetAbility(definition.id);
    if (!options.activationCommitted) {
      this.commitAbilityActivation(attacker, definition, {
        target,
        ...(options.targetPosition === undefined
          ? {}
          : { targetPosition: options.targetPosition })
      });
    }

    if (definition.id.includes("_v2_")) {
      this.resolveClassSystemV2Ability(attacker, target, definition, options.targetPosition, options.repositionAccepted,
        options.scheduledArmed === true, options.sourceActionSequence, options.attackContext);
      if (isSupportTechnique(definition)) {
        const supportUsedAt = this.now();
        runtime.lastCombatAtMs = supportUsedAt;
        attacker.aggressiveUntilMs = Math.max(
          attacker.aggressiveUntilMs,
          supportUsedAt + this.v3AggressionDurationMs(attacker)
        );
      }
      this.markDirty(attacker);
      this.rememberClassRuntime(attacker);
      return;
    }

    if (this.resolveSupportAbility(attacker, target, definition)) {
      if (attacker.kind === "player" && isSupportTechnique(definition)) {
        const supportUsedAt = this.now();
        runtime.lastCombatAtMs = supportUsedAt;
        attacker.aggressiveUntilMs = Math.max(
          attacker.aggressiveUntilMs,
          supportUsedAt + this.v3AggressionDurationMs(attacker)
        );
      }
      this.markDirty(attacker);
      this.rememberClassRuntime(attacker);
      const supportSession = this.pveSessions.get(attacker.entityId);
      supportSession?.telemetry.recordPlayerAction({
        action: reset ? "reset_strike" : "normal_active",
        abilityId: definition.id,
        atMs: this.telemetryTime(supportSession),
        damage: 0
      });
      return;
    }

    let targets = [target];
    if (definition.id === "warrior_anger_explosion") {
      const session = this.pveSessions.get(attacker.entityId);
      const candidateIds = [...new Set([
        ...(session?.focusTargetEntityId ? [session.focusTargetEntityId] : []),
        ...(session?.enemyQueue ?? []),
        ...this.grid.query(attacker.position, WARRIOR_BALANCE.angerExplosionRadiusM)
      ])];
      const enemies = candidateIds
        .map((enemyId) => this.entities.get(enemyId))
        .filter((candidate): candidate is Combatant => Boolean(
          candidate && candidate.kind === "mob" && candidate.lifeState === "alive" &&
          this.isAttackPairValid(attacker, candidate) &&
          distanceMeters(attacker.position, candidate.position) <= WARRIOR_BALANCE.angerExplosionRadiusM
        ));
      targets = enemies;
    }
    if (definition.id === "hunter_sweep") {
      const session = this.pveSessions.get(attacker.entityId);
      const maximum = runtime.weaponMode === "ranged"
        ? HUNTER_BALANCE.sweepRangedMaximumSecondaryTargets
        : HUNTER_BALANCE.sweepMeleeMaximumSecondaryTargets;
      const secondary = (session?.enemyQueue ?? [])
        .filter((enemyId) => enemyId !== target.entityId && this.isEnemyValidForSession(session!, enemyId))
        .map((enemyId) => this.entities.get(enemyId))
        .filter((candidate): candidate is Combatant => Boolean(
          candidate && this.grid.query(attacker.position, attacker.attackRangeM).includes(candidate.entityId)
        ))
        .slice(0, maximum);
      targets = [target, ...secondary];
      const metric = runtime.weaponMode === "ranged" ? "hunterSweepRangedUses" : "hunterSweepMeleeUses";
      runtime.counters[metric] = Number(runtime.counters[metric] ?? 0) + 1;
      session?.telemetry.recordClassMetric(
        runtime.weaponMode === "ranged" ? "hunter_sweep_ranged_uses" : "hunter_sweep_melee_uses"
      );
    }
    if (definition.id === "druid_thorn_burst") {
      targets = this.grid.query(attacker.position, 100)
        .map((entityId) => this.entities.get(entityId))
        .filter((candidate): candidate is Combatant => Boolean(candidate && candidate.kind === "mob" &&
          candidate.lifeState === "alive" && this.isAttackPairValid(attacker, candidate) &&
          distanceMeters(attacker.position, candidate.position) <= 100));
    }
    if (attacker.kind === "player") this.aggroAbilityTargets(attacker, targets);
    const bleedingBefore = new Map(targets.map((candidate) => [candidate.entityId, this.hasQueueBleed(candidate)]));
    const basicTypeMultiplier = runtime.activeClassId === "hunter"
      ? this.hunterDirectMultiplier(
          attacker,
          target,
          reset,
          (definition.damageMultiplier ?? 0) > 0 && definition.id !== "hunter_marked_strike"
        )
      : reset ? this.basicOrResetMultiplier(attacker, target) : 1;
    let hitCount = 0;
    let totalDamage = 0;
    let primaryDamageBeforePowerScaling = 0;
    for (let index = 0; index < targets.length; index += 1) {
      const candidate = targets[index]!;
      if (candidate.lifeState !== "alive") continue;
      let configuredMultiplier = definition.damageMultiplier ?? 0;
      if (definition.id === "warrior_anger_explosion") configuredMultiplier = WARRIOR_BALANCE.angerExplosionMultiplier;
      if (
        definition.id === "warrior_executioners_strike" &&
        candidate.currentHealth / candidate.maxHealth < WARRIOR_BALANCE.executionThreshold
      ) {
        configuredMultiplier = WARRIOR_BALANCE.executionDamageMultiplier;
      }
      if (
        definition.id === "hunter_cull" &&
        candidate.currentHealth / candidate.maxHealth < HUNTER_BALANCE.cullThreshold
      ) configuredMultiplier = HUNTER_BALANCE.cullDamageMultiplier;
      if (
        definition.id === "sharpshooter_deadeye_shot" &&
        distanceMeters(attacker.position, candidate.position) >= HUNTER_BALANCE.deadeyeLongRangeM
      ) {
        configuredMultiplier = HUNTER_BALANCE.deadeyeLongRangeMultiplier;
        runtime.counters.deadeyeLongRangeHits = Number(runtime.counters.deadeyeLongRangeHits ?? 0) + 1;
        this.pveSessions.get(attacker.entityId)?.telemetry.recordClassMetric("deadeye_long_range_hits");
      }
      let multiplier = configuredMultiplier * basicTypeMultiplier;
      if (index > 0 && definition.id === "hunter_sweep") {
        multiplier = configuredMultiplier * this.hunterDirectMultiplier(attacker, candidate, false, true) *
          (runtime.weaponMode === "ranged"
            ? HUNTER_BALANCE.sweepRangedSecondaryMultiplier
            : HUNTER_BALANCE.sweepMeleeSecondaryMultiplier);
      }
      if (multiplier > 0) {
        const damageBeforeMultiplier = Math.max(
          1,
          attacker.attackDamage + this.warriorFlatAttackBonus(attacker, false, candidate, definition.id)
        );
        const pveRaw = Math.max(1, Math.round(damageBeforeMultiplier * multiplier));
        const damageResolution = this.resolveContextDamage(attacker, candidate, {
          pveDamage: pveRaw,
          pveDamageBeforeMultiplier: damageBeforeMultiplier,
          pveDamageMultiplier: multiplier,
          pvpDamageBeforePowerScaling: damageBeforeMultiplier,
          pvpDamageMultiplier: multiplier,
          pvpUseEquipmentMatrix: true
        });
        if (candidate.entityId === target.entityId) {
          primaryDamageBeforePowerScaling = damageResolution.damageBeforePowerScaling;
        }
        const applied = this.applyDamage(
          attacker,
          candidate,
          damageResolution.finalDamage,
          definition.id,
          true,
          {},
          attacker.kind === "player" && candidate.kind === "player"
            ? 0
            : this.effectiveDefense(candidate)
        );
        totalDamage += applied;
        if (definition.id === "ranger_rapid_shot" && candidate.lifeState === "alive") {
          const second = this.applyDamage(
            attacker, candidate, damageResolution.finalDamage, definition.id, true, {},
            attacker.kind === "player" && candidate.kind === "player" ? 0 : this.effectiveDefense(candidate)
          );
          totalDamage += second;
          hitCount += 1;
        }
        activeSession?.telemetry.recordPowerResolution({
          damageBeforePowerScaling: damageResolution.damageBeforePowerScaling,
          powerMultiplier: damageResolution.powerMultiplier,
          finalPowerScaledDamage: damageResolution.finalDamage,
          resolvedTick: this.currentTick
        });
        this.applyEquipmentProcResolution(
          attacker,
          candidate,
          this.resolveEquipmentProc(attacker, candidate, applied, true)
        );
        this.consumePlayerActionDefenseReduction(candidate);
        hitCount += 1;
      }
    }

    if (definition.id === "warrior_sundering_strike" && target.lifeState === "alive") {
      this.applyPlayerActionDefenseReduction(attacker, target, definition.id);
    }
    if (definition.id === "warrior_concussive_blow" && target.kind === "mob" && target.lifeState === "alive") {
      this.applyConcussed(attacker, target);
    }
    if (definition.id === "druid_nature_bolt" && target.lifeState === "alive") {
      this.addTimedEffect(attacker, target, "rooted", definition.id, 2_000, 1);
    }
    if (definition.id === "ranger_crippling_shot" && target.lifeState === "alive") {
      this.addTimedEffect(attacker, target, "movement_slow", definition.id, 5_000, 0.6);
      if (runtime.equippedPassives.has("ranger_skirmisher")) {
        this.addTimedEffect(attacker, attacker, "out_of_combat_movement", definition.id, 5_000, 0.2);
      }
    }
    if (definition.id === "ranger_hunters_mark" && target.lifeState === "alive") {
      this.addTimedEffect(attacker, attacker, "outgoing_damage", definition.id, 10_000,
        runtime.equippedPassives.has("ranger_deadeye") ? 0.15 : 0.10, [target.entityId]);
    }
    if (definition.id === "reaver_bloodletting_strike") {
      if (bleedingBefore.get(target.entityId)) {
        const heal = Math.max(1, Math.round(attacker.maxHealth * WARRIOR_BALANCE.bloodlettingAlreadyBleedingHeal));
        const received = this.commitNormalHealing(
          attacker.entityId,
          attacker,
          Math.max(0, Math.round(heal))
        ).effective;
        this.pveSessions.get(attacker.entityId)?.telemetry.recordReaverHealing(
          received
        );
      }
      if (target.lifeState === "alive") this.applyQueueBleed(attacker, target, definition.id);
    }
    if (definition.id === "warden_guardians_reprisal") {
      this.addGuard(attacker, WARRIOR_BALANCE.guardReprisal);
      runtime.counters.reprisalReady = true;
    }
    if (definition.id === "hunter_marked_strike" && target.lifeState === "alive") {
      this.applyMarkedQuarry(attacker, target);
    }
    if (definition.id === "hunter_snare_trap" && target.lifeState === "alive") {
      this.applyHunterSnare(attacker, target);
    }
    if (definition.id === "stalker_rending_strike" && target.lifeState === "alive" && totalDamage > 0) {
      this.applyHunterBleed(
        attacker,
        target,
        definition.id,
        totalDamage,
        primaryDamageBeforePowerScaling
      );
    }
    if (reset && hitCount > 0 && runtime.activeClassId === "hunter") {
      const keen = runtime.equippedPassives.has("hunter_keen_focus") ? HUNTER_BALANCE.focus.keenFocusBonus : 0;
      const bloodScent = runtime.subclassId === "stalker" && bleedingBefore.get(target.entityId)
        ? HUNTER_BALANCE.focus.bloodScentBonus
        : 0;
      this.addRage(attacker, HUNTER_BALANCE.focus.basicOrReset + keen, "attack");
      if (bloodScent > 0) this.addRage(attacker, bloodScent, "blood_scent");
      if (definition.id === "hunter_predators_strike") {
        this.addRage(attacker, HUNTER_BALANCE.focus.predatorBonus, "predator");
      }
      this.advanceSteadyHand(attacker, target);
    }
    this.markDirty(attacker);
    this.rememberClassRuntime(attacker);
    const session = this.pveSessions.get(attacker.entityId);
    session?.telemetry.recordPlayerAction({
      action: reset ? "reset_strike" : "normal_active",
      abilityId: definition.id,
      atMs: this.telemetryTime(session),
      damage: totalDamage
    });
  }

  private resolveClassSystemV2Ability(
    source: Combatant,
    target: Combatant,
    definition: TechniqueDefinition,
    targetPosition?: LatLon,
    repositionAccepted?: boolean,
    scheduledArmed = false,
    sourceActionSequence?: number,
    sharedAttackContext?: AttackResolutionContext
  ): void {
    void scheduledArmed;
    const runtime = requireClassCombatRuntime(source);
    const id = definition.id;
    const armed = definition.activation === "armed";
    const damage = (recipient: Combatant, amount: number, procEligible = true,
      attackContext?: AttackResolutionContext) => {
      const shurikenBonus = id.startsWith("ninja_v2_")
        ? (runtime.equippedPassives.has("ninja_v2_razor_edge") ? 1 : 0) +
          (runtime.equippedPassives.has("ninja_v2_flow_state") &&
            distanceMeters(source.position, recipient.position) <= 100 ? 2 : 0)
        : 0;
      const context = attackContext ?? sharedAttackContext;
      const appliedDamage = this.applyDamage(
        source, recipient, amount + shurikenBonus, id, procEligible, {},
        source.kind === "player" && recipient.kind === "player" ? 0 : this.effectiveDefense(recipient),
        procEligible, undefined, context
      );
      return { appliedDamage, damageEvent: context?.damageEvent };
    };
    const damagePackets = (recipient: Combatant, amount: number, count: number) => {
      const attackContext: AttackResolutionContext = sharedAttackContext ?? {};
      for (let index = 0; index < count && recipient.lifeState === "alive"; index += 1) {
        delete attackContext.damageEvent;
        const { damageEvent: event } = damage(recipient, amount, index === 0, attackContext);
        if (event?.type === "DAMAGE") {
          event.packetIndex = index + 1;
          event.packetCount = count;
          event.presentationDelayMs = index * 100;
        }
        if (attackContext.suppressed) break;
        const resolvedRecipient = this.entities.get(
          attackContext.resolvedTargetEntityId ?? recipient.entityId
        );
        if (!resolvedRecipient || resolvedRecipient.lifeState !== "alive") break;
      }
    };
    const enemiesNear = (position: LatLon, radiusM: number) => this.nearbyEntityIds(position, radiusM)
      .map((entityId) => this.entities.get(entityId))
      .filter((candidate): candidate is Combatant => Boolean(
        candidate && candidate.entityId !== source.entityId && candidate.lifeState === "alive" &&
        this.isAttackPairValid(source, candidate)
      ))
      .sort((left, right) =>
        distanceMeters(position, left.position) - distanceMeters(position, right.position) ||
        left.entityId.localeCompare(right.entityId)
      );
    const setWindow = (key: string, durationMs: number, value: number | string | boolean = true) => {
      runtime.counters[key] = value;
      runtime.counters[`${key}EndsAt`] = this.now() + durationMs;
    };

    switch (id) {
      case "warrior_v2_sundering_arc":
        for (const enemy of enemiesNear(target.position, definition.targetRadiusM ?? 40).filter((enemy) => enemy.entityId !== target.entityId).slice(0, 3)) damage(enemy, 4);
        break;
      case "warrior_v2_iron_reversal": setWindow("v2IronReversal", 3_000); break;
      case "warrior_v2_faultline":
        if (!targetPosition || !repositionAccepted) {
          throw new CombatRequestError("ABILITY_POSITION_REJECTED", "That Blood Rush destination is not traversable");
        }
        this.grid.update(source.entityId, targetPosition);
        source.position = { ...targetPosition };
        runtime.counters.v2BloodRushTarget = target.entityId;
        runtime.counters.v2BloodRushEndsAt = this.now() + 5_000;
        this.resolveBasicAttack(source, target, true);
        break;
      case "warrior_v2_rallying_roar":
        this.addTimedEffect(source, source, "flat_defense", id, 10_000, 2);
        for (const ally of this.validVisibleAllies(source, definition.targetRadiusM ?? FRIENDLY_TARGET_RANGE_M)) {
          this.addTimedEffect(source, ally, "flat_defense", id, 10_000, 2);
        }
        break;
      case "warrior_v2_worldbreaker":
        for (const enemy of enemiesNear(source.position, definition.targetRadiusM ?? 120)) {
          damage(enemy, 12);
          this.addTimedEffect(source, enemy, "movement_slow", id, 4_000, 0.6);
        }
        break;
      case "ranger_v2_throughshot":
        { const primaryDistance = distanceMeters(source.position, target.position);
          const continuationM = definition.targetRadiusM ?? 50;
          const lateralToleranceM = 25;
          const behind = enemiesNear(source.position, primaryDistance + continuationM)
            .filter((enemy) => enemy.entityId !== target.entityId)
            .filter((enemy) => this.isBeyondTargetRay(source.position, target.position, enemy.position, lateralToleranceM, continuationM))[0];
          if (behind) damage(behind, 5); }
        break;
      case "ranger_v2_threefold_volley":
        if (!targetPosition || !repositionAccepted) {
          throw new CombatRequestError("ABILITY_POSITION_REJECTED", "That Retreat Volley destination is not traversable");
        }
        this.grid.update(source.entityId, targetPosition);
        source.position = { ...targetPosition };
        this.resolveBasicAttack(source, target, true);
        break;
      case "ranger_v2_marked_quarry":
        this.addTimedEffect(source, target, "defense_reduction", id, 12_000, 2);
        break;
      case "ranger_v2_snare_shot":
        this.applyV2Zone(source, id, targetPosition!, 30_000, 1_000,
          runtime.equippedPassives.has("ranger_v2_keep_your_distance") ? 8 : 4,
          "trap", sourceActionSequence);
        break;
      case "ranger_v2_black_rain":
        // One beat per tick. The old 6 one-second ticks of 5 (30) become 4 beat ticks of 7.5 (7, 8, 7, 8 with carry).
        this.applyV2Zone(source, id, targetPosition!, 6_000, BASIC_ATTACK_INTERVAL_MS,
          5 * Math.floor(6_000 / 1_000) / Math.floor(6_000 / BASIC_ATTACK_INTERVAL_MS), "hostile", sourceActionSequence);
        break;
      case "ninja_v2_twin_fang": damagePackets(target, 3, 3); break;
      case "ninja_v2_smoke_bomb":
        setWindow("v2Substitution", 3_000);
        break;
      case "ninja_v2_shadowstep":
        if (!targetPosition || !repositionAccepted) {
          throw new CombatRequestError("ABILITY_POSITION_REJECTED", "That Shadowstep destination is not traversable");
        }
        this.grid.update(source.entityId, targetPosition);
        source.position = { ...targetPosition };
        source.classRuntime!.effects = source.classRuntime!.effects.filter((effect) => effect.kind !== "movement_slow" && effect.kind !== "rooted");
        break;
      case "ninja_v2_shuriken_fan":
        for (const enemy of enemiesNear(source.position, definition.targetRadiusM ?? source.attackRangeM)
          .filter((enemy) => this.isInForwardCone(source.position, target.position, enemy.position, 35))
          .slice(0, 4)) damage(enemy, 4);
        break;
      case "ninja_v2_thousand_shadows":
        damagePackets(target, 4, 6);
        break;
    }
    if (definition.kind === "normal" && !armed) this.onV2RegularCast(source, definition);
  }

  private onV2RegularCast(source: Combatant, definition: TechniqueDefinition): void {
    requireClassCombatRuntime(source);
    void definition;
    this.rememberClassRuntime(source);
  }

  private launchClassAttackRange(runtime: ClassCombatRuntime, state?: PlayerEquipmentCombatState): number {
    const base = state
      ? state.activeWeaponSlot === "secondary" ? RANGED_ATTACK_RANGE_M : MELEE_ATTACK_RANGE_M
      : runtime.weaponMode === "ranged" ? RANGED_ATTACK_RANGE_M : MELEE_ATTACK_RANGE_M;
    if (runtime.skillV3) {
      const family = equipmentGameplayFamily(runtime.weaponDefinitionId) ?? runtime.weaponCategory;
      const rangedFamily = family === "bow" || family === "longbow" || family === "crossbow";
      const archeryRank = runtime.skillV3.generalSkillRanks.archery ?? 0;
      const generalBonus = rangedFamily ? archeryRank >= 3 ? 45 : archeryRank >= 2 ? 22 : 0 : 0;
      const rangerRank = runtime.skillV3.activeSpecializationId === "ranger" &&
        (family === "bow" || family === "longbow")
          ? runtime.skillV3.specializationRank
          : 0;
      return base + generalBonus + (rangerRank >= 4 ? 40 : rangerRank >= 2 ? 20 : 0);
    }
    if (runtime.activeClassId !== "ranger" || equipmentGameplayFamily(runtime.weaponDefinitionId) !== "bow") return base;
    const rank = automaticRank(runtime.masteryRank, [5, 9, 13]);
    const masteryBonus = CLASS_MASTERY_RANGE_BONUS_M_BY_RANK[rank] ?? 55;
    return base + masteryBonus + (runtime.equippedPassives.has("ranger_v2_broadheads") ? 50 : 0);
  }

  private resolveV2ScheduledAttackPassives(
    attacker: Combatant,
    target: Combatant,
    appliedDamage: number,
    attackContext: AttackResolutionContext
  ): void {
    const runtime = requireClassCombatRuntime(attacker);
    const now = this.now();
    const bow = equipmentGameplayFamily(runtime.weaponDefinitionId) === "bow";
    const shuriken = runtime.weaponCategory === "shuriken";
    if (appliedDamage <= 0) return;
    if (bow && runtime.equippedPassives.has("ranger_v2_quick_draw")) {
      const other = this.nearbyEntityIds(target.position, 150).some((id) => {
        const entity = this.entities.get(id);
        return Boolean(entity && entity.entityId !== target.entityId && entity.lifeState === "alive" && this.isAttackPairValid(attacker, entity));
      });
      if (!other) this.applyDamage(attacker, target, 2, "ranger_v2_quick_draw", false, {}, 0, false, undefined, attackContext);
    }
    if (bow && runtime.equippedPassives.has("ranger_v2_deadeye") && distanceMeters(attacker.position, target.position) >= 200) {
      this.applyDamage(attacker, target, 3, "ranger_v2_deadeye", false, {}, 0, false, undefined, attackContext);
    }
    if (shuriken && runtime.equippedPassives.has("ninja_v2_razor_edge")) {
      this.applyDamage(attacker, target, 1, "ninja_v2_razor_edge", false, {}, 0, false, undefined, attackContext);
    }
    if (shuriken && runtime.equippedPassives.has("ninja_v2_flow_state") && distanceMeters(attacker.position, target.position) <= 100) {
      this.applyDamage(attacker, target, 2, "ninja_v2_flow_state", false, {}, 0, false, undefined, attackContext);
    }
    if (runtime.weaponCategory === "axe" && Number(runtime.counters.v2IronReversalBonusEndsAt ?? 0) >= now) {
      this.applyDamage(attacker, target, 4, "warrior_v2_iron_reversal", false, {}, 0, false, undefined, attackContext);
      delete runtime.counters.v2IronReversalBonus;
      delete runtime.counters.v2IronReversalBonusEndsAt;
    }
  }

  private reduceRegularCooldowns(runtime: ClassCombatRuntime, milliseconds: number): void {
    const now = this.now();
    for (const id of runtime.equippedActives) {
      const definition = requireTechniqueDefinition(id);
      if (definition.kind === "normal") runtime.cooldownEndsAt[id] = Math.max(now, (runtime.cooldownEndsAt[id] ?? now) - milliseconds);
    }
  }

  private isBossMob(entity: Combatant): boolean {
    return entity.kind === "mob" && (
      (entity.archetypeKey !== null && requireMobDefinition(entity.archetypeKey).boss === true)
    );
  }

  private isHostileV2Activation(definition: TechniqueDefinition): boolean {
    return definition.activation === "armed" || this.techniqueTargetType(definition) === "hostile" || [
      "warrior_v2_faultline", "warrior_v2_worldbreaker",
      "ranger_v2_snare_shot", "ranger_v2_black_rain"
    ].includes(definition.id);
  }

  private isPassiveGeneratedTechnique(sourceTechniqueId: string): boolean {
    try {
      return requireTechniqueDefinition(sourceTechniqueId).kind === "passive";
    } catch {
      return false;
    }
  }

  private isInsideOwnedV2Zone(player: Combatant, abilityId: string): boolean {
    const zone = this.classAbilityZones.get(`${player.entityId}:${abilityId}`);
    return Boolean(zone && zone.endTick >= this.currentTick && distanceMeters(player.position, zone.position) <= zone.radiusM);
  }

  private isMeleeBasicAttacker(attacker: Combatant): boolean {
    if (attacker.kind === "mob") return attacker.attackRangeM <= MELEE_ATTACK_RANGE_M;
    return !["bow", "crossbow", "shuriken", "wand", "staff"].includes(attacker.classRuntime?.weaponCategory ?? "");
  }

  private isInDirectionalSegment(
    source: LatLon, endpoint: LatLon, candidate: LatLon, minimumHalfWidthM: number, widthRatio: number
  ): boolean {
    const length = distanceMeters(source, endpoint);
    if (length <= 0) return false;
    const distance = distanceMeters(source, candidate);
    const angle = bearingDifferenceRadians(initialBearingDegrees(source, endpoint), initialBearingDegrees(source, candidate));
    const along = distance * Math.cos(angle);
    const lateral = Math.abs(distance * Math.sin(angle));
    return along > 0 && along <= length && lateral <= Math.max(minimumHalfWidthM, along * widthRatio);
  }

  private isBeyondTargetRay(
    source: LatLon, primary: LatLon, candidate: LatLon, lateralToleranceM: number, maximumBeyondM: number
  ): boolean {
    const primaryDistance = distanceMeters(source, primary);
    const candidateDistance = distanceMeters(source, candidate);
    if (candidateDistance <= primaryDistance || candidateDistance > primaryDistance + maximumBeyondM) return false;
    const angle = bearingDifferenceRadians(initialBearingDegrees(source, primary), initialBearingDegrees(source, candidate));
    return candidateDistance * Math.cos(angle) > primaryDistance && Math.abs(candidateDistance * Math.sin(angle)) <= lateralToleranceM;
  }

  private isInForwardCone(source: LatLon, primary: LatLon, candidate: LatLon, halfAngleDegrees: number): boolean {
    return Math.abs(bearingDifferenceRadians(initialBearingDegrees(source, primary), initialBearingDegrees(source, candidate)))
      <= halfAngleDegrees * Math.PI / 180;
  }

  private setScheduledBonus(target: Combatant, sourceId: string, charges: number, amount: number, durationMs: number,
    sourceEntityId = target.entityId): void {
    const runtime = target.classRuntime ?? (target.classRuntime = emptyRuntime());
    runtime.effects = runtime.effects.filter((effect) => effect.sourceTechniqueId !== sourceId);
    runtime.effects.push({
      id: `${target.entityId}:${sourceId}`, kind: "flat_attack", sourceTechniqueId: sourceId,
      sourceEntityId, startTick: this.currentTick,
      endTick: this.currentTick + millisecondsToTicks(durationMs, this.options.tickRateHz),
      nextTick: Number.MAX_SAFE_INTEGER, stacks: charges, maximumStacks: charges, amount
    });
    this.markDirty(target);
  }

  private applyV2Ward(source: Combatant, target: Combatant, sourceId: string, amount: number, durationMs: number,
    sourceActionSequence?: number): void {
    void sourceActionSequence;
    const runtime = target.classRuntime ?? (target.classRuntime = emptyRuntime());
    const id = `${source.entityId}:${sourceId}:ward`;
    const existing = runtime.effects.find((effect) => effect.id === id);
    if (existing) {
      existing.amount = amount;
      existing.endTick = this.currentTick + millisecondsToTicks(durationMs, this.options.tickRateHz);
      existing.sourceEntityId = source.entityId;
    } else {
      runtime.effects.push({ id, kind: "healing_shield", sourceTechniqueId: sourceId, sourceEntityId: source.entityId,
        startTick: this.currentTick, endTick: this.currentTick + millisecondsToTicks(durationMs, this.options.tickRateHz),
        nextTick: Number.MAX_SAFE_INTEGER, stacks: 1, maximumStacks: 1, amount });
    }
    this.markDirty(target);
  }

  private isTargetedAttack(sourceTechniqueId: string): boolean {
    if (sourceTechniqueId.endsWith("_basic_attack")) return true;
    try {
      const definition = requireTechniqueDefinition(sourceTechniqueId);
      return definition.kind !== "passive" && this.techniqueTargetType(definition) === "hostile" && definition.targetRadiusM === undefined &&
        definition.activation !== "drag";
    } catch {
      return false;
    }
  }

  private isTargetedBasicOrWeaponAttack(sourceTechniqueId: string, targetedAttack: boolean): boolean {
    if (!targetedAttack) return false;
    if (sourceTechniqueId.endsWith("_basic_attack")) return true;
    try {
      return (requireTechniqueDefinition(sourceTechniqueId).allowedWeaponCategories?.length ?? 0) > 0;
    } catch {
      return false;
    }
  }

  private applyV2Zone(
    source: Combatant, sourceId: string, position: LatLon, durationMs: number,
    intervalMs: number, amount: number, kind: "smoke" | "hostile" | "banner" | "trap",
    sourceActionSequence = this.playerActionSequence(source)
  ): void {
    const zoneId = `${source.entityId}:${sourceId}`;
    const intervalTicks = millisecondsToTicks(intervalMs, this.options.tickRateHz);
    const zone = {
      id: zoneId, sourceEntityId: source.entityId, abilityId: sourceId, position: { ...position },
      radiusM: requireTechniqueDefinition(sourceId).targetRadiusM ?? 100,
      endTick: this.currentTick + millisecondsToTicks(durationMs, this.options.tickRateHz),
      nextTick: this.currentTick + intervalTicks, intervalTicks, amount, kind,
      sourceActionSequence,
      enteredEntityIds: new Set<string>(), hitCounts: new Map<string, number>(), carry: new Map<string, number>()
    };
    this.classAbilityZones.set(zoneId, zone);
    this.emitClassAbilityZoneEvent("CLASS_ABILITY_ZONE_STARTED", zone, durationMs);
    this.processClassAbilityZone(zone, true);
  }

  private processClassAbilityZones(): void {
    for (const zone of [...this.classAbilityZones.values()].sort((a, b) => a.id.localeCompare(b.id))) {
      if (this.isPlayerReserved(zone.sourceEntityId)) continue;
      const source = this.entities.get(zone.sourceEntityId);
      if (!source || source.lifeState !== "alive" || this.currentTick > zone.endTick) {
        this.removeBannerDefense(zone);
        this.classAbilityZones.delete(zone.id);
        this.emitClassAbilityZoneEvent("CLASS_ABILITY_ZONE_ENDED", zone);
        continue;
      }
      this.processClassAbilityZone(zone, false);
    }
  }

  private processClassAbilityZone(
    zone: (typeof this.classAbilityZones extends Map<string, infer Zone> ? Zone : never),
    spawning: boolean
  ): void {
    const source = this.entities.get(zone.sourceEntityId);
    if (!source) return;
    const ids = this.nearbyEntityIds(zone.position, zone.radiusM);
    const occupants = ids.map((id) => this.entities.get(id)).filter((entity): entity is Combatant => Boolean(entity?.lifeState === "alive"));
    if (zone.kind === "smoke") return;
    if (zone.kind === "trap") {
      const enemy = occupants.filter((entity) => this.isAttackPairValid(source, entity))
        .sort((left, right) => left.entityId.localeCompare(right.entityId))[0];
      if (enemy) {
        this.applyDamage(source, enemy, zone.amount, zone.abilityId, false);
        this.addTimedEffect(source, enemy, "movement_slow", zone.abilityId, 4_000, 0.6);
        this.classAbilityZones.delete(zone.id);
        this.emitClassAbilityZoneEvent("CLASS_ABILITY_ZONE_ENDED", zone);
      }
      return;
    }
    if (zone.kind === "banner") {
      const allies = occupants.filter((entity) => entity.kind === "player" && this.isValidVisibleAlly(source, entity));
      const allyIds = new Set(allies.map((ally) => ally.entityId));
      for (const entity of this.entities.values()) {
        if (allyIds.has(entity.entityId) || !entity.classRuntime) continue;
        entity.classRuntime.effects = entity.classRuntime.effects.filter((effect) =>
          !(effect.kind === "flat_defense" && effect.sourceEntityId === source.entityId && effect.sourceTechniqueId === zone.abilityId)
        );
      }
      for (const ally of allies) {
        if (!zone.enteredEntityIds.has(ally.entityId)) {
          zone.enteredEntityIds.add(ally.entityId);
          this.applyV2Ward(source, ally, zone.abilityId, 5,
            Math.max(1, (zone.endTick - this.currentTick) * 1_000 / this.options.tickRateHz), zone.sourceActionSequence);
        }
        this.addTimedEffect(source, ally, "flat_defense", zone.abilityId, 1_500, 2);
      }
      return;
    }
    if (!spawning && this.currentTick >= zone.nextTick) {
      for (const enemy of occupants.filter((entity) => this.isAttackPairValid(source, entity))) {
        let amount = zone.amount;
        if (zone.kind === "hostile") {
          const owed = zone.amount + (zone.carry.get(enemy.entityId) ?? 0);
          amount = Math.floor(owed + 1e-9);
          zone.carry.set(enemy.entityId, Math.max(0, owed - amount));
        }
        if (amount > 0) this.applyDamage(source, enemy, amount, zone.abilityId, false);
        const hits = (zone.hitCounts.get(enemy.entityId) ?? 0) + 1;
        zone.hitCounts.set(enemy.entityId, hits);
        if (zone.abilityId === "ranger_v2_black_rain") {
          this.addTimedEffect(source, enemy, "movement_slow", zone.abilityId, 1_500, 0.6);
        }
      }
      zone.nextTick += zone.intervalTicks;
    }
  }

  private removeBannerDefense(zone: { sourceEntityId: string; abilityId: string; kind: string }): void {
    if (zone.kind !== "banner") return;
    for (const entity of this.entities.values()) {
      if (!entity.classRuntime) continue;
      entity.classRuntime.effects = entity.classRuntime.effects.filter((effect) =>
        !(effect.kind === "flat_defense" && effect.sourceEntityId === zone.sourceEntityId && effect.sourceTechniqueId === zone.abilityId)
      );
    }
  }

  private emitClassAbilityZoneEvent(
    type: "CLASS_ABILITY_ZONE_STARTED" | "CLASS_ABILITY_ZONE_ENDED",
    zone: { id: string; sourceEntityId: string; abilityId: string; position: LatLon; radiusM: number },
    durationMs?: number
  ): void {
    this.metrics.combatEventsEmitted += 1;
    this.pendingEvents.push({ eventId: zone.id, type, tick: this.currentTick,
      sourceEntityId: zone.sourceEntityId, targetEntityId: null, position: { ...zone.position },
      radiusM: zone.radiusM, abilityId: zone.abilityId,
      ...(durationMs === undefined ? {} : { durationMs }) });
  }

  private resolveSupportAbility(
    attacker: Combatant,
    target: Combatant,
    definition: TechniqueDefinition
  ): boolean {
    const runtime = requireClassCombatRuntime(attacker);
    if (definition.id === "warrior_empowered_hit") {
      runtime.counters.warriorEmpoweredHitArmed = true;
      return true;
    }
    if (definition.id === "warrior_battle_cry") {
      for (const recipient of [
        attacker,
        ...this.validVisibleAllies(attacker, WARRIOR_BALANCE.battleCryRadiusM)
      ]) {
        const recipientRuntime = recipient.classRuntime ?? (recipient.classRuntime = emptyRuntime());
        recipientRuntime.effects = recipientRuntime.effects.filter(
          (effect) => effect.sourceTechniqueId !== "warrior_battle_cry"
        );
        const durationTicks = Math.ceil(
          WARRIOR_BALANCE.battleCryDurationMs * this.options.tickRateHz / 1_000
        );
        recipientRuntime.effects.push({
          id: `${recipient.entityId}:warrior_battle_cry`,
          kind: "outgoing_damage",
          sourceTechniqueId: "warrior_battle_cry",
          sourceEntityId: attacker.entityId,
          sourceClassId: "warrior",
          sourceSubclassId: runtime.subclassId,
          startTick: this.currentTick,
          endTick: this.currentTick + durationTicks,
          nextTick: Number.MAX_SAFE_INTEGER,
          stacks: 1,
          maximumStacks: 1,
          amount: WARRIOR_BALANCE.battleCryDamageMultiplier - 1,
          cleansable: false,
          minor: false
        });
        this.markDirty(recipient);
        if (recipient.kind === "player") this.rememberClassRuntime(recipient);
      }
      return true;
    }
    if (definition.id === "druid_rejuvenation" || definition.id === "druid_regrowth") {
      const low = target.currentHealth / target.maxHealth < 0.35;
      const castBonus = (runtime.equippedPassives.has("druid_gentle_touch") ? 2 : 0) +
        (low && runtime.equippedPassives.has("druid_flourish") ? 5 : 0);
      if (definition.id === "druid_regrowth") this.applyHealing(attacker, target, 20 + castBonus);
      else if (castBonus > 0) this.applyHealing(attacker, target, castBonus);
      const deep = runtime.equippedPassives.has("druid_deep_roots") ? 1 : 0;
      this.addTimedEffect(attacker, target, "healing_over_time", definition.id,
        definition.id === "druid_rejuvenation" ? 10_000 : 5_000,
        (definition.id === "druid_rejuvenation" ? 4 : 2) + deep,
        undefined, definition.id === "druid_rejuvenation" ? 2_000 : 1_000);
      return true;
    }
    if (definition.id === "knight_taunt") {
      this.resolveTauntAction(attacker, this.ensurePveSession(attacker));
      this.recordSupportContribution(attacker, 1);
      return true;
    }
    if (definition.id === "knight_brace") {
      this.addTimedMitigation(attacker, definition.id,
        runtime.equippedPassives.has("knight_unyielding") ? 8_000 : 6_000, 0.30);
      return true;
    }
    if (definition.id === "knight_intervene") {
      this.addTimedEffect(attacker, target, "intervene", definition.id, 30_000,
        runtime.equippedPassives.has("knight_guardians_duty") ? 0.35 : 0.25);
      this.recordSupportContribution(attacker, 1);
      return true;
    }
    return false;
  }

  /** Universal-table matchup for true mobs; companions and NPC actors keep legacy stats. */
  private pveMatrixMobProfile(entity: Combatant): MobMatchup | null {
    const lich = entity.undead?.lich;
    if (lich) {
      return { weaponName: "Weapon", weaponType: lich.weaponProfile, armorName: "Armor", armorType: lich.bodyProfile, damageMultiplier: 1 };
    }
    if (
      entity.kind !== "mob" || entity.archetypeKey === null ||
      entity.npcFaction !== null || (entity.companionOwnerPlayerId ?? null) !== null
    ) return null;
    return mobMatchup(entity.archetypeKey);
  }

  /** DAMAGE_MATRIX_V4_ENABLED. Off: every matrix hit below resolves on the v3 table exactly as before. */
  private damageMatrixV4Active(): boolean {
    return this.options.damageMatrixV4Enabled?.() === true;
  }

  /**
   * The v4 types of the same entities pveMatrixMobProfile covers: a mob hits with its tier base, a Lich with its
   * copied weapon's base (it has no tier).
   */
  private v4MobProfile(entity: Combatant): Omit<MobV4Profile, "tier"> | null {
    const lich = entity.undead?.lich;
    if (lich) {
      const weapon = WEAPON_PROFILES_V4[lich.weaponProfile];
      return {
        damageType: weapon.damageType,
        baseDamage: weapon.baseDamage,
        armourType: V3_BODY_PROFILE_TO_V4_ARMOUR[lich.bodyProfile],
        damageMultiplier: 1
      };
    }
    return this.pveMatrixMobProfile(entity) === null ? null : mobV4Profile(entity.archetypeKey!);
  }

  private resolvePlayerToMobPveMatrixDamage(
    attacker: Combatant,
    target: Combatant,
    damageBeforeMultiplier: number,
    multiplier: number
  ): number | null {
    const mobMatrix = this.pveMatrixMobProfile(target);
    const state = attacker.equipmentCombatState;
    if (attacker.kind !== "player" || !state || !mobMatrix) return null;
    // Defense-bypassing developer weapons (God Sword) keep their fixed damage.
    if (state.stats.bypassPveDefense) return null;
    const activeItem = state.stats.items[state.activeWeaponSlot] ?? null;
    const weapon = activeItem?.category === "melee_weapon" || activeItem?.category === "ranged_weapon"
      ? activeItem
      : null;
    const weaponLevel = weapon?.itemLevel ?? 0;
    const targetLich = target.undead?.lich ?? null;
    if (this.damageMatrixV4Active()) {
      const profile = resolveV4WeaponProfileForEquipmentFamily(equipmentGameplayFamily(weapon?.definitionId ?? null));
      const mob = this.v4MobProfile(target);
      if (profile === null || mob === null) return null;
      return resolveDamageMatrixV4({
        ...WEAPON_PROFILES_V4[profile],
        armourType: mob.armourType,
        shielded: targetLich?.shieldProfile != null,
        ...(targetLich?.shieldProfile ? { shieldLevel: targetLich.shieldLevel } : {}),
        attackerLevel: weaponLevel,
        defenderLevel: targetLich ? targetLich.bodyLevel : target.level,
        flatAttack: damageBeforeMultiplier - EQUIPMENT_BASE_BASIC_ATTACK - weaponLevel,
        // The action-combat swing/shot factor rides in here, after the matrix and level factor.
        multiplier: Math.max(0, multiplier)
      }).finalDamage;
    }
    const weaponProfile = resolveV3WeaponProfileForEquipmentFamily(
      equipmentGameplayFamily(weapon?.definitionId ?? null)
    );
    if (weaponProfile.profile === null) return null;
    return resolveMatchupDamage({
      weaponType: weaponProfile.profile,
      armorType: mobMatrix.armorType,
      ...(targetLich?.shieldProfile ? { shieldType: targetLich.shieldProfile, shieldLevel: targetLich.shieldLevel } : {}),
      attackerLevel: weaponLevel,
      defenderLevel: targetLich ? targetLich.bodyLevel : target.level,
      // Everything above the base attack and the weapon level (weapon base
      // bonus, attack ring, class flat bonuses) stays additive as before.
      flatAttack: damageBeforeMultiplier - EQUIPMENT_BASE_BASIC_ATTACK - weaponLevel,
      multiplier: Math.max(0, multiplier)
    }).finalDamage;
  }

  private resolveMobToPlayerPveMatrixDamage(
    attacker: Combatant,
    target: Combatant,
    mobMatrix: MobMatchup
  ): number | null {
    const items = target.equipmentCombatState?.stats.items;
    const chest = items?.chest ?? null;
    const shield = items?.secondary?.category === "shield" ? items.secondary : null;
    if (this.damageMatrixV4Active()) {
      const body = resolveV4DefenseForEquipmentFamily(equipmentGameplayFamily(chest?.definitionId ?? null));
      const mob = this.v4MobProfile(attacker);
      if (body?.kind !== "body" || mob === null) return null;
      return resolveDamageMatrixV4({
        damageType: mob.damageType,
        baseDamage: mob.baseDamage,
        armourType: body.armourType,
        shielded: shield !== null &&
          resolveV4DefenseForEquipmentFamily(equipmentGameplayFamily(shield.definitionId))?.kind === "shield",
        attackerLevel: attacker.undead?.lich ? attacker.undead.lich.weaponLevel : attacker.level,
        ...(attacker.undead?.lich ? { flatAttack: this.lichFlatAttack(attacker.undead.lich) } : {}),
        defenderLevel: Math.max(1, chest ? chest.universalDefenseContribution : 0),
        shieldLevel: shield?.itemLevel ?? 0,
        multiplier: mob.damageMultiplier
      }).finalDamage;
    }
    const bodyProfile = resolveV3DefenseProfileForEquipmentFamily(
      equipmentGameplayFamily(chest?.definitionId ?? null)
    );
    if (bodyProfile.profile === null) return null;
    const shieldProfile = shield
      ? resolveV3DefenseProfileForEquipmentFamily(equipmentGameplayFamily(shield.definitionId)).profile
      : null;
    return resolveMatchupDamage({
      weaponType: mobMatrix.weaponType,
      armorType: bodyProfile.profile,
      shieldType: shieldProfile === "shield" || shieldProfile === "wyrm_shield"
        ? shieldProfile
        : null,
      attackerLevel: attacker.undead?.lich ? attacker.undead.lich.weaponLevel : attacker.level,
      ...(attacker.undead?.lich ? { flatAttack: this.lichFlatAttack(attacker.undead.lich) } : {}),
      // Condition-scaled armor level (equals the item level at full condition);
      // bare skin defends at level 1.
      defenderLevel: Math.max(1, chest ? chest.universalDefenseContribution : 0),
      shieldLevel: shield?.itemLevel ?? 0,
      multiplier: mobMatrix.damageMultiplier
    }).finalDamage;
  }

  private resolveContextDamage(
    attacker: Combatant,
    target: Combatant,
    input: {
      pveDamage: number;
      /** Player-to-mob only: damage before multipliers, for the PvE matrix. */
      pveDamageBeforeMultiplier?: number;
      pveDamageMultiplier?: number;
      pvpDamageBeforePowerScaling?: number;
      pvpDamageMultiplier?: number;
      pvpUseEquipmentMatrix?: boolean;
    }
  ): CombatDamageResolution {
    const context: CombatContext = attacker.kind === "player" && target.kind === "player"
      ? "pvp_open_world"
      : "pve";
    if (context === "pve") {
      const matrixDamage = input.pveDamageBeforeMultiplier === undefined
        ? null
        : this.resolvePlayerToMobPveMatrixDamage(
          attacker,
          target,
          input.pveDamageBeforeMultiplier,
          input.pveDamageMultiplier ?? 1
        );
      const finalDamage = matrixDamage ?? Math.max(1, Math.round(input.pveDamage));
      return {
        context,
        damageBeforePowerScaling: finalDamage,
        powerMultiplier: 1,
        finalDamage
      };
    }
    const attackerWeapon = attacker.equipmentCombatState?.stats.items[
      attacker.equipmentCombatState.activeWeaponSlot
    ] ?? null;
    const attackerWeaponDefinition = attackerWeapon && isEquipmentDefinitionId(attackerWeapon.definitionId)
      ? requireEquipmentDefinition(attackerWeapon.definitionId)
      : null;
    if (input.pvpUseEquipmentMatrix) {
      const defenderChest = target.equipmentCombatState?.stats.items.chest ?? null;
      const defenderShield = target.equipmentCombatState?.stats.items.secondary?.category === "shield"
        ? target.equipmentCombatState.stats.items.secondary
        : null;
      const defenderChestDefinition = defenderChest && isEquipmentDefinitionId(defenderChest.definitionId)
        ? requireEquipmentDefinition(defenderChest.definitionId)
        : null;
      const defenderShieldDefinition = defenderShield && isEquipmentDefinitionId(defenderShield.definitionId)
        ? requireEquipmentDefinition(defenderShield.definitionId)
        : null;
      const weaponProfile = resolveV3WeaponProfileForEquipmentFamily(
        equipmentGameplayFamily(attackerWeapon?.definitionId ?? null)
      );
      const bodyProfile = resolveV3DefenseProfileForEquipmentFamily(
        equipmentGameplayFamily(defenderChest?.definitionId ?? null)
      );
      const shieldProfile = defenderShield
        ? resolveV3DefenseProfileForEquipmentFamily(
            equipmentGameplayFamily(defenderShield.definitionId)
          )
        : null;
      const attackRingBonus = attacker.equipmentCombatState?.stats.items.ring?.utilityKind === "attack_bonus"
        ? attacker.equipmentCombatState.stats.items.ring.universalAttackContribution
        : 0;
      const requestedFlatAdjustment = (input.pvpDamageBeforePowerScaling ?? attacker.attackDamage) - attacker.attackDamage;
      const classDefense = this.v3ClassDefenseBonuses(target, attacker);
      // Whetted weapon proc: the target's flat defense drops while it lasts. applyDamage only
      // reduces its `defense` argument, which PvP matrix hits pass as 0, so this is not double counted.
      const whettedDefenseLoss = this.effectTotal(target, "whetted_defense");
      const caveDefense = this.deepstoneCaveBonus(target, "defense");
      const v3Defense = {
        body: classDefense.body + caveDefense - whettedDefenseLoss,
        shield: classDefense.shield + caveDefense - whettedDefenseLoss
      };
      if (this.damageMatrixV4Active()) {
        const v4Weapon = resolveV4WeaponProfileForEquipmentFamily(equipmentGameplayFamily(attackerWeapon?.definitionId ?? null));
        const v4Body = resolveV4DefenseForEquipmentFamily(equipmentGameplayFamily(defenderChest?.definitionId ?? null));
        const v4Shield = defenderShield
          ? resolveV4DefenseForEquipmentFamily(equipmentGameplayFamily(defenderShield.definitionId))
          : null;
        if (v4Weapon !== null && v4Body?.kind === "body" && (defenderShield === null || v4Shield?.kind === "shield")) {
          const matrix = resolveDamageMatrixV4({
            ...WEAPON_PROFILES_V4[v4Weapon],
            armourType: v4Body.armourType,
            shielded: defenderShield !== null,
            attackerLevel: attackerWeapon?.itemLevel ?? 0,
            defenderLevel: defenderChest?.itemLevel ?? 0,
            shieldLevel: defenderShield?.itemLevel ?? 0,
            flatAttack: attackRingBonus + requestedFlatAdjustment,
            flatBodyDefense: v3Defense.body,
            flatShieldDefense: v3Defense.shield,
            multiplier: input.pvpDamageMultiplier ?? 1
          });
          return {
            context,
            damageBeforePowerScaling: Math.max(1, matrix.selectedRawDamage),
            powerMultiplier: matrix.finalDamage / Math.max(1, matrix.selectedRawDamage),
            finalDamage: matrix.finalDamage
          };
        }
      }
      if (
        weaponProfile.pvpDamageProfileMode === "matrix_v3" && weaponProfile.profile !== null &&
        bodyProfile.pvpDamageProfileMode === "matrix_v3" && bodyProfile.profile !== null &&
        (shieldProfile === null || (
          shieldProfile.pvpDamageProfileMode === "matrix_v3" &&
          (shieldProfile.profile === "shield" || shieldProfile.profile === "wyrm_shield")
        ))
      ) {
        const matrix = resolveDamageMatrixV3({
          weaponProfile: weaponProfile.profile,
          weaponUpgrade: attackerWeapon?.itemLevel ?? 0,
          bodyDefenseProfile: bodyProfile.profile,
          bodyArmorUpgrade: defenderChest?.itemLevel ?? 0,
          shieldDefenseProfile: shieldProfile?.profile === "shield" || shieldProfile?.profile === "wyrm_shield"
            ? shieldProfile.profile
            : null,
          shieldUpgrade: defenderShield?.itemLevel ?? 0,
          flatAttack: attackRingBonus + requestedFlatAdjustment,
          flatBodyDefense: v3Defense.body,
          flatShieldDefense: v3Defense.shield,
          multiplier: input.pvpDamageMultiplier ?? 1
        });
        return {
          context,
          damageBeforePowerScaling: Math.max(1, matrix.selectedRawDamage),
          powerMultiplier: matrix.finalDamage / Math.max(1, matrix.selectedRawDamage),
          finalDamage: matrix.finalDamage
        };
      }
      if (!attackerWeapon || !attackerWeaponDefinition?.damageWeaponType) {
        const resolved = resolvePvpDamage({
          attackerOffense: attacker.equipmentCombatState?.stats.universalAttackPower ?? attacker.attackDamage,
          defenderGuard: Math.max(0, (target.equipmentCombatState?.stats.universalDefense ?? this.effectiveDefense(target)) +
            classDefense.body + classDefense.shield - whettedDefenseLoss),
          damageBeforePowerScaling: input.pvpDamageBeforePowerScaling ?? PVP_BASE_BASIC_DAMAGE,
          damageMultiplier: input.pvpDamageMultiplier ?? 1
        });
        return {
          context,
          damageBeforePowerScaling: resolved.damageBeforePowerScaling,
          powerMultiplier: resolved.powerMultiplier,
          finalDamage: resolved.finalDamage
        };
      }
      const matrix = resolveDamageMatrixV1({
        weaponType: attackerWeaponDefinition.damageWeaponType,
        weaponUpgrade: attackerWeapon.itemLevel,
        armorType: defenderChestDefinition?.damageArmorType ?? "naked",
        armorUpgrade: defenderChest?.itemLevel ?? 0,
        shieldType: defenderShieldDefinition?.damageShieldType ?? null,
        shieldUpgrade: defenderShield?.itemLevel ?? 0
      });
      const damageBeforeMultiplier = Math.max(
        1,
        matrix.finalDamage + attackRingBonus + requestedFlatAdjustment - classDefense.body - classDefense.shield +
          whettedDefenseLoss
      );
      const finalDamage = Math.max(
        1,
        Math.round(damageBeforeMultiplier * (input.pvpDamageMultiplier ?? 1))
      );
      return {
        context,
        damageBeforePowerScaling: damageBeforeMultiplier,
        powerMultiplier: finalDamage / damageBeforeMultiplier,
        finalDamage
      };
    }
    const resolved = resolvePvpDamage({
      attackerOffense:
        attacker.equipmentCombatState?.stats.universalAttackPower
        ?? attacker.attackDamage,
      defenderGuard:
        target.equipmentCombatState?.stats.universalDefense
        ?? this.effectiveDefense(target),
      damageBeforePowerScaling:
        input.pvpDamageBeforePowerScaling ?? PVP_BASE_BASIC_DAMAGE,
      damageMultiplier: input.pvpDamageMultiplier ?? 1
    });
    return {
      context,
      damageBeforePowerScaling: resolved.damageBeforePowerScaling,
      powerMultiplier: resolved.powerMultiplier,
      finalDamage: resolved.finalDamage
    };
  }

  private resolvePeriodicDamage(
    attacker: Combatant,
    target: Combatant,
    damageBeforePowerScaling: number,
    sourceTechniqueId: string
  ): number {
    if (attacker.kind !== "player" || target.kind !== "player") {
      return this.applyDamage(
        attacker,
        target,
        damageBeforePowerScaling,
        sourceTechniqueId,
        false
      );
    }
    const resolution = this.resolveContextDamage(attacker, target, {
      pveDamage: damageBeforePowerScaling,
      pvpDamageBeforePowerScaling: damageBeforePowerScaling
    });
    return this.applyDamage(
      attacker,
      target,
      resolution.finalDamage,
      sourceTechniqueId,
      false
    );
  }

  private applyStatusDamage(
    sourceEntityId: string,
    target: Combatant,
    requestedDamage: number,
    sourceTechniqueId: string,
    harmfulStatusId: HarmfulStatusId
  ): number {
    if (this.isPlayerReserved(sourceEntityId) || this.isPlayerReserved(target.entityId)) {
      this.deferredReplenishEffects.push(() => {
        this.applyStatusDamage(sourceEntityId, target, requestedDamage, sourceTechniqueId, harmfulStatusId);
      });
      return 0;
    }
    if (target.lifeState !== "alive" || this.options.isEntityInvulnerable?.(target.entityId)) return 0;
    if (isShelled(target.special, this.currentTick)) return 0;
    if (target.kind === "mob" && target.archetypeKey === "blight_treant" && harmfulStatusId === "burning") {
      this.mobSpecial(target).lastBurnTick = this.currentTick;
    }
    const source = this.entities.get(sourceEntityId);
    const isAttributedDisconnectedElementalBurn =
      target.kind === "mob" && source === undefined && harmfulStatusId === "burning" &&
      sourceTechniqueId === METAL_EMBER_BURN_ID &&
      this.contributionsByMob.get(target.entityId)?.has(sourceEntityId) === true;
    if (target.kind === "mob" && source?.kind !== "player" && !isAttributedDisconnectedElementalBurn) return 0;
    // Gem immunity, dormant statues and the shielded Core hold against damage over time too.
    if (target.kind === "mob" && this.golemForgeBlocksDamage(source, target)) return 0;
    // Tilted Vault: the Ember Shade's wail leaves it untouchable for a moment, damage over time included.
    if (target.kind === "mob" && this.vaultWardBlocksDamage(source, target)) return 0;
    // One swing: damage over time from a player who already used it on this target does nothing.
    if (source?.kind === "player" && target.kind === "player" && this.pvpStrikeBlocked(source, target)) return 0;
    if (
      source?.kind === "mob" &&
      target.kind === "player" &&
      this.flagArrivalProtectionUntil(target.entityId) !== null
    ) return 0;
    const healthBeforeDamage = target.currentHealth;
    let damage = Math.max(1, Math.round(requestedDamage));
    const shields = target.classRuntime?.effects.filter((effect) =>
      effect.kind === "healing_shield" && effect.amount > 0 && effect.endTick >= this.currentTick &&
      (!effect.enemyIds || effect.enemyIds.includes(sourceEntityId))
    )
      .sort((left, right) => left.id.localeCompare(right.id)) ?? [];
    for (const shield of shields) {
      const absorbed = Math.min(damage, Math.round(shield.amount));
      damage -= absorbed;
      shield.amount -= absorbed;
      if (shield.amount <= 0 && target.classRuntime) {
        target.classRuntime.effects = target.classRuntime.effects.filter((effect) => effect !== shield);
      }
      if (absorbed > 0) this.rememberClassRuntime(target);
      if (damage <= 0) break;
    }
    const appliedDamage = Math.min(target.currentHealth, damage);
    target.currentHealth = Math.max(0, target.currentHealth - damage);
    this.emitCombatAnalyticsEvent({
      kind: "damage_applied",
      context: source?.kind === "player" && target.kind === "player"
        ? "pvp_open_world"
        : "pve",
      actorId: sourceEntityId,
      actorKind: source?.kind ?? "system",
      targetId: target.entityId,
      targetKind: target.kind,
      actorLevel: source?.level ?? null,
      targetLevel: target.level,
      actorClassId: source?.classRuntime?.activeClassId ?? null,
      actorSubclassId: source?.classRuntime?.subclassId ?? null,
      targetClassId: target.classRuntime?.activeClassId ?? null,
      targetSubclassId: target.classRuntime?.subclassId ?? null,
      actorWeaponInstanceId: source?.equipmentCombatState?.activeWeaponInstanceId ?? null,
      damageBeforeMitigation: damage,
      damageApplied: appliedDamage,
      mitigationBySource: {},
      sourceTechniqueId,
      distanceM: source ? distanceMeters(source.position, target.position) : null,
      targetHealthAfter: target.currentHealth
    });
    if (target.kind === "player" && appliedDamage > 0) {
      try {
        this.options.onHarmfulStatusDamage?.({
          operationId: `${target.entityId}:${harmfulStatusId}:${this.currentTick}:${this.eventSequence++}`,
          playerId: target.entityId,
          harmfulStatusId,
          appliedDamage
        });
      } catch {
        // Durable progression observers are isolated from the combat tick.
      }
    }
    const disconnectedBurningPlayerId = isAttributedDisconnectedElementalBurn ? sourceEntityId : null;
    const contributingPlayerId = source?.kind === "player"
      ? source.entityId
      : disconnectedBurningPlayerId;
    if (target.kind === "mob" && !target.companionDogId && contributingPlayerId && appliedDamage > 0) {
      if (source?.kind === "player") this.markSessionParticipation(source.entityId);
      const contributions = this.contributionsByMob.get(target.entityId) ?? new Map();
      contributions.set(
        contributingPlayerId,
        (contributions.get(contributingPlayerId) ?? 0) + appliedDamage
      );
      this.contributionsByMob.set(target.entityId, contributions);
      this.pveSessions.get(contributingPlayerId)?.telemetry.recordDamageDealt(
        sourceTechniqueId,
        appliedDamage
      );
    }
    if (appliedDamage > 0 && target.kind === "mob" && target.bossOwnership !== null && target.currentHealth > 0 &&
        sourceEntityId !== target.entityId) {
      this.bossDamageListener?.(target.entityId, appliedDamage, sourceEntityId);
    }
    this.markDirty(target);
    this.rememberProfile(target);
    this.emitEvent("DAMAGE", sourceEntityId, target.entityId, appliedDamage, target.currentHealth);
    if (this.persistCompanionHealth(target)) return appliedDamage;
    if (target.currentHealth <= 0 && target.lifeState === "alive") {
      if (source) this.beginDefeat(target, source, false, sourceTechniqueId);
      else if (disconnectedBurningPlayerId) {
        this.beginDefeat(
          target,
          null,
          false,
          sourceTechniqueId,
          disconnectedBurningPlayerId
        );
      }
      else this.defeat(target, sourceEntityId);
    }
    return appliedDamage;
  }

  private applyHarmfulStatus(
    source: Combatant,
    target: Combatant,
    statusId: HarmfulStatusId,
    chance = 1
  ): boolean {
    const applied = this.applyHarmfulStatusInner(source, target, statusId, chance);
    const weapon = source.equipmentCombatState?.inscribedWeapon;
    if (applied && weapon && source.kind === "player") this.options.inscriptionStats?.add(weapon.instanceId, "debuffsApplied");
    return applied;
  }

  /** Inscribed weapon and armor counters for one landed hit. */
  private recordInscriptionDamage(attacker: Combatant, target: Combatant, applied: number, direct: boolean): void {
    const counters = this.options.inscriptionStats;
    if (!counters || applied <= 0 || attacker.entityId === target.entityId) return;
    const weapon = attacker.kind === "player" ? attacker.equipmentCombatState?.inscribedWeapon : null;
    if (weapon && direct) {
      counters.add(weapon.instanceId, "totalDamageDealt", applied);
      counters.add(weapon.instanceId, "hits");
    }
    if (target.kind === "player") {
      for (const id of target.equipmentCombatState?.inscribedArmorIds ?? []) {
        counters.add(id, "totalDamageTaken", applied);
        counters.add(id, "hitsTaken");
        counters.max(id, "highestDamageTaken", applied);
        if (applied === 1) counters.add(id, "reducedToOne");
      }
    }
  }

  /** Kill and death counters; returns the inscription that killed a player, for the death message. */
  private recordInscriptionDefeat(
    source: Combatant | undefined,
    target: Combatant
  ): Readonly<{ wielderName: string; inscription: string }> | null {
    const counters = this.options.inscriptionStats;
    if (!counters) return null;
    let killedBy: { wielderName: string; inscription: string } | null = null;
    const weapon = source?.kind === "player" ? source.equipmentCombatState?.inscribedWeapon : null;
    if (source && weapon) {
      if (target.kind === "mob") {
        counters.add(weapon.instanceId, mobMovementHabitat(target.archetypeKey) === "water"
          ? "monstersKilledWater" : "monstersKilledLand");
      } else if (target.kind === "player" && target.entityId !== source.entityId) {
        counters.add(weapon.instanceId, "playersKilled");
        killedBy = { wielderName: source.name, inscription: weapon.name };
      }
    }
    if (target.kind === "player") {
      for (const id of target.equipmentCombatState?.inscribedArmorIds ?? []) {
        counters.add(id, source?.kind === "player" ? "deathsByPlayers" : "deathsByMonsters");
      }
    }
    return killedBy;
  }

  private applyHarmfulStatusInner(
    source: Combatant,
    target: Combatant,
    statusId: HarmfulStatusId,
    chance = 1
  ): boolean {
    if (this.isPlayerReserved(source.entityId) || this.isPlayerReserved(target.entityId)) {
      this.deferredReplenishEffects.push(() => { this.applyHarmfulStatus(source, target, statusId, chance); });
      return false;
    }
    // Only the ticking statuses are applied here; the rest come from their own sources.
    if (statusId !== "poison" && statusId !== "gloom" && statusId !== "burning" && statusId !== "storm") return false;
    if (statusId === "poison" && this.isVenomImmune(target)) return false;
    if (
      target.lifeState !== "alive" ||
      this.hasV3CleanseImmunity(target) ||
      chance <= 0 || (chance < 1 && (this.options.random?.() ?? Math.random()) >= chance)
    ) return false;
    const runtime = target.classRuntime ?? (target.classRuntime = emptyRuntime());
    // Beat-aligned pulses keeping the design damage per second and (to the nearest beat) duration.
    const intervalTicks = this.periodicIntervalTicks(HARMFUL_STATUS_PULSE_INTERVAL_MS);
    const pulseCount = beatPulseCount(HARMFUL_STATUS_DURATION_MS, HARMFUL_STATUS_PULSE_INTERVAL_MS);
    // Statuses never stack; re-applying refreshes the duration (never shortens it).
    const active = runtime.effects.find((effect) =>
      effect.kind === statusId && effect.stacks > 0 && effect.endTick >= this.currentTick
    );
    if (active) {
      active.sourceEntityId = source.entityId;
      active.endTick = Math.max(active.endTick, this.currentTick + intervalTicks * pulseCount);
      active.stacks = Math.max(active.stacks, active.maximumStacks);
      this.markDirty(target);
      return true;
    }
    const firstTick = statusId === "poison"
      ? this.firstPeriodicTick(source.entityId, target, intervalTicks)
      : Number.MAX_SAFE_INTEGER;
    runtime.effects.push({
      id: `${target.entityId}:harmful:${statusId}`,
      kind: statusId,
      sourceTechniqueId: `status_${statusId}`,
      sourceEntityId: source.entityId,
      startTick: this.currentTick,
      endTick: statusId === "poison"
        ? firstTick + intervalTicks * (pulseCount - 1)
        : this.currentTick + intervalTicks * pulseCount,
      nextTick: firstTick,
      stacks: statusId === "poison" ? pulseCount : 1,
      maximumStacks: statusId === "poison" ? pulseCount : 1,
      amount: statusId === "poison"
        ? POISON_DAMAGE_PER_PULSE * beatAlignedAmountScale(HARMFUL_STATUS_PULSE_INTERVAL_MS)
        : 0,
      cleansable: true,
      minor: false
    });
    this.markDirty(target);
    return true;
  }

  private applyJellyfishHitEffects(attacker: Combatant, target: Combatant): void {
    if (
      attacker.kind !== "mob" || attacker.archetypeKey !== "jellyfish" ||
      target.kind !== "player" || target.lifeState !== "alive"
    ) return;
    this.applyHarmfulStatus(attacker, target, "poison", 1);
    if (attacker.jellyfishRuntime?.shadeEnabled === true) {
      this.applyHarmfulStatus(attacker, target, "gloom", 1);
    }
  }

  setExpelHandler(handler: MetalExpelHandler | null): void {
    this.expelHandler = handler;
  }

  setRevenantMetalHandler(handler: RevenantMetalHandler | null): void {
    this.revenantMetalHandler = handler;
  }

  /** Installs a player's stored PvP max-HP penalty (null clears it). Recovery is applied lazily. */
  setPlayerMaxHealthPenalty(
    playerId: string,
    penalty: Readonly<{ penalty: number; recoveryAnchorMs: number }> | null
  ): void {
    if (penalty && effectiveMaxHealthPenalty(penalty.penalty, penalty.recoveryAnchorMs, this.now()) > 0) {
      this.maxHealthPenalties.set(playerId, { penalty: penalty.penalty, recoveryAnchorMs: penalty.recoveryAnchorMs });
    } else {
      this.maxHealthPenalties.delete(playerId);
    }
    const player = this.entities.get(playerId);
    if (player?.kind === "player") this.reapplyMaxHealthPenalty(player);
  }

  /** A player's max HP before the PvP death penalty (null when the player is not connected). */
  unpenalizedMaxHealth(playerId: string): number | null {
    const player = this.entities.get(playerId);
    return player?.kind === "player"
      ? player.maxHealth + (player.maxHealthPenaltyApplied ?? 0) - (this.vigorSerumApplied.get(playerId) ?? 0)
      : null;
  }

  /** A player's max HP from its unpenalized value, with the current penalty and the 50% floor. */
  private penalizedMaxHealth(player: Combatant, unpenalizedMaxHealth: number): number {
    const unpenalized = Math.max(1, Math.trunc(unpenalizedMaxHealth));
    const stored = this.maxHealthPenalties.get(player.entityId);
    const penalty = stored ? effectiveMaxHealthPenalty(stored.penalty, stored.recoveryAnchorMs, this.now()) : 0;
    if (stored && penalty === 0) this.maxHealthPenalties.delete(player.entityId);
    const maxHealth = applyMaxHealthDebuff(unpenalized, penalty);
    player.maxHealthPenaltyApplied = unpenalized - maxHealth;
    return maxHealth;
  }

  private reapplyMaxHealthPenalty(player: Combatant): void {
    const maxHealth = this.penalizedMaxHealth(player, player.maxHealth + (player.maxHealthPenaltyApplied ?? 0));
    if (maxHealth === player.maxHealth) return;
    player.maxHealth = maxHealth;
    // Recovered max HP is room to heal into, not a heal.
    player.currentHealth = Math.min(player.currentHealth, maxHealth);
    this.markDirty(player);
    this.rememberProfile(player);
  }

  private processMaxHealthPenaltyRecovery(): void {
    if (this.maxHealthPenalties.size === 0 || this.currentTick % this.options.tickRateHz !== 0) return;
    for (const playerId of [...this.maxHealthPenalties.keys()]) {
      const player = this.entities.get(playerId);
      if (player?.kind === "player") this.reapplyMaxHealthPenalty(player);
    }
  }

  private undeadOwner(entity: Combatant | null | undefined): Combatant | null {
    const owner = entity?.undead ? this.entities.get(entity.undead.ownerPlayerId) : undefined;
    return owner?.kind === "player" ? owner : null;
  }

  /** The player behind a blow: the attacker itself, or the owner of the undead that landed it. */
  private owningPlayerId(source: Combatant | undefined, victim: Combatant): string | null {
    const playerId = source?.kind === "player" ? source.entityId : source?.undead?.ownerPlayerId ?? null;
    return playerId !== null && playerId !== victim.entityId ? playerId : null;
  }

  private wearsRevenantArmor(player: Combatant): boolean {
    return player.kind === "player" && player.equipmentCombatState?.revenantArmor === true;
  }

  /**
   * Revenant weapon: only a direct weapon attack from a Revenant-infused weapon counts. Undead hits,
   * metal procs and damage-over-time ticks are not weapon attacks, so they never raise skeletons.
   */
  private noteRevenantWeaponKillingBlow(attacker: Combatant | null, target: Combatant, sourceTechniqueId: string): void {
    const handler = this.revenantMetalHandler;
    if (!handler || attacker?.kind !== "player" || attacker.entityId === target.entityId) return;
    if (!this.isTargetedBasicOrWeaponAttack(sourceTechniqueId, this.isTargetedAttack(sourceTechniqueId))) return;
    const metal = parseEquipmentEnhancement(attacker.equipmentCombatState?.activeWeaponEnchantmentIdentity ?? null)?.metal;
    if (metal !== "revenant") return;
    try {
      handler.onRevenantWeaponKillingBlow({
        ownerPlayerId: attacker.entityId,
        position: { ...target.position },
        regionCode: target.regionCode,
        zoneId: target.zoneId
      });
    } catch {
      // Revenant Metal observers are isolated from the authoritative combat tick.
    }
  }

  private lichSnapshot(player: Combatant): LichCombatSnapshot {
    const state = player.equipmentCombatState;
    const items = state?.stats.items;
    const weapon = state ? items?.[state.activeWeaponSlot] ?? null : null;
    const activeWeapon = weapon?.category === "melee_weapon" || weapon?.category === "ranged_weapon" ? weapon : null;
    const chest = items?.chest ?? null;
    const shield = items?.secondary?.category === "shield" ? items.secondary : null;
    const body = resolveV3DefenseProfileForEquipmentFamily(equipmentGameplayFamily(chest?.definitionId ?? null)).profile;
    const shieldProfile = shield
      ? resolveV3DefenseProfileForEquipmentFamily(equipmentGameplayFamily(shield.definitionId)).profile
      : null;
    return {
      name: `${player.name}'s Lich`.slice(0, 80),
      level: player.level,
      maxHealth: Math.max(1, player.maxHealth),
      attack: Math.max(1, player.attackDamage),
      defense: Math.max(0, player.defense),
      weaponProfile: resolveV3WeaponProfileForEquipmentFamily(
        equipmentGameplayFamily(activeWeapon?.definitionId ?? null)
      ).profile ?? "unarmed",
      weaponLevel: Math.max(0, activeWeapon?.itemLevel ?? 0),
      bodyProfile: body === null || body === "shield" || body === "wyrm_shield" ? "unarmored" : body,
      bodyLevel: Math.max(0, chest?.itemLevel ?? 0),
      shieldProfile: shieldProfile === "shield" || shieldProfile === "wyrm_shield" ? shieldProfile : null,
      shieldLevel: Math.max(0, shield?.itemLevel ?? 0)
    };
  }

  /** Re-levels (or only refreshes) a Revenant Metal skeleton in place; damage already taken is kept. */
  upgradeUndeadSkeleton(entityId: string, skeletonLevel: number, mobLevel: number, expiresAt: number): boolean {
    const entity = this.entities.get(entityId);
    if (!entity?.undead || entity.undead.kind !== "skeleton" || entity.lifeState !== "alive" || !entity.archetypeKey) {
      return false;
    }
    const profile = resolveMobCombatProfile(entity.archetypeKey, mobLevel);
    const damageTaken = Math.max(0, entity.maxHealth - entity.currentHealth);
    entity.level = profile.level;
    entity.challengeTier = profile.tier;
    entity.combatBalanceVersion = profile.balanceVersion;
    entity.maxHealth = Math.max(1, profile.maxHealth);
    entity.currentHealth = Math.max(1, entity.maxHealth - damageTaken);
    entity.attackDamage = profile.attackPower;
    entity.defense = profile.defense;
    entity.undead = { ...entity.undead, level: skeletonLevel, expiresAt };
    this.markDirty(entity);
    return true;
  }

  /**
   * Revenant Metal undead fight under their owner's gates, even while the owner is respawning:
   * PvP zones (combat rules), the trust shield, arrival protection, and PvE encounter authority.
   */
  canUndeadAttack(undeadEntityId: string, targetEntityId: string): boolean {
    const undead = this.entities.get(undeadEntityId);
    const owner = this.undeadOwner(undead);
    const target = this.entities.get(targetEntityId);
    return Boolean(undead && owner && target && !this.undeadAttackBlocked(undead, owner, target));
  }

  private undeadAttackBlocked(undead: Combatant, owner: Combatant, target: Combatant): boolean {
    if (undead.lifeState !== "alive" || target.lifeState !== "alive") return true;
    if (target.entityId === owner.entityId || target.entityId === undead.entityId) return true;
    if (target.undead?.ownerPlayerId === owner.entityId || target.companionDogId) return true;
    if (target.npcFaction && !this.isNpcCityPlayerEnemy(target.npcFaction.cityId, owner.entityId)) return true;
    if (this.worldAbsentPlayerIds.has(owner.entityId) || this.worldAbsentPlayerIds.has(target.entityId)) return true;
    if (this.pendingMobDefeats.has(target.entityId) || isMobRetreating(target)) return true;
    if (target.regionCode !== undead.regionCode || target.zoneId !== undead.zoneId) return true;
    if (this.options.isEntityInvulnerable?.(target.entityId) || this.isNinjaInvisible(target)) return true;
    // Another player's undead is fought under the same PvP gates as its owner.
    const defendingPlayer = target.kind === "player" ? target : this.undeadOwner(target);
    if (defendingPlayer) {
      if (this.flagArrivalProtectionUntil(defendingPlayer.entityId) !== null) return true;
      if (this.options.isPvpBlocked?.(owner.entityId, defendingPlayer.entityId) === true) return true;
      if (this.pvpRuleRefusal(owner.entityId, defendingPlayer) === "pvp-defeat-safety") return true;
      return !this.rules.canAttack({
        attacker: { entityId: owner.entityId, kind: "player", regionCode: undead.regionCode, zoneId: undead.zoneId },
        target: { entityId: defendingPlayer.entityId, kind: "player", regionCode: target.regionCode, zoneId: target.zoneId }
      });
    }
    if (target.undead) return true;
    if (
      this.options.isPlayerMobAttackAuthorized &&
      !this.options.isPlayerMobAttackAuthorized(owner.entityId, target.entityId)
    ) return true;
    return target.aggroOwnerPlayerId !== null && target.aggroOwnerPlayerId !== owner.entityId &&
      this.options.partyAuthority?.sameParty(target.aggroOwnerPlayerId, owner.entityId) !== true &&
      this.options.isSharedMobCombat?.(target.entityId) !== true;
  }

  /** The undead's matrix row (skeleton profile, or the Lich's copied weapon) into the target's armor. */
  private undeadHitDamage(undead: Combatant, target: Combatant): number {
    const profile = this.pveMatrixMobProfile(undead);
    if (!profile) return 0;
    if (target.kind === "player") return this.resolveMobToPlayerPveMatrixDamage(undead, target, profile) ?? 0;
    return this.mobVersusMobMatrixDamage(undead, target);
  }

  /** One mob's matrix row into another mob's armor (Lich rows use the copied gear levels). */
  private mobVersusMobMatrixDamage(attacker: Combatant, target: Combatant): number {
    const profile = this.pveMatrixMobProfile(attacker);
    const lich = attacker.undead?.lich ?? null;
    const targetLich = target.undead?.lich ?? null;
    const targetProfile = this.pveMatrixMobProfile(target);
    if (!profile || !targetProfile) return 0;
    if (this.damageMatrixV4Active()) {
      const attackerV4 = this.v4MobProfile(attacker)!;
      return resolveDamageMatrixV4({
        damageType: attackerV4.damageType,
        baseDamage: attackerV4.baseDamage,
        armourType: this.v4MobProfile(target)!.armourType,
        shielded: targetLich?.shieldProfile != null,
        ...(targetLich?.shieldProfile ? { shieldLevel: targetLich.shieldLevel } : {}),
        attackerLevel: lich ? lich.weaponLevel : attacker.level,
        defenderLevel: targetLich ? targetLich.bodyLevel : target.level,
        ...(lich ? { flatAttack: this.lichFlatAttack(lich) } : {}),
        multiplier: attackerV4.damageMultiplier
      }).finalDamage;
    }
    return resolveMatchupDamage({
      weaponType: profile.weaponType,
      armorType: targetProfile.armorType,
      ...(targetLich?.shieldProfile ? { shieldType: targetLich.shieldProfile, shieldLevel: targetLich.shieldLevel } : {}),
      attackerLevel: lich ? lich.weaponLevel : attacker.level,
      defenderLevel: targetLich ? targetLich.bodyLevel : target.level,
      ...(lich ? { flatAttack: this.lichFlatAttack(lich) } : {}),
      multiplier: profile.damageMultiplier
    }).finalDamage;
  }

  /** Attack above the base attack and the weapon level (rings, class bonuses), as for a player hit. */
  private lichFlatAttack(lich: LichCombatSnapshot): number {
    return Math.max(0, lich.attack - EQUIPMENT_BASE_BASIC_ATTACK - lich.weaponLevel);
  }

  /**
   * One Revenant Metal undead hit, applied in the owner's name so it credits the owner (XP, loot,
   * PvP kills) and obeys the owner's gates. The damage is fixed: the owner's own buffs and
   * procs and the target's reactive armor do not apply to it.
   */
  applyUndeadAttack(undeadEntityId: string, targetEntityId: string): number {
    const undead = this.entities.get(undeadEntityId);
    const owner = this.undeadOwner(undead);
    const target = this.entities.get(targetEntityId);
    if (!undead?.undead || !owner || !target || this.undeadAttackBlocked(undead, owner, target)) return 0;
    if (distanceMeters(undead.position, target.position) > undead.attackRangeM + 1) return 0;
    const damage = this.undeadHitDamage(undead, target);
    if (damage <= 0) return 0;
    const applied = this.applyDamage(
      owner, target, damage,
      undead.undead.kind === "lich" ? REVENANT_METAL_LICH_TECHNIQUE_ID : REVENANT_METAL_SKELETON_TECHNIQUE_ID,
      false, {}, 0, false, "targeted",
      { fixedFinalDamage: damage, presentationSourceEntityId: undead.entityId }
    );
    if (applied > 0 && target.kind === "mob" && target.lifeState === "alive") this.retaliateAgainstUndead(target, undead);
    return applied;
  }

  /**
   * Threat for undead. A mob keeps hitting the player who is fighting it (one combat, many
   * attackers: the owner's encounter and auto-attack queue are never touched by an undead hit).
   * Only when no player is fighting it does it turn on the undead that hit it, so an undead
   * that pulls a mob alone tanks it and can be killed, without stealing the owner's fight.
   */
  private retaliateAgainstUndead(mob: Combatant, undead: Combatant): void {
    if (
      mob.kind !== "mob" || mob.lifeState !== "alive" || mob.undead || mob.companionDogId || mob.npcFaction ||
      !mob.retaliates || mob.attackDamage <= 0 || this.isBossMob(mob) || isMobRetreating(mob) ||
      this.pendingMobDefeats.has(mob.entityId) || mob.targetEntityId === undead.entityId ||
      this.isPlayerFightingMob(mob)
    ) return;
    if (mob.aggroOwnerPlayerId) {
      const session = this.pveSessions.get(mob.aggroOwnerPlayerId);
      if (session) this.removeEnemy(session, mob.entityId);
    }
    if (mob.targetEntityId) this.clearTarget(mob);
    this.cancelMobAiIntent(mob);
    this.returningMobs.delete(mob.entityId);
    this.invalidateScheduledAttack(mob);
    this.setTarget(mob, undead.entityId);
    mob.nextEligibleAttackTick = Math.max(mob.nextEligibleAttackTick, this.currentTick + 1);
    this.scheduleAttack(mob, mob.nextEligibleAttackTick);
  }

  /** A living player is fighting the mob: it targets them, or they hold it in a valid PvE session. */
  private isPlayerFightingMob(mob: Combatant): boolean {
    const candidateIds = new Set<string>();
    if (mob.aggroOwnerPlayerId) candidateIds.add(mob.aggroOwnerPlayerId);
    if (mob.targetEntityId) candidateIds.add(mob.targetEntityId);
    for (const playerId of candidateIds) {
      const player = this.entities.get(playerId);
      if (player?.kind !== "player" || player.lifeState !== "alive") continue;
      const session = this.pveSessions.get(playerId);
      if (session) {
        if (session.enemyIds.has(mob.entityId) && this.isEnemyValidForSession(session, mob.entityId)) return true;
      } else if (
        mob.targetEntityId === playerId &&
        (mob.leashRadiusM <= 0 || distanceMeters(mob.homePosition, mob.position) <= mob.leashRadiusM)
      ) return true;
    }
    return false;
  }

  /**
   * Whether an undead may hit now: on its owner's player-side phase (the first half of the
   * basic attack interval, `PVE_TURN_STEP_MS`), never on the enemy-action tick, so an undead hit and a monster hit never share
   * a tick. Without an owner turn anchor there is no phase to follow.
   */
  undeadInPlayerPhase(ownerPlayerId: string): boolean {
    const session = this.pveSessions.get(ownerPlayerId);
    const owner = this.entities.get(ownerPlayerId);
    if (!session || !owner || session.playerTurnAnchorTick === null) return true;
    const interval = Math.max(1, owner.attackIntervalTicks);
    const offset = ((this.currentTick - session.playerTurnAnchorTick) % interval + interval) % interval;
    return offset < this.pveTurnStepTicks;
  }

  /** Living entities currently fighting the player or one of its undead (mobs and players). */
  hostilesOf(playerId: string): string[] {
    const defended = new Set([playerId]);
    for (const entity of this.entities.values()) {
      if (entity.undead?.ownerPlayerId === playerId) defended.add(entity.entityId);
    }
    return [...this.entities.values()]
      .filter((entity) => entity.lifeState === "alive" && !defended.has(entity.entityId) && (
        (entity.targetEntityId !== null && defended.has(entity.targetEntityId)) ||
        (entity.kind === "mob" && entity.aggroOwnerPlayerId === playerId)
      ))
      .map((entity) => entity.entityId)
      .sort();
  }

  setBossCombatModifierProvider(provider: BossCombatModifierProvider | null): void {
    this.bossCombatModifierProvider = provider;
  }

  setBossDamageListener(listener: ((bossEntityId: string, amount: number, sourceEntityId: string) => void) | null): void {
    this.bossDamageListener = listener;
  }

  /** Installs the cached, synchronous player-building lookup (no database access on the Tactics tick). */
  setPlayerBuildingLookup(lookup: ((position: LatLon) => boolean) | null): void {
    this.playerBuildingLookup = lookup;
  }

  /** Voyager R3/R5: Tactics builds 1.35x / 1.7x faster while no player building is visible. */
  private voyagerIsolatedTacticsMultiplier(entity: Combatant, runtime: ClassCombatRuntime): number {
    const skill = runtime.skillV3;
    if (skill?.activeSpecializationId !== "voyager" || skill.specializationRank < 3) return 1;
    if (!this.playerBuildingLookup || this.playerBuildingLookup(entity.position)) return 1;
    return skill.specializationRank >= 5 ? 1.7 : 1.35;
  }

  /** Installs the synchronous land/water lookup that keeps mobs in their habitat. */
  setMobSurfaceLookup(lookup: MobSurfaceLookup | null): void {
    this.mobSurfaceLookup = lookup;
  }

  /**
   * Land mobs never step onto water and water mobs never step onto land. The
   * habitat comes from the mob's spawn rules (none: anywhere); the surface
   * from a prefilled cache. Unknown surfaces, dungeon rooms and mobs without a
   * spawn habitat fail open.
   */
  private isMobHabitatStepAllowed(mob: Combatant, next: LatLon): boolean {
    if (this.mobSurfaceLookup === null || mob.kind !== "mob" || mob.zoneId.startsWith("interior:")) return true;
    const habitat = mobMovementHabitat(mob.archetypeKey);
    if (habitat === null) return true;
    const surface = this.mobSurfaceLookup.surfaceAt(next);
    return surface === null || surface === habitat;
  }

  private bossCombatModifiers(entity: Combatant): BossCombatModifiers | null {
    if (entity.kind !== "mob" || entity.bossOwnership === null) return null;
    return this.bossCombatModifierProvider?.(entity.entityId) ?? null;
  }

  /** Additive per-mob modifiers for non-boss mobs (dungeon elites). Bosses keep the boss provider only. */
  setMobCombatModifierProvider(provider: BossCombatModifierProvider | null): void {
    this.mobCombatModifierProvider = provider;
  }

  private damageCombatModifiers(entity: Combatant): BossCombatModifiers | null {
    if (entity.kind !== "mob") return null;
    if (entity.bossOwnership !== null) return this.bossCombatModifiers(entity);
    return this.mobCombatModifierProvider?.(entity.entityId) ?? null;
  }

  private effectiveMobMovementSpeedMps(entity: Combatant): number {
    const modifiers = this.bossCombatModifiers(entity);
    if (modifiers?.movementSpeedMps !== undefined) {
      return Math.max(0, modifiers.movementSpeedMps);
    }
    const multiplier = modifiers?.movementSpeedMultiplier;
    return entity.movementSpeedMps * (multiplier === undefined
      ? 1
      : Math.max(0, multiplier));
  }

  private mobSpecial(mob: Combatant): MobSpecialState {
    return mob.special ?? (mob.special = newMobSpecialState());
  }

  /** Below the health threshold (and off cooldown) the turtle withdraws: immune, rooted, and silent for a few seconds. */
  private processShellbackThreshold(mob: Combatant): void {
    if (mob.lifeState !== "alive") return;
    const state = this.mobSpecial(mob);
    if (!shouldWithdrawIntoShell(state, mob.currentHealth, mob.maxHealth, this.currentTick)) return;
    state.shellUntilTick = this.currentTick +
      millisecondsToTicks(SHELLBACK_TURTLE.shellDurationMs, this.options.tickRateHz);
    state.nextShellTick = this.currentTick +
      millisecondsToTicks(SHELLBACK_TURTLE.shellCooldownMs, this.options.tickRateHz);
    this.addTimedEffect(mob, mob, "rooted", "shellback_turtle_shell", SHELLBACK_TURTLE.shellDurationMs, 1);
    this.markDirty(mob);
  }

  /** Wounded spiderlings fall back to the Brood Matriarch and guard her. */
  private processSpiderlingRetreat(mob: Combatant): void {
    if (mob.lifeState !== "alive") return;
    const state = this.mobSpecial(mob);
    if (!shouldSpiderlingRetreat(state, mob.currentHealth, mob.maxHealth)) return;
    const matriarch = this.findBroodMatriarch(mob);
    if (!matriarch) return;
    state.retreatToEntityId = matriarch.entityId;
    state.retreatArrived = false;
    this.disengageMobForRetreat(mob);
  }

  private findBroodMatriarch(near: Combatant): Combatant | null {
    for (const other of this.entities.values()) {
      if (
        other.kind === "mob" && other.archetypeKey === "brood_matriarch" &&
        other.lifeState === "alive" && other.zoneId === near.zoneId
      ) return other;
    }
    return null;
  }

  private stepSpiderlingRetreat(mob: Combatant): void {
    const state = this.mobSpecial(mob);
    const matriarch = state.retreatToEntityId ? this.entities.get(state.retreatToEntityId) : undefined;
    if (!matriarch || matriarch.lifeState !== "alive") {
      state.retreatToEntityId = null;
      state.retreatArrived = false;
      mob.activityState = "idle";
      this.markDirty(mob);
      return;
    }
    const remainingM = distanceMeters(mob.position, matriarch.position);
    if (remainingM <= SPIDERLING_RETREAT.arriveDistanceM) {
      state.retreatArrived = true;
      mob.activityState = "idle";
      this.markDirty(mob);
      return;
    }
    const stepM = this.effectiveMobMovementSpeedMps(mob) / this.options.tickRateHz;
    this.commitMobPhysicalPosition(mob, moveToward(mob.position, matriarch.position, stepM));
    mob.activityState = "fleeing";
  }

  private spiderlingAlliesOnTarget(spiderling: Combatant, target: Combatant): number {
    let allies = 0;
    for (const other of this.entities.values()) {
      if (
        other === spiderling || other.kind !== "mob" || other.archetypeKey !== spiderling.archetypeKey ||
        other.lifeState !== "alive" || other.targetEntityId !== target.entityId
      ) continue;
      if (distanceMeters(other.position, target.position) <= SPIDERLING_SWARM.radiusM) allies += 1;
    }
    return allies;
  }

  private processMobSpecials(): void {
    this.processAcidZones();
    this.pruneMobCasts();
    const expired: string[] = [];
    for (const mob of this.entities.values()) {
      if (mob.kind !== "mob" || mob.lifeState !== "alive" || this.pendingMobDefeats.has(mob.entityId)) continue;
      if (mob.special && mob.special.despawnAtTick > 0 && this.currentTick >= mob.special.despawnAtTick) {
        expired.push(mob.entityId);
        continue;
      }
      // Biome variants (frost_wolf, caiman, ...) run their family base's specials.
      const key = mob.archetypeKey === null ? null : mobBehaviorArchetype(mob.archetypeKey);
      if (mob.special?.strikeKind != null) this.resolveGimmickStrike(mob);
      if (mob.archetypeKey !== null && mobGimmickArchetype(mob.archetypeKey) === "ink_pool") this.processInkPoolDrift(mob);
      if (mob.archetypeKey !== null && mob.archetypeKey.endsWith("_gf") && this.processGolemForgeMob(mob)) continue;
      if (isRetreatingToGuard(mob.special)) {
        if (key === "spiderling") this.stepSpiderlingRetreat(mob);
        else if (key === "raptor_runt") this.stepRuntFlee(mob);
        else if (key === "cliff_hawk" || key === "ash_wyvern") this.stepHawkClimb(mob);
        else if (key === "magma_salamander") this.stepSalamanderSubmerged(mob);
        continue;
      }
      if (key === "cliff_hawk" || key === "ash_wyvern") {
        this.processHawk(mob);
        continue;
      }
      if (key === "drakeling" || key === "magma_salamander" || key === "lava_slime" || key === "drake_broodguard") {
        this.processWyrmHollowMob(mob, key);
        continue;
      }
      if (key !== null && MONASTERY_MOB_ARCHETYPES.has(key)) {
        this.processMonasteryMob(mob, key);
        continue;
      }
      if (key !== null && VAULT_MOB_ARCHETYPES.has(key)) {
        this.processVaultMob(mob, key);
        continue;
      }
      if (key === "blighted_stag") {
        this.processStag(mob, BLIGHTED_STAG);
        continue;
      }
      if (key === "hog" && !mob.npcFaction && !hasOwnGimmick(mob.archetypeKey)) {
        // Mob AI Phase 2: an archetype-managed mob charges through its signature; a charge already in flight still resolves.
        if (!this.isArchetypeManaged(mob) || mob.special?.chargeOrigin != null) {
          this.processStag(mob, isAnimalMob(mob.archetypeKey) ? HOG_CHARGE_ANIMAL : HOG_CHARGE);
        }
        continue;
      }
      if (key === "blight_treant") {
        this.processTreant(mob);
        continue;
      }
      if (
        key !== "sewer_spider" && key !== "dune_tick" && key !== "cave_bat" && key !== "nest_mouse" &&
        key !== "cave_raptor" && key !== "raptor_spitter" && key !== "thornfern" && key !== "blight_sprite" &&
        !hasShellGuard(mob.archetypeKey) && gimmickStrikeFor(mob.archetypeKey) === null
      ) continue;
      const target = mob.targetEntityId ? this.entities.get(mob.targetEntityId) : undefined;
      if (!target || target.kind !== "player" || target.lifeState !== "alive") continue;
      if (this.effectTotal(mob, "rooted") > 0) continue;
      if (key === "sewer_spider") this.processSpiderWeb(mob, target);
      else if (key === "cave_raptor") this.processRaptorFlank(mob, target);
      else if (key === "raptor_spitter") this.processSpitter(mob, target);
      else if (key === "thornfern") this.processThornfern(mob, target);
      else if (key === "blight_sprite") this.processSprite(mob, target);
      else if (hasShellGuard(mob.archetypeKey)) this.processCrabShell(mob, target);
      else if (gimmickStrikeFor(mob.archetypeKey) !== null) {
        // Mob AI Phase 2: archetype-managed mobs strike through their signature (a strike in flight still resolves above).
        if (!this.isArchetypeManaged(mob)) this.processGimmickStrike(mob, target);
      }
      else this.processFleaHop(mob, target);
    }
    for (const entityId of expired) this.despawnMob(entityId);
  }

  /**
   * Geode Golem and Gem Husk take no damage unless the attacker is a player whose active weapon carries a
   * gem enhancement (a gem-less metal infusion does not count); skills and procs ride on the same weapon.
   * Shows the "Immune" floating text, at most once a second per mob.
   */
  private golemForgeBlocksDamage(attacker: Combatant | undefined, target: Combatant): boolean {
    if (attacker?.entityId === target.entityId) return false;
    const dormant = target.archetypeKey === SENTINEL_STATUE.archetype && !this.golemForgeMobState(target).awake;
    const scriptedImmune = target.kind === "mob" && this.invulnerableMobs.has(target.entityId);
    if (!dormant && !scriptedImmune) {
      if (!isGemImmuneArchetype(target.archetypeKey)) return false;
      if (attacker?.kind === "player" && weaponCarriesGem(attacker.equipmentCombatState?.activeWeaponEnchantmentIdentity ?? null)) {
        return false;
      }
    }
    const state = this.golemForgeMobState(target);
    const now = this.now();
    if (now - state.lastImmuneFeedbackMs >= IMMUNE_FEEDBACK_INTERVAL_MS) {
      state.lastImmuneFeedbackMs = now;
      this.emitInnateEvent(target.entityId, target.entityId, "IMMUNE", "golem_forge_gem_immunity");
    }
    return true;
  }

  private golemForgeMobState(mob: Combatant): GolemForgeMobState {
    let state = this.golemForgeState.get(mob.entityId);
    if (!state) this.golemForgeState.set(mob.entityId, state = newGolemForgeMobState());
    return state;
  }

  /** Golem Forge behaviours that run every beat (golemForgeMobs.ts). True skips the template gimmicks this beat. */
  private processGolemForgeMob(mob: Combatant): boolean {
    if (mob.npcFaction) return false;
    if (mob.archetypeKey === GOLEM_FORGE_ARCHETYPES.slagCrawler) this.processSlagTrail(mob);
    if (mob.archetypeKey === SENTINEL_STATUE.archetype) return this.processSentinelWake(mob);
    if (mob.archetypeKey === "mender_golem_gf") this.processMenderHeal(mob);
    if (mob.archetypeKey === "golem_smith_gf") return this.processSmithRevive(mob);
    return false;
  }

  /** Mender Golem: every pulse it heals the hurt golems around it. */
  private processMenderHeal(mob: Combatant): void {
    const state = this.golemForgeMobState(mob);
    if (this.currentTick < state.nextHealTick) return;
    state.nextHealTick = this.currentTick + millisecondsToTicks(MENDER_HEAL.intervalMs, this.options.tickRateHz);
    for (const id of this.grid.query(mob.position, MENDER_HEAL.radiusM)) {
      const golem = this.entities.get(id);
      if (
        !golem || golem === mob || golem.kind !== "mob" || golem.lifeState !== "alive" || golem.zoneId !== mob.zoneId ||
        golem.archetypeKey === null || !GOLEM_ARCHETYPES.includes(golem.archetypeKey) ||
        golem.currentHealth >= golem.maxHealth ||
        distanceMeters(golem.position, mob.position) > MENDER_HEAL.radiusM
      ) continue;
      this.healMob(golem.entityId, golem.maxHealth * MENDER_HEAL.healFraction);
    }
  }

  /** Golem Smith: with a fresh golem corpse nearby it stops and channels to rebuild it; a hit breaks the channel. True while channelling. */
  private processSmithRevive(mob: Combatant): boolean {
    const state = this.golemForgeMobState(mob);
    const hz = this.options.tickRateHz;
    if (state.channelEndTick > 0) {
      if (this.currentTick < state.channelEndTick) return true;
      const rubble = state.channelRubble;
      state.channelEndTick = 0;
      state.channelRubble = null;
      if (rubble && this.golemRubble.includes(rubble)) {
        this.golemRubble = this.golemRubble.filter((entry) => entry !== rubble);
        this.reviveGolem(mob, rubble);
      }
      return false;
    }
    if (mob.targetEntityId === null || this.currentTick < state.nextChannelTick) return false;
    const cutoff = this.currentTick - millisecondsToTicks(SMITH_REVIVE.recentDeathMs, hz);
    const rubble = this.golemRubble.find((entry) =>
      entry.atTick >= cutoff && entry.zoneId === mob.zoneId &&
      distanceMeters(entry.position, mob.position) <= SMITH_REVIVE.radiusM);
    if (!rubble) return false;
    state.channelEndTick = this.currentTick + millisecondsToTicks(SMITH_REVIVE.channelMs, hz);
    state.channelRubble = rubble;
    state.nextChannelTick = state.channelEndTick + millisecondsToTicks(SMITH_REVIVE.cooldownMs, hz);
    this.holdMob(mob, mob, SMITH_REVIVE.channelMs, SMITH_REVIVE.techniqueId);
    this.addMobTelegraph(
      mob, SMITH_REVIVE.techniqueId, { kind: "circle", center: { ...rubble.position }, radiusM: MELEE_ATTACK_RANGE_M * 0.8 },
      SMITH_REVIVE.channelMs
    );
    return true;
  }

  /** A hit on a channelling Smith breaks the rebuild (and frees it). */
  private interruptSmithChannel(mob: Combatant): void {
    const state = this.golemForgeState.get(mob.entityId);
    if (!state || state.channelEndTick === 0) return;
    state.channelEndTick = 0;
    state.channelRubble = null;
    if (mob.classRuntime) {
      mob.classRuntime.effects = mob.classRuntime.effects.filter(
        (effect) => effect.id !== `${mob.entityId}:${SMITH_REVIVE.techniqueId}:rooted`
      );
    }
    this.mobSpecial(mob).stunUntilTick = 0;
    this.markDirty(mob);
  }

  private reviveGolem(smith: Combatant, rubble: GolemRubble): void {
    let id: string;
    try {
      id = this.spawnMob({
        archetype: rubble.archetype as MobArchetypeKey, position: rubble.position, homePosition: rubble.position,
        regionCode: rubble.regionCode, zoneId: rubble.zoneId, worldAi: smith.worldAi, summonedByEntityId: smith.entityId,
        noRewards: true
      }).entityId;
    } catch {
      return;
    }
    if (smith.targetEntityId) this.directMobTarget(id, smith.targetEntityId);
  }

  /** Spark Wisp: a basic hit also zaps up to two other players near the one it hit. */
  private applySparkChain(attacker: Combatant, target: Combatant): void {
    const victims = this.nearbyEntityIds(target.position, SPARK_CHAIN.radiusM)
      .map((id) => this.entities.get(id))
      .filter((entity): entity is Combatant => Boolean(
        entity && entity.kind === "player" && entity.lifeState === "alive" &&
        entity.entityId !== target.entityId && entity.zoneId === attacker.zoneId
      ))
      .sort((left, right) => distanceMeters(left.position, target.position) - distanceMeters(right.position, target.position))
      .slice(0, SPARK_CHAIN.maxTargets);
    for (const victim of victims) {
      this.applyScriptedDamage(
        attacker.entityId, victim.entityId, Math.max(1, Math.round(attacker.attackDamage * SPARK_CHAIN.damageFactor)),
        SPARK_CHAIN.techniqueId
      );
    }
  }

  /** Sentinel Statue: dormant until a player is within the wake radius (or it is dragged into a fight). True while dormant. */
  private processSentinelWake(mob: Combatant): boolean {
    const state = this.golemForgeMobState(mob);
    if (state.awake) {
      // Back home with its threat gone and nobody near: it falls dormant again.
      if (mob.targetEntityId !== null || distanceMeters(mob.position, mob.homePosition) > SENTINEL_HOME_RADIUS_M) return false;
      const watched = this.grid.query(mob.position, SENTINEL_STATUE.wakeRadiusM).some((id) => {
        const player = this.entities.get(id);
        return player?.kind === "player" && player.lifeState === "alive" && player.zoneId === mob.zoneId &&
          distanceMeters(player.position, mob.position) <= SENTINEL_STATUE.wakeRadiusM;
      });
      if (watched) return false;
      state.awake = false;
      this.markDirty(mob);
      return true;
    }
    let waker: Combatant | null = null;
    let nearestM = Number.POSITIVE_INFINITY;
    for (const id of this.grid.query(mob.position, SENTINEL_STATUE.wakeRadiusM)) {
      const player = this.entities.get(id);
      if (!player || player.kind !== "player" || player.lifeState !== "alive" || player.zoneId !== mob.zoneId) continue;
      const distanceM = distanceMeters(player.position, mob.position);
      if (distanceM <= SENTINEL_STATUE.wakeRadiusM && distanceM < nearestM) { waker = player; nearestM = distanceM; }
    }
    if (!waker && mob.targetEntityId === null) return true;
    state.awake = true;
    this.markDirty(mob);
    if (waker && mob.targetEntityId === null) this.directMobTarget(mob.entityId, waker.entityId);
    return false;
  }

  /** Slag Crawler: while fighting, it leaves short-lived burning puddles behind it as it moves. */
  private processSlagTrail(mob: Combatant): void {
    if (mob.targetEntityId === null) return;
    const state = this.golemForgeMobState(mob);
    if (state.lastTrailPosition === null) {
      state.lastTrailPosition = { ...mob.position };
      return;
    }
    const movedM = distanceMeters(mob.position, state.lastTrailPosition);
    if (!slagTrailDue(state.lastTrailTick, this.currentTick, millisecondsToTicks(SLAG_TRAIL.intervalMs, this.options.tickRateHz), movedM)) return;
    state.lastTrailTick = this.currentTick;
    state.lastTrailPosition = { ...mob.position };
    this.spawnDamageZone({
      ownerEntityId: mob.entityId, center: mob.position, radiusM: SLAG_TRAIL.radiusM,
      delayMs: SLAG_TRAIL.delayMs, durationMs: SLAG_TRAIL.durationMs,
      damage: mob.attackDamage * SLAG_TRAIL.damageFactor, techniqueId: SLAG_TRAIL.techniqueId
    });
  }

  /** Ink Pool: while it has a target it drifts to a random nearby spot every few seconds. */
  private processInkPoolDrift(mob: Combatant): void {
    const target = mob.targetEntityId ? this.entities.get(mob.targetEntityId) : undefined;
    if (!target || target.kind !== "player" || target.lifeState !== "alive") return;
    if (this.effectTotal(mob, "rooted") > 0 || this.hasEffect(mob, "immobilized")) return;
    const state = this.mobSpecial(mob);
    if (state.nextHopTick === 0) {
      state.nextHopTick = this.currentTick + millisecondsToTicks(INK_POOL_DRIFT.intervalMs, this.options.tickRateHz);
      return;
    }
    if (this.currentTick < state.nextHopTick) return;
    state.nextHopTick = this.currentTick + millisecondsToTicks(INK_POOL_DRIFT.intervalMs, this.options.tickRateHz);
    const roll = (): number => this.options.random?.() ?? Math.random();
    const distanceM = INK_POOL_DRIFT.minDistanceM + roll() * (INK_POOL_DRIFT.maxDistanceM - INK_POOL_DRIFT.minDistanceM);
    const destination = destinationPoint(mob.position, distanceM, roll() * 360);
    if (this.isMobHabitatStepAllowed(mob, destination)) this.placeMobAtFirstTraversable(mob, [destination]);
  }

  /**
   * Gate Warden: the first time it drops below half health it blinks away from its attacker and
   * leaves a rift at its old spot that calls a fixed number of Drowned Cultists. Once per life;
   * the cultists fade after a minute.
   */
  private processGateWardenRift(warden: Combatant, attacker: Combatant): void {
    const state = this.mobSpecial(warden);
    if (state.triggered || !belowHealthRatio(warden.currentHealth, warden.maxHealth, GATE_WARDEN_RIFT.healthRatio)) return;
    state.triggered = true;
    const rift = { ...warden.position };
    const away = destinationPoint(rift, GATE_WARDEN_RIFT.blinkDistanceM, initialBearingDegrees(attacker.position, rift));
    if (this.isMobHabitatStepAllowed(warden, away)) this.placeMobAtFirstTraversable(warden, [away]);
    this.addMobTelegraph(
      warden, GATE_WARDEN_RIFT.techniqueId,
      { kind: "circle", center: rift, radiusM: GATE_WARDEN_RIFT.riftRadiusM },
      GATE_WARDEN_RIFT.cultistLifetimeMs
    );
    const despawnAtTick = this.currentTick + millisecondsToTicks(GATE_WARDEN_RIFT.cultistLifetimeMs, this.options.tickRateHz);
    for (let index = 0; index < GATE_WARDEN_RIFT.cultists; index += 1) {
      const position = destinationPoint(rift, GATE_WARDEN_RIFT.spreadM, index * (360 / GATE_WARDEN_RIFT.cultists));
      if (!this.isMobPositionTraversable(position, warden.regionCode)) continue;
      let cultistId: string;
      try {
        cultistId = this.spawnMob({
          entityId: `${warden.entityId}:rift-cultist:${warden.lifeGeneration}:${index}`,
          archetype: GATE_WARDEN_RIFT_CULTIST[warden.archetypeKey ?? ""] ?? "drowned_cultist",
          position, homePosition: position,
          regionCode: warden.regionCode, zoneId: warden.zoneId, worldAi: warden.worldAi,
          summonedByEntityId: warden.entityId
        }).entityId;
      } catch {
        continue;
      }
      const cultist = this.entities.get(cultistId);
      if (!cultist) continue;
      this.mobSpecial(cultist).despawnAtTick = despawnAtTick;
      if (attacker.kind === "player" && attacker.lifeState === "alive") this.directMobTarget(cultistId, attacker.entityId);
    }
  }

  /** Opening web shot: roots a distant target, then the spider closes in to bite. */
  private processSpiderWeb(mob: Combatant, target: Combatant): void {
    const state = this.mobSpecial(mob);
    if (this.effectTotal(target, "rooted") > 0) return;
    if (!shouldWebTarget(state, distanceMeters(mob.position, target.position), this.currentTick)) return;
    if (!this.applyScriptedRoot(
      mob.entityId, target.entityId, SEWER_SPIDER_WEB.rootDurationMs, SEWER_SPIDER_WEB.techniqueId
    )) return;
    state.nextWebTick = this.currentTick +
      millisecondsToTicks(SEWER_SPIDER_WEB.cooldownMs, this.options.tickRateHz);
  }

  /** Hit and hop: leap beside the target while closing, hop away right after a bite (fleas and bats). */
  private processFleaHop(mob: Combatant, target: Combatant): void {
    const state = this.mobSpecial(mob);
    const profile: HopProfile = mob.archetypeKey === "cave_bat" ? CAVE_BAT_HOP
      : mob.archetypeKey === "nest_mouse" ? NEST_MOUSE_HOP : DUNE_TICK_HOP;
    const mode = state.hopAwayPending
      ? "away"
      : !this.isWithinMobAttackHoldRange(mob, target) &&
          fleaLeapDue(state, mob.position, target.position, this.currentTick, profile)
        ? "leap"
        : null;
    if (mode === null) return;
    state.hopAwayPending = false;
    if (this.placeMobAtFirstTraversable(mob, fleaHopCandidates(mode, mob.entityId, this.currentTick, mob.position, target.position, profile))) {
      state.nextHopTick = this.currentTick + millisecondsToTicks(profile.leapCooldownMs, this.options.tickRateHz);
      if (mode === "away") this.startChasing(mob);
    }
  }

  /** Moves a mob to the first traversable candidate point. */
  private placeMobAtFirstTraversable(mob: Combatant, candidates: readonly LatLon[]): boolean {
    for (const candidate of candidates) {
      if (!this.isMobPositionTraversable(candidate, mob.regionCode) || !this.isMobHabitatStepAllowed(mob, candidate)) continue;
      this.commitMobPhysicalPosition(mob, candidate);
      return true;
    }
    return false;
  }

  /** Scripted leap used by boss controllers; refuses non-traversable landings. */
  leapMobTo(entityId: string, position: LatLon): boolean {
    const mob = this.entities.get(entityId);
    if (!mob || mob.kind !== "mob" || mob.lifeState !== "alive" || isDisplacementImmune(mob.archetypeKey)) return false;
    return this.placeMobAtFirstTraversable(mob, [position]);
  }

  /** War roar: raptors in the zone hit harder for a while. Returns how many were buffed. */
  applyWarRoar(zoneId: string, durationMs: number): number {
    let buffed = 0;
    const untilTick = this.currentTick + millisecondsToTicks(durationMs, this.options.tickRateHz);
    for (const mob of this.entities.values()) {
      if (
        mob.kind !== "mob" || mob.lifeState !== "alive" || mob.zoneId !== zoneId ||
        !mob.archetypeKey || !RAPTOR_FAMILY.includes(mob.archetypeKey)
      ) continue;
      this.mobSpecial(mob).roarUntilTick = untilTick;
      buffed += 1;
    }
    return buffed;
  }

  /** Pack flanker: pounce into a spread slot around the target, and spread out when stacked. */
  private processRaptorFlank(mob: Combatant, target: Combatant): void {
    const state = this.mobSpecial(mob);
    if (this.currentTick < state.nextHopTick) return;
    const pack = [...this.entities.values()]
      .filter((other) => other.kind === "mob" && other.archetypeKey === "cave_raptor" &&
        other.lifeState === "alive" && other.targetEntityId === target.entityId && other.zoneId === mob.zoneId)
      .sort((left, right) => left.entityId.localeCompare(right.entityId));
    const index = pack.findIndex((other) => other.entityId === mob.entityId);
    if (index < 0) return;
    // A managed raptor pounces to its tactics slot, so the two systems never disagree (spec 2.6).
    const slot = this.mobTacticsSlotPosition(mob, target) ?? flankSlotPosition(index, pack.length, target.position);
    let cooldownMs: number | null = null;
    if (
      !this.isWithinMobAttackHoldRange(mob, target) &&
      distanceMeters(mob.position, target.position) > CAVE_RAPTOR_POUNCE.minDistanceM
    ) {
      cooldownMs = CAVE_RAPTOR_POUNCE.pounceCooldownMs;
    } else if (pack.some((other, otherIndex) => otherIndex < index &&
      distanceMeters(other.position, mob.position) < CAVE_RAPTOR_POUNCE.stackedDistanceM)) {
      cooldownMs = CAVE_RAPTOR_POUNCE.respreadCooldownMs;
    }
    if (cooldownMs === null || !this.placeMobAtFirstTraversable(mob, [slot])) return;
    state.nextHopTick = this.currentTick + millisecondsToTicks(cooldownMs, this.options.tickRateHz);
  }

  /** At low health a runt shrieks (idle raptors in the room join its attacker) and runs away. */
  private processRuntFlee(runt: Combatant, attacker: Combatant): void {
    if (runt.lifeState !== "alive") return;
    const state = this.mobSpecial(runt);
    if (!shouldRuntFlee(state, runt.currentHealth, runt.maxHealth)) return;
    state.fled = true;
    if (attacker.kind === "player" && attacker.lifeState === "alive") {
      this.callIdleAllies(runt, attacker, RAPTOR_FAMILY, RAPTOR_RUNT.shriekRadiusM);
      state.fleeDestination = runtFleeDestination(runt.position, attacker.position);
    } else {
      return;
    }
    this.disengageMobForRetreat(runt);
    this.resolveV3Provoke(runt, attacker);
  }

  /**
   * Provoke: when a mob truly starts fleeing within range of a player who knows it, that player may
   * turn it around into an attacker (and weaken its Defense). The attacker is preferred when eligible.
   */
  private resolveV3Provoke(mob: Combatant, attacker: Combatant): void {
    if (mob.kind !== "mob" || mob.lifeState !== "alive") return;
    const candidates = [attacker, ...this.nearbyEntityIds(mob.position, V3_PROVOKE_RANGE_M).map((id) => this.entities.get(id))]
      .filter((entity, index, all): entity is Combatant => Boolean(
        entity && entity.kind === "player" && entity.lifeState === "alive" &&
        all.indexOf(entity) === index &&
        (entity.classRuntime?.skillV3?.generalSkillRanks.provoke ?? 0) > 0 &&
        distanceMeters(entity.position, mob.position) <= V3_PROVOKE_RANGE_M
      ))
      .sort((left, right) =>
        Number(right.entityId === attacker.entityId) - Number(left.entityId === attacker.entityId) ||
        distanceMeters(left.position, mob.position) - distanceMeters(right.position, mob.position) ||
        left.entityId.localeCompare(right.entityId)
      );
    for (const player of candidates) {
      const rank = player.classRuntime?.skillV3?.generalSkillRanks.provoke ?? 0;
      const chance = rank >= 3 ? 1 : rank >= 2 ? 0.70 : 0.45;
      if (chance < 1 && (this.options.random?.() ?? Math.random()) >= chance) continue;
      const state = this.mobSpecial(mob);
      state.fleeDestination = null;
      state.returnTargetId = null;
      mob.activityState = "idle";
      if (!this.directMobTarget(mob.entityId, player.entityId)) continue;
      if (rank >= 2) this.addTimedEffect(player, mob, "provoke_exposure", "v3_general_provoke", V3_PROVOKE_DEBUFF_MS, flatRankValue(PROVOKE_DEFENSE_DEBUFF_BY_RANK, rank));
      this.markDirty(mob);
      return;
    }
  }

  /** Aggro link: idle allies of the given kinds in the caller's room join the attacker. */
  private callIdleAllies(caller: Combatant, attacker: Combatant, archetypes: readonly string[], radiusM: number): number {
    let called = 0;
    for (const other of this.entities.values()) {
      if (
        other === caller || other.kind !== "mob" || other.lifeState !== "alive" ||
        !other.archetypeKey || !archetypes.includes(other.archetypeKey) ||
        other.zoneId !== caller.zoneId || other.targetEntityId !== null ||
        distanceMeters(other.position, caller.position) > radiusM
      ) continue;
      if (this.directMobTarget(other.entityId, attacker.entityId)) called += 1;
    }
    return called;
  }

  /** The first time a carrion chick is hurt it screeches and idle cliff hawks in the room join its attacker. */
  private processChickScreech(chick: Combatant, attacker: Combatant): void {
    if (chick.lifeState !== "alive") return;
    const state = this.mobSpecial(chick);
    if (!shouldScreech(state)) return;
    state.screeched = true;
    if (attacker.kind === "player" && attacker.lifeState === "alive") {
      this.callIdleAllies(chick, attacker, ["cliff_hawk"], CARRION_SCREECH_RADIUS_M);
    }
  }

  /**
   * Cliff hawk: circles at range, then every ~7s picks a dive point on its target. After a short delay it
   * slams that spot for big damage, then climbs away; while climbing it is out of reach (retreat state).
   */
  private processHawk(mob: Combatant): void {
    const state = this.mobSpecial(mob);
    if (state.diveCenter !== null) {
      if (this.currentTick < state.diveHitTick) return;
      const center = state.diveCenter;
      state.diveCenter = null;
      this.placeMobAtFirstTraversable(mob, [center]);
      const damage = Math.max(1, Math.round(mob.attackDamage * CLIFF_HAWK.diveDamageFactor));
      for (const id of [...this.grid.query(center, CLIFF_HAWK.diveRadiusM)]) {
        const victim = this.entities.get(id);
        if (!victim || victim.kind !== "player" || victim.lifeState !== "alive" || victim.zoneId !== mob.zoneId) continue;
        if (distanceMeters(victim.position, center) > CLIFF_HAWK.diveRadiusM) continue;
        this.applyScriptedDamage(mob.entityId, victim.entityId, damage, CLIFF_HAWK.techniqueId);
        if (mob.archetypeKey === "ash_wyvern") this.knockbackPlayer(victim.entityId, center, ASH_WYVERN.knockbackM);
      }
      state.climbing = true;
      state.climbUntilTick = this.currentTick + millisecondsToTicks(CLIFF_HAWK.climbMs, this.options.tickRateHz);
      this.disengageMobForRetreat(mob);
      state.fleeDestination = hawkClimbDestination(mob.position, center, 90);
      return;
    }
    const target = mob.targetEntityId ? this.entities.get(mob.targetEntityId) : undefined;
    if (!target || target.kind !== "player" || target.lifeState !== "alive" || this.effectTotal(mob, "rooted") > 0) return;
    const distanceM = distanceMeters(mob.position, target.position);
    if (hawkKeepsRange(state, distanceM, this.currentTick)) {
      if (this.placeMobAtFirstTraversable(mob, [spitterBackoffDestination(mob.position, target.position)])) {
        state.nextBackoffTick = this.currentTick + millisecondsToTicks(RAPTOR_SPITTER.backoffCooldownMs, this.options.tickRateHz);
      }
      return;
    }
    if (!shouldStartHawkDive(state, distanceM, mob.attackRangeM, this.currentTick)) return;
    state.diveCenter = { ...target.position };
    state.diveTargetId = target.entityId;
    state.diveHitTick = this.currentTick + millisecondsToTicks(CLIFF_HAWK.diveDelayMs, this.options.tickRateHz);
    this.addMobTelegraph(mob, CLIFF_HAWK.techniqueId, { kind: "circle", center: { ...target.position }, radiusM: CLIFF_HAWK.diveRadiusM }, CLIFF_HAWK.diveDelayMs);
    state.nextDiveTick = this.currentTick + millisecondsToTicks(CLIFF_HAWK.diveIntervalMs, this.options.tickRateHz);
  }

  private stepHawkClimb(mob: Combatant): void {
    const state = this.mobSpecial(mob);
    if (this.currentTick >= state.climbUntilTick) {
      state.climbing = false;
      state.fleeDestination = null;
      mob.activityState = "idle";
      this.markDirty(mob);
      if (state.diveTargetId) this.directMobTarget(mob.entityId, state.diveTargetId);
      return;
    }
    this.stepRuntFlee(mob);
  }

  /** Server-authoritative push: slides a player away from `from`, shortening the push until the room accepts the spot. */
  knockbackPlayer(playerEntityId: string, from: LatLon, distanceM: number): boolean {
    const player = this.entities.get(playerEntityId);
    if (!player || player.kind !== "player" || player.lifeState !== "alive" || !this.options.repositionPlayer) return false;
    const bearing = initialBearingDegrees(from, player.position);
    // The push stops at the last spot the path to it allows: shorten in eighths until the room accepts it.
    for (const fraction of [1, 0.875, 0.75, 0.625, 0.5, 0.375, 0.25, 0.125]) {
      const push = distanceM * fraction;
      const destination = destinationPoint(player.position, push, bearing);
      if (!this.options.repositionPlayer(player.entityId, destination, push + 50, true)) continue;
      this.grid.update(player.entityId, destination);
      player.position = { ...destination };
      this.markDirty(player);
      return true;
    }
    return false;
  }

  private stepRuntFlee(mob: Combatant, speedFactor = 1): void {
    const state = this.mobSpecial(mob);
    const destination = state.fleeDestination;
    if (!destination) return;
    const stepM = this.effectiveMobMovementSpeedMps(mob) * speedFactor / this.options.tickRateHz;
    const remainingM = distanceMeters(mob.position, destination);
    const next = remainingM <= stepM ? destination : moveToward(mob.position, destination, stepM);
    const allowed = this.isMobPositionTraversable(next, mob.regionCode) && this.isMobHabitatStepAllowed(mob, next);
    if (!allowed || remainingM <= stepM) {
      state.fleeDestination = null;
      mob.activityState = "idle";
      if (remainingM <= stepM && allowed) this.commitMobPhysicalPosition(mob, next);
      this.markDirty(mob);
      return;
    }
    this.commitMobPhysicalPosition(mob, next);
    mob.activityState = "fleeing";
  }

  /** Keeps its range: backs away when meleed and spits acid that leaves a short damage zone. */
  private processSpitter(mob: Combatant, target: Combatant): void {
    const state = this.mobSpecial(mob);
    const distanceM = distanceMeters(mob.position, target.position);
    if (shouldSpitterBackOff(state, distanceM, this.currentTick)) {
      const away = spitterBackoffDestination(mob.position, target.position);
      if (this.placeMobAtFirstTraversable(mob, [away])) {
        state.nextBackoffTick = this.currentTick +
          millisecondsToTicks(RAPTOR_SPITTER.backoffCooldownMs, this.options.tickRateHz);
      }
      return;
    }
    if (!shouldSpit(state, distanceM, mob.attackRangeM, this.currentTick)) return;
    const landTick = this.currentTick + millisecondsToTicks(RAPTOR_SPITTER.zoneDelayMs, this.options.tickRateHz);
    this.acidZones.push({
      sourceEntityId: mob.entityId,
      center: { ...target.position },
      landTick,
      endTick: landTick + millisecondsToTicks(RAPTOR_SPITTER.zoneDurationMs, this.options.tickRateHz),
      nextTick: landTick,
      damage: Math.max(1, Math.round(mob.attackDamage * RAPTOR_SPITTER.zoneDamageFactor))
    });
    // The warning stays up as the hazard marker for the whole life of the acid puddle.
    this.addMobTelegraph(
      mob, RAPTOR_SPITTER.techniqueId,
      { kind: "circle", center: { ...target.position }, radiusM: RAPTOR_SPITTER.zoneRadiusM },
      RAPTOR_SPITTER.zoneDelayMs + RAPTOR_SPITTER.zoneDurationMs
    );
    state.nextSpitTick = this.currentTick + millisecondsToTicks(RAPTOR_SPITTER.spitIntervalMs, this.options.tickRateHz);
  }

  /** Lingering poison cloud: lands after delayMs, then ticks damage and poison for durationMs. */
  spawnPoisonCloud(
    sourceEntityId: string,
    center: LatLon,
    radiusM: number,
    delayMs: number,
    durationMs: number,
    damage: number,
    techniqueId: string
  ): boolean {
    return this.spawnDamageZone({
      ownerEntityId: sourceEntityId, center, radiusM, delayMs, durationMs, damage, techniqueId,
      poison: true, telegraph: false
    });
  }

  /**
   * Timed ground damage zone for mobs and bosses: after delayMs it hurts every living player standing in
   * radiusM, once per design second (damage is per design second), until durationMs has passed. The zone
   * outlives its owner (a death burst). By default the client gets a circle telegraph that stays up for
   * the whole life of the zone.
   */
  spawnDamageZone(input: Readonly<{
    ownerEntityId: string;
    center: LatLon;
    radiusM: number;
    delayMs: number;
    durationMs: number;
    damage: number;
    techniqueId: string;
    poison?: boolean;
    slow?: Readonly<{ durationMs: number; amount: number }>;
    telegraph?: boolean;
  }>): boolean {
    const owner = this.entities.get(input.ownerEntityId);
    if (!owner) return false;
    const landTick = this.currentTick + millisecondsToTicks(input.delayMs, this.options.tickRateHz);
    this.acidZones.push({
      sourceEntityId: input.ownerEntityId, center: { ...input.center }, landTick,
      ...(owner.zoneId ? { zoneId: owner.zoneId } : {}),
      endTick: landTick + millisecondsToTicks(input.durationMs, this.options.tickRateHz),
      nextTick: landTick, damage: Math.max(1, Math.round(input.damage)), radiusM: input.radiusM,
      techniqueId: input.techniqueId,
      ...(input.poison ? { poison: true } : {}),
      ...(input.slow ? { slow: { ...input.slow } } : {})
    });
    if (input.telegraph !== false) {
      this.addMobTelegraph(
        owner, input.techniqueId, { kind: "circle", center: { ...input.center }, radiusM: input.radiusM },
        input.delayMs + input.durationMs
      );
    }
    return true;
  }

  /** Heals a living mob (used by boss controllers); showFloater sends the green heal number to clients. */
  healMob(entityId: string, amount: number, showFloater = false): number {
    const mob = this.entities.get(entityId);
    if (!mob || mob.kind !== "mob" || mob.lifeState !== "alive" || mob.undead || !(amount > 0)) return 0;
    const healed = Math.min(mob.maxHealth - mob.currentHealth, Math.round(amount));
    if (healed <= 0) return 0;
    mob.currentHealth += healed;
    this.markDirty(mob);
    if (showFloater) this.emitEvent("HEAL", mob.entityId, mob.entityId, healed, mob.currentHealth);
    return healed;
  }

  /** A scripted mob that never deals damage (walking hammers, dormant husks): stunned for good, or woken with inert = false. */
  setMobInert(entityId: string, inert = true): boolean {
    const mob = this.entities.get(entityId);
    if (!mob || mob.kind !== "mob" || mob.lifeState !== "alive") return false;
    this.mobSpecial(mob).stunUntilTick = inert ? Number.MAX_SAFE_INTEGER : 0;
    this.markDirty(mob);
    return true;
  }

  /** Takes no damage while set (shows "Immune"): dormant Corrupted Husks and the possessing Core. */
  setMobInvulnerable(entityId: string, invulnerable: boolean): boolean {
    const mob = this.entities.get(entityId);
    if (!mob || mob.kind !== "mob" || mob.lifeState !== "alive") return false;
    if (invulnerable) this.invulnerableMobs.add(entityId);
    else this.invulnerableMobs.delete(entityId);
    return true;
  }

  /** The mob's own basic attacks land nothing; boss-scripted damage and damage zones it owns still do. */
  setMobPassive(entityId: string, passive: boolean): boolean {
    const mob = this.entities.get(entityId);
    if (!mob || mob.kind !== "mob" || mob.lifeState !== "alive") return false;
    if (passive) this.passiveMobs.add(entityId);
    else this.passiveMobs.delete(entityId);
    return true;
  }

  /** Flags the mob "awake": the client swaps its dormant art for the awake art (Sentinel Statue, Corrupted Husk). */
  setMobAwake(entityId: string, awake: boolean): boolean {
    const mob = this.entities.get(entityId);
    if (!mob || mob.kind !== "mob" || mob.lifeState !== "alive") return false;
    this.golemForgeMobState(mob).awake = awake;
    this.markDirty(mob);
    return true;
  }

  /** Stuns a player: held in place (no walking) for durationMs. */
  stunPlayer(sourceEntityId: string, playerEntityId: string, durationMs: number, sourceTechniqueId: string): boolean {
    const source = this.entities.get(sourceEntityId);
    const player = this.entities.get(playerEntityId);
    if (
      !source || source.kind !== "mob" || source.lifeState !== "alive" ||
      !player || player.kind !== "player" || player.lifeState !== "alive" ||
      this.flagArrivalProtectionUntil(player.entityId) !== null ||
      !Number.isFinite(durationMs) || durationMs <= 0
    ) return false;
    this.addTimedEffect(source, player, "immobilized", sourceTechniqueId, durationMs, 1);
    this.options.stopPlayer?.(player.entityId);
    return true;
  }

  /** The mob that summoned this one, or null for an ordinary spawn. */
  summonerOf(entityId: string): string | null {
    return this.entities.get(entityId)?.summonedByEntityId ?? null;
  }

  /** Living mobs in a zone that were summoned by any of the given mobs. */
  livingSummonedMobIds(zoneId: string, summonerIds: ReadonlySet<string>): string[] {
    const ids: string[] = [];
    if (summonerIds.size === 0) return ids;
    for (const mob of this.entities.values()) {
      if (mob.kind === "mob" && mob.lifeState === "alive" && mob.zoneId === zoneId &&
          mob.summonedByEntityId !== undefined && summonerIds.has(mob.summonedByEntityId)) ids.push(mob.entityId);
    }
    return ids;
  }

  /** Living mobs of one archetype in a room. */
  livingMobIds(zoneId: string, archetype: string): string[] {
    const ids: string[] = [];
    for (const mob of this.entities.values()) {
      if (mob.kind === "mob" && mob.lifeState === "alive" && mob.zoneId === zoneId && mob.archetypeKey === archetype) ids.push(mob.entityId);
    }
    return ids;
  }

  private processStag(mob: Combatant, profile: ChargeProfile): void {
    const state = this.mobSpecial(mob);
    if (state.chargeOrigin !== null) {
      if (this.currentTick < state.chargeHitTick || this.now() < state.chargeResolveAt) return;
      const origin = state.chargeOrigin;
      state.chargeOrigin = null;
      const damage = Math.max(1, Math.round(mob.attackDamage * profile.damageFactor));
      // The charging body sweeps a capsule (profile.widthM each side) along the drawn lane; any hurt circle it touches
      // is hit. The whole path is tested at once, so nobody slips between samples.
      const laneM = hurtShapeReachM(state.chargeLengthM, PLAYER_HURT_RADIUS_M);
      const bearingRad = (state.chargeBearing * Math.PI) / 180;
      const endX = Math.sin(bearingRad) * laneM;
      const endY = Math.cos(bearingRad) * laneM;
      const cosLat = Math.cos((origin.lat * Math.PI) / 180);
      const local = this.signatureHitLocal;
      let hits = 0;
      for (const victim of [...this.entities.values()]) {
        if (victim.kind !== "player" || victim.lifeState !== "alive" || victim.zoneId !== mob.zoneId) continue;
        toLocalMeters(origin.lat, origin.lon, cosLat, victim.position.lat, victim.position.lon, local);
        if (!circleVsSegment(0, 0, endX, endY, profile.widthM, local.x, local.y, this.hurtRadiusM(victim))) continue;
        // A dash through the lane is a dodge: no hit, no knockback, and the miss stagger still applies.
        if (this.options.isEntityInvulnerable?.(victim.entityId)) continue;
        hits += 1;
        this.applyScriptedDamage(mob.entityId, victim.entityId, damage, profile.techniqueId);
        this.knockbackPlayer(victim.entityId, origin, profile.knockbackM);
      }
      this.placeMobAtFirstTraversable(mob, [destinationPoint(origin, state.chargeLengthM, state.chargeBearing)]);
      if (profile.techniqueId !== BLIGHTED_STAG.techniqueId) {
        this.applyStrikeAftermath(mob, hits > 0);
      } else if (hits === 0) {
        state.stunUntilTick = this.currentTick + millisecondsToTicks(profile.missStunMs, this.options.tickRateHz);
        this.addTimedEffect(mob, mob, "rooted", `${profile.techniqueId}_stun`, profile.missStunMs, 1);
      }
      return;
    }
    const target = mob.targetEntityId ? this.entities.get(mob.targetEntityId) : undefined;
    if (!target || target.kind !== "player" || target.lifeState !== "alive" || this.effectTotal(mob, "rooted") > 0) return;
    const distanceM = distanceMeters(mob.position, target.position);
    if (!shouldStagCharge(state, distanceM, this.currentTick, profile)) return;
    state.chargeOrigin = { ...mob.position };
    state.chargeBearing = initialBearingDegrees(mob.position, target.position);
    state.chargeLengthM = chargeLengthTo(distanceM, profile);
    state.chargeResolveAt = this.addMobTelegraph(
      mob, profile.techniqueId,
      {
        kind: "line", origin: { ...mob.position }, facingDegrees: state.chargeBearing,
        lengthM: hurtShapeReachM(state.chargeLengthM, PLAYER_HURT_RADIUS_M), widthM: profile.widthM * 2
      },
      profile.telegraphMs
    );
    state.chargeHitTick = this.currentTick + millisecondsToTicks(profile.telegraphMs, this.options.tickRateHz);
    state.nextChargeTick = this.currentTick + millisecondsToTicks(profile.chargeIntervalMs, this.options.tickRateHz);
  }

  /** Turns damage reflection on (fraction of the blocked hit) or off for a mob; used by the Grandmaster's Crane glow. */
  setMobDamageReflect(entityId: string, fraction: number | null): void {
    if (fraction === null || !(fraction > 0)) this.damageReflect.delete(entityId);
    else this.damageReflect.set(entityId, fraction);
  }

  /** True when the player carries a weapon inside the Monastery of the Still Hand (their hits deal nothing). */
  private isArmedInMonastery(player: Combatant): boolean {
    if (!isStillHandMonasteryZone(player.zoneId)) return false;
    const runtime = player.classRuntime;
    const family = equipmentGameplayFamily(runtime?.weaponDefinitionId ?? null) ?? runtime?.weaponCategory ?? null;
    return family !== null && !MONASTERY_MARTIAL_WEAPON_FAMILIES.has(family);
  }

  /** Learned general skill rank, raised to the Monastery's granted rank while the player fights inside it. */
  private generalRankInZone(entity: Combatant, skillId: keyof typeof STILL_HAND_GRANTED_SKILL_RANKS): number {
    const learned = entity.classRuntime?.skillV3?.generalSkillRanks[skillId] ?? 0;
    return entity.kind === "player" && isStillHandMonasteryZone(entity.zoneId)
      ? Math.max(learned, STILL_HAND_GRANTED_SKILL_RANKS[skillId])
      : learned;
  }

  private monasteryState(mob: Combatant): MonasteryMobState {
    return mob.monastery ?? (mob.monastery = newMonasteryMobState());
  }

  private nearestLivingPlayerM(mob: Combatant): number | null {
    let nearest: number | null = null;
    for (const other of this.entities.values()) {
      if (other.kind !== "player" || other.lifeState !== "alive" || other.zoneId !== mob.zoneId) continue;
      const distanceM = distanceMeters(other.position, mob.position);
      if (nearest === null || distanceM < nearest) nearest = distanceM;
    }
    return nearest;
  }

  /** Telegraphed signatures for the Monastery mobs (the monk's finisher is started from its landed hits). */
  private processMonasteryMob(mob: Combatant, key: string): void {
    const state = this.monasteryState(mob);
    const hz = this.options.tickRateHz;
    if (state.strikeKind !== null) {
      this.resolveMonasteryStrike(mob, state);
      return;
    }
    if (key === "iron_statue" && !state.awake) {
      if (shouldAwaken(state, this.nearestLivingPlayerM(mob), false)) this.awakenStatue(mob);
      else if (this.effectTotal(mob, "rooted") <= 0) this.addTimedEffect(mob, mob, "rooted", IRON_STATUE.dormantId, 1_000, 1);
      return;
    }
    const target = mob.targetEntityId ? this.entities.get(mob.targetEntityId) : undefined;
    if (!target || target.kind !== "player" || target.lifeState !== "alive" || this.effectTotal(mob, "rooted") > 0) return;
    const distanceM = distanceMeters(mob.position, target.position);
    const begin = (kind: "sweep" | "slam" | "toll", telegraphMs: number, radiusM: number, intervalMs: number): void => {
      state.strikeKind = kind;
      state.strikeTick = this.currentTick + millisecondsToTicks(telegraphMs, hz);
      state.strikeCenter = { ...mob.position };
      state.strikeTargetId = target.entityId;
      state.nextStrikeTick = this.currentTick + millisecondsToTicks(intervalMs, hz);
      this.addMobTelegraph(mob, `${key}_${kind}`, { kind: "circle", center: { ...mob.position }, radiusM }, telegraphMs);
    };
    if (key === "staff_adept") {
      if (state.nextStrikeTick === 0) state.nextStrikeTick = this.currentTick + millisecondsToTicks(STAFF_ADEPT_SWEEP.firstDelayMs, hz);
      if (this.currentTick < state.nextStrikeTick || distanceM > STAFF_ADEPT_SWEEP.triggerRangeM) return;
      begin("sweep", STAFF_ADEPT_SWEEP.telegraphMs, STAFF_ADEPT_SWEEP.radiusM, STAFF_ADEPT_SWEEP.intervalMs);
    } else if (key === "iron_statue") {
      if (this.currentTick < state.nextStrikeTick || distanceM > IRON_STATUE.slamTriggerRangeM) return;
      begin("slam", IRON_STATUE.telegraphMs, IRON_STATUE.radiusM, IRON_STATUE.slamIntervalMs);
    } else if (key === "bell_spirit") {
      if (state.nextStrikeTick === 0) state.nextStrikeTick = this.currentTick + millisecondsToTicks(BELL_SPIRIT_TOLL.firstDelayMs, hz);
      if (this.currentTick < state.nextStrikeTick || distanceM > BELL_SPIRIT_TOLL.triggerRangeM) return;
      begin("toll", BELL_SPIRIT_TOLL.telegraphMs, BELL_SPIRIT_TOLL.radiusM, BELL_SPIRIT_TOLL.intervalMs);
    }
  }

  private resolveMonasteryStrike(mob: Combatant, state: MonasteryMobState): void {
    const kind = state.strikeKind;
    const center = state.strikeCenter;
    if (kind === null || this.currentTick < state.strikeTick) return;
    state.strikeKind = null;
    state.strikeCenter = null;
    if (!center) return;
    const attack = mob.attackDamage;
    for (const victim of [...this.entities.values()]) {
      if (victim.kind !== "player" || victim.lifeState !== "alive" || victim.zoneId !== mob.zoneId) continue;
      const distanceM = distanceMeters(victim.position, center);
      if (kind === "finisher") {
        if (distanceM > INITIATE_MONK_COMBO.rangeM) continue;
        const diff = Math.abs(((initialBearingDegrees(center, victim.position) - state.strikeBearing + 540) % 360) - 180);
        if (diff > INITIATE_MONK_COMBO.angleDegrees / 2 && distanceM > 1) continue;
        this.applyScriptedDamage(mob.entityId, victim.entityId, attack * INITIATE_MONK_COMBO.damageFactor, INITIATE_MONK_COMBO.techniqueId);
        this.knockbackPlayer(victim.entityId, center, INITIATE_MONK_COMBO.knockbackM);
      } else if (kind === "sweep") {
        if (distanceM > STAFF_ADEPT_SWEEP.radiusM) continue;
        this.applyScriptedDamage(mob.entityId, victim.entityId, attack * STAFF_ADEPT_SWEEP.damageFactor, STAFF_ADEPT_SWEEP.techniqueId);
      } else if (kind === "slam") {
        if (distanceM > IRON_STATUE.radiusM) continue;
        this.applyScriptedDamage(mob.entityId, victim.entityId, attack * IRON_STATUE.damageFactor, IRON_STATUE.techniqueId);
        this.knockbackPlayer(victim.entityId, center, IRON_STATUE.knockbackM);
      } else {
        if (distanceM > BELL_SPIRIT_TOLL.radiusM) continue;
        this.applyScriptedDamage(mob.entityId, victim.entityId, attack * BELL_SPIRIT_TOLL.damageFactor, BELL_SPIRIT_TOLL.techniqueId);
        this.silencePlayer(victim, BELL_SPIRIT_TOLL.silenceMs);
      }
    }
    if (kind === "sweep") {
      // After the sweep the adept dashes onto its target.
      const target = state.strikeTargetId ? this.entities.get(state.strikeTargetId) : undefined;
      if (target?.kind === "player" && target.lifeState === "alive" && target.zoneId === mob.zoneId &&
          this.placeMobAtFirstTraversable(mob, [dashStop(mob.position, target.position)])) this.markDirty(mob);
    }
  }

  // ---- Tilted Vault story mobs (vaultBehaviors.ts) ----

  private vaultState(mob: Combatant): VaultMobState {
    return mob.vault ?? (mob.vault = newVaultMobState());
  }

  /** Ember Wail ward: the Shade takes no damage from anyone else while it holds; "Immune" shows at most once a second. */
  private vaultWardBlocksDamage(attacker: Combatant | undefined, target: Combatant): boolean {
    if (attacker?.entityId === target.entityId || !target.vault || !isVaultWarded(target.vault, this.currentTick)) return false;
    const now = this.now();
    if (now - target.vault.lastImmuneFeedbackMs >= IMMUNE_FEEDBACK_INTERVAL_MS) {
      target.vault.lastImmuneFeedbackMs = now;
      this.emitInnateEvent(target.entityId, target.entityId, "IMMUNE", EMBER_SHADE_WAIL.techniqueId);
    }
    return true;
  }

  /** Telegraphed moves for the Tilted Vault mobs. The Warden's heartbeat ring keeps travelling while it fights on. */
  private processVaultMob(mob: Combatant, key: string): void {
    const state = this.vaultState(mob);
    const ticks = (ms: number): number => millisecondsToTicks(ms, this.options.tickRateHz);
    if (state.pulse) this.advanceVaultHeartbeat(mob, state);
    if (state.heartbeatWindupTick > 0) {
      if (this.currentTick >= state.heartbeatWindupTick) this.launchVaultHeartbeat(mob, state);
      return;
    }
    if (state.strikeKind !== null) {
      this.resolveVaultStrike(mob, state);
      return;
    }
    const target = mob.targetEntityId ? this.entities.get(mob.targetEntityId) : undefined;
    if (
      !target || target.kind !== "player" || target.lifeState !== "alive" || target.zoneId !== mob.zoneId ||
      this.effectTotal(mob, "rooted") > 0
    ) return;
    const seed = (field: "nextPrimaryTick" | "nextSecondaryTick", firstDelayMs: number): void => {
      if (state[field] === 0) state[field] = this.currentTick + ticks(firstDelayMs);
    };
    if (key === "ember_shade") {
      seed("nextPrimaryTick", EMBER_SHADE_GRASP.firstDelayMs);
      seed("nextSecondaryTick", EMBER_SHADE_WAIL.firstDelayMs);
    } else if (key === "ashbound_revenant") {
      seed("nextPrimaryTick", REVENANT_DOUBLE_STRIKE.firstDelayMs);
      seed("nextSecondaryTick", REVENANT_FLANK_LUNGE.firstDelayMs);
    } else {
      seed("nextPrimaryTick", WARDEN_STRIKES.firstDelayMs);
      seed("nextSecondaryTick", WARDEN_HEARTBEAT.firstDelayMs);
    }
    if (this.currentTick < state.nextStrikeTick) return;
    const distanceM = distanceMeters(mob.position, target.position);
    const bearing = initialBearingDegrees(mob.position, target.position);
    const origin = { ...mob.position };
    const primaryReady = this.currentTick >= state.nextPrimaryTick;
    const secondaryReady = this.currentTick >= state.nextSecondaryTick;
    if (key === "ember_shade") {
      if (secondaryReady && distanceM <= EMBER_SHADE_WAIL.triggerRangeM) {
        state.nextSecondaryTick = this.currentTick + ticks(EMBER_SHADE_WAIL.intervalMs);
        this.beginVaultStrike(mob, state, target, "wail", EMBER_SHADE_WAIL.telegraphMs, EMBER_SHADE_WAIL.techniqueId,
          { kind: "circle", center: origin, radiusM: EMBER_SHADE_WAIL.radiusM });
      } else if (primaryReady && distanceM <= EMBER_SHADE_GRASP.triggerRangeM) {
        state.nextPrimaryTick = this.currentTick + ticks(EMBER_SHADE_GRASP.intervalMs);
        this.beginVaultStrike(mob, state, target, "grasp", EMBER_SHADE_GRASP.telegraphMs, EMBER_SHADE_GRASP.techniqueId, {
          kind: "cone", origin, facingDegrees: bearing, rangeM: EMBER_SHADE_GRASP.rangeM, angleDegrees: EMBER_SHADE_GRASP.angleDegrees
        }, bearing);
      }
    } else if (key === "ashbound_revenant") {
      if (
        secondaryReady && distanceM >= REVENANT_FLANK_LUNGE.minRangeM && distanceM <= REVENANT_FLANK_LUNGE.maxRangeM &&
        mayFlankLunge(mob.entityId, target.entityId, this.vaultRevenantsAround(mob, target))
      ) {
        state.nextSecondaryTick = this.currentTick + ticks(REVENANT_FLANK_LUNGE.intervalMs);
        const lengthM = vaultLaneLengthM(distanceM, REVENANT_FLANK_LUNGE);
        this.beginVaultStrike(mob, state, target, "lunge", REVENANT_FLANK_LUNGE.telegraphMs, REVENANT_FLANK_LUNGE.techniqueId, {
          kind: "line", origin, facingDegrees: bearing, lengthM, widthM: REVENANT_FLANK_LUNGE.widthM
        }, bearing, lengthM);
      } else if (primaryReady && distanceM <= REVENANT_DOUBLE_STRIKE.triggerRangeM) {
        state.nextPrimaryTick = this.currentTick + ticks(REVENANT_DOUBLE_STRIKE.intervalMs);
        this.beginVaultStrike(mob, state, target, "double_a", REVENANT_DOUBLE_STRIKE.telegraphMs[0],
          REVENANT_DOUBLE_STRIKE.techniqueIds[0], {
            kind: "cone", origin, facingDegrees: bearing,
            rangeM: REVENANT_DOUBLE_STRIKE.rangeM, angleDegrees: REVENANT_DOUBLE_STRIKE.angleDegrees
          }, bearing);
      }
    } else if (secondaryReady) {
      // The heartbeat reaches the whole room, so it needs no range check.
      state.nextSecondaryTick = this.currentTick + ticks(WARDEN_HEARTBEAT.intervalMs);
      state.heartbeatWindupTick = this.currentTick + ticks(WARDEN_HEARTBEAT.windupMs);
      state.heartbeatCenter = origin;
      state.nextStrikeTick = state.heartbeatWindupTick + ticks(VAULT_MOVE_GAP_MS);
      this.addMobTelegraph(mob, WARDEN_HEARTBEAT.windupId,
        { kind: "circle", center: { ...origin }, radiusM: WARDEN_HEARTBEAT.windupRadiusM }, WARDEN_HEARTBEAT.windupMs);
    } else if (primaryReady) {
      state.nextPrimaryTick = this.currentTick + ticks(WARDEN_STRIKES.intervalMs);
      const strike = chooseWardenStrike(state, distanceM);
      if (strike === state.wardenNext) state.wardenNext = strike === "slam" ? "charge" : "slam";
      if (strike === "slam") {
        this.beginVaultStrike(mob, state, target, "slam", WARDEN_SLAM.telegraphMs, WARDEN_SLAM.techniqueId,
          { kind: "circle", center: origin, radiusM: WARDEN_SLAM.radiusM });
      } else {
        const lengthM = vaultLaneLengthM(distanceM, WARDEN_CHARGE);
        this.beginVaultStrike(mob, state, target, "charge", WARDEN_CHARGE.telegraphMs, WARDEN_CHARGE.techniqueId, {
          kind: "line", origin, facingDegrees: bearing, lengthM, widthM: WARDEN_CHARGE.widthM
        }, bearing, lengthM);
      }
    }
  }

  /** Locks a vault move's geometry now and draws its telegraph; it resolves `telegraphMs` later. */
  private beginVaultStrike(
    mob: Combatant, state: VaultMobState, target: Combatant, kind: VaultStrikeKind, telegraphMs: number,
    abilityId: string, geometry: BossTelegraphGeometry, bearing = 0, lengthM = 0
  ): void {
    const hz = this.options.tickRateHz;
    state.strikeKind = kind;
    state.strikeTick = this.currentTick + millisecondsToTicks(telegraphMs, hz);
    state.strikeCenter = geometry.kind === "circle" ? { ...geometry.center } : { ...geometry.origin };
    state.strikeBearing = bearing;
    state.strikeLengthM = lengthM;
    state.strikeTargetId = target.entityId;
    state.nextStrikeTick = state.strikeTick + millisecondsToTicks(VAULT_MOVE_GAP_MS, hz);
    this.addMobTelegraph(mob, abilityId, geometry, telegraphMs);
  }

  /** Every living player whose hurt circle overlaps the locked shape takes the hit unless in dash i-frames (a dodge). */
  private resolveVaultStrike(mob: Combatant, state: VaultMobState): void {
    const kind = state.strikeKind;
    const center = state.strikeCenter;
    if (kind === null || this.currentTick < state.strikeTick) return;
    state.strikeKind = null;
    state.strikeCenter = null;
    if (!center) return;
    const bearing = state.strikeBearing;
    const lengthM = state.strikeLengthM;
    const [factor, techniqueId, knockbackM]: [number, string, number] =
      kind === "grasp" ? [EMBER_SHADE_GRASP.damageFactor, EMBER_SHADE_GRASP.techniqueId, 0] :
      kind === "wail" ? [EMBER_SHADE_WAIL.damageFactor, EMBER_SHADE_WAIL.techniqueId, 0] :
      kind === "double_a" ? [REVENANT_DOUBLE_STRIKE.damageFactor, REVENANT_DOUBLE_STRIKE.techniqueIds[0], 0] :
      kind === "double_b" ? [REVENANT_DOUBLE_STRIKE.damageFactor, REVENANT_DOUBLE_STRIKE.techniqueIds[1], 0] :
      kind === "lunge" ? [REVENANT_FLANK_LUNGE.damageFactor, REVENANT_FLANK_LUNGE.techniqueId, 0] :
      kind === "slam" ? [WARDEN_SLAM.damageFactor, WARDEN_SLAM.techniqueId, WARDEN_SLAM.knockbackM] :
      [WARDEN_CHARGE.damageFactor, WARDEN_CHARGE.techniqueId, WARDEN_CHARGE.knockbackM];
    const local = this.signatureHitLocal;
    const cosLat = Math.cos((center.lat * Math.PI) / 180);
    const target = state.strikeTargetId ? this.entities.get(state.strikeTargetId) : undefined;
    let targetHit = false;
    for (const victim of [...this.entities.values()]) {
      if (victim.kind !== "player" || victim.lifeState !== "alive" || victim.zoneId !== mob.zoneId) continue;
      toLocalMeters(center.lat, center.lon, cosLat, victim.position.lat, victim.position.lon, local);
      const r = this.hurtRadiusM(victim);
      const inside =
        kind === "grasp" ? circleVsCone(bearing, EMBER_SHADE_GRASP.rangeM, EMBER_SHADE_GRASP.angleDegrees, local.x, local.y, r) :
        kind === "wail" ? circleVsCircle(0, 0, EMBER_SHADE_WAIL.radiusM, local.x, local.y, r) :
        kind === "double_a" || kind === "double_b"
          ? circleVsCone(bearing, REVENANT_DOUBLE_STRIKE.rangeM, REVENANT_DOUBLE_STRIKE.angleDegrees, local.x, local.y, r) :
        kind === "lunge" ? circleVsRect(bearing, lengthM, REVENANT_FLANK_LUNGE.widthM, local.x, local.y, r) :
        kind === "slam" ? circleVsCircle(0, 0, WARDEN_SLAM.radiusM, local.x, local.y, r) :
        circleVsRect(bearing, lengthM, WARDEN_CHARGE.widthM, local.x, local.y, r);
      // A dash through the strike is a dodge: no hit, no knockback.
      if (!inside || this.options.isEntityInvulnerable?.(victim.entityId) === true) continue;
      if (victim.entityId === target?.entityId) targetHit = true;
      this.applyScriptedDamage(mob.entityId, victim.entityId, Math.max(1, Math.round(this.mobBasicHitDamage(mob, victim) * factor)), techniqueId);
      if (knockbackM > 0) this.knockbackPlayer(victim.entityId, center, knockbackM);
    }
    if (target?.kind === "player" && !targetHit) this.emitInnateEvent(target.entityId, target.entityId, "DODGE", techniqueId);
    if (kind === "wail") {
      state.wardUntilTick = this.currentTick + millisecondsToTicks(EMBER_SHADE_WAIL.wardMs, this.options.tickRateHz);
      this.markDirty(mob);
    } else if (kind === "double_a") {
      // The second cone follows right away, re-aimed at the target.
      if (target?.kind === "player" && target.lifeState === "alive" && target.zoneId === mob.zoneId) {
        const facing = initialBearingDegrees(mob.position, target.position);
        this.beginVaultStrike(mob, state, target, "double_b", REVENANT_DOUBLE_STRIKE.telegraphMs[1],
          REVENANT_DOUBLE_STRIKE.techniqueIds[1], {
            kind: "cone", origin: { ...mob.position }, facingDegrees: facing,
            rangeM: REVENANT_DOUBLE_STRIKE.rangeM, angleDegrees: REVENANT_DOUBLE_STRIKE.angleDegrees
          }, facing);
      }
    } else if (kind === "lunge" || kind === "charge") {
      // The body travels the lane: the Revenant stops just past the target's locked spot, the Warden at the lane end.
      const endM = kind === "lunge" ? Math.max(0, lengthM - REVENANT_FLANK_LUNGE.overshootM / 2) : lengthM;
      if (this.placeMobAtFirstTraversable(mob, [destinationPoint(center, endM, bearing), destinationPoint(center, endM / 2, bearing)])) {
        this.markDirty(mob);
      }
    }
  }

  /** Every living Revenant in the mob's room, for the single-lunger rule. */
  private vaultRevenantsAround(mob: Combatant, target: Combatant): RevenantPosition[] {
    const revenants: RevenantPosition[] = [];
    for (const other of this.entities.values()) {
      if (other.kind !== "mob" || other.lifeState !== "alive" || other.zoneId !== mob.zoneId) continue;
      if (other.archetypeKey === null || mobBehaviorArchetype(other.archetypeKey) !== "ashbound_revenant") continue;
      revenants.push({
        entityId: other.entityId,
        distanceToTargetM: distanceMeters(other.position, target.position),
        lungeTargetId: other.vault?.strikeKind === "lunge" ? other.vault.strikeTargetId : null
      });
    }
    return revenants;
  }

  /** The heartbeat charge-up ends: the ember ring leaves the spot the Warden stood on. */
  private launchVaultHeartbeat(mob: Combatant, state: VaultMobState): void {
    const center = state.heartbeatCenter ?? { ...mob.position };
    state.heartbeatWindupTick = 0;
    state.heartbeatCenter = null;
    state.pulse = { center, startTick: this.currentTick, prevFrontM: 0, resolved: new Set() };
    this.addMobTelegraph(mob, WARDEN_HEARTBEAT.techniqueId,
      { kind: "circle", center: { ...center }, radiusM: WARDEN_HEARTBEAT.maxRadiusM }, WARDEN_HEARTBEAT_TRAVEL_MS);
  }

  /**
   * Moves the heartbeat ring front out one beat. A player is hit the beat the front reaches their hurt circle
   * unless invulnerable; one still invulnerable when the front has fully passed dodged it. A player already behind
   * the front at the previous beat (arrived after it passed) is left alone.
   */
  private advanceVaultHeartbeat(mob: Combatant, state: VaultMobState): void {
    const pulse = state.pulse;
    if (!pulse) return;
    const elapsedMs = (this.currentTick - pulse.startTick) * 1_000 / this.options.tickRateHz;
    const frontM = heartbeatFrontM(elapsedMs);
    for (const victim of [...this.entities.values()]) {
      if (victim.kind !== "player" || victim.lifeState !== "alive" || victim.zoneId !== mob.zoneId) continue;
      if (pulse.resolved.has(victim.entityId)) continue;
      const r = this.hurtRadiusM(victim);
      const distanceM = distanceMeters(victim.position, pulse.center);
      const contact = heartbeatContact(frontM, distanceM, r);
      if (contact === "ahead") continue;
      if (distanceM + r < pulse.prevFrontM) {
        pulse.resolved.add(victim.entityId);
        continue;
      }
      if (this.options.isEntityInvulnerable?.(victim.entityId) === true) {
        if (contact === "passed") {
          pulse.resolved.add(victim.entityId);
          this.emitInnateEvent(victim.entityId, victim.entityId, "DODGE", WARDEN_HEARTBEAT.techniqueId);
        }
        continue;
      }
      pulse.resolved.add(victim.entityId);
      this.applyScriptedDamage(mob.entityId, victim.entityId,
        Math.max(1, Math.round(this.mobBasicHitDamage(mob, victim) * WARDEN_HEARTBEAT.damageFactor)), WARDEN_HEARTBEAT.techniqueId);
    }
    pulse.prevFrontM = frontM;
    if (frontM >= WARDEN_HEARTBEAT.maxRadiusM) state.pulse = null;
  }

  /** The monk's third strike: a telegraphed knockback finisher after two landed hits. */
  private processMonkCombo(mob: Combatant, target: Combatant): void {
    if (mob.lifeState !== "alive") return;
    const state = this.monasteryState(mob);
    if (!countComboHit(state)) return;
    const bearing = initialBearingDegrees(mob.position, target.position);
    state.strikeKind = "finisher";
    state.strikeTick = this.currentTick + millisecondsToTicks(INITIATE_MONK_COMBO.telegraphMs, this.options.tickRateHz);
    state.strikeCenter = { ...mob.position };
    state.strikeBearing = bearing;
    state.strikeTargetId = target.entityId;
    this.addMobTelegraph(mob, INITIATE_MONK_COMBO.techniqueId, {
      kind: "cone", origin: { ...mob.position }, facingDegrees: bearing,
      rangeM: INITIATE_MONK_COMBO.rangeM, angleDegrees: INITIATE_MONK_COMBO.angleDegrees
    }, INITIATE_MONK_COMBO.telegraphMs);
  }

  /** Hit twice, the acrobat vanishes in a puff and reappears behind its target. */
  private processAcrobatHit(mob: Combatant, attacker: Combatant): void {
    if (mob.lifeState !== "alive" || mob.currentHealth <= 0) return;
    const state = this.monasteryState(mob);
    if (!countAcrobatHit(state)) return;
    const target = mob.targetEntityId ? this.entities.get(mob.targetEntityId) : attacker;
    const victim = target?.kind === "player" && target.lifeState === "alive" ? target : attacker;
    const from = { ...mob.position };
    if (!this.placeMobAtFirstTraversable(mob, [behindTarget(from, victim.position)])) return;
    this.addMobTelegraph(mob, SHADOW_ACROBAT.techniqueId, { kind: "circle", center: from, radiusM: SHADOW_ACROBAT.puffRadiusM }, SHADOW_ACROBAT.puffMs);
    this.directMobTarget(mob.entityId, victim.entityId);
    this.markDirty(mob);
  }

  /** Wakes a dormant statue: it glows and opens with a slam. */
  private awakenStatue(mob: Combatant): void {
    const state = this.monasteryState(mob);
    if (state.awake || mob.lifeState !== "alive") return;
    state.awake = true;
    if (mob.classRuntime) {
      mob.classRuntime.effects = mob.classRuntime.effects.filter((effect) => effect.sourceTechniqueId !== IRON_STATUE.dormantId);
    }
    state.strikeKind = "slam";
    state.strikeTick = this.currentTick + millisecondsToTicks(IRON_STATUE.telegraphMs, this.options.tickRateHz);
    state.strikeCenter = { ...mob.position };
    state.nextStrikeTick = this.currentTick + millisecondsToTicks(IRON_STATUE.slamIntervalMs, this.options.tickRateHz);
    this.addMobTelegraph(mob, IRON_STATUE.awakenId, { kind: "circle", center: { ...mob.position }, radiusM: IRON_STATUE.radiusM }, IRON_STATUE.telegraphMs);
    this.markDirty(mob);
  }

  /** Bell toll: interrupts the player's movement and blocks general actives for a while. */
  private silencePlayer(player: Combatant, durationMs: number): void {
    for (const [playerId, untilTick] of this.silencedUntilTick) {
      if (untilTick <= this.currentTick) this.silencedUntilTick.delete(playerId);
    }
    this.silencedUntilTick.set(player.entityId, this.currentTick + millisecondsToTicks(durationMs, this.options.tickRateHz));
    this.options.stopPlayer?.(player.entityId);
  }

  private processThornfern(mob: Combatant, target: Combatant): void {
    const state = this.mobSpecial(mob);
    if (this.currentTick < state.nextSpitTick) return;
    if (distanceMeters(mob.position, target.position) > mob.attackRangeM) return;
    state.nextSpitTick = this.currentTick + millisecondsToTicks(THORNFERN.volleyIntervalMs, this.options.tickRateHz);
    this.applyScriptedDamage(
      mob.entityId, target.entityId,
      Math.max(1, Math.round(mob.attackDamage * THORNFERN.volleyDamageFactor)), THORNFERN.techniqueId
    );
  }

  /** Slow tank: regenerates unless recently hit or burned, and slams roots onto nearby players. */
  private processTreant(mob: Combatant): void {
    const state = this.mobSpecial(mob);
    if (this.currentTick >= state.nextRegenTick) {
      state.nextRegenTick = this.currentTick + millisecondsToTicks(BLIGHT_TREANT.regenIntervalMs, this.options.tickRateHz);
      if (mob.currentHealth < mob.maxHealth && treantMayRegenerate(state, this.currentTick, this.options.tickRateHz)) {
        this.healMob(mob.entityId, Math.max(1, mob.maxHealth * BLIGHT_TREANT.regenFraction));
      }
    }
    const target = mob.targetEntityId ? this.entities.get(mob.targetEntityId) : undefined;
    if (
      !target || target.kind !== "player" || target.lifeState !== "alive" || this.effectTotal(mob, "rooted") > 0 ||
      this.currentTick < state.nextSlamTick ||
      distanceMeters(mob.position, target.position) > BLIGHT_TREANT.slamTriggerRangeM
    ) return;
    state.nextSlamTick = this.currentTick + millisecondsToTicks(BLIGHT_TREANT.slamIntervalMs, this.options.tickRateHz);
    for (const victim of this.entities.values()) {
      if (victim.kind !== "player" || victim.lifeState !== "alive" || victim.zoneId !== mob.zoneId) continue;
      if (distanceMeters(victim.position, mob.position) > BLIGHT_TREANT.slamRadiusM) continue;
      this.applyScriptedRoot(mob.entityId, victim.entityId, BLIGHT_TREANT.slamRootMs, BLIGHT_TREANT.techniqueId);
    }
  }

  /** Fragile boss add: closes on its target and bursts into a poison cloud. */
  private processSprite(mob: Combatant, target: Combatant): void {
    const state = this.mobSpecial(mob);
    if (state.fuseTick === 0) {
      if (distanceMeters(mob.position, target.position) > BLIGHT_SPRITE.burstRangeM) return;
      // Light the fuse: the warning circle shows the cloud footprint, then the sprite pops.
      state.fuseTick = this.currentTick + millisecondsToTicks(BLIGHT_SPRITE.fuseMs, this.options.tickRateHz);
      this.addMobTelegraph(
        mob, BLIGHT_SPRITE.techniqueId,
        { kind: "circle", center: { ...mob.position }, radiusM: BLIGHT_SPRITE.cloudRadiusM },
        BLIGHT_SPRITE.fuseMs + BLIGHT_SPRITE.cloudDelayMs + BLIGHT_SPRITE.cloudDurationMs
      );
      return;
    }
    if (this.currentTick < state.fuseTick) return;
    state.fuseTick = 0;
    this.spawnPoisonCloud(
      mob.entityId, mob.position, BLIGHT_SPRITE.cloudRadiusM, BLIGHT_SPRITE.cloudDelayMs, BLIGHT_SPRITE.cloudDurationMs,
      mob.attackDamage * BLIGHT_SPRITE.cloudDamageFactor, BLIGHT_SPRITE.techniqueId
    );
    this.applyScriptedDamage(mob.entityId, mob.entityId, mob.currentHealth + 1, "blight_sprite_burst");
  }


  // ---- Everyday-mob gimmicks (see mobGimmicks.ts for tuning) ----

  /** Adds an ordinary-mob telegraph (same shape bosses use) that the client draws until it resolves. */
  private addMobTelegraph(source: Combatant, abilityId: string, geometry: BossTelegraphGeometry, durationMs: number): number {
    const startTime = this.now();
    const origin = geometry.kind === "circle" ? geometry.center : geometry.origin;
    this.mobCasts.push({
      sourceEntityId: source.entityId,
      zoneId: source.zoneId,
      cast: {
        encounterId: `mob:${source.entityId}`,
        bossId: source.archetypeKey ?? "mob",
        abilityId,
        castInstanceId: `${source.entityId}:${abilityId}:${this.currentTick}`,
        startTime,
        resolveTime: startTime + durationMs,
        origin: { ...origin },
        geometry,
        lifeGeneration: source.lifeGeneration
      }
    });
    if (this.mobCasts.length > 256) this.mobCasts.splice(0, this.mobCasts.length - 256);
    this.markDirty(source);
    this.immediateFlushPending = true;
    return startTime + durationMs;
  }

  /**
   * True once after something that must ship this tick (a mob telegraph, a resolved swing's DAMAGE
   * events), so the runtime sends a combat delta now instead of waiting up to 100 ms for the next slot.
   */
  takeImmediateFlush(): boolean {
    const pending = this.immediateFlushPending;
    this.immediateFlushPending = false;
    return pending;
  }

  private pruneMobCasts(): void {
    if (this.mobCasts.length === 0) return;
    const cutoff = this.now() - 500;
    this.mobCasts = this.mobCasts.filter((record) => record.cast.resolveTime > cutoff);
  }

  /** Telegraphs and buffs for one snapshot. Casts whose mob is gone ride on players in the same room. */
  private mobGimmickPresentation(entity: Combatant): { telegraphs?: BossCastSnapshot[]; mobBuffs?: MobBuffSnapshot[] } {
    const result: { telegraphs?: BossCastSnapshot[]; mobBuffs?: MobBuffSnapshot[] } = {};
    if (this.mobCasts.length > 0) {
      const now = this.now();
      const casts = this.mobCasts
        .filter((record) => {
          if (record.cast.resolveTime <= now) return false;
          if (entity.kind === "mob") return record.sourceEntityId === entity.entityId;
          return record.zoneId === entity.zoneId && !this.entities.has(record.sourceEntityId);
        })
        // durationMs/remainingMs let the client anchor the warning to its own clock (no skew, no delta-batching loss).
        .map((record) => ({ ...record.cast, durationMs: record.cast.resolveTime - record.cast.startTime, remainingMs: Math.max(0, record.cast.resolveTime - now) }));
      if (casts.length > 0) result.telegraphs = casts;
    }
    const buffs = entity.kind === "mob" ? this.mobBuffSnapshots(entity) : [];
    if (buffs.length > 0) result.mobBuffs = buffs;
    return result;
  }

  private mobBuffSnapshots(mob: Combatant): MobBuffSnapshot[] {
    const now = this.now();
    const buffs: MobBuffSnapshot[] = [];
    if (mob.special && mob.special.staggerUntilTick > this.currentTick) {
      buffs.push({
        kind: "staggered",
        endsAt: now + Math.max(0, mob.special.staggerUntilTick - this.currentTick) * 1_000 / this.options.tickRateHz
      });
    }
    // Tilted Vault: the Ember Shade's post-wail ward (the client fades and flickers the Shade).
    if (mob.vault && isVaultWarded(mob.vault, this.currentTick)) {
      buffs.push({
        kind: "warded",
        endsAt: now + Math.max(0, mob.vault.wardUntilTick - this.currentTick) * 1_000 / this.options.tickRateHz
      });
    }
    // The client swaps dormant art (Sentinel Statue, Corrupted Husk) for its awake art on this signal.
    if (this.golemForgeState.get(mob.entityId)?.awake) {
      buffs.push({ kind: "awake", endsAt: now + OPEN_ENDED_BUFF_MS });
    }
    const state = mob.special;
    if (!state) return buffs;
    const endsAt = (untilTick: number): number =>
      now + Math.max(0, untilTick - this.currentTick) * 1_000 / this.options.tickRateHz;
    if (state.shellUntilTick > this.currentTick) buffs.push({ kind: "shell", endsAt: endsAt(state.shellUntilTick) });
    if (state.reassembleUntilTick > this.currentTick) buffs.push({ kind: "reassembling", endsAt: endsAt(state.reassembleUntilTick) });
    if (state.guardUntilTick > this.currentTick) buffs.push({ kind: "shell", endsAt: endsAt(state.guardUntilTick) });
    if (state.roarUntilTick > this.currentTick) {
      buffs.push({ kind: roarBuffKind(mob.archetypeKey), endsAt: endsAt(state.roarUntilTick) });
    }
    if (state.backstabUntilTick > this.currentTick) buffs.push({ kind: "backstab", endsAt: endsAt(state.backstabUntilTick) });
    if (isMobFamilyArchetype(mob.archetypeKey, "alligator") && deathRollPrimed(state.biteCount)) {
      buffs.push({ kind: "death_roll", endsAt: now + OPEN_ENDED_BUFF_MS });
    }
    return buffs;
  }

  /** Bumps nearby players so a mob-less telegraph reaches their clients. */
  private markPlayersNearDirty(position: LatLon, zoneId: string): void {
    for (const id of this.grid.query(position, 1_500)) {
      const entity = this.entities.get(id);
      if (entity?.kind === "player" && entity.zoneId === zoneId) this.markDirty(entity);
    }
  }

  /** Slides a player toward `to`, stopping stopDistanceM short; shortens the pull until the room accepts the spot. */
  pullPlayer(playerEntityId: string, to: LatLon, stopDistanceM: number): boolean {
    const player = this.entities.get(playerEntityId);
    if (!player || player.kind !== "player" || player.lifeState !== "alive" || !this.options.repositionPlayer) return false;
    const travelM = distanceMeters(player.position, to) - stopDistanceM;
    if (travelM <= 1) return false;
    const bearing = initialBearingDegrees(player.position, to);
    for (const fraction of [1, 0.875, 0.75, 0.625, 0.5, 0.375, 0.25, 0.125]) {
      const pull = travelM * fraction;
      const destination = destinationPoint(player.position, pull, bearing);
      if (!this.options.repositionPlayer(player.entityId, destination, pull + 50, true)) continue;
      this.grid.update(player.entityId, destination);
      player.position = { ...destination };
      this.markDirty(player);
      return true;
    }
    return false;
  }

  /** Crab and tortoise: periodically hunker behind a shell and takes much less damage for a moment. */
  private processCrabShell(mob: Combatant, target: Combatant): void {
    if (mob.npcFaction) return;
    const state = this.mobSpecial(mob);
    if (state.nextGimmickTick === 0) {
      state.nextGimmickTick = this.currentTick + millisecondsToTicks(3_000, this.options.tickRateHz);
      return;
    }
    if (this.currentTick < state.nextGimmickTick || state.guardUntilTick > this.currentTick) return;
    if (distanceMeters(mob.position, target.position) > CRAB_SHELL.triggerRangeM) return;
    const shell = shellGuardFor(mob.archetypeKey);
    state.guardUntilTick = this.currentTick + millisecondsToTicks(shell.durationMs, this.options.tickRateHz);
    state.nextGimmickTick = this.currentTick + millisecondsToTicks(shell.intervalMs, this.options.tickRateHz);
    this.markDirty(mob);
  }

  /** Starts a telegraphed strike (slam, maul, bomb, tongue, blink) or ink cloud once the cooldown and range allow. */
  private processGimmickStrike(mob: Combatant, target: Combatant): void {
    const profile = gimmickStrikeFor(mob.archetypeKey);
    if (!profile || mob.npcFaction || golemForgeSuppressesStrike(mob.archetypeKey)) return;
    const state = this.mobSpecial(mob);
    if (state.strikeKind !== null || isShelled(state, this.currentTick)) return;
    // Close-range strikes wait a beat after engaging; gap-closers (tongue, blink) open the fight.
    if (state.nextGimmickTick === 0 && profile.minRangeM === 0) {
      state.nextGimmickTick = this.currentTick + millisecondsToTicks(2_500, this.options.tickRateHz);
      return;
    }
    if (this.currentTick < state.nextGimmickTick) return;
    const distanceM = distanceMeters(mob.position, target.position);
    if (!strikeInRange(profile, distanceM)) return;
    const bearing = initialBearingDegrees(mob.position, target.position);
    const hz = this.options.tickRateHz;
    let geometry: BossTelegraphGeometry;
    let center: LatLon = { ...mob.position };
    let lengthM = 0;
    switch (profile.kind) {
      case "slam":
        geometry = { kind: "circle", center, radiusM: hurtShapeReachM(OGRE_SLAM.radiusM, PLAYER_HURT_RADIUS_M) };
        break;
      case "maul":
        geometry = {
          kind: "cone", origin: center, facingDegrees: bearing,
          rangeM: hurtShapeReachM(BEAR_MAUL.rangeM, PLAYER_HURT_RADIUS_M), angleDegrees: BEAR_MAUL.angleDegrees
        };
        break;
      case "swoop":
        geometry = {
          kind: "cone", origin: center, facingDegrees: bearing,
          rangeM: hurtShapeReachM(SWOOP.rangeM, PLAYER_HURT_RADIUS_M), angleDegrees: SWOOP.angleDegrees
        };
        break;
      case "bomb":
        center = { ...target.position };
        geometry = { kind: "circle", center, radiusM: hurtShapeReachM(GOBLIN_BOMB.radiusM, PLAYER_HURT_RADIUS_M) };
        break;
      case "pull":
        lengthM = Math.min(FROG_TONGUE.maxRangeM + FROG_TONGUE.overshootM, distanceM + FROG_TONGUE.overshootM);
        geometry = {
          kind: "line", origin: center, facingDegrees: bearing, lengthM: hurtShapeReachM(lengthM, PLAYER_HURT_RADIUS_M),
          widthM: FROG_TONGUE.widthM
        };
        break;
      case "smoke":
        center = destinationPoint(target.position, BANDIT_BACKSTAB.behindM, bearing);
        if (!this.isMobPositionTraversable(center, mob.regionCode)) return;
        geometry = { kind: "circle", center, radiusM: BANDIT_BACKSTAB.puffRadiusM };
        break;
      case "ink": {
        center = { ...target.position };
        const landTick = this.currentTick + millisecondsToTicks(profile.delayMs, hz);
        this.acidZones.push({
          zoneId: mob.zoneId, sourceEntityId: mob.entityId, center, landTick,
          endTick: landTick + millisecondsToTicks(SQUID_INK.durationMs, hz), nextTick: landTick,
          damage: Math.max(1, Math.round(mob.attackDamage * SQUID_INK.damageFactor)),
          radiusM: SQUID_INK.radiusM, techniqueId: SQUID_INK.techniqueId,
          slow: { durationMs: SQUID_INK.slowMs, amount: SQUID_INK.slowAmount }
        });
        // The warning doubles as the cloud marker until the ink fades.
        this.addMobTelegraph(mob, SQUID_INK.techniqueId, { kind: "circle", center, radiusM: SQUID_INK.radiusM }, profile.delayMs + SQUID_INK.durationMs);
        state.nextGimmickTick = this.currentTick + millisecondsToTicks(profile.intervalMs, hz);
        return;
      }
    }
    state.nextGimmickTick = this.currentTick + millisecondsToTicks(profile.intervalMs, hz);
    state.strikeKind = profile.kind;
    state.strikeTick = this.currentTick + millisecondsToTicks(profile.delayMs, hz);
    state.strikeCenter = center;
    state.strikeBearing = bearing;
    state.strikeLengthM = lengthM;
    state.strikeTargetId = target.entityId;
    state.strikeResolveAt = this.addMobTelegraph(mob, `${mob.archetypeKey}_${profile.kind}`, geometry, profile.delayMs);
  }

  /** Resolves a due strike against everyone still standing in the telegraphed shape. */
  private resolveGimmickStrike(mob: Combatant): void {
    const state = this.mobSpecial(mob);
    const kind = state.strikeKind;
    const center = state.strikeCenter;
    if (kind === null || this.currentTick < state.strikeTick || this.now() < state.strikeResolveAt) return;
    state.strikeKind = null;
    state.strikeCenter = null;
    if (!center) return;
    if (kind === "smoke") {
      if (this.placeMobAtFirstTraversable(mob, [center])) {
        state.backstabUntilTick = this.currentTick + millisecondsToTicks(BANDIT_BACKSTAB.readyMs, this.options.tickRateHz);
        const target = state.strikeTargetId ? this.entities.get(state.strikeTargetId) : undefined;
        if (target?.kind === "player" && target.lifeState === "alive") this.directMobTarget(mob.entityId, target.entityId);
        this.markDirty(mob);
      }
      return;
    }
    const attack = mob.attackDamage;
    const scan = kind === "pull" ? state.strikeLengthM : kind === "maul" ? BEAR_MAUL.rangeM : kind === "swoop" ? SWOOP.rangeM
      : kind === "slam" ? OGRE_SLAM.radiusM : GOBLIN_BOMB.radiusM;
    // Every shape is the drawn telegraph (PLAYER_HURT_RADIUS_M short of the table reach) against the hurt circle.
    const drawn = (effectiveM: number): number => hurtShapeReachM(effectiveM, PLAYER_HURT_RADIUS_M);
    const bearingRad = (state.strikeBearing * Math.PI) / 180;
    const pullM = drawn(state.strikeLengthM);
    const cosLat = Math.cos((center.lat * Math.PI) / 180);
    const local = this.signatureHitLocal;
    let hits = 0;
    for (const id of [...this.grid.query(center, scan + 50)]) {
      const victim = this.entities.get(id);
      if (!victim || victim.kind !== "player" || victim.lifeState !== "alive" || victim.zoneId !== mob.zoneId) continue;
      toLocalMeters(center.lat, center.lon, cosLat, victim.position.lat, victim.position.lon, local);
      const r = this.hurtRadiusM(victim);
      if (kind === "slam" && !circleVsCircle(0, 0, drawn(OGRE_SLAM.radiusM), local.x, local.y, r)) continue;
      if (kind === "bomb" && !circleVsCircle(0, 0, drawn(GOBLIN_BOMB.radiusM), local.x, local.y, r)) continue;
      if (kind === "maul" && !circleVsCone(state.strikeBearing, drawn(BEAR_MAUL.rangeM), BEAR_MAUL.angleDegrees, local.x, local.y, r)) continue;
      if (kind === "swoop" && !circleVsCone(state.strikeBearing, drawn(SWOOP.rangeM), SWOOP.angleDegrees, local.x, local.y, r)) continue;
      if (
        kind === "pull" &&
        !circleVsSegment(0, 0, Math.sin(bearingRad) * pullM, Math.cos(bearingRad) * pullM, FROG_TONGUE.widthM / 2, local.x, local.y, r)
      ) continue;
      // A dash through the strike is a dodge: no hit, no knockback, and the miss stagger still applies.
      if (this.options.isEntityInvulnerable?.(victim.entityId)) continue;
      hits += 1;
      if (kind === "slam") {
        this.applyScriptedDamage(mob.entityId, victim.entityId, Math.max(1, Math.round(attack * OGRE_SLAM.damageFactor)), OGRE_SLAM.techniqueId);
        this.knockbackPlayer(victim.entityId, center, OGRE_SLAM.knockbackM);
      } else if (kind === "maul") {
        this.applyScriptedDamage(mob.entityId, victim.entityId, Math.max(1, Math.round(attack * bearMaulDamageFactor(mob.archetypeKey))), BEAR_MAUL.techniqueId);
        this.knockbackPlayer(victim.entityId, center, BEAR_MAUL.knockbackM);
      } else if (kind === "swoop") {
        this.applyScriptedDamage(mob.entityId, victim.entityId, Math.max(1, Math.round(attack * SWOOP.damageFactor)), SWOOP.techniqueId);
      } else if (kind === "bomb") {
        this.applyScriptedDamage(mob.entityId, victim.entityId, Math.max(1, Math.round(attack * GOBLIN_BOMB.damageFactor)), GOBLIN_BOMB.techniqueId);
        this.knockbackPlayer(victim.entityId, center, GOBLIN_BOMB.knockbackM);
      } else if (kind === "pull") {
        this.applyScriptedDamage(mob.entityId, victim.entityId, Math.max(1, Math.round(attack * FROG_TONGUE.damageFactor)), FROG_TONGUE.techniqueId);
        this.pullPlayer(victim.entityId, mob.position, FROG_TONGUE.stopDistanceM);
      }
    }
    if ((kind === "slam" || kind === "maul" || kind === "swoop") && !mob.npcFaction) this.applyStrikeAftermath(mob, hits > 0);
  }

  /**
   * After a telegraphed charge, slam, maul or swoop resolves: a miss staggers the mob (frozen, takes extra damage),
   * a hit only costs a short recovery. Ability cooldowns are pushed back by the same time so nothing fires right after.
   */
  private applyStrikeAftermath(mob: Combatant, hit: boolean): void {
    if (mob.lifeState !== "alive" || mob.currentHealth <= 0) return;
    const state = this.mobSpecial(mob);
    const durationMs = hit ? DODGE_REWARD.recoveryMs : DODGE_REWARD.staggerMs;
    const ticks = millisecondsToTicks(durationMs, this.options.tickRateHz);
    const endTick = this.currentTick + ticks;
    state.stunUntilTick = Math.max(state.stunUntilTick, endTick);
    if (!hit) state.staggerUntilTick = Math.max(state.staggerUntilTick, endTick);
    state.nextGimmickTick = Math.max(state.nextGimmickTick + ticks, endTick);
    state.nextChargeTick = Math.max(state.nextChargeTick + ticks, endTick);
    this.addTimedEffect(mob, mob, "rooted", hit ? "strike_recovery" : "strike_stagger", durationMs, 1);
    this.markDirty(mob);
  }

  /** Reactions to being hit: squeak, bolt, howl, enrage. */
  private processMobDamagedGimmicks(mob: Combatant, attacker: Combatant): void {
    if (mob.lifeState !== "alive" || mob.currentHealth <= 0 || mob.npcFaction || mob.archetypeKey === null) return;
    if (mob.archetypeKey === "golem_smith_gf") this.interruptSmithChannel(mob);
    const state = this.mobSpecial(mob);
    if (state.triggered) return;
    const alivePlayer = attacker.kind === "player" && attacker.lifeState === "alive";
    if (mobGimmickArchetype(mob.archetypeKey) === "gate_warden") {
      this.processGateWardenRift(mob, attacker);
      return;
    }
    switch (mobBehaviorArchetype(mob.archetypeKey)) {
      case "sewer_rat":
      case "sick_sewer_rat":
        state.triggered = true;
        if (alivePlayer) this.callIdleAllies(mob, attacker, SEWER_RAT_SQUEAK.archetypes, SEWER_RAT_SQUEAK.radiusM);
        break;
      case "wolf": {
        if (!belowHealthRatio(mob.currentHealth, mob.maxHealth, WOLF_HOWL.healthRatio)) break;
        state.triggered = true;
        // Wolves rally the wolf family; a wolf-template fantasy mob (Griffin) rallies its own kind.
        const pack: readonly MobArchetypeKey[] = isWolfFamilyArchetype(mob.archetypeKey)
          ? WOLF_FAMILY_ARCHETYPES
          : [mob.archetypeKey];
        if (alivePlayer) this.callIdleAllies(mob, attacker, pack, WOLF_HOWL.radiusM);
        const untilTick = this.currentTick + millisecondsToTicks(WOLF_HOWL.durationMs, this.options.tickRateHz);
        for (const other of this.entities.values()) {
          if (
            other.kind !== "mob" || other.lifeState !== "alive" || other.archetypeKey === null ||
            !pack.includes(other.archetypeKey) ||
            other.zoneId !== mob.zoneId || other.npcFaction ||
            distanceMeters(other.position, mob.position) > WOLF_HOWL.radiusM
          ) continue;
          this.mobSpecial(other).roarUntilTick = untilTick;
          this.markDirty(other);
        }
        break;
      }
      case "orc_brute":
        if (!belowHealthRatio(mob.currentHealth, mob.maxHealth, ORC_ENRAGE.healthRatio)) break;
        state.triggered = true;
        state.roarUntilTick = this.currentTick + millisecondsToTicks(OPEN_ENDED_BUFF_MS, this.options.tickRateHz);
        this.markDirty(mob);
        break;
      default:
        break;
    }
  }

  /** Procs on a landed basic hit from a mob: sap, death roll, backstab consume, elemental birds. */
  private processMobHitGimmicks(attacker: Combatant, target: Combatant): void {
    if (attacker.kind !== "mob" || attacker.npcFaction || target.kind !== "player" || target.lifeState !== "alive") return;
    const state = this.mobSpecial(attacker);
    const roll = (): number => this.options.random?.() ?? Math.random();
    if (attacker.archetypeKey === GOLEM_FORGE_ARCHETYPES.sparkWisp) this.applySparkChain(attacker, target);
    if (state.pounceTargetId !== target.entityId && pounceReady(attacker.archetypeKey, null, target.entityId)) {
      state.pounceTargetId = target.entityId;
    }
    const bird = birdProcKind(attacker.archetypeKey);
    if (bird === "fire") {
      if (roll() < BIRD_PROC.fire.chance) this.applyElementalBurn(attacker, target);
    } else if (bird === "ice") {
      if (roll() < BIRD_PROC.ice.chance) {
        this.addTimedEffect(attacker, target, "movement_slow", SLOW_STATUS_TECHNIQUE_ID, BIRD_PROC.ice.durationMs, BIRD_PROC.ice.amount);
      }
    } else if (bird === "lightning") {
      const arc = BIRD_PROC.lightning;
      this.addTimedEffect(attacker, target, "storm", "lightning_bird_shock", arc.stormMs, 0);
      const victims = this.nearbyEntityIds(target.position, arc.arcRadiusM)
        .map((id) => this.entities.get(id))
        .filter((entity): entity is Combatant => Boolean(
          entity && entity.kind === "player" && entity.lifeState === "alive" &&
          entity.entityId !== target.entityId && entity.zoneId === attacker.zoneId
        ))
        .sort((left, right) => distanceMeters(left.position, target.position) - distanceMeters(right.position, target.position))
        .slice(0, arc.arcMaxTargets);
      for (const victim of victims) {
        this.addTimedEffect(attacker, victim, "storm", "lightning_bird_shock", arc.stormMs, 0);
        this.applyScriptedDamage(attacker.entityId, victim.entityId, Math.max(1, Math.round(attacker.attackDamage * arc.arcDamageFactor)), arc.techniqueId);
      }
    }
    switch (attacker.archetypeKey === null ? null : mobBehaviorArchetype(attacker.archetypeKey)) {
      case "sap_crawler":
        if (roll() < SAP_CRAWLER_STICK.chance) {
          this.addTimedEffect(attacker, target, "movement_slow", SLOW_STATUS_TECHNIQUE_ID, SAP_CRAWLER_STICK.durationMs, SAP_CRAWLER_STICK.amount);
        }
        break;
      case "alligator":
        state.biteCount += 1;
        if (isDeathRollBite(state.biteCount)) {
          this.applyScriptedRoot(attacker.entityId, target.entityId, ALLIGATOR_DEATH_ROLL.rootMs, ALLIGATOR_DEATH_ROLL.techniqueId);
          this.applyScriptedDamage(
            attacker.entityId, target.entityId,
            Math.max(1, Math.round(attacker.attackDamage * deathRollBonusFactor(attacker.archetypeKey))), ALLIGATOR_DEATH_ROLL.techniqueId
          );
        }
        this.markDirty(attacker);
        break;
      case "bandit":
        if (state.backstabUntilTick > 0) {
          state.backstabUntilTick = 0;
          this.markDirty(attacker);
        }
        break;
      default:
        break;
    }
  }

  /** Skeleton: the first killing blow just scatters it; the bones pull back together at partial health. */
  private tryReassemble(mob: Combatant): boolean {
    // Skeleton-template fantasy mobs (Frost Wraith, Barrow Wight, ...) reassemble too.
    if (
      mob.kind !== "mob" || mob.archetypeKey === null || mobBehaviorArchetype(mob.archetypeKey) !== "skeleton" ||
      mob.npcFaction || mob.undead
    ) return false;
    const state = this.mobSpecial(mob);
    if (state.triggered) return false;
    state.triggered = true;
    mob.currentHealth = Math.max(1, Math.round(mob.maxHealth * SKELETON_REASSEMBLE.healthRatio));
    state.reassembleUntilTick = this.currentTick + millisecondsToTicks(SKELETON_REASSEMBLE.durationMs, this.options.tickRateHz);
    this.addTimedEffect(mob, mob, "rooted", "skeleton_reassemble", SKELETON_REASSEMBLE.durationMs, 1);
    this.markDirty(mob);
    return true;
  }

  /** Death effects: sick rats burst into a plague cloud, slimes split into slimelets. */
  private processMobDefeatGimmicks(mob: Combatant, killerEntityId: string): void {
    if (mob.npcFaction) return;
    if (mob.archetypeKey === "sick_sewer_rat" || (mob.archetypeKey !== null && mobGimmickArchetype(mob.archetypeKey) === "darter")) {
      const burst = mob.archetypeKey === "sick_sewer_rat" ? SICK_RAT_BURST : DARTER_BURST;
      if (!this.spawnPoisonCloud(
        mob.entityId, mob.position, burst.radiusM, burst.delayMs, burst.durationMs,
        mob.attackDamage * burst.damageFactor, burst.techniqueId
      )) return;
      this.addMobTelegraph(
        mob, burst.techniqueId, { kind: "circle", center: { ...mob.position }, radiusM: burst.radiusM },
        burst.delayMs + burst.durationMs
      );
      this.markPlayersNearDirty(mob.position, mob.zoneId);
      return;
    }
    if (!mob.noRewards && mob.archetypeKey !== null && SMITH_REVIVE.archetypes.includes(mob.archetypeKey)) {
      const cutoff = this.currentTick - millisecondsToTicks(SMITH_REVIVE.recentDeathMs, this.options.tickRateHz);
      this.golemRubble = this.golemRubble.filter((entry) => entry.atTick >= cutoff);
      this.golemRubble.push({
        archetype: mob.archetypeKey, position: { ...mob.position }, zoneId: mob.zoneId,
        regionCode: mob.regionCode, atTick: this.currentTick
      });
    }
    if (mob.archetypeKey === GOLEM_FORGE_ARCHETYPES.sparkWisp) {
      // A small burst where the wisp pops.
      if (this.spawnDamageZone({
        ownerEntityId: mob.entityId, center: mob.position, radiusM: SPARK_WISP_BURST.radiusM,
        delayMs: SPARK_WISP_BURST.delayMs, durationMs: SPARK_WISP_BURST.durationMs,
        damage: mob.attackDamage * SPARK_WISP_BURST.damageFactor, techniqueId: SPARK_WISP_BURST.techniqueId
      })) this.markPlayersNearDirty(mob.position, mob.zoneId);
      return;
    }
    if (mob.archetypeKey !== "slime") return;
    const state = this.mobSpecial(mob);
    // Slimelets never split again and stay out of dungeon rooms, where enemies are tracked per encounter.
    if (state.splitChild || mob.zoneId.startsWith("interior:")) return;
    const killer = this.entities.get(killerEntityId);
    for (let index = 0; index < SLIME_SPLIT.children; index += 1) {
      const position = destinationPoint(mob.position, SLIME_SPLIT.spreadM, 60 + index * 180);
      if (!this.isMobPositionTraversable(position, mob.regionCode)) continue;
      let childId: string;
      try {
        childId = this.spawnMob({
          archetype: "slime", position, homePosition: position, regionCode: mob.regionCode, zoneId: mob.zoneId,
          worldAi: mob.worldAi, summoned: true,
          ...(mob.challengeTier && mob.combatBalanceVersion
            ? { combatProfile: { level: mob.level, tier: mob.challengeTier, balanceVersion: mob.combatBalanceVersion } }
            : {})
        }).entityId;
      } catch {
        continue;
      }
      const child = this.entities.get(childId);
      if (!child) continue;
      child.maxHealth = Math.max(1, Math.round(mob.maxHealth * SLIME_SPLIT.healthFraction));
      child.currentHealth = child.maxHealth;
      child.name = SLIME_SPLIT.childName;
      this.mobSpecial(child).splitChild = true;
      this.markDirty(child);
      if (killer?.kind === "player" && killer.lifeState === "alive") this.directMobTarget(child.entityId, killer.entityId);
    }
  }

  // ---- Wyrm Hollow (see wyrmHollowBehaviors.ts for tuning) ----

  /** Drakeling spit, salamander submerge, lava slime trail and broodguard clutch enrage. */
  private processWyrmHollowMob(mob: Combatant, key: string): void {
    const state = this.mobSpecial(mob);
    const hz = this.options.tickRateHz;
    if (key === "drake_broodguard") {
      // Someone at the eggs it guards (its spawn point) enrages it for a few seconds; refreshed while they stay.
      for (const id of this.grid.query(mob.homePosition, DRAKE_BROODGUARD.clutchRadiusM)) {
        const intruder = this.entities.get(id);
        if (!intruder || intruder.kind !== "player" || intruder.lifeState !== "alive" || intruder.zoneId !== mob.zoneId) continue;
        if (distanceMeters(intruder.position, mob.homePosition) > DRAKE_BROODGUARD.clutchRadiusM) continue;
        if (state.roarUntilTick <= this.currentTick) this.markDirty(mob);
        state.roarUntilTick = this.currentTick + millisecondsToTicks(DRAKE_BROODGUARD.enrageMs, hz);
        break;
      }
      return;
    }
    // A drakeling spit in flight reuses the charge fields (origin, bearing, landing tick).
    if (key === "drakeling" && state.chargeOrigin !== null) {
      if (this.currentTick < state.chargeHitTick) return;
      const origin = state.chargeOrigin;
      state.chargeOrigin = null;
      const damage = Math.max(1, Math.round(mob.attackDamage * DRAKELING_SPIT.damageFactor));
      for (const id of [...this.grid.query(origin, DRAKELING_SPIT.rangeM + 50)]) {
        const victim = this.entities.get(id);
        if (!victim || victim.kind !== "player" || victim.lifeState !== "alive" || victim.zoneId !== mob.zoneId) continue;
        if (distanceMeters(victim.position, origin) > DRAKELING_SPIT.rangeM) continue;
        const diff = Math.abs(((initialBearingDegrees(origin, victim.position) - state.chargeBearing + 540) % 360) - 180);
        if (diff > DRAKELING_SPIT.angleDegrees / 2) continue;
        this.applyScriptedDamage(mob.entityId, victim.entityId, damage, DRAKELING_SPIT.techniqueId);
        this.applyHarmfulStatus(mob, victim, "burning", 1);
      }
      return;
    }
    const target = mob.targetEntityId ? this.entities.get(mob.targetEntityId) : undefined;
    if (!target || target.kind !== "player" || target.lifeState !== "alive" || this.effectTotal(mob, "rooted") > 0) return;
    if (key === "drakeling") {
      if (state.nextChargeTick === 0) {
        state.nextChargeTick = this.currentTick + millisecondsToTicks(DRAKELING_SPIT.firstDelayMs, hz);
        return;
      }
      if (this.currentTick < state.nextChargeTick || distanceMeters(mob.position, target.position) > DRAKELING_SPIT.triggerRangeM) return;
      state.chargeOrigin = { ...mob.position };
      state.chargeBearing = initialBearingDegrees(mob.position, target.position);
      state.chargeHitTick = this.currentTick + millisecondsToTicks(DRAKELING_SPIT.telegraphMs, hz);
      state.nextChargeTick = this.currentTick + millisecondsToTicks(DRAKELING_SPIT.intervalMs, hz);
      this.addMobTelegraph(mob, DRAKELING_SPIT.techniqueId, {
        kind: "cone", origin: { ...mob.position }, facingDegrees: state.chargeBearing,
        rangeM: DRAKELING_SPIT.rangeM, angleDegrees: DRAKELING_SPIT.angleDegrees
      }, DRAKELING_SPIT.telegraphMs);
      return;
    }
    if (key === "magma_salamander") {
      if (state.nextDiveTick === 0) {
        state.nextDiveTick = this.currentTick + millisecondsToTicks(MAGMA_SALAMANDER.firstSubmergeDelayMs, hz);
        return;
      }
      if (this.currentTick < state.nextDiveTick) return;
      // Submerged: the retreat state makes it untargetable until it surfaces next to its target.
      state.climbing = true;
      state.climbUntilTick = this.currentTick + millisecondsToTicks(MAGMA_SALAMANDER.submergedMs, hz);
      state.diveTargetId = target.entityId;
      state.nextDiveTick = this.currentTick + millisecondsToTicks(MAGMA_SALAMANDER.submergeIntervalMs, hz);
      this.disengageMobForRetreat(mob);
      return;
    }
    if (key === "lava_slime" && this.currentTick >= state.nextSpitTick) {
      state.nextSpitTick = this.currentTick + millisecondsToTicks(LAVA_SLIME_TRAIL.intervalMs, hz);
      const center = { ...mob.position };
      this.acidZones.push({
        zoneId: mob.zoneId, sourceEntityId: mob.entityId, center, landTick: this.currentTick,
        endTick: this.currentTick + millisecondsToTicks(LAVA_SLIME_TRAIL.durationMs, hz), nextTick: this.currentTick,
        damage: Math.max(1, Math.round(mob.attackDamage * LAVA_SLIME_TRAIL.damageFactor)),
        radiusM: LAVA_SLIME_TRAIL.radiusM, techniqueId: LAVA_SLIME_TRAIL.techniqueId, burning: true
      });
      this.addMobTelegraph(mob, LAVA_SLIME_TRAIL.techniqueId, { kind: "circle", center, radiusM: LAVA_SLIME_TRAIL.radiusM }, LAVA_SLIME_TRAIL.durationMs);
    }
  }

  /** A submerged salamander waits out its dive, then surfaces beside its target with a burning bite. */
  private stepSalamanderSubmerged(mob: Combatant): void {
    const state = this.mobSpecial(mob);
    if (this.currentTick < state.climbUntilTick) return;
    state.climbing = false;
    mob.activityState = "idle";
    this.markDirty(mob);
    const target = state.diveTargetId ? this.entities.get(state.diveTargetId) : undefined;
    state.diveTargetId = null;
    if (!target || target.kind !== "player" || target.lifeState !== "alive" || target.zoneId !== mob.zoneId) return;
    const surface: HopProfile = { leapMinDistanceM: 0, leapLandingRadiusM: MAGMA_SALAMANDER.surfaceDistanceM, awayDistanceM: 0, leapCooldownMs: 0 };
    if (this.placeMobAtFirstTraversable(mob, fleaHopCandidates("leap", mob.entityId, this.currentTick, mob.position, target.position, surface))) {
      this.applyScriptedDamage(
        mob.entityId, target.entityId,
        Math.max(1, Math.round(mob.attackDamage * MAGMA_SALAMANDER.surfaceBiteDamageFactor)), MAGMA_SALAMANDER.techniqueId
      );
      this.applyHarmfulStatus(mob, target, "burning", 1);
    }
    this.directMobTarget(mob.entityId, target.entityId);
  }

  /**
   * Room hazard with no owning mob (lava vents, the Elder Dragon's lava pools): a telegraphed burning
   * zone that lands after delayMs and ticks for durationMs. The warning rides on the room's players.
   */
  spawnRoomHazard(input: Readonly<{
    zoneId: string; hazardId: string; center: LatLon; radiusM: number;
    delayMs: number; durationMs: number; damage: number; techniqueId: string;
  }>): void {
    const hz = this.options.tickRateHz;
    const landTick = this.currentTick + millisecondsToTicks(input.delayMs, hz);
    const sourceEntityId = `hazard:${input.hazardId}`;
    this.acidZones.push({
      zoneId: input.zoneId, sourceEntityId, center: { ...input.center }, landTick,
      endTick: landTick + millisecondsToTicks(input.durationMs, hz), nextTick: landTick,
      damage: Math.max(1, Math.round(input.damage)), radiusM: input.radiusM, techniqueId: input.techniqueId, burning: true
    });
    const startTime = this.now();
    this.mobCasts.push({
      sourceEntityId,
      zoneId: input.zoneId,
      cast: {
        encounterId: sourceEntityId,
        bossId: "hazard",
        abilityId: input.techniqueId,
        castInstanceId: `${sourceEntityId}:${this.currentTick}`,
        startTime,
        resolveTime: startTime + input.delayMs + input.durationMs,
        origin: { ...input.center },
        geometry: { kind: "circle", center: { ...input.center }, radiusM: input.radiusM },
        lifeGeneration: 0
      }
    });
    if (this.mobCasts.length > 256) this.mobCasts.splice(0, this.mobCasts.length - 256);
    this.markPlayersNearDirty(input.center, input.zoneId);
  }

  /**
   * Boss flight: an airborne mob is in the retreat state (untargetable, out of melee) until it lands,
   * when it turns on retargetPlayerId if given.
   */
  setMobAirborne(entityId: string, airborne: boolean, retargetPlayerId: string | null = null): boolean {
    const mob = this.entities.get(entityId);
    if (!mob || mob.kind !== "mob" || mob.lifeState !== "alive") return false;
    const state = this.mobSpecial(mob);
    if (airborne) {
      state.climbing = true;
      state.climbUntilTick = Number.MAX_SAFE_INTEGER;
      this.disengageMobForRetreat(mob);
      return true;
    }
    state.climbing = false;
    state.climbUntilTick = 0;
    mob.activityState = "idle";
    this.markDirty(mob);
    if (retargetPlayerId) this.directMobTarget(mob.entityId, retargetPlayerId);
    return true;
  }

  /**
   * Removes the damage zones the given owners left behind, with their telegraphs, so a reset or wipe never
   * leaves a pool for the next attempt. Returns how many zones were removed.
   */
  clearDamageZones(ownerEntityIds: Iterable<string>): number {
    const owners = new Set(ownerEntityIds);
    if (owners.size === 0) return 0;
    const removed = this.acidZones.filter((zone) => owners.has(zone.sourceEntityId));
    if (removed.length === 0) return 0;
    this.acidZones = this.acidZones.filter((zone) => !owners.has(zone.sourceEntityId));
    const abilityIds = new Set(removed.flatMap((zone) => zone.techniqueId ? [zone.techniqueId] : []));
    this.mobCasts = this.mobCasts.filter((record) =>
      !(owners.has(record.sourceEntityId) && abilityIds.has(record.cast.abilityId)));
    for (const ownerId of owners) {
      const owner = this.entities.get(ownerId);
      if (owner) this.markDirty(owner);
    }
    return removed.length;
  }

  private processAcidZones(): void {
    if (this.acidZones.length === 0) return;
    const tickIntervalTicks = millisecondsToTicks(RAPTOR_SPITTER.zoneTickMs, this.options.tickRateHz);
    const designIntervalTicks = millisecondsToTicks(ACID_ZONE_DESIGN_TICK_MS, this.options.tickRateHz);
    this.acidZones = this.acidZones.filter((zone) => {
      const source = this.entities.get(zone.sourceEntityId);
      const zoneRoom = zone.zoneId ?? source?.zoneId;
      if (!zoneRoom || this.currentTick >= zone.endTick) return false;
      if (this.currentTick >= zone.nextTick) {
        zone.nextTick += tickIntervalTicks;
        const radiusM = zone.radiusM ?? RAPTOR_SPITTER.zoneRadiusM;
        for (const id of this.grid.query(zone.center, radiusM)) {
          const victim = this.entities.get(id);
          if (!victim || victim.kind !== "player" || victim.lifeState !== "alive" || victim.zoneId !== zoneRoom) continue;
          if (distanceMeters(victim.position, zone.center) > radiusM) continue;
          // A cloud left by a dead mob (a burst sprite) still hurts; its damage is attributed to the victim.
          // The beat has fewer ticks than the old one-second cadence: rescale so the cloud's total holds.
          const scale = acidZoneTickDamageScale(zone.endTick - zone.landTick, designIntervalTicks, tickIntervalTicks);
          const carry = zone.carry ?? (zone.carry = new Map<string, number>());
          const owed = zone.damage * scale + (carry.get(victim.entityId) ?? 0);
          const whole = Math.floor(owed + 1e-9);
          carry.set(victim.entityId, Math.max(0, owed - whole));
          if (whole > 0) {
            this.applyScriptedDamage(
              (source ?? victim).entityId, victim.entityId, whole, zone.techniqueId ?? RAPTOR_SPITTER.techniqueId
            );
          }
          if (zone.poison) this.applyHarmfulStatus(source ?? victim, victim, "poison", 1);
          if (zone.burning) this.applyHarmfulStatus(source ?? victim, victim, "burning", 1);
          if (zone.slow) {
            this.addTimedEffect(source ?? victim, victim, "movement_slow", SLOW_STATUS_TECHNIQUE_ID, zone.slow.durationMs, zone.slow.amount);
          }
        }
      }
      return true;
    });
  }

  private applySickSewerRatHitEffects(attacker: Combatant, target: Combatant): void {
    if (
      attacker.kind !== "mob" || !attacker.archetypeKey || !(attacker.archetypeKey in POISON_BITE_CHANCE) ||
      target.kind !== "player" || target.lifeState !== "alive"
    ) return;
    this.applyHarmfulStatus(attacker, target, "poison", POISON_BITE_CHANCE[attacker.archetypeKey]);
  }

  private resolveEquipmentProc(
    attacker: Combatant,
    target: Combatant,
    appliedDamage: number,
    qualifyingWeaponAttack: boolean,
    override?: Readonly<{
      instanceId: string | null;
      enchantmentIdentity: string | null;
      procSource: "weapon" | "armor";
      itemLevel?: number;
    }>
  ): EquipmentProcResolution {
    const runtimeSequence = Number(attacker.classRuntime?.counters.actionSequence ?? 0);
    const state = attacker.equipmentCombatState;
    const procSource = override?.procSource ?? "weapon";
    // Weapon procs read the hit target; armor procs read the wearer (`attacker` here).
    const victim = procSource === "weapon" ? target : attacker;
    return this.equipmentProcResolver.resolve({
      combatContext:
        attacker.kind === "player" && target.kind === "player"
          ? "pvp_open_world"
          : "pve",
      actionSequence: Number.isSafeInteger(runtimeSequence) && runtimeSequence >= 0
        ? runtimeSequence
        : 0,
      attackerEntityId: attacker.entityId,
      targetEntityId: target.entityId,
      activeWeaponInstanceId: override?.instanceId ?? state?.activeWeaponInstanceId ?? null,
      enchantmentIdentity: override?.enchantmentIdentity ?? state?.activeWeaponEnchantmentIdentity ?? null,
      landed: appliedDamage > 0,
      qualifyingWeaponAttack,
      appliedDamage,
      procSource,
      procContext: {
        victimHealthFraction: victim.maxHealth > 0 ? Math.max(0, victim.currentHealth) / victim.maxHealth : 1,
        attackerQuality: procSource === "weapon"
          ? this.metalQuality(attacker, "weapon")
          : override?.itemLevel ?? 0,
        defenderQuality: this.metalQuality(target, procSource === "weapon" ? "defense" : "weapon"),
        killingBlow: victim.currentHealth <= 0
      }
    });
  }

  /** Q for the proc quality multiplier: gear item level for players, level / 5 for mobs. */
  private metalQuality(entity: Combatant, part: "weapon" | "defense"): number {
    if (entity.kind === "mob") return mobMetalProcQuality(entity.level);
    const state = entity.equipmentCombatState;
    if (!state) return 0;
    if (part === "weapon") return state.stats.items[state.activeWeaponSlot]?.itemLevel ?? 0;
    const shield = state.stats.items.secondary?.category === "shield"
      ? state.stats.items.secondary.itemLevel
      : 0;
    return Math.max(state.stats.items.chest?.itemLevel ?? 0, shield);
  }

  private randomMetalDamage(min: number, max: number): number {
    const roll = this.options.random?.() ?? Math.random();
    return min + Math.min(max - min, Math.floor(roll * (max - min + 1)));
  }

  /**
   * Applies the effect of a metal proc. `owner` carries the metal (the wielder or
   * the wearer); `opponent` is the combatant on the other side of the hit.
   */
  private applyEquipmentProcResolution(
    owner: Combatant,
    opponent: Combatant,
    resolution: EquipmentProcResolution,
    procSource: "weapon" | "armor" = "weapon"
  ): void {
    for (const application of resolution.statusApplications) {
      if (application.applied) this.applyMetalEffect(owner, opponent, application.statusId, procSource);
    }
  }

  private applyReactiveArmorProcs(wearer: Combatant, attacker: Combatant, appliedDamage: number): void {
    if (wearer.kind !== "player" || attacker.entityId === wearer.entityId) return;
    // Pieces sharing a metal do not stack: one roll per distinct metal, from the highest-level piece.
    const pieces = (wearer.equipmentCombatState?.reactiveArmorEnhancements ?? []).map((piece) => ({
      instanceId: piece.instanceId,
      enchantmentIdentity: piece.enchantmentIdentity,
      itemLevel: piece.itemLevel ?? 0
    }));
    for (const armor of distinctArmorMetals(pieces)) {
      this.applyEquipmentProcResolution(
        wearer,
        attacker,
        this.resolveEquipmentProc(wearer, attacker, appliedDamage, true, {
          instanceId: armor.instanceId,
          enchantmentIdentity: armor.enchantmentIdentity,
          procSource: "armor",
          itemLevel: armor.itemLevel
        }),
        "armor"
      );
    }
  }

  /** Metal procs hit mobs, players and city defenders; never companions, invulnerables, or protected players. */
  private metalProcTargetable(owner: Combatant, target: Combatant): boolean {
    if (owner.entityId === target.entityId) return false;
    if (target.kind === "mob" && (target.companionDogId || target.npcFaction?.invulnerable === true)) return false;
    if (this.options.isEntityInvulnerable?.(target.entityId)) return false;
    if (target.kind === "player") {
      if (this.flagArrivalProtectionUntil(target.entityId) !== null) return false;
      if (owner.kind === "player" && this.options.isPvpBlocked?.(owner.entityId, target.entityId) === true) return false;
      if (owner.kind === "player" && owner.entityId !== target.entityId &&
        this.pvpRuleRefusal(owner.entityId, target) === "pvp-defeat-safety") return false;
    }
    return true;
  }

  /** Area and spread effects re-run the full attack-pair gates (zones, trust shield, view authority). */
  private metalSecondaryTargetValid(owner: Combatant, target: Combatant): boolean {
    return this.isAttackPairValid(owner, target) && this.metalProcTargetable(owner, target);
  }

  private metalImmune(target: Combatant, archetypes: readonly string[]): boolean {
    return target.kind === "mob" && target.archetypeKey !== null && archetypes.includes(target.archetypeKey);
  }

  private applyMetalEffect(
    owner: Combatant,
    opponent: Combatant,
    effectId: string,
    procSource: "weapon" | "armor"
  ): void {
    if (owner.kind !== "player" || !this.metalProcTargetable(owner, opponent)) return;
    if (effectId === "expel") {
      // `lethal`: the expelled combatant (always the opponent) is already down.
      this.applyMetalExpel(owner, opponent, opponent.currentHealth <= 0);
      return;
    }
    const ownerAlive = owner.lifeState === "alive" && owner.currentHealth > 0;
    const opponentAlive = opponent.lifeState === "alive" && opponent.currentHealth > 0;
    if (!ownerAlive) return;
    switch (effectId) {
      case "vitality":
        this.commitNormalHealing(
          owner.entityId, owner,
          this.randomMetalDamage(METAL_PROC_BALANCE.vital.healMin, METAL_PROC_BALANCE.vital.healMax)
        );
        return;
      case "knockback":
        this.applyMetalGale(owner);
        return;
      case "blink":
        if (opponentAlive) this.applyMetalMirage(owner, opponent, procSource);
        return;
    }
    if (!opponentAlive) return;
    switch (effectId) {
      case "poison": this.applyMetalPoison(owner, opponent); break;
      case "burning": this.applyMetalBurn(owner, opponent); break;
      case "storm":
        this.upsertMetalStatus(owner, opponent, {
          kind: "storm", id: `${opponent.entityId}:elemental:storm`,
          techniqueId: METAL_STORM_ID, durationMs: METAL_PROC_BALANCE.storm.durationMs,
          tickMs: METAL_PROC_BALANCE.storm.pulseMs
        });
        break;
      case "slow":
        this.addTimedEffect(
          owner, opponent, "movement_slow", "elemental_ice_slow",
          METAL_PROC_BALANCE.frost.durationMs, METAL_PROC_BALANCE.frost.slowFraction
        );
        break;
      case "whetted":
        if (procSource === "weapon") {
          this.addTimedEffect(
            owner, opponent, "whetted_defense", "metal_whetted_weapon",
            METAL_PROC_BALANCE.whetted.durationMs, METAL_PROC_BALANCE.whetted.defenseReduction
          );
        } else {
          this.addTimedEffect(
            owner, opponent, "whetted_attack", "metal_whetted_armor",
            METAL_PROC_BALANCE.whetted.durationMs, METAL_PROC_BALANCE.whetted.attackReduction
          );
        }
        break;
      case "withered":
        this.upsertMetalStatus(owner, opponent, {
          kind: "gloom", id: `${opponent.entityId}:harmful:gloom`, techniqueId: "metal_gloom_withered",
          durationMs: METAL_PROC_BALANCE.gloom.durationMs, tickMs: null
        });
        break;
      case "steal_speed":
        this.addTimedEffect(
          owner, opponent, "movement_slow", "metal_fleet_slow",
          METAL_PROC_BALANCE.fleet.durationMs, METAL_PROC_BALANCE.fleet.stealFraction
        );
        this.addTimedEffect(
          owner, owner, "out_of_combat_movement", "metal_fleet_boost",
          METAL_PROC_BALANCE.fleet.durationMs, METAL_PROC_BALANCE.fleet.stealFraction
        );
        break;
      case "vengeance":
        if (procSource === "weapon") {
          this.addTimedEffect(
            owner, opponent, "vengeance_mark", "metal_vengeance_weapon",
            METAL_PROC_BALANCE.vengeance.windowMs, METAL_PROC_BALANCE.vengeance.weaponDamage
          );
        } else {
          this.addTimedEffect(
            owner, opponent, "vengeance_mark", "metal_vengeance_armor",
            METAL_PROC_BALANCE.vengeance.windowMs, METAL_PROC_BALANCE.vengeance.armorDamage,
            [owner.entityId]
          );
        }
        break;
      case "immobilize":
        this.applyMetalImmobilize(owner, opponent);
        break;
    }
  }

  /**
   * Upserts one timed status per target and kind. Re-applying refreshes the
   * duration ("wears off N seconds after the last attack of this type"); it never stacks.
   */
  private upsertMetalStatus(
    owner: Combatant,
    target: Combatant,
    spec: Readonly<{
      kind: "poison" | "burning" | "storm" | "gloom";
      id: string;
      techniqueId: string;
      durationMs: number;
      tickMs: number | null;
    }>
  ): boolean {
    if (this.hasV3CleanseImmunity(target)) return false;
    const hz = this.options.tickRateHz;
    const runtime = target.classRuntime ?? (target.classRuntime = emptyRuntime());
    const durationTicks = Math.max(1, millisecondsToTicks(spec.durationMs, hz));
    // The tick interval becomes a whole number of beats; the status timer itself stays exact.
    const tickTicks = spec.tickMs === null ? null : this.periodicIntervalTicks(spec.tickMs);
    const pulses = tickTicks === null ? 1 : Math.max(1, Math.floor(durationTicks / tickTicks));
    const firstTick = tickTicks === null
      ? Number.MAX_SAFE_INTEGER
      : this.firstPeriodicTick(owner.entityId, target, tickTicks);
    const existing = runtime.effects.find((effect) => effect.id === spec.id);
    if (existing) {
      existing.sourceEntityId = owner.entityId;
      existing.sourceTechniqueId = spec.techniqueId;
      existing.startTick = this.currentTick;
      existing.stacks = pulses;
      existing.maximumStacks = pulses;
      if (tickTicks === null) existing.nextTick = Number.MAX_SAFE_INTEGER;
      else if (existing.nextTick <= this.currentTick || existing.nextTick > firstTick) existing.nextTick = firstTick;
      existing.endTick = tickTicks === null
        ? this.currentTick + durationTicks
        : Math.max(this.currentTick + durationTicks, existing.nextTick + tickTicks * (pulses - 1));
    } else {
      runtime.effects.push({
        id: spec.id, kind: spec.kind, sourceTechniqueId: spec.techniqueId,
        sourceEntityId: owner.entityId, startTick: this.currentTick,
        endTick: tickTicks === null
          ? this.currentTick + durationTicks
          : Math.max(this.currentTick + durationTicks, firstTick + tickTicks * (pulses - 1)),
        nextTick: firstTick,
        stacks: pulses, maximumStacks: pulses, amount: 0, cleansable: true, minor: false
      });
    }
    this.markDirty(target);
    if (target.kind === "player") this.rememberClassRuntime(target);
    return true;
  }

  private applyMetalPoison(owner: Combatant, target: Combatant): void {
    const balance = METAL_PROC_BALANCE.poison;
    if (this.metalImmune(target, balance.immuneArchetypes) || isShelled(target.special, this.currentTick)) return;
    if (this.isVenomImmune(target)) return;
    this.upsertMetalStatus(owner, target, {
      kind: "poison", id: `${target.entityId}:harmful:poison`, techniqueId: METAL_VENOM_POISON_ID,
      durationMs: balance.durationMs, tickMs: balance.tickMs
    });
  }

  private applyMetalBurn(
    owner: Combatant,
    target: Combatant,
    durationMs: number = METAL_PROC_BALANCE.burning.durationMs
  ): boolean {
    const balance = METAL_PROC_BALANCE.burning;
    if (this.metalImmune(target, balance.immuneArchetypes) || isShelled(target.special, this.currentTick)) return false;
    return this.upsertMetalStatus(owner, target, {
      kind: "burning", id: `${target.entityId}:elemental:burning`, techniqueId: METAL_EMBER_BURN_ID,
      durationMs, tickMs: balance.tickMs
    });
  }

  /**
   * Each burn tick may spread to the nearest non-burning enemy. The new fire lasts 0.45x
   * its parent's full duration (27 s -> ~12 s -> ~5.5 s) and a fire under 4.5 s cannot spread.
   */
  private spreadMetalBurn(target: Combatant, effect: CombatEffect): void {
    const balance = METAL_PROC_BALANCE.burning;
    const fullDurationMs = (effect.endTick - effect.startTick) * 1_000 / this.options.tickRateHz;
    if (fullDurationMs < balance.minSpreadDurationMs) return;
    if ((this.options.random?.() ?? Math.random()) >= balance.spreadChancePerTick) return;
    const source = this.entities.get(effect.sourceEntityId);
    if (source?.kind !== "player" || source.lifeState !== "alive") return;
    const next = this.nearbyEntityIds(target.position, balance.spreadRadiusM)
      .map((id) => this.entities.get(id))
      .filter((candidate): candidate is Combatant => Boolean(
        candidate && candidate.entityId !== target.entityId && candidate.lifeState === "alive" &&
        distanceMeters(target.position, candidate.position) <= balance.spreadRadiusM &&
        !this.hasEffect(candidate, "burning") &&
        this.metalSecondaryTargetValid(source, candidate)
      ))
      .sort((left, right) =>
        distanceMeters(target.position, left.position) - distanceMeters(target.position, right.position) ||
        left.entityId.localeCompare(right.entityId)
      )[0];
    if (next) this.applyMetalBurn(source, next, fullDurationMs * balance.spreadDurationFraction);
  }

  /** Immobilize (can still attack), then a short immunity so it cannot be chained. */
  private applyMetalImmobilize(owner: Combatant, target: Combatant): void {
    const balance = METAL_PROC_BALANCE.skyrise;
    if (this.hasEffect(target, "immobilized") || this.hasEffect(target, "immobilize_immunity")) return;
    if (this.hasV3CleanseImmunity(target)) return;
    this.addTimedEffect(owner, target, "immobilized", "metal_skyrise", balance.immobilizeMs, 1);
    this.addTimedEffect(
      owner, target, "immobilize_immunity", "metal_skyrise_immunity",
      balance.immobilizeMs + balance.immunityMs, 1
    );
    if (target.kind === "player") this.options.stopPlayer?.(target.entityId);
  }

  private pushAwayFrom(origin: LatLon, victim: Combatant, distanceM: number): void {
    if (victim.kind === "player") {
      this.knockbackPlayer(victim.entityId, origin, distanceM);
      return;
    }
    if (victim.bossOwnership !== null) return;
    const bearing = initialBearingDegrees(origin, victim.position);
    for (const fraction of [1, 0.75, 0.5, 0.25]) {
      if (this.placeMobAtFirstTraversable(victim, [destinationPoint(victim.position, distanceM * fraction, bearing)])) {
        victim.chaseDestination = null;
        return;
      }
    }
  }

  /** Gale: every enemy within range takes fixed damage and is thrown back. */
  private applyMetalGale(owner: Combatant): void {
    const balance = METAL_PROC_BALANCE.gale;
    const victims = this.nearbyEntityIds(owner.position, balance.radiusM)
      .map((id) => this.entities.get(id))
      .filter((candidate): candidate is Combatant => Boolean(
        candidate && candidate.entityId !== owner.entityId && candidate.lifeState === "alive" &&
        candidate.currentHealth > 0 &&
        distanceMeters(owner.position, candidate.position) <= balance.radiusM &&
        this.metalSecondaryTargetValid(owner, candidate)
      ))
      .sort((left, right) =>
        distanceMeters(owner.position, left.position) - distanceMeters(owner.position, right.position) ||
        left.entityId.localeCompare(right.entityId)
      )
      .slice(0, balance.maximumTargets);
    const origin = { ...owner.position };
    for (const victim of victims) {
      this.applyDamage(
        owner, victim, balance.damage, "metal_wind", false, {}, 0, false, "area",
        { fixedFinalDamage: balance.damage }
      );
      if (victim.lifeState === "alive") this.pushAwayFrom(origin, victim, balance.knockbackM);
    }
  }

  private blinkPlayer(player: Combatant, destination: LatLon): boolean {
    const hopM = distanceMeters(player.position, destination);
    if (!this.options.repositionPlayer?.(player.entityId, destination, hopM + 50)) return false;
    this.grid.update(player.entityId, destination);
    player.position = { ...destination };
    this.markDirty(player);
    return true;
  }

  /**
   * Mirage: a weapon proc blinks the wielder to a random spot near the target; an armor
   * proc blinks the wearer away from the attacker. Either way the next attack within the
   * window deals bonus damage.
   */
  private applyMetalMirage(owner: Combatant, opponent: Combatant, procSource: "weapon" | "armor"): void {
    const balance = METAL_PROC_BALANCE.mirage;
    const roll = (): number => this.options.random?.() ?? Math.random();
    for (let attempt = 0; attempt < balance.blinkAttempts; attempt += 1) {
      const destination = procSource === "weapon"
        ? destinationPoint(opponent.position, balance.blinkRadiusM * Math.sqrt(roll()), roll() * 360)
        : destinationPoint(
            owner.position,
            balance.escapeMinM + roll() * (balance.escapeMaxM - balance.escapeMinM),
            initialBearingDegrees(opponent.position, owner.position) + (attempt === 0 ? 0 : (roll() - 0.5) * 90)
          );
      if (this.blinkPlayer(owner, destination)) break;
    }
    const runtime = owner.classRuntime ?? (owner.classRuntime = emptyRuntime());
    runtime.counters.metalMirageEndsAt = this.now() + balance.bonusWindowMs;
    this.rememberClassRuntime(owner);
  }

  /** Consumes the pending Mirage bonus when a direct attack lands; expired charges are dropped. */
  private consumeMirageBonus(attacker: Combatant, eligible: boolean): number {
    const runtime = attacker.classRuntime;
    if (!eligible || attacker.kind !== "player" || !runtime) return 0;
    const endsAt = Number(runtime.counters.metalMirageEndsAt ?? 0);
    if (endsAt === 0) return 0;
    delete runtime.counters.metalMirageEndsAt;
    return endsAt >= this.now() ? METAL_PROC_BALANCE.mirage.bonusDamage : 0;
  }

  /** Vengeance: the marked combatant's next landed attack reflects fixed damage back at it. */
  private triggerVengeanceMarks(attacker: Combatant, victim: Combatant): void {
    const runtime = attacker.classRuntime;
    const marks = runtime?.effects.filter((effect) =>
      effect.kind === "vengeance_mark" && effect.endTick >= this.currentTick &&
      (!effect.enemyIds || effect.enemyIds.includes(victim.entityId))
    );
    if (!runtime || !marks || marks.length === 0) return;
    runtime.effects = runtime.effects.filter((effect) => !marks.includes(effect));
    this.markDirty(attacker);
    for (const mark of marks) {
      const owner = this.entities.get(mark.sourceEntityId);
      if (owner?.kind !== "player" || owner.lifeState !== "alive" || attacker.lifeState !== "alive") continue;
      if (!this.metalSecondaryTargetValid(owner, attacker)) continue;
      this.applyDamage(
        owner, attacker, mark.amount, "metal_vengeance", false, {}, 0, false, "area",
        { fixedFinalDamage: mark.amount }
      );
    }
  }

  /**
   * Expel: players only. The host teleports the victim to their Manor entrance (or respawn
   * point), never inside dungeons or interiors; 60 s of expel immunity follows.
   */
  private applyMetalExpel(owner: Combatant, target: Combatant, lethal: boolean): void {
    const handler = this.expelHandler;
    if (!handler || target.kind !== "player" || owner.entityId === target.entityId) return;
    if (target.regionCode.startsWith("interior:") || target.zoneId.startsWith("interior:")) return;
    const now = this.now();
    if ((this.expelImmuneUntilMs.get(target.entityId) ?? 0) > now) return;
    if (!handler.canExpel(target.entityId)) return;
    this.expelImmuneUntilMs.set(target.entityId, now + METAL_PROC_BALANCE.expel.immunityMs);
    void Promise.resolve(handler.expel(target.entityId, lethal))
      .then((expelled) => { if (!expelled) this.expelImmuneUntilMs.delete(target.entityId); })
      .catch(() => { this.expelImmuneUntilMs.delete(target.entityId); });
  }

  /** Whether a player is currently Immobilized (Skyrise). The world tick blocks their movement. */
  isPlayerImmobilized(playerId: string): boolean {
    const player = this.entities.get(playerId);
    return player !== undefined && (this.hasEffect(player, "immobilized") || this.hasEffect(player, "stunned"));
  }

  /** Mob fire-bird burn: a short fixed burn, unrelated to the Ember metal. */
  private applyElementalBurn(source: Combatant, target: Combatant): void {
    if (this.hasV3CleanseImmunity(target)) return;
    const balance = ELEMENTAL_BIRD_BURN;
    const runtime = target.classRuntime ?? (target.classRuntime = emptyRuntime());
    const intervalTicks = this.periodicIntervalTicks(balance.tickMs);
    const pulses = beatPulseCount(balance.durationMs, balance.tickMs);
    const firstTick = this.firstPeriodicTick(source.entityId, target, intervalTicks);
    runtime.effects = runtime.effects.filter((effect) => effect.kind !== "burning");
    runtime.effects.push({
      id: `${target.entityId}:elemental:burning`, kind: "burning",
      sourceTechniqueId: "elemental_fire_burning", sourceEntityId: source.entityId,
      startTick: this.currentTick, endTick: firstTick + intervalTicks * (pulses - 1),
      nextTick: firstTick, stacks: pulses, maximumStacks: pulses,
      amount: balance.damagePerTick * beatAlignedAmountScale(balance.tickMs), cleansable: true, minor: false
    });
    this.markDirty(target);
  }

  private applyDamage(
    attacker: Combatant,
    target: Combatant,
    deterministicDamage: number,
    sourceTechniqueId: string,
    direct: boolean,
    defenseMitigation: DefenseMitigation = {},
    defense = 0,
    reactiveArmorHit = direct,
    attackKind?: "targeted" | "area",
    attackContext: AttackResolutionContext = {}
  ): number {
    if (this.isPlayerReserved(attacker.entityId) || this.isPlayerReserved(target.entityId)) {
      this.deferredReplenishEffects.push(() => {
        this.applyDamage(attacker, target, deterministicDamage, sourceTechniqueId, direct,
          defenseMitigation, defense, reactiveArmorHit, attackKind, attackContext);
      });
      return 0;
    }
    if (attackContext.suppressed || target.npcFaction?.invulnerable === true ||
        this.options.isEntityInvulnerable?.(target.entityId)) return 0;
    if (target.kind === "mob" && this.golemForgeBlocksDamage(attacker, target)) return 0;
    if (target.kind === "mob" && this.vaultWardBlocksDamage(attacker, target)) return 0;
    if (attacker.kind === "mob" && sourceTechniqueId === "enemy_basic_attack" && this.passiveMobs.has(attacker.entityId)) return 0;
    // A turtle withdrawn into its shell takes no damage and deals none.
    if (isShelled(target.special, this.currentTick) || isShelled(attacker.special, this.currentTick) ||
        isStunned(attacker.special, this.currentTick)) return 0;
    if (target.lifeState !== "alive") return 0;
    // One swing: a multi-hit or area attack lands nothing more once the strike block starts.
    if (attacker.kind === "player" && target.kind === "player" && this.pvpStrikeBlocked(attacker, target)) return 0;
    if (direct && attackContext.fixedFinalDamage === undefined) {
      // Whetted: the target's defense and the attacker's attack are reduced while the effect lasts.
      const defenseLoss = this.effectTotal(target, "whetted_defense");
      if (defenseLoss > 0) defense = Math.max(0, defense - defenseLoss);
      const attackLoss = this.effectTotal(attacker, "whetted_attack");
      if (attackLoss > 0) deterministicDamage = Math.max(1, deterministicDamage - attackLoss);
    }
    // Monastery of the Still Hand: weapons deal no damage there; players fight unarmed.
    if (attacker.kind === "player" && target.kind === "mob" && this.isArmedInMonastery(attacker)) return 0;
    // Monastery mobs pause their basic attacks while a telegraphed strike winds up; dormant statues do nothing.
    if (attacker.kind === "mob" && sourceTechniqueId.endsWith("_basic_attack") && (
      isWindingUp(attacker.monastery) || isVaultWindingUp(attacker.vault) ||
      (attacker.archetypeKey === "iron_statue" && attacker.monastery?.awake !== true)
    )) return 0;
    const bossOutgoingMultiplier = attacker.kind === "mob"
      ? this.damageCombatModifiers(attacker)?.outgoingDamageMultiplier
      : undefined;
    if (bossOutgoingMultiplier !== undefined && bossOutgoingMultiplier <= 0) return 0;
    // A shielded elite absorbs every hit while its shield is up.
    if (target.kind === "mob" && target.bossOwnership === null) {
      const incoming = this.damageCombatModifiers(target)?.incomingDamageMultiplier;
      if (incoming !== undefined && incoming <= 0) return 0;
    }
    const basicIncoming = sourceTechniqueId.endsWith("_basic_attack");
    const targetedAttack = attackKind === undefined
      ? this.isTargetedAttack(sourceTechniqueId)
      : attackKind === "targeted";
    const targetedBasicOrWeapon = this.isTargetedBasicOrWeaponAttack(sourceTechniqueId, targetedAttack);
    if (basicIncoming && direct && attacker.entityId !== target.entityId && this.isNinjaInvisible(target)) {
      if (attacker.kind === "mob" && attacker.targetEntityId === target.entityId) this.clearTarget(attacker);
      attackContext.suppressed = true;
      return 0;
    }
    if (
      attacker.kind === "mob" &&
      target.kind === "player" &&
      this.flagArrivalProtectionUntil(target.entityId) !== null
    ) return 0;
    attackContext.resolvedTargetEntityId = target.entityId;
    if (direct && attacker.kind === "mob" && target.kind === "player") {
      const intervene = target.classRuntime?.effects.find((effect) =>
        effect.kind === "intervene" && effect.sourceTechniqueId === "knight_intervene" &&
        effect.endTick >= this.currentTick
      );
      const knight = intervene ? this.entities.get(intervene.sourceEntityId) : null;
      if (intervene && knight?.kind === "player" && knight.lifeState === "alive" &&
        knight.classRuntime?.activeClassId === "knight" && knight.entityId !== target.entityId &&
        this.flagArrivalProtectionUntil(knight.entityId) === null) {
        target.classRuntime!.effects = target.classRuntime!.effects.filter((effect) => effect !== intervene);
        this.markDirty(target);
        this.rememberClassRuntime(target);
        return this.applyDamage(attacker, knight,
          Math.max(0, Math.round(deterministicDamage * (1 - intervene.amount))),
          "knight_intervene", false, defenseMitigation, this.effectiveDefense(knight), reactiveArmorHit);
      }
    }
    if (direct && attacker.kind === "mob" && target.kind === "player") {
      const concussed = attacker.classRuntime?.effects.find(
        (effect) => effect.kind === "concussed" && effect.stacks > 0 && effect.endTick >= this.currentTick
      );
      if (concussed && attacker.classRuntime) {
        attacker.classRuntime.effects = attacker.classRuntime.effects.filter((effect) => effect !== concussed);
        this.markDirty(attacker);
        attackContext.suppressed = true;
        attackContext.damageEvent = this.emitEvent("DAMAGE", attacker.entityId, target.entityId, 0, target.currentHealth);
        return 0;
      }
    }
    if (basicIncoming && targetedAttack && direct && attacker.kind === "player" &&
      target.kind === "mob" && target.archetypeKey === "shadow_acrobat" &&
      (this.options.random?.() ?? Math.random()) < SHADOW_ACROBAT.dodgeChance) {
      attackContext.suppressed = true;
      this.emitInnateEvent(target.entityId, target.entityId, "DODGE", SHADOW_ACROBAT.dodgeId);
      attackContext.damageEvent = this.emitEvent("DAMAGE", attacker.entityId, target.entityId, 0, target.currentHealth);
      return 0;
    }
    // Crane glow: a direct, targeted strike is turned back on the attacker and the Grandmaster takes nothing.
    // Damage over time and other indirect damage is not reflected (it still lands on him).
    const reflectFraction = direct && targetedAttack && attacker.kind === "player" && target.kind === "mob"
      ? this.damageReflect.get(target.entityId)
      : undefined;
    if (reflectFraction !== undefined && attacker.lifeState === "alive" && attacker.entityId !== target.entityId) {
      const reflected = Math.round(damageFromStats(deterministicDamage, defense) * reflectFraction);
      attackContext.suppressed = true;
      attackContext.damageEvent = this.emitEvent("DAMAGE", attacker.entityId, target.entityId, 0, target.currentHealth);
      // Indirect and non-reactive: no Intervene redirect, no armor procs.
      if (reflected > 0) this.applyDamage(target, attacker, reflected, "grandmaster_crane_reflect", false, {}, 0, false);
      return 0;
    }
    if (basicIncoming && targetedAttack && direct && attacker.entityId !== target.entityId &&
      (Boolean(target.classRuntime?.skillV3) || this.ninjaTunicEligible(target))) {
      const dodgeChance = target.classRuntime?.skillV3
        ? this.v3DodgeChance(target, attacker)
        : Math.min(target.level * NINJA_INNATE_BALANCE.dodgePerLevel, NINJA_INNATE_BALANCE.dodgeMaximum) * this.frostDodgeMultiplier(target);
      if ((this.options.random?.() ?? Math.random()) < dodgeChance) {
        if (!target.classRuntime?.skillV3 && target.classRuntime?.equippedPassives.has("ninja_v2_afterimage")) {
          this.addTimedEffect(target, target, "out_of_combat_movement", "ninja_v2_afterimage", 3_000, 0.2);
        }
        attackContext.suppressed = true;
        this.emitInnateEvent(target.entityId, target.entityId, "DODGE", "ninja_way_of_the_ninja");
        attackContext.damageEvent = this.emitEvent("DAMAGE", attacker.entityId, target.entityId, 0, target.currentHealth);
        return 0;
      }
    }
    deterministicDamage *= this.v3AssassinSurpriseMultiplier(
      attacker,
      target,
      direct && targetedBasicOrWeapon
    );
    const attackerRuntime = attacker.classRuntime;
    if (direct && attacker.kind === "player" && attackerRuntime?.skillV3) {
      deterministicDamage += this.v3ConcentrationBonus(attacker, target);
      const perfectStrikeRank = this.generalRankInZone(attacker, "perfect_strike");
      if (
        target.kind === "mob" && target.currentHealth === target.maxHealth &&
        perfectStrikeRank > 0 && !this.isBossMob(target) &&
        (this.options.random?.() ?? Math.random()) < ([0.025, 0.045, 0.07][Math.min(3, perfectStrikeRank) - 1] ?? 0.07)
      ) deterministicDamage = target.currentHealth + defense;
      const pierceRank = attackerRuntime.skillV3.generalSkillRanks.pierce_armor ?? 0;
      const weaponFamily = equipmentGameplayFamily(attackerRuntime.weaponDefinitionId) ?? attackerRuntime.weaponCategory;
      if (
        target.kind === "mob" && targetedBasicOrWeapon &&
        requireGeneralSkillDefinition("pierce_armor").useEquipmentRequirement?.includes(weaponFamily ?? "") &&
        pierceRank > 0 &&
        Number(attackerRuntime.counters.skillV3PierceArmorReadyAt ?? 0) <= this.now()
      ) {
        const fraction = pierceRank >= 3 ? 0.38 : pierceRank >= 2 ? 0.30 : 0.22;
        const cap = pierceRank >= 3 ? 38 : pierceRank >= 2 ? 30 : 22;
        const pierceDamage = Math.min(cap, Math.max(1, Math.round(target.currentHealth * fraction)));
        if (pierceDamage >= damageFromStats(deterministicDamage, defense)) {
          deterministicDamage = pierceDamage + defense;
          attackerRuntime.counters.skillV3PierceArmorReadyAt = this.now() + V3_PIERCE_ARMOR_COOLDOWN_MS;
        }
      }
    }
    const districtDamageBonus =
      direct && attacker.kind === "player" && target.kind === "mob"
        ? this.options.getCityDistrictCombatBenefits?.(attacker.entityId)
            .directPveDamageBonus ?? 0
        : 0;
    deterministicDamage += districtDamageBonus;
    if (attacker.kind === "mob" && this.hunterSnareEffect(attacker)) {
      deterministicDamage = Math.max(1, Math.round(deterministicDamage * HUNTER_BALANCE.snareDamageMultiplier));
    }
    let outgoingMultiplier = Math.max(0.1, 1 + this.effectTotalForTarget(attacker, "outgoing_damage", target.entityId));
    if (target.kind === "mob") {
      const exposure = Math.max(
        0,
        ...(target.classRuntime?.effects
          .filter((effect) => effect.kind === "quarry_exposure" && effect.endTick >= this.currentTick)
          .map((effect) => effect.amount) ?? [])
      );
      outgoingMultiplier *= 1 + exposure;
    }
    if (bossOutgoingMultiplier !== undefined) {
      outgoingMultiplier *= Math.max(0, bossOutgoingMultiplier);
    }
    if (attacker.kind === "player") {
      outgoingMultiplier *= 1 + Math.max(0, this.options.getMonolithOutgoingDamageBonus?.(attacker.entityId) ?? 0);
    }
    const districtDefenseBonus =
      attacker.kind === "mob" && target.kind === "player"
        ? this.options.getCityDistrictCombatBenefits?.(target.entityId)
            .pveDefenseBonus ?? 0
        : 0;
    const rangerDamageAction = sourceTechniqueId === "ranger_basic_attack" ||
      (sourceTechniqueId.startsWith("ranger_v2_") && !this.isPassiveGeneratedTechnique(sourceTechniqueId));
    const wildSlayerBonus = rangerDamageAction && attacker.classRuntime?.activeClassId === "ranger" && target.kind === "mob" &&
      attacker.classRuntime.equippedPassives.has("ranger_v2_suppressing_fire") &&
      attacker.classRuntime.counters.v2WildSlayerSpecies === target.archetypeKey &&
      Number(attacker.classRuntime.counters.v2WildSlayerEndsAt ?? 0) >= this.now()
        ? 2
        : 0;
    // Provoke: monsters have no Defense to subtract, so it adds +1/+2 raw damage instead.
    const provokeBonus = target.kind === "mob"
      ? Math.max(0, ...(target.classRuntime?.effects
        .filter((effect) =>
          effect.kind === "provoke_exposure" && effect.sourceTechniqueId === "v3_general_provoke" &&
          effect.endTick >= this.currentTick
        )
        .map((effect) => effect.amount) ?? []))
      : 0;
    const defendedDamage = damageFromStats(
      Math.max(1, Math.round((deterministicDamage + wildSlayerBonus + provokeBonus) * outgoingMultiplier)),
      defense + districtDefenseBonus
    );
    const targetRuntime = target.classRuntime;
    const passiveGenerated = this.isPassiveGeneratedTechnique(sourceTechniqueId);
    const percentageMitigation = this.effectTotal(target, "incoming_mitigation");
    let damageFactor = 1 - Math.max(-0.5, Math.min(0.75, percentageMitigation));
    const mitigationBySource: DefenseMitigation = {};
    for (const [source, amount] of Object.entries(defenseMitigation) as Array<[CombatMitigationSource, number]>) {
      mitigationBySource[source] = amount * outgoingMultiplier;
    }
    const enemyQueueHit = Boolean(
      direct &&
      attacker.kind === "mob" &&
      target.kind === "player"
    );
    if (enemyQueueHit && targetRuntime) {
      Math.max(0, this.validOwnedEnemyCount(target.entityId) - 1);
      const queueMitigation = 0;
      const crowdMitigation = 0;
      const guardMitigation = targetRuntime.subclassId === "warden"
        ? Math.min(
            WARRIOR_BALANCE.guardMitigationMaximum,
            targetRuntime.guard * WARRIOR_BALANCE.guardMitigationPerPoint
          )
        : 0;
      const fortifyMitigation = this.fortifyApplies(target.entityId, attacker.entityId)
        ? WARRIOR_BALANCE.fortifyMitigation
        : 0;
      const reprisalMitigation = targetRuntime.subclassId === "warden" &&
        targetRuntime.counters.reprisalReady === true
        ? WARRIOR_BALANCE.reprisalNextAttackMitigation
        : 0;
      if (reprisalMitigation > 0) {
        targetRuntime.counters.reprisalReady = false;
        this.rememberClassRuntime(target);
      }
      let damageBeforeSource = defendedDamage * damageFactor;
      for (const [source, mitigation] of [
        ["queue_discipline", queueMitigation],
        ["crowd_breaker", crowdMitigation],
        ["guard", guardMitigation],
        ["fortify", fortifyMitigation],
        ["guardians_reprisal", reprisalMitigation]
      ] as const) {
        mitigationBySource[source] = (mitigationBySource[source] ?? 0) + damageBeforeSource * mitigation;
        damageBeforeSource *= 1 - mitigation;
        damageFactor *= 1 - mitigation;
      }
    }
    const bossIncomingMultiplier = target.kind === "mob"
      ? this.damageCombatModifiers(target)?.incomingDamageMultiplier
      : undefined;
    if (bossIncomingMultiplier !== undefined) {
      damageFactor *= Math.max(0, bossIncomingMultiplier);
    }
    if (attacker.kind === "mob" && attacker.archetypeKey === "spiderling") {
      damageFactor *= spiderlingSwarmDamageFactor(this.spiderlingAlliesOnTarget(attacker, target));
    }
    if (attacker.kind === "mob" && attacker.archetypeKey === "rot_wolf") {
      damageFactor *= packDamageFactor(this.spiderlingAlliesOnTarget(attacker, target));
    }
    if (attacker.kind === "mob" && isWarRoared(attacker.special, this.currentTick)) {
      damageFactor *= roarDamageMultiplier(attacker.archetypeKey, WAR_ROAR_DAMAGE_MULTIPLIER);
    }
    if (attacker.kind === "mob" && attacker.special && attacker.special.backstabUntilTick > this.currentTick) {
      damageFactor *= BANDIT_BACKSTAB.damageFactor;
    }
    if (
      this.archBasicDamageFactor !== null && attacker.kind === "mob" &&
      attacker.entityId === this.archBasicDamageAttackerId && sourceTechniqueId === "enemy_basic_attack"
    ) {
      // Mob AI Phase 2: the archetype's basic hit factor (cycle / 1400; Swarmer 0.3), set only around its strike.
      damageFactor *= this.archBasicDamageFactor;
    }
    if (
      attacker.kind === "mob" && target.kind === "player" && sourceTechniqueId === "enemy_basic_attack" &&
      pounceReady(attacker.archetypeKey, attacker.special?.pounceTargetId ?? null, target.entityId)
    ) {
      damageFactor *= POUNCE.damageFactor;
    }
    if (
      target.kind === "mob" && target.special &&
      (target.special.staggerUntilTick > this.currentTick || target.special.reassembleUntilTick > this.currentTick)
    ) {
      damageFactor *= targetedBasicOrWeapon && this.isMeleeBasicAttacker(attacker)
        ? DODGE_REWARD.staggerMeleeDamageFactor
        : DODGE_REWARD.staggerDamageFactor;
    }
    if (target.kind === "mob" && target.special && target.special.guardUntilTick > this.currentTick) {
      damageFactor *= shellGuardFor(target.archetypeKey).incomingFactor;
    } else if (
      direct && target.kind === "mob" && target.archetypeKey !== null && mobGimmickArchetype(target.archetypeKey) === "shellback" &&
      (this.options.random?.() ?? Math.random()) < SHELLBACK_BLUNT.chance
    ) {
      // A glancing blow off the Shellback's plates lands like a hit on the Crab's shell.
      damageFactor *= CRAB_SHELL.incomingFactor;
    }
    damageFactor = Math.max(targetRuntime?.activeClassId === "warrior" ? 0.6 : 0.25, damageFactor);
    let finalDamage = attackContext.fixedFinalDamage === undefined
      ? Math.max(1, Math.round(defendedDamage * damageFactor))
      : Math.max(0, Math.round(attackContext.fixedFinalDamage));
    if (attackContext.fixedFinalDamage === undefined) {
      finalDamage += this.consumeMirageBonus(attacker, direct && targetedBasicOrWeapon);
    }
    if (targetRuntime && attacker.entityId !== target.entityId) {
      const now = this.now();
      const applyRemainingMitigation = (key: keyof AttackResolutionContext) => {
        const remaining = Number(attackContext[key] ?? 0);
        const prevented = Math.min(finalDamage, remaining);
        finalDamage -= prevented;
        (attackContext[key] as number | undefined) = remaining - prevented;
      };
      if (targetedBasicOrWeapon && Number(targetRuntime.counters.v2SubstitutionEndsAt ?? 0) >= now) {
        finalDamage = 0;
        attackContext.suppressed = true;
        delete targetRuntime.counters.v2Substitution;
        delete targetRuntime.counters.v2SubstitutionEndsAt;
        const destination = destinationPoint(target.position, 50, initialBearingDegrees(attacker.position, target.position));
        if (this.options.repositionPlayer?.(target.entityId, destination)) {
          this.grid.update(target.entityId, destination);
          target.position = { ...destination };
        }
      } else if (targetedBasicOrWeapon && Number(targetRuntime.counters.v2IronReversalEndsAt ?? 0) >= now) {
        finalDamage = 0;
        attackContext.suppressed = true;
        delete targetRuntime.counters.v2IronReversal;
        delete targetRuntime.counters.v2IronReversalEndsAt;
        targetRuntime.counters.v2IronReversalBonus = 4;
        targetRuntime.counters.v2IronReversalBonusEndsAt = Number.MAX_SAFE_INTEGER;
      }
      const eligibleMitigationHit = finalDamage > 0;
      if (eligibleMitigationHit && attackContext.battleHardenedResolved !== true && !passiveGenerated &&
        targetRuntime.equippedPassives.has("warrior_v2_battle_hardened") &&
        Number(targetRuntime.counters.v2BattleHardenedCooldown ?? 0) <= now) {
        attackContext.battleHardenedResolved = true;
        attackContext.battleHardenedMitigationRemaining = 3;
        targetRuntime.counters.v2BattleHardenedCooldown = now + 8_000;
      }
      if (eligibleMitigationHit && attackContext.juggernautResolved !== true && targetedAttack && !passiveGenerated &&
        targetRuntime.equippedPassives.has("warrior_v2_juggernaut") &&
        target.currentHealth / target.maxHealth < 0.25) {
        attackContext.juggernautResolved = true;
        attackContext.juggernautMitigationRemaining = 2;
      }
      applyRemainingMitigation("battleHardenedMitigationRemaining");
      applyRemainingMitigation("juggernautMitigationRemaining");
    }
    const shields = targetRuntime?.effects.filter((effect) =>
      effect.kind === "healing_shield" && effect.amount > 0 &&
      (!effect.enemyIds || effect.enemyIds.includes(attacker.entityId))
    ).sort((left, right) => left.id.localeCompare(right.id)) ?? [];
    for (const shield of shields) {
      if (finalDamage <= 0) break;
      const absorbed = Math.min(finalDamage, Math.round(shield.amount));
      shield.amount -= absorbed;
      finalDamage -= absorbed;
      if (shield.amount <= 0 && targetRuntime) {
        targetRuntime.effects = targetRuntime.effects.filter((effect) => effect !== shield);
      }
      if (absorbed > 0) this.rememberClassRuntime(target);
    }
    // Dev/e2e only: a test character clears long dungeon runs while still taking real damage.
    const devMultiplier = this.options.devPlayerDamageMultiplier ?? 1;
    if (devMultiplier !== 1 && attacker.kind === "player" && target.kind === "mob" && finalDamage > 0) {
      finalDamage = Math.max(1, Math.round(finalDamage * devMultiplier));
    }
    const healthBeforeDamage = target.currentHealth;
    const appliedDamage = Math.min(target.currentHealth, finalDamage);
    target.currentHealth = Math.max(0, target.currentHealth - finalDamage);
    if (reactiveArmorHit) this.applyReactiveArmorProcs(target, attacker, appliedDamage);
    this.recordInscriptionDamage(attacker, target, appliedDamage, direct);
    this.emitCombatAnalyticsEvent({
      kind: "damage_applied",
      context:
        attacker.kind === "player" && target.kind === "player"
          ? "pvp_open_world"
          : "pve",
      actorId: attacker.entityId,
      actorKind: attacker.kind,
      targetId: target.entityId,
      targetKind: target.kind,
      actorLevel: attacker.level,
      targetLevel: target.level,
      actorClassId: attacker.classRuntime?.activeClassId ?? null,
      actorSubclassId: attacker.classRuntime?.subclassId ?? null,
      targetClassId: target.classRuntime?.activeClassId ?? null,
      targetSubclassId: target.classRuntime?.subclassId ?? null,
      actorWeaponInstanceId:
        attacker.equipmentCombatState?.activeWeaponInstanceId ?? null,
      damageBeforeMitigation: defendedDamage,
      damageApplied: appliedDamage,
      mitigationBySource,
      sourceTechniqueId,
      distanceM: distanceMeters(attacker.position, target.position),
      targetHealthAfter: target.currentHealth
    });
    if (appliedDamage > 0 && target.kind === "mob" && target.bossOwnership !== null && target.currentHealth > 0 &&
        attacker.entityId !== target.entityId) {
      this.bossDamageListener?.(target.entityId, appliedDamage, attacker.entityId);
    }
    if (appliedDamage > 0) {
      const hitAt = this.now();
      if (attacker.kind === "player" && target.kind === "player" && attacker.entityId !== target.entityId) {
        const targetAggressive = target.aggressiveUntilMs > hitAt;
        this.options.onPvpHit?.(
          attacker.entityId,
          target.entityId,
          hitAt + this.v3AggressionDurationMs(attacker),
          targetAggressive
        );
        if (this.pvpStrikeBlocked(attacker, target)) {
          // That was the one swing: stop the auto-attack and the walk-up.
          if (this.pendingPlayerAttackApproachStops.get(attacker.entityId) === target.entityId) {
            this.pendingPlayerAttackApproachStops.delete(attacker.entityId);
            this.options.stopPlayer?.(attacker.entityId);
          }
          if (attacker.targetEntityId === target.entityId) this.clearTarget(attacker);
        } else if (targetAggressive) {
          this.autoRetaliatePvp(target, attacker);
        }
      }
      this.recordV3MercenaryMomentumExchange(attacker, target, hitAt);
      if (attacker.classRuntime) {
        attacker.classRuntime.lastCombatAtMs = hitAt;
        this.rememberClassRuntime(attacker);
      }
      if (target.classRuntime) {
        target.classRuntime.lastCombatAtMs = hitAt;
        this.rememberClassRuntime(target);
      }
      if (attacker.kind === "player") {
        if (
          direct &&
          sourceTechniqueId.endsWith("_basic_attack") &&
          this.pendingPlayerAttackApproachStops.get(attacker.entityId) === target.entityId
        ) {
          this.pendingPlayerAttackApproachStops.delete(attacker.entityId);
          this.options.stopPlayer?.(attacker.entityId);
        }
        const session = this.pveSessions.get(attacker.entityId);
        if (session && target.kind === "mob") {
          session.lastMeaningfulEngagementAtMs = hitAt;
        }
        const nextAggressiveUntilMs = hitAt + this.v3AggressionDurationMs(attacker);
        if (nextAggressiveUntilMs > attacker.aggressiveUntilMs) {
          attacker.aggressiveUntilMs = nextAggressiveUntilMs;
          this.markDirty(attacker);
        }
      }
    }
    this.markDirty(target);
    this.rememberProfile(target);
    if (target.kind === "mob" && !target.companionDogId && attacker.kind === "player" && appliedDamage > 0) {
      this.markSessionParticipation(attacker.entityId);
      const contributions = this.contributionsByMob.get(target.entityId) ?? new Map();
      contributions.set(attacker.entityId, (contributions.get(attacker.entityId) ?? 0) + appliedDamage);
      this.contributionsByMob.set(target.entityId, contributions);
      this.pveSessions.get(attacker.entityId)?.telemetry.recordDamageDealt(
        sourceTechniqueId,
        appliedDamage
      );
      if (
        attacker.classRuntime?.activeClassId === "knight" &&
        attacker.classRuntime.equippedPassives.has("knight_threatening_presence")
      ) {
        target.threatPriorityPlayerId = attacker.entityId;
        target.threatPriorityRemainingActions = Math.max(target.threatPriorityRemainingActions, 2);
        this.setTarget(target, attacker.entityId);
      }
    }
    if (appliedDamage > 0 && !target.companionDogId) this.handleWorldMobDamageExchange(attacker, target);
    if (
      appliedDamage > 0 && sourceTechniqueId === "enemy_basic_attack" &&
      attacker.archetypeKey === "jellyfish"
    ) {
      this.applyJellyfishHitEffects(attacker, target);
    }
    if (
      appliedDamage > 0 && sourceTechniqueId === "enemy_basic_attack" &&
      attacker.kind === "mob" && attacker.archetypeKey !== null && attacker.archetypeKey in POISON_BITE_CHANCE
    ) {
      this.applySickSewerRatHitEffects(attacker, target);
    }
    if (
      appliedDamage > 0 && sourceTechniqueId === "enemy_basic_attack" && attacker.kind === "mob" &&
      attacker.archetypeKey === "magma_salamander" && target.kind === "player" && target.lifeState === "alive"
    ) {
      this.applyHarmfulStatus(attacker, target, "burning", MAGMA_SALAMANDER.biteBurnChance);
    }
    if (
      attacker.kind === "mob" &&
      (attacker.archetypeKey === "dune_tick" || attacker.archetypeKey === "cave_bat" || attacker.archetypeKey === "nest_mouse") &&
      sourceTechniqueId === "enemy_basic_attack"
    ) {
      this.mobSpecial(attacker).hopAwayPending = true;
      if (attacker.archetypeKey === "nest_mouse" && appliedDamage > 0 && target.kind === "player") {
        this.addTimedEffect(attacker, target, "movement_slow", NEST_MOUSE_SLOW.techniqueId, NEST_MOUSE_SLOW.durationMs, NEST_MOUSE_SLOW.amount);
      }
      if (attacker.archetypeKey === "cave_bat" && attacker.lifeState === "alive") {
        const healed = caveBatLifesteal(appliedDamage);
        if (healed > 0 && attacker.currentHealth < attacker.maxHealth) {
          attacker.currentHealth = Math.min(attacker.maxHealth, attacker.currentHealth + healed);
          this.markDirty(attacker);
        }
      }
    }
    if (appliedDamage > 0 && sourceTechniqueId === "enemy_basic_attack" && attacker.kind === "mob" && target.kind === "player") {
      this.processMobHitGimmicks(attacker, target);
    }
    if (appliedDamage > 0 && target.kind === "mob" && attacker.kind === "player") {
      this.processMobDamagedGimmicks(target, attacker);
      if (
        direct && attacker.lifeState === "alive" && target.archetypeKey !== null && !target.npcFaction &&
        QUILL_ARCHETYPES.includes(target.archetypeKey) && sourceTechniqueId !== QUILL_REFLECT.techniqueId &&
        distanceMeters(attacker.position, target.position) <= QUILL_REFLECT.rangeM
      ) {
        this.applyScriptedDamage(target.entityId, attacker.entityId, quillDamage(appliedDamage, attacker.maxHealth), QUILL_REFLECT.techniqueId);
      }
    }
    if (appliedDamage > 0 && target.kind === "mob" && target.archetypeKey === "blight_treant") {
      this.mobSpecial(target).lastHitTick = this.currentTick;
    }
    if (
      appliedDamage > 0 && target.kind === "mob" && target.archetypeKey === "thornfern" &&
      attacker.kind === "player" && attacker.lifeState === "alive" && sourceTechniqueId !== THORNFERN.techniqueId &&
      distanceMeters(attacker.position, target.position) <= THORNFERN.thornsRangeM
    ) {
      this.applyHarmfulStatus(target, attacker, "poison", 1);
    }
    if (appliedDamage > 0 && attacker.kind === "mob" && attacker.archetypeKey === "initiate_monk" &&
        sourceTechniqueId === "enemy_basic_attack" && target.kind === "player") {
      this.processMonkCombo(attacker, target);
    }
    if (appliedDamage > 0 && target.kind === "mob" && attacker.kind === "player") {
      if (target.archetypeKey === "shadow_acrobat") this.processAcrobatHit(target, attacker);
      if (target.archetypeKey === "iron_statue") this.awakenStatue(target);
    }
    if (appliedDamage > 0 && target.kind === "mob" && target.archetypeKey === "carrion_chick") {
      this.processChickScreech(target, attacker);
    }
    if (appliedDamage > 0 && target.kind === "mob" && target.archetypeKey === "raptor_runt") {
      this.processRuntFlee(target, attacker);
    }
    if (appliedDamage > 0 && target.kind === "mob" && target.archetypeKey === "shellback_turtle") {
      this.processShellbackThreshold(target);
    }
    if (appliedDamage > 0 && target.kind === "mob" && target.archetypeKey === "spiderling") {
      this.processSpiderlingRetreat(target);
    }
    if (direct && appliedDamage > 0) this.triggerVengeanceMarks(attacker, target);
    if (
      appliedDamage > 0 && target.archetypeKey === "jellyfish" &&
      target.currentHealth > 0
    ) {
      this.processJellyfishHealthThresholds(target, healthBeforeDamage);
      this.persistPopulationMobRuntimeState(target);
    }
    this.emitEvent(
      "ATTACK_LANDED",
      attackContext.presentationSourceEntityId ?? attacker.entityId,
      target.entityId,
      appliedDamage,
      target.currentHealth
    );
    attackContext.damageEvent = this.emitEvent("DAMAGE", attacker.entityId, target.entityId, appliedDamage, target.currentHealth);
    if (enemyQueueHit) {
      this.markSessionParticipation(target.entityId);
      const session = this.pveSessions.get(target.entityId);
      if (session) {
        session.telemetry.recordDamageReceived(appliedDamage, mitigationBySource);
        session.telemetry.recordEnemyAction({
          action: "attack",
          atMs: this.telemetryTime(session),
          enemyArchetype: attacker.archetypeKey ?? "unknown",
          damage: appliedDamage
        });
      }
    }
    if (
      direct && targetRuntime &&
      this.damageQualifiesForRage(attacker, target)
    ) {
      if (enemyQueueHit && targetRuntime.subclassId === "warden") {
        this.addGuard(target, WARRIOR_BALANCE.guardIncomingAttack);
      }
    }
    if (direct && appliedDamage > 0) this.recordV3ConcentrationHit(attacker, target);
    if (direct && targetedBasicOrWeapon && appliedDamage > 0 && this.isMeleeBasicAttacker(attacker)) {
      this.spreadV3BlightOnContact(attacker, target);
      const attackerRuntime = attacker.classRuntime;
      if (
        attacker.kind === "player" && attackerRuntime?.skillV3 &&
        Number(attackerRuntime.counters.skillV3BlightArmedUntil ?? 0) >= this.now()
      ) {
        const blightRank = Math.max(
          1,
          Math.min(3, Number(attackerRuntime.counters.skillV3BlightRank ?? 1))
        );
        delete attackerRuntime.counters.skillV3BlightArmedUntil;
        delete attackerRuntime.counters.skillV3BlightRank;
        this.applyV3Blight(attacker, target, blightRank, false);
      }
    }
    if (this.persistCompanionHealth(target)) return appliedDamage;
    if (target.currentHealth <= 0 && target.lifeState === "alive") {
      const bleeding = this.hasQueueBleed(target) || this.hasEffect(target, "bleed");
      this.beginDefeat(target, attacker, bleeding, sourceTechniqueId);
    }
    return appliedDamage;
  }

  private persistCompanionHealth(target: Combatant): boolean {
    if (!target.companionDogId || !target.companionOwnerPlayerId) return false;
    const defeated = target.currentHealth <= 0;
    try {
      this.options.onCompanionHealthChanged?.({
        ownerPlayerId: target.companionOwnerPlayerId,
        dogId: target.companionDogId,
        currentHealth: target.currentHealth,
        maxHealth: target.maxHealth,
        baseMaxHealth: target.companionBaseMaxHealth ?? target.maxHealth,
        defeated,
      });
    } catch {
      // Persistence observers are isolated from the authoritative combat tick.
    }
    if (defeated) {
      this.emitEvent("MOB_REMOVED", target.entityId, target.entityId);
      this.removeEntity(target.entityId, true);
    }
    return true;
  }

  private handleWorldMobDamageExchange(attacker: Combatant, target: Combatant): void {
    if (target.kind !== "mob" || attacker.kind !== "player") return;
    const session = this.pveSessions.get(attacker.entityId);
    if (!session) return;
    session.playerAggroActive = true;
    const attacked = this.mobAiProfile(target).onAttacked;
    if (!attacked || !this.isCombatEligibleMob(target)) return;
    if (attacked.group === "exact_pack" && target.packId) {
      this.engageHostileGroup(target, attacker, session);
      return;
    }
    this.engageHostileMob(target, attacker, session);
  }

  /** Whether a companion may walk to this outdoor position (same rule as mob movement). */
  isCompanionPositionTraversable(position: LatLon): boolean {
    if (!Number.isFinite(position.lat) || !Number.isFinite(position.lon) || Math.abs(position.lat) > 90 || Math.abs(position.lon) > 180) return false;
    return this.isMobPositionTraversable(position, packageIdForPosition(position));
  }

  private isMobPositionTraversable(position: LatLon, regionCode: string): boolean {
    if (
      !Number.isFinite(position.lat) ||
      !Number.isFinite(position.lon) ||
      position.lat < -90 ||
      position.lat > 90 ||
      position.lon < -180 ||
      position.lon > 180
    ) {
      return false;
    }
    return this.options.isMobPositionTraversable?.(position, regionCode) ?? true;
  }

  private engageHostileGroup(
    initialMob: Combatant,
    player: Combatant,
    session: PveCombatSession
  ): void {
    if (
      initialMob.kind !== "mob" ||
      !initialMob.packId ||
      !this.isCombatEligibleMob(initialMob)
    ) return;
    const remainingMembers = [...this.entities.values()]
      .filter((candidate) =>
        candidate.entityId !== initialMob.entityId &&
        candidate.packId === initialMob.packId &&
        candidate.currentHealth > 0 &&
        this.isCombatEligibleMob(candidate) &&
        this.isAttackPairValid(player, candidate)
      )
      .sort((left, right) =>
        distanceMeters(player.position, left.position) -
          distanceMeters(player.position, right.position) ||
        left.entityId.localeCompare(right.entityId)
      );
    const orderedMembers = [initialMob, ...remainingMembers];
    for (const mob of orderedMembers) {
      session.tauntedEnemyIds.add(mob.entityId);
      this.engageHostileMob(mob, player, session);
    }
    session.telemetry.captureInitialQueueSize(session.enemyQueue.length);
    this.markSessionParticipation(player.entityId);
    this.noteSessionChanged(player, session);
  }

  private engageHostileMob(
    mob: Combatant,
    player: Combatant,
    session: PveCombatSession
  ): void {
    if (!this.isCombatEligibleMob(mob)) return;
    if (mob.aggroOwnerPlayerId === null) this.claimMobAggro(mob, player, session);
    const ownedBySession =
      mob.aggroOwnerPlayerId === player.entityId &&
      mob.aggroOwnerSessionId === session.sessionId &&
      mob.aggroOwnerSessionGeneration === session.generation;
    if (!ownedBySession) return;
    this.returningMobs.delete(mob.entityId);
    if (mob.mobAi) {
      mob.mobAi.phase = "engaging";
      mob.mobAi.intent = "combat";
      mob.mobAi.targetPlayerId = player.entityId;
      mob.mobAi.deadlineTick = null;
      mob.mobAi.deadlineAtMs = null;
    }
    this.invalidateScheduledAttack(mob);
    if (mob.targetEntityId !== player.entityId) this.setTarget(mob, player.entityId);
    if (this.joinMobTactics(mob, player)) {
      this.trackEnemy(session, mob.entityId);
      return;
    }
    if (this.isWithinMobAttackHoldRange(mob, player)) {
      this.activeChases.delete(mob.entityId);
      mob.activityState = "attacking";
      mob.chaseDestination = null;
      this.appendEnemy(session, mob.entityId);
      this.markDirty(mob);
    } else {
      this.removeEnemyFromQueue(session, mob.entityId);
      session.pursuingEnemyIds.add(mob.entityId);
      this.startChasing(mob);
    }
  }

  /** Rooted, immobilized, stunned/staggered or in swing hitstun: the mob may not walk anywhere (chase, wander, standoff, return home). */
  private isMobMovementHeld(mob: Combatant): boolean {
    return this.effectTotal(mob, "rooted") > 0 || this.hasEffect(mob, "immobilized") ||
      this.hasEffect(mob, "stunned") || isStunned(mob.special, this.currentTick) ||
      this.isMobInHitstun(mob);
  }

  private isMobInHitstun(mob: Combatant): boolean {
    return mob.special !== undefined && mob.special.hitstunUntilTick > this.currentTick;
  }

  /** Action combat only: a hostile melee mob (range <= 100 m) telegraphs its basic strike on a player. */
  private usesMeleeWindup(mob: Combatant, target: Combatant): boolean {
    return this.options.actionCombatEnabled?.() === true &&
      mob.kind === "mob" && target.kind === "player" &&
      mob.attackRangeM <= MOB_MELEE_WINDUP_MAX_RANGE_M &&
      !mob.companionDogId && !mob.undead;
  }

  /**
   * The mob's wound-up strike on `target`, if one is waiting. A strike for another target, or one left
   * over from an earlier fight (more than a beat past due), is dropped.
   */
  private pendingMeleeStrikeFor(mob: Combatant, target: Combatant): PendingBasicStrike | null {
    const state = mob.special;
    const pending = state?.pendingBasicStrike ?? null;
    if (!state || !pending) return null;
    if (pending.targetEntityId !== target.entityId || this.currentTick > pending.dueTick + this.attackIntervalTicks) {
      state.pendingBasicStrike = null;
      return null;
    }
    return pending;
  }

  /**
   * Starts a melee windup: a 90-degree cone telegraph toward the target now, the strike at `dueTick`. `reachM` is the
   * effective centre-to-centre connect distance (unmanaged: attack range + MOB_MELEE_WINDUP_RANGE_SLACK_M; managed:
   * tacticsReachM). The cone is drawn and tested the target's hurt radius shorter, so it connects at `reachM`.
   */
  private beginMeleeWindup(
    mob: Combatant,
    target: Combatant,
    dueTick: number,
    durationMs: number = MOB_MELEE_WINDUP_MS,
    reachM: number = mob.attackRangeM + MOB_MELEE_WINDUP_RANGE_SLACK_M,
    archetype?: Readonly<{ abilityId?: string; angleDeg?: number; damageFactor?: number }>
  ): void {
    const origin = { ...mob.position };
    const facingDegrees = initialBearingDegrees(origin, target.position);
    const rangeM = hurtShapeReachM(reachM, this.hurtRadiusM(target));
    this.mobSpecial(mob).pendingBasicStrike = {
      targetEntityId: target.entityId, dueTick, origin, facingDegrees, rangeM,
      ...(archetype?.abilityId === undefined ? {} : { abilityId: archetype.abilityId }),
      ...(archetype?.angleDeg === undefined ? {} : { angleDeg: archetype.angleDeg }),
      ...(archetype?.damageFactor === undefined ? {} : { damageFactor: archetype.damageFactor })
    };
    this.addMobTelegraph(mob, archetype?.abilityId ?? MOB_MELEE_WINDUP_ID, {
      kind: "cone", origin, facingDegrees, rangeM, angleDegrees: archetype?.angleDeg ?? MOB_MELEE_WINDUP_ANGLE_DEG
    }, durationMs);
  }

  /**
   * Mob tactics ranged aim (spec 2.12): a `ranged_aim` line telegraph locked toward the target now
   * (the mob's range long, MOB_RANGED_AIM_WIDTH_M wide), the shot at `dueTick`. Stepping the whole hurt circle out of
   * the lane dodges, like the melee cone. The lane is drawn the target's hurt radius short of `reachM` so the shot
   * still connects at its range.
   */
  private beginRangedAim(
    mob: Combatant,
    target: Combatant,
    dueTick: number,
    durationMs: number = MOB_RANGED_AIM_MS,
    reachM: number = mob.attackRangeM,
    damageFactor?: number
  ): void {
    const origin = { ...mob.position };
    const facingDegrees = initialBearingDegrees(origin, target.position);
    const rangeM = hurtShapeReachM(reachM, this.hurtRadiusM(target));
    this.mobSpecial(mob).pendingBasicStrike = {
      targetEntityId: target.entityId, dueTick, origin, facingDegrees, rangeM,
      shape: "line", widthM: MOB_RANGED_AIM_WIDTH_M,
      ...(damageFactor === undefined ? {} : { damageFactor })
    };
    this.addMobTelegraph(mob, MOB_RANGED_AIM_ID, {
      kind: "line", origin, facingDegrees, lengthM: rangeM, widthM: MOB_RANGED_AIM_WIDTH_M
    }, durationMs);
  }

  /** Resolves an aimed shot: inside the locked lane and not in dash i-frames it lands, else a DODGE pair. */
  private resolvePendingRangedShot(mob: Combatant, target: Combatant, pending: PendingBasicStrike): boolean {
    let inLane = false;
    if (target.lifeState === "alive" && target.zoneId === mob.zoneId) {
      const local = this.meleeWindupLocal;
      toLocalMeters(
        pending.origin.lat, pending.origin.lon, Math.cos((pending.origin.lat * Math.PI) / 180),
        target.position.lat, target.position.lon, local
      );
      // The whole shot path is the locked lane, tested at once against the hurt circle (nothing can tunnel).
      inLane = circleVsRect(
        pending.facingDegrees, pending.rangeM, pending.widthM ?? MOB_RANGED_AIM_WIDTH_M, local.x, local.y, this.hurtRadiusM(target)
      );
    }
    if (inLane && this.options.isEntityInvulnerable?.(target.entityId) !== true) {
      this.resolveWoundUpBasic(mob, target, pending);
      return true;
    }
    this.emitInnateEvent(target.entityId, target.entityId, "DODGE", MOB_RANGED_AIM_ID);
    this.emitEvent("DAMAGE", mob.entityId, target.entityId, 0, target.currentHealth);
    return false;
  }

  /**
   * Resolves a wound-up basic strike. It lands through the normal basic attack only when the target is still
   * inside the telegraphed cone and not in dash i-frames; otherwise it is a dodge: no damage, a DODGE innate
   * event plus a zero DAMAGE event (the same pair other dodges emit). The t1495 miss stagger
   * (applyStrikeAftermath) belongs to the telegraphed gimmick strikes only, so a basic strike never awards it.
   */
  private resolvePendingMeleeStrike(mob: Combatant, target: Combatant): boolean {
    const state = this.mobSpecial(mob);
    const pending = state.pendingBasicStrike;
    state.pendingBasicStrike = null;
    if (!pending) return false;
    if (pending.shape === "line") return this.resolvePendingRangedShot(mob, target, pending);
    let inCone = false;
    if (target.lifeState === "alive" && target.zoneId === mob.zoneId) {
      const local = this.meleeWindupLocal;
      toLocalMeters(
        pending.origin.lat, pending.origin.lon, Math.cos((pending.origin.lat * Math.PI) / 180),
        target.position.lat, target.position.lon, local
      );
      // The telegraphed cone overlaps the target's hurt circle; point blank lands whatever the angle.
      inCone = Math.hypot(local.x, local.y) <= MOB_MELEE_WINDUP_POINT_BLANK_M || circleVsCone(
        pending.facingDegrees, pending.rangeM, pending.angleDeg ?? MOB_MELEE_WINDUP_ANGLE_DEG, local.x, local.y, this.hurtRadiusM(target)
      );
    }
    if (inCone && this.options.isEntityInvulnerable?.(target.entityId) !== true) {
      this.resolveWoundUpBasic(mob, target, pending);
      return true;
    }
    this.emitInnateEvent(target.entityId, target.entityId, "DODGE", pending.abilityId ?? MOB_MELEE_WINDUP_ID);
    this.emitEvent("DAMAGE", mob.entityId, target.entityId, 0, target.currentHealth);
    return false;
  }

  /** The landed basic of a wound-up strike; an archetype strike carries its hit factor (Phase 2), else the plain basic. */
  private resolveWoundUpBasic(mob: Combatant, target: Combatant, pending: PendingBasicStrike): void {
    if (pending.damageFactor === undefined) {
      this.resolveBasicAttack(mob, target);
      return;
    }
    this.archBasicDamageFactor = pending.damageFactor;
    this.archBasicDamageAttackerId = mob.entityId;
    try {
      this.resolveBasicAttack(mob, target);
    } finally {
      this.archBasicDamageFactor = null;
      this.archBasicDamageAttackerId = "";
    }
  }

  /** Set only while an archetype basic resolves (applyDamage reads it for that attacker's basic hit). */
  private archBasicDamageFactor: number | null = null;
  private archBasicDamageAttackerId = "";

  /**
   * Resolves wound-up strikes whose session turn will no longer come (see `orphanedMeleeStrikeMobIds`) once
   * they are due, as a landed strike or a DODGE pair exactly like the session path. A strike that some other
   * path already resolved is simply forgotten; a mob in hitstun keeps its strike until the hitstun ends;
   * a dead or missing mob or target drops it without events.
   */
  private resolveOrphanedMeleeStrikes(): void {
    for (const mobId of this.orphanedMeleeStrikeMobIds) {
      const mob = this.entities.get(mobId);
      const pending = mob?.special?.pendingBasicStrike ?? null;
      if (!mob || !pending || mob.lifeState !== "alive" || this.pendingMobDefeats.has(mobId)) {
        if (mob?.special) mob.special.pendingBasicStrike = null;
        this.orphanedMeleeStrikeMobIds.delete(mobId);
        continue;
      }
      if (this.currentTick < pending.dueTick || this.isMobInHitstun(mob)) continue;
      this.orphanedMeleeStrikeMobIds.delete(mobId);
      const target = this.entities.get(pending.targetEntityId);
      if (!target || target.lifeState !== "alive") {
        mob.special!.pendingBasicStrike = null;
        continue;
      }
      this.resolvePendingMeleeStrike(mob, target);
      this.markDirty(mob);
    }
  }

  // ---- Mob tactics (docs/plans/mob-ai-phase1.md): tokens, surround slots, separation, rhythm ----

  /** MOB_TELEGRAPH_SCALE, clamped to 1-3 (1 when absent or not a number). Read only for managed mobs. */
  private mobTelegraphScale(): number {
    return clampMobTelegraphScale(this.options.mobTelegraphScale?.());
  }

  /** MOB_TACTICS_ENABLED, effective only while action combat is on. */
  private mobTacticsActive(): boolean {
    return this.options.actionCombatEnabled?.() === true && this.options.mobTacticsEnabled?.() === true;
  }

  /**
   * Spec 2.1: an ordinary overworld mob fighting a player is managed. Bosses, raid and shared-combat
   * mobs, dungeon (interior) fights, player-owned creatures and undead keep the old path.
   */
  private usesMobTactics(mob: Combatant, target: Combatant): boolean {
    return this.mobTacticsActive() &&
      mob.kind === "mob" && mob.lifeState === "alive" &&
      target.kind === "player" && target.lifeState === "alive" &&
      !this.isPlayerOwnedCreature(mob) && !mob.undead && !this.isBossMob(mob) &&
      !this.golemForgeState.has(mob.entityId) &&
      this.options.isSharedMobCombat?.(mob.entityId) !== true &&
      !target.regionCode.startsWith("interior:") && !mob.regionCode.startsWith("interior:");
  }

  /**
   * Puts a mob that targets `player` under tactics (idempotent). It leaves the turn queue, the
   * pursuit set, the chase set and the attack scheduler; enemyIds membership is untouched.
   */
  private joinMobTactics(mob: Combatant, player: Combatant, readyDelayTicks = this.tacticsArrivalGraceTicks): boolean {
    if (mob.targetEntityId !== player.entityId || !this.usesMobTactics(mob, player)) return false;
    // Mob AI Phase 2: archetype (rhythm, movement, signature) resolved once here; null keeps Phase 1 exactly.
    const tier = mob.challengeTier ?? "common";
    // Telegraph time: every managed windup and signature telegraph is scaled once here (MOB_TELEGRAPH_SCALE).
    const telegraphScale = this.mobTelegraphScale();
    const arch = this.mobArchetypesActive()
      ? resolveArchetypeTactics(mob.archetypeKey, tier, this.mobArchetypesOnlySet(), this.options.tickRateHz, telegraphScale)
      : null;
    if (arch !== null && readyDelayTicks === this.tacticsArrivalGraceTicks) {
      readyDelayTicks = tacticsMsToTicks(arch.params.arrivalGraceMs, this.options.tickRateHz);
    }
    const existing = this.mobTactics.mobs.get(mob.entityId);
    if (existing) {
      if (existing.targetId === player.entityId) return true;
      this.forgetMobTactics(mob.entityId, true);
      readyDelayTicks = Math.max(readyDelayTicks, this.tacticsSwapPenaltyTicks);
    }
    this.invalidateScheduledAttack(mob);
    this.activeChases.delete(mob.entityId);
    mob.chaseDestination = null;
    mob.activityState = "attacking";
    const ownerSession = mob.aggroOwnerPlayerId ? this.pveSessions.get(mob.aggroOwnerPlayerId) : undefined;
    for (const session of [this.pveSessions.get(player.entityId), ownerSession]) {
      if (!session || !session.enemyIds.has(mob.entityId)) continue;
      if (session.enemyQueue.includes(mob.entityId)) this.removeEnemyFromQueue(session, mob.entityId);
      session.pursuingEnemyIds.delete(mob.entityId);
    }
    const now = this.currentTick;
    // A strike still wound up from before (orphaned on a forget) resolves first: never start a new
    // windup over it, which would silently drop it.
    const pendingDueTick = mob.special?.pendingBasicStrike?.dueTick;
    if (pendingDueTick !== undefined) readyDelayTicks = Math.max(readyDelayTicks, pendingDueTick - now + 1);
    const rangeM = arch?.reachOverrideM ?? mob.attackRangeM;
    const pool = tacticsPool(rangeM);
    const ring = pool === "ranged" ? "outer" : "engage";
    // The archetype params already carry the scaled windup; a Phase 1 rhythm is scaled here (recover and cooldown
    // keep their lengths, so the cycle grows with the windup).
    const rhythm = arch !== null
      ? { windupMs: arch.params.windupMs, recoverMs: arch.params.recoverMs, cooldownMs: arch.params.cooldownMs, backoffM: arch.params.backoffM }
      : scaleMobRhythm(deriveMobRhythm(
        (mob.attackIntervalTicks * 1_000) / this.options.tickRateHz,
        mob.attackRangeM,
        mob.archetypeKey ? MOB_RHYTHM_OVERRIDES[mob.archetypeKey] : undefined
      ), telegraphScale);
    const state: MobTacticsState = {
      mobId: mob.entityId,
      targetId: player.entityId,
      phase: "approach",
      phaseEndTick: now,
      pool,
      cost: arch !== null ? archetypeTokenCost(arch.params.basicTokenCost, tier) : tacticsTokenCost(tier),
      rhythm,
      ring,
      layer: 0,
      radiusM: tacticsRingRadiusM(rangeM, ring),
      slotAngleDeg: null,
      waitingSinceTick: now,
      joinedTick: now,
      readyTick: now + readyDelayTicks,
      grabbed: false,
      cycle: 0,
      strafeFlips: 0,
      strafeFlipTick: now + strafeFlipTicks(mob.entityId, 0, this.options.tickRateHz),
      backoffBearingDeg: 0,
      arch,
      x: 0,
      y: 0,
      distanceM: 0,
      bearingDeg: 0
    };
    this.mobTactics.add(state);
    this.markDirty(mob);
    return true;
  }

  /**
   * Drops a mob from tactics and releases its token (idempotent). A planted windup still finishes
   * (lands or dodges once, through the orphan resolver) unless `cancelWindup`, which clears the
   * strike and its telegraph (target swap). A windup is never left behind without a resolver.
   */
  private forgetMobTactics(mobId: string, cancelWindup = false): void {
    const prior = this.mobTactics.mobs.get(mobId);
    // A signature never outlives its tactics state: cancelled with its telegraph, slot freed (spec 6.3).
    if (prior?.arch?.inSignature) this.cancelMobSignature(mobId, prior);
    const state = this.mobTactics.forget(mobId);
    if (!state) return;
    const mob = this.entities.get(mobId);
    if (!mob?.special?.pendingBasicStrike) return;
    if (cancelWindup || state.phase !== "windup") {
      mob.special.pendingBasicStrike = null;
      this.orphanedMeleeStrikeMobIds.delete(mobId);
      this.clearMobWindupTelegraphs(mob);
    } else {
      this.orphanedMeleeStrikeMobIds.add(mobId);
    }
  }

  private forgetMobTacticsTarget(playerId: string): void {
    const roster = this.mobTactics.rosters.get(playerId);
    if (!roster) return;
    for (const mobId of [...roster]) this.forgetMobTactics(mobId);
  }

  private clearMobWindupTelegraphs(mob: Combatant): void {
    const before = this.mobCasts.length;
    this.mobCasts = this.mobCasts.filter(({ sourceEntityId, cast }) =>
      sourceEntityId !== mob.entityId ||
      (cast.abilityId !== MOB_MELEE_WINDUP_ID && cast.abilityId !== MOB_RANGED_AIM_ID && !isMobSignatureAbilityId(cast.abilityId)));
    if (this.mobCasts.length === before) return;
    this.markDirty(mob);
    this.immediateFlushPending = true;
  }

  /**
   * A mob that is dying (defeat settlement pending), defeated or removed owns nothing in flight: melee windup, ranged
   * aim, signature (and a double strike's queued second hit), legacy gimmick strikes, dives, charges and fuses are all
   * dropped, its tokens, seat and signature slot are released, and every telegraph it owns leaves the next snapshot
   * (an immediate flush ships it, so clients drop the decals at once). Persistent ground zones keep their own
   * telegraph. Idempotent.
   */
  private cancelMobPendingActions(mob: Combatant): void {
    if (mob.kind !== "mob") return;
    this.forgetMobTactics(mob.entityId, true);
    this.orphanedMeleeStrikeMobIds.delete(mob.entityId);
    const special = mob.special;
    if (special) {
      special.pendingBasicStrike = null;
      special.pendingSignature = null;
      special.strikeKind = null;
      special.strikeTick = 0;
      special.strikeResolveAt = 0;
      special.strikeTargetId = null;
      special.chargeHitTick = 0;
      special.chargeResolveAt = 0;
      special.diveHitTick = 0;
      special.diveTargetId = null;
      special.fuseTick = 0;
    }
    const zoneAbilityIds = new Set(this.acidZones
      .filter((zone) => zone.sourceEntityId === mob.entityId && zone.techniqueId)
      .map((zone) => zone.techniqueId as string));
    const before = this.mobCasts.length;
    this.mobCasts = this.mobCasts.filter(({ sourceEntityId, cast }) =>
      sourceEntityId !== mob.entityId || zoneAbilityIds.has(cast.abilityId));
    if (this.mobCasts.length !== before) {
      this.markDirty(mob);
      this.immediateFlushPending = true;
    }
  }

  /** setTarget hook: the windup is cancelled, the old ledger released, the new target joined with the swap penalty. */
  private retargetMobTactics(mob: Combatant): void {
    this.forgetMobTactics(mob.entityId, true);
    const target = mob.targetEntityId ? this.entities.get(mob.targetEntityId) : undefined;
    if (target) {
      this.joinMobTactics(mob, target, Math.max(this.tacticsArrivalGraceTicks, this.tacticsSwapPenaltyTicks));
    }
  }

  /** The gate no longer holds (flag off, target left the overworld): back to the old chase and queue path. */
  private handBackMobTactics(mobId: string): void {
    this.forgetMobTactics(mobId);
    const mob = this.entities.get(mobId);
    if (!mob || mob.lifeState !== "alive" || !mob.targetEntityId) return;
    const session = mob.aggroOwnerPlayerId ? this.pveSessions.get(mob.aggroOwnerPlayerId) : undefined;
    if (session?.enemyIds.has(mobId)) {
      session.pursuingEnemyIds.add(mobId);
      this.startChasing(mob);
      return;
    }
    this.startChasing(mob);
    this.scheduleAttack(mob, Math.max(this.currentTick + 1, mob.nextEligibleAttackTick));
  }

  /** Spec 2.13: a player hit on a managed mob that is not mid-attack makes it take the next free token first. */
  private grabMobTactics(mob: Combatant, player: Combatant): void {
    const state = this.mobTactics.mobs.get(mob.entityId);
    if (!state || state.targetId !== player.entityId || mob.lifeState !== "alive") return;
    if (state.phase !== "approach" && state.phase !== "wait" && state.phase !== "cooldown") return;
    if (distanceMeters(mob.position, player.position) > this.tacticsGrabRangeM(mob)) return;
    state.grabbed = true;
  }

  /** Taunted mobs inside the session view ignore the leash, exactly as `isEncounterPursuitWithinView` does for chasers. */
  private isTacticsLeashExempt(mob: Combatant, player: Combatant): boolean {
    const session = this.pveSessions.get(player.entityId);
    return Boolean(
      session &&
      mob.aggroOwnerPlayerId === player.entityId &&
      mob.aggroOwnerSessionId === session.sessionId &&
      mob.aggroOwnerSessionGeneration === session.generation &&
      session.tauntedEnemyIds.has(mob.entityId) &&
      distanceMeters(mob.position, session.viewCenter) <= session.viewRadiusM &&
      distanceMeters(player.position, session.viewCenter) <= session.viewRadiusM
    );
  }

  /** Ids of a target's roster, copied into a reused buffer so the per-tick passes may forget mobs safely. */
  private tacticsRosterIds(playerId: string): string[] {
    const ids = this.tacticsIdBuffer;
    ids.length = 0;
    const roster = this.mobTactics.rosters.get(playerId);
    if (roster) for (const id of roster) ids.push(id);
    return ids;
  }

  private readonly tacticsIdBuffer: string[] = [];

  /**
   * Strike reach of a managed mob, centre to centre. Melee: the player's swing reach to the body edge
   * (MOB_TACTICS_MELEE_REACH_M) plus the body radius (MOB_TACTICS_MELEE_REACH_SLACK_M), the same measure as the swing;
   * the engage ring is clamped inside it. Ranged keep their range.
   */
  private tacticsReachM(mob: Combatant, state: MobTacticsState): number {
    if (state.pool !== "melee") return state.arch?.reachOverrideM ?? mob.attackRangeM;
    const arch = state.arch;
    const edgeReachM = arch === null || arch.archetype === "caster" || !(arch.params.basicReachM > 0)
      ? mobTacticsMeleeReachM(mob.attackRangeM, this.tacticsEngageRadiusM(mob))
      : arch.params.basicReachM;
    return edgeReachM + MOB_TACTICS_MELEE_REACH_SLACK_M;
  }

  /** Body width from the mob's sprite footprint at the default play zoom (cached per archetype by the shared helper). */
  private tacticsBodyWidthM(mob: Combatant | undefined): number {
    const archetype = mob?.archetypeKey ?? null;
    const spriteKey = archetype ? requireMobDefinition(archetype).spriteKey : null;
    return mobTacticsBodyWidthM(archetype, spriteKey);
  }

  /** Engage ring radius: body-sized for melee (clear of the player sprite), the outer ring for ranged. */
  private tacticsEngageRadiusM(mob: Combatant): number {
    const rangeM = this.tacticsRangeM(mob);
    return tacticsPool(rangeM) === "melee"
      ? mobTacticsEngageRadiusM(rangeM, this.tacticsBodyWidthM(mob))
      : tacticsRingRadiusM(rangeM, "outer");
  }

  /** A player hit grabs a mob anywhere out to its wait ring (spec 2.13, with the wait ring moved out for spacing). */
  private tacticsGrabRangeM(mob: Combatant): number {
    if (tacticsPool(this.tacticsRangeM(mob)) !== "melee") return this.tacticsRangeM(mob) * MOB_TACTICS_GRAB_MAX_RANGE_FACTOR;
    // Out to the third wait band: every waiter can be grabbed (the player still has to reach it with a hit).
    return mobTacticsWaitBandRadiusM(2, this.tacticsEngageRadiusM(mob), this.tacticsBodyWidthM(mob)) + MOB_TACTICS_SLOT_ARRIVE_M;
  }

  /** Centre-to-centre spacing for a roster: the widest body's width plus the visible gap (sprites never overlap). */
  private tacticsSpacingM(ids: readonly string[]): number {
    let widest = 0;
    for (const id of ids) widest = Math.max(widest, this.tacticsBodyWidthM(this.entities.get(id)));
    return mobTacticsSpacingM(widest || mobTacticsBodyWidthM(null));
  }

  /** Tick pass (after processMobSpecials): one pass per target player, cost proportional to managed mobs. */
  private processMobTactics(): void {
    if (!this.mobTacticsActive()) {
      for (const mobId of [...this.mobTactics.mobs.keys()]) this.handBackMobTactics(mobId);
      return;
    }
    // Round robin over target players under the per-tick ceiling (like maxChasesPerTick); a
    // target's whole roster is advanced together so tokens and separation stay consistent.
    const tactics = this.mobTactics;
    const targets = tactics.targetIds;
    targets.length = 0;
    for (const playerId of tactics.rosters.keys()) targets.push(playerId);
    if (targets.length === 0) return;
    const budget = this.options.maxTacticsPerTick ?? MOB_TACTICS_MAX_PER_TICK;
    const start = tactics.cursor % targets.length;
    let spent = 0;
    let processed = 0;
    while (processed < targets.length) {
      const playerId = targets[(start + processed) % targets.length]!;
      const size = tactics.rosters.get(playerId)?.size ?? 0;
      if (processed > 0 && spent + size > budget) break;
      spent += size;
      processed += 1;
      this.processTacticsTarget(playerId);
    }
    tactics.cursor = (start + processed) % targets.length;
  }

  /** Bound once: the ledger self-heal predicate for the target being processed (no per-tick closure). */
  private tacticsValidatingPlayerId = "";
  private readonly tacticsHolderValid = (id: string): boolean => {
    const state = this.mobTactics.mobs.get(id);
    return state !== undefined && state.targetId === this.tacticsValidatingPlayerId &&
      (state.phase === "wait" || state.phase === "windup" || state.phase === "recover");
  };

  /** Movement heading of the target player (bearing of its last >= 1 m of travel), for the front bonus. */
  private updateTacticsHeading(player: Combatant, cosLat: number): number | null {
    let heading = this.mobTactics.headings.get(player.entityId);
    if (!heading) {
      heading = { lat: player.position.lat, lon: player.position.lon, headingDeg: null };
      this.mobTactics.headings.set(player.entityId, heading);
      return null;
    }
    const local = this.tacticsLocal;
    toLocalMeters(heading.lat, heading.lon, cosLat, player.position.lat, player.position.lon, local);
    if (Math.hypot(local.x, local.y) >= 1) {
      heading.headingDeg = normalizeAngleDeg((Math.atan2(local.x, local.y) * 180) / Math.PI);
      heading.lat = player.position.lat;
      heading.lon = player.position.lon;
    }
    return heading.headingDeg;
  }

  private processTacticsTarget(playerId: string): void {
    const tactics = this.mobTactics;
    const player = this.entities.get(playerId);
    if (!player || player.kind !== "player" || player.lifeState !== "alive") {
      this.forgetMobTacticsTarget(playerId);
      return;
    }
    if (this.isPlayerReserved(playerId)) return;
    const now = this.currentTick;
    const hz = this.options.tickRateHz;
    const cosLat = Math.cos((player.position.lat * Math.PI) / 180);
    const local = this.tacticsLocal;

    // 1. Validate and measure in the local metre frame around the target.
    for (const mobId of this.tacticsRosterIds(playerId)) {
      const mob = this.entities.get(mobId);
      if (!mob || mob.lifeState !== "alive" || mob.targetEntityId !== playerId || !this.usesMobTactics(mob, player)) {
        this.handBackMobTactics(mobId);
        continue;
      }
      if (!this.isAttackPairValid(mob, player)) {
        this.clearTarget(mob);
        continue;
      }
      if (
        mob.leashRadiusM > 0 &&
        distanceMeters(mob.homePosition, player.position) > mob.leashRadiusM + mob.attackRangeM &&
        !this.isTacticsLeashExempt(mob, player)
      ) {
        this.clearTarget(mob);
        continue;
      }
      if (tactics.mobs.get(mobId)?.arch && !this.mobArchetypesActive()) {
        // MOB_ARCHETYPES_ENABLED turned off mid-fight: start over as a Phase 1 mob.
        this.forgetMobTactics(mobId, true);
        this.joinMobTactics(mob, player);
      }
      const state = tactics.mobs.get(mobId);
      if (!state) continue;
      toLocalMeters(player.position.lat, player.position.lon, cosLat, mob.position.lat, mob.position.lon, local);
      state.x = local.x;
      state.y = local.y;
      state.distanceM = Math.hypot(local.x, local.y);
      state.bearingDeg = normalizeAngleDeg((Math.atan2(local.x, local.y) * 180) / Math.PI);
    }
    const ledger = tactics.ledgers.get(playerId);
    if (!ledger || !tactics.rosters.has(playerId)) return;
    const headingDeg = this.updateTacticsHeading(player, cosLat);
    // Design rule 7: two ranged points while archetypes are on (casters), one in Phase 1.
    ledger.setCapacity("ranged", this.mobArchetypesActive() ? MOB_ARCH_CASTER_RANGED_TOKENS : MOB_TACTICS_RANGED_TOKENS);

    // 2. Self-heal: tokens held by a mob that left, or held past the fail-safe, go back.
    this.tacticsValidatingPlayerId = playerId;
    ledger.validate(this.tacticsHolderValid, now);

    // 3. Timed phases: strikes, recover, cooldown, dash-out.
    let remeasure = false;
    for (const mobId of this.tacticsRosterIds(playerId)) {
      const state = tactics.mobs.get(mobId);
      const mob = this.entities.get(mobId);
      if (!state || !mob) continue;
      if (state.phase === "windup") {
        if (now < state.phaseEndTick || this.isMobInHitstun(mob)) continue;
        if (state.arch?.inSignature) {
          // A signature can move the mob (charge, lunge, blink) or the player (knockback, pull).
          this.resolveSignaturePart(mob, player, state, ledger);
          remeasure = true;
        } else {
          this.finishTacticsStrike(mob, player, state);
        }
        if (!tactics.rosters.has(playerId)) return;
      } else if (state.phase === "recover") {
        if (now < state.phaseEndTick) continue;
        ledger.release(mobId);
        // Fairness clock restarts on token release (spec 2.2), so the cooldown counts as waiting.
        state.waitingSinceTick = now;
        state.cycle += 1;
        state.phase = "cooldown";
        state.phaseEndTick = now + tacticsMsToTicks(jitteredCooldownMs(state.rhythm, mobId, state.cycle), hz);
      } else if (state.phase === "cooldown") {
        if (now < state.phaseEndTick) continue;
        state.phase = "wait";
      } else if (state.phase === "approach") {
        // Archetype mobs arrive at their own ring (pack band, caster outer ring; a turret caster has arrived).
        const arrivalRadiusM = state.arch !== null
          ? this.archDestinationRadiusM(state, mob, state.radiusM, ledger.holds(mobId), ledger)
          : state.radiusM;
        if (
          state.slotAngleDeg !== null &&
          (arrivalRadiusM < 0 ||
            this.tacticsDestinationDistanceM(state, mob, arrivalRadiusM, player, cosLat) <= MOB_TACTICS_SLOT_ARRIVE_M * 2)
        ) {
          state.phase = "wait";
        }
      } else if (state.phase === "wait" && ledger.holds(mobId)) {
        // The player dashed away before this mob planted: give the token back and walk in again.
        const reachM = state.grabbed
          ? this.tacticsGrabRangeM(mob)
          : state.arch !== null ? this.tacticsAskReachM(mob, state) : this.tacticsReachM(mob, state);
        if (state.distanceM > reachM + MOB_TACTICS_DASH_OUT_SLACK_M) {
          ledger.release(mobId);
          state.phase = "approach";
        }
      }
    }

    if (remeasure) this.measureTacticsRoster(playerId, player);

    // 3b. Archetype reactions (Phase 2): the Pack hurt retreat.
    if (this.mobArchetypesActive()) this.updatePackRetreats(playerId, ledger);

    // 4. Rings and slots, every few ticks (staggered per player) or when a mob has none yet.
    let needsSlots = (now + Math.floor(tacticsHash01(playerId) * MOB_TACTICS_SLOT_REASSIGN_TICKS)) %
      MOB_TACTICS_SLOT_REASSIGN_TICKS === 0;
    if (!needsSlots) {
      for (const mobId of this.tacticsRosterIds(playerId)) {
        if (tactics.mobs.get(mobId)?.slotAngleDeg === null) {
          needsSlots = true;
          break;
        }
      }
    }
    if (needsSlots) this.assignTacticsSlots(playerId, ledger);

    // Strikes started this tick count against the governor with the landed ones (a swarm wave starts together).
    // Earlier windups are not added: they land as older landings leave the window, and counting them made it stricter
    // than the 1.25x cap.
    this.archInFlightHe = 0;

    // 5. Tokens.
    // Only the first MOB_TACTICS_MAX_ROSTER mobs (join order) compete; overflow mobs wait on the
    // outer layers and move up as earlier mobs leave.
    let count = 0;
    let rosterIndex = 0;
    for (const mobId of this.tacticsRosterIds(playerId)) {
      if (rosterIndex++ >= MOB_TACTICS_MAX_ROSTER) break;
      const state = tactics.mobs.get(mobId);
      const mob = this.entities.get(mobId);
      if (!state || !mob || ledger.holds(mobId)) continue;
      const arch = state.arch;
      // An archetype mob still approaching may ask for its signature (a charge or smoke step opens the fight).
      const approaching = arch !== null && state.phase === "approach";
      if (state.phase !== "wait" && !approaching) continue;
      if (now < state.readyTick || state.distanceM > MOB_TACTICS_ATTACK_VIEW_RADIUS_M) continue;
      // Retreating pack mates and hopping skirmishers take no tokens (Phase 2).
      if (arch !== null && (arch.retreatUntilTick > now || arch.hopUntilTick > now)) continue;
      const reachM = state.grabbed
        ? this.tacticsGrabRangeM(mob)
        : arch !== null ? this.tacticsAskReachM(mob, state) : this.tacticsReachM(mob, state) + MOB_ATTACK_HOLD_RANGE_BUFFER_M;
      // A signature with a longer trigger (charge, lunge, smoke, blast, tongue, volley) asks from its trigger window,
      // paying the signature cost at the grant.
      // A signature-ready mob asks for the signature cost (strict priority keeps the pool for it, so a Brute's
      // 2-point move is not starved by cheaper mobs); it may then wait a moment for the landing windows to clear.
      const signatureReady = arch !== null && this.archWantsSignature(state, mob, ledger, headingDeg, false);
      const signatureOnly = (state.distanceM > reachM || approaching) && signatureReady;
      if (((state.distanceM > reachM || approaching) && !signatureOnly) || this.isMobMovementHeld(mob)) continue;
      const candidate = tactics.candidate(count);
      candidate.id = mobId;
      candidate.pool = state.pool;
      candidate.cost = signatureReady ? arch!.signatureCost : state.cost;
      candidate.starvationMs = arch?.params.starvationMs;
      candidate.waitingSinceTick = state.waitingSinceTick;
      candidate.distanceM = state.distanceM;
      candidate.bearingDeg = state.bearingDeg;
      candidate.grabbed = state.grabbed;
      candidate.engageRadiusM = this.tacticsEngageRadiusM(mob);
      count += 1;
    }
    tactics.candidates.length = count;
    if (count > 0) ledger.arbitrateInto(tactics.candidates, count, now, headingDeg, tactics.granted);

    // 6. Token holders in reach start their windup (or their signature), respecting the arrival grace and the landing windows.
    let waveId: string | null = null;
    let waveMembers = 0;
    for (const mobId of this.tacticsRosterIds(playerId)) {
      const state = tactics.mobs.get(mobId);
      const mob = this.entities.get(mobId);
      if (!state || !mob || !ledger.holds(mobId)) continue;
      const arch = state.arch;
      if (state.phase !== "wait" && !(arch !== null && state.phase === "approach")) continue;
      const wantsSignature = arch !== null && now >= state.readyTick && !this.isMobMovementHeld(mob) &&
        this.archWantsSignature(state, mob, ledger, headingDeg);
      // Granted for a signature that is still ready but blocked by a basic landing window: hold the points a moment.
      // Combat feel: this includes signatures that cost no more than a basic (the pack lunge). With 700 ms windups the
      // basic landings of a close rotation are dense enough that such a signature never found a clear window and the
      // mob always fell back to a basic, so wolves stopped lunging after the opener.
      const awaitingWindow = !wantsSignature && arch !== null && ledger.costOf(mobId) >= arch.signatureCost &&
        arch.signatureCost >= state.cost && now >= state.readyTick && !this.isMobMovementHeld(mob) &&
        this.archWantsSignature(state, mob, ledger, headingDeg, false);
      if (awaitingWindow) {
        // Let the committed basic landings drain: no new basic starts for up to one windup plus the gap.
        ledger.holdBasicsForSignature(mobId, now, tacticsMsToTicks(state.rhythm.windupMs + MOB_ARCH_SIGNATURE_LANDING_GAP_MS, hz));
        continue;
      }
      if (state.phase === "approach" && !wantsSignature) {
        // Granted for a signature that can no longer start: back to walking in, token returned.
        ledger.release(mobId);
        continue;
      }
      const inReach = state.distanceM <= this.tacticsReachM(mob, state);
      if (now < state.readyTick || (!inReach && !wantsSignature) || this.isMobMovementHeld(mob)) continue;
      if (!wantsSignature) {
        // A melee mob closer than its engage ring (it would draw on the player) first steps back out to the ring.
        if (state.pool === "melee" && state.distanceM < this.tacticsEngageRadiusM(mob) - MOB_TACTICS_SLOT_ARRIVE_M) continue;
        // A swoop bird or slammer with its signature ready keeps the token and steps in for it instead of a basic.
        if (arch !== null && this.archDropInPending(state, mob, ledger)) continue;
      }
      // Threat priority (an ally's taunt-like effect): the mob turns to that player, as the queue
      // does on its turn. The setTarget hook moves it to that ledger with the swap penalty.
      const priorityTarget = this.sessionEnemyTarget(mob, player);
      if (priorityTarget.entityId !== playerId) {
        this.setTarget(mob, priorityTarget.entityId);
        continue;
      }
      if (wantsSignature) {
        // The cycle becomes a signature when the ledger also covers the signature cost (spec 6.2 step 6).
        if (ledger.upgrade(mobId, arch!.signatureCost)) {
          if (this.resolveQueueBleedTurn(mob)) {
            if (!tactics.rosters.has(playerId)) return;
            continue;
          }
          state.grabbed = false;
          mob.activityState = "attacking";
          if (mob.v2SkipNextAttackSourceId) {
            delete mob.v2SkipNextAttackSourceId;
            this.enterTacticsRecover(state, now);
            continue;
          }
          this.beginSignature(mob, player, state, ledger);
          ledger.restartHold(mobId, now);
          continue;
        }
        if (!inReach) {
          ledger.release(mobId);
          continue;
        }
      }
      const windupTicks = tacticsMsToTicks(state.rhythm.windupMs, hz);
      // Swarmers wind up together: up to MOB_ARCH_WAVE_MAX_MEMBERS per tick share one wave id and one landing tick.
      const swarm = arch !== null && arch.archetype === "swarmer";
      if (swarm) {
        if (waveMembers >= MOB_ARCH_WAVE_MAX_MEMBERS) continue;
        waveId ??= `${playerId}:${now}`;
      }
      if (!ledger.canStartWindup(now, windupTicks, swarm ? waveId : null)) continue;
      // The governor caps the mixed pack (design rule 7): an archetype basic waits while the 2 s window is full.
      if (arch !== null && !ledger.governorAllows(now, this.archInFlightHe + arch.basicDamageFactor)) continue;
      // Queue bleed: the mob's turn ticks its bleed first; a bleed kill spends the turn (as on the queue).
      if (this.resolveQueueBleedTurn(mob)) {
        if (!tactics.rosters.has(playerId)) return;
        continue;
      }
      if (arch !== null) {
        this.archInFlightHe += arch.basicDamageFactor;
        ledger.commitLanding(now, windupTicks, mobId, swarm ? waveId : null, arch.basicDamageFactor);
        if (swarm) waveMembers += 1;
        arch.waveId = swarm ? waveId : null;
      } else {
        ledger.commitLanding(now, windupTicks);
      }
      state.grabbed = false;
      mob.activityState = "attacking";
      if (mob.v2SkipNextAttackSourceId) {
        // A skipped attack (the same effect the queue honours) spends this cycle without a strike.
        delete mob.v2SkipNextAttackSourceId;
        this.enterTacticsRecover(state, now);
        continue;
      }
      const dueTick = now + windupTicks;
      if (arch !== null) this.beginArchetypeWindup(mob, player, state, dueTick, swarm);
      else if (state.pool === "ranged") this.beginRangedAim(mob, player, dueTick, state.rhythm.windupMs);
      else this.beginMeleeWindup(mob, player, dueTick, state.rhythm.windupMs, this.tacticsReachM(mob, state));
      this.orphanedMeleeStrikeMobIds.delete(mobId);
      ledger.restartHold(mobId, now);
      state.phase = "windup";
      state.phaseEndTick = dueTick;
      this.markDirty(mob);
    }

    // 7. Movement: one steering vector (slot seek or back-off, plus separation), one write per mob.
    // Separation pairs are bounded: only the first MOB_TACTICS_MAX_ROSTER mobs are bodies.
    const ids = this.tacticsRosterIds(playerId);
    const bodyCount = Math.min(ids.length, MOB_TACTICS_MAX_ROSTER);
    const spacingM = this.tacticsSpacingM(ids);
    for (let index = 0; index < bodyCount; index += 1) {
      const state = tactics.mobs.get(ids[index]!);
      const body = tactics.body(index);
      body.id = ids[index]!;
      body.x = state?.x ?? 0;
      body.y = state?.y ?? 0;
      body.r = this.tacticsBodyWidthM(this.entities.get(ids[index]!)) / 2;
    }
    tactics.bodies.length = bodyCount;
    for (let index = 0; index < ids.length; index += 1) {
      const mobId = ids[index]!;
      const state = tactics.mobs.get(mobId);
      const mob = this.entities.get(mobId);
      if (!state || !mob || state.phase === "windup" || this.isMobMovementHeld(mob)) continue;
      let maxStepM = this.mobChaseStepM(mob);
      if (!(maxStepM > 0)) continue;
      const arch = state.arch;
      const hopping = arch !== null && arch.hopUntilTick > now && arch.hopRemainingM > 0;
      // Archetype speed share (burst for retreats, kites and the skirmisher back-off), capped under the player's speed.
      if (arch !== null && !hopping) maxStepM = this.archStepM(arch, maxStepM, this.archBursting(state, now));
      let body = tactics.bodies[index];
      if (!body) {
        body = tactics.overflowBody;
        body.id = mobId;
        body.x = state.x;
        body.y = state.y;
        body.r = this.tacticsBodyWidthM(mob) / 2;
      }
      // Separation starts a little outside the body spacing; the firm minimum below does the rest.
      const push = separationPush(body, tactics.bodies, maxStepM, tactics.push, spacingM - MOB_TACTICS_BODY_GAP_M + MOB_TACTICS_PACKED_GAP_M + 10);
      const out = tactics.step;
      if (hopping) {
        // Skirmisher hop (spec 4.2): straight away from the player, the hop distance over the hop time.
        const hop = MOB_ARCHETYPE_RETREAT.skirmisher;
        const hopStepM = Math.min(arch!.hopRemainingM, hop.hopDistanceM / Math.max(1, tacticsMsToTicks(hop.hopMs, hz)));
        arch!.hopRemainingM -= hopStepM;
        const radians = (arch!.hopBearingDeg * Math.PI) / 180;
        out.x = state.x + Math.sin(radians) * hopStepM;
        out.y = state.y + Math.cos(radians) * hopStepM;
        maxStepM = Math.max(maxStepM, hopStepM);
      } else if (state.phase === "recover") {
        const recoverTicks = Math.max(1, tacticsMsToTicks(state.rhythm.recoverMs, hz));
        const backoffStepM = Math.min(maxStepM, state.rhythm.backoffM / recoverTicks);
        const radians = (state.backoffBearingDeg * Math.PI) / 180;
        let moveX = Math.sin(radians) * backoffStepM + push.x;
        let moveY = Math.cos(radians) * backoffStepM + push.y;
        const length = Math.hypot(moveX, moveY);
        if (length > maxStepM) {
          moveX *= maxStepM / length;
          moveY *= maxStepM / length;
        }
        out.x = state.x + moveX;
        out.y = state.y + moveY;
      } else {
        const holdsToken = ledger.holds(mobId);
        let radiusM = holdsToken && state.pool === "melee"
          ? this.tacticsEngageRadiusM(mob)
          : state.radiusM;
        // Archetype ring choice (Phase 2): band shifts, retreat band, skirmisher pull-out, caster outer ring and kite.
        if (arch !== null) radiusM = this.archDestinationRadiusM(state, mob, radiusM, holdsToken, ledger);
        const strafeShare = arch !== null ? arch.params.strafeShare : MOB_TACTICS_STRAFE_SPEED_FACTOR;
        if (
          strafeShare > 0 && radiusM > 0 &&
          state.pool === "melee" && state.slotAngleDeg !== null && !holdsToken &&
          (state.phase === "wait" || state.phase === "cooldown") &&
          this.tacticsDestinationDistanceM(state, mob, radiusM, player, cosLat) <= MOB_TACTICS_SLOT_ARRIVE_M * 3
        ) {
          // Waiting melee mobs circle slowly; the direction flips on a seeded timer (ranged hold still).
          if (now >= state.strafeFlipTick) {
            state.strafeFlips += 1;
            state.strafeFlipTick = now + strafeFlipTicks(mobId, state.strafeFlips, hz);
          }
          const arcM = maxStepM * strafeShare;
          // Pack mates circle one shared way per target (spec 4.1).
          const direction = arch?.params.sharedOrbit ? this.packOrbitDirection(playerId, now) : strafeDirection(mobId, state.strafeFlips);
          state.slotAngleDeg = normalizeAngleDeg(
            state.slotAngleDeg + (direction * arcM * 180) / (Math.PI * Math.max(1, state.radiusM))
          );
        }
        if (radiusM < 0) {
          // A slow caster inside its kite trigger holds ground (a turret); only separation moves it.
          out.x = state.x + push.x;
          out.y = state.y + push.y;
        } else {
          const destination = this.tacticsDestination(state, mob, radiusM, player, cosLat, tactics.strafe);
          steerStep(state.x, state.y, destination.x, destination.y, push, maxStepM, out);
        }
      }
      // Firm minimum spacing from every other body (sprite width + gap), corrected at most one step per tick.
      enforceMinSpacing(body, tactics.bodies, spacingM, maxStepM, out, MOB_TACTICS_PACKED_GAP_M);
      if (Math.hypot(out.x - state.x, out.y - state.y) < 0.01) continue;
      const next = fromLocalMeters(player.position.lat, player.position.lon, cosLat, out.x, out.y);
      // A slot step past the home leash is held, not a disengage: slots sit around the player, not
      // toward the mob, so they can lie beyond the leash. The real leash rule (the target beyond
      // leash + range from home) is checked in pass 1, exactly like processChases.
      if (this.commitMobStep(mob, next, this.isTacticsLeashExempt(mob, player), MOB_TACTICS_SLOT_LEASH_MARGIN_M) !== "moved") continue;
      state.x = out.x;
      state.y = out.y;
      body.x = out.x;
      body.y = out.y;
    }
  }

  private readonly tacticsHomeLocal: LocalMetersOut = { x: 0, y: 0 };
  /** Set by tacticsReachableArc: the bearing from the player to the mob's home. */
  private tacticsArcCenterDeg = 0;

  /**
   * Half-width of the arc of a ring (radius `radiusM` around the player) the mob can reach without
   * crossing its home leash; 180 = all of it. Leaves the arc centre in `tacticsArcCenterDeg`.
   */
  private tacticsReachableArc(mob: Combatant, player: Combatant, radiusM: number, cosLat: number): number {
    if (mob.leashRadiusM <= 0 || this.isTacticsLeashExempt(mob, player)) {
      this.tacticsArcCenterDeg = 0;
      return 180;
    }
    const home = this.tacticsHomeLocal;
    toLocalMeters(player.position.lat, player.position.lon, cosLat, mob.homePosition.lat, mob.homePosition.lon, home);
    this.tacticsArcCenterDeg = normalizeAngleDeg((Math.atan2(home.x, home.y) * 180) / Math.PI);
    return reachableArcHalfDeg(radiusM, Math.hypot(home.x, home.y), Math.max(0, mob.leashRadiusM + MOB_TACTICS_SLOT_LEASH_MARGIN_M - 1));
  }

  /** The managed mob's current slot point as a world position (raptor pounce hand-off), or null. */
  private mobTacticsSlotPosition(mob: Combatant, target: Combatant): LatLon | null {
    const state = this.mobTactics.mobs.get(mob.entityId);
    if (!state || state.targetId !== target.entityId || state.slotAngleDeg === null) return null;
    const cosLat = Math.cos((target.position.lat * Math.PI) / 180);
    const destination = this.tacticsDestination(state, mob, state.radiusM, target, cosLat, this.tacticsDestinationScratch);
    return fromLocalMeters(target.position.lat, target.position.lon, cosLat, destination.x, destination.y);
  }
  private readonly tacticsDestinationScratch: LocalMetersOut = { x: 0, y: 0 };

  /**
   * The point (local frame) a mob steers to: its slot on a ring of `radiusM`, pulled back inside
   * its home leash when the slot lies beyond it, so a leashed mob still spreads instead of
   * stalling on an unreachable slot. Taunted mobs in view ignore the leash as chasers do.
   */
  private tacticsDestination(
    state: MobTacticsState,
    mob: Combatant,
    radiusM: number,
    player: Combatant,
    cosLat: number,
    out: LocalMetersOut
  ): LocalMetersOut {
    const radians = ((state.slotAngleDeg ?? state.bearingDeg) * Math.PI) / 180;
    out.x = Math.sin(radians) * radiusM;
    out.y = Math.cos(radians) * radiusM;
    if (mob.leashRadiusM <= 0 || this.isTacticsLeashExempt(mob, player)) return out;
    const home = this.tacticsHomeLocal;
    toLocalMeters(player.position.lat, player.position.lon, cosLat, mob.homePosition.lat, mob.homePosition.lon, home);
    const dx = out.x - home.x;
    const dy = out.y - home.y;
    const distance = Math.hypot(dx, dy);
    const limit = Math.max(0, mob.leashRadiusM + MOB_TACTICS_SLOT_LEASH_MARGIN_M - 1);
    if (distance > limit && distance > 0) {
      out.x = home.x + (dx * limit) / distance;
      out.y = home.y + (dy * limit) / distance;
    }
    return out;
  }

  private tacticsDestinationDistanceM(
    state: MobTacticsState,
    mob: Combatant,
    radiusM: number,
    player: Combatant,
    cosLat: number
  ): number {
    if (state.slotAngleDeg === null) return Number.POSITIVE_INFINITY;
    const destination = this.tacticsDestination(state, mob, radiusM, player, cosLat, this.tacticsDestinationScratch);
    return Math.hypot(state.x - destination.x, state.y - destination.y);
  }

  /** Ring and slot pass: engage seats by priority, then angular relaxation per ring and layer. */
  private assignTacticsSlots(playerId: string, ledger: { holds(id: string): boolean }): void {
    const tactics = this.mobTactics;
    const now = this.currentTick;
    const player = this.entities.get(playerId);
    if (!player) return;
    const cosLat = Math.cos((player.position.lat * Math.PI) / 180);
    const msPerTick = 1_000 / this.options.tickRateHz;
    const items: RingItem[] = [];
    const spacingM = this.tacticsSpacingM(this.tacticsRosterIds(playerId));
    let engageSeats = MOB_TACTICS_ENGAGE_SEATS;
    for (const mobId of this.tacticsRosterIds(playerId)) {
      const state = tactics.mobs.get(mobId);
      const mob = this.entities.get(mobId);
      if (!state || !mob) continue;
      // Seat rotation by waiting time: busy mobs (token, windup, recover) and grabbed mobs keep or
      // take an engage seat; the rest are ranked by how long they have waited, and a current
      // occupant only gets a small hold bonus, so long waiters on the wait ring rotate in.
      const busy = ledger.holds(mobId) || state.phase === "windup" || state.phase === "recover";
      const waitedMs = (now - state.waitingSinceTick) * msPerTick;
      const holdBonus = state.slotAngleDeg !== null && state.ring === "engage" ? MOB_TACTICS_SEAT_HOLD_BONUS_MS : 0;
      items.push({
        id: mobId,
        pool: state.pool,
        // A starved waiter (spec 2.5) outranks the occupants' hold bonus, so the seat hold never starves it.
        score: state.grabbed ? 1e12 : busy ? 1e11 : waitedMs >= MOB_TACTICS_STARVATION_MS ? 1e10 + waitedMs
          : waitedMs + holdBonus + (state.arch?.archetype === "brute" ? MOB_TACTICS_SEAT_HOLD_BONUS_MS : 0),
        attackRangeM: this.tacticsRangeM(mob),
        currentRing: state.slotAngleDeg === null ? null : state.ring,
        ...(state.pool === "melee"
          ? { engageRadiusM: this.tacticsEngageRadiusM(mob), waitRadiusM: mobTacticsWaitBandRadiusM(0, this.tacticsEngageRadiusM(mob), this.tacticsBodyWidthM(mob)) }
          : {})
      });
      // Leash-aware seat count: no more engage seats than fit on the reachable arc.
      if (state.pool === "melee") {
        // Engage seats = how many body-sized slots fit on the engage ring (and on its reachable arc).
        const radiusM = this.tacticsEngageRadiusM(mob);
        engageSeats = Math.min(engageSeats, ringCapacity(radiusM, spacingM), MOB_TACTICS_ENGAGE_SEATS_MAX);
        const halfDeg = this.tacticsReachableArc(mob, player, radiusM, cosLat);
        if (halfDeg < 180) {
          engageSeats = Math.min(engageSeats, Math.floor((2 * halfDeg) / minSlotAngleDeg(radiusM, spacingM)) + 1);
        }
      }
    }
    const rings = assignRings(items, { engageSeats, preferCurrent: false, spacingM });
    const groups = new Map<string, MobTacticsState[]>();
    const keepPrevious = new Set<string>();
    const meleeWaiters: Array<{ state: MobTacticsState; score: number; keep: boolean }> = [];
    for (const item of items) {
      const state = tactics.mobs.get(item.id)!;
      const assignment = rings.get(item.id)!;
      if (state.pool === "melee" && assignment.ring === "wait") {
        // Melee waiters go to the wait bands below (interleaved with the engaged mobs), not a relaxed ring.
        meleeWaiters.push({ state, score: item.score, keep: state.ring === "wait" && state.slotAngleDeg !== null });
        state.ring = "wait";
        continue;
      }
      if (state.slotAngleDeg !== null && assignment.ring === state.ring && assignment.layer === state.layer) {
        keepPrevious.add(item.id);
      }
      state.ring = assignment.ring;
      state.layer = assignment.layer;
      state.radiusM = assignment.radiusM;
      const key = `${assignment.ring}:${assignment.layer}:${assignment.radiusM}`;
      let group = groups.get(key);
      if (!group) {
        group = [];
        groups.set(key, group);
      }
      group.push(state);
    }
    for (const group of groups.values()) {
      for (let index = 0; index < group.length; index += 1) {
        const state = group[index]!;
        const slotItem = tactics.slotItem(index);
        slotItem.id = state.mobId;
        slotItem.bearingDeg = state.bearingDeg;
        slotItem.prevSlotDeg = keepPrevious.has(state.mobId) ? state.slotAngleDeg : null;
        const mob = this.entities.get(state.mobId);
        slotItem.arcHalfDeg = mob ? this.tacticsReachableArc(mob, player, state.radiusM, cosLat) : 180;
        slotItem.arcCenterDeg = this.tacticsArcCenterDeg;
      }
      tactics.slotItems.length = group.length;
      tactics.slotOut.clear();
      relaxSlotsInto(tactics.slotItems, group.length, group[0]!.radiusM, tactics.slotOut, undefined, tactics.slotScratch, spacingM);
      for (const state of group) state.slotAngleDeg = tactics.slotOut.get(state.mobId) ?? state.slotAngleDeg;
    }
    if (meleeWaiters.length > 0) this.assignTacticsWaitBands(meleeWaiters, groups, spacingM);
  }

  /**
   * Wait bands (decision 5 with sprite-sized bodies): band 0 sits at 160 m, one step outside the 130 m swing reach.
   * Its slots are the midpoints between engaged mobs whose gap leaves a waiter clear of both neighbours (no visual
   * overlap at the packed spacing); the best-scored waiters take the nearest free midpoint. Everyone else staggers
   * onto bands 40 m further out, each relaxed at the packed spacing and spilling outward when full.
   */
  private assignTacticsWaitBands(
    waiters: Array<{ state: MobTacticsState; score: number; keep: boolean }>,
    groups: ReadonlyMap<string, readonly MobTacticsState[]>,
    spacingM: number
  ): void {
    const tactics = this.mobTactics;
    waiters.sort((left, right) => right.score - left.score || (left.state.mobId < right.state.mobId ? -1 : 1));
    const first = this.entities.get(waiters[0]!.state.mobId);
    const bodyWidthM = spacingM - MOB_TACTICS_BODY_GAP_M;
    const packedM = mobTacticsPackedSpacingM(bodyWidthM);
    const engageRadiusM = first ? this.tacticsEngageRadiusM(first) : MOB_TACTICS_MELEE_REACH_M;
    const band0RadiusM = mobTacticsWaitBandRadiusM(0, engageRadiusM, bodyWidthM);
    // Engaged melee slot angles, sorted.
    const engaged: number[] = [];
    for (const [key, group] of groups) {
      if (!key.startsWith("engage:")) continue;
      for (const state of group) if (state.pool === "melee" && state.slotAngleDeg !== null) engaged.push(state.slotAngleDeg);
    }
    engaged.sort((left, right) => left - right);
    // Smallest angle from an engaged mob that keeps a band-0 waiter clear of it.
    const cosine = (band0RadiusM ** 2 + engageRadiusM ** 2 - packedM ** 2) / (2 * band0RadiusM * engageRadiusM);
    const clearDeg = cosine >= 1 ? 0 : cosine <= -1 ? 180 : (Math.acos(cosine) * 180) / Math.PI;
    const midpoints: number[] = [];
    if (engaged.length === 0) {
      // Nobody engaged: band 0 is a plain ring (relaxed below with the rest).
    } else {
      for (let index = 0; index < engaged.length; index += 1) {
        const from = engaged[index]!;
        const to = index + 1 < engaged.length ? engaged[index + 1]! : engaged[0]! + 360;
        if (to - from >= 2 * clearDeg) midpoints.push(normalizeAngleDeg((from + to) / 2));
      }
    }
    const used = new Set<number>();
    const outer: Array<{ state: MobTacticsState; keep: boolean }> = [];
    for (const waiter of waiters) {
      if (midpoints.length === 0 || used.size >= midpoints.length) {
        outer.push(waiter);
        continue;
      }
      const reference = waiter.keep && waiter.state.layer === 0 && waiter.state.slotAngleDeg !== null
        ? waiter.state.slotAngleDeg
        : waiter.state.bearingDeg;
      let best = -1;
      let bestDiff = Number.POSITIVE_INFINITY;
      for (let index = 0; index < midpoints.length; index += 1) {
        if (used.has(index)) continue;
        const diff = Math.abs(((midpoints[index]! - reference + 540) % 360) - 180);
        if (diff < bestDiff) {
          bestDiff = diff;
          best = index;
        }
      }
      used.add(best);
      waiter.state.layer = 0;
      waiter.state.radiusM = band0RadiusM;
      waiter.state.slotAngleDeg = midpoints[best]!;
    }
    // Outer bands (band 1 and out, or band 0 itself when nobody is engaged), relaxed at the packed spacing.
    let band = engaged.length === 0 ? 0 : 1;
    let offset = 0;
    while (offset < outer.length) {
      const radiusM = mobTacticsWaitBandRadiusM(band, engageRadiusM, bodyWidthM);
      const capacity = ringCapacity(radiusM, packedM);
      const slice = outer.slice(offset, offset + capacity);
      for (let index = 0; index < slice.length; index += 1) {
        const { state, keep } = slice[index]!;
        const slotItem = tactics.slotItem(index);
        slotItem.id = state.mobId;
        slotItem.bearingDeg = state.bearingDeg;
        slotItem.prevSlotDeg = keep && state.layer === band ? state.slotAngleDeg : null;
        slotItem.arcHalfDeg = 180;
        slotItem.arcCenterDeg = 0;
        state.layer = band;
        state.radiusM = radiusM;
      }
      tactics.slotItems.length = slice.length;
      tactics.slotOut.clear();
      relaxSlotsInto(tactics.slotItems, slice.length, radiusM, tactics.slotOut, undefined, tactics.slotScratch, packedM);
      for (const { state } of slice) state.slotAngleDeg = tactics.slotOut.get(state.mobId) ?? state.slotAngleDeg;
      offset += slice.length;
      band += 1;
    }
  }

  /** Strike tick: the wound-up strike resolves exactly once (cone or lane), then the punish window. */
  private finishTacticsStrike(mob: Combatant, player: Combatant, state: MobTacticsState): void {
    const pending = mob.special?.pendingBasicStrike ?? null;
    this.orphanedMeleeStrikeMobIds.delete(mob.entityId);
    if (pending && pending.targetEntityId === player.entityId) {
      const landed = this.resolvePendingMeleeStrike(mob, player);
      if (landed && this.mobArchetypesActive()) {
        this.mobTactics.ledgers.get(player.entityId)?.recordLanded(this.currentTick, pending.damageFactor ?? 1);
      }
      if (state.arch) state.arch.waveId = null;
      this.markDirty(mob);
      this.consumeHunterSnareOpportunity(mob);
      const session = mob.aggroOwnerPlayerId ? this.pveSessions.get(mob.aggroOwnerPlayerId) : undefined;
      if (session?.enemyIds.has(mob.entityId)) this.consumeFortifyOpportunity(session, mob.entityId, true);
      this.consumeEnemyActionEffects(mob);
      this.expireRotationEnemyOpportunity(mob.entityId);
      if (mob.threatPriorityRemainingActions > 0) {
        mob.threatPriorityRemainingActions -= 1;
        if (mob.threatPriorityRemainingActions <= 0) mob.threatPriorityPlayerId = null;
      }
    } else if (pending && mob.special) {
      mob.special.pendingBasicStrike = null;
    }
    this.enterTacticsRecover(state, this.currentTick);
  }

  private enterTacticsRecover(state: MobTacticsState, now: number, recoverMs: number = state.rhythm.recoverMs): void {
    state.phase = "recover";
    state.phaseEndTick = now + tacticsMsToTicks(recoverMs, this.options.tickRateHz);
    state.backoffBearingDeg = state.bearingDeg;
  }

  // ---- Mob archetypes (docs/plans/mob-ai-phase2.md): rhythm, movement style, one signature move ----

  /** MOB_ARCHETYPES_ENABLED, effective only while action combat and mob tactics are on. */
  private mobArchetypesActive(): boolean {
    return this.mobTacticsActive() && this.options.mobArchetypesEnabled?.() === true;
  }

  private archOnlyRaw: string | null = null;
  private archOnly: ReadonlySet<MobArchetypeId> | null = null;

  /** MOB_ARCHETYPES_ONLY, parsed once per distinct value; null = every archetype. */
  private mobArchetypesOnlySet(): ReadonlySet<MobArchetypeId> | null {
    const raw = this.options.mobArchetypesOnly?.() ?? "";
    if (raw !== this.archOnlyRaw) {
      this.archOnlyRaw = raw;
      this.archOnly = parseArchetypesOnly(raw);
    }
    return this.archOnly;
  }

  /** A mob under tactics with an archetype: its legacy strike timers (processStag, processGimmickStrike) stay off. */
  private isArchetypeManaged(mob: Combatant): boolean {
    return (this.mobTactics.mobs.get(mob.entityId)?.arch ?? null) !== null;
  }

  /** Attack range tactics use: the flag-gated caster reach override (owner decision 2), else the definition's. */
  private tacticsRangeM(mob: Combatant): number {
    return this.mobTactics.mobs.get(mob.entityId)?.arch?.reachOverrideM ?? mob.attackRangeM;
  }

  /** True while a managed skirmisher is mid-hop: player swings and shots pass it by. */
  private isTacticsHopping(entityId: string): boolean {
    const arch = this.mobTactics.mobs.get(entityId)?.arch ?? null;
    return arch !== null && arch.hopUntilTick > this.currentTick && arch.hopRemainingM > 0;
  }

  /** Archetype step: the mob's own step times its speed share (burst share when bursting), never above 0.95 x player speed. */
  private archStepM(arch: ArchetypeTacticsState, maxStepM: number, burst: boolean): number {
    const factor = burst ? arch.params.burstSpeedFactor : arch.params.speedFactor;
    const playerStepM = ((this.options.playerMovementSpeedMps ?? DEFAULT_PLAYER_SPEED_MPS) * MOB_ARCH_MAX_SPEED_SHARE) /
      this.options.tickRateHz;
    return Math.max(0, Math.min(maxStepM * factor, playerStepM));
  }

  /** Bursting: a retreating pack mate, a skirmisher backing off in recover, a fast caster kiting. */
  private archBursting(state: MobTacticsState, now: number): boolean {
    const arch = state.arch;
    if (!arch) return false;
    if (arch.archetype === "pack") return arch.retreatUntilTick > now;
    if (arch.archetype === "skirmisher") return state.phase === "recover";
    if (arch.archetype === "caster") return state.pool === "ranged" && state.distanceM < MOB_ARCHETYPE_RETREAT.caster.kiteTriggerM;
    return false;
  }

  /** One orbit direction per target for every pack mate (spec 4.1), flipping every 6 to 10 s (seeded per player). */
  private packOrbitDirection(playerId: string, now: number): 1 | -1 {
    const periodMs = PACK_ORBIT_FLIP_MIN_MS + tacticsHash01(`${playerId}~orbit`) * (PACK_ORBIT_FLIP_MAX_MS - PACK_ORBIT_FLIP_MIN_MS);
    const periodTicks = Math.max(1, tacticsMsToTicks(periodMs, this.options.tickRateHz));
    return strafeDirection(`${playerId}#orbit`, Math.floor(now / periodTicks));
  }

  /**
   * Archetype ring choice (spec 4.1, 4.2, 6.2 step 4). Returns the destination radius, or -1 to hold ground (a slow
   * caster inside its kite trigger).
   */
  private archDestinationRadiusM(
    state: MobTacticsState,
    mob: Combatant,
    radiusM: number,
    holdsToken: boolean,
    ledger: TokenLedger
  ): number {
    const arch = state.arch!;
    const now = this.currentTick;
    if (arch.archetype === "pack" && arch.retreatUntilTick > now) {
      return mobTacticsWaitBandRadiusM(MOB_ARCHETYPE_RETREAT.pack.band, this.tacticsEngageRadiusM(mob), this.tacticsBodyWidthM(mob));
    }
    const preferred = arch.params.preferred;
    if (preferred.kind === "wait_band" && state.pool === "melee" && !holdsToken) {
      // Pack waits at 180 m, Swarmer at 130 m (engage seat or not; only a token holder walks in): the Phase 1 bands
      // shifted, never onto the engaged bodies.
      const floorM = this.tacticsEngageRadiusM(mob) + this.tacticsBodyWidthM(mob) / 2 + MOB_TACTICS_PACKED_GAP_M;
      let bandM = state.ring === "wait" ? radiusM + preferred.radiusM - MOB_TACTICS_WAIT_BAND_BASE_M : preferred.radiusM;
      // Ready to strike: wait closer, so the walk-in under a token is short (chunk H).
      const readyM = MOB_ARCH_READY_BAND_M[arch.archetype];
      if (readyM !== undefined && state.phase === "wait") bandM = Math.min(bandM, readyM);
      return Math.max(floorM, bandM);
    }
    if (preferred.kind === "engage_then_retreat" && state.phase === "cooldown" && !holdsToken) {
      return Math.max(radiusM, preferred.retreatToM);
    }
    if (holdsToken && this.archDropInPending(state, mob, ledger)) {
      // The bird drops into swoop range (the slammer into slam range) for the strike, then returns to its ring.
      return Math.max(0, signatureTriggerMaxM(arch.signature!) - MOB_TACTICS_SLOT_ARRIVE_M);
    }
    if (preferred.kind === "outer_ring" && state.pool === "ranged") {
      if (state.distanceM < MOB_ARCHETYPE_RETREAT.caster.kiteTriggerM) {
        const playerSpeedMps = this.options.playerMovementSpeedMps ?? DEFAULT_PLAYER_SPEED_MPS;
        const fast = this.effectiveMobMovementSpeedMps(mob) >= playerSpeedMps * arch.params.kiteMinSpeedShare;
        return fast ? MOB_ARCHETYPE_RETREAT.caster.kiteTargetM : -1;
      }
      return Math.min(preferred.maxM, Math.max(preferred.minM, radiusM));
    }
    return radiusM;
  }

  /**
   * A swoop bird or a slammer whose signature is ready but which stands outside its (tighter) trigger: it holds its
   * token and steps in for the signature instead of a basic strike.
   */
  private archDropInPending(state: MobTacticsState, mob: Combatant, ledger: TokenLedger): boolean {
    const signature = state.arch?.signature;
    return signature !== undefined && signature !== null && signatureDropsIn(signature.kind) &&
      this.currentTick >= (mob.special?.archSignatureReadyTick ?? 0) &&
      ledger.signatureHolderId === null && state.distanceM > signatureTriggerMaxM(signature);
  }

  /**
   * Distance from which a waiting mob may ask for a token. Phase 1: its strike reach plus the hold buffer. Pack and
   * Swarmer wait on their own band (180 m, 130 m) and walk in once granted, so they may ask from it.
   */
  private tacticsAskReachM(mob: Combatant, state: MobTacticsState): number {
    const reachM = this.tacticsReachM(mob, state) + MOB_ATTACK_HOLD_RANGE_BUFFER_M;
    const preferred = state.arch?.params.preferred;
    if (!preferred || preferred.kind !== "wait_band" || state.pool !== "melee") return reachM;
    return Math.max(reachM, preferred.radiusM + MOB_TACTICS_SLOT_ARRIVE_M * 2);
  }

  /** Pack hurt retreat (spec 4.2): at 35% HP or less, with a living mate, one at a time per player, 2.5 s to band 2. */
  private updatePackRetreats(playerId: string, ledger: TokenLedger): void {
    const rule = MOB_ARCHETYPE_RETREAT.pack;
    const now = this.currentTick;
    const hz = this.options.tickRateHz;
    const ids = this.tacticsRosterIds(playerId);
    let packCount = 0;
    let retreating = 0;
    for (const id of ids) {
      const arch = this.mobTactics.mobs.get(id)?.arch;
      if (arch?.archetype !== "pack") continue;
      packCount += 1;
      if (arch.retreatUntilTick > now) retreating += 1;
    }
    // A lone wolf never retreats.
    if (packCount < 2) return;
    for (const id of ids) {
      if (retreating >= rule.maxRetreatingPerPlayer) return;
      const state = this.mobTactics.mobs.get(id);
      const arch = state?.arch;
      const mob = this.entities.get(id);
      if (!state || !arch || !mob || arch.archetype !== "pack" || arch.retreatUntilTick > now || now < arch.retreatReadyTick) continue;
      if (state.phase !== "approach" && state.phase !== "wait" && state.phase !== "cooldown") continue;
      if (ledger.holds(id) || mob.currentHealth > mob.maxHealth * rule.hurtHpShare) continue;
      const retreatTicks = tacticsMsToTicks(rule.retreatMs, hz);
      arch.retreatUntilTick = now + retreatTicks;
      arch.retreatReadyTick = now + retreatTicks + tacticsMsToTicks(rule.cooldownMs, hz);
      state.grabbed = false;
      retreating += 1;
    }
  }

  /**
   * Skirmisher hop (spec 4.2): a skirmisher the committed swing would reach that is not winding up, recovering,
   * staggered or held hops straight out of reach, at most once per 4 s; it is skipped by this swing.
   */
  private triggerSkirmisherHops(player: Combatant, dirX: number, dirY: number, candidateIds: Iterable<string>): void {
    const now = this.currentTick;
    const hz = this.options.tickRateHz;
    const hop = MOB_ARCHETYPE_RETREAT.skirmisher;
    const cosLat = Math.cos((player.position.lat * Math.PI) / 180);
    const local = this.tacticsLocal;
    for (const id of candidateIds) {
      const state = this.mobTactics.mobs.get(id);
      const arch = state?.arch ?? null;
      const mob = this.entities.get(id);
      if (!state || arch === null || !mob || arch.archetype !== "skirmisher" || arch.inSignature) continue;
      if (now < arch.hopReadyTick || arch.hopUntilTick > now) continue;
      if (state.phase !== "approach" && state.phase !== "wait" && state.phase !== "cooldown") continue;
      if (this.isMobMovementHeld(mob) || (mob.special?.staggerUntilTick ?? 0) > now) continue;
      toLocalMeters(player.position.lat, player.position.lon, cosLat, mob.position.lat, mob.position.lon, local);
      const distanceM = Math.hypot(local.x, local.y);
      // Inside this swing's reach of the hop mob's hurt circle (the same measure the swing uses).
      if (distanceM > SWING_RANGE_M + this.hurtRadiusM(mob) || local.x * dirX + local.y * dirY <= 0) continue;
      arch.hopBearingDeg = normalizeAngleDeg((Math.atan2(local.x, local.y) * 180) / Math.PI);
      // One spare tick: the hop covers its full distance whether this swing resolves before or after the tactics pass.
      arch.hopUntilTick = now + Math.max(1, tacticsMsToTicks(hop.hopMs, hz)) + 1;
      arch.hopRemainingM = hop.hopDistanceM;
      arch.hopReadyTick = now + tacticsMsToTicks(hop.hopCooldownMs, hz);
      // A token it held for a strike not yet started goes back: the hop takes it out of reach.
      this.mobTactics.ledgers.get(state.targetId)?.release(id);
      this.markDirty(mob);
    }
  }

  /**
   * Spec 6.2 step 5: the mob's signature is off cooldown, its trigger window holds, and the slot, the landing
   * spacing and the damage governor allow it to start now (plus the lunge rear arc, the smoke puff spot and the
   * clear lane where they apply).
   */
  private archWantsSignature(
    state: MobTacticsState,
    mob: Combatant,
    ledger: TokenLedger,
    headingDeg: number | null,
    checkLandingWindows = true
  ): boolean {
    const arch = state.arch;
    const signature = arch?.signature ?? null;
    if (!arch || signature === null) return false;
    const now = this.currentTick;
    if (now < (mob.special?.archSignatureReadyTick ?? 0) || arch.retreatUntilTick > now || arch.hopUntilTick > now) return false;
    if (state.distanceM < signature.triggerMinM || state.distanceM > signatureTriggerMaxM(signature)) return false;
    if (!ledger.signatureSlotOpen(now, arch.signaturePartTicks)) return false;
    if (checkLandingWindows && !ledger.canStartSignature(now, arch.signaturePartTicks)) return false;
    const he = signatureDamageFactor(signature, isAnimalMob(mob.archetypeKey)) * arch.signaturePartTicks.length;
    if (!ledger.governorAllows(now, this.archInFlightHe + he)) return false;
    if (signature.kind === "lunge" && !inLungeRearArc(headingDeg, state.bearingDeg)) return false;
    if (signature.kind === "smoke_step") {
      const player = this.entities.get(state.targetId);
      if (!player) return false;
      const puff = destinationPoint(player.position, signature.rangeM, initialBearingDegrees(mob.position, player.position));
      if (!this.isMobPositionTraversable(puff, mob.regionCode)) return false;
    }
    if (signatureNeedsClearLane(signature.kind) && !this.archClearLane(state, mob)) return false;
    return true;
  }

  /**
   * Clear lane (owner decision 6, no terrain line of sight): the straight lane to the target crosses no blocked
   * ground, and for a caster no other caster's body.
   */
  private archClearLane(state: MobTacticsState, mob: Combatant): boolean {
    const player = this.entities.get(state.targetId);
    if (!player) return false;
    const totalM = state.distanceM;
    const steps = Math.max(1, Math.ceil(totalM / SIGNATURE_LANE_SAMPLE_M));
    for (let index = 1; index < steps; index += 1) {
      if (!this.isMobPositionTraversable(moveToward(mob.position, player.position, (totalM * index) / steps), mob.regionCode)) return false;
    }
    if (state.arch?.archetype !== "caster") return true;
    const roster = this.mobTactics.rosters.get(state.targetId);
    if (!roster) return true;
    const lengthSq = state.x * state.x + state.y * state.y;
    if (!(lengthSq > 0)) return true;
    for (const otherId of roster) {
      if (otherId === state.mobId) continue;
      const other = this.mobTactics.mobs.get(otherId);
      if (!other || other.arch?.archetype !== "caster") continue;
      // Distance from the other caster to the segment player (0, 0) -> this mob (x, y), in the local frame.
      const along = (other.x * state.x + other.y * state.y) / lengthSq;
      if (along <= 0 || along >= 1) continue;
      const gapM = Math.hypot(other.x - state.x * along, other.y - state.y * along);
      if (gapM < this.tacticsBodyWidthM(this.entities.get(otherId)) / 2) return false;
    }
    return true;
  }

  /** An archetype basic windup: the archetype's windup, reach and hit factor; swarmers telegraph the wave cone. */
  private beginArchetypeWindup(mob: Combatant, player: Combatant, state: MobTacticsState, dueTick: number, swarm: boolean): void {
    const arch = state.arch!;
    if (state.pool === "ranged") {
      this.beginRangedAim(mob, player, dueTick, state.rhythm.windupMs, this.tacticsRangeM(mob), arch.basicDamageFactor);
      return;
    }
    const wave = MOB_SIGNATURES.pile_on_wave;
    this.beginMeleeWindup(
      mob, player, dueTick, state.rhythm.windupMs, this.tacticsReachM(mob, state),
      swarm
        ? { abilityId: wave.abilityIds[0]!, angleDeg: wave.angleDeg, damageFactor: arch.basicDamageFactor }
        : { damageFactor: arch.basicDamageFactor }
    );
  }

  /** Hit-equivalents started on the player being processed, this tick (governor). */
  private archInFlightHe = 0;

  /** Re-measures every roster mob in the local frame around the player (after a signature moved someone this tick). */
  private measureTacticsRoster(playerId: string, player: Combatant): void {
    const local = this.tacticsLocal;
    const cosLat = Math.cos((player.position.lat * Math.PI) / 180);
    for (const mobId of this.tacticsRosterIds(playerId)) {
      const state = this.mobTactics.mobs.get(mobId);
      const mob = this.entities.get(mobId);
      if (!state || !mob) continue;
      toLocalMeters(player.position.lat, player.position.lon, cosLat, mob.position.lat, mob.position.lon, local);
      state.x = local.x;
      state.y = local.y;
      state.distanceM = Math.hypot(local.x, local.y);
      state.bearingDeg = normalizeAngleDeg((Math.atan2(local.x, local.y) * 180) / Math.PI);
    }
  }

  /** Spec 6.2 step 6: starts the signature telegraph (the slot is taken, each part's landing reserved). */
  private beginSignature(mob: Combatant, player: Combatant, state: MobTacticsState, ledger: TokenLedger): void {
    const arch = state.arch!;
    const signature = arch.signature!;
    const now = this.currentTick;
    const parts = arch.signaturePartTicks;
    ledger.takeSignatureSlot(mob.entityId, now, parts);
    arch.inSignature = true;
    this.archInFlightHe += signatureDamageFactor(signature, isAnimalMob(mob.archetypeKey)) * parts.length;
    const origin = { ...mob.position };
    const facingDegrees = initialBearingDegrees(origin, player.position);
    const distanceM = distanceMeters(origin, player.position);
    const pending: PendingSignature = {
      kind: signature.kind, targetEntityId: player.entityId, part: 0, dueTick: now + parts[0]!,
      origin, facingDegrees, lengthM: signatureLaneLengthM(signature, distanceM), stopM: 0, anyHit: false
    };
    const durationMs = signature.telegraphMs[0]!;
    const abilityId = signature.abilityIds[0]!;
    switch (signature.shape) {
      case "line":
        // The lunge ends next to the player's locked position (the engage ring short of it).
        if (signature.kind === "lunge") pending.stopM = Math.max(0, Math.min(pending.lengthM, distanceM - this.tacticsEngageRadiusM(mob)));
        this.addMobTelegraph(mob, abilityId, {
          kind: "line", origin, facingDegrees, lengthM: signatureDrawnM(pending.lengthM), widthM: signature.widthM
        }, durationMs);
        break;
      case "cone":
      case "cone_pair":
        this.addMobTelegraph(mob, abilityId, {
          kind: "cone", origin, facingDegrees, rangeM: signatureDrawnM(signature.rangeM), angleDegrees: signature.angleDeg
        }, durationMs);
        break;
      case "circle": {
        // Slam on the mob, ground blast on the player, the smoke puff behind the player.
        const center = signature.kind === "slam"
          ? origin
          : signature.kind === "smoke_step"
            ? destinationPoint(player.position, signature.rangeM, facingDegrees)
            : { ...player.position };
        pending.origin = center;
        this.addMobTelegraph(mob, abilityId, { kind: "circle", center, radiusM: signatureDrawnM(signature.radiusM) }, durationMs);
        break;
      }
      case "fan": {
        // Three lines: centre on the player, the side lines half the fan angle off; each has its own telegraph id.
        const facings = volleyFacings(facingDegrees, signature.angleDeg);
        for (let index = 0; index < facings.length; index += 1) {
          this.addMobTelegraph(mob, signature.abilityIds[index]!, {
            kind: "line", origin, facingDegrees: facings[index]!, lengthM: signatureDrawnM(signature.rangeM), widthM: signature.widthM
          }, durationMs);
        }
        break;
      }
      case "wave":
        break;
    }
    this.mobSpecial(mob).pendingSignature = pending;
    state.phase = "windup";
    state.phaseEndTick = pending.dueTick;
    this.orphanedMeleeStrikeMobIds.delete(mob.entityId);
    this.markDirty(mob);
  }

  private readonly signatureHitLocal: LocalMetersOut = { x: 0, y: 0 };
  /** Set by applySignatureHits: the signature's own target was hit. */
  private signatureTargetHit = false;

  /**
   * Every living player in the zone whose hurt circle overlaps the locked (drawn) shape takes the hit unless in dash
   * i-frames (a dodge: no hit, no knockback). Volley lines hit a player at most once. Returns the hit count; a missed
   * target gets a DODGE event.
   */
  private applySignatureHits(
    mob: Combatant,
    target: Combatant,
    pending: PendingSignature,
    signature: MobSignatureParams,
    factor: number
  ): number {
    const scanM = Math.max(pending.lengthM, signature.rangeM, signature.radiusM) + 50;
    const r = PLAYER_HURT_RADIUS_M;
    const laneM = signatureDrawnM(pending.lengthM);
    const rangeM = signatureDrawnM(signature.rangeM);
    const radiusM = signatureDrawnM(signature.radiusM);
    const local = this.signatureHitLocal;
    const cosLat = Math.cos((pending.origin.lat * Math.PI) / 180);
    const facings = signature.shape === "fan" ? volleyFacings(pending.facingDegrees, signature.angleDeg) : null;
    const knockbackM = signatureKnockbackM(signature.kind);
    const abilityId = signature.abilityIds[Math.min(pending.part, signature.abilityIds.length - 1)]!;
    let hits = 0;
    let targetHit = false;
    for (const id of [...this.grid.query(pending.origin, scanM)]) {
      const victim = this.entities.get(id);
      if (!victim || victim.kind !== "player" || victim.lifeState !== "alive" || victim.zoneId !== mob.zoneId) continue;
      toLocalMeters(pending.origin.lat, pending.origin.lon, cosLat, victim.position.lat, victim.position.lon, local);
      let inside: boolean;
      if (signature.shape === "line") {
        inside = signatureLaneContains(pending.facingDegrees, laneM, signature.widthM, local.x, local.y, r);
      } else if (facings !== null) {
        inside = facings.some((facing) => signatureLaneContains(facing, rangeM, signature.widthM, local.x, local.y, r));
      } else if (signature.shape === "circle") {
        inside = signatureCircleContains(radiusM, local.x, local.y, r);
      } else {
        inside = signatureConeContains(pending.facingDegrees, rangeM, signature.angleDeg, local.x, local.y, r);
      }
      if (!inside || this.options.isEntityInvulnerable?.(victim.entityId) === true) continue;
      hits += 1;
      if (victim.entityId === target.entityId) targetHit = true;
      // Factor 1.0 = one Phase 1 basic hit on this player (the PvE matrix hit when it applies, else the attack stat).
      this.applyScriptedDamage(mob.entityId, victim.entityId, Math.max(1, Math.round(this.mobBasicHitDamage(mob, victim) * factor)), abilityId);
      if (knockbackM > 0) this.knockbackPlayer(victim.entityId, pending.origin, knockbackM);
      if (signature.kind === "tongue") this.pullPlayer(victim.entityId, mob.position, FROG_TONGUE.stopDistanceM);
      // The lunge spends the pounce opener (they never stack).
      if (signature.kind === "lunge" && victim.entityId === target.entityId) this.mobSpecial(mob).pounceTargetId = victim.entityId;
    }
    if (!targetHit) this.emitInnateEvent(target.entityId, target.entityId, "DODGE", abilityId);
    this.signatureTargetHit = targetHit;
    return hits;
  }

  /**
   * Signature strike tick: tests the locked shape and applies the damage, re-aims the double strike's second cone,
   * then the aftermath (spec 4.4): a miss staggers the mob and gives its token back at once; a hit costs a short
   * recovery. The slot frees and the per-mob cooldown starts at the landing.
   */
  private resolveSignaturePart(mob: Combatant, player: Combatant, state: MobTacticsState, ledger: TokenLedger): void {
    const arch = state.arch!;
    const signature = arch.signature;
    const special = this.mobSpecial(mob);
    const pending = special.pendingSignature;
    const now = this.currentTick;
    const hz = this.options.tickRateHz;
    if (!signature || !pending || pending.targetEntityId !== player.entityId) {
      this.cancelMobSignature(mob.entityId, state, false);
      this.enterTacticsRecover(state, now);
      return;
    }
    let factor = signatureDamageFactor(signature, isAnimalMob(mob.archetypeKey));
    if (signature.kind === "lunge" && pounceReady(mob.archetypeKey, special.pounceTargetId, player.entityId)) {
      // Pounce does not stack with the lunge: the opener uses the larger factor.
      factor = Math.max(factor, POUNCE.damageFactor);
    }
    if (signature.kind !== "smoke_step") {
      const hits = this.applySignatureHits(mob, player, pending, signature, factor);
      if (hits > 0) pending.anyHit = true;
      if (this.signatureTargetHit) ledger.recordLanded(now, factor);
      // Reentrancy: the hit can end the fight (the player dies, the mob dies to a reflect) and forget this mob,
      // which cancels the signature. Nothing more to do then: no re-aim, no move, no aftermath.
      if (this.mobTactics.mobs.get(mob.entityId) !== state || special.pendingSignature !== pending || mob.lifeState !== "alive") {
        if (special.pendingSignature === pending) special.pendingSignature = null;
        arch.inSignature = false;
        ledger.finishSignature(mob.entityId, now);
        return;
      }
    }
    // Movement that ends the move: the charge runs to the lane end, the lunge stops beside the locked spot, the smoke blinks.
    if (signature.kind === "charge" || signature.kind === "lunge") {
      const travelM = signature.kind === "charge" ? pending.lengthM : pending.stopM;
      if (travelM > 1) this.placeMobAtFirstTraversable(mob, [destinationPoint(pending.origin, travelM, pending.facingDegrees)]);
    } else if (signature.kind === "smoke_step") {
      if (this.placeMobAtFirstTraversable(mob, [pending.origin])) {
        special.backstabUntilTick = now + millisecondsToTicks(BANDIT_BACKSTAB.readyMs, hz);
      }
    } else if (signature.kind === "ground_blast" && gimmickStrikeFor(mob.archetypeKey)?.kind === "ink") {
      // Squid-family blasts keep the ink's slowing cloud.
      const center = { ...pending.origin };
      this.acidZones.push({
        zoneId: mob.zoneId, sourceEntityId: mob.entityId, center, landTick: now,
        endTick: now + millisecondsToTicks(SQUID_INK.durationMs, hz), nextTick: now,
        damage: Math.max(1, Math.round(mob.attackDamage * SQUID_INK.damageFactor)),
        radiusM: SQUID_INK.radiusM, techniqueId: SQUID_INK.techniqueId,
        slow: { durationMs: SQUID_INK.slowMs, amount: SQUID_INK.slowAmount }
      });
      this.addMobTelegraph(mob, SQUID_INK.techniqueId, { kind: "circle", center, radiusM: SQUID_INK.radiusM }, SQUID_INK.durationMs);
    }
    if (signature.kind === "double_strike" && pending.part === 0 && arch.signaturePartTicks.length > 1) {
      // The second cone is re-aimed at the player when the first resolves.
      const parts = arch.signaturePartTicks;
      pending.part = 1;
      pending.origin = { ...mob.position };
      pending.facingDegrees = initialBearingDegrees(mob.position, player.position);
      pending.dueTick = now + Math.max(1, parts[1]! - parts[0]!);
      this.addMobTelegraph(mob, signature.abilityIds[1]!, {
        kind: "cone", origin: pending.origin, facingDegrees: pending.facingDegrees, rangeM: signatureDrawnM(signature.rangeM),
        angleDegrees: signature.angleDeg
      }, signature.telegraphMs[1]!);
      state.phaseEndTick = pending.dueTick;
      this.markDirty(mob);
      return;
    }
    special.pendingSignature = null;
    arch.inSignature = false;
    ledger.finishSignature(mob.entityId, now);
    special.archSignatureReadyTick = now + tacticsMsToTicks(signature.cooldownMs, hz);
    this.markDirty(mob);
    const missed = !pending.anyHit && signature.kind !== "smoke_step";
    if (missed && signature.missStaggerMs > 0) {
      // A stagger never holds a token.
      this.applySignatureAftermath(mob, false, signature.missStaggerMs);
      ledger.release(mob.entityId);
      this.enterTacticsRecover(state, now, Math.max(state.rhythm.recoverMs, signature.missStaggerMs));
      return;
    }
    if (pending.anyHit && signature.missStaggerMs > 0 && signature.hitRecoveryMs > 0) {
      this.applySignatureAftermath(mob, true, signature.hitRecoveryMs);
    }
    this.enterTacticsRecover(state, now, Math.max(state.rhythm.recoverMs, signature.hitRecoveryMs));
  }

  /** The incoming damage of one plain basic hit from `mob` on `target` before defenses (the PvE matrix when it applies). */
  private mobBasicHitDamage(mob: Combatant, target: Combatant): number {
    const matrix = target.kind === "player" ? this.pveMatrixMobProfile(mob) : null;
    const matrixDamage = matrix ? this.resolveMobToPlayerPveMatrixDamage(mob, target, matrix) : null;
    return Math.max(1, matrixDamage ?? mob.attackDamage);
  }

  /** Signature aftermath: a miss staggers (frozen, takes extra damage), a hit roots for a short recovery. */
  private applySignatureAftermath(mob: Combatant, hit: boolean, durationMs: number): void {
    if (mob.lifeState !== "alive" || mob.currentHealth <= 0) return;
    const state = this.mobSpecial(mob);
    const endTick = this.currentTick + millisecondsToTicks(durationMs, this.options.tickRateHz);
    state.stunUntilTick = Math.max(state.stunUntilTick, endTick);
    if (!hit) state.staggerUntilTick = Math.max(state.staggerUntilTick, endTick);
    this.addTimedEffect(mob, mob, "rooted", hit ? "strike_recovery" : "strike_stagger", durationMs, 1);
    this.markDirty(mob);
  }

  /**
   * Cancels a live signature (target swap, hand-back, death, leash): the telegraph goes, the slot and its unlanded
   * reservations free, nothing is refunded and the next signature is SIGNATURE_CANCEL_LOCKOUT_MS away. Idempotent.
   */
  private cancelMobSignature(mobId: string, state: MobTacticsState, lockout = true): void {
    const arch = state.arch;
    if (!arch) return;
    arch.inSignature = false;
    this.mobTactics.ledgers.get(state.targetId)?.cancelSignature(mobId, this.currentTick);
    // The telegraph goes even when the mob is already gone (a mob-less cast would otherwise ride on nearby players).
    const before = this.mobCasts.length;
    this.mobCasts = this.mobCasts.filter(({ sourceEntityId, cast }) => sourceEntityId !== mobId || !isMobSignatureAbilityId(cast.abilityId));
    if (this.mobCasts.length !== before) this.immediateFlushPending = true;
    const mob = this.entities.get(mobId);
    if (!mob?.special) return;
    if (this.mobCasts.length !== before) this.markDirty(mob);
    mob.special.pendingSignature = null;
    if (lockout) {
      mob.special.archSignatureReadyTick = Math.max(
        mob.special.archSignatureReadyTick,
        this.currentTick + tacticsMsToTicks(SIGNATURE_CANCEL_LOCKOUT_MS, this.options.tickRateHz)
      );
    }
  }

  /** Test and metrics view: the target's signature slot holder and governor load (Phase 2). */
  mobArchetypeLedgerSnapshot(playerId: string): { signatureHolderId: string | null; governorLoad: number; tokensInUse: number } | null {
    const ledger = this.mobTactics.ledgers.get(playerId);
    if (!ledger) return null;
    return {
      signatureHolderId: ledger.signatureHolderId,
      governorLoad: ledger.governorLoad(this.currentTick),
      tokensInUse: ledger.inUse("melee") + ledger.inUse("ranged")
    };
  }

  /** Test and metrics view: managed mob count and token points held. */
  mobTacticsSnapshot(): { managed: number; tokensInUse: number; ledgers: number } {
    return {
      managed: this.mobTactics.mobs.size,
      tokensInUse: this.mobTactics.tokensInUse(),
      ledgers: this.mobTactics.ledgers.size
    };
  }

  private moveMobWithPackSeparation(
    mob: Combatant,
    target: LatLon,
    maximumStepM: number
  ): LatLon {
    const direct = moveToward(mob.position, target, maximumStepM);
    const minimumSeparationM = mob.archetypeKey
      ? requireMobDefinition(mob.archetypeKey).combatSeparationM
      : 0;
    if (!mob.packId || minimumSeparationM <= 0 || maximumStepM <= 0) return direct;
    const metersPerLatitude = 111_320;
    const metersPerLongitude = Math.max(
      1,
      metersPerLatitude * Math.cos(mob.position.lat * Math.PI / 180)
    );
    let movementEastM = longitudeDeltaDegrees(mob.position.lon, direct.lon) * metersPerLongitude;
    let movementNorthM = (direct.lat - mob.position.lat) * metersPerLatitude;
    let repulsionEast = 0;
    let repulsionNorth = 0;
    const packNeighbors = this.grid.query(
      mob.position,
      minimumSeparationM
    )
      .map((entityId) => this.entities.get(entityId))
      .filter((candidate): candidate is Combatant => Boolean(
        candidate &&
        candidate.entityId !== mob.entityId &&
        candidate.kind === "mob" &&
        candidate.lifeState === "alive" &&
        candidate.packId === mob.packId
      ))
      .sort((left, right) => left.entityId.localeCompare(right.entityId));
    for (const neighbor of packNeighbors) {
      let eastM = longitudeDeltaDegrees(neighbor.position.lon, mob.position.lon) * metersPerLongitude;
      let northM = (mob.position.lat - neighbor.position.lat) * metersPerLatitude;
      let separationM = Math.hypot(eastM, northM);
      if (separationM < 0.01) {
        eastM = longitudeDeltaDegrees(neighbor.homePosition.lon, mob.homePosition.lon) * metersPerLongitude;
        northM = (mob.homePosition.lat - neighbor.homePosition.lat) * metersPerLatitude;
        separationM = Math.hypot(eastM, northM);
      }
      if (separationM < 0.01) {
        const direction = deterministicDirection(mob.entityId, neighbor.entityId);
        eastM = Math.sin(direction);
        northM = Math.cos(direction);
        separationM = 1;
      }
      const pressure = Math.max(
        0,
        (minimumSeparationM - distanceMeters(mob.position, neighbor.position)) /
          minimumSeparationM
      );
      repulsionEast += eastM / separationM * pressure * maximumStepM;
      repulsionNorth += northM / separationM * pressure * maximumStepM;
    }
    const repulsionM = Math.hypot(repulsionEast, repulsionNorth);
    const repulsionScale = repulsionM > maximumStepM * 0.5
      ? maximumStepM * 0.5 / repulsionM
      : 1;
    movementEastM += repulsionEast * repulsionScale;
    movementNorthM += repulsionNorth * repulsionScale;
    const movementM = Math.hypot(movementEastM, movementNorthM);
    if (movementM <= 0.001) return direct;
    const scale = Math.min(1, maximumStepM / movementM);
    return {
      lat: mob.position.lat + movementNorthM * scale / metersPerLatitude,
      lon: normalizeLongitude(mob.position.lon + movementEastM * scale / metersPerLongitude)
    };
  }

  private onEnemyDefeated(
    attacker: Combatant,
    defeated: Combatant,
    bleeding: boolean,
    sourceTechniqueId: string
  ): void {
    const runtime = requireClassCombatRuntime(attacker);
    const session = this.pveSessions.get(attacker.entityId);
    const now = this.now();
    session?.telemetry.recordEnemyDefeated(
      defeated.archetypeKey ?? "unknown",
      this.telemetryTime(session)
    );
    this.resolveV3KillEffects(attacker, defeated, sourceTechniqueId);
    if (
      defeated.kind === "mob" && runtime.skillV3 &&
      runtime.counters.skillV3ShieldChargeResetEligible === true &&
      runtime.counters.skillV3ShieldChargeTarget === defeated.entityId &&
      Number(runtime.counters.skillV3ShieldChargeEndsAt ?? 0) >= now
    ) {
      delete runtime.cooldownEndsAt[`${V3_GENERAL_COOLDOWN_PREFIX}shield_charge`];
    }
    if (runtime.counters.skillV3ShieldChargeTarget === defeated.entityId) {
      delete runtime.counters.skillV3ShieldChargeTarget;
      delete runtime.counters.skillV3ShieldChargeEndsAt;
      delete runtime.counters.skillV3ShieldChargeResetEligible;
    }
    const warStandard = runtime.effects.find((effect) =>
      effect.kind === "flat_attack" && effect.sourceTechniqueId === V3_WAR_STANDARD_ID &&
      effect.endTick >= this.currentTick
    );
    const warStandardCaster = warStandard ? this.entities.get(warStandard.sourceEntityId) : null;
    if (defeated.kind === "mob" && warStandardCaster?.kind === "player" && warStandardCaster.classRuntime?.skillV3) {
      const cooldownKey = `${V3_GENERAL_COOLDOWN_PREFIX}war_standard`;
      warStandardCaster.classRuntime.cooldownEndsAt[cooldownKey] = Math.max(
        now,
        (warStandardCaster.classRuntime.cooldownEndsAt[cooldownKey] ?? now) - V3_WAR_STANDARD_KILL_REDUCTION_MS
      );
      this.rememberClassRuntime(warStandardCaster);
    }
    if (runtime.activeClassId === "hunter") {
      this.addRage(attacker, HUNTER_BALANCE.focus.enemyDefeat, "kill");
      if (sourceTechniqueId === "hunter_cull") {
        this.addRage(attacker, HUNTER_BALANCE.focus.cullRefund, "cull");
        runtime.counters.cullRefunds = Number(runtime.counters.cullRefunds ?? 0) + 1;
        session?.telemetry.recordClassMetric("cull_refunds");
      }
    } else if (runtime.activeClassId === "warrior") {
      if (runtime.equippedPassives.has("warrior_v2_retaliation") && defeated.kind === "mob") {
        this.applyHealing(attacker, attacker, 5);
      }
      if (runtime.equippedPassives.has("warrior_v2_relentless") && sourceTechniqueId !== "warrior_v2_relentless") {
        for (const entityId of this.nearbyEntityIds(defeated.position, 150).sort()) {
          const enemy = this.entities.get(entityId);
          if (enemy && enemy.entityId !== defeated.entityId && enemy.lifeState === "alive" && this.isAttackPairValid(attacker, enemy)) {
            this.applyDamage(attacker, enemy, 4, "warrior_v2_relentless", false);
          }
        }
      }
      if (runtime.equippedPassives.has("warrior_v2_berserker")) {
        for (const id of ["warrior_v2_sundering_arc", "warrior_v2_faultline"]) {
          runtime.cooldownEndsAt[id] = Math.max(now, (runtime.cooldownEndsAt[id] ?? now) - 5_000);
        }
      }
      if (runtime.equippedPassives.has("warrior_bloodthirst") && defeated.kind === "mob") {
        this.commitNormalHealing(
          attacker.entityId,
          attacker,
          WARRIOR_BALANCE.bloodthirstHealing
        );
      }
    } else if (runtime.activeClassId === "ranger") {
      if (defeated.kind === "mob" && runtime.equippedPassives.has("ranger_v2_suppressing_fire")) {
        runtime.counters.v2WildSlayerSpecies = defeated.archetypeKey ?? "unknown";
        runtime.counters.v2WildSlayerEndsAt = this.now() + 60_000;
      }
    }
    const bloodlustEligible = runtime.subclassId === "reaver" &&
      bleeding &&
      defeated.level >= Math.max(0, attacker.level - WARRIOR_BALANCE.rage.weakEnemyLevelGap);
    if (bloodlustEligible) {
      const healingUsed = Number(runtime.counters.bloodlustHealingThisAction ?? 0);
      const healingCap = Math.round(attacker.maxHealth * WARRIOR_BALANCE.bloodlustActionHealCap);
      const requestedHeal = Math.max(1, Math.round(attacker.maxHealth * WARRIOR_BALANCE.bloodlustKillHeal));
      const heal = Math.max(0, Math.min(requestedHeal, healingCap - healingUsed));
      if (heal > 0) {
        const received = this.commitNormalHealing(
          attacker.entityId,
          attacker,
          Math.max(0, Math.round(heal))
        ).effective;
        session?.telemetry.recordReaverHealing(received);
        runtime.counters.bloodlustHealingThisAction = healingUsed + received;
      }
      const rageUsed = Number(runtime.counters.bloodlustRageThisAction ?? 0);
      const rage = Math.max(0, Math.min(WARRIOR_BALANCE.bloodlustKillRage, WARRIOR_BALANCE.bloodlustActionRageCap - rageUsed));
      if (rage > 0) {
        this.addRage(attacker, rage);
        runtime.counters.bloodlustRageThisAction = rageUsed + rage;
      }
    }
    this.rememberClassRuntime(attacker);
  }

  /** The stored Tactics ceiling: the Tactics rank, raised by Druid, Merchant, Artificer and Voyager class ranks. */
  private v3TacticsCap(runtime: ClassCombatRuntime): number {
    const rank = runtime.skillV3?.generalSkillRanks.tactics ?? 0;
    const specialization = runtime.skillV3?.activeSpecializationId ?? null;
    const specializationRank = runtime.skillV3?.specializationRank ?? 0;
    return ["druid", "merchant", "artificer", "voyager"].includes(specialization ?? "")
      ? specializationRank >= 5 ? 7 : specializationRank >= 4 ? 5.5 : specializationRank >= 2 ? 4.5 : tacticsCapForRank(rank)
      : tacticsCapForRank(rank);
  }

  /** Tactics also gains one step (TACTICS_GAIN_BY_RANK) for every tree the player finishes chopping. */
  recordTreeChopped(playerId: string): void {
    const player = this.entities.get(playerId);
    const runtime = player?.classRuntime;
    const rank = runtime?.skillV3?.generalSkillRanks.tactics ?? 0;
    if (!player || player.kind !== "player" || !runtime?.skillV3 || rank <= 0) return;
    const current = Number(runtime.counters.skillV3TacticsValue ?? 0);
    const next = Math.min(this.v3TacticsCap(runtime), current + tacticsGainForRank(rank));
    runtime.counters.skillV3TacticsValue = Math.round(Math.max(current, next) * 10) / 10;
    this.markDirty(player);
    this.rememberClassRuntime(player);
  }

  /** Merchant Rank 1: what a Maximize Tactics purchase would cost and fill. Throws when it cannot apply. */
  merchantMaximizeTacticsState(playerId: string, accountId: string, connectionId: string): { characterLevel: number; current: number; maximum: number } {
    const entity = this.requireEntity(playerId, "COMBAT_PLAYER_NOT_FOUND");
    this.requirePlayerAuthority(entity, accountId, connectionId);
    const runtime = entity.classRuntime;
    const skill = runtime?.skillV3;
    if (entity.kind !== "player" || !runtime || !skill || skill.activeSpecializationId !== "merchant" || skill.specializationRank < 1) {
      throw new CombatRequestError("ABILITY_NOT_AVAILABLE", "Maximize Tactics needs the Merchant class");
    }
    if ((skill.generalSkillRanks.tactics ?? 0) <= 0) {
      throw new CombatRequestError("ABILITY_NOT_AVAILABLE", "Maximize Tactics needs the Tactics skill");
    }
    const maximum = this.v3TacticsCap(runtime);
    const current = Math.max(0, Number(runtime.counters.skillV3TacticsValue ?? 0));
    if (current >= maximum) throw new CombatRequestError("TACTICS_ALREADY_MAXIMIZED", "Your Tactics is already at its maximum");
    return { characterLevel: entity.level, current, maximum };
  }

  /** Set stored Tactics to its maximum (after the Merchant has paid). */
  applyMerchantMaximizeTactics(playerId: string): void {
    const entity = this.entities.get(playerId);
    const runtime = entity?.classRuntime;
    if (!entity || !runtime?.skillV3) return;
    runtime.counters.skillV3TacticsValue = this.v3TacticsCap(runtime);
    runtime.counters.skillV3TacticsUpdatedAt = this.now();
    this.rememberClassRuntime(entity);
    this.markDirty(entity);
  }

  private updateV3Tactics(entity: Combatant, now: number): boolean {
    const runtime = entity.classRuntime;
    const rank = runtime?.skillV3?.generalSkillRanks.tactics ?? 0;
    if (entity.kind !== "player" || !runtime?.skillV3 || rank <= 0) return false;
    const aggressive = entity.aggressiveUntilMs > now;
    const previousAggressive = runtime.counters.skillV3TacticsAggressive === true;
    const anchor = Number(runtime.counters.skillV3TacticsUpdatedAt ?? now);
    if (runtime.counters.skillV3TacticsUpdatedAt === undefined || aggressive !== previousAggressive) {
      runtime.counters.skillV3TacticsUpdatedAt = now;
      runtime.counters.skillV3TacticsAggressive = aggressive;
      return true;
    }
    const intervalMs = aggressive ? 11_000 : 27_000;
    const intervals = Math.floor(Math.max(0, now - anchor) / intervalMs);
    if (intervals <= 0) return false;
    const current = Number(runtime.counters.skillV3TacticsValue ?? 0);
    const specializationTacticsCap = this.v3TacticsCap(runtime);
    let next: number;
    if (aggressive) {
      next = Math.max(0, current - intervals * 0.1);
    } else {
      const multiplier = this.voyagerIsolatedTacticsMultiplier(entity, runtime);
      let gain = intervals * tacticsGainForRank(rank);
      if (multiplier !== 1) {
        // Stored Tactics moves in 0.1 steps: carry the remainder of a 1.5x gain to the next interval.
        const boosted = gain * multiplier + Number(runtime.counters.skillV3TacticsGainCarry ?? 0);
        gain = Math.floor(boosted * 10 + 1e-9) / 10;
        runtime.counters.skillV3TacticsGainCarry = Math.round((boosted - gain) * 1000) / 1000;
      }
      next = Math.min(specializationTacticsCap, current + gain);
    }
    runtime.counters.skillV3TacticsValue = Math.round(next * 10) / 10;
    runtime.counters.skillV3TacticsUpdatedAt = anchor + intervals * intervalMs;
    return true;
  }

  private resolveV3KillEffects(
    attacker: Combatant,
    defeated: Combatant,
    sourceTechniqueId: string
  ): void {
    const runtime = attacker.classRuntime;
    const skill = runtime?.skillV3;
    if (!runtime || !skill) return;
    if (defeated.kind !== "mob") return;
    const now = this.now();
    const heroismRank = skill.generalSkillRanks.heroism ?? 0;
    if (heroismRank > 0 && this.isBossMob(defeated)) {
      const durationMs = heroismRank >= 3 ? 72_000_000 : heroismRank >= 2 ? 25_200_000 : 2_700_000;
      runtime.counters.skillV3HeroismEndsAt = now + durationMs;
    }
    const huntsmanRank = skill.generalSkillRanks.huntsmans_edge ?? 0;
    if (huntsmanRank > 0 && defeated.archetypeKey) {
      runtime.counters.skillV3HuntsmanSpecies = defeated.archetypeKey;
      runtime.counters.skillV3HuntsmanEndsAt = now + V3_HUNTSMAN_DURATION_MS;
    }
    const generatedKill = this.isV3GeneratedKill(sourceTechniqueId);
    const pursuitRank = skill.generalSkillRanks.pursuit ?? 0;
    if (!generatedKill && pursuitRank > 0 && this.isMeleeBasicAttacker(attacker)) {
      runtime.counters.skillV3PursuitEndsAt = now + V3_PURSUIT_DURATION_MS;
      this.addTimedEffect(
        attacker,
        attacker,
        "out_of_combat_movement",
        "v3_general_pursuit",
        V3_PURSUIT_DURATION_MS,
        ([0.4, 0.9, 1.4][Math.min(3, pursuitRank) - 1] ?? 1.4)
      );
      const next = this.nearbyEntityIds(attacker.position, 650)
        .map((id) => this.entities.get(id))
        .filter((candidate): candidate is Combatant => Boolean(
          candidate?.kind === "mob" && candidate.entityId !== defeated.entityId &&
          candidate.lifeState === "alive" && this.isAttackPairValid(attacker, candidate)
        ))
        .sort((left, right) =>
          distanceMeters(attacker.position, left.position) - distanceMeters(attacker.position, right.position) ||
          left.entityId.localeCompare(right.entityId)
        )[0];
      if (next) this.options.movePlayerToward?.(attacker.entityId, next.position);
    }
    if (!generatedKill) this.resolveV3SecondWind(attacker);
    if (
      (skill.generalSkillRanks.calm_mind ?? 0) >= 3 &&
      !this.nearbyEntityIds(attacker.position, 650).some((id) => {
        const candidate = this.entities.get(id);
        return Boolean(
          candidate && candidate.entityId !== defeated.entityId &&
          candidate.lifeState === "alive" && this.isAttackPairValid(attacker, candidate)
        );
      })
    ) {
      attacker.aggressiveUntilMs = Math.min(attacker.aggressiveUntilMs, now);
      this.markDirty(attacker);
    }
    this.resolveV3Deathburst(attacker, defeated, sourceTechniqueId);
  }

  private isV3GeneratedKill(sourceTechniqueId: string): boolean {
    return ["v3_general_cleave", "v3_general_ricochet", "v3_general_deathburst"].includes(sourceTechniqueId);
  }

  /** A mob killing blow by the player, or by their pet or minion, heals a random share of max HP. */
  private resolveV3SecondWind(player: Combatant): void {
    const runtime = player.classRuntime;
    const rank = runtime?.skillV3?.generalSkillRanks.second_wind ?? 0;
    if (!runtime || rank <= 0) return;
    const [minimumPercent, maximumPercent] = rank >= 3 ? [4, 13] : rank >= 2 ? [2, 8] : [1, 4];
    const roll = Math.max(0, Math.min(0.999999999, this.options.random?.() ?? Math.random()));
    const ratio = (minimumPercent + Math.floor(roll * (maximumPercent - minimumPercent + 1))) / 100;
    this.applyHealing(player, player, Math.max(1, Math.round(player.maxHealth * ratio)));
    this.rememberClassRuntime(player);
  }

  /** The owner whose Second Wind a pet or minion killing blow feeds. */
  private ownedUnitKillOwner(attacker: Combatant | null, defeated: Combatant): Combatant | null {
    if (attacker?.kind !== "mob" || defeated.kind !== "mob") return null;
    const ownerId = attacker.companionOwnerPlayerId ?? attacker.undead?.ownerPlayerId ?? null;
    const owner = ownerId === null ? undefined : this.entities.get(ownerId);
    return owner?.kind === "player" && owner.lifeState === "alive" && owner.classRuntime?.skillV3 ? owner : null;
  }

  /** Deathburst: a killing blow hits valid hostiles near the defeated target for a share of its max HP. */
  private resolveV3Deathburst(attacker: Combatant, defeated: Combatant, sourceTechniqueId: string): void {
    const rank = attacker.classRuntime?.skillV3?.generalSkillRanks.deathburst ?? 0;
    if (rank <= 0 || this.isV3GeneratedKill(sourceTechniqueId)) return;
    const ratio = rank >= 3 ? 0.09 : rank >= 2 ? 0.055 : 0.025;
    const burstDamage = Math.max(1, Math.round(defeated.maxHealth * ratio));
    if (defeated.kind !== "mob") return;
    for (const candidate of this.v3EligibleSecondaryTargets(attacker, defeated, 180, Number.MAX_SAFE_INTEGER)) {
      if (candidate.kind === "mob") {
        this.applyDamage(attacker, candidate, burstDamage, "v3_general_deathburst", false);
      }
    }
  }

  private resolveBloodRushTargetDefeat(defeated: Combatant): void {
    const now = this.now();
    for (const watcher of [...this.entities.values()].sort((left, right) => left.entityId.localeCompare(right.entityId))) {
      const runtime = watcher.kind === "player" ? watcher.classRuntime : null;
      if (!runtime || runtime.counters.v2BloodRushTarget !== defeated.entityId ||
        Number(runtime.counters.v2BloodRushEndsAt ?? 0) < now) continue;
      runtime.cooldownEndsAt.warrior_v2_faultline = Math.max(now,
        (runtime.cooldownEndsAt.warrior_v2_faultline ?? now) - 10_000);
      delete runtime.counters.v2BloodRushTarget;
      delete runtime.counters.v2BloodRushEndsAt;
      this.markDirty(watcher);
      this.rememberClassRuntime(watcher);
    }
  }

  private beginPlayerAction(player: Combatant): void {
    const session = this.pveSessions.get(player.entityId);
    if (session) session.playerActionSequence += 1;
    const actionRuntime = player.classRuntime;
    if (!actionRuntime) return;
    actionRuntime.counters.actionSequence = Number(actionRuntime.counters.actionSequence ?? 0) + 1;
    actionRuntime.counters.bloodlustHealingThisAction = 0;
    actionRuntime.counters.bloodlustRageThisAction = 0;
  }

  private breakNinjaInvisible(player: Combatant): void {
    const runtime = player.classRuntime;
    if (!runtime || Number(runtime.counters.ninjaInvisibleUntil ?? 0) <= this.now()) return;
    delete runtime.counters.ninjaInvisibleUntil;
    this.markDirty(player);
    this.rememberClassRuntime(player);
  }

  private basicOrResetMultiplier(attacker: Combatant, target: Combatant): number {
    const runtime = requireClassCombatRuntime(attacker);
    if (runtime.activeClassId === "hunter") {
      return this.hunterDirectMultiplier(attacker, target, true, true);
    }
    let multiplier = 1;
    if (runtime.activeClassId === "warrior") {
      if (runtime.counters.warriorEmpoweredHitArmed === true) {
        multiplier *= WARRIOR_BALANCE.empoweredHitMultiplier;
        runtime.counters.warriorEmpoweredHitArmed = false;
      }
      if (runtime.equippedPassives.has("warrior_relentless")) {
        const sameTarget = runtime.counters.relentlessTarget === target.entityId;
        const count = sameTarget ? Number(runtime.counters.relentlessCount ?? 0) + 1 : 1;
        runtime.counters.relentlessTarget = target.entityId;
        if (count >= 3) {
          multiplier *= 1.25;
          runtime.counters.relentlessCount = 0;
        } else runtime.counters.relentlessCount = count;
      }
    }
    if (runtime.activeClassId === "ranger" && runtime.equippedPassives.has("ranger_rapid_rhythm")) {
      const sameTarget = runtime.counters.rapidRhythmTarget === target.entityId;
      const count = sameTarget ? Number(runtime.counters.rapidRhythmCount ?? 0) + 1 : 1;
      runtime.counters.rapidRhythmTarget = target.entityId;
      if (count >= 3) {
        multiplier *= 1.25;
        runtime.counters.rapidRhythmCount = 0;
      } else runtime.counters.rapidRhythmCount = count;
    }
    return multiplier;
  }

  private hunterDirectMultiplier(
    attacker: Combatant,
    target: Combatant,
    basicOrReset: boolean,
    consumeMark: boolean
  ): number {
    const runtime = requireClassCombatRuntime(attacker);
    const session = this.pveSessions.get(attacker.entityId);
    const isFocus = session?.focusTargetEntityId === target.entityId;
    let multiplier = 1;
    if (basicOrReset) {
      const weaponryRank = automaticRank(runtime.masteryRank, [2, 7, 12, 17, 22]);
      multiplier *= 1 + weaponryRank * HUNTER_BALANCE.hunterWeaponryPerRank;
    }
    if (isFocus) {
      const quarryRank = automaticRank(runtime.masteryRank, [4, 9, 14, 19, 24]);
      multiplier *= 1 + quarryRank * HUNTER_BALANCE.quarrySensePerRank;
    }
    const mark = target.classRuntime?.effects.find((effect) =>
      effect.kind === "marked_quarry" && effect.sourceEntityId === attacker.entityId && effect.stacks > 0
    );
    if (mark) {
      multiplier *= HUNTER_BALANCE.markedQuarryDamageMultiplier;
      if (consumeMark) {
        mark.stacks -= 1;
        if (mark.stacks <= 0 && target.classRuntime) {
          target.classRuntime.effects = target.classRuntime.effects.filter((effect) => effect !== mark);
        }
        runtime.counters.markedQuarryChargesConsumed = Number(runtime.counters.markedQuarryChargesConsumed ?? 0) + 1;
        this.pveSessions.get(attacker.entityId)?.telemetry.recordClassMetric("marked_quarry_charges_consumed");
      }
    }
    const queueSize = this.validOwnedEnemyCount(attacker.entityId);
    if (runtime.equippedPassives.has("hunter_lone_hunter") && queueSize === 1) {
      multiplier *= HUNTER_BALANCE.loneHunterDamageMultiplier;
    }
    if (runtime.equippedPassives.has("hunter_pack_hunter") && queueSize > 1) {
      multiplier *= 1 + Math.min(
        HUNTER_BALANCE.packHunterMaximum,
        (queueSize - 1) * HUNTER_BALANCE.packHunterPerAdditionalEnemy
      );
    }
    if (basicOrReset && runtime.equippedPassives.has("hunter_patient_hunter")) {
      const sameTarget = runtime.counters.patientHunterTarget === target.entityId;
      const count = sameTarget ? Number(runtime.counters.patientHunterCount ?? 0) + 1 : 1;
      runtime.counters.patientHunterTarget = target.entityId;
      if (count >= HUNTER_BALANCE.patientHunterActionCount) {
        multiplier *= HUNTER_BALANCE.patientHunterDamageMultiplier;
        runtime.counters.patientHunterCount = 0;
      } else runtime.counters.patientHunterCount = count;
    }
    if (
      runtime.equippedPassives.has("hunter_killer_instinct") &&
      target.currentHealth / target.maxHealth < HUNTER_BALANCE.killerInstinctThreshold
    ) multiplier *= HUNTER_BALANCE.killerInstinctDamageMultiplier;
    if (runtime.subclassId === "sharpshooter" && runtime.weaponMode === "ranged" && basicOrReset) {
      multiplier *= 1 + Math.min(
        HUNTER_BALANCE.steadyHandMaximumStacks,
        Number(runtime.counters.steadyHandStacks ?? 0)
      ) * HUNTER_BALANCE.steadyHandPerStack;
    }
    if (runtime.subclassId === "stalker" && this.hasQueueBleed(target)) {
      multiplier *= HUNTER_BALANCE.bloodScentDamageMultiplier;
    }
    return multiplier;
  }

  private advanceSteadyHand(attacker: Combatant, target: Combatant): void {
    const runtime = attacker.classRuntime;
    if (!runtime || runtime.subclassId !== "sharpshooter" || runtime.weaponMode !== "ranged") return;
    const sameTarget = runtime.counters.steadyHandTarget === target.entityId;
    runtime.counters.steadyHandTarget = target.entityId;
    runtime.counters.steadyHandStacks = Math.min(
      HUNTER_BALANCE.steadyHandMaximumStacks,
      sameTarget ? Number(runtime.counters.steadyHandStacks ?? 0) + 1 : 1
    );
    runtime.counters.maximumSteadyHandStacks = Math.max(
      Number(runtime.counters.maximumSteadyHandStacks ?? 0),
      Number(runtime.counters.steadyHandStacks)
    );
    this.pveSessions.get(attacker.entityId)?.telemetry.recordClassMetricMaximum(
      "maximum_steady_hand_stacks", Number(runtime.counters.steadyHandStacks)
    );
  }

  private resetFocusBoundClassState(player: Combatant): void {
    const runtime = player.classRuntime;
    if (!runtime) return;
    if (runtime.activeClassId === "hunter") {
      runtime.counters.patientHunterTarget = "";
      runtime.counters.patientHunterCount = 0;
      runtime.counters.steadyHandTarget = "";
      runtime.counters.steadyHandStacks = 0;
    }
    this.rememberClassRuntime(player);
  }

  private validOwnedEnemyCount(playerId: string): number {
    const session = this.pveSessions.get(playerId);
    if (!session) return 0;
    return session.enemyQueue.reduce(
      (count, enemyId) => count + (this.isEnemyValidForSession(session, enemyId) ? 1 : 0),
      0
    );
  }

  private fortifyApplies(playerId: string, enemyId: string): boolean {
    void playerId;
    void enemyId;
    return false;
  }

  private consumeFortifyOpportunity(
    session: PveCombatSession,
    enemyId: string,
    directAttack: boolean
  ): void {
    const fortify = session.fortify;
    if (!fortify || !fortify.remainingEnemyIds.delete(enemyId)) return;
    if (directAttack) fortify.remainingProtectedHits -= 1;
    if (fortify.remainingEnemyIds.size === 0 || fortify.remainingProtectedHits <= 0) {
      session.fortify = null;
    }
  }

  private applyQueueBleed(attacker: Combatant, target: Combatant, sourceTechniqueId: string): void {
    if (this.hasV3CleanseImmunity(target)) return;
    const runtime = target.classRuntime ?? (target.classRuntime = emptyRuntime());
    const id = `${attacker.entityId}:${sourceTechniqueId}:queue_bleed`;
    const existing = runtime.effects.find((effect) => effect.id === id);
    if (existing) {
      existing.stacks = WARRIOR_BALANCE.bleedBaseTicks;
      existing.amount = WARRIOR_BALANCE.bleedDamagePerTick;
    } else {
      runtime.effects.push({
        id,
        kind: "queue_bleed",
        sourceTechniqueId,
        sourceEntityId: attacker.entityId,
        startTick: this.currentTick,
        endTick: Number.MAX_SAFE_INTEGER,
        nextTick: Number.MAX_SAFE_INTEGER,
        stacks: WARRIOR_BALANCE.bleedBaseTicks,
        maximumStacks: WARRIOR_BALANCE.bleedBaseTicks,
        amount: WARRIOR_BALANCE.bleedDamagePerTick,
        cleansable: true,
        minor: false
      });
    }
    this.markDirty(target);
  }

  private applyHunterBleed(
    attacker: Combatant,
    target: Combatant,
    sourceTechniqueId: string,
    appliedDirectDamage: number,
    directDamageBeforePowerScaling: number
  ): void {
    if (this.hasV3CleanseImmunity(target)) return;
    const runtime = target.classRuntime ?? (target.classRuntime = emptyRuntime());
    const id = `${attacker.entityId}:${sourceTechniqueId}:queue_bleed`;
    const damageBasis = attacker.kind === "player" && target.kind === "player"
      ? directDamageBeforePowerScaling
      : appliedDirectDamage;
    const amount = Math.max(1, Math.round(
      damageBasis * HUNTER_BALANCE.rendingBleedDirectDamageMultiplier
    ));
    const existing = runtime.effects.find((effect) => effect.id === id);
    if (existing) {
      existing.stacks = HUNTER_BALANCE.rendingBleedTicks;
      existing.amount = amount;
    } else {
      runtime.effects.push({
        id,
        kind: "queue_bleed",
        sourceTechniqueId,
        sourceEntityId: attacker.entityId,
        startTick: this.currentTick,
        endTick: Number.MAX_SAFE_INTEGER,
        nextTick: Number.MAX_SAFE_INTEGER,
        stacks: HUNTER_BALANCE.rendingBleedTicks,
        maximumStacks: HUNTER_BALANCE.rendingBleedTicks,
        amount,
        cleansable: true,
        minor: false
      });
    }
    attacker.classRuntime!.counters.stalkerBleedApplications =
      Number(attacker.classRuntime!.counters.stalkerBleedApplications ?? 0) + 1;
    this.markDirty(target);
  }

  private applyMarkedQuarry(attacker: Combatant, target: Combatant): void {
    if (this.hasV3CleanseImmunity(target)) return;
    const runtime = target.classRuntime ?? (target.classRuntime = emptyRuntime());
    const id = `${attacker.entityId}:hunter_marked_strike:marked_quarry`;
    const existing = runtime.effects.find((effect) => effect.id === id);
    if (existing) existing.stacks = HUNTER_BALANCE.markedQuarryCharges;
    else runtime.effects.push({
      id,
      kind: "marked_quarry",
      sourceTechniqueId: "hunter_marked_strike",
      sourceEntityId: attacker.entityId,
      startTick: this.currentTick,
      endTick: Number.MAX_SAFE_INTEGER,
      nextTick: Number.MAX_SAFE_INTEGER,
      stacks: HUNTER_BALANCE.markedQuarryCharges,
      maximumStacks: HUNTER_BALANCE.markedQuarryCharges,
      amount: HUNTER_BALANCE.markedQuarryDamageMultiplier - 1
    });
    attacker.classRuntime!.counters.markedQuarryApplications =
      Number(attacker.classRuntime!.counters.markedQuarryApplications ?? 0) + 1;
    this.pveSessions.get(attacker.entityId)?.telemetry.recordClassMetric("marked_quarry_applications");
    this.markDirty(target);
  }

  private applyHunterSnare(attacker: Combatant, target: Combatant): void {
    if (this.hasV3CleanseImmunity(target)) return;
    const runtime = target.classRuntime ?? (target.classRuntime = emptyRuntime());
    const id = `${attacker.entityId}:hunter_snare_trap:hunter_snare`;
    const existing = runtime.effects.find((effect) => effect.id === id);
    if (existing) {
      existing.stacks = HUNTER_BALANCE.snareCharges;
      existing.cleansable = true;
      existing.minor = true;
    }
    else runtime.effects.push({
      id,
      kind: "hunter_snare",
      sourceTechniqueId: "hunter_snare_trap",
      sourceEntityId: attacker.entityId,
      startTick: this.currentTick,
      endTick: Number.MAX_SAFE_INTEGER,
      nextTick: Number.MAX_SAFE_INTEGER,
      stacks: HUNTER_BALANCE.snareCharges,
      maximumStacks: HUNTER_BALANCE.snareCharges,
      amount: 1 - HUNTER_BALANCE.snareDamageMultiplier,
      cleansable: true,
      minor: true
    });
    attacker.classRuntime!.counters.snareApplications =
      Number(attacker.classRuntime!.counters.snareApplications ?? 0) + 1;
    this.pveSessions.get(attacker.entityId)?.telemetry.recordClassMetric("snare_applications");
    this.markDirty(target);
  }

  private hunterSnareEffect(target: Combatant): CombatEffect | null {
    return target.classRuntime?.effects.find((effect) => effect.kind === "hunter_snare" && effect.stacks > 0) ?? null;
  }

  private consumeHunterSnareOpportunity(target: Combatant): void {
    const snare = this.hunterSnareEffect(target);
    if (!snare || !target.classRuntime) return;
    snare.stacks -= 1;
    const source = this.entities.get(snare.sourceEntityId);
    if (source?.classRuntime) {
      source.classRuntime.counters.snaredEnemyActions =
        Number(source.classRuntime.counters.snaredEnemyActions ?? 0) + 1;
      this.pveSessions.get(source.entityId)?.telemetry.recordClassMetric("snared_enemy_actions");
      this.rememberClassRuntime(source);
    }
    if (snare.stacks <= 0) target.classRuntime.effects = target.classRuntime.effects.filter((effect) => effect !== snare);
    this.markDirty(target);
  }

  private hasQueueBleed(target: Combatant): boolean {
    return target.classRuntime?.effects.some((effect) => effect.kind === "queue_bleed" && effect.stacks > 0) ?? false;
  }

  private resolveQueueBleedTurn(target: Combatant): boolean {
    const runtime = target.classRuntime;
    const bleed = runtime?.effects.find((effect) => effect.kind === "queue_bleed" && effect.stacks > 0);
    if (!runtime || !bleed) return false;
    const source = this.entities.get(bleed.sourceEntityId);
    if (source?.lifeState === "alive") {
      const damage = this.resolvePeriodicDamage(
        source,
        target,
        bleed.amount,
        bleed.sourceTechniqueId
      );
      if (bleed.sourceTechniqueId === "stalker_rending_strike") {
        this.pveSessions.get(source.entityId)?.telemetry.recordClassMetric("stalker_bleed_damage", damage);
      }
    }
    bleed.stacks -= 1;
    if (bleed.stacks <= 0) runtime.effects = runtime.effects.filter((effect) => effect !== bleed);
    if (target.lifeState === "alive") this.markDirty(target);
    return target.lifeState !== "alive";
  }

  private applyPlayerActionDefenseReduction(
    attacker: Combatant,
    target: Combatant,
    sourceTechniqueId: string
  ): void {
    if (this.hasV3CleanseImmunity(target)) return;
    const runtime = target.classRuntime ?? (target.classRuntime = emptyRuntime());
    const id = "warrior_sundering_strike:player_action_defense_reduction";
    const existing = runtime.effects.find((effect) => effect.id === id);
    if (existing) {
      existing.stacks = WARRIOR_BALANCE.sunderingStrikePlayerActions;
      existing.amount = WARRIOR_BALANCE.sunderingStrikeDefenseReduction;
    } else {
      runtime.effects.push({
        id,
        kind: "player_action_defense_reduction",
        sourceTechniqueId,
        sourceEntityId: attacker.entityId,
        startTick: this.currentTick,
        endTick: Number.MAX_SAFE_INTEGER,
        nextTick: Number.MAX_SAFE_INTEGER,
        stacks: WARRIOR_BALANCE.sunderingStrikePlayerActions,
        maximumStacks: WARRIOR_BALANCE.sunderingStrikePlayerActions,
        amount: WARRIOR_BALANCE.sunderingStrikeDefenseReduction
      });
    }
    this.markDirty(target);
  }

  private consumePlayerActionDefenseReduction(target: Combatant): void {
    const runtime = target.classRuntime;
    if (!runtime) return;
    for (const effect of runtime.effects) {
      if (effect.kind === "player_action_defense_reduction" && effect.stacks > 0) effect.stacks -= 1;
    }
    runtime.effects = runtime.effects.filter(
      (effect) =>
        effect.kind !== "player_action_defense_reduction" || effect.stacks > 0
    );
  }

  private effectiveDefenseStages(target: Combatant, excludeEquipmentDefense = false): {
    armor: number;
    ironhide: number;
    lastStand: number;
  } {
    const flatReduction = this.effectTotal(target, "defense_reduction");
    const runtime = target.classRuntime;
    const proportionalReductions = runtime?.effects
      .filter((effect) =>
        effect.kind === "player_action_defense_reduction" && effect.stacks > 0
      )
      .map((effect) => effect.amount) ?? [];
    const proportionalReduction = Math.max(
      0,
      Math.min(0.9, proportionalReductions.length > 0 ? Math.max(...proportionalReductions) : 0)
    );
    const equipmentDefense = excludeEquipmentDefense
      ? target.equipmentCombatState?.stats.universalDefense ?? 0
      : 0;
    const armor = Math.max(
      0,
      target.defense - equipmentDefense + this.warriorFlatDefenseBonus(target) - flatReduction
    ) * (1 - proportionalReduction);
    const ironhide = armor;
    const lastStand = ironhide;
    return { armor, ironhide, lastStand };
  }

  private effectiveDefense(target: Combatant): number {
    return this.effectiveDefenseStages(target).lastStand;
  }

  private commitNormalHealing(
    sourceEntityId: string | null,
    target: Combatant,
    requested: number,
    witheredFraction = 0
  ): { effective: number; blocked: boolean } {
    if (this.isPlayerReserved(target.entityId)) {
      this.deferredReplenishEffects.push(() => { this.commitNormalHealing(sourceEntityId, target, requested, witheredFraction); });
      return { effective: 0, blocked: false };
    }
    const withered = this.hasEffect(target, "gloom");
    const amount = Math.max(0, Math.round(withered && witheredFraction > 0 ? requested * witheredFraction : requested));
    // Revenant Metal undead never heal from any source.
    if (amount <= 0 || target.lifeState !== "alive" || target.undead) {
      return { effective: 0, blocked: false };
    }
    if (withered && witheredFraction <= 0) {
      this.emitHealingBlocked(sourceEntityId, target.entityId, "gloom", target.currentHealth);
      return { effective: 0, blocked: true };
    }
    // Verdant Surge: each heal a player receives from a source (not an ambient tick) gains a flat bonus.
    const bonus = sourceEntityId !== null && target.kind === "player" ? target.kingdomPerkEffects?.healingBonus ?? 0 : 0;
    const effective = Math.min(target.maxHealth - target.currentHealth, amount + bonus);
    if (effective <= 0) return { effective: 0, blocked: false };
    target.currentHealth += effective;
    this.markDirty(target);
    this.rememberProfile(target);
    this.emitEvent("HEAL", sourceEntityId, target.entityId, effective, target.currentHealth);
    return { effective, blocked: false };
  }

  private applyHealing(
    source: Combatant,
    target: Combatant,
    requested: number
  ): { effective: number; overheal: number } {
    if (this.isPlayerReserved(source.entityId) || this.isPlayerReserved(target.entityId)) {
      this.deferredReplenishEffects.push(() => { this.applyHealing(source, target, requested); });
      return { effective: 0, overheal: Math.max(0, Math.round(requested)) };
    }
    if (
      source.kind !== "player" || target.kind !== "player" ||
      source.lifeState !== "alive" || target.lifeState !== "alive" ||
      (source.entityId !== target.entityId && !this.isValidVisibleAlly(source, target))
    ) return { effective: 0, overheal: Math.max(0, Math.round(requested)) };
    const amount = Math.max(0, Math.round(requested));
    const committed = this.commitNormalHealing(source.entityId, target, amount);
    const effective = committed.effective;
    const overheal = Math.max(0, amount - effective);
    if (committed.blocked || effective <= 0) return { effective: 0, overheal };
    this.markSessionParticipation(source.entityId);
    this.recordSupportContribution(source, effective);
    return { effective, overheal };
  }

  private playerActionSequence(player: Combatant): number {
    return Number(player.classRuntime?.counters.actionSequence ?? 0);
  }

  private addEffect(
    target: Combatant,
    kind: CombatEffectKind,
    sourceTechniqueId: string,
    sourceEntityId: string,
    durationTicks: number,
    amount: number,
    maximumStacks = 1
  ): void {
    const runtime = target.classRuntime ?? (target.classRuntime = emptyRuntime());
    if (kind === "movement_slow" && target.classRuntime) {
      const controlMultiplier = target.classRuntime.activeClassId === "hunter"
        ? 1 - automaticRank(target.classRuntime.masteryRank, [5, 10, 15, 20, 25]) *
          HUNTER_BALANCE.trailblazerSlowReductionPerRank
        : target.classRuntime.masteryRank >= 16 ? WARRIOR_BALANCE.unshakenMultiplier : 1;
      durationTicks = Math.max(1, Math.round(durationTicks * controlMultiplier));
      durationTicks = Math.max(
        1,
        Math.round(
          durationTicks *
          (target.equipmentCombatState?.stats.crowdControlDurationMultiplier ?? 1)
        )
      );
      amount *= controlMultiplier;
    }
    const durationServerTicks = durationTicks * this.attackIntervalTicks;
    const id = `${sourceEntityId}:${sourceTechniqueId}:${kind}`;
    const existing = runtime.effects.find((effect) => effect.id === id);
    if (existing) {
      existing.stacks = Math.min(existing.maximumStacks, existing.stacks + 1);
      existing.endTick = this.currentTick + durationServerTicks;
      existing.nextTick = Math.min(existing.nextTick, this.currentTick + this.attackIntervalTicks);
      existing.cleansable = true;
      existing.minor = kind === "movement_slow";
      if (kind === "movement_slow") {
        existing.controlTag = "movement_impairing_cc";
      } else {
        delete existing.controlTag;
      }
    } else {
      runtime.effects.push({
        id,
        kind,
        sourceTechniqueId,
        sourceEntityId,
        startTick: this.currentTick,
        endTick: this.currentTick + durationServerTicks,
        nextTick: this.currentTick + this.attackIntervalTicks,
        stacks: 1,
        maximumStacks,
        amount,
        cleansable: true,
        minor: kind === "movement_slow",
        ...(kind === "movement_slow"
          ? { controlTag: "movement_impairing_cc" as const }
          : {})
      });
    }
    this.markDirty(target);
    if (target.kind === "player") this.rememberClassRuntime(target);
  }

  private hasEffect(entity: Combatant, kind: CombatEffectKind): boolean {
    return entity.classRuntime?.effects.some((effect) => effect.kind === kind && effect.endTick >= this.currentTick) ?? false;
  }

  private effectTotal(entity: Combatant, kind: CombatEffectKind): number {
    return entity.classRuntime?.effects
      .filter((effect) => effect.kind === kind && effect.endTick >= this.currentTick)
      .reduce((total, effect) => total + effect.amount * effect.stacks, 0) ?? 0;
  }

  private nearbyHostiles(attacker: Combatant, radiusM: number, maximum: number): Combatant[] {
    return this.grid.query(attacker.position, radiusM)
      .map((id) => this.entities.get(id))
      .filter((candidate): candidate is Combatant => Boolean(
        candidate && candidate.entityId !== attacker.entityId && this.isAttackPairValid(attacker, candidate)
      ))
      .sort((left, right) => left.entityId.localeCompare(right.entityId))
      .slice(0, maximum);
  }

  private partyMemberIds(playerId: string): readonly string[] {
    return this.options.partyAuthority?.partyForPlayer(playerId)?.memberPlayerIds ?? [playerId];
  }

  private ninjaTunicEligible(entity: Combatant): boolean {
    if (entity.kind !== "player" || equipmentGameplayFamily(entity.classRuntime?.chestDefinitionId ?? null) !== "tunic") {
      return false;
    }
    const v3 = entity.classRuntime?.skillV3;
    return v3
      ? v3.activeSpecializationId === "ninja" && v3.specializationRank >= 5
      : entity.classRuntime?.activeClassId === "ninja";
  }

  private isNinjaInvisible(entity: Combatant, now = this.now()): boolean {
    const counters = entity.classRuntime?.counters;
    return (this.ninjaTunicEligible(entity) || Number(counters?.petShadowHideUntil ?? 0) > now) &&
      Number(counters?.ninjaInvisibleUntil ?? 0) > now;
  }

  private emitInnateEvent(
    sourceEntityId: string,
    targetEntityId: string,
    innateFeedback: Exclude<NonNullable<CombatEvent["innateFeedback"]>, "FOCUS">,
    innateId: string
  ): void {
    this.metrics.combatEventsEmitted += 1;
    this.pendingEvents.push({
      eventId: `${this.currentTick}:${++this.eventSequence}`,
      type: "CLASS_INNATE_TRIGGERED",
      tick: this.currentTick,
      sourceEntityId,
      targetEntityId,
      innateFeedback,
      innateId
    });
  }

  private participatingPartyMemberIds(source: Combatant, rangeM: number): readonly string[] {
    return this.partyMemberIds(source.entityId).filter((memberId) => {
      if (memberId === source.entityId) return true;
      const member = this.entities.get(memberId);
      return Boolean(member && this.isValidParticipatingAlly(source, member, rangeM));
    });
  }

  private purgeIncompatibleSourceEffects(
    sourcePlayerId: string,
    nextClassId: ClassId,
    nextSubclassId: SubclassId | null
  ): void {
    for (const entity of this.entities.values()) {
      const runtime = entity.classRuntime;
      if (!runtime) continue;
      const retained = runtime.effects.filter((effect) =>
        effect.sourceEntityId !== sourcePlayerId ||
        this.effectCompatibleWithSourceClass(effect, nextClassId, nextSubclassId)
      );
      if (retained.length === runtime.effects.length) continue;
      runtime.effects = retained;
      this.markDirty(entity);
      if (entity.kind === "player") this.rememberClassRuntime(entity);
    }
  }

  private effectCompatibleWithSourceClass(
    effect: CombatEffect,
    nextClassId: ClassId,
    nextSubclassId: SubclassId | null
  ): boolean {
    let requiredClassId = effect.sourceClassId;
    let requiredSubclassId = effect.sourceSubclassId ?? null;
    if (!requiredClassId) {
      try {
        const definition = requireTechniqueDefinition(effect.sourceTechniqueId);
        requiredClassId = definition.classId;
        requiredSubclassId = definition.subclassId;
      } catch {
        return true;
      }
    }
    return requiredClassId === nextClassId &&
      (requiredSubclassId === null || requiredSubclassId === nextSubclassId);
  }

  private sharesParticipatingEncounter(leftPlayerId: string, rightPlayerId: string): boolean {
    if (leftPlayerId === rightPlayerId) return true;
    const left = this.pveSessions.get(leftPlayerId);
    const right = this.pveSessions.get(rightPlayerId);
    if (!left || !right) return false;
    for (const enemyId of left.enemyIds) {
      if (
        right.enemyIds.has(enemyId) &&
        this.isEnemyValidForSession(left, enemyId) &&
        this.isEnemyValidForSession(right, enemyId)
      ) return true;
    }
    return false;
  }

  private isValidParticipatingAlly(source: Combatant, target: Combatant, rangeM: number): boolean {
    return this.isValidNearbyVisibleAlly(source, target, rangeM) &&
      this.sharesParticipatingEncounter(source.entityId, target.entityId);
  }

  private isValidVisibleAlly(source: Combatant, target: Combatant): boolean {
    if (source.kind !== "player" || target.kind !== "player" || target.lifeState !== "alive") return false;
    if (source.entityId === target.entityId) return true;
    if (!this.options.partyAuthority?.sameParty(source.entityId, target.entityId)) return false;
    if (!this.hasActiveAuthority(target)) return false;
    if (!this.isInsideAuthoritativeView(source, target)) return false;
    if (
      this.options.isPvpSupportRestricted?.(source.entityId) === true &&
      this.isEngagedInPvp(target)
    ) {
      return false;
    }
    return true;
  }

  // A player is fighting players when targeting one or targeted by one nearby.
  // Only evaluated for shielded supporters, so the grid scan stays rare.
  private isEngagedInPvp(player: Combatant): boolean {
    if (player.targetEntityId && this.entities.get(player.targetEntityId)?.kind === "player") return true;
    return this.grid.query(player.position, PVP_SUPPORT_ENGAGEMENT_RADIUS_M).some((entityId) => {
      const entity = this.entities.get(entityId);
      return entity?.kind === "player" && entity.entityId !== player.entityId &&
        entity.targetEntityId === player.entityId;
    });
  }

  private isValidNearbyVisibleAlly(source: Combatant, target: Combatant, rangeM: number): boolean {
    return this.isValidVisibleAlly(source, target)
      && distanceMeters(source.position, target.position) <= rangeM;
  }

  private validVisibleAllies(source: Combatant, rangeM: number, maximum = Number.POSITIVE_INFINITY): Combatant[] {
    return this.partyMemberIds(source.entityId)
      .map((playerId) => this.entities.get(playerId))
      .filter((candidate): candidate is Combatant => Boolean(
        candidate && candidate.entityId !== source.entityId &&
        this.isValidNearbyVisibleAlly(source, candidate, rangeM)
      ))
      .sort((left, right) => {
        const health = left.currentHealth / left.maxHealth - right.currentHealth / right.maxHealth;
        return health === 0 ? left.entityId.localeCompare(right.entityId) : health;
      })
      .slice(0, maximum);
  }

  private damageQualifiesForRage(attacker: Combatant, target: Combatant): boolean {
    if (target.classRuntime?.activeClassId !== "warrior") return attacker.kind === "mob" || attacker.kind === "player";
    return attacker.kind === "player" || attacker.level >= Math.max(1, target.level - WARRIOR_BALANCE.rage.weakEnemyLevelGap);
  }

  private addRage(
    entity: Combatant,
    amount: number,
    source: string = "warrior"
  ): void {
    const runtime = entity.classRuntime;
    if (!runtime || amount <= 0) return;
    if (runtime.resourceId === "none") return;
    let modifier =
      (1 + this.effectTotal(entity, "rage_generation"))
      * (entity.equipmentCombatState?.stats.resourceGenerationMultiplier ?? 1);
    if (runtime.activeClassId === "warrior") {
      const mastery = warriorEffects(runtime.masteryRank);
      modifier *= 1 + mastery.normalRageGenerationBonus;
      if (entity.currentHealth / entity.maxHealth < 0.35) {
        modifier *= 1 + mastery.lowHealthRageGenerationBonus;
      }
    }
    if (
      runtime.activeClassId === "warrior" &&
      runtime.equippedPassives.has("warrior_last_stand") &&
      entity.currentHealth / entity.maxHealth < WARRIOR_BALANCE.lastStandHealthThreshold
    ) {
      modifier *= WARRIOR_BALANCE.lastStandRageMultiplier;
    }
    if (
      runtime.activeClassId === "hunter" &&
      runtime.equippedPassives.has("hunter_killer_instinct") &&
      source !== "regeneration"
    ) {
      const session = this.pveSessions.get(entity.entityId);
      const focus = session?.focusTargetEntityId ? this.entities.get(session.focusTargetEntityId) : null;
      if (focus && focus.currentHealth / focus.maxHealth < HUNTER_BALANCE.killerInstinctThreshold) {
        modifier *= HUNTER_BALANCE.killerInstinctResourceMultiplier;
      }
    }
    const usesAccumulator = runtime.activeClassId !== "warrior";
    const accumulatorKey = `${runtime.resourceId}GenerationAccumulator`;
    const accumulated = usesAccumulator
      ? Number(runtime.counters[accumulatorKey] ?? 0) + amount * modifier
      : amount * modifier;
    const generated = usesAccumulator ? Math.floor(accumulated) : Math.round(accumulated);
    if (usesAccumulator) runtime.counters[accumulatorKey] = accumulated - generated;
    if (generated <= 0) return;
    const previousRage = runtime.rage;
    runtime.rage = clampRage(
      runtime.rage + generated,
      this.classResourceMaximum(entity)
    );
    const telemetry = this.pveSessions.get(entity.entityId)?.telemetry;
    telemetry?.recordResource({
      generated,
      wastedAtCap: Math.max(0, generated - (runtime.rage - previousRage))
    });
    if (runtime.activeClassId === "hunter") {
      runtime.counters.focusGenerated = Number(runtime.counters.focusGenerated ?? 0) + generated;
      const metricKey = `focus_${source}`;
      runtime.counters[metricKey] = Number(runtime.counters[metricKey] ?? 0) + generated;
      const telemetryMetric = ({
        regeneration: "focus_regenerated",
        attack: "focus_gained_from_attacks",
        kill: "focus_gained_from_kills",
        predator: "predator_bonus_focus",
        cull: "cull_refund_focus",
        blood_scent: "blood_scent_focus_gained"
      } as Record<string, string>)[source];
      if (telemetryMetric) telemetry?.recordClassMetric(telemetryMetric, generated);
    }
    this.markDirty(entity);
    this.rememberClassRuntime(entity);
  }

  private addGuard(entity: Combatant, amount: number): void {
    const runtime = entity.classRuntime;
    if (!runtime || runtime.subclassId !== "warden") return;
    runtime.guard = Math.min(WARRIOR_BALANCE.guardMaximum, runtime.guard + amount);
    this.markDirty(entity);
    this.rememberClassRuntime(entity);
  }

  private rageCost(_runtime: ClassCombatRuntime, definition: TechniqueDefinition): number {
    return Math.max(0, definition.resourceCost);
  }

  private validateAbilityEquipment(
    player: Combatant,
    runtime: ClassCombatRuntime,
    definition: TechniqueDefinition
  ): void {
    const equipmentState = player.equipmentCombatState;
    if (runtime.activeClassId === "hunter") {
      if (!runtime.weaponMode) {
        throw new CombatRequestError("CLASS_WEAPON_REQUIRED", "Hunter requires a compatible weapon");
      }
      if (runtime.armorCategory === "heavy") {
        throw new CombatRequestError("CLASS_ARMOR_INCOMPATIBLE", "Hunter cannot fight in heavy armor");
      }
      if (
        definition.subclassId === "sharpshooter" &&
        !equipmentState?.weaponSlots.secondary.instanceId
      ) {
        throw new CombatRequestError("SUBCLASS_WEAPON_REQUIRED", "Sharpshooter requires a ranged weapon");
      }
      if (
        definition.subclassId === "stalker" &&
        !equipmentState?.weaponSlots.melee.instanceId
      ) {
        throw new CombatRequestError("SUBCLASS_WEAPON_REQUIRED", "Stalker requires a melee weapon");
      }
    }
    const equipment = (definition as TechniqueDefinition & {
      equipment?: { shield?: boolean; weapon?: WeaponCategory[]; armor?: ArmorCategory };
    }).equipment;
    if (equipment?.shield && !runtime.hasShield) {
      throw new CombatRequestError("ABILITY_EQUIPMENT_REQUIRED", "A shield is required");
    }
    if (equipment?.weapon && !equipment.weapon.includes(runtime.weaponCategory ?? "sword")) {
      throw new CombatRequestError("ABILITY_EQUIPMENT_REQUIRED", "The equipped weapon does not meet this ability requirement");
    }
    if (definition.allowedWeaponCategories?.length &&
      (!runtime.weaponCategory || !definition.allowedWeaponCategories.includes(runtime.weaponCategory))) {
      throw new CombatRequestError("ABILITY_EQUIPMENT_REQUIRED", "The active weapon category is not allowed for this ability");
    }
    if (
      definition.weaponRequirement === "melee" &&
      !equipmentState?.weaponSlots.melee.instanceId
    ) {
      throw new CombatRequestError(
        "ABILITY_EQUIPMENT_REQUIRED",
        "A melee weapon is required"
      );
    }
    if (
      definition.weaponRequirement === "ranged" &&
      !equipmentState?.weaponSlots.secondary.instanceId
    ) {
      throw new CombatRequestError(
        "ABILITY_EQUIPMENT_REQUIRED",
        "A ranged weapon is required"
      );
    }
    if (definition.weaponRequirement === "shield" && !runtime.hasShield) {
      throw new CombatRequestError(
        "ABILITY_EQUIPMENT_REQUIRED",
        "A shield is required"
      );
    }
  }

  private refundQueue(runtime: ClassCombatRuntime): void {
    if (!runtime.queuedAbility) return;
    if (runtime.queuedAbility.activationCommitted === true) return;
    runtime.rage = clampRage(runtime.rage + runtime.queuedAbility.reservedRage);
    runtime.reservedRage = 0;
    runtime.queuedAbility = null;
  }

  private warriorInnateDamageTier(healthRatio: number): number {
    const [one, two, three] = WARRIOR_INNATE_BALANCE.damageTierHealthThresholds;
    return healthRatio < three ? 3 : healthRatio < two ? 2 : healthRatio < one ? 1 : 0;
  }

  private classCombatState(entity: Combatant): ClassCombatState {
    const runtime = requireClassCombatRuntime(entity);
    const session = this.pveSessions.get(entity.entityId);
    const pendingAbilityId = session?.pendingNormal?.kind === "ability"
      ? session.pendingNormal.abilityId
      : session?.pendingResetAbilityId ?? null;
    const now = this.now();
    const innate: ClassCombatState["innate"] = runtime.skillV3
      ? undefined
      : runtime.activeClassId === "warrior"
      ? { id: "warrior_unrelenting_rage", maxHealthBonus: Math.min(WARRIOR_INNATE_BALANCE.maxHealthMaximum, entity.level * WARRIOR_INNATE_BALANCE.maxHealthPerLevel),
          damageBonus: this.warriorInnateDamageTier(entity.currentHealth / entity.maxHealth) }
      : runtime.activeClassId === "ninja"
            ? { id: "ninja_way_of_the_ninja", armorActive: this.ninjaTunicEligible(entity), dodgeChance: this.ninjaTunicEligible(entity) ? Math.min(entity.level * NINJA_INNATE_BALANCE.dodgePerLevel, NINJA_INNATE_BALANCE.dodgeMaximum) : 0,
                cooldownEndsAt: (runtime.cooldownEndsAt[NINJA_INVISIBLE_KEY] ?? 0) > now ? runtime.cooldownEndsAt[NINJA_INVISIBLE_KEY]! : null,
                invisibleEndsAt: this.isNinjaInvisible(entity) ? Number(runtime.counters.ninjaInvisibleUntil) : null }
            : undefined;
    return {
      activeClassId: runtime.activeClassId,
      activeSubclassId: runtime.subclassId,
      ...(innate ? { innate } : {}),
      ...(runtime.activeClassId !== "hunter" ? {} : { resource: {
        resourceId: "focus" as const,
        displayName: "Focus" as const,
        current: runtime.rage,
        maximum: this.classResourceMaximum(entity),
        reserved: runtime.reservedRage
      } }),
      weaponMode: runtime.weaponMode,
      rage: runtime.activeClassId === "hunter" ? runtime.rage : 0,
      maximumRage: runtime.activeClassId === "hunter" ? this.classResourceMaximum(entity) : 0,
      reservedRage: runtime.activeClassId === "hunter" ? runtime.reservedRage : 0,
      guard: runtime.guard,
      bloodlust: runtime.bloodlust,
      classCounters: numericCounters(runtime.counters),
      statusIndicators: this.v2StatusIndicators(runtime),
      queuedAbility: runtime.queuedAbility ? {
        abilityId: runtime.queuedAbility.abilityId,
        targetEntityId: runtime.queuedAbility.targetEntityId,
        queuedAtTick: runtime.queuedAbility.queuedAtTick
      } : pendingAbilityId && (session?.pendingResetTargetEntityId || session?.focusTargetEntityId) ? {
        abilityId: pendingAbilityId,
        targetEntityId: session.pendingResetTargetEntityId ?? session.focusTargetEntityId!,
        queuedAtTick: this.currentTick
      } : null,
      cooldownEndsAt: { ...runtime.cooldownEndsAt },
      cooldownGroupEndsAt: {
        [BASIC_ATTACK_RESET_COOLDOWN_GROUP]: runtime.cooldownEndsAt[BASIC_ATTACK_RESET_COOLDOWN_GROUP] ?? 0
      }
    };
  }

  private v2StatusIndicators(runtime: ClassCombatRuntime): NonNullable<ClassCombatState["statusIndicators"]> {
    const now = this.now();
    const indicators: NonNullable<ClassCombatState["statusIndicators"]> = [];
    const visibleEffects = runtime.effects.filter((effect) => effect.sourceTechniqueId.includes("_v2_") && effect.endTick >= this.currentTick);
    const techniqueCounts = new Map<string, number>();
    for (const effect of visibleEffects) techniqueCounts.set(effect.sourceTechniqueId, (techniqueCounts.get(effect.sourceTechniqueId) ?? 0) + 1);
    for (const effect of visibleEffects) {
      const id = (techniqueCounts.get(effect.sourceTechniqueId) ?? 0) > 1 ? effect.id : effect.sourceTechniqueId;
      indicators.push({ id, label: effect.sourceTechniqueId.split("_v2_")[1]!.replaceAll("_", " "),
        ...(effect.stacks > 1 ? { stacks: effect.stacks } : {}),
        endsAt: now + (effect.endTick - this.currentTick) * 1_000 / this.options.tickRateHz });
    }
    for (const [key, label] of [
      ["v2IronReversal", "Iron Reversal"], ["v2Substitution", "Substitution"]
    ] as const) {
      const stacks = Number(runtime.counters[key] ?? 0);
      const endsAt = Number(runtime.counters[`${key}EndsAt`] ?? 0);
      if (stacks > 0 && (endsAt === 0 || endsAt >= now)) indicators.push({ id: key, label, ...(stacks > 1 ? { stacks } : {}), ...(endsAt > 0 ? { endsAt } : {}) });
    }
    return indicators.sort((a, b) => a.id.localeCompare(b.id));
  }

  private rememberClassRuntime(entity: Combatant): void {
    const runtime = entity.classRuntime;
    if (entity.kind !== "player" || !runtime) return;
    runtime.dirtyVersion += 1;
    runtime.counters.guard = runtime.guard;
    runtime.counters.bloodlust = runtime.bloodlust;
    runtime.counters.persistedServerTick = this.currentTick;
    const engagedTargetEntityId = typeof runtime.counters.skillV3ShieldChargeTarget === "string"
      ? runtime.counters.skillV3ShieldChargeTarget
      : null;
    const engagedTargetExpiresAt = Number(runtime.counters.skillV3ShieldChargeEndsAt ?? 0);
    this.dirtyClassRuntimes.set(entity.entityId, {
      playerId: entity.entityId,
      version: runtime.dirtyVersion,
      skillV3: runtime.skillV3 !== null,
      engagedTarget: engagedTargetEntityId && engagedTargetExpiresAt > this.now()
        ? { targetEntityId: engagedTargetEntityId, expiresAt: engagedTargetExpiresAt }
        : null,
      activeClassId: runtime.activeClassId,
      resourceId: runtime.resourceId,
      resourceCurrent: runtime.activeClassId === "warrior" ? 0 : runtime.rage,
      resourceReserved: runtime.activeClassId === "warrior" ? 0 : runtime.reservedRage,
      rage: runtime.activeClassId === "warrior" ? 0 : runtime.rage,
      rageReserved: runtime.activeClassId === "warrior" ? 0 : runtime.reservedRage,
      queuedAbilityId: runtime.queuedAbility?.abilityId ?? null,
      queuedTargetEntityId: runtime.queuedAbility?.targetEntityId ?? null,
      queuedAtTick: runtime.queuedAbility?.queuedAtTick ?? null,
      cooldownEndsAt: { ...runtime.cooldownEndsAt },
      statusEffects: runtime.effects
        .filter((effect) => runtime.skillV3 !== null || !isHarmfulStatusKind(effect.kind))
        .map((effect) => ({ ...effect })),
      counters: { ...runtime.counters },
      combatGeneration: runtime.combatGeneration,
      lastCombatAt: runtime.lastCombatAtMs
    });
  }

  private isResetAbility(abilityId: string): boolean {
    return (RESET_ACTIVE_IDS as readonly string[]).includes(abilityId);
  }

  private validateAbilityInput(
    player: Combatant,
    abilityId: string,
    reset: boolean,
    options: { skipReadiness?: boolean } = {}
  ): TechniqueDefinition {
    const runtime = requireClassCombatRuntime(player);
    let definition: TechniqueDefinition;
    try {
      definition = requireTechniqueDefinition(abilityId);
    } catch {
      throw new CombatRequestError("ABILITY_NOT_DEFINED", "Ability is not in the active technique catalog");
    }
    if (runtime.skillV3 && definition.classId !== "hunter" && definition.kind !== "passive") {
      throw new CombatRequestError("CLASS_TECHNIQUES_DISABLED", "Class techniques are not available yet");
    }
    if (
      definition.classId !== runtime.activeClassId ||
      definition.kind === "passive" ||
      !runtime.learned.has(definition.id) ||
      !runtime.equippedActives.has(definition.id)
    ) {
      throw new CombatRequestError("ABILITY_NOT_EQUIPPED", "Ability is not learned and equipped");
    }
    if (runtime.masteryRank < definition.unlockLevel) {
      throw new CombatRequestError("ABILITY_RANK_LOCKED", "Ability rank is not unlocked");
    }
    if (definition.kind === "ultimate" && !this.isResetAbility(definition.id)) {
      throw new CombatRequestError("ABILITY_NOT_NORMAL", "Ultimate abilities are not available");
    }
    if (this.isResetAbility(definition.id) !== reset) {
      throw new CombatRequestError(
        reset ? "ABILITY_NOT_RESET" : "ABILITY_NOT_NORMAL",
        reset ? "Ability is not a reset active" : "Reset actives require the reset input"
      );
    }
    if (definition.subclassId !== null && definition.subclassId !== runtime.subclassId) {
      throw new CombatRequestError("ABILITY_SUBCLASS_INACTIVE", "Ability does not match the active subclass");
    }
    this.validateAbilityEquipment(player, runtime, definition);
    const cooldownEnd = reset
      ? runtime.cooldownEndsAt[BASIC_ATTACK_RESET_COOLDOWN_GROUP] ?? 0
      : runtime.cooldownEndsAt[definition.id] ?? 0;
    if (!options.skipReadiness && cooldownEnd > this.now()) {
      throw new CombatRequestError("ABILITY_COOLDOWN", "Ability is still cooling down");
    }
    if (!options.skipReadiness && Number(runtime.counters.abilityActivationLockoutEndsAt ?? 0) > this.now()) {
      throw new CombatRequestError("ABILITY_ACTIVATION_LOCKOUT", "Ability activation is locked briefly");
    }
    if (runtime.activeClassId !== "warrior" && !options.skipReadiness && runtime.rage < this.rageCost(runtime, definition)) {
      throw new CombatRequestError(
        `${runtime.resourceId.toUpperCase()}_INSUFFICIENT`,
        `Not enough ${runtime.resourceId.charAt(0).toUpperCase()}${runtime.resourceId.slice(1)}`
      );
    }
    if (definition.id === "warrior_empowered_hit" && runtime.counters.warriorEmpoweredHitArmed === true) {
      throw new CombatRequestError("EMPOWERMENT_ALREADY_ARMED", "Empowered Hit is already armed");
    }
    return definition;
  }

  private v3ConcentrationBonus(attacker: Combatant, target: Combatant): number {
    const runtime = attacker.classRuntime;
    const rank = runtime?.skillV3?.generalSkillRanks.concentration ?? 0;
    if (!runtime?.skillV3 || rank <= 0) return 0;
    const sameTarget = runtime.counters.skillV3ConcentrationTarget === target.entityId;
    const priorHits = sameTarget ? Number(runtime.counters.skillV3ConcentrationHits ?? 0) : 0;
    if ((priorHits + 1) % 3 !== 0) return 0;
    const missingPercent = Math.max(0, (target.maxHealth - target.currentHealth) * 100 / target.maxHealth);
    const step = rank >= 3 ? 9 : rank >= 2 ? 13 : 22;
    return Math.floor(missingPercent / step);
  }

  private recordV3ConcentrationHit(attacker: Combatant, target: Combatant): void {
    const runtime = attacker.classRuntime;
    if (!runtime?.skillV3 || (runtime.skillV3.generalSkillRanks.concentration ?? 0) <= 0) return;
    const sameTarget = runtime.counters.skillV3ConcentrationTarget === target.entityId;
    runtime.counters.skillV3ConcentrationTarget = target.entityId;
    runtime.counters.skillV3ConcentrationHits = sameTarget
      ? Number(runtime.counters.skillV3ConcentrationHits ?? 0) + 1
      : 1;
  }

  private resolveV3BasicAttackProcs(
    attacker: Combatant,
    target: Combatant,
    appliedDamage: number
  ): void {
    const runtime = attacker.classRuntime;
    const skill = runtime?.skillV3;
    if (!runtime || !skill || appliedDamage <= 0) return;
    const family = equipmentGameplayFamily(runtime.weaponDefinitionId) ?? runtime.weaponCategory;
    const cleaveRank = skill.generalSkillRanks.cleave ?? 0;
    if (
      cleaveRank > 0 &&
      ["sword", "axe", "hammer", "dagger", "brass_knuckles", "spear", "staff"].includes(family ?? "") &&
      (this.options.random?.() ?? Math.random()) < ([0.04, 0.09, 0.13][Math.min(3, cleaveRank) - 1] ?? 0.13)
    ) {
      const maximum = cleaveRank >= 3 ? 5 : cleaveRank >= 2 ? 4 : 3;
      for (const candidate of this.v3EligibleSecondaryTargets(attacker, target, V3_CLEAVE_RADIUS_M, maximum)) {
        this.applyDamage(attacker, candidate, Math.max(1, Math.round(appliedDamage * 0.45)), "v3_general_cleave", false);
      }
    }
    const ricochetRank = skill.generalSkillRanks.ricochet ?? 0;
    if (
      ricochetRank > 0 &&
      ["sling", "bow", "crossbow", "blowdart", "shuriken"].includes(family ?? "")
    ) {
      const radius = ricochetRank >= 3 ? 280 : ricochetRank >= 2 ? 230 : 180;
      const secondary = this.v3EligibleSecondaryTargets(attacker, target, radius, 1)[0];
      if (secondary) {
        const multiplier = ricochetRank >= 3 ? 0.55 : ricochetRank >= 2 ? 0.36 : 0.18;
        this.applyDamage(attacker, secondary, Math.max(1, Math.round(appliedDamage * multiplier)), "v3_general_ricochet", false);
      }
    }
    const quarryRank = skill.generalSkillRanks.quarry_sense ?? 0;
    if (
      target.kind === "mob" && !this.isPlayerOwnedCreature(target) && quarryRank > 0 && !this.isBossMob(target) &&
      (this.options.random?.() ?? Math.random()) < ([0.025, 0.055, 0.085][Math.min(3, quarryRank) - 1] ?? 0.085)
    ) {
      this.applyOpenedGuard(attacker, target, flatRankValue(QUARRY_EXPOSED_DAMAGE_BONUS_BY_RANK, quarryRank));
    }
  }

  /** Opened Guard (Quarry Sense, Alchemy's Ember Bomb): the monster takes extra damage until death. Keeps the stronger mark. */
  private applyOpenedGuard(source: Combatant, target: Combatant, amount: number): void {
    const targetRuntime = target.classRuntime ?? (target.classRuntime = emptyRuntime());
    const existing = Math.max(0, ...targetRuntime.effects
      .filter((effect) => effect.sourceTechniqueId === V3_QUARRY_EXPOSURE_ID)
      .map((effect) => effect.amount));
    if (existing >= amount) return;
    targetRuntime.effects = targetRuntime.effects.filter((effect) =>
      effect.sourceTechniqueId !== V3_QUARRY_EXPOSURE_ID
    );
    targetRuntime.effects.push({
      id: `${target.entityId}:${V3_QUARRY_EXPOSURE_ID}`,
      kind: "quarry_exposure",
      sourceTechniqueId: V3_QUARRY_EXPOSURE_ID,
      sourceEntityId: source.entityId,
      startTick: this.currentTick,
      endTick: Number.MAX_SAFE_INTEGER,
      nextTick: Number.MAX_SAFE_INTEGER,
      stacks: 1,
      maximumStacks: 1,
      amount,
      cleansable: false,
      minor: false
    });
    this.markDirty(target);
  }

  private v3EligibleSecondaryTargets(
    attacker: Combatant,
    primary: Combatant,
    radiusM: number,
    maximum: number
  ): Combatant[] {
    return this.nearbyEntityIds(primary.position, radiusM)
      .map((id) => this.entities.get(id))
      .filter((candidate): candidate is Combatant => Boolean(
        candidate && candidate.entityId !== primary.entityId && candidate.lifeState === "alive" &&
        this.isAttackPairValid(attacker, candidate)
      ))
      .sort((left, right) =>
        distanceMeters(primary.position, left.position) - distanceMeters(primary.position, right.position) ||
        left.entityId.localeCompare(right.entityId)
      )
      .slice(0, maximum);
  }

  private ensurePveSession(player: Combatant): PveCombatSession {
    const existing = this.pveSessions.get(player.entityId);
    if (existing) return existing;
    const generation = (this.pveSessionGenerations.get(player.entityId) ?? 0) + 1;
    this.pveSessionGenerations.set(player.entityId, generation);
    const focus = player.targetEntityId && this.entities.get(player.targetEntityId)?.kind === "mob"
      ? player.targetEntityId
      : null;
    const sessionId = crypto.randomUUID();
    const telemetryStartedAtMs = this.now();
    const view = this.authoritativeViewCircle(player);
    const session: PveCombatSession = {
      sessionId,
      generation,
      playerId: player.entityId,
      playerAggroActive: false,
      focusTargetEntityId: focus,
      focusPackId: focus ? this.entities.get(focus)?.packId ?? null : null,
      enemyQueue: [],
      enemyIds: new Set(),
      pursuingEnemyIds: new Set(),
      tauntedEnemyIds: new Set(),
      enemyQueueJoinedAtTick: new Map(),
      queueCursor: 0,
      phase: "waiting_player",
      playerTurnAnchorTick: null,
      nextBasicAttackTick: focus
        ? Math.max(this.currentTick + 1, player.nextEligibleAttackTick)
        : null,
      enemyActionAtTick: null,
      pendingNormal: null,
      pendingResetAbilityId: null,
      pendingResetTargetEntityId: null,
      pendingResetTargetMode: null,
      pendingResetActionSequence: null,
      playerActionSequence: 0,
      fortify: null,
      telemetry: this.createCombatTelemetry(player, sessionId, telemetryStartedAtMs),
      telemetryStartedAtMs,
      telemetryStartedAtTick: this.currentTick,
      requestedEndReason: null,
      viewCenter: { ...view.center },
      viewRadiusM: view.radiusM,
      viewGeneration: view.generation,
      lastMeaningfulEngagementAtMs: telemetryStartedAtMs,
      lastTauntExcludedByCap: 0,
      hadEnemyParticipation: false
    };
    this.pveSessions.set(player.entityId, session);
    if (player.classRuntime) {
      player.classRuntime.combatGeneration += 1;
      player.classRuntime.lastCombatAtMs = this.now();
      player.classRuntime.counters.rageDecayAccumulator = 0;
      player.classRuntime.counters.guardDecayAccumulator = 0;
      this.rememberClassRuntime(player);
    }
    this.markDirty(player);
    return session;
  }

  private authoritativeViewCircle(player: Combatant): AuthoritativeCombatViewCircle {
    const view = this.options.getAuthoritativeViewCircle
      ? this.options.getAuthoritativeViewCircle(player.entityId)
      : { center: player.homePosition, radiusM: this.interestRadiusM, generation: 0 };
    if (
      !view ||
      !Number.isFinite(view.center.lat) ||
      !Number.isFinite(view.center.lon) ||
      !Number.isFinite(view.radiusM) ||
      view.radiusM <= 0 ||
      !Number.isInteger(view.generation) ||
      view.generation < 0
    ) {
      throw new CombatRequestError("TAUNT_VIEW_CIRCLE_UNAVAILABLE", "No valid authoritative gameplay view circle is active");
    }
    return { ...view, center: { ...view.center } };
  }

  private createCombatTelemetry(
    player: Combatant,
    sessionId: string,
    startedAtMs: number
  ): CombatTelemetryAccumulator {
    const runtime = player.classRuntime;
    const equipmentState = player.equipmentCombatState;
    const definitions = [...(runtime?.equippedActives ?? [])]
      .map((id) => {
        try {
          return requireTechniqueDefinition(id);
        } catch {
          return null;
        }
      })
      .filter((definition): definition is TechniqueDefinition => definition !== null);
    const resets = definitions.filter((definition) => definition.kind === "reset").map((definition) => definition.id);
    const normals = definitions.filter((definition) => definition.kind === "normal").map((definition) => definition.id);
    const passiveForTier = (tier: 0 | 10 | 20): string | null => {
      for (const id of runtime?.equippedPassives ?? []) {
        try {
          const definition = requireTechniqueDefinition(id);
          if (definition.passiveTier === tier) return definition.id;
        } catch {
          continue;
        }
      }
      return null;
    };
    return new CombatTelemetryAccumulator({
      combatSessionId: sessionId,
      playerId: player.entityId,
      activeClassId: runtime?.activeClassId ?? "unclassed",
      activeSubclassId: runtime?.subclassId ?? null,
      activeClassLevel: Math.max(0, Math.min(25, runtime?.masteryRank ?? 0)),
      primaryResourceId: runtime?.resourceId === "none" ? "rage" : runtime?.resourceId ?? "rage",
      weaponMode: runtime?.weaponMode ?? null,
      warriorLevel: Math.max(0, Math.min(25, runtime?.masteryRank ?? 0)),
      characterLevel: Math.max(0, Math.min(CURRENT_LEVEL_CAP, player.level)),
      warriorRank: runtime?.activeClassId === "warrior"
        ? Math.max(0, Math.min(15, runtime.masteryRank))
        : 0,
      ...(equipmentState
        ? telemetryEquipmentState(equipmentState)
        : {
            activeKitIndex: null,
            readiedWeaponSlot: "melee" as const,
            weaponCategory: null,
            weaponItemLevel: null,
            effectiveWeaponLevel: null,
            weightedArmorLevel: 0,
            shieldLevel: null,
            pvpOffense: 0,
            pvpGuard: 0
          }),
      equippedResetActives: [resets[0] ?? null, resets[1] ?? null],
      equippedNormalActives: [normals[0] ?? null, normals[1] ?? null],
      selectedTierPassives: {
        tier0: passiveForTier(0),
        tier10: passiveForTier(10),
        tier20: passiveForTier(20)
      },
      initialEnemyQueueSize: 0,
      enemyArchetypeCounts: {},
      startedAtMs
    });
  }

  private telemetryTime(session: PveCombatSession): number {
    return session.telemetryStartedAtMs +
      (this.currentTick - session.telemetryStartedAtTick) * 1_000 / this.options.tickRateHz;
  }

  private requirePveSession(player: Combatant): PveCombatSession {
    const session = this.pveSessions.get(player.entityId);
    if (!session) {
      throw new CombatRequestError("PVE_SESSION_REQUIRED", "A PvE combat session is required");
    }
    return session;
  }

  private combatActionState(player: Combatant): CombatActionResult {
    return {
      classCombat: player.classRuntime ? this.classCombatState(player) : null,
      pveCombat: this.pveCombatState(player)
    };
  }

  private pveCombatState(player: Combatant): PveCombatSessionSnapshot | null {
    const session = this.pveSessions.get(player.entityId);
    if (!session) return null;
    const timestampForTick = (tick: number | null): number | null => tick === null
      ? null
      : this.now() + Math.max(0, tick - this.currentTick) * 1_000 / this.options.tickRateHz;
    return {
      sessionId: session.sessionId,
      focusTargetEntityId: session.focusTargetEntityId,
      enemyQueue: [...session.enemyQueue],
      pursuingEnemyIds: [...session.pursuingEnemyIds],
      queueCursor: session.enemyQueue.length === 0 ? 0 : session.queueCursor % session.enemyQueue.length,
      phase: session.phase,
      nextBasicAttackAt: timestampForTick(session.nextBasicAttackTick),
      resetWindowEndsAt: null,
      pendingNormalAbilityId: session.pendingNormal?.kind === "ability"
        ? session.pendingNormal.abilityId
        : session.pendingNormal?.kind === "taunt"
          ? UNIVERSAL_TAUNT_ID
          : null,
      pendingResetAbilityId: session.pendingResetAbilityId,
      tauntCooldownEndsAt: this.tauntCooldownEnd(player),
      activeViewCenter: { ...session.viewCenter },
      activeViewRadiusM: session.viewRadiusM,
      activeViewGeneration: session.viewGeneration,
      lastTauntExcludedByCap: session.lastTauntExcludedByCap
    };
  }

  private noteSessionChanged(player: Combatant, _session: PveCombatSession): void {
    void _session;
    this.markDirty(player);
  }

  private markSessionParticipation(playerId: string): void {
    const session = this.pveSessions.get(playerId);
    if (session && session.enemyIds.size > 0) session.hadEnemyParticipation = true;
  }

  private isCombatEligibleMob(entity: Combatant): boolean {
    return entity.kind === "mob" &&
      entity.lifeState === "alive" &&
      !isMobRetreating(entity) &&
      this.mobAiProfile(entity).onAttacked !== null &&
      entity.retaliates &&
      entity.attackDamage > 0;
  }

  private mobAiProfile(mob: Combatant): MobAiProfile {
    if (mob.kind !== "mob" || !mob.archetypeKey) {
      throw new Error("Mob AI profile requested for a non-mob combatant");
    }
    if (mob.npcFaction?.culture === "goblin") {
      const cityDefenseRadiusM = Math.max(
        300,
        mob.attackRangeM,
        mob.npcFaction.annexRadiusM * 2
      );
      return {
        proactive: {
          intent: "combat",
          radiusM: mob.npcFaction.role === "archer" ? cityDefenseRadiusM : 300,
          acquisitionDelayMs: 0
        },
        onAttacked: { group: "exact_pack" },
        movement: { kind: "attack_range" },
        disengagement: { kind: "outside_radius", radiusM: cityDefenseRadiusM, graceMs: 0 },
        endDisposition: "return_home",
        countdown: null
      };
    }
    return requireMobAiProfile(mob.archetypeKey);
  }

  private isWithinMobAttackHoldRange(mob: Combatant, target: Combatant): boolean {
    const holdBufferM = mob.activityState === "attacking"
      ? MOB_ATTACK_HOLD_RANGE_BUFFER_M
      : 0;
    return distanceMeters(mob.position, target.position) <= mob.attackRangeM + holdBufferM;
  }

  private trackEnemy(session: PveCombatSession, enemyId: string): boolean {
    if (session.enemyIds.has(enemyId)) return false;
    if (session.enemyIds.size >= MAX_PVE_ENEMY_QUEUE_SIZE) return false;
    session.enemyIds.add(enemyId);
    return true;
  }

  private appendEnemy(session: PveCombatSession, enemyId: string): boolean {
    // Mob tactics: a managed mob joins its target's roster instead of the turn queue (spec 2.9).
    // It stays in enemyIds for aggro, loot and session end; false = not queued.
    if (this.mobTacticsActive()) {
      const enemy = this.entities.get(enemyId);
      const target = enemy?.targetEntityId ? this.entities.get(enemy.targetEntityId) : undefined;
      if (enemy && target && this.joinMobTactics(enemy, target)) {
        if (!session.enemyIds.has(enemyId)) this.trackEnemy(session, enemyId);
        session.pursuingEnemyIds.delete(enemyId);
        return false;
      }
    }
    if (session.enemyQueue.includes(enemyId)) return false;
    if (session.enemyQueue.length >= MAX_PVE_ENEMY_QUEUE_SIZE) return false;
    if (!session.enemyIds.has(enemyId) && !this.trackEnemy(session, enemyId)) return false;
    session.pursuingEnemyIds.delete(enemyId);
    session.enemyQueue.push(enemyId);
    session.enemyQueueJoinedAtTick.set(enemyId, this.currentTick);
    const archetype = this.entities.get(enemyId)?.archetypeKey;
    if (archetype) {
      session.telemetry.recordQueueInsertion(
        archetype,
        session.enemyQueue.length,
        this.telemetryTime(session)
      );
    }
    return true;
  }

  private claimMobAggro(
    mob: Combatant,
    player: Combatant,
    session: PveCombatSession
  ): boolean {
    const sharedPartyOwner = mob.aggroOwnerPlayerId !== null &&
      this.options.partyAuthority?.sameParty(mob.aggroOwnerPlayerId, player.entityId) === true;
    if (
      mob.kind !== "mob" ||
      mob.lifeState !== "alive" ||
      !this.isCombatEligibleMob(mob) ||
      (mob.aggroOwnerPlayerId !== null && !sharedPartyOwner && (
        mob.aggroOwnerPlayerId !== player.entityId ||
        mob.aggroOwnerSessionId !== session.sessionId ||
        mob.aggroOwnerSessionGeneration !== session.generation
      ))
    ) {
      return false;
    }
    if (
      mob.aggroOwnerPlayerId === null &&
      !session.enemyIds.has(mob.entityId) &&
      session.enemyIds.size >= MAX_PVE_ENEMY_QUEUE_SIZE
    ) {
      return false;
    }
    if (mob.aggroOwnerPlayerId === null) {
      mob.aggroOwnerPlayerId = player.entityId;
      mob.aggroOwnerSessionId = session.sessionId;
      mob.aggroOwnerSessionGeneration = session.generation;
      mob.aggroViewGeneration = session.viewGeneration;
      this.setTarget(mob, player.entityId);
    }
    const tracked = this.trackEnemy(session, mob.entityId);
    if (tracked) this.noteSessionChanged(player, session);
    return tracked;
  }

  private releaseMobClaim(mob: Combatant, session: PveCombatSession): boolean {
    if (
      mob.kind !== "mob" ||
      mob.aggroOwnerPlayerId !== session.playerId ||
      mob.aggroOwnerSessionId !== session.sessionId ||
      mob.aggroOwnerSessionGeneration !== session.generation
    ) return false;
    const successor = [...this.pveSessions.values()]
      .filter((candidate) =>
        candidate !== session && candidate.enemyIds.has(mob.entityId) &&
        this.options.partyAuthority?.sameParty(session.playerId, candidate.playerId)
      )
      .sort((left, right) => left.playerId.localeCompare(right.playerId))[0];
    const successorPlayer = successor ? this.entities.get(successor.playerId) : null;
    if (successor && successorPlayer?.kind === "player" && successorPlayer.lifeState === "alive") {
      mob.aggroOwnerPlayerId = successor.playerId;
      mob.aggroOwnerSessionId = successor.sessionId;
      mob.aggroOwnerSessionGeneration = successor.generation;
      mob.aggroViewGeneration = successor.viewGeneration;
      this.setTarget(mob, successor.playerId);
    } else {
      mob.aggroOwnerPlayerId = null;
      mob.aggroOwnerSessionId = null;
      mob.aggroOwnerSessionGeneration = null;
      mob.aggroViewGeneration = null;
      this.clearTarget(mob);
      this.finishMobAiEngagement(mob);
    }
    return true;
  }

  private finishMobAiEngagement(mob: Combatant): void {
    if (mob.kind !== "mob" || mob.lifeState !== "alive") return;
    this.invalidateScheduledAttack(mob);
    this.activeChases.delete(mob.entityId);
    mob.chaseDestination = null;
    if (!mob.worldAi || !mob.mobAi) {
      mob.activityState = "idle";
      this.markDirty(mob);
      return;
    }
    const profile = this.mobAiProfile(mob);
    const resumePlayer = mob.mobAi.targetPlayerId
      ? this.entities.get(mob.mobAi.targetPlayerId)
      : null;
    if (
      profile.proactive?.intent === "observe" &&
      resumePlayer?.kind === "player" &&
      resumePlayer.lifeState === "alive" &&
      this.canMobContinueIntent(mob, resumePlayer)
    ) {
      this.beginMobObservation(mob, resumePlayer);
      return;
    }
    mob.mobAi.intent = null;
    mob.mobAi.targetPlayerId = null;
    mob.mobAi.deadlineTick = null;
    mob.mobAi.deadlineAtMs = null;
    if (profile.endDisposition === "return_home") {
      mob.mobAi.phase = "returning";
      mob.activityState = "returning";
      this.returningMobs.add(mob.entityId);
    } else {
      mob.mobAi.phase = "idle";
      mob.activityState = "idle";
      this.returningMobs.delete(mob.entityId);
    }
    this.markDirty(mob);
  }

  private aggroAbilityTargets(player: Combatant, targets: Combatant[]): void {
    const session = this.pveSessions.get(player.entityId);
    if (!session) return;
    const ordered = targets
      .filter((target) => target.kind === "mob" && target.lifeState === "alive")
      .sort((left, right) =>
        distanceMeters(player.position, left.position) - distanceMeters(player.position, right.position) ||
        left.entityId.localeCompare(right.entityId)
      );
    for (const target of ordered) {
      if (
        target.aggroOwnerPlayerId === player.entityId &&
        target.aggroOwnerSessionId === session.sessionId &&
        target.aggroOwnerSessionGeneration === session.generation
      ) {
        this.appendEnemy(session, target.entityId);
      } else if (
        target.aggroOwnerPlayerId === null ||
        this.options.partyAuthority?.sameParty(target.aggroOwnerPlayerId, player.entityId)
      ) {
        this.claimMobAggro(target, player, session);
        this.appendEnemy(session, target.entityId);
      }
    }
    this.noteSessionChanged(player, session);
  }

  private removeEnemyFromQueue(session: PveCombatSession, enemyId: string): boolean {
    if (this.entities.get(enemyId)?.special?.pendingBasicStrike) this.orphanedMeleeStrikeMobIds.add(enemyId);
    const index = session.enemyQueue.indexOf(enemyId);
    if (index < 0) return false;
    session.enemyQueue.splice(index, 1);
    session.enemyQueueJoinedAtTick.delete(enemyId);
    session.telemetry.recordQueueRemoval(
      session.enemyQueue.length,
      this.telemetryTime(session)
    );
    session.fortify?.remainingEnemyIds.delete(enemyId);
    if (
      session.fortify &&
      (session.fortify.remainingEnemyIds.size === 0 || session.fortify.remainingProtectedHits <= 0)
    ) {
      session.fortify = null;
    }
    if (session.enemyQueue.length === 0) {
      session.queueCursor = 0;
    } else {
      if (index < session.queueCursor) session.queueCursor -= 1;
      session.queueCursor %= session.enemyQueue.length;
    }
    const player = this.entities.get(session.playerId);
    if (player) this.noteSessionChanged(player, session);
    return true;
  }

  private removeEnemy(session: PveCombatSession, enemyId: string, defeated = false): boolean {
    if (!session.enemyIds.has(enemyId)) return false;
    if (this.mobTactics.mobs.get(enemyId)?.targetId === session.playerId) this.forgetMobTactics(enemyId);
    this.removeEnemyFromQueue(session, enemyId);
    session.pursuingEnemyIds.delete(enemyId);
    session.tauntedEnemyIds.delete(enemyId);
    session.enemyIds.delete(enemyId);
    if (session.focusTargetEntityId === enemyId) {
      const previousFocus = session.focusTargetEntityId;
      session.focusTargetEntityId = null;
      this.repairFocus(session, previousFocus);
    }
    const removedMob = this.entities.get(enemyId);
    if (removedMob?.kind === "mob" && this.releaseMobClaim(removedMob, session)) {
      if (!defeated) session.requestedEndReason ??= "enemies_cleared";
    }
    const player = this.entities.get(session.playerId);
    if (player) {
      if (player.classRuntime?.counters.relentlessTarget === enemyId) {
        player.classRuntime.counters.relentlessTarget = "";
        player.classRuntime.counters.relentlessCount = 0;
        this.rememberClassRuntime(player);
      }
      this.noteSessionChanged(player, session);
      if (!defeated && session.enemyIds.size === 0) this.maybeEndPveSession(player, session);
    }
    return true;
  }

  private removeEnemyFromAllSessions(enemyId: string): void {
    for (const session of [...this.pveSessions.values()].sort((a, b) => a.playerId.localeCompare(b.playerId))) {
      this.removeEnemy(session, enemyId, true);
    }
  }

  private isEnemyValidForSession(session: PveCombatSession, enemyId: string): boolean {
    const player = this.entities.get(session.playerId);
    const mob = this.entities.get(enemyId);
    return Boolean(
      player &&
      mob &&
      player.lifeState === "alive" &&
      this.currentAuthoritativeViewGeneration(player) === session.viewGeneration &&
      mob.kind === "mob" &&
      mob.lifeState === "alive" &&
      (mob.aggroOwnerPlayerId === player.entityId
        ? mob.aggroOwnerSessionId === session.sessionId &&
          mob.aggroOwnerSessionGeneration === session.generation
        : mob.aggroOwnerPlayerId !== null &&
          this.options.partyAuthority?.sameParty(mob.aggroOwnerPlayerId, player.entityId) === true) &&
      distanceMeters(player.position, session.viewCenter) <= session.viewRadiusM &&
      distanceMeters(mob.position, session.viewCenter) <= session.viewRadiusM &&
      this.isAttackPairValid(player, mob)
    );
  }

  private repairFocus(session: PveCombatSession, previousFocusOverride?: string | null): void {
    const player = this.entities.get(session.playerId);
    if (!player) return;
    const preservedFocusTarget = session.focusTargetEntityId
      ? this.entities.get(session.focusTargetEntityId)
      : null;
    if (
      preservedFocusTarget?.kind === "mob" &&
      preservedFocusTarget.lifeState === "alive" &&
      player.targetEntityId === preservedFocusTarget.entityId &&
      this.isAttackPairValid(player, preservedFocusTarget) &&
      (
        this.isEnemyValidForSession(session, preservedFocusTarget.entityId) ||
        preservedFocusTarget.aggroOwnerPlayerId === null ||
        this.options.isSharedMobCombat?.(preservedFocusTarget.entityId) === true
      )
    ) {
      return;
    }
    if (!session.playerAggroActive) {
      session.focusTargetEntityId = player.targetEntityId;
      return;
    }
    if (
      session.focusTargetEntityId &&
      this.isEnemyValidForSession(session, session.focusTargetEntityId)
    ) {
      return;
    }
    const previousFocus = previousFocusOverride === undefined
      ? session.focusTargetEntityId
      : previousFocusOverride;
    const inAttackRange = new Set(this.grid.query(player.position, player.attackRangeM));
    const orderedEnemyIds = [...new Set([...session.enemyQueue, ...session.enemyIds])];
    const eligibleEnemyIds = orderedEnemyIds.filter((enemyId) =>
      inAttackRange.has(enemyId) && this.isEnemyValidForSession(session, enemyId)
    );
    const nextFocus = (
      session.focusPackId
        ? eligibleEnemyIds.find((enemyId) =>
            this.entities.get(enemyId)?.packId === session.focusPackId
          )
        : null
    ) ?? eligibleEnemyIds[0] ?? null;
    session.focusTargetEntityId = nextFocus;
    if (nextFocus) {
      session.focusPackId = this.entities.get(nextFocus)?.packId ?? null;
    } else if (
      session.focusPackId &&
      ![...session.enemyIds].some((enemyId) =>
        this.entities.get(enemyId)?.packId === session.focusPackId &&
        this.isEnemyValidForSession(session, enemyId)
      )
    ) {
      session.focusPackId = null;
    }
    if (previousFocus && previousFocus !== nextFocus) {
      if (nextFocus) session.telemetry.recordFocusSwitch(this.telemetryTime(session));
      this.resetFocusBoundClassState(player);
    }
    if (nextFocus) {
      if (player.targetEntityId !== nextFocus) this.setTarget(player, nextFocus);
    } else if (player.targetEntityId) {
      this.clearTarget(player);
    }
  }

  private endPveSession(
    player: Combatant,
    releaseAggro: boolean,
    reason = "cancelled"
  ): void {
    const session = this.pveSessions.get(player.entityId);
    if (!session) return;
    this.pveSessions.delete(player.entityId);
    if (this.mobTactics.rosters.has(player.entityId)) this.forgetMobTacticsTarget(player.entityId);
    const endedAtMs = this.telemetryTime(session);
    if (session.enemyQueue.length > 0) {
      session.telemetry.recordQueueRemoval(
        0,
        endedAtMs,
        session.enemyQueue.length
      );
    }
    const summary = session.telemetry.finish({
      endedAtMs,
      playerSurvived: reason !== "player_defeated" && player.currentHealth > 0,
      combatEndReason: reason
    });
    player.scheduledAttackTick = null;
    player.attackScheduleGeneration += 1;
    if (releaseAggro) {
      for (const enemyId of session.enemyIds) {
        const mob = this.entities.get(enemyId);
        if (mob?.kind === "mob") this.releaseMobClaim(mob, session);
      }
    }
    if (player.targetEntityId && this.entities.get(player.targetEntityId)?.kind === "mob") {
      this.clearTarget(player);
    }
    this.markDirty(player);
    if (player.classRuntime) {
      this.clearV2TransientState(player, reason === "disconnect" || reason === "linkdead_presence_ended");
    }
    this.resetFocusBoundClassState(player);
    this.options.onCombatSummary?.(summary);
  }

  private maybeEndPveSession(player: Combatant, session: PveCombatSession): boolean {
    if (
      session.enemyIds.size > 0 ||
      session.pursuingEnemyIds.size > 0 ||
      player.targetEntityId !== null ||
      session.pendingNormal?.kind === "taunt"
    ) {
      return false;
    }
    session.pendingNormal = null;
    this.clearPendingEmpowerment(session);
    this.endPveSession(player, true, session.requestedEndReason ?? "enemies_defeated");
    return true;
  }

  private isEncounterPursuitWithinView(attacker: Combatant, target: Combatant): boolean {
    if (attacker.kind !== "mob" || attacker.aggroOwnerPlayerId !== target.entityId) return false;
    const session = this.pveSessions.get(target.entityId);
    return Boolean(
      session &&
      attacker.aggroOwnerSessionId === session.sessionId &&
      attacker.aggroOwnerSessionGeneration === session.generation &&
      session.enemyIds.has(attacker.entityId) &&
      session.pursuingEnemyIds.has(attacker.entityId) &&
      session.tauntedEnemyIds.has(attacker.entityId) &&
      distanceMeters(attacker.position, session.viewCenter) <= session.viewRadiusM &&
      distanceMeters(target.position, session.viewCenter) <= session.viewRadiusM
    );
  }

  private processPveSessions(): void {
    for (const session of [...this.pveSessions.values()].sort((a, b) => a.playerId.localeCompare(b.playerId))) {
      if (this.isPlayerReserved(session.playerId)) continue;
      if (this.pveSessions.get(session.playerId) !== session) continue;
      const player = this.entities.get(session.playerId);
      if (!player) continue;
      if (player.lifeState !== "alive") {
        this.endPveSession(player, true, "player_defeated");
        continue;
      }
      if (this.linkDeadPlayerIds.has(player.entityId)) {
        this.invalidateScheduledAttack(player);
        session.pendingNormal = null;
        this.clearPendingEmpowerment(session);
        if (
          session.enemyQueue.length > 0 &&
          (session.phase !== "enemy_pending" || session.enemyActionAtTick === null)
        ) {
          session.phase = "enemy_pending";
          session.enemyActionAtTick = this.currentTick + 1;
        }
        if (
          session.phase === "enemy_pending" &&
          session.enemyActionAtTick !== null &&
          this.currentTick >= session.enemyActionAtTick
        ) {
          this.resolveEnemyOpportunity(player, session);
        }
        continue;
      }
      if (!this.hasActiveAuthority(player)) {
        session.requestedEndReason = "authority_lost";
        this.endPveSession(player, true, "authority_lost");
        continue;
      }
      if (
        this.now() - session.lastMeaningfulEngagementAtMs >= PVE_AGGRO_ABANDON_TIMEOUT_MS
      ) {
        session.requestedEndReason = "abandonment_timeout";
        const expiringEnemyIds = [...session.enemyIds]
          .filter((enemyId) => {
            const mob = this.entities.get(enemyId);
            return mob?.kind === "mob" &&
              this.mobAiProfile(mob).disengagement.kind === "engagement_timeout";
          })
          .sort();
        for (const enemyId of expiringEnemyIds) {
          if (this.pveSessions.get(session.playerId) !== session) break;
          this.removeEnemy(session, enemyId);
        }
        if (this.pveSessions.get(session.playerId) !== session) continue;
        session.lastMeaningfulEngagementAtMs = this.now();
      }
      if (
        session.phase === "waiting_player" &&
        session.pendingNormal &&
        this.isPlayerTurnDue(session)
      ) {
        const pending = session.pendingNormal;
        session.pendingNormal = null;
        try {
          if (!this.tryResolveNormalAction(player, session, pending)) session.pendingNormal = pending;
        } catch (error) {
          if (!(error instanceof CombatRequestError)) throw error;
          this.repairFocus(session);
        }
        if (this.pveSessions.get(session.playerId) !== session) continue;
        this.noteSessionChanged(player, session);
      }
      if (
        this.pveSessions.get(session.playerId) === session &&
        session.phase === "waiting_player" &&
        player.scheduledAttackTick === null
      ) {
        this.repairFocus(session);
        if (session.focusTargetEntityId) {
          const dueTick = Math.max(
            this.currentTick + 1,
            player.nextEligibleAttackTick,
            session.nextBasicAttackTick ?? this.currentTick + 1
          );
          session.nextBasicAttackTick = dueTick;
          this.scheduleAttack(player, dueTick);
          this.noteSessionChanged(player, session);
        }
      }
      if (
        this.options.actionCombatEnabled?.() === true &&
        this.pveSessions.get(session.playerId) === session &&
        session.phase === "enemy_pending" &&
        session.enemyActionAtTick !== null &&
        this.currentTick < session.enemyActionAtTick &&
        session.enemyActionAtTick - this.currentTick <= this.meleeWindupTicks
      ) {
        this.beginSessionEnemyWindup(player, session);
      }
      if (
        this.pveSessions.get(session.playerId) === session &&
        session.phase === "enemy_pending" &&
        session.enemyActionAtTick !== null &&
        this.currentTick >= session.enemyActionAtTick
      ) {
        this.resolveEnemyOpportunity(player, session);
      }
    }
  }

  /** Who a session enemy strikes on its turn: a valid threat-priority ally, otherwise the session player. */
  private sessionEnemyTarget(enemy: Combatant, player: Combatant): Combatant {
    const priorityTarget = enemy.threatPriorityRemainingActions > 0 && enemy.threatPriorityPlayerId
      ? this.entities.get(enemy.threatPriorityPlayerId)
      : null;
    return priorityTarget && priorityTarget.kind === "player" &&
      priorityTarget.lifeState === "alive" &&
      this.isAttackPairValid(enemy, priorityTarget) &&
      (priorityTarget.entityId === player.entityId || this.isValidParticipatingAlly(player, priorityTarget, 120))
      ? priorityTarget
      : player;
  }

  private isEnemyInSessionStrikeRange(enemy: Combatant, target: Combatant): boolean {
    return this.grid
      .query(
        enemy.position,
        enemy.attackRangeM + (
          enemy.activityState === "attacking" ? MOB_ATTACK_HOLD_RANGE_BUFFER_M : 0
        )
      )
      .includes(target.entityId);
  }

  /**
   * Action combat: starts the melee windup of the enemy whose turn is next, MOB_MELEE_WINDUP_MS before
   * that turn, so the telegraph eats into the half-beat instead of delaying the strike. Only the enemy at
   * the queue cursor is considered; anything else winds up when its turn resolves.
   */
  private beginSessionEnemyWindup(player: Combatant, session: PveCombatSession): void {
    if (this.options.mobAiEnabled?.() === false || session.enemyQueue.length === 0 || session.enemyActionAtTick === null) return;
    const enemyId = session.enemyQueue[session.queueCursor % session.enemyQueue.length]!;
    if (!this.isEnemyValidForSession(session, enemyId)) return;
    const enemy = this.entities.get(enemyId);
    if (!enemy || enemy.aggroOwnerPlayerId !== session.playerId || enemy.v2SkipNextAttackSourceId || this.isMobInHitstun(enemy)) return;
    const target = this.sessionEnemyTarget(enemy, player);
    if (!this.usesMeleeWindup(enemy, target) || this.pendingMeleeStrikeFor(enemy, target)) return;
    if (!this.isEnemyInSessionStrikeRange(enemy, target)) return;
    // A turn set less than a full windup ahead moves back so the telegraph always runs its full length.
    const dueTick = Math.max(session.enemyActionAtTick, this.currentTick + this.meleeWindupTicks);
    session.enemyActionAtTick = dueTick;
    this.beginMeleeWindup(enemy, target, dueTick);
  }

  private resolveEnemyOpportunity(player: Combatant, session: PveCombatSession): void {
    if (this.options.mobAiEnabled?.() === false) {
      this.completeEnemyAction(player, session);
      return;
    }
    session.enemyActionAtTick = null;
    const remainingCandidates = new Set(session.enemyQueue);
    const opportunityScanLimit = session.enemyQueue.length;
    let opportunityScans = 0;
    let resolvedAction = false;
    let deferredNewArrival = false;
    // One enemy opportunity may inspect each queued enemy at most once. This
    // explicit cap remains safe even if later queue-repair code mutates entries.
    while (
      session.enemyQueue.length > 0 &&
      remainingCandidates.size > 0 &&
      opportunityScans < opportunityScanLimit
    ) {
      opportunityScans += 1;
      session.queueCursor %= session.enemyQueue.length;
      const enemyId = session.enemyQueue[session.queueCursor]!;
      remainingCandidates.delete(enemyId);
      if (!this.isEnemyValidForSession(session, enemyId)) {
        this.removeEnemy(session, enemyId);
        continue;
      }
      if ((session.enemyQueueJoinedAtTick.get(enemyId) ?? -1) >= this.currentTick) {
        session.queueCursor = (session.queueCursor + 1) % session.enemyQueue.length;
        deferredNewArrival = true;
        continue;
      }
      const enemy = this.entities.get(enemyId)!;
      if (this.isMobInHitstun(enemy)) {
        // Swing hitstun: this enemy keeps the turn and strikes once it recovers.
        session.enemyActionAtTick = enemy.special!.hitstunUntilTick;
        return;
      }
      session.queueCursor = (session.queueCursor + 1) % session.enemyQueue.length;
      // A shared party participant may reference the owner's enemy, but only the
      // canonical aggro-owner session resolves that enemy's authoritative action.
      if (enemy.aggroOwnerPlayerId !== session.playerId) break;
      const enemyTarget = this.sessionEnemyTarget(enemy, player);
      if (enemy.targetEntityId !== enemyTarget.entityId) this.setTarget(enemy, enemyTarget.entityId);
      const enemyArchetype = enemy.archetypeKey ?? "unknown";
      if (this.resolveQueueBleedTurn(enemy)) {
        resolvedAction = true;
        session.telemetry.recordEnemyAction({
          action: "attack",
          atMs: this.telemetryTime(session),
          enemyArchetype,
          damage: 0
        });
        this.consumeFortifyOpportunity(session, enemyId, false);
        this.consumeEnemyActionEffects(enemy);
        this.expireRotationEnemyOpportunity(enemy.entityId);
        if (enemy.threatPriorityRemainingActions > 0) {
          enemy.threatPriorityRemainingActions -= 1;
          if (enemy.threatPriorityRemainingActions <= 0) enemy.threatPriorityPlayerId = null;
        }
        break;
      }
      const meleeWindup = this.usesMeleeWindup(enemy, enemyTarget);
      const pendingStrike = meleeWindup ? this.pendingMeleeStrikeFor(enemy, enemyTarget) : null;
      // A telegraphed strike resolves against its cone wherever the target went: no range gate.
      const inRange = pendingStrike !== null || this.isEnemyInSessionStrikeRange(enemy, enemyTarget);
      if (!inRange) {
        this.removeEnemyFromQueue(session, enemyId);
        session.pursuingEnemyIds.add(enemyId);
        this.startChasing(enemy);
        continue;
      }
      if (meleeWindup && pendingStrike === null && !enemy.v2SkipNextAttackSourceId) {
        // No windup ran ahead of this turn (the turn was set late, or a hitstun just ended):
        // telegraph now and keep the turn with this enemy until the strike is due.
        this.activeChases.delete(enemy.entityId);
        enemy.activityState = "attacking";
        const dueTick = this.currentTick + this.meleeWindupTicks;
        this.beginMeleeWindup(enemy, enemyTarget, dueTick);
        session.queueCursor = Math.max(0, session.enemyQueue.indexOf(enemyId));
        session.enemyActionAtTick = dueTick;
        return;
      }
      resolvedAction = true;
      this.activeChases.delete(enemy.entityId);
      enemy.activityState = "attacking";
      if (enemy.v2SkipNextAttackSourceId) {
        delete enemy.v2SkipNextAttackSourceId;
        if (pendingStrike) enemy.special!.pendingBasicStrike = null;
      } else if (pendingStrike) this.resolvePendingMeleeStrike(enemy, enemyTarget);
      else this.resolveBasicAttack(enemy, enemyTarget);
      this.markDirty(enemy);
      this.consumeHunterSnareOpportunity(enemy);
      this.consumeFortifyOpportunity(session, enemyId, inRange);
      this.consumeEnemyActionEffects(enemy);
      this.expireRotationEnemyOpportunity(enemy.entityId);
      if (enemy.threatPriorityRemainingActions > 0) {
        enemy.threatPriorityRemainingActions -= 1;
        if (enemy.threatPriorityRemainingActions <= 0) enemy.threatPriorityPlayerId = null;
      }
      break;
    }
    if (!resolvedAction && deferredNewArrival) {
      session.nextBasicAttackTick = Math.max(
        session.nextBasicAttackTick ?? 0,
        this.currentTick + this.pveTurnStepTicks
      );
    }
    if (this.pveSessions.get(player.entityId) !== session || player.lifeState !== "alive") return;
    this.completeEnemyAction(player, session);
  }

  private consumeEnemyActionEffects(enemy: Combatant): void {
    const runtime = enemy.classRuntime;
    if (!runtime) return;
    runtime.effects = runtime.effects.filter((effect) => effect.stacks > 0);
    this.markDirty(enemy);
  }

  private expireRotationEnemyOpportunity(enemyId: string): void {
    for (const entity of this.entities.values()) {
      const runtime = entity.classRuntime;
      if (!runtime || entity.kind !== "player") continue;
      let changed = false;
      for (const effect of runtime.effects) {
        if (!effect.enemyIds?.includes(enemyId)) continue;
        effect.enemyIds = effect.enemyIds.filter((id) => id !== enemyId);
        changed = true;
      }
      if (changed) {
        runtime.effects = runtime.effects.filter((effect) => !effect.enemyIds || effect.enemyIds.length > 0);
        this.markDirty(entity);
        this.rememberClassRuntime(entity);
      }
    }
  }

  private completeEnemyAction(player: Combatant, session: PveCombatSession): void {
    session.phase = "waiting_player";
    session.enemyActionAtTick = null;
    for (const enemyId of [...session.enemyQueue]) {
      if (!this.isEnemyValidForSession(session, enemyId)) this.removeEnemy(session, enemyId);
    }
    if (this.maybeEndPveSession(player, session)) return;
    if (
      !session.playerAggroActive &&
      player.targetEntityId === null &&
      session.pendingNormal === null &&
      session.pendingResetAbilityId === null
    ) {
      if (session.enemyQueue.length > 0) {
        session.phase = "enemy_pending";
        session.enemyActionAtTick = this.currentTick + this.attackIntervalTicks;
      }
      this.noteSessionChanged(player, session);
      return;
    }
    this.repairFocus(session);
    if (session.focusTargetEntityId) {
      const dueTick = Math.max(
        this.currentTick + this.pveTurnStepTicks,
        session.nextBasicAttackTick ?? this.currentTick + this.pveTurnStepTicks
      );
      session.nextBasicAttackTick = dueTick;
      this.scheduleAttack(player, dueTick);
    }
    this.noteSessionChanged(player, session);
  }

  private tryResolveNormalAction(
    player: Combatant,
    session: PveCombatSession,
    pending: PendingNormalAction
  ): boolean {
    if (player.equipmentCombatState?.switchingToSlot) return false;
    if (pending.kind === "taunt") {
      this.resolveTauntAction(player, session);
      return true;
    }
    const definition = this.validateAbilityInput(player, pending.abilityId, false);
    this.repairFocus(session);
    const target = this.resolveTechniqueTarget(player, session, definition, pending.targetEntityId, pending.targetMode);
    const targetType = this.resolvedTargetMode(player, target);
    const range = targetType === "friendly" || targetType === "self"
      ? FRIENDLY_TARGET_RANGE_M
      : player.attackRangeM;
    const inRange = target.entityId === player.entityId
      || (isSingleTargetSupportTechnique(definition) && target.kind === "player")
      || this.grid.query(player.position, range).includes(target.entityId);
    if (!inRange) {
      return false;
    }
    this.resolveAbility(player, target, definition);
    this.afterNormalPlayerAction(player, session);
    return true;
  }

  private afterNormalPlayerAction(player: Combatant, session: PveCombatSession): void {
    session.phase = "waiting_player";
    this.markDirty(player);
    if (!this.maybeEndPveSession(player, session)) this.queueEnemyAction(player, session, true);
  }

  private isPlayerTurnDue(session: PveCombatSession): boolean {
    return session.playerTurnAnchorTick === null ||
      session.nextBasicAttackTick === null ||
      this.currentTick >= session.nextBasicAttackTick;
  }

  private anchorPlayerTurn(player: Combatant, session: PveCombatSession): void {
    session.playerTurnAnchorTick = this.currentTick;
    session.enemyActionAtTick = this.currentTick + this.pveTurnStepTicks;
    player.nextEligibleAttackTick = this.currentTick + player.attackIntervalTicks;
    session.nextBasicAttackTick = player.nextEligibleAttackTick;
  }

  private clearPendingEmpowerment(session: PveCombatSession): void {
    session.pendingResetAbilityId = null;
    session.pendingResetTargetEntityId = null;
    session.pendingResetTargetMode = null;
    session.pendingResetActionSequence = null;
  }

  private clearV2TransientState(player: Combatant, preserveCommittedArm = false): void {
    const runtime = player.classRuntime;
    if (!runtime) return;
    const preservedArmedActionSequence = preserveCommittedArm && runtime.queuedAbility?.activationCommitted &&
      requireTechniqueDefinition(runtime.queuedAbility.abilityId).activation === "armed"
      ? runtime.counters.v2ArmedActionSequence
      : undefined;
    if (!preserveCommittedArm) this.clearCommittedV2Armed(player);
    const session = this.pveSessions.get(player.entityId);
    if (session) this.clearPendingEmpowerment(session);
    for (const key of Object.keys(runtime.counters)) {
      if (key.startsWith("v2") || key === "abilityActivationLockoutEndsAt") delete runtime.counters[key];
    }
    if (preservedArmedActionSequence !== undefined) {
      runtime.counters.v2ArmedActionSequence = preservedArmedActionSequence;
    }
    for (const entity of this.entities.values()) {
      const entityRuntime = entity.classRuntime;
      if (!entityRuntime) continue;
      entityRuntime.effects = entityRuntime.effects.filter((effect) =>
        !(effect.sourceEntityId === player.entityId && effect.sourceTechniqueId.includes("_v2_"))
      );
      if (entityRuntime.counters.v2LastBastionSource === player.entityId) {
        delete entityRuntime.counters.v2LastBastionSource;
        delete entityRuntime.counters.v2LastBastionEndsAt;
        delete entityRuntime.counters.v2LastBastionUsed;
      }
      if (entity.v2SkipNextAttackSourceId === player.entityId) delete entity.v2SkipNextAttackSourceId;
    }
    for (const zone of [...this.classAbilityZones.values()]) {
      if (zone.sourceEntityId !== player.entityId) continue;
      this.removeBannerDefense(zone);
      this.classAbilityZones.delete(zone.id);
      this.emitClassAbilityZoneEvent("CLASS_ABILITY_ZONE_ENDED", zone);
    }
  }

  private clearCommittedV2Armed(player: Combatant): void {
    const runtime = player.classRuntime;
    if (!runtime?.queuedAbility?.activationCommitted ||
      requireTechniqueDefinition(runtime.queuedAbility.abilityId).activation !== "armed") return;
    runtime.queuedAbility = null;
    delete runtime.counters.v2ArmedActionSequence;
    const session = this.pveSessions.get(player.entityId);
    if (session) this.clearPendingEmpowerment(session);
  }

  private addTimedMitigation(target: Combatant, sourceTechniqueId: string, durationMs: number, amount: number): void {
    const runtime = target.classRuntime ?? (target.classRuntime = emptyRuntime());
    const id = `${target.entityId}:${sourceTechniqueId}:incoming_mitigation`;
    const durationTicks = Math.max(1, Math.ceil(durationMs * this.options.tickRateHz / 1_000));
    const existing = runtime.effects.find((effect) => effect.id === id);
    const effect: CombatEffect = {
      id,
      kind: "incoming_mitigation",
      sourceTechniqueId,
      sourceEntityId: target.entityId,
      startTick: this.currentTick,
      endTick: this.currentTick + durationTicks,
      nextTick: this.currentTick + durationTicks,
      stacks: 1,
      maximumStacks: 1,
      amount,
      cleansable: false,
      minor: false
    };
    if (existing) Object.assign(existing, effect);
    else runtime.effects.push(effect);
    this.markDirty(target);
    this.rememberClassRuntime(target);
  }

  private recordSupportContribution(source: Combatant, amount: number): void {
    if (source.kind !== "player" || amount <= 0) return;
    const enemyIds = new Set<string>();
    for (const memberId of this.participatingPartyMemberIds(source, FRIENDLY_TARGET_RANGE_M)) {
      const session = this.pveSessions.get(memberId);
      for (const enemyId of session?.enemyIds ?? []) enemyIds.add(enemyId);
    }
    for (const enemyId of enemyIds) {
      const enemy = this.entities.get(enemyId);
      if (!enemy || enemy.kind !== "mob" || enemy.lifeState !== "alive") continue;
      const contributions = this.contributionsByMob.get(enemyId) ?? new Map<string, number>();
      contributions.set(source.entityId, (contributions.get(source.entityId) ?? 0) + amount);
      this.contributionsByMob.set(enemyId, contributions);
    }
  }

  private effectTotalForTarget(entity: Combatant, kind: CombatEffectKind, targetEntityId: string): number {
    return entity.classRuntime?.effects
      .filter((effect) => effect.kind === kind && effect.endTick >= this.currentTick &&
        (!effect.enemyIds || effect.enemyIds.includes(targetEntityId)))
      .reduce((total, effect) => total + effect.amount * effect.stacks, 0) ?? 0;
  }

  private hasV3CleanseImmunity(target: Combatant): boolean {
    return target.classRuntime?.effects.some((effect) =>
      effect.kind === "cleanse_immunity" && effect.endTick >= this.currentTick
    ) ?? false;
  }

  private hasV3BlightImmunity(target: Combatant): boolean {
    return target.classRuntime?.effects.some((effect) =>
      effect.kind === "blight_immunity" && effect.endTick >= this.currentTick
    ) ?? false;
  }

  private applyV3Blight(
    source: Combatant,
    target: Combatant,
    rank: number,
    spread: boolean
  ): boolean {
    if (
      target.lifeState !== "alive" || this.hasV3CleanseImmunity(target) ||
      this.hasV3BlightImmunity(target)
    ) return false;
    const runtime = target.classRuntime ?? (target.classRuntime = emptyRuntime());
    const durationSeconds = spread ? 9 : 18;
    const damagePerSecond = rank >= 3 ? 2.2 : rank >= 2 ? 1.7 : 1.2;
    const missChance = rank >= 3 ? 0.22 : rank >= 2 ? 0.14 : 0.09;
    // One beat-aligned tick instead of one per second; the total damage is unchanged.
    const intervalTicks = this.periodicIntervalTicks(V3_BLIGHT_TICK_MS);
    const pulses = beatPulseCount(durationSeconds * 1_000, V3_BLIGHT_TICK_MS);
    const firstTick = this.firstPeriodicTick(source.entityId, target, intervalTicks);
    runtime.effects.push({
      id: `${target.entityId}:${V3_BLIGHT_ID}`,
      kind: "blight",
      sourceTechniqueId: V3_BLIGHT_ID,
      sourceEntityId: source.entityId,
      startTick: this.currentTick,
      endTick: firstTick + intervalTicks * (pulses - 1),
      nextTick: firstTick,
      stacks: pulses,
      maximumStacks: pulses,
      amount: missChance,
      remainingAmount: Math.round(damagePerSecond * durationSeconds),
      cleansable: true,
      minor: false,
      spreadApplied: spread
    });
    runtime.effects.push({
      id: `${target.entityId}:${V3_BLIGHT_IMMUNITY_ID}`,
      kind: "blight_immunity",
      sourceTechniqueId: V3_BLIGHT_IMMUNITY_ID,
      sourceEntityId: source.entityId,
      startTick: this.currentTick,
      endTick: this.currentTick + millisecondsToTicks(V3_BLIGHT_IMMUNITY_MS, this.options.tickRateHz),
      nextTick: Number.MAX_SAFE_INTEGER,
      stacks: 1,
      maximumStacks: 1,
      amount: 0,
      cleansable: false,
      minor: false,
      spreadApplied: true
    });
    this.markDirty(target);
    if (target.kind === "player") this.rememberClassRuntime(target);
    return true;
  }

  private spreadV3BlightOnContact(left: Combatant, right: Combatant): void {
    const candidates: Array<[Combatant, Combatant]> = [[left, right], [right, left]];
    for (const [infected, recipient] of candidates) {
      const effect = infected.classRuntime?.effects.find((entry) =>
        entry.kind === "blight" && entry.endTick >= this.currentTick && entry.spreadApplied !== true
      );
      if (!effect) continue;
      effect.spreadApplied = true;
      const source = this.entities.get(effect.sourceEntityId) ?? infected;
      const rank = effect.amount >= 0.20 ? 3 : effect.amount >= 0.15 ? 2 : 1;
      this.applyV3Blight(source, recipient, rank, true);
      this.markDirty(infected);
      if (infected.kind === "player") this.rememberClassRuntime(infected);
      return;
    }
  }

  private addTimedEffect(
    source: Combatant,
    target: Combatant,
    kind: CombatEffectKind,
    sourceTechniqueId: string,
    durationMs: number,
    amount: number,
    enemyIds?: string[],
    intervalMs = 2_000
  ): void {
    if (isV3HarmfulEffectKind(kind) && this.hasV3CleanseImmunity(target)) return;
    // Free-Step Ward: nobody inside can be rooted or held.
    if ((kind === "rooted" || kind === "immobilized" || kind === "stunned") && source.entityId !== target.entityId && this.isFreeStepProtected(target)) return;
    const runtime = target.classRuntime ?? (target.classRuntime = emptyRuntime());
    const durationTicks = Math.max(1, Math.ceil(durationMs * this.options.tickRateHz / 1_000));
    const id = `${target.entityId}:${sourceTechniqueId}:${kind}`;
    runtime.effects = runtime.effects.filter((effect) => effect.id !== id);
    // Healing over time ticks on the beat: the heal per second and pulse count follow the design
    // interval and duration as closely as whole beats allow (`remainingActions` = beat ticks).
    const healing = kind === "healing_over_time";
    const healIntervalTicks = healing ? this.periodicIntervalTicks(intervalMs) : 0;
    const firstHealTick = healing ? this.firstPeriodicTick(source.entityId, target, healIntervalTicks) : Number.MAX_SAFE_INTEGER;
    runtime.effects.push({
      id, kind, sourceTechniqueId, sourceEntityId: source.entityId,
      ...(source.classRuntime ? { sourceClassId: source.classRuntime.activeClassId } : {}),
      sourceSubclassId: source.classRuntime?.subclassId ?? null,
      startTick: this.currentTick,
      endTick: healing
        ? firstHealTick + healIntervalTicks * (beatPulseCount(durationMs, intervalMs) - 1)
        : this.currentTick + durationTicks,
      nextTick: firstHealTick,
      stacks: 1, maximumStacks: 1,
      amount: healing ? amount * beatAlignedAmountScale(intervalMs) : amount,
      cleansable: true,
      ...(healing ? { remainingActions: healIntervalTicks } : {}),
      minor: kind === "movement_slow", ...(enemyIds ? { enemyIds } : {})
    });
    this.markDirty(target);
    if (target.kind === "player") this.rememberClassRuntime(target);
  }

  private applyConcussed(source: Combatant, target: Combatant): void {
    if (this.hasV3CleanseImmunity(target)) return;
    const runtime = target.classRuntime ?? (target.classRuntime = emptyRuntime());
    runtime.effects = runtime.effects.filter((effect) => effect.kind !== "concussed");
    runtime.effects.push({
      id: `${target.entityId}:concussed`,
      kind: "concussed",
      sourceTechniqueId: "warrior_concussive_blow",
      sourceEntityId: source.entityId,
      sourceClassId: "warrior",
      sourceSubclassId: source.classRuntime?.subclassId ?? null,
      startTick: this.currentTick,
      endTick: Number.MAX_SAFE_INTEGER,
      nextTick: Number.MAX_SAFE_INTEGER,
      stacks: 1,
      maximumStacks: 1,
      amount: 1,
      cleansable: false,
      minor: false
    });
    this.markDirty(target);
  }

  private warriorFlatAttackBonus(
    attacker: Combatant,
    basicAttack: boolean,
    target?: Combatant,
    sourceTechniqueId?: string
  ): number {
    const lanternBonus = (attacker.kind === "player" && target?.kind === "mob"
      ? this.options.dungeonLanternStatBonus?.(attacker.entityId).attack ?? 0
      : 0) + (attacker.kind === "player" && this.battleDraughts.has(attacker.entityId) ? BATTLE_DRAUGHT_ATTACK_BONUS : 0);
    const runtime = attacker.classRuntime;
    if (!runtime) return lanternBonus;
    if (lanternBonus > 0) {
      return lanternBonus + this.warriorFlatAttackBonusBase(attacker, runtime, basicAttack, target, sourceTechniqueId);
    }
    return this.warriorFlatAttackBonusBase(attacker, runtime, basicAttack, target, sourceTechniqueId);
  }

  private warriorFlatAttackBonusBase(
    attacker: Combatant,
    runtime: NonNullable<Combatant["classRuntime"]>,
    basicAttack: boolean,
    target?: Combatant,
    sourceTechniqueId?: string
  ): number {
    if (runtime.skillV3) {
      const retainedEffectBonus = runtime.effects
        .filter((effect) => effect.kind === "flat_attack" && effect.endTick >= this.currentTick)
        .filter((effect) => !effect.sourceTechniqueId.includes("_v2_"))
        .reduce((total, effect) => total + effect.amount * effect.stacks, 0);
      return this.v3StaticAttackBonus(attacker) + this.v3MercenaryMomentumAttackBonus(attacker, target) +
        this.v3ContextualAttackBonus(attacker) + this.deepstoneCaveBonus(attacker, "attack") +
        this.v3PveContextualAttackBonus(attacker, target) + retainedEffectBonus;
    }
    const preferredFamily = ({
      warrior: "axe", druid: "staff", ranger: "bow",
      knight: "sword", ninja: "shuriken", hunter: null
    } as const)[runtime.activeClassId];
    let bonus = preferredFamily && equipmentGameplayFamily(runtime.weaponDefinitionId) === preferredFamily
      ? CLASS_MASTERY_ATTACK_BY_RANK[automaticRank(runtime.masteryRank, [5, 9, 13])]! : 0;
    bonus += runtime.effects
      .filter((effect) => effect.kind === "flat_attack" && effect.endTick >= this.currentTick)
      .filter((effect) => !effect.sourceTechniqueId.includes("_v2_") || this.v2ScheduledBonusApplies(runtime, effect.sourceTechniqueId))
      .reduce((total, effect) => total + effect.amount * (effect.sourceTechniqueId.includes("_v2_") ? 1 : effect.stacks), 0);
    if (runtime.activeClassId !== "warrior") {
      const weaponFamily = equipmentGameplayFamily(runtime.weaponDefinitionId);
      if (runtime.activeClassId === "druid") {
        if (!basicAttack && runtime.equippedPassives.has("druid_natural_focus")) bonus += 1;
        if (sourceTechniqueId === "druid_thorn_burst" && runtime.equippedPassives.has("druid_thorned_growth")) bonus += 2;
        if (target && target.currentHealth / target.maxHealth < 0.35 && runtime.equippedPassives.has("druid_predatory_growth")) bonus += 2;
      }
      if (runtime.activeClassId === "ranger") {
        if (basicAttack && weaponFamily === "bow" && runtime.equippedPassives.has("ranger_heavy_draw")) bonus += 1;
        if (target && distanceMeters(attacker.position, target.position) >= 100 && runtime.equippedPassives.has("ranger_longshot")) bonus += 2;
        if (target && target.currentHealth / target.maxHealth < 0.35 && runtime.equippedPassives.has("ranger_executioner")) bonus += 2;
      }
      if (runtime.activeClassId === "knight" && basicAttack && weaponFamily === "sword" &&
        runtime.equippedPassives.has("knight_heavy_blade")) bonus += 1;
      return bonus;
    }
    const healthRatio = attacker.currentHealth / attacker.maxHealth;
    bonus += this.warriorInnateDamageTier(healthRatio);
    if (
      target
      && runtime.equippedPassives.has("warrior_desperate_fury")
      && target.currentHealth / target.maxHealth < WARRIOR_BALANCE.lowHealthThreshold
    ) bonus += 2;
    if (runtime.equippedPassives.has("warrior_crowd_fighter") && this.validOwnedEnemyCount(attacker.entityId) >= 2) {
      bonus += 1;
    }
    if (basicAttack && runtime.equippedPassives.has("warrior_heavy_handed")) bonus += 1;
    return bonus;
  }

  private v3StaticAttackBonus(attacker: Combatant): number {
    const skill = attacker.classRuntime?.skillV3;
    if (!skill) return 0;
    const family = equipmentGameplayFamily(attacker.classRuntime?.weaponDefinitionId ?? null) ??
      attacker.classRuntime?.weaponCategory ?? null;
    const general = skill.generalSkillRanks;
    let bonus = 0;
    const archeryRank = general.archery ?? 0;
    if ((family === "bow" || family === "longbow" || family === "crossbow") && archeryRank > 0) {
      bonus += flatRankValue(ARCHERY_ATTACK_BY_RANK, archeryRank);
    }
    const martialRank = this.generalRankInZone(attacker, "martial_arts");
    if ((family === "shuriken" || family === "blowdart") && martialRank > 0) bonus += flatRankValue(MARTIAL_RANGED_ATTACK_BY_RANK, martialRank);
    if (
      family === null && martialRank > 0 &&
      (attacker.classRuntime?.heavyArmorPieces ?? 0) === 0 && !attacker.classRuntime?.hasShield
    ) bonus += Math.min(EQUIPMENT_LEVEL_CAP, attacker.level);

    const rank = skill.specializationRank;
    const specialization = skill.activeSpecializationId;
    const masteryBonus = specializationTierBonus(rank);
    const weaponMatches = (families: readonly string[]) => families.includes(family ?? "unarmed");
    if (
      (specialization === "warrior" && weaponMatches(["axe"])) ||
      (specialization === "knight" && weaponMatches(["sword", "god_sword"])) ||
      (specialization === "legionnaire" && weaponMatches(["spear"])) ||
      (specialization === "ranger" && weaponMatches(["bow", "sword", "god_sword"])) ||
      (specialization === "sentinel" && weaponMatches(["crossbow"])) ||
      (specialization === "ninja" && weaponMatches(["shuriken"])) ||
      (specialization === "monk" && weaponMatches(["staff", "sling"])) ||
      (specialization === "rogue" && weaponMatches(["dagger", "brass_knuckles"]))
    ) bonus += masteryBonus;
    if (specialization === "assassin") {
      if (family === "dagger") bonus += masteryBonus;
      if (family === "blowdart") bonus += rank >= 5 ? 4 : rank >= 4 ? 2 : rank >= 2 ? 1 : 0;
    }
    if (specialization === "mercenary") {
      if (family === "spear") bonus += rank >= 5 ? 3 : rank >= 4 ? 2 : rank >= 1 ? 1 : 0;
      if (family === "crossbow") bonus += rank >= 5 ? 3 : rank >= 3 ? 1 : 0;
    }
    return bonus;
  }

  private readonly mercenaryKillMomentum = new Map<string, { killerEntityId: string; rank: number; stacks: number }>();

  private v3MercenaryMomentumAttackBonus(attacker: Combatant, target?: Combatant): number {
    if (
      (equipmentGameplayFamily(attacker.classRuntime?.weaponDefinitionId ?? null) ??
        attacker.classRuntime?.weaponCategory) !== "spear"
    ) return 0;
    return this.v3MercenaryMomentumStacks(attacker, target);
  }

  /** Current Momentum stacks the Mercenary holds against this player (weapon-independent). */
  private v3MercenaryMomentumStacks(attacker: Combatant, target?: Combatant): number {
    const skill = attacker.classRuntime?.skillV3;
    if (
      skill?.activeSpecializationId !== "mercenary" || skill.specializationRank < 1 ||
      target?.kind !== "player"
    ) return 0;
    const counters = attacker.classRuntime!.counters;
    const now = this.now();
    if (
      counters.skillV3MercenaryMomentumTarget !== target.entityId ||
      now - Number(counters.skillV3MercenaryMomentumLastHitAt ?? 0) >= V3_MERCENARY_MOMENTUM_INACTIVITY_MS
    ) return 0;
    const elapsed = Math.max(0, now - Number(counters.skillV3MercenaryMomentumStartedAt ?? now));
    const maximum = skill.specializationRank >= 5
      ? 6
      : skill.specializationRank >= 4 ? 4 : skill.specializationRank >= 3 ? 3 : 2;
    return Math.min(maximum, Math.floor(elapsed / V3_MERCENARY_MOMENTUM_INTERVAL_MS));
  }

  private recordV3MercenaryMomentumExchange(attacker: Combatant, target: Combatant, now: number): void {
    if (attacker.kind !== "player" || target.kind !== "player") return;
    const record = (mercenary: Combatant, opponent: Combatant): void => {
      const runtime = mercenary.classRuntime;
      const skill = runtime?.skillV3;
      if (skill?.activeSpecializationId !== "mercenary" || skill.specializationRank < 1 || !runtime) return;
      const targetChanged = runtime.counters.skillV3MercenaryMomentumTarget !== opponent.entityId;
      const inactive = now - Number(runtime.counters.skillV3MercenaryMomentumLastHitAt ?? 0) >=
        V3_MERCENARY_MOMENTUM_INACTIVITY_MS;
      if (targetChanged || inactive) {
        runtime.counters.skillV3MercenaryMomentumTarget = opponent.entityId;
        runtime.counters.skillV3MercenaryMomentumStartedAt = now;
      }
      runtime.counters.skillV3MercenaryMomentumLastHitAt = now;
      this.rememberClassRuntime(mercenary);
    };
    record(attacker, target);
    record(target, attacker);
  }

  private clearV3MercenaryMomentumForDefeat(defeatedEntityId: string): void {
    for (const entity of this.entities.values()) {
      const runtime = entity.classRuntime;
      if (!runtime?.skillV3) continue;
      if (
        entity.entityId !== defeatedEntityId &&
        runtime.counters.skillV3MercenaryMomentumTarget !== defeatedEntityId
      ) continue;
      delete runtime.counters.skillV3MercenaryMomentumTarget;
      delete runtime.counters.skillV3MercenaryMomentumStartedAt;
      delete runtime.counters.skillV3MercenaryMomentumLastHitAt;
      this.rememberClassRuntime(entity);
    }
  }

  private v3AssassinSurpriseMultiplier(
    attacker: Combatant,
    target: Combatant,
    qualifyingAttack: boolean
  ): number {
    const runtime = attacker.classRuntime;
    const skill = runtime?.skillV3;
    const now = this.now();
    if (
      attacker.kind !== "player" || target.kind !== "player" || !qualifyingAttack || !runtime ||
      skill?.activeSpecializationId !== "assassin" || skill.specializationRank < 3 ||
      target.aggressiveUntilMs > now ||
      Number(runtime.counters.skillV3AssassinSurpriseReadyAt ?? 0) > now
    ) return 1;
    runtime.counters.skillV3AssassinSurpriseReadyAt = now + V3_ASSASSIN_SURPRISE_COOLDOWN_MS;
    this.rememberClassRuntime(attacker);
    return skill.specializationRank >= 5 ? 3.5 : 2.5;
  }

  private v3WarriorMaxHealthBonus(skill: SkillCombatRuntimeV3 | null): number {
    if (skill?.activeSpecializationId !== "warrior") return 0;
    return Math.max(0, Math.min(5, skill.specializationRank)) * 9;
  }

  private applyV3WarriorMaxHealthTransition(
    player: Combatant,
    previous: SkillCombatRuntimeV3 | null,
    next: SkillCombatRuntimeV3 | null
  ): void {
    const delta = this.v3WarriorMaxHealthBonus(next) - this.v3WarriorMaxHealthBonus(previous);
    if (delta === 0) return;
    const previousMaxHealth = player.maxHealth;
    player.maxHealth = this.penalizedMaxHealth(
      player,
      Math.max(1, player.maxHealth + (player.maxHealthPenaltyApplied ?? 0) + delta)
    );
    player.currentHealth = preserveCurrentHealthPercentage(
      player.currentHealth,
      previousMaxHealth,
      player.maxHealth
    );
  }

  private v3ContextualAttackBonus(attacker: Combatant): number {
    const skill = attacker.classRuntime?.skillV3;
    if (!skill || skill.activeSpecializationId !== "warrior") return 0;
    const family = equipmentGameplayFamily(attacker.classRuntime?.weaponDefinitionId ?? null) ??
      attacker.classRuntime?.weaponCategory ?? null;
    const qualifyingMelee = ["axe", "hammer", "sword", "god_sword", "dagger", "spear", "staff", "brass_knuckles"].includes(family ?? "");
    if (!qualifyingMelee) {
      return 0;
    }
    const healthRatio = attacker.currentHealth / attacker.maxHealth;
    if (skill.specializationRank >= 5 && healthRatio < 0.22) return 3;
    if (skill.specializationRank >= 4 && family === "axe" && healthRatio < 0.33) return 2;
    return skill.specializationRank >= 2 && healthRatio < 0.46 ? 1 : 0;
  }

  /** Pets, companions and raised minions belong to a player and are never "monsters" for PvE-only skills. */
  private isPlayerOwnedCreature(entity: Combatant): boolean {
    return entity.kind === "mob" && (
      (entity.companionOwnerPlayerId ?? null) !== null || Boolean(entity.companionDogId) ||
      (entity.undead?.ownerPlayerId ?? null) !== null
    );
  }

  private v3PveContextualAttackBonus(attacker: Combatant, target?: Combatant): number {
    const runtime = attacker.classRuntime;
    const skill = runtime?.skillV3;
    if (!runtime || !skill || target?.kind !== "mob" || this.isPlayerOwnedCreature(target)) return 0;
    const now = this.now();
    let bonus = 0;
    if (
      Number(runtime.counters.skillV3HeroismEndsAt ?? 0) > now &&
      !this.isBossMob(target) && target.challengeTier !== "legendary"
    ) bonus += flatRankValue(HEROISM_HERO_ATTACK_BY_RANK, skill.generalSkillRanks.heroism ?? 0);
    if (
      Number(runtime.counters.skillV3HuntsmanEndsAt ?? 0) > now &&
      runtime.counters.skillV3HuntsmanSpecies === target.archetypeKey
    ) bonus += [0, 2, 3, 5][Math.min(3, skill.generalSkillRanks.huntsmans_edge ?? 0)] ?? 0;
    if (Number(runtime.counters.skillV3PursuitEndsAt ?? 0) > now) {
      bonus += [0, 1, 2, 4][Math.min(3, skill.generalSkillRanks.pursuit ?? 0)] ?? 0;
    }
    bonus += Math.max(0, Number(runtime.counters.skillV3TacticsValue ?? 0));
    bonus += rareBeastDragonAttackBonus(skill.rareBeastMasteryRank, target.archetypeKey);
    bonus += this.tidecraftMatchupBonus(attacker, target, "attack");
    bonus += this.leatherworkingMatchupBonus(attacker, target, "attack");
    return bonus;
  }

  private v3PveContextualDefenseBonus(target: Combatant, attacker: Combatant): number {
    const runtime = target.classRuntime;
    const skill = runtime?.skillV3;
    if (!runtime || !skill || attacker.kind !== "mob" || this.isPlayerOwnedCreature(attacker)) return 0;
    let bonus = 0;
    const heroismRank = skill.generalSkillRanks.heroism ?? 0;
    if (
      heroismRank > 0 &&
      (this.isBossMob(attacker) || (heroismRank >= 2 && attacker.challengeTier === "legendary"))
    ) bonus += flatRankValue(HEROISM_BOSS_DEFENSE_BY_RANK, heroismRank);
    if (
      (skill.generalSkillRanks.huntsmans_edge ?? 0) > 0 &&
      Number(runtime.counters.skillV3HuntsmanEndsAt ?? 0) > this.now() &&
      runtime.counters.skillV3HuntsmanSpecies !== attacker.archetypeKey
    ) bonus -= 1;
    bonus += rareBeastDragonDefenseBonus(skill.rareBeastMasteryRank, attacker.archetypeKey);
    bonus += this.tidecraftMatchupBonus(target, attacker, "defense");
    bonus += this.leatherworkingMatchupBonus(target, attacker, "defense");
    bonus += this.deepstoneCaveBonus(target, "defense");
    return bonus;
  }

  /**
   * Legionnaire formation: living shield-bearing players within 225m that are not attacking the Legionnaire,
   * and the party-ally subset of them. (Shielded summons are not modelled: they carry no equipment runtime.)
   */
  private v3LegionnaireFormationCounts(legionnaire: Combatant): { entities: number; allies: number } {
    let entities = 0;
    let allies = 0;
    for (const entityId of this.grid.query(legionnaire.position, V3_LEGIONNAIRE_FORMATION_RANGE_M)) {
      const other = this.entities.get(entityId);
      if (
        !other || other.entityId === legionnaire.entityId || other.kind !== "player" ||
        other.lifeState !== "alive" || !other.classRuntime?.hasShield ||
        other.targetEntityId === legionnaire.entityId ||
        distanceMeters(legionnaire.position, other.position) > V3_LEGIONNAIRE_FORMATION_RANGE_M
      ) continue;
      entities += 1;
      if (this.isValidNearbyVisibleAlly(legionnaire, other, V3_LEGIONNAIRE_FORMATION_RANGE_M)) allies += 1;
    }
    return { entities, allies };
  }

  private v3AggressionDurationMs(player: Combatant): number {
    const skill = player.classRuntime?.skillV3;
    const calmMindRank = skill?.generalSkillRanks.calm_mind ?? 0;
    const calmMindReduction = calmMindRank >= 3 ? 0.42 : calmMindRank >= 2 ? 0.27 : calmMindRank >= 1 ? 0.12 : 0;
    const assassinReduction = skill?.activeSpecializationId === "assassin"
      ? skill.specializationRank >= 5 ? 0.14 : skill.specializationRank >= 4 ? 0.09 : skill.specializationRank >= 2 ? 0.04 : 0
      : 0;
    return Math.round(AGGRESSIVE_FLAG_TRAVEL_LOCK_MS * (1 - calmMindReduction) * (1 - assassinReduction));
  }

  /** Strongest nearby Monk's flat base Speed reduction (meters per second) for this hostile. */
  private v3MonkSlowAura(target: Combatant): number {
    let strongest = 0;
    for (const entityId of this.nearbyEntityIds(target.position, V3_MONK_SLOW_AURA_RADIUS_M)) {
      const monk = this.entities.get(entityId);
      const skill = monk?.classRuntime?.skillV3;
      if (
        !monk || monk.kind !== "player" || monk.entityId === target.entityId ||
        skill?.activeSpecializationId !== "monk" || skill.specializationRank < 2 ||
        !this.hasActiveAuthority(monk) || !this.isAttackPairValid(monk, target) ||
        (target.kind === "player" && this.options.partyAuthority?.sameParty(monk.entityId, target.entityId) === true)
      ) continue;
      strongest = Math.max(
        strongest,
        skill.specializationRank >= 5 ? 26 : skill.specializationRank >= 4 ? 16 : 8
      );
    }
    return strongest;
  }

  private v3ClassDefenseBonuses(
    target: Combatant,
    attacker: Combatant
  ): Readonly<{ body: number; shield: number }> {
    const skill = target.classRuntime?.skillV3;
    if (!skill) return { body: 0, shield: 0 };
    const bodyFamily = equipmentGameplayFamily(target.classRuntime?.chestDefinitionId ?? null);
    const attackerFamily = equipmentGameplayFamily(attacker.classRuntime?.weaponDefinitionId ?? null);
    const rangedAttack = ["bow", "crossbow", "shuriken", "blowdart", "sling", "wand"].includes(attackerFamily ?? "");
    const meleeAttack = !rangedAttack;
    const rank = skill.specializationRank;
    const specialization = skill.activeSpecializationId;
    let body = 0;
    let shield = 0;

    if (
      bodyFamily === null && this.generalRankInZone(target, "martial_arts") > 0 &&
      (target.classRuntime?.heavyArmorPieces ?? 0) === 0 && !target.classRuntime?.hasShield
    ) {
      body += Math.min(EQUIPMENT_LEVEL_CAP, target.level);
    }
    if (specialization === "knight") {
      if (bodyFamily === "breastplate" || bodyFamily === "wyrm_scalemail") body += rank >= 5 ? 3 : rank >= 4 ? 2 : rank >= 2 ? 1 : 0;
      if (target.classRuntime?.hasShield && rangedAttack) shield += rank >= 5 ? 3 : rank >= 3 ? 2 : rank >= 2 ? 1 : 0;
    }
    if (specialization === "legionnaire" && target.classRuntime?.hasShield) {
      shield += rank >= 3 ? 2 : rank >= 2 ? 1 : 0;
      const formation = this.v3LegionnaireFormationCounts(target);
      const perEntity = rank >= 5 ? 0.9 : rank >= 4 ? 0.65 : rank >= 2 ? 0.4 : 0;
      const entityCap = rank >= 5 ? 5 : rank >= 4 ? 3 : rank >= 2 ? 2 : 0;
      shield += Math.min(entityCap, formation.entities * perEntity);
      if (rank >= 2) shield += Math.min(1.5, formation.allies * 0.2);
    }
    if (specialization === "ranger" && bodyFamily === "leather" && !target.classRuntime?.hasShield && meleeAttack) {
      body += rank >= 5 ? 3 : rank >= 3 ? 1 : 0;
    }
    if (specialization === "mercenary" && bodyFamily === "leather" && !target.classRuntime?.hasShield) {
      body += rank >= 3 ? 1 : 0;
      if (rank >= 5 && meleeAttack) body += 1;
    }
    if (specialization === "sentinel" && bodyFamily === "breastplate" && rangedAttack) {
      body += rank >= 5 ? 4 : rank >= 4 ? 3 : rank >= 2 ? 2 : 0;
    }
    if (specialization === "assassin" && bodyFamily === "tunic" && rank >= 4) body += 1;
    if (specialization === "monk" && bodyFamily === "tunic") {
      body += rank >= 5 ? 4 : rank >= 4 ? 3 : rank >= 2 ? 2 : 0;
    }
    return { body, shield };
  }

  private v3DodgeChance(target: Combatant, attacker: Combatant): number {
    const skill = target.classRuntime?.skillV3;
    if (!skill) return 0;
    const runtime = target.classRuntime!;
    const weaponFamily = equipmentGameplayFamily(runtime.weaponDefinitionId) ?? runtime.weaponCategory;
    const bodyFamily = equipmentGameplayFamily(runtime.chestDefinitionId);
    const lightlyEquipped = runtime.heavyArmorPieces === 0 && !runtime.hasShield;
    const generalMartialPermission = bodyFamily === "tunic" && !runtime.hasShield && [
      null, "martial_arts", "shuriken", "blowdart", "brass_knuckles"
    ].includes(weaponFamily);
    const specializationPermission = !runtime.hasShield && (
      (bodyFamily === "tunic" && (
        (skill.activeSpecializationId === "assassin" && weaponFamily === "dagger") ||
        (skill.activeSpecializationId === "monk" && weaponFamily === "sling")
      )) ||
      (skill.activeSpecializationId === "rogue" && bodyFamily === "leather")
    );
    const martialRank = this.generalRankInZone(target, "martial_arts");
    let chance = generalMartialPermission || specializationPermission
      ? (martialRank >= 3 ? 0.28 : martialRank >= 2 ? 0.14 : 0)
      : 0;
    const rank = skill.specializationRank;
    switch (skill.activeSpecializationId) {
      case "ninja":
        if (lightlyEquipped) chance += rank >= 5 ? 0.11 : rank >= 4 ? 0.07 : rank >= 2 ? 0.04 : 0;
        break;
      case "assassin":
        break;
      case "monk":
        break;
      case "rogue":
        break;
      case "druid":
        if (lightlyEquipped) chance += rank >= 5 ? 0.27 : rank >= 3 ? 0.13 : 0;
        break;
    }
    const attackerSkill = attacker.classRuntime?.skillV3;
    const flatAntiDodge = (
      attackerSkill?.activeSpecializationId === "sentinel" &&
      (equipmentGameplayFamily(attacker.classRuntime?.weaponDefinitionId ?? null) === "crossbow" ||
        attacker.classRuntime?.weaponCategory === "crossbow")
    ) ? (attackerSkill.specializationRank >= 5
        ? 0.22
        : attackerSkill.specializationRank >= 3 ? 0.09 : 0) : 0;
    // Frost no longer halves a Ninja's dodge; the Frozen status scales every target's dodge instead.
    return resolveDodgeChance({
      base: chance,
      flatAntiDodge,
      defenderIsActiveNinja: skill.activeSpecializationId === "ninja",
      attackerUsedIceMetalWeapon: false
    }).final * this.frostDodgeMultiplier(target);
  }

  /** Frost: a slowed target's dodge chance is multiplied (x0.85). */
  private frostDodgeMultiplier(target: Combatant): number {
    return target.classRuntime?.effects.some((effect) =>
      effect.kind === "movement_slow" && effect.sourceTechniqueId === "elemental_ice_slow" &&
      effect.endTick >= this.currentTick
    ) ? METAL_PROC_BALANCE.frost.dodgeMultiplier : 1;
  }

  private v2ScheduledBonusApplies(runtime: ClassCombatRuntime, sourceTechniqueId: string): boolean {
    if (["ranger_v2_quick_draw", "ranger_v2_keep_your_distance"].includes(sourceTechniqueId)) {
      return equipmentGameplayFamily(runtime.weaponDefinitionId) === "bow";
    }
    if (sourceTechniqueId === "ninja_v2_razor_edge") return runtime.weaponCategory === "shuriken";
    return true;
  }

  private warriorFlatDefenseBonus(target: Combatant): number {
    const lantern = target.kind === "player"
      ? this.options.dungeonLanternStatBonus?.(target.entityId).defense ?? 0
      : 0;
    const draught = target.kind === "player" && this.battleDraughts.has(target.entityId) ? BATTLE_DRAUGHT_DEFENSE_PENALTY : 0;
    return lantern - draught + this.warriorFlatDefenseBonusBase(target);
  }

  private warriorFlatDefenseBonusBase(target: Combatant): number {
    const runtime = target.classRuntime;
    if (!runtime) return 0;
    if (runtime.skillV3) return this.effectTotal(target, "flat_defense");
    const preferredFamily = ({
      warrior: "breastplate", druid: "leather", ranger: "leather",
      knight: "breastplate", ninja: null, hunter: null
    } as const)[runtime.activeClassId];
    let bonus = preferredFamily && equipmentGameplayFamily(runtime.chestDefinitionId) === preferredFamily
      ? CLASS_MASTERY_DEFENSE_BY_RANK[automaticRank(runtime.masteryRank, [6, 10, 14])]! : 0;
    bonus += this.effectTotal(target, "flat_defense");
    if (runtime.activeClassId === "knight" && runtime.equippedPassives.has("knight_stalwart")) bonus += 1;
    if (runtime.activeClassId === "knight" && runtime.equippedPassives.has("knight_surrounded") &&
      this.validOwnedEnemyCount(target.entityId) >= 2) bonus += 2;
    if (runtime.activeClassId !== "warrior") return bonus;
    if (runtime.equippedPassives.has("warrior_v2_battle_grit") && this.validOwnedEnemyCount(target.entityId) >= 2) {
      bonus += 2;
    }
    if (runtime.equippedPassives.has("warrior_crowd_fighter") && this.validOwnedEnemyCount(target.entityId) >= 2) {
      bonus += 1;
    }
    if (
      runtime.equippedPassives.has("warrior_last_stand") &&
      target.currentHealth / target.maxHealth < WARRIOR_BALANCE.lowHealthThreshold
    ) bonus += 2;
    return bonus;
  }

  private isHuntableAnimal(entity: Combatant): boolean {
    return entity.kind === "mob" && entity.archetypeKey === "wolf" &&
      (entity.entityId.startsWith("wolf:") || entity.entityId.startsWith("mob:wolf-slot:"));
  }

  private techniqueTargetType(definition: TechniqueDefinition): "hostile" | "friendly" | "self" | "friendly_or_hostile" {
    return (definition as TechniqueDefinition & {
      targetType?: "hostile" | "friendly" | "self" | "friendly_or_hostile";
    }).targetType ?? "hostile";
  }

  private resolveV3HostileTarget(
    player: Combatant,
    requestedTargetEntityId?: string,
    requestedTargetMode?: "hostile" | "friendly" | "self" | "position" | "direction"
  ): Combatant {
    if (requestedTargetMode !== undefined && requestedTargetMode !== "hostile") {
      throw new CombatRequestError("ABILITY_TARGET_MODE_INVALID", "General active requires a hostile target");
    }
    const targetId = requestedTargetEntityId ?? player.targetEntityId;
    const target = targetId ? this.entities.get(targetId) : null;
    if (!target || target.entityId === player.entityId || !this.isAttackPairValid(player, target)) {
      throw new CombatRequestError("ABILITY_TARGET_INVALID", "General active requires a living authoritative hostile target");
    }
    if (this.isNinjaInvisible(target)) {
      throw new CombatRequestError("ABILITY_TARGET_INVALID", "General active requires a visible hostile target");
    }
    if (target.kind === "mob") {
      const session = this.pveSessions.get(player.entityId);
      if (!session || !this.isEnemyValidForSession(session, target.entityId)) {
        throw new CombatRequestError("ABILITY_TARGET_INVALID", "General active target is not in the authoritative encounter");
      }
    } else {
      this.validateAttackPair(player, target, false);
    }
    return target;
  }

  private currentPvpAbilityTarget(
    player: Combatant,
    definition: TechniqueDefinition,
    requestedTargetEntityId?: string,
    requestedTargetMode?: AbilityTargetMode
  ): Combatant | null {
    const targetType = this.techniqueTargetType(definition);
    const targetMode = requestedTargetMode ?? (
      targetType === "self" ? "self" : targetType === "friendly" ? "friendly" : "hostile"
    );
    if (targetMode !== "hostile") return null;
    const target = player.targetEntityId
      ? this.entities.get(player.targetEntityId) ?? null
      : null;
    if (target?.kind !== "player") return null;
    if (targetType !== "hostile" && targetType !== "friendly_or_hostile") {
      throw new CombatRequestError(
        "ABILITY_TARGET_MODE_INVALID",
        "That target mode is not valid for this ability"
      );
    }
    if (requestedTargetEntityId && requestedTargetEntityId !== target.entityId) {
      throw new CombatRequestError(
        "ABILITY_TARGET_NOT_FOCUS",
        "Hostile ability target must be the active combat target"
      );
    }
    if (this.isNinjaInvisible(target)) {
      throw new CombatRequestError("ABILITY_TARGET_INVALID", "Ability requires a visible hostile target");
    }
    this.validateAttackPair(player, target, false);
    return target;
  }

  private resolveDirectSupportTarget(
    player: Combatant,
    definition: TechniqueDefinition,
    requestedTargetEntityId?: string,
    requestedTargetMode?: AbilityTargetMode
  ): Combatant | null {
    const targetType = this.techniqueTargetType(definition);
    const targetMode = requestedTargetMode ?? (
      targetType === "self" ? "self" : targetType === "friendly" ? "friendly" : "hostile"
    );
    if (targetMode !== "self" && targetMode !== "friendly") return null;
    if (
      targetType !== "friendly_or_hostile"
      && targetType !== targetMode
      && !(targetType === "friendly" && targetMode === "self")
    ) {
      throw new CombatRequestError(
        "ABILITY_TARGET_MODE_INVALID",
        "That target mode is not valid for this ability"
      );
    }
    if (targetMode === "self") return player;
    const target = requestedTargetEntityId
      ? this.entities.get(requestedTargetEntityId)
      : null;
    if (
      !target
      || target.entityId === player.entityId
      || !this.isValidVisibleAlly(player, target)
    ) {
      throw new CombatRequestError(
        "ABILITY_FRIENDLY_TARGET_INVALID",
        "Friendly target is not a visible eligible party member"
      );
    }
    return target;
  }

  private queuePvpAbility(
    player: Combatant,
    target: Combatant,
    definition: TechniqueDefinition,
    reset: boolean
  ): CombatActionResult {
    this.requireImmediateAbilityWeaponReady(player, target, definition);
    const runtime = requireClassCombatRuntime(player);
    if (runtime.queuedAbility?.activationCommitted) {
      throw new CombatRequestError(
        "EMPOWERMENT_ALREADY_ARMED",
        "A next-attack empowerment is already armed"
      );
    }
    const cooldownEnd = reset
      ? runtime.cooldownEndsAt[BASIC_ATTACK_RESET_COOLDOWN_GROUP] ?? 0
      : runtime.cooldownEndsAt[definition.id] ?? 0;
    if (cooldownEnd > this.now()) {
      throw new CombatRequestError("ABILITY_COOLDOWN", "Ability is still cooling down");
    }
    const cost = this.rageCost(runtime, definition);
    const availableResource =
      runtime.rage + (runtime.queuedAbility?.reservedRage ?? 0);
    if (availableResource < cost) {
      throw new CombatRequestError(
        `${runtime.resourceId.toUpperCase()}_INSUFFICIENT`,
        `Not enough ${runtime.resourceId.charAt(0).toUpperCase()}${runtime.resourceId.slice(1)}`
      );
    }
    this.refundQueue(runtime);
    if (reset) {
      this.commitAbilityActivation(player, definition, { target });
    } else {
      runtime.rage -= cost;
      runtime.reservedRage = cost;
    }
    runtime.queuedAbility = {
      abilityId: definition.id,
      targetEntityId: target.entityId,
      queuedAtTick: this.currentTick,
      reservedRage: reset ? 0 : cost,
      activationCommitted: reset
    };
    this.markDirty(player);
    this.rememberClassRuntime(player);
    return this.combatActionState(player);
  }

  private resolvedTargetMode(player: Combatant, target: Combatant): AbilityTargetMode {
    if (target.entityId === player.entityId) return "self";
    return target.kind === "player" ? "friendly" : "hostile";
  }

  private resolveTechniqueTarget(
    player: Combatant,
    session: PveCombatSession,
    definition: TechniqueDefinition,
    requestedTargetEntityId?: string,
    requestedTargetMode?: AbilityTargetMode
  ): Combatant {
    const targetType = this.techniqueTargetType(definition);
    const targetMode = requestedTargetMode ?? (
      targetType === "self" ? "self" : targetType === "friendly" ? "friendly" : "hostile"
    );
    if (targetType !== "friendly_or_hostile" && targetType !== targetMode) {
      if (!(targetType === "friendly" && targetMode === "self")) {
        throw new CombatRequestError("ABILITY_TARGET_MODE_INVALID", "That target mode is not valid for this ability");
      }
    }
    if (targetMode === "self") return player;
    if (targetMode === "friendly") {
      const target = requestedTargetEntityId
        ? this.entities.get(requestedTargetEntityId)
        : null;
      if (
        !target ||
        target.entityId === player.entityId ||
        !this.isValidVisibleAlly(player, target)
      ) {
        throw new CombatRequestError("ABILITY_FRIENDLY_TARGET_INVALID", "Friendly target is not a visible eligible party member");
      }
      return target;
    }
    const hostileId = requestedTargetEntityId ?? session.focusTargetEntityId;
    if (requestedTargetEntityId && requestedTargetEntityId !== session.focusTargetEntityId) {
      throw new CombatRequestError("ABILITY_TARGET_NOT_FOCUS", "Hostile ability target must be the authoritative focus");
    }
    const target = hostileId ? this.entities.get(hostileId) : null;
    if (!target || !this.isAttackPairValid(player, target) || !this.isEnemyValidForSession(session, target.entityId)) {
      throw new CombatRequestError("ABILITY_TARGET_INVALID", "Ability requires a living authoritative hostile target");
    }
    return target;
  }

  private resolveTauntAction(player: Combatant, session: PveCombatSession): void {
    if (this.tauntCooldownEnd(player) > this.now()) {
      throw new CombatRequestError("ABILITY_COOLDOWN", "Universal Taunt is still cooling down");
    }
    session.playerAggroActive = true;
    const view = this.authoritativeViewCircle(player);
    if (view.generation !== session.viewGeneration) {
      throw new CombatRequestError("TAUNT_VIEW_GENERATION_STALE", "The active view circle changed before Taunt resolved");
    }
    const activationPosition = { ...player.position };
    const tauntRadiusM = universalTauntRadiusM(view.radiusM);
    const candidates = this.grid.query(activationPosition, tauntRadiusM)
      .map((entityId) => this.entities.get(entityId))
      .filter((candidate): candidate is Combatant => Boolean(
        candidate &&
        candidate.kind === "mob" &&
        candidate.lifeState === "alive" &&
        this.isCombatEligibleMob(candidate) &&
        (candidate.aggroOwnerPlayerId === null || (
          (candidate.aggroOwnerPlayerId === player.entityId &&
            candidate.aggroOwnerSessionId === session.sessionId &&
            candidate.aggroOwnerSessionGeneration === session.generation) ||
          this.options.partyAuthority?.sameParty(candidate.aggroOwnerPlayerId, player.entityId) === true
        )) &&
        distanceMeters(candidate.position, activationPosition) <= tauntRadiusM &&
        distanceMeters(candidate.position, view.center) <= view.radiusM &&
        this.isAttackPairValid(player, candidate)
      ))
      .sort((left, right) =>
        Number(right.entityId === session.focusTargetEntityId) -
          Number(left.entityId === session.focusTargetEntityId) ||
        distanceMeters(activationPosition, left.position) - distanceMeters(activationPosition, right.position) ||
        left.entityId.localeCompare(right.entityId)
      );
    const availableSlots = Math.max(0, MAX_PVE_ENEMY_QUEUE_SIZE - session.enemyIds.size);
    const newCandidates = candidates.filter((candidate) => !session.enemyIds.has(candidate.entityId));
    session.lastTauntExcludedByCap = Math.max(0, newCandidates.length - availableSlots);
    const encounterSizeBeforeTaunt = session.enemyIds.size;
    for (const candidate of candidates) {
      if (
        candidate.aggroOwnerPlayerId === null ||
        this.options.partyAuthority?.sameParty(candidate.aggroOwnerPlayerId, player.entityId)
      ) this.claimMobAggro(candidate, player, session);
      const ownedBySession =
        candidate.aggroOwnerSessionId === session.sessionId &&
        candidate.aggroOwnerSessionGeneration === session.generation;
      if (ownedBySession && session.enemyIds.has(candidate.entityId)) {
        session.tauntedEnemyIds.add(candidate.entityId);
        if (candidate.targetEntityId !== player.entityId) {
          this.setTarget(candidate, player.entityId);
        }
        if (this.joinMobTactics(candidate, player)) {
          // Managed: tactics walks it to a slot; no queue, no chase.
        } else if (distanceMeters(candidate.position, player.position) <= candidate.attackRangeM) {
          this.appendEnemy(session, candidate.entityId);
        } else {
          session.pursuingEnemyIds.add(candidate.entityId);
          this.startChasing(candidate);
        }
      }
    }
    session.lastMeaningfulEngagementAtMs = this.now();
    const enemiesAdded = session.enemyIds.size - encounterSizeBeforeTaunt;
    if (enemiesAdded > 0) this.markSessionParticipation(player.entityId);
    session.telemetry.recordTauntResult({
      eligibleCandidates: candidates.length,
      enemiesAdded,
      excludedByCap: session.lastTauntExcludedByCap
    });
    session.telemetry.captureInitialQueueSize(session.enemyQueue.length);
    this.emitTauntActivatedEvent(player.entityId, activationPosition, tauntRadiusM);
    player.tauntCooldownEndsAt = this.now() + UNIVERSAL_TAUNT_COOLDOWN_MS;
    if (player.classRuntime) {
      player.classRuntime.cooldownEndsAt[UNIVERSAL_TAUNT_ID] = player.tauntCooldownEndsAt;
      this.rememberClassRuntime(player);
    }
    session.phase = "waiting_player";
    this.markDirty(player);
    session.telemetry.recordPlayerAction({
      action: "taunt",
      atMs: this.telemetryTime(session),
      abilityId: UNIVERSAL_TAUNT_ID
    });
    if (!this.maybeEndPveSession(player, session)) this.queueEnemyAction(player, session, true);
  }

  private queueEnemyAction(
    player: Combatant,
    session: PveCombatSession,
    preserveScheduledBasic = false
  ): void {
    if (preserveScheduledBasic) {
      if (player.scheduledAttackTick === null && session.focusTargetEntityId) {
        const dueTick = Math.max(
          this.currentTick + 1,
          player.nextEligibleAttackTick,
          session.nextBasicAttackTick ?? this.currentTick + 1
        );
        session.nextBasicAttackTick = dueTick;
        this.scheduleAttack(player, dueTick);
      }
    } else {
      this.invalidateScheduledAttack(player);
    }
    if (session.enemyQueue.length === 0) {
      session.phase = "waiting_player";
      session.enemyActionAtTick = null;
      if (!this.maybeEndPveSession(player, session) && session.focusTargetEntityId) {
        const dueTick = Math.max(
          this.currentTick + 1,
          session.nextBasicAttackTick ?? this.currentTick + this.pveTurnStepTicks * 2
        );
        session.nextBasicAttackTick = dueTick;
        this.scheduleAttack(player, dueTick);
      }
      return;
    }
    session.phase = "enemy_pending";
    session.enemyActionAtTick ??= session.playerTurnAnchorTick === null
      ? this.currentTick + this.pveTurnStepTicks
      : session.playerTurnAnchorTick + this.pveTurnStepTicks;
    this.noteSessionChanged(player, session);
  }

  private invalidateScheduledAttack(player: Combatant): void {
    player.scheduledAttackTick = null;
    player.attackScheduleGeneration += 1;
  }

  private tauntCooldownEnd(player: Combatant): number {
    return Math.max(
      player.tauntCooldownEndsAt,
      player.classRuntime?.cooldownEndsAt[UNIVERSAL_TAUNT_ID] ?? 0
    );
  }

  private resolveAttack(work: ScheduledWork): void {
    const attacker = this.entities.get(work.entityId);
    if (
      !attacker ||
      attacker.scheduledAttackTick !== work.dueTick ||
      attacker.attackScheduleGeneration !== work.generation
    ) {
      return;
    }
    attacker.scheduledAttackTick = null;
    if (attacker.kind === "mob" && this.options.mobAiEnabled?.() === false) {
      this.scheduleAttack(attacker, this.currentTick + 1);
      return;
    }
    if (attacker.kind === "mob" && this.isMobInHitstun(attacker)) {
      // Swing hitstun: the strike waits until the mob recovers.
      this.scheduleAttack(attacker, attacker.special!.hitstunUntilTick);
      return;
    }
    const target = attacker.targetEntityId
      ? this.entities.get(attacker.targetEntityId)
      : undefined;
    if (this.isPlayerReserved(target?.entityId ?? "")) {
      this.scheduleAttack(attacker, this.currentTick + 1);
      return;
    }
    if (!target || !this.isAttackPairValid(attacker, target)) {
      if (attacker.kind === "player" && this.pveSessions.has(attacker.entityId)) {
        this.repairFocus(this.pveSessions.get(attacker.entityId)!);
      } else {
        this.clearTarget(attacker);
      }
      return;
    }
    if (!this.hasActiveAuthority(attacker)) {
      this.clearTarget(attacker);
      return;
    }
    if (
      this.pvpAutoRetaliationTargets.get(attacker.entityId) === target.entityId &&
      this.options.pvpIsFighting?.(attacker.entityId, target.entityId) === false
    ) {
      // The fight that started the automatic retaliation is over.
      this.clearTarget(attacker);
      return;
    }
    if (
      attacker.kind === "player" &&
      target.kind === "mob" &&
      target.aggroOwnerPlayerId !== null &&
      target.aggroOwnerPlayerId !== attacker.entityId &&
      !this.options.partyAuthority?.sameParty(target.aggroOwnerPlayerId, attacker.entityId) &&
      !this.options.isSharedMobCombat?.(target.entityId)
    ) {
      this.clearTarget(attacker);
      const session = this.pveSessions.get(attacker.entityId);
      if (session) {
        session.focusTargetEntityId = null;
        this.maybeEndPveSession(attacker, session);
      }
      return;
    }
    if (
      attacker.kind === "player" &&
      this.resolveAutomaticWeaponSwitch(attacker, target)
    ) {
      return;
    }
    const meleeWindup = attacker.kind === "mob" && this.usesMeleeWindup(attacker, target);
    if (meleeWindup && this.pendingMeleeStrikeFor(attacker, target)) {
      // The telegraphed strike resolves against its cone wherever the target went: no range gate here.
      this.activeChases.delete(attacker.entityId);
      attacker.activityState = "attacking";
      if (attacker.v2SkipNextAttackSourceId) {
        delete attacker.v2SkipNextAttackSourceId;
        attacker.special!.pendingBasicStrike = null;
      } else {
        this.resolvePendingMeleeStrike(attacker, target);
      }
      attacker.nextEligibleAttackTick = this.currentTick + attacker.attackIntervalTicks;
      this.markDirty(attacker);
      if (attacker.lifeState === "alive" && attacker.targetEntityId === target.entityId) {
        // The next windup starts early so the next strike still lands exactly one interval later.
        this.scheduleAttack(attacker, attacker.nextEligibleAttackTick - this.meleeWindupTicks);
      }
      return;
    }
    const targetIsInRange = this.grid
      .query(
        attacker.position,
        attacker.attackRangeM + (
          attacker.kind === "mob" && attacker.activityState === "attacking"
            ? MOB_ATTACK_HOLD_RANGE_BUFFER_M
            : 0
        )
      )
      .includes(target.entityId);
    if (!targetIsInRange) {
      if (attacker.kind === "mob") {
        this.startChasing(attacker);
      } else {
        this.activeChases.delete(attacker.entityId);
        attacker.chaseDestination = null;
        this.markDirty(attacker);
        // Keep walking after a player target that moved since Attack was pressed.
        if (target.kind === "player" &&
          this.pendingPlayerAttackApproachStops.get(attacker.entityId) === target.entityId) {
          this.approachAttackTarget(attacker, target);
        }
      }
      const session = attacker.kind === "player" ? this.pveSessions.get(attacker.entityId) : null;
      if (session && this.currentTick >= attacker.nextEligibleAttackTick) {
        session.nextBasicAttackTick = attacker.nextEligibleAttackTick;
      }
      const retryTick = this.currentTick + COMBAT_CHASE_REEVALUATE_TICKS;
      this.scheduleAttack(
        attacker,
        attacker.nextEligibleAttackTick > this.currentTick
          ? Math.min(retryTick, attacker.nextEligibleAttackTick)
          : retryTick
      );
      return;
    }
    // A melee windup eats into the interval: it may start this many ticks before the strike is due.
    const windupLeadTicks = meleeWindup ? this.meleeWindupTicks : 0;
    if (this.currentTick < attacker.nextEligibleAttackTick - windupLeadTicks) {
      this.scheduleAttack(attacker, attacker.nextEligibleAttackTick - windupLeadTicks);
      return;
    }
    const stunEndTick = attacker.kind === "player" ? this.stunEndTick(attacker) : null;
    if (stunEndTick !== null) {
      this.scheduleAttack(attacker, stunEndTick + 1);
      return;
    }

    if (attacker.kind === "mob" && attacker.v2SkipNextAttackSourceId) {
      delete attacker.v2SkipNextAttackSourceId;
      attacker.nextEligibleAttackTick = this.currentTick + attacker.attackIntervalTicks;
      if (attacker.targetEntityId === target.entityId) this.scheduleAttack(attacker, attacker.nextEligibleAttackTick);
      this.markDirty(attacker);
      return;
    }

    this.activeChases.delete(attacker.entityId);
    attacker.activityState = "attacking";
    if (meleeWindup) {
      // Telegraph now; the strike resolves when it is due (never sooner than the full windup).
      const dueTick = Math.max(this.currentTick + this.meleeWindupTicks, attacker.nextEligibleAttackTick);
      this.beginMeleeWindup(attacker, target, dueTick);
      this.scheduleAttack(attacker, dueTick);
      this.markDirty(attacker);
      return;
    }

    const pveSession = attacker.kind === "player" && target.kind === "mob"
      ? this.pveSessions.get(attacker.entityId)
      : null;
    if (pveSession) {
      const enemyActionAlreadyPending = pveSession.phase === "enemy_pending";
      const pendingEnemyActionAt = pveSession.enemyActionAtTick;
      if (pveSession.phase !== "waiting_player" && !enemyActionAlreadyPending) return;
      if (pveSession.pendingNormal) {
        const pending = pveSession.pendingNormal;
        pveSession.pendingNormal = null;
        try {
          if (!this.tryResolveNormalAction(attacker, pveSession, pending)) {
            pveSession.pendingNormal = pending;
          }
        } catch (error) {
          if (!(error instanceof CombatRequestError)) throw error;
          this.repairFocus(pveSession);
        }
        if (!this.pveSessions.has(attacker.entityId)) return;
      }
      const queued = attacker.classRuntime?.queuedAbility;
      if (queued && queued.targetEntityId === target.entityId) {
        this.resolveAbility(attacker, target, requireTechniqueDefinition(queued.abilityId));
        this.afterNormalPlayerAction(attacker, pveSession);
      }
      const runtimeArmed = attacker.classRuntime?.queuedAbility?.activationCommitted === true &&
        requireTechniqueDefinition(attacker.classRuntime.queuedAbility.abilityId).activation === "armed"
        ? attacker.classRuntime.queuedAbility
        : null;
      const pendingAbilityId = pveSession.pendingResetAbilityId ?? runtimeArmed?.abilityId ?? null;
      const pendingEmpowerment = pendingAbilityId ? {
        abilityId: pendingAbilityId,
        targetEntityId: pveSession.pendingResetTargetEntityId ?? undefined,
        targetMode: pveSession.pendingResetTargetMode ?? undefined,
        sourceActionSequence: pveSession.pendingResetActionSequence ??
          (Number(attacker.classRuntime?.counters.v2ArmedActionSequence ?? 0) || undefined)
      } : null;
      this.clearPendingEmpowerment(pveSession);
      if (runtimeArmed && attacker.classRuntime) {
        attacker.classRuntime.queuedAbility = null;
        delete attacker.classRuntime.counters.v2ArmedActionSequence;
      }
      let empowered = false;
      if (pendingEmpowerment) {
        try {
          const definition = this.validateAbilityInput(
            attacker,
            pendingEmpowerment.abilityId,
            requireTechniqueDefinition(pendingEmpowerment.abilityId).activation !== "armed",
            { skipReadiness: true }
          );
          this.repairFocus(pveSession);
          const empoweredTarget = definition.activation === "armed"
            ? target
            : this.resolveTechniqueTarget(
                attacker,
                pveSession,
                definition,
                pendingEmpowerment.targetEntityId,
                pendingEmpowerment.targetMode
              );
          const targetMode = this.resolvedTargetMode(attacker, empoweredTarget);
          const range = targetMode === "friendly" || targetMode === "self"
            ? FRIENDLY_TARGET_RANGE_M
            : attacker.attackRangeM;
          if (
            empoweredTarget.entityId !== attacker.entityId &&
            !this.grid.query(attacker.position, range).includes(empoweredTarget.entityId)
          ) {
            throw new CombatRequestError("EMPOWER_TARGET_OUT_OF_RANGE", "Empowered attack target is out of range");
          }
          if (definition.activation === "armed") {
            const attackContext: AttackResolutionContext = {};
            this.resolveBasicAttack(attacker, empoweredTarget, false, attackContext);
            const resolvedTarget = this.entities.get(attackContext.resolvedTargetEntityId ?? empoweredTarget.entityId) ?? empoweredTarget;
            this.resolveAbility(attacker, resolvedTarget, definition, {
              activationCommitted: true,
              scheduledArmed: true,
              attackContext,
              ...(pendingEmpowerment.sourceActionSequence === undefined ? {} : {
                sourceActionSequence: pendingEmpowerment.sourceActionSequence
              })
            });
          } else {
            this.resolveAbility(attacker, empoweredTarget, definition, { activationCommitted: true });
          }
          empowered = true;
        } catch (error) {
          if (!(error instanceof CombatRequestError)) throw error;
        }
      }
      if (!empowered) this.resolveBasicAttack(attacker, target);
      this.anchorPlayerTurn(attacker, pveSession);
      if (enemyActionAlreadyPending) {
        pveSession.phase = "enemy_pending";
        pveSession.enemyActionAtTick = pendingEnemyActionAt ?? this.currentTick + this.pveTurnStepTicks;
      }
      this.markDirty(attacker);
      if (pveSession.enemyQueue.length === 0 && this.maybeEndPveSession(attacker, pveSession)) return;
      if (enemyActionAlreadyPending) {
        this.noteSessionChanged(attacker, pveSession);
        return;
      }
      pveSession.phase = "waiting_player";
      if (!this.maybeEndPveSession(attacker, pveSession)) this.queueEnemyAction(attacker, pveSession);
      return;
    }

    const armedSession = attacker.kind === "player" ? this.pveSessions.get(attacker.entityId) : null;
    const runtimeArmed = attacker.classRuntime?.queuedAbility?.activationCommitted === true &&
      requireTechniqueDefinition(attacker.classRuntime.queuedAbility.abilityId).activation === "armed"
      ? attacker.classRuntime.queuedAbility
      : null;
    const armedAbilityId = armedSession?.pendingResetAbilityId ?? runtimeArmed?.abilityId ?? null;
    if (armedAbilityId && requireTechniqueDefinition(armedAbilityId).activation === "armed") {
      const actionSequence = armedSession?.pendingResetActionSequence ??
        (Number(attacker.classRuntime?.counters.v2ArmedActionSequence ?? 0) || undefined);
      if (armedSession) this.clearPendingEmpowerment(armedSession);
      if (attacker.classRuntime) {
        attacker.classRuntime.queuedAbility = null;
        delete attacker.classRuntime.counters.v2ArmedActionSequence;
      }
      const attackContext: AttackResolutionContext = {};
      this.resolveBasicAttack(attacker, target, false, attackContext);
      const resolvedTarget = this.entities.get(attackContext.resolvedTargetEntityId ?? target.entityId) ?? target;
      this.resolveAbility(attacker, resolvedTarget, requireTechniqueDefinition(armedAbilityId), {
        activationCommitted: true,
        scheduledArmed: true,
        attackContext,
        ...(actionSequence === undefined ? {} : { sourceActionSequence: actionSequence })
      });
    } else {
      const queued = attacker.classRuntime?.queuedAbility;
      if (queued && queued.targetEntityId === target.entityId) {
      const activationCommitted = queued.activationCommitted === true;
      if (activationCommitted && attacker.classRuntime) {
        attacker.classRuntime.queuedAbility = null;
        attacker.classRuntime.reservedRage = 0;
      }
      this.resolveAbility(
        attacker,
        target,
        requireTechniqueDefinition(queued.abilityId),
        { activationCommitted }
      );
      } else {
        this.resolveBasicAttack(attacker, target);
      }
    }
    attacker.nextEligibleAttackTick = this.currentTick + attacker.attackIntervalTicks;
    this.markDirty(attacker);
    if (target.currentHealth > 0) {
      this.establishRetaliation(target, attacker);
    }
    if (attacker.lifeState === "alive" && attacker.targetEntityId === target.entityId) {
      this.scheduleAttack(attacker, attacker.nextEligibleAttackTick);
    }
  }

  private establishRetaliation(target: Combatant, attacker: Combatant): void {
    if (target.kind === "mob" && attacker.kind === "player") {
      const session = this.pveSessions.get(attacker.entityId);
      if (session && target.aggroOwnerPlayerId === null) {
        this.claimMobAggro(target, attacker, session);
        this.appendEnemy(session, target.entityId);
      }
      return;
    }
    if (target.kind === "player" || target.undead) return;
    if (!target.retaliates || target.attackDamage <= 0 || target.targetEntityId !== null) {
      return;
    }
    this.setTarget(target, attacker.entityId);
    target.nextEligibleAttackTick = Math.max(
      target.nextEligibleAttackTick,
      this.currentTick + target.attackIntervalTicks
    );
    this.scheduleAttack(target, target.nextEligibleAttackTick);
  }

  /**
   * An Aggressive player who is struck by another player hits back
   * automatically, like a retaliating monster: only when they have no target
   * of their own (an explicit target is never overridden), and only through
   * the normal attack-pair gates (trust shield, zone/region, view) plus
   * arrival protection on either side. The target is dropped again once the
   * fight between them ends, so it never becomes a standing revenge attack.
   */
  private autoRetaliatePvp(victim: Combatant, attacker: Combatant): void {
    if (
      victim.kind !== "player" || attacker.kind !== "player" ||
      victim.lifeState !== "alive" || victim.currentHealth <= 0 ||
      victim.targetEntityId !== null ||
      this.flagArrivalProtectionUntil(victim.entityId) !== null ||
      this.flagArrivalProtectionUntil(attacker.entityId) !== null ||
      !this.isAttackPairValid(victim, attacker)
    ) return;
    this.setTarget(victim, attacker.entityId);
    this.pvpAutoRetaliationTargets.set(victim.entityId, attacker.entityId);
    victim.nextEligibleAttackTick = Math.max(
      victim.nextEligibleAttackTick,
      this.currentTick + victim.attackIntervalTicks
    );
    this.scheduleAttack(victim, victim.nextEligibleAttackTick);
  }

  private defeat(target: Combatant, sourceEntityId: string, sourceTechniqueId: string | null = null): void {
    const source = this.entities.get(sourceEntityId);
    this.emitCombatAnalyticsEvent({
      kind: "defeat",
      context:
        source?.kind === "player" && target.kind === "player"
          ? "pvp_open_world"
          : "pve",
      actorId: sourceEntityId,
      actorKind: source?.kind ?? "system",
      targetId: target.entityId,
      targetKind: target.kind,
      actorLevel: source?.level ?? null,
      targetLevel: target.level,
      actorClassId: source?.classRuntime?.activeClassId ?? null,
      actorSubclassId: source?.classRuntime?.subclassId ?? null,
      targetClassId: target.classRuntime?.activeClassId ?? null,
      targetSubclassId: target.classRuntime?.subclassId ?? null,
      actorWeaponInstanceId:
        source?.equipmentCombatState?.activeWeaponInstanceId ?? null,
      damageBeforeMitigation: null,
      damageApplied: null,
      mitigationBySource: {},
      sourceTechniqueId: null,
      distanceM: source ? distanceMeters(source.position, target.position) : null,
      targetHealthAfter: 0
    });
    if (target.kind === "player") {
      this.breakFlagArrivalProtection(target.entityId);
      this.endPveSession(target, true, "player_defeated");
    } else {
      this.cancelMobPendingActions(target);
      this.removeEnemyFromAllSessions(target.entityId);
    }
    this.clearTarget(target);
    this.cancelTargeters(target.entityId);
    target.scheduledAttackTick = null;
    target.attackScheduleGeneration += 1;
    target.lifeGeneration += 1;
    target.currentHealth = 0;
    target.lifeState = target.kind === "player" ? "respawning" : "defeated";
    target.activityState = "idle";
    if (target.kind === "player" && target.classRuntime) {
      target.classRuntime.effects = target.classRuntime.effects.filter(
        (effect) => !isHarmfulStatusKind(effect.kind) && effect.kind !== "healing_shield"
      );
    }
    this.markDirty(target);
    this.emitEvent("DEFEATED", sourceEntityId, target.entityId, undefined, 0);
    const killedByInscription = this.recordInscriptionDefeat(source, target);
    if (target.kind === "player") {
      const deathId = randomUUID();
      target.deathPenaltyOperationKey = `player-death:${deathId}`;
      target.respawnAvailableAt = this.now() + PLAYER_RESPAWN_DELAY_MS;
      this.rememberProfile(target);
      const revenantArmor = this.wearsRevenantArmor(target);
      if (revenantArmor && this.revenantMetalHandler) {
        try {
          this.revenantMetalHandler.onRevenantArmorDeath({
            ownerPlayerId: target.entityId,
            deathOperationKey: target.deathPenaltyOperationKey,
            position: { ...target.position },
            regionCode: target.regionCode,
            zoneId: target.zoneId,
            killerEntityId: source && source.entityId !== target.entityId ? source.entityId : null,
            // Max HP here is before this death's PvP penalty.
            snapshot: this.lichSnapshot(target)
          });
        } catch {
          // Revenant Metal observers are isolated from the authoritative combat tick.
        }
      }
      const killerPlayerId = this.owningPlayerId(source, target);
      const momentum = this.mercenaryKillMomentum.get(target.entityId);
      this.mercenaryKillMomentum.delete(target.entityId);
      this.options.onPlayerDefeated?.(
        target.entityId,
        deathId,
        killerPlayerId,
        {
          revenantArmor,
          ...(killedByInscription ? { killedByInscription } : {}),
          ...(momentum && momentum.killerEntityId === killerPlayerId
            ? { mercenaryMomentum: { rank: momentum.rank, stacks: momentum.stacks } }
            : {}),
          goldEligible: killerPlayerId !== null && source?.kind === "player" &&
            source.entityId === killerPlayerId && !isOwnedUnitTechnique(sourceTechniqueId)
        }
      );
    } else {
      this.processMobDefeatGimmicks(target, sourceEntityId);
      this.emitEvent("MOB_REMOVED", target.entityId, target.entityId);
      this.removeEntity(target.entityId, true);
    }
  }

  private emitCombatAnalyticsEvent(event: CombatAnalyticsEvent): void {
    try {
      this.options.onCombatAnalyticsEvent?.(event);
    } catch {
      // Telemetry observers are deliberately isolated from combat authority.
    }
  }

  private beginDefeat(
    target: Combatant,
    attacker: Combatant | null,
    bleeding: boolean,
    sourceTechniqueId: string,
    attackerEntityId = attacker?.entityId ?? ""
  ): void {
    if (attackerEntityId.length === 0) return;
    if (target.kind === "mob" && this.tryReassemble(target)) return;
    if (target.kind === "mob" && (target.special?.splitChild || target.undead || target.noRewards)) {
      // Slimelets, Revenant Metal undead and scripted boss adds are not reward sources.
      this.noteRevenantWeaponKillingBlow(attacker, target, sourceTechniqueId);
      this.defeat(target, attackerEntityId, sourceTechniqueId);
      return;
    }
    if (target.kind === "player" && attacker?.kind === "player") {
      // Momentum is cleared by the defeat below; keep the stacks for the Mercenary kill XP.
      const stacks = this.v3MercenaryMomentumStacks(attacker, target);
      if (stacks > 0) {
        this.mercenaryKillMomentum.set(target.entityId, {
          killerEntityId: attacker.entityId,
          rank: attacker.classRuntime!.skillV3!.specializationRank,
          stacks
        });
      }
    }
    this.clearV3MercenaryMomentumForDefeat(target.entityId);
    if (target.kind === "player" || !this.options.onDefeatSettlementCandidate) {
      this.resolveBloodRushTargetDefeat(target);
      this.noteRevenantWeaponKillingBlow(attacker, target, sourceTechniqueId);
      this.defeat(target, attackerEntityId, sourceTechniqueId);
      if (attacker?.kind === "player" && attacker.classRuntime) {
        this.onEnemyDefeated(attacker, target, bleeding, sourceTechniqueId);
      } else {
        const owner = this.ownedUnitKillOwner(attacker, target);
        if (owner) this.resolveV3SecondWind(owner);
      }
      return;
    }
    if (this.pendingMobDefeats.has(target.entityId)) {
      return;
    }
    this.mergeHolyArcHealCredits(target.entityId);
    const contributions = [...(this.contributionsByMob.get(target.entityId) ?? new Map())]
      .map(([entityId, damage]) => ({ entityId, damage }))
      .sort((left, right) => left.entityId.localeCompare(right.entityId));
    const xpAnchor = combatXpAnchor(target.archetypeKey!);
    const participantClassIds = Object.fromEntries(contributions.flatMap((entry) => {
      const activeClassId = this.entities.get(entry.entityId)?.classRuntime?.activeClassId;
      return activeClassId ? [[entry.entityId, activeClassId]] : [];
    }));
    const candidate: CombatDefeatSettlementCandidate = {
      settlementKey: `${target.entityId}:defeat:${target.lifeGeneration + 1}`,
      defeatedEntityId: target.entityId,
      defeatGeneration: target.lifeGeneration + 1,
      eligibleParticipantIds: contributions.map((entry) => entry.entityId),
      contributions,
      serverTick: this.currentTick,
      mobArchetype: target.archetypeKey!,
      ...(target.bossOwnership ? { bossOwnership: { ...target.bossOwnership } } : {}),
      mobLevel: target.level,
      xpPolicyVersion: xpAnchor.xpPolicyVersion,
      itemRewardPolicyVersion: COMBAT_ITEM_REWARD_POLICY_VERSION,
      targetBasicHitCount: xpAnchor.targetBasicHitCount,
      baseXpPool: xpAnchor.baseXpPool,
      participantClassIds,
      classXpPolicyVersion: CLASS_XP_POLICY_VERSION,
      baseClassXpPool: target.archetypeKey === "training_dummy"
        ? 0
        : CLASS_XP_PER_TARGET_BASIC_HIT * xpAnchor.targetBasicHitCount,
      ...(target.challengeTier ? { mobTier: target.challengeTier } : {}),
      ...(target.combatBalanceVersion
        ? { mobBalanceVersion: target.combatBalanceVersion }
        : {}),
      ...(attacker?.kind === "player" || contributions.some((entry) => entry.entityId === attackerEntityId)
        ? { defeatingPlayerId: attackerEntityId }
        : {}),
      lootLocation: {
        regionCode: target.regionCode.startsWith("interior:")
          ? target.regionCode
          : packageIdForPosition(target.position),
        zoneId: target.zoneId.startsWith("interior:")
          ? target.zoneId
          : zoneIdForPosition(target.position),
        position: { ...target.position }
      },
      ...(target.populationAuthority
        ? { populationAuthority: { ...target.populationAuthority } }
        : {}),
      ...(target.summoned ? { summoned: true } : {})
    };
    const token = Symbol(candidate.settlementKey);
    this.pendingMobDefeats.set(target.entityId, token);
    this.cancelMobPendingActions(target);

    const settle = (accepted: boolean): void => {
      const current = this.entities.get(target.entityId);
      if (!current || current.kind !== "mob" || this.pendingMobDefeats.get(target.entityId) !== token) {
        return;
      }
      this.pendingMobDefeats.delete(target.entityId);
      if (!accepted) {
        current.currentHealth = 1;
        this.markDirty(current);
        return;
      }
      const currentAttacker = this.entities.get(attackerEntityId);
      this.resolveBloodRushTargetDefeat(current);
      if (
        attacker !== null && currentAttacker === attacker &&
        currentAttacker.kind === "player" &&
        currentAttacker.classRuntime
      ) {
        this.onEnemyDefeated(currentAttacker, current, bleeding, sourceTechniqueId);
      } else if (currentAttacker === attacker) {
        const owner = this.ownedUnitKillOwner(attacker, current);
        if (owner) this.resolveV3SecondWind(owner);
      }
      this.noteRevenantWeaponKillingBlow(currentAttacker === attacker ? attacker : null, current, sourceTechniqueId);
      this.defeat(current, attackerEntityId, sourceTechniqueId);
    };

    let acceptance: boolean | void | Promise<boolean>;
    try {
      acceptance = this.options.onDefeatSettlementCandidate(candidate);
    } catch {
      settle(false);
      return;
    }
    if (acceptance && typeof (acceptance as Promise<boolean>).then === "function") {
      void Promise.resolve(acceptance).then(settle, () => settle(false));
      return;
    }
    settle(acceptance !== false);
  }

  respawnPlayer(playerId: string): CombatEntitySnapshot | null {
    const player = this.entities.get(playerId);
    if (!player || player.kind !== "player" || !this.respawnReadiness(playerId)?.ready) return null;
    const respawnPosition = this.options.onPlayerRespawn?.(player.entityId);
    if (respawnPosition) {
      player.position = { ...respawnPosition };
      player.homePosition = { ...respawnPosition };
      this.grid.update(player.entityId, player.position);
    }
    player.currentHealth = player.maxHealth;
    player.lifeState = "alive";
    player.deathPenaltyOperationKey = null;
    player.respawnAvailableAt = null;
    player.activityState = "idle";
    player.targetEntityId = null;
    player.nextEligibleAttackTick = Math.max(player.nextEligibleAttackTick, this.currentTick);
    this.grantRespawnArrivalProtection(player.entityId);
    this.markDirty(player);
    this.rememberProfile(player);
    this.emitEvent("RESPAWNED", player.entityId, player.entityId, undefined, player.currentHealth);
    return this.snapshot(player);
  }

  deathPenaltyOperationKey(playerId: string): string | null {
    const player = this.entities.get(playerId);
    return player?.kind === "player" && player.lifeState === "respawning"
      ? player.deathPenaltyOperationKey
      : null;
  }

  respawnReadiness(playerId: string, now = this.now()): {
    ready: boolean;
    remainingMs: number;
  } | null {
    const player = this.entities.get(playerId);
    if (!player || player.kind !== "player" || player.lifeState !== "respawning") return null;
    const remainingMs = Math.max(0, (player.respawnAvailableAt ?? 0) - now);
    return { ready: remainingMs === 0, remainingMs };
  }

  private recoverDownedPlayer(work: ScheduledWork): void {
    const player = this.entities.get(work.entityId);
    if (!player || player.kind !== "player" || player.lifeGeneration !== work.generation ||
      player.lifeState !== "downed") return;
    if ((player.downedUntil ?? 0) > this.now()) {
      this.scheduler.schedule({
        dueTick: this.currentTick + millisecondsToTicks(player.downedUntil! - this.now(), this.options.tickRateHz),
        kind: "downed-recovery",
        entityId: player.entityId,
        generation: player.lifeGeneration
      });
      return;
    }
    player.lifeState = "alive";
    player.downedUntil = null;
    player.currentHealth = Math.max(1, Math.round(player.maxHealth * 0.25));
    player.activityState = "idle";
    this.markDirty(player);
    this.rememberProfile(player);
  }

  private validateAttackPair(attacker: Combatant, target: Combatant, resolution: boolean): void {
    const failedPredicate = this.failedAttackPairPredicate(attacker, target);
    if (failedPredicate) {
      const playerView =
        attacker.kind === "player"
          ? attacker
          : target.kind === "player"
            ? target
            : null;
      const targetUnavailable =
        failedPredicate === "target-world-absent" ||
        failedPredicate === "target-not-alive" ||
        failedPredicate === "target-pending-defeat" ||
        failedPredicate === "mob-retreating" ||
        failedPredicate === "target-authority-stale" ||
        failedPredicate === "target-flag-arrival-protected" ||
        failedPredicate === "pve-outside-authoritative-view";
      const strikeBlockMs = failedPredicate === "pvp-strike-block"
        ? this.options.pvpStrikeBlockMs?.(attacker.entityId, target.entityId) ?? null
        : null;
      const defeatSafetyMs = failedPredicate === "pvp-defeat-safety"
        ? this.options.pvpDefeatSafetyMs?.(target.entityId) ?? null
        : null;
      const targetName = this.options.pvpPlayerName?.(target.entityId) ?? "them";
      throw new CombatRequestError(
        strikeBlockMs !== null || defeatSafetyMs !== null
          ? "PVP_PROTECTED"
          : resolution
          ? "COMBAT_RESOLUTION_REJECTED"
          : targetUnavailable
            ? "COMBAT_TARGET_OUTSIDE_AUTHORITY"
            : "COMBAT_TARGET_INVALID",
        defeatSafetyMs !== null
          ? pvpDefeatSafetyRefusal(targetName, defeatSafetyMs)
          : strikeBlockMs !== null
          ? pvpStrikeBlockRefusal(targetName, strikeBlockMs)
          : "Target cannot be attacked",
        {
          combatValidationPredicate: failedPredicate,
          attackerId: attacker.entityId,
          targetEntityId: target.entityId,
          attackerZoneId: attacker.zoneId,
          targetZoneId: target.zoneId,
          attackerRegionCode: attacker.regionCode,
          targetRegionCode: target.regionCode,
          ...(playerView === null
            ? {}
            : {
                gameplayViewGeneration:
                  this.currentAuthoritativeViewGeneration(playerView) ?? 0,
                attackerInsideAuthoritativeView:
                  this.isInsideAuthoritativeView(playerView, attacker),
                targetInsideAuthoritativeView:
                  this.isInsideAuthoritativeView(playerView, target)
              })
        }
      );
    }
  }

  private isInsideAuthoritativeView(player: Combatant, target: Combatant): boolean {
    try {
      const view = this.authoritativeViewCircle(player);
      if (
        distanceMeters(player.position, view.center) > view.radiusM ||
        distanceMeters(target.position, view.center) > view.radiusM
      ) {
        return false;
      }
      if (
        (view.eligibleRegionCodes?.length && !view.eligibleRegionCodes.includes(target.regionCode)) ||
        (view.eligibleZoneIds?.length && !view.eligibleZoneIds.includes(target.zoneId))
      ) {
        return false;
      }
      return target.kind !== "mob" || view.anchorType === "flag" || target.originFlagId === null;
    } catch (error) {
      if (!(error instanceof CombatRequestError)) throw error;
      return false;
    }
  }

  private currentAuthoritativeViewGeneration(player: Combatant): number | null {
    try {
      return this.authoritativeViewCircle(player).generation;
    } catch (error) {
      if (!(error instanceof CombatRequestError)) throw error;
      return null;
    }
  }

  /** True when the PvP strike-block rule refuses this player's damage on the target right now. */
  private pvpStrikeBlocked(attacker: Combatant, target: Combatant): boolean {
    return attacker.entityId !== target.entityId && this.pvpRuleRefusal(attacker.entityId, target) !== null;
  }

  /**
   * The PvP strike-block rule between an attacking player and a target player: the
   * target's post-kill safety (no one may attack them), then the attacker's
   * strike block. An Aggressive target overrides both: anyone may attack them.
   */
  private pvpRuleRefusal(
    attackerPlayerId: string,
    target: Combatant
  ): "pvp-defeat-safety" | "pvp-strike-block" | null {
    if (target.aggressiveUntilMs > this.now()) return null;
    if ((this.options.pvpDefeatSafetyMs?.(target.entityId) ?? null) !== null) return "pvp-defeat-safety";
    if ((this.options.pvpStrikeBlockMs?.(attackerPlayerId, target.entityId) ?? null) !== null) return "pvp-strike-block";
    return null;
  }

  private isAttackPairValid(attacker: Combatant, target: Combatant): boolean {
    return this.failedAttackPairPredicate(attacker, target) === null;
  }

  private failedAttackPairPredicate(
    attacker: Combatant,
    target: Combatant
  ): CombatValidationPredicate | null {
    if (attacker.entityId === target.entityId) return "self-attack";
    if (target.companionDogId && attacker.kind === "player") return "combat-rules";
    if (target.undead && attacker.kind === "player") {
      // A player fights another player's undead under the PvP gates against that owner.
      if (target.undead.ownerPlayerId === attacker.entityId) return "combat-rules";
      if (this.flagArrivalProtectionUntil(target.undead.ownerPlayerId) !== null) return "target-flag-arrival-protected";
      if (this.options.isPvpBlocked?.(attacker.entityId, target.undead.ownerPlayerId) === true) return "pvp-trust-shield";
    }
    if (this.worldAbsentPlayerIds.has(attacker.entityId)) {
      return "attacker-world-absent";
    }
    if (this.worldAbsentPlayerIds.has(target.entityId)) {
      return "target-world-absent";
    }
    if (attacker.lifeState !== "alive") return "attacker-not-alive";
    if (target.lifeState !== "alive") return "target-not-alive";
    if (isMobRetreating(attacker) || isMobRetreating(target)) {
      return "mob-retreating";
    }
    if (this.pendingMobDefeats.has(attacker.entityId)) {
      return "attacker-pending-defeat";
    }
    if (this.pendingMobDefeats.has(target.entityId)) {
      return "target-pending-defeat";
    }
    if (attacker.kind === "player" && target.kind === "mob") {
      if (!this.isInsideAuthoritativeView(attacker, target)) {
        return "pve-outside-authoritative-view";
      }
    } else if (attacker.kind === "mob" && target.kind === "player") {
      if (this.flagArrivalProtectionUntil(target.entityId) !== null) {
        return "target-flag-arrival-protected";
      }
      if (!this.isLegitimateMobPlayerEncounter(attacker, target)) {
        return "pve-encounter-authority";
      }
      if (!this.isInsideAuthoritativeView(target, attacker)) {
        return "pve-outside-authoritative-view";
      }
    } else if (attacker.kind === "player" && target.kind === "player") {
      if (attacker.regionCode !== target.regionCode) {
        return "pvp-region-mismatch";
      }
      if (attacker.zoneId !== target.zoneId) return "pvp-zone-mismatch";
      if (!this.isInsideAuthoritativeView(attacker, target)) {
        return "pvp-outside-authoritative-view";
      }
      if (this.options.isPvpBlocked?.(attacker.entityId, target.entityId) === true) {
        return "pvp-trust-shield";
      }
      const pvpRefusal = this.pvpRuleRefusal(attacker.entityId, target);
      if (pvpRefusal) return pvpRefusal;
    } else {
      if (attacker.regionCode !== target.regionCode) {
        return "non-player-region-mismatch";
      }
      if (attacker.zoneId !== target.zoneId) {
        return "non-player-zone-mismatch";
      }
    }
    return this.rules.canAttack({ attacker, target }) ? null : "combat-rules";
  }

  private isLegitimateMobPlayerEncounter(
    mob: Combatant,
    player: Combatant
  ): boolean {
    if (
      this.options.isSharedMobCombat?.(mob.entityId) === true &&
      this.options.isMobPlayerAttackAuthorized?.(mob.entityId, player.entityId) === true
    ) {
      return true;
    }
    const ownerPlayerId = mob.aggroOwnerPlayerId;
    if (!ownerPlayerId) return false;
    const session = this.pveSessions.get(ownerPlayerId);
    const owner = this.entities.get(ownerPlayerId);
    if (
      !session ||
      owner?.kind !== "player" ||
      mob.aggroOwnerSessionId !== session.sessionId ||
      mob.aggroOwnerSessionGeneration !== session.generation ||
      mob.aggroViewGeneration !== session.viewGeneration ||
      this.currentAuthoritativeViewGeneration(owner) !==
        session.viewGeneration ||
      !session.enemyIds.has(mob.entityId)
    ) {
      return false;
    }
    return (
      player.entityId === ownerPlayerId ||
      this.options.partyAuthority?.sameParty(
        ownerPlayerId,
        player.entityId
      ) === true
    );
  }

  private requirePlayerAuthority(
    attacker: Combatant,
    accountId: string,
    connectionId: string
  ): void {
    if (
      attacker.kind !== "player" ||
      attacker.accountId !== accountId ||
      attacker.connectionId !== connectionId ||
      !this.hasActiveAuthority(attacker)
    ) {
      throw new CombatRequestError("COMBAT_AUTHORITY_REJECTED", "Gameplay connection is not authoritative");
    }
  }

  private hasActiveAuthority(entity: Combatant): boolean {
    if (entity.kind === "mob") {
      return true;
    }
    return Boolean(
      entity.accountId &&
      entity.connectionId &&
      (this.options.isPlayerAuthorityActive?.(
        entity.entityId,
        entity.accountId,
        entity.connectionId
      ) ?? true)
    );
  }

  private setTarget(entity: Combatant, targetEntityId: string): void {
    const enteringCombat =
      entity.targetEntityId === null &&
      entity.classRuntime !== null &&
      !(entity.kind === "player" && this.pveSessions.has(entity.entityId));
    const switchedTarget = entity.targetEntityId !== null && entity.targetEntityId !== targetEntityId;
    if (entity.targetEntityId) {
      this.targetersByEntity.get(entity.targetEntityId)?.delete(entity.entityId);
    }
    this.pvpAutoRetaliationTargets.delete(entity.entityId);
    entity.targetEntityId = targetEntityId;
    // Mob tactics target swap: cancel the windup, leave the old ledger, rejoin the new one with the swap penalty.
    if (switchedTarget && entity.kind === "mob" && this.mobTactics.has(entity.entityId)) this.retargetMobTactics(entity);
    if (switchedTarget && entity.classRuntime) {
      if (entity.classRuntime.queuedAbility) this.refundQueue(entity.classRuntime);
      entity.classRuntime.counters.relentlessTarget = "";
      entity.classRuntime.counters.relentlessCount = 0;
      this.rememberClassRuntime(entity);
    }
    if (switchedTarget) {
      this.cancelInProgressWeaponSwitch(entity);
    }
    if (enteringCombat && entity.classRuntime) {
      entity.classRuntime.combatGeneration += 1;
      entity.classRuntime.lastCombatAtMs = this.now();
      this.rememberClassRuntime(entity);
    }
    entity.activityState = "attacking";
    entity.chaseDestination = null;
    let targeters = this.targetersByEntity.get(targetEntityId);
    if (!targeters) {
      targeters = new Set();
      this.targetersByEntity.set(targetEntityId, targeters);
    }
    targeters.add(entity.entityId);
    this.markDirty(entity);
  }

  private clearTarget(entity: Combatant): void {
    if (entity.kind === "mob" && this.mobTactics.mobs.size > 0) this.forgetMobTactics(entity.entityId);
    if (entity.kind === "mob" && entity.aggroOwnerPlayerId) {
      const session = this.pveSessions.get(entity.aggroOwnerPlayerId);
      if (
        session?.sessionId === entity.aggroOwnerSessionId &&
        session.generation === entity.aggroOwnerSessionGeneration
      ) {
        this.removeEnemy(session, entity.entityId);
        return;
      }
      entity.aggroOwnerPlayerId = null;
      entity.aggroOwnerSessionId = null;
      entity.aggroOwnerSessionGeneration = null;
      entity.aggroViewGeneration = null;
    }
    if (entity.targetEntityId) {
      const targeters = this.targetersByEntity.get(entity.targetEntityId);
      targeters?.delete(entity.entityId);
      if (targeters?.size === 0) {
        this.targetersByEntity.delete(entity.targetEntityId);
      }
    }
    this.cancelInProgressWeaponSwitch(entity);
    entity.targetEntityId = null;
    if (entity.kind === "mob" && entity.special) entity.special.pounceTargetId = null;
    this.pvpAutoRetaliationTargets.delete(entity.entityId);
    if (entity.classRuntime) {
      entity.classRuntime.counters.relentlessTarget = "";
      entity.classRuntime.counters.relentlessCount = 0;
      if (entity.classRuntime.queuedAbility) this.refundQueue(entity.classRuntime);
      this.rememberClassRuntime(entity);
    }
    entity.activityState = "idle";
    entity.chaseDestination = null;
    this.activeChases.delete(entity.entityId);
    this.markDirty(entity);
  }

  private cancelTargeters(targetEntityId: string): void {
    const targeters = [...(this.targetersByEntity.get(targetEntityId) ?? [])].sort();
    for (const entityId of targeters) {
      const entity = this.entities.get(entityId);
      if (entity) {
        this.clearTarget(entity);
      }
    }
    this.targetersByEntity.delete(targetEntityId);
  }

  private startChasing(entity: Combatant): void {
    entity.activityState = "chasing";
    this.activeChases.add(entity.entityId);
    this.markDirty(entity);
    // Warm the habitat surface cache along the chase line once, off the tick.
    const target = entity.targetEntityId ? this.entities.get(entity.targetEntityId) : undefined;
    if (target && entity.kind === "mob" && mobMovementHabitat(entity.archetypeKey) !== null) {
      this.mobSurfaceLookup?.prewarm(entity.position, target.position);
    }
  }

  private scheduleAttack(entity: Combatant, dueTick: number): void {
    if (entity.targetEntityId === null || entity.lifeState !== "alive") {
      return;
    }
    if (entity.scheduledAttackTick !== null && entity.scheduledAttackTick <= dueTick) {
      return;
    }
    entity.attackScheduleGeneration += 1;
    entity.scheduledAttackTick = dueTick;
    this.scheduler.schedule({
      dueTick,
      kind: "attack",
      entityId: entity.entityId,
      generation: entity.attackScheduleGeneration
    });
  }

  private removeEntity(entityId: string, emitRemoval: boolean): void {
    const entity = this.entities.get(entityId);
    if (!entity) {
      return;
    }
    if (entity.kind === "mob") {
      this.cancelMobPendingActions(entity);
      this.removeEnemyFromAllSessions(entityId);
    } else this.endPveSession(entity, true, "entity_removed");
    this.cancelTargeters(entityId);
    this.clearTarget(entity);
    this.entities.delete(entityId);
    this.golemForgeState.delete(entityId);
    this.invulnerableMobs.delete(entityId);
    this.passiveMobs.delete(entityId);
    if (entity.originFlagId) {
      const flagEntityIds = this.entityIdsByOriginFlag.get(entity.originFlagId);
      flagEntityIds?.delete(entityId);
      if (flagEntityIds?.size === 0) this.entityIdsByOriginFlag.delete(entity.originFlagId);
    }
    this.pendingMobDefeats.delete(entityId);
    this.contributionsByMob.delete(entityId);
    this.holyArcHealCredits.delete(entityId);
    this.holyArcRelations.delete(entityId);
    this.positionHistory.release(entityId);
    this.swingStates.delete(entityId);
    this.pendingSwingIds.delete(entityId);
    this.windupSwingIds.delete(entityId);
    this.givingTreeAuraDueTicks.delete(entityId);
    this.balsamResinEffects.delete(entityId);
    this.grid.remove(entityId);
    this.activeChases.delete(entityId);
    this.returningMobs.delete(entityId);
    this.retreatingMobs.delete(entityId);
    this.pendingMobRetreats.delete(entityId);
    this.dirtyEntityIds.delete(entityId);
    if (emitRemoval || entity.kind === "player") {
      this.removedEntityIds.add(entityId);
    }
  }

  private markDirty(entity: Combatant, bumpRevision = true): void {
    if (bumpRevision) {
      entity.revision += 1;
    }
    this.dirtyEntityIds.add(entity.entityId);
  }

  private rememberProfile(entity: Combatant): void {
    if (entity.kind !== "player") {
      return;
    }
    const persistenceVersion = (this.profileVersions.get(entity.entityId) ?? 0) + 1;
    this.profileVersions.set(entity.entityId, persistenceVersion);
    this.dirtyProfiles.set(entity.entityId, {
      playerId: entity.entityId,
      maxHealth: entity.maxHealth,
      currentHealth: entity.currentHealth,
      baseAttackDamage: entity.attackDamage,
      lifeState: entity.lifeState,
      downedUntil: entity.downedUntil,
      deathPenaltyOperationKey: entity.deathPenaltyOperationKey,
      respawnAvailableAt: entity.respawnAvailableAt,
      persistenceVersion
    });
  }

  private emitEvent(
    type: CombatEvent["type"],
    sourceEntityId: string | null,
    targetEntityId: string | null,
    amount?: number,
    currentHealth?: number
  ): CombatEvent {
    this.metrics.combatEventsEmitted += 1;
    const event: CombatEvent = {
      eventId: `${this.currentTick}:${++this.eventSequence}`,
      type,
      tick: this.currentTick,
      sourceEntityId,
      targetEntityId,
      ...(amount === undefined ? {} : { amount }),
      ...(currentHealth === undefined ? {} : { currentHealth })
    };
    this.pendingEvents.push(event);
    return event;
  }

  private emitHealingBlocked(
    sourceEntityId: string | null,
    targetEntityId: string,
    harmfulStatusId: HarmfulStatusId,
    currentHealth: number
  ): void {
    this.metrics.combatEventsEmitted += 1;
    this.pendingEvents.push({
      eventId: `${this.currentTick}:${++this.eventSequence}`,
      type: "HEAL_BLOCKED",
      tick: this.currentTick,
      sourceEntityId,
      targetEntityId,
      amount: 0,
      currentHealth,
      harmfulStatusId
    });
  }

  private emitTauntActivatedEvent(sourceEntityId: string, position: LatLon, radiusM: number): void {
    this.metrics.combatEventsEmitted += 1;
    this.pendingEvents.push({
      eventId: `${this.currentTick}:${++this.eventSequence}`,
      type: "TAUNT_ACTIVATED",
      tick: this.currentTick,
      sourceEntityId,
      targetEntityId: null,
      position: { ...position },
      radiusM
    });
  }

  /** A one-shot pet ability visual for everyone who can see the pet (or its target). */
  emitPetAbilityEffect(input: Readonly<{
    sourceEntityId: string;
    abilityId: string;
    position: LatLon;
    radiusM?: number;
    targetEntityId?: string | null;
    durationMs: number;
  }>): void {
    if (!this.entities.has(input.sourceEntityId)) return;
    this.metrics.combatEventsEmitted += 1;
    this.pendingEvents.push({
      eventId: `${this.currentTick}:${++this.eventSequence}`,
      type: "PET_ABILITY_EFFECT",
      tick: this.currentTick,
      sourceEntityId: input.sourceEntityId,
      targetEntityId: input.targetEntityId ?? null,
      abilityId: input.abilityId,
      position: { lat: input.position.lat, lon: input.position.lon },
      durationMs: input.durationMs,
      ...(input.radiusM === undefined ? {} : { radiusM: input.radiusM })
    });
  }

  private emitClassAbilityActivatedEvent(
    source: Combatant,
    definition: TechniqueDefinition,
    presentation: { target?: Combatant; targetPosition?: LatLon }
  ): void {
    const target = presentation.target;
    const position = presentation.targetPosition ?? (
      definition.activation === "armed"
        ? source.position
        : target?.position ?? source.position
    );
    const circularRadiusM = definition.activation !== "armed" &&
      definition.dragTargetKind !== "direction"
      ? definition.targetRadiusM
      : undefined;
    this.metrics.combatEventsEmitted += 1;
    this.pendingEvents.push({
      eventId: `${this.currentTick}:${++this.eventSequence}`,
      type: "CLASS_ABILITY_ACTIVATED",
      tick: this.currentTick,
      sourceEntityId: source.entityId,
      targetEntityId: target && target.entityId !== source.entityId
        ? target.entityId
        : null,
      abilityId: definition.id,
      position: { ...position },
      ...(circularRadiusM === undefined
        ? {}
        : { radiusM: circularRadiusM })
    });
  }

  private snapshotsForIds(
    entityIds: Iterable<string>,
    recipientPlayerId?: string
  ): CombatEntitySnapshot[] {
    return [...entityIds]
      .map((entityId) => this.entities.get(entityId))
      .filter((entity): entity is Combatant => entity !== undefined)
      .sort((left, right) => left.entityId.localeCompare(right.entityId))
      .map((entity) => this.snapshot(entity, recipientPlayerId));
  }

  private revisionsForIds(entityIds: Iterable<string>): Map<string, number> {
    const revisions = new Map<string, number>();
    for (const entityId of entityIds) {
      const entity = this.entities.get(entityId);
      if (entity) {
        revisions.set(entityId, entity.revision);
      }
    }
    return revisions;
  }

  private nextNetworkSequence(playerId: string): number {
    const next = (this.networkSequenceByPlayer.get(playerId) ?? 0) + 1;
    this.networkSequenceByPlayer.set(playerId, next);
    return next;
  }

  private snapshot(entity: Combatant, recipientPlayerId?: string): CombatEntitySnapshot {
    const includesPrivateCombatState =
      recipientPlayerId === undefined || recipientPlayerId === entity.entityId;
    const ward = entity.kind === "player"
      ? Math.max(0, Math.round(entity.classRuntime?.effects
          .filter((effect) =>
            effect.kind === "healing_shield" && effect.amount > 0 && effect.endTick >= this.currentTick
          )
          .reduce((total, effect) => total + effect.amount, 0) ?? 0))
      : 0;
    const rootedEffect = entity.classRuntime?.effects.find(
      (effect) => effect.kind === "rooted" && effect.endTick >= this.currentTick
    );
    const harmfulStatusIds = (["poison", "gloom", "burning", "storm"] as const).filter((statusId) =>
      entity.classRuntime?.effects.some((effect) =>
        effect.kind === statusId && effect.stacks > 0 && effect.endTick >= this.currentTick
      ) === true
    ) as HarmfulStatusId[];
    if (entity.classRuntime?.effects.some((effect) =>
      effect.kind === "movement_slow" && effect.sourceTechniqueId === "elemental_ice_slow" &&
      effect.endTick >= this.currentTick
    )) harmfulStatusIds.push("ice_slow");
    const hasEffectWhere = (predicate: (effect: CombatEffect) => boolean): boolean =>
      entity.classRuntime?.effects.some((effect) => effect.endTick >= this.currentTick && predicate(effect)) === true;
    if (hasEffectWhere((effect) => effect.kind === "movement_slow" && effect.sourceTechniqueId === "metal_fleet_slow")) {
      harmfulStatusIds.push("fleet_slow");
    }
    if (hasEffectWhere((effect) => effect.kind === "whetted_defense")) harmfulStatusIds.push("whetted_defense");
    if (hasEffectWhere((effect) => effect.kind === "whetted_attack")) harmfulStatusIds.push("whetted_attack");
    if (hasEffectWhere((effect) => effect.kind === "immobilized")) harmfulStatusIds.push("immobilized");
    if (hasEffectWhere((effect) => effect.kind === "stunned")) harmfulStatusIds.push("stunned");
    if (hasEffectWhere((effect) => effect.kind === "vengeance_mark")) harmfulStatusIds.push("vengeance_mark");
    if (entity.classRuntime?.effects.some((effect) =>
      effect.kind === "defense_reduction" && effect.sourceTechniqueId === "ranger_v2_marked_quarry" &&
      effect.amount > 0 && effect.endTick >= this.currentTick
    )) harmfulStatusIds.push("quarry_sign");
    if (entity.classRuntime?.effects.some((effect) =>
      effect.kind === "player_action_defense_reduction" &&
      effect.stacks > 0 && effect.endTick >= this.currentTick
    )) harmfulStatusIds.push("exposed");
    return {
      entityId: entity.entityId,
      kind: entity.kind,
      archetypeKey: entity.archetypeKey,
      ...(entity.kind === "mob" && entity.appearanceVariant
        ? { appearanceVariant: entity.appearanceVariant }
        : {}),
      name: entity.name,
      level: entity.level,
      challengeTier: entity.challengeTier,
      combatBalanceVersion: entity.combatBalanceVersion,
      regionCode: entity.regionCode,
      zoneId: entity.zoneId,
      lat: entity.position.lat,
      lon: entity.position.lon,
      maxHealth: entity.maxHealth,
      currentHealth: entity.currentHealth,
      ...(entity.kind === "player" ? { ward, downedUntil: entity.downedUntil } : {}),
      ...(entity.kind === "player" && includesPrivateCombatState
        ? { invisibleUntil: this.isNinjaInvisible(entity)
            ? Number(entity.classRuntime?.counters.ninjaInvisibleUntil)
            : null }
        : {}),
      lifeState: entity.lifeState,
      activityState: entity.activityState,
      targetEntityId: entity.targetEntityId,
      ...(entity.kind === "mob" ? { packId: entity.packId } : {}),
      ...(entity.npcFaction
        ? { npcFaction: {
            cityId: entity.npcFaction.cityId,
            cityName: entity.npcFaction.cityName,
            culture: entity.npcFaction.culture,
            role: entity.npcFaction.role,
            presentationKey: entity.npcFaction.presentationKey,
            relation: recipientPlayerId && this.isNpcCityPlayerEnemy(
              entity.npcFaction.cityId,
              recipientPlayerId
            ) ? "enemy" as const : "neutral" as const,
            protected: true as const
          } }
        : {}),
      ...(entity.companionDogId && entity.companionOwnerPlayerId
        ? { companion: {
            ownerPlayerId: entity.companionOwnerPlayerId,
            dogId: entity.companionDogId,
            species: entity.companionSpecies ?? "trail_hound",
            mode: entity.companionMode ?? "play",
          } }
        : {}),
      ...(entity.undead
        ? { undead: {
            ownerPlayerId: entity.undead.ownerPlayerId,
            kind: entity.undead.kind,
            level: entity.undead.level,
            expiresAt: entity.undead.expiresAt
          } }
        : {}),
      ...(entity.kind === "player" && (entity.maxHealthPenaltyApplied ?? 0) > 0
        ? { maxHealthPenalty: entity.maxHealthPenaltyApplied }
        : {}),
      // Public: every client animates this player's swings with the profile the server resolves them with.
      ...(entity.kind === "player" && this.combatStyleOf(entity) !== "default"
        ? { combatStyle: this.combatStyleOf(entity) }
        : {}),
      ...(entity.kind === "mob" && entity.archetypeKey &&
        (entity.bossOwnership !== null || requireMobDefinition(entity.archetypeKey).boss === true) &&
        entity.bossLifecycleState !== "dormant"
        ? { boss: true }
        : {}),
      ...(entity.kind === "mob" && entity.bossEventState
        ? { bossEventState: entity.bossEventState }
        : {}),
      ...(entity.kind === "mob" && entity.bossLifecycleState
        ? { bossLifecycleState: entity.bossLifecycleState }
        : {}),
      ...(entity.kind === "mob" && entity.bossOwnership
        ? { bossOwnership: { ...entity.bossOwnership } }
        : {}),
      ...(entity.kind === "mob" && this.bossEncounterProjectionProvider
        ? (() => {
            const bossEncounter = this.bossEncounterProjectionProvider!(entity.entityId, recipientPlayerId);
            return bossEncounter ? { bossEncounter } : {};
          })()
        : {}),
      ...this.mobGimmickPresentation(entity),
      attackRangeM: entity.attackRangeM,
      ...(rootedEffect
        ? {
            controlEffects: [{
              kind: "rooted" as const,
              endsAt: this.now() +
                Math.max(0, rootedEffect.endTick - this.currentTick) *
                1_000 / this.options.tickRateHz
            }]
          }
        : {}),
      ...(entity.kind === "player" || harmfulStatusIds.length > 0 ? { harmfulStatusIds } : {}),
      ...(entity.kind === "mob"
        ? {
            aiPresentation: this.mobAiPresentation(entity),
            ...(entity.archetypeKey ? { hostility: this.mobHostility(entity) } : {})
          }
        : {}),
      ...(entity.mobAi?.ambientSpeech
        ? { ambientSpeech: { ...entity.mobAi.ambientSpeech } }
        : {}),
      revision: entity.revision,
      ...(entity.kind === "player" && includesPrivateCombatState
        ? { aggressiveUntil: entity.aggressiveUntilMs > this.now() ? entity.aggressiveUntilMs : null }
        : {}),
      ...(entity.kind === "player" && includesPrivateCombatState
        ? { flagArrivalProtectionUntil: this.flagArrivalProtectionUntil(entity.entityId) }
        : {}),
      ...(entity.kind === "player" && includesPrivateCombatState
        ? { respawnAvailableAt: entity.respawnAvailableAt }
        : {}),
      pveCombat: entity.kind === "player" && includesPrivateCombatState
        ? this.pveCombatState(entity)
        : null,
      classCombat: entity.kind === "player" && entity.classRuntime && includesPrivateCombatState
        ? this.classCombatState(entity)
        : null,
      weaponCombat: entity.kind === "player" &&
        entity.equipmentCombatState &&
        includesPrivateCombatState
        ? {
            activeWeaponSlot: entity.equipmentCombatState.activeWeaponSlot,
            activeWeaponInstanceId:
              entity.equipmentCombatState.activeWeaponInstanceId,
            activeWeaponCategory: entity.equipmentCombatState.weaponCategory,
            switchPolicy: entity.equipmentCombatState.switchPolicy,
            switchingToSlot: entity.equipmentCombatState.switchingToSlot,
            switchStartedAtTick:
              entity.equipmentCombatState.switchStartedAtTick,
            switchCompletesAtTick:
              entity.equipmentCombatState.switchCompletesAtTick
          }
        : null
    };
  }

  private mobAiPresentation(
    entity: Combatant
  ): NonNullable<CombatEntitySnapshot["aiPresentation"]> | null {
    if (entity.kind !== "mob" || !entity.mobAi || !entity.archetypeKey) return null;
    const profile = this.mobAiProfile(entity);
    const deadlineAt = entity.mobAi.deadlineAtMs;
    const targetEntityId = entity.mobAi.targetPlayerId;
    if (entity.mobAi.phase === "acquiring" && profile.countdown === "acquisition") {
      return {
        phase: "acquiring",
        intent: "combat",
        deadlineAt,
        ...(profile.proactive ? { durationMs: profile.proactive.acquisitionDelayMs } : {}),
        targetEntityId
      };
    }
    if (
      entity.mobAi.phase === "engaging" &&
      profile.countdown === "disengagement" &&
      deadlineAt !== null
    ) {
      return {
        phase: "disengaging",
        intent: "combat",
        deadlineAt,
        ...(profile.disengagement.kind === "outside_radius"
          ? { durationMs: profile.disengagement.graceMs }
          : {}),
        targetEntityId
      };
    }
    if (entity.mobAi.phase === "observing") {
      return { phase: "observing", intent: "observe", deadlineAt: null };
    }
    return null;
  }

  private mobHostility(entity: Combatant): NonNullable<CombatEntitySnapshot["hostility"]> {
    const proactive = this.mobAiProfile(entity).proactive;
    if (!proactive) return "passive";
    return proactive.intent === "observe" ? "observer" : "aggressive";
  }

  private requireEntity(entityId: string, code: string): Combatant {
    const entity = this.entities.get(entityId);
    if (!entity) {
      throw new CombatRequestError(code, "Combat entity does not exist");
    }
    return entity;
  }

  private pruneRequestIds(): void {
    if (this.seenRequestTicks.size <= 4_096) {
      return;
    }
    const cutoff = this.currentTick - this.options.tickRateHz * 60;
    for (const [key, tick] of this.seenRequestTicks) {
      if (tick < cutoff) {
        this.seenRequestTicks.delete(key);
      }
    }
  }

  private emptyMetrics(): CombatMetrics {
    return {
      currentServerTick: 0,
      lastTickDurationMs: 0,
      longestRecentTickMs: 0,
      activeCombatants: 0,
      activeEngagements: 0,
      activeChases: 0,
      tacticsManaged: 0,
      tacticsTokensInUse: 0,
      dueAttacksProcessed: 0,
      spatialGridQueries: 0,
      dirtyCombatEntities: 0,
      combatEventsEmitted: 0,
      combatSnapshotsSent: 0,
      combatDeltasSent: 0,
      entitiesPerDelta: 0,
      averageEntitiesPerDelta: 0,
      maximumEntitiesPerDelta: 0,
      aoiCacheHits: 0,
      aoiCacheMisses: 0,
      resyncRequests: 0,
      persistenceDirtyCount: 0,
      persistenceFailures: 0,
      persistenceRetries: 0,
      scheduledWorkCount: 0,
      swingsResolved: 0,
      swingHits: 0,
      swingRejected: 0,
      swingResolveMsMax: 0,
      swingResolveMsTotal: 0
    };
  }
}

function initialBearingDegrees(from: LatLon, to: LatLon): number {
  const fromLatitude = from.lat * Math.PI / 180;
  const toLatitude = to.lat * Math.PI / 180;
  const longitudeDelta = (to.lon - from.lon) * Math.PI / 180;
  const y = Math.sin(longitudeDelta) * Math.cos(toLatitude);
  const x =
    Math.cos(fromLatitude) * Math.sin(toLatitude) -
    Math.sin(fromLatitude) * Math.cos(toLatitude) * Math.cos(longitudeDelta);
  return normalizeBearingDegrees(Math.atan2(y, x) * 180 / Math.PI);
}

function normalizeBearingDegrees(bearing: number): number {
  return ((bearing % 360) + 360) % 360;
}

function bearingDifferenceRadians(leftDegrees: number, rightDegrees: number): number {
  const difference = ((rightDegrees - leftDegrees + 540) % 360) - 180;
  return difference * Math.PI / 180;
}

function requireBoundedStableId(value: string, label: string): string {
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(value)) {
    throw new Error(`${label} must be a bounded stable ID`);
  }
  return value;
}

function positiveInteger(value: number, fallback: number): number {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function validatedPopulationAuthority(
  authority: CombatPopulationAuthorityToken
): CombatPopulationAuthorityToken {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
      .test(authority.ownerToken)
  ) {
    throw new Error("population authority owner token must be a UUID");
  }
  if (
    !Number.isSafeInteger(authority.fencingGeneration)
    || authority.fencingGeneration <= 0
  ) {
    throw new Error("population authority fencing generation must be a positive safe integer");
  }
  if (
    !Number.isSafeInteger(authority.cutoverRevision)
    || authority.cutoverRevision <= 0
  ) {
    throw new Error("population authority cutover revision must be a positive safe integer");
  }
  return { ...authority };
}

function deterministicDirection(leftId: string, rightId: string): number {
  const value = `${leftId}:${rightId}`;
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) / 0x1_0000_0000 * Math.PI * 2;
}

function clampRage(
  value: number,
  maximum: number = WARRIOR_BALANCE.rage.maximum
): number {
  return Math.max(
    0,
    Math.min(maximum, Math.trunc(Number.isFinite(value) ? value : 0))
  );
}

function automaticRank(masteryRank: number, thresholds: readonly number[]): number {
  return thresholds.filter((rank) => masteryRank >= rank).length;
}

function specializationTierBonus(rank: number): number {
  return rank >= 5 ? 4 : rank >= 3 ? 2 : rank >= 1 ? 1 : 0;
}

function equipmentGameplayFamily(definitionId: string | null): string | null {
  if (!definitionId) return null;
  try {
    return requireEquipmentDefinition(definitionId).gameplayFamilyId ?? null;
  } catch {
    return null;
  }
}

function normalizeCounters(value: Record<string, unknown>): Record<string, number | string | boolean> {
  const result: Record<string, number | string | boolean> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "number" || typeof entry === "string" || typeof entry === "boolean") result[key] = entry;
  }
  return result;
}

function normalizeCooldownEndsAt(
  value: Record<string, number>,
  learnedTechniqueIds: readonly string[],
  now = Date.now()
): Record<string, number> {
  const learned = new Set(learnedTechniqueIds);
  const hasResetAbility = learnedTechniqueIds.some((id) =>
    (RESET_ACTIVE_IDS as readonly string[]).includes(id)
  );
  const normalized: Record<string, number> = {};
  for (const [id, expiry] of Object.entries(value)) {
    if (!Number.isFinite(expiry) || expiry <= now) continue;
    let maximumDurationMs: number | null = null;
    if (id === NINJA_INVISIBLE_KEY) {
      maximumDurationMs = 60_000;
    } else if (id === UNIVERSAL_TAUNT_ID) {
      maximumDurationMs = UNIVERSAL_TAUNT_COOLDOWN_MS;
    } else if (id === BASIC_ATTACK_RESET_COOLDOWN_GROUP) {
      if (hasResetAbility) maximumDurationMs = BASIC_ATTACK_RESET_COOLDOWN_MS;
    } else if (learned.has(id)) {
      const definition = TECHNIQUE_BY_ID[id];
      if (definition && definition.kind !== "passive" && definition.cooldownMs > 0) {
        maximumDurationMs = (RESET_ACTIVE_IDS as readonly string[]).includes(id)
          ? BASIC_ATTACK_RESET_COOLDOWN_MS
          : definition.cooldownMs;
      }
    }
    if (maximumDurationMs !== null) {
      normalized[id] = Math.min(expiry, now + maximumDurationMs);
    }
  }
  return normalized;
}

function numericCounters(value: Record<string, number | string | boolean>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === "number")
  );
}

function isCombatEffect(value: unknown): value is CombatEffect {
  if (!value || typeof value !== "object") return false;
  const effect = value as Partial<CombatEffect>;
  return (
    typeof effect.id === "string" && typeof effect.kind === "string" &&
    typeof effect.sourceTechniqueId === "string" && typeof effect.sourceEntityId === "string" &&
    Number.isInteger(effect.startTick) && Number.isInteger(effect.endTick) &&
    Number.isInteger(effect.nextTick) && Number.isInteger(effect.stacks) &&
    Number.isInteger(effect.maximumStacks) && typeof effect.amount === "number"
  );
}

/** Beat-aligned pulses covering a design duration: the nearest whole number of beat intervals, at least one. */
function beatPulseCount(durationMs: number, designIntervalMs: number): number {
  return Math.max(1, Math.round(durationMs / beatAlignedIntervalMs(designIntervalMs)));
}

/** Tick profile (tick interval and roll) of a metal-applied status, keyed by its source technique; null otherwise. */
function metalStatusTick(effect: CombatEffect): { tickMs: number; damageMin: number; damageMax: number } | null {
  switch (effect.sourceTechniqueId) {
    case METAL_VENOM_POISON_ID: return METAL_PROC_BALANCE.poison;
    case METAL_EMBER_BURN_ID: return METAL_PROC_BALANCE.burning;
    case METAL_STORM_ID: {
      const { pulseMs, damageMin, damageMax } = METAL_PROC_BALANCE.storm;
      return { tickMs: pulseMs, damageMin, damageMax };
    }
    default: return null;
  }
}

/** Effects that tick on the combat beat. */
function isPeriodicEffectKind(kind: CombatEffectKind): boolean {
  return kind === "poison" || kind === "burning" || kind === "storm" || kind === "blight" ||
    kind === "healing_over_time" || kind === "bleed";
}

function isHarmfulStatusKind(
  kind: CombatEffectKind
): kind is "poison" | "gloom" | "burning" | "storm" {
  return kind === "poison" || kind === "gloom" || kind === "burning" || kind === "storm";
}

function isV3HarmfulEffectKind(kind: CombatEffectKind): boolean {
  return [
    "poison", "gloom", "burning", "storm", "bleed", "queue_bleed",
    "hunter_snare", "movement_slow", "defense_reduction", "player_action_defense_reduction",
    "provoke_exposure", "marked_quarry", "blight", "rooted", "concussed"
  ].includes(kind);
}

function isMobRetreating(entity: Combatant): boolean {
  return entity.kind === "mob" && (
    isRetreatingToGuard(entity.special) ||
    entity.jellyfishRuntime?.retreatPhase === "preparing" ||
    entity.jellyfishRuntime?.retreatPhase === "moving"
  );
}

function emptyJellyfishRuntime(): JellyfishRuntime {
  return {
    revision: 0,
    stage: 1,
    retreatTriggered: false,
    secondRetreatTriggered: false,
    retreatsCompleted: 0,
    shadeEnabled: false,
    retreatPhase: "idle",
    retreatStartPosition: null,
    retreatDestination: null,
    retreatStartedAtMs: null
  };
}

function restoreJellyfishRuntimeState(
  value: unknown,
  maxHealth: number,
  normalMaxHealth: number,
  spawnPosition: LatLon,
  movementSpeedMps: number,
  nowMs = Date.now()
): { currentHealth: number; position: LatLon; runtime: JellyfishRuntime } | null {
  if (!value || typeof value !== "object") return null;
  const state = value as Partial<PopulationMobCombatRuntimeState>;
  if (state.schemaVersion !== 1 || state.archetype !== "jellyfish") return null;
  const jellyfish = state.jellyfish;
  if (!jellyfish || typeof jellyfish !== "object") return null;
  const storedMaxHealth = Number(state.maxHealth);
  const sourceMaxHealth = Number.isFinite(storedMaxHealth) && storedMaxHealth > 0
    ? storedMaxHealth
    : normalMaxHealth;
  const storedCurrentHealth = Number(state.currentHealth);
  const sourceCurrentHealth = Number.isFinite(storedCurrentHealth) && storedCurrentHealth > 0
    ? Math.min(sourceMaxHealth, storedCurrentHealth)
    : sourceMaxHealth;
  const currentHealth = Math.max(
    1,
    Math.min(maxHealth, Math.round(maxHealth * sourceCurrentHealth / sourceMaxHealth))
  );
  const healthStage: 1 | 2 | 3 = currentHealth * 3 <= maxHealth
    ? 3
    : currentHealth * 3 <= maxHealth * 2
      ? 2
      : 1;
  const storedStage = jellyfish.stage === 2 || jellyfish.stage === 3
    ? jellyfish.stage
    : 1;
  const stage = Math.max(storedStage, healthStage) as 1 | 2 | 3;
  const retreatTriggered = jellyfish.retreatTriggered === true || stage >= 2;
  const secondRetreatTriggered = jellyfish.secondRetreatTriggered === true || stage === 3;
  const retreatStartPosition = validLatLon(jellyfish.retreatStartPosition);
  const retreatDestination = validLatLon(jellyfish.retreatDestination);
  const retreatStartedAtMs = Number.isFinite(jellyfish.retreatStartedAtMs)
    ? Number(jellyfish.retreatStartedAtMs)
    : null;
  let retreatPhase: JellyfishRuntime["retreatPhase"] =
    jellyfish.retreatPhase === "preparing" ||
    jellyfish.retreatPhase === "moving" ||
    jellyfish.retreatPhase === "complete"
      ? jellyfish.retreatPhase
      : "idle";
  let retreatsCompleted = Number.isSafeInteger(jellyfish.retreatsCompleted)
    ? Math.max(0, Math.min(2, Number(jellyfish.retreatsCompleted))) as 0 | 1 | 2
    : retreatPhase === "complete" && retreatTriggered
      ? 1
      : 0;
  let position = validLatLon(state.position) ?? { ...spawnPosition };
  if (
    retreatPhase === "moving" && retreatStartPosition &&
    retreatDestination && retreatStartedAtMs !== null
  ) {
    const elapsedSeconds = Math.max(0, nowMs - retreatStartedAtMs) / 1_000;
    const travelM = Math.max(0, movementSpeedMps) * elapsedSeconds;
    if (travelM >= distanceMeters(retreatStartPosition, retreatDestination)) {
      position = { ...retreatDestination };
      retreatPhase = "complete";
      retreatsCompleted = Math.min(2, retreatsCompleted + 1) as 0 | 1 | 2;
    } else {
      position = moveToward(retreatStartPosition, retreatDestination, travelM);
    }
  } else if (retreatPhase === "moving") {
    retreatPhase = "preparing";
  }
  const retreatsTriggered = Number(retreatTriggered) + Number(secondRetreatTriggered);
  if (retreatPhase === "complete" && retreatsCompleted < retreatsTriggered) {
    retreatPhase = "preparing";
  }
  return {
    currentHealth,
    position,
    runtime: {
      revision: Number.isSafeInteger(state.revision) && Number(state.revision) >= 0
        ? Number(state.revision)
        : 0,
      stage,
      retreatTriggered,
      secondRetreatTriggered,
      retreatsCompleted,
      shadeEnabled: jellyfish.shadeEnabled === true || stage === 3,
      retreatPhase,
      retreatStartPosition,
      retreatDestination,
      retreatStartedAtMs
    }
  };
}

function jellyfishRetreatsTriggered(runtime: JellyfishRuntime): number {
  return Number(runtime.retreatTriggered) + Number(runtime.secondRetreatTriggered);
}

function validLatLon(value: unknown): LatLon | null {
  if (!value || typeof value !== "object") return null;
  const point = value as Partial<LatLon>;
  return typeof point.lat === "number" && Number.isFinite(point.lat) &&
    point.lat >= -90 && point.lat <= 90 &&
    typeof point.lon === "number" && Number.isFinite(point.lon) &&
    point.lon >= -180 && point.lon <= 180
    ? { lat: point.lat, lon: point.lon }
    : null;
}

function emptyRuntime(): ClassCombatRuntime {
  return {
    skillV3: null,
    activeClassId: "warrior",
    resourceId: "rage",
    weaponMode: null,
    masteryRank: 0,
    subclassId: null,
    subclassMasteryRank: 1,
    learned: new Set(),
    equippedActives: new Set(),
    equippedPassives: new Set(),
    legacyIds: new Set(),
    weaponCategory: null,
    armorCategory: null,
    weaponDefinitionId: null,
    chestDefinitionId: null,
    hasShield: false,
    heavyArmorPieces: 0,
    rage: 0,
    reservedRage: 0,
    guard: 0,
    bloodlust: 0,
    queuedAbility: null,
    cooldownEndsAt: {},
    effects: [],
    counters: {},
    lastCombatAtMs: null,
    combatGeneration: 0,
    dirtyVersion: 0
  };
}

function requireClassCombatRuntime(entity: Combatant): ClassCombatRuntime {
  if (!entity.classRuntime || entity.kind !== "player") {
    throw new CombatRequestError("CLASS_RUNTIME_UNAVAILABLE", "Class combat state is unavailable");
  }
  return entity.classRuntime;
}

function isCurrentTechniqueId(id: string, learnedIds: readonly string[]): boolean {
  if (!learnedIds.includes(id)) return false;
  try {
    requireTechniqueDefinition(id);
    return true;
  } catch {
    return false;
  }
}

function sameStringSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

export type FieldConsumableRejection = Readonly<{ code: string; message: string }>;
/** An Undertow Snare or Free-Step Ward on the ground. */
type TidecraftField = {
  position: LatLon;
  zoneId: string;
  expiresAtMs: number;
  /** Rank 3: snares spare allies, wards protect only allies. */
  alliesOnly: boolean;
  /** Kingdom members of the owner at placement (party is checked live). */
  allyPlayerIds: ReadonlySet<string>;
  nextPullAtMs: number;
};
/** Extra input a field consumable may need from the caller. */
export type FieldConsumableUseOptions = Readonly<{ allyPlayerIds?: readonly string[] }>;
export type FieldConsumableOutcome = Readonly<{
  itemId: FieldConsumableItemId;
  hits: number;
  origin?: LatLon;
  radiusM?: number;
  /** Damage each creature took; structures in reach take the same hit. */
  damage?: number;
}>;

function battleDraughtHealthCost(player: Combatant): number {
  return Math.max(1, Math.ceil(player.maxHealth * BATTLE_DRAUGHT_HEALTH_COST_FRACTION));
}

/**
 * Damage a player's units deal in the owner's name (military units, Revenant Metal
 * undead). It counts as the owner's for PvP marks and the killer, but a
 * killing blow from it never moves PvP death gold.
 */
function isOwnedUnitTechnique(sourceTechniqueId: string | null): boolean {
  if (!sourceTechniqueId) return false;
  return sourceTechniqueId.startsWith("military_") ||
    sourceTechniqueId === REVENANT_METAL_SKELETON_TECHNIQUE_ID ||
    sourceTechniqueId === REVENANT_METAL_LICH_TECHNIQUE_ID;
}

function tacticsCapForRank(rank: number): number {
  return TACTICS_CAP_BY_RANK[Math.max(0, Math.min(TACTICS_CAP_BY_RANK.length - 1, Math.floor(rank)))] ?? 0;
}

function tacticsGainForRank(rank: number): number {
  return TACTICS_GAIN_BY_RANK[Math.max(0, Math.min(TACTICS_GAIN_BY_RANK.length - 1, Math.floor(rank)))] ?? 0;
}
