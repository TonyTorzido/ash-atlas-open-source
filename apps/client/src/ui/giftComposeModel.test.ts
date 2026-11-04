import type { PlayerGiftStatus } from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import { canAffordGiftBox, giftSendBlockedReason } from "./giftComposeModel.js";

const status: PlayerGiftStatus = {
  giftBoxPriceGold: "250", giftBoxesOwned: 1, sentToday: 0, maxSentPerDay: 10,
  maxPerRecipientPerDay: 3, minSenderLevel: 5, senderLevel: 9, levelOk: true,
  settledOk: true, heldCount: 0, maxHeld: 5, maxLines: 8
};

describe("gift compose rules", () => {
  it("explains each blocker in order and allows a valid gift", () => {
    expect(giftSendBlockedReason(null, 1, 1)).toMatch(/Checking/);
    expect(giftSendBlockedReason({ ...status, levelOk: false }, 1, 1)).toBe("Reach level 5 to send gifts.");
    expect(giftSendBlockedReason({ ...status, settledOk: false }, 1, 1)).toMatch(/not settled/);
    expect(giftSendBlockedReason({ ...status, sentToday: 10 }, 1, 1)).toMatch(/limit/);
    expect(giftSendBlockedReason(status, 0, 1)).toMatch(/Gift Box/);
    expect(giftSendBlockedReason(status, 1, 0)).toBe("");
    expect(giftSendBlockedReason(status, 1, 9)).toMatch(/at most 8/);
    expect(giftSendBlockedReason(status, 1, 8)).toBeNull();
  });

  it("buying needs enough gold", () => {
    expect(canAffordGiftBox("249", "250")).toBe(false);
    expect(canAffordGiftBox("250", "250")).toBe(true);
    expect(canAffordGiftBox(null, "250")).toBe(false);
  });
});
