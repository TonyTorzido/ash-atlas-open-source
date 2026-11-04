import { Component, Fragment, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ErrorInfo, ReactNode } from "react";
import {
  parseEquipmentEnhancement,
  equipmentEffectDisplayName,
  equipmentMetalDisplayName,
  requireEquipmentDefinition,
  type EquipmentInstanceV2,
  type EquipmentSnapshotV2,
  PREMIUM_CURRENCIES,
  type MarketEquipmentListingSnapshot,
  type MarketPriceCurrency,
  type PlayerInventorySnapshot,
  type PremiumWalletSnapshot
} from "@ash-atlas/shared";

import type {
  MarketController,
  MarketSection,
  MarketSort
} from "../market/marketController.js";
import { marketBookKey, splitMarketBookKey } from "../market/marketController.js";
import { readMarketDevelopmentFixture } from "../market/marketDevelopmentFixture.js";
import { formatGold, formatPrice } from "../market/marketFormat.js";
import { MarketCollectionView, MarketOrdersView } from "./market/MarketAccountViews.js";
import { MarketCatalog } from "./market/MarketCatalog.js";
import { MarketNumberInput, MarketNumberPadProvider } from "./market/MarketNumberPad.js";
import {
  PriceCurrencyToggle,
  StandardMarketBrowseView,
  StandardMarketSellView
} from "./market/MarketTradingViews.js";
import { bugReportDiagnostics } from "../diagnostics/bugReportDiagnostics.js";
import { InscriptionDetails } from "./InscriptionDetails.js";
import { ItemArtwork } from "./ItemArtwork.js";
import { RingBonusLines, ringBonusSummary } from "./RingBonusLines.js";
import { ringBonusPresentation, ringViewBonusPresentation } from "../inventory/ringPresentation.js";
import { GameAppActionBar, GameAppShell, GameAppTabs } from "./GameAppShell.js";

type MarketOverlayProps = {
  open: boolean;
  controller: MarketController;
  keepActive?: boolean;
  connectionStatus: "offline" | "connecting" | "online";
  inventory: PlayerInventorySnapshot;
  equipment?: EquipmentSnapshotV2 | null;
  hasInventorySnapshot: boolean;
  walletGold: string | null;
  /** Glimmer balance; it trades from the premium wallet, not inventory. */
  premiumBalances?: PremiumWalletSnapshot["balances"] | null;
  layout?: "desktop" | "phone";
  onClose(): void;
};

type MarketPrimaryTab = "browse" | "sell" | "orders";
type MarketPhoneRoute = "list" | "detail";
type MarketSellCategory = "resource" | "consumable" | "currency" | "equipment";

export class MarketErrorBoundary extends Component<{
  children: ReactNode;
  resetKey: string;
  onClose(): void;
}, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    bugReportDiagnostics.recordError({
      category: "react_error_boundary",
      name: error.name,
      message: error.message,
      stack: error.stack ?? info.componentStack ?? null,
      component: "city-market"
    });
  }

  override componentDidUpdate(previous: Readonly<{ resetKey: string }>): void {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) {
      this.setState({ failed: false });
    }
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <section className="destination-empty-state market-error-boundary" role="alert">
        <h3>City Market unavailable</h3>
        <p>The Market panel could not be displayed. Gameplay remains available.</p>
        <button type="button" onClick={this.props.onClose}>Return to Game</button>
      </section>
    );
  }
}

