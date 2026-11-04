import type { ShopProvenance } from "./shopProvenance.js";

export const MARKET_ORDER_SIDES = ["buy", "sell"] as const;
export type MarketOrderSide = (typeof MARKET_ORDER_SIDES)[number];

/**
 * A listing is priced in Gold or Glimmer. Each item has a separate book per
 * price currency and the books never match each other. Glimmer itself is
 * priced in Gold only.
 */
export const MARKET_PRICE_CURRENCIES = ["gold", "glimmer"] as const;
export type MarketPriceCurrency = (typeof MARKET_PRICE_CURRENCIES)[number];

/** Canonical wire representation for PostgreSQL bigint economic values. */
export type MarketInteger = string;

export const MARKET_ORDER_STATUSES = ["open", "partially_filled", "filled", "cancelled"] as const;
export type MarketOrderStatus = (typeof MARKET_ORDER_STATUSES)[number];

export const MARKET_COLLECTION_SCOPES = ["items", "gold", "all"] as const;
export type MarketCollectionScope = (typeof MARKET_COLLECTION_SCOPES)[number];
export const MARKET_TAX_TAGS = [
  "mining",
  "forestry",
  "hunting",
  "equipment",
  "cosmetic"
] as const;
export type MarketTaxTag = (typeof MARKET_TAX_TAGS)[number];

/** Largest fill set carried by one committed mutation result. */
export const MARKET_MAX_MUTATION_TRADES = 500;

export type MarketItemSummary = {
  itemId: string;
  itemIdentity: string;
  variant?: string | null;
  displayName: string;
  iconKey: string;
  category: string;
  bestAsk: MarketInteger | null;
  bestBid: MarketInteger | null;
  availableSellQuantity: MarketInteger;
  availableBuyQuantity: MarketInteger;
  lastTradePrice: MarketInteger | null;
  bookVersion: MarketInteger;
  /** Present on a Glimmer-priced book; absent means Gold. */
  priceCurrency?: MarketPriceCurrency;
  /** On a Gold summary: the item's Glimmer book, when it has open orders. */
  glimmerBestAsk?: MarketInteger | null;
  glimmerBestBid?: MarketInteger | null;
  glimmerSellQuantity?: MarketInteger;
  glimmerBuyQuantity?: MarketInteger;
  /** Version of the Glimmer book, so a Glimmer-only change still refreshes the row. */
  glimmerBookVersion?: MarketInteger;
  /** One exact Glimmer Shop copy (face_mask / manor_skin book): its tag and original buyer. */
  provenance?: ShopProvenance;
};

export type MarketDepthLevel = {
  unitPrice: MarketInteger;
  quantity: MarketInteger;
  orderCount: number;
};

export type MarketPublicTrade = {
  tradeId: string;
  quantity: MarketInteger;
  unitPrice: MarketInteger;
  total: MarketInteger;
  buyerTax: MarketInteger;
  sellerProceeds: MarketInteger;
  buyerTaxBps: number;
  specialtyTaxApplied: boolean;
  qualifyingTaxTag: MarketTaxTag | null;
  createdAt: string;
};

export type MarketBookSnapshot = {
  item: MarketItemSummary;
  asks: MarketDepthLevel[];
  bids: MarketDepthLevel[];
  recentTrades: MarketPublicTrade[];
};

export type MarketOrderSnapshot = {
  orderId: string;
  itemId: string;
  itemIdentity: string;
  variant?: string | null;
  displayName: string;
  side: MarketOrderSide;
  policy: "gtc" | "aon_ioc";
  unitPrice: MarketInteger;
  originalQuantity: MarketInteger;
  filledQuantity: MarketInteger;
  remainingQuantity: MarketInteger;
  status: MarketOrderStatus;
  prioritySequence: MarketInteger;
  createdAt: string;
  cancelledAt: string | null;
  completedAt: string | null;
  /** Present on a Glimmer-priced order; absent means Gold. */
  priceCurrency?: MarketPriceCurrency;
};

export type MarketPlayerFill = {
  tradeId: string;
  orderId: string;
  side: MarketOrderSide;
  itemId: string;
  itemIdentity?: string | undefined;
  variant?: string | null;
  displayName: string;
  quantity: MarketInteger;
  unitPrice: MarketInteger;
  total: MarketInteger;
  createdAt: string;
  priceCurrency?: MarketPriceCurrency;
};

export type MarketCollectionItem = {
  itemId: string;
  itemIdentity: string;
  displayName: string;
  variant: string | null;
  quantity: MarketInteger;
};

export type MarketCollectionSnapshot = {
  items: MarketCollectionItem[];
  gold: MarketInteger;
  equipment: MarketEquipmentListingSnapshot[];
};

