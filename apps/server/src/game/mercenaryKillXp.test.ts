import { describe, expect, it } from "vitest";

import { grantMercenaryKillXp, mercenaryKillXp } from "./mercenaryKillXp.js";

describe("Mercenary PvP kill XP", () => {
  it("scales by rank coefficient, level (capped at 33) and Momentum stacks", () => {
    expect(mercenaryKillXp(1, 20, 1)).toBe(40);
    expect(mercenaryKillXp(2, 20, 2)).toBe(120);
    expect(mercenaryKillXp(3, 40, 2)).toBe(264);
    expect(mercenaryKillXp(5, 30, 5)).toBe(600);
    expect(mercenaryKillXp(1, 20, 0)).toBe(0);
  });

  it("pays once per death and nothing on a replay", async () => {
    const seen = new Map<string, number>();
    const progression = {
      grantXp: async (input: { operationKey: string; requestedXp: number }) => {
        const replayed = seen.has(input.operationKey);
        if (!replayed) seen.set(input.operationKey, input.requestedXp);
        return { replayed, grantedXp: replayed ? 0 : input.requestedXp };
      }
    };
    const input = { deathOperationKey: "player-death:d1", killerPlayerId: "k", victimPlayerId: "v", rank: 2, killerLevel: 25, stacks: 2 };
    const first = await grantMercenaryKillXp(progression as never, input);
    const again = await grantMercenaryKillXp(progression as never, input);
    expect(first).toMatchObject({ grantedXp: 150 });
    expect(again).toBeNull();
    expect([...seen.keys()]).toEqual(["mercenary-kill-xp:player-death:d1"]);
  });
});
