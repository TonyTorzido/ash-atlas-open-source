import {
  emptyInventoryTotals,
  type MarketBookSnapshot,
  type MarketMutationResult,
  type MarketSnapshot,
  type PlayerInventorySnapshot
} from "@ash-atlas/shared";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";

import {
  MarketController,
  marketMutationChangesInventory,
  type MarketClientTransport
} from "./marketController.js";

const activeControllers: MarketController[] = [];

afterEach(() => {
  for (const controller of activeControllers.splice(0)) controller.destroy();
  vi.useRealTimers();
});

describe("MarketController", () => {
  it("keeps the market ready while the initially selected book loads", () => {
    const harness = controllerHarness();
    const openRequestId = open(harness);
    harness.controller.handleMessage({
      type: "MARKET_OPEN_RESULT",
      requestId: openRequestId,
      snapshot: snapshot("Ore")
    });

    expect(harness.controller.getState()).toMatchObject({
      requestState: "ready",
      bookLoading: true,
      bookError: null
    });
    expect(harness.marketGetBook).toHaveBeenCalledOnce();
  });

  it("selects and subscribes to gemstone books by exact market identity", () => {
    const harness = controllerHarness();
    const gemSnapshot = snapshot("Ruby Enchantment Stone");
    gemSnapshot.items = [{
      ...gemSnapshot.items[0]!,
      itemId: "enchantment_stone",
      itemIdentity: "enchantment_stone:ruby",
      variant: "ruby",
      iconKey: "enchantment_stone"
    }];
    const requestId = open(harness);
    harness.controller.handleMessage({
      type: "MARKET_OPEN_RESULT",
      requestId,
      snapshot: gemSnapshot
    });

    expect(lastCall(harness.marketGetBook)[2]).toBe("enchantment_stone:ruby");
    expect(lastCall(harness.marketSetSubscriptions)[2]).toEqual([
      "enchantment_stone:ruby"
    ]);
    expect(lastCall(harness.marketSetSubscriptions)[3]).toBe(
      "enchantment_stone:ruby"
    );
  });

  it("does not map an ambiguous legacy gem item ID to the first variant", () => {
    const harness = controllerHarness();
    const gemSnapshot = snapshot("Ruby Enchantment Stone");
    gemSnapshot.items = ["ruby", "emerald"].map((variant) => ({
      ...gemSnapshot.items[0]!,
      itemId: "enchantment_stone",
      itemIdentity: `enchantment_stone:${variant}`,
      variant,
      displayName: `${variant} Enchantment Stone`,
      iconKey: "enchantment_stone"
    }));
    const requestId = open(harness);
    harness.controller.handleMessage({
      type: "MARKET_OPEN_RESULT",
      requestId,
      snapshot: gemSnapshot
    });

    harness.controller.selectItem("enchantment_stone");

    expect(harness.controller.getState().selectedItemId).toBe("enchantment_stone");
    expect(lastCall(harness.marketSetSubscriptions)[3]).toBe("enchantment_stone");
    expect(lastCall(harness.marketSetSubscriptions)[3]).not.toBe("enchantment_stone:ruby");
    expect(lastCall(harness.marketSetSubscriptions)[3]).not.toBe("enchantment_stone:emerald");
  });

  it("ends quote loading on timeout and exposes a retryable quote failure", () => {
    vi.useFakeTimers();
    const harness = controllerHarness({ quoteTimeoutMs: 9_000 });
    openWithSnapshot(harness);
    expect(harness.controller.requestQuote("ore", "1", "8")).toBe(true);
    vi.advanceTimersByTime(9_000);
    expect(harness.controller.getState()).toMatchObject({
      requestState: "ready",
      quoteLoading: false,
      quote: null,
      quoteError: { code: "MARKET_QUOTE_TIMEOUT", retryable: true }
    });
  });

  it("uses a new request id when retrying a timed-out quote", () => {
    vi.useFakeTimers();
    const harness = controllerHarness({ quoteTimeoutMs: 10 });
    openWithSnapshot(harness);
    harness.controller.requestQuote("ore", "1", "8");
    const first = lastCall(harness.marketRequestQuote)[0];
    vi.advanceTimersByTime(10);
    harness.controller.requestQuote("ore", "1", "8");
    expect(lastCall(harness.marketRequestQuote)[0]).toBe(first);
    vi.advanceTimersByTime(2_190);
    expect(lastCall(harness.marketRequestQuote)[0]).not.toBe(first);
    expect(harness.controller.getState().quoteLoading).toBe(true);
  });

  it("lets a newer quantity and price cap supersede an older quote response", () => {
    vi.useFakeTimers();
    const harness = controllerHarness();
    openWithSnapshot(harness);
    harness.controller.requestQuote("ore", "1", "8");
    const first = lastCall(harness.marketRequestQuote)[0];
    harness.controller.requestQuote("ore", "2", "9");
    expect(harness.marketRequestQuote).toHaveBeenCalledOnce();
    harness.controller.handleMessage({ type: "MARKET_QUOTE_RESULT", requestId: first, quote: {
      ...quote("1"), requestedQuantity: "1", requestedMaximumUnitPrice: "8", quotedTotal: "8"
    } });
    expect(harness.controller.getState().quote).toBeNull();
    expect(harness.controller.getState().quoteLoading).toBe(true);
    vi.advanceTimersByTime(2_200);
    const second = lastCall(harness.marketRequestQuote)[0];
    expect(second).not.toBe(first);
    harness.controller.handleMessage({ type: "MARKET_QUOTE_RESULT", requestId: second, quote: {
      ...quote("1"), requestedMaximumUnitPrice: "9", quotedTotal: "17"
    } });
    expect(harness.controller.getState().quote?.quotedTotal).toBe("17");
  });

  it("ignores a response whose intent does not match its request id", () => {
    const harness = controllerHarness();
    openWithSnapshot(harness);
    harness.controller.requestQuote("ore", "2", "8");
    const requestId = lastCall(harness.marketRequestQuote)[0];
    harness.controller.handleMessage({ type: "MARKET_QUOTE_RESULT", requestId, quote: {
      ...quote("1"), requestedMaximumUnitPrice: "9"
    } });
    expect(harness.controller.getState().quote).toBeNull();
    expect(harness.controller.getState().quoteLoading).toBe(true);
  });

  it("ends quote loading when the server returns an error", () => {
    const harness = controllerHarness();
    openWithSnapshot(harness);
    harness.controller.requestQuote("ore", "2", "8");
    const requestId = lastCall(harness.marketRequestQuote)[0];
    harness.controller.handleMessage({
      type: "MARKET_ERROR", requestId, code: "MARKET_FROZEN", message: "Market frozen", retryable: false
    });
    expect(harness.controller.getState()).toMatchObject({
      requestState: "ready",
      quoteLoading: false,
      quoteError: { code: "MARKET_FROZEN" }
    });
  });

  it("bounds sustained quote intents below the server minute quota", () => {
    vi.useFakeTimers();
    const harness = controllerHarness();
    openWithSnapshot(harness);
    let handledCalls = 0;

    for (let second = 0; second < 60; second += 1) {
      harness.controller.requestQuote("ore", "2", "8");
      if (harness.marketRequestQuote.mock.calls.length > handledCalls) {
        const requestId = harness.marketRequestQuote.mock.calls[handledCalls]![0];
        handledCalls += 1;
        harness.controller.handleMessage({
          type: "MARKET_QUOTE_RESULT",
          requestId,
          quote: quote("1")
        });
      }
      vi.advanceTimersByTime(1_000);
    }

    expect(harness.marketRequestQuote.mock.calls.length).toBeLessThanOrEqual(28);
    expect(harness.marketRequestQuote.mock.calls.length).toBeGreaterThan(20);
    expect(harness.controller.getState().requestState).toBe("ready");
  });

  it("backs off a rate-limited quote while retaining the latest intent", () => {
    vi.useFakeTimers();
    const harness = controllerHarness();
    openWithSnapshot(harness);
    harness.controller.requestQuote("ore", "1", "8");
    const limitedRequestId = lastCall(harness.marketRequestQuote)[0];
    harness.controller.handleMessage({
      type: "MARKET_ERROR",
      requestId: limitedRequestId,
      code: "MARKET_RATE_LIMITED",
      message: "Market request rate limit reached",
      retryable: true
    });
    harness.controller.requestQuote("ore", "2", "9");

    expect(harness.controller.getState()).toMatchObject({
      requestState: "ready",
      quoteLoading: true
    });
    vi.advanceTimersByTime(9_999);
    expect(harness.marketRequestQuote).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1);
    expect(harness.marketRequestQuote).toHaveBeenCalledTimes(2);
    expect(lastCall(harness.marketRequestQuote).slice(2)).toEqual(["ore", "2", "9"]);
  });

  it("does not let a late quote result finish a newer browse refresh", () => {
    const harness = controllerHarness();
    openWithSnapshot(harness);
    harness.controller.requestQuote("ore", "2", "8");
    const quoteRequestId = lastCall(harness.marketRequestQuote)[0];

    harness.controller.refresh();
    expect(harness.controller.getState().requestState).toBe("refreshing");
    harness.controller.handleMessage({
      type: "MARKET_QUOTE_RESULT",
      requestId: quoteRequestId,
      quote: quote("1")
    });

    expect(harness.controller.getState().requestState).toBe("refreshing");
    expect(harness.controller.getState().quote?.quoteId).toBe(quote("1").quoteId);
  });

  it("cancels active quote work before starting a mutation", () => {
    const harness = controllerHarness();
    openWithSnapshot(harness);
    harness.controller.requestQuote("ore", "2", "8");
    const quoteRequestId = lastCall(harness.marketRequestQuote)[0];

    expect(harness.controller.submitCreateOrder("merchant", "buy", "ore", "1", "7")).toBe(true);
    harness.controller.handleMessage({
      type: "MARKET_QUOTE_RESULT",
      requestId: quoteRequestId,
      quote: quote("1")
    });

    expect(harness.controller.getState()).toMatchObject({
      requestState: "creating_listing",
      pendingMutation: { requestId: lastCall(harness.marketCreateOrder)[0] },
      quote: null,
      quoteQuantity: null,
      quoteMaximumUnitPrice: null,
      quoteLoading: false,
      quoteError: null,
      error: null
    });
  });

  it("does not send a queued quote after leaving Browse", () => {
    vi.useFakeTimers();
    const harness = controllerHarness();
    openWithSnapshot(harness);
    harness.controller.requestQuote("ore", "1", "8");
    const firstRequestId = lastCall(harness.marketRequestQuote)[0];
    harness.controller.handleMessage({
      type: "MARKET_QUOTE_RESULT",
      requestId: firstRequestId,
      quote: { ...quote("1"), requestedQuantity: "1", quotedTotal: "8" }
    });
    harness.controller.requestQuote("ore", "2", "9");
    harness.controller.setSection("gear");

    vi.advanceTimersByTime(2_200);
    expect(harness.marketRequestQuote).toHaveBeenCalledOnce();
    expect(harness.controller.getState()).toMatchObject({
      section: "gear",
      quoteLoading: false,
      quote: null
    });
  });

  it("ignores a server error for a locally superseded quote", () => {
    const harness = controllerHarness();
    openWithSnapshot(harness);
    harness.controller.requestQuote("ore", "2", "8");
    const requestId = lastCall(harness.marketRequestQuote)[0];
    harness.controller.invalidateQuote();

    harness.controller.handleMessage({
      type: "MARKET_ERROR",
      requestId,
      code: "MARKET_RATE_LIMITED",
      message: "Market request rate limit reached",
      retryable: true
    });

    expect(harness.controller.getState()).toMatchObject({
      requestState: "ready",
      error: null,
      quoteError: null
    });
  });

  it("supersedes a pending quote when the authoritative book changes", () => {
    vi.useFakeTimers();
    const harness = controllerHarness();
    const openRequestId = open(harness);
    harness.controller.handleMessage({
      type: "MARKET_OPEN_RESULT", requestId: openRequestId, snapshot: snapshot("Ore")
    });
    completeBook(harness);
    harness.controller.requestQuote("ore", "2", "8");
    const quoteRequestId = lastCall(harness.marketRequestQuote)[0];
    harness.controller.handleMessage({ type: "MARKET_BOOK_CHANGED", itemId: "ore", bookVersion: "2" });
    expect(harness.controller.getState()).toMatchObject({
      quoteLoading: false,
      quoteError: { code: "MARKET_PRICE_CHANGED" }
    });
    harness.controller.handleMessage({
      type: "MARKET_QUOTE_RESULT", requestId: quoteRequestId, quote: quote("1")
    });
    expect(harness.controller.getState().quote).toBeNull();
  });

  it("clears pending quote timers on invalidation, close, and disconnect", () => {
    vi.useFakeTimers();
    const harness = controllerHarness({ quoteTimeoutMs: 10 });
    openWithSnapshot(harness);
    harness.controller.requestQuote("ore", "2", "8");
    harness.controller.invalidateQuote();
    vi.advanceTimersByTime(10);
    expect(harness.controller.getState().quoteError).toBeNull();
    harness.controller.requestQuote("ore", "2", "8");
    harness.controller.deactivate();
    vi.advanceTimersByTime(10);
    expect(harness.controller.getState().quoteError).toBeNull();
    harness.controller.activate();
    harness.controller.requestQuote("ore", "2", "8");
    harness.controller.onDisconnected();
    vi.advanceTimersByTime(10);
    expect(harness.controller.getState()).toMatchObject({ quoteLoading: false, connected: false });
  });
  it("debounces searches and ignores a superseded browse response", () => {
    vi.useFakeTimers();
    const harness = controllerHarness();
    const initialRequestId = open(harness);
    harness.controller.handleMessage({
      type: "MARKET_OPEN_RESULT",
      requestId: initialRequestId,
      snapshot: snapshot("Ore")
    });
    completeBook(harness);

    harness.controller.setSearch("wood");
    vi.advanceTimersByTime(200);
    const woodRequestId = lastCall(harness.marketBrowse)[0];
    harness.controller.setSearch("ore");
    vi.advanceTimersByTime(200);
    const oreRequestId = lastCall(harness.marketBrowse)[0];

    harness.controller.handleMessage({
      type: "MARKET_BROWSE_RESULT",
      requestId: woodRequestId,
      snapshot: snapshot("Stale Wood")
    });
    expect(harness.controller.getState().snapshot?.items[0]?.displayName).toBe("Ore");

    harness.controller.handleMessage({
      type: "MARKET_BROWSE_RESULT",
      requestId: oreRequestId,
      snapshot: snapshot("Fresh Ore")
    });
    expect(harness.controller.getState().snapshot?.items[0]?.displayName).toBe("Fresh Ore");
    expect(harness.marketOpen).toHaveBeenCalledOnce();
    expect(harness.marketBrowse).toHaveBeenCalledTimes(2);
  });

  it("browses listed items only, and every item on Sell", () => {
    const harness = controllerHarness();
    openWithSnapshot(harness);
    expect(lastCall(harness.marketOpen)[3]).toEqual({ listedOnly: true });
    harness.marketBrowse.mockClear();

    harness.controller.setSection("gear");
    expect(lastCall(harness.marketBrowse)[2]).not.toHaveProperty("listedOnly");
    harness.controller.setSection("orders");
    harness.controller.setSection("gear");
    expect(harness.marketBrowse).toHaveBeenCalledOnce();

    harness.controller.setSection("browse");
    expect(lastCall(harness.marketBrowse)[2]).toMatchObject({ listedOnly: true });
  });

  it("does not apply optimistic economic truth and gates duplicate submits", () => {
    const harness = controllerHarness();
    const initialRequestId = open(harness);
    harness.controller.handleMessage({
      type: "MARKET_OPEN_RESULT",
      requestId: initialRequestId,
      snapshot: snapshot("Ore")
    });
    completeBook(harness);

    expect(harness.controller.submitCreateOrder("merchant", "buy", "ore", "2", "10")).toBe(true);
    expect(harness.controller.submitCreateOrder("merchant", "buy", "ore", "2", "10")).toBe(false);
    expect(harness.marketCreateOrder).toHaveBeenCalledOnce();
    expect(harness.controller.getState().snapshot?.player.walletGold).toBe("100");
    expect(harness.controller.getState().pendingMutation?.label).toBe("Placing buy order");

    const mutationRequestId = harness.marketCreateOrder.mock.calls[0]?.[0];
    expect(mutationRequestId).toBeTruthy();
    harness.controller.handleMessage({
      type: "MARKET_MUTATION_RESULT",
      requestId: mutationRequestId!,
      result: mutationResult(mutationRequestId!, "80"),
      inventory: inventorySnapshot()
    });

    expect(harness.controller.getState().snapshot?.player.walletGold).toBe("80");
    expect(harness.controller.getState().pendingMutation).toBeNull();
    expect(harness.controller.getState().notice).toContain("Order confirmed");
  });

  it("retries a retryable failure with the exact same request id", () => {
    const harness = controllerHarness();
    const initialRequestId = open(harness);
    harness.controller.handleMessage({ type: "MARKET_OPEN_RESULT", requestId: initialRequestId, snapshot: snapshot("Ore") });
    completeBook(harness);
    harness.controller.submitCreateOrder("simple", "sell", "ore", "3", "9");
    const requestId = harness.marketCreateOrder.mock.calls[0]?.[0];
    expect(requestId).toBeTruthy();

    harness.controller.handleMessage({
      type: "MARKET_ERROR",
      requestId: requestId!,
      code: "MARKET_BUSY",
      message: "busy",
      retryable: true
    });
    expect(harness.controller.getState().pendingMutation).toBeNull();
    expect(harness.controller.getState().error?.retryable).toBe(true);

    expect(harness.controller.retryLastMutation()).toBe(true);
    expect(harness.marketCreateOrder).toHaveBeenCalledTimes(2);
    expect(harness.marketCreateOrder.mock.calls[1]?.[0]).toBe(requestId);
  });

  it("never automatically replays an unresolved mutation after reconnect or a fresh snapshot", () => {
    vi.useFakeTimers();
    const harness = controllerHarness();
    const initialRequestId = open(harness);
    harness.controller.handleMessage({ type: "MARKET_OPEN_RESULT", requestId: initialRequestId, snapshot: snapshot("Ore") });
    completeBook(harness);
    harness.controller.submitCreateOrder("simple", "sell", "ore", "1", "7");
    const requestId = harness.marketCreateOrder.mock.calls[0]?.[0];

    harness.controller.onDisconnected();
    expect(harness.controller.getState().pendingMutation).toBeNull();
    expect(harness.controller.getState().error).toMatchObject({
      requestId,
      code: "MARKET_RESULT_UNCONFIRMED",
      retryable: true
    });
    harness.controller.onReady();
    expect(harness.marketCreateOrder).toHaveBeenCalledTimes(1);
    expect(harness.controller.getState().snapshotFresh).toBe(false);

    const reconnectOpenRequestId = lastCall(harness.marketOpen)[0];
    harness.controller.handleMessage({
      type: "MARKET_OPEN_RESULT",
      requestId: reconnectOpenRequestId,
      snapshot: snapshot("Ore")
    });
    completeBook(harness);
    expect(harness.marketCreateOrder).toHaveBeenCalledTimes(1);

    expect(harness.controller.retryLastMutation()).toBe(true);
    expect(harness.marketCreateOrder).toHaveBeenCalledTimes(2);
    expect(harness.marketCreateOrder.mock.calls[1]?.[0]).toBe(requestId);

    harness.controller.deactivate();
    const subscription = lastCall(harness.marketSetSubscriptions);
    expect(subscription[1]).toBe(snapshot("Ore").sessionId);
    expect(subscription[2]).toEqual([]);
    expect(subscription[3]).toBeNull();
    expect(subscription[4]).toBe(false);
  });

  it("ignores mismatched and stale duplicate mutation results without disrupting a newer request", () => {
    vi.useFakeTimers();
    const harness = controllerHarness();
    const initialRequestId = open(harness);
    harness.controller.handleMessage({ type: "MARKET_OPEN_RESULT", requestId: initialRequestId, snapshot: snapshot("Ore") });
    completeBook(harness);

    harness.controller.submitCreateOrder("merchant", "buy", "ore", "2", "10");
    const firstRequestId = lastCall(harness.marketCreateOrder)[0];
    harness.controller.handleMessage({
      type: "MARKET_MUTATION_RESULT",
      requestId: firstRequestId,
      result: mutationResult(firstRequestId, "80"),
      inventory: inventorySnapshot()
    });
    expect(harness.controller.getState().snapshot?.player.walletGold).toBe("80");
    completeBook(harness);

    harness.controller.submitCreateOrder("merchant", "buy", "ore", "1", "5");
    const secondRequestId = lastCall(harness.marketCreateOrder)[0];

    harness.controller.handleMessage({
      type: "MARKET_MUTATION_RESULT",
      requestId: secondRequestId,
      result: mutationResult(firstRequestId, "1"),
      inventory: inventorySnapshot()
    });
    harness.controller.handleMessage({
      type: "MARKET_MUTATION_RESULT",
      requestId: firstRequestId,
      result: mutationResult(firstRequestId, "1"),
      inventory: inventorySnapshot()
    });

    expect(harness.controller.getState().snapshot?.player.walletGold).toBe("80");
    expect(harness.controller.getState().pendingMutation?.requestId).toBe(secondRequestId);

    vi.advanceTimersByTime(4_000);
    expect(harness.marketCreateOrder.mock.calls.filter(([requestId]) => requestId === secondRequestId)).toHaveLength(1);
    vi.advanceTimersByTime(8_000);
    expect(harness.controller.getState().pendingMutation?.requestId).toBe(secondRequestId);
    expect(harness.controller.getState().error).toMatchObject({
      requestId: secondRequestId,
      code: "MARKET_RESULT_UNCONFIRMED",
      retryable: true
    });
  });

  it("clears quotes and blocks new mutations until a reconnect snapshot is current", () => {
    const harness = controllerHarness();
    const initialRequestId = open(harness);
    harness.controller.handleMessage({ type: "MARKET_OPEN_RESULT", requestId: initialRequestId, snapshot: snapshot("Ore") });
    completeBook(harness);
    harness.controller.requestQuote("ore", "2", "8");
    const quoteRequestId = lastCall(harness.marketRequestQuote)[0];
    harness.controller.handleMessage({
      type: "MARKET_QUOTE_RESULT",
      requestId: quoteRequestId,
      quote: quote("1")
    });
    expect(harness.controller.getState().quote).not.toBeNull();

    harness.controller.onDisconnected();
    harness.controller.onReady();
    expect(harness.controller.getState().quote).toBeNull();
    expect(harness.controller.getState().snapshotFresh).toBe(false);
    expect(harness.controller.submitCreateOrder("merchant", "buy", "ore", "1", "5")).toBe(false);

    const reconnectOpenRequestId = lastCall(harness.marketOpen)[0];
    harness.controller.handleMessage({ type: "MARKET_OPEN_RESULT", requestId: reconnectOpenRequestId, snapshot: snapshot("Ore") });
    completeBook(harness);
    expect(harness.controller.getState().snapshotFresh).toBe(true);
    expect(harness.controller.submitCreateOrder("merchant", "buy", "ore", "1", "5")).toBe(true);
  });

  it("requires a fresh snapshot after reopening from an unsubscribed state", () => {
    const harness = controllerHarness();
    const initialRequestId = open(harness);
    harness.controller.handleMessage({ type: "MARKET_OPEN_RESULT", requestId: initialRequestId, snapshot: snapshot("Ore") });
    harness.controller.deactivate();
    harness.controller.activate();

    expect(harness.controller.getState().snapshotFresh).toBe(false);
    expect(harness.controller.submitCreateOrder("merchant", "buy", "ore", "1", "5")).toBe(false);

    const reopenRequestId = lastCall(harness.marketOpen)[0];
    harness.controller.handleMessage({ type: "MARKET_OPEN_RESULT", requestId: reopenRequestId, snapshot: snapshot("Ore") });
    expect(harness.controller.getState().snapshotFresh).toBe(true);
  });

  it("refreshes only the focused book for a newer version notification", () => {
    vi.useFakeTimers();
    const harness = controllerHarness();
    const initialRequestId = open(harness);
    harness.controller.handleMessage({ type: "MARKET_OPEN_RESULT", requestId: initialRequestId, snapshot: snapshot("Ore") });
    const bookRequestId = lastCall(harness.marketGetBook)[0];
    harness.controller.handleMessage({ type: "MARKET_BOOK_RESULT", requestId: bookRequestId, book: book() });
    const callsBefore = harness.marketGetBook.mock.calls.length;

    harness.controller.handleMessage({ type: "MARKET_BOOK_CHANGED", itemId: "ore", bookVersion: "1" });
    vi.advanceTimersByTime(1_000);
    expect(harness.marketGetBook).toHaveBeenCalledTimes(callsBefore);

    harness.controller.handleMessage({ type: "MARKET_BOOK_CHANGED", itemId: "ore", bookVersion: "2" });
    vi.advanceTimersByTime(1_000);
    expect(harness.marketGetBook).toHaveBeenCalledTimes(callsBefore + 1);
  });

  it("keeps summary-only updates from suppressing a focused book refresh and invalidates its quote", () => {
    vi.useFakeTimers();
    const harness = controllerHarness();
    const initialRequestId = open(harness);
    harness.controller.handleMessage({ type: "MARKET_OPEN_RESULT", requestId: initialRequestId, snapshot: snapshot("Ore") });
    const initialBookRequestId = lastCall(harness.marketGetBook)[0];
    harness.controller.handleMessage({ type: "MARKET_BOOK_RESULT", requestId: initialBookRequestId, book: book() });

    harness.controller.requestQuote("ore", "2", "8");
    const quoteRequestId = lastCall(harness.marketRequestQuote)[0];
    harness.controller.handleMessage({
      type: "MARKET_QUOTE_RESULT",
      requestId: quoteRequestId,
      quote: {
        quoteId: "00000000-0000-4000-8000-000000000099",
        itemId: "ore",
        itemIdentity: "ore",
        requestedQuantity: "2",
        requestedMaximumUnitPrice: "8",
        fillableQuantity: "2",
        quotedTotal: "16",
        grossItemTotal: "16",
        buyerTax: "0",
        buyerTotal: "16",
        appliedBuyerTaxBps: 0,
        taxLabel: "Standard local tax",
        districtType: null,
        taxRevision: "1",
        specialtyTaxApplied: false,
        qualifyingTaxTag: null,
        maximumUnitPrice: "8",
        fullQuantityAvailable: true,
        availability: "available",
        bookVersion: "1",
        expiresAt: new Date(Date.now() + 15_000).toISOString()
      }
    });
    expect(harness.controller.getState().quote?.bookVersion).toBe("1");

    const changedItem = { ...snapshot("Ore").items[0]!, bestAsk: "9", bookVersion: "2" };
    const callsBefore = harness.marketGetBook.mock.calls.length;
    harness.controller.handleMessage({ type: "MARKET_ITEM_SUMMARY_CHANGED", item: changedItem });

    expect(harness.controller.getState().snapshot?.items[0]?.bookVersion).toBe("2");
    expect(harness.controller.getState().book?.item.bookVersion).toBe("1");
    expect(harness.controller.getState().quote).toBeNull();

    // The server intentionally publishes summary first and book-change second.
    harness.controller.handleMessage({ type: "MARKET_BOOK_CHANGED", itemId: "ore", bookVersion: "2" });
    vi.advanceTimersByTime(1_000);
    expect(harness.marketGetBook).toHaveBeenCalledTimes(callsBefore + 1);
  });

  it("coalesces book changes while one read is in flight and follows up once for the newest version", () => {
    vi.useFakeTimers();
    const harness = controllerHarness();
    openWithSnapshot(harness);
    completeBook(harness);
    const callsBefore = harness.marketGetBook.mock.calls.length;

    for (const version of ["2", "3", "4"]) {
      harness.controller.handleMessage({ type: "MARKET_BOOK_CHANGED", itemId: "ore", bookVersion: version });
    }
    vi.advanceTimersByTime(1_000);
    expect(harness.marketGetBook).toHaveBeenCalledTimes(callsBefore + 1);
    const activeRequestId = lastCall(harness.marketGetBook)[0];

    harness.controller.handleMessage({ type: "MARKET_BOOK_CHANGED", itemId: "ore", bookVersion: "5" });
    vi.advanceTimersByTime(1_000);
    expect(harness.marketGetBook).toHaveBeenCalledTimes(callsBefore + 1);

    harness.controller.handleMessage({
      type: "MARKET_BOOK_RESULT",
      requestId: activeRequestId,
      book: book("4")
    });
    expect(harness.marketGetBook).toHaveBeenCalledTimes(callsBefore + 2);
    expect(lastCall(harness.marketGetBook)[2]).toBe("ore");
  });

  it("backs off a rate-limited book read without failing global market readiness", () => {
    vi.useFakeTimers();
    const harness = controllerHarness();
    openWithSnapshot(harness);
    completeBook(harness);
    harness.controller.handleMessage({ type: "MARKET_BOOK_CHANGED", itemId: "ore", bookVersion: "2" });
    vi.advanceTimersByTime(1_000);
    const limitedRequestId = lastCall(harness.marketGetBook)[0];
    const callsBeforeLimit = harness.marketGetBook.mock.calls.length;

    harness.controller.handleMessage({
      type: "MARKET_ERROR",
      requestId: limitedRequestId,
      code: "MARKET_RATE_LIMITED",
      message: "Market request rate limit reached",
      retryable: true
    });
    expect(harness.controller.getState()).toMatchObject({
      requestState: "ready",
      bookLoading: true,
      bookError: { code: "MARKET_RATE_LIMITED" }
    });

    harness.controller.handleMessage({ type: "MARKET_BOOK_CHANGED", itemId: "ore", bookVersion: "3" });
    vi.advanceTimersByTime(9_999);
    expect(harness.marketGetBook).toHaveBeenCalledTimes(callsBeforeLimit);
    vi.advanceTimersByTime(1);
    expect(harness.marketGetBook).toHaveBeenCalledTimes(callsBeforeLimit + 1);

    const secondLimitedRequestId = lastCall(harness.marketGetBook)[0];
    harness.controller.handleMessage({
      type: "MARKET_ERROR",
      requestId: secondLimitedRequestId,
      code: "MARKET_RATE_LIMITED",
      message: "Market request rate limit reached",
      retryable: true
    });
    vi.advanceTimersByTime(19_999);
    expect(harness.marketGetBook).toHaveBeenCalledTimes(callsBeforeLimit + 1);
    vi.advanceTimersByTime(1);
    expect(harness.marketGetBook).toHaveBeenCalledTimes(callsBeforeLimit + 2);
  });

  it("never installs a completed book for an item that is no longer selected", () => {
    vi.useFakeTimers();
    const harness = controllerHarness();
    const marketSnapshot = snapshot("Ore");
    const wood = {
      ...marketSnapshot.items[0]!,
      itemId: "wood",
      itemIdentity: "wood",
      displayName: "Wood"
    };
    marketSnapshot.items.push(wood);
    const openRequestId = open(harness);
    harness.controller.handleMessage({
      type: "MARKET_OPEN_RESULT",
      requestId: openRequestId,
      snapshot: marketSnapshot
    });
    const oreRequestId = lastCall(harness.marketGetBook)[0];

    harness.controller.selectItem("wood");
    harness.controller.handleMessage({
      type: "MARKET_BOOK_RESULT",
      requestId: oreRequestId,
      book: book("1")
    });
    expect(harness.controller.getState().book).toBeNull();

    vi.advanceTimersByTime(1_000);
    expect(lastCall(harness.marketGetBook)[2]).toBe("wood");
    const woodRequestId = lastCall(harness.marketGetBook)[0];
    harness.controller.handleMessage({
      type: "MARKET_BOOK_RESULT",
      requestId: woodRequestId,
      book: { ...book("1"), item: wood }
    });
    expect(harness.controller.getState().book?.item.itemId).toBe("wood");
  });

  it("continues the new selection when the prior item book request times out", () => {
    vi.useFakeTimers();
    const harness = controllerHarness({ requestTimeoutMs: 10 });
    const marketSnapshot = snapshot("Ore");
    marketSnapshot.items.push({
      ...marketSnapshot.items[0]!,
      itemId: "wood",
      itemIdentity: "wood",
      displayName: "Wood"
    });
    const openRequestId = open(harness);
    harness.controller.handleMessage({
      type: "MARKET_OPEN_RESULT",
      requestId: openRequestId,
      snapshot: marketSnapshot
    });

    harness.controller.selectItem("wood");
    vi.advanceTimersByTime(10);
    expect(harness.controller.getState()).toMatchObject({
      selectedItemId: "wood",
      bookLoading: true,
      bookError: null
    });
    vi.advanceTimersByTime(990);
    expect(lastCall(harness.marketGetBook)[2]).toBe("wood");
  });

  it("identifies only committed market mutations that change normal inventory", () => {
    const claim = mutationResult("claim-request", "100");
    claim.action = "claim";
    claim.claimedItems = "2";
    expect(marketMutationChangesInventory(claim)).toBe(true);

    const sell = mutationResult("sell-request", "100");
    sell.order = {
      orderId: "00000000-0000-4000-8000-000000000010",
      itemId: "ore",
      itemIdentity: "ore",
      displayName: "Ore",
      side: "sell",
      policy: "gtc",
      unitPrice: "8",
      originalQuantity: "2",
      filledQuantity: "0",
      remainingQuantity: "2",
      status: "open",
      prioritySequence: "1",
      createdAt: new Date(0).toISOString(),
      cancelledAt: null,
      completedAt: null
    };
    expect(marketMutationChangesInventory(sell)).toBe(true);

    const buy = mutationResult("buy-request", "80");
    expect(marketMutationChangesInventory(buy)).toBe(false);
  });
});

