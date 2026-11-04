import { bearingDegrees, type LatLon } from "@ash-atlas/shared";
import type { BossController, BossControllerContext } from "./bossFramework.js";

export const GRANDMASTER_ABILITIES = Object.freeze({
  tigerPalm: "grandmaster_tiger_palm",
  mantisStrike: "grandmaster_mantis_strike"
});

export const GRANDMASTER = Object.freeze({
  /** He changes stance this often. */
  stanceMs: 12_000,
  firstStrikeDelayMs: 2_500,
  /** Tiger: heavy telegraphed palm strikes (cone toward a random player). */
  tigerIntervalMs: 3_500,
  tigerTelegraphMs: 1_400,
  tigerRangeM: 220,
  tigerAngleDegrees: 70,
  tigerDamage: 42,
  tigerKnockbackM: 150,
  /**
   * Crane: a glowing counter stance. While he glows, damage dealt to him is reflected to the attacker.
   * He glows twice per stance, with a breather between glows.
   */
  craneGlowMs: 4_000,
  craneRestMs: 2_000,
  craneReflectFraction: 1,
  /** Mantis (below 50% health): quick small strikes on players; the two shadow clones come from the room data. */
  mantisHealthRatio: 0.5,
  mantisIntervalMs: 2_000,
  mantisTelegraphMs: 900,
  mantisRadiusM: 90,
  mantisDamage: 24
});

export const GRANDMASTER_STANCES = Object.freeze({
  tiger: "tiger_stance",
  crane: "crane_stance",
  craneGlow: "crane_stance_glowing",
  mantis: "mantis_stance"
});

type Stance = "tiger" | "crane" | "mantis";

export type GrandmasterHooks = Readonly<{
  bossHealthRatio(bossEntityId: string): number;
  bossPosition(bossEntityId: string): LatLon | null;
  playerPosition(playerEntityId: string): LatLon | null;
  /** Turns damage reflection on or off for the boss (the Crane glow). */
  setReflect(bossEntityId: string, fraction: number | null): void;
}>;

/** Stance order: Tiger and Crane alternate; once below 50% health Mantis joins the rotation. */
export function nextGrandmasterStance(current: Stance, mantisUnlocked: boolean): Stance {
  if (current === "tiger") return "crane";
  if (current === "crane") return mantisUnlocked ? "mantis" : "tiger";
  return "tiger";
}

/**
 * The Grandmaster: a stance fight that rotates every 12s. Tiger throws heavy telegraphed palm strikes;
 * Crane stands still and glows, reflecting damage back at anyone who keeps attacking (the lesson: stop and
 * wait); Mantis, unlocked below 50% health, rains quick strikes while the two shadow clones (summoned by the
 * room data at 50%) join the fight.
 */
export function createGrandmasterController(hooks: GrandmasterHooks): BossController {
  let stance: Stance = "tiger";
  let stanceEndsAt = 0;
  let nextStrikeAt = 0;
  let glowing = false;
  let glowToggleAt = 0;
  let glowsLeft = 0;

  const setGlow = (context: BossControllerContext, on: boolean): void => {
    glowing = on;
    const bossId = context.encounter.mobEntityId;
    hooks.setReflect(bossId, on ? GRANDMASTER.craneReflectFraction : null);
    context.encounter.setMovementOverride(on
      ? { id: "grandmaster_crane_glow", generation: context.lifeGeneration, movementSpeedMultiplier: 0 }
      : null);
    context.encounter.transitionPhase(on ? GRANDMASTER_STANCES.craneGlow : GRANDMASTER_STANCES.crane);
  };

  const enterStance = (context: BossControllerContext, next: Stance): void => {
    if (glowing) setGlow(context, false);
    stance = next;
    stanceEndsAt = context.now + GRANDMASTER.stanceMs;
    context.encounter.setPhaseDeadline(stanceEndsAt);
    if (next === "crane") {
      glowsLeft = 2;
      glowToggleAt = context.now;
      context.encounter.transitionPhase(GRANDMASTER_STANCES.crane);
    } else {
      nextStrikeAt = context.now + (next === "tiger" ? GRANDMASTER.tigerTelegraphMs : GRANDMASTER.mantisIntervalMs) / 2;
      context.encounter.transitionPhase(GRANDMASTER_STANCES[next]);
    }
  };

  const stopAll = (context: BossControllerContext): void => {
    if (glowing) {
      glowing = false;
      hooks.setReflect(context.encounter.mobEntityId, null);
      context.encounter.setMovementOverride(null);
    }
    context.encounter.setPhaseDeadline(null);
  };

  return {
    onActivate: (context) => {
      stance = "tiger";
      stanceEndsAt = context.now + GRANDMASTER.stanceMs;
      nextStrikeAt = context.now + GRANDMASTER.firstStrikeDelayMs;
      context.encounter.setPhaseDeadline(stanceEndsAt);
      context.encounter.transitionPhase(GRANDMASTER_STANCES.tiger);
    },
    update: (context) => {
      const bossId = context.encounter.mobEntityId;
      if (context.now >= stanceEndsAt) {
        enterStance(context, nextGrandmasterStance(stance, hooks.bossHealthRatio(bossId) <= GRANDMASTER.mantisHealthRatio));
        return;
      }
      if (stance === "crane") {
        if (context.now < glowToggleAt) return;
        if (glowing) {
          setGlow(context, false);
          glowToggleAt = context.now + GRANDMASTER.craneRestMs;
        } else if (glowsLeft > 0) {
          glowsLeft -= 1;
          setGlow(context, true);
          glowToggleAt = context.now + GRANDMASTER.craneGlowMs;
        }
        return;
      }
      if (context.now < nextStrikeAt) return;
      const targetId = context.selectTarget({ kind: "random" });
      const targetPosition = targetId ? hooks.playerPosition(targetId) : null;
      const origin = hooks.bossPosition(bossId);
      if (!targetId || !targetPosition || !origin) return;
      if (stance === "tiger") {
        context.beginCast({
          abilityId: GRANDMASTER_ABILITIES.tigerPalm,
          geometry: {
            kind: "cone", origin, facingDegrees: bearingDegrees(origin, targetPosition),
            rangeM: GRANDMASTER.tigerRangeM, angleDegrees: GRANDMASTER.tigerAngleDegrees
          },
          castDurationMs: GRANDMASTER.tigerTelegraphMs,
          targetEntityId: targetId
        });
        nextStrikeAt = context.now + GRANDMASTER.tigerIntervalMs;
      } else {
        context.beginCast({
          abilityId: GRANDMASTER_ABILITIES.mantisStrike,
          geometry: { kind: "circle", center: targetPosition, radiusM: GRANDMASTER.mantisRadiusM },
          castDurationMs: GRANDMASTER.mantisTelegraphMs
        });
        nextStrikeAt = context.now + GRANDMASTER.mantisIntervalMs;
      }
    },
    onReset: (context) => {
      stopAll(context);
      stance = "tiger";
      stanceEndsAt = 0;
      nextStrikeAt = 0;
      glowsLeft = 0;
    },
    onDefeat: (context) => { stopAll(context); },
    destroy: (context) => { stopAll(context); }
  };
}
