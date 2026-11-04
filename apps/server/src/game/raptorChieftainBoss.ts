import type { LatLon } from "@ash-atlas/shared";
import type { BossController } from "./bossFramework.js";

export const RAPTOR_CHIEFTAIN_ABILITIES = Object.freeze({ leapSlam: "raptor_leap_slam" });

export const RAPTOR_CHIEFTAIN = Object.freeze({
  /** Combat meters (melee range is 100). */
  slamRadiusM: 140,
  slamTelegraphMs: 1_500,
  slamIntervalMs: 8_000,
  firstSlamDelayMs: 3_000,
  slamDamage: 30,
  /** Below this health ratio the chieftain is enraged: shorter telegraph, faster leaps. */
  enrageHealthRatio: 0.25,
  enragedSlamTelegraphMs: 900,
  enragedSlamIntervalMs: 4_500,
  enragedMovementMultiplier: 1.25,
  firstRoarDelayMs: 9_000,
  roarIntervalMs: 18_000,
  roarDurationMs: 6_000
});

export const RAPTOR_CHIEFTAIN_PHASES = Object.freeze({ normal: "normal", enraged: "enraged" });

export type RaptorChieftainHooks = Readonly<{
  bossHealthRatio(bossEntityId: string): number;
  playerPosition(playerEntityId: string): LatLon | null;
  /** Moves the boss to the slam point as the telegraph lands. */
  leapBossTo(bossEntityId: string, position: LatLon): void;
  /** Buffs every raptor-family mob in the boss's room. */
  warRoar(bossEntityId: string, durationMs: number): void;
}>;

/**
 * Raptor Chieftain: a telegraphed leap slam on a random player (a circle cast; the boss jumps onto it
 * as it lands), a periodic war roar that buffs the room's raptors, and an enrage below 25% health.
 * The Raptor Runt calls at 66% and 33% health are the dungeon runtime's health-triggered summons
 * (see docs/design/dungeon-layouts/fangrock_cavern.md), so the controller does not spawn anything.
 */
export function createRaptorChieftainController(hooks: RaptorChieftainHooks): BossController {
  let nextSlamAt = 0;
  let nextRoarAt = 0;
  let pendingLeap: { center: LatLon; at: number } | null = null;

  const applyPhase = (
    context: Parameters<NonNullable<BossController["onPhaseTransition"]>>[0]
  ): void => {
    context.encounter.setMovementOverride(
      context.encounter.phase === RAPTOR_CHIEFTAIN_PHASES.enraged
        ? {
            id: "raptor-enrage",
            generation: context.lifeGeneration,
            movementSpeedMultiplier: RAPTOR_CHIEFTAIN.enragedMovementMultiplier
          }
        : null
    );
  };

  return {
    onActivate: (context) => {
      nextSlamAt = context.now + RAPTOR_CHIEFTAIN.firstSlamDelayMs;
      nextRoarAt = context.now + RAPTOR_CHIEFTAIN.firstRoarDelayMs;
      if (context.encounter.phase === null) context.encounter.transitionPhase(RAPTOR_CHIEFTAIN_PHASES.normal);
      else applyPhase(context);
    },
    onPhaseTransition: applyPhase,
    update: (context) => {
      const bossId = context.encounter.mobEntityId;
      const enraged = hooks.bossHealthRatio(bossId) < RAPTOR_CHIEFTAIN.enrageHealthRatio;
      const wanted = enraged ? RAPTOR_CHIEFTAIN_PHASES.enraged : RAPTOR_CHIEFTAIN_PHASES.normal;
      if (context.encounter.phase !== wanted) context.encounter.transitionPhase(wanted);

      if (pendingLeap && context.now >= pendingLeap.at) {
        hooks.leapBossTo(bossId, pendingLeap.center);
        pendingLeap = null;
      }
      if (context.now >= nextRoarAt) {
        hooks.warRoar(bossId, RAPTOR_CHIEFTAIN.roarDurationMs);
        nextRoarAt = context.now + RAPTOR_CHIEFTAIN.roarIntervalMs;
      }
      if (context.now < nextSlamAt || pendingLeap) return;
      const targetId = context.selectTarget({ kind: "random" });
      const center = targetId ? hooks.playerPosition(targetId) : null;
      if (!center) return;
      const telegraphMs = enraged ? RAPTOR_CHIEFTAIN.enragedSlamTelegraphMs : RAPTOR_CHIEFTAIN.slamTelegraphMs;
      const cast = context.beginCast({
        abilityId: RAPTOR_CHIEFTAIN_ABILITIES.leapSlam,
        geometry: { kind: "circle", center, radiusM: RAPTOR_CHIEFTAIN.slamRadiusM },
        castDurationMs: telegraphMs
      });
      if (!cast) return;
      pendingLeap = { center, at: cast.resolveTime };
      nextSlamAt = context.now + (enraged ? RAPTOR_CHIEFTAIN.enragedSlamIntervalMs : RAPTOR_CHIEFTAIN.slamIntervalMs);
    },
    onReset: (context) => {
      nextSlamAt = 0;
      nextRoarAt = 0;
      pendingLeap = null;
      context.encounter.setMovementOverride(null);
    },
    onDefeat: (context) => { pendingLeap = null; context.encounter.setMovementOverride(null); },
    destroy: (context) => { pendingLeap = null; context.encounter.setMovementOverride(null); }
  };
}
