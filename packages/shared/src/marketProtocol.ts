import { z } from "zod";
import { SHOP_TAG_PATTERN } from "./shopProvenance.js";

import type { PlayerInventorySnapshot } from "./collectibles.js";
import type { EquipmentSnapshotV2 } from "./equipment.js";
import type { PlayerWalletSnapshot } from "./wallet.js";
import { premiumWalletSnapshotSchema, type PremiumWalletSnapshot } from "./premiumCurrency.js";
import {
  MARKET_COLLECTION_SCOPES,
  MARKET_MAX_MUTATION_TRADES,
  MARKET_ORDER_SIDES,
  MARKET_PRICE_CURRENCIES,
  MARKET_TAX_TAGS,
  type MarketBookSnapshot,
  type MarketItemSummary,
  type MarketMutationResult,
  type MarketQuote,
  type MarketSnapshot
} from "./market.js";
import { inventoryServerSchema } from "./protocol/serverSchemaPrimitives.js";
import { equipmentSnapshotSchema } from "./protocol/combatEquipmentServerSchemas.js";

const marketInventorySnapshotSchema =
  inventoryServerSchema as unknown as z.ZodType<PlayerInventorySnapshot>;
const marketEquipmentSnapshotSchema =
  equipmentSnapshotSchema as unknown as z.ZodType<EquipmentSnapshotV2>;
const marketRequestIdSchema = z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const MAX_SIGNED_BIGINT = 9_223_372_036_854_775_807n;
const MARKET_INTEGER_PATTERN = /^(0|[1-9]\d{0,18})$/;
const POSITIVE_MARKET_INTEGER_PATTERN = /^[1-9]\d{0,18}$/;
export const marketIntegerSchema = z.string()
  .regex(MARKET_INTEGER_PATTERN)
  .refine((value) => isSignedBigint(value, MARKET_INTEGER_PATTERN), "Market integer exceeds signed bigint range");
const positiveMarketIntegerSchema = z.string()
  .regex(POSITIVE_MARKET_INTEGER_PATTERN)
  .refine((value) => isSignedBigint(value, POSITIVE_MARKET_INTEGER_PATTERN), "Market integer exceeds signed bigint range");
const marketItemIdentitySchema = z.string().min(1).max(160).regex(/^[a-z0-9_:-]+$/);
const legacyItemIdSchema = z.string().min(1).max(120).regex(/^[a-z0-9_]+$/);
const cursorSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/);
const marketSessionIdSchema = z.string().uuid();

function isSignedBigint(value: string, pattern: RegExp): boolean {
  return pattern.test(value) && BigInt(value) <= MAX_SIGNED_BIGINT;
}

export const marketOpenMessageSchema = z.object({
  type: z.literal("MARKET_OPEN"),
  requestId: marketRequestIdSchema,
  marketStructureId: z.string().uuid(),
  expectedPlacementRevision: positiveMarketIntegerSchema,
  search: z.string().trim().max(80).optional(),
  category: z.string().trim().min(1).max(80).optional(),
  cursor: cursorSchema.nullable().optional(),
  limit: z.number().int().min(1).max(40).optional(),
  listedOnly: z.boolean().optional()
}).strict();

export const marketBrowseMessageSchema = z.object({
  type: z.literal("MARKET_BROWSE"),
  requestId: marketRequestIdSchema,
  marketSessionId: marketSessionIdSchema,
  search: z.string().trim().max(80).optional(),
  category: z.string().trim().min(1).max(80).optional(),
  cursor: cursorSchema.nullable().optional(),
  limit: z.number().int().min(1).max(40).optional(),
  listedOnly: z.boolean().optional()
}).strict();

export const marketGetBookMessageSchema = z.object({
  type: z.literal("MARKET_GET_BOOK"),
  requestId: marketRequestIdSchema,
  marketSessionId: marketSessionIdSchema,
  itemIdentity: marketItemIdentitySchema.optional(),
  /** @deprecated Default-asset compatibility only. */
  itemId: legacyItemIdSchema.optional(),
  depth: z.number().int().min(1).max(25).optional(),
  /** Which of the item's books; Gold when omitted. */
  priceCurrency: z.enum(MARKET_PRICE_CURRENCIES).optional()
}).strict();

