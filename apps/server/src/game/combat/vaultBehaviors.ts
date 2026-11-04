import { MELEE_ATTACK_RANGE_M, MOB_RING_TELEGRAPH_ABILITY_IDS, type LatLon } from "@ash-atlas/shared";

/**
 * The Tilted Vault mob signatures (Ember Shade, Ashbound Revenant, Vault Warden). The engine owns all world
 * mutation; this module holds tuning, the per-mob state and pure decision helpers so each move is unit-testable.
 * Distances are combat meters (melee range is 100). Every move is a telegraphed one-off strike on the shared
 * mob telegraph system: geometry is locked at telegraph start, so stepping sideways dodges, and dash i-frames
 * at the resolve tick count as a dodge. Basic attacks pause while a move winds up.
 */

const R = MELEE_ATTACK_RANGE_M;

/** Ember Shade: a short clawing cone. */
export const EMBER_SHADE_GRASP = Object.freeze({
  intervalMs: 6_000,
  firstDelayMs: 1_500,
  triggerRangeM: R * 1.3,
  telegraphMs: 1_000,
  rangeM: R * 1.4,
  angleDegrees: 80,
  damageFactor: 1.3,
  techniqueId: "ember_shade_grasp"
});

/** Ember Shade: a wail around itself; after it resolves the Shade takes no damage for a moment. */
export const EMBER_SHADE_WAIL = Object.freeze({
  intervalMs: 12_000,
  firstDelayMs: 4_500,
  triggerRangeM: R * 1.5,
  telegraphMs: 1_200,
  radiusM: R * 1.6,
  damageFactor: 1.2,
  wardMs: 1_000,
  techniqueId: "ember_shade_wail"
});

/** Ashbound Revenant: two cones, the second re-aimed at the target right after the first lands. */
export const REVENANT_DOUBLE_STRIKE = Object.freeze({
  intervalMs: 7_000,
  firstDelayMs: 2_000,
  triggerRangeM: R * 1.3,
  telegraphMs: [1_000, 600] as const,
  rangeM: R * 1.3,
  angleDegrees: 90,
  damageFactor: 0.75,
  techniqueIds: ["ashbound_revenant_double_a", "ashbound_revenant_double_b"] as const
});

/**
 * Ashbound Revenant: a lunge down a lane locked at telegraph start. Only one Revenant per target lunges at a
 * time, and never the Revenant standing nearest the target (it keeps pressure with its double strike).
 */
export const REVENANT_FLANK_LUNGE = Object.freeze({
  intervalMs: 9_000,
  firstDelayMs: 3_000,
  minRangeM: R * 1.2,
  maxRangeM: R * 3.2,
  telegraphMs: 1_000,
  widthM: 50,
  /** Lane runs this far past the target's locked position. */
  overshootM: 60,
  minLengthM: R * 1.6,
  maxLengthM: R * 3.6,
  damageFactor: 1.4,
  techniqueId: "ashbound_revenant_lunge"
});

/** Vault Warden: slam around itself, alternating with the charge. */
export const WARDEN_SLAM = Object.freeze({
  triggerRangeM: R * 1.5,
  telegraphMs: 1_200,
  radiusM: R * 1.6,
  damageFactor: 1.6,
  knockbackM: 60,
  techniqueId: "vault_warden_slam"
});

/** Vault Warden: a charge down a lane locked at telegraph start; the Warden ends at the lane end. */
export const WARDEN_CHARGE = Object.freeze({
  telegraphMs: 1_100,
  widthM: 120,
  overshootM: 80,
  minLengthM: R * 2.5,
  maxLengthM: R * 5,
  damageFactor: 1.5,
  knockbackM: 60,
  techniqueId: "vault_warden_charge"
});

/** Quiet time after any vault move resolves before the next may start. */
export const VAULT_MOVE_GAP_MS = 1_500;

/** Shared cadence of the Warden's slam / charge alternation. */
export const WARDEN_STRIKES = Object.freeze({ intervalMs: 6_000, firstDelayMs: 2_000 });

/**
 * Vault Warden heartbeat: a short charge-up, then an ember ring expands from where the Warden stood, much faster
 * than walking, out past the room walls. A player is hit when the ring front passes over their hurt circle,
 * unless they are invulnerable (dash i-frames) the whole time the front touches them.
 */
export const WARDEN_HEARTBEAT = Object.freeze({
  intervalMs: 8_000,
  firstDelayMs: 4_000,
  windupMs: 900,
  windupRadiusM: R * 0.7,
  speedMps: 500,
  maxRadiusM: 2_400,
  damageFactor: 1.1,
  windupId: "vault_warden_heartbeat_charge",
  techniqueId: "vault_warden_heartbeat"
});

/** The client draws the heartbeat as a thin expanding band (shared MOB_RING_TELEGRAPH_ABILITY_IDS). */
export const WARDEN_HEARTBEAT_DRAWN_AS_RING = MOB_RING_TELEGRAPH_ABILITY_IDS.has(WARDEN_HEARTBEAT.techniqueId);

