import { bearingDegrees, destinationPoint, dungeonLocalDistanceToCombatMeters, type LatLon } from "@ash-atlas/shared";
import type { BossController, BossControllerContext } from "./bossFramework.js";

export const ELDER_DRAGON_ABILITIES = Object.freeze({
  breath: "elder_dragon_fire_breath",
  buffet: "elder_dragon_wing_buffet",
  fireball: "elder_dragon_fireball"
});

export const ELDER_DRAGON = Object.freeze({
  /** Combat meters (melee range is 100). */
  breathRangeM: 450,
  breathAngleDegrees: 60,
  breathTelegraphMs: 1_600,
  breathIntervalMs: 9_000,
  firstBreathDelayMs: 4_000,
  breathDamage: 46,
  /** Below this health ratio the dragon is enraged: shorter breath telegraph, breath far more often. */
  enrageHealthRatio: 0.25,
  enragedBreathTelegraphMs: 1_000,
  enragedBreathIntervalMs: 5_000,
  buffetRadiusM: 180,
  buffetTelegraphMs: 1_200,
  buffetIntervalMs: 12_000,
  firstBuffetDelayMs: 8_000,
  buffetKnockbackM: 260,
  buffetDamage: 24,
  /** Takes off once at each of these health ratios. */
  flightHealthRatios: Object.freeze([0.7, 0.4]) as readonly number[],
  flightDurationMs: 15_000,
  fireballRadiusM: 110,
  fireballTelegraphMs: 1_600,
  fireballIntervalMs: 1_800,
  fireballDamage: 40,
  /** Four lava pools sit diagonally off the perch and widen through the fight (dungeon room units). */
  lavaPoolOffsetLocal: 560,
  lavaPoolStartRadiusLocal: 90,
  lavaPoolGrowthLocalPerPulse: 10,
  lavaPoolMaxRadiusLocal: 260,
  lavaPoolPulseMs: 4_000,
  /** Each pulse lingers a little past the next one so the pools never flicker off. */
  lavaPoolOverlapMs: 400,
  lavaPoolTickDamage: 16
});

export const ELDER_DRAGON_PHASES = Object.freeze({ normal: "normal", flight: "flight", enraged: "enraged" });

export type ElderDragonHooks = Readonly<{
  bossHealthRatio(bossEntityId: string): number;
  bossPosition(bossEntityId: string): LatLon | null;
  playerPosition(playerEntityId: string): LatLon | null;
  /** Airborne bosses cannot be targeted or reached; landing turns it back onto `retargetPlayerId`. */
  setAirborne(bossEntityId: string, airborne: boolean, retargetPlayerId: string | null): void;
  /** A burning room hazard (pool `index`) that lands at once and lingers for durationMs. */
  spawnLavaPool(bossEntityId: string, index: number, center: LatLon, radiusM: number, durationMs: number): void;
  /** True while at least one living player is in the boss room; the pools pause (and stop widening) otherwise. */
  roomOccupied(bossEntityId: string): boolean;
}>;

/** Lava pool centres: diagonally off the perch the boss started on. */
export function elderDragonLavaPoolCenters(perch: LatLon): LatLon[] {
  const distanceM = dungeonLocalDistanceToCombatMeters(ELDER_DRAGON.lavaPoolOffsetLocal * Math.SQRT2);
  return [45, 135, 225, 315].map((bearing) => destinationPoint(perch, distanceM, bearing));
}

/** Pool radius (combat meters) after `pulses` pulses. */
export function elderDragonLavaPoolRadiusM(pulses: number): number {
  const local = Math.min(
    ELDER_DRAGON.lavaPoolMaxRadiusLocal,
    ELDER_DRAGON.lavaPoolStartRadiusLocal + Math.max(0, pulses) * ELDER_DRAGON.lavaPoolGrowthLocalPerPulse
  );
  return dungeonLocalDistanceToCombatMeters(local);
}

/**
 * Elder Dragon: a telegraphed fire-breath cone and a wing buffet that shoves everyone near it away.
 * At 70% and 40% health it takes off for 15s (untargetable, no melee) while fireballs rain on
 * telegraphed circles; the Drakelings that spill in are the dungeon runtime's health-triggered summons
 * (see wyrm_hollow.md), so nothing spawns here. Four lava pools around the perch widen through the
 * fight. Below 25% it is enraged and breathes far more often.
 */