export const marketRequestQuoteMessageSchema = z.object({
  type: z.literal("MARKET_REQUEST_QUOTE"),
  requestId: marketRequestIdSchema,
  marketSessionId: marketSessionIdSchema,
  itemIdentity: marketItemIdentitySchema.optional(),
  /** @deprecated Default-asset compatibility only. */
  itemId: legacyItemIdSchema.optional(),
  quantity: positiveMarketIntegerSchema,
  maximumUnitPrice: positiveMarketIntegerSchema,
  priceCurrency: z.enum(MARKET_PRICE_CURRENCIES).optional()
}).strict();

export const marketCreateOrderMessageSchema = z.object({
  type: z.literal("MARKET_CREATE_ORDER"),
  requestId: marketRequestIdSchema,
  marketSessionId: marketSessionIdSchema,
  interface: z.enum(["simple", "merchant"]),
  side: z.enum(MARKET_ORDER_SIDES),
  itemIdentity: marketItemIdentitySchema.optional(),
  /** @deprecated Default-asset compatibility only. */
  itemId: legacyItemIdSchema.optional(),
  quantity: positiveMarketIntegerSchema,
  unitPrice: positiveMarketIntegerSchema,
  priceCurrency: z.enum(MARKET_PRICE_CURRENCIES).optional()
}).strict();

export const marketSimpleBuyMessageSchema = z.object({
  type: z.literal("MARKET_SIMPLE_BUY"),
  requestId: marketRequestIdSchema,
  marketSessionId: marketSessionIdSchema,
  quoteId: z.string().uuid(),
  maximumTotal: positiveMarketIntegerSchema
}).strict();

export const marketCancelOrderMessageSchema = z.object({
  type: z.literal("MARKET_CANCEL_ORDER"),
  requestId: marketRequestIdSchema,
  marketSessionId: marketSessionIdSchema,
  orderId: z.string().uuid()
}).strict();

export const marketClaimMessageSchema = z.object({
  type: z.literal("MARKET_CLAIM"),
  requestId: marketRequestIdSchema,
  marketSessionId: marketSessionIdSchema,
  scope: z.enum(MARKET_COLLECTION_SCOPES)
}).strict();

export const marketSetSubscriptionsMessageSchema = z.object({
  type: z.literal("MARKET_SET_SUBSCRIPTIONS"),
  requestId: marketRequestIdSchema,
  marketSessionId: marketSessionIdSchema,
  visibleItemIdentities: z.array(marketItemIdentitySchema).max(40).optional(),
  focusedItemIdentity: marketItemIdentitySchema.nullable().optional(),
  /** @deprecated Default-asset compatibility only. */
  visibleItemIds: z.array(legacyItemIdSchema).max(40).optional(),
  /** @deprecated Default-asset compatibility only. */
  focusedItemId: legacyItemIdSchema.nullable().optional(),
  privateState: z.boolean(),
  revision: z.number().int().nonnegative()
}).strict();

export const marketCreateEquipmentListingMessageSchema = z.object({
  type: z.literal("MARKET_CREATE_EQUIPMENT_LISTING"),
  requestId: marketRequestIdSchema,
  marketSessionId: marketSessionIdSchema,
  equipmentInstanceId: z.string().uuid(),
  askingPrice: positiveMarketIntegerSchema,
  expectedEquipmentRevision: marketIntegerSchema,
  priceCurrency: z.enum(MARKET_PRICE_CURRENCIES).optional()
}).strict();

export const marketPurchaseEquipmentListingMessageSchema = z.object({
  type: z.literal("MARKET_PURCHASE_EQUIPMENT_LISTING"),
  requestId: marketRequestIdSchema,
  marketSessionId: marketSessionIdSchema,
  listingId: z.string().uuid(),
  expectedListingVersion: marketIntegerSchema,
  maximumBuyerTotal: positiveMarketIntegerSchema,
  expectedTaxRevision: marketIntegerSchema,
  /** The currency the buyer saw; a listing priced otherwise is refused. */
  expectedPriceCurrency: z.enum(MARKET_PRICE_CURRENCIES)
}).strict();

export const marketCancelEquipmentListingMessageSchema = z.object({
  type: z.literal("MARKET_CANCEL_EQUIPMENT_LISTING"),
  requestId: marketRequestIdSchema,
  marketSessionId: marketSessionIdSchema,
  listingId: z.string().uuid(),
  expectedListingVersion: marketIntegerSchema
}).strict();

