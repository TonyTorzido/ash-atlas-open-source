import {
  BASIC_ATTACK_INTERVAL_MS,
  MELEE_ATTACK_RANGE_M,
  RANGED_ATTACK_RANGE_M,
  bearingDegrees,
  destinationPoint,
  distanceMeters,
  dungeonLocalDistanceToCombatMeters,
  ringSlotPosition,
  type LatLon,
  type MobSignatureKind
} from "@ash-atlas/shared";
import { ANIMAL_GIMMICKS, type GimmickStrikeKind } from "./mobGimmicks.js";

/**
 * Archetype-specific behavior hooks for the Cistern Warrens mobs. The engine owns
 * all world mutation; this module only holds tuning, per-mob state, and pure
 * decision helpers so each signature behavior is unit-testable. All distances
 * are combat meters (melee range is 100, ranged range is 300).
 */

export const SHELLBACK_TURTLE = Object.freeze({
  /** Withdraw once a hit leaves the turtle at or below this health ratio. */
  withdrawHealthRatio: 0.5,
  shellDurationMs: 4_000,
  shellCooldownMs: 16_000
});

export const SEWER_SPIDER_WEB = Object.freeze({
  rangeM: RANGED_ATTACK_RANGE_M,
  /** Webs are opening shots; the spider bites instead once it is this close. */
  minRangeM: MELEE_ATTACK_RANGE_M * 1.2,
  rootDurationMs: 2_000,
  cooldownMs: 9_000,
  techniqueId: "sewer_spider_web"
});

export const DUNE_TICK_HOP: HopProfile = Object.freeze({
  leapMinDistanceM: MELEE_ATTACK_RANGE_M * 1.5,
  leapLandingRadiusM: MELEE_ATTACK_RANGE_M * 0.4,
  awayDistanceM: MELEE_ATTACK_RANGE_M * 2.2,
  leapCooldownMs: 1_800
});

export type HopProfile = Readonly<{
  leapMinDistanceM: number;
  leapLandingRadiusM: number;
  awayDistanceM: number;
  leapCooldownMs: number;
}>;

/** Cave bats flutter in and out faster and closer than fleas do. */
export const CAVE_BAT_HOP: HopProfile = Object.freeze({
  leapMinDistanceM: MELEE_ATTACK_RANGE_M * 1.2,
  leapLandingRadiusM: MELEE_ATTACK_RANGE_M * 0.5,
  awayDistanceM: MELEE_ATTACK_RANGE_M * 1.6,
  leapCooldownMs: 1_200
});
/** Fraction of bite damage a cave bat heals. */
export const CAVE_BAT_LIFESTEAL = 0.3;

/** Mobs the Raptor Runt shriek and the Raptor Chieftain war roar apply to. */
export const RAPTOR_FAMILY: readonly string[] = Object.freeze(["cave_raptor", "raptor_runt", "raptor_spitter"]);

export const CAVE_RAPTOR_POUNCE = Object.freeze({
  minDistanceM: MELEE_ATTACK_RANGE_M * 1.5,
  flankRadiusM: MELEE_ATTACK_RANGE_M * 0.7,
  stackedDistanceM: MELEE_ATTACK_RANGE_M * 0.35,
  pounceCooldownMs: 6_000,
  respreadCooldownMs: 2_000
});

export const RAPTOR_RUNT = Object.freeze({
  fleeHealthRatio: 0.3,
  fleeDistanceM: MELEE_ATTACK_RANGE_M * 5,
  /** Idle raptors within this distance of the shriek answer it (about one dungeon room). */
  shriekRadiusM: dungeonLocalDistanceToCombatMeters(1_400)
});

/** Hostile zone damage (acid, ink, spore clouds) was designed as one hit per second of the cloud's life. */
export const ACID_ZONE_DESIGN_TICK_MS = 1_000;

/**
 * Per-tick damage multiplier that keeps a cloud's total damage over its life: the old number of
 * one-second ticks over the new number of beat ticks. Ticks start when the cloud lands, so a cloud
 * of `durationTicks` ticks holds one tick at 0 and one per interval while below its end.
 */
