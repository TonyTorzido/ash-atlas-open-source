import { describe, expect, it } from "vitest";

import { emptyInventoryTotals } from "./collectibles.js";
import { parseServerMessage } from "./protocol.js";

describe("dropped item pickup result protocol", () => {
  it("carries explicit requested, received, remaining, item, and inventory authority", () => {
    const message = pickupResult();
    expect(parseServerMessage(JSON.stringify(message))).toEqual(message);
  });

  it("rejects a pickup result that omits its requested quantity", () => {
    const { requestedQuantity, ...missingRequestedQuantity } = pickupResult();
    expect(requestedQuantity).toBe(25);
    expect(() =>
      parseServerMessage(JSON.stringify(missingRequestedQuantity))
    ).toThrow();
  });
});

function pickupResult() {
  return {
    type: "DROPPED_ITEM_PICKUP_RESULT",
    requestId: "pickup-25",
    itemId: "leather",
    requestedQuantity: 25,
    pickedUpQuantity: 25,
    remainingQuantity: 58,
    removed: false,
    drop: {
      dropId: "11111111-1111-4111-8111-111111111111",
      droppedBy: "player-2",
      regionCode: "NM",
      itemId: "leather",
      variant: null,
      quantity: 58,
      status: "active",
      lat: 35,
      lon: -106,
      createdAt: "2026-07-25T00:00:00.000Z",
      expiresAt: "2026-07-25T00:10:00.000Z",
      pickedUpBy: null,
      pickedUpAt: null
    },
    inventory: {
      playerId: "player-1",
      revision: 1,
      items: [],
      totals: emptyInventoryTotals(),
      unlockedSlots: 16
    },
    replayed: false,
    serverTime: 1_000,
    message: "Picked up Leather x25."
  } as const;
}
