import {
  MELEE_ATTACK_RANGE_M,
  RANGED_ATTACK_RANGE_M,
  dungeonLocalDistanceToCombatMeters,
  mobBehaviorArchetype,
  mobSpawnGroup,
  type MobArchetypeKey,
  type MobBuffKind
} from "@ash-atlas/shared";

/**
 * Small readable gimmicks for the everyday mobs. The engine owns all world mutation; this module
 * only holds tuning and pure decision helpers so each gimmick is unit-testable. Distances are
 * combat meters (melee 100, ranged 300). Attack cadence is never touched (uniform basic attack interval): every
 * lever here is a per-hit proc, a telegraphed one-off strike, a status, or positioning.
 */

/** Open-ended buffs report this far-off deadline so clients show the name without a countdown. */
export const OPEN_ENDED_BUFF_MS = 10 * 60_000;

export const SEWER_RAT_SQUEAK = Object.freeze({
  archetypes: Object.freeze(["sewer_rat", "sick_sewer_rat"]) as readonly string[],
  radiusM: dungeonLocalDistanceToCombatMeters(1_400)
});

export const SICK_RAT_BURST = Object.freeze({
  radiusM: MELEE_ATTACK_RANGE_M,
  delayMs: 800,
  durationMs: 4_000,
  damageFactor: 0.4,
  techniqueId: "sick_rat_plague_burst"
});

export const CRAB_SHELL = Object.freeze({
  intervalMs: 11_000,
  durationMs: 2_500,
  triggerRangeM: MELEE_ATTACK_RANGE_M * 1.5,
  /** Incoming damage multiplier while the crab hunkers behind its shell. */
  incomingFactor: 0.35
});

export const WOLF_HOWL = Object.freeze({
  healthRatio: 0.6,
  durationMs: 6_000,
  radiusM: MELEE_ATTACK_RANGE_M * 8
});

export const GOBLIN_BOMB = Object.freeze({
  intervalMs: 10_000,
  delayMs: 1_000,
  radiusM: MELEE_ATTACK_RANGE_M * 0.9,
  triggerRangeM: MELEE_ATTACK_RANGE_M * 3,
  damageFactor: 1.2,
  knockbackM: MELEE_ATTACK_RANGE_M * 1.2,
  techniqueId: "goblin_bomb"
});

export const BANDIT_BACKSTAB = Object.freeze({
  intervalMs: 10_000,
  delayMs: 1_100,
  minRangeM: MELEE_ATTACK_RANGE_M * 1.3,
  maxRangeM: MELEE_ATTACK_RANGE_M * 5,
  behindM: MELEE_ATTACK_RANGE_M * 0.6,
  puffRadiusM: MELEE_ATTACK_RANGE_M * 0.5,
  /** The next hit after the blink lands this much harder, if it comes within readyMs. */
  damageFactor: 1.75,
  readyMs: 6_000
});

export const ORC_ENRAGE = Object.freeze({ healthRatio: 0.4 });

export const OGRE_SLAM = Object.freeze({
  intervalMs: 10_000,
  triggerRangeM: MELEE_ATTACK_RANGE_M * 1.3,
  delayMs: 1_800,
  radiusM: MELEE_ATTACK_RANGE_M * 1.1,
  damageFactor: 1.6,
  knockbackM: MELEE_ATTACK_RANGE_M * 1.5,
  techniqueId: "ogre_ground_slam"
});

export const BEAR_MAUL = Object.freeze({
  intervalMs: 9_000,
  triggerRangeM: MELEE_ATTACK_RANGE_M * 1.4,
  delayMs: 1_500,
  rangeM: MELEE_ATTACK_RANGE_M * 1.8,
  angleDegrees: 100,
  damageFactor: 1.8,
  knockbackM: MELEE_ATTACK_RANGE_M * 1.5,
  techniqueId: "bear_maul"
});

/**
 * Ordinary animals (mobSpawnGroup "animal") run milder versions of the shared gimmicks above;
 * fantasy and boss mobs keep the original numbers. Before -> after: hog charge 1.5 -> 1.25,
 * bear maul 1.8 -> 1.3, alligator death-roll bite 0.8 -> 0.4, wolf howl +35% -> +15%.
 */
export const ANIMAL_GIMMICKS = Object.freeze({
  hogChargeDamageFactor: 1.25,
  bearMaulDamageFactor: 1.3,
  deathRollBonusDamageFactor: 0.4,
  /** Howl damage multiplier cap for animal wolves (the shared war roar is 1.35). */
  howlDamageMultiplier: 1.15
});

