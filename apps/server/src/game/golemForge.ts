import type { DungeonDefinition } from "@ash-atlas/shared";

/**
 * Golem Forge shared-building rules (docs/design/GOLEM_FORGE_PLAN.md sections 2, 3 and 10). The Forge is
 * one shared run per site: entry is paid per torch from the live boss count, re-entry pays again, only
 * players inside a boss fight when it started are credited with it, and mob gold gets a group bonus.
 */
export const GOLEM_FORGE_DUNGEON_ID = "golem_forge";

/** The three boss encounters, in no particular order; the last is the final boss. */
export const GOLEM_FORGE_BOSS_ENCOUNTER_IDS: readonly string[] = ["quarry_boss", "conduit_boss", "forgemaster"];
/** The hub room a failed boss fight (the Forgemaster's fourth strike) ejects its occupants to. */
export const GOLEM_FORGE_HUB_ROOM_ID = "gf_crucible";
/** Forgemaster credit starts the lockout. */
export const GOLEM_FORGE_FINAL_BOSS_ENCOUNTER_ID = "forgemaster";

/** Refined (Glimmer) oil per torch by bosses alive: 3 / 2 / 1. Zero alive (collapsing) keeps the 1 price. */
const OIL_PER_TORCH_BY_BOSSES_ALIVE: Readonly<Record<number, number>> = { 3: 22, 2: 15, 1: 7 };
const WOOD_PER_TORCH = 1;

/** Mob gold multiplier by killer's party members present in the same Forge (party cap is 5). */
const GROUP_GOLD_MULTIPLIER_BY_MEMBERS: Readonly<Record<number, number>> = { 1: 1, 2: 1.4, 3: 1.8, 4: 2.2, 5: 2.55 };
export const GOLEM_FORGE_MAX_GROUP_GOLD_MULTIPLIER = 2.55;

export function isGolemForge(dungeon: Pick<DungeonDefinition, "id"> | undefined | null): boolean {
  return dungeon?.id === GOLEM_FORGE_DUNGEON_ID;
}

/**
 * The authored per-torch cost at this many bosses alive (before any Atlas Pass discount, which takes 35% off the
 * oil: 14 / 9 / 4).
 */
export function golemForgeEntryCost(bossesAlive: number): Array<{ itemId: string; quantity: number }> {
  const alive = Math.max(1, Math.min(3, Math.floor(bossesAlive)));
  return [
    { itemId: "refined_oil", quantity: OIL_PER_TORCH_BY_BOSSES_ALIVE[alive]! },
    { itemId: "wood", quantity: WOOD_PER_TORCH }
  ];
}

export function golemForgeGroupGoldMultiplier(membersPresent: number): number {
  const members = Math.max(1, Math.min(5, Math.floor(membersPresent)));
  return GROUP_GOLD_MULTIPLIER_BY_MEMBERS[members]!;
}
