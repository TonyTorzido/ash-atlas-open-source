import {
  DUNGEON_METERS_PER_COORDINATE,
  distanceMeters,
  interiorLocalToLngLat,
  treeDisplayNameForStableId,
  treeProduceAvailable,
  type LatLon
} from "@ash-atlas/shared";

import type { WorldObjectPick } from "./worldObjectPickContracts.js";

export type WorldObjectPickCandidate = Readonly<{
  pick: WorldObjectPick;
  key: string;
  distancePx: number;
}>;

export function preferCityStructuresOverTheirCity(
  picks: readonly WorldObjectPick[]
): WorldObjectPick[] {
  const structureCityIds = new Set(
    picks
      .filter((pick) => pick.kind === "city_structure")
      .map((pick) => pick.value.cityId)
  );
  return picks.filter((pick) =>
    pick.kind !== "city" || !structureCityIds.has(pick.value.id)
  );
}

export function prioritizeWorldObjectPicks(
  candidates: readonly WorldObjectPickCandidate[]
): WorldObjectPick[] {
  const preferredPicks = new Set(
    preferCityStructuresOverTheirCity(candidates.map(({ pick }) => pick))
  );
  return [...candidates]
    .filter(({ pick }) => preferredPicks.has(pick))
    .sort((left, right) =>
      worldObjectPickRank(left.pick) - worldObjectPickRank(right.pick)
      || left.distancePx - right.distancePx
      || compareKeys(left.key, right.key)
    )
    .map(({ pick }) => pick);
}

export function orderRepeatedWorldObjectsNearestToPlayer(
  picks: readonly WorldObjectPick[],
  player: LatLon
): WorldObjectPick[] {
  const groups = new Map<string, Array<{
    pick: WorldObjectPick;
    distanceM: number;
    originalIndex: number;
  }>>();
  picks.forEach((pick, originalIndex) => {
    const identity = repeatedWorldObjectIdentity(pick);
    if (!identity) return;
    const group = groups.get(identity) ?? [];
    group.push({ pick, distanceM: distanceMeters(player, worldObjectPickPosition(pick)), originalIndex });
    groups.set(identity, group);
  });
  const sortedGroups = new Map(
    [...groups]
      .filter(([, group]) => group.length > 1)
      .map(([identity, group]) => [identity, [...group].sort((left, right) =>
        left.distanceM - right.distanceM || left.originalIndex - right.originalIndex
      ).map(({ pick }) => pick)] as const)
  );
  const cursors = new Map<string, number>();
  return picks.map((pick) => {
    const identity = repeatedWorldObjectIdentity(pick);
    if (!identity) return pick;
    const sorted = sortedGroups.get(identity);
    if (!sorted) return pick;
    const cursor = cursors.get(identity) ?? 0;
    cursors.set(identity, cursor + 1);
    return sorted[cursor] ?? pick;
  });
}

function repeatedWorldObjectIdentity(pick: WorldObjectPick): string | null {
  switch (pick.kind) {
    case "combat_entity": {
      const category = pick.value.companion ? "companion" : "creature";
      return `${category}:${combatEntityPickIdentity(pick.value)}`;
    }
    case "collectible":
      if (pick.value.type === "wood") {
        return `collectible:tree:${treeDisplayNameForStableId(pick.value.id, treeProduceAvailable(pick.value, Date.now()))}`;
      }
      return pick.value.repeatableNodeType
        ? `collectible:repeatable:${pick.value.repeatableNodeType}`
        : `collectible:resource:${pick.value.type}`;
    case "dropped_item":
      return `dropped_item:${pick.value.itemId}:${pick.value.variant ?? "default"}`;
    case "city_structure":
      return `city_structure:${pick.value.type}:tier-${pick.value.tier}`;
    case "dungeon_entrance":
      return `dungeon_entrance:${pick.value.dungeonId}`;
    case "furnace":
    case "tannery":
    case "loom":
    case "kitchen":
    case "fishing_hut":
      return pick.kind;
    case "flag":
    case "city":
    case "manor":
    case "greenhouse":
    case "player":
    case "interior_object":
      return null;
  }
}

/**
 * Map lat/lon of a pick. Interior picks store local room units, which map to
 * lngLat through the dungeon frame; everything else already carries lat/lon.
 */
export function worldObjectPickPosition(pick: WorldObjectPick): LatLon {
  if (pick.kind === "interior_object") {
    return interiorLocalToLngLat(pick.value, DUNGEON_METERS_PER_COORDINATE);
  }
  return pick.value;
}

export function worldObjectPickDistanceMeta(
  player: LatLon,
  pick: WorldObjectPick
): string {
  const distance = `${Math.max(0, Math.round(distanceMeters(player, worldObjectPickPosition(pick))))}m`;
  if (pick.kind !== "combat_entity") return distance;
  const healthPercent = injuredCombatEntityHealthPercent(pick.value);
  return healthPercent === null ? distance : `${distance} ${healthPercent}%`;
}

export function injuredCombatEntityHealthPercent(
  entity: Extract<WorldObjectPick, { kind: "combat_entity" }>["value"]
): number | null {
  const { currentHealth, maxHealth } = entity;
  if (
    !Number.isFinite(currentHealth) ||
    !Number.isFinite(maxHealth) ||
    maxHealth <= 0 ||
    currentHealth < 0 ||
    currentHealth >= maxHealth
  ) return null;
  return Math.min(99, Math.max(0, Math.round(currentHealth / maxHealth * 100)));
}

function combatEntityPickIdentity(
  entity: Extract<WorldObjectPick, { kind: "combat_entity" }>["value"]
): string {
  const archetypeKey = entity.archetypeKey?.trim();
  if (archetypeKey) return `archetype:${archetypeKey}`;
  const name = entity.name.trim().toLowerCase();
  return name ? `name:${name}` : `entity:${entity.entityId}`;
}

function worldObjectPickRank(pick: WorldObjectPick): number {
  if (pick.kind === "city") return 0;
  if (
    pick.kind === "flag" ||
    pick.kind === "city_structure" ||
    pick.kind === "dungeon_entrance" ||
    pick.kind === "manor" ||
    pick.kind === "greenhouse" ||
    pick.kind === "furnace" ||
    pick.kind === "tannery" ||
    pick.kind === "loom" ||
    pick.kind === "kitchen" ||
    pick.kind === "fishing_hut"
  ) return 1;
  if (pick.kind === "dropped_item") return 2;
  // A dungeon door beats the creatures around it: with action combat, attacking is the swing input, so a tap on a door
  // with mobs awake in front of it (or the player standing on it) must open the door prompt, not select a mob.
  if (pick.kind === "interior_object" && pick.value.kind === "portal") return 2.5;
  if (pick.kind === "combat_entity") return 3;
  if (pick.kind === "player") return 4;
  if (pick.kind === "interior_object") return 6;
  return 5;
}

function compareKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