export function MarketOverlay({
  open,
  controller,
  keepActive = false,
  connectionStatus,
  inventory,
  equipment = null,
  hasInventorySnapshot,
  walletGold,
  premiumBalances = null,
  layout = "desktop",
  onClose
}: MarketOverlayProps): React.JSX.Element | null {
  const [phoneRoute, setPhoneRoute] = useState<MarketPhoneRoute>("list");
  const [browseEquipment, setBrowseEquipment] = useState(false);
  const [sellCategory, setSellCategory] = useState<MarketSellCategory>("resource");
  const [selectedEquipmentListingId, setSelectedEquipmentListingId] = useState<string | null>(null);
  const [selectedEquipmentInstanceId, setSelectedEquipmentInstanceId] = useState<string | null>(null);
  const contentRef = useRef<HTMLElement>(null);
  const listScrollTop = useRef(0);
  const controllerState = useSyncExternalStore(
    controller.subscribe,
    controller.getState,
    controller.getState
  );
  const fixture = readMarketDevelopmentFixture();
  const state = fixture ? {
    ...controllerState,
    marketStructureId: fixture.snapshot.venue.marketStructureId,
    connected: true,
    snapshotFresh: true,
    loading: false,
    loadingMore: false,
    snapshot: fixture.snapshot,
    selectedItemId: fixture.book.item.itemIdentity,
    book: fixture.book,
    bookLoading: false,
    bookError: null,
    quote: fixture.quote,
    quoteQuantity: fixture.quote?.requestedQuantity ?? null,
    quoteMaximumUnitPrice: fixture.quote?.requestedMaximumUnitPrice ?? null,
    quoteLoading: false,
    quoteError: null,
    pendingMutation: null,
    error: null,
    notice: null
  } : controllerState;

  useEffect(() => {
    if (!open) {
      if (keepActive) controller.activate();
      else controller.deactivate();
      return () => {
        if (keepActive) controller.deactivate();
      };
    }
    controller.activate();
    return () => {
      if (!keepActive) controller.deactivate();
    };
  }, [controller, keepActive, open]);

  useEffect(() => {
    if (!open) return;
    setPhoneRoute("list");
    setBrowseEquipment(false);
    setSelectedEquipmentListingId(null);
    setSelectedEquipmentInstanceId(null);
  }, [open]);

  // Phone list and detail are separate routes; keep the list where the player left it.
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    if (phoneRoute === "detail") {
      content.scrollTop = 0;
      return;
    }
    const catalog = content.querySelector<HTMLElement>(".market-catalog");
    if (catalog) catalog.scrollTop = listScrollTop.current;
  }, [phoneRoute]);

  if (!open) return null;

  const snapshot = state.snapshot;
  const controls = snapshot?.controls ?? null;
  const selectedBook = state.selectedItemId === null ? null : splitMarketBookKey(state.selectedItemId);
  const selectedIdentity = selectedBook?.itemIdentity ?? null;
  const selectedPriceCurrency = selectedBook?.priceCurrency ?? "gold";
  const items = fixture ? fixture.snapshot.items : controller.sortedItems();
  const visibleInventory = withPremiumHoldings(fixture?.inventory ?? inventory, premiumBalances);
  const pending = state.pendingMutation !== null;
  // A background refresh (e.g. after one of your orders fills) keeps the panel usable;
  // the server still validates every action.
  const marketReady =
    state.connected &&
    state.snapshotFresh &&
    (state.requestState === "ready" || (state.requestState === "refreshing" && state.snapshot !== null));
  const selectedBookReady = fixture
    ? true
    : state.connected &&
      state.snapshotFresh &&
      controller.isSelectedBookFresh() &&
      !state.bookLoading &&
      !state.bookError;
  const eligibleEquipment = eligibleMarketEquipment(equipment);
  const selectedEquipmentListing = snapshot?.equipmentListings.find(
    (listing) => listing.status === "open" && listing.listingId === selectedEquipmentListingId
  ) ?? null;
  const selectedEquipmentInstance = eligibleEquipment.find(
    (instance) => instance.instanceId === selectedEquipmentInstanceId
  ) ?? null;

  const primaryTab: MarketPrimaryTab = state.section === "browse"
    ? "browse"
    : state.section === "gear"
      ? "sell"
      : "orders";
  const orderTab = state.section === "collection"
    ? "collection"
    : state.section === "recent"
      ? "recent"
      : "orders";
  const title = snapshot?.venue.cityName ? `${snapshot.venue.cityName} Market` : "City Market";
  const openPhoneDetail = (): void => {
    if (layout !== "phone") return;
    listScrollTop.current = contentRef.current?.querySelector<HTMLElement>(".market-catalog")?.scrollTop ?? 0;
    setPhoneRoute("detail");
  };
  const phoneBack = (): void => {
    if (layout === "phone" && phoneRoute === "detail") {
      setPhoneRoute("list");
      return;
    }
    onClose();
  };
  const setPrimaryTab = (id: string): void => {
    const next = id as MarketPrimaryTab;
    controller.setSection(next === "sell" ? "gear" : next === "orders" ? "orders" : "browse");
    if (next === "sell" && sellCategory !== "equipment") controller.setCategory(sellCategory);
    listScrollTop.current = 0;
    setPhoneRoute("list");
    setBrowseEquipment(false);
    setSelectedEquipmentListingId(null);
    setSelectedEquipmentInstanceId(null);
  };
  const selectBrowseCategory = (category: string | null): void => {
    setBrowseEquipment(category === "equipment");
    setSelectedEquipmentListingId(null);
    if (category !== "equipment") controller.setCategory(category);
  };
  const selectStandardItem = (itemId: string): void => {
    controller.selectItem(itemId);
    openPhoneDetail();
  };

  const feedback = state.pendingMutation || state.error || state.notice ? (
    <GameAppActionBar>
      <div className="market-feedback" aria-live="polite">
        {state.pendingMutation ? (
          <div className="market-feedback-pending">
            <span className="market-ledger-progress" aria-hidden="true"><i /><i /><i /></span>
            <div><strong>{state.pendingMutation.label}…</strong></div>
          </div>
        ) : state.error ? (
          <div className="market-feedback-error">
            <div><strong>{state.error.message}</strong></div>
            {state.error.retryable ? <button type="button" onClick={() => controller.retryLastMutation()}>Retry</button> : null}
            <button type="button" onClick={() => controller.clearFeedback()}>Dismiss</button>
          </div>
        ) : (
          <div className="market-feedback-success">
            <strong>{state.notice}</strong>
            <button type="button" onClick={() => controller.clearFeedback()}>Dismiss</button>
          </div>
        )}
      </div>
    </GameAppActionBar>
  ) : null;

  const NumberPadScope = layout === "phone" ? MarketNumberPadProvider : Fragment;
  return (
    <GameAppShell
      open={open}
      title={title}
      closeLabel="Close Market"
      className="market-app"
      layout={layout}
      headerAction={<MarketHeaderStatus
        state={state}
        snapshot={snapshot}
        connectionStatus={connectionStatus}
        walletGold={walletGold}
        loading={state.loading}
        onRefresh={() => controller.refresh()}
      />}
      phoneBackLabel={phoneRoute === "detail" ? "Back to items" : "Back to Game"}
      phoneOnBack={phoneBack}
      phoneOnReturnToGame={onClose}
      footer={layout === "desktop" ? feedback : undefined}
      onClose={onClose}
    >
      <NumberPadScope>
      <div className="market-app-navigation">
        <GameAppTabs
          variant="housed"
          ariaLabel="Market section"
          activeTab={primaryTab}
          onChange={setPrimaryTab}
          tabs={[
            { id: "browse", label: "Browse" },
            { id: "sell", label: "Sell" },
            { id: "orders", label: "Orders", ...(snapshot?.player.activeOrders.length ? { badge: String(snapshot.player.activeOrders.length) } : {}) }
          ]}
        />
      </div>
        <MarketStateBanner state={state} connectionStatus={connectionStatus} />
        <main
          ref={contentRef}
          className="market-content"
          data-market-tab={primaryTab}
          data-market-route={phoneRoute}
          aria-busy={state.loading || pending}
        >
          {!state.marketStructureId ? (
            <div className="market-loading-state market-visit-state">
              <strong>Travel to a City Market to trade.</strong>
              <button type="button" onClick={onClose}>Return to Game</button>
            </div>
          ) : !snapshot ? (
            <div className="market-loading-state">
              <span className="market-loading-orbit" aria-hidden="true" />
              <strong>Opening the Market…</strong>
              {!state.connected ? <button type="button" onClick={() => controller.refresh()}>Retry when connected</button> : null}
            </div>
          ) : primaryTab === "browse" ? (
            <>
              {(layout === "desktop" || phoneRoute === "list") ? <MarketBrowseControls
                  search={state.search}
                  category={state.category}
                  equipmentSelected={browseEquipment}
                  categories={snapshot.categories}
                  sort={state.sort}
                  loading={state.loading}
                  onSearch={controller.setSearch.bind(controller)}
                  onCategory={selectBrowseCategory}
                  onSort={controller.setSort.bind(controller)}
                /> : null}
              <div className="market-browse-layout">
                {(layout === "desktop" || phoneRoute === "list") ? <MarketCatalog
                  items={items}
                  inventory={visibleInventory}
                  hasInventorySnapshot={fixture ? true : hasInventorySnapshot}
                  selectedItemId={selectedIdentity}
                  loading={state.loading}
                  hasMore={Boolean(snapshot.nextCursor) && snapshot.items.length < 40}
                  loadingMore={state.loadingMore}
                  paginationKey={`${state.search}\u001f${state.category ?? "all"}\u001f${state.sort}\u001f${browseEquipment ? "equipment" : "standard"}`}
                  showGear={browseEquipment}
                  hideStandardItems={browseEquipment}
                  equipmentListings={snapshot.equipmentListings}
                  ownPlayerId={visibleInventory.playerId}
                  activeOrders={snapshot.player.activeOrders}
                  selectedEquipmentListingId={selectedEquipmentListingId}
                  onSelect={selectStandardItem}
                  onLoadMore={() => controller.loadMore()}
                  onSelectEquipment={(listing) => {
                    setSelectedEquipmentListingId(listing.listingId);
                    openPhoneDetail();
                  }}
                /> : null}
                {controls && !browseEquipment && (layout === "desktop" || phoneRoute === "detail") ? (
                  <StandardMarketBrowseView
                    key={`browse:${state.selectedItemId ?? "none"}`}
                    book={state.book}
                    bookLoading={state.bookLoading}
                    bookError={state.bookError}
                    bookReady={selectedBookReady}
                    connected={marketReady}
                    controls={controls}
                    feePolicy={snapshot.feePolicy}
                    walletGold={walletGold ?? "0"}
                    inventory={visibleInventory}
                    hasInventorySnapshot={fixture ? true : hasInventorySnapshot}
                    pending={pending}
                    priceCurrency={selectedPriceCurrency}
                    glimmerBalance={premiumBalances?.glimmer.balance ?? null}
                    onPriceCurrency={fixture ? undefined : (currency) => controller.setPriceCurrency(currency)}
                    quote={state.quote}
                    quoteQuantity={state.quoteQuantity}
                    quoteMaximumUnitPrice={state.quoteMaximumUnitPrice}
                    quoteLoading={state.quoteLoading}
                    quoteError={state.quoteError}
                    onInvalidateQuote={() => fixture ? undefined : controller.invalidateQuote()}
                    onRequestQuote={(itemId, quantity, maximumUnitPrice) =>
                      fixture ? false : controller.requestQuote(marketBookKey(itemId, selectedPriceCurrency), quantity, maximumUnitPrice)}
                    onConfirmBuy={() => fixture ? false : controller.submitSimpleBuy()}
                    onRetryBook={() => fixture ? undefined : controller.retryBook()}
                    onCreateOrder={(mode, side, itemId, quantity, unitPrice, priceCurrency) =>
                      fixture ? false : controller.submitCreateOrder(mode, side, itemId, quantity, unitPrice, priceCurrency)}
                  />
                ) : null}
                {browseEquipment && (layout === "desktop" || phoneRoute === "detail") ? (
                  <MarketEquipmentListingDetail
                    key={selectedEquipmentListing?.listingId ?? "none"}
                    listing={selectedEquipmentListing}
                    ownPlayerId={visibleInventory.playerId}
                    walletGold={walletGold ?? "0"}
                    glimmerBalance={premiumBalances?.glimmer.balance ?? "0"}
                    connected={marketReady}
                    pending={pending}
                    onPurchase={(listing) => fixture ? false : controller.purchaseEquipmentListing(
                      listing.listingId,
                      listing.version,
                      listing.buyerTotal,
                      snapshot.venue.taxRevision,
                      listing.priceCurrency ?? "gold"
                    )}
                    onCancel={(listing) => fixture ? false : controller.cancelEquipmentListing(
                      listing.listingId,
                      listing.version
                    )}
                  />
                ) : null}
              </div>
            </>
          ) : primaryTab === "sell" ? (
            <>
              {(layout === "desktop" || phoneRoute === "list") ? <section className="market-sell-selector" aria-label="Sell categories">
                <GameAppTabs
                  variant="subtabs"
                  ariaLabel="Sell category"
                  activeTab={sellCategory}
                  onChange={(id) => {
                    const category = id as MarketSellCategory;
                    setSellCategory(category);
                    setSelectedEquipmentInstanceId(null);
                    if (category !== "equipment") controller.setCategory(category);
                  }}
                  tabs={[
                    { id: "resource", label: "Resources" },
                    { id: "consumable", label: "Consumables" },
                    { id: "currency", label: "Currency" },
                    { id: "equipment", label: "Equipment" }
                  ]}
                />
              </section> : null}
              <div className="market-sell-layout">
                {sellCategory !== "equipment" && (layout === "desktop" || phoneRoute === "list") ? <MarketCatalog
                  items={items.filter((item) => item.category === sellCategory)}
                  inventory={visibleInventory}
                  hasInventorySnapshot={fixture ? true : hasInventorySnapshot}
                  selectedItemId={selectedIdentity}
                  loading={state.loading}
                  hasMore={false}
                  loadingMore={false}
                  ownedOnly
                  onSelect={selectStandardItem}
                  onLoadMore={() => undefined}
                /> : null}
              {controls && sellCategory !== "equipment" && (layout === "desktop" || phoneRoute === "detail") ? (
                <StandardMarketSellView
                  key={`sell:${selectedIdentity ?? "none"}`}
                  book={state.book}
                  bookLoading={state.bookLoading}
                  bookError={state.bookError}
                  bookReady={selectedBookReady}
                  connected={marketReady}
                  controls={controls}
                  feePolicy={snapshot.feePolicy}
                  walletGold={walletGold ?? "0"}
                  inventory={visibleInventory}
                  hasInventorySnapshot={fixture ? true : hasInventorySnapshot}
                  pending={pending}
                  activeOrders={snapshot.player.activeOrders}
                  priceCurrency={selectedPriceCurrency}
                  onPriceCurrency={fixture ? undefined : (currency) => controller.setPriceCurrency(currency)}
                  onCancelOrder={(orderId) =>
                    fixture ? false : controller.cancelOrder(orderId)}
                  onRetryBook={() => fixture ? undefined : controller.retryBook()}
                  onCreateOrder={(mode, side, itemId, quantity, unitPrice, priceCurrency) =>
                    fixture
                      ? false
                      : controller.submitCreateOrder(
                          mode,
                          side,
                          itemId,
                          quantity,
                          unitPrice,
                          priceCurrency
                        )}
                />
              ) : null}
              {sellCategory === "equipment" && (layout === "desktop" || phoneRoute === "list") ? <EquipmentSellList
                equipment={equipment}
                selectedInstanceId={selectedEquipmentInstanceId}
                onSelect={(instance) => {
                  setSelectedEquipmentInstanceId(instance.instanceId);
                  openPhoneDetail();
                }}
              /> : null}
              {sellCategory === "equipment" && (layout === "desktop" || phoneRoute === "detail") ? (
                selectedEquipmentInstance ? <EquipmentSellCard
                  key={selectedEquipmentInstance.instanceId}
                  instance={selectedEquipmentInstance}
                  disabled={!marketReady || pending}
                  onList={(instanceId, price, priceCurrency) => equipment
                    ? controller.createEquipmentListing(instanceId, price, String(equipment.inventoryRevision), priceCurrency)
                    : false}
                /> : <MarketEquipmentPlaceholder message="Choose an item to list." />
              ) : null}
              </div>
            </>
          ) : (
            <>
              <div className="market-orders-navigation">
                <GameAppTabs
                  variant="subtabs"
                  ariaLabel="Order view"
                  activeTab={orderTab}
                  onChange={(id) => controller.setSection(id as MarketSection)}
                  tabs={[
                    { id: "orders", label: "Active", ...(snapshot.player.activeOrders.length ? { badge: String(snapshot.player.activeOrders.length) } : {}) },
                    { id: "collection", label: "Collect", ...(hasCollection(snapshot) ? { badge: "•" } : {}) },
                    { id: "recent", label: "History" }
                  ]}
                />
              </div>
              <div className="market-orders-content">
                {state.section === "orders" ? <>
                  <MarketOwnEquipmentListings
                    listings={snapshot.equipmentListings}
                    ownPlayerId={visibleInventory.playerId}
                    canCancel={marketReady && !pending && snapshot.controls.accessAllowed &&
                      !snapshot.controls.readOnly && snapshot.controls.cancellationsEnabled &&
                      !snapshot.controls.venueFrozen && !snapshot.controls.playerFrozen}
                    onCancel={(listing) => fixture ? false : controller.cancelEquipmentListing(
                      listing.listingId,
                      listing.version
                    )}
                  />
                  <MarketOrdersView
                    player={snapshot.player}
                    controls={snapshot.controls}
                    connected={marketReady}
                    pending={pending}
                    view="active"
                    onCancel={(orderId) => controller.cancelOrder(orderId)}
                  />
                </> : state.section === "collection" ? (
                  <MarketCollectionView
                    player={snapshot.player}
                    controls={snapshot.controls}
                    connected={marketReady}
                    pending={pending}
                    onClaim={(scope) => controller.claim(scope)}
                  />) : (
                  <MarketOrdersView
                    player={snapshot.player}
                    controls={snapshot.controls}
                    connected={marketReady}
                    pending={pending}
                    view="history"
                    onCancel={(orderId) => controller.cancelOrder(orderId)}
                  />
                )}
              </div>
            </>
          )}
        </main>
        {layout === "phone" ? feedback : null}
      </NumberPadScope>
    </GameAppShell>
  );
}

