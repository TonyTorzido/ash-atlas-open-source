import {
  MOB_ARCH_KNOCKBACK_CAP_M,
  MOB_ARCHETYPE_IDS,
  MOB_ARCHETYPE_PARAMS,
  MOB_SIGNATURES,
  MOB_TACTICS_TIER_COST,
  mobArchetypeAssignment,
  mobArchetypeReachOverrideM,
  circleVsCircle,
  circleVsCone,
  circleVsRect,
  hurtShapeReachM,
  PLAYER_HURT_RADIUS_M,
  scaleMobArchetypeParams,
  scaleMobSignature,
  tacticsMsToTicks,
  type MobArchetypeId,
  type MobChallengeTier,
  type MobSignatureKind,
  type MobSignatureParams
} from "@ash-atlas/shared";

import { BEAR_MAUL, OGRE_SLAM } from "./mobGimmicks.js";
import { HOG_CHARGE } from "./mobSpecialBehaviors.js";
import type { ArchetypeTacticsState } from "./mobTactics.js";

/**
 * Pure helpers for Mob AI Phase 2 (docs/plans/mob-ai-phase2.md): archetype resolution at join,
 * token costs, signature timing, shapes and hit tests. No engine types; the engine converts world
 * positions to a local metre frame (x east, y north) around the shape's origin and calls these.
 */

/** A cancelled signature (target swap, hand-back) cannot start again for this long (spec 6.3). */
export const SIGNATURE_CANCEL_LOCKOUT_MS = 1_500;
/** Pack mates circle one shared way per target, flipping every 6 to 10 s (spec 4.1). */
export const PACK_ORBIT_FLIP_MIN_MS = 6_000;
export const PACK_ORBIT_FLIP_MAX_MS = 10_000;
/** Clear-lane check sample step along the lane (owner decision 6). */
export const SIGNATURE_LANE_SAMPLE_M = 25;

/** Parses MOB_ARCHETYPES_ONLY (comma list; empty = every archetype). Unknown names are ignored. */
export function parseArchetypesOnly(raw: string | null | undefined): ReadonlySet<MobArchetypeId> | null {
  const names = (raw ?? "").split(",").map((name) => name.trim().toLowerCase()).filter((name) => name.length > 0);
  if (names.length === 0) return null;
  const known = new Set<string>(MOB_ARCHETYPE_IDS);
  return new Set(names.filter((name) => known.has(name)) as MobArchetypeId[]);
}

/**
 * Token cost for an archetype cost and a challenge tier (spec 4.1): epic and legendary pay the
 * Phase 1 tier cost when it is higher; the Swarmer's 0.5 applies to common mobs only.
 */
export function archetypeTokenCost(archetypeCost: number, tier: MobChallengeTier): number {
  const tierCost = MOB_TACTICS_TIER_COST[tier];
  if (archetypeCost < 1 && tier !== "common") return Math.max(1, tierCost);
  return Math.max(archetypeCost, tier === "common" ? 0 : tierCost);
}

/**
 * Archetype state for a mob key at join, or null (unmapped, excluded, or filtered out by the
 * rollout list). The Swarmer's pile-on wave is its basic strike, so it carries no signature here.
 * `telegraphScale` (MOB_TELEGRAPH_SCALE) multiplies the basic windup and every signature telegraph part.
 */
export function resolveArchetypeTactics(
  archetypeKey: string | null,
  tier: MobChallengeTier,
  only: ReadonlySet<MobArchetypeId> | null,
  tickRateHz: number,
  telegraphScale = 1
): ArchetypeTacticsState | null {
  if (!archetypeKey) return null;
  const assignment = mobArchetypeAssignment(archetypeKey);
  if (!assignment || (only !== null && !only.has(assignment.archetype))) return null;
  const params = scaleMobArchetypeParams(MOB_ARCHETYPE_PARAMS[assignment.archetype], telegraphScale);
  const kind: MobSignatureKind = assignment.signature;
  const signature = kind === "none" || kind === "pile_on_wave" ? null : scaleMobSignature(MOB_SIGNATURES[kind], telegraphScale);
  return {
    archetype: assignment.archetype,
    params,
    signature,
    signaturePartTicks: signature ? signaturePartTicks(signature, tickRateHz) : [],
    signatureCost: archetypeTokenCost(params.signatureTokenCost, tier),
    basicDamageFactor: params.basicDamageFactor,
    reachOverrideM: assignment.archetype === "caster" ? mobArchetypeReachOverrideM(archetypeKey) : null,
    inSignature: false,
    retreatUntilTick: 0,
    retreatReadyTick: 0,
    hopUntilTick: 0,
    hopReadyTick: 0,
    hopBearingDeg: 0,
    hopRemainingM: 0,
    waveId: null
  };
}

/** Landing offsets (ticks from the start) of each part: one, or two for the double strike. */
export function signaturePartTicks(signature: MobSignatureParams, tickRateHz: number): number[] {
  const offsets: number[] = [];
  let total = 0;
  for (const ms of signature.telegraphMs) {
    total += tacticsMsToTicks(ms, tickRateHz);
    offsets.push(total);
  }
  return offsets;
}

/** Damage factor of one signature part: the milder animal value for ordinary animals. */
export function signatureDamageFactor(signature: MobSignatureParams, animal: boolean): number {
  return animal ? signature.damageFactorAnimal : signature.damageFactor;
}