function controllerHarness(options: { quoteTimeoutMs?: number; requestTimeoutMs?: number } = {}) {
  let sequence = 0;
  const marketOpen = vi.fn<MarketClientTransport["marketOpen"]>(() => true);
  const marketBrowse = vi.fn<NonNullable<MarketClientTransport["marketBrowse"]>>(() => true);
  const marketGetBook = vi.fn<MarketClientTransport["marketGetBook"]>(() => true);
  const marketRequestQuote = vi.fn<MarketClientTransport["marketRequestQuote"]>(() => true);
  const marketCreateOrder = vi.fn<MarketClientTransport["marketCreateOrder"]>(() => true);
  const marketSimpleBuy = vi.fn<MarketClientTransport["marketSimpleBuy"]>(() => true);
  const marketCancelOrder = vi.fn<MarketClientTransport["marketCancelOrder"]>(() => true);
  const marketClaim = vi.fn<MarketClientTransport["marketClaim"]>(() => true);
  const marketSetSubscriptions = vi.fn<MarketClientTransport["marketSetSubscriptions"]>(() => true);
  const transport: MarketClientTransport = {
    marketOpen,
    marketBrowse,
    marketGetBook,
    marketRequestQuote,
    marketCreateOrder,
    marketSimpleBuy,
    marketCancelOrder,
    marketClaim,
    marketSetSubscriptions
  };
  const controller = new MarketController(() => transport, {
    createRequestId: () => `request-${++sequence}`,
    debounceMs: 200,
    ...options
  });
  activeControllers.push(controller);
  return {
    controller,
    marketOpen,
    marketBrowse,
    marketGetBook,
    marketRequestQuote,
    marketCreateOrder,
    marketSimpleBuy,
    marketCancelOrder,
    marketClaim,
    marketSetSubscriptions
  };
}

