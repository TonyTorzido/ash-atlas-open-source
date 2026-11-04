// @vitest-environment jsdom

import {
  emptyInventoryTotals,
  type MarketBookSnapshot,
  type MarketQuote,
  type PlayerInventorySnapshot
} from "@ash-atlas/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StandardMarketBrowseView, StandardMarketSellView } from "./MarketTradingViews.js";

afterEach(cleanup);

describe("StandardMarketBrowseView", () => {
  it("resets quick-trade state when the exact item identity changes", () => {
    const props = tradingProps();
    const view = render(
      <StandardMarketBrowseView {...props} book={gemBook("ruby", "8")} />
    );
    fireEvent.change(screen.getByLabelText("Trade quantity"), {
      target: { value: "3" }
    });
    expect((screen.getByLabelText("Trade quantity") as HTMLInputElement).value).toBe("3");

    view.rerender(
      <StandardMarketBrowseView {...props} book={gemBook("emerald", "9")} />
    );

    expect((screen.getByLabelText("Trade quantity") as HTMLInputElement).value).toBe("1");
    expect(screen.getByRole("heading", { level: 2, name: "Emerald Enchantment Stone" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Buy at 9 gold/ }).getAttribute("aria-pressed"))
      .toBe("true");
  });

  it("lets the quantity box be cleared and retyped, clamping on blur", () => {
    render(<StandardMarketBrowseView {...tradingProps()} book={gemBook("ruby", "8")} />);
    const input = screen.getByLabelText("Trade quantity") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "" } });
    expect(input.value).toBe("");
    fireEvent.change(input, { target: { value: "58" } });
    expect(input.value).toBe("58");
    fireEvent.blur(input);
    expect(input.value).toBe("5");
  });

  it("asks for confirmation before buying", () => {
    const onConfirmBuy = vi.fn(() => true);
    const book = gemBook("ruby", "8");
    render(<StandardMarketBrowseView
      {...tradingProps()}
      book={book}
      quote={rubyQuote()}
      quoteQuantity="1"
      quoteMaximumUnitPrice="8"
      onConfirmBuy={onConfirmBuy}
    />);

    fireEvent.click(screen.getByRole("button", { name: "Buy 1 for 9 gold" }));
    expect(onConfirmBuy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: "Buy 1 for 9 gold" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm · 9 gold" }));
    expect(onConfirmBuy).toHaveBeenCalledOnce();
  });
});

