import { BASIC_ATTACK_INTERVAL_MS, MELEE_ATTACK_RANGE_M } from "./combatConstants.js";
import { mobBehaviorArchetype, mobTemplateOf } from "./mobContracts.js";
import {
  MOB_RANGED_AIM_MS,
  MOB_TACTICS_MELEE_TOKENS,
  MOB_TACTICS_RECOVER_MS,
  MOB_TACTICS_RANGED_RECOVER_MS,
  MOB_TACTICS_LANDING_MIN_GAP_MS,
  MOB_TACTICS_MELEE_REACH_M,
  MOB_TELEGRAPH_REACTION_MS,
  scaleTelegraphMs,
  type MobRhythm
} from "./mobTactics.js";
import { DASH_COOLDOWN_MS } from "./dash.js";
import { MOB_MELEE_WINDUP_MS } from "./actionCombat.js";

/**
 * Mob archetypes (Phase 2 of mob AI; action combat + mob tactics only): movement style, rhythm and one signature
 * move per archetype. The one place every constant lives, like mobTactics.ts. Spec: docs/plans/mob-ai-phase2.md.
 * Nothing here touches the engine; MOB_ARCHETYPES_ENABLED off changes nothing.
 *
 * Distances are metres, times are milliseconds. Numbers marked "existing" are copies of the gimmick values in
 * apps/server/src/game/combat/mobGimmicks.ts (kept there for the flag-off path); a server test keeps them equal.
 */

export const MOB_ARCHETYPE_IDS = ["brute", "pack", "skirmisher", "caster", "swarmer"] as const;
export type MobArchetypeId = (typeof MOB_ARCHETYPE_IDS)[number];

export const MOB_SIGNATURE_KINDS = [
  "charge", "maul", "slam", "lunge", "double_strike", "smoke_step", "swoop",
  "ground_blast", "volley", "tongue", "pile_on_wave", "none"
] as const;
export type MobSignatureKind = (typeof MOB_SIGNATURE_KINDS)[number];

/** Signature kinds each archetype may use. */
export const MOB_ARCHETYPE_SIGNATURES: Readonly<Record<MobArchetypeId, readonly MobSignatureKind[]>> = {
  brute: ["charge", "maul", "slam", "none"],
  pack: ["lunge"],
  skirmisher: ["double_strike", "smoke_step", "swoop"],
  caster: ["ground_blast", "volley", "tongue"],
  swarmer: ["pile_on_wave"]
};

// ---- Readability and guardrail constants (spec sections 5 and 8) ----

/** At most one signature telegraph is live per target player. */
export const MOB_ARCH_MAX_LIVE_SIGNATURES = 1;
/**
 * Signature landings on one player are at least this far apart (at or above the dash cooldown, now 3000 ms, so a
 * player who dashed one signature has the dash back for the next). Chunk H tuning:
 * 3000 ms (spec 1600). At 1600 ms a dense pack lands a signature every 1.6 s and the 500 ms windows either side
 * leave too little room for basics, so pressure fell to about half of Phase 1.
 */
export const MOB_ARCH_SIGNATURE_MIN_SPACING_MS = Math.max(3_000, DASH_COOLDOWN_MS);
/** No basic landing within this long of a signature landing, either side. */
export const MOB_ARCH_SIGNATURE_LANDING_GAP_MS = 500;
/** Basic-to-basic landing gap is still the Phase 1 value. */
export const MOB_ARCH_BASIC_LANDING_GAP_MS = MOB_TACTICS_LANDING_MIN_GAP_MS;
/**
 * Signature telegraph is never shorter than this, and at least this much longer than the time to walk out of it.
 * Telegraph time (docs/plans/telegraph-time.md): 1000 ms floor (was 450) and the 400 ms reaction (was 250).
 */