function open(harness: ReturnType<typeof controllerHarness>): string {
  harness.controller.setVenue("00000000-0000-4000-8000-000000000004");
  harness.controller.activate();
  harness.controller.onReady();
  return harness.marketOpen.mock.calls[0]?.[0] ?? "missing";
}

function openWithSnapshot(harness: ReturnType<typeof controllerHarness>): string {
  const requestId = open(harness);
  harness.controller.handleMessage({
    type: "MARKET_OPEN_RESULT",
    requestId,
    snapshot: snapshot("Ore")
  });
  completeBook(harness);
  return requestId;
}

function snapshot(displayName: string): MarketSnapshot {
  return {
    venue: {
      venueId: "00000000-0000-4000-8000-000000000001",
      venueKey: "city-test",
      displayName: "Test City Market",
      scopeType: "regional",
      cityId: "00000000-0000-4000-8000-000000000003",
      cityName: "Test City",
      marketStructureId: "00000000-0000-4000-8000-000000000004",
      activeMonumentTypes: [],
      standardBuyerTaxBps: 900,
      specialtyBuyerTaxBps: 450,
      taxRevision: "1"
    },
    sessionId: "00000000-0000-4000-8000-000000000005",
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
    categories: ["resource"],
    items: [{
      itemId: "ore",
      itemIdentity: "ore",
      displayName,
      iconKey: "ore",
      category: "resource",
      bestAsk: "8",
      bestBid: "7",
      availableSellQuantity: "10",
      availableBuyQuantity: "3",
      lastTradePrice: "8",
      bookVersion: "1"
    }],
    equipmentListings: [],
    nextCursor: null,
    player: player("100"),
    feePolicy: { version: 1, listingFee: "0", buyerFeeBps: 0, sellerFeeBps: 0, cancellationFee: "0" }
  };
}

