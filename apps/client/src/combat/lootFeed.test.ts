import { describe, expect, it } from "vitest";

import type { DamageFloater } from "./damageFloaters.js";
import { buildLootFeedRows, lootFeedRowPresentation, LOOT_FEED_MAX_ROWS } from "./lootFeed.js";

function floater(partial: Partial<DamageFloater> & Pick<DamageFloater, "eventId" | "kind" | "amount">, at = 0): DamageFloater {
  return {
    targetEntityId: "player-1", createdAtMs: at, expiresAtMs: at + 2_200, xOffsetPx: 0,
    startYOffsetPx: 0, risePx: 0, horizontalTravelPx: 0, feedbackLane: 0, ...partial
  };
}
const names = (id: string): string | null => ({ iron_shield: "Iron Shield", coal: "Coal" } as Record<string, string>)[id] ?? null;

describe("loot feed rows", () => {
  it("renders compact rows for items, gold and skill XP", () => {
    const rows = buildLootFeedRows([
      floater({ eventId: "i", kind: "resource", amount: 1, icon: "iron_shield", label: "×1" }),
      floater({ eventId: "g", kind: "gold", amount: 14 }, 10),
      floater({ eventId: "x", kind: "character_xp", amount: 7 }, 20),
      floater({ eventId: "h", kind: "profession_xp", amount: 20, subject: "Hunter", label: "+20 Hunter XP" }, 30)
    ], 40, names);
    expect(rows.map((row) => row.text)).toEqual(["Iron Shield ×1", "+14 Gold", "+7 XP", "+20 Hunter XP"]);
    expect(rows[0]!.icon).toBe("iron_shield");
    expect(rows[1]!.kind).toBe("gold");
  });

  it("merges identical rewards inside the window and counts up, but not across the window", () => {
    const rows = buildLootFeedRows([
      floater({ eventId: "a", kind: "resource", amount: 1, icon: "iron_shield" }, 0),
      floater({ eventId: "b", kind: "resource", amount: 2, icon: "iron_shield" }, 1_000),
      floater({ eventId: "c", kind: "gold", amount: 14 }, 1_100),
      floater({ eventId: "d", kind: "gold", amount: 20 }, 1_200),
      floater({ eventId: "e", kind: "resource", amount: 1, icon: "iron_shield" }, 3_100)
    ], 3_150, names);
    expect(rows.map((row) => row.text)).toEqual(["Iron Shield ×3", "+34 Gold", "Iron Shield ×1"]);
  });

  it("counts identical free-text notices and keeps only the newest rows", () => {
    const merged = buildLootFeedRows([
      floater({ eventId: "n1", kind: "harvesting_notice", amount: 1, label: "CLEAN BREAK" }, 0),
      floater({ eventId: "n2", kind: "harvesting_notice", amount: 1, label: "CLEAN BREAK" }, 500)
    ], 600, names);
    expect(merged.map((row) => row.text)).toEqual(["CLEAN BREAK ×2"]);
    const many = buildLootFeedRows(Array.from({ length: 9 }, (_, index) =>
      floater({ eventId: `r${index}`, kind: "resource", amount: 1, icon: "coal", subject: `Thing ${index}` }, index)), 20, names);
    expect(many).toHaveLength(LOOT_FEED_MAX_ROWS);
    expect(many.at(-1)!.text).toBe("Thing 8 ×1");
  });

  it("ignores action-family floaters and pending rewards, and fades expiring rows", () => {
    expect(buildLootFeedRows([
      floater({ eventId: "d", kind: "damage_dealt", amount: 5 }),
      floater({ eventId: "p", kind: "gold", amount: 5 }, 500)
    ], 100, names)).toEqual([]);
    const row = { createdAtMs: 0, expiresAtMs: 1_000 };
    expect(lootFeedRowPresentation(row, 500, false)).toEqual({ alpha: 1, slidePx: 0 });
    expect(lootFeedRowPresentation(row, 900, false).alpha).toBeLessThan(1);
    expect(lootFeedRowPresentation(row, 0, true).slidePx).toBe(0);
  });
});
