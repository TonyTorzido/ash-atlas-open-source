import type { LatLon } from "./types.js";
import type { CombatStyleId } from "./attackProfiles.js";
import type { BossEntityOwnership, BossLifecycleState, BossEncounterProjection, BossCastSnapshot } from "./bossContracts.js";
import type { CompanionSpeciesId } from "./petSystem.js";
import type {
  ClassId,
  ClassResourceDisplayName,
  ClassResourceId,
  ClassWeaponMode,
  SubclassId
} from "./classContracts.js";
import {
  BASIC_ATTACK_INTERVAL_MS,
  MELEE_ATTACK_RANGE_M
} from "./combatConstants.js";
import type {
  MobChallengeTier,
  WeaponSwitchPolicy
} from "./equipmentBalance.js";
import type { ReadiedWeaponSlot } from "./equipmentContracts.js";
import type { WeaponCategory } from "./classes.js";
import {
  type MobArchetypeKey,
  type MobAppearanceVariant
} from "./mobContracts.js";

export {
  ALLIGATOR_FAMILY_ARCHETYPES,
  ANIMAL_MOB_ARCHETYPES,
  ANIMAL_MOB_TEMPLATES,
  BEAR_FAMILY_ARCHETYPES,
  COASTAL_CRAB_FAMILY_ARCHETYPES,
  DEER_FAMILY_ARCHETYPES,
  DUNGEON_MOB_VARIANT_BASES,
  FANTASY_MOB_ARCHETYPES,
  FANTASY_MOB_TEMPLATES,
  FROG_FAMILY_ARCHETYPES,
  HOG_FAMILY_ARCHETYPES,
  HUMANOID_MOB_ARCHETYPES,
  isAnimalMobArchetype,
  isDeerFamilyArchetype,
  isFantasyMobArchetype,
  isHumanoidMobArchetype,
  isMobFamilyArchetype,
  isWolfFamilyArchetype,
  isWorldMobTemplateKey,
  MOB_ARCHETYPE_KEYS,
  MOB_APPEARANCE_VARIANTS,
  MOB_BIOME_VARIANT_FAMILIES,
  MOB_BIOME_VARIANT_FAMILY_BASES,
  mobBehaviorArchetype,
  mobGimmickArchetype,
  mobTemplateOf,
  WOLF_FAMILY_ARCHETYPES,
  WORLD_MOB_TEMPLATE_KEYS
} from "./mobContracts.js";
export type {
  AlligatorFamilyArchetype,
  AnimalMobArchetype,
  BearFamilyArchetype,
  CoastalCrabFamilyArchetype,
  DeerFamilyArchetype,
  DungeonMobVariantArchetype,
  FantasyMobArchetype,
  FantasyMobTemplate,
  FrogFamilyArchetype,
  HogFamilyArchetype,
  HumanoidMobArchetype,
  MobArchetypeKey,
  MobAppearanceVariant,
  MobBiomeVariantArchetype,
  MobBiomeVariantFamilyBase,
  MobTemplateKey,
  WolfFamilyArchetype,
  WorldMobTemplateKey
} from "./mobContracts.js";

export {
  BASIC_ATTACK_INTERVAL_MS,
  MELEE_ATTACK_RANGE_M,
  PLAYER_RESPAWN_DELAY_MS,
  RANGED_ATTACK_RANGE_M
} from "./combatConstants.js";

export const PVE_TURN_STEP_MS = BASIC_ATTACK_INTERVAL_MS / 2;

/**
 * Periodic effects (damage over time, healing over time) tick on the combat beat: a whole number
 * of basic attack intervals, so every tick keeps the phase (player or enemy half) it started on.
 * A design interval rounds to the nearest beat count, ties to the shorter one, minimum one beat.
 */
export function beatAlignedIntervalMs(intervalMs: number): number {
  const beats = Math.max(1, Math.ceil(intervalMs / BASIC_ATTACK_INTERVAL_MS - 0.5));
  return beats * BASIC_ATTACK_INTERVAL_MS;
}

