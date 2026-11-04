import {
  CITY_MARKET_STANDARD_BUYER_TAX_BPS,
  merchantReducedBuyerTaxBps,
  type MarketTaxTag,
  MARKET_MAX_MUTATION_TRADES,
  MAX_EQUIPMENT_LEVEL,
  inscriptionKind,
  fishingRodMarketIdentity,
  parseFishingRodMarketIdentity,
  parseShopCopyMarketIdentity,
  isShopCopyItemId,
  requireEquipmentDefinition,
  resolveEquipmentItemDerivedStats,
  clampEquipmentCondition,
  equipmentRepairCostForFamily,
  EQUIPMENT_MAX_CONDITION,
  PREMIUM_CURRENCY_NAMES,
  premiumCurrencyForMarketItem,
  premiumMarketSellerFee,
  parseRingBonusRolls,
  ringTierForDefinitionId,
  type PremiumCurrency,
  type MarketCollectionScope,
  type MarketMutationResult,
  type MarketEquipmentListingSnapshot,
  type MarketOrderSide,
  type MarketPublicTrade,
  type MarketPriceCurrency,
  type MarketQuote
} from "@ash-atlas/shared";
import type pg from "pg";
import { requireRuntimeItemDefinition } from "./items.js";

import type { AppConfig } from "../config.js";
import type { AppLogger } from "../logger.js";
import { InventoryService, assertInventoryWeightInTransaction, isInventoryItemEquippedError, lockInventoryCapacity } from "./inventory.js";
import type { EquipmentService } from "./equipment.js";
import {
  MarketAccessPolicy,
  type AuthorizedMarketVenue
} from "./marketAccess.js";
import { CityDistrictBenefitService } from "./cityDistrictBenefits.js";
import { activeSpecializationRank } from "./skills/activeSpecialization.js";
import { reserveMarketRate } from "./marketRateLimit.js";
import { acquireMarketMutationSafetyLock } from "./marketSafetyLock.js";
import { MarketReadService } from "./marketReadService.js";
import { setMarketControlAuditContext } from "./marketControlAudit.js";
import {
  PremiumWalletOperationError,
  PremiumWalletService
} from "./premiumWallet.js";
import {
  WalletOperationError,
  WalletService
} from "./wallet.js";
import {
  MARKET_DEFAULT_VARIANT,
  MARKET_RULES_VERSION,
  MarketError,
  calculateFee,
  checkedOrderValue,
  isRetryablePostgresError,
  mapMarketError,
  marketLimits,
  marketRequestHash,
  noMarketFaults,
  orderAction,
  requireEconomicInteger,
  requireRequestId,
  type MarketActor,
  type MarketFaultInjector
} from "./marketRules.js";

type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

type ItemRow = {
  item_id: string;
  variant: string;
  display_name: string;
  category: string;
  stackable: boolean;
  market_tradable: boolean;
  market_fungible: boolean;
  market_identity: string | null;
};

const MARKET_SALE_INBOX_EVENT_KIND = "market_sale";

type VenueRow = {
  venue_id: string;
  fee_policy_id: number;
};

type FeeRow = {
  fee_policy_id: number;
  version: number;
  listing_fee: string;
  buyer_fee_bps: number;
  seller_fee_bps: number;
  cancellation_fee: string;
};

type BookRow = {
  book_id: string;
  venue_id: string;
  item_identity: string;
  item_id: string;
  variant: string;
  book_version: string;
  frozen: boolean;
  price_currency: MarketPriceCurrency;
  sensitive_reason?: string | null;
};

type OrderRow = {
  order_id: string;
  venue_id: string;
  book_id: string;
  item_identity: string;
  item_id: string;
  variant: string;
  player_id: string;
  account_id: string;
  side: MarketOrderSide;
  order_policy: "gtc" | "aon_ioc";
  limit_unit_price: string;
  original_quantity: string;
  remaining_quantity: string;
  filled_quantity: string;
  status: "open" | "partially_filled" | "filled" | "cancelled" | "expired";
  priority_sequence: string;
  client_request_id: string;
  fee_policy_id: number;
  fee_policy_version: number;
  rules_version: number;
  created_at: Date | string;
};

type EscrowRow = {
  order_id: string;
  asset_kind: "item" | "gold" | "glimmer";
  remaining_amount: string;
};

type QuoteRow = {
  quote_id: string;
  player_id: string;
  account_id: string;
  venue_id: string;
  book_id: string;
  item_identity: string;
  requested_quantity: string;
  fillable_quantity: string;
  quoted_total: string;
  gross_item_total: string;
  buyer_tax: string;
  buyer_total: string;
  applied_buyer_tax_bps: number;
  district_type: MarketQuote["districtType"];
  tax_revision: string;
  specialty_tax_applied: boolean;
  qualifying_tax_tag: MarketQuote["qualifyingTaxTag"];
  maximum_unit_price: string | null;
  book_version: string;
  expires_at: Date | string;
  consumed_at: Date | string | null;
  replaced_at: Date | string | null;
};

type CollectionRow = {
  collection_id: string;
  asset_kind: "item" | "gold";
  item_identity: string | null;
  item_id: string | null;
  variant: string | null;
  remaining_amount: string;
  reason:
    | "purchase"
    | "sell_proceeds"
    | "sell_cancel_return"
    | "buy_cancel_refund"
    | "price_improvement_refund"
    | "sell_expired_return"
    | "buy_expired_refund";
  source_order_id: string;
  source_trade_id: string | null;
};

type SellLiquidityRow = {
  remaining_quantity: string;
  limit_unit_price: string;
  priority_sequence: string;
};

type MarketEquipmentRow = {
  instance_id: string;
  definition_id: string;
  owner_player_id: string;
  location: string;
  inventory_slot_index: number | null;
  item_level: number;
  condition: number;
  balance_version: number;
  enchantment_identity: string | null;
  ring_bonuses?: unknown;
  ring_rough?: boolean;
  inscription_name?: string | null;
  inscribed_by_name?: string | null;
  inscribed_at?: Date | string | null;
  inscription_stats?: Record<string, number> | null;
};

type EquipmentListingRow = {
  listing_id: string;
  venue_id: string;
  equipment_instance_id: string;
  seller_player_id: string;
  buyer_player_id: string | null;
  asking_price: string;
  price_currency?: MarketPriceCurrency;
  status: "open" | "sold" | "cancelled" | "claimed";
  version: string;
  presentation_snapshot: Omit<
    MarketEquipmentListingSnapshot,
    | "listingId"
    | "venueId"
    | "sellerPlayerId"
    | "askingPrice"
    | "buyerTax"
    | "buyerTotal"
    | "buyerTaxBps"
    | "status"
    | "version"
    | "createdAt"
  >;
  created_at: Date | string;
};

type MutationAction =
  | "create_buy"
  | "create_sell"
  | "simple_buy"
  | "cancel_order"
  | "claim_items"
  | "claim_gold"
  | "claim_all"
  | "create_equipment_listing"
  | "purchase_equipment_listing"
  | "cancel_equipment_listing";

type MutationCore = {
  action: MarketMutationResult["action"];
  orderId: string | null;
  trades: MarketPublicTrade[];
  claimedItems: string;
  claimedGold: string;
  claimedEquipment?: number;
  equipmentListing?: MarketEquipmentListingSnapshot | null;
  affectedPlayerIds?: string[];
};

type LedgerEntry = {
  assetKind: "item" | "gold" | "glimmer";
  itemIdentity: string | null;
  amount: bigint;
  accountLocation:
    | "player_inventory"
    | "sell_escrow"
    | "buyer_collection"
    | "return_collection"
    | "player_wallet"
    | "buy_escrow"
    | "seller_proceeds"
    | "refund_balance"
    | "fee_sink"
    | "premium_wallet";
  playerId?: string | null;
  orderId?: string | null;
  tradeId?: string | null;
  collectionId?: string | null;
  reason: string;
};

export type CreateMarketOrderInput = {
  requestId: string;
  interface: "simple" | "merchant";
  side: MarketOrderSide;
  itemIdentity?: string;
  /** @deprecated Default-asset compatibility only. */
  itemId?: string;
  quantity: string;
  unitPrice: string;
  /** Book price currency; Gold when omitted. */
  priceCurrency?: MarketPriceCurrency;
};

export type MarketServiceMetrics = {
  transactions: number;
  retries: number;
  deadlocks: number;
  serializationFailures: number;
  fills: number;
  rateLimitRejections: number;
  invariantFailures: number;
  quotesCreated: number;
  quotesReplaced: number;
};

export class MarketService {
  readonly read: MarketReadService;
  private readonly access: MarketAccessPolicy;
  private readonly inventory: InventoryService;
  private readonly wallet: WalletService;
  private readonly premiumWallet: PremiumWalletService;
  private readonly equipment: EquipmentService | null;
  private readonly districtBenefits: Pick<
    CityDistrictBenefitService,
    "resolveMarketTax"
  >;
  private readonly limits: ReturnType<typeof marketLimits>;
  private readonly matchingBatchSize: number;
  private readonly metrics: MarketServiceMetrics = {
    transactions: 0,
    retries: 0,
    deadlocks: 0,
    serializationFailures: 0,
    fills: 0,
    rateLimitRejections: 0,
    invariantFailures: 0,
    quotesCreated: 0,
    quotesReplaced: 0
  };

  constructor(
    private readonly pool: pg.Pool,
    private readonly config: AppConfig,
    private readonly logger: AppLogger,
    options: {
      inventory?: InventoryService;
      wallet?: WalletService;
      premiumWallet?: PremiumWalletService;
      equipment?: EquipmentService;
      access?: MarketAccessPolicy;
      read?: MarketReadService;
      districtBenefits?: Pick<CityDistrictBenefitService, "resolveMarketTax">;
      faultInjector?: MarketFaultInjector;
      onCommitted?: (event: {
        venueId: string;
        itemIdentity: string | null;
        playerIds: string[];
        premiumCurrencyChanged?: boolean;
        priceCurrency?: MarketPriceCurrency | undefined;
      }) => void;
      onInvariantFailure?: (event: { operation: string; constraint: string | null }) => void;
      matchingBatchSize?: number;
    } = {}
  ) {
    if (
      config.NODE_ENV === "production" &&
      options.faultInjector !== undefined &&
      options.faultInjector !== noMarketFaults
    ) {
      throw new Error("Market fault injection is forbidden in production");
    }
    this.access = options.access ?? new MarketAccessPolicy(config);
    this.inventory = options.inventory ?? new InventoryService(pool);
    this.wallet = options.wallet ?? new WalletService();
    this.premiumWallet = options.premiumWallet ?? new PremiumWalletService(pool);
    this.equipment = options.equipment ?? null;
    this.districtBenefits =
      options.districtBenefits ?? new CityDistrictBenefitService(pool);
    this.read = options.read ?? new MarketReadService(pool, config, this.access);
    this.limits = marketLimits(config);
    this.matchingBatchSize = options.matchingBatchSize ?? MARKET_MAX_MUTATION_TRADES;
    if (
      !Number.isSafeInteger(this.matchingBatchSize) ||
      this.matchingBatchSize < 1 ||
      this.matchingBatchSize > MARKET_MAX_MUTATION_TRADES
    ) {
      throw new Error(
        `Market matching batch size must be an integer between 1 and ${MARKET_MAX_MUTATION_TRADES}`
      );
    }
    this.faultInjector = options.faultInjector ?? noMarketFaults;
    this.onCommitted = options.onCommitted ?? (() => undefined);
    this.onInvariantFailure = options.onInvariantFailure ?? (() => undefined);
  }

  private readonly faultInjector: MarketFaultInjector;
  private readonly onCommitted: (event: {
    venueId: string;
    itemIdentity: string | null;
    playerIds: string[];
    premiumCurrencyChanged?: boolean;
    priceCurrency?: MarketPriceCurrency | undefined;
  }) => void;
  private readonly onInvariantFailure: (
    event: { operation: string; constraint: string | null }
  ) => void;

  metricsSnapshot(): MarketServiceMetrics {
    return { ...this.metrics };
  }