export function isAnimalMob(archetype: string | null | undefined): boolean {
  return archetype != null && mobSpawnGroup(archetype) === "animal";
}

export function bearMaulDamageFactor(archetype: string | null): number {
  return isAnimalMob(archetype) ? ANIMAL_GIMMICKS.bearMaulDamageFactor : BEAR_MAUL.damageFactor;
}

export function deathRollBonusFactor(archetype: string | null): number {
  return isAnimalMob(archetype) ? ANIMAL_GIMMICKS.deathRollBonusDamageFactor : ALLIGATOR_DEATH_ROLL.bonusDamageFactor;
}

/** Roar/howl damage multiplier for a buffed mob; animal howlers are capped at +15%. */
export function roarDamageMultiplier(archetype: string | null, fullMultiplier: number): number {
  return roarBuffKind(archetype) === "howl" && isAnimalMob(archetype)
    ? Math.min(fullMultiplier, ANIMAL_GIMMICKS.howlDamageMultiplier)
    : fullMultiplier;
}

/** Archetypes that hunker behind a shell. The crab keeps CRAB_SHELL; others list their own numbers. */
export type ShellGuardProfile = Readonly<{ intervalMs: number; durationMs: number; incomingFactor: number }>;
export const SHELL_GUARD_ARCHETYPES: Readonly<Record<string, ShellGuardProfile>> = Object.freeze({
  coastal_crab: CRAB_SHELL,
  spur_thighed_tortoise: Object.freeze({ intervalMs: 12_000, durationMs: 2_000, incomingFactor: 0.5 }),
  armadillo: Object.freeze({ intervalMs: 12_000, durationMs: 2_000, incomingFactor: 0.5 })
});

/** The shell profile of a mob listed in SHELL_GUARD_ARCHETYPES, by its own key first and then its behaviour key. */
function shellGuardProfileOf(archetype: string | null): ShellGuardProfile | null {
  if (!archetype) return null;
  return SHELL_GUARD_ARCHETYPES[archetype] ?? SHELL_GUARD_ARCHETYPES[mobBehaviorArchetype(archetype)] ?? null;
}

export function hasShellGuard(archetype: string | null): boolean {
  return shellGuardProfileOf(archetype) !== null;
}

export function shellGuardFor(archetype: string | null): ShellGuardProfile {
  return shellGuardProfileOf(archetype) ?? CRAB_SHELL;
}

/** Melee hits on these reflect a little damage back to the attacker. */
export const QUILL_ARCHETYPES: readonly string[] = Object.freeze(["crested_porcupine"]);
export const QUILL_REFLECT = Object.freeze({
  damageFraction: 0.1,
  maxAttackerHealthFraction: 0.05,
  rangeM: MELEE_ATTACK_RANGE_M * 1.5,
  techniqueId: "porcupine_quills"
});

/** Reflected quill damage: 10% of the hit, at least 1, at most 5% of the attacker's max HP. */
export function quillDamage(damageDealt: number, attackerMaxHealth: number): number {
  const reflected = Math.max(1, Math.round(damageDealt * QUILL_REFLECT.damageFraction));
  return Math.max(1, Math.min(reflected, Math.floor(attackerMaxHealth * QUILL_REFLECT.maxAttackerHealthFraction)));
}

/** The first basic hit on a freshly engaged target lands harder, once per engagement. */
export const POUNCE_ARCHETYPES: readonly string[] = Object.freeze(["jaguar", "lioness", "sidewinder"]);
export const POUNCE = Object.freeze({ damageFactor: 1.4 });

export function pounceReady(archetype: string | null, pounceTargetId: string | null, targetId: string): boolean {
  return archetype !== null && POUNCE_ARCHETYPES.includes(archetype) && pounceTargetId !== targetId;
}

/** Telegraphed owl swoop: a forward cone strike. */
export const SWOOP_ARCHETYPES: readonly string[] = Object.freeze(["great_grey_owl", "golden_eagle"]);
export const SWOOP = Object.freeze({
  intervalMs: 10_000,
  delayMs: 1_300,
  rangeM: MELEE_ATTACK_RANGE_M * 1.3,
  angleDegrees: 90,
  damageFactor: 1.3,
  techniqueId: "owl_swoop"
});

export const SKELETON_REASSEMBLE = Object.freeze({ healthRatio: 0.35, durationMs: 2_500 });