function book(bookVersion = "1"): MarketBookSnapshot {
  return {
    item: { ...snapshot("Ore").items[0]!, bookVersion },
    asks: [{ unitPrice: "8", quantity: "10", orderCount: 1 }],
    bids: [{ unitPrice: "7", quantity: "3", orderCount: 1 }],
    recentTrades: []
  };
}

function completeBook(harness: ReturnType<typeof controllerHarness>): void {
  const requestId = harness.marketGetBook.mock.calls.at(-1)?.[0];
  if (!requestId) return;
  harness.controller.handleMessage({
    type: "MARKET_BOOK_RESULT",
    requestId,
    book: book()
  });
}

function player(walletGold: string): MarketSnapshot["player"] {
  return { walletGold, walletVersion: "0", activeOrders: [], recentOrders: [], recentFills: [], collection: { items: [], equipment: [], gold: "0" } };
}

function mutationResult(requestId: string, walletGold: string): MarketMutationResult {
  return {
    action: "create_order",
    requestId,
    replayed: false,
    order: null,
    trades: [],
    claimedItems: "0",
    claimedGold: "0",
    claimedEquipment: 0,
    equipmentListing: null,
    player: player(walletGold)
  };
}

function inventorySnapshot(): PlayerInventorySnapshot {
  return {
    playerId: "player-1",
    revision: 0,
    items: [],
    totals: emptyInventoryTotals(),
    unlockedSlots: 16
  };
}

function quote(bookVersion: string) {
  return {
    quoteId: "00000000-0000-4000-8000-000000000099",
    itemId: "ore",
    itemIdentity: "ore",
    requestedQuantity: "2",
    requestedMaximumUnitPrice: "8",
    fillableQuantity: "2",
    quotedTotal: "16",
    grossItemTotal: "15",
    buyerTax: "1",
    buyerTotal: "16",
    appliedBuyerTaxBps: 900,
    taxLabel: "Standard local tax",
    districtType: null,
    taxRevision: "1",
    specialtyTaxApplied: false,
    qualifyingTaxTag: null,
    maximumUnitPrice: "8",
    fullQuantityAvailable: true,
    availability: "available",
    bookVersion,
    expiresAt: new Date(Date.now() + 15_000).toISOString()
  } as const;
}

function lastCall<T extends (...args: never[]) => unknown>(mock: Mock<T>): Parameters<T> {
  const call = mock.mock.calls.at(-1);
  if (!call) throw new Error("Expected mock call");
  return call;
}
