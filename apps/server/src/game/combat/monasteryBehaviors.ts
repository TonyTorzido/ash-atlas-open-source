import { MELEE_ATTACK_RANGE_M, bearingDegrees, destinationPoint, type LatLon } from "@ash-atlas/shared";

/**
 * Monastery of the Still Hand mob signatures. The engine owns all world mutation; this module holds
 * tuning, the per-mob state and pure decision helpers so each behavior is unit-testable. Distances are
 * combat meters (melee range is 100). Attack cadence is never touched: every lever is a telegraphed
 * one-off strike, a dodge, a reposition or a status.
 */

/** Every third strike of the combo is telegraphed and knocks back. */
export const INITIATE_MONK_COMBO = Object.freeze({
  /** Landed basic hits before the finisher winds up. */
  hitsBeforeFinisher: 2,
  telegraphMs: 900,
  rangeM: MELEE_ATTACK_RANGE_M * 1.6,
  angleDegrees: 90,
  damageFactor: 1.6,
  knockbackM: MELEE_ATTACK_RANGE_M * 1.5,
  techniqueId: "initiate_monk_finisher"
});

/** Spinning staff sweep around itself, then a dash onto its target. */
export const STAFF_ADEPT_SWEEP = Object.freeze({
  intervalMs: 9_000,
  firstDelayMs: 2_500,
  triggerRangeM: MELEE_ATTACK_RANGE_M * 1.5,
  telegraphMs: 1_000,
  radiusM: MELEE_ATTACK_RANGE_M * 1.4,
  damageFactor: 1.4,
  /** After the sweep it dashes to this distance from its target. */
  dashStopM: MELEE_ATTACK_RANGE_M * 0.7,
  techniqueId: "staff_adept_sweep"
});

/** Dodges some hits; after being hit twice it vanishes and reappears behind its target. */
export const SHADOW_ACROBAT = Object.freeze({
  dodgeChance: 0.3,
  hitsBeforeVanish: 2,
  behindM: MELEE_ATTACK_RANGE_M * 0.6,
  puffRadiusM: MELEE_ATTACK_RANGE_M * 0.5,
  puffMs: 600,
  dodgeId: "shadow_acrobat_dodge",
  techniqueId: "shadow_acrobat_vanish"
});

/** Dormant until a player steps close; then it awakens with a slam and keeps slamming. */
export const IRON_STATUE = Object.freeze({
  awakenRangeM: MELEE_ATTACK_RANGE_M * 1.6,
  slamIntervalMs: 10_000,
  slamTriggerRangeM: MELEE_ATTACK_RANGE_M * 1.6,
  telegraphMs: 1_200,
  radiusM: MELEE_ATTACK_RANGE_M * 1.3,
  damageFactor: 1.8,
  knockbackM: MELEE_ATTACK_RANGE_M * 1.2,
  /** Statues are never displaced by knockback, pulls or charges. */
  knockbackImmune: true,
  techniqueId: "iron_statue_slam",
  dormantId: "iron_statue_dormant",
  awakenId: "iron_statue_awaken"
});

/** Expanding ring shockwave that hurts, interrupts and silences everyone it reaches. */
export const BELL_SPIRIT_TOLL = Object.freeze({
  intervalMs: 8_000,
  firstDelayMs: 3_000,
  triggerRangeM: MELEE_ATTACK_RANGE_M * 3,
  telegraphMs: 1_400,
  radiusM: MELEE_ATTACK_RANGE_M * 2.5,
  damageFactor: 1.2,
  silenceMs: 3_000,
  techniqueId: "bell_spirit_toll"
});

/** Martial weapons still strike inside the Monastery (like bare hands); every other weapon deals nothing. */
export const MONASTERY_MARTIAL_WEAPON_FAMILIES: ReadonlySet<string> = new Set([
  "martial_arts", "brass_knuckles", "shuriken", "blowdart"
]);

/** True for archetypes that scripted leaps, knockbacks and pulls must never move (the Iron Statue). */
export function isDisplacementImmune(archetypeKey: string | null): boolean {
  return archetypeKey === "iron_statue" && IRON_STATUE.knockbackImmune;
}

export const MONASTERY_MOB_ARCHETYPES: ReadonlySet<string> = new Set([
  "initiate_monk", "staff_adept", "shadow_acrobat", "iron_statue", "bell_spirit"
]);

export type MonasteryStrikeKind = "finisher" | "sweep" | "slam" | "toll";

export type MonasteryMobState = {
  /** Landed basic hits by the monk since its last finisher. */
  comboHits: number;
  /** Hits the acrobat has taken since it last vanished. */
  hitsTaken: number;
  awake: boolean;
  nextStrikeTick: number;
  strikeKind: MonasteryStrikeKind | null;
  strikeTick: number;
  strikeCenter: LatLon | null;
  strikeBearing: number;
  strikeTargetId: string | null;
};

export function newMonasteryMobState(): MonasteryMobState {
  return {
    comboHits: 0, hitsTaken: 0, awake: false, nextStrikeTick: 0,
    strikeKind: null, strikeTick: 0, strikeCenter: null, strikeBearing: 0, strikeTargetId: null
  };
}

/** True while a monastery mob is winding up a telegraphed strike (its basic attacks pause). */
export function isWindingUp(state: MonasteryMobState | undefined): boolean {
  return state !== undefined && state.strikeKind !== null;
}

/** Counts a landed monk basic hit; true when the finisher should start winding up. */
export function countComboHit(state: MonasteryMobState): boolean {
  if (state.strikeKind !== null) return false;
  state.comboHits += 1;
  if (state.comboHits < INITIATE_MONK_COMBO.hitsBeforeFinisher) return false;
  state.comboHits = 0;
  return true;
}

/** Counts a hit the acrobat took; true when it should vanish. */
export function countAcrobatHit(state: MonasteryMobState): boolean {
  state.hitsTaken += 1;
  if (state.hitsTaken < SHADOW_ACROBAT.hitsBeforeVanish) return false;
  state.hitsTaken = 0;
  return true;
}

/** Where the acrobat reappears: just behind its target, on the far side from where it stood. */
export function behindTarget(mobPosition: LatLon, targetPosition: LatLon): LatLon {
  return destinationPoint(targetPosition, SHADOW_ACROBAT.behindM, bearingDegrees(mobPosition, targetPosition));
}

/** Where the adept's dash ends: short of its target on the line from the adept. */
export function dashStop(mobPosition: LatLon, targetPosition: LatLon): LatLon {
  return destinationPoint(targetPosition, STAFF_ADEPT_SWEEP.dashStopM, bearingDegrees(targetPosition, mobPosition));
}

export function shouldAwaken(state: MonasteryMobState, nearestPlayerM: number | null, wasHit: boolean): boolean {
  return !state.awake && (wasHit || (nearestPlayerM !== null && nearestPlayerM <= IRON_STATUE.awakenRangeM));
}