export function acidZoneTickDamageScale(durationTicks: number, designIntervalTicks: number, beatIntervalTicks: number): number {
  const oldTicks = Math.max(1, Math.ceil(durationTicks / designIntervalTicks));
  const newTicks = Math.max(1, Math.ceil(durationTicks / beatIntervalTicks));
  return oldTicks / newTicks;
}

export const RAPTOR_SPITTER = Object.freeze({
  backoffDistanceM: MELEE_ATTACK_RANGE_M * 1.2,
  backoffStepM: MELEE_ATTACK_RANGE_M * 1.5,
  backoffCooldownMs: 2_500,
  spitIntervalMs: 7_000,
  zoneDelayMs: 800,
  zoneDurationMs: 3_000,
  /** One beat per tick (the 1.4 s environment). */
  zoneTickMs: BASIC_ATTACK_INTERVAL_MS,
  zoneRadiusM: MELEE_ATTACK_RANGE_M * 0.8,
  /** Zone damage per tick as a fraction of the spitter attack. */
  zoneDamageFactor: 0.6,
  techniqueId: "raptor_spitter_acid"
});

/** Per-hit damage multiplier for raptors under the chieftain war roar (attack cadence stays uniform). */
/** Nest mice dart in, bite, and scurry well clear (toward cover) before the next run. */
export const NEST_MOUSE_HOP: HopProfile = Object.freeze({
  leapMinDistanceM: MELEE_ATTACK_RANGE_M * 1.2,
  leapLandingRadiusM: MELEE_ATTACK_RANGE_M * 0.4,
  awayDistanceM: MELEE_ATTACK_RANGE_M * 2.2,
  leapCooldownMs: 1_500
});
/** The nest mouse bite slows its target briefly (gold theft has no existing hook). */
export const NEST_MOUSE_SLOW = Object.freeze({ durationMs: 2_000, amount: 0.3, techniqueId: "nest_mouse_bite" });

/** Where idle hawks answer a carrion chick screech (about one dungeon room). */
export const CARRION_SCREECH_RADIUS_M = dungeonLocalDistanceToCombatMeters(1_400);

export const CLIFF_HAWK = Object.freeze({
  /** Hawks keep at least this far from their target while circling. */
  keepRangeM: MELEE_ATTACK_RANGE_M * 1.2,
  diveIntervalMs: 7_000,
  diveDelayMs: 1_000,
  diveRadiusM: MELEE_ATTACK_RANGE_M * 0.9,
  diveMinRangeM: MELEE_ATTACK_RANGE_M * 1.2,
  /** Dive damage as a multiple of the hawk attack. */
  diveDamageFactor: 2.5,
  climbMs: 2_500,
  climbDistanceM: MELEE_ATTACK_RANGE_M * 4,
  techniqueId: "cliff_hawk_dive"
});

/** Rot wolves hit harder for every other wolf on the same target (per-hit, cadence stays uniform). */
export const ROT_WOLF_PACK = Object.freeze({
  radiusM: MELEE_ATTACK_RANGE_M * 2.5,
  bonusPerAlly: 0.12,
  maxBonus: 0.36
});

/** Tuning for a telegraphed straight-line charge (blighted stag, hog). */
export type ChargeProfile = Readonly<{
  chargeIntervalMs: number;
  telegraphMs: number;
  minRangeM: number;
  maxRangeM: number;
  overshootM: number;
  widthM: number;
  damageFactor: number;
  knockbackM: number;
  missStunMs: number;
  sampleStepM: number;
  techniqueId: string;
}>;

export const BLIGHTED_STAG: ChargeProfile = Object.freeze({
  chargeIntervalMs: 9_000,
  telegraphMs: 1_200,
  minRangeM: MELEE_ATTACK_RANGE_M * 2,
  maxRangeM: MELEE_ATTACK_RANGE_M * 6,
  overshootM: MELEE_ATTACK_RANGE_M,
  widthM: MELEE_ATTACK_RANGE_M * 0.7,
  damageFactor: 2,
  knockbackM: MELEE_ATTACK_RANGE_M * 2,
  /** Punish window: a charge that hits nobody leaves the stag stunned this long. */
  missStunMs: 2_000,
  sampleStepM: MELEE_ATTACK_RANGE_M * 0.25,
  techniqueId: "blighted_stag_charge"
});