/** Per-tick multiplier that keeps a periodic effect's amount per second on its beat interval. */
export function beatAlignedAmountScale(intervalMs: number): number {
  return beatAlignedIntervalMs(intervalMs) / intervalMs;
}
export const BASIC_ATTACK_RANGE_M = MELEE_ATTACK_RANGE_M;
export const BASIC_ATTACK_APPROACH_M = MELEE_ATTACK_RANGE_M - 2;
export const FRIENDLY_TARGET_RANGE_M = 120;
export const AGGRESSIVE_FLAG_TRAVEL_LOCK_MS = 10_000;
export const FLAG_ARRIVAL_PROTECTION_MS = 4 * 60_000;
export const DEFAULT_PLAYER_MAX_HEALTH = 100;
export const DEFAULT_PLAYER_BASIC_DAMAGE = 10;
export const DEFAULT_COMBAT_SPATIAL_CELL_M = 128;
export const DEFAULT_COMBAT_INTEREST_RADIUS_M = 1_100;
export const DEFAULT_COMBAT_DELTA_HZ = 10;
export const DEFAULT_DEV_MOB_SPAWN_DISTANCE_M = 1_000;
export const COMBAT_CHASE_REEVALUATE_TICKS = 2;
export const MOB_ATTACK_HOLD_RANGE_BUFFER_M = 5;
export const BASIC_ATTACK_RESET_COOLDOWN_MS = 10_000;
export const BASIC_ATTACK_RESET_COOLDOWN_GROUP = "basic_attack_reset";
export const UNIVERSAL_TAUNT_ID = "universal_taunt";
export const UNIVERSAL_TAUNT_COOLDOWN_MS = 12_000;
export const UNIVERSAL_TAUNT_RADIUS_FACTOR = 0.5;
export const UNIVERSAL_TAUNT_PULSE_DURATION_MS = 900;
export const PVE_AGGRO_ABANDON_TIMEOUT_MS = AGGRESSIVE_FLAG_TRAVEL_LOCK_MS;
export const WOLF_PACK_COMBAT_TIMEOUT_MS = AGGRESSIVE_FLAG_TRAVEL_LOCK_MS;
/** Defensive upper bound; ordinary encounters and Taunt never approach this size. */
export const MAX_PVE_ENEMY_QUEUE_SIZE = 128;

export const RESET_ACTIVE_IDS = [
  "reaver_bloodletting_strike",
  "warden_guardians_reprisal",
  "hunter_predators_strike",
  "hunter_marked_strike",
  "hunter_cull",
  "sharpshooter_deadeye_shot",
  "stalker_rending_strike"
] as const;
export type ResetActiveId = (typeof RESET_ACTIVE_IDS)[number];

export type PveCombatPhase = "waiting_player" | "enemy_pending";

export type PveCombatSessionSnapshot = {
  sessionId: string;
  focusTargetEntityId: string | null;
  enemyQueue: string[];
  pursuingEnemyIds: string[];
  queueCursor: number;
  phase: PveCombatPhase;
  nextBasicAttackAt: number | null;
  resetWindowEndsAt: number | null;
  pendingNormalAbilityId: string | null;
  pendingResetAbilityId: string | null;
  tauntCooldownEndsAt: number;
  activeViewCenter: LatLon;
  activeViewRadiusM: number;
  activeViewGeneration: number;
  lastTauntExcludedByCap: number;
};


export type CombatEntityKind = "player" | "mob";
export const COMBAT_LIFE_STATES = ["alive", "downed", "defeated", "respawning"] as const;
export type CombatLifeState = (typeof COMBAT_LIFE_STATES)[number];
export type CombatActivityState = "idle" | "chasing" | "attacking" | "fleeing" | "returning";
export const DOG_COMPANION_MODES = ["play", "come_and_sit", "sit", "returning"] as const;
export type DogCompanionMode = (typeof DOG_COMPANION_MODES)[number];

export const HARMFUL_STATUS_IDS = [
  "poison",
  "gloom",
  "burning",
  "storm",
  "ice_slow",
  "quarry_sign",
  "exposed",
  "weakened",
  "whetted_defense",
  "whetted_attack",
  "fleet_slow",
  "immobilized",
  "vengeance_mark",
  "stunned"
] as const;
export type HarmfulStatusId = (typeof HARMFUL_STATUS_IDS)[number];

export const HARMFUL_STATUS_DISPLAY_NAMES: Readonly<Record<HarmfulStatusId, string>> = Object.freeze({
  poison: "Poisoned",
  gloom: "Withered",
  burning: "Burning",
  storm: "Electrified",
  ice_slow: "Slowed",
  quarry_sign: "Quarry Sign",
  exposed: "Exposed",
  weakened: "Weakened",
  whetted_defense: "Defense Broken",
  whetted_attack: "Attack Dulled",
  fleet_slow: "Speed Stolen",
  immobilized: "Immobilized",
  vengeance_mark: "Marked",
  stunned: "Stunned"
});

export function harmfulStatusDisplayName(statusId: HarmfulStatusId): string {
  return HARMFUL_STATUS_DISPLAY_NAMES[statusId];
}

