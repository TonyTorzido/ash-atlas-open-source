import type { LatLon } from "@ash-atlas/shared";
import type { BossController } from "./bossFramework.js";

export const BROOD_MATRIARCH_ABILITIES = Object.freeze({ webSnare: "brood_web_snare" });

export const BROOD_MATRIARCH = Object.freeze({
  /** Combat meters (melee range is 100). */
  snareRadiusM: 130,
  snareTelegraphMs: 1_800,
  snareIntervalMs: 9_000,
  firstSnareDelayMs: 4_000,
  snareRootMs: 2_000,
  /** Damage multiplier while any of her spiderlings live (60% reduction). */
  shieldIncomingMultiplier: 0.4
});

export const BROOD_MATRIARCH_PHASES = Object.freeze({ normal: "normal", shielded: "brood_shield" });

export type BroodMatriarchHooks = Readonly<{
  /** Living spiderlings in the boss's room. */
  livingBroodCount(bossEntityId: string): number;
  playerPosition(playerEntityId: string): LatLon | null;
}>;

/**
 * Brood Matriarch: a telegraphed web snare on a random player (the cast resolver roots anyone caught),
 * and a brood shield that cuts incoming damage while her spiderlings live. The poison bite lives in
 * the combat engine's basic-hit hook, and the 50%/25% egg-sac waves are the dungeon runtime's
 * health-triggered summons, so the controller only owns the snare and the shield.
 */
export function createBroodMatriarchController(hooks: BroodMatriarchHooks): BossController {
  let nextSnareAt = 0;

  const applyPhase = (
    context: Parameters<NonNullable<BossController["onPhaseTransition"]>>[0]
  ): void => {
    context.encounter.setMovementOverride(
      context.encounter.phase === BROOD_MATRIARCH_PHASES.shielded
        ? {
            id: "brood-shield",
            generation: context.lifeGeneration,
            incomingDamageMultiplier: BROOD_MATRIARCH.shieldIncomingMultiplier
          }
        : null
    );
  };

  return {
    onActivate: (context) => {
      nextSnareAt = context.now + BROOD_MATRIARCH.firstSnareDelayMs;
      if (context.encounter.phase === null) context.encounter.transitionPhase(BROOD_MATRIARCH_PHASES.normal);
      else applyPhase(context);
    },
    onPhaseTransition: applyPhase,
    update: (context) => {
      const shielded = hooks.livingBroodCount(context.encounter.mobEntityId) > 0;
      const wanted = shielded ? BROOD_MATRIARCH_PHASES.shielded : BROOD_MATRIARCH_PHASES.normal;
      if (context.encounter.phase !== wanted) context.encounter.transitionPhase(wanted);
      if (context.now < nextSnareAt) return;
      const targetId = context.selectTarget({ kind: "random" });
      const center = targetId ? hooks.playerPosition(targetId) : null;
      if (!targetId || !center) return;
      context.beginCast({
        abilityId: BROOD_MATRIARCH_ABILITIES.webSnare,
        geometry: { kind: "circle", center, radiusM: BROOD_MATRIARCH.snareRadiusM },
        // No targetEntityId: the cast roots every participant standing in the circle when it lands.
        castDurationMs: BROOD_MATRIARCH.snareTelegraphMs
      });
      nextSnareAt = context.now + BROOD_MATRIARCH.snareIntervalMs;
    },
    onReset: (context) => {
      nextSnareAt = 0;
      context.encounter.setMovementOverride(null);
    },
    onDefeat: (context) => { context.encounter.setMovementOverride(null); },
    destroy: (context) => { context.encounter.setMovementOverride(null); }
  };
}
