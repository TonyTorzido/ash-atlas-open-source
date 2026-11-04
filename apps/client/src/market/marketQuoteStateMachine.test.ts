import type { MarketInteger, MarketQuote, MarketSnapshot } from "@ash-atlas/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MarketController, type MarketClientTransport } from "./marketController.js";

type QuoteCall = [string, string, string, MarketInteger, MarketInteger];

afterEach(() => {
  vi.useRealTimers();
});

describe("Quick Trade quote state-machine model", () => {
  it("runs 100 deterministic seeds with 500 randomized transitions each", () => {
    vi.useFakeTimers();
    const seeds = Array.from({ length: 100 }, (_, index) => `quote-model-${index.toString().padStart(3, "0")}`);
    let transitions = 0;

    for (const seed of seeds) {
      const harness = createHarness(10);
      let active = true;
      let connected = true;
      harness.controller.activate();
      harness.controller.onReady();
      establishSession(harness);
      const random = seededRandom(seed);

      for (let step = 0; step < 500; step += 1) {
        transitions += 1;
        const event = Math.floor(random() * 17);
        const latest = latestQuoteCall(harness.marketRequestQuote);
        switch (event) {
          case 0:
          case 1:
          case 2:
            if (active && connected) {
              harness.controller.requestQuote(
                "food",
                String(1 + Math.floor(random() * 20)),
                random() < 0.5 ? "9" : "13"
              );
            }
            break;
          case 3:
            if (latest) harness.controller.handleMessage(quoteResult(latest));
            break;
          case 4: {
            const historical = randomQuoteCall(harness.marketRequestQuote, random);
            if (historical) harness.controller.handleMessage(quoteResult(historical));
            break;
          }
          case 5:
            if (latest) harness.controller.handleMessage(quoteResult(latest, { itemId: "another-item", itemIdentity: "another-item" }));
            break;
          case 6:
            if (latest) harness.controller.handleMessage(quoteResult(latest, { requestedQuantity: "999" }));
            break;
          case 7:
            if (latest) harness.controller.handleMessage(quoteResult(latest, { requestedMaximumUnitPrice: "777" }));
            break;
          case 8:
            if (latest) harness.controller.handleMessage({
              type: "MARKET_ERROR",
              requestId: latest[0],
              code: "MARKET_BUSY",
              message: "busy",
              retryable: true
            });
            break;
          case 9:
            vi.advanceTimersByTime(10);
            break;
          case 10:
            harness.controller.invalidateQuote();
            break;
          case 11:
            harness.controller.handleMessage({
              type: "MARKET_BOOK_CHANGED",
              itemId: "food",
              bookVersion: String(2 + step)
            });
            break;
          case 12:
            harness.controller.onDisconnected();
            connected = false;
            break;
          case 13:
            harness.controller.onReady();
            connected = true;
            break;
          case 14:
            harness.controller.deactivate();
            active = false;
            break;
          case 15:
            harness.controller.activate();
            active = true;
            break;
          case 16:
            if (active && connected && harness.controller.getState().quoteError?.retryable) {
              const state = harness.controller.getState();
              harness.controller.requestQuote(
                state.selectedItemId ?? "food",
                state.quoteQuantity ?? "1",
                state.quoteMaximumUnitPrice ?? "9"
              );
            }
            break;
        }
        completeBook(harness);
        assertStateInvariants(harness, seed, step, active, connected);
      }

      vi.advanceTimersByTime(100);
      expect(harness.controller.getState().quoteLoading, `seed=${seed} final loading`).toBe(false);
      const requestIds = harness.marketRequestQuote.mock.calls.map((call) => call[0]);
      expect(new Set(requestIds).size, `seed=${seed} request-id collision`).toBe(requestIds.length);
      harness.controller.destroy();
      expect(vi.getTimerCount(), `seed=${seed} surviving timer`).toBe(0);
    }

    expect(transitions).toBe(50_000);
  });

  it("keeps requests, timers, and stale responses bounded during controller storms", () => {
    vi.useFakeTimers();
    const harness = createHarness(10);
    harness.controller.activate();
    harness.controller.onReady();
    establishSession(harness);
    expect(harness.controller.isSelectedBookFresh()).toBe(true);
    expect(harness.controller.getState().bookLoading).toBe(false);

    for (let index = 0; index < 1_000; index += 1) {
      harness.controller.requestQuote(
        "food",
        String((index % 25) + 1),
        index % 2 === 0 ? "9" : "13"
      );
    }
    const calls = harness.marketRequestQuote.mock.calls as QuoteCall[];
    // One in-flight quote and one coalesced latest intent; storms must not
    // produce one network request for every edit.
    expect(calls).toHaveLength(1);
    expect(vi.getTimerCount()).toBeLessThanOrEqual(2);

    const first = calls[0]!;
    harness.controller.handleMessage(quoteResult(first));
    vi.advanceTimersByTime(2_200);
    expect(calls).toHaveLength(2);
    expect(new Set(calls.map((call) => call[0])).size).toBe(2);
    expect(calls[1]!.slice(2)).toEqual(["food", "25", "13"]);
    for (let index = 0; index < 500; index += 1) harness.controller.handleMessage(quoteResult(first));
    expect(harness.controller.getState().quote).toBeNull();
    expect(harness.controller.getState().quoteLoading).toBe(true);

    const newest = calls.at(-1)!;
    harness.controller.handleMessage(quoteResult(newest));
    expect(harness.controller.getState().quote?.requestedMaximumUnitPrice).toBe("13");
    expect(harness.controller.getState().quoteLoading).toBe(false);
    expect(vi.getTimerCount()).toBeLessThanOrEqual(1);

    for (let index = 0; index < 500; index += 1) {
      harness.controller.requestQuote("food", "1", "9");
      harness.controller.onDisconnected();
      harness.controller.onReady();
      establishSession(harness);
    }
    expect(harness.controller.getState().quoteLoading).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    harness.controller.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });
});