export type ClassCombatState = {
  activeClassId?: ClassId;
  activeSubclassId?: SubclassId | null;
  resource?: {
    resourceId: ClassResourceId;
    displayName: ClassResourceDisplayName;
    current: number;
    maximum: number;
    reserved: number;
  };
  weaponMode?: ClassWeaponMode | null;
  innate?:
    | { id: "warrior_unrelenting_rage"; maxHealthBonus: number; damageBonus: number }
    | { id: "ninja_way_of_the_ninja"; armorActive: boolean; dodgeChance: number; cooldownEndsAt: number | null; invisibleEndsAt: number | null };
  rage: number;
  maximumRage: number;
  reservedRage: number;
  guard: number;
  bloodlust: number;
  classCounters?: Record<string, number>;
  statusIndicators?: Array<{
    id: string;
    label: string;
    stacks?: number;
    endsAt?: number;
  }>;
  queuedAbility: {
    abilityId: string;
    targetEntityId: string | null;
    queuedAtTick: number;
  } | null;
  cooldownEndsAt: Record<string, number>;
  cooldownGroupEndsAt?: Record<string, number>;
};

export type CombatEntitySnapshot = {
  entityId: string;
  kind: CombatEntityKind;
  archetypeKey: MobArchetypeKey | null;
  appearanceVariant?: MobAppearanceVariant;
  name: string;
  level: number;
  challengeTier?: MobChallengeTier | null;
  combatBalanceVersion?: number | null;
  regionCode: string;
  zoneId: string;
  lat: number;
  lon: number;
  maxHealth: number;
  currentHealth: number;
  ward?: number;
  invisibleUntil?: number | null;
  downedUntil?: number | null;
  respawnAvailableAt?: number | null;
  lifeState: CombatLifeState;
  activityState: CombatActivityState;
  targetEntityId: string | null;
  packId?: string | null;
  npcFaction?: Readonly<{
    cityId: string;
    cityName: string;
    culture: "goblin";
    role: "basic" | "warrior" | "archer" | "healer";
    presentationKey: string;
    relation: "neutral" | "enemy";
    protected: true;
  }> | null;
  /** `dogId` is the pet whistle id (kept for wire compatibility). */
  companion?: { ownerPlayerId: string; dogId: string; species: CompanionSpeciesId; mode: DogCompanionMode } | null;
  /** Revenant Metal undead (skeleton or Lich) fighting for `ownerPlayerId`; `level` is the skeleton level 1-6. */
  undead?: Readonly<{ ownerPlayerId: string; kind: "skeleton" | "lich"; level: number; expiresAt: number }> | null;
  /** Players only: max HP currently removed by the PvP death penalty (recovers 1 every 75 minutes). */
  maxHealthPenalty?: number;
  /** Players only: the server-resolved combat style (attackProfiles.ts) its swings use; absent = "default". */
  combatStyle?: CombatStyleId;
  revision: number;
  aggressiveUntil?: number | null;
  flagArrivalProtectionUntil?: number | null;
  aiPresentation?: MobAiPresentation | null;
  /** Server-authoritative mob temperament for overhead threat pips; absent for non-mobs. */
  hostility?: MobHostility;
  ambientSpeech?: Readonly<{ text: string; expiresAt: number }>;
  boss?: boolean;
  bossEventState?: "dormant" | "active";
  bossLifecycleState?: BossLifecycleState;
  bossOwnership?: BossEntityOwnership;
  bossEncounter?: BossEncounterProjection;
  /** Ability warnings from ordinary (non-boss) mobs, in the same shape bosses use. */
  telegraphs?: readonly BossCastSnapshot[];
  /** Positive mob states (shell, enrage, howl) with a server deadline; clients show a glow and label. */
  mobBuffs?: readonly MobBuffSnapshot[];
  attackRangeM?: number;
  controlEffects?: readonly CombatControlEffectSnapshot[];
  harmfulStatusIds?: readonly HarmfulStatusId[];
  pveCombat?: PveCombatSessionSnapshot | null;
  classCombat?: ClassCombatState | null;
  weaponCombat?: WeaponCombatState | null;
};

