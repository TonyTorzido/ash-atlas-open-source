import { bearingDegrees, type LatLon } from "@ash-atlas/shared";
import type { BossController } from "./bossFramework.js";

export const THUNDERWING_ABILITIES = Object.freeze({
  windGust: "thunderwing_wind_gust",
  dive: "thunderwing_dive",
  lightning: "thunderwing_static_lightning"
});

export const THUNDERWING = Object.freeze({
  /** Combat meters (melee range is 100). */
  gustRangeM: 450,
  gustAngleDegrees: 70,
  gustTelegraphMs: 1_500,
  gustIntervalMs: 9_000,
  firstGustDelayMs: 4_000,
  gustKnockbackM: 250,
  gustDamage: 14,
  /** Every Nth gust also marks a player for a lightning strike. */
  staticMarkEveryGusts: 3,
  lightningRadiusM: 100,
  lightningDelayMs: 2_000,
  lightningDamage: 42,
  diveRadiusM: 110,
  diveTelegraphMs: 1_400,
  diveIntervalMs: 12_000,
  firstDiveDelayMs: 8_000,
  diveDamage: 36
});

export type ThunderwingHooks = Readonly<{
  bossPosition(bossEntityId: string): LatLon | null;
  playerPosition(playerEntityId: string): LatLon | null;
  /** Moves the boss onto the dive point as the telegraph lands. */
  leapBossTo(bossEntityId: string, position: LatLon): void;
}>;

/**
 * Thunderwing: a wind-gust cone that shoves players back (every third gust also marks a player for a
 * delayed lightning strike) and a telegraphed dive on a random player. The 50% Carrion Chick and Cliff
 * Hawk call is the dungeon runtime's health-triggered summon (see the_eyrie.md), so nothing spawns here.
 */
export function createThunderwingController(hooks: ThunderwingHooks): BossController {
  let nextGustAt = 0;
  let nextDiveAt = 0;
  let gusts = 0;
  let pendingLeap: { center: LatLon; at: number } | null = null;

  return {
    onActivate: (context) => {
      nextGustAt = context.now + THUNDERWING.firstGustDelayMs;
      nextDiveAt = context.now + THUNDERWING.firstDiveDelayMs;
    },
    update: (context) => {
      const bossId = context.encounter.mobEntityId;
      if (pendingLeap && context.now >= pendingLeap.at) {
        hooks.leapBossTo(bossId, pendingLeap.center);
        pendingLeap = null;
      }
      if (context.now >= nextGustAt) {
        const origin = hooks.bossPosition(bossId);
        const targetId = context.selectTarget({ kind: "random" });
        const targetPosition = targetId ? hooks.playerPosition(targetId) : null;
        if (origin && targetPosition) {
          const cast = context.beginCast({
            abilityId: THUNDERWING_ABILITIES.windGust,
            geometry: {
              kind: "cone",
              origin,
              facingDegrees: bearingDegrees(origin, targetPosition),
              rangeM: THUNDERWING.gustRangeM,
              angleDegrees: THUNDERWING.gustAngleDegrees
            },
            castDurationMs: THUNDERWING.gustTelegraphMs
          });
          if (cast) {
            gusts += 1;
            nextGustAt = context.now + THUNDERWING.gustIntervalMs;
            if (gusts % THUNDERWING.staticMarkEveryGusts === 0) {
              const markedId = context.selectTarget({ kind: "random" });
              const marked = markedId ? hooks.playerPosition(markedId) : null;
              if (marked) {
                context.beginCast({
                  abilityId: THUNDERWING_ABILITIES.lightning,
                  geometry: { kind: "circle", center: marked, radiusM: THUNDERWING.lightningRadiusM },
                  castDurationMs: THUNDERWING.lightningDelayMs
                });
              }
            }
          }
        }
      }
      if (context.now >= nextDiveAt && !pendingLeap) {
        const targetId = context.selectTarget({ kind: "random" });
        const center = targetId ? hooks.playerPosition(targetId) : null;
        if (center) {
          const cast = context.beginCast({
            abilityId: THUNDERWING_ABILITIES.dive,
            geometry: { kind: "circle", center, radiusM: THUNDERWING.diveRadiusM },
            castDurationMs: THUNDERWING.diveTelegraphMs
          });
          if (cast) {
            pendingLeap = { center, at: cast.resolveTime };
            nextDiveAt = context.now + THUNDERWING.diveIntervalMs;
          }
        }
      }
    },
    onReset: () => {
      nextGustAt = 0;
      nextDiveAt = 0;
      gusts = 0;
      pendingLeap = null;
    },
    onDefeat: () => { pendingLeap = null; },
    destroy: () => { pendingLeap = null; }
  };
}
