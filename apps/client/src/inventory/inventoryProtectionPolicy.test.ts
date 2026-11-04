import type { InventoryProtectionSnapshot } from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import { acceptInventoryProtectionSnapshot } from "./inventoryProtectionPolicy.js";

describe("inventory protection policy installation", () => {
  it("rejects another player and older revisions", () => {
    const current = snapshot("player-1", 5, 20);

    expect(
      acceptInventoryProtectionSnapshot(current, snapshot("player-2", 6, 30), "player-1")
    ).toMatchObject({ accepted: false, snapshot: current });
    expect(
      acceptInventoryProtectionSnapshot(current, snapshot("player-1", 4, 10), "player-1")
    ).toMatchObject({ accepted: false, snapshot: current });
  });

  it("accepts newer policy and compatible equal-revision derived refreshes", () => {
    const current = snapshot("player-1", 5, 20);
    const refreshed = {
      ...current,
      materialPolicies: [{
        ...current.materialPolicies[0]!,
        currentTotal: 999
      }]
    };

    expect(
      acceptInventoryProtectionSnapshot(current, refreshed, "player-1")
    ).toEqual({ accepted: true, snapshot: refreshed });
    expect(
      acceptInventoryProtectionSnapshot(current, snapshot("player-1", 6, 30), "player-1")
    ).toMatchObject({ accepted: true, snapshot: { revision: 6 } });
  });

  it("does not regress policy values at an equal revision", () => {
    const current = snapshot("player-1", 5, 20);
    expect(
      acceptInventoryProtectionSnapshot(current, snapshot("player-1", 5, 10), "player-1")
    ).toEqual({ accepted: false, snapshot: current });
  });
});

function snapshot(
  playerId: string,
  revision: number,
  keepQuantity: number
): InventoryProtectionSnapshot {
  return {
    playerId,
    revision,
    materialPolicies: [{
      itemId: "wood",
      variant: null,
      keepQuantity,
      currentTotal: 0
    }],
    uniqueItems: [],
    stackAllocations: []
  };
}
