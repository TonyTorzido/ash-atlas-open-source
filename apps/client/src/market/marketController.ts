import type {
  MarketBookSnapshot,
  MarketCollectionScope,
  MarketInteger,
  MarketMutationResult,
  MarketOrderSide,
  MarketPriceCurrency,
  MarketQuote,
  MarketServerMessage,
  MarketSnapshot,
  ServerMessage
} from "@ash-atlas/shared";

import { compareMarketIntegers, isQuoteExpired } from "./marketFormat.js";
import { requestIdCrypto as crypto } from "../requestId.js";

export type MarketSection = "browse" | "gear" | "orders" | "collection" | "recent";
export type MarketSort = "lowest_ask" | "name" | "available";
export type MarketInterfaceMode = "simple" | "merchant";
export type MarketRequestState =
  | "access_required"
  | "opening"
  | "loading"
  | "ready"
  | "refreshing"
  | "purchasing"
  | "creating_listing"
  | "canceling_listing"
  | "reconnecting"
  | "failed";

export type MarketClientTransport = {
  marketOpen(
    requestId: string,
    marketStructureId: string,
    expectedPlacementRevision: string,
    options?: { listedOnly?: boolean }
  ): boolean;
  marketBrowse?(
    requestId: string,
    marketSessionId: string,
    options?: {
      search?: string;
      category?: string;
      cursor?: string | null;
      limit?: number;
      listedOnly?: boolean;
    }
  ): boolean;
  marketGetBook(
    requestId: string,
    marketSessionId: string,
    itemIdentity: string,
    depth?: number,
    priceCurrency?: MarketPriceCurrency
  ): boolean;
  marketRequestQuote(
    requestId: string,
    marketSessionId: string,
    itemIdentity: string,
    quantity: MarketInteger,
    maximumUnitPrice: MarketInteger,
    priceCurrency?: MarketPriceCurrency
  ): boolean;
  marketCreateOrder(
    requestId: string,
    marketSessionId: string,
    interfaceMode: MarketInterfaceMode,
    side: MarketOrderSide,
    itemIdentity: string,
    quantity: MarketInteger,
    unitPrice: MarketInteger,
    priceCurrency?: MarketPriceCurrency
  ): boolean;
  marketSimpleBuy(
    requestId: string,
    marketSessionId: string,
    quoteId: string,
    maximumTotal: MarketInteger
  ): boolean;
  marketCancelOrder(requestId: string, marketSessionId: string, orderId: string): boolean;
  marketClaim(
    requestId: string,
    marketSessionId: string,
    scope: MarketCollectionScope
  ): boolean;
  marketCreateEquipmentListing?(
    requestId: string,
    marketSessionId: string,
    equipmentInstanceId: string,
    askingPrice: MarketInteger,
    expectedEquipmentRevision: MarketInteger,
    priceCurrency?: MarketPriceCurrency
  ): boolean;
  marketPurchaseEquipmentListing?(
    requestId: string,
    marketSessionId: string,
    listingId: string,
    expectedListingVersion: MarketInteger,
    maximumBuyerTotal: MarketInteger,
    expectedTaxRevision: MarketInteger,
    expectedPriceCurrency?: MarketPriceCurrency
  ): boolean;
  marketCancelEquipmentListing?(
    requestId: string,
    marketSessionId: string,
    listingId: string,
    expectedListingVersion: MarketInteger
  ): boolean;
  marketSetSubscriptions(
    requestId: string,
    marketSessionId: string,
    visibleItemIdentities: string[],
    focusedItemIdentity: string | null,
    privateState: boolean,
    revision: number
  ): boolean;
};

export type MarketPendingMutation = {
  requestId: string;
  label: string;
};

export type MarketClientError = {
  requestId: string | null;
  code: string;
  message: string;
  retryable: boolean;
};

export type MarketViewState = {
  active: boolean;
  connected: boolean;
  snapshotFresh: boolean;
  marketStructureId: string | null;
  placementRevision: string | null;
  requestState: MarketRequestState;
  connectionGeneration: number;
  sessionGeneration: number;
  section: MarketSection;
  search: string;
  category: string | null;
  sort: MarketSort;
  loading: boolean;
  loadingMore: boolean;
  snapshot: MarketSnapshot | null;
  selectedItemId: string | null;
  book: MarketBookSnapshot | null;
  bookLoading: boolean;
  bookError: MarketClientError | null;
  quote: MarketQuote | null;
  quoteQuantity: MarketInteger | null;
  quoteMaximumUnitPrice: MarketInteger | null;
  quoteLoading: boolean;
  quoteError: MarketClientError | null;
  pendingMutation: MarketPendingMutation | null;
  error: MarketClientError | null;
  notice: string | null;
  subscriptionRevision: number;
};

type OpenRequest = {
  requestId: string;
  marketStructureId: string;
  placementRevision: string;
  connectionGeneration: number;
  sessionGeneration: number;
};
type BrowseRequest = {
  requestId: string;
  append: boolean;
  sessionId: string;
  connectionGeneration: number;
  sessionGeneration: number;
};
type QuoteRequest = {
  requestId: string;
  itemId: string;
  quantity: MarketInteger;
  maximumUnitPrice: MarketInteger;
  sessionId: string;
  connectionGeneration: number;
  sessionGeneration: number;
};
type PendingQuoteRequest = {
  itemId: string;
  quantity: MarketInteger;
  maximumUnitPrice: MarketInteger;
};
type BookRequest = {
  requestId: string;
  itemId: string;
  sessionId: string;
  minimumBookVersion: MarketInteger;
  connectionGeneration: number;
  sessionGeneration: number;
};
type PendingBookRefresh = {
  itemId: string;
  minimumBookVersion: MarketInteger;
};

type PendingCommand =
  | {
      kind: "create_order";
      requestId: string;
      interfaceMode: MarketInterfaceMode;
      side: MarketOrderSide;
      itemId: string;
      quantity: MarketInteger;
      unitPrice: MarketInteger;
      priceCurrency?: MarketPriceCurrency;
      label: string;
    }
  | {
      kind: "simple_buy";
      requestId: string;
      quoteId: string;
      maximumTotal: MarketInteger;
      label: string;
    }
  | { kind: "cancel_order"; requestId: string; orderId: string; label: string }
  | {
      kind: "claim";
      requestId: string;
      scope: MarketCollectionScope;
      label: string;
    }
  | {
      kind: "create_equipment_listing";
      requestId: string;
      equipmentInstanceId: string;
      askingPrice: MarketInteger;
      expectedEquipmentRevision: MarketInteger;
      priceCurrency?: MarketPriceCurrency;
      label: string;
    }
  | {
      kind: "purchase_equipment_listing";
      requestId: string;
      listingId: string;
      expectedListingVersion: MarketInteger;
      maximumBuyerTotal: MarketInteger;
      expectedTaxRevision: MarketInteger;
      expectedPriceCurrency: MarketPriceCurrency;
      label: string;
    }
  | {
      kind: "cancel_equipment_listing";
      requestId: string;
      listingId: string;
      expectedListingVersion: MarketInteger;
      label: string;
    };

type MarketControllerOptions = {
  createRequestId?: () => string;
  debounceMs?: number;
  quoteTimeoutMs?: number;
  requestTimeoutMs?: number;
};

const MARKET_PAGE_SIZE = 24;
const MAX_RETAINED_ITEMS = 40;
const BOOK_DEPTH = 20;
const BOOK_REFRESH_DEBOUNCE_MS = 80;
const BOOK_REFRESH_INTERVAL_MS = 1_000;
const QUOTE_REQUEST_INTERVAL_MS = 2_200;
const MARKET_RATE_LIMIT_BACKOFF_MS = [10_000, 20_000, 40_000, 60_000] as const;

const INITIAL_STATE: MarketViewState = {
  active: false,
  connected: false,
  snapshotFresh: false,
  marketStructureId: null,
  placementRevision: null,
  requestState: "access_required",
  connectionGeneration: 0,
  sessionGeneration: 0,
  section: "browse",
  search: "",
  category: null,
  sort: "lowest_ask",
  loading: false,
  loadingMore: false,
  snapshot: null,
  selectedItemId: null,
  book: null,
  bookLoading: false,
  bookError: null,
  quote: null,
  quoteQuantity: null,
  quoteMaximumUnitPrice: null,
  quoteLoading: false,
  quoteError: null,
  pendingMutation: null,
  error: null,
  notice: null,
  subscriptionRevision: 0
};

