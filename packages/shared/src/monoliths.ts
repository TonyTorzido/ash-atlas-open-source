/*
 * War monoliths (Field Engineering). A player who has discovered Field
 * Engineering and ranked it up places short-lived monoliths at their own
 * position. Every effect reaches only the owner's allies (the owner, their
 * city and their kingdom) inside a 540 m DIAMETER (270 m radius) circle.
 *
 * A monolith lives 20 h, then leaves 30 h of inert remnants; a recharge costs
 * two sparks; ignition costs 25 crude oil and burns the monolith down in 80 min.
 * The spark is the Forge Spark, the Golem Forge token. Discovery is 175
 * Sparks turned in at the Spark Forge altar in the Golem Forge hub and
 * nowhere else (dungeonSkills.ts); it takes nothing else. A build costs 1 Spark and a
 * recharge costs 2. Players who discovered Field Engineering earlier,
 * when it cost Crystal, keep the skill.
 *
 * Frenzy monoliths boost siege building damage by
 * MONOLITH_BERSERKER_SIEGE_DAMAGE_BONUS.
 */
import { BASIC_ATTACK_INTERVAL_MS } from "./combatConstants.js";

export const MONOLITH_TYPES = ["healer", "reflection", "gloom", "berserker", "hunter", "fortified"] as const;
export type MonolithType = (typeof MONOLITH_TYPES)[number];

export const MONOLITH_SKILL_ID = "field_engineering" as const;
export const MONOLITH_RANGE_DIAMETER_M = 540;
export const MONOLITH_RANGE_RADIUS_M = MONOLITH_RANGE_DIAMETER_M / 2;
export const MONOLITH_LIFETIME_MS = 20 * 60 * 60 * 1_000;
export const MONOLITH_REMNANT_MS = 30 * 60 * 60 * 1_000;
export const MONOLITH_BURN_MS = 80 * 60 * 1_000;
/** Recharge, ignite and inspect from this close. */
export const MONOLITH_INTERACTION_RADIUS_M = 50;

/** The spark: the Golem Forge token. */
export const MONOLITH_SPARK_ITEM_ID = "forge_spark" as const;
/** Turned in at the Spark Forge altar (DUNGEON_SKILL_TURN_INS.field_engineering); nothing else is taken. */
export const MONOLITH_DISCOVERY_SPARKS = 175;
export const MONOLITH_BUILD_SPARKS = 1;
export const MONOLITH_RECHARGE_SPARKS = 2;
export const MONOLITH_IGNITE_ITEM_ID = "crude_oil" as const;
export const MONOLITH_IGNITE_QUANTITY = 25;

/** Rank 1: Healer, Reflection. Rank 2: Gloom, Frenzy. Rank 3: Hunter, Fortified. */
export const MONOLITH_REQUIRED_RANK: Readonly<Record<MonolithType, 1 | 2 | 3>> = Object.freeze({
  healer: 1,
  reflection: 1,
  gloom: 2,
  berserker: 2,
  hunter: 3,
  fortified: 3
});

/** Reflection and Gloom wait on a debuff-reflection system; they stand but do nothing yet. */
export const MONOLITH_INERT_TYPES: ReadonlySet<MonolithType> = new Set(["reflection", "gloom"]);

/** Frenzy: allies in range deal +28% attack damage. */
export const MONOLITH_BERSERKER_ATTACK_BONUS = 0.28;
/** Frenzy: allied Sieges in range deal +30% building damage. */
export const MONOLITH_BERSERKER_SIEGE_DAMAGE_BONUS = 0.3;
/** Fortified: allied structures in range take 45% less building damage. */
export const MONOLITH_FORTIFIED_DAMAGE_MULTIPLIER = 0.55;
/** Hunter: +27% Bricks and City Coins for allies in range ... */
export const MONOLITH_HUNTER_YIELD_BONUS_PERCENT = 27;
/** ... plus 8% more for a recipient who holds Field Engineering rank 3 (added, not multiplied). */
export const MONOLITH_HUNTER_RANK3_EXTRA_PERCENT = 8;
/** Reflection: debuff capacity 7 (stored for the future reflection system). */
export const MONOLITH_REFLECTION_CAPACITY = 7;
/**
 * Healer: heals 1.6% max health every beat (1.4 s), in or out of combat (about 1.1% per second).
 */
export const MONOLITH_HEALER_TICK_MS = BASIC_ATTACK_INTERVAL_MS;
export const MONOLITH_HEALER_HEAL_FRACTION = 0.016;

export const MONOLITH_DISPLAY_NAMES: Readonly<Record<MonolithType, string>> = Object.freeze({
  healer: "Healer Monolith",
  reflection: "Reflection Monolith",
  gloom: "Gloom Monolith",
  berserker: "Frenzy Monolith",
  hunter: "Hunter Monolith",
  fortified: "Fortified Monolith"
});