/** Knockback of a managed signature: the legacy push, capped at MOB_ARCH_KNOCKBACK_CAP_M (owner decision 3). */
export function signatureKnockbackM(kind: MobSignatureKind): number {
  const legacy = kind === "charge" ? HOG_CHARGE.knockbackM
    : kind === "maul" ? BEAR_MAUL.knockbackM
      : kind === "slam" ? OGRE_SLAM.knockbackM
        : 0;
  return Math.min(legacy, MOB_ARCH_KNOCKBACK_CAP_M);
}

/**
 * Lane length toward a target `distanceM` away. Charge and tongue run past the target, capped at the shape's
 * range. The lunge lane is its 160 m, stretched to reach a target farther out in its trigger window (up to 240 m),
 * so a lunge started from the wait band can land on a player standing still.
 */
export function signatureLaneLengthM(signature: MobSignatureParams, distanceM: number): number {
  if (signature.kind === "charge") return Math.min(signature.rangeM, distanceM + HOG_CHARGE.overshootM);
  if (signature.kind === "lunge") {
    return Math.min(signature.triggerMaxM + signature.widthM / 2, Math.max(signature.rangeM, distanceM + signature.widthM / 2));
  }
  if (signature.kind === "tongue") return Math.min(signature.rangeM + signature.widthM / 2, distanceM + signature.widthM / 2);
  return signature.rangeM;
}

/** Signed difference `to - from` in (-180, 180]. */
function angleDiff(fromDeg: number, toDeg: number): number {
  let diff = ((toDeg - fromDeg) % 360 + 360) % 360;
  if (diff > 180) diff -= 360;
  return diff;
}

/**
 * Signature shapes hit the player through the player's ground hurt circle (hitGeometry.ts). The table sizes
 * (MOB_SIGNATURES rangeM / radiusM / lane length) are the effective centre-to-centre reach the AI triggers on; the
 * decal is drawn and tested PLAYER_HURT_RADIUS_M short of them so it still connects there. Lane and cone widths are
 * not shrunk: any part of the hurt circle on the decal is a hit.
 */
export function signatureDrawnM(effectiveM: number, hurtRadiusM: number = PLAYER_HURT_RADIUS_M): number {
  return hurtShapeReachM(effectiveM, hurtRadiusM);
}

/** Does a hurt circle of `hurtRadiusM` at local (x east, y north) overlap a cone of `angleDeg` and `rangeM` along `facingDeg`? */
export function signatureConeContains(
  facingDeg: number, rangeM: number, angleDeg: number, x: number, y: number, hurtRadiusM = 0
): boolean {
  return circleVsCone(facingDeg, rangeM, angleDeg, x, y, hurtRadiusM);
}

/** Does a hurt circle of `hurtRadiusM` at local (x, y) overlap a circle of `radiusM` around the origin? */
export function signatureCircleContains(radiusM: number, x: number, y: number, hurtRadiusM = 0): boolean {
  return circleVsCircle(0, 0, radiusM, x, y, hurtRadiusM);
}

/** Does a hurt circle at local (x, y) overlap a lane `lengthM` long and `widthM` wide (half each side) along `facingDeg`? */
export function signatureLaneContains(
  facingDeg: number, lengthM: number, widthM: number, x: number, y: number, hurtRadiusM = 0
): boolean {
  return circleVsRect(facingDeg, lengthM, widthM, x, y, hurtRadiusM);
}

/** Facings of the three volley lines: left, centre (on the target), right, `angleDeg` across. */
export function volleyFacings(centerDeg: number, angleDeg: number): [number, number, number] {
  const half = angleDeg / 2;
  return [centerDeg - half, centerDeg, centerDeg + half];
}

/**
 * Pack flank lunge rear-arc rule (spec 4.3): the lunge starts only from 100 degrees or more off
 * the player's heading (behind or beside). An unknown heading (standing still) allows any side.
 */
export const PACK_LUNGE_REAR_ARC_DEG = 100;
export function inLungeRearArc(headingDeg: number | null, bearingFromPlayerDeg: number): boolean {
  if (headingDeg === null) return true;
  return Math.abs(angleDiff(headingDeg, bearingFromPlayerDeg)) >= PACK_LUNGE_REAR_ARC_DEG;
}

/**
 * A circle centred on the mob (the slam) must hold a target standing still, so it starts this far inside its
 * radius: the table's 130 m trigger against a 110 m radius would otherwise whiff on anyone at 111 to 130 m.
 */
export const SLAM_INSIDE_MARGIN_M = 15;

/** Trigger maximum the engine uses (the table's, tightened for the slam). */
export function signatureTriggerMaxM(signature: MobSignatureParams): number {
  return signature.kind === "slam" ? Math.min(signature.triggerMaxM, signature.radiusM - SLAM_INSIDE_MARGIN_M) : signature.triggerMaxM;
}

/** Signatures whose mob steps in closer than its ring first (the owl's swoop, the slam). */
export function signatureDropsIn(kind: MobSignatureKind): boolean {
  return kind === "swoop" || kind === "slam";
}

/** Signatures that need a clear lane to the target (spec 4.3, owner decision 6). */
export function signatureNeedsClearLane(kind: MobSignatureKind): boolean {
  return kind === "charge" || kind === "ground_blast" || kind === "volley" || kind === "tongue";
}
