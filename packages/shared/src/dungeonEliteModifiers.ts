/**
 * Elite modifier ids a rolled dungeon encounter may pick. Picking happens in the run materializer;
 * applying stats and behaviour is the elite runtime's job. Stat-only modifiers are allowed at any
 * level; behaviour modifiers only from dungeon level 20.
 */
export const DUNGEON_ELITE_MODIFIER_IDS = [
  "hardy", "swift", "shielded", "enraged", "splitting", "healer_aura"
] as const;
export type DungeonEliteModifierId = (typeof DUNGEON_ELITE_MODIFIER_IDS)[number];

export const DUNGEON_ELITE_BEHAVIOUR_MIN_LEVEL = 20;

export const DUNGEON_ELITE_MODIFIERS: Readonly<Record<DungeonEliteModifierId, Readonly<{
  kind: "stat" | "behaviour";
  minLevel: number;
}>>> = {
  hardy: { kind: "stat", minLevel: 0 },
  swift: { kind: "stat", minLevel: 0 },
  shielded: { kind: "behaviour", minLevel: DUNGEON_ELITE_BEHAVIOUR_MIN_LEVEL },
  enraged: { kind: "behaviour", minLevel: DUNGEON_ELITE_BEHAVIOUR_MIN_LEVEL },
  splitting: { kind: "behaviour", minLevel: DUNGEON_ELITE_BEHAVIOUR_MIN_LEVEL },
  healer_aura: { kind: "behaviour", minLevel: DUNGEON_ELITE_BEHAVIOUR_MIN_LEVEL }
};

/** Modifiers a dungeon of this level may roll. */
export function dungeonEliteModifierAllowed(id: DungeonEliteModifierId, dungeonLevel: number): boolean {
  return dungeonLevel >= DUNGEON_ELITE_MODIFIERS[id].minLevel;
}

/** Elite runtime tuning. Every number the server and client share lives here. */
export const DUNGEON_ELITE_TUNING = {
  /** Every elite spawns this many levels above its archetype. */
  levelBonus: 1,
  hardy: { healthMultiplier: 1.6, levelBonus: 1 },
  swift: { speedMultiplier: 1.25 },
  shielded: { activeMs: 2_000, periodMs: 8_000 },
  enraged: { belowHealthFraction: 0.3, outgoingDamageMultiplier: 1.4 },
  splitting: { copies: 2, healthFraction: 0.5, visualScale: 0.75 },
  healerAura: { intervalMs: 4_000, radiusM: 150, healFraction: 0.04 },
  /** Client draw scale for an elite (split children are never elite). */
  visualScaleMultiplier: 1.15
} as const;

/** True while a shielded elite's shield is up (the last activeMs of each period), `elapsedMs` after its spawn. */
export function dungeonEliteShieldActive(elapsedMs: number): boolean {
  const { activeMs, periodMs } = DUNGEON_ELITE_TUNING.shielded;
  return elapsedMs >= 0 && elapsedMs % periodMs >= periodMs - activeMs;
}
