import {
  MELEE_ATTACK_RANGE_M,
  RANGED_ATTACK_RANGE_M,
  parseEquipmentEnhancement
} from "@ash-atlas/shared";

/**
 * Golem Forge mob behaviours (docs/design/GOLEM_FORGE_PLAN.md section 5). One tunable block: the engine owns
 * every world mutation and this module only holds numbers and pure decisions so each behaviour is
 * unit-testable. Distances are combat meters (melee 100, ranged 300); damage factors multiply the
 * mob's attack damage. Slam, knockback and the line charge are the Ogre and Hog template gimmicks
 * (mobGimmicks.ts, mobSpecialBehaviors.ts); the numbers here only cover what those do not.
 */

/** Pace and reach where the Ogre / Bandit templates do not fit (read by mobDefinitions.ts). */
export const GOLEM_FORGE_MOB_PACE = Object.freeze({
  /** The Iron Golem is the slow heavy of the roster (the Ogre template walks at 0.9). */
  ironGolem: 0.6,
  /** The Spark Wisp keeps up with a running player (the Bandit template walks at 0.5). */
  sparkWisp: 1.0,
  /** The Golem Smith throws its hammer from range. */
  smithThrowRangeM: RANGED_ATTACK_RANGE_M * 0.7
});

/** Slag Crawler: short-lived burning puddles dropped behind it while it moves in a fight. */
export const SLAG_TRAIL = Object.freeze({
  /** A puddle is dropped after this much movement and at most this often. */
  spacingM: MELEE_ATTACK_RANGE_M * 0.4,
  intervalMs: 600,
  radiusM: MELEE_ATTACK_RANGE_M * 0.5,
  /** Lands almost at once: the crawler has already moved on. */
  delayMs: 200,
  durationMs: 3_000,
  /** Damage per design second (the zone's one-second beat) as a factor of the crawler's attack. */
  damageFactor: 0.35,
  techniqueId: "slag_crawler_trail"
});

/** Spark Wisp: a small burst where it pops. */
export const SPARK_WISP_BURST = Object.freeze({
  radiusM: MELEE_ATTACK_RANGE_M * 0.9,
  delayMs: 400,
  durationMs: 1_500,
  damageFactor: 0.5,
  techniqueId: "spark_wisp_burst"
});

/** Archetypes that leave a burst or trail; the engine asks, this module answers. */
export const GOLEM_FORGE_ARCHETYPES = Object.freeze({
  slagCrawler: "slag_crawler_gf",
  sparkWisp: "spark_wisp_gf"
});

/** True when this puddle is due: far enough from the last one and past the interval. */
export function slagTrailDue(
  lastDropTick: number,
  currentTick: number,
  intervalTicks: number,
  movedM: number
): boolean {
  return currentTick - lastDropTick >= intervalTicks && movedM >= SLAG_TRAIL.spacingM;
}

/** Per-mob runtime kept by the engine (dropped when the mob leaves the world). */
export type GolemForgeMobState = {
  lastTrailTick: number;
  lastTrailPosition: { lat: number; lon: number } | null;
  lastImmuneFeedbackMs: number;
  /** Sentinel Statue: true once a player has woken it. */
  awake: boolean;
  /** Mender Golem: next heal pulse. */
  nextHealTick: number;
  /** Golem Smith: channel end (0 = not channelling), the rubble it is rebuilding, and its next channel. */
  channelEndTick: number;
  channelRubble: GolemRubble | null;
  nextChannelTick: number;
};

/** A golem that just died, kept briefly so a Golem Smith can rebuild it. */
export type GolemRubble = {
  archetype: string;
  position: { lat: number; lon: number };
  zoneId: string;
  regionCode: string;
  atTick: number;
};

export function newGolemForgeMobState(): GolemForgeMobState {
  return { lastTrailTick: -1_000_000, lastTrailPosition: null, lastImmuneFeedbackMs: -1_000_000, awake: false,
    nextHealTick: 0, channelEndTick: 0, channelRubble: null, nextChannelTick: 0 };
}

/** Sentinel Statue: dormant, untargetable and not aggressive until a player comes this close, then it fights on. */
/** A Sentinel Statue this close to its post counts as home. */
export const SENTINEL_HOME_RADIUS_M = 4;

export const SENTINEL_STATUE = Object.freeze({
  archetype: "sentinel_statue_gf",
  /** Wider than ranged weapons reach, so nobody can shoot it while it sleeps. */
  wakeRadiusM: MELEE_ATTACK_RANGE_M * 4
});

/** Archetypes the Mender heals (the roster's golems and statues, not the wisp, crawler or Smith). */
export const GOLEM_ARCHETYPES: readonly string[] = Object.freeze([
  "iron_golem_gf", "stone_golem_gf", "geode_golem_gf", "mender_golem_gf", "sentinel_statue_gf"
]);

/** Mender Golem: heals nearby golems every pulse; stays a low-priority, killable support. */
export const MENDER_HEAL = Object.freeze({
  intervalMs: 5_000,
  radiusM: MELEE_ATTACK_RANGE_M * 6,
  /** Fraction of the healed golem's maximum health. */
  healFraction: 0.1
});

/** Spark Wisp: each basic hit also zaps up to two other players close to the one it hit. */
export const SPARK_CHAIN = Object.freeze({
  radiusM: MELEE_ATTACK_RANGE_M * 6,
  maxTargets: 2,
  damageFactor: 0.4,
  techniqueId: "spark_wisp_chain"
});

/** Golem Smith: channels to rebuild a golem that died moments ago unless it is hit first. */
export const SMITH_REVIVE = Object.freeze({
  channelMs: 4_000,
  /** A golem can be rebuilt only if it died this recently. */
  recentDeathMs: 20_000,
  radiusM: MELEE_ATTACK_RANGE_M * 6,
  cooldownMs: 10_000,
  techniqueId: "golem_smith_revive",
  /** Rebuilt: the roster golems, not statues. */
  archetypes: Object.freeze(["iron_golem_gf", "stone_golem_gf", "geode_golem_gf", "mender_golem_gf"]) as readonly string[]
});

/** The Mender and the Smith have no template strike (the Ogre slam, the Bandit blink): they support and throw. */
export function golemForgeSuppressesStrike(archetype: string | null): boolean {
  return archetype === "mender_golem_gf" || archetype === "golem_smith_gf";
}

/** Geode Golem and Gem Husk: no damage unless the attacker's weapon carries a gem enhancement. */
export const GEM_IMMUNE_ARCHETYPES: readonly string[] = Object.freeze(["geode_golem_gf", "gem_husk_gf"]);
/** The "Immune" floating text shows at most this often per mob (damage over time would spam it). */
export const IMMUNE_FEEDBACK_INTERVAL_MS = 1_000;

export function isGemImmuneArchetype(archetype: string | null): boolean {
  return archetype !== null && GEM_IMMUNE_ARCHETYPES.includes(archetype);
}

/** A weapon enhancement identity (`enh:v1:<gem>:<stage>`) counts only with a gemstone; gem-less metal infusions do not. */
export function weaponCarriesGem(enchantmentIdentity: string | null): boolean {
  return parseEquipmentEnhancement(enchantmentIdentity)?.gemstone != null;
}
