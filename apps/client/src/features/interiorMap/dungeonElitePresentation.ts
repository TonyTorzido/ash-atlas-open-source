import {
  DUNGEON_ELITE_TUNING,
  type CombatEntitySnapshot,
  type DungeonEnemySnapshot
} from "@ash-atlas/shared";

export type DungeonEnemyElite = NonNullable<DungeonEnemySnapshot["elite"]>;

/** Text stubs until the elite modifier icons land. */
export const ELITE_MODIFIER_BADGES: Readonly<Record<string, string>> = {
  hardy: "Hardy", swift: "Swift", shielded: "Shield", enraged: "Enraged", splitting: "Splits", healer_aura: "Healer"
};

const ELITE_PREFIX = "Elite ";

/** "Elite <name>"; idempotent, so an already decorated name is returned as is. */
export function eliteDisplayName(name: string): string {
  return name.startsWith(ELITE_PREFIX) ? name : `${ELITE_PREFIX}${name}`;
}

export function eliteModifierBadge(modifier: string): string {
  return ELITE_MODIFIER_BADGES[modifier] ?? modifier;
}

/** Authored per-mob draw scale, times the elite size bump. */
export function dungeonEnemyVisualScale(enemy: Pick<DungeonEnemySnapshot, "visualScale" | "elite">): number {
  return enemy.visualScale * (enemy.elite ? DUNGEON_ELITE_TUNING.visualScaleMultiplier : 1);
}

/** Two-line map label: "Elite <name>" over the modifier badges ("Swift · Shield"). */
export function dungeonEliteMapLabel(elite: DungeonEnemyElite, name: string): string {
  const badges = elite.modifiers.map(eliteModifierBadge).join(" · ");
  return badges ? `${eliteDisplayName(name)}\n${badges}` : eliteDisplayName(name);
}

/** Elite modifiers by combat entity id, from the dungeon snapshot's enemies. */
export function dungeonElitesByEntityId(
  enemies: readonly Pick<DungeonEnemySnapshot, "entityId" | "elite">[]
): ReadonlyMap<string, DungeonEnemyElite> {
  const elites = new Map<string, DungeonEnemyElite>();
  for (const enemy of enemies) if (enemy.elite) elites.set(enemy.entityId, enemy.elite);
  return elites;
}

/** The combat entity with an elite's name ("Elite <name>"), for target choosers and cards. */
export function withDungeonEliteName<T extends CombatEntitySnapshot | null>(
  entity: T,
  elites: ReadonlyMap<string, DungeonEnemyElite>
): T {
  if (!entity || entity.kind !== "mob" || !elites.has(entity.entityId)) return entity;
  const name = eliteDisplayName(entity.name);
  return name === entity.name ? entity : { ...entity, name };
}
