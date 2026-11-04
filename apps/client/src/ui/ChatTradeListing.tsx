import {
  CHAT_TRADE_LISTING_MAX_PRICE,
  CHAT_TRADE_LISTING_MAX_QUANTITY,
  INVENTORY_CATALOG,
  chatTradeListingItemName,
  type ChatTradeListing,
  type ChatTradeListingCurrency,
  type ChatTradeListingKind,
  type EquipmentSnapshotV2,
  type PlayerInventorySnapshot
} from "@ash-atlas/shared";
import { useMemo, useState } from "react";

import { inventoryPanelRows } from "../inventory/inventoryPanelModel.js";
import { GameActionPrompt, type GamePromptAction } from "./GameActionPrompt.js";
import { CurrencyGlyph } from "./InventoryCarryList.js";
import { ItemArtwork } from "./ItemArtwork.js";
import { PriceCurrencyToggle } from "./market/MarketTradingViews.js";

const BUY_RESULT_LIMIT = 40;

/** Buy/Sell card shown inside a Trade chat row, under the sender's name. */
export function ChatTradeListingCard({ listing, onMessage }: Readonly<{
  listing: ChatTradeListing;
  /** Absent on your own listings and on messages that are not yet confirmed. */
  onMessage?: (() => void) | undefined;
}>): React.JSX.Element {
  const name = chatTradeListingItemName(listing.itemId);
  return (
    <div className={`chat-trade-listing chat-trade-listing-${listing.kind}`}>
      <ItemArtwork itemId={listing.itemId} label={name} />
      <div className="chat-trade-listing-text">
        <strong>{name}</strong>
        <span>
          <b className="chat-trade-listing-kind">{listing.kind === "sell" ? "SELLING" : "BUYING"}</b>
          {` ×${listing.quantity.toLocaleString()} · `}
          <b className={`chat-trade-listing-price chat-trade-listing-price-${listing.currency}`}>
            {listing.price.toLocaleString()}
          </b>
          <CurrencyGlyph kind={listing.currency} />
          {" each"}
        </span>
      </div>
      {onMessage ? (
        <button type="button" className="game-app-button game-app-button-compact chat-trade-listing-message" onClick={onMessage}>
          Message
        </button>
      ) : null}
    </div>
  );
}

type ListingItemOption = { itemId: string; name: string; owned: number | null };