function MarketHeaderStatus({ state, snapshot, connectionStatus, walletGold, loading, onRefresh }: {
  state: ReturnType<MarketController["getState"]>;
  snapshot: ReturnType<MarketController["getState"]>["snapshot"];
  connectionStatus: MarketOverlayProps["connectionStatus"];
  walletGold: string | null;
  loading: boolean;
  onRefresh(): void;
}): React.JSX.Element {
  const [refreshAcknowledged, setRefreshAcknowledged] = useState(false);
  const refreshTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
  }, []);
  const taxPercent = snapshot ? snapshot.venue.standardBuyerTaxBps / 100 : null;
  const activeSpecialties = snapshot?.venue.activeMonumentTypes ?? [];
  const specialtyTax = activeSpecialties.length > 0 && snapshot
    ? `${snapshot.venue.specialtyBuyerTaxBps / 100}% ${activeSpecialties.map(formatSpecialtyName).join(", ")}`
    : null;
  return <div className="market-header-status">
    <span className={`market-connection market-connection-${connectionStatus}`} aria-label={`Market connection ${marketReadinessLabel(state, connectionStatus)}`} />
    {snapshot ? <div className="market-header-ledger" aria-label={`Market buyer tax ${taxPercent}%${specialtyTax ? `. Specialty buyer tax ${specialtyTax}` : ""}`}>
      <span>Tax</span><strong>{taxPercent}%</strong>
      {specialtyTax ? <span className="sr-only">Specialty buyer tax {specialtyTax}</span> : null}
    </div> : null}
    <div className="market-header-ledger" aria-label={walletGold === null ? "Wallet loading" : `Wallet balance ${formatGold(walletGold)}`}><span>Wallet</span><strong>{walletGold === null ? "…" : formatGold(walletGold)}</strong></div>
    <button
      type="button"
      className={`market-refresh-compact${refreshAcknowledged ? " acknowledged" : ""}`}
      aria-label="Refresh Market"
      disabled={loading}
      onClick={() => {
        setRefreshAcknowledged(true);
        if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
        refreshTimer.current = window.setTimeout(() => {
          setRefreshAcknowledged(false);
          refreshTimer.current = null;
        }, 600);
        onRefresh();
      }}
    >↻</button>
  </div>;
}