export const HOG_CHARGE: ChargeProfile = Object.freeze({
  chargeIntervalMs: 8_000,
  telegraphMs: 1_500,
  minRangeM: MELEE_ATTACK_RANGE_M * 1.8,
  maxRangeM: MELEE_ATTACK_RANGE_M * 5,
  overshootM: MELEE_ATTACK_RANGE_M * 0.8,
  widthM: MELEE_ATTACK_RANGE_M * 0.6,
  damageFactor: 1.5,
  knockbackM: MELEE_ATTACK_RANGE_M * 1.2,
  /** Unused by the hog template: a missed hog charge staggers via DODGE_REWARD instead (the stag keeps missStunMs). */
  missStunMs: 1_500,
  sampleStepM: MELEE_ATTACK_RANGE_M * 0.25,
  techniqueId: "hog_charge"
});

/**
 * Dodging pays: a telegraphed charge, maul, slam or swoop that hits no player leaves the mob staggered
 * (no move, attack or new ability, and it takes extra damage); one that lands only costs a short recovery.
 */
export const DODGE_REWARD = Object.freeze({
  staggerMs: 5_000,
  staggerDamageFactor: 1.25,
  /** Melee hits (basic or weapon strikes by a non-ranged attacker) land harder than spells and arrows while vulnerable. */
  staggerMeleeDamageFactor: 1.5,
  recoveryMs: 600
});

/** Ordinary animal hogs (boar, warthog, ...) charge softer than the fantasy hog-template mobs. */
export const HOG_CHARGE_ANIMAL: ChargeProfile = Object.freeze({
  ...HOG_CHARGE,
  damageFactor: ANIMAL_GIMMICKS.hogChargeDamageFactor
});

export const THORNFERN = Object.freeze({
  volleyIntervalMs: 5_000,
  volleyDamageFactor: 1.5,
  /** Melee attackers inside this distance of a thornfern get poisoned by its thorns. */
  thornsRangeM: MELEE_ATTACK_RANGE_M * 1.5,
  techniqueId: "thornfern_volley"
});

export const BLIGHT_TREANT = Object.freeze({
  slamIntervalMs: 8_000,
  slamTriggerRangeM: MELEE_ATTACK_RANGE_M * 2,
  slamRadiusM: MELEE_ATTACK_RANGE_M * 1.2,
  slamRootMs: 1_500,
  /** One beat per regen tick; 2.1% per beat keeps the old 1.5% per second. */
  regenIntervalMs: BASIC_ATTACK_INTERVAL_MS,
  regenFraction: 0.021,
  /** No regeneration for this long after the treant is hit or burned. */
  noRegenAfterHitMs: 4_000,
  techniqueId: "blight_treant_slam"
});

export const BLIGHT_SPRITE = Object.freeze({
  burstRangeM: MELEE_ATTACK_RANGE_M,
  /** The sprite lights a fuse in burst range; the telegraph shows for this long before it pops. */
  fuseMs: 700,
  cloudRadiusM: MELEE_ATTACK_RANGE_M * 0.9,
  cloudDelayMs: 300,
  cloudDurationMs: 4_000,
  cloudDamageFactor: 0.4,
  techniqueId: "blight_sprite_cloud"
});

export const WAR_ROAR_DAMAGE_MULTIPLIER = 1.35;

export const SPIDERLING_SWARM = Object.freeze({
  radiusM: MELEE_ATTACK_RANGE_M * 1.5,
  bonusPerAlly: 0.15,
  maxBonus: 0.45
});

export const SPIDERLING_RETREAT = Object.freeze({
  /** Below this health ratio a spiderling falls back to guard the Brood Matriarch. */
  healthRatio: 0.3,
  arriveDistanceM: MELEE_ATTACK_RANGE_M * 0.6
});