/** Items the player carries or wears, merged per item (listings are per item, not per stack). */
function sellableItems(inventory: PlayerInventorySnapshot, equipment: EquipmentSnapshotV2 | null): ListingItemOption[] {
  const owned = new Map<string, number>();
  for (const row of inventoryPanelRows(inventory)) {
    if (row.quantity > 0) owned.set(row.itemId, (owned.get(row.itemId) ?? 0) + row.quantity);
  }
  for (const instance of equipment?.instances ?? []) {
    if (instance.location !== "inventory" && instance.location !== "equipped") continue;
    owned.set(instance.definitionId, (owned.get(instance.definitionId) ?? 0) + 1);
  }
  return [...owned.entries()]
    .filter(([itemId]) => Object.hasOwn(INVENTORY_CATALOG, itemId))
    .map(([itemId, quantity]) => ({ itemId, name: chatTradeListingItemName(itemId), owned: quantity }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function positiveInteger(value: string, maximum: number): number | null {
  if (!/^\d+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= maximum ? parsed : null;
}

/** Composer flow: Buy or Sell → item → quantity, price each, currency → post. */
export function ChatTradeListingComposer({ readInventory, onPost, onClose }: Readonly<{
  readInventory(): { inventory: PlayerInventorySnapshot; equipment: EquipmentSnapshotV2 | null } | null;
  onPost(listing: ChatTradeListing): boolean;
  onClose(): void;
}>): React.JSX.Element {
  const [kind, setKind] = useState<ChatTradeListingKind | null>(null);
  const [item, setItem] = useState<ListingItemOption | null>(null);
  const [query, setQuery] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [price, setPrice] = useState("");
  const [currency, setCurrency] = useState<ChatTradeListingCurrency>("gold");
  const [error, setError] = useState<string | null>(null);
  // The carried inventory is read once when the composer opens; the server re-checks on post.
  const [owned] = useState(() => {
    const source = readInventory();
    return source ? sellableItems(source.inventory, source.equipment) : [];
  });
  const options = useMemo((): ListingItemOption[] => {
    const needle = query.trim().toLocaleLowerCase();
    const matches = (option: { name: string }): boolean =>
      needle === "" || option.name.toLocaleLowerCase().includes(needle);
    if (kind === "sell") return owned.filter(matches);
    return Object.values(INVENTORY_CATALOG)
      .map((entry) => ({ itemId: entry.itemId, name: entry.displayName, owned: null }))
      .filter(matches)
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(0, BUY_RESULT_LIMIT);
  }, [kind, owned, query]);

  if (kind === null) {
    return <GameActionPrompt
      modal
      movable={false}
      elevated
      title="Trade Listing"
      ariaLabel="Post a Buy or Sell listing"
      actions={[
        { key: "buy", label: "Buy", tone: "secondary", onSelect: () => setKind("buy") },
        { key: "sell", label: "Sell", onSelect: () => setKind("sell") }
      ]}
      onCancel={onClose}
    />;
  }

  if (item === null) {
    return <GameActionPrompt
      modal
      movable={false}
      elevated
      title="Choose Item"
      category={kind === "sell" ? "Selling" : "Buying"}
      ariaLabel={kind === "sell" ? "Choose an item to sell" : "Choose an item to buy"}
      content={<div className="gift-compose trade-listing-compose">
        <input
          type="text"
          enterKeyHint="search"
          className="gift-compose-message trade-listing-search"
          placeholder="Search items"
          aria-label="Search items"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
        <div className="gift-compose-picker">
          {options.length === 0 ? <p className="gift-compose-empty">
            {kind === "sell" && owned.length === 0 ? "You have nothing to sell." : "No items found."}
          </p> : null}
          {options.map((option) => <button type="button" key={option.itemId} className="gift-compose-pick"
            onClick={() => {
              setItem(option);
              setQuantity("1");
              setError(null);
            }}>
            <ItemArtwork itemId={option.itemId} label={option.name} nameTooltip={false} />
            <span><strong>{option.name}</strong>
              {option.owned !== null ? <small>x{option.owned.toLocaleString()}</small> : null}</span>
          </button>)}
        </div>
      </div>}
      actions={[]}
      cancelLabel="Back"
      onCancel={() => { setKind(null); setQuery(""); }}
    />;
  }

  const quantityLimit = kind === "sell" && item.owned !== null
    ? Math.min(item.owned, CHAT_TRADE_LISTING_MAX_QUANTITY)
    : CHAT_TRADE_LISTING_MAX_QUANTITY;
  const parsedQuantity = positiveInteger(quantity, quantityLimit);
  const parsedPrice = positiveInteger(price, CHAT_TRADE_LISTING_MAX_PRICE);
  const post = (): void => {
    if (parsedQuantity === null || parsedPrice === null) return;
    const sent = onPost({ kind, itemId: item.itemId, quantity: parsedQuantity, price: parsedPrice, currency });
    if (sent) onClose();
    else setError("You are offline. Reconnect to post this listing.");
  };
  const actions: GamePromptAction[] = [{
    key: "post",
    label: kind === "sell" ? "Post Sell Listing" : "Post Buy Listing",
    enabled: parsedQuantity !== null && parsedPrice !== null,
    onSelect: post
  }];
  return <GameActionPrompt
    modal
    movable={false}
    elevated
    title={item.name}
    category={kind === "sell" ? "Selling" : "Buying"}
    artwork={<ItemArtwork itemId={item.itemId} label={item.name} nameTooltip={false} />}
    detail={item.owned !== null ? `You have ${item.owned.toLocaleString()}` : null}
    message={error ? { text: error, tone: "error" } : null}
    content={<div className="trade-listing-compose trade-listing-fields">
      <label>
        <span>Quantity</span>
        <input
          className="gift-compose-message"
          inputMode="numeric"
          value={quantity}
          aria-invalid={parsedQuantity === null}
          onChange={(event) => setQuantity(event.currentTarget.value.replace(/\D/gu, "").slice(0, 7))}
        />
      </label>
      <label>
        <span>Price each</span>
        <input
          className="gift-compose-message"
          inputMode="numeric"
          value={price}
          placeholder="0"
          aria-invalid={price !== "" && parsedPrice === null}
          onChange={(event) => setPrice(event.currentTarget.value.replace(/\D/gu, "").slice(0, 10))}
        />
      </label>
      <PriceCurrencyToggle value={currency} disabled={false} onChange={setCurrency} />
    </div>}
    actions={actions}
    cancelLabel="Back"
    onCancel={() => { setItem(null); setError(null); }}
  />;
}
