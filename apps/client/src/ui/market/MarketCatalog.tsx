import {
  INVENTORY_CATALOG,
  premiumCurrencyForMarketItem,
  type MarketEquipmentListingSnapshot,
  type MarketItemSummary,
  type MarketOrderSnapshot,
  type PlayerInventorySnapshot
} from "@ash-atlas/shared";
import { useEffect, useRef } from "react";

import { formatGold, formatMarketInteger, formatPrice } from "../../market/marketFormat.js";
import { ItemArtwork } from "../ItemArtwork.js";
import { ringBonusSummary } from "../RingBonusLines.js";
import { ringViewBonusPresentation } from "../../inventory/ringPresentation.js";

type MarketCatalogProps = {
  items: MarketItemSummary[];
  inventory: PlayerInventorySnapshot;
  hasInventorySnapshot: boolean;
  selectedItemId: string | null;
  loading: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  paginationKey?: string;
  ownedOnly?: boolean;
  showGear?: boolean;
  hideStandardItems?: boolean;
  equipmentListings?: MarketEquipmentListingSnapshot[];
  ownPlayerId?: string | null;
  activeOrders?: MarketOrderSnapshot[];
  selectedEquipmentListingId?: string | null;
  onSelect(itemId: string): void;
  onLoadMore(): void;
  onSelectEquipment?(listing: MarketEquipmentListingSnapshot): void;
};

export function MarketCatalog({
  items,
  inventory,
  hasInventorySnapshot,
  selectedItemId,
  loading,
  hasMore,
  loadingMore,
  paginationKey = "",
  ownedOnly = false,
  showGear = false,
  hideStandardItems = false,
  equipmentListings = [],
  ownPlayerId = null,
  activeOrders = [],
  selectedEquipmentListingId = null,
  onSelect,
  onLoadMore,
  onSelectEquipment
}: MarketCatalogProps): React.JSX.Element {
  const loadMoreSentinelRef = useRef<HTMLDivElement>(null);
  const loadRequestedRef = useRef(false);
  const resultSetKey = JSON.stringify(items.map((item) => item.itemIdentity));

  useEffect(() => {
    loadRequestedRef.current = false;
  }, [paginationKey, resultSetKey]);

  useEffect(() => {
    const sentinel = loadMoreSentinelRef.current;
    if (!hasMore || !sentinel || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting) || loadingMore || loadRequestedRef.current) return;
      loadRequestedRef.current = true;
      onLoadMore();
    }, { rootMargin: "160px 0px" });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loadingMore, onLoadMore]);

  const catalogItems = items.flatMap((item) => {
    const catalog = INVENTORY_CATALOG[item.itemId];
    if (!catalog?.marketTradable && !premiumCurrencyForMarketItem(item.itemId)) return [];
    if (ownedOnly) {
      if (hasInventorySnapshot && ownedMarketQuantity(inventory, item.itemId, item.variant ?? null) === 0) return [];
      return [{ item, availableSellQuantity: (BigInt(item.availableSellQuantity) + BigInt(item.glimmerSellQuantity ?? "0")).toString() }];
    }
    if (item.bestAsk === null && (item.glimmerBestAsk ?? null) === null) return [];
    // Count other players' listings across the Gold and Glimmer books.
    const ownListed = (currency: "gold" | "glimmer"): bigint => activeOrders
      .filter((order) => order.side === "sell" && order.itemIdentity === item.itemIdentity &&
        (order.priceCurrency ?? "gold") === currency)
      .reduce((total, order) => total + BigInt(order.remainingQuantity), 0n);
    const externalQuantity = BigInt(nonNegativeDifference(item.availableSellQuantity, ownListed("gold"))) +
      BigInt(nonNegativeDifference(item.glimmerSellQuantity ?? "0", ownListed("glimmer")));
    return externalQuantity > 0n ? [{ item, availableSellQuantity: externalQuantity.toString() }] : [];
  });
  const openEquipmentListings = equipmentListings.filter(
    (listing) => listing.status === "open" && listing.sellerPlayerId !== ownPlayerId
  );
  return (
    <section className="market-catalog" aria-label="Market assets" aria-busy={loading}>
      {!hideStandardItems && loading && catalogItems.length === 0 ? (
        <div className="market-empty compact"><strong>Loading listings…</strong></div>
      ) : !hideStandardItems && catalogItems.length === 0 ? (
        <div className="market-empty compact">
          <strong>{ownedOnly ? "Nothing here to sell" : "No listings"}</strong>
        </div>
      ) : !hideStandardItems ? (
        <div className="market-item-grid">
          {catalogItems.map(({ item, availableSellQuantity }) => {
            const owned = ownedMarketQuantity(inventory, item.itemId, item.variant ?? null);
            return (
              <button
                key={item.itemIdentity}
                type="button"
                className={`market-item-card${selectedItemId === item.itemIdentity ? " selected" : ""}`}
                aria-pressed={selectedItemId === item.itemIdentity}
                onClick={() => onSelect(item.itemIdentity)}
              >
                <MarketItemIcon iconKey={item.iconKey} category={item.category} variant={item.variant ?? null} label={item.displayName} />
                <span className="market-item-card-copy">
                  <strong>{item.displayName}</strong>
                  {item.provenance ? <small>Tag #{item.provenance.tag} · Originally bought by {item.provenance.originalBuyerName}</small> : null}
                  <small><b>Owned</b> {hasInventorySnapshot ? owned.toLocaleString() : "—"} · <b>For sale</b> {formatMarketInteger(availableSellQuantity)}</small>
                </span>
                <span className="market-item-row-price">
                  <CatalogPrice item={item} />
                </span>
                <span className="market-row-chevron" aria-hidden="true">›</span>
              </button>
            );
          })}
        </div>
      ) : null}
      {!hideStandardItems && hasMore ? <div ref={loadMoreSentinelRef} className="market-load-more-sentinel">
        {loadingMore ? <span role="status" aria-live="polite">Loading more listings…</span> : null}
      </div> : null}
      {showGear ? (
        <section className="market-asset-group market-gear-catalog" aria-label="Gear listings">
          {openEquipmentListings.length === 0 ? (
            <div className="market-empty compact"><strong>No equipment listed</strong></div>
          ) : (
            <div className="market-item-grid market-equipment-row-list">
              {openEquipmentListings.map((listing) => (
                <button
                  key={listing.listingId}
                  type="button"
                  className={`market-item-card market-equipment-row${selectedEquipmentListingId === listing.listingId ? " selected" : ""}`}
                  aria-pressed={selectedEquipmentListingId === listing.listingId}
                  onClick={() => onSelectEquipment?.(listing)}
                >
                  <MarketItemIcon iconKey={listing.artworkKey} category={listing.category} label={listing.displayName} />
                  <span className="market-item-card-copy">
                    <strong>{listing.displayName}</strong>
                    <small>{listing.ring
                      ? ringBonusSummary(ringViewBonusPresentation(listing.ring, listing.equipmentInstanceId))
                      : `Level ${listing.itemLevel} · ${humanize(listing.slot)} · Exact item`}</small>
                  </span>
                  <span className="market-item-row-price"><strong>{formatPrice(listing.askingPrice, listing.priceCurrency)}</strong><small>+ {formatPrice(listing.buyerTax, listing.priceCurrency)} tax</small></span>
                  <span className="market-row-chevron" aria-hidden="true">›</span>
                </button>
              ))}
            </div>
          )}
        </section>
      ) : null}
    </section>
  );
}