describe("Glimmer price currency", () => {
  it("lists in Glimmer from the Sell toggle and shows the proceeds in Glimmer", () => {
    const onCreateOrder = vi.fn(() => true);
    const onPriceCurrency = vi.fn();
    const book = { ...gemBook("ruby", "8"), item: { ...gemBook("ruby", "8").item, priceCurrency: "glimmer" as const } };
    render(<StandardMarketSellView
      {...tradingProps()}
      book={book}
      priceCurrency="glimmer"
      onPriceCurrency={onPriceCurrency}
      inventory={inventoryWith("enchantment_stone", "ruby", 4)}
      activeOrders={[]}
      onCancelOrder={vi.fn(() => true)}
      onCreateOrder={onCreateOrder}
    />);
    const toggle = screen.getByRole("group", { name: "Price currency" });
    expect(toggle.querySelector("[aria-pressed='true']")?.textContent).toBe("Glimmer");
    fireEvent.click(screen.getByRole("button", { name: "Gold" }));
    expect(onPriceCurrency).toHaveBeenCalledWith("gold");
    fireEvent.change(screen.getByLabelText("Price each"), { target: { value: "3" } });
    fireEvent.change(screen.getByLabelText("Quantity"), { target: { value: "2" } });
    expect(screen.getByText("6 Glimmer")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Review listing" }));
    fireEvent.click(screen.getByRole("button", { name: "Post listing" }));
    expect(onCreateOrder).toHaveBeenCalledWith("merchant", "sell", "enchantment_stone:ruby", "2", "3", "glimmer");
  });

  it("shows the Glimmer book above For sale and checks the Glimmer balance", () => {
    const book = { ...gemBook("ruby", "8"), item: { ...gemBook("ruby", "8").item, priceCurrency: "glimmer" as const } };
    render(<StandardMarketBrowseView
      {...tradingProps()}
      book={book}
      priceCurrency="glimmer"
      glimmerBalance="4"
      onPriceCurrency={vi.fn()}
      quote={{ ...rubyQuote(), priceCurrency: "glimmer" }}
      quoteQuantity="1"
      quoteMaximumUnitPrice="8"
    />);
    expect(screen.getByRole("group", { name: "Price currency" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Buy at 8 Glimmer/ })).toBeTruthy();
    expect(screen.getByText("You need 5 Glimmer more.")).toBeTruthy();
  });
});

describe("StandardMarketSellView", () => {
  it("fills Price each from a buyer offer and preserves the merchant sell mutation boundary", () => {
    const onCreateOrder = vi.fn(() => true);
    const book = gemBook("ruby", "8");
    book.bids = [{ unitPrice: "7", quantity: "3", orderCount: 1 }];
    render(<StandardMarketSellView
      {...tradingProps()}
      book={book}
      inventory={inventoryWith("enchantment_stone", "ruby", 4)}
      activeOrders={[]}
      onCancelOrder={vi.fn(() => true)}
      onCreateOrder={onCreateOrder}
    />);

    expect(screen.queryByText("Custom limit order")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Sellers" })).toBeNull();
    expect(screen.queryByText("Recent trades")).toBeNull();
    expect(screen.queryByText(/escrow/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Use buyer price 7 gold" }));
    expect((screen.getByLabelText("Price each") as HTMLInputElement).value).toBe("7");
    fireEvent.change(screen.getByLabelText("Quantity"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Review listing" }));
    fireEvent.click(screen.getByRole("button", { name: "Post listing" }));

    expect(onCreateOrder).toHaveBeenCalledWith(
      "merchant",
      "sell",
      "enchantment_stone:ruby",
      "2",
      "7",
      "gold"
    );
    expect(screen.getByText("You receive")).toBeTruthy();
    expect(screen.queryByText("Fees")).toBeNull();
  });
});

function tradingProps() {
  return {
    bookLoading: false,
    bookError: null,
    bookReady: true,
    connected: true,
    controls: {
      accessAllowed: true,
      readOnly: false,
      newOrdersEnabled: true,
      matchingEnabled: true,
      cancellationsEnabled: true,
      claimsEnabled: true,
      venueFrozen: false,
      playerFrozen: false,
      message: null
    },
    feePolicy: {
      version: 1,
      listingFee: "0" as const,
      buyerFeeBps: 0,
      sellerFeeBps: 0,
      cancellationFee: "0" as const
    },
    walletGold: "100" as const,
    inventory: emptyInventory(),
    hasInventorySnapshot: true,
    pending: false,
    onRetryBook: vi.fn(),
    quote: null,
    quoteQuantity: null,
    quoteMaximumUnitPrice: null,
    quoteLoading: false,
    quoteError: null,
    onInvalidateQuote: vi.fn(),
    onRequestQuote: vi.fn(() => true),
    onConfirmBuy: vi.fn(() => true),
    onCreateOrder: vi.fn(() => true)
  };
}

function gemBook(variant: "ruby" | "emerald", price: string): MarketBookSnapshot {
  const displayName = `${variant[0]!.toUpperCase()}${variant.slice(1)} Enchantment Stone`;
  return {
    item: {
      itemId: "enchantment_stone",
      itemIdentity: `enchantment_stone:${variant}`,
      variant,
      displayName,
      iconKey: "enchantment_stone",
      category: "resource",
      bestAsk: price,
      bestBid: null,
      availableSellQuantity: "5",
      availableBuyQuantity: "0",
      lastTradePrice: null,
      bookVersion: "1"
    },
    asks: [{ unitPrice: price, quantity: "5", orderCount: 1 }],
    bids: [],
    recentTrades: []
  };
}

function rubyQuote(): MarketQuote {
  return {
    quoteId: "quote-1",
    itemId: "enchantment_stone",
    itemIdentity: "enchantment_stone:ruby",
    variant: "ruby",
    requestedQuantity: "1",
    requestedMaximumUnitPrice: "8",
    fillableQuantity: "1",
    quotedTotal: "9",
    grossItemTotal: "8",
    buyerTax: "1",
    buyerTotal: "9",
    appliedBuyerTaxBps: 900,
    taxLabel: "Tax",
    districtType: null,
    taxRevision: "1",
    specialtyTaxApplied: false,
    qualifyingTaxTag: null,
    maximumUnitPrice: "8",
    fullQuantityAvailable: true,
    availability: "available",
    bookVersion: "1",
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  } as MarketQuote;
}

function emptyInventory(): PlayerInventorySnapshot {
  return {
    playerId: "market-trading-test",
    revision: 1,
    items: [],
    totals: emptyInventoryTotals()
  };
}

function inventoryWith(
  itemId: PlayerInventorySnapshot["items"][number]["resourceType"],
  variant: string | null,
  quantity: number
): PlayerInventorySnapshot {
  return {
    ...emptyInventory(),
    items: [{ playerId: "market-trading-test", resourceType: itemId, variant, quantity }]
  };
}
