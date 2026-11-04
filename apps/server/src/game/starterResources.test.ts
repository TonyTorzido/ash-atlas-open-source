import { describe, expect, it, vi } from "vitest";

import { FLAG_BUILD_COST } from "./flags.js";
import {
  STARTER_LEATHER,
  STARTER_STONE,
  STARTER_WOOD,
  ensureStarterResources,
  starterResourceOperation
} from "./starterResources.js";

describe("starter resources v1", () => {
  it("grants exactly the ordinary materials for five basic flags and no stone", () => {
    const operation = starterResourceOperation("player-1");
    expect(operation.operationKey).toBe("starter-resources-v1:player-1");
    expect(operation.grants).toEqual([
      { itemId: "wood", variant: null, quantity: 15 },
      { itemId: "leather", variant: null, quantity: 10 }
    ]);
    expect(STARTER_STONE).toBe(0);
    expect(Math.floor(STARTER_WOOD / FLAG_BUILD_COST.wood)).toBe(5);
    expect(Math.floor(STARTER_LEATHER / FLAG_BUILD_COST.leather)).toBe(5);
    expect(STARTER_WOOD).toBeLessThan(FLAG_BUILD_COST.wood * 6);
    expect(STARTER_LEATHER).toBeLessThan(FLAG_BUILD_COST.leather * 6);
  });

  it("uses one stable operation identity across reconnects, retries, and concurrent initialization", async () => {
    const applied = new Set<string>();
    const grantItemsForOperation = vi.fn(async (operation: ReturnType<typeof starterResourceOperation>) => {
      const first = !applied.has(operation.operationKey);
      applied.add(operation.operationKey);
      return { applied: first, inventory: { playerId: operation.playerId, items: [], totals: {} } };
    });
    const inventory = { grantItemsForOperation } as never;
    const results = await Promise.all([
      ensureStarterResources(inventory, "existing-player"),
      ensureStarterResources(inventory, "existing-player"),
      ensureStarterResources(inventory, "existing-player")
    ]);
    expect(results.filter((result) => result.applied)).toHaveLength(1);
    expect(new Set(grantItemsForOperation.mock.calls.map(([input]) => input.operationKey))).toEqual(
      new Set(["starter-resources-v1:existing-player"])
    );
  });

  it("never derives eligibility from the player's current balances", () => {
    expect(starterResourceOperation("spent-all")).toEqual(starterResourceOperation("spent-all"));
  });
});