export const MONOLITH_EFFECT_TEXT: Readonly<Record<MonolithType, string>> = Object.freeze({
  healer: "Allies in range heal 1.6% of their health every 1.4 seconds.",
  reflection: "Raises allies' reflected-debuff capacity to 7. Effect coming soon.",
  gloom: "Effect coming soon.",
  berserker: "Allies in range deal 28% more attack damage; allied Sieges deal 30% more building damage.",
  hunter: "Allies in range earn 27% more Bricks and City Coins (35% with Field Engineering rank 3).",
  fortified: "Allied structures in range take 45% less building damage."
});

export function isMonolithType(value: unknown): value is MonolithType {
  return typeof value === "string" && (MONOLITH_TYPES as readonly string[]).includes(value);
}

/** True when a player with this Field Engineering rank may build the type. */
export function monolithTypeUnlocked(type: MonolithType, rank: number): boolean {
  return Number.isFinite(rank) && rank >= MONOLITH_REQUIRED_RANK[type];
}

export type MonolithPhase = "active" | "remnant" | "burning" | "gone";

export type MonolithTimes = Readonly<{
  expiresAtMs: number;
  remnantUntilMs: number;
  burnUntilMs: number | null;
}>;

/**
 * Phase at `nowMs`. Remnants are inert until recharged; "gone" means the
 * remnants ran out or the fire burnt the monolith down.
 */
export function monolithPhase(times: MonolithTimes, nowMs: number): MonolithPhase {
  if (nowMs >= times.remnantUntilMs) return "gone";
  if (times.burnUntilMs !== null) return nowMs < times.burnUntilMs ? "burning" : "gone";
  return nowMs < times.expiresAtMs ? "active" : "remnant";
}

/** True while the effect applies: inside its 20 h life, burning or not. */
export function monolithEffective(times: MonolithTimes, nowMs: number): boolean {
  const phase = monolithPhase(times, nowMs);
  return (phase === "active" || phase === "burning") && nowMs < times.expiresAtMs;
}

export type MonolithAllegiance = Readonly<{ playerId: string; cityId: string | null; kingdomId: string | null }>;

/** Allies: the same player, or a shared city, or a shared kingdom. */
export function monolithAllied(owner: MonolithAllegiance, other: MonolithAllegiance): boolean {
  return owner.playerId === other.playerId ||
    (owner.cityId !== null && owner.cityId === other.cityId) ||
    (owner.kingdomId !== null && owner.kingdomId === other.kingdomId);
}

/** Hunter bonus percent for a recipient with this Field Engineering rank. */
export function monolithHunterBonusPercent(recipientRank: number): number {
  return MONOLITH_HUNTER_YIELD_BONUS_PERCENT + (recipientRank >= 3 ? MONOLITH_HUNTER_RANK3_EXTRA_PERCENT : 0);
}

/**
 * Whole-unit Hunter yield: the fractional part of `quantity x (1 + bonus)`
 * is paid with probability equal to the fraction, using a deterministic
 * roll in [0, 1) so a retried settlement pays the same.
 */
export function monolithHunterYield(quantity: number, bonusPercent: number, roll: number): number {
  if (!Number.isSafeInteger(quantity) || quantity <= 0 || !(bonusPercent > 0)) return quantity;
  const scaled = quantity * (100 + bonusPercent);
  const whole = Math.floor(scaled / 100);
  const fraction = (scaled % 100) / 100;
  return whole + (roll >= 0 && roll < fraction ? 1 : 0);
}

/** Siege / bomber building damage after Frenzy (attacker side) and Fortified (target side). */
export function monolithBuildingDamage(baseDamage: number, input: Readonly<{ berserker: boolean; fortified: boolean }>): number {
  if (!(baseDamage > 0)) return 0;
  let damage = baseDamage;
  if (input.berserker) damage *= 1 + MONOLITH_BERSERKER_SIEGE_DAMAGE_BONUS;
  if (input.fortified) damage *= MONOLITH_FORTIFIED_DAMAGE_MULTIPLIER;
  return Math.max(1, Math.round(damage));
}

/** One monolith as the nearby list and the map show it. */
export type MonolithSnapshot = Readonly<{
  id: string;
  type: MonolithType;
  ownerPlayerId: string;
  ownerName: string;
  lat: number;
  lon: number;
  rangeRadiusM: number;
  placedAt: string;
  expiresAt: string;
  remnantUntil: string;
  burnUntil: string | null;
  phase: MonolithPhase;
  allied: boolean;
  own: boolean;
  inert: boolean;
  distanceM: number;
}>;

export type MonolithStateSnapshot = Readonly<{
  serverTime: string;
  skill: Readonly<{ discovered: boolean; rank: number }>;
  sparks: number;
  crudeOil: number;
  monoliths: readonly MonolithSnapshot[];
}>;