export type MarketControlSnapshot = {
  accessAllowed: boolean;
  readOnly: boolean;
  newOrdersEnabled: boolean;
  matchingEnabled: boolean;
  cancellationsEnabled: boolean;
  claimsEnabled: boolean;
  venueFrozen: boolean;
  playerFrozen: boolean;
  message: string | null;
};

export type MarketPlayerSnapshot = {
  walletGold: MarketInteger;
  walletVersion: MarketInteger;
  activeOrders: MarketOrderSnapshot[];
  recentOrders: MarketOrderSnapshot[];
  recentFills: MarketPlayerFill[];
  collection: MarketCollectionSnapshot;
};

export type MarketSnapshot = {
  venue: {
    venueId: string;
    venueKey: string;
    displayName: string;
    scopeType: "global_test" | "trade_hub" | "regional";
    cityId: string | null;
    cityName: string | null;
    marketStructureId: string | null;
    activeMonumentTypes: readonly ("mining" | "forestry" | "hunting")[];
    standardBuyerTaxBps: number;
    specialtyBuyerTaxBps: number;
    taxRevision: MarketInteger;
  };
  sessionId: string;
  controls: MarketControlSnapshot;
  categories: string[];
  items: MarketItemSummary[];
  equipmentListings: MarketEquipmentListingSnapshot[];
  nextCursor: string | null;
  player: MarketPlayerSnapshot;
  feePolicy: {
    version: number;
    listingFee: MarketInteger;
    buyerFeeBps: number;
    sellerFeeBps: number;
    cancellationFee: MarketInteger;
  };
};

export type MarketQuote = {
  quoteId: string;
  itemId: string;
  itemIdentity: string;
  variant?: string | null;
  requestedQuantity: MarketInteger;
  requestedMaximumUnitPrice: MarketInteger;
  fillableQuantity: MarketInteger;
  quotedTotal: MarketInteger;
  grossItemTotal: MarketInteger;
  buyerTax: MarketInteger;
  buyerTotal: MarketInteger;
  appliedBuyerTaxBps: number;
  taxLabel: string;
  districtType: "mining" | "forestry" | "hunting" | null;
  taxRevision: MarketInteger;
  specialtyTaxApplied: boolean;
  qualifyingTaxTag: MarketTaxTag | null;
  maximumUnitPrice: MarketInteger | null;
  fullQuantityAvailable: boolean;
  availability: "available" | "no_eligible_liquidity" | "self_trade_only" | "quantity_unavailable";
  bookVersion: MarketInteger;
  expiresAt: string;
  priceCurrency?: MarketPriceCurrency;
};

export type MarketMutationResult = {
  action:
    | "create_order"
    | "simple_buy"
    | "cancel_order"
    | "claim"
    | "create_equipment_listing"
    | "purchase_equipment_listing"
    | "cancel_equipment_listing";
  requestId: string;
  replayed: boolean;
  order: MarketOrderSnapshot | null;
  trades: MarketPublicTrade[];
  claimedItems: MarketInteger;
  claimedGold: MarketInteger;
  claimedEquipment: number;
  equipmentListing: MarketEquipmentListingSnapshot | null;
  player: MarketPlayerSnapshot;
};

export type MarketEquipmentListingStatus =
  | "open"
  | "sold"
  | "cancelled"
  | "claimed";

export type MarketEquipmentListingSnapshot = {
  listingId: string;
  venueId: string;
  equipmentInstanceId: string;
  definitionId: string;
  displayName: string;
  artworkKey: string;
  category: string;
  slot: string;
  itemLevel: number;
  maximumItemLevel: number;
  condition?: number;
  maximumCondition?: number;
  balanceVersion: number;
  derivedStats: Record<string, number | string | boolean | null>;
  utilityIdentity: string | null;
  enchantmentIdentity: string | null;
  cosmeticIdentity: string | null;
  ring?: import("./rings.js").RingInstanceView;
  /** Name, inscriber and counters of an inscribed item, as listed. */
  inscription?: import("./inscription.js").InscriptionSnapshot;
  sellerPlayerId: string;
  askingPrice: MarketInteger;
  buyerTax: MarketInteger;
  buyerTotal: MarketInteger;
  buyerTaxBps: number;
  status: MarketEquipmentListingStatus;
  version: MarketInteger;
  createdAt: string;
  /** Present on a Glimmer-priced listing; absent means Gold. */
  priceCurrency?: MarketPriceCurrency;
};

export type MarketReconciliationIssue = {
  code: string;
  scope: string;
  entityId: string | null;
  details: Record<string, unknown>;
};

export type MarketReconciliationReport = {
  ok: boolean;
  checkedAt: string;
  orderCount: number;
  tradeCount: number;
  ledgerGroupCount: number;
  collectionCount: number;
  issues: MarketReconciliationIssue[];
};