export const marketClientMessageSchema = z.discriminatedUnion("type", [
  marketOpenMessageSchema,
  marketBrowseMessageSchema,
  marketGetBookMessageSchema,
  marketRequestQuoteMessageSchema,
  marketCreateOrderMessageSchema,
  marketSimpleBuyMessageSchema,
  marketCancelOrderMessageSchema,
  marketClaimMessageSchema,
  marketSetSubscriptionsMessageSchema,
  marketCreateEquipmentListingMessageSchema,
  marketPurchaseEquipmentListingMessageSchema,
  marketCancelEquipmentListingMessageSchema
]).superRefine((message, context) => {
  if (
    ["MARKET_GET_BOOK", "MARKET_REQUEST_QUOTE", "MARKET_CREATE_ORDER"].includes(message.type) &&
    !("itemIdentity" in message && message.itemIdentity) &&
    !("itemId" in message && message.itemId)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["itemIdentity"],
      message: "Market item identity is required"
    });
  }
  if (
    message.type === "MARKET_SET_SUBSCRIPTIONS" &&
    message.visibleItemIdentities === undefined &&
    message.visibleItemIds === undefined
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["visibleItemIdentities"],
      message: "Visible market item identities are required"
    });
  }
});

export type MarketClientMessage = z.infer<typeof marketClientMessageSchema>;

export type MarketServerMessage =
  | { type: "MARKET_OPEN_RESULT"; requestId: string; snapshot: MarketSnapshot }
  | { type: "MARKET_BROWSE_RESULT"; requestId: string; snapshot: MarketSnapshot }
  | { type: "MARKET_BOOK_RESULT"; requestId: string; book: MarketBookSnapshot }
  | { type: "MARKET_QUOTE_RESULT"; requestId: string; quote: MarketQuote }
  | {
      type: "MARKET_MUTATION_RESULT";
      requestId: string;
      result: MarketMutationResult;
      inventory: PlayerInventorySnapshot;
      equipment?: EquipmentSnapshotV2 | undefined;
    }
  | {
      type: "MARKET_SUBSCRIPTIONS_SET";
      requestId: string;
      revision: number;
    }
  | {
      type: "MARKET_ITEM_SUMMARY_CHANGED";
      item: MarketItemSummary;
    }
  | {
      type: "MARKET_BOOK_CHANGED";
      itemIdentity?: string | undefined;
      /** @deprecated Default-asset compatibility only. */
      itemId?: string | undefined;
      bookVersion: string;
      priceCurrency?: "gold" | "glimmer" | undefined;
    }
  | {
      type: "MARKET_PLAYER_STATE_CHANGED";
      reason: "order" | "fill" | "cancel" | "collection" | "claim" | "controls";
    }
  | {
      type: "MARKET_ASSETS_CHANGED";
      wallet: PlayerWalletSnapshot;
      inventory: PlayerInventorySnapshot;
      equipment?: EquipmentSnapshotV2 | undefined;
      /** Present when the committed change moved Glimmer. */
      premiumWallet?: PremiumWalletSnapshot | undefined;
    }
  | {
      type: "MARKET_ERROR";
      requestId: string;
      code: string;
      message: string;
      retryable: boolean;
    };