function MarketOwnEquipmentListings({ listings, ownPlayerId, canCancel, onCancel }: {
  listings: MarketEquipmentListingSnapshot[];
  ownPlayerId: string;
  canCancel: boolean;
  onCancel(listing: MarketEquipmentListingSnapshot): boolean;
}): React.JSX.Element | null {
  const [selectedListingId, setSelectedListingId] = useState<string | null>(null);
  const ownListings = listings.filter(
    (listing) => listing.status === "open" && listing.sellerPlayerId === ownPlayerId
  );
  const selected = ownListings.find((listing) => listing.listingId === selectedListingId) ?? null;
  if (ownListings.length === 0) return null;

  if (selected) {
    return <section className="market-account-section market-own-equipment-listings" role="region" aria-label={`Review cancellation of ${selected.displayName}`}>
      <header className="market-section-heading">
        <div><h2>Cancel listing?</h2></div>
        <button type="button" onClick={() => setSelectedListingId(null)}>Back</button>
      </header>
      <div className="market-equipment-detail-header">
        <div className="market-gear-card-art"><ItemArtwork itemId={selected.artworkKey} category={selected.category} label={selected.displayName} /></div>
        <div><span>Level {selected.itemLevel} · {humanize(selected.slot)}</span><h2>{selected.displayName}</h2></div>
      </div>
      <div className="market-status-chips">
        {derivedStatChips(selected.derivedStats).map((chip) => <span key={chip}>{chip}</span>)}
      </div>
      <dl className="market-tax-breakdown">
        <div><dt>Asking price</dt><dd>{formatPrice(selected.askingPrice, selected.priceCurrency)}</dd></div>
      </dl>
      <p className="market-order-note">The item goes to Collect.</p>
      <button
        type="button"
        className="market-secondary-action"
        disabled={!canCancel}
        onClick={() => {
          if (onCancel(selected)) setSelectedListingId(null);
        }}
      >Confirm cancel</button>
    </section>;
  }

  return <section className="market-account-section market-own-equipment-listings" aria-label="Your equipment listings">
    <header className="market-section-heading">
      <div><h2>Your equipment</h2></div>
      <strong>{ownListings.length} active</strong>
    </header>
    <div className="market-item-grid">
      {ownListings.map((listing) => <button
        key={listing.listingId}
        type="button"
        className="market-item-card market-equipment-row"
        onClick={() => setSelectedListingId(listing.listingId)}
      >
        <span className="market-item-icon"><ItemArtwork itemId={listing.artworkKey} category={listing.category} label={listing.displayName} /></span>
        <span className="market-item-card-copy"><strong>{listing.displayName}</strong><small>{listing.ring
          ? ringBonusSummary(ringViewBonusPresentation(listing.ring, listing.equipmentInstanceId))
          : `Level ${listing.itemLevel} · ${humanize(listing.slot)}`}</small></span>
        <span className="market-item-row-price"><strong>{formatPrice(listing.askingPrice, listing.priceCurrency)}</strong></span>
        <span className="market-row-chevron" aria-hidden="true">›</span>
      </button>)}
    </div>
  </section>;
}