export const MOB_ARCH_SIGNATURE_MIN_TELEGRAPH_MS = 1_000;
export const MOB_ARCH_SIGNATURE_REACTION_SLACK_MS = MOB_TELEGRAPH_REACTION_MS;
/** Archetype movement never exceeds this share of the player's speed (signature dashes excepted). */
export const MOB_ARCH_MAX_SPEED_SHARE = 0.95;
/** Knockback from a managed signature is capped here (owner decision 3); the miss stagger reward stays. */
export const MOB_ARCH_KNOCKBACK_CAP_M = 60;
/** Incoming-damage governor: landed hit-equivalents per player over this window may not exceed the budget. */
export const MOB_ARCH_GOVERNOR_WINDOW_MS = 2_000;
/** Phase 1 hit-equivalent (HE): one common melee hit at damage factor 1. Guardrail multipliers over Phase 1. */
export const MOB_ARCH_BASIC_CEILING_MULTIPLIER = 1.1;
export const MOB_ARCH_SIGNATURE_CEILING_MULTIPLIER = 1.25;
/**
 * Design rule: the mixed-pack ceiling is what the governor
 * enforces, and the governor caps landed damage at 1.25x the Phase 1 token ceiling (2 points over a 750 ms hold),
 * about 6.67 HE per 2 s. It defers basic and signature starts alike while archetypes are on.
 */
/**
 * Token hold the pressure ceilings are anchored to: the Phase 1 hold as tuned (450 ms windup + 300 ms recover). The
 * combat-feel walkable windups (MOB_TACTICS_MELEE_WINDUP_MS) hold tokens longer, which only lowers what packs can
 * land; keeping it here keeps the governor and ceilings where the Phase 1 / Phase 2 tuning put them.
 */
export const MOB_ARCH_PHASE1_REFERENCE_HOLD_MS = MOB_MELEE_WINDUP_MS + 300;
export const MOB_ARCH_GOVERNOR_BUDGET_HE = (MOB_ARCH_GOVERNOR_WINDOW_MS / 1_000) * MOB_ARCH_SIGNATURE_CEILING_MULTIPLIER *
  (MOB_TACTICS_MELEE_TOKENS / (MOB_ARCH_PHASE1_REFERENCE_HOLD_MS / 1_000));
/** Ranged token points per player while archetypes are on (design rule: casters get 2; Phase 1 keeps 1). */
export const MOB_ARCH_CASTER_RANGED_TOKENS = 2;
/** Signature token cost may be re-set to the Phase 1 tier cost when that is higher (epic, legendary). */
export const MOB_ARCH_SWARM_TOKEN_COST = 0.5;
/** Lone-mob damage rate is rhythm-neutral: damage factor = cycle / this (Swarmer excepted). */
export const MOB_ARCH_REFERENCE_CYCLE_MS = BASIC_ATTACK_INTERVAL_MS;
/** Swarm waves hold at most this many members, all landing on one tick. */
export const MOB_ARCH_WAVE_MAX_MEMBERS = 4;

// ---- Per-archetype parameters (spec 4.1 and 4.2) ----

export type MobArchetypePreferredDistance =
  | Readonly<{ kind: "engage_ring" }>
  | Readonly<{ kind: "wait_band"; radiusM: number }>
  | Readonly<{ kind: "engage_then_retreat"; retreatToM: number }>
  | Readonly<{ kind: "outer_ring"; minM: number; maxM: number }>;

export type MobArchetypeParams = Readonly<{
  windupMs: number;
  recoverMs: number;
  cooldownMs: number;
  /** Basic hit damage factor (1.0 = one Phase 1 hit). */
  basicDamageFactor: number;
  /** Share of the mob's own speed while approaching and repositioning. */
  speedFactor: number;
  /** Speed share for retreat bursts (clamped by MOB_ARCH_MAX_SPEED_SHARE). */
  burstSpeedFactor: number;
  preferred: MobArchetypePreferredDistance;
  /** Wait-ring strafe as a share of speed; 0 = none. */
  strafeShare: number;
  /** All mobs of one pack circle the same way (Pack only). */
  sharedOrbit: boolean;
  basicTokenCost: number;
  signatureTokenCost: number;
  /** Back-off distance during recover. */
  backoffM: number;
  arrivalGraceMs: number;
  starvationMs: number;
  /** Basic strike reach (m, attacker centre to target edge); melee archetypes use the player's swing reach. */
  basicReachM: number;
  /** Casters hold ground below this speed share of the player (turrets). */
  kiteMinSpeedShare: number;
}>;

/**
 * Telegraph time (docs/plans/telegraph-time.md): melee basics wind up 1100 ms (was 750), the swarm wave 1000 ms (was
 * 700, recover 200 -> 250), the caster aim MOB_RANGED_AIM_MS (900, was 450). Cooldowns are unchanged, so every cycle
 * grows by the windup increase and lone-mob damage drops 13-24 % (Phase 3 retunes damage).
 */