/** Chance that a basic hit from the archetype poisons the player. */
export const POISON_BITE_CHANCE: Readonly<Record<string, number>> = Object.freeze({
  sick_sewer_rat: 0.5,
  brood_matriarch: 1,
  rot_wolf: 0.6
});

export type MobSpecialState = {
  shellUntilTick: number;
  nextShellTick: number;
  nextWebTick: number;
  nextHopTick: number;
  hopAwayPending: boolean;
  retreatToEntityId: string | null;
  retreatArrived: boolean;
  fleeDestination: LatLon | null;
  fled: boolean;
  nextSpitTick: number;
  nextBackoffTick: number;
  roarUntilTick: number;
  screeched: boolean;
  nextDiveTick: number;
  diveHitTick: number;
  diveCenter: LatLon | null;
  diveTargetId: string | null;
  climbing: boolean;
  climbUntilTick: number;
  chargeOrigin: LatLon | null;
  chargeBearing: number;
  chargeLengthM: number;
  chargeHitTick: number;
  /** Wall-clock ms the charge telegraph resolves at; damage never lands earlier. */
  chargeResolveAt: number;
  nextChargeTick: number;
  stunUntilTick: number;
  /** Dodged-strike stagger: the mob takes DODGE_REWARD.staggerDamageFactor damage until this tick. */
  staggerUntilTick: number;
  /** Action combat swing hitstun: the mob neither walks nor strikes until this tick. */
  hitstunUntilTick: number;
  /** Action combat melee windup: the basic strike telegraphed at windup start, resolved at `dueTick` (null = none). */
  pendingBasicStrike: PendingBasicStrike | null;
  /** Mob AI Phase 2: the live signature move (telegraphed, resolved at `dueTick`), null = none. */
  pendingSignature: PendingSignature | null;
  /** Mob AI Phase 2: earliest tick the next signature may start (per-mob cooldown; survives a target swap). */
  archSignatureReadyTick: number;
  /** Skeleton pile: drives the "reassembling" buff only; the pile is vulnerable like a stagger and takes damage. */
  reassembleUntilTick: number;
  nextSlamTick: number;
  nextRegenTick: number;
  lastHitTick: number;
  lastBurnTick: number;
  /** Shared cooldown for the everyday-mob telegraphed strikes (slam, maul, bomb, tongue, ink, blink). */
  nextGimmickTick: number;
  strikeKind: GimmickStrikeKind | null;
  strikeTick: number;
  /** Wall-clock ms the strike telegraph resolves at; damage never lands earlier. */
  strikeResolveAt: number;
  strikeCenter: LatLon | null;
  strikeBearing: number;
  strikeLengthM: number;
  strikeTargetId: string | null;
  /** One-shot trigger used by threshold gimmicks (bolt, howl, enrage, reassemble, squeak, split). */
  triggered: boolean;
  biteCount: number;
  guardUntilTick: number;
  backstabUntilTick: number;
  returnTargetId: string | null;
  splitChild: boolean;
  /** Blight sprite fuse: the burst lands at this tick (0 = not lit). */
  fuseTick: number;
  /** A summoned add (Gate Warden rift) is removed at this tick (0 = never). */
  despawnAtTick: number;
  /** Pounce: the target this mob already landed its opening hit on (null = pounce ready). */
  pounceTargetId: string | null;
};

/** A wound-up basic strike: it lands only if its target is still inside this cone when it resolves. */
export type PendingBasicStrike = {
  targetEntityId: string;
  /** Tick the strike resolves at (a hitstun only pushes it later). */
  dueTick: number;
  origin: LatLon;
  facingDegrees: number;
  rangeM: number;
  /** Mob tactics ranged aim: a locked lane (`rangeM` long, `widthM` wide) instead of the melee cone. */
  shape?: "line";
  widthM?: number;
  /** Mob AI Phase 2: cone angle when not the 90-degree basic cone (swarm wave), the telegraph id, and the hit factor. */
  angleDeg?: number;
  abilityId?: string;
  damageFactor?: number;
};

