// @vitest-environment jsdom
import { emptyInventoryTotals } from "@ash-atlas/shared";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useMarketFeature } from "./useMarketFeature.js";

afterEach(cleanup);

describe("useMarketFeature", () => {
  it("installs the authoritative inventory carried by every mutation result", () => {
    const receiveInventorySnapshot = vi.fn();
    const inventory = {
      playerId: "player-1",
      revision: 0,
      items: [],
      totals: emptyInventoryTotals(),
      unlockedSlots: 16
    };
    const { result } = renderHook(() => useMarketFeature({
      getClient: () => null,
      receiveInventorySnapshot
    }));

    act(() => result.current.handleServerMessage({
      type: "MARKET_MUTATION_RESULT",
      requestId: "request-1",
      result: {
        action: "claim",
        requestId: "request-1",
        replayed: false,
        order: null,
        trades: [],
        claimedItems: "0",
        claimedGold: "1",
        claimedEquipment: 0,
        equipmentListing: null,
        player: {
          walletGold: "0",
          walletVersion: "0",
          activeOrders: [],
          recentOrders: [],
          recentFills: [],
          collection: { items: [], equipment: [], gold: "0" }
        }
      },
      inventory
    }));

    expect(receiveInventorySnapshot).toHaveBeenCalledOnce();
    expect(receiveInventorySnapshot).toHaveBeenCalledWith(inventory);
  });

  it("preserves controller binding across lifecycle callbacks", () => {
    const { result } = renderHook(() => useMarketFeature({
      getClient: () => null,
      receiveInventorySnapshot: vi.fn()
    }));

    act(() => result.current.onReady());
    expect(result.current.view.connected).toBe(true);

    act(() => result.current.onDisconnected());
    expect(result.current.view.connected).toBe(false);
    expect(result.current.view.pendingMutation).toBeNull();
  });
});
