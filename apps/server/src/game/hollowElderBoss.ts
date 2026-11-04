import { bearingDegrees, type LatLon } from "@ash-atlas/shared";
import type { BossController } from "./bossFramework.js";

export const HOLLOW_ELDER_ABILITIES = Object.freeze({
  rootSlam: "hollow_elder_root_slam",
  sporeCloud: "hollow_elder_spore_cloud"
});

export const HOLLOW_ELDER = Object.freeze({
  /** Combat meters (melee range is 100). */
  slamLines: 3,
  slamLineLengthM: 450,
  slamLineWidthM: 80,
  slamTelegraphMs: 1_600,
  slamIntervalMs: 10_000,
  firstSlamDelayMs: 5_000,
  slamDamage: 28,
  slamRootMs: 1_200,
  sporeRadiusM: 120,
  sporeTelegraphMs: 1_500,
  sporeDurationMs: 6_000,
  sporeIntervalMs: 14_000,
  firstSporeDelayMs: 9_000,
  sporeCastDamage: 10,
  /** Tick damage of the lingering cloud (poison is applied on top). */
  sporeTickDamage: 8,
  /** "Draws in the corruption" once health falls to this ratio. */
  drawInHealthRatio: 0.5,
  drawInStartDelayMs: 1_500,
  drawInWindowMs: 8_000,
  /** Fraction of max health healed if any sprite alive when the channel began is still alive at its end. */
  drawInHealFraction: 0.15
});

export const HOLLOW_ELDER_PHASES = Object.freeze({ normal: "normal", drawingIn: "drawing_corruption" });

export type HollowElderHooks = Readonly<{
  bossHealthRatio(bossEntityId: string): number;
  bossPosition(bossEntityId: string): LatLon | null;
  playerPosition(playerEntityId: string): LatLon | null;
  livingSprites(bossEntityId: string): readonly string[];
  healBoss(bossEntityId: string, fractionOfMax: number): void;
  spawnSporeCloud(bossEntityId: string, center: LatLon, radiusM: number, delayMs: number, durationMs: number): void;
}>;

/**
 * Hollow Elder: three telegraphed root-slam lanes radiating from the boss, lingering spore clouds that tick
 * poison, and, at 50% health, a "draw in the corruption" channel. When it starts, the Blight Sprites alive
 * are remembered; if any of them survives the 8s window the Elder heals. The sprite waves themselves are the
 * dungeon runtime's health-triggered summons (see blightwood_grove.md), so the controller spawns nothing.
 */
export function createHollowElderController(hooks: HollowElderHooks): BossController {
  let nextSlamAt = 0;
  let nextSporeAt = 0;
  let drawInStartAt: number | null = null;
  let drawInEndsAt: number | null = null;
  let drawInDone = false;
  let remembered: readonly string[] = [];

  return {
    onActivate: (context) => {
      nextSlamAt = context.now + HOLLOW_ELDER.firstSlamDelayMs;
      nextSporeAt = context.now + HOLLOW_ELDER.firstSporeDelayMs;
      if (context.encounter.phase === null) context.encounter.transitionPhase(HOLLOW_ELDER_PHASES.normal);
    },
    update: (context) => {
      const bossId = context.encounter.mobEntityId;

      if (drawInEndsAt !== null) {
        if (context.now >= drawInEndsAt) {
          const alive = new Set(hooks.livingSprites(bossId));
          if (remembered.some((id) => alive.has(id))) hooks.healBoss(bossId, HOLLOW_ELDER.drawInHealFraction);
          drawInEndsAt = null;
          context.encounter.setPhaseDeadline(null);
          context.encounter.transitionPhase(HOLLOW_ELDER_PHASES.normal);
        }
      } else if (!drawInDone) {
        if (drawInStartAt === null && hooks.bossHealthRatio(bossId) <= HOLLOW_ELDER.drawInHealthRatio) {
          drawInStartAt = context.now + HOLLOW_ELDER.drawInStartDelayMs;
        }
        if (drawInStartAt !== null && context.now >= drawInStartAt) {
          drawInDone = true;
          remembered = hooks.livingSprites(bossId);
          if (remembered.length > 0) {
            drawInEndsAt = context.now + HOLLOW_ELDER.drawInWindowMs;
            context.encounter.setPhaseDeadline(drawInEndsAt);
            context.encounter.transitionPhase(HOLLOW_ELDER_PHASES.drawingIn);
          }
        }
      }

      if (context.now >= nextSlamAt) {
        const origin = hooks.bossPosition(bossId);
        const targetId = context.selectTarget({ kind: "random" });
        const targetPosition = targetId ? hooks.playerPosition(targetId) : null;
        if (origin && targetPosition) {
          const base = bearingDegrees(origin, targetPosition);
          for (let lane = 0; lane < HOLLOW_ELDER.slamLines; lane += 1) {
            context.beginCast({
              abilityId: HOLLOW_ELDER_ABILITIES.rootSlam,
              geometry: {
                kind: "line",
                origin,
                facingDegrees: (base + (360 / HOLLOW_ELDER.slamLines) * lane) % 360,
                lengthM: HOLLOW_ELDER.slamLineLengthM,
                widthM: HOLLOW_ELDER.slamLineWidthM
              },
              castDurationMs: HOLLOW_ELDER.slamTelegraphMs
            });
          }
          nextSlamAt = context.now + HOLLOW_ELDER.slamIntervalMs;
        }
      }

      if (context.now >= nextSporeAt) {
        const targetId = context.selectTarget({ kind: "random" });
        const center = targetId ? hooks.playerPosition(targetId) : null;
        if (center) {
          const cast = context.beginCast({
            abilityId: HOLLOW_ELDER_ABILITIES.sporeCloud,
            geometry: { kind: "circle", center, radiusM: HOLLOW_ELDER.sporeRadiusM },
            castDurationMs: HOLLOW_ELDER.sporeTelegraphMs
          });
          if (cast) {
            // The cloud lands as the telegraph resolves and then lingers.
            hooks.spawnSporeCloud(bossId, center, HOLLOW_ELDER.sporeRadiusM, HOLLOW_ELDER.sporeTelegraphMs, HOLLOW_ELDER.sporeDurationMs);
            nextSporeAt = context.now + HOLLOW_ELDER.sporeIntervalMs;
          }
        }
      }
    },
    onReset: (context) => {
      nextSlamAt = 0;
      nextSporeAt = 0;
      drawInStartAt = null;
      drawInEndsAt = null;
      drawInDone = false;
      remembered = [];
      context.encounter.setPhaseDeadline(null);
    },
    onDefeat: (context) => { drawInEndsAt = null; context.encounter.setPhaseDeadline(null); },
    destroy: (context) => { drawInEndsAt = null; context.encounter.setPhaseDeadline(null); }
  };
}
