import { ShopProvenanceDetails } from "../ShopProvenance.js";
import {
  PREMIUM_CURRENCY_NAMES,
  premiumCurrencyForMarketItem,
  premiumMarketMaxSellQuantity,
  premiumMarketSellerFee
} from "@ash-atlas/shared";
import { MarketNumberInput } from "./MarketNumberPad.js";
import type {
  MarketBookSnapshot,
  MarketControlSnapshot,
  MarketDepthLevel,
  MarketInteger,
  MarketOrderSnapshot,
  MarketOrderSide,
  MarketPriceCurrency,
  MarketQuote,
  MarketSnapshot,
  PlayerInventorySnapshot
} from "@ash-atlas/shared";
import { useEffect, useRef, useState } from "react";

import {
  calculateMarketFee,
  formatMarketInteger,
  formatPrice,
  isQuoteExpired,
  multiplyMarketIntegers,
  normalizePositiveMarketInput
} from "../../market/marketFormat.js";
import type { MarketClientError, MarketInterfaceMode } from "../../market/marketController.js";
import { MarketItemIcon } from "./MarketCatalog.js";
import { CurrencyGlyph } from "../InventoryCarryList.js";

type CommonTradingProps = {
  book: MarketBookSnapshot | null;
  bookLoading: boolean;
  bookError: MarketClientError | null;
  bookReady: boolean;
  connected: boolean;
  controls: MarketControlSnapshot;
  feePolicy: MarketSnapshot["feePolicy"];
  walletGold: MarketInteger;
  inventory: PlayerInventorySnapshot;
  hasInventorySnapshot: boolean;
  pending: boolean;
  /** Which of the item's books is shown; Glimmer itself is priced in Gold only. */
  priceCurrency?: MarketPriceCurrency;
  glimmerBalance?: MarketInteger | null;
  onPriceCurrency?: ((priceCurrency: MarketPriceCurrency) => void) | undefined;
  onRetryBook(): void;
  onCreateOrder(
    interfaceMode: MarketInterfaceMode,
    side: MarketOrderSide,
    itemId: string,
    quantity: MarketInteger,
    unitPrice: MarketInteger,
    priceCurrency?: MarketPriceCurrency
  ): boolean;
};

type StandardBrowseProps = CommonTradingProps & {
  quote: MarketQuote | null;
  quoteQuantity: MarketInteger | null;
  quoteMaximumUnitPrice: MarketInteger | null;
  quoteLoading: boolean;
  quoteError: MarketClientError | null;
  onInvalidateQuote(): void;
  onRequestQuote(itemId: string, quantity: MarketInteger, maximumUnitPrice: MarketInteger): boolean;
  onConfirmBuy(): boolean;
};

type StandardSellViewProps = CommonTradingProps & {
  activeOrders: MarketOrderSnapshot[];
  onCancelOrder(orderId: string): boolean;
};

type QuickSelection = {
  side: "buy" | "sell";
  unitPrice: MarketInteger;
  available: MarketInteger;
};