function MarketEquipmentListingDetail({
  listing,
  ownPlayerId,
  walletGold,
  glimmerBalance,
  connected,
  pending,
  onPurchase,
  onCancel
}: {
  listing: MarketEquipmentListingSnapshot | null;
  ownPlayerId: string | null;
  walletGold: string;
  glimmerBalance: string;
  connected: boolean;
  pending: boolean;
  onPurchase(listing: MarketEquipmentListingSnapshot): boolean;
  onCancel(listing: MarketEquipmentListingSnapshot): boolean;
}): React.JSX.Element {
  const [reviewing, setReviewing] = useState(false);
  if (!listing) return <MarketEquipmentPlaceholder message="Choose an item." />;
  const own = listing.sellerPlayerId === ownPlayerId;
  const currency = listing.priceCurrency ?? "gold";
  const balance = currency === "glimmer" ? glimmerBalance : walletGold;
  const affordable = own || BigInt(balance) >= BigInt(listing.buyerTotal);
  return (
    <section className="market-equipment-detail" role="region" aria-label={`${listing.displayName} equipment listing`}>
      <header className="market-equipment-detail-header">
        <div className="market-gear-card-art"><ItemArtwork itemId={listing.artworkKey} category={listing.category} label={listing.displayName} /></div>
        <div><span>Level {listing.itemLevel} · {humanize(listing.slot)}</span><h2>{listing.displayName}</h2></div>
      </header>
      <div className="market-status-chips">
        {derivedStatChips(listing.derivedStats).map((chip) => <span key={chip}>{chip}</span>)}
        {listing.utilityIdentity ? <span>{humanize(listing.utilityIdentity)}</span> : null}
        {listing.cosmeticIdentity ? <span>{humanize(listing.cosmeticIdentity)}</span> : null}
      </div>
      {listing.ring ? <RingBonusLines lines={ringViewBonusPresentation(listing.ring, listing.equipmentInstanceId)} /> : null}
      {equipmentEnhancementSummary(listing.enchantmentIdentity)}
      <InscriptionDetails inscription={listing.inscription} />
      <dl className="market-tax-breakdown">
        <div><dt>Asking price</dt><dd>{formatPrice(listing.askingPrice, currency)}</dd></div>
        <div><dt>Buyer tax ({listing.buyerTaxBps / 100}%)</dt><dd>{formatPrice(listing.buyerTax, currency)}</dd></div>
        <div className="quick-total-final"><dt>Buyer total</dt><dd>{formatPrice(listing.buyerTotal, currency)}</dd></div>
      </dl>
      {reviewing ? <div className="market-gear-review" role="group" aria-label={own ? `Review cancellation of ${listing.displayName}` : `Review purchase of ${listing.displayName}`}>
        <strong>{own ? "Cancel listing?" : `Buy for ${formatPrice(listing.buyerTotal, currency)}?`}</strong>
        <div>
          <button type="button" onClick={() => setReviewing(false)}>Back</button>
          <button
            type="button"
            className={own ? "market-secondary-action" : "market-primary-action"}
            disabled={!connected || pending || (!own && !affordable)}
            onClick={() => {
              const accepted = own ? onCancel(listing) : onPurchase(listing);
              if (accepted) setReviewing(false);
            }}
          >{own ? "Confirm cancel" : "Confirm purchase"}</button>
        </div>
      </div> : <button
        type="button"
        className={own ? "market-secondary-action" : "market-primary-action"}
        disabled={!connected || pending || (!own && !affordable)}
        onClick={() => setReviewing(true)}
      >{own ? "Cancel listing" : affordable ? `Buy · ${formatPrice(listing.buyerTotal, currency)}` : currency === "glimmer" ? "Not enough Glimmer" : "Not enough gold"}</button>}
    </section>
  );
}