const marketShortStringSchema = (maximum: number) => z.string().min(1).max(maximum);
const marketTimestampSchema = z.string().max(64).refine(
  (value) => Number.isFinite(Date.parse(value)),
  "Invalid market timestamp"
);
const marketNullableIntegerSchema = marketIntegerSchema.nullable();
const marketItemSummarySchema = z.object({
  itemId: marketShortStringSchema(120),
  itemIdentity: marketShortStringSchema(180),
  variant: marketShortStringSchema(120).nullable().default(null),
  displayName: marketShortStringSchema(160),
  iconKey: marketShortStringSchema(120),
  category: marketShortStringSchema(80),
  bestAsk: marketNullableIntegerSchema,
  bestBid: marketNullableIntegerSchema,
  availableSellQuantity: marketIntegerSchema,
  availableBuyQuantity: marketIntegerSchema,
  lastTradePrice: marketNullableIntegerSchema,
  bookVersion: marketIntegerSchema,
  priceCurrency: z.enum(MARKET_PRICE_CURRENCIES).optional(),
  glimmerBestAsk: marketNullableIntegerSchema.optional(),
  glimmerBestBid: marketNullableIntegerSchema.optional(),
  glimmerSellQuantity: marketIntegerSchema.optional(),
  glimmerBuyQuantity: marketIntegerSchema.optional(),
  glimmerBookVersion: marketIntegerSchema.optional(),
  provenance: z.object({
    tag: z.string().regex(SHOP_TAG_PATTERN),
    originalBuyerName: z.string().min(1).max(80)
  }).strict().optional()
}).strict();
const marketDepthLevelSchema = z.object({
  unitPrice: marketIntegerSchema,
  quantity: marketIntegerSchema,
  orderCount: z.number().int().positive().safe()
}).strict();
const marketPublicTradeSchema = z.object({
  tradeId: marketShortStringSchema(128),
  quantity: marketIntegerSchema,
  unitPrice: marketIntegerSchema,
  total: marketIntegerSchema,
  buyerTax: marketIntegerSchema,
  sellerProceeds: marketIntegerSchema,
  buyerTaxBps: z.number().int().min(0).max(10_000),
  specialtyTaxApplied: z.boolean(),
  qualifyingTaxTag: z.enum(MARKET_TAX_TAGS).nullable(),
  createdAt: marketTimestampSchema
}).strict();
const marketBookSnapshotSchema = z.object({
  item: marketItemSummarySchema,
  asks: z.array(marketDepthLevelSchema).max(25),
  bids: z.array(marketDepthLevelSchema).max(25),
  recentTrades: z.array(marketPublicTradeSchema).max(100)
}).strict().superRefine((book, context) => {
  for (const [side, levels] of [["asks", book.asks], ["bids", book.bids]] as const) {
    for (let index = 1; index < levels.length; index += 1) {
      const prior = BigInt(levels[index - 1]!.unitPrice);
      const current = BigInt(levels[index]!.unitPrice);
      if (side === "asks" ? current <= prior : current >= prior) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [side, index, "unitPrice"],
          message: `Market ${side} must be strictly price ordered`
        });
      }
    }
  }
});
const marketQuoteSchema = z.object({
  quoteId: marketShortStringSchema(128),
  itemId: marketShortStringSchema(120),
  itemIdentity: marketShortStringSchema(180),
  variant: marketShortStringSchema(120).nullable().default(null),
  requestedQuantity: marketIntegerSchema,
  requestedMaximumUnitPrice: marketIntegerSchema,
  fillableQuantity: marketIntegerSchema,
  quotedTotal: marketIntegerSchema,
  grossItemTotal: marketIntegerSchema,
  buyerTax: marketIntegerSchema,
  buyerTotal: marketIntegerSchema,
  appliedBuyerTaxBps: z.number().int().min(0).max(10_000),
  taxLabel: marketShortStringSchema(160),
  districtType: z.enum(["mining", "forestry", "hunting"]).nullable(),
  taxRevision: marketIntegerSchema,
  specialtyTaxApplied: z.boolean(),
  qualifyingTaxTag: z.enum(MARKET_TAX_TAGS).nullable(),
  maximumUnitPrice: marketNullableIntegerSchema,
  fullQuantityAvailable: z.boolean(),
  availability: z.enum([
    "available",
    "no_eligible_liquidity",
    "self_trade_only",
    "quantity_unavailable"
  ]),
  bookVersion: marketIntegerSchema,
  expiresAt: marketTimestampSchema,
  priceCurrency: z.enum(MARKET_PRICE_CURRENCIES).optional()
}).strict();
const marketOrderSchema = z.object({
  orderId: marketShortStringSchema(128),
  itemId: marketShortStringSchema(120),
  itemIdentity: marketShortStringSchema(180),
  variant: marketShortStringSchema(120).nullable().default(null),
  displayName: marketShortStringSchema(160),
  side: z.enum(MARKET_ORDER_SIDES),
  policy: z.enum(["gtc", "aon_ioc"]),
  unitPrice: marketIntegerSchema,
  originalQuantity: marketIntegerSchema,
  filledQuantity: marketIntegerSchema,
  remainingQuantity: marketIntegerSchema,
  status: z.enum(["open", "partially_filled", "filled", "cancelled", "expired"]),
  prioritySequence: marketIntegerSchema,
  createdAt: marketTimestampSchema,
  cancelledAt: marketTimestampSchema.nullable(),
  completedAt: marketTimestampSchema.nullable(),
  priceCurrency: z.enum(MARKET_PRICE_CURRENCIES).optional()
}).strict();
const marketPlayerFillSchema = z.object({
  tradeId: marketShortStringSchema(128),
  orderId: marketShortStringSchema(128),
  side: z.enum(MARKET_ORDER_SIDES),
  itemId: marketShortStringSchema(120),
  itemIdentity: marketShortStringSchema(180).optional(),
  variant: marketShortStringSchema(120).nullable().default(null),
  displayName: marketShortStringSchema(160),
  quantity: marketIntegerSchema,
  unitPrice: marketIntegerSchema,
  total: marketIntegerSchema,
  createdAt: marketTimestampSchema,
  priceCurrency: z.enum(MARKET_PRICE_CURRENCIES).optional()
}).strict();
const marketCollectionItemSchema = z.object({
  itemId: marketShortStringSchema(120),
  itemIdentity: marketShortStringSchema(180),
  displayName: marketShortStringSchema(160),
  variant: marketShortStringSchema(120).nullable(),
  quantity: marketIntegerSchema
}).strict();
const marketEquipmentListingSchema = z.object({
  listingId: z.string().uuid(),
  venueId: z.string().uuid(),
  equipmentInstanceId: z.string().uuid(),
  definitionId: marketShortStringSchema(120),
  displayName: marketShortStringSchema(160),
  artworkKey: marketShortStringSchema(160),
  category: marketShortStringSchema(80),
  slot: marketShortStringSchema(80),
  itemLevel: z.number().int().positive(),
  maximumItemLevel: z.number().int().positive(),
  condition: z.number().int().min(0).max(100).optional(),
  maximumCondition: z.literal(100).optional(),
  balanceVersion: z.number().int().positive(),
  derivedStats: z.record(
    z.string().max(120),
    z.union([z.number(), z.string(), z.boolean(), z.null()])
  ),
  utilityIdentity: marketShortStringSchema(160).nullable(),
  enchantmentIdentity: marketShortStringSchema(160).nullable(),
  cosmeticIdentity: marketShortStringSchema(160).nullable(),
  ring: z.object({
    tier: z.enum(["plain", "fine", "prime", "peerless"]),
    rough: z.boolean(),
    bonuses: z.array(z.object({
      id: marketShortStringSchema(64),
      family: marketShortStringSchema(32).optional()
    }).strict()).max(3)
  }).strict().optional(),
  inscription: z.object({
    name: marketShortStringSchema(40),
    inscriberName: marketShortStringSchema(80),
    inscribedAt: marketShortStringSchema(40),
    kind: z.enum(["weapon", "armor"]),
    stats: z.record(z.string().max(40), z.number())
  }).strict().optional(),
  sellerPlayerId: marketShortStringSchema(160),
  askingPrice: marketIntegerSchema,
  buyerTax: marketIntegerSchema,
  buyerTotal: marketIntegerSchema,
  buyerTaxBps: z.number().int().min(0).max(10_000),
  status: z.enum(["open", "sold", "cancelled", "claimed", "expired"]),
  version: marketIntegerSchema,
  createdAt: marketTimestampSchema,
  priceCurrency: z.enum(MARKET_PRICE_CURRENCIES).optional()
}).strict();
const marketPlayerSnapshotSchema = z.object({
  walletGold: marketIntegerSchema,
  walletVersion: marketIntegerSchema,
  activeOrders: z.array(marketOrderSchema).max(200),
  recentOrders: z.array(marketOrderSchema).max(200),
  recentFills: z.array(marketPlayerFillSchema).max(200),
  collection: z.object({
    gold: marketIntegerSchema,
    items: z.array(marketCollectionItemSchema).max(200),
    equipment: z.array(marketEquipmentListingSchema).max(200)
  }).strict()
}).strict();
const marketControlsSchema = z.object({
  accessAllowed: z.boolean(),
  readOnly: z.boolean(),
  newOrdersEnabled: z.boolean(),
  matchingEnabled: z.boolean(),
  cancellationsEnabled: z.boolean(),
  claimsEnabled: z.boolean(),
  venueFrozen: z.boolean(),
  playerFrozen: z.boolean(),
  message: marketShortStringSchema(500).nullable()
}).strict();
const marketSnapshotSchema = z.object({
  venue: z.object({
    venueId: marketShortStringSchema(128),
    venueKey: marketShortStringSchema(120),
    displayName: marketShortStringSchema(160),
    scopeType: z.enum(["global_test", "trade_hub", "regional"]),
    cityId: z.string().uuid().nullable(),
    cityName: marketShortStringSchema(160).nullable(),
    marketStructureId: z.string().uuid().nullable(),
    activeMonumentTypes: z.array(z.enum(["mining", "forestry", "hunting"])).max(3),
    standardBuyerTaxBps: z.number().int().min(0).max(10_000),
    specialtyBuyerTaxBps: z.number().int().min(0).max(10_000),
    taxRevision: marketIntegerSchema
  }).strict(),
  sessionId: marketSessionIdSchema,
  controls: marketControlsSchema,
  categories: z.array(marketShortStringSchema(80)).max(40),
  items: z.array(marketItemSummarySchema).max(40),
  equipmentListings: z.array(marketEquipmentListingSchema).max(100),
  nextCursor: marketShortStringSchema(256).nullable(),
  player: marketPlayerSnapshotSchema,
  feePolicy: z.object({
    version: z.number().int().nonnegative().safe(),
    listingFee: marketIntegerSchema,
    buyerFeeBps: z.number().int().min(0).max(10_000),
    sellerFeeBps: z.number().int().min(0).max(10_000),
    cancellationFee: marketIntegerSchema
  }).strict()
}).strict();
const marketMutationResultSchema = z.object({
  action: z.enum([
    "create_order",
    "simple_buy",
    "cancel_order",
    "claim",
    "create_equipment_listing",
    "purchase_equipment_listing",
    "cancel_equipment_listing"
  ]),
  requestId: marketRequestIdSchema,
  replayed: z.boolean(),
  order: marketOrderSchema.nullable(),
  trades: z.array(marketPublicTradeSchema).max(MARKET_MAX_MUTATION_TRADES),
  claimedItems: marketIntegerSchema,
  claimedGold: marketIntegerSchema,
  claimedEquipment: z.number().int().nonnegative(),
  equipmentListing: marketEquipmentListingSchema.nullable(),
  player: marketPlayerSnapshotSchema
}).strict();

