import type {
  MarketCollectionScope,
  MarketControlSnapshot,
  MarketOrderSnapshot,
  MarketPlayerSnapshot
} from "@ash-atlas/shared";
import { useState } from "react";

import { formatGold, formatMarketInteger, formatPrice } from "../../market/marketFormat.js";
import { MarketItemIcon } from "./MarketCatalog.js";

type OrdersViewProps = {
  player: MarketPlayerSnapshot;
  controls: MarketControlSnapshot;
  connected: boolean;
  pending: boolean;
  view?: "active" | "history";
  onCancel(orderId: string): boolean;
};

export function MarketOrdersView({
  player,
  controls,
  connected,
  pending,
  view = "active",
  onCancel
}: OrdersViewProps): React.JSX.Element {
  const [reviewOrderId, setReviewOrderId] = useState<string | null>(null);
  const active = player.activeOrders;
  const recent = player.recentOrders.filter(
    (order) => !active.some((activeOrder) => activeOrder.orderId === order.orderId)
  );
  const canCancel = connected && !pending && controls.accessAllowed &&
    !controls.readOnly && controls.cancellationsEnabled &&
    !controls.venueFrozen && !controls.playerFrozen;

  if (view === "history") {
    return (
      <div className="market-account-view">
        <section className="market-account-section">
          <header className="market-section-heading">
            <div><h2>Recent fills</h2></div>
          </header>
          {player.recentFills.length === 0 ? (
            <div className="market-empty compact">No recent fills</div>
          ) : (
            <div className="market-table-scroll">
              <table className="market-history-table">
                <thead><tr><th>Item</th><th>Side</th><th>Quantity</th><th>Price</th><th>Total</th><th>Time</th></tr></thead>
                <tbody>{player.recentFills.map((fill) => (
                  <tr key={`${fill.tradeId}:${fill.orderId}`}>
                    <td><span className="market-history-item"><MarketItemIcon iconKey={fill.itemId} variant={fill.variant ?? null} label={fill.displayName} />{fill.displayName}</span></td>
                    <td><span className={`market-side market-side-${fill.side}`}>{fill.side}</span></td>
                    <td>{formatMarketInteger(fill.quantity)}</td><td>{formatPrice(fill.unitPrice, fill.priceCurrency)}</td><td>{formatPrice(fill.total, fill.priceCurrency)}</td><td>{formatTimestamp(fill.createdAt)}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </section>
        <section className="market-account-section">
          <header className="market-section-heading"><div><h2>Recent orders</h2></div></header>
          {recent.length ? <div className="market-order-list compact">{recent.map((order) => <OrderRow key={order.orderId} order={order} />)}</div> : <div className="market-empty compact">No recently closed orders</div>}
        </section>
      </div>
    );
  }

  return (
    <div className="market-account-view">
      <section className="market-account-section">
        {active.length === 0 ? (
          <div className="market-empty"><strong>No open orders</strong></div>
        ) : (
          <div className="market-order-list">
            {active.map((order) => (
              <OrderRow
                key={order.orderId}
                order={order}
                canCancel={canCancel}
                reviewing={reviewOrderId === order.orderId}
                onReview={() => setReviewOrderId(order.orderId)}
                onBack={() => setReviewOrderId(null)}
                onConfirm={() => {
                  if (onCancel(order.orderId)) setReviewOrderId(null);
                }}
              />
            ))}
          </div>
        )}
      </section>

    </div>
  );
}

type CollectionViewProps = {
  player: MarketPlayerSnapshot;
  controls: MarketControlSnapshot;
  connected: boolean;
  pending: boolean;
  onClaim(scope: MarketCollectionScope): boolean;
};

export function MarketCollectionView({
  player,
  controls,
  connected,
  pending,
  onClaim
}: CollectionViewProps): React.JSX.Element {
  const [reviewScope, setReviewScope] = useState<MarketCollectionScope | null>(null);
  const collection = player.collection;
  const hasItems = collection.items.some((item) => BigInt(item.quantity) > 0n);
  const hasEquipment = collection.equipment.length > 0;
  const hasGold = BigInt(collection.gold) > 0n;
  const canClaim = connected && !pending && controls.accessAllowed &&
    !controls.readOnly && controls.claimsEnabled && !controls.venueFrozen && !controls.playerFrozen;

  const reviewLabel = reviewScope === "gold"
    ? `Claim ${formatGold(collection.gold)}?`
    : reviewScope === "items"
      ? "Move available items into inventory?"
      : "Claim every available collection asset?";

  return (
    <div className="market-account-view">
      <section className="market-account-section market-collection-hero">
        <header className="market-section-heading">
          <div><h2>Collect</h2></div>
          <strong>{formatGold(collection.gold)}</strong>
        </header>
        <div className="market-collection-actions">
          <button type="button" disabled={!canClaim || (!hasItems && !hasEquipment)} onClick={() => setReviewScope("items")}>Claim items &amp; equipment</button>
          <button type="button" disabled={!canClaim || !hasGold} onClick={() => setReviewScope("gold")}>Claim gold</button>
          <button type="button" className="market-primary-action" disabled={!canClaim || (!hasItems && !hasEquipment && !hasGold)} onClick={() => setReviewScope("all")}>Claim all</button>
        </div>
        {reviewScope ? (
          <div className="market-review" role="group" aria-label="Review collection claim">
            <p>{reviewLabel}</p>
            <small>Anything that doesn't fit stays here.</small>
            <div>
              <button type="button" disabled={pending} onClick={() => setReviewScope(null)}>Back</button>
              <button
                type="button"
                className="market-confirm-action"
                disabled={!canClaim}
                onClick={() => {
                  if (onClaim(reviewScope)) setReviewScope(null);
                }}
              >
                Confirm claim
              </button>
            </div>
          </div>
        ) : null}
      </section>

      <section className="market-account-section">
        <header className="market-section-heading"><div><h2>Items</h2></div></header>
        {collection.items.length === 0 ? (
          <div className="market-empty compact">No items waiting</div>
        ) : (
          <div className="market-collection-grid">
            {collection.items.map((item) => (
              <div key={`${item.itemIdentity}:${item.variant ?? "default"}`} className="market-collection-item">
                <MarketItemIcon iconKey={item.itemId} variant={item.variant} label={item.displayName} />
                <span><strong>{item.displayName}</strong><small>{item.variant ?? "Standard"}</small></span>
                <b>×{formatMarketInteger(item.quantity)}</b>
              </div>
            ))}
          </div>
        )}
      </section>
      <section className="market-account-section">
        <header className="market-section-heading"><div><h2>Equipment</h2></div></header>
        {collection.equipment.length === 0 ? (
          <div className="market-empty compact">No equipment waiting</div>
        ) : (
          <div className="market-collection-grid">
            {collection.equipment.map((item) => (
              <div key={item.equipmentInstanceId} className="market-collection-item">
                <MarketItemIcon iconKey={item.artworkKey} category={item.category} label={item.displayName} />
                <span><strong>{item.displayName}</strong><small>Level {item.itemLevel} · {item.category}</small></span>
                <b>Exact item</b>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function OrderRow({
  order,
  canCancel = false,
  reviewing = false,
  onReview,
  onBack,
  onConfirm
}: {
  order: MarketOrderSnapshot;
  canCancel?: boolean;
  reviewing?: boolean;
  onReview?: () => void;
  onBack?: () => void;
  onConfirm?: () => void;
}): React.JSX.Element {
  return (
    <article className="market-order-row">
      <div className="market-order-primary">
        <span className={`market-side market-side-${order.side}`}>{order.side}</span>
        <span className="market-order-item"><MarketItemIcon iconKey={order.itemId} variant={order.variant ?? null} label={order.displayName} /><strong>{order.displayName}</strong></span>
        <small>{formatTimestamp(order.createdAt)}</small>
      </div>
      <dl>
        <div><dt>Limit</dt><dd>{formatPrice(order.unitPrice, order.priceCurrency)}</dd></div>
        <div><dt>Filled</dt><dd>{formatMarketInteger(order.filledQuantity)} / {formatMarketInteger(order.originalQuantity)}</dd></div>
        <div><dt>Status</dt><dd>{order.status.replace("_", " ")}</dd></div>
      </dl>
      {reviewing ? (
        <div className="market-order-cancel-review">
          <span>Cancel the unfilled part?</span>
          <button type="button" onClick={onBack}>Back</button>
          <button type="button" className="danger" disabled={!canCancel} onClick={onConfirm}>Confirm cancel</button>
        </div>
      ) : onReview ? (
        <button type="button" className="market-cancel-order" disabled={!canCancel} onClick={onReview}>Cancel order</button>
      ) : null}
    </article>
  );
}

function formatTimestamp(value: string): string {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime())
    ? parsed.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : "Unknown time";
}
