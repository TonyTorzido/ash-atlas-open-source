import { describe, expect, it } from "vitest";

import { refundDungeonEntryTorch } from "./dungeonReentryTorch.js";

describe("Delver's Lore re-entry torch", () => {
  const run = { runId: "run-1", dungeonId: "d", instanceId: "i" };
  const payers = new Set(["dungeon-entry-cost:run-1:payer"]);
  const pool = { query: async (_sql: string, params: unknown[]) => ({ rowCount: payers.has(params[0] as string) ? 1 : 0, rows: [] }) };
  const granted = new Set<string>();
  const inventory = {
    grantItemsForOperation: async (input: { operationKey: string; grants: { quantity: number }[] }) => {
      const applied = !granted.has(input.operationKey);
      granted.add(input.operationKey);
      return { applied, grants: input.grants, inventory: {} };
    }
  };

  it("credits the payer once, never a non-payer, and nothing on a repeat leave", async () => {
    const first = await refundDungeonEntryTorch(pool as never, inventory as never, { ...run, playerId: "payer" });
    expect(first?.grants).toEqual([{ itemId: "torch", variant: null, quantity: 1 }]);
    expect(await refundDungeonEntryTorch(pool as never, inventory as never, { ...run, playerId: "friend" })).toBeNull();
    expect(await refundDungeonEntryTorch(pool as never, inventory as never, { ...run, playerId: "payer" })).toBeNull();
    expect([...granted]).toEqual(["dungeon-reentry-torch:run-1:payer"]);
  });
});