function EquipmentSellList({ equipment, selectedInstanceId, onSelect }: {
  equipment: EquipmentSnapshotV2 | null;
  selectedInstanceId: string | null;
  onSelect(instance: EquipmentInstanceV2): void;
}): React.JSX.Element {
  const eligible = eligibleMarketEquipment(equipment);
  return <section className="market-catalog market-equipment-sell-list" aria-label="Eligible equipment">
    {equipment === null ? <div className="market-empty compact">Refreshing equipment…</div> : eligible.length ? <div className="market-item-grid">
      {eligible.map((instance) => <button
        key={instance.instanceId}
        type="button"
        className={`market-item-card market-equipment-row${selectedInstanceId === instance.instanceId ? " selected" : ""}`}
        aria-pressed={selectedInstanceId === instance.instanceId}
        onClick={() => onSelect(instance)}
      >
        <span className="market-item-icon"><ItemArtwork itemId={instance.definitionId} category={instance.category} label={instance.displayName} /></span>
        <span className="market-item-card-copy"><strong>{instance.displayName}</strong><small>Level {instance.itemLevel} · {humanize(instance.category)}</small></span>
        <span className="market-item-row-price"><strong>Set price</strong><small>{instance.ring
          ? ringBonusSummary(ringBonusPresentation(instance, null))
          : derivedStatChips(instance.derived).join(" · ") || "Standard stats"}</small></span>
        <span className="market-row-chevron" aria-hidden="true">›</span>
      </button>)}
    </div> : <div className="market-empty compact">No equipment to list. Unequip it and remove it from saved sets first.</div>}
  </section>;
}