export const MOB_ARCHETYPE_PARAMS: Readonly<Record<MobArchetypeId, MobArchetypeParams>> = {
  brute: {
    windupMs: 1_100, recoverMs: 350, cooldownMs: 1_200, basicDamageFactor: 1.5, speedFactor: 0.85, burstSpeedFactor: 0.85,
    preferred: { kind: "engage_ring" }, strafeShare: 0, sharedOrbit: false,
    basicTokenCost: 1, signatureTokenCost: 1, backoffM: 0, arrivalGraceMs: 400, starvationMs: 4_000, basicReachM: MOB_TACTICS_MELEE_REACH_M,
    kiteMinSpeedShare: 0
  },
  pack: {
    windupMs: 1_100, recoverMs: 250, cooldownMs: 400, basicDamageFactor: 1, speedFactor: 1.15, burstSpeedFactor: 1.15,
    preferred: { kind: "wait_band", radiusM: 180 }, strafeShare: 0.55, sharedOrbit: true,
    basicTokenCost: 1, signatureTokenCost: 1, backoffM: 20, arrivalGraceMs: 400, starvationMs: 4_000, basicReachM: MOB_TACTICS_MELEE_REACH_M,
    kiteMinSpeedShare: 0
  },
  skirmisher: {
    windupMs: 1_100, recoverMs: 400, cooldownMs: 700, basicDamageFactor: 1.3, speedFactor: 1, burstSpeedFactor: 1.2,
    preferred: { kind: "engage_then_retreat", retreatToM: 160 }, strafeShare: 0.2, sharedOrbit: false,
    basicTokenCost: 1, signatureTokenCost: 1, backoffM: 50, arrivalGraceMs: 400, starvationMs: 4_000, basicReachM: MOB_TACTICS_MELEE_REACH_M,
    kiteMinSpeedShare: 0
  },
  caster: {
    windupMs: MOB_RANGED_AIM_MS, recoverMs: MOB_TACTICS_RANGED_RECOVER_MS, cooldownMs: 600, basicDamageFactor: 1.1,
    speedFactor: 1, burstSpeedFactor: 1.1,
    preferred: { kind: "outer_ring", minM: 200, maxM: 260 }, strafeShare: 0, sharedOrbit: false,
    basicTokenCost: 1, signatureTokenCost: 1, backoffM: 0, arrivalGraceMs: 400, starvationMs: 4_000, basicReachM: 260,
    kiteMinSpeedShare: 0.4
  },
  swarmer: {
    windupMs: 1_000, recoverMs: 250, cooldownMs: 250, basicDamageFactor: 0.8, speedFactor: 1.1, burstSpeedFactor: 1.1,
    preferred: { kind: "wait_band", radiusM: 130 }, strafeShare: 0.4, sharedOrbit: false,
    basicTokenCost: MOB_ARCH_SWARM_TOKEN_COST, signatureTokenCost: MOB_ARCH_SWARM_TOKEN_COST, backoffM: 0,
    arrivalGraceMs: 0, starvationMs: 2_000, basicReachM: MOB_TACTICS_MELEE_REACH_M, kiteMinSpeedShare: 0
  }
};

/**
 * Chunk H tuning: a wait-band archetype ready to strike (cooldown over) waits this close instead of on its band, so
 * a token holder's walk-in is short; it fades back out to the band during its cooldown.
 */
export const MOB_ARCH_READY_BAND_M: Readonly<Partial<Record<MobArchetypeId, number>>> = { pack: 125 };

/** Retreat and reaction rules (spec 4.2). Zero or absent = the rule does not apply. */
export const MOB_ARCHETYPE_RETREAT = {
  pack: { hurtHpShare: 0.35, retreatMs: 2_500, cooldownMs: 8_000, maxRetreatingPerPlayer: 1, band: 2 },
  skirmisher: { hopDistanceM: 90, hopMs: 150, hopCooldownMs: 4_000 },
  caster: { kiteTriggerM: 150, kiteTargetM: 200 }
} as const;

/** Casters whose Phase 1 reach is melee get this reach, only while the flag is on (owner decision 2). */
export const MOB_ARCH_CASTER_REACH_OVERRIDE_M = 260;
export const MOB_ARCH_CASTER_REACH_OVERRIDE_KEYS: readonly string[] = Object.freeze([
  "hedge_witch", "rime_witch", "gnoll_bonebow", "frogfolk_blowgunner"
]);