/** Mob AI Phase 2 signature move in flight: shape locked at telegraph start (re-aimed only for a double strike's second cone). */
export type PendingSignature = {
  kind: MobSignatureKind;
  targetEntityId: string;
  /** 0, or 1 for the double strike's second cone. */
  part: number;
  dueTick: number;
  /** Cone or lane origin, or circle centre. */
  origin: LatLon;
  facingDegrees: number;
  /** Lane length (charge, tongue, lunge). */
  lengthM: number;
  /** Lunge: distance along the lane the mob stops at (next to the locked player position). */
  stopM: number;
  /** Any part landed on someone. */
  anyHit: boolean;
};

export function newMobSpecialState(): MobSpecialState {
  return { shellUntilTick: 0, nextShellTick: 0, nextWebTick: 0, nextHopTick: 0, hopAwayPending: false, retreatToEntityId: null, retreatArrived: false,
    fleeDestination: null, fled: false, nextSpitTick: 0, nextBackoffTick: 0, roarUntilTick: 0,
    screeched: false, nextDiveTick: 0, diveHitTick: 0, diveCenter: null, diveTargetId: null,
    climbing: false, climbUntilTick: 0,
    chargeOrigin: null, chargeBearing: 0, chargeLengthM: 0, chargeHitTick: 0, chargeResolveAt: 0, nextChargeTick: 0,
    stunUntilTick: 0, staggerUntilTick: 0, hitstunUntilTick: 0, pendingBasicStrike: null, pendingSignature: null, archSignatureReadyTick: 0, reassembleUntilTick: 0, nextSlamTick: 0, nextRegenTick: 0, lastHitTick: -1_000_000, lastBurnTick: -1_000_000,
    nextGimmickTick: 0, strikeKind: null, strikeTick: 0, strikeResolveAt: 0, strikeCenter: null, strikeBearing: 0, strikeLengthM: 0,
    strikeTargetId: null, triggered: false, biteCount: 0, guardUntilTick: 0, backstabUntilTick: 0,
    returnTargetId: null, splitChild: false, fuseTick: 0, despawnAtTick: 0, pounceTargetId: null };
}

export function isShelled(state: MobSpecialState | undefined, tick: number): boolean {
  return state !== undefined && state.shellUntilTick > tick;
}

/** True when a hit has dropped the turtle into its withdraw window and it is off cooldown. */
export function shouldWithdrawIntoShell(
  state: MobSpecialState,
  currentHealth: number,
  maxHealth: number,
  tick: number
): boolean {
  return currentHealth > 0 &&
    currentHealth <= maxHealth * SHELLBACK_TURTLE.withdrawHealthRatio &&
    state.shellUntilTick <= tick &&
    tick >= state.nextShellTick;
}

export function shouldWebTarget(
  state: MobSpecialState,
  distanceM: number,
  tick: number
): boolean {
  return tick >= state.nextWebTick &&
    distanceM >= SEWER_SPIDER_WEB.minRangeM &&
    distanceM <= SEWER_SPIDER_WEB.rangeM;
}

function hashUnit(seed: string): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash = Math.imul(hash ^ seed.charCodeAt(index), 16777619);
  }
  return ((hash >>> 0) % 100_000) / 100_000;
}

function offsetMeters(origin: LatLon, bearingRad: number, meters: number): LatLon {
  const metersPerDegree = 111_320;
  return {
    lat: origin.lat + (Math.cos(bearingRad) * meters) / metersPerDegree,
    lon: origin.lon + (Math.sin(bearingRad) * meters) /
      (metersPerDegree * Math.max(0.01, Math.cos((origin.lat * Math.PI) / 180)))
  };
}

/**
 * Candidate hop landings in preference order. "leap" lands beside the target
 * (ready to bite); "away" lands on the far side after a bite. Bearings are
 * deterministic per mob and tick so replays and tests are stable.
 */