function createHarness(quoteTimeoutMs: number) {
  let sequence = 0;
  const marketRequestQuote = vi.fn<MarketClientTransport["marketRequestQuote"]>(() => true);
  const marketOpen = vi.fn<MarketClientTransport["marketOpen"]>(() => true);
  const marketBrowse = vi.fn<NonNullable<MarketClientTransport["marketBrowse"]>>(() => true);
  const marketGetBook = vi.fn<MarketClientTransport["marketGetBook"]>(() => true);
  const transport: MarketClientTransport = {
    marketOpen,
    marketBrowse,
    marketGetBook,
    marketRequestQuote,
    marketCreateOrder: vi.fn(() => true),
    marketSimpleBuy: vi.fn(() => true),
    marketCancelOrder: vi.fn(() => true),
    marketClaim: vi.fn(() => true),
    marketSetSubscriptions: vi.fn(() => true)
  };
  return {
    controller: new MarketController(() => transport, {
      createRequestId: () => `model-request-${++sequence}`,
      debounceMs: 1,
      quoteTimeoutMs
    }),
    marketOpen,
    marketRequestQuote,
    marketGetBook,
    completedBookRequestId: ""
  };
}

function latestQuoteCall(mock: ReturnType<typeof createHarness>["marketRequestQuote"]): QuoteCall | null {
  return (mock.mock.calls.at(-1) as QuoteCall | undefined) ?? null;
}

function randomQuoteCall(
  mock: ReturnType<typeof createHarness>["marketRequestQuote"],
  random: () => number
): QuoteCall | null {
  if (mock.mock.calls.length === 0) return null;
  return mock.mock.calls[Math.floor(random() * mock.mock.calls.length)] as QuoteCall;
}

function quoteResult(call: QuoteCall, overrides: Partial<MarketQuote> = {}) {
  return {
    type: "MARKET_QUOTE_RESULT" as const,
    requestId: call[0],
    quote: {
      quoteId: deterministicUuid(call[0]),
      itemId: call[2],
      itemIdentity: call[2],
      requestedQuantity: call[3],
      requestedMaximumUnitPrice: call[4],
      fillableQuantity: call[3],
      quotedTotal: (BigInt(call[3]) * BigInt(call[4])).toString(),
      grossItemTotal: (BigInt(call[3]) * BigInt(call[4])).toString(),
      buyerTax: "0",
      buyerTotal: (BigInt(call[3]) * BigInt(call[4])).toString(),
      appliedBuyerTaxBps: 0,
      taxLabel: "Standard local tax",
      districtType: null,
      taxRevision: "1",
      specialtyTaxApplied: false,
      qualifyingTaxTag: null,
      maximumUnitPrice: call[4],
      fullQuantityAvailable: true,
      availability: "available" as const,
      bookVersion: "1",
      expiresAt: new Date(Date.now() + 15_000).toISOString(),
      ...overrides
    }
  };
}