export const FROG_TONGUE = Object.freeze({
  intervalMs: 8_000,
  delayMs: 900,
  minRangeM: MELEE_ATTACK_RANGE_M * 1.2,
  maxRangeM: MELEE_ATTACK_RANGE_M * 3.5,
  widthM: MELEE_ATTACK_RANGE_M * 0.6,
  overshootM: MELEE_ATTACK_RANGE_M * 0.3,
  damageFactor: 0.6,
  /** The pulled player lands this close to the frog. */
  stopDistanceM: MELEE_ATTACK_RANGE_M * 0.7,
  techniqueId: "frog_tongue"
});

export const ALLIGATOR_DEATH_ROLL = Object.freeze({
  /** Every Nth landed bite is a death roll: it roots the target and bites again. */
  everyNthBite: 3,
  rootMs: 1_500,
  bonusDamageFactor: 0.8,
  techniqueId: "alligator_death_roll"
});

export const SQUID_INK = Object.freeze({
  intervalMs: 11_000,
  delayMs: 800,
  durationMs: 4_000,
  radiusM: MELEE_ATTACK_RANGE_M * 1.2,
  maxRangeM: RANGED_ATTACK_RANGE_M,
  damageFactor: 0.25,
  slowAmount: 0.4,
  slowMs: 1_500,
  techniqueId: "squid_ink_cloud"
});

/** Shown by the client as "Slowed"; the engine keys the icon off this technique id. */
export const SLOW_STATUS_TECHNIQUE_ID = "elemental_ice_slow";

export const SAP_CRAWLER_STICK = Object.freeze({ chance: 0.6, durationMs: 3_000, amount: 0.4 });

export const BIRD_PROC = Object.freeze({
  fire: Object.freeze({ chance: 0.5 }),
  ice: Object.freeze({ chance: 0.5, durationMs: 4_000, amount: 0.35 }),
  lightning: Object.freeze({
    stormMs: 3_000,
    arcRadiusM: MELEE_ATTACK_RANGE_M * 3,
    arcMaxTargets: 2,
    arcDamageFactor: 0.5,
    techniqueId: "lightning_bird_arc"
  })
});

export const SLIME_SPLIT = Object.freeze({
  children: 2,
  healthFraction: 0.4,
  spreadM: MELEE_ATTACK_RANGE_M * 0.6,
  childName: "Slimelet"
});

/** Shellback: some direct hits glance off its shell and land at the Crab Shell's reduced damage. */
export const SHELLBACK_BLUNT = Object.freeze({ chance: 0.25 });

/** Darter: bursts on death, hurting everyone close (one short cloud, like the sick rat). */
export const DARTER_BURST = Object.freeze({
  radiusM: MELEE_ATTACK_RANGE_M * 1.2,
  delayMs: 600,
  durationMs: 2_000,
  damageFactor: 0.6,
  techniqueId: "darter_burst"
});

/** Ink Pool: once fighting, it drifts to a random nearby spot every few seconds. */
export const INK_POOL_DRIFT = Object.freeze({
  intervalMs: 3_500,
  minDistanceM: MELEE_ATTACK_RANGE_M * 0.4,
  maxDistanceM: MELEE_ATTACK_RANGE_M * 1.2
});

/**
 * Gate Warden: the first time it drops below half health it blinks away and leaves a rift that
 * calls Drowned Cultists. Once per life; the cultists fade when the rift closes.
 */
export const GATE_WARDEN_RIFT = Object.freeze({
  healthRatio: 0.5,
  /** Inside the Bandit template's 160 m leash, so the warden stays in the fight. */
  blinkDistanceM: MELEE_ATTACK_RANGE_M * 1.2,
  cultists: 2,
  spreadM: MELEE_ATTACK_RANGE_M * 0.6,
  cultistLifetimeMs: 60_000,
  riftRadiusM: MELEE_ATTACK_RANGE_M * 0.8,
  techniqueId: "gate_warden_rift"
});

/** Which cultist each warden's rift calls (a dungeon variant calls the matching variant). */
export const GATE_WARDEN_RIFT_CULTIST: Readonly<Record<string, MobArchetypeKey>> = Object.freeze({
  gate_warden: "drowned_cultist",
  gate_warden_dc: "drowned_cultist_dc"
});

/**
 * A mob in the pounce, quill, shell or swoop list has its own gimmick, so it does not also run its
 * template's strike (bear maul, frog tongue) or charge (hog charge).
 */
export function hasOwnGimmick(archetype: string | null): boolean {
  return archetype !== null && (
    POUNCE_ARCHETYPES.includes(archetype) || QUILL_ARCHETYPES.includes(archetype) ||
    SWOOP_ARCHETYPES.includes(archetype) || archetype in SHELL_GUARD_ARCHETYPES
  );
}