function MarketEquipmentPlaceholder({ message }: { message: string }): React.JSX.Element {
  return <section className="market-equipment-detail market-item-detail-empty">{message}</section>;
}

export function EquipmentSellCard({
  instance,
  disabled,
  onList
}: {
  instance: EquipmentInstanceV2;
  disabled: boolean;
  onList(instanceId: string, price: string, priceCurrency: MarketPriceCurrency): boolean;
}): React.JSX.Element {
  const [price, setPrice] = useState("");
  const [priceCurrency, setPriceCurrency] = useState<MarketPriceCurrency>("gold");
  const [reviewing, setReviewing] = useState(false);
  const validPrice = /^[1-9]\d*$/.test(price);
  return (
    <section className="market-equipment-detail" role="region" aria-label={`List ${instance.displayName}`}>
      <header className="market-equipment-detail-header"><div className="market-gear-card-art"><ItemArtwork itemId={instance.definitionId} category={instance.category} label={instance.displayName} /></div><div><span>Level {instance.itemLevel} · {humanize(instance.category)}</span><h2>{instance.displayName}</h2></div></header>
      <div className="market-status-chips">{derivedStatChips(instance.derived).map((chip) => <span key={chip}>{chip}</span>)}</div>
      {instance.ring ? <RingBonusLines lines={ringBonusPresentation(instance, null)} /> : null}
      {equipmentEnhancementSummary(instance.enchantmentIdentity)}
      <InscriptionDetails inscription={instance.inscription} />
      <div className="market-field">
        <span>Asking price</span>
        <div className="market-field-with-action market-price-with-currency">
          <MarketNumberInput label="Asking price" value={price} disabled={disabled} onValueChange={(raw) => { setPrice(raw); setReviewing(false); }} />
          <PriceCurrencyToggle
            value={priceCurrency}
            disabled={disabled}
            onChange={(currency) => { setPriceCurrency(currency); setReviewing(false); }}
          />
        </div>
      </div>
      {reviewing && validPrice ? (
        <div className="market-review market-confirm-row" role="group" aria-label={`Confirm listing ${instance.displayName}`}>
          <button type="button" onClick={() => setReviewing(false)}>Back</button>
          <button
            type="button"
            className="market-confirm-action"
            disabled={disabled}
            onClick={() => { if (onList(instance.instanceId, price, priceCurrency)) setReviewing(false); }}
          >
            Confirm · {formatPrice(price, priceCurrency)}
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="market-primary-action"
          disabled={disabled || !validPrice}
          onClick={() => setReviewing(true)}
        >
          List item
        </button>
      )}
    </section>
  );
}

// Glimmer sits in the premium wallet. Present it as an owned market
// holding so Browse and Sell show the balance without touching inventory.
function withPremiumHoldings(
  inventory: PlayerInventorySnapshot,
  balances: PremiumWalletSnapshot["balances"] | null
): PlayerInventorySnapshot {
  if (!balances) return inventory;
  const holdings = PREMIUM_CURRENCIES.flatMap((currency) => {
    const balance = Number(BigInt(balances[currency].balance));
    return balance > 0
      ? [{ ...PREMIUM_HOLDING_TEMPLATE, resourceType: currency, quantity: Math.min(balance, Number.MAX_SAFE_INTEGER) }]
      : [];
  });
  if (holdings.length === 0) return inventory;
  return { ...inventory, items: [...inventory.items, ...holdings] as PlayerInventorySnapshot["items"] };
}

const PREMIUM_HOLDING_TEMPLATE = { variant: null } as unknown as PlayerInventorySnapshot["items"][number];

function eligibleMarketEquipment(equipment: EquipmentSnapshotV2 | null): EquipmentInstanceV2[] {
  return (equipment?.instances ?? []).filter((instance) => {
    const definition = requireEquipmentDefinition(instance.definitionId);
    return definition.marketTradable &&
      instance.location === "inventory" &&
      instance.equippedSlot === null &&
      instance.savedKitIndices.length === 0 &&
      instance.ring?.rough !== true;
  });
}

function equipmentEnhancementSummary(identity: string | null): React.JSX.Element | null {
  const enhancement = parseEquipmentEnhancement(identity);
  if (!enhancement) return null;
  return (
    <p className="market-order-note">
      {enhancement.metal
        ? `${equipmentMetalDisplayName(enhancement.metal)} / ${equipmentEffectDisplayName(enhancement.effect ?? "poison")}${enhancement.gemstone ? ` · ${humanize(enhancement.gemstone)} stone` : ""}${enhancement.metal === "venomsteel" ? " · Requires Bitter Blood to equip" : ""}`
        : `${humanize(enhancement.gemstone ?? "none")} stone prepared for imbuement`}
    </p>
  );
}