/** Best Gold price first; the Glimmer book adds one compact line (or leads when it is the only one). */
function CatalogPrice({ item }: { item: MarketItemSummary }): React.JSX.Element {
  const glimmerAsk = item.glimmerBestAsk ?? null;
  const glimmerBid = item.glimmerBestBid ?? null;
  const lead = item.bestAsk !== null
    ? formatGold(item.bestAsk)
    : glimmerAsk !== null ? formatPrice(glimmerAsk, "glimmer") : "No ask";
  const detail = item.bestAsk !== null && glimmerAsk !== null
    ? `or ${formatPrice(glimmerAsk, "glimmer")}`
    : item.bestBid !== null
      ? `Bid ${formatGold(item.bestBid)}`
      : glimmerBid !== null ? `Bid ${formatPrice(glimmerBid, "glimmer")}` : "Buy orders welcome";
  return <><strong>{lead}</strong><small>{detail}</small></>;
}

export function MarketItemIcon({
  iconKey,
  category,
  variant,
  label = humanize(iconKey)
}: {
  iconKey: string;
  category?: string | null;
  variant?: string | null;
  label?: string;
}): React.JSX.Element {
  return (
    <span className="market-item-icon" aria-hidden="true">
      <ItemArtwork itemId={iconKey} category={category} variant={variant} label={label} />
    </span>
  );
}

function ownedMarketQuantity(
  inventory: PlayerInventorySnapshot,
  itemId: string,
  variant: string | null
): number {
  return inventory.items
    .filter((entry) => entry.resourceType === itemId && entry.variant === variant)
    .reduce((total, entry) => total + entry.quantity, 0);
}

function nonNegativeDifference(total: string, subtraction: bigint): string {
  const difference = BigInt(total) - subtraction;
  return (difference > 0n ? difference : 0n).toString();
}

function humanize(value: string): string {
  return value.replace(/[_-]+/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}