export const marketServerMessageSchema = z.discriminatedUnion("type", [
    z.object({
      type: z.literal("MARKET_OPEN_RESULT"),
      requestId: marketRequestIdSchema,
      snapshot: marketSnapshotSchema
    }).strict(),
    z.object({
      type: z.literal("MARKET_BROWSE_RESULT"),
      requestId: marketRequestIdSchema,
      snapshot: marketSnapshotSchema
    }).strict(),
    z.object({
      type: z.literal("MARKET_BOOK_RESULT"),
      requestId: marketRequestIdSchema,
      book: marketBookSnapshotSchema
    }).strict(),
    z.object({
      type: z.literal("MARKET_QUOTE_RESULT"),
      requestId: marketRequestIdSchema,
      quote: marketQuoteSchema
    }).strict(),
    z.object({
      type: z.literal("MARKET_MUTATION_RESULT"),
      requestId: marketRequestIdSchema,
      result: marketMutationResultSchema,
      inventory: marketInventorySnapshotSchema,
      equipment: marketEquipmentSnapshotSchema.optional()
    }).strict(),
    z.object({
      type: z.literal("MARKET_SUBSCRIPTIONS_SET"),
      requestId: marketRequestIdSchema,
      revision: z.number().int().nonnegative().safe()
    }).strict(),
    z.object({
      type: z.literal("MARKET_ITEM_SUMMARY_CHANGED"),
      item: marketItemSummarySchema
    }).strict(),
    z.object({
      type: z.literal("MARKET_BOOK_CHANGED"),
      itemIdentity: marketShortStringSchema(180).optional(),
      itemId: marketShortStringSchema(120).optional(),
      bookVersion: marketIntegerSchema,
      priceCurrency: z.enum(MARKET_PRICE_CURRENCIES).optional()
    }).strict(),
    z.object({
      type: z.literal("MARKET_PLAYER_STATE_CHANGED"),
      reason: z.enum(["order", "fill", "cancel", "collection", "claim", "controls"])
    }).strict(),
    z.object({
      type: z.literal("MARKET_ASSETS_CHANGED"),
      wallet: z.object({
        playerId: marketShortStringSchema(160),
        gold: marketIntegerSchema,
        revision: marketIntegerSchema
      }).strict(),
      inventory: marketInventorySnapshotSchema,
      equipment: marketEquipmentSnapshotSchema.optional(),
      premiumWallet: premiumWalletSnapshotSchema.optional()
    }).strict(),
    z.object({
      type: z.literal("MARKET_ERROR"),
      requestId: marketRequestIdSchema,
      code: marketShortStringSchema(120),
      message: marketShortStringSchema(500),
      retryable: z.boolean()
    }).strict()
  ]).superRefine((message, context) => {
    if (
      message.type === "MARKET_BOOK_CHANGED" &&
      !message.itemIdentity &&
      !message.itemId
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["itemIdentity"],
        message: "Market book identity is required"
      });
    }
    if (
      message.type === "MARKET_MUTATION_RESULT" &&
      message.requestId !== message.result.requestId
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Market mutation request IDs must match"
      });
    }
  });