export function StandardMarketBrowseView({
  book,
  bookLoading,
  bookError,
  bookReady,
  connected,
  controls,
  feePolicy,
  walletGold,
  inventory,
  hasInventorySnapshot,
  pending,
  priceCurrency = "gold",
  glimmerBalance = null,
  onPriceCurrency,
  onRetryBook,
  quote,
  quoteQuantity,
  quoteMaximumUnitPrice,
  quoteLoading,
  quoteError,
  onInvalidateQuote,
  onRequestQuote,
  onConfirmBuy,
  onCreateOrder
}: StandardBrowseProps): React.JSX.Element {
  const [selection, setSelection] = useState<QuickSelection | null>(null);
  const [selectionRevision, setSelectionRevision] = useState(0);
  const [quantity, setQuantity] = useState("1");
  const [clock, setClock] = useState(() => Date.now());
  const [previousQuoteTotal, setPreviousQuoteTotal] = useState<MarketInteger | null>(null);
  const [confirmingBuy, setConfirmingBuy] = useState(false);
  const lastQuoteRef = useRef<MarketQuote | null>(null);

  const asks = quickTradeLevels(book?.asks ?? []);
  const itemIdentity = book?.item.itemIdentity ?? null;

  useEffect(() => {
    const firstAsk = asks[0];
    setSelection(firstAsk
      ? { side: "buy", unitPrice: firstAsk.unitPrice, available: buyCapacityAtPrice(asks, firstAsk.unitPrice) }
      : null);
    setQuantity("1");
    setPreviousQuoteTotal(null);
    lastQuoteRef.current = null;
  }, [itemIdentity]);

  useEffect(() => {
    setSelection((current) => {
      if (!current) return current;
      const levels = asks;
      const refreshed = levels.find((level) => level.unitPrice === current.unitPrice);
      if (refreshed) {
        return {
          ...current,
          available: current.side === "buy"
            ? buyCapacityAtPrice(asks, current.unitPrice)
            : refreshed.quantity
        };
      }
      const fallback = levels[0];
      return fallback
        ? {
            side: current.side,
            unitPrice: fallback.unitPrice,
            available: current.side === "buy"
              ? buyCapacityAtPrice(asks, fallback.unitPrice)
              : fallback.quantity
          }
        : null;
    });
  }, [book?.item.bookVersion]);

  useEffect(() => {
    if (!quote) return;
    const prior = lastQuoteRef.current;
    if (
      prior &&
      prior.itemIdentity === quote.itemIdentity &&
      prior.requestedQuantity === quote.requestedQuantity &&
      prior.quotedTotal !== quote.quotedTotal
    ) {
      setPreviousQuoteTotal(prior.quotedTotal);
    }
    lastQuoteRef.current = quote;
    setClock(Date.now());
    const interval = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [quote]);

  const validQuantity = normalizePositiveMarketInput(quantity);
  useEffect(() => {
    if (!book || selection?.side !== "buy" || !validQuantity || !connected || !bookReady || pending) return;
    onInvalidateQuote();
    const timer = window.setTimeout(() => {
      onRequestQuote(book.item.itemIdentity, validQuantity, selection.unitPrice);
    }, 180);
    return () => window.clearTimeout(timer);
  }, [book?.item.bookVersion, book?.item.itemIdentity, bookReady, connected, pending, selection?.side, selection?.unitPrice, selectionRevision, validQuantity]);

  if (!book) return <BookLoading loading={bookLoading} error={bookError} onRetry={onRetryBook} />;

  const ownedQuantity = ownedMarketQuantity(inventory, book.item.itemId, book.item.variant ?? null);
  const selectedAvailable = selection ? BigInt(selection.available) : 0n;
  const maxQuantity = selection?.side === "sell"
    ? minBigInt(BigInt(ownedQuantity), selectedAvailable)
    : selection?.side === "buy"
      ? selectedAvailable
      : 0n;
  const chosenQuantity = validQuantity ? BigInt(validQuantity) : 0n;
  const quantityWithinOffer = chosenQuantity > 0n && chosenQuantity <= maxQuantity;
  const quoteExpired = quote ? isQuoteExpired(quote.expiresAt, clock) : false;
  const quoteMatches = Boolean(
    quote &&
    selection?.side === "buy" &&
    quote.itemIdentity === book.item.itemIdentity &&
    quoteQuantity === validQuantity &&
    validQuantity === quote.requestedQuantity &&
    quoteMaximumUnitPrice === selection.unitPrice &&
    quote.requestedMaximumUnitPrice === selection.unitPrice
  );
  const priceBalance = priceCurrency === "glimmer" ? glimmerBalance ?? "0" : walletGold;
  const quoteAffordable = quoteMatches && quote
    ? BigInt(quote.quotedTotal) <= BigInt(priceBalance)
    : false;
  const quoteRateLimited = quoteLoading && quoteError?.code === "MARKET_RATE_LIMITED";
  const mutationBlocked = !canCreateOrder(controls) || !connected || !bookReady || pending;
  const sellGross = selection?.side === "sell" && validQuantity
    ? multiplyMarketIntegers(validQuantity, selection.unitPrice)
    : null;
  const sellFee = sellGross === null ? null : calculateMarketFee(sellGross, feePolicy.sellerFeeBps);
  const sellProceeds = quickTradeSellProceeds(sellGross, sellFee, feePolicy.listingFee);
  const buyReady = Boolean(
    quoteMatches && quote && !quoteLoading && !quoteExpired &&
    quote.fullQuantityAvailable && quoteAffordable && quantityWithinOffer
  );
  const sellReady = selection?.side === "sell" && hasInventorySnapshot && quantityWithinOffer;

  const chooseLevel = (side: QuickSelection["side"], level: MarketDepthLevel): void => {
    const available = side === "buy" ? buyCapacityAtPrice(asks, level.unitPrice) : level.quantity;
    const currentQuantity = normalizePositiveMarketInput(quantity);
    setSelection({ side, unitPrice: level.unitPrice, available });
    setSelectionRevision((revision) => revision + 1);
    setQuantity(currentQuantity && BigInt(currentQuantity) <= BigInt(available) ? currentQuantity : "1");
    setPreviousQuoteTotal(null);
    setConfirmingBuy(false);
    onInvalidateQuote();
  };

  const updateQuantity = (next: bigint): void => {
    const bounded = maxQuantity > 0n ? clampBigInt(next, 1n, maxQuantity) : 1n;
    setQuantity(bounded.toString());
    setPreviousQuoteTotal(null);
    setConfirmingBuy(false);
  };

  const quoteShown = quoteMatches && quote?.fullQuantityAvailable ? quote : null;
  const buyLabel = pending
    ? "Order in progress…"
    : !connected
      ? "Reconnecting…"
      : !bookReady
        ? "Updating offers…"
        : quoteRateLimited
          ? "Price updates paused"
          : quoteLoading || (!quoteMatches && !quoteError)
            ? "Checking price…"
            : quoteShown
              ? `Buy ${formatMarketInteger(quoteShown.requestedQuantity)} for ${formatPrice(quoteShown.quotedTotal, priceCurrency)}`
              : "Unavailable";

  return (
    <section className="market-item-detail quick-trade" aria-label={`${book.item.displayName} listings`} aria-busy={!bookReady}>
      <ItemSummaryHeader book={book} ownedQuantity={ownedQuantity} loading={bookLoading} />
      <BookUpdateStatus error={bookError} onRetry={onRetryBook} />
      <div className="quick-trade-body">
        {selection ? (
          <section className={`quick-ticket quick-ticket-${selection.side}`} aria-label={selection.side === "buy" ? "Buy" : "Sell"}>
            {selection.side === "sell" && (!hasInventorySnapshot || ownedQuantity === 0) ? (
              <div className="market-empty compact">
                {hasInventorySnapshot ? `You have no ${book.item.displayName}.` : "Refreshing inventory…"}
              </div>
            ) : (
              <>
                <QuantityStepper
                  value={quantity}
                  maximum={maxQuantity}
                  disabled={pending || maxQuantity === 0n}
                  onChange={updateQuantity}
                  onType={(raw) => {
                    setQuantity(raw);
                    setPreviousQuoteTotal(null);
                    setConfirmingBuy(false);
                  }}
                />

                {selection.side === "buy" ? (
                  <div className="quick-total-card">
                    <dl className="market-tax-breakdown" aria-busy={!quoteShown}>
                      <div><dt>Price</dt><dd>{quoteShown ? formatPrice(quoteShown.grossItemTotal, priceCurrency) : "…"}</dd></div>
                      <div>
                        <dt>{quoteShown ? `${quoteShown.taxLabel}${quoteShown.specialtyTaxApplied ? " · Specialty" : ""} (${quoteShown.appliedBuyerTaxBps / 100}%)` : "Tax"}</dt>
                        <dd>{quoteShown ? formatPrice(quoteShown.buyerTax, priceCurrency) : "…"}</dd>
                      </div>
                      <div className="quick-total-final"><dt>Total</dt><dd>{quoteShown ? formatPrice(quoteShown.quotedTotal, priceCurrency) : "…"}</dd></div>
                    </dl>
                    {previousQuoteTotal && quote && previousQuoteTotal !== quote.quotedTotal ? (
                      <p className="market-price-change" role="status">Price changed from {formatPrice(previousQuoteTotal, priceCurrency)}.</p>
                    ) : null}
                    {quoteMatches && quote?.availability === "self_trade_only" ? (
                      <p className="market-inline-warning" role="alert">Only your own listings are here.</p>
                    ) : null}
                    {quoteMatches && quote?.availability === "no_eligible_liquidity" ? (
                      <p className="market-inline-warning" role="alert">No sellers available.</p>
                    ) : null}
                    {quoteMatches && quote?.availability === "quantity_unavailable" ? (
                      <p className="market-inline-warning" role="alert">That quantity is no longer available.</p>
                    ) : null}
                    {quoteError && !quoteLoading && !quoteRateLimited ? (
                      <div className="market-inline-warning" role="alert">
                        <p>{quoteError.message}</p>
                        {connected ? (
                          <button type="button" className="market-secondary-action" onClick={() => validQuantity && onRequestQuote(book.item.itemIdentity, validQuantity, selection.unitPrice)}>
                            Retry
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                    {quoteMatches && quote && !quoteAffordable ? <p className="market-inline-warning">You need {formatPrice(BigInt(quote.quotedTotal) - BigInt(priceBalance), priceCurrency)} more.</p> : null}
                    {quoteExpired ? (
                      <button type="button" className="market-secondary-action" onClick={() => validQuantity && onRequestQuote(book.item.itemIdentity, validQuantity, selection.unitPrice)}>
                        Refresh price
                      </button>
                    ) : confirmingBuy && quoteShown ? (
                      <div className="market-review market-confirm-row" role="group" aria-label="Confirm purchase">
                        <button type="button" onClick={() => setConfirmingBuy(false)} disabled={pending}>Back</button>
                        <button
                          type="button"
                          className="market-confirm-action"
                          disabled={mutationBlocked || !buyReady}
                          onClick={() => { if (onConfirmBuy()) setConfirmingBuy(false); }}
                        >
                          Confirm · {formatPrice(quoteShown.quotedTotal, priceCurrency)}
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="market-primary-action"
                        aria-live="polite"
                        disabled={mutationBlocked || !buyReady}
                        onClick={() => setConfirmingBuy(true)}
                      >
                        {buyLabel}
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="quick-total-card">
                    <dl>
                      <div className="quick-total-final"><dt>You receive</dt><dd>{sellProceeds === null ? "—" : formatPrice(sellProceeds, priceCurrency)}</dd></div>
                    </dl>
                    <button
                      type="button"
                      className="market-primary-action"
                      disabled={mutationBlocked || !sellReady || !validQuantity || sellProceeds === null}
                      onClick={() => validQuantity && onCreateOrder("simple", "sell", book.item.itemIdentity, validQuantity, selection.unitPrice, priceCurrency)}
                    >
                      {validQuantity ? `Sell ${formatMarketInteger(validQuantity)}` : "Sell"}
                    </button>
                  </div>
                )}
              </>
            )}
          </section>
        ) : null}
        <MarketListingsBox
          levels={asks}
          selectedPrice={selection?.side === "buy" ? selection.unitPrice : null}
          actionLabel="Buy at"
          priceCurrency={priceCurrency}
          toolbar={onPriceCurrency && glimmerPriceable(book) ? (
            <PriceCurrencyToggle value={priceCurrency} disabled={pending} onChange={onPriceCurrency} />
          ) : null}
          onSelect={(level) => chooseLevel("buy", level)}
        />
      </div>
    </section>
  );
}

export function StandardMarketSellView({
  book,
  bookLoading,
  bookError,
  bookReady,
  connected,
  controls,
  feePolicy,
  inventory,
  hasInventorySnapshot,
  pending,
  priceCurrency = "gold",
  onPriceCurrency,
  onRetryBook,
  onCreateOrder
}: StandardSellViewProps): React.JSX.Element {
  const side: MarketOrderSide = "sell";
  const [quantity, setQuantity] = useState("1");
  const [unitPrice, setUnitPrice] = useState(book?.item.bestAsk ?? book?.item.bestBid ?? "1");
  const [reviewing, setReviewing] = useState(false);
  const pricedBook = book && (book.item.priceCurrency ?? "gold") === priceCurrency ? book : null;
  const pricedBookKey = pricedBook ? `${pricedBook.item.itemIdentity}:${priceCurrency}` : null;
  // Prices differ per currency: start a switched book from its own best price.
  const priceBookRef = useRef(pricedBookKey);
  useEffect(() => {
    if (!pricedBook || priceBookRef.current === pricedBookKey) return;
    const first = priceBookRef.current === null;
    priceBookRef.current = pricedBookKey;
    if (first) return;
    setUnitPrice(pricedBook.item.bestAsk ?? pricedBook.item.bestBid ?? "1");
    setReviewing(false);
  }, [pricedBookKey]);

  if (!book) return <BookLoading loading={bookLoading} error={bookError} onRetry={onRetryBook} />;

  const validQuantity = normalizePositiveMarketInput(quantity);
  const validPrice = normalizePositiveMarketInput(unitPrice);
  const gross = validQuantity && validPrice ? multiplyMarketIntegers(validQuantity, validPrice) : null;
  const feeBps = feePolicy.sellerFeeBps;
  const fee = gross === null ? null : calculateMarketFee(gross, feeBps);
  const final = gross === null || fee === null
    ? null
    : gross - fee - BigInt(feePolicy.listingFee);
  const ownedQuantity = ownedMarketQuantity(inventory, book.item.itemId, book.item.variant ?? null);
  // Glimmer: the seller also pays a currency fee (5%, rounded up) from the balance.
  const premiumCurrency = premiumCurrencyForMarketItem(book.item.itemId);
  const currencyFee = premiumCurrency && validQuantity ? premiumMarketSellerFee(BigInt(validQuantity)) : null;
  const sellableQuantity = premiumCurrency
    ? Number(premiumMarketMaxSellQuantity(BigInt(ownedQuantity)))
    : ownedQuantity;
  const sellWithinInventory = hasInventorySnapshot &&
    validQuantity !== null &&
    BigInt(validQuantity) <= BigInt(sellableQuantity);
  const mutationBlocked = !canCreateOrder(controls) || !connected || pending;
  const crossingQuantity = validQuantity && validPrice ? estimateCrossingQuantity(book, side, validQuantity, validPrice) : 0n;

  const fees = fee === null ? null : fee + BigInt(feePolicy.listingFee);
  const tooMany = hasInventorySnapshot && validQuantity !== null && BigInt(validQuantity) > BigInt(sellableQuantity);

  return (
    <section className="market-item-detail merchant-market" aria-label={`Sell ${book.item.displayName}`} aria-busy={!bookReady}>
      <ItemSummaryHeader book={book} ownedQuantity={ownedQuantity} loading={bookLoading} />
      <BookUpdateStatus error={bookError} onRetry={onRetryBook} />
      <div className="merchant-market-layout">
        {book.bids.length ? <CurrentBuyerOffers levels={book.bids} priceCurrency={priceCurrency} onSelectPrice={(price) => {
          setUnitPrice(price);
          setReviewing(false);
        }} /> : null}

        <section className={`market-trade-card market-${side}-card merchant-order-entry`} aria-busy={pending}>
          {onPriceCurrency && glimmerPriceable(book) ? (
            <PriceCurrencyToggle value={priceCurrency} disabled={pending} onChange={(next) => { onPriceCurrency(next); setReviewing(false); }} />
          ) : null}
          <div className="market-two-fields">
            <div className="market-field">
              <span>Quantity</span>
              <div className="market-field-with-action">
                <MarketNumberInput label="Quantity" invalid={tooMany} value={quantity} disabled={pending} onValueChange={(raw) => { setQuantity(raw); setReviewing(false); }} />
                <button type="button" aria-label="Use owned quantity" disabled={pending || sellableQuantity <= 0} onClick={() => { setQuantity(String(sellableQuantity)); setReviewing(false); }}>Max</button>
              </div>
            </div>
            <label className="market-field"><span>Price each</span><MarketNumberInput label="Price each" value={unitPrice} disabled={pending} onValueChange={(raw) => { setUnitPrice(raw); setReviewing(false); }} /></label>
          </div>
          <dl className="market-estimate">
            <div className="market-estimate-total"><dt>You receive</dt><dd>{final === null ? "—" : formatPrice(final < 0n ? 0n : final, priceCurrency)}</dd></div>
            {fees !== null && fees > 0n ? <div><dt>Fees</dt><dd>{formatPrice(fees, priceCurrency)}</dd></div> : null}
            {premiumCurrency && currencyFee !== null ? <div><dt>Fee</dt><dd>{formatMarketInteger(currencyFee)} {PREMIUM_CURRENCY_NAMES[premiumCurrency]}</dd></div> : null}
            {crossingQuantity > 0n && validQuantity ? <div><dt>Sells instantly</dt><dd>{formatMarketInteger(crossingQuantity)} / {formatMarketInteger(validQuantity)}</dd></div> : null}
          </dl>
          {tooMany ? <p className="market-inline-warning">{premiumCurrency ? `Max ${formatMarketInteger(BigInt(sellableQuantity))} with the fee.` : `You only have ${formatMarketInteger(BigInt(ownedQuantity))}.`}</p> : null}
          {reviewing && validQuantity && validPrice ? (
            <div className="market-review market-confirm-row" role="group" aria-label="Review listing">
              <button type="button" onClick={() => setReviewing(false)} disabled={pending}>Back</button>
              <button type="button" className="market-confirm-action" disabled={mutationBlocked || !sellWithinInventory || !pricedBook} onClick={() => { if (onCreateOrder("merchant", side, book.item.itemIdentity, validQuantity, validPrice, priceCurrency)) setReviewing(false); }}>Post listing</button>
            </div>
          ) : (
            <button type="button" className="market-primary-action" disabled={mutationBlocked || !validQuantity || !validPrice || !sellWithinInventory} onClick={() => setReviewing(true)}>Review listing</button>
          )}
        </section>
        <MarketListingsBox
          levels={quickTradeLevels(book.asks)}
          selectedPrice={null}
          actionLabel="Use price"
          priceCurrency={priceCurrency}
          onSelect={(level) => {
            setUnitPrice(level.unitPrice);
            setReviewing(false);
          }}
        />
      </div>
    </section>
  );
}

// Fixed-height box of current seller prices, cheapest first. It scrolls inside itself so the
// trade controls above never move.
function MarketListingsBox({
  levels,
  selectedPrice,
  actionLabel,
  priceCurrency = "gold",
  toolbar = null,
  onSelect
}: {
  levels: MarketDepthLevel[];
  selectedPrice: MarketInteger | null;
  actionLabel: string;
  priceCurrency?: MarketPriceCurrency;
  toolbar?: React.ReactNode;
  onSelect(level: MarketDepthLevel): void;
}): React.JSX.Element {
  return (
    <section className="market-listings-box" aria-label="For sale">
      {toolbar}
      <header><h3>For sale</h3><span>{levels.length ? "Cheapest first" : ""}</span></header>
      <div className="market-listings-scroll">
        {levels.length === 0 ? <p className="quick-offer-empty">No listings yet.</p> : levels.map((level) => {
          const active = selectedPrice === level.unitPrice;
          return (
            <button key={level.unitPrice} type="button" className={active ? "market-listing-row selected" : "market-listing-row"} aria-pressed={active} aria-label={`${actionLabel} ${formatPrice(level.unitPrice, priceCurrency)}, ${formatMarketInteger(level.quantity)} listed`} onClick={() => onSelect(level)}>
              <strong>{formatPrice(level.unitPrice, priceCurrency)}</strong>
              <span>{formatMarketInteger(level.quantity)} listed</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

// Typing keeps the raw digits (so the box can be cleared); the value is clamped on blur.
function QuantityStepper({ value, maximum, disabled, onChange, onType }: { value: string; maximum: bigint; disabled: boolean; onChange(value: bigint): void; onType(raw: string): void }): React.JSX.Element {
  const current = normalizePositiveMarketInput(value);
  const amount = current ? BigInt(current) : 1n;
  return (
    <div className="quick-quantity">
      <span id="quick-quantity-label">Quantity</span>
      <div role="group" aria-labelledby="quick-quantity-label">
        <button type="button" aria-label="Decrease quantity" disabled={disabled || amount <= 1n} onClick={() => onChange(amount - 1n)}>−</button>
        <MarketNumberInput label="Trade quantity" value={value} disabled={disabled} onValueChange={onType} onCommit={() => onChange(BigInt(normalizePositiveMarketInput(value) ?? "1"))} />
        <button type="button" aria-label="Increase quantity" disabled={disabled || amount >= maximum} onClick={() => onChange(amount + 1n)}>+</button>
        <button type="button" aria-label="Use maximum quantity" disabled={disabled || maximum <= 0n} onClick={() => onChange(maximum)}>Max</button>
      </div>
    </div>
  );
}

function ItemSummaryHeader({ book, ownedQuantity, loading = false }: { book: MarketBookSnapshot; ownedQuantity: number; loading?: boolean }): React.JSX.Element {
  return (
    <header className="market-item-detail-header">
      <MarketItemIcon iconKey={book.item.iconKey} category={book.item.category} variant={book.item.variant ?? null} label={book.item.displayName} />
      <div>
        <h2>{book.item.displayName}</h2>
        {book.item.provenance ? <ShopProvenanceDetails provenance={book.item.provenance} /> : null}
        <p className="market-item-detail-meta">
          <span>You own <strong>{formatMarketInteger(BigInt(ownedQuantity))}</strong></span>
          <span>For sale <strong>{formatMarketInteger(book.item.availableSellQuantity)}</strong></span>
          <span>Wanted <strong>{formatMarketInteger(book.item.availableBuyQuantity)}</strong></span>
        </p>
      </div>
      <span className={loading ? "market-quote-spinner market-header-spinner" : "market-header-spinner"} role="status" aria-label={loading ? "Updating offers" : undefined} />
    </header>
  );
}

/** Compact Gold / Glimmer switch between an item's two books. */
export function PriceCurrencyToggle({ value, disabled, onChange }: {
  value: MarketPriceCurrency;
  disabled: boolean;
  onChange(priceCurrency: MarketPriceCurrency): void;
}): React.JSX.Element {
  return (
    <div className="market-price-currency" role="group" aria-label="Price currency">
      {(["gold", "glimmer"] as const).map((currency) => (
        <button key={currency} type="button" aria-pressed={value === currency} disabled={disabled} onClick={() => onChange(currency)}>
          <CurrencyGlyph kind={currency} />{currency === "gold" ? "Gold" : "Glimmer"}
        </button>
      ))}
    </div>
  );
}

function glimmerPriceable(book: MarketBookSnapshot): boolean {
  return premiumCurrencyForMarketItem(book.item.itemId) === null;
}

function CurrentBuyerOffers({ levels, priceCurrency = "gold", onSelectPrice }: { levels: MarketDepthLevel[]; priceCurrency?: MarketPriceCurrency; onSelectPrice(price: string): void }): React.JSX.Element {
  return (
    <section className="market-buyer-offers" aria-label="Current buyer offers">
      <h3>Buyers</h3>
      <div>{levels.map((level) => (
        <button key={level.unitPrice} type="button" onClick={() => onSelectPrice(level.unitPrice)} aria-label={`Use buyer price ${formatPrice(level.unitPrice, priceCurrency)}`}>
          <strong>{formatPrice(level.unitPrice, priceCurrency)}</strong>
          <span>{formatMarketInteger(level.quantity)} wanted</span>
        </button>
      ))}</div>
    </section>
  );
}

function BookLoading({
  loading,
  error,
  onRetry
}: {
  loading: boolean;
  error: MarketClientError | null;
  onRetry(): void;
}): React.JSX.Element {
  return (
    <section className="market-item-detail market-item-detail-empty" aria-busy={loading}>
      <BookUpdateStatus error={error} onRetry={onRetry} />
      {loading ? <span className="market-quote-spinner" role="status" aria-label="Loading offers" /> : !error ? "Choose an item." : null}
    </section>
  );
}

function BookUpdateStatus({
  error,
  onRetry
}: {
  error: MarketClientError | null;
  onRetry(): void;
}): React.JSX.Element | null {
  if (!error) return null;
  const rateLimited = error.code === "MARKET_RATE_LIMITED";
  return (
    <div className="market-inline-warning" role="status" aria-live="polite">
      <p>{rateLimited
        ? "Live offer updates are paused. Retrying shortly."
        : error.message}</p>
      {!rateLimited ? (
        <button type="button" className="market-secondary-action" onClick={onRetry}>Retry</button>
      ) : null}
    </div>
  );
}

export function quickTradeLevels(levels: MarketDepthLevel[]): MarketDepthLevel[] {
  const aggregated: MarketDepthLevel[] = [];
  const byPrice = new Map<string, MarketDepthLevel>();
  for (const level of levels) {
    const existing = byPrice.get(level.unitPrice);
    if (existing) {
      existing.quantity = (BigInt(existing.quantity) + BigInt(level.quantity)).toString();
      existing.orderCount += level.orderCount;
      continue;
    }
    const copy = { ...level };
    byPrice.set(level.unitPrice, copy);
    aggregated.push(copy);
  }
  return aggregated.sort((left, right) => compareMarketIntegers(left.unitPrice, right.unitPrice));
}

function buyCapacityAtPrice(levels: MarketDepthLevel[], maximumUnitPrice: MarketInteger): MarketInteger {
  return levels
    .filter((level) => BigInt(level.unitPrice) <= BigInt(maximumUnitPrice))
    .reduce((total, level) => total + BigInt(level.quantity), 0n)
    .toString();
}

export function quickTradeSellProceeds(gross: bigint | null, fee: bigint | null, listingFee: MarketInteger): bigint | null {
  if (gross === null || fee === null) return null;
  const proceeds = gross - fee - BigInt(listingFee);
  return proceeds < 0n ? 0n : proceeds;
}

export function canCreateOrder(controls: MarketControlSnapshot): boolean {
  return controls.accessAllowed && !controls.readOnly && controls.newOrdersEnabled && controls.matchingEnabled && !controls.venueFrozen && !controls.playerFrozen;
}

export function ownedMarketQuantity(
  inventory: PlayerInventorySnapshot,
  itemId: string,
  variant: string | null = null
): number {
  return inventory.items.filter((item) =>
    item.resourceType === itemId && item.variant === variant
  ).reduce((total, item) => total + item.quantity, 0);
}

function estimateCrossingQuantity(book: MarketBookSnapshot, side: MarketOrderSide, quantity: MarketInteger, unitPrice: MarketInteger): bigint {
  const desired = BigInt(quantity);
  const limit = BigInt(unitPrice);
  const eligible = side === "buy" ? book.asks.filter((level) => BigInt(level.unitPrice) <= limit) : book.bids.filter((level) => BigInt(level.unitPrice) >= limit);
  let available = 0n;
  for (const level of eligible) { available += BigInt(level.quantity); if (available >= desired) return desired; }
  return available;
}

function compareMarketIntegers(left: MarketInteger, right: MarketInteger): number {
  const difference = BigInt(left) - BigInt(right);
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}
function clampBigInt(value: bigint, min: bigint, max: bigint): bigint { return value < min ? min : value > max ? max : value; }
function minBigInt(left: bigint, right: bigint): bigint { return left < right ? left : right; }

// Transitional export for existing focused tests while the production surface uses one Browse view.
export const QuickTradeView = StandardMarketBrowseView;