  async openSession(
    actor: MarketActor,
    connectionId: string,
    marketStructureId: string,
    expectedPlacementRevision: string
  ): Promise<AuthorizedMarketVenue> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const venue = await this.access.openSession(
        client,
        actor,
        connectionId,
        marketStructureId,
        expectedPlacementRevision
      );
      await client.query("COMMIT");
      return venue;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw this.mapAndReportError(error, "open_session");
    } finally {
      client.release();
    }
  }

  async requireSession(
    actor: MarketActor,
    connectionId: string,
    sessionId: string
  ): Promise<AuthorizedMarketVenue> {
    return this.access.requireSession(
      this.pool,
      actor,
      connectionId,
      sessionId
    );
  }

  async equipmentSnapshot(
    playerId: string
  ): Promise<Awaited<ReturnType<EquipmentService["getSnapshot"]>>> {
    return this.requireEquipmentService().getSnapshot(playerId);
  }

  private mapAndReportError(error: unknown, operation: string): Error {
    const mapped = mapMarketError(error, { operation });
    if (mapped instanceof MarketError && mapped.code === "MARKET_RATE_LIMITED") {
      this.metrics.rateLimitRejections += 1;
    }
    if (mapped instanceof MarketError && mapped.code === "MARKET_INVARIANT_FAILURE") {
      this.metrics.invariantFailures += 1;
      const constraint = typeof (error as { constraint?: unknown } | null)?.constraint === "string"
        ? (error as { constraint: string }).constraint
        : null;
      this.logger.error(
        {
          operation,
          postgresCode: (error as { code?: unknown } | null)?.code,
          constraint
        },
        "market invariant failure"
      );
      this.onInvariantFailure({ operation, constraint });
    }
    return mapped;
  }

  async cleanupExpiredData(): Promise<{ quotesDeleted: number; rateWindowsDeleted: number }> {
    const quotes = await this.pool.query(
      `DELETE FROM market_quotes
       WHERE expires_at < now() - interval '24 hours'`
    );
    const windows = await this.pool.query(
      `DELETE FROM market_rate_windows
       WHERE window_started_at < date_trunc('minute', now()) - interval '24 hours'`
    );
    return {
      quotesDeleted: quotes.rowCount ?? 0,
      rateWindowsDeleted: windows.rowCount ?? 0
    };
  }

  async quote(
    actor: MarketActor,
    connectionId: string,
    marketSessionId: string,
    requestId: string,
    itemIdentity: string,
    quantityRaw: string,
    maximumUnitPriceRaw?: string,
    priceCurrencyRaw?: MarketPriceCurrency
  ): Promise<MarketQuote> {
    const priceCurrency = requirePriceCurrency(priceCurrencyRaw);
    // Gold quotes keep their pre-Glimmer hash shape.
    const currencyHash = priceCurrency === "glimmer" ? { priceCurrency } : {};
    const normalizedRequestId = requireRequestId(requestId);
    const quantity = requireEconomicInteger(
      quantityRaw,
      "quantity",
      this.limits.maxSimpleBuyQuantity
    );
    const requestedMaximumUnitPrice = maximumUnitPriceRaw === undefined
      ? this.limits.maxUnitPrice
      : requireEconomicInteger(maximumUnitPriceRaw, "unit price", this.limits.maxUnitPrice);
    let initialVenue: AuthorizedMarketVenue;
    try {
      // Completed replay is deliberately checked before consuming quota. The
      // quota write itself is autocommitted so malformed/failed quote work
      // cannot roll it back and obtain unbounded PostgreSQL work.
      initialVenue = await this.access.requireSession(
        this.pool,
        actor,
        connectionId,
        marketSessionId
      );
      const requestHash = marketRequestHash({
        action: "quote",
        venueId: initialVenue.venueId,
        // Preserve the durable pre-variant hash shape. The value is the exact
        // market identity, so default-asset retries keep their original hash.
        itemId: itemIdentity,
        quantity: quantity.toString(),
        maximumUnitPrice: requestedMaximumUnitPrice.toString(),
        ...currencyHash
      });
      const replay = await this.completedQuoteReplay(
        this.pool,
        actor,
        normalizedRequestId,
        requestHash
      );
      if (replay) return replay;
      await reserveMarketRate(
        this.pool,
        actor.playerId,
        "quote",
        this.limits.quoteRequestsPerMinute
      );
    } catch (error) {
      throw this.mapAndReportError(error, "quote");
    }
    const client = await this.pool.connect();
    let replacedQuotes = 0;
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('statement_timeout', $1, true)", [
        `${this.config.MARKET_READ_STATEMENT_TIMEOUT_MS}ms`
      ]);
      const venueAuthority = await this.access.requireSession(
        client,
        actor,
        connectionId,
        marketSessionId
      );
      const requestHash = marketRequestHash({
        action: "quote",
        venueId: venueAuthority.venueId,
        itemId: itemIdentity,
        quantity: quantity.toString(),
        maximumUnitPrice: requestedMaximumUnitPrice.toString(),
        ...currencyHash
      });
      const reserved = await client.query(
        `INSERT INTO market_quote_requests (
           account_id, player_id, request_id, request_hash, result
         ) VALUES ($1,$2,$3,$4,'{}'::jsonb)
         ON CONFLICT (account_id, request_id) DO NOTHING
         RETURNING request_id`,
        [actor.accountId, actor.playerId, normalizedRequestId, requestHash]
      );
      if (reserved.rowCount === 0) {
        const replay = await this.completedQuoteReplay(
          client,
          actor,
          normalizedRequestId,
          requestHash
        );
        if (!replay) throw new MarketError(
          "MARKET_REPLAY_CONFLICT",
          "Request id was already used with incomplete market intent"
        );
        await client.query("COMMIT");
        return replay;
      }
      const venue = await this.venue(client, venueAuthority.venueId);
      const item = await this.requireTradableIdentity(client, itemIdentity);
      assertMarketItemQuantity(item, quantity);
      const { tax, merchantRank } = await this.resolveBuyerMarketTax(
        client,
        venue.venue_id,
        await this.itemTaxTags(client, item.item_id),
        actor.playerId
      );
      const fee = await this.feePolicy(
        client,
        tax.specialtyApplied ? 3 : 2
      );
      const pricingFee = withMerchantBuyerFee(fee, merchantRank);
      const book = await this.ensureAndLockBook(client, venue.venue_id, item, "FOR SHARE", priceCurrency);
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`market-quote:${actor.accountId}:${book.book_id}`]
      );
      const liquidity = await this.priceAvailableSellLiquidity(
        client,
        book.book_id,
        actor.accountId,
        quantity,
        pricingFee,
        requestedMaximumUnitPrice
      );
      const ownership = await client.query<{ own_quantity: string; other_quantity: string }>(
        `SELECT
           COALESCE(sum(remaining_quantity) FILTER (WHERE account_id = $2), 0)::text AS own_quantity,
           COALESCE(sum(remaining_quantity) FILTER (WHERE account_id <> $2), 0)::text AS other_quantity
         FROM market_orders
         WHERE book_id = $1 AND side = 'sell' AND status IN ('open','partially_filled')
           AND limit_unit_price <= $3::bigint`,
        [book.book_id, actor.accountId, requestedMaximumUnitPrice.toString()]
      );
      const ownQuantity = BigInt(ownership.rows[0]?.own_quantity ?? "0");
      const otherQuantity = BigInt(ownership.rows[0]?.other_quantity ?? "0");
      const availability: MarketQuote["availability"] = liquidity.fillable === quantity
        ? "available"
        : liquidity.fillable > 0n || otherQuantity > 0n
          ? "quantity_unavailable"
          : ownQuantity > 0n
            ? "self_trade_only"
            : "no_eligible_liquidity";
      const quoteId = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + this.limits.quoteTtlSeconds * 1_000);
      const replaced = await client.query(
        `UPDATE market_quotes
         SET replaced_at = clock_timestamp()
         WHERE account_id = $1 AND book_id = $2
           AND consumed_at IS NULL AND replaced_at IS NULL`,
        [actor.accountId, book.book_id]
      );
      replacedQuotes = replaced.rowCount ?? 0;
      const outstanding = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM market_quotes
         WHERE account_id = $1 AND book_id = $2
           AND consumed_at IS NULL AND replaced_at IS NULL AND expires_at > now()`,
        [actor.accountId, book.book_id]
      );
      if (
        BigInt(outstanding.rows[0]?.count ?? "0") >=
        BigInt(this.limits.maxOutstandingQuotesPerAccountBook)
      ) {
        throw new MarketError("MARKET_RATE_LIMITED", "Outstanding market quote limit reached");
      }
      await client.query(
        `INSERT INTO market_quotes (
           quote_id, player_id, account_id, venue_id, book_id, item_identity,
           requested_quantity, fillable_quantity, quoted_total, maximum_unit_price,
           book_version, expires_at, gross_item_total, buyer_tax, buyer_total,
           applied_buyer_tax_bps, district_type, tax_revision,
           specialty_tax_applied, qualifying_tax_tag
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
           $18,$19,$20
         )`,
        [
          quoteId,
          actor.playerId,
          actor.accountId,
          venue.venue_id,
          book.book_id,
          item.market_identity,
          quantity.toString(),
          liquidity.fillable.toString(),
          liquidity.total.toString(),
          liquidity.maximumUnitPrice?.toString() ?? null,
          book.book_version,
          expiresAt,
          liquidity.gross.toString(),
          (liquidity.total - liquidity.gross).toString(),
          liquidity.total.toString(),
          tax.buyerTaxBps,
          tax.districtType,
          tax.taxRevision,
          tax.specialtyApplied,
          tax.qualifyingTaxTag
        ]
      );
      const result: MarketQuote = {
        quoteId,
        itemId: item.item_id,
        itemIdentity: item.market_identity!,
        variant: item.variant === MARKET_DEFAULT_VARIANT ? null : item.variant,
        requestedQuantity: quantity.toString(),
        requestedMaximumUnitPrice: requestedMaximumUnitPrice.toString(),
        fillableQuantity: liquidity.fillable.toString(),
        quotedTotal: liquidity.total.toString(),
        grossItemTotal: liquidity.gross.toString(),
        buyerTax: (liquidity.total - liquidity.gross).toString(),
        buyerTotal: liquidity.total.toString(),
        appliedBuyerTaxBps: tax.buyerTaxBps,
        taxLabel: tax.specialtyApplied
          ? "District specialty tax"
          : "Standard buyer tax",
        districtType: tax.districtType,
        taxRevision: tax.taxRevision,
        specialtyTaxApplied: tax.specialtyApplied,
        qualifyingTaxTag: tax.qualifyingTaxTag,
        maximumUnitPrice: liquidity.maximumUnitPrice?.toString() ?? null,
        fullQuantityAvailable: liquidity.fillable === quantity,
        availability,
        bookVersion: book.book_version,
        expiresAt: expiresAt.toISOString(),
        ...currencyHash
      };
      await client.query(
        `UPDATE market_quote_requests
         SET quote_id = $4, result = $5::jsonb, completed_at = clock_timestamp()
         WHERE account_id = $1 AND player_id = $2 AND request_id = $3`,
        [
          actor.accountId,
          actor.playerId,
          normalizedRequestId,
          quoteId,
          JSON.stringify(result)
        ]
      );
      await client.query("COMMIT");
      this.metrics.quotesCreated += 1;
      this.metrics.quotesReplaced += replacedQuotes;
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw this.mapAndReportError(error, "quote");
    } finally {
      client.release();
    }
  }

  private async completedQuoteReplay(
    queryable: Queryable,
    actor: MarketActor,
    requestId: string,
    requestHash: string
  ): Promise<MarketQuote | null> {
    const replay = await queryable.query<{
      player_id: string;
      request_hash: string;
      result: MarketQuote;
    }>(
      `SELECT player_id, request_hash, result
       FROM market_quote_requests
       WHERE account_id = $1 AND request_id = $2`,
      [actor.accountId, requestId]
    );
    const row = replay.rows[0];
    if (!row) return null;
    if (
      row.player_id !== actor.playerId ||
      row.request_hash !== requestHash ||
      !row.result?.quoteId
    ) {
      throw new MarketError(
        "MARKET_REPLAY_CONFLICT",
        "Request id was already used with different market intent"
      );
    }
    return row.result;
  }

  async createOrder(
    actor: MarketActor,
    connectionId: string,
    marketSessionId: string,
    input: CreateMarketOrderInput
  ): Promise<MarketMutationResult> {
    const itemIdentity = input.itemIdentity ?? input.itemId;
    if (!itemIdentity) {
      throw new MarketError("MARKET_UNKNOWN_ITEM", "Market item identity is required");
    }
    const requestId = requireRequestId(input.requestId);
    const quantity = requireEconomicInteger(
      input.quantity,
      "quantity",
      this.limits.maxQuantityPerOrder
    );
    const unitPrice = requireEconomicInteger(
      input.unitPrice,
      "unit price",
      this.limits.maxUnitPrice
    );
    checkedOrderValue(unitPrice, quantity, this.limits.maxTotalOrderValue);
    const priceCurrency = requirePriceCurrency(input.priceCurrency);
    const result = await this.executeMutation(
      actor,
      connectionId,
      marketSessionId,
      itemIdentity,
      requestId,
      orderAction(input.side),
      {
        interface: input.interface,
        side: input.side,
        // Keep committed default-asset requests replayable across this rollout.
        itemId: itemIdentity,
        quantity: input.quantity,
        unitPrice: input.unitPrice,
        // Gold requests keep their pre-Glimmer hash shape.
        ...(priceCurrency === "glimmer" ? { priceCurrency } : {})
      },
      async (client, venueId) => {
        const venue = await this.venue(client, venueId);
        const controls = await this.lockMutationControls(client, actor, venue.venue_id, "order");
        const item = await this.requireTradableIdentity(client, itemIdentity);
        const fee = await this.feePolicy(client, venue.fee_policy_id);
        const book = await this.ensureAndLockBook(client, venue.venue_id, item, "FOR UPDATE", priceCurrency);
        assertMarketItemQuantity(item, quantity);
        if (book.frozen) throw new MarketError("MARKET_ITEM_FROZEN", "This market item is frozen");
        if (
          !controls.matchingEnabled &&
          await this.wouldCross(client, book.book_id, input.side, unitPrice, actor.accountId)
        ) {
          throw new MarketError(
            "MARKET_MATCHING_DISABLED",
            "Crossing orders are disabled while matching is paused"
          );
        }
        await this.reserveRate(client, actor.playerId, "order", this.limits.requestsPerMinute);
        return this.createAndMatchOrder(client, {
          actor,
          requestId,
          venue,
          controls,
          fee,
          book,
          item,
          side: input.side,
          quantity,
          unitPrice,
          policy: "gtc"
        });
      }
    );
    return result;
  }

  async simpleBuy(
    actor: MarketActor,
    connectionId: string,
    marketSessionId: string,
    requestIdRaw: string,
    quoteId: string,
    maximumTotalRaw: string
  ): Promise<MarketMutationResult> {
    const requestId = requireRequestId(requestIdRaw);
    const maximumTotal = requireEconomicInteger(
      maximumTotalRaw,
      "maximum total",
      this.limits.maxTotalOrderValue
    );
    const result = await this.executeMutation(
      actor,
      connectionId,
      marketSessionId,
      null,
      requestId,
      "simple_buy",
      { quoteId, maximumTotal: maximumTotalRaw },
      async (client, venueId) => {
        const quoteResult = await client.query<QuoteRow>(
          `SELECT quote_id, player_id, account_id, venue_id, book_id, item_identity,
                  requested_quantity::text, fillable_quantity::text, quoted_total::text,
                  gross_item_total::text, buyer_tax::text, buyer_total::text,
                  applied_buyer_tax_bps, district_type, tax_revision::text,
                  specialty_tax_applied, qualifying_tax_tag,
                  maximum_unit_price::text, book_version::text, expires_at, consumed_at,
                  replaced_at
           FROM market_quotes WHERE quote_id = $1 AND account_id = $2 FOR UPDATE`,
          [quoteId, actor.accountId]
        );
        const quote = quoteResult.rows[0];
        if (!quote) throw new MarketError("MARKET_QUOTE_NOT_FOUND", "Market quote does not exist");
        if (quote.player_id !== actor.playerId || quote.account_id !== actor.accountId) {
          throw new MarketError("MARKET_QUOTE_NOT_FOUND", "Market quote does not exist");
        }
        if (
          quote.consumed_at ||
          quote.replaced_at ||
          new Date(quote.expires_at).getTime() <= Date.now()
        ) {
          throw new MarketError("MARKET_QUOTE_EXPIRED", "Price quote expired; request a fresh quote");
        }
        const quantity = BigInt(quote.requested_quantity);
        if (BigInt(quote.fillable_quantity) !== quantity || quote.maximum_unit_price === null) {
          throw new MarketError("MARKET_PRICE_CHANGED", "The full requested quantity is unavailable");
        }
        if (BigInt(quote.buyer_total) > maximumTotal) {
          throw new MarketError("MARKET_PRICE_CHANGED", "Quoted total exceeds the confirmed maximum");
        }
        const venue = await this.venue(client, venueId);
        if (venue.venue_id !== quote.venue_id) throw new MarketError("MARKET_QUOTE_STALE", "Market venue changed");
        const controls = await this.lockMutationControls(client, actor, venue.venue_id, "order");
        if (!controls.matchingEnabled) {
          throw new MarketError("MARKET_MATCHING_DISABLED", "Simple Buy requires matching");
        }
        const item = await this.requireTradableIdentity(client, quote.item_identity);
        assertMarketItemQuantity(item, quantity);
        const { tax, merchantRank } = await this.resolveBuyerMarketTax(
          client,
          venue.venue_id,
          await this.itemTaxTags(client, item.item_id),
          actor.playerId
        );
        if (
          tax.taxRevision !== quote.tax_revision ||
          tax.buyerTaxBps !== Number(quote.applied_buyer_tax_bps) ||
          tax.districtType !== quote.district_type ||
          tax.specialtyApplied !== quote.specialty_tax_applied ||
          tax.qualifyingTaxTag !== quote.qualifying_tax_tag
        ) {
          throw new MarketError(
            "MARKET_QUOTE_STALE",
            "Market tax changed; request a fresh quote"
          );
        }
        const fee = await this.feePolicy(
          client,
          tax.specialtyApplied ? 3 : 2
        );
        const pricingFee = withMerchantBuyerFee(fee, merchantRank);
        const book = await this.lockBookById(client, quote.book_id);
        if (book.frozen) throw new MarketError("MARKET_ITEM_FROZEN", "This market item is frozen");
        if (book.book_version !== quote.book_version) {
          throw new MarketError("MARKET_QUOTE_STALE", "Price or availability changed; request a fresh quote");
        }
        const liquidity = await this.priceAvailableSellLiquidity(
          client,
          book.book_id,
          actor.accountId,
          quantity,
          pricingFee
        );
        if (liquidity.fillable !== quantity || liquidity.total > maximumTotal) {
          throw new MarketError("MARKET_PRICE_CHANGED", "Price or availability changed; no purchase was made");
        }
        await this.reserveRate(client, actor.playerId, "simple_buy", this.limits.requestsPerMinute);
        const core = await this.createAndMatchOrder(client, {
          actor,
          requestId,
          venue,
          controls,
          fee,
          book,
          item,
          side: "buy",
          quantity,
          unitPrice: liquidity.maximumUnitPrice!,
          policy: "aon_ioc",
          buyEscrowOverride: liquidity.total
        });
        if (core.trades.reduce((sum, trade) => sum + BigInt(trade.quantity), 0n) !== quantity) {
          throw new MarketError("MARKET_INVARIANT_FAILURE", "Atomic Simple purchase did not fill completely");
        }
        await client.query("UPDATE market_quotes SET consumed_at = now() WHERE quote_id = $1", [quote.quote_id]);
        return { ...core, action: "simple_buy" };
      }
    );
    return result;
  }

  async createEquipmentListing(
    actor: MarketActor,
    connectionId: string,
    marketSessionId: string,
    requestIdRaw: string,
    equipmentInstanceId: string,
    askingPriceRaw: string,
    expectedEquipmentRevisionRaw: string,
    priceCurrencyRaw?: MarketPriceCurrency
  ): Promise<Readonly<{
    result: MarketMutationResult;
    equipment: Awaited<ReturnType<EquipmentService["getSnapshot"]>>;
  }>> {
    const equipment = this.requireEquipmentService();
    if (equipment.pendingActivation(actor.playerId)) {
      throw new MarketError(
        "MARKET_EQUIPMENT_NOT_ELIGIBLE",
        "Equipment cannot be listed during a pending combat-kit change"
      );
    }
    const requestId = requireRequestId(requestIdRaw);
    const askingPrice = requireEconomicInteger(
      askingPriceRaw,
      "asking price",
      this.limits.maxUnitPrice
    );
    const expectedEquipmentRevision = requireEconomicInteger(
      expectedEquipmentRevisionRaw,
      "equipment revision",
      9_223_372_036_854_775_807n
    );
    const priceCurrency = requirePriceCurrency(priceCurrencyRaw);
    const result = await this.executeMutation(
      actor,
      connectionId,
      marketSessionId,
      null,
      requestId,
      "create_equipment_listing",
      {
        equipmentInstanceId,
        askingPrice: askingPrice.toString(),
        expectedEquipmentRevision: expectedEquipmentRevision.toString(),
        // Gold requests keep their pre-Glimmer hash shape.
        ...(priceCurrency === "glimmer" ? { priceCurrency } : {})
      },
      async (client, venueId) => {
        await this.venue(client, venueId);
        await this.lockMutationControls(client, actor, venueId, "order");
        const state = await client.query<{ inventory_revision: string }>(
          `SELECT inventory_revision::text
           FROM player_equipment_state
           WHERE player_id = $1
           FOR UPDATE`,
          [actor.playerId]
        );
        if (
          BigInt(state.rows[0]?.inventory_revision ?? "-1") !==
          expectedEquipmentRevision
        ) {
          throw new MarketError(
            "MARKET_EQUIPMENT_STALE",
            "Equipment Inventory changed; refresh and try again"
          );
        }
        const instance = await this.lockMarketEquipment(
          client,
          equipmentInstanceId
        );
        if (
          instance.owner_player_id !== actor.playerId ||
          instance.location !== "inventory"
        ) {
          throw new MarketError(
            "MARKET_EQUIPMENT_NOT_ELIGIBLE",
            "This exact equipment instance is not available in Inventory"
          );
        }
        const definition = requireEquipmentDefinition(instance.definition_id);
        if (!definition.marketTradable) {
          throw new MarketError(
            "MARKET_EQUIPMENT_NOT_TRADABLE",
            "This equipment definition is not market tradable"
          );
        }
        if (instance.ring_rough === true) {
          throw new MarketError(
            "MARKET_EQUIPMENT_NOT_ELIGIBLE",
            "Polish this ring before you list it"
          );
        }
        const ringTier = ringTierForDefinitionId(instance.definition_id);
        if (
          definition.category === "chest_armor" &&
          equipmentRepairCostForFamily(definition.gameplayFamilyId) &&
          clampEquipmentCondition(instance.condition) < EQUIPMENT_MAX_CONDITION
        ) {
          throw new MarketError(
            "MARKET_EQUIPMENT_NOT_ELIGIBLE",
            "Eligible chest armor must be fully repaired before it can be listed"
          );
        }
        const blocked = await client.query<{ blocked: boolean }>(
          `SELECT (
             EXISTS (
               SELECT 1 FROM player_unique_item_protections protection
               WHERE protection.player_id = $1
                 AND protection.equipment_instance_id = $2
                 AND protection.protected
             )
             OR EXISTS (
               SELECT 1 FROM combat_kit_items kit
               WHERE kit.player_id = $1 AND kit.instance_id = $2
             )
             OR EXISTS (
               SELECT 1 FROM equipment_operations operation
               WHERE operation.player_id = $1
                 AND operation.instance_id = $2
                 AND operation.completed_at IS NULL
             )
           ) AS blocked`,
          [actor.playerId, equipmentInstanceId]
        );
        if (blocked.rows[0]?.blocked) {
          throw new MarketError(
            "MARKET_EQUIPMENT_NOT_ELIGIBLE",
            "Protected, saved-kit, or pending equipment cannot be listed"
          );
        }
        const listingId = crypto.randomUUID();
        const derived = resolveEquipmentItemDerivedStats({
          item: {
            instanceId: instance.instance_id,
            definition,
            itemLevel: instance.item_level,
            condition: instance.condition
          },
          slot: definition.slot,
          classId: "warrior"
        });
        const presentation = {
          equipmentInstanceId: instance.instance_id,
          definitionId: definition.definitionId,
          displayName: definition.displayName,
          artworkKey: definition.definitionId,
          category: definition.category,
          slot: definition.slot,
          itemLevel: instance.item_level,
          maximumItemLevel: MAX_EQUIPMENT_LEVEL,
          condition: clampEquipmentCondition(instance.condition),
          maximumCondition: EQUIPMENT_MAX_CONDITION,
          balanceVersion: instance.balance_version,
          derivedStats: { ...derived },
          utilityIdentity:
            definition.utilityKind === "none" ? null : definition.utilityKind,
          enchantmentIdentity: instance.enchantment_identity,
          cosmeticIdentity: null,
          ...(instance.inscription_name && inscriptionKind(definition.category)
            ? {
                inscription: {
                  name: instance.inscription_name,
                  inscriberName: instance.inscribed_by_name ?? "",
                  inscribedAt: new Date(instance.inscribed_at ?? Date.now()).toISOString(),
                  kind: inscriptionKind(definition.category)!,
                  stats: instance.inscription_stats ?? {}
                }
              }
            : {}),
          ...(ringTier === null
            ? {}
            : { ring: { tier: ringTier, rough: false, bonuses: parseRingBonusRolls(instance.ring_bonuses) ?? [] } })
        };
        const inserted = await client.query<EquipmentListingRow>(
          `INSERT INTO market_equipment_listings (
             listing_id, venue_id, equipment_instance_id, seller_player_id,
             asking_price, status, presentation_snapshot, price_currency
           ) VALUES ($1,$2,$3,$4,$5,'open',$6::jsonb,$7)
           RETURNING listing_id::text, venue_id::text,
                     equipment_instance_id::text, seller_player_id,
                     buyer_player_id, asking_price::text, status,
                     version::text, presentation_snapshot, created_at, price_currency`,
          [
            listingId,
            venueId,
            equipmentInstanceId,
            actor.playerId,
            askingPrice.toString(),
            JSON.stringify(presentation),
            priceCurrency
          ]
        );
        const moved = await client.query(
          `UPDATE equipment_instances
           SET location = 'market_escrow',
               inventory_slot_index = NULL,
               market_listing_id = $3,
               market_collection_id = NULL
           WHERE instance_id = $1
             AND owner_player_id = $2
             AND location = 'inventory'`,
          [equipmentInstanceId, actor.playerId, listingId]
        );
        if (moved.rowCount !== 1) {
          throw new MarketError(
            "MARKET_EQUIPMENT_STALE",
            "Equipment location changed before listing"
          );
        }
        await client.query(
          `UPDATE player_equipment_state
           SET inventory_revision = inventory_revision + 1
           WHERE player_id = $1`,
          [actor.playerId]
        );
        await this.writeEquipmentLedger(client, {
          operationKey: `market-equipment-list:${actor.accountId}:${requestId}`,
          venueId,
          listingId,
          equipmentInstanceId,
          actorPlayerId: actor.playerId,
          entryType: "listed",
          metadata: { askingPrice: askingPrice.toString(), priceCurrency }
        });
        const listing = await this.equipmentListingSnapshot(
          client,
          inserted.rows[0]!,
          venueId
        );
        return {
          action: "create_equipment_listing",
          orderId: null,
          trades: [],
          claimedItems: "0",
          claimedGold: "0",
          equipmentListing: listing
        };
      }
    );
    const snapshot = await equipment.refreshInventorySlots(actor.playerId);
    return { result, equipment: snapshot };
  }

  async purchaseEquipmentListing(
    actor: MarketActor,
    connectionId: string,
    marketSessionId: string,
    requestIdRaw: string,
    listingId: string,
    expectedListingVersionRaw: string,
    maximumBuyerTotalRaw: string,
    expectedTaxRevisionRaw: string,
    expectedPriceCurrencyRaw: MarketPriceCurrency
  ): Promise<Readonly<{
    result: MarketMutationResult;
    equipment: Awaited<ReturnType<EquipmentService["getSnapshot"]>>;
  }>> {
    const equipment = this.requireEquipmentService();
    const requestId = requireRequestId(requestIdRaw);
    const expectedListingVersion = requireEconomicInteger(
      expectedListingVersionRaw,
      "listing version",
      9_223_372_036_854_775_807n
    );
    const maximumBuyerTotal = requireEconomicInteger(
      maximumBuyerTotalRaw,
      "maximum buyer total",
      this.limits.maxTotalOrderValue
    );
    const expectedTaxRevision = requireEconomicInteger(
      expectedTaxRevisionRaw,
      "tax revision",
      9_223_372_036_854_775_807n
    );
    // Consent: the buyer names the currency they saw, so a Gold buyer is never
    // charged Glimmer (or the reverse).
    const expectedPriceCurrency = requirePriceCurrency(expectedPriceCurrencyRaw);
    const result = await this.executeMutation(
      actor,
      connectionId,
      marketSessionId,
      null,
      requestId,
      "purchase_equipment_listing",
      {
        listingId,
        expectedListingVersion: expectedListingVersion.toString(),
        maximumBuyerTotal: maximumBuyerTotal.toString(),
        expectedTaxRevision: expectedTaxRevision.toString(),
        expectedPriceCurrency
      },
      async (client, venueId) => {
        await this.lockMutationControls(client, actor, venueId, "order");
        const listing = await this.lockEquipmentListing(client, listingId);
        if (
          listing.venue_id !== venueId ||
          listing.status !== "open" ||
          BigInt(listing.version) !== expectedListingVersion
        ) {
          throw new MarketError(
            "MARKET_EQUIPMENT_LISTING_STALE",
            "Equipment listing changed or belongs to another City Market"
          );
        }
        if (listing.seller_player_id === actor.playerId) {
          throw new MarketError(
            "MARKET_SELF_TRADE",
            "You cannot purchase your own equipment listing"
          );
        }
        if ((listing.price_currency ?? "gold") !== expectedPriceCurrency) {
          throw new MarketError(
            "MARKET_EQUIPMENT_LISTING_STALE",
            "This listing is priced in a different currency; refresh and confirm again"
          );
        }
        const { tax } = await this.resolveBuyerMarketTax(
          client,
          venueId,
          ["equipment"],
          actor.playerId
        );
        if (BigInt(tax.taxRevision) !== expectedTaxRevision) {
          throw new MarketError(
            "MARKET_QUOTE_STALE",
            "Market tax changed; refresh the listing"
          );
        }
        const askingPrice = BigInt(listing.asking_price);
        const buyerTax = calculateFee(askingPrice, tax.buyerTaxBps);
        const buyerTotal = askingPrice + buyerTax;
        if (buyerTotal > maximumBuyerTotal) {
          throw new MarketError(
            "MARKET_PRICE_CHANGED",
            "Equipment total exceeds the confirmed maximum"
          );
        }
        const glimmerPriced = listing.price_currency === "glimmer";
        const sellerAccountId = await this.accountIdForPlayer(
          client,
          listing.seller_player_id
        );
        if (glimmerPriced) {
          // Glimmer listing: buyer pays asking price plus tax from the premium
          // wallet; the seller's proceeds go straight to theirs (0917 provenance).
          try {
            await this.premiumWallet.debitForOperationInTransaction(client, {
              accountId: actor.accountId,
              actorPlayerId: actor.playerId,
              currency: "glimmer",
              amount: buyerTotal,
              operationKey: `market-equipment-buy:${actor.accountId}:${requestId}`,
              reason: "market",
              refType: "market_equipment_listing",
              refId: listingId,
              metadata: { venueId }
            });
          } catch (error) {
            if (error instanceof PremiumWalletOperationError && error.code === "PREMIUM_WALLET_INSUFFICIENT_FUNDS") {
              throw new MarketError("MARKET_NOT_ENOUGH_GOLD", "Not enough Glimmer for this equipment");
            }
            throw mapPremiumWalletOperationError(error, "glimmer");
          }
          await this.creditPremiumWallet(client, {
            accountId: sellerAccountId,
            playerId: listing.seller_player_id,
            currency: "glimmer",
            amount: askingPrice,
            operationKey: `market-equipment-seller:${listingId}`,
            refType: "market_equipment_listing",
            refId: listingId
          });
        } else {
          try {
            await this.wallet.debitForOperationInTransaction(client, {
              playerId: actor.playerId,
              accountId: actor.accountId,
              amount: buyerTotal,
              operationKey:
                `market-equipment-buy:${actor.accountId}:${requestId}`,
              reason: "market_equipment_purchase",
              metadata: { listingId, venueId }
            });
          } catch (error) {
            throw mapWalletOperationError(error);
          }
          await this.creditWallet(
            client,
            {
              playerId: listing.seller_player_id,
              accountId: sellerAccountId
            },
            askingPrice,
            `market-equipment-seller:${listingId}`,
            "market_equipment_seller_proceeds"
          );
        }
        const priceDelta = (amount: bigint) => glimmerPriced
          ? { glimmerDelta: amount }
          : { goldDelta: amount };
        await client.query(
          `SELECT inventory_revision
           FROM player_equipment_state
           WHERE player_id = ANY($1::text[])
           ORDER BY player_id
           FOR UPDATE`,
          [[actor.playerId, listing.seller_player_id].sort()]
        );
        const incoming = await this.lockMarketEquipment(client, listing.equipment_instance_id);
        await assertInventoryWeightInTransaction(client, actor.playerId, BigInt(requireRuntimeItemDefinition(incoming.definition_id).unitWeightGrams));
        const moved = await client.query(
          `UPDATE equipment_instances
           SET owner_player_id = $2,
               location = 'inventory',
               inventory_slot_index = $3,
               market_listing_id = NULL,
               market_collection_id = NULL
           WHERE instance_id = $1
             AND location = 'market_escrow'
             AND market_listing_id = $4`,
          [
            listing.equipment_instance_id,
            actor.playerId,
            null,
            listingId
          ]
        );
        if (moved.rowCount !== 1) {
          throw new MarketError(
            "MARKET_EQUIPMENT_LISTING_STALE",
            "Equipment listing changed before ownership transfer"
          );
        }
        const updated = await client.query<EquipmentListingRow>(
          `UPDATE market_equipment_listings
           SET status = 'sold',
               buyer_player_id = $2,
               sold_at = clock_timestamp(),
               version = version + 1,
               tax_revision = $3,
               buyer_tax = $4,
               applied_buyer_tax_bps = $5,
               specialty_tax_applied = $6,
               qualifying_tax_tag = $7
           WHERE listing_id = $1 AND status = 'open'
           RETURNING listing_id::text, venue_id::text,
                     equipment_instance_id::text, seller_player_id,
                     buyer_player_id, asking_price::text, status,
                     version::text, presentation_snapshot, created_at, price_currency`,
          [
            listingId,
            actor.playerId,
            tax.taxRevision,
            buyerTax.toString(),
            tax.buyerTaxBps,
            tax.specialtyApplied,
            tax.qualifyingTaxTag
          ]
        );
        if (!updated.rows[0]) {
          throw new MarketError(
            "MARKET_EQUIPMENT_LISTING_STALE",
            "Equipment listing was purchased by another player"
          );
        }
        await client.query(
          `UPDATE player_equipment_state
           SET inventory_revision = inventory_revision + 1
           WHERE player_id = ANY($1::text[])`,
          [[actor.playerId, listing.seller_player_id]]
        );
        await this.writeEquipmentLedger(client, {
          operationKey: `market-equipment-buy:${actor.accountId}:${requestId}`,
          venueId,
          listingId,
          equipmentInstanceId: listing.equipment_instance_id,
          actorPlayerId: actor.playerId,
          entryType: "purchased",
          ...priceDelta(-buyerTotal),
          metadata: {
            askingPrice: askingPrice.toString(),
            buyerTax: buyerTax.toString(),
            taxRevision: tax.taxRevision
          }
        });
        await this.writeEquipmentLedger(client, {
          operationKey: `market-equipment-buy:${actor.accountId}:${requestId}`,
          venueId,
          listingId,
          equipmentInstanceId: listing.equipment_instance_id,
          actorPlayerId: actor.playerId,
          entryType: "buyer_debit",
          ...priceDelta(-buyerTotal),
          metadata: {}
        });
        await this.writeEquipmentLedger(client, {
          operationKey: `market-equipment-buy:${actor.accountId}:${requestId}`,
          venueId,
          listingId,
          equipmentInstanceId: listing.equipment_instance_id,
          actorPlayerId: listing.seller_player_id,
          entryType: "seller_proceeds",
          ...priceDelta(askingPrice),
          metadata: {}
        });
        if (buyerTax > 0n) {
          await this.writeEquipmentLedger(client, {
            operationKey:
              `market-equipment-buy:${actor.accountId}:${requestId}`,
            venueId,
            listingId,
            equipmentInstanceId: listing.equipment_instance_id,
            actorPlayerId: actor.playerId,
            entryType: "tax_burn",
            ...priceDelta(buyerTax),
            metadata: { taxRevision: tax.taxRevision }
          });
        }
        await this.insertSaleNotice(client, {
          sellerPlayerId: listing.seller_player_id,
          eventId: listingId,
          venueId,
          itemName: requireRuntimeItemDefinition(incoming.definition_id).displayName,
          quantity: 1n,
          proceeds: askingPrice,
          priceCurrency: updated.rows[0]!.price_currency === "glimmer" ? "glimmer" : "gold"
        });
        const snapshot = await this.equipmentListingSnapshot(
          client,
          updated.rows[0]!,
          venueId
        );
        return {
          action: "purchase_equipment_listing",
          orderId: null,
          trades: [],
          claimedItems: "0",
          claimedGold: "0",
          equipmentListing: snapshot,
          affectedPlayerIds: [listing.seller_player_id]
        };
      }
    );
    const snapshot = await equipment.refreshInventorySlots(actor.playerId);
    const sellerId = result.equipmentListing?.sellerPlayerId;
    if (sellerId) {
      void equipment.refreshInventorySlots(sellerId).catch((error: unknown) => {
        this.logger.warn(
          { sellerId, error },
          "market equipment seller snapshot refresh failed after commit"
        );
      });
    }
    return { result, equipment: snapshot };
  }

  async cancelEquipmentListing(
    actor: MarketActor,
    connectionId: string,
    marketSessionId: string,
    requestIdRaw: string,
    listingId: string,
    expectedListingVersionRaw: string
  ): Promise<Readonly<{
    result: MarketMutationResult;
    equipment: Awaited<ReturnType<EquipmentService["getSnapshot"]>>;
  }>> {
    const equipment = this.requireEquipmentService();
    const requestId = requireRequestId(requestIdRaw);
    const expectedListingVersion = requireEconomicInteger(
      expectedListingVersionRaw,
      "listing version",
      9_223_372_036_854_775_807n
    );
    const result = await this.executeMutation(
      actor,
      connectionId,
      marketSessionId,
      null,
      requestId,
      "cancel_equipment_listing",
      { listingId, expectedListingVersion: expectedListingVersion.toString() },
      async (client, venueId) => {
        await this.lockMutationControls(client, actor, venueId, "cancel");
        const listing = await this.lockEquipmentListing(client, listingId);
        if (
          listing.venue_id !== venueId ||
          listing.seller_player_id !== actor.playerId ||
          listing.status !== "open" ||
          BigInt(listing.version) !== expectedListingVersion
        ) {
          throw new MarketError(
            "MARKET_EQUIPMENT_LISTING_STALE",
            "Equipment listing is unavailable or not owned here"
          );
        }
        await client.query(
          `SELECT inventory_revision
           FROM player_equipment_state
           WHERE player_id = $1
           FOR UPDATE`,
          [actor.playerId]
        );
        const incoming = await this.lockMarketEquipment(client, listing.equipment_instance_id);
        await assertInventoryWeightInTransaction(client, actor.playerId, BigInt(requireRuntimeItemDefinition(incoming.definition_id).unitWeightGrams));
        const moved = await client.query(
          `UPDATE equipment_instances
           SET location = 'inventory',
               inventory_slot_index = $2,
               market_listing_id = NULL,
               market_collection_id = NULL
           WHERE instance_id = $1
             AND location = 'market_escrow'
             AND market_listing_id = $3`,
          [listing.equipment_instance_id, null, listingId]
        );
        if (moved.rowCount !== 1) {
          throw new MarketError(
            "MARKET_EQUIPMENT_LISTING_STALE",
            "Equipment listing changed before cancellation"
          );
        }
        const updated = await client.query<EquipmentListingRow>(
          `UPDATE market_equipment_listings
           SET status = 'cancelled',
               cancelled_at = clock_timestamp(),
               version = version + 1
           WHERE listing_id = $1 AND status = 'open'
           RETURNING listing_id::text, venue_id::text,
                     equipment_instance_id::text, seller_player_id,
                     buyer_player_id, asking_price::text, status,
                     version::text, presentation_snapshot, created_at`,
          [listingId]
        );
        await client.query(
          `UPDATE player_equipment_state
           SET inventory_revision = inventory_revision + 1
           WHERE player_id = $1`,
          [actor.playerId]
        );
        await this.writeEquipmentLedger(client, {
          operationKey: `market-equipment-cancel:${actor.accountId}:${requestId}`,
          venueId,
          listingId,
          equipmentInstanceId: listing.equipment_instance_id,
          actorPlayerId: actor.playerId,
          entryType: "cancelled",
          metadata: {}
        });
        return {
          action: "cancel_equipment_listing",
          orderId: null,
          trades: [],
          claimedItems: "0",
          claimedGold: "0",
          equipmentListing: await this.equipmentListingSnapshot(
            client,
            updated.rows[0]!,
            venueId
          )
        };
      }
    );
    return {
      result,
      equipment: await equipment.refreshInventorySlots(actor.playerId)
    };
  }

  async cancelOrder(
    actor: MarketActor,
    connectionId: string,
    marketSessionId: string,
    requestIdRaw: string,
    orderId: string
  ): Promise<MarketMutationResult> {
    const requestId = requireRequestId(requestIdRaw);
    return this.executeMutation(
      actor,
      connectionId,
      marketSessionId,
      null,
      requestId,
      "cancel_order",
      { orderId },
      async (client, venueId) => {
        const locator = await client.query<{ book_id: string; venue_id: string }>(
          "SELECT book_id, venue_id FROM market_orders WHERE order_id = $1",
          [orderId]
        );
        const located = locator.rows[0];
        if (!located) throw new MarketError("MARKET_ORDER_NOT_FOUND", "Market order does not exist");
        const venue = await this.venue(client, venueId);
        if (located.venue_id !== venue.venue_id) throw new MarketError("MARKET_ORDER_NOT_FOUND", "Market order does not exist");
        await this.lockMutationControls(client, actor, venue.venue_id, "cancel");
        const book = await this.lockBookById(client, located.book_id);
        // A rate-breaker freeze stops new orders and matching only; owners can still
        // cancel and recover their escrow. Operator freezes block cancels too.
        if (book.frozen && book.sensitive_reason !== PREMIUM_RATE_BREAKER_REASON) {
          throw new MarketError("MARKET_ITEM_FROZEN", "This market item is frozen");
        }
        const orderResult = await client.query<OrderRow>(`${ORDER_COLUMNS} WHERE order_id = $1 FOR UPDATE`, [orderId]);
        const order = orderResult.rows[0];
        if (!order) throw new MarketError("MARKET_ORDER_NOT_FOUND", "Market order does not exist");
        if (order.account_id !== actor.accountId || order.player_id !== actor.playerId) {
          throw new MarketError("MARKET_ORDER_NOT_OWNED", "Only the order owner can cancel it");
        }
        if (order.status === "filled" || order.status === "cancelled") {
          throw new MarketError("MARKET_ORDER_ALREADY_CLOSED", "Market order is already closed");
        }
        await this.feePolicySnapshot(client, order.fee_policy_id, order.fee_policy_version);
        await this.reserveRate(client, actor.playerId, "cancel", this.limits.cancellationsPerMinute);
        await this.faultInjector("during_cancellation");
        const escrowResult = await client.query<EscrowRow>(
          `SELECT order_id, asset_kind, remaining_amount::text
           FROM market_order_escrows WHERE order_id = $1 FOR UPDATE`,
          [orderId]
        );
        const escrow = escrowResult.rows[0];
        if (!escrow || BigInt(escrow.remaining_amount) <= 0n) {
          throw new MarketError("MARKET_INVARIANT_FAILURE", "Open order has no remaining escrow");
        }
        const amount = BigInt(escrow.remaining_amount);
        const premiumCurrency = escrow.asset_kind === "glimmer"
          ? "glimmer"
          : escrow.asset_kind === "item"
            ? premiumCurrencyForMarketItem(order.item_id)
            : null;
        if (premiumCurrency) {
          await this.creditPremiumWallet(client, {
            accountId: order.account_id,
            playerId: order.player_id,
            currency: premiumCurrency,
            amount,
            operationKey: `market-cancel-premium:${orderId}`,
            refType: "market_order",
            refId: orderId
          });
        } else if (escrow.asset_kind === "item") {
          await this.inventory.grantItemsForOperationInTransaction(client, {
            operationKey: `market-cancel-item:${orderId}`,
            playerId: actor.playerId,
            source: "market_manual_cancellation",
            sourceEntityType: "market_order",
            sourceEntityId: orderId,
            metadata: { requestId, venueId },
            grants: [{
              itemId: order.item_id as never,
              variant:
                order.variant === MARKET_DEFAULT_VARIANT ? null : order.variant,
              quantity: amount
            }]
          });
        } else {
          await this.creditWallet(
            client,
            actor,
            amount,
            `market-cancel-gold:${orderId}`,
            "market_manual_cancellation"
          );
        }
        await client.query(
          "UPDATE market_order_escrows SET remaining_amount = 0, updated_at = now() WHERE order_id = $1",
          [orderId]
        );
        await client.query(
          `UPDATE market_orders SET status = 'cancelled', cancelled_at = now()
           WHERE order_id = $1 AND status IN ('open', 'partially_filled')`,
          [orderId]
        );
        await this.bumpBook(client, book.book_id);
        const source = escrow.asset_kind === "item" ? "sell_escrow" : "buy_escrow";
        const destination = premiumCurrency
          ? "premium_wallet"
          : escrow.asset_kind === "item"
            ? "player_inventory"
            : "player_wallet";
        await this.writeLedger(client, {
          groupType: "cancel",
          requestId,
          claimId: null,
          orderId,
          tradeId: null,
          orderFeePolicy: {
            id: order.fee_policy_id,
            version: order.fee_policy_version
          },
          entries: [
            {
              assetKind: escrow.asset_kind,
              itemIdentity: escrow.asset_kind === "item" ? order.item_identity : null,
              amount: -amount,
              accountLocation: source,
              playerId: actor.playerId,
              orderId,
              reason: "cancel_escrow_release"
            },
            {
              assetKind: escrow.asset_kind,
              itemIdentity: escrow.asset_kind === "item" ? order.item_identity : null,
              amount,
              accountLocation: destination,
              playerId: actor.playerId,
              orderId,
              reason: "cancel_direct_return"
            }
          ]
        });
        await client.query(
          `INSERT INTO market_audit_events (
             severity, event_type, venue_id, book_id, player_id, order_id, request_id, evidence
           ) VALUES ('info','order_cancelled',$1,$2,$3,$4,$5,$6::jsonb)`,
          [venue.venue_id, book.book_id, actor.playerId, orderId, requestId, JSON.stringify({ amount: amount.toString() })]
        );
        return {
          action: "cancel_order",
          orderId,
          trades: [],
          claimedItems: "0",
          claimedGold: "0"
        };
      }
    );
  }

  async claim(
    actor: MarketActor,
    connectionId: string,
    marketSessionId: string,
    requestIdRaw: string,
    scope: MarketCollectionScope
  ): Promise<MarketMutationResult> {
    const requestId = requireRequestId(requestIdRaw);
    const action: MutationAction = scope === "items" ? "claim_items" : scope === "gold" ? "claim_gold" : "claim_all";
    const result = await this.executeMutation(
      actor,
      connectionId,
      marketSessionId,
      null,
      requestId,
      action,
      { scope },
      async (client, venueId) => {
        const venue = await this.venue(client, venueId);
        await this.lockMutationControls(client, actor, venue.venue_id, "claim");
        await this.reserveRate(client, actor.playerId, "claim", this.limits.requestsPerMinute);
        const kinds = scope === "all" ? ["item", "gold"] : [scope === "items" ? "item" : "gold"];
        const equipmentCollections =
          scope === "gold"
            ? { rows: [] as Array<{
                collection_id: string;
                listing_id: string;
                equipment_instance_id: string;
              }> }
            : await client.query<{
                collection_id: string;
                listing_id: string;
                equipment_instance_id: string;
              }>(
                `SELECT collection_id::text, listing_id::text,
                        equipment_instance_id::text
                 FROM market_equipment_collections
                 WHERE venue_id = $1
                   AND player_id = $2
                   AND claimed_at IS NULL
                 ORDER BY created_at, collection_id
                 LIMIT $3
                 FOR UPDATE`,
                [venueId, actor.playerId, this.limits.maxClaimsPerRequest]
              );
        const equipmentGoldCollections =
          scope === "items"
            ? { rows: [] as Array<{
                collection_id: string;
                listing_id: string;
                remaining_amount: string;
              }> }
            : await client.query<{
                collection_id: string;
                listing_id: string;
                remaining_amount: string;
              }>(
                `SELECT collection_id::text, listing_id::text,
                        remaining_amount::text
                 FROM market_equipment_gold_collections
                 WHERE venue_id = $1
                   AND player_id = $2
                   AND remaining_amount > 0
                 ORDER BY created_at, collection_id
                 LIMIT $3
                 FOR UPDATE`,
                [venueId, actor.playerId, this.limits.maxClaimsPerRequest]
              );
        const collections = await client.query<CollectionRow>(
          `SELECT collection_id::text, asset_kind, item_identity, item_id, variant,
                  remaining_amount::text, reason, source_order_id, source_trade_id
           FROM market_collections
           WHERE player_id = $1 AND venue_id = $2
             AND remaining_amount > 0 AND asset_kind = ANY($3::text[])
           ORDER BY collection_id ASC
           LIMIT $4 FOR UPDATE`,
          [actor.playerId, venueId, kinds, this.limits.maxClaimsPerRequest]
        );
        // A claim's deferred provenance guards revalidate both orders behind
        // every source trade. Keep their mutable state stable until COMMIT so
        // a concurrent fill cannot create a mixed READ COMMITTED snapshot.
        await client.query(
          `WITH related_orders AS (
             SELECT unnest($1::uuid[]) AS order_id
             UNION
             SELECT buy_order_id FROM market_trades WHERE trade_id = ANY($2::uuid[])
             UNION
             SELECT sell_order_id FROM market_trades WHERE trade_id = ANY($2::uuid[])
           )
           SELECT orders.order_id
           FROM market_orders AS orders
           JOIN related_orders USING (order_id)
           ORDER BY orders.order_id
           FOR UPDATE OF orders`,
          [
            [...new Set(collections.rows.map((row) => row.source_order_id))],
            [...new Set(collections.rows.flatMap((row) => row.source_trade_id ? [row.source_trade_id] : []))]
          ]
        );
        await this.faultInjector("during_claim");
        const itemRows = collections.rows.filter((row) => row.asset_kind === "item");
        const goldRows = collections.rows.filter((row) => row.asset_kind === "gold");
        const itemTotal = itemRows.reduce((sum, row) => sum + BigInt(row.remaining_amount), 0n);
        const equipmentGoldTotal = equipmentGoldCollections.rows.reduce(
          (sum, row) => sum + BigInt(row.remaining_amount),
          0n
        );
        const goldTotal =
          goldRows.reduce(
            (sum, row) => sum + BigInt(row.remaining_amount),
            0n
          ) + equipmentGoldTotal;
        if (itemRows.length > 0) {
          const grants = new Map<string, {
            itemId: string;
            variant: string | null;
            quantity: bigint;
          }>();
          for (const row of itemRows) {
            const key = `${row.item_id}\u0000${row.variant}`;
            const quantity = BigInt(row.remaining_amount);
            const prior = grants.get(key);
            grants.set(key, {
              itemId: row.item_id!,
              variant: row.variant === MARKET_DEFAULT_VARIANT ? null : row.variant,
              quantity: (prior?.quantity ?? 0n) + quantity
            });
          }
          await this.inventory.grantItemsForOperationInTransaction(client, {
            operationKey: `market-claim-items:${actor.accountId}:${requestId}`,
            playerId: actor.playerId,
            source: "market_collection_claim",
            sourceEntityType: "market_claim",
            sourceEntityId: requestId,
            metadata: { requestId },
            grants: [...grants.values()] as never
          });
        }
        if (goldTotal > 0n) {
          await this.creditWallet(client, actor, goldTotal, `market-claim-gold:${actor.accountId}:${requestId}`, "market_collection_claim");
        }
        if (equipmentCollections.rows.length > 0) {
          await client.query(
            `SELECT inventory_revision
             FROM player_equipment_state
             WHERE player_id = $1
             FOR UPDATE`,
            [actor.playerId]
          );
          for (const row of equipmentCollections.rows) {
            const incoming = await this.lockMarketEquipment(client, row.equipment_instance_id);
            await assertInventoryWeightInTransaction(client, actor.playerId, BigInt(requireRuntimeItemDefinition(incoming.definition_id).unitWeightGrams));
            const moved = await client.query(
              `UPDATE equipment_instances
               SET location = 'inventory',
                   inventory_slot_index = $3,
                   market_listing_id = NULL,
                   market_collection_id = NULL
               WHERE instance_id = $1
                 AND owner_player_id = $2
                 AND location = 'market_collection'
                 AND market_collection_id = $4`,
              [
                row.equipment_instance_id,
                actor.playerId,
                null,
                row.collection_id
              ]
            );
            if (moved.rowCount !== 1) {
              throw new MarketError(
                "MARKET_INVARIANT_FAILURE",
                "Equipment collection ownership is inconsistent"
              );
            }
            await client.query(
              `UPDATE market_equipment_collections
               SET claimed_at = clock_timestamp()
               WHERE collection_id = $1 AND claimed_at IS NULL`,
              [row.collection_id]
            );
            await client.query(
              `UPDATE market_equipment_listings
               SET status = 'claimed', version = version + 1
               WHERE listing_id = $1
                 AND status IN ('sold', 'cancelled')`,
              [row.listing_id]
            );
            await this.writeEquipmentLedger(client, {
              operationKey:
                `market-equipment-claim:${actor.accountId}:${requestId}:${row.collection_id}`,
              venueId,
              listingId: row.listing_id,
              equipmentInstanceId: row.equipment_instance_id,
              actorPlayerId: actor.playerId,
              entryType: "collected",
              metadata: { destination: "inventory" }
            });
          }
          await client.query(
            `UPDATE player_equipment_state
             SET inventory_revision = inventory_revision + 1
             WHERE player_id = $1`,
            [actor.playerId]
          );
        }
        for (const row of equipmentGoldCollections.rows) {
          await client.query(
            `UPDATE market_equipment_gold_collections
             SET remaining_amount = 0,
                 claimed_at = clock_timestamp()
             WHERE collection_id = $1 AND remaining_amount > 0`,
            [row.collection_id]
          );
        }
        const claimId = crypto.randomUUID();
        const ledgerEntries: LedgerEntry[] = [];
        for (const row of collections.rows) {
          const amount = BigInt(row.remaining_amount);
          await client.query(
            `UPDATE market_collections SET remaining_amount = 0, claimed_at = now(), updated_at = now()
             WHERE collection_id = $1`,
            [row.collection_id]
          );
          if (row.asset_kind === "item") {
            const sourceLocation =
              row.reason === "sell_cancel_return" || row.reason === "sell_expired_return"
                ? "return_collection"
                : "buyer_collection";
            ledgerEntries.push(
              { assetKind: "item", itemIdentity: row.item_identity, amount: -amount, accountLocation: sourceLocation, playerId: actor.playerId, collectionId: row.collection_id, reason: "claim_item_debit" },
              { assetKind: "item", itemIdentity: row.item_identity, amount, accountLocation: "player_inventory", playerId: actor.playerId, reason: "claim_item_credit" }
            );
          } else {
            const sourceLocation =
              row.reason === "sell_proceeds"
                ? "seller_proceeds"
                : row.reason === "buy_expired_refund"
                  ? "return_collection"
                  : "refund_balance";
            ledgerEntries.push(
              { assetKind: "gold", itemIdentity: null, amount: -amount, accountLocation: sourceLocation, playerId: actor.playerId, collectionId: row.collection_id, reason: "claim_gold_debit" },
              { assetKind: "gold", itemIdentity: null, amount, accountLocation: "player_wallet", playerId: actor.playerId, reason: "claim_gold_credit" }
            );
          }
        }
        if (ledgerEntries.length > 0) {
          await this.writeLedger(client, {
            groupType: "claim",
            requestId,
            claimId,
            orderId: null,
            tradeId: null,
            entries: ledgerEntries
          });
        }
        const resultStub = { itemUnitsClaimed: itemTotal.toString(), goldClaimed: goldTotal.toString() };
        await client.query(
          `INSERT INTO market_claims (
             claim_id, player_id, account_id, client_request_id, asset_scope,
             item_units_claimed, gold_claimed, result, venue_id
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`,
          [
            claimId,
            actor.playerId,
            actor.accountId,
            requestId,
            scope,
            itemTotal.toString(),
            goldTotal.toString(),
            JSON.stringify(resultStub),
            venueId
          ]
        );
        return {
          action: "claim",
          orderId: null,
          trades: [],
          claimedItems: itemTotal.toString(),
          claimedGold: goldTotal.toString(),
          claimedEquipment: equipmentCollections.rows.length
        };
      }
    );
    if (result.claimedEquipment > 0) {
      await this.requireEquipmentService().refreshInventorySlots(actor.playerId);
    }
    return result;
  }

  private async executeMutation(
    actor: MarketActor,
    connectionId: string,
    marketSessionId: string,
    itemIdentity: string | null,
    requestId: string,
    action: MutationAction,
    requestBody: unknown,
    operation: (
      client: pg.PoolClient,
      venueId: string
    ) => Promise<MutationCore>
  ): Promise<MarketMutationResult> {
    for (let attempt = 0; attempt <= this.limits.transactionRetryLimit; attempt += 1) {
      const client = await this.pool.connect();
      let committed = false;
      let venueId = "";
      let committedPlayerIds = [actor.playerId];
      try {
        await client.query("BEGIN");
        await acquireMarketMutationSafetyLock(client);
        const venueAuthority = await this.access.requireSession(
          client,
          actor,
          connectionId,
          marketSessionId
        );
        venueId = venueAuthority.venueId;
        const requestHash = marketRequestHash({
          action,
          venueId,
          // `itemId` is the historical persisted hash key. Its value now
          // carries the exact market identity for variant-aware requests.
          itemId: itemIdentity,
          requestBody
        });
        const reserved = await client.query(
          `INSERT INTO market_requests (
             player_id, account_id, request_id, action, request_hash, result,
             venue_id
           )
           VALUES ($1,$2,$3,$4,$5,'{}'::jsonb,$6)
           ON CONFLICT (account_id, request_id) DO NOTHING
           RETURNING request_id`,
          [
            actor.playerId,
            actor.accountId,
            requestId,
            action,
            requestHash,
            venueId
          ]
        );
        if (reserved.rowCount === 0) {
          const replay = await client.query<{
            player_id: string;
            action: MutationAction;
            request_hash: string;
            result: MarketMutationResult;
          }>(
            `SELECT player_id, action, request_hash, result
             FROM market_requests WHERE account_id = $1 AND request_id = $2`,
            [actor.accountId, requestId]
          );
          const row = replay.rows[0];
          if (!row || row.player_id !== actor.playerId || row.action !== action || row.request_hash !== requestHash || !row.result?.action) {
            throw new MarketError("MARKET_REPLAY_CONFLICT", "Request id was already used with different market intent");
          }
          await client.query("COMMIT");
          committed = true;
          return { ...row.result, replayed: true };
        }
        const core = await operation(client, venueId);
        committedPlayerIds = [...new Set([
          actor.playerId,
          ...(core.affectedPlayerIds ?? [])
        ])];
        if (core.trades.length > 0) {
          const participants = await client.query<{ buyer_player_id: string; seller_player_id: string }>(
            `SELECT buyer_player_id, seller_player_id FROM market_trades
             WHERE trade_id = ANY($1::uuid[])`,
            [core.trades.map((trade) => trade.tradeId)]
          );
          committedPlayerIds = [...new Set([
            actor.playerId,
            ...(core.affectedPlayerIds ?? []),
            ...participants.rows.flatMap((row) => [row.buyer_player_id, row.seller_player_id])
          ])];
        }
        const order = core.orderId ? await this.read.order(client, core.orderId) : null;
        const player = await this.read.playerSnapshot(client, actor, venueId);
        const result: MarketMutationResult = {
          action: core.action,
          requestId,
          replayed: false,
          order,
          trades: core.trades,
          claimedItems: core.claimedItems,
          claimedGold: core.claimedGold,
          claimedEquipment: core.claimedEquipment ?? 0,
          equipmentListing: core.equipmentListing ?? null,
          player
        };
        await client.query(
          `UPDATE market_requests SET result = $3::jsonb
           WHERE account_id = $1 AND request_id = $2`,
          [actor.accountId, requestId, JSON.stringify(result)]
        );
        await this.faultInjector("before_commit");
        await client.query("COMMIT");
        committed = true;
        this.metrics.transactions += 1;
        await this.faultInjector("after_commit_before_response");
        this.onCommitted({
          itemIdentity: result.order?.itemIdentity ?? null,
          venueId,
          playerIds: committedPlayerIds,
          premiumCurrencyChanged:
            premiumCurrencyForMarketItem(result.order?.itemId) !== null ||
            result.order?.priceCurrency === "glimmer" ||
            result.equipmentListing?.priceCurrency === "glimmer",
          priceCurrency: result.order?.priceCurrency
        });
        return result;
      } catch (error) {
        if (!committed) await client.query("ROLLBACK").catch(() => undefined);
        if (!committed && isRetryablePostgresError(error) && attempt < this.limits.transactionRetryLimit) {
          this.metrics.retries += 1;
          if ((error as { code?: string }).code === "40P01") this.metrics.deadlocks += 1;
          if ((error as { code?: string }).code === "40001") this.metrics.serializationFailures += 1;
          this.logger.warn({ attempt: attempt + 1, code: (error as { code?: string }).code, action }, "retrying market transaction");
          continue;
        }
        throw this.mapAndReportError(error, action);
      } finally {
        client.release();
      }
    }
    throw new MarketError("MARKET_BUSY", "Market transaction retry limit reached", true);
  }

  private async createAndMatchOrder(
    client: pg.PoolClient,
    input: {
      actor: MarketActor;
      requestId: string;
      venue: VenueRow;
      controls: { rulesVersion: number };
      fee: FeeRow;
      book: BookRow;
      item: ItemRow;
      side: MarketOrderSide;
      quantity: bigint;
      unitPrice: bigint;
      policy: "gtc" | "aon_ioc";
      buyEscrowOverride?: bigint;
    }
  ): Promise<MutationCore> {
    const orderId = crypto.randomUUID();
    const value = checkedOrderValue(input.unitPrice, input.quantity, this.limits.maxTotalOrderValue);
    const buyerFeeAtLimit = calculateFee(
      value,
      CITY_MARKET_STANDARD_BUYER_TAX_BPS
    );
    const premiumCurrency = premiumCurrencyForMarketItem(input.item.item_id);
    const glimmerPriced = input.book.price_currency === "glimmer";
    const priceAsset = glimmerPriced ? "glimmer" : "gold";
    const premiumFeeBps = premiumCurrency && input.side === "sell"
      ? await this.premiumSellerFeeBps(client, input.item.item_id)
      : null;
    const premiumFeeReserve = premiumFeeBps === null
      ? 0n
      : premiumMarketSellerFee(input.quantity, premiumFeeBps);
    const escrowAmount = input.side === "buy"
      ? input.buyEscrowOverride ?? value + buyerFeeAtLimit
      : input.quantity + premiumFeeReserve;
    if (escrowAmount > this.limits.maxTotalOrderValue && input.side === "buy") {
      throw new MarketError("MARKET_ORDER_VALUE_LIMIT", "Order escrow exceeds the configured total limit");
    }
    if (input.side === "sell" && premiumCurrency) {
      await this.faultInjector("before_inventory_debit");
      try {
        await this.premiumWallet.debitForOperationInTransaction(client, {
          accountId: input.actor.accountId,
          actorPlayerId: input.actor.playerId,
          currency: premiumCurrency,
          amount: escrowAmount,
          operationKey: `market-sell-escrow:${input.actor.accountId}:${input.requestId}`,
          reason: "market",
          refType: "market_order",
          refId: orderId,
          metadata: { requestId: input.requestId, feeReserve: premiumFeeReserve.toString() }
        });
      } catch (error) {
        throw mapPremiumWalletOperationError(error, premiumCurrency);
      }
      await this.faultInjector("after_inventory_debit");
    } else if (input.side === "sell") {
      await this.faultInjector("before_inventory_debit");
      try {
        await this.inventory.debitItemsForOperationInTransaction(client, {
          operationKey: `market-sell-escrow:${input.actor.accountId}:${input.requestId}`,
          playerId: input.actor.playerId,
          source: "market_sell_escrow",
          sourceEntityType: "market_order",
          sourceEntityId: orderId,
          metadata: { requestId: input.requestId },
          debits: [{
            itemId: input.item.item_id as never,
            variant: input.item.variant === MARKET_DEFAULT_VARIANT ? null : input.item.variant,
            quantity: input.quantity
          }]
        });
      } catch (error) {
        if (error instanceof Error && error.message.includes("enough items")) {
          throw new MarketError("MARKET_NOT_ENOUGH_ITEMS", "Not enough authoritative inventory for this sell order");
        }
        if (isInventoryItemEquippedError(error)) throw new MarketError("MARKET_ITEM_NOT_TRADABLE", error.message);
        throw error;
      }
      await this.faultInjector("after_inventory_debit");
    } else if (glimmerPriced) {
      try {
        await this.premiumWallet.debitForOperationInTransaction(client, {
          accountId: input.actor.accountId,
          actorPlayerId: input.actor.playerId,
          currency: "glimmer",
          amount: escrowAmount,
          operationKey: `market-buy-escrow:${input.actor.accountId}:${input.requestId}`,
          reason: "market",
          refType: "market_order",
          refId: orderId,
          metadata: { requestId: input.requestId }
        });
      } catch (error) {
        if (error instanceof PremiumWalletOperationError && error.code === "PREMIUM_WALLET_INSUFFICIENT_FUNDS") {
          throw new MarketError("MARKET_NOT_ENOUGH_GOLD", "Not enough Glimmer for this order");
        }
        throw mapPremiumWalletOperationError(error, "glimmer");
      }
    } else {
      await this.debitWallet(
        client,
        input.actor,
        escrowAmount,
        `market-buy-escrow:${input.actor.accountId}:${input.requestId}`,
        orderId
      );
    }
    await client.query(
      `INSERT INTO market_order_escrows (
         order_id, player_id, asset_kind, item_identity, item_id, variant,
         initial_amount, remaining_amount
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$7)`,
      [
        orderId,
        input.actor.playerId,
        input.side === "sell" ? "item" : priceAsset,
        input.side === "sell" ? input.item.market_identity : null,
        input.side === "sell" ? input.item.item_id : null,
        input.side === "sell" ? input.item.variant : null,
        escrowAmount.toString()
      ]
    );
    await this.faultInjector("after_escrow_creation");
    const createdBookVersion = await this.bumpBook(client, input.book.book_id);
    const inserted = await client.query<OrderRow>(
      `INSERT INTO market_orders (
         order_id, venue_id, book_id, item_identity, item_id, variant, player_id, account_id,
         side, order_policy, limit_unit_price, original_quantity, remaining_quantity,
         filled_quantity, status, book_version_created, client_request_id,
         fee_policy_id, fee_policy_version, rules_version
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,0,'open',$13,$14,$15,$16,$17)
       RETURNING ${ORDER_RETURNING}`,
      [
        orderId,
        input.venue.venue_id,
        input.book.book_id,
        input.item.market_identity,
        input.item.item_id,
        input.item.variant,
        input.actor.playerId,
        input.actor.accountId,
        input.side,
        input.policy,
        input.unitPrice.toString(),
        input.quantity.toString(),
        createdBookVersion,
        input.requestId,
        input.fee.fee_policy_id,
        input.fee.version,
        input.controls.rulesVersion
      ]
    );
    const order = inserted.rows[0];
    if (!order) throw new Error("Market order insert returned no row");
    if (premiumFeeBps !== null) {
      await client.query(
        `INSERT INTO market_premium_sell_terms (order_id, item_id, seller_fee_bps, fee_reserve)
         VALUES ($1,$2,$3,$4)`,
        [orderId, input.item.item_id, premiumFeeBps, premiumFeeReserve.toString()]
      );
    }
    await this.faultInjector("after_order_creation");
    await this.writeLedger(client, {
      groupType: "order_escrow",
      requestId: input.requestId,
      claimId: null,
      orderId,
      tradeId: null,
      orderFeePolicy: {
        id: input.fee.fee_policy_id,
        version: input.fee.version
      },
      entries: input.side === "sell"
        ? [
            { assetKind: "item", itemIdentity: input.item.market_identity, amount: -escrowAmount, accountLocation: premiumCurrency ? "premium_wallet" : "player_inventory", playerId: input.actor.playerId, orderId, reason: "sell_escrow_debit" },
            { assetKind: "item", itemIdentity: input.item.market_identity, amount: escrowAmount, accountLocation: "sell_escrow", playerId: input.actor.playerId, orderId, reason: "sell_escrow_credit" }
          ]
        : [
            { assetKind: priceAsset, itemIdentity: null, amount: -escrowAmount, accountLocation: glimmerPriced ? "premium_wallet" : "player_wallet", playerId: input.actor.playerId, orderId, reason: "buy_escrow_debit" },
            { assetKind: priceAsset, itemIdentity: null, amount: escrowAmount, accountLocation: "buy_escrow", playerId: input.actor.playerId, orderId, reason: "buy_escrow_credit" }
          ]
    });
    await this.faultInjector("after_ledger_insert");
    const trades = await this.matchIncomingOrder(client, order);
    if (input.policy === "aon_ioc") {
      const filled = trades.reduce((sum, trade) => sum + BigInt(trade.quantity), 0n);
      if (filled !== input.quantity) throw new MarketError("MARKET_PRICE_CHANGED", "Atomic purchase could not be completed");
    }
    if (input.policy === "gtc" && BigInt(order.remaining_quantity) > 0n) {
      await this.enforceOrderLimits(client, input.actor, input.book.book_id, order.order_id);
    }
    if (premiumCurrency && trades.length > 0) {
      await this.applyPremiumRateBreaker(client, input.book.book_id, premiumCurrency);
    }
    return {
      action: "create_order",
      orderId,
      trades,
      claimedItems: "0",
      claimedGold: "0"
    };
  }

  private async matchIncomingOrder(client: pg.PoolClient, incomingRow: OrderRow): Promise<MarketPublicTrade[]> {
    // Settlement mutates this object as fills are applied; callers use the
    // final remainder to decide whether resting-order limits apply.
    const incoming = incomingRow;
    const opposite = incoming.side === "buy" ? "sell" : "buy";
    const comparator = incoming.side === "buy" ? "limit_unit_price <= $2" : "limit_unit_price >= $2";
    const direction = incoming.side === "buy" ? "ASC" : "DESC";
    const trades: MarketPublicTrade[] = [];
    const feePolicies = new Map<string, FeeRow>();
    while (BigInt(incoming.remaining_quantity) > 0n) {
      const restingResult = await client.query<OrderRow>(
        `${ORDER_COLUMNS}
         WHERE book_id = $1 AND side = '${opposite}'
           AND status IN ('open', 'partially_filled')
           AND ${comparator}
           AND account_id <> $3
         ORDER BY market_orders.limit_unit_price ${direction}, market_orders.priority_sequence ASC
         LIMIT $4 FOR UPDATE`,
        [incoming.book_id, incoming.limit_unit_price, incoming.account_id, this.matchingBatchSize]
      );
      if (restingResult.rows.length === 0) break;
      for (const resting of restingResult.rows) {
        if (BigInt(incoming.remaining_quantity) <= 0n) break;
        if (!isOpen(resting.status) || BigInt(resting.remaining_quantity) <= 0n) continue;
        const quantity = minBigInt(BigInt(incoming.remaining_quantity), BigInt(resting.remaining_quantity));
        const trade = await this.settleFill(client, incoming, resting, quantity, feePolicies);
        trades.push(trade);
        this.metrics.fills += 1;
        if (trades.length > 1) await this.faultInjector("midway_multi_fill");
      }
    }
    return trades;
  }

  private async settleFill(
    client: pg.PoolClient,
    incoming: OrderRow,
    resting: OrderRow,
    quantity: bigint,
    feePolicies: Map<string, FeeRow>
  ): Promise<MarketPublicTrade> {
    if (incoming.account_id === resting.account_id) {
      throw new MarketError("MARKET_INVARIANT_FAILURE", "Self-trade reached settlement");
    }
    const buy = incoming.side === "buy" ? incoming : resting;
    const sell = incoming.side === "sell" ? incoming : resting;
    await this.feePolicySnapshot(
      client,
      buy.fee_policy_id,
      buy.fee_policy_version,
      feePolicies
    );
    const sellFeePolicy = await this.feePolicySnapshot(
      client,
      sell.fee_policy_id,
      sell.fee_policy_version,
      feePolicies
    );
    const unitPrice = BigInt(resting.limit_unit_price);
    const gross = checkedOrderValue(unitPrice, quantity, this.limits.maxTotalOrderValue);
    const { tax, merchantRank } = await this.resolveBuyerMarketTax(
      client,
      incoming.venue_id,
      await this.itemTaxTags(client, incoming.item_id),
      buy.player_id
    );
    const baseBuyerFeePolicy = await this.feePolicy(
      client,
      tax.specialtyApplied ? 3 : 2
    );
    // The trade snapshot must be an immutable fee policy whose bps equal the charged tax.
    const buyerFeePolicy = merchantRank >= 2
      ? await this.feePolicyForBuyerBps(client, tax.buyerTaxBps)
      : baseBuyerFeePolicy;
    const buyerFee = calculateFee(gross, tax.buyerTaxBps);
    const sellerFee = calculateFee(gross, sellFeePolicy.seller_fee_bps);
    const sellerProceeds = gross - sellerFee;
    const buyEscrowResult = await client.query<EscrowRow>(
      `SELECT order_id, asset_kind, remaining_amount::text
       FROM market_order_escrows WHERE order_id = $1 FOR UPDATE`,
      [buy.order_id]
    );
    const sellEscrowResult = await client.query<EscrowRow>(
      `SELECT order_id, asset_kind, remaining_amount::text
       FROM market_order_escrows WHERE order_id = $1 FOR UPDATE`,
      [sell.order_id]
    );
    const buyEscrow = buyEscrowResult.rows[0];
    const sellEscrow = sellEscrowResult.rows[0];
    const premiumCurrency = premiumCurrencyForMarketItem(incoming.item_id);
    let currencyFee = 0n;
    if (premiumCurrency) {
      const terms = await client.query<{ seller_fee_bps: number }>(
        "SELECT seller_fee_bps FROM market_premium_sell_terms WHERE order_id = $1",
        [sell.order_id]
      );
      const bps = terms.rows[0]?.seller_fee_bps;
      if (bps === undefined) {
        throw new MarketError("MARKET_INVARIANT_FAILURE", "Premium sell order has no fee terms");
      }
      const filledBefore = BigInt(sell.filled_quantity);
      currencyFee = premiumMarketSellerFee(filledBefore + quantity, Number(bps)) -
        premiumMarketSellerFee(filledBefore, Number(bps));
    }
    if (
      !buyEscrow || (buyEscrow.asset_kind !== "gold" && buyEscrow.asset_kind !== "glimmer") ||
      !sellEscrow || sellEscrow.asset_kind !== "item"
    ) {
      throw new MarketError("MARKET_INVARIANT_FAILURE", "Trade escrow is missing or invalid");
    }
    // The buy escrow carries the book's price currency.
    const priceAsset = buyEscrow.asset_kind;
    const priceWallet = priceAsset === "glimmer" ? "premium_wallet" : "player_wallet";
    const buyRemainingBefore = BigInt(buyEscrow.remaining_amount);
    const buyQuantityAfter = BigInt(buy.remaining_quantity) - quantity;
    const remainingLimitValue = buyQuantityAfter === 0n
      ? 0n
      : checkedOrderValue(BigInt(buy.limit_unit_price), buyQuantityAfter, this.limits.maxTotalOrderValue);
    const requiredAfter = buy.order_policy === "aon_ioc"
      ? buyRemainingBefore - gross - buyerFee
      : remainingLimitValue + calculateFee(
          remainingLimitValue,
          CITY_MARKET_STANDARD_BUYER_TAX_BPS
        );
    const refund = buyRemainingBefore - requiredAfter - gross - buyerFee;
    if (requiredAfter < 0n || refund < 0n || BigInt(sellEscrow.remaining_amount) < quantity + currencyFee) {
      throw new MarketError("MARKET_INVARIANT_FAILURE", "Escrow cannot cover this fill");
    }
    const tradeId = crypto.randomUUID();
    const bookVersion = await this.bumpBook(client, incoming.book_id);
    const insertedTrade = await client.query<TradeRowForInsert>(
      `INSERT INTO market_trades (
         trade_id, venue_id, book_id, item_identity, item_id, variant,
         buy_order_id, sell_order_id, buyer_player_id, seller_player_id,
         maker_order_id, quantity, unit_price, gross_value, buyer_fee, seller_fee,
         book_version, buyer_fee_policy_id, buyer_fee_policy_version,
         seller_fee_policy_id, seller_fee_policy_version, rules_version,
         applied_buyer_tax_bps, district_type, tax_revision,
         specialty_tax_applied, qualifying_tax_tag
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
          $18,$19,$20,$21,$22,$23,$24,$25,$26,$27
        )
       RETURNING trade_id, quantity::text, unit_price::text, gross_value::text,
                 buyer_fee::text, (gross_value - seller_fee)::text AS seller_proceeds,
                 applied_buyer_tax_bps, specialty_tax_applied,
                 qualifying_tax_tag, created_at`,
      [
        tradeId,
        incoming.venue_id,
        incoming.book_id,
        incoming.item_identity,
        incoming.item_id,
        incoming.variant,
        buy.order_id,
        sell.order_id,
        buy.player_id,
        sell.player_id,
        resting.order_id,
        quantity.toString(),
        unitPrice.toString(),
        gross.toString(),
        buyerFee.toString(),
        sellerFee.toString(),
        bookVersion,
        buyerFeePolicy.fee_policy_id,
        buyerFeePolicy.version,
        sellFeePolicy.fee_policy_id,
        sellFeePolicy.version,
        MARKET_RULES_VERSION,
        tax.buyerTaxBps,
        tax.districtType,
        tax.taxRevision,
        tax.specialtyApplied,
        tax.qualifyingTaxTag
      ]
    );
    await this.faultInjector("after_trade_insert");
    await this.transferFishingRodOwnershipOnTrade(
      client,
      {
        item_id: incoming.item_id,
        variant: incoming.variant,
        market_identity: incoming.item_identity
      },
      sell.player_id,
      buy.player_id,
      quantity
    );
    if (premiumCurrency) {
      await this.creditPremiumWallet(client, {
        accountId: buy.account_id,
        playerId: buy.player_id,
        currency: premiumCurrency,
        amount: quantity,
        operationKey: `market-trade-premium:${tradeId}`,
        refType: "market_trade",
        refId: tradeId
      });
    } else {
      await this.inventory.grantItemsForOperationInTransaction(client, {
        operationKey: `market-trade-item:${tradeId}`,
        playerId: buy.player_id,
        source: "market_trade_purchase",
        sourceEntityType: "market_trade",
        sourceEntityId: tradeId,
        metadata: {
          buyOrderId: buy.order_id,
          sellOrderId: sell.order_id,
          venueId: incoming.venue_id
        },
        grants: [{
          itemId: incoming.item_id as never,
          variant:
            incoming.variant === MARKET_DEFAULT_VARIANT
              ? null
              : incoming.variant,
          quantity
        }]
      });
    }
    if (sellerProceeds > 0n && priceAsset === "glimmer") {
      await this.creditPremiumWallet(client, {
        accountId: sell.account_id,
        playerId: sell.player_id,
        currency: "glimmer",
        amount: sellerProceeds,
        operationKey: `market-trade-proceeds:${tradeId}`,
        refType: "market_trade",
        refId: tradeId
      });
    } else if (sellerProceeds > 0n) {
      await this.creditWallet(
        client,
        { playerId: sell.player_id, accountId: sell.account_id },
        sellerProceeds,
        `market-trade-seller:${tradeId}`,
        "market_trade_seller_proceeds",
        { marketTradeId: tradeId }
      );
    }
    if (refund > 0n && priceAsset === "glimmer") {
      await this.creditPremiumWallet(client, {
        accountId: buy.account_id,
        playerId: buy.player_id,
        currency: "glimmer",
        amount: refund,
        operationKey: `market-trade-refund:${tradeId}`,
        refType: "market_trade",
        refId: tradeId
      });
    } else if (refund > 0n) {
      await this.creditWallet(
        client,
        { playerId: buy.player_id, accountId: buy.account_id },
        refund,
        `market-trade-refund:${tradeId}`,
        "market_trade_price_improvement",
        { marketTradeId: tradeId }
      );
    }
    await client.query(
      "UPDATE market_order_escrows SET remaining_amount = $2, updated_at = now() WHERE order_id = $1",
      [buy.order_id, requiredAfter.toString()]
    );
    await client.query(
      "UPDATE market_order_escrows SET remaining_amount = remaining_amount - $2, updated_at = now() WHERE order_id = $1 AND remaining_amount >= $2",
      [sell.order_id, (quantity + currencyFee).toString()]
    );
    await this.applyFillToOrder(client, buy, quantity);
    await this.applyFillToOrder(client, sell, quantity);
    const entries: LedgerEntry[] = [
      { assetKind: "item", itemIdentity: incoming.item_identity, amount: -(quantity + currencyFee), accountLocation: "sell_escrow", playerId: sell.player_id, orderId: sell.order_id, tradeId, reason: "trade_item_debit" },
      { assetKind: "item", itemIdentity: incoming.item_identity, amount: quantity, accountLocation: premiumCurrency ? "premium_wallet" : "player_inventory", playerId: buy.player_id, orderId: buy.order_id, tradeId, reason: "trade_item_credit" },
      { assetKind: priceAsset, itemIdentity: null, amount: -(gross + buyerFee + refund), accountLocation: "buy_escrow", playerId: buy.player_id, orderId: buy.order_id, tradeId, reason: "trade_gold_debit" }
    ];
    if (sellerProceeds > 0n) entries.push({ assetKind: priceAsset, itemIdentity: null, amount: sellerProceeds, accountLocation: priceWallet, playerId: sell.player_id, orderId: sell.order_id, tradeId, reason: "seller_proceeds_credit" });
    if (refund > 0n) entries.push({ assetKind: priceAsset, itemIdentity: null, amount: refund, accountLocation: priceWallet, playerId: buy.player_id, orderId: buy.order_id, tradeId, reason: "price_improvement_credit" });
    if (currencyFee > 0n) entries.push({ assetKind: "item", itemIdentity: incoming.item_identity, amount: currencyFee, accountLocation: "fee_sink", tradeId, reason: "trade_currency_fee" });
    if (buyerFee + sellerFee > 0n) entries.push({ assetKind: priceAsset, itemIdentity: null, amount: buyerFee + sellerFee, accountLocation: "fee_sink", tradeId, reason: "trade_fee_credit" });
    await this.writeLedger(client, {
      groupType: "trade",
      requestId: incoming.client_request_id,
      claimId: null,
      orderId: null,
      tradeId,
      tradeFeePolicies: {
        buyerId: buyerFeePolicy.fee_policy_id,
        buyerVersion: buyerFeePolicy.version,
        sellerId: sellFeePolicy.fee_policy_id,
        sellerVersion: sellFeePolicy.version
      },
      entries
    });
    await this.faultInjector("after_ledger_insert");
    await this.insertSaleNotice(client, {
      sellerPlayerId: sell.player_id,
      eventId: tradeId,
      venueId: incoming.venue_id,
      itemName: premiumCurrency
        ? PREMIUM_CURRENCY_NAMES[premiumCurrency]
        : requireRuntimeItemDefinition(incoming.item_id).displayName,
      quantity,
      proceeds: sellerProceeds,
      priceCurrency: priceAsset === "glimmer" ? "glimmer" : "gold"
    });
    await client.query(
      `INSERT INTO market_audit_events (
         severity, event_type, venue_id, book_id, player_id, order_id, trade_id, request_id, evidence
       ) VALUES ('info','trade_settled',$1,$2,$3,$4,$5,$6,$7::jsonb)`,
      [incoming.venue_id, incoming.book_id, incoming.player_id, incoming.order_id, tradeId, incoming.client_request_id, JSON.stringify({ quantity: quantity.toString(), unitPrice: unitPrice.toString() })]
    );
    const row = insertedTrade.rows[0];
    if (!row) throw new Error("Trade insert returned no row");
    return {
      tradeId: row.trade_id,
      quantity: row.quantity,
      unitPrice: row.unit_price,
      total: row.gross_value,
      buyerTax: row.buyer_fee,
      sellerProceeds: row.seller_proceeds,
      buyerTaxBps: Number(row.applied_buyer_tax_bps),
      specialtyTaxApplied: row.specialty_tax_applied,
      qualifyingTaxTag: row.qualifying_tax_tag,
      createdAt: iso(row.created_at)
    };
  }

  private async applyFillToOrder(client: Queryable, order: OrderRow, quantity: bigint): Promise<void> {
    const remaining = BigInt(order.remaining_quantity) - quantity;
    const filled = BigInt(order.filled_quantity) + quantity;
    if (remaining < 0n) throw new MarketError("MARKET_INVARIANT_FAILURE", "Order overfill prevented");
    const status = remaining === 0n ? "filled" : "partially_filled";
    const updated = await client.query(
      `UPDATE market_orders
       SET remaining_quantity = $2, filled_quantity = $3, status = $4,
           completed_at = CASE WHEN $4 = 'filled' THEN now() ELSE NULL END
       WHERE order_id = $1 AND status IN ('open', 'partially_filled')
         AND remaining_quantity >= $5`,
      [order.order_id, remaining.toString(), filled.toString(), status, quantity.toString()]
    );
    if (updated.rowCount !== 1) throw new MarketError("MARKET_INVARIANT_FAILURE", "Concurrent order state changed during fill");
    order.remaining_quantity = remaining.toString();
    order.filled_quantity = filled.toString();
    order.status = status;
  }

  private async lockMutationControls(
    client: pg.PoolClient,
    actor: MarketActor,
    venueId: string,
    action: "order" | "cancel" | "claim"
  ): Promise<{ rulesVersion: number; matchingEnabled: boolean }> {
    await lockInventoryCapacity(client, actor.playerId);
    const globalResult = await client.query<{
      read_only: boolean;
      new_orders_enabled: boolean;
      matching_enabled: boolean;
      cancellations_enabled: boolean;
      claims_enabled: boolean;
      rules_version: number;
    }>(
      `SELECT read_only, new_orders_enabled, matching_enabled, cancellations_enabled,
              claims_enabled, rules_version
       FROM market_global_controls WHERE singleton FOR SHARE`
    );
    const global = globalResult.rows[0];
    if (!global) throw new Error("Market global controls do not exist");
    await client.query(
      `INSERT INTO market_player_controls (account_id, player_id)
       VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [actor.accountId, actor.playerId]
    );
    const playerResult = await client.query<{ player_id: string; mutations_frozen: boolean }>(
      `SELECT player_id, mutations_frozen FROM market_player_controls
       WHERE account_id = $1 FOR UPDATE`,
      [actor.accountId]
    );
    const player = playerResult.rows[0];
    if (!player || player.player_id !== actor.playerId) throw new MarketError("MARKET_ACCESS_DENIED", "Market account ownership is invalid");
    const venueResult = await client.query<{
      frozen: boolean;
      new_orders_enabled: boolean;
      matching_enabled: boolean;
      cancellations_enabled: boolean;
      claims_enabled: boolean;
    }>(
      `SELECT frozen, new_orders_enabled, matching_enabled,
              cancellations_enabled, claims_enabled
       FROM market_venue_controls
       WHERE venue_id = $1 FOR SHARE`,
      [venueId]
    );
    const venue = venueResult.rows[0];
    if (global.read_only) throw new MarketError("MARKET_READ_ONLY", "Market is in emergency read-only mode");
    if (player.mutations_frozen) throw new MarketError("MARKET_PLAYER_FROZEN", "This account's market mutations are frozen");
    if (!venue || venue.frozen) throw new MarketError("MARKET_VENUE_FROZEN", "This market venue is frozen");
    if (
      action === "order" &&
      (!global.new_orders_enabled || !venue.new_orders_enabled)
    ) {
      throw new MarketError("MARKET_NEW_ORDERS_DISABLED", "New market orders are disabled");
    }
    if (
      action === "cancel" &&
      (!global.cancellations_enabled || !venue.cancellations_enabled)
    ) {
      throw new MarketError("MARKET_CANCELLATIONS_DISABLED", "Market cancellations are disabled");
    }
    if (
      action === "claim" &&
      (!global.claims_enabled || !venue.claims_enabled)
    ) {
      throw new MarketError("MARKET_CLAIMS_DISABLED", "Market claims are disabled");
    }
    return {
      rulesVersion: Number(global.rules_version),
      matchingEnabled: global.matching_enabled && venue.matching_enabled
    };
  }

  private async enforceOrderLimits(
    client: Queryable,
    actor: MarketActor,
    bookId: string,
    incomingOrderId: string
  ): Promise<void> {
    const counts = await client.query<{
      active_count: string;
      item_count: string;
      account_book_count: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM market_orders
          WHERE account_id = $1 AND order_id <> $3
            AND status IN ('open','partially_filled')) AS active_count,
         (SELECT count(*)::text FROM market_orders
          WHERE book_id = $2 AND order_id <> $3
            AND status IN ('open','partially_filled')) AS item_count,
         (SELECT count(*)::text FROM market_orders
          WHERE account_id = $1 AND book_id = $2 AND order_id <> $3
            AND status IN ('open','partially_filled')) AS account_book_count`,
      [actor.accountId, bookId, incomingOrderId]
    );
    const row = counts.rows[0];
    if (BigInt(row?.active_count ?? "0") >= this.limits.maxActiveOrdersPerPlayer) {
      throw new MarketError("MARKET_ACTIVE_ORDER_LIMIT", "Active market order limit reached");
    }
    if (BigInt(row?.item_count ?? "0") >= this.limits.maxOpenOrdersPerItem) {
      throw new MarketError("MARKET_ITEM_ORDER_LIMIT", "Open-order limit for this item reached");
    }
    if (
      BigInt(row?.account_book_count ?? "0") >=
      this.limits.maxRestingOrdersPerAccountBook
    ) {
      throw new MarketError(
        "MARKET_ITEM_ORDER_LIMIT",
        "Per-account resting-order limit for this item reached"
      );
    }
  }

  private async wouldCross(
    client: Queryable,
    bookId: string,
    side: MarketOrderSide,
    unitPrice: bigint,
    accountId: string
  ): Promise<boolean> {
    const result = await client.query(
      `SELECT 1
       FROM market_orders
       WHERE book_id = $1
         AND side = $2
         AND status IN ('open', 'partially_filled')
         AND account_id <> $4
         AND CASE WHEN $2 = 'sell'
           THEN limit_unit_price <= $3
           ELSE limit_unit_price >= $3
         END
       LIMIT 1`,
      [bookId, side === "buy" ? "sell" : "buy", unitPrice.toString(), accountId]
    );
    return result.rowCount === 1;
  }

  private async reserveRate(client: Queryable, playerId: string, bucket: string, maximum: number): Promise<void> {
    await reserveMarketRate(client, playerId, bucket, maximum);
  }

  private async requireTradableIdentity(client: Queryable, identity: string): Promise<ItemRow> {
    // One exact Glimmer Shop copy (1202): its own book, quantity 1, ownership = the inventory row.
    const copy = parseShopCopyMarketIdentity(identity);
    if (copy) {
      const result = await client.query<ItemRow>(
        `SELECT d.item_id, COALESCE(c.display_name, d.display_name) AS display_name, d.category, d.stackable,
                d.market_tradable, d.market_fungible, $1::text AS market_identity, c.copy_id AS variant
         FROM shop_item_copies c JOIN item_definitions d ON d.item_id = c.item_id
         WHERE c.copy_id = $2 AND c.item_id = $3`,
        [identity, copy.copyId, copy.itemId]
      );
      const row = result.rows[0];
      if (!row) throw new MarketError("MARKET_UNKNOWN_ITEM", "That item copy does not exist");
      if (!row.market_tradable) throw new MarketError("MARKET_ITEM_NOT_TRADABLE", "Item is not authoritatively tradable");
      return row;
    }
    const rodId = parseFishingRodMarketIdentity(identity);
    if (rodId) {
      const definition = await client.query<ItemRow>(
        `SELECT d.item_id, d.display_name, d.category, d.stackable,
                d.market_tradable, d.market_fungible, d.market_identity,
                $1::text AS variant
         FROM item_definitions d
         WHERE d.item_id = 'fishing_rod'`,
        [rodId]
      );
      const row = definition.rows[0];
      if (!row || !row.market_tradable) {
        throw new MarketError("MARKET_ITEM_NOT_TRADABLE", "Fishing Rods are not authoritatively tradable");
      }
      const instance = await client.query(
        `SELECT 1 FROM fishing_rods WHERE rod_id = $1::uuid`,
        [rodId]
      );
      if (instance.rowCount !== 1) {
        throw new MarketError("MARKET_UNKNOWN_ITEM", "That Fishing Rod instance does not exist");
      }
      return {
        ...row,
        variant: rodId,
        market_identity: fishingRodMarketIdentity(rodId)
      };
    }
    const result = await client.query<ItemRow>(
      `SELECT d.item_id,
              CASE WHEN variant = 'default' THEN d.display_name
                   ELSE initcap(replace(variant, '_', ' ')) || ' ' || d.display_name END AS display_name,
              d.category, d.stackable, d.market_tradable, d.market_fungible,
              CASE WHEN variant = 'default' THEN d.market_identity
                   ELSE d.market_identity || ':' || variant END AS market_identity,
              variant
       FROM item_definitions d
       CROSS JOIN LATERAL unnest(d.supported_variants) AS variant
       WHERE CASE WHEN variant = 'default' THEN d.market_identity
                  ELSE d.market_identity || ':' || variant END = $1`,
      [identity]
    );
    const row = result.rows[0];
    if (!row) {
      const definition = await client.query(
        `SELECT 1
         FROM item_definitions d
         WHERE d.item_id = $1
            OR d.market_identity = $1
            OR starts_with($1, d.market_identity || ':')
         LIMIT 1`,
        [identity]
      );
      if (definition.rowCount === 0) {
        throw new MarketError("MARKET_UNKNOWN_ITEM", "Unknown market item");
      }
      throw new MarketError("MARKET_ITEM_NOT_TRADABLE", "Item is not authoritatively tradable and fungible");
    }
    if (!row.market_tradable || !row.market_fungible) {
      throw new MarketError("MARKET_ITEM_NOT_TRADABLE", "Item is not authoritatively tradable and fungible");
    }
    return row;
  }

  private async transferFishingRodOwnershipOnTrade(
    client: Queryable,
    item: Pick<ItemRow, "item_id" | "variant" | "market_identity">,
    sellerPlayerId: string,
    buyerPlayerId: string,
    quantity: bigint
  ): Promise<void> {
    if (item.item_id !== "fishing_rod") return;
    if (item.market_identity === null) {
      throw new MarketError(
        "MARKET_INVARIANT_FAILURE",
        "Fishing Rod trade is missing its durable market identity"
      );
    }
    const rodId = parseFishingRodMarketIdentity(item.market_identity);
    if (quantity !== 1n || !rodId || item.variant !== rodId) {
      throw new MarketError(
        "MARKET_INVARIANT_FAILURE",
        "Fishing Rod trades must transfer one exact durable rod instance"
      );
    }
    const locked = await client.query(
      `SELECT rod_id FROM fishing_rods
       WHERE rod_id = $1::uuid AND player_id = $2
       FOR UPDATE`,
      [rodId, sellerPlayerId]
    );
    if (locked.rowCount !== 1) {
      throw new MarketError(
        "MARKET_INVARIANT_FAILURE",
        "Fishing Rod escrow no longer belongs to the selling player"
      );
    }
    const moved = await client.query(
      `UPDATE fishing_rods
       SET player_id = $2, updated_at = clock_timestamp()
       WHERE rod_id = $1::uuid AND player_id = $3`,
      [rodId, buyerPlayerId, sellerPlayerId]
    );
    if (moved.rowCount !== 1) {
      throw new MarketError(
        "MARKET_INVARIANT_FAILURE",
        "Fishing Rod ownership could not be transferred"
      );
    }
  }

  private requireEquipmentService(): EquipmentService {
    if (!this.equipment) {
      throw new MarketError(
        "MARKET_INVARIANT_FAILURE",
        "Equipment Market authority is unavailable",
        true
      );
    }
    return this.equipment;
  }

  private async lockMarketEquipment(
    client: Queryable,
    equipmentInstanceId: string
  ): Promise<MarketEquipmentRow> {
    const result = await client.query<MarketEquipmentRow>(
      `SELECT instance_id::text, definition_id, owner_player_id, location,
              inventory_slot_index, item_level, condition, balance_version,
              enchantment_identity, ring_bonuses, ring_rough,
              inscription_name, inscribed_by_name, inscribed_at, inscription_stats
       FROM equipment_instances
       WHERE instance_id = $1
       FOR UPDATE`,
      [equipmentInstanceId]
    );
    const row = result.rows[0];
    if (!row) {
      throw new MarketError(
        "MARKET_EQUIPMENT_NOT_FOUND",
        "Equipment instance does not exist"
      );
    }
    return row;
  }

  private async lockEquipmentListing(
    client: Queryable,
    listingId: string
  ): Promise<EquipmentListingRow> {
    const result = await client.query<EquipmentListingRow>(
      `SELECT listing_id::text, venue_id::text,
              equipment_instance_id::text, seller_player_id,
              buyer_player_id, asking_price::text, status, version::text,
              presentation_snapshot, created_at, price_currency
       FROM market_equipment_listings
       WHERE listing_id = $1
       FOR UPDATE`,
      [listingId]
    );
    const row = result.rows[0];
    if (!row) {
      throw new MarketError(
        "MARKET_EQUIPMENT_LISTING_NOT_FOUND",
        "Equipment listing does not exist"
      );
    }
    return row;
  }

  private async equipmentListingSnapshot(
    client: Queryable,
    row: EquipmentListingRow,
    venueId: string
  ): Promise<MarketEquipmentListingSnapshot> {
    const tax = await this.districtBenefits.resolveMarketTax(
      client,
      venueId,
      ["equipment"]
    );
    const askingPrice = BigInt(row.asking_price);
    const buyerTax = calculateFee(askingPrice, tax.buyerTaxBps);
    return {
      listingId: row.listing_id,
      venueId: row.venue_id,
      ...row.presentation_snapshot,
      sellerPlayerId: row.seller_player_id,
      askingPrice: askingPrice.toString(),
      buyerTax: buyerTax.toString(),
      buyerTotal: (askingPrice + buyerTax).toString(),
      buyerTaxBps: tax.buyerTaxBps,
      status: row.status,
      version: row.version,
      createdAt: iso(row.created_at),
      ...(row.price_currency === "glimmer" ? { priceCurrency: "glimmer" as const } : {})
    };
  }

  private async writeEquipmentLedger(
    client: Queryable,
    input: Readonly<{
      operationKey: string;
      venueId: string;
      listingId: string;
      equipmentInstanceId: string;
      actorPlayerId: string;
      entryType:
        | "listed"
        | "purchased"
        | "cancelled"
        | "collected"
        | "seller_proceeds"
        | "buyer_debit"
        | "tax_burn";
      goldDelta?: bigint;
      glimmerDelta?: bigint;
      metadata: Readonly<Record<string, unknown>>;
    }>
  ): Promise<void> {
    await client.query(
      `INSERT INTO market_equipment_ledger (
         operation_key, venue_id, listing_id, equipment_instance_id,
         actor_player_id, entry_type, gold_delta, metadata, glimmer_delta
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`,
      [
        input.operationKey,
        input.venueId,
        input.listingId,
        input.equipmentInstanceId,
        input.actorPlayerId,
        input.entryType,
        input.goldDelta?.toString() ?? null,
        JSON.stringify(input.metadata),
        input.glimmerDelta?.toString() ?? null
      ]
    );
  }

  private async itemTaxTags(
    client: Queryable,
    itemId: string
  ): Promise<Array<"mining" | "forestry" | "hunting" | "equipment" | "cosmetic">> {
    const result = await client.query<{
      tax_tag: "mining" | "forestry" | "hunting" | "equipment" | "cosmetic";
    }>(
      `SELECT tax_tag
       FROM item_market_tax_tags
       WHERE item_id = $1
       ORDER BY tax_tag`,
      [itemId]
    );
    return result.rows.map((row) => row.tax_tag);
  }

  // Seller-facing Messages notice, written in the settlement transaction and
  // keyed by trade/listing id so a replay hits the unique game-notice index.
  private async insertSaleNotice(
    client: Queryable,
    input: {
      sellerPlayerId: string;
      eventId: string;
      venueId: string;
      itemName: string;
      quantity: bigint;
      proceeds: bigint;
      priceCurrency: MarketPriceCurrency;
    }
  ): Promise<void> {
    const venue = await client.query<{ market_name: string }>(
      `SELECT COALESCE(city.name || ' Market', venue.display_name) AS market_name
       FROM market_venues venue
       LEFT JOIN cities city ON city.id = venue.city_id
       WHERE venue.venue_id = $1`,
      [input.venueId]
    );
    const marketName = venue.rows[0]?.market_name ?? "the City Market";
    const what = input.quantity === 1n
      ? input.itemName
      : `${input.quantity.toLocaleString("en-US")} ${input.itemName}`;
    const message =
      input.priceCurrency === "glimmer"
        ? `Sold ${what} for ${input.proceeds.toLocaleString("en-US")} Glimmer at ${marketName}. It's in your Glimmer balance.`
        : `Sold ${what} for ${input.proceeds.toLocaleString("en-US")} gold at ${marketName}. Collect it at the Market.`;
    await client.query(
      `INSERT INTO player_inbox_entries (
         id,player_id,entry_kind,message,created_at,status,event_kind,event_id
       ) VALUES (gen_random_uuid(),$1,'game_notice',$2,clock_timestamp(),'notice',$3,$4)
       ON CONFLICT (player_id,event_kind,event_id)
         WHERE entry_kind='game_notice' DO NOTHING`,
      [input.sellerPlayerId, message, MARKET_SALE_INBOX_EVENT_KIND, input.eventId]
    );
  }

  private async venue(client: Queryable, venueId: string): Promise<VenueRow> {
    const full = await this.read.requireVenue(client, venueId);
    return { venue_id: full.venue_id, fee_policy_id: full.fee_policy_id };
  }

  /**
   * City market tax as the BUYER pays it. Merchant (active specialization only) cuts the tax by a percent of the
   * tax. Read server-side from the buyer's own player id; the quote stores the reduced bps and settle recomputes it,
   * so a client-sent class can never change what is charged.
   */
  private async resolveBuyerMarketTax(
    client: Queryable,
    venueId: string,
    itemTaxTags: readonly MarketTaxTag[],
    buyerPlayerId: string
  ): Promise<{ tax: Awaited<ReturnType<CityDistrictBenefitService["resolveMarketTax"]>>; merchantRank: number }> {
    const tax = await this.districtBenefits.resolveMarketTax(client, venueId, itemTaxTags);
    const merchantRank = await activeSpecializationRank(client, buyerPlayerId, "merchant");
    return {
      tax: merchantRank >= 2
        ? { ...tax, buyerTaxBps: merchantReducedBuyerTaxBps(tax.buyerTaxBps, merchantRank) }
        : tax,
      merchantRank
    };
  }

  private async feePolicyForBuyerBps(client: Queryable, buyerFeeBps: number): Promise<FeeRow> {
    const result = await client.query<FeeRow>(
      `SELECT fee_policy_id, version, listing_fee::text, buyer_fee_bps,
              seller_fee_bps, cancellation_fee::text
       FROM market_fee_policies
       WHERE buyer_fee_bps = $1 AND seller_fee_bps = 0 AND fee_policy_id BETWEEN 41 AND 46 AND active
       FOR SHARE`,
      [buyerFeeBps]
    );
    const row = result.rows[0];
    if (!row) throw new Error("Active Merchant market fee policy does not exist");
    return requireSupportedFeePolicy(row);
  }

  private async feePolicy(client: Queryable, feePolicyId: number): Promise<FeeRow> {
    const result = await client.query<FeeRow>(
      `SELECT fee_policy_id, version, listing_fee::text, buyer_fee_bps,
              seller_fee_bps, cancellation_fee::text
       FROM market_fee_policies WHERE fee_policy_id = $1 AND active FOR SHARE`,
      [feePolicyId]
    );
    const row = result.rows[0];
    if (!row) throw new Error("Active market fee policy does not exist");
    return requireSupportedFeePolicy(row);
  }

  private async feePolicySnapshot(
    client: Queryable,
    feePolicyId: number,
    version: number,
    cache?: Map<string, FeeRow>
  ): Promise<FeeRow> {
    const cacheKey = `${feePolicyId}:${version}`;
    const cached = cache?.get(cacheKey);
    if (cached) return cached;
    const result = await client.query<FeeRow>(
      `SELECT fee_policy_id, version, listing_fee::text, buyer_fee_bps,
              seller_fee_bps, cancellation_fee::text
       FROM market_fee_policies
       WHERE fee_policy_id = $1 AND version = $2`,
      [feePolicyId, version]
    );
    const row = result.rows[0];
    if (!row) throw new MarketError("MARKET_INVARIANT_FAILURE", "Order fee policy snapshot does not exist");
    const supported = requireSupportedFeePolicy(row);
    cache?.set(cacheKey, supported);
    return supported;
  }

  private async ensureAndLockBook(
    client: pg.PoolClient,
    venueId: string,
    item: ItemRow,
    lock: "FOR UPDATE" | "FOR SHARE",
    priceCurrency: MarketPriceCurrency = "gold"
  ): Promise<BookRow> {
    if (priceCurrency === "glimmer" && premiumCurrencyForMarketItem(item.item_id) === "glimmer") {
      throw new MarketError("MARKET_ITEM_NOT_TRADABLE", "Glimmer is priced in Gold only");
    }
    await client.query(
      `INSERT INTO market_order_books (book_id, venue_id, item_identity, item_id, variant, price_currency)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (venue_id, item_identity, price_currency) DO NOTHING`,
      [crypto.randomUUID(), venueId, item.market_identity, item.item_id, item.variant, priceCurrency]
    );
    const result = await client.query<BookRow>(
      `SELECT book_id, venue_id, item_identity, item_id, variant, book_version::text, frozen, price_currency
       FROM market_order_books
       WHERE venue_id = $1 AND item_identity = $2 AND price_currency = $3 ${lock}`,
      [venueId, item.market_identity, priceCurrency]
    );
    const row = result.rows[0];
    if (!row) throw new Error("Market order book does not exist");
    return row;
  }

  private async lockBookById(client: Queryable, bookId: string): Promise<BookRow> {
    const result = await client.query<BookRow>(
      `SELECT book_id, venue_id, item_identity, item_id, variant, book_version::text, frozen, price_currency,
              sensitive_reason
       FROM market_order_books WHERE book_id = $1 FOR UPDATE`,
      [bookId]
    );
    const row = result.rows[0];
    if (!row) throw new MarketError("MARKET_QUOTE_STALE", "Market order book no longer exists");
    return row;
  }

  private async bumpBook(client: Queryable, bookId: string): Promise<string> {
    const result = await client.query<{ book_version: string }>(
      `UPDATE market_order_books
       SET book_version = book_version + 1, updated_at = now()
       WHERE book_id = $1 RETURNING book_version::text`,
      [bookId]
    );
    const version = result.rows[0]?.book_version;
    if (!version) throw new Error("Market order book version update failed");
    return version;
  }

  private async priceAvailableSellLiquidity(
    client: Queryable,
    bookId: string,
    accountId: string,
    requested: bigint,
    fee: FeeRow,
    requestedMaximumUnitPrice: bigint = this.limits.maxUnitPrice
  ): Promise<{
    fillable: bigint;
    gross: bigint;
    total: bigint;
    maximumUnitPrice: bigint | null;
  }> {
    let fillable = 0n;
    let grossTotal = 0n;
    let total = 0n;
    let maximumUnitPrice: bigint | null = null;
    let cursorPrice: string | null = null;
    let cursorPriority: string | null = null;
    while (fillable < requested) {
      const result: pg.QueryResult<SellLiquidityRow> = await client.query<SellLiquidityRow>(
        `SELECT remaining_quantity::text, limit_unit_price::text, priority_sequence::text
         FROM market_orders
         WHERE book_id = $1 AND side = 'sell' AND status IN ('open','partially_filled')
           AND account_id <> $2
           AND limit_unit_price <= $3::bigint
           AND (
             $4::bigint IS NULL
             OR limit_unit_price > $4::bigint
             OR (limit_unit_price = $4::bigint AND priority_sequence > $5::bigint)
           )
         ORDER BY market_orders.limit_unit_price ASC, market_orders.priority_sequence ASC
         LIMIT $6 FOR SHARE`,
        [
          bookId,
          accountId,
          requestedMaximumUnitPrice.toString(),
          cursorPrice,
          cursorPriority,
          this.matchingBatchSize
        ]
      );
      if (result.rows.length === 0) break;
      let valueLimitReached = false;
      for (const row of result.rows) {
        if (fillable >= requested) break;
        const quantity = minBigInt(BigInt(row.remaining_quantity), requested - fillable);
        const unitPrice = BigInt(row.limit_unit_price);
        const gross = checkedOrderValue(unitPrice, quantity, this.limits.maxTotalOrderValue);
        const nextTotal = total + gross + calculateFee(gross, fee.buyer_fee_bps);
        if (nextTotal > this.limits.maxTotalOrderValue) {
          valueLimitReached = true;
          break;
        }
        total = nextTotal;
        grossTotal += gross;
        fillable += quantity;
        maximumUnitPrice = unitPrice;
      }
      if (valueLimitReached || fillable >= requested) break;
      const last: SellLiquidityRow = result.rows.at(-1)!;
      cursorPrice = last.limit_unit_price;
      cursorPriority = last.priority_sequence;
    }
    return { fillable, gross: grossTotal, total, maximumUnitPrice };
  }

  private async debitWallet(
    client: Queryable,
    actor: MarketActor,
    amount: bigint,
    operationKey: string,
    orderId: string
  ): Promise<void> {
    try {
      await this.wallet.debitForOperationInTransaction(client, {
        playerId: actor.playerId,
        accountId: actor.accountId,
        amount,
        operationKey,
        reason: "market_buy_escrow",
        marketOrderId: orderId
      });
    } catch (error) {
      throw mapWalletOperationError(error);
    }
  }

  private async creditWallet(
    client: Queryable,
    actor: MarketActor,
    amount: bigint,
    operationKey: string,
    reason: string,
    provenance: Readonly<{
      marketOrderId?: string;
      marketTradeId?: string;
      metadata?: Readonly<Record<string, unknown>>;
    }> = {}
  ): Promise<void> {
    try {
      await this.wallet.creditForOperationInTransaction(client, {
        playerId: actor.playerId,
        accountId: actor.accountId,
        amount,
        operationKey,
        reason,
        ...provenance
      });
    } catch (error) {
      throw mapWalletOperationError(error);
    }
  }

  async expireDueOrders(limit = 100): Promise<Readonly<{
    materialOrders: number;
    equipmentListings: number;
  }>> {
    const dueOrders = await this.pool.query<{ order_id: string }>(
      `SELECT order_id::text
       FROM market_orders
       WHERE status IN ('open', 'partially_filled')
         AND expires_at <= clock_timestamp()
       ORDER BY expires_at, order_id
       LIMIT $1`,
      [limit]
    );
    let materialOrders = 0;
    for (const candidate of dueOrders.rows) {
      const client = await this.pool.connect();
      let venueId: string | null = null;
      let bookId: string | null = null;
      let playerId: string | null = null;
      let expiredPremium = false;
      try {
        await client.query("BEGIN");
        await acquireMarketMutationSafetyLock(client);
        const locked = await client.query<OrderRow & { remaining_escrow: string; escrow_asset_kind: EscrowRow["asset_kind"] }>(
          `SELECT orders.*, escrow.remaining_amount::text AS remaining_escrow,
                  escrow.asset_kind AS escrow_asset_kind
           FROM market_orders orders
           JOIN market_order_escrows escrow USING (order_id)
           WHERE orders.order_id = $1
             AND orders.status IN ('open', 'partially_filled')
             AND orders.expires_at <= clock_timestamp()
           FOR UPDATE OF orders, escrow`,
          [candidate.order_id]
        );
        const order = locked.rows[0];
        if (!order) {
          await client.query("ROLLBACK");
          continue;
        }
        const amount = BigInt(order.remaining_escrow);
        const reason = order.side === "sell"
          ? "sell_expired_return"
          : "buy_expired_refund";
        const premiumCurrency = order.escrow_asset_kind === "glimmer"
          ? "glimmer"
          : order.side === "sell"
            ? premiumCurrencyForMarketItem(order.item_id)
            : null;
        const returnedAsset = order.escrow_asset_kind;
        const returnedIdentity = returnedAsset === "item" ? order.item_identity : null;
        if (amount > 0n && premiumCurrency) {
          // Premium escrow has no capacity limit, so it returns straight to the wallet.
          await this.creditPremiumWallet(client, {
            accountId: order.account_id,
            playerId: order.player_id,
            currency: premiumCurrency,
            amount,
            operationKey: `market-cancel-premium:${order.order_id}`,
            refType: "market_order",
            refId: order.order_id
          });
          await client.query(
            `UPDATE market_order_escrows
             SET remaining_amount = 0, updated_at = clock_timestamp()
             WHERE order_id = $1`,
            [order.order_id]
          );
          await this.writeLedger(client, {
            groupType: "cancel",
            requestId: `expire:${order.order_id}`,
            claimId: null,
            orderId: order.order_id,
            tradeId: null,
            orderFeePolicy: { id: order.fee_policy_id, version: order.fee_policy_version },
            entries: [
              { assetKind: returnedAsset, itemIdentity: returnedIdentity, amount: -amount, accountLocation: order.side === "sell" ? "sell_escrow" : "buy_escrow", playerId: order.player_id, orderId: order.order_id, reason: "order_expired_debit" },
              { assetKind: returnedAsset, itemIdentity: returnedIdentity, amount, accountLocation: "premium_wallet", playerId: order.player_id, orderId: order.order_id, reason: "order_expired_return" }
            ]
          });
        } else if (amount > 0n) {
          const insertedCollection = await client.query<{ collection_id: string }>(
            `INSERT INTO market_collections (
               venue_id, player_id, asset_kind, item_identity, item_id, variant,
               original_amount, remaining_amount, reason, source_order_id
             ) VALUES (
               $1,$2,$3,$4,$5,$6,$7,$7,$8,$9
             ) ON CONFLICT (source_order_id, reason)
               WHERE reason IN ('sell_expired_return', 'buy_expired_refund')
               DO UPDATE SET source_order_id = excluded.source_order_id
             RETURNING collection_id::text`,
            [
              order.venue_id,
              order.player_id,
              order.side === "sell" ? "item" : "gold",
              order.side === "sell" ? order.item_identity : null,
              order.side === "sell" ? order.item_id : null,
              order.side === "sell" ? order.variant : null,
              amount.toString(),
              reason,
              order.order_id
            ]
          );
          const collectionId = insertedCollection.rows[0]?.collection_id;
          if (!collectionId) {
            throw new MarketError(
              "MARKET_INVARIANT_FAILURE",
              `Expiration recovery collection was not created for order ${order.order_id}`
            );
          }
          await client.query(
            `UPDATE market_order_escrows
             SET remaining_amount = 0, updated_at = clock_timestamp()
             WHERE order_id = $1`,
            [order.order_id]
          );
          await this.writeLedger(client, {
            groupType: "cancel",
            requestId: `expire:${order.order_id}`,
            claimId: null,
            orderId: order.order_id,
            tradeId: null,
            orderFeePolicy: {
              id: order.fee_policy_id,
              version: order.fee_policy_version
            },
            entries: [
              {
                assetKind: order.side === "sell" ? "item" : "gold",
                itemIdentity: order.side === "sell" ? order.item_identity : null,
                amount: -amount,
                accountLocation: order.side === "sell" ? "sell_escrow" : "buy_escrow",
                playerId: order.player_id,
                orderId: order.order_id,
                reason: "order_expired_debit"
              },
              {
                assetKind: order.side === "sell" ? "item" : "gold",
                itemIdentity: order.side === "sell" ? order.item_identity : null,
                amount,
                accountLocation: "return_collection",
                  playerId: order.player_id,
                  orderId: order.order_id,
                  collectionId,
                  reason: "order_expired_return"
                }
            ]
          });
        }
        await client.query(
          `UPDATE market_orders
           SET status = 'expired', expired_at = clock_timestamp()
           WHERE order_id = $1`,
          [order.order_id]
        );
        await this.bumpBook(client, order.book_id);
        await client.query("COMMIT");
        materialOrders += 1;
        expiredPremium = premiumCurrency !== null;
        venueId = order.venue_id;
        bookId = order.book_id;
        playerId = order.player_id;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw this.mapAndReportError(error, "expire_order");
      } finally {
        client.release();
      }
      if (venueId && bookId && playerId) {
        this.onCommitted({
          itemIdentity: null,
          venueId,
          playerIds: [playerId],
          premiumCurrencyChanged: expiredPremium
        });
      }
    }

    const equipment = await this.pool.query<{ listing_id: string; venue_id: string; seller_player_id: string }>(
      `WITH due AS (
         SELECT listing_id
         FROM market_equipment_listings
         WHERE status = 'open' AND expires_at <= clock_timestamp()
         ORDER BY expires_at, listing_id
         FOR UPDATE SKIP LOCKED
         LIMIT $1
       ), expired AS (
         UPDATE market_equipment_listings listing
         SET status = 'expired', expired_at = clock_timestamp(), version = version + 1
         FROM due
         WHERE listing.listing_id = due.listing_id
         RETURNING listing.listing_id, listing.venue_id,
                   listing.equipment_instance_id, listing.seller_player_id
       ), collections AS (
         INSERT INTO market_equipment_collections (
           collection_id, venue_id, listing_id, equipment_instance_id,
           player_id, reason
         )
         SELECT gen_random_uuid(), venue_id, listing_id, equipment_instance_id,
                seller_player_id, 'expired_return'
         FROM expired
         ON CONFLICT DO NOTHING
         RETURNING listing_id, collection_id
       )
       UPDATE equipment_instances instance
       SET location = 'market_collection',
           market_collection_id = collections.collection_id
       FROM collections
       WHERE instance.market_listing_id = collections.listing_id
       RETURNING collections.listing_id::text, instance.owner_player_id AS seller_player_id,
                 (SELECT venue_id::text FROM expired
                  WHERE expired.listing_id = collections.listing_id) AS venue_id`,
      [limit]
    );
    for (const listing of equipment.rows) {
      this.onCommitted({
        itemIdentity: null,
        venueId: listing.venue_id,
        playerIds: [listing.seller_player_id]
      });
    }
    return { materialOrders, equipmentListings: equipment.rowCount ?? 0 };
  }

  async repairLegacyCollections(limit = 500): Promise<Readonly<{
    material: number;
    equipment: number;
    equipmentGold: number;
  }>> {
    const materialRows = await this.pool.query<{
      collection_id: string;
      player_id: string;
      asset_kind: "item" | "gold";
      item_id: string | null;
      variant: string | null;
      remaining_amount: string;
      reason: string;
    }>(
      `SELECT collection_id::text, player_id, asset_kind, item_id, variant,
              remaining_amount::text, reason
       FROM market_collections
       WHERE remaining_amount > 0
         AND reason NOT IN ('sell_expired_return', 'buy_expired_refund')
       ORDER BY collection_id
       LIMIT $1`,
      [limit]
    );
    let material = 0;
    for (const row of materialRows.rows) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const locked = await client.query<typeof row>(
          `SELECT collection_id::text, player_id, asset_kind, item_id, variant,
                  remaining_amount::text, reason
           FROM market_collections
           WHERE collection_id = $1 AND remaining_amount > 0
             AND reason NOT IN ('sell_expired_return', 'buy_expired_refund')
           FOR UPDATE`,
          [row.collection_id]
        );
        const current = locked.rows[0];
        if (!current) {
          await client.query("ROLLBACK");
          continue;
        }
        const operationKey = `market-collection-repair:${current.collection_id}`;
        const amount = BigInt(current.remaining_amount);
        if (current.asset_kind === "item" && current.item_id) {
          try {
            await this.inventory.grantItemsForOperationInTransaction(client, {
              operationKey,
              playerId: current.player_id,
              source: "market_collection_repair",
              sourceEntityType: "market_collection",
              sourceEntityId: current.collection_id,
              metadata: { reason: current.reason },
              grants: [{
                itemId: current.item_id as never,
                variant:
                  current.variant === MARKET_DEFAULT_VARIANT
                    ? null
                    : current.variant,
                quantity: amount
              }]
            });
          } catch (error) {
            throw new Error(
              `Market collection repair cannot deliver collection ${current.collection_id} ` +
              `to player ${current.player_id}: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        } else if (current.asset_kind === "gold") {
          await this.creditWallet(
            client,
            {
              playerId: current.player_id,
              accountId: await this.accountIdForPlayer(client, current.player_id)
            },
            amount,
            operationKey,
            "market_collection_repair",
            { metadata: { collectionId: current.collection_id, reason: current.reason } }
          );
        }
        await client.query(
          `UPDATE market_collections
           SET remaining_amount = 0, claimed_at = clock_timestamp(),
               updated_at = clock_timestamp()
           WHERE collection_id = $1`,
          [current.collection_id]
        );
        await client.query(
          `INSERT INTO market_collection_repairs (
             collection_kind, collection_identity, player_id, operation_key
           ) VALUES ('material',$1,$2,$3)
           ON CONFLICT DO NOTHING`,
          [current.collection_id, current.player_id, operationKey]
        );
        await client.query("COMMIT");
        material += 1;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    }

    const equipmentRows = await this.pool.query<{
      collection_id: string;
      equipment_instance_id: string;
      player_id: string;
    }>(
      `SELECT collection_id::text, equipment_instance_id::text, player_id
       FROM market_equipment_collections
       WHERE claimed_at IS NULL AND reason <> 'expired_return'
       ORDER BY created_at, collection_id
       LIMIT $1`,
      [limit]
    );
    let equipment = 0;
    for (const row of equipmentRows.rows) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const locked = await client.query<typeof row>(
          `SELECT collection_id::text, equipment_instance_id::text, player_id
           FROM market_equipment_collections
           WHERE collection_id = $1 AND claimed_at IS NULL
             AND reason <> 'expired_return'
           FOR UPDATE`,
          [row.collection_id]
        );
        const current = locked.rows[0];
        if (!current) {
          await client.query("ROLLBACK");
          continue;
        }
        await client.query(
          `SELECT inventory_revision FROM player_equipment_state
           WHERE player_id = $1 FOR UPDATE`,
          [current.player_id]
        );
        const incoming = await this.lockMarketEquipment(client, current.equipment_instance_id);
        await assertInventoryWeightInTransaction(client, current.player_id, BigInt(requireRuntimeItemDefinition(incoming.definition_id).unitWeightGrams));
        const moved = await client.query(
          `UPDATE equipment_instances
           SET location = 'inventory', inventory_slot_index = $2,
               market_listing_id = NULL, market_collection_id = NULL
           WHERE instance_id = $1 AND location = 'market_collection'
             AND market_collection_id = $3`,
          [current.equipment_instance_id, null, current.collection_id]
        );
        if (moved.rowCount !== 1) {
          throw new Error(
            `Market equipment collection repair found incompatible instance ` +
            `${current.equipment_instance_id} for collection ${current.collection_id}, ` +
            `player ${current.player_id}`
          );
        }
        await client.query(
          `UPDATE player_equipment_state
           SET inventory_revision = inventory_revision + 1
           WHERE player_id = $1`,
          [current.player_id]
        );
        await client.query(
          `UPDATE market_equipment_collections
           SET claimed_at = clock_timestamp() WHERE collection_id = $1`,
          [current.collection_id]
        );
        const operationKey = `market-equipment-collection-repair:${current.collection_id}`;
        await client.query(
          `INSERT INTO market_collection_repairs (
             collection_kind, collection_identity, player_id, operation_key
           ) VALUES ('equipment',$1,$2,$3)
           ON CONFLICT DO NOTHING`,
          [current.collection_id, current.player_id, operationKey]
        );
        await client.query("COMMIT");
        equipment += 1;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    }

    const goldRows = await this.pool.query<{
      collection_id: string;
      player_id: string;
      remaining_amount: string;
    }>(
      `SELECT collection_id::text, player_id, remaining_amount::text
       FROM market_equipment_gold_collections
       WHERE remaining_amount > 0
       ORDER BY created_at, collection_id
       LIMIT $1`,
      [limit]
    );
    let equipmentGold = 0;
    for (const row of goldRows.rows) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const operationKey = `market-equipment-gold-repair:${row.collection_id}`;
        await this.creditWallet(
          client,
          {
            playerId: row.player_id,
            accountId: await this.accountIdForPlayer(client, row.player_id)
          },
          BigInt(row.remaining_amount),
          operationKey,
          "market_equipment_collection_repair",
          { metadata: { collectionId: row.collection_id } }
        );
        await client.query(
          `UPDATE market_equipment_gold_collections
           SET remaining_amount = 0, claimed_at = clock_timestamp()
           WHERE collection_id = $1 AND remaining_amount > 0`,
          [row.collection_id]
        );
        await client.query(
          `INSERT INTO market_collection_repairs (
             collection_kind, collection_identity, player_id, operation_key
           ) VALUES ('equipment_gold',$1,$2,$3)
           ON CONFLICT DO NOTHING`,
          [row.collection_id, row.player_id, operationKey]
        );
        await client.query("COMMIT");
        equipmentGold += 1;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    }
    return { material, equipment, equipmentGold };
  }

  async assetsSnapshot(playerId: string, options: { premiumWallet?: boolean } = {}) {
    const accountId = await this.accountIdForPlayer(this.pool, playerId);
    const [wallet, inventory, equipment, premiumWallet] = await Promise.all([
      this.wallet.snapshot(playerId, accountId),
      this.inventory.getInventorySnapshot(playerId),
      this.equipment?.getSnapshot(playerId),
      options.premiumWallet ? this.premiumWallet.snapshot(accountId) : undefined
    ]);
    return {
      wallet,
      inventory,
      ...(equipment ? { equipment } : {}),
      ...(premiumWallet ? { premiumWallet } : {})
    };
  }

  private async premiumSellerFeeBps(client: Queryable, itemId: string): Promise<number> {
    const result = await client.query<{ seller_fee_bps: number }>(
      "SELECT seller_fee_bps FROM market_premium_assets WHERE item_id = $1",
      [itemId]
    );
    const bps = result.rows[0]?.seller_fee_bps;
    if (bps === undefined) {
      throw new MarketError("MARKET_ITEM_NOT_TRADABLE", "This currency has no exchange book");
    }
    return Number(bps);
  }

  private async creditPremiumWallet(
    client: Queryable,
    input: {
      accountId: string;
      playerId: string;
      currency: PremiumCurrency;
      amount: bigint;
      operationKey: string;
      refType: "market_order" | "market_trade" | "market_equipment_listing";
      refId: string;
    }
  ): Promise<void> {
    try {
      await this.premiumWallet.creditForMarketInTransaction(client, {
        accountId: input.accountId,
        actorPlayerId: input.playerId,
        currency: input.currency,
        amount: input.amount,
        operationKey: input.operationKey,
        reason: "market",
        refType: input.refType,
        refId: input.refId
      });
    } catch (error) {
      throw mapPremiumWalletOperationError(error, input.currency);
    }
  }

  /**
   * Rate circuit breaker for the Glimmer book: freezes the book when
   * its trailing 24-hour VWAP differs from the previous 24 hours by more than
   * 50%. Unfreezing stays a manual `market:controls` action.
   */
  private async applyPremiumRateBreaker(
    client: pg.PoolClient,
    bookId: string,
    currency: PremiumCurrency
  ): Promise<void> {
    const result = await client.query<{
      current_vwap: string | null;
      current_trades: string;
      current_quantity: string;
      prior_vwap: string | null;
      prior_trades: string;
      prior_quantity: string;
      frozen: boolean;
    }>(
      `WITH windows AS (
         SELECT created_at > now() - interval '24 hours' AS current_window,
                quantity, gross_value
         FROM market_trades
         WHERE book_id = $1 AND created_at > now() - interval '48 hours'
       )
       SELECT
         (sum(gross_value) FILTER (WHERE current_window)::numeric
           / nullif(sum(quantity) FILTER (WHERE current_window), 0))::text AS current_vwap,
         count(*) FILTER (WHERE current_window)::text AS current_trades,
         coalesce(sum(quantity) FILTER (WHERE current_window), 0)::text AS current_quantity,
         (sum(gross_value) FILTER (WHERE NOT current_window)::numeric
           / nullif(sum(quantity) FILTER (WHERE NOT current_window), 0))::text AS prior_vwap,
         count(*) FILTER (WHERE NOT current_window)::text AS prior_trades,
         coalesce(sum(quantity) FILTER (WHERE NOT current_window), 0)::text AS prior_quantity,
         (SELECT frozen FROM market_order_books WHERE book_id = $1) AS frozen
       FROM windows`,
      [bookId]
    );
    const row = result.rows[0];
    if (!row || row.frozen || row.current_vwap === null || row.prior_vwap === null) return;
    // A thin market cannot trip the breaker: both windows need real volume, so
    // one tiny wash trade between two accounts cannot freeze the book.
    if (
      BigInt(row.current_trades) < PREMIUM_RATE_BREAKER_MIN_TRADES ||
      BigInt(row.prior_trades) < PREMIUM_RATE_BREAKER_MIN_TRADES ||
      BigInt(row.current_quantity) < PREMIUM_RATE_BREAKER_MIN_QUANTITY ||
      BigInt(row.prior_quantity) < PREMIUM_RATE_BREAKER_MIN_QUANTITY
    ) return;
    const current = Number(row.current_vwap);
    const prior = Number(row.prior_vwap);
    if (!(prior > 0) || Math.abs(current - prior) / prior <= PREMIUM_RATE_BREAKER_MOVE) return;
    await setMarketControlAuditContext(client, {
      operatorIdentity: "system:premium-rate-breaker",
      reason: `${PREMIUM_CURRENCY_NAMES[currency]} 24h VWAP moved from ${row.prior_vwap.slice(0, 24)} to ${row.current_vwap.slice(0, 24)} gold`
    });
    await client.query(
      `UPDATE market_order_books
       SET frozen = true, sensitive_reason = '${PREMIUM_RATE_BREAKER_REASON}', updated_at = now()
       WHERE book_id = $1 AND NOT frozen`,
      [bookId]
    );
    this.logger.warn(
      { bookId, currency, currentVwap: row.current_vwap, priorVwap: row.prior_vwap },
      "premium exchange rate breaker froze book"
    );
  }

  private async accountIdForPlayer(
    client: Queryable,
    playerId: string
  ): Promise<string> {
    const result = await client.query<{ account_id: string }>(
      `SELECT account_id::text
       FROM players
       WHERE id = $1
       FOR SHARE`,
      [playerId]
    );
    const accountId = result.rows[0]?.account_id;
    if (!accountId) {
      throw new MarketError(
        "MARKET_INVARIANT_FAILURE",
        "Market player ownership is unavailable"
      );
    }
    return accountId;
  }

  private async addCollection(
    client: Queryable,
    input: {
      venueId: string;
      playerId: string;
      assetKind: "item" | "gold";
      itemIdentity: string | null;
      itemId: string | null;
      variant: string | null;
      amount: bigint;
      reason:
        | "purchase"
        | "sell_proceeds"
        | "sell_cancel_return"
        | "buy_cancel_refund"
        | "price_improvement_refund"
        | "sell_expired_return"
        | "buy_expired_refund";
      sourceOrderId: string | null;
      sourceTradeId: string | null;
    }
  ): Promise<string> {
    const result = await client.query<{ collection_id: string }>(
      `INSERT INTO market_collections (
         venue_id, player_id, asset_kind, item_identity, item_id, variant,
         original_amount, remaining_amount, reason, source_order_id, source_trade_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10)
       RETURNING collection_id::text`,
      [
        input.venueId,
        input.playerId,
        input.assetKind,
        input.itemIdentity,
        input.itemId,
        input.variant,
        input.amount.toString(),
        input.reason,
        input.sourceOrderId,
        input.sourceTradeId
      ]
    );
    const id = result.rows[0]?.collection_id;
    if (!id) throw new Error("Market collection insert returned no row");
    return id;
  }

  private async writeLedger(
    client: Queryable,
    input: {
      groupType: "order_escrow" | "trade" | "cancel" | "claim" | "fee" | "administrative";
      requestId: string | null;
      claimId: string | null;
      orderId: string | null;
      tradeId: string | null;
      orderFeePolicy?: { id: number; version: number };
      tradeFeePolicies?: {
        buyerId: number;
        buyerVersion: number;
        sellerId: number;
        sellerVersion: number;
      };
      entries: LedgerEntry[];
    }
  ): Promise<void> {
    assertBalancedEntries(input.entries);
    const groupId = crypto.randomUUID();
    await client.query(
      `INSERT INTO market_ledger_groups (
         ledger_group_id, group_type, request_id, claim_id, order_id, trade_id,
         rules_version, order_fee_policy_id, order_fee_policy_version,
         buyer_fee_policy_id, buyer_fee_policy_version,
         seller_fee_policy_id, seller_fee_policy_version
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        groupId,
        input.groupType,
        input.requestId,
        input.claimId,
        input.orderId,
        input.tradeId,
        MARKET_RULES_VERSION,
        input.orderFeePolicy?.id ?? null,
        input.orderFeePolicy?.version ?? null,
        input.tradeFeePolicies?.buyerId ?? null,
        input.tradeFeePolicies?.buyerVersion ?? null,
        input.tradeFeePolicies?.sellerId ?? null,
        input.tradeFeePolicies?.sellerVersion ?? null
      ]
    );
    for (const entry of input.entries) {
      await client.query(
        `INSERT INTO market_ledger_entries (
           ledger_group_id, asset_kind, item_identity, amount, account_location,
           player_id, order_id, trade_id, collection_id, reason
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          groupId,
          entry.assetKind,
          entry.itemIdentity,
          entry.amount.toString(),
          entry.accountLocation,
          entry.playerId ?? null,
          entry.orderId ?? null,
          entry.tradeId ?? null,
          entry.collectionId ?? null,
          entry.reason
        ]
      );
    }
  }
}

type TradeRowForInsert = {
  trade_id: string;
  quantity: string;
  unit_price: string;
  gross_value: string;
  buyer_fee: string;
  seller_proceeds: string;
  applied_buyer_tax_bps: number;
  specialty_tax_applied: boolean;
  qualifying_tax_tag: MarketPublicTrade["qualifyingTaxTag"];
  created_at: Date | string;
};

const ORDER_RETURNING = `
  order_id, venue_id, book_id, item_identity, item_id, variant, player_id,
  account_id, side, order_policy, limit_unit_price::text, original_quantity::text,
  remaining_quantity::text, filled_quantity::text, status, priority_sequence::text,
  client_request_id, fee_policy_id, fee_policy_version, rules_version, created_at
`;

const ORDER_COLUMNS = `
  SELECT ${ORDER_RETURNING} FROM market_orders
`;

function assertBalancedEntries(entries: LedgerEntry[]): void {
  if (entries.length < 2) throw new Error("Market ledger group requires balanced entries");
  const totals = new Map<string, bigint>();
  for (const entry of entries) {
    const key = `${entry.assetKind}\u0000${entry.itemIdentity ?? ""}`;
    totals.set(key, (totals.get(key) ?? 0n) + entry.amount);
  }
  if ([...totals.values()].some((total) => total !== 0n)) {
    throw new MarketError("MARKET_INVARIANT_FAILURE", "Market ledger group is not balanced");
  }
}

function minBigInt(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}

function mapWalletOperationError(error: unknown): Error {
  if (!(error instanceof WalletOperationError)) {
    return error instanceof Error ? error : new Error("Unknown wallet operation failure");
  }
  switch (error.code) {
    case "WALLET_INSUFFICIENT_FUNDS":
      return new MarketError(
        "MARKET_NOT_ENOUGH_GOLD",
        "Not enough authoritative wallet gold for this order"
      );
    case "WALLET_OWNERSHIP_INVALID":
      return new MarketError(
        "MARKET_ACCESS_DENIED",
        "Authoritative wallet ownership is invalid"
      );
    default:
      return new MarketError("MARKET_INVARIANT_FAILURE", "Authoritative wallet transition failed");
  }
}

const PREMIUM_RATE_BREAKER_MOVE = 0.5;
/** Each 24-hour window needs at least this many fills and this much Glimmer traded. */
const PREMIUM_RATE_BREAKER_MIN_TRADES = 5n;
const PREMIUM_RATE_BREAKER_MIN_QUANTITY = 1_000n;
const PREMIUM_RATE_BREAKER_REASON = "premium_rate_breaker";

function requirePriceCurrency(value: unknown): MarketPriceCurrency {
  if (value === undefined || value === "gold") return "gold";
  if (value === "glimmer") return "glimmer";
  throw new MarketError("MARKET_INVALID_PRICE", "Unknown price currency");
}

function mapPremiumWalletOperationError(error: unknown, currency: PremiumCurrency): Error {
  if (!(error instanceof PremiumWalletOperationError)) {
    return error instanceof Error ? error : new Error("Unknown premium wallet operation failure");
  }
  if (error.code === "PREMIUM_WALLET_INSUFFICIENT_FUNDS") {
    return new MarketError(
      "MARKET_NOT_ENOUGH_ITEMS",
      `Not enough ${PREMIUM_CURRENCY_NAMES[currency]} for this listing and its fee`
    );
  }
  return new MarketError("MARKET_INVARIANT_FAILURE", "Authoritative premium wallet transition failed");
}

function isOpen(status: OrderRow["status"]): boolean {
  return status === "open" || status === "partially_filled";
}

function withMerchantBuyerFee(fee: FeeRow, merchantRank: number): FeeRow {
  return merchantRank >= 2
    ? { ...fee, buyer_fee_bps: merchantReducedBuyerTaxBps(fee.buyer_fee_bps, merchantRank) }
    : fee;
}

function requireSupportedFeePolicy(policy: FeeRow): FeeRow {
  if (BigInt(policy.listing_fee) !== 0n || BigInt(policy.cancellation_fee) !== 0n) {
    throw new MarketError(
      "MARKET_FEE_POLICY_UNSUPPORTED",
      "Market listing and cancellation fees are not enabled by this server version"
    );
  }
  return policy;
}

function assertMarketItemQuantity(item: Pick<ItemRow, "item_id" | "variant">, quantity: bigint): void {
  if (isShopCopyItemId(item.item_id) && (quantity !== 1n || item.variant === MARKET_DEFAULT_VARIANT)) {
    throw new MarketError(
      "MARKET_ITEM_NOT_TRADABLE",
      "Each listing of a tagged item must name one exact copy"
    );
  }
  if (item.item_id === "fishing_rod" && (quantity !== 1n || item.variant === MARKET_DEFAULT_VARIANT)) {
    throw new MarketError(
      "MARKET_ITEM_NOT_TRADABLE",
      "Each Fishing Rod listing must name one exact durable rod instance"
    );
  }
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