function MarketBrowseControls({
  search,
  category,
  equipmentSelected,
  categories,
  sort,
  loading,
  onSearch,
  onCategory,
  onSort
}: {
  search: string;
  category: string | null;
  equipmentSelected: boolean;
  categories: string[];
  sort: MarketSort;
  loading: boolean;
  onSearch(value: string): void;
  onCategory(value: string | null): void;
  onSort(value: MarketSort): void;
}): React.JSX.Element {
  return (
    <section className="market-browse-controls" aria-label="Browse controls">
      <div className="market-category-tabs">
        <GameAppTabs
          variant="subtabs"
          scrollable={marketBrowseCategories(categories).length > 4}
          ariaLabel="Market categories"
          activeTab={equipmentSelected ? "equipment" : category ?? "all"}
          onChange={(id) => onCategory(id === "all" ? null : id)}
          tabs={marketBrowseCategories(categories)}
        />
      </div>
      <label className="market-search">
        <span aria-hidden="true">⌕</span>
        <input
          type="search"
          value={search}
          maxLength={80}
          autoComplete="off"
          placeholder="Search"
          aria-label="Search market items"
          onChange={(event) => onSearch(event.currentTarget.value)}
        />
        {loading ? <i aria-label="Searching" /> : null}
      </label>
      <label className="market-sort">
        <span>Sort</span>
        <select value={sort} onChange={(event) => onSort(event.currentTarget.value as MarketSort)}>
          <option value="lowest_ask">Lowest ask</option>
          <option value="name">Name</option>
          <option value="available">Most available</option>
        </select>
      </label>
    </section>
  );
}

function marketBrowseCategories(categories: string[]): { id: string; label: string }[] {
  const standard = [
    { id: "all", label: "All" },
    { id: "consumable", label: "Consumables" },
    { id: "resource", label: "Resources" },
    { id: "equipment", label: "Equipment" }
  ];
  const standardIds = new Set(standard.map(({ id }) => id));
  return [
    ...standard,
    ...categories
      .filter((category) => !standardIds.has(category))
      .map((category) => ({ id: category, label: humanize(category) }))
  ];
}

function MarketStateBanner({
  state,
  connectionStatus
}: {
  state: ReturnType<MarketController["getState"]>;
  connectionStatus: MarketOverlayProps["connectionStatus"];
}): React.JSX.Element | null {
  const controls = state.snapshot?.controls;
  if (connectionStatus !== "online" || !state.connected) {
    return <div className="market-state-banner warning">Reconnecting…</div>;
  }
  if (state.requestState === "failed") {
    return <div className="market-state-banner danger">{state.error?.message ?? "Market request failed. Refresh to see the latest Market state."}</div>;
  }
  if (controls && !controls.accessAllowed) return <div className="market-state-banner danger">Market access is not available for this account or location.</div>;
  if (controls && (controls.readOnly || controls.venueFrozen || controls.playerFrozen)) {
    return <div className="market-state-banner danger">{controls.message ?? "Trading is paused right now. You can still browse."}</div>;
  }
  if (controls && (!controls.newOrdersEnabled || !controls.matchingEnabled || !controls.cancellationsEnabled || !controls.claimsEnabled)) {
    return <div className="market-state-banner warning">{controls.message ?? "Some market actions are temporarily unavailable."}</div>;
  }
  if (state.requestState === "refreshing" && state.snapshot) return null;
  // With no venue the panel already explains how to reach a City Market.
  if (state.requestState === "access_required" && !state.snapshot) return null;
  // Transient loading states show on the header connection dot instead of a banner, so the
  // page never jumps while prices refresh.
  return null;
}

function marketReadinessLabel(
  state: ReturnType<MarketController["getState"]>,
  connectionStatus: MarketOverlayProps["connectionStatus"]
): string {
  if (connectionStatus === "offline" || !state.connected) return "Offline";
  if (connectionStatus === "connecting" || state.requestState === "reconnecting") {
    return "Reconnecting";
  }
  switch (state.requestState) {
    case "opening":
      return "Opening Market";
    case "loading":
    case "purchasing":
    case "creating_listing":
    case "canceling_listing":
      return "Loading";
    case "refreshing":
      return "Refreshing listings";
    case "ready":
      return "Ready";
    case "failed":
      return "Request failed";
    case "access_required":
      return "Waiting for Market access";
  }
}

function hasCollection(snapshot: ReturnType<MarketController["getState"]>["snapshot"]): boolean {
  if (!snapshot) return false;
  return BigInt(snapshot.player.collection.gold) > 0n ||
    snapshot.player.collection.items.some((item) => BigInt(item.quantity) > 0n) ||
    snapshot.player.collection.equipment.length > 0;
}

function derivedStatChips(stats: object | null | undefined): string[] {
  return Object.entries(stats ?? {})
    .filter(([, value]) => value !== null && value !== false && value !== 0 && value !== "")
    .slice(0, 3)
    .map(([key, value]) => `${humanize(key)} ${typeof value === "boolean" ? "" : String(value)}`.trim());
}

function humanize(value: string): string {
  return value.replace(/[_-]+/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function formatSpecialtyName(value: string): string {
  return `${humanize(value)} specialty`;
}