/** Telegraphed single strikes resolved by one shared engine path. */
export type GimmickStrikeKind = "slam" | "maul" | "bomb" | "pull" | "smoke" | "ink" | "swoop";

export type GimmickStrikeProfile = Readonly<{
  kind: GimmickStrikeKind;
  intervalMs: number;
  /** Strike windup; the telegraph is visible for exactly this long. */
  delayMs: number;
  minRangeM: number;
  maxRangeM: number;
}>;

/** Which archetypes use which strike; the engine reads the profile for cooldowns and range gates. */
export const GIMMICK_STRIKES: Readonly<Record<string, GimmickStrikeProfile>> = Object.freeze({
  ogre: { kind: "slam", intervalMs: OGRE_SLAM.intervalMs, delayMs: OGRE_SLAM.delayMs, minRangeM: 0, maxRangeM: OGRE_SLAM.triggerRangeM },
  bear: { kind: "maul", intervalMs: BEAR_MAUL.intervalMs, delayMs: BEAR_MAUL.delayMs, minRangeM: 0, maxRangeM: BEAR_MAUL.triggerRangeM },
  goblin: { kind: "bomb", intervalMs: GOBLIN_BOMB.intervalMs, delayMs: GOBLIN_BOMB.delayMs, minRangeM: 0, maxRangeM: GOBLIN_BOMB.triggerRangeM },
  frog: { kind: "pull", intervalMs: FROG_TONGUE.intervalMs, delayMs: FROG_TONGUE.delayMs, minRangeM: FROG_TONGUE.minRangeM, maxRangeM: FROG_TONGUE.maxRangeM },
  bandit: { kind: "smoke", intervalMs: BANDIT_BACKSTAB.intervalMs, delayMs: BANDIT_BACKSTAB.delayMs, minRangeM: BANDIT_BACKSTAB.minRangeM, maxRangeM: BANDIT_BACKSTAB.maxRangeM },
  squid: { kind: "ink", intervalMs: SQUID_INK.intervalMs, delayMs: SQUID_INK.delayMs, minRangeM: 0, maxRangeM: SQUID_INK.maxRangeM }
});

const SWOOP_STRIKE: GimmickStrikeProfile = Object.freeze({
  kind: "swoop", intervalMs: SWOOP.intervalMs, delayMs: SWOOP.delayMs, minRangeM: 0, maxRangeM: SWOOP.rangeM
});

/** Biome variants (Snow Bear, Poison Frog, ...) use their family base's strike. */
export function gimmickStrikeFor(archetype: string | null): GimmickStrikeProfile | null {
  if (archetype && SWOOP_ARCHETYPES.includes(archetype)) return SWOOP_STRIKE;
  if (hasOwnGimmick(archetype)) return null;
  return archetype ? GIMMICK_STRIKES[mobBehaviorArchetype(archetype)] ?? null : null;
}

export function strikeInRange(profile: GimmickStrikeProfile, distanceM: number): boolean {
  return distanceM >= profile.minRangeM && distanceM <= profile.maxRangeM;
}

/** Health-threshold one-shots (wolf howl, orc enrage, skeleton reassemble). */
export function belowHealthRatio(currentHealth: number, maxHealth: number, ratio: number): boolean {
  return currentHealth > 0 && currentHealth < maxHealth * ratio;
}

/** True when this landed bite is the alligator's death roll. */
export function isDeathRollBite(biteCount: number): boolean {
  return biteCount > 0 && biteCount % ALLIGATOR_DEATH_ROLL.everyNthBite === 0;
}

/** True while the next bite will be the death roll (the buff shows during the warning bite). */
export function deathRollPrimed(biteCount: number): boolean {
  return (biteCount + 1) % ALLIGATOR_DEATH_ROLL.everyNthBite === 0;
}

export function birdProcKind(archetype: string | null): "fire" | "ice" | "lightning" | null {
  return archetype === "fire_bird" ? "fire"
    : archetype === "ice_bird" ? "ice"
    : archetype === "lightning_bird" ? "lightning"
    : null;
}

/** Display kind of the shared roar-style damage buff, by who is carrying it. */
export function roarBuffKind(archetype: string | null): MobBuffKind {
  return archetype === "orc_brute" || archetype === "drake_broodguard"
    ? "enraged"
    : archetype !== null && mobBehaviorArchetype(archetype) === "wolf" ? "howl" : "war_roar";
}