export const MOB_BUFF_KINDS = ["shell", "enraged", "howl", "war_roar", "reassembling", "backstab", "death_roll", "awake", "staggered", "warded"] as const;
export type MobBuffKind = (typeof MOB_BUFF_KINDS)[number];
export const MOB_BUFF_DISPLAY_NAMES: Readonly<Record<MobBuffKind, string>> = Object.freeze({
  shell: "Shelled",
  enraged: "Enraged",
  howl: "Howling",
  war_roar: "War Roar",
  reassembling: "Vulnerable",
  backstab: "Backstab",
  death_roll: "Death Roll",
  awake: "Awake",
  staggered: "Vulnerable",
  warded: "Warded"
});
export type MobBuffSnapshot = Readonly<{ kind: MobBuffKind; endsAt: number }>;

/**
 * Mob telegraphs drawn as a thin band expanding from the circle's centre to its radius over the cast (a travelling
 * ring front) instead of a filled warning circle. The geometry stays a plain circle on the wire.
 */
export const MOB_RING_TELEGRAPH_ABILITY_IDS: ReadonlySet<string> = new Set(["vault_warden_heartbeat"]);

export type CombatControlEffectSnapshot = Readonly<{
  kind: "rooted";
  endsAt: number;
}>;

export type MobAiPresentation = Readonly<{
  phase: "acquiring" | "disengaging" | "observing";
  intent: "combat" | "observe";
  deadlineAt: number | null;
  /** Full countdown length, so clients can fill a ring without guessing. */
  durationMs?: number;
  /** Player the mob is acquiring or disengaging from. */
  targetEntityId?: string | null;
}>;

export type MobHostility = "passive" | "aggressive" | "observer";

export type WeaponCombatState = {
  activeWeaponSlot: ReadiedWeaponSlot;
  activeWeaponInstanceId: string | null;
  activeWeaponCategory: WeaponCategory | null;
  switchPolicy: WeaponSwitchPolicy;
  switchingToSlot: ReadiedWeaponSlot | null;
  switchStartedAtTick: number | null;
  switchCompletesAtTick: number | null;
};

export type CombatEventType =
  | "ATTACK_LANDED"
  | "DAMAGE"
  | "HEAL"
  | "HEAL_BLOCKED"
  | "DEFEATED"
  | "RESPAWNED"
  | "TAUNT_ACTIVATED"
  | "MOB_SPAWNED"
  | "MOB_REMOVED"
  | "WEAPON_SWITCH_STARTED"
  | "WEAPON_SWITCH_COMPLETED"
  | "WEAPON_SWITCH_CANCELLED"
  | "PROFESSION_OPENING_STRIKE"
  | "PROFESSION_EXECUTED"
  | "CLASS_ABILITY_ACTIVATED"
  | "CLASS_ABILITY_ZONE_STARTED"
  | "CLASS_ABILITY_ZONE_ENDED"
  | "CLASS_INNATE_TRIGGERED"
  /** One-shot pet ability visual: `position`/`radiusM` at ground scale, source = the pet. */
  | "PET_ABILITY_EFFECT"
  /**
   * Action combat swing or shot by another player: `position` = origin, `radiusM` = reach,
   * `abilityId` = "swing_<step>" (plus "@<profile id>" for a non-default attack profile) | "shot", `facingDegrees` = aim bearing.
   * For "shot", `radiusM` = distance along the aim line to the mob hit (`targetEntityId`), or SHOT_RANGE_M on a miss.
   */
  | "SWING";

export type CombatEvent = {
  eventId: string;
  type: CombatEventType;
  tick: number;
  sourceEntityId: string | null;
  targetEntityId: string | null;
  amount?: number;
  professionBonusAmount?: number;
  presentationDelayMs?: number;
  packetIndex?: number;
  packetCount?: number;
  currentHealth?: number;
  position?: LatLon;
  radiusM?: number;
  abilityId?: string;
  /** Compass bearing (0 = north, 90 = east) of a SWING event. */
  facingDegrees?: number;
  durationMs?: number;
  weaponSlot?: ReadiedWeaponSlot;
  previousWeaponSlot?: ReadiedWeaponSlot;
  harmfulStatusId?: HarmfulStatusId;
  innateFeedback?: "FOCUS" | "DODGE" | "INVISIBLE" | "IMMUNE";
  innateId?: string;
};

export function universalTauntRadiusM(activeViewRadiusM: number): number {
  return activeViewRadiusM * UNIVERSAL_TAUNT_RADIUS_FACTOR;
}

export type CombatStateBatch = {
  serverTick: number;
  serverTime: number;
  sequence: number;
  upserts: CombatEntitySnapshot[];
  removedEntityIds: string[];
  events: CombatEvent[];
};

export type CombatPosition = LatLon;

export function millisecondsToTicks(milliseconds: number, tickRateHz: number): number {
  return Math.max(1, Math.round((milliseconds / 1_000) * tickRateHz));
}
