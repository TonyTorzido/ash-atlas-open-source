// @vitest-environment jsdom

import type { MarketControlSnapshot, MarketOrderSnapshot, MarketPlayerSnapshot } from "@ash-atlas/shared";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { itemArtworkSource } from "../ItemArtwork.js";
import { MarketCollectionView, MarketOrdersView } from "./MarketAccountViews.js";

afterEach(cleanup);

describe("Market account artwork", () => {
  it("preserves amethyst variants in active orders, history, fills, and collection", () => {
    const expected = itemArtworkSource("enchantment_stone", null, "amethyst");
    const player = marketPlayer();

    const active = render(<MarketOrdersView player={player} controls={controls} connected pending={false} onCancel={vi.fn(() => true)} />);
    expect(screen.getByAltText("Amethyst Enchantment Stone").getAttribute("src")).toBe(expected);
    active.unmount();

    const history = render(<MarketOrdersView player={player} controls={controls} connected pending={false} view="history" onCancel={vi.fn(() => true)} />);
    for (const artwork of screen.getAllByAltText("Amethyst Enchantment Stone")) {
      expect(artwork.getAttribute("src")).toBe(expected);
    }
    history.unmount();

    render(<MarketCollectionView player={player} controls={controls} connected pending={false} onClaim={vi.fn(() => true)} />);
    expect(screen.getByAltText("Amethyst Enchantment Stone").getAttribute("src")).toBe(expected);
  });
});

const controls: MarketControlSnapshot = {
  accessAllowed: true,
  readOnly: false,
  newOrdersEnabled: true,
  matchingEnabled: true,
  cancellationsEnabled: true,
  claimsEnabled: true,
  venueFrozen: false,
  playerFrozen: false,
  message: null
};

function order(orderId: string, status: MarketOrderSnapshot["status"]): MarketOrderSnapshot {
  return {
    orderId,
    itemId: "enchantment_stone",
    itemIdentity: "enchantment_stone:amethyst",
    variant: "amethyst",
    displayName: "Amethyst Enchantment Stone",
    side: "sell",
    policy: "gtc",
    unitPrice: "12",
    originalQuantity: "2",
    filledQuantity: status === "filled" ? "2" : "0",
    remainingQuantity: status === "filled" ? "0" : "2",
    status,
    prioritySequence: "1",
    createdAt: "2026-09-01T12:00:00.000Z",
    cancelledAt: null,
    completedAt: status === "filled" ? "2026-09-01T12:05:00.000Z" : null
  };
}

function marketPlayer(): MarketPlayerSnapshot {
  return {
    walletGold: "100",
    walletVersion: "1",
    activeOrders: [order("active", "open")],
    recentOrders: [order("recent", "filled")],
    recentFills: [{
      tradeId: "trade",
      orderId: "recent",
      side: "sell",
      itemId: "enchantment_stone",
      itemIdentity: "enchantment_stone:amethyst",
      variant: "amethyst",
      displayName: "Amethyst Enchantment Stone",
      quantity: "2",
      unitPrice: "12",
      total: "24",
      createdAt: "2026-09-01T12:05:00.000Z"
    }],
    collection: {
      items: [{
        itemId: "enchantment_stone",
        itemIdentity: "enchantment_stone:amethyst",
        variant: "amethyst",
        displayName: "Amethyst Enchantment Stone",
        quantity: "1"
      }],
      equipment: [],
      gold: "0"
    }
  };
}