export function createElderDragonController(hooks: ElderDragonHooks): BossController {
  let nextBreathAt = 0;
  let nextBuffetAt = 0;
  let nextFireballAt = 0;
  let nextPoolAt = 0;
  let pools = 0;
  let flightsTaken = 0;
  let landsAt: number | null = null;
  let perch: LatLon | null = null;

  const groundPhase = (bossId: string): string =>
    hooks.bossHealthRatio(bossId) < ELDER_DRAGON.enrageHealthRatio ? ELDER_DRAGON_PHASES.enraged : ELDER_DRAGON_PHASES.normal;

  const land = (context: BossControllerContext, retarget: boolean): void => {
    const bossId = context.encounter.mobEntityId;
    landsAt = null;
    context.encounter.setPhaseDeadline(null);
    context.encounter.setMovementOverride(null);
    hooks.setAirborne(bossId, false, retarget ? context.selectTarget({ kind: "random" }) : null);
  };

  return {
    onActivate: (context) => {
      nextBreathAt = context.now + ELDER_DRAGON.firstBreathDelayMs;
      nextBuffetAt = context.now + ELDER_DRAGON.firstBuffetDelayMs;
      nextPoolAt = context.now;
      perch = perch ?? hooks.bossPosition(context.encounter.mobEntityId);
      if (context.encounter.phase === null) context.encounter.transitionPhase(ELDER_DRAGON_PHASES.normal);
    },
    update: (context) => {
      const bossId = context.encounter.mobEntityId;

      if (perch && context.now >= nextPoolAt && hooks.roomOccupied(bossId)) {
        const radiusM = elderDragonLavaPoolRadiusM(pools);
        elderDragonLavaPoolCenters(perch).forEach((center, index) => {
          hooks.spawnLavaPool(bossId, index, center, radiusM, ELDER_DRAGON.lavaPoolPulseMs + ELDER_DRAGON.lavaPoolOverlapMs);
        });
        pools += 1;
        nextPoolAt = context.now + ELDER_DRAGON.lavaPoolPulseMs;
      }

      if (landsAt !== null) {
        if (context.now >= landsAt) {
          land(context, true);
          context.encounter.transitionPhase(groundPhase(bossId));
          nextBreathAt = context.now + ELDER_DRAGON.firstBreathDelayMs;
          nextBuffetAt = context.now + ELDER_DRAGON.firstBuffetDelayMs;
          return;
        }
        if (context.now >= nextFireballAt) {
          const targetId = context.selectTarget({ kind: "random" });
          const center = targetId ? hooks.playerPosition(targetId) : null;
          if (center) {
            context.beginCast({
              abilityId: ELDER_DRAGON_ABILITIES.fireball,
              geometry: { kind: "circle", center, radiusM: ELDER_DRAGON.fireballRadiusM },
              castDurationMs: ELDER_DRAGON.fireballTelegraphMs
            });
          }
          nextFireballAt = context.now + ELDER_DRAGON.fireballIntervalMs;
        }
        return;
      }

      const health = hooks.bossHealthRatio(bossId);
      const nextFlightRatio = ELDER_DRAGON.flightHealthRatios[flightsTaken];
      if (nextFlightRatio !== undefined && health <= nextFlightRatio) {
        flightsTaken += 1;
        landsAt = context.now + ELDER_DRAGON.flightDurationMs;
        nextFireballAt = context.now + 1_000;
        context.encounter.transitionPhase(ELDER_DRAGON_PHASES.flight);
        context.encounter.setPhaseDeadline(landsAt);
        context.encounter.setMovementOverride({
          id: "elder-dragon-flight",
          generation: context.lifeGeneration,
          // No outgoing multiplier: melee is already impossible while airborne, and fireballs must still hurt.
          movementSpeedMultiplier: 0,
          incomingDamageMultiplier: 0
        });
        hooks.setAirborne(bossId, true, null);
        return;
      }

      const wanted = groundPhase(bossId);
      if (context.encounter.phase !== wanted) context.encounter.transitionPhase(wanted);
      const enraged = wanted === ELDER_DRAGON_PHASES.enraged;

      if (context.now >= nextBreathAt) {
        const origin = hooks.bossPosition(bossId);
        const targetId = context.selectTarget({ kind: "random" });
        const targetPosition = targetId ? hooks.playerPosition(targetId) : null;
        if (origin && targetPosition) {
          const cast = context.beginCast({
            abilityId: ELDER_DRAGON_ABILITIES.breath,
            geometry: {
              kind: "cone",
              origin,
              facingDegrees: bearingDegrees(origin, targetPosition),
              rangeM: ELDER_DRAGON.breathRangeM,
              angleDegrees: ELDER_DRAGON.breathAngleDegrees
            },
            castDurationMs: enraged ? ELDER_DRAGON.enragedBreathTelegraphMs : ELDER_DRAGON.breathTelegraphMs
          });
          if (cast) nextBreathAt = context.now + (enraged ? ELDER_DRAGON.enragedBreathIntervalMs : ELDER_DRAGON.breathIntervalMs);
        }
      }

      if (context.now >= nextBuffetAt) {
        const origin = hooks.bossPosition(bossId);
        if (origin) {
          const cast = context.beginCast({
            abilityId: ELDER_DRAGON_ABILITIES.buffet,
            geometry: { kind: "circle", center: origin, radiusM: ELDER_DRAGON.buffetRadiusM },
            castDurationMs: ELDER_DRAGON.buffetTelegraphMs
          });
          if (cast) nextBuffetAt = context.now + ELDER_DRAGON.buffetIntervalMs;
        }
      }
    },
    onReset: (context) => {
      if (landsAt !== null) land(context, false);
      context.encounter.setPhaseDeadline(null);
      context.encounter.setMovementOverride(null);
      nextBreathAt = 0;
      nextBuffetAt = 0;
      nextFireballAt = 0;
      nextPoolAt = 0;
      pools = 0;
      flightsTaken = 0;
      landsAt = null;
    },
    onDefeat: (context) => {
      if (landsAt !== null) land(context, false);
    },
    destroy: (context) => {
      if (landsAt !== null) land(context, false);
    }
  };
}