export function mobArchetypeCycleMs(archetype: MobArchetypeId): number {
  const p = MOB_ARCHETYPE_PARAMS[archetype];
  return p.windupMs + p.recoverMs + p.cooldownMs;
}

/** The archetype's rhythm in the Phase 1 shape, for MOB_RHYTHM_OVERRIDES / deriveMobRhythm. */
export function mobArchetypeRhythm(archetype: MobArchetypeId): MobRhythm {
  const p = MOB_ARCHETYPE_PARAMS[archetype];
  return { windupMs: p.windupMs, recoverMs: p.recoverMs, cooldownMs: p.cooldownMs, backoffM: p.backoffM };
}

/** Speed in m/s the archetype moves at: own speed x factor, never above MOB_ARCH_MAX_SPEED_SHARE of the player's. */
export function mobArchetypeSpeedMps(
  baseSpeedMps: number,
  archetype: MobArchetypeId,
  playerSpeedMps: number,
  burst = false
): number {
  const p = MOB_ARCHETYPE_PARAMS[archetype];
  const factor = burst ? p.burstSpeedFactor : p.speedFactor;
  return Math.max(0, Math.min(baseSpeedMps * factor, playerSpeedMps * MOB_ARCH_MAX_SPEED_SHARE));
}

// ---- Signature moves (spec 4.3 and 4.4) ----

export type MobSignatureShape = "line" | "cone" | "circle" | "fan" | "cone_pair" | "wave";

export type MobSignatureParams = Readonly<{
  kind: Exclude<MobSignatureKind, "none">;
  archetype: MobArchetypeId;
  shape: MobSignatureShape;
  /** Telegraph length(s). Double-strike lists both cones. */
  telegraphMs: readonly number[];
  /** Fantasy / default damage factor and the milder animal factor (same when equal). */
  damageFactor: number;
  damageFactorAnimal: number;
  /** Per-mob cooldown from landing; 0 = none (every cycle). */
  cooldownMs: number;
  /** Distance window (m) from the mob to the player in which it may start. */
  triggerMinM: number;
  triggerMaxM: number;
  /** Lane or cone or circle size. widthM is the telegraph width of a lane; radiusM a circle; rangeM a cone or lane length. */
  widthM: number;
  radiusM: number;
  rangeM: number;
  angleDeg: number;
  /** Miss and hit aftermath (spec 4.4). */
  missStaggerMs: number;
  hitRecoveryMs: number;
  /** Telegraph ability id(s); multi-part moves list one per part. */
  abilityIds: readonly string[];
  /** True when the numbers are a copy of the existing gimmick. */
  existing: boolean;
}>;

const R = MELEE_ATTACK_RANGE_M;

/**
 * Telegraph time (docs/plans/telegraph-time.md): every part is walk-out + 400 ms reaction or more, 1.2-1.6 s by size
 * (the second double-strike cone 1.0 s: it follows straight on, the player is already moving). Managed only; the
 * legacy gimmicks keep their own timings.
 */
