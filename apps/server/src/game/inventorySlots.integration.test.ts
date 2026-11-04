import type pg from "pg";
import { describe, expect, it } from "vitest";
import { InventoryService } from "./inventory.js";
// Slot/grid behavior was retired by 0829. Durable quantity, replay, concurrency,
// and migration coverage now lives in inventoryCarry.integration.test.ts.
describe("retired player inventory grid commands", () => {
  const inventory = new InventoryService({} as pg.Pool);
  it("cannot split, move, restack, or reorganize a logical quantity balance", async () => {
    for (const operation of [
      inventory.splitStack("player", "request", "entry", 1),
      inventory.moveStack("player", "request", "entry", 1),
      inventory.restackStack("player", "request", "entry"),
      inventory.reorganize("player", "request")
    ])
      await expect(operation).rejects.toMatchObject({ code: "INVENTORY_ACTION_RETIRED" });
  });
});