export class MarketController {
  private state: MarketViewState = INITIAL_STATE;
  private readonly listeners = new Set<() => void>();
  private readonly createRequestId: () => string;
  private readonly debounceMs: number;
  private readonly quoteTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private bookRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private bookPumpTimer: ReturnType<typeof setTimeout> | null = null;
  private playerRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private mutationConfirmationTimer: ReturnType<typeof setTimeout> | null = null;
  private activeBrowseRequest: BrowseRequest | null = null;
  /** Whether the item list on screen was fetched as Browse (listed only) or Sell (everything). */
  private browsedListedOnly = false;
  private activeOpenRequest: OpenRequest | null = null;
  private openTimer: ReturnType<typeof setTimeout> | null = null;
  private browseTimer: ReturnType<typeof setTimeout> | null = null;
  private bookTimer: ReturnType<typeof setTimeout> | null = null;
  private activeBookRequest: BookRequest | null = null;
  private pendingBookRefresh: PendingBookRefresh | null = null;
  private lastBookRequestAt = -BOOK_REFRESH_INTERVAL_MS;
  private bookRetryNotBefore = 0;
  private bookRateLimitCount = 0;
  private quoteTimer: ReturnType<typeof setTimeout> | null = null;
  private quotePumpTimer: ReturnType<typeof setTimeout> | null = null;
  private activeQuoteRequest: QuoteRequest | null = null;
  private readonly ignoredQuoteRequestIds = new Set<string>();
  private pendingQuoteRequest: PendingQuoteRequest | null = null;
  private lastQuoteRequestAt = -QUOTE_REQUEST_INTERVAL_MS;
  private quoteRetryNotBefore = 0;
  private quoteRateLimitCount = 0;
  private lastCommand: PendingCommand | null = null;

