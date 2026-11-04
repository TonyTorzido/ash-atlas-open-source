import { MELEE_ATTACK_RANGE_M, dungeonLocalDistanceToCombatMeters } from "@ash-atlas/shared";

/**
 * Tuning for the Wyrm Hollow mobs and room hazards. The engine owns all world mutation; this module
 * only holds numbers and pure helpers. Distances are combat meters (melee 100, ranged 300). Attack
 * cadence stays uniform: every lever is a telegraphed strike, a status, a zone or positioning.
 */

/** Pack mob: a short fire spit in a small telegraphed cone every few seconds; it sets targets burning. */
export const DRAKELING_SPIT = Object.freeze({
  intervalMs: 6_000,
  firstDelayMs: 2_500,
  telegraphMs: 800,
  triggerRangeM: MELEE_ATTACK_RANGE_M * 1.4,
  rangeM: MELEE_ATTACK_RANGE_M * 1.6,
  angleDegrees: 60,
  damageFactor: 1.1,
  techniqueId: "drakeling_fire_spit"
});

/** Submerges into the lava (untargetable), then surfaces beside its target with a burning bite. */
export const MAGMA_SALAMANDER = Object.freeze({
  submergeIntervalMs: 11_000,
  firstSubmergeDelayMs: 5_000,
  submergedMs: 2_500,
  surfaceDistanceM: MELEE_ATTACK_RANGE_M * 0.5,
  surfaceBiteDamageFactor: 1.4,
  /** Chance an ordinary bite also sets the target burning. */
  biteBurnChance: 0.35,
  techniqueId: "magma_salamander_surface_bite"
});

/** Drips a short-lived burning puddle behind it while it fights. */
export const LAVA_SLIME_TRAIL = Object.freeze({
  intervalMs: 1_600,
  durationMs: 3_000,
  radiusM: MELEE_ATTACK_RANGE_M * 0.55,
  damageFactor: 0.35,
  techniqueId: "lava_slime_trail"
});

/** Flies like a cliff hawk (telegraphed dive, then climbs out of reach) and the dive knocks players back. */
export const ASH_WYVERN = Object.freeze({ knockbackM: MELEE_ATTACK_RANGE_M * 1.6 });

/** Guards the Hatchery eggs: enraged (harder hits) while a player stands at the eggs near its post. */
export const DRAKE_BROODGUARD = Object.freeze({
  /** Around the broodguard's spawn point (its clutch), about the painted nest's size. */
  clutchRadiusM: dungeonLocalDistanceToCombatMeters(220),
  enrageMs: 6_000
});

/** Timed room hazards (`damage` zones, e.g. the Ember Tunnels lava vents). */
export const LAVA_VENT = Object.freeze({
  cycleMs: 7_000,
  /** Each vent in a room starts this much later than the previous one. */
  staggerMs: 1_400,
  telegraphMs: 1_500,
  eruptionMs: 2_500,
  tickDamage: 18,
  techniqueId: "lava_vent_eruption"
});

/** True when it is time for vent `index` of a room to erupt (cycle timing is per room, from when it woke). */
export function lavaVentDue(now: number, wokeAt: number, index: number, lastEruptionAt: number | undefined): boolean {
  const start = wokeAt + index * LAVA_VENT.staggerMs;
  if (now < start) return false;
  const cycleStart = start + Math.floor((now - start) / LAVA_VENT.cycleMs) * LAVA_VENT.cycleMs;
  return lastEruptionAt === undefined || lastEruptionAt < cycleStart;
}
