import { describe, expect, it } from "vitest";

import { requireTradeSkillGate } from "./tradeSkillRank.js";

const withRank = (rank: number | null) => ({
  query: async () => ({ rows: rank === null ? [] : [{ rank }] })
}) as never;

describe("requireTradeSkillGate", () => {
  it("allows Cartography 2 to craft a Shovel and denies rank 1 or none", async () => {
    await expect(requireTradeSkillGate(withRank(2), "p", "artisan_shovel", (m) => new Error(m))).resolves.toBe(2);
    await expect(requireTradeSkillGate(withRank(1), "p", "artisan_shovel", (m) => new Error(m))).rejects.toThrow("Needs Cartography rank 2 to craft a Shovel.");
    await expect(requireTradeSkillGate(withRank(null), "p", "artisan_compass", (m) => new Error(m))).rejects.toThrow("Cartography rank 1");
  });

  it("gates repair on Blacksmithing 1 and Field Traps on Blacksmithing 3", async () => {
    await expect(requireTradeSkillGate(withRank(1), "p", "repair_gear", (m) => new Error(m))).resolves.toBe(1);
    await expect(requireTradeSkillGate(withRank(0), "p", "repair_gear", (m) => new Error(m))).rejects.toThrow("Blacksmithing rank 1");
    await expect(requireTradeSkillGate(withRank(2), "p", "craft_field_trap", (m) => new Error(m))).rejects.toThrow("Blacksmithing rank 3");
    await expect(requireTradeSkillGate(withRank(3), "p", "craft_field_trap", (m) => new Error(m))).resolves.toBe(3);
  });
});