function establishSession(harness: ReturnType<typeof createHarness>): void {
  const structureId = "00000000-0000-4000-8000-000000000004";
  harness.controller.openVenue(structureId, "1");
  const requestId = harness.marketOpen.mock.calls.at(-1)?.[0] ?? "missing";
  harness.controller.handleMessage({
    type: "MARKET_OPEN_RESULT",
    requestId,
    snapshot: {
      venue: {
        venueId: "00000000-0000-4000-8000-000000000001",
        venueKey: "model-city",
        displayName: "Model City Market",
        scopeType: "regional",
        cityId: "00000000-0000-4000-8000-000000000003",
        cityName: "Model City",
        marketStructureId: structureId,
        activeMonumentTypes: [],
        standardBuyerTaxBps: 1_000,
        specialtyBuyerTaxBps: 500,
        taxRevision: "1"
      },
      sessionId: "00000000-0000-4000-8000-000000000005",
      controls: {
        accessAllowed: true, readOnly: false, newOrdersEnabled: true,
        matchingEnabled: true, cancellationsEnabled: true, claimsEnabled: true,
        venueFrozen: false, playerFrozen: false, message: null
      },
      categories: ["resource"],
      items: [{
        itemId: "food", itemIdentity: "food", displayName: "Food", iconKey: "food", category: "resource",
        bestAsk: "9", bestBid: "8", availableSellQuantity: "100", availableBuyQuantity: "100",
        lastTradePrice: "9", bookVersion: "1"
      }],
      equipmentListings: [],
      nextCursor: null,
      player: {
        walletGold: "1000", walletVersion: "0", activeOrders: [], recentOrders: [], recentFills: [],
        collection: { items: [], equipment: [], gold: "0" }
      },
      feePolicy: {
        version: 1, listingFee: "0", buyerFeeBps: 0,
        sellerFeeBps: 0, cancellationFee: "0"
      }
    } satisfies MarketSnapshot
  });
  completeBook(harness);
}

function completeBook(harness: ReturnType<typeof createHarness>): void {
  const call = harness.marketGetBook.mock.calls.at(-1);
  if (!call || call[0] === harness.completedBookRequestId) return;
  const item = harness.controller.getState().snapshot?.items.find((entry) => entry.itemIdentity === call[2]);
  if (!item) return;
  harness.completedBookRequestId = call[0];
  harness.controller.handleMessage({
    type: "MARKET_BOOK_RESULT",
    requestId: call[0],
    book: {
      item,
      asks: [{ unitPrice: "9", quantity: "100", orderCount: 1 }],
      bids: [{ unitPrice: "8", quantity: "100", orderCount: 1 }],
      recentTrades: []
    }
  });
}

function assertStateInvariants(
  harness: ReturnType<typeof createHarness>,
  seed: string,
  step: number,
  active: boolean,
  connected: boolean
): void {
  const state = harness.controller.getState();
  const context = `seed=${seed} step=${step}`;
  if (state.quoteLoading) {
    expect(state.quote, `${context} requesting quote`).toBeNull();
    expect(state.quoteError, `${context} requesting error`).toBeNull();
    expect(state.quoteQuantity, `${context} requesting quantity`).not.toBeNull();
    expect(state.quoteMaximumUnitPrice, `${context} requesting cap`).not.toBeNull();
    expect(active, `${context} requesting while closed`).toBe(true);
    expect(connected, `${context} requesting while disconnected`).toBe(true);
  }
  if (state.quote) {
    expect(state.quoteLoading, `${context} authoritative quote still loading`).toBe(false);
    expect(state.quote.itemId, `${context} authoritative item`).toBe(state.selectedItemId);
    expect(state.quote.itemIdentity, `${context} authoritative identity`).toBe(state.selectedItemId);
    expect(state.quote.requestedQuantity, `${context} authoritative quantity`).toBe(state.quoteQuantity);
    expect(state.quote.requestedMaximumUnitPrice, `${context} authoritative cap`)
      .toBe(state.quoteMaximumUnitPrice);
  }
  if (!connected || !active) {
    expect(state.quoteLoading, `${context} inactive pending quote`).toBe(false);
  }
}

function seededRandom(seed: string): () => number {
  let state = 2_166_136_261;
  for (const character of seed) {
    state ^= character.charCodeAt(0);
    state = Math.imul(state, 16_777_619) >>> 0;
  }
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function deterministicUuid(value: string): string {
  let hex = "";
  let state = 0x811c9dc5;
  for (let index = 0; index < 32; index += 1) {
    state ^= value.charCodeAt(index % value.length);
    state = Math.imul(state, 0x01000193) >>> 0;
    hex += (state & 0xf).toString(16);
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
