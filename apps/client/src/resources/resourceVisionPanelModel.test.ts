import type { CollectibleNode, ResourceType } from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import { summarizeVisibleHarvestables } from "./resourceVisionPanelModel.js";

describe("Resource Vision panel model", () => {
  it("counts available visible nodes by type instead of summing item quantities", () => {
    const summary = summarizeVisibleHarvestables([
      node("wood", "available", 35),
      node("wood", "available", 20),
      node("stone", "available", 10),
      node("food", "available", 8),
      node("ore", "available", 4)
    ]);

    expect(summary).toEqual({
      counts: { wood: 2, stone: 1, food: 1, ore: 1 },
      totalAvailableGroundNodes: 5,
      otherAvailableNodes: 0
    });
  });

  it("does not count harvested, removed, or water nodes as available ground nodes", () => {
    const visible = [
      node("wood", "available"),
      node("stone", "harvested"),
      node("water", "available")
    ];

    expect(summarizeVisibleHarvestables(visible)).toMatchObject({
      counts: { wood: 1, stone: 0, food: 0, ore: 0 },
      totalAvailableGroundNodes: 1
    });
    expect(summarizeVisibleHarvestables(visible.filter((item) => item.type !== "wood"))).toMatchObject({
      counts: { wood: 0, stone: 0, food: 0, ore: 0 },
      totalAvailableGroundNodes: 0
    });
  });

  it("keeps Resource Vision counts independent from owned inventory totals", () => {
    const nodes = [node("wood", "available")];
    const beforeInventoryUpdate = summarizeVisibleHarvestables(nodes);
    const afterInventoryUpdate = summarizeVisibleHarvestables(nodes);

    expect(afterInventoryUpdate).toEqual(beforeInventoryUpdate);
    expect(afterInventoryUpdate.counts.wood).toBe(1);
  });

  it("tracks unknown available types without crashing", () => {
    const unknownNode = {
      ...node("wood", "available"),
      type: "crystal"
    } as unknown as CollectibleNode;

    expect(summarizeVisibleHarvestables([unknownNode])).toEqual({
      counts: { wood: 0, stone: 0, food: 0, ore: 0 },
      totalAvailableGroundNodes: 1,
      otherAvailableNodes: 1
    });
  });

  it("returns a clear empty summary for no visible nodes or malformed data", () => {
    expect(summarizeVisibleHarvestables([null, {}, { type: "wood" }])).toEqual({
      counts: { wood: 0, stone: 0, food: 0, ore: 0 },
      totalAvailableGroundNodes: 0,
      otherAvailableNodes: 0
    });
  });
});

function node(
  type: ResourceType,
  state: CollectibleNode["state"],
  quantity = 1
): CollectibleNode {
  return {
    id: `${type}-${state}-${quantity}`,
    type,
    lat: 35,
    lon: -106,
    quantity,
    state,
    createdAt: "2026-07-09T00:00:00.000Z",
    harvestedAt: state === "harvested" ? "2026-07-09T00:01:00.000Z" : null,
    sourceCellId: "cell-1",
    waterKind: type === "water" ? "fresh" : null
  };
}
