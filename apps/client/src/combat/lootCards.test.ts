import { describe, expect, it } from "vitest";

import {
  chestLootCard, giftLootCard, killLootCard, LootCardState, LOOT_CARD_BOSS_VISIBLE_MS,
  LOOT_CARD_MAX, LOOT_CARD_VISIBLE_MS, type LootItemLookup
} from "./lootCards.js";

const lookup: LootItemLookup = (itemId) => ({
  name: itemId,
  rarity: itemId === "raptor_scale" ? "epic" : itemId === "coal" ? "uncommon" : "common"
});

describe("loot cards", () => {
  it("lists gold, then items by rarity, then ground drops, merging duplicates", () => {
    const card = killLootCard({
      settlementKey: "s1", gold: 12, mobName: "Raptor Runt",
      items: [{ itemId: "wood", quantity: 1 }, { itemId: "coal", quantity: 1 }, { itemId: "wood", quantity: 2 }],
      drops: [{ itemId: "raptor_scale", quantity: 1 }]
    }, lookup, 100)!;
    expect(card.heading).toBe("Raptor Runt");
    expect(card.boss).toBe(false);
    expect(card.expiresAtMs).toBe(100 + LOOT_CARD_VISIBLE_MS);
    expect(card.entries.map((e) => [e.kind, e.name, e.quantity, e.rarity])).toEqual([
      ["gold", "Gold", 12, "common"], ["item", "coal", 1, "uncommon"], ["item", "wood", 3, "common"],
      ["ground", "raptor_scale", 1, "epic"]
    ]);
  });

  it("gives bosses a bigger, longer reveal and skips XP-only kills", () => {
    const boss = killLootCard({ settlementKey: "b", gold: 0, boss: true, mobName: "Raptor Chieftain",
      items: [{ itemId: "raptor_scale", quantity: 1 }], drops: [] }, lookup, 0)!;
    expect(boss).toMatchObject({ boss: true, eyebrow: "Boss defeated", expiresAtMs: LOOT_CARD_BOSS_VISIBLE_MS });
    expect(killLootCard({ settlementKey: "x", gold: 0, items: [], drops: [] }, lookup, 0)).toBeNull();
  });

  it("builds chest cards only for applied, non-empty claims", () => {
    const frame = { runId: "r", rewardSourceId: "t:reward:0", items: [{ itemId: "coal", quantity: 3 }], gold: 25 };
    expect(chestLootCard({ ...frame, applied: true }, lookup, 0)!.id).toBe("chest:r:t:reward:0");
    expect(chestLootCard({ ...frame, applied: false }, lookup, 0)).toBeNull();
    expect(chestLootCard({ ...frame, items: [], gold: 0, applied: true }, lookup, 0)).toBeNull();
  });

  it("dedupes replayed frames, caps the stack and expires cards", () => {
    const state = new LootCardState();
    const make = (key: string, at: number) => killLootCard({ settlementKey: key, gold: 1, items: [], drops: [] }, lookup, at)!;
    expect(state.push(make("a", 0))).toBe(true);
    expect(state.push(make("a", 0))).toBe(false);
    for (const key of ["b", "c", "d"]) state.push(make(key, 10));
    expect(state.active(11).map((c) => c.id)).toEqual(["kill:b", "kill:c", "kill:d"].slice(-LOOT_CARD_MAX));
    expect(state.active(10 + LOOT_CARD_VISIBLE_MS)).toEqual([]);
  });
});

describe("giftLootCard", () => {
  it("shows only what was granted, gold included", () => {
    const card = giftLootCard({
      package: { packageId: "p1" },
      lines: [
        { itemKind: "resource", itemId: "coal", grantedQuantity: 3 },
        { itemKind: "resource", itemId: "wood", grantedQuantity: 0 },
        { itemKind: "gold", itemId: "gold", grantedQuantity: 50 }
      ]
    }, lookup, 0);
    expect(card?.id).toBe("gift:p1");
    expect(card?.entries.map((entry) => [entry.kind, entry.itemId, entry.quantity])).toEqual([["gold", null, 50], ["item", "coal", 3]]);
  });
  it("shows nothing when nothing was granted", () => {
    expect(giftLootCard({ package: { packageId: "p2" }, lines: [{ itemKind: "resource", itemId: "coal", grantedQuantity: 0 }] }, lookup, 0)).toBeNull();
  });
});