  constructor(
    private readonly transport: () => MarketClientTransport | null,
    options: MarketControllerOptions = {}
  ) {
    this.createRequestId = options.createRequestId ?? (() => crypto.randomUUID());
    this.debounceMs = options.debounceMs ?? 200;
    this.quoteTimeoutMs = options.quoteTimeoutMs ?? 9_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getState = (): MarketViewState => this.state;

  isSelectedBookFresh(): boolean {
    const selectedItemId = this.state.selectedItemId;
    const book = this.state.book;
    const summary = this.state.snapshot?.items.find((item) => marketSelectionIdentity(item) === selectedItemId);
    // Catalog summaries describe the Gold book; a Glimmer book is fresh once loaded.
    const glimmerBook = selectedItemId !== null &&
      splitMarketBookKey(selectedItemId).priceCurrency === "glimmer";
    return Boolean(
      selectedItemId &&
      book &&
      marketSelectionIdentity(book.item) === selectedItemId &&
      (glimmerBook || (
        summary &&
        compareMarketIntegers(book.item.bookVersion, summary.bookVersion) >= 0
      ))
    );
  }

  /** Switches the selected item between its Gold and Glimmer books. */
  setPriceCurrency(priceCurrency: MarketPriceCurrency): void {
    const key = this.state.selectedItemId;
    if (!key) return;
    const current = splitMarketBookKey(key);
    if (current.priceCurrency === priceCurrency) return;
    const next = marketBookKey(current.itemIdentity, priceCurrency);
    this.clearQuoteWork();
    this.pendingBookRefresh = null;
    const loading = this.state.connected && this.state.active;
    this.update({
      selectedItemId: next,
      book: null,
      bookLoading: loading,
      bookError: null,
      quote: null,
      quoteQuantity: null,
      quoteMaximumUnitPrice: null,
      quoteLoading: false,
      quoteError: null
    });
    if (loading) this.queueBookRefresh(next);
  }

  activate(): void {
    if (this.state.active) return;
    this.update({
      active: true,
      error: this.lastCommand ? this.state.error : null
    });
    if (this.state.connected && this.state.marketStructureId) {
      this.requestOpen();
    }
  }

  setVenue(
    marketStructureId: string | null,
    placementRevision: string | null = null
  ): void {
    const resolvedPlacementRevision =
      marketStructureId !== null && placementRevision === null
        ? "1"
        : placementRevision;
    if (
      marketStructureId === this.state.marketStructureId &&
      resolvedPlacementRevision === this.state.placementRevision
    ) return;
    this.clearTimer("search");
    this.clearTimer("player");
    this.activeBrowseRequest = null;
    this.clearOpenTimeout();
    this.clearBrowseTimeout();
    this.activeOpenRequest = null;
    this.clearBookWork();
    this.resetQuoteWork();
    this.update({
      marketStructureId,
      placementRevision: resolvedPlacementRevision,
      requestState: marketStructureId ? "access_required" : "access_required",
      snapshot: null,
      snapshotFresh: false,
      loading: false,
      loadingMore: false,
      selectedItemId: null,
      book: null,
      bookLoading: false,
      bookError: null,
      quote: null,
      quoteQuantity: null,
      quoteMaximumUnitPrice: null,
      quoteLoading: false,
      quoteError: null,
      pendingMutation: null,
      error: null,
      notice: null
    });
  }

  openVenue(marketStructureId: string, placementRevision: string): boolean {
    this.setVenue(marketStructureId, placementRevision);
    this.activate();
    if (!this.activeOpenRequest) this.requestOpen();
    return this.activeOpenRequest !== null;
  }

  deactivate(): void {
    this.replaceSubscriptions([], null, false);
    this.clearTimer("search");
    this.clearTimer("player");
    this.clearMutationConfirmation();
    this.activeBrowseRequest = null;
    this.activeOpenRequest = null;
    this.clearOpenTimeout();
    this.clearBrowseTimeout();
    this.clearBookWork();
    this.resetQuoteWork();
    this.update({
      active: false,
      requestState: "access_required",
      snapshot: null,
      snapshotFresh: false,
      loading: false,
      loadingMore: false,
      bookLoading: false,
      bookError: null,
      quote: null,
      quoteQuantity: null,
      quoteMaximumUnitPrice: null,
      quoteLoading: false,
      quoteError: null
    });
  }

  destroy(): void {
    this.deactivate();
    this.listeners.clear();
  }

  onReady(): void {
    this.resetQuoteWork();
    const connectionGeneration = this.state.connectionGeneration + 1;
    this.update({
      connected: true,
      connectionGeneration,
      requestState: this.state.active ? "reconnecting" : "access_required",
      snapshotFresh: false,
      quote: null,
      quoteQuantity: null,
      quoteMaximumUnitPrice: null,
      quoteLoading: false,
      quoteError: null,
      error: this.lastCommand ? this.state.error : null
    });
    if (!this.state.active) return;
    this.requestOpen();
  }

  onDisconnected(): void {
    const pendingRequestId = this.state.pendingMutation?.requestId ?? null;
    this.clearMutationConfirmation();
    this.activeBrowseRequest = null;
    this.activeOpenRequest = null;
    this.clearOpenTimeout();
    this.clearBrowseTimeout();
    this.clearBookWork();
    this.resetQuoteWork();
    this.update({
      connected: false,
      requestState: this.state.active ? "reconnecting" : "access_required",
      snapshotFresh: false,
      loading: false,
      loadingMore: false,
      bookLoading: false,
      bookError: null,
      quote: null,
      quoteQuantity: null,
      quoteMaximumUnitPrice: null,
      quoteLoading: false,
      quoteError: disconnectedError(null),
      pendingMutation: null,
      ...(pendingRequestId
        ? {
            error: unconfirmedMutationError(pendingRequestId)
          }
        : {})
    });
  }

  setSection(section: MarketSection): void {
    if (section === this.state.section) return;
    if (section !== "browse") {
      this.clearQuoteWork();
      this.update({
        section,
        quote: null,
        quoteQuantity: null,
        quoteMaximumUnitPrice: null,
        quoteLoading: false,
        quoteError: null
      });
      this.refreshItemsForSection();
      return;
    }
    this.update({ section });
    this.refreshItemsForSection();
  }

  setSort(sort: MarketSort): void {
    this.update({ sort });
  }

  setSearch(search: string): void {
    this.clearTimer("search");
    this.update({ search: search.slice(0, 80), quote: null, quoteQuantity: null });
    this.searchTimer = setTimeout(() => {
      this.searchTimer = null;
      this.requestBrowse(false);
    }, this.debounceMs);
  }

  setCategory(category: string | null): void {
    if (category === this.state.category) return;
    this.clearTimer("search");
    this.update({ category, quote: null, quoteQuantity: null });
    this.requestBrowse(false);
  }

  refresh(): void {
    this.clearTimer("search");
    this.requestBrowse(false);
  }

  loadMore(): boolean {
    const cursor = this.state.snapshot?.nextCursor;
    if (!cursor || this.state.loadingMore || this.visibleItems().length >= MAX_RETAINED_ITEMS) {
      return false;
    }
    this.requestBrowse(true, cursor);
    return true;
  }

  selectItem(itemId: string): void {
    const items = this.state.snapshot?.items ?? [];
    const selectedItemIdentity = items.find((item) => item.itemIdentity === itemId)
      ?? items.find((item) => item.itemId === itemId && item.variant == null);
    const selectionKey = selectedItemIdentity
      ? marketSelectionIdentity(selectedItemIdentity)
      : itemId;
    this.clearQuoteWork();
    this.update({
      selectedItemId: selectionKey,
      book: this.state.book && marketSelectionIdentity(this.state.book.item) === selectionKey
        ? this.state.book
        : null,
      bookLoading: this.state.connected && this.state.active,
      bookError: null,
      quote: null,
      quoteQuantity: null,
      quoteMaximumUnitPrice: null,
      quoteLoading: false,
      quoteError: null,
      error: this.lastCommand ? this.state.error : null
    });
    if (this.state.connected && this.state.active) this.queueBookRefresh(selectionKey);
    this.syncSubscriptions();
  }

  retryBook(): void {
    const itemId = this.state.selectedItemId;
    if (!itemId) return;
    this.update({ bookError: null, bookLoading: true });
    this.queueBookRefresh(itemId);
  }

  invalidateQuote(): void {
    this.clearQuoteWork();
    this.update({
      quote: null,
      quoteQuantity: null,
      quoteMaximumUnitPrice: null,
      quoteLoading: false,
      quoteError: null
    });
  }

  requestQuote(
    itemId: string,
    quantity: MarketInteger,
    maximumUnitPrice: MarketInteger
  ): boolean {
    if (
      itemId !== this.state.selectedItemId ||
      this.state.bookLoading ||
      this.state.bookError ||
      !this.isSelectedBookFresh()
    ) return false;
    const transport = this.transport();
    const sessionId = this.state.snapshot?.sessionId ?? null;
    if (!this.canSend() || !transport || !sessionId) return this.offlineFailure();
    this.pendingQuoteRequest = { itemId, quantity, maximumUnitPrice };
    this.update({
      quote: null,
      quoteQuantity: quantity,
      quoteMaximumUnitPrice: maximumUnitPrice,
      quoteLoading: true,
      quoteError: null
    });
    this.pumpQuoteRequest();
    return true;
  }

  submitSimpleBuy(): boolean {
    const quote = this.state.quote;
    if (!quote || !quote.fullQuantityAvailable) return false;
    if (isQuoteExpired(quote.expiresAt)) {
      this.update({
        quote: null,
        error: {
          requestId: null,
          code: "MARKET_QUOTE_EXPIRED",
          message: "Price quote expired. Request a fresh quote.",
          retryable: false
        }
      });
      return false;
    }
    return this.beginMutation({
      kind: "simple_buy",
      requestId: this.createRequestId(),
      quoteId: quote.quoteId,
      maximumTotal: quote.quotedTotal,
      label: "Purchasing"
    });
  }

  submitCreateOrder(
    interfaceMode: MarketInterfaceMode,
    side: MarketOrderSide,
    itemId: string,
    quantity: MarketInteger,
    unitPrice: MarketInteger,
    priceCurrency: MarketPriceCurrency = "gold"
  ): boolean {
    return this.beginMutation({
      kind: "create_order",
      requestId: this.createRequestId(),
      interfaceMode,
      side,
      itemId,
      quantity,
      unitPrice,
      ...(priceCurrency === "glimmer" ? { priceCurrency } : {}),
      label: side === "buy" ? "Placing buy order" : "Listing item"
    });
  }

  cancelOrder(orderId: string): boolean {
    return this.beginMutation({
      kind: "cancel_order",
      requestId: this.createRequestId(),
      orderId,
      label: "Cancelling order"
    });
  }

  claim(scope: MarketCollectionScope): boolean {
    return this.beginMutation({
      kind: "claim",
      requestId: this.createRequestId(),
      scope,
      label: scope === "gold" ? "Claiming gold" : scope === "items" ? "Claiming items" : "Claiming collection"
    });
  }

  createEquipmentListing(
    equipmentInstanceId: string,
    askingPrice: MarketInteger,
    expectedEquipmentRevision: MarketInteger,
    priceCurrency: MarketPriceCurrency = "gold"
  ): boolean {
    return this.beginMutation({
      kind: "create_equipment_listing",
      requestId: this.createRequestId(),
      equipmentInstanceId,
      askingPrice,
      expectedEquipmentRevision,
      ...(priceCurrency === "glimmer" ? { priceCurrency } : {}),
      label: "Listing equipment"
    });
  }

  purchaseEquipmentListing(
    listingId: string,
    expectedListingVersion: MarketInteger,
    maximumBuyerTotal: MarketInteger,
    expectedTaxRevision: MarketInteger,
    expectedPriceCurrency: MarketPriceCurrency = "gold"
  ): boolean {
    return this.beginMutation({
      kind: "purchase_equipment_listing",
      requestId: this.createRequestId(),
      listingId,
      expectedListingVersion,
      maximumBuyerTotal,
      expectedTaxRevision,
      expectedPriceCurrency,
      label: "Purchasing equipment"
    });
  }

  cancelEquipmentListing(
    listingId: string,
    expectedListingVersion: MarketInteger
  ): boolean {
    return this.beginMutation({
      kind: "cancel_equipment_listing",
      requestId: this.createRequestId(),
      listingId,
      expectedListingVersion,
      label: "Cancelling equipment listing"
    });
  }

  retryLastMutation(): boolean {
    if (!this.lastCommand || this.state.pendingMutation) {
      return false;
    }
    const command = this.lastCommand;
    this.update({
      pendingMutation: { requestId: command.requestId, label: command.label },
      requestState: "ready",
      error: null,
      notice: null
    });
    if (this.sendPendingCommand(command)) {
      this.scheduleMutationConfirmation();
      return true;
    }
    this.update({
      pendingMutation: null,
      error: disconnectedError(command.requestId)
    });
    return false;
  }

  clearFeedback(): void {
    this.update({ error: null, notice: null });
  }

  sortedItems() {
    const items = [...this.visibleItems()];
    switch (this.state.sort) {
      case "name":
        return items.sort((left, right) => left.displayName.localeCompare(right.displayName));
      case "available":
        return items.sort((left, right) =>
          compareMarketIntegers(right.availableSellQuantity, left.availableSellQuantity)
        );
      case "lowest_ask":
        return items.sort((left, right) => {
          const price = compareMarketIntegers(left.bestAsk, right.bestAsk);
          return price || left.displayName.localeCompare(right.displayName);
        });
    }
  }

  handleMessage(message: ServerMessage): boolean {
    if (!isMarketServerMessage(message)) return false;
    switch (message.type) {
      case "MARKET_OPEN_RESULT":
        this.receiveOpenResult(message.requestId, message.snapshot);
        break;
      case "MARKET_BROWSE_RESULT":
        this.receiveBrowseResult(message.requestId, message.snapshot);
        break;
      case "MARKET_BOOK_RESULT":
        this.receiveBookResult(message.requestId, message.book);
        break;
      case "MARKET_QUOTE_RESULT":
        this.receiveQuoteResult(message.requestId, message.quote);
        break;
      case "MARKET_MUTATION_RESULT":
        this.receiveMutationResult(message.requestId, message.result);
        break;
      case "MARKET_SUBSCRIPTIONS_SET":
        if (message.revision > this.state.subscriptionRevision) {
          this.update({ subscriptionRevision: message.revision });
        }
        break;
      case "MARKET_ITEM_SUMMARY_CHANGED":
        this.receiveItemSummary(message.item);
        break;
      case "MARKET_BOOK_CHANGED":
        this.receiveBookChanged(
          marketBookKey(message.itemIdentity ?? message.itemId!, message.priceCurrency ?? "gold"),
          message.bookVersion
        );
        break;
      case "MARKET_PLAYER_STATE_CHANGED":
        this.schedulePlayerRefresh();
        break;
      case "MARKET_ASSETS_CHANGED":
        break;
      case "MARKET_ERROR":
        this.receiveError(message);
        break;
    }
    return true;
  }

  private receiveOpenResult(requestId: string, snapshot: MarketSnapshot): void {
    const request = this.activeOpenRequest;
    if (!request || request.requestId !== requestId) return;
    if (
      request.connectionGeneration !== this.state.connectionGeneration ||
      request.sessionGeneration !== this.state.sessionGeneration ||
      snapshot.venue.marketStructureId !== request.marketStructureId ||
      request.marketStructureId !== this.state.marketStructureId ||
      request.placementRevision !== this.state.placementRevision
    ) {
      return;
    }
    this.activeOpenRequest = null;
    this.clearOpenTimeout();
    this.installSnapshot(snapshot, false);
  }

  private receiveBrowseResult(requestId: string, snapshot: MarketSnapshot): void {
    const request = this.activeBrowseRequest;
    if (!request || request.requestId !== requestId) return;
    if (
      request.connectionGeneration !== this.state.connectionGeneration ||
      request.sessionGeneration !== this.state.sessionGeneration ||
      snapshot.sessionId !== request.sessionId ||
      snapshot.sessionId !== this.state.snapshot?.sessionId ||
      snapshot.venue.marketStructureId !== this.state.marketStructureId
    ) return;
    this.activeBrowseRequest = null;
    this.clearBrowseTimeout();
    this.installSnapshot(snapshot, request.append);
  }

  private receiveBookResult(requestId: string, book: MarketBookSnapshot): void {
    const request = this.activeBookRequest;
    if (!request || request.requestId !== requestId) return;
    this.activeBookRequest = null;
    this.clearBookTimeout();
    this.bookRateLimitCount = 0;
    this.bookRetryNotBefore = 0;

    const requestStillCurrent =
      request.connectionGeneration === this.state.connectionGeneration &&
      request.sessionGeneration === this.state.sessionGeneration &&
      request.sessionId === this.state.snapshot?.sessionId &&
      request.itemId === marketSelectionIdentity(book.item) &&
      request.itemId === this.state.selectedItemId;

    if (!requestStillCurrent) {
      this.pumpBookRefresh();
      return;
    }

    const quoteStale = this.isQuoteOlderThan(marketSelectionIdentity(book.item), book.item.bookVersion);
    if (quoteStale) this.clearQuoteWork();

    if (compareMarketIntegers(book.item.bookVersion, request.minimumBookVersion) < 0) {
      this.mergePendingBookRefresh(request.itemId, request.minimumBookVersion);
    }
    if (
      this.pendingBookRefresh?.itemId === request.itemId &&
      compareMarketIntegers(book.item.bookVersion, this.pendingBookRefresh.minimumBookVersion) >= 0
    ) {
      this.pendingBookRefresh = null;
    }

    this.update({
      book,
      bookLoading: this.pendingBookRefresh !== null,
      bookError: null,
      error: this.lastCommand ? this.state.error : null,
      ...(quoteStale
        ? {
            quote: null,
            quoteQuantity: null,
            quoteMaximumUnitPrice: null,
            quoteLoading: false,
            quoteError: null
          }
        : {})
    });
    this.pumpBookRefresh();
  }

  private receiveQuoteResult(requestId: string, quote: MarketQuote): void {
    if (this.ignoredQuoteRequestIds.delete(requestId)) return;
    const request = this.activeQuoteRequest;
    if (
      !request ||
      request.requestId !== requestId ||
      marketQuoteSelectionIdentity(quote) !== request.itemId ||
      quote.requestedQuantity !== request.quantity ||
      quote.requestedMaximumUnitPrice !== request.maximumUnitPrice
    ) return;
    this.clearActiveQuoteRequest();

    const currentBook = this.state.book;
    const requestStillCurrent =
      request.connectionGeneration === this.state.connectionGeneration &&
      request.sessionGeneration === this.state.sessionGeneration &&
      request.sessionId === this.state.snapshot?.sessionId &&
      request.itemId === this.state.selectedItemId &&
      (currentBook ? marketSelectionIdentity(currentBook.item) : null) === request.itemId &&
      this.isSelectedBookFresh();
    if (!requestStillCurrent) {
      this.pumpQuoteRequest();
      return;
    }

    this.quoteRateLimitCount = 0;
    this.quoteRetryNotBefore = 0;
    if (
      currentBook &&
      compareMarketIntegers(quote.bookVersion, currentBook.item.bookVersion) < 0 &&
      !this.pendingQuoteRequest
    ) {
      this.pendingQuoteRequest = {
        itemId: request.itemId,
        quantity: request.quantity,
        maximumUnitPrice: request.maximumUnitPrice
      };
    }
    if (this.pendingQuoteRequest) {
      this.update({ quote: null, quoteLoading: true, quoteError: null });
      this.pumpQuoteRequest();
      return;
    }

    this.update({
      quote,
      quoteLoading: false,
      quoteError: null
    });
  }

  private installSnapshot(snapshot: MarketSnapshot, append: boolean): void {
    const priorItems = append ? this.visibleItems() : [];
    const items = mergeItems(priorItems, snapshot.items).slice(0, MAX_RETAINED_ITEMS);
    const nextSnapshot = { ...snapshot, items };
    const selectedIdentity = this.state.selectedItemId === null
      ? null
      : splitMarketBookKey(this.state.selectedItemId).itemIdentity;
    const selectedStillVisible = items.some((item) => marketSelectionIdentity(item) === selectedIdentity);
    const selectedItemId = selectedStillVisible
      ? this.state.selectedItemId
      : items[0] ? marketSelectionIdentity(items[0]) : null;
    const selectionChanged = selectedItemId !== this.state.selectedItemId;
    const selectedItem = items.find((item) => marketSelectionIdentity(item) === selectedItemId);
    const quoteStale = selectedItem
      ? this.isQuoteOlderThan(marketSelectionIdentity(selectedItem), selectedItem.bookVersion)
      : false;
    if (selectionChanged || quoteStale) this.clearQuoteWork();
    this.update({
      snapshot: nextSnapshot,
      snapshotFresh: true,
      requestState: "ready",
      selectedItemId,
      loading: false,
      loadingMore: false,
      book: selectionChanged ? null : this.state.book,
      bookLoading: false,
      bookError: selectionChanged ? null : this.state.bookError,
      quote: selectionChanged || quoteStale ? null : this.state.quote,
      quoteQuantity: selectionChanged || quoteStale ? null : this.state.quoteQuantity,
      quoteMaximumUnitPrice: selectionChanged || quoteStale
        ? null
        : this.state.quoteMaximumUnitPrice,
      quoteLoading: selectionChanged || quoteStale ? false : this.state.quoteLoading,
      quoteError: selectionChanged || quoteStale ? null : this.state.quoteError,
      pendingMutation:
        this.state.error?.code === "MARKET_RESULT_UNCONFIRMED"
          ? null
          : this.state.pendingMutation,
      error: this.lastCommand ? this.state.error : null
    });
    if (selectedItemId && this.state.active && this.state.connected) {
      this.queueBookRefresh(selectedItemId);
    }
    this.syncSubscriptions();
  }

  private receiveMutationResult(
    requestId: string,
    result: Extract<MarketServerMessage, { type: "MARKET_MUTATION_RESULT" }>['result']
  ): void {
    if (result.requestId !== requestId) return;
    const pendingMatches = this.state.pendingMutation?.requestId === requestId;
    const recoveryMatches = this.lastCommand?.requestId === requestId;
    if (!pendingMatches && !recoveryMatches) return;
    if (this.state.snapshot) {
      this.update({
        snapshot: { ...this.state.snapshot, player: result.player },
        pendingMutation: pendingMatches ? null : this.state.pendingMutation,
        error: null,
        notice: mutationNotice(result.action, result.replayed),
        requestState: "ready"
      });
    } else {
      this.update({
        pendingMutation: pendingMatches ? null : this.state.pendingMutation,
        error: null,
        notice: mutationNotice(result.action, result.replayed),
        requestState: "ready"
      });
    }
    if (this.lastCommand?.requestId === requestId) this.lastCommand = null;
    this.clearMutationConfirmation();
    this.clearQuoteWork();
    this.update({
      quote: null,
      quoteQuantity: null,
      quoteMaximumUnitPrice: null,
      quoteLoading: false,
      quoteError: null
    });
    if (this.state.selectedItemId) this.queueBookRefresh(this.state.selectedItemId);
    this.schedulePlayerRefresh();
  }

  private receiveItemSummary(item: MarketSnapshot["items"][number]): void {
    const snapshot = this.state.snapshot;
    if (!snapshot) return;
    const index = snapshot.items.findIndex((entry) => entry.itemIdentity === item.itemIdentity);
    if (index < 0) return;
    const current = snapshot.items[index]!;
    const goldOrder = compareMarketIntegers(item.bookVersion, current.bookVersion);
    // A Glimmer-only change keeps the Gold version; its Glimmer book version moves.
    const glimmerNewer = goldOrder === 0 &&
      compareMarketIntegers(item.glimmerBookVersion ?? "0", current.glimmerBookVersion ?? "0") > 0;
    if (goldOrder < 0 || (goldOrder === 0 && !glimmerNewer)) return;
    const items = [...snapshot.items];
    items[index] = item;
    const itemSelectionIdentity = marketSelectionIdentity(item);
    const quoteStale = this.isQuoteOlderThan(itemSelectionIdentity, item.bookVersion);
    if (quoteStale) this.clearQuoteWork();
    this.update({
      snapshot: { ...snapshot, items },
      ...(quoteStale
        ? {
            quote: null,
            quoteQuantity: null,
            quoteMaximumUnitPrice: null,
            quoteLoading: false,
            quoteError: null
          }
        : {})
    });

    // A summary contains best-price/volume data, not the matching depth snapshot.
    // Keep the focused book's version unchanged until a full book read arrives so
    // the ordered BOOK_CHANGED notification cannot be suppressed as a duplicate.
    if (this.state.selectedItemId === itemSelectionIdentity) {
      this.receiveBookChanged(itemSelectionIdentity, item.bookVersion);
    }
  }

  private receiveBookChanged(itemId: string, bookVersion: MarketInteger): void {
    if (this.state.selectedItemId !== itemId) return;
    const quoteInvalidated = this.activeQuoteRequest?.itemId === itemId ||
      this.pendingQuoteRequest?.itemId === itemId ||
      this.isQuoteOlderThan(itemId, bookVersion);
    if (quoteInvalidated) {
      this.clearQuoteWork();
      this.update({
        quote: null,
        quoteQuantity: null,
        quoteMaximumUnitPrice: null,
        quoteLoading: false,
        quoteError: {
          requestId: null,
          code: "MARKET_PRICE_CHANGED",
          message: "The available price changed. Check the latest total.",
          retryable: true
        }
      });
    }
    const currentVersion = this.state.book?.item.bookVersion ?? "0";
    if (compareMarketIntegers(bookVersion, currentVersion) <= 0) return;
    this.update({ bookLoading: true, bookError: null });
    this.clearTimer("book");
    this.bookRefreshTimer = setTimeout(() => {
      this.bookRefreshTimer = null;
      if (this.state.active && this.state.connected && this.state.selectedItemId === itemId) {
        this.queueBookRefresh(itemId, bookVersion);
      }
    }, BOOK_REFRESH_DEBOUNCE_MS);
  }

  private receiveError(
    message: Extract<MarketServerMessage, { type: "MARKET_ERROR" }>
  ): void {
    if (this.ignoredQuoteRequestIds.delete(message.requestId)) return;
    const isOpen = this.activeOpenRequest?.requestId === message.requestId;
    const isBrowse = this.activeBrowseRequest?.requestId === message.requestId;
    const isBook = this.activeBookRequest?.requestId === message.requestId;
    const isQuote = this.activeQuoteRequest?.requestId === message.requestId;
    const isMutation = this.state.pendingMutation?.requestId === message.requestId;
    if (isBook) {
      this.receiveBookError(message);
      return;
    }
    if (isQuote) {
      this.receiveQuoteError(message);
      return;
    }
    if (isOpen) {
      this.activeOpenRequest = null;
      this.clearOpenTimeout();
    }
    if (isBrowse) this.activeBrowseRequest = null;
    if (isBrowse) this.clearBrowseTimeout();
    if (isMutation && !message.retryable) this.lastCommand = null;
    if (isMutation) this.clearMutationConfirmation();
    this.update({
      snapshot: isOpen ? null : this.state.snapshot,
      snapshotFresh: isOpen ? false : this.state.snapshotFresh,
      requestState: isOpen || isBrowse || isMutation
        ? "failed"
        : this.state.requestState,
      loading: isBrowse ? false : this.state.loading,
      loadingMore: isBrowse ? false : this.state.loadingMore,
      pendingMutation: isMutation ? null : this.state.pendingMutation,
      error: {
        requestId: message.requestId,
        code: message.code,
        message: marketErrorMessage(message.code, message.message),
        retryable: message.retryable && isMutation
      },
      notice: null
    });
  }

  private requestOpen(): boolean {
    const transport = this.transport();
    const marketStructureId = this.state.marketStructureId;
    const placementRevision = this.state.placementRevision;
    if (
      !this.canSend() ||
      !transport ||
      !marketStructureId ||
      !placementRevision ||
      this.activeOpenRequest
    ) return false;
    const requestId = this.createRequestId();
    const sessionGeneration = this.state.sessionGeneration + 1;
    this.browsedListedOnly = this.browseListedOnly();
    if (!transport.marketOpen(
      requestId,
      marketStructureId,
      placementRevision,
      ...(this.browsedListedOnly ? [{ listedOnly: true }] : [])
    )) {
      return this.offlineFailure();
    }
    this.activeBrowseRequest = null;
    this.clearBrowseTimeout();
    this.activeOpenRequest = {
      requestId,
      marketStructureId,
      placementRevision,
      connectionGeneration: this.state.connectionGeneration,
      sessionGeneration
    };
    this.update({
      sessionGeneration,
      snapshot: null,
      snapshotFresh: false,
      loading: true,
      loadingMore: false,
      requestState: this.state.requestState === "reconnecting"
        ? "reconnecting"
        : "opening",
      error: null,
      notice: null
    });
    this.openTimer = setTimeout(() => {
      if (this.activeOpenRequest?.requestId !== requestId) return;
      this.activeOpenRequest = null;
      this.openTimer = null;
      this.update({
        loading: false,
        requestState: "failed",
        error: {
          requestId,
          code: "MARKET_OPEN_TIMEOUT",
          message: "Opening the Market timed out. Retry from the City Market.",
          retryable: true
        }
      });
    }, this.requestTimeoutMs);
    return true;
  }

  /** Browse shows only items someone is selling; Sell needs every item so owned ones appear. */
  private browseListedOnly(): boolean {
    return this.state.section === "browse";
  }

  private refreshItemsForSection(): void {
    if (this.state.section === "orders" || !this.state.snapshot || this.activeOpenRequest) return;
    if (this.browseListedOnly() === this.browsedListedOnly) return;
    this.clearTimer("search");
    this.requestBrowse(false);
  }

  private requestBrowse(append: boolean, cursor?: string): void {
    const transport = this.transport();
    const sessionId = this.state.snapshot?.sessionId ?? null;
    if (!this.canSend() || !transport?.marketBrowse || !sessionId) return;
    if (this.activeBrowseRequest) {
      this.activeBrowseRequest = null;
      this.clearBrowseTimeout();
    }
    const requestId = this.createRequestId();
    const search = this.state.search.trim();
    const options = {
      ...(search ? { search } : {}),
      ...(this.state.category ? { category: this.state.category } : {}),
      ...(cursor ? { cursor } : {}),
      limit: MARKET_PAGE_SIZE,
      ...(this.browseListedOnly() ? { listedOnly: true } : {})
    };
    this.browsedListedOnly = this.browseListedOnly();
    if (!transport.marketBrowse(requestId, sessionId, options)) {
      this.offlineFailure();
      return;
    }
    this.activeBrowseRequest = {
      requestId,
      append,
      sessionId,
      connectionGeneration: this.state.connectionGeneration,
      sessionGeneration: this.state.sessionGeneration
    };
    this.update({
      loading: !append,
      loadingMore: append,
      requestState: "refreshing",
      error: this.lastCommand ? this.state.error : null,
      notice: null
    });
    this.browseTimer = setTimeout(() => {
      if (this.activeBrowseRequest?.requestId !== requestId) return;
      this.activeBrowseRequest = null;
      this.browseTimer = null;
      this.update({
        loading: false,
        loadingMore: false,
        requestState: "failed",
        error: {
          requestId,
          code: "MARKET_BROWSE_TIMEOUT",
          message: "Refreshing listings timed out. Retry to load current Market state.",
          retryable: true
        }
      });
    }, this.requestTimeoutMs);
  }

  private queueBookRefresh(itemId: string, minimumBookVersion?: MarketInteger): void {
    if (this.state.selectedItemId !== itemId) return;
    const summaryVersion = this.state.snapshot?.items.find(
      (item) => marketSelectionIdentity(item) === itemId
    )?.bookVersion;
    const requiredVersion = minimumBookVersion ?? summaryVersion ?? "0";
    this.mergePendingBookRefresh(itemId, requiredVersion);
    if (!this.state.bookLoading) this.update({ bookLoading: true });
    this.pumpBookRefresh();
  }

  private mergePendingBookRefresh(itemId: string, minimumBookVersion: MarketInteger): void {
    if (this.pendingBookRefresh?.itemId !== itemId) {
      this.pendingBookRefresh = { itemId, minimumBookVersion };
      return;
    }
    if (compareMarketIntegers(minimumBookVersion, this.pendingBookRefresh.minimumBookVersion) > 0) {
      this.pendingBookRefresh = { itemId, minimumBookVersion };
    }
  }

  private pumpBookRefresh(): void {
    if (this.activeBookRequest || !this.pendingBookRefresh) return;
    const transport = this.transport();
    const sessionId = this.state.snapshot?.sessionId ?? null;
    if (!this.canSend() || !transport || !sessionId) return;
    if (this.pendingBookRefresh.itemId !== this.state.selectedItemId) {
      this.pendingBookRefresh = null;
      this.update({ bookLoading: false });
      return;
    }

    const now = Date.now();
    const nextAllowedAt = Math.max(
      this.lastBookRequestAt + BOOK_REFRESH_INTERVAL_MS,
      this.bookRetryNotBefore
    );
    if (now < nextAllowedAt) {
      this.scheduleBookPump(nextAllowedAt - now);
      return;
    }

    const pending = this.pendingBookRefresh;
    const requestId = this.createRequestId();
    const target = splitMarketBookKey(pending.itemId);
    const sent = target.priceCurrency === "glimmer"
      ? transport.marketGetBook(requestId, sessionId, target.itemIdentity, BOOK_DEPTH, "glimmer")
      : transport.marketGetBook(requestId, sessionId, target.itemIdentity, BOOK_DEPTH);
    if (!sent) {
      this.pendingBookRefresh = null;
      this.update({ bookLoading: false, bookError: disconnectedError(requestId) });
      return;
    }
    this.pendingBookRefresh = null;
    this.lastBookRequestAt = now;
    this.activeBookRequest = {
      requestId,
      itemId: pending.itemId,
      sessionId,
      minimumBookVersion: pending.minimumBookVersion,
      connectionGeneration: this.state.connectionGeneration,
      sessionGeneration: this.state.sessionGeneration
    };
    this.update({ bookLoading: true, bookError: null });
    this.clearBookTimeout();
    this.bookTimer = setTimeout(() => {
      const request = this.activeBookRequest;
      if (!request || request.requestId !== requestId) return;
      this.activeBookRequest = null;
      this.bookTimer = null;
      if (
        request.connectionGeneration !== this.state.connectionGeneration ||
        request.sessionGeneration !== this.state.sessionGeneration ||
        request.sessionId !== this.state.snapshot?.sessionId ||
        request.itemId !== this.state.selectedItemId
      ) {
        this.pumpBookRefresh();
        return;
      }
      this.update({
        bookLoading: false,
        bookError: {
          requestId,
          code: "MARKET_BOOK_TIMEOUT",
          message: "Loading this item timed out. Retry to load current listings.",
          retryable: true
        }
      });
    }, this.requestTimeoutMs);
  }

  private scheduleBookPump(delayMs: number): void {
    if (this.bookPumpTimer !== null) clearTimeout(this.bookPumpTimer);
    this.bookPumpTimer = setTimeout(() => {
      this.bookPumpTimer = null;
      this.pumpBookRefresh();
    }, Math.max(0, delayMs));
  }

  private receiveBookError(
    message: Extract<MarketServerMessage, { type: "MARKET_ERROR" }>
  ): void {
    const request = this.activeBookRequest;
    if (!request || request.requestId !== message.requestId) return;
    this.activeBookRequest = null;
    this.clearBookTimeout();
    if (
      request.connectionGeneration !== this.state.connectionGeneration ||
      request.sessionGeneration !== this.state.sessionGeneration ||
      request.sessionId !== this.state.snapshot?.sessionId ||
      request.itemId !== this.state.selectedItemId
    ) {
      this.pumpBookRefresh();
      return;
    }
    const error = {
      requestId: message.requestId,
      code: message.code,
      message: marketErrorMessage(message.code, message.message),
      retryable: message.retryable
    };

    if (message.code === "MARKET_RATE_LIMITED") {
      const backoffIndex = Math.min(this.bookRateLimitCount, MARKET_RATE_LIMIT_BACKOFF_MS.length - 1);
      this.bookRateLimitCount += 1;
      this.bookRetryNotBefore = Date.now() + MARKET_RATE_LIMIT_BACKOFF_MS[backoffIndex]!;
      const summaryVersion = this.state.snapshot?.items.find(
        (item) => marketSelectionIdentity(item) === request.itemId
      )?.bookVersion ?? request.minimumBookVersion;
      this.mergePendingBookRefresh(request.itemId, summaryVersion);
      this.update({ bookLoading: true, bookError: error });
      this.pumpBookRefresh();
      return;
    }

    this.pendingBookRefresh = null;
    this.update({ bookLoading: false, bookError: error });
  }

  private pumpQuoteRequest(): void {
    if (this.activeQuoteRequest || !this.pendingQuoteRequest) return;
    const transport = this.transport();
    const sessionId = this.state.snapshot?.sessionId ?? null;
    const pending = this.pendingQuoteRequest;
    if (
      !this.canSend() ||
      !transport ||
      !sessionId ||
      this.state.section !== "browse" ||
      pending.itemId !== this.state.selectedItemId ||
      this.state.bookLoading ||
      this.state.bookError ||
      !this.isSelectedBookFresh()
    ) {
      this.pendingQuoteRequest = null;
      this.update({ quoteLoading: false });
      return;
    }

    const now = Date.now();
    const nextAllowedAt = Math.max(
      this.lastQuoteRequestAt + QUOTE_REQUEST_INTERVAL_MS,
      this.quoteRetryNotBefore
    );
    if (now < nextAllowedAt) {
      this.scheduleQuotePump(nextAllowedAt - now);
      return;
    }

    const requestId = this.createRequestId();
    const target = splitMarketBookKey(pending.itemId);
    const sent = target.priceCurrency === "glimmer"
      ? transport.marketRequestQuote(
          requestId,
          sessionId,
          target.itemIdentity,
          pending.quantity,
          pending.maximumUnitPrice,
          "glimmer"
        )
      : transport.marketRequestQuote(
          requestId,
          sessionId,
          target.itemIdentity,
          pending.quantity,
          pending.maximumUnitPrice
        );
    if (!sent) {
      this.pendingQuoteRequest = null;
      this.update({
        quoteLoading: false,
        quoteError: disconnectedError(requestId)
      });
      return;
    }
    this.pendingQuoteRequest = null;
    this.lastQuoteRequestAt = now;
    this.activeQuoteRequest = {
      requestId,
      itemId: pending.itemId,
      quantity: pending.quantity,
      maximumUnitPrice: pending.maximumUnitPrice,
      sessionId,
      connectionGeneration: this.state.connectionGeneration,
      sessionGeneration: this.state.sessionGeneration
    };
    this.update({ quoteLoading: true, quoteError: null });
    this.clearQuoteTimeout();
    this.quoteTimer = setTimeout(() => {
      const request = this.activeQuoteRequest;
      if (!request || request.requestId !== requestId) return;
      this.clearActiveQuoteRequest();
      const requestStillCurrent =
        request.connectionGeneration === this.state.connectionGeneration &&
        request.sessionGeneration === this.state.sessionGeneration &&
        request.sessionId === this.state.snapshot?.sessionId &&
        request.itemId === this.state.selectedItemId;
      if (!requestStillCurrent || this.pendingQuoteRequest) {
        this.pumpQuoteRequest();
        return;
      }
      this.update({
        quote: null,
        quoteLoading: false,
        quoteError: {
          requestId,
          code: "MARKET_QUOTE_TIMEOUT",
          message: "Couldn’t load the current price.",
          retryable: true
        }
      });
    }, this.quoteTimeoutMs);
  }

  private scheduleQuotePump(delayMs: number): void {
    if (this.quotePumpTimer !== null) clearTimeout(this.quotePumpTimer);
    this.quotePumpTimer = setTimeout(() => {
      this.quotePumpTimer = null;
      this.pumpQuoteRequest();
    }, Math.max(0, delayMs));
  }

  private receiveQuoteError(
    message: Extract<MarketServerMessage, { type: "MARKET_ERROR" }>
  ): void {
    const request = this.activeQuoteRequest;
    if (!request || request.requestId !== message.requestId) return;
    this.clearActiveQuoteRequest();
    const requestStillCurrent =
      request.connectionGeneration === this.state.connectionGeneration &&
      request.sessionGeneration === this.state.sessionGeneration &&
      request.sessionId === this.state.snapshot?.sessionId &&
      request.itemId === this.state.selectedItemId;
    if (!requestStillCurrent) {
      this.pumpQuoteRequest();
      return;
    }

    const error = {
      requestId: message.requestId,
      code: message.code,
      message: marketErrorMessage(message.code, message.message),
      retryable: message.retryable
    };
    if (message.code === "MARKET_RATE_LIMITED") {
      const backoffIndex = Math.min(this.quoteRateLimitCount, MARKET_RATE_LIMIT_BACKOFF_MS.length - 1);
      this.quoteRateLimitCount += 1;
      this.quoteRetryNotBefore = Date.now() + MARKET_RATE_LIMIT_BACKOFF_MS[backoffIndex]!;
      if (!this.pendingQuoteRequest) {
        this.pendingQuoteRequest = {
          itemId: request.itemId,
          quantity: request.quantity,
          maximumUnitPrice: request.maximumUnitPrice
        };
      }
      this.update({ quote: null, quoteLoading: true, quoteError: error });
      this.pumpQuoteRequest();
      return;
    }

    if (this.pendingQuoteRequest) {
      this.update({ quote: null, quoteLoading: true, quoteError: null });
      this.pumpQuoteRequest();
      return;
    }
    this.update({ quote: null, quoteLoading: false, quoteError: error });
  }

  private beginMutation(command: PendingCommand): boolean {
    if (this.state.pendingMutation) return false;
    if (!this.canMutate()) return this.offlineFailure();
    this.clearQuoteWork();
    this.lastCommand = command;
    this.update({
      quote: null,
      quoteQuantity: null,
      quoteMaximumUnitPrice: null,
      quoteLoading: false,
      quoteError: null,
      pendingMutation: { requestId: command.requestId, label: command.label },
      requestState: mutationRequestState(command),
      error: null,
      notice: null
    });
    if (this.sendPendingCommand(command)) {
      this.scheduleMutationConfirmation();
      return true;
    }
    this.update({ pendingMutation: null, error: disconnectedError(command.requestId) });
    return false;
  }

  private sendPendingCommand(command: PendingCommand): boolean {
    const transport = this.transport();
    const sessionId = this.state.snapshot?.sessionId ?? null;
    if (
      !this.canSend() ||
      !this.state.snapshotFresh ||
      !transport ||
      !sessionId ||
      this.activeOpenRequest ||
      this.activeBrowseRequest
    ) return false;
    switch (command.kind) {
      case "create_order":
        return command.priceCurrency === "glimmer"
          ? transport.marketCreateOrder(
              command.requestId,
              sessionId,
              command.interfaceMode,
              command.side,
              command.itemId,
              command.quantity,
              command.unitPrice,
              "glimmer"
            )
          : transport.marketCreateOrder(
              command.requestId,
              sessionId,
              command.interfaceMode,
              command.side,
              command.itemId,
              command.quantity,
              command.unitPrice
            );
      case "simple_buy":
        return transport.marketSimpleBuy(
          command.requestId,
          sessionId,
          command.quoteId,
          command.maximumTotal
        );
      case "cancel_order":
        return transport.marketCancelOrder(command.requestId, sessionId, command.orderId);
      case "claim":
        return transport.marketClaim(command.requestId, sessionId, command.scope);
      case "create_equipment_listing":
        return (command.priceCurrency === "glimmer"
          ? transport.marketCreateEquipmentListing?.(
              command.requestId,
              sessionId,
              command.equipmentInstanceId,
              command.askingPrice,
              command.expectedEquipmentRevision,
              "glimmer"
            )
          : transport.marketCreateEquipmentListing?.(
              command.requestId,
              sessionId,
              command.equipmentInstanceId,
              command.askingPrice,
              command.expectedEquipmentRevision
            )) ?? false;
      case "purchase_equipment_listing":
        return transport.marketPurchaseEquipmentListing?.(
          command.requestId,
          sessionId,
          command.listingId,
          command.expectedListingVersion,
          command.maximumBuyerTotal,
          command.expectedTaxRevision,
          command.expectedPriceCurrency
        ) ?? false;
      case "cancel_equipment_listing":
        return transport.marketCancelEquipmentListing?.(
          command.requestId,
          sessionId,
          command.listingId,
          command.expectedListingVersion
        ) ?? false;
    }
  }

  private syncSubscriptions(): void {
    if (!this.state.active || !this.state.connected) return;
    this.replaceSubscriptions(
      this.visibleItems().map(marketSelectionIdentity).slice(0, 40),
      this.state.selectedItemId === null
        ? null
        : splitMarketBookKey(this.state.selectedItemId).itemIdentity,
      true
    );
  }

  private replaceSubscriptions(
    visibleItemIds: string[],
    focusedItemId: string | null,
    privateState: boolean
  ): void {
    const transport = this.transport();
    const sessionId = this.state.snapshot?.sessionId ?? null;
    if (!this.state.connected || !transport || !sessionId) return;
    const revision = this.state.subscriptionRevision + 1;
    const sent = transport.marketSetSubscriptions(
      this.createRequestId(),
      sessionId,
      visibleItemIds,
      focusedItemId,
      privateState,
      revision
    );
    if (sent) this.update({ subscriptionRevision: revision });
  }

  private schedulePlayerRefresh(): void {
    if (!this.state.active || !this.state.connected) return;
    this.clearTimer("player");
    this.playerRefreshTimer = setTimeout(() => {
      this.playerRefreshTimer = null;
      this.requestBrowse(false);
    }, 120);
  }

  private scheduleMutationConfirmation(): void {
    this.clearMutationConfirmation();
    if (!this.state.pendingMutation || !this.lastCommand) return;
    this.mutationConfirmationTimer = setTimeout(() => {
      this.mutationConfirmationTimer = null;
      const command = this.lastCommand;
      if (!command || this.state.pendingMutation?.requestId !== command.requestId) return;
      this.update({
        pendingMutation: this.state.pendingMutation,
        requestState: "failed",
        error: unconfirmedMutationError(command.requestId)
      });
      this.requestBrowse(false);
    }, 12_000);
  }

  private clearMutationConfirmation(): void {
    if (this.mutationConfirmationTimer !== null) {
      clearTimeout(this.mutationConfirmationTimer);
      this.mutationConfirmationTimer = null;
    }
  }

  private clearQuoteTimeout(): void {
    if (this.quoteTimer !== null) clearTimeout(this.quoteTimer);
    this.quoteTimer = null;
  }

  private clearActiveQuoteRequest(ignoreResponse = false): void {
    if (ignoreResponse && this.activeQuoteRequest) {
      this.ignoredQuoteRequestIds.add(this.activeQuoteRequest.requestId);
      if (this.ignoredQuoteRequestIds.size > 32) {
        const oldestRequestId = this.ignoredQuoteRequestIds.values().next().value;
        if (oldestRequestId) this.ignoredQuoteRequestIds.delete(oldestRequestId);
      }
    }
    this.activeQuoteRequest = null;
    this.clearQuoteTimeout();
  }

  private clearQuoteWork(): void {
    this.clearActiveQuoteRequest(true);
    if (this.quotePumpTimer !== null) clearTimeout(this.quotePumpTimer);
    this.quotePumpTimer = null;
    this.pendingQuoteRequest = null;
  }

  private resetQuoteWork(): void {
    this.clearQuoteWork();
    this.lastQuoteRequestAt = -QUOTE_REQUEST_INTERVAL_MS;
    this.quoteRetryNotBefore = 0;
    this.quoteRateLimitCount = 0;
  }

  private visibleItems(): MarketSnapshot["items"] {
    return this.state.snapshot?.items ?? [];
  }

  private isQuoteOlderThan(itemId: string, bookVersion: MarketInteger): boolean {
    const quote = this.state.quote;
    return quote !== null && marketQuoteSelectionIdentity(quote) === itemId &&
      compareMarketIntegers(quote.bookVersion, bookVersion) < 0;
  }

  private canSend(): boolean {
    return this.state.active && this.state.connected;
  }

  private canMutate(): boolean {
    const sessionId = this.state.snapshot?.sessionId ?? null;
    return this.canSend() &&
      this.state.requestState === "ready" &&
      this.state.snapshotFresh &&
      sessionId !== null &&
      !this.activeOpenRequest &&
      !this.activeBrowseRequest;
  }

  private offlineFailure(): false {
    this.update({ error: disconnectedError(null) });
    return false;
  }

  private clearTimer(kind: "search" | "book" | "player"): void {
    const timer = kind === "search"
      ? this.searchTimer
      : kind === "book"
        ? this.bookRefreshTimer
        : this.playerRefreshTimer;
    if (timer !== null) clearTimeout(timer);
    if (kind === "search") this.searchTimer = null;
    else if (kind === "book") this.bookRefreshTimer = null;
    else this.playerRefreshTimer = null;
  }

  private clearOpenTimeout(): void {
    if (this.openTimer !== null) clearTimeout(this.openTimer);
    this.openTimer = null;
  }

  private clearBrowseTimeout(): void {
    if (this.browseTimer !== null) clearTimeout(this.browseTimer);
    this.browseTimer = null;
  }

  private clearBookTimeout(): void {
    if (this.bookTimer !== null) clearTimeout(this.bookTimer);
    this.bookTimer = null;
  }

  private clearBookWork(): void {
    this.clearTimer("book");
    if (this.bookPumpTimer !== null) clearTimeout(this.bookPumpTimer);
    this.bookPumpTimer = null;
    this.clearBookTimeout();
    this.activeBookRequest = null;
    this.pendingBookRefresh = null;
    this.lastBookRequestAt = -BOOK_REFRESH_INTERVAL_MS;
    this.bookRetryNotBefore = 0;
    this.bookRateLimitCount = 0;
  }

  private update(patch: Partial<MarketViewState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}

function isMarketServerMessage(message: ServerMessage): message is MarketServerMessage {
  return message.type.startsWith("MARKET_");
}

function mergeItems(
  current: MarketSnapshot["items"],
  incoming: MarketSnapshot["items"]
): MarketSnapshot["items"] {
  const byId = new Map(current.map((item) => [item.itemIdentity, item]));
  for (const item of incoming) byId.set(item.itemIdentity, item);
  return [...byId.values()];
}

// A selection names one book: the item identity, plus a suffix for its Glimmer
// book. Gold keys stay the bare identity, as before.
const GLIMMER_BOOK_KEY_SUFFIX = "#glimmer";

export function marketBookKey(itemIdentity: string, priceCurrency: MarketPriceCurrency = "gold"): string {
  return priceCurrency === "glimmer" ? `${itemIdentity}${GLIMMER_BOOK_KEY_SUFFIX}` : itemIdentity;
}

export function splitMarketBookKey(key: string): { itemIdentity: string; priceCurrency: MarketPriceCurrency } {
  return key.endsWith(GLIMMER_BOOK_KEY_SUFFIX)
    ? { itemIdentity: key.slice(0, -GLIMMER_BOOK_KEY_SUFFIX.length), priceCurrency: "glimmer" }
    : { itemIdentity: key, priceCurrency: "gold" };
}

function marketSelectionIdentity(item: MarketSnapshot["items"][number]): string {
  return marketBookKey(item.itemIdentity, item.priceCurrency ?? "gold");
}

function marketQuoteSelectionIdentity(quote: MarketQuote): string {
  return marketBookKey(quote.itemIdentity, quote.priceCurrency ?? "gold");
}

function mutationNotice(
  action: Extract<MarketServerMessage, { type: "MARKET_MUTATION_RESULT" }>['result']['action'],
  replayed: boolean
): string {
  const suffix = replayed ? " The original committed result was recovered." : "";
  switch (action) {
    case "create_order":
      return `Order confirmed.${suffix}`;
    case "simple_buy":
      return `Purchase confirmed. Items were delivered to Inventory.${suffix}`;
    case "cancel_order":
      return `Cancellation confirmed. Remaining escrow was returned immediately.${suffix}`;
    case "claim":
      return `Collection claim confirmed.${suffix}`;
    case "create_equipment_listing":
      return `Equipment listing confirmed.${suffix}`;
    case "purchase_equipment_listing":
      return `Equipment purchase confirmed. Claim it from this Market.${suffix}`;
    case "cancel_equipment_listing":
      return `Equipment listing cancelled. Claim it from this Market.${suffix}`;
  }
}

function marketErrorMessage(code: string, message: string): string {
  if (
    code === "MARKET_QUOTE_EXPIRED" ||
    code === "MARKET_QUOTE_STALE" ||
    code === "MARKET_PRICE_CHANGED"
  ) {
    return "Price or availability changed. No purchase was made; request a fresh quote.";
  }
  if (code === "MARKET_NOT_ENOUGH_ITEMS") {
    return "Your available inventory changed before the listing could be placed. Refresh and try a smaller quantity.";
  }
  if (code === "MARKET_NOT_ENOUGH_GOLD" || code === "MARKET_INSUFFICIENT_FUNDS" || code === "WALLET_INSUFFICIENT_FUNDS") {
    return "Your confirmed wallet balance is too low for this order. No gold was moved.";
  }
  if (code === "MARKET_BUSY" || code === "MARKET_RATE_LIMITED") {
    return "The exchange is handling heavy traffic. Wait a moment, then try again.";
  }
  if (
    code === "MARKET_READ_ONLY" ||
    code === "MARKET_MUTATIONS_DISABLED" ||
    code === "MARKET_NEW_ORDERS_DISABLED" ||
    code === "MARKET_MATCHING_DISABLED" ||
    code === "MARKET_CANCELLATIONS_DISABLED" ||
    code === "MARKET_CLAIMS_DISABLED" ||
    code === "MARKET_VENUE_FROZEN" ||
    code === "MARKET_PLAYER_FROZEN" ||
    code === "MARKET_ITEM_FROZEN"
  ) {
    return "Trading is temporarily paused. Browsing remains available.";
  }
  if (code === "MARKET_ORDER_ALREADY_CLOSED" || code === "MARKET_ORDER_NOT_FOUND") {
    return "That order changed before the request completed. Refresh to see its latest status.";
  }
  if (code === "MARKET_ACCESS_DENIED") {
    return message.trim().length > 0
      ? message
      : "Market access is not available for this account or location.";
  }
  return message.trim().length > 0 && !/exception|stack|sql|internal/i.test(message)
    ? message
    : "The exchange could not complete that request. No local result was applied.";
}

function disconnectedError(requestId: string | null): MarketClientError {
  return {
    requestId,
    code: "MARKET_DISCONNECTED",
    message: "Market connection is unavailable. No local result was applied.",
    retryable: false
  };
}

function unconfirmedMutationError(requestId: string): MarketClientError {
  return {
    requestId,
    code: "MARKET_RESULT_UNCONFIRMED",
    message: "The server result is unconfirmed. Retry the same request manually to recover committed truth.",
    retryable: true
  };
}

export function marketMutationChangesInventory(result: MarketMutationResult): boolean {
  return (result.action === "claim" && BigInt(result.claimedItems) > 0n) ||
    (result.action === "create_order" && result.order?.side === "sell");
}

function mutationRequestState(command: PendingCommand): MarketRequestState {
  switch (command.kind) {
    case "simple_buy":
    case "purchase_equipment_listing":
      return "purchasing";
    case "create_order":
    case "create_equipment_listing":
      return "creating_listing";
    case "cancel_order":
    case "cancel_equipment_listing":
      return "canceling_listing";
    case "claim":
      return "loading";
  }
}