export const MOB_SIGNATURES: Readonly<Record<Exclude<MobSignatureKind, "none">, MobSignatureParams>> = {
  charge: {
    kind: "charge", archetype: "brute", shape: "line", telegraphMs: [1_300], damageFactor: 1.5, damageFactorAnimal: 1.25,
    cooldownMs: 7_000, triggerMinM: R * 1.8, triggerMaxM: R * 5, widthM: R * 1.2, radiusM: 0, rangeM: R * 5, angleDeg: 0,
    missStaggerMs: 5_000, hitRecoveryMs: 600, abilityIds: ["brute_charge"], existing: true
  },
  maul: {
    kind: "maul", archetype: "brute", shape: "cone", telegraphMs: [1_400], damageFactor: 2.6, damageFactorAnimal: 2.6,
    cooldownMs: 7_000, triggerMinM: 0, triggerMaxM: R * 1.4, widthM: 0, radiusM: 0, rangeM: R * 1.8, angleDeg: 100,
    missStaggerMs: 5_000, hitRecoveryMs: 600, abilityIds: ["brute_maul"], existing: false
  },
  slam: {
    kind: "slam", archetype: "brute", shape: "circle", telegraphMs: [1_600], damageFactor: 1.6, damageFactorAnimal: 1.6,
    cooldownMs: 8_000, triggerMinM: 0, triggerMaxM: R * 1.3, widthM: 0, radiusM: R * 1.1, rangeM: 0, angleDeg: 0,
    missStaggerMs: 5_000, hitRecoveryMs: 600, abilityIds: ["brute_slam"], existing: true
  },
  lunge: {
    kind: "lunge", archetype: "pack", shape: "line", telegraphMs: [1_200], damageFactor: 1.2, damageFactorAnimal: 1.2,
    cooldownMs: 6_000, triggerMinM: 120, triggerMaxM: 240, widthM: 50, radiusM: 0, rangeM: 160, angleDeg: 0,
    missStaggerMs: 1_500, hitRecoveryMs: 400, abilityIds: ["pack_lunge"], existing: false
  },
  double_strike: {
    kind: "double_strike", archetype: "skirmisher", shape: "cone_pair", telegraphMs: [1_200, 1_000],
    damageFactor: 0.65, damageFactorAnimal: 0.65, cooldownMs: 6_000, triggerMinM: 0, triggerMaxM: 110, widthM: 0,
    radiusM: 0, rangeM: 110, angleDeg: 70, missStaggerMs: 1_000, hitRecoveryMs: 300,
    abilityIds: ["skirmisher_double_a", "skirmisher_double_b"], existing: false
  },
  smoke_step: {
    kind: "smoke_step", archetype: "skirmisher", shape: "circle", telegraphMs: [1_200], damageFactor: 1.75,
    damageFactorAnimal: 1.75, cooldownMs: 10_000, triggerMinM: R * 1.3, triggerMaxM: R * 5, widthM: 0, radiusM: R * 0.5,
    rangeM: R * 0.6, angleDeg: 0, missStaggerMs: 1_000, hitRecoveryMs: 300, abilityIds: ["skirmisher_smoke"],
    existing: true
  },
  swoop: {
    kind: "swoop", archetype: "skirmisher", shape: "cone", telegraphMs: [1_300], damageFactor: 1.3, damageFactorAnimal: 1.3,
    cooldownMs: 8_000, triggerMinM: 0, triggerMaxM: R * 1.3, widthM: 0, radiusM: 0, rangeM: R * 1.3, angleDeg: 90,
    missStaggerMs: 1_000, hitRecoveryMs: 300, abilityIds: ["skirmisher_swoop"], existing: true
  },
  ground_blast: {
    kind: "ground_blast", archetype: "caster", shape: "circle", telegraphMs: [1_500], damageFactor: 1.3,
    damageFactorAnimal: 1.3, cooldownMs: 6_000, triggerMinM: 150, triggerMaxM: 300, widthM: 0, radiusM: 100, rangeM: 0,
    angleDeg: 0, missStaggerMs: 0, hitRecoveryMs: 500, abilityIds: ["caster_blast"], existing: false
  },
  volley: {
    kind: "volley", archetype: "caster", shape: "fan", telegraphMs: [1_200], damageFactor: 0.6, damageFactorAnimal: 0.6,
    cooldownMs: 6_000, triggerMinM: 150, triggerMaxM: 260, widthM: 40, radiusM: 0, rangeM: 260, angleDeg: 50,
    missStaggerMs: 0, hitRecoveryMs: 500, abilityIds: ["caster_volley_l", "caster_volley_c", "caster_volley_r"],
    existing: false
  },
  tongue: {
    kind: "tongue", archetype: "caster", shape: "line", telegraphMs: [1_200], damageFactor: 0.6, damageFactorAnimal: 0.6,
    cooldownMs: 8_000, triggerMinM: R * 1.2, triggerMaxM: R * 3.5, widthM: R * 0.6, radiusM: 0, rangeM: R * 3.5,
    angleDeg: 0, missStaggerMs: 0, hitRecoveryMs: 500, abilityIds: ["caster_tongue"], existing: true
  },
  pile_on_wave: {
    kind: "pile_on_wave", archetype: "swarmer", shape: "wave", telegraphMs: [1_000], damageFactor: 0.3,
    damageFactorAnimal: 0.3, cooldownMs: 0, triggerMinM: 0, triggerMaxM: 90, widthM: 0, radiusM: 0, rangeM: 90,
    angleDeg: 70, missStaggerMs: 0, hitRecoveryMs: 0, abilityIds: ["swarmer_wave"], existing: false
  }
};