export function fleaHopCandidates(
  mode: "leap" | "away",
  entityId: string,
  tick: number,
  mobPosition: LatLon,
  targetPosition: LatLon,
  profile: HopProfile = DUNE_TICK_HOP
): LatLon[] {
  const base = hashUnit(`${entityId}:${tick}:${mode}`) * Math.PI * 2;
  const candidates: LatLon[] = [];
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const bearing = base + (attempt * Math.PI) / 2;
    candidates.push(mode === "leap"
      ? offsetMeters(targetPosition, bearing, profile.leapLandingRadiusM)
      : offsetMeters(mobPosition, bearing, profile.awayDistanceM));
  }
  return candidates;
}

/** Spiderlings bite harder the more of their swarm is on the same target. */
export function spiderlingSwarmDamageFactor(alliesOnTarget: number): number {
  return 1 + Math.min(SPIDERLING_SWARM.maxBonus, Math.max(0, alliesOnTarget) * SPIDERLING_SWARM.bonusPerAlly);
}

export function fleaLeapDue(
  state: MobSpecialState,
  mobPosition: LatLon,
  targetPosition: LatLon,
  tick: number,
  profile: HopProfile = DUNE_TICK_HOP
): boolean {
  return tick >= state.nextHopTick &&
    distanceMeters(mobPosition, targetPosition) > profile.leapMinDistanceM;
}

export function shouldSpiderlingRetreat(
  state: MobSpecialState,
  currentHealth: number,
  maxHealth: number
): boolean {
  return state.retreatToEntityId === null && currentHealth > 0 &&
    currentHealth < maxHealth * SPIDERLING_RETREAT.healthRatio;
}

export function isRetreatingToGuard(state: MobSpecialState | undefined): boolean {
  return state !== undefined && (
    (state.retreatToEntityId !== null && !state.retreatArrived) || state.fleeDestination !== null || state.climbing
  );
}

/**
 * Spread slot for the index-th of count raptors around one target. Slots are evenly spaced so
 * raptors on the same target flank it instead of stacking; the ring is offset per target so it
 * does not always start due north.
 */
export function flankSlotPosition(
  index: number,
  count: number,
  targetPosition: LatLon,
  radiusM: number = CAVE_RAPTOR_POUNCE.flankRadiusM
): LatLon {
  const safeCount = Math.max(1, count);
  return ringSlotPosition(targetPosition, radiusM, ((index % safeCount) / safeCount) * 360 + 45);
}

export function shouldRuntFlee(state: MobSpecialState, currentHealth: number, maxHealth: number): boolean {
  return !state.fled && currentHealth > 0 && currentHealth < maxHealth * RAPTOR_RUNT.fleeHealthRatio;
}

/** A point straight away from the attacker. */
export function runtFleeDestination(runtPosition: LatLon, attackerPosition: LatLon): LatLon {
  return destinationPoint(runtPosition, RAPTOR_RUNT.fleeDistanceM, bearingDegrees(attackerPosition, runtPosition));
}

/** Where a spitter steps when meleed: directly away from the target. */
export function spitterBackoffDestination(spitterPosition: LatLon, targetPosition: LatLon): LatLon {
  return destinationPoint(spitterPosition, RAPTOR_SPITTER.backoffStepM, bearingDegrees(targetPosition, spitterPosition));
}

export function shouldSpitterBackOff(state: MobSpecialState, distanceM: number, tick: number): boolean {
  return tick >= state.nextBackoffTick && distanceM < RAPTOR_SPITTER.backoffDistanceM;
}

export function shouldSpit(state: MobSpecialState, distanceM: number, attackRangeM: number, tick: number): boolean {
  return tick >= state.nextSpitTick && distanceM <= attackRangeM && distanceM >= RAPTOR_SPITTER.backoffDistanceM * 0.5;
}

