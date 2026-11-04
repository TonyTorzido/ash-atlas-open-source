import {
  GROUND_RESOURCE_TYPES,
  type GroundResourceType
} from "@ash-atlas/shared";

export type VisibleHarvestableSummary = {
  counts: Record<GroundResourceType, number>;
  totalAvailableGroundNodes: number;
  otherAvailableNodes: number;
};

const GROUND_RESOURCE_TYPE_SET = new Set<string>(GROUND_RESOURCE_TYPES);

export function summarizeVisibleHarvestables(
  nodes: readonly unknown[]
): VisibleHarvestableSummary {
  const counts: Record<GroundResourceType, number> = {
    wood: 0,
    stone: 0,
    food: 0,
    ore: 0
  };
  let otherAvailableNodes = 0;

  for (const value of nodes) {
    if (!isRecord(value) || value.state !== "available" || typeof value.type !== "string") {
      continue;
    }
    if (GROUND_RESOURCE_TYPE_SET.has(value.type)) {
      counts[value.type as GroundResourceType] += 1;
    } else if (value.type !== "water") {
      otherAvailableNodes += 1;
    }
  }

  return {
    counts,
    totalAvailableGroundNodes:
      counts.wood + counts.stone + counts.food + counts.ore + otherAvailableNodes,
    otherAvailableNodes
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