/**
 * Archetype parameters with the basic windup times MOB_TELEGRAPH_SCALE (recover and cooldown unchanged, so the cycle
 * grows with it). Scale 1 returns the table row itself.
 */
export function scaleMobArchetypeParams(params: MobArchetypeParams, scale: number): MobArchetypeParams {
  const windupMs = scaleTelegraphMs(params.windupMs, scale);
  return windupMs === params.windupMs ? params : { ...params, windupMs };
}

/** A signature with every telegraph part times MOB_TELEGRAPH_SCALE. Scale 1 returns the table row itself. */
export function scaleMobSignature(signature: MobSignatureParams, scale: number): MobSignatureParams {
  const telegraphMs = signature.telegraphMs.map((ms) => scaleTelegraphMs(ms, scale));
  return telegraphMs.every((ms, index) => ms === signature.telegraphMs[index]) ? signature : { ...signature, telegraphMs };
}

/** Telegraph ability ids the client styles as signatures (heavier outline). */
export const MOB_SIGNATURE_ABILITY_IDS: ReadonlySet<string> = new Set(
  Object.values(MOB_SIGNATURES).flatMap((signature) => signature.abilityIds)
);

export function isMobSignatureAbilityId(abilityId: string): boolean {
  return MOB_SIGNATURE_ABILITY_IDS.has(abilityId);
}

// ---- Mapping: every overworld mob (spec section 3) ----

/** Behaviour family (mobBehaviorArchetype, or the world template for template-only mobs) to archetype and signature. */
export const MOB_ARCHETYPE_BY_FAMILY: Readonly<Record<string, readonly [MobArchetypeId, MobSignatureKind]>> = {
  wolf: ["pack", "lunge"],
  hog: ["brute", "charge"],
  alligator: ["brute", "charge"],
  bear: ["brute", "maul"],
  orc_brute: ["brute", "maul"],
  skeleton: ["brute", "maul"],
  ogre: ["brute", "slam"],
  deer: ["swarmer", "pile_on_wave"],
  sap_crawler: ["swarmer", "pile_on_wave"],
  coastal_crab: ["swarmer", "pile_on_wave"],
  frog: ["caster", "tongue"],
  squid: ["caster", "ground_blast"],
  bandit: ["skirmisher", "smoke_step"],
  world_cliff_hawk: ["skirmisher", "swoop"],
  world_shellback_turtle: ["brute", "none"]
};

/** Per-mob exceptions; `unclear` marks the calls the spec flags with `*`. */
export const MOB_ARCHETYPE_OVERRIDES: Readonly<Record<string, readonly [MobArchetypeId, MobSignatureKind]>> = {
  jaguar: ["pack", "lunge"],
  griffin: ["pack", "lunge"],
  storm_harpy: ["pack", "lunge"],
  ash_drake: ["pack", "lunge"],
  centaur_outrider: ["skirmisher", "double_strike"],
  merfolk_harpooner: ["skirmisher", "double_strike"],
  mossjaw_spearman: ["skirmisher", "double_strike"],
  great_grey_owl: ["skirmisher", "swoop"],
  golden_eagle: ["skirmisher", "swoop"],
  hedge_witch: ["caster", "ground_blast"],
  rime_witch: ["caster", "ground_blast"],
  nixie: ["caster", "tongue"],
  gnoll_bonebow: ["caster", "volley"],
  frogfolk_blowgunner: ["caster", "volley"],
  jellyfish: ["brute", "slam"],
  crested_porcupine: ["brute", "none"],
  shellback: ["brute", "none"],
  spur_thighed_tortoise: ["brute", "none"],
  snapping_turtle: ["brute", "none"],
  kappa: ["brute", "none"],
  kappa_brawler: ["brute", "none"],
  sidewinder: ["swarmer", "pile_on_wave"],
  sea_otter: ["swarmer", "pile_on_wave"],
  river_salmon: ["swarmer", "pile_on_wave"],
  frogfolk_tadpole: ["swarmer", "pile_on_wave"],
  spiny_lobster: ["swarmer", "pile_on_wave"]
};

/** Mobs deliberately not managed by archetypes (speed 0, do not retaliate). */
export const MOB_ARCHETYPE_EXCLUDED_KEYS: readonly string[] = Object.freeze(["drowned_citizen"]);

export type MobArchetypeAssignment = Readonly<{ archetype: MobArchetypeId; signature: MobSignatureKind }>;

