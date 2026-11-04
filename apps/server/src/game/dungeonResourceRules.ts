import {
  FLAX_FIBER_HARVEST_YIELD_QUANTITY,
  dungeonResourceMineNodeType,
  dungeonResourceNodeId,
  treeWoodYieldForStableId,
  type DungeonResourceType
} from "@ash-atlas/shared";

import { PERMANENT_RESOURCE_REGISTRY } from "./permanentResourceLifecycle.js";

/**
 * Overworld rules a dungeon resource node follows. The dungeon catalog only
 * places nodes; yield comes from the overworld definitions, so the catalog's
 * min/max yield and respawn fields no longer change gameplay. Gathering (duration,
 * mastery rolls, XP) matches the overworld, but no dungeon node regenerates: once
 * depleted it stays depleted for the run unless a skill keeps the vein unbroken.
 */
export type DungeonResourceRule = Readonly<{
  kind: "mine" | "tree" | "plant" | "resin";
  /** Base yield before mastery and city bonuses. */
  yieldQuantity: number;
  /** Always null in dungeons: a depleted node stays depleted until the run ends. */
  regenerationMs: number | null;
}>;

export function dungeonResourceRule(
  resourceType: DungeonResourceType,
  resourceId: string
): DungeonResourceRule {
  const mineNodeType = dungeonResourceMineNodeType(resourceType);
  if (mineNodeType) {
    const definition = PERMANENT_RESOURCE_REGISTRY.requireDefinition(mineNodeType);
    return {
      kind: "mine",
      yieldQuantity: definition.yieldQuantity,
      regenerationMs: null
    };
  }
  if (resourceType === "wood") {
    return {
      kind: "tree",
      yieldQuantity: treeWoodYieldForStableId(dungeonResourceNodeId(resourceId)),
      regenerationMs: null
    };
  }
  if (resourceType === "flax_fiber") {
    return { kind: "plant", yieldQuantity: FLAX_FIBER_HARVEST_YIELD_QUANTITY, regenerationMs: null };
  }
  return { kind: "resin", yieldQuantity: 1, regenerationMs: null };
}