export type AcidZone = {
  /** Room the zone belongs to; lets a cloud outlive the mob that made it. */
  zoneId?: string;
  radiusM?: number;
  techniqueId?: string;
  /** Also poisons everyone standing in the zone each tick. */
  poison?: boolean;
  /** Also sets everyone standing in the zone burning (lava hazards). */
  burning?: boolean;
  /** Also slows everyone standing in the zone (ink cloud). */
  slow?: { durationMs: number; amount: number };
  sourceEntityId: string;
  center: LatLon;
  landTick: number;
  endTick: number;
  nextTick: number;
  damage: number;
  /** Fraction of a tick's damage not yet dealt, per victim (rescaled ticks are not whole numbers). */
  carry?: Map<string, number>;
};

export function caveBatLifesteal(damageDealt: number): number {
  return damageDealt > 0 ? Math.max(1, Math.round(damageDealt * CAVE_BAT_LIFESTEAL)) : 0;
}

export function isWarRoared(state: MobSpecialState | undefined, tick: number): boolean {
  return state !== undefined && state.roarUntilTick > tick;
}

export function shouldScreech(state: MobSpecialState): boolean {
  return !state.screeched;
}

export function shouldStartHawkDive(state: MobSpecialState, distanceM: number, attackRangeM: number, tick: number): boolean {
  return state.diveCenter === null && !state.climbing && tick >= state.nextDiveTick &&
    distanceM >= CLIFF_HAWK.diveMinRangeM && distanceM <= attackRangeM + MELEE_ATTACK_RANGE_M;
}

export function hawkKeepsRange(state: MobSpecialState, distanceM: number, tick: number): boolean {
  return state.diveCenter === null && tick >= state.nextBackoffTick && distanceM < CLIFF_HAWK.keepRangeM;
}

/** Where a diving hawk climbs to: straight away from the dive point. */
export function hawkClimbDestination(from: LatLon, diveCenter: LatLon, fallbackBearingDegrees: number): LatLon {
  const bearing = distanceMeters(from, diveCenter) < 1 ? fallbackBearingDegrees : bearingDegrees(diveCenter, from);
  return destinationPoint(from, CLIFF_HAWK.climbDistanceM, bearing);
}

export function packDamageFactor(alliesOnTarget: number): number {
  return 1 + Math.min(ROT_WOLF_PACK.maxBonus, Math.max(0, alliesOnTarget) * ROT_WOLF_PACK.bonusPerAlly);
}

export function isStunned(state: MobSpecialState | undefined, tick: number): boolean {
  return state !== undefined && state.stunUntilTick > tick;
}

export function shouldStagCharge(
  state: MobSpecialState, distanceM: number, tick: number, profile: ChargeProfile = BLIGHTED_STAG
): boolean {
  return state.chargeOrigin === null && tick >= state.nextChargeTick && tick >= state.stunUntilTick &&
    distanceM >= profile.minRangeM && distanceM <= profile.maxRangeM;
}

export function chargeLengthTo(distanceM: number, profile: ChargeProfile = BLIGHTED_STAG): number {
  return Math.min(profile.maxRangeM, distanceM + profile.overshootM);
}

/** Evenly spaced points along a charge lane, including both ends. */
export function chargeLaneSamples(
  origin: LatLon, bearing: number, lengthM: number, profile: ChargeProfile = BLIGHTED_STAG
): LatLon[] {
  const steps = Math.max(1, Math.ceil(lengthM / profile.sampleStepM));
  const samples: LatLon[] = [];
  for (let index = 0; index <= steps; index += 1) {
    samples.push(destinationPoint(origin, (lengthM * index) / steps, bearing));
  }
  return samples;
}

export function laneHitsPoint(
  samples: readonly LatLon[], point: LatLon, profile: ChargeProfile = BLIGHTED_STAG
): boolean {
  return samples.some((sample) => distanceMeters(sample, point) <= profile.widthM);
}

export function treantMayRegenerate(state: MobSpecialState | undefined, tick: number, tickRateHz: number): boolean {
  if (!state) return true;
  const quietTicks = Math.ceil(BLIGHT_TREANT.noRegenAfterHitMs * tickRateHz / 1_000);
  return tick - state.lastHitTick >= quietTicks && tick - state.lastBurnTick >= quietTicks;
}
