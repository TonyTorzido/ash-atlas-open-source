// @vitest-environment jsdom

import type { GoblinMarketSnapshot } from "@ash-atlas/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GoblinMarketPanel } from "./GoblinMarketPanel.js";

describe("GoblinMarketPanel", () => {
  afterEach(cleanup);

  it("uses concise player-facing resource and confirmation copy", () => {
    render(<GoblinMarketPanel
      open
      snapshot={snapshot([{
        kind: "resource",
        identity: "stack-wood",
        displayName: "Wood",
        quantity: 7,
        offerGold: "7"
      }])}
      busy={false}
      layout="desktop"
      onSell={vi.fn()}
      onBuy={vi.fn()}
      onClose={vi.fn()}
    />);

    expect(screen.getByRole("heading", { name: "Goblin Market" })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /Sell/ }));
    expect(screen.getByText("Stack ×7")).toBeTruthy();
    expect(screen.getByText("7 Gold")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sell Stack" })).toBeTruthy();
    expect(screen.queryByText(/server/i)).toBeNull();
    expect(screen.queryByText(/carried goods/i)).toBeNull();
    expect(screen.queryByText(/offers exactly/i)).toBeNull();
    expect(screen.queryByText(/sell entire/i)).toBeNull();
    expect(screen.queryByText(/removes the entire/i)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Sell Stack" }));
    expect(screen.getByRole("heading", { name: "Sell Wood?" })).toBeTruthy();
    expect(screen.getByText("Stack ×7 · 7 Gold")).toBeTruthy();
  });

  it("shows the concise empty state", () => {
    render(<GoblinMarketPanel
      open
      snapshot={snapshot([])}
      busy={false}
      layout="desktop"
      onSell={vi.fn()}
      onBuy={vi.fn()}
      onClose={vi.fn()}
    />);

    fireEvent.click(screen.getByRole("tab", { name: /Sell/ }));
    expect(screen.getByText("Nothing to sell.")).toBeTruthy();
  });

  it("offers wheat seeds at the fixed Goblin price", () => {
    const onBuy = vi.fn();
    render(<GoblinMarketPanel
      open
      snapshot={{
        ...snapshot([]),
        buyLines: [{
          kind: "resource",
          itemId: "wheat_seed",
          identity: "wheat_seed",
          displayName: "Wheat Seed",
          quantity: 250,
          unitPriceGold: "10"
        }]
      }}
      busy={false}
      layout="desktop"
      onSell={vi.fn()}
      onBuy={onBuy}
      onClose={vi.fn()}
    />);

    expect(screen.getByText("Stock ×250")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Buy 1" }));
    expect(screen.getByRole("heading", { name: "Buy Wheat Seed?" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Buy" }));
    expect(onBuy).toHaveBeenCalledWith(expect.objectContaining({ itemId: "wheat_seed", unitPriceGold: "10" }));
  });
});

function snapshot(lines: GoblinMarketSnapshot["lines"]): GoblinMarketSnapshot {
  return {
    cityId: "goblin-city",
    cityName: "Goblin Village",
    marketStructureId: "goblin-market",
    relation: "neutral",
    lines,
    buyLines: []
  };
}