export const VAULT_MOB_ARCHETYPES: ReadonlySet<string> = new Set(["ember_shade", "ashbound_revenant", "vault_warden"]);

export type VaultStrikeKind = "grasp" | "wail" | "double_a" | "double_b" | "lunge" | "slam" | "charge";

export type VaultHeartbeatPulse = {
  center: LatLon;
  startTick: number;
  /** Front radius at the previous beat, so a player already behind the front is never hit late. */
  prevFrontM: number;
  /** Players the ring front has finished with (hit or dodged). */
  resolved: Set<string>;
};

export type VaultMobState = {
  strikeKind: VaultStrikeKind | null;
  strikeTick: number;
  strikeCenter: LatLon | null;
  strikeBearing: number;
  strikeLengthM: number;
  strikeTargetId: string | null;
  /** Earliest tick any new move may start (keeps moves apart). */
  nextStrikeTick: number;
  /** Per-move ready ticks; 0 = not yet seeded with the first delay. */
  nextPrimaryTick: number;
  nextSecondaryTick: number;
  /** Ember Wail: the Shade takes no damage until this tick. */
  wardUntilTick: number;
  wardenNext: "slam" | "charge";
  heartbeatWindupTick: number;
  heartbeatCenter: LatLon | null;
  pulse: VaultHeartbeatPulse | null;
  lastImmuneFeedbackMs: number;
};

export function newVaultMobState(): VaultMobState {
  return {
    strikeKind: null, strikeTick: 0, strikeCenter: null, strikeBearing: 0, strikeLengthM: 0, strikeTargetId: null,
    nextStrikeTick: 0, nextPrimaryTick: 0, nextSecondaryTick: 0, wardUntilTick: 0, wardenNext: "slam",
    heartbeatWindupTick: 0, heartbeatCenter: null, pulse: null, lastImmuneFeedbackMs: Number.NEGATIVE_INFINITY
  };
}

/** True while a vault mob winds up a move (its basic attacks pause). The heartbeat ring in flight does not count. */
export function isVaultWindingUp(state: VaultMobState | undefined): boolean {
  return state !== undefined && (state.strikeKind !== null || state.heartbeatWindupTick > 0);
}

/** True while the Ember Wail ward holds. */
export function isVaultWarded(state: VaultMobState | undefined, currentTick: number): boolean {
  return state !== undefined && state.wardUntilTick > currentTick;
}

export type RevenantPosition = Readonly<{ entityId: string; distanceToTargetM: number; lungeTargetId: string | null }>;

/**
 * The single-lunger rule: `selfId` may lunge at `targetId` only when no other Revenant is already lunging at that
 * target and `selfId` is not the Revenant nearest the target. `revenants` lists every living Revenant in the room
 * (including self).
 */
export function mayFlankLunge(selfId: string, targetId: string, revenants: readonly RevenantPosition[]): boolean {
  let nearest: RevenantPosition | null = null;
  for (const revenant of revenants) {
    if (revenant.entityId !== selfId && revenant.lungeTargetId === targetId) return false;
    if (nearest === null || revenant.distanceToTargetM < nearest.distanceToTargetM) nearest = revenant;
  }
  return nearest !== null && nearest.entityId !== selfId;
}

/** Lane length of a lunge or charge: past the target by the overshoot, clamped to the move's limits. */
export function vaultLaneLengthM(distanceM: number, move: { overshootM: number; minLengthM: number; maxLengthM: number }): number {
  return Math.min(move.maxLengthM, Math.max(move.minLengthM, distanceM + move.overshootM));
}

/** Radius of the heartbeat ring front `elapsedMs` after it launched. */
export function heartbeatFrontM(elapsedMs: number): number {
  return Math.min(WARDEN_HEARTBEAT.maxRadiusM, Math.max(0, elapsedMs) * WARDEN_HEARTBEAT.speedMps / 1_000);
}

/** Total time the heartbeat ring takes to reach its full radius. */
export const WARDEN_HEARTBEAT_TRAVEL_MS = WARDEN_HEARTBEAT.maxRadiusM / WARDEN_HEARTBEAT.speedMps * 1_000;

/**
 * Where the ring front stands relative to a hurt circle `distanceM` from its centre: "ahead" (not reached yet),
 * "touching" (the front overlaps the hurt circle) or "passed".
 */
export function heartbeatContact(frontM: number, distanceM: number, hurtRadiusM: number): "ahead" | "touching" | "passed" {
  if (frontM < distanceM - hurtRadiusM) return "ahead";
  if (frontM <= distanceM + hurtRadiusM) return "touching";
  return "passed";
}

/** The Warden's next strike: alternate slam and charge, but charge when the slam is due and the target is out of reach. */
export function chooseWardenStrike(state: VaultMobState, distanceM: number): "slam" | "charge" {
  if (state.wardenNext === "slam" && distanceM > WARDEN_SLAM.triggerRangeM) return "charge";
  return state.wardenNext;
}
