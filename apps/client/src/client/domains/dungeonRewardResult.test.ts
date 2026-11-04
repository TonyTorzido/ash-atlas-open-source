import { emptyInventoryTotals, type DungeonServerMessage } from "@ash-atlas/shared";
import { describe, expect, it, vi } from "vitest";

import { LOOT_CARD_VISIBLE_MS, type LootItemLookup } from "../../combat/lootCards.js";
import { applyDungeonRewardResult } from "./dungeonRewardResult.js";

const itemLookup: LootItemLookup = (itemId) => ({
  name: itemId.toUpperCase(),
  rarity: itemId === "coal" ? "uncommon" : "common"
});

describe("applyDungeonRewardResult", () => {
  it("installs authoritative state and reveals the haul as one chest card", () => {
    const frame = rewardFrame(true, "Dungeon reward granted.", [
      { itemId: "wood", quantity: 2 },
      { itemId: "coal", quantity: 1 }
    ], 25);
    const receiveInventory = vi.fn();
    const receiveWallet = vi.fn();
    const presentLootCard = vi.fn();

    applyDungeonRewardResult(frame, { receiveInventory, receiveWallet, presentLootCard, itemLookup, nowMs: 1_000 });

    expect(receiveInventory).toHaveBeenCalledWith(frame.inventory);
    expect(receiveWallet).toHaveBeenCalledWith(frame.wallet);
    expect(presentLootCard).toHaveBeenCalledOnce();
    const card = presentLootCard.mock.calls[0]![0];
    expect(card).toMatchObject({
      id: `chest:${frame.runId}:${frame.rewardSourceId}`,
      source: "chest",
      heading: "Chest opened",
      createdAtMs: 1_000,
      expiresAtMs: 1_000 + LOOT_CARD_VISIBLE_MS
    });
    // Gold first, then items by rarity.
    expect(card.entries.map((entry: { kind: string; name: string; quantity: number }) =>
      [entry.kind, entry.name, entry.quantity])).toEqual([
      ["gold", "Gold", 25], ["item", "COAL", 1], ["item", "WOOD", 2]
    ]);
  });

  it("shows no card for an idempotent replay or an empty claim (the dungeon notice already says why)", () => {
    const presentLootCard = vi.fn();
    applyDungeonRewardResult(
      rewardFrame(false, "This dungeon reward was already claimed for this run.", [{ itemId: "wood", quantity: 2 }], 25),
      { receiveInventory: vi.fn(), receiveWallet: vi.fn(), presentLootCard, itemLookup, nowMs: 0 }
    );
    applyDungeonRewardResult(rewardFrame(true, "Dungeon reward granted.", [], 0), {
      receiveInventory: vi.fn(), receiveWallet: vi.fn(), presentLootCard, itemLookup, nowMs: 0
    });
    expect(presentLootCard).not.toHaveBeenCalled();
  });
});

function rewardFrame(
  applied: boolean,
  message: string,
  items: Array<{ itemId: string; quantity: number }>,
  gold: number
): Extract<DungeonServerMessage, { type: "DUNGEON_REWARD_GRANTED" }> {
  return {
    type: "DUNGEON_REWARD_GRANTED",
    requestId: "request-1",
    runId: "11111111-1111-4111-8111-111111111111",
    rewardSourceId: "orc-chest",
    rewardTableId: "basic_dungeon_chest",
    applied,
    inventory: {
      playerId: "player-1",
      totals: { ...emptyInventoryTotals(), wood: 2 },
      items: [],
      revision: 2
    },
    wallet: { playerId: "player-1", gold: "25", revision: "3" },
    items,
    gold,
    message
  };
}
