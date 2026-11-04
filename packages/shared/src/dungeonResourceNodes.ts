import type { CollectibleNode, RepeatableResourceNodeType } from "./collectibles.js";
import type { DungeonResourceSnapshot } from "./dungeon.js";
import { DUNGEON_METERS_PER_COORDINATE } from "./dungeon.js";
import type { DungeonResourceType } from "./dungeonCatalog.js";
import { interiorLocalToLngLat } from "./interiorSpace.js";

/**
 * Dungeon resource nodes are the overworld resource nodes, scoped to one dungeon
 * instance and run. The catalog only decides placement and count; presentation,
 * gather duration, yield, tool/mastery effects and depletion/respawn come from
 * the overworld definitions. The node id carries the prefix so one harvesting
 * pipeline can tell a dungeon node from a world node.
 */
export const DUNGEON_RESOURCE_NODE_ID_PREFIX = "dungeon-resource:";

export function dungeonResourceNodeId(resourceId: string): string {
  return `${DUNGEON_RESOURCE_NODE_ID_PREFIX}${resourceId}`;
}

export function isDungeonResourceNodeId(nodeId: string): boolean {
  return nodeId.startsWith(DUNGEON_RESOURCE_NODE_ID_PREFIX);
}

export function dungeonResourceIdFromNodeId(nodeId: string): string | null {
  return isDungeonResourceNodeId(nodeId)
    ? nodeId.slice(DUNGEON_RESOURCE_NODE_ID_PREFIX.length) || null
    : null;
}

/**
 * The overworld permanent mine a dungeon mineral node behaves as. `ore` has no
 * overworld mine of its own and uses the iron mine rules and art; it still pays
 * out `ore`.
 */
export function dungeonResourceMineNodeType(
  resourceType: DungeonResourceType
): RepeatableResourceNodeType | null {
  switch (resourceType) {
    case "stone": return "stone_mine";
    case "coal": return "coal_mine";
    case "iron":
    case "ore": return "iron_mine";
    case "sulfur": return "sulfur_mine";
    default: return null;
  }
}

/**
 * Projects a dungeon resource onto the overworld collectible model so the
 * world renderer, picking and harvest flow handle it unchanged. Positions are
 * the dungeon combat position (lat/lon after the y-flip).
 */
export function dungeonResourceAsCollectible(
  resource: Pick<
    DungeonResourceSnapshot,
    "id" | "resourceType" | "x" | "y" | "quantity" | "state" | "availableAt"
  >,
  metersPerUnit: number = DUNGEON_METERS_PER_COORDINATE
): CollectibleNode | null {
  const mineNodeType = dungeonResourceMineNodeType(resource.resourceType);
  const position = interiorLocalToLngLat(resource, metersPerUnit);
  const nodeId = dungeonResourceNodeId(resource.id);
  const base = {
    id: nodeId,
    type: resource.resourceType,
    lat: position.lat,
    lon: position.lon,
    quantity: resource.quantity,
    createdAt: "",
    harvestedAt: null,
    sourceCellId: `dungeon:${resource.id}`,
    waterKind: null
  } as const;
  if (mineNodeType) {
    const ready = resource.state === "available";
    return {
      ...base,
      state: ready ? "available" : "harvested",
      repeatableNodeType: mineNodeType,
      repeatableState: ready ? "ready" : "depleted",
      // Dungeon veins never regenerate: a depleted one has no ready time and shows no countdown.
      repeatableReadyAt: null,
      repeatableTimerVisibility: ready ? "visible" : "redacted",
      repeatableRevision: 0,
      repeatableOwnerPlayerId: null,
      presentationOwner: "repeatable-resource"
    };
  }
  // Trees and plants vanish when harvested, like the overworld.
  if (resource.state !== "available") return null;
  return { ...base, state: "available", presentationOwner: "population" };
}