/** Archetype and signature for a mob key, or null when the mob is excluded or unmapped. */
export function mobArchetypeAssignment(archetypeKey: string): MobArchetypeAssignment | null {
  if (MOB_ARCHETYPE_EXCLUDED_KEYS.includes(archetypeKey)) return null;
  const override = MOB_ARCHETYPE_OVERRIDES[archetypeKey];
  if (override) return { archetype: override[0], signature: override[1] };
  const behaviour = mobBehaviorArchetype(archetypeKey);
  const template = mobTemplateOf(archetypeKey);
  const family = MOB_ARCHETYPE_BY_FAMILY[behaviour] ??
    (template !== null ? MOB_ARCHETYPE_BY_FAMILY[template] : undefined);
  return family ? { archetype: family[0], signature: family[1] } : null;
}

export function mobArchetypeOf(archetypeKey: string): MobArchetypeId | null {
  return mobArchetypeAssignment(archetypeKey)?.archetype ?? null;
}

export function mobSignatureOf(archetypeKey: string): MobSignatureKind {
  return mobArchetypeAssignment(archetypeKey)?.signature ?? "none";
}

/** Attack reach for a caster under the flag: the override for the four humanoids, else null (keep the definition's). */
export function mobArchetypeReachOverrideM(archetypeKey: string): number | null {
  return MOB_ARCH_CASTER_REACH_OVERRIDE_KEYS.includes(archetypeKey) ? MOB_ARCH_CASTER_REACH_OVERRIDE_M : null;
}

// ---- Guardrail math (spec section 8), computed from the tables ----

/** Phase 1 lone-mob rate and token ceiling, in hit-equivalents per second. */
export const MOB_ARCH_PHASE1_LONE_HE_PER_SEC = 1_000 / BASIC_ATTACK_INTERVAL_MS;
export const MOB_ARCH_PHASE1_HOLD_MS = MOB_ARCH_PHASE1_REFERENCE_HOLD_MS;
export const MOB_ARCH_PHASE1_CEILING_HE_PER_SEC = (MOB_TACTICS_MELEE_TOKENS / (MOB_ARCH_PHASE1_HOLD_MS / 1_000));

/** Time a basic strike keeps its token: windup plus recover. */
export function mobArchetypeHoldMs(archetype: MobArchetypeId): number {
  const p = MOB_ARCHETYPE_PARAMS[archetype];
  return p.windupMs + p.recoverMs;
}

/** One mob alone, basic strikes only. */
export function mobArchetypeLoneHePerSec(archetype: MobArchetypeId): number {
  return MOB_ARCHETYPE_PARAMS[archetype].basicDamageFactor / (mobArchetypeCycleMs(archetype) / 1_000);
}

/** Token ceiling for a pure pack of this archetype, basic strikes only (caster uses the ranged pool). */
export function mobArchetypeCeilingHePerSec(archetype: MobArchetypeId): number {
  const p = MOB_ARCHETYPE_PARAMS[archetype];
  const capacity = archetype === "caster" ? MOB_ARCH_CASTER_RANGED_TOKENS : MOB_TACTICS_MELEE_TOKENS;
  return (capacity / (p.basicTokenCost * (mobArchetypeHoldMs(archetype) / 1_000))) * p.basicDamageFactor;
}

/** Incoming rate for a pure pack of `count` mobs of one archetype, basic strikes only. */
export function mobArchetypePackHePerSec(archetype: MobArchetypeId, count: number): number {
  return Math.min(
    Math.max(0, count) * mobArchetypeLoneHePerSec(archetype),
    mobArchetypeCeilingHePerSec(archetype),
    MOB_ARCH_GOVERNOR_BUDGET_HE / (MOB_ARCH_GOVERNOR_WINDOW_MS / 1_000)
  );
}

/** Hit-equivalents per token point-second (the per-archetype rate the basic ceiling bounds). */
export function mobArchetypeHePerPointSecond(archetype: MobArchetypeId): number {
  const p = MOB_ARCHETYPE_PARAMS[archetype];
  return p.basicDamageFactor / (p.basicTokenCost * (mobArchetypeHoldMs(archetype) / 1_000));
}

/** Seconds a player needs to walk out of a signature shape of this size (distance / player speed). */
export function mobSignatureWalkOutMs(distanceM: number, playerSpeedMps: number): number {
  return (distanceM / playerSpeedMps) * 1_000;
}
