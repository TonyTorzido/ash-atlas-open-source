import type {
  MarketBookSnapshot,
  MarketPriceCurrency,
  MarketCollectionItem,
  MarketControlSnapshot,
  MarketDepthLevel,
  MarketItemSummary,
  MarketEquipmentListingSnapshot,
  MarketOrderSnapshot,
  MarketPlayerFill,
  MarketPlayerSnapshot,
  MarketPublicTrade,
  MarketSnapshot
} from "@ash-atlas/shared";
import {
  CITY_MARKET_SPECIALTY_BUYER_TAX_BPS,
  CITY_MARKET_STANDARD_BUYER_TAX_BPS,
  FISHING_ROD_MARKET_IDENTITY,
  parseFishingRodMarketIdentity,
  parseShopCopyMarketIdentity
} from "@ash-atlas/shared";
import type pg from "pg";

import type { AppConfig } from "../config.js";
import {
  MarketAccessPolicy,
  type AuthorizedMarketVenue
} from "./marketAccess.js";
import { reserveMarketRate } from "./marketRateLimit.js";
import {
  MarketError,
  marketLimits,
  type MarketActor
} from "./marketRules.js";

type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

type VenueRow = {
  venue_id: string;
  venue_key: string;
  display_name: string;
  scope_type: "global_test" | "trade_hub" | "regional";
  fee_policy_id: number;
  city_id: string | null;
  market_structure_id: string | null;
  tax_revision: string;
};

type SummaryRow = {
  item_id: string;
  item_identity: string;
  variant: string;
  display_name: string;
  category: string;
  book_version: string | null;
  best_ask: string | null;
  best_bid: string | null;
  sell_quantity: string;
  buy_quantity: string;
  last_trade_price: string | null;
  glimmer_best_ask?: string | null;
  glimmer_best_bid?: string | null;
  glimmer_sell_quantity?: string | null;
  glimmer_buy_quantity?: string | null;
  glimmer_book_version?: string | null;
  copy_tag?: string | null;
  copy_buyer_name?: string | null;
};

type OrderRow = {
  order_id: string;
  item_id: string;
  item_identity: string;
  variant: string;
  display_name: string;
  side: "buy" | "sell";
  order_policy: "gtc" | "aon_ioc";
  limit_unit_price: string;
  original_quantity: string;
  filled_quantity: string;
  remaining_quantity: string;
  status: "open" | "partially_filled" | "filled" | "cancelled";
  priority_sequence: string;
  created_at: Date | string;
  cancelled_at: Date | string | null;
  completed_at: Date | string | null;
  price_currency?: MarketPriceCurrency;
};

type TradeRow = {
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

export type MarketBrowseInput = {
  search?: string;
  category?: string;
  cursor?: string | null;
  limit?: number;
  /** Only items someone is selling, in either book, so a page is never all empty rows. */
  listedOnly?: boolean;
};

export class MarketReadService {
  private readonly access: MarketAccessPolicy;
  private readonly limits: ReturnType<typeof marketLimits>;

  constructor(
    private readonly pool: pg.Pool,
    private readonly config: AppConfig,
    access?: MarketAccessPolicy
  ) {
    this.access = access ?? new MarketAccessPolicy(config);
    this.limits = marketLimits(config);
  }

  async assertAccess(actor: MarketActor): Promise<void> {
    await this.access.assertAccess(this.pool, actor);
  }

  async assertSubscriptionAccess(
    actor: MarketActor,
    connectionId: string,
    sessionId: string
  ): Promise<AuthorizedMarketVenue> {
    const venue = await this.access.requireSession(
      this.pool,
      actor,
      connectionId,
      sessionId
    );
    await reserveMarketRate(
      this.pool,
      actor.playerId,
      "subscription",
      this.limits.subscriptionRequestsPerMinute
    );
    return venue;
  }

  async snapshot(
    actor: MarketActor,
    venue: AuthorizedMarketVenue,
    input: MarketBrowseInput = {}
  ): Promise<MarketSnapshot> {
    await reserveMarketRate(
      this.pool,
      actor.playerId,
      "browse",
      this.limits.browseRequestsPerMinute
    );
    return this.withReadSnapshot((client) =>
      this.snapshotInTransaction(client, actor, venue, input)
    );
  }

  async snapshotInTransaction(
    queryable: Queryable,
    actor: MarketActor,
    venueAuthority: AuthorizedMarketVenue,
    input: MarketBrowseInput = {}
  ): Promise<MarketSnapshot> {
    const venue = await this.requireVenue(queryable, venueAuthority.venueId);
    const controls = await this.controls(queryable, actor, venue.venue_id);
    const categoriesResult = await queryable.query<{ category: string }>(
      `SELECT DISTINCT category
       FROM item_definitions
       WHERE market_tradable AND market_identity IS NOT NULL
         AND (market_fungible OR item_id IN ('fishing_rod', 'face_mask', 'manor_skin'))
       ORDER BY category ASC`
    );
    const page = await this.browseItems(queryable, venue.venue_id, actor.playerId, input);
    const exactEquipmentListings = await equipmentListings(
      queryable,
      venueAuthority,
      null
    );
    const player = await this.playerSnapshot(queryable, actor, venue.venue_id);
    const feeResult = await queryable.query<{
      version: number;
      listing_fee: string;
      buyer_fee_bps: number;
      seller_fee_bps: number;
      cancellation_fee: string;
    }>(
      `SELECT version, listing_fee, buyer_fee_bps, seller_fee_bps, cancellation_fee
       FROM market_fee_policies WHERE fee_policy_id = $1 AND active`,
      [venue.fee_policy_id]
    );
    const fee = feeResult.rows[0];
    if (!fee) throw new Error("Active market fee policy does not exist");
    return {
      venue: {
        venueId: venue.venue_id,
        venueKey: venue.venue_key,
        displayName: venue.display_name,
        scopeType: venue.scope_type,
        cityId: venueAuthority.cityId,
        cityName: venueAuthority.cityName,
        marketStructureId: venueAuthority.marketStructureId,
        activeMonumentTypes: [...venueAuthority.activeMonumentTypes],
        standardBuyerTaxBps: CITY_MARKET_STANDARD_BUYER_TAX_BPS,
        specialtyBuyerTaxBps: CITY_MARKET_SPECIALTY_BUYER_TAX_BPS,
        taxRevision: venueAuthority.taxRevision
      },
      sessionId: venueAuthority.sessionId,
      controls,
      categories: categoriesResult.rows.map((row) => row.category),
      items: page.items,
      equipmentListings: exactEquipmentListings,
      nextCursor: page.nextCursor,
      player,
      feePolicy: {
        version: Number(fee.version),
        listingFee: fee.listing_fee,
        buyerFeeBps: Number(fee.buyer_fee_bps),
        sellerFeeBps: Number(fee.seller_fee_bps),
        cancellationFee: fee.cancellation_fee
      }
    };
  }

  async book(
    actor: MarketActor,
    venue: AuthorizedMarketVenue,
    itemIdentity: string,
    requestedDepth?: number,
    priceCurrency: MarketPriceCurrency = "gold"
  ): Promise<MarketBookSnapshot> {
    await reserveMarketRate(
      this.pool,
      actor.playerId,
      "book",
      this.limits.bookRequestsPerMinute
    );
    return this.bookSnapshot(actor, venue.venueId, itemIdentity, requestedDepth, priceCurrency);
  }

  /** Internal committed-state publication path; client quotas are not consumed. */
  async bookForRealtime(
    actor: MarketActor,
    venueId: string,
    itemIdentity: string,
    requestedDepth?: number,
    priceCurrency: MarketPriceCurrency = "gold"
  ): Promise<MarketBookSnapshot> {
    await this.access.assertAccess(this.pool, actor);
    return this.bookSnapshot(actor, venueId, itemIdentity, requestedDepth, priceCurrency);
  }

  private async bookSnapshot(
    actor: MarketActor,
    venueId: string,
    itemIdentity: string,
    requestedDepth?: number,
    priceCurrency: MarketPriceCurrency = "gold"
  ): Promise<MarketBookSnapshot> {
    return this.withReadSnapshot(async (client) => {
      return this.bookInTransaction(client, venueId, itemIdentity, requestedDepth, priceCurrency);
    });
  }

  async bookInTransaction(
    queryable: Queryable,
    venueId: string,
    itemIdentity: string,
    requestedDepth?: number,
    priceCurrency: MarketPriceCurrency = "gold"
  ): Promise<MarketBookSnapshot> {
    const depth = Math.max(1, Math.min(requestedDepth ?? this.limits.maxDepthLevels, this.limits.maxDepthLevels));
    const summary = await this.itemSummary(queryable, venueId, itemIdentity, priceCurrency);
    const bookResult = await queryable.query<{ book_id: string }>(
      `SELECT book_id FROM market_order_books
       WHERE venue_id = $1 AND item_identity = $2 AND price_currency = $3`,
      [venueId, summary.itemIdentity, priceCurrency]
    );
    const bookId = bookResult.rows[0]?.book_id;
    if (!bookId) return { item: summary, asks: [], bids: [], recentTrades: [] };

    const asks = await this.depth(queryable, bookId, "sell", depth);
    const bids = await this.depth(queryable, bookId, "buy", depth);
    const trades = await queryable.query<TradeRow>(
      `SELECT trade_id, quantity::text, unit_price::text, gross_value::text,
              buyer_fee::text, (gross_value - seller_fee)::text AS seller_proceeds,
              applied_buyer_tax_bps, specialty_tax_applied,
              qualifying_tax_tag, created_at
       FROM market_trades WHERE book_id = $1
       ORDER BY created_at DESC, trade_id DESC LIMIT 25`,
      [bookId]
    );
    return { item: summary, asks, bids, recentTrades: trades.rows.map(publicTrade) };
  }

  async playerSnapshot(
    queryable: Queryable,
    actor: MarketActor,
    venueId: string
  ): Promise<MarketPlayerSnapshot> {
    const wallet = await queryable.query<{ gold_balance: string; version: string }>(
      `SELECT gold_balance::text, version::text FROM player_wallets WHERE player_id = $1 AND account_id = $2`,
      [actor.playerId, actor.accountId]
    );
    const activeRows = await queryable.query<OrderRow>(
      `${ORDER_SELECT}
       WHERE o.account_id = $1 AND o.venue_id = $2
         AND o.status IN ('open', 'partially_filled')
       ORDER BY o.created_at DESC, o.order_id DESC LIMIT 50`,
      [actor.accountId, venueId]
    );
    const recentRows = await queryable.query<OrderRow>(
      `${ORDER_SELECT}
       WHERE o.account_id = $1 AND o.venue_id = $2
       ORDER BY o.created_at DESC, o.order_id DESC LIMIT 50`,
      [actor.accountId, venueId]
    );
    const fillRows = await queryable.query<{
      trade_id: string;
      order_id: string;
      side: "buy" | "sell";
      item_id: string;
      item_identity: string;
      variant: string;
      display_name: string;
      quantity: string;
      unit_price: string;
      gross_value: string;
      created_at: Date | string;
      price_currency: MarketPriceCurrency;
    }>(
      `SELECT t.trade_id, b.price_currency,
              CASE WHEN t.buyer_player_id = $1 THEN t.buy_order_id ELSE t.sell_order_id END AS order_id,
              CASE WHEN t.buyer_player_id = $1 THEN 'buy' ELSE 'sell' END AS side,
              t.item_id, t.item_identity, t.variant,
              CASE WHEN t.item_id IN ('face_mask', 'manor_skin')
                     THEN COALESCE((SELECT c.display_name FROM shop_item_copies c WHERE c.copy_id = t.variant), d.display_name)
                   WHEN t.item_id = 'fishing_rod' OR t.variant = 'default' THEN d.display_name
                   ELSE initcap(replace(t.variant, '_', ' ')) || ' ' || d.display_name END AS display_name,
              t.quantity::text, t.unit_price::text,
              t.gross_value::text, t.created_at
       FROM market_trades t
       JOIN item_definitions d ON d.item_id = t.item_id
       JOIN market_order_books b ON b.book_id = t.book_id
       WHERE (t.buyer_player_id = $1 OR t.seller_player_id = $1)
         AND t.venue_id = $2
       ORDER BY t.created_at DESC, t.trade_id DESC LIMIT 50`,
      [actor.playerId, venueId]
    );
    const itemCollections = await queryable.query<{
      item_id: string;
      item_identity: string;
      display_name: string;
      variant: string;
      quantity: string;
    }>(
      `SELECT c.item_id, c.item_identity, d.display_name, c.variant,
              sum(c.remaining_amount)::text AS quantity
       FROM market_collections c
       JOIN item_definitions d ON d.item_id = c.item_id
       WHERE c.player_id = $1 AND c.venue_id = $2
         AND c.asset_kind = 'item' AND c.remaining_amount > 0
       GROUP BY c.item_id, c.item_identity, d.display_name, c.variant
       ORDER BY d.display_name ASC, c.item_id ASC, c.variant ASC
       LIMIT 100`,
      [actor.playerId, venueId]
    );
    const goldCollection = await queryable.query<{ gold: string }>(
      `SELECT (
         SELECT coalesce(sum(remaining_amount), 0)
         FROM market_collections
         WHERE player_id = $1 AND venue_id = $2
           AND asset_kind = 'gold' AND remaining_amount > 0
       )::bigint + (
         SELECT coalesce(sum(remaining_amount), 0)
         FROM market_equipment_gold_collections
         WHERE player_id = $1 AND venue_id = $2
           AND remaining_amount > 0
       )::bigint AS gold`,
      [actor.playerId, venueId]
    );
    const equipmentCollection = await equipmentListingsForCollection(
      queryable,
      venueId,
      actor.playerId
    );
    return {
      walletGold: wallet.rows[0]?.gold_balance ?? "0",
      walletVersion: wallet.rows[0]?.version ?? "0",
      activeOrders: activeRows.rows.map(orderSnapshot),
      recentOrders: recentRows.rows.map(orderSnapshot),
      recentFills: fillRows.rows.map((row): MarketPlayerFill => ({
        tradeId: row.trade_id,
        orderId: row.order_id,
        side: row.side,
        itemId: row.item_id,
        itemIdentity: row.item_identity,
        variant: row.variant === "default" ? null : row.variant,
        displayName: row.display_name,
        quantity: row.quantity,
        unitPrice: row.unit_price,
        total: row.gross_value,
        createdAt: iso(row.created_at),
        ...(row.price_currency === "glimmer" ? { priceCurrency: "glimmer" as const } : {})
      })),
      collection: {
        items: itemCollections.rows.map((row): MarketCollectionItem => ({
          itemId: row.item_id,
          itemIdentity: row.item_identity,
          displayName: row.display_name,
          variant: row.variant === "default" ? null : row.variant,
          quantity: row.quantity
        })),
        gold: goldCollection.rows[0]?.gold ?? "0",
        equipment: equipmentCollection
      }
    };
  }

  async order(queryable: Queryable, orderId: string): Promise<MarketOrderSnapshot | null> {
    const result = await queryable.query<OrderRow>(
      `${ORDER_SELECT} WHERE o.order_id = $1`,
      [orderId]
    );
    return result.rows[0] ? orderSnapshot(result.rows[0]) : null;
  }

  async requireVenue(queryable: Queryable, venueId: string): Promise<VenueRow> {
    const result = await queryable.query<VenueRow>(
      `SELECT venue_id, venue_key, display_name, scope_type, fee_policy_id,
              city_id::text, market_structure_id::text, tax_revision::text
       FROM market_venues
       WHERE venue_id = $1 AND active AND state = 'active'`,
      [venueId]
    );
    const row = result.rows[0];
    if (!row) throw new MarketError("MARKET_ACCESS_DENIED", "City Market venue is unavailable");
    return row;
  }

  async controls(queryable: Queryable, actor: MarketActor, venueId: string): Promise<MarketControlSnapshot> {
    const result = await queryable.query<{
      read_only: boolean;
      new_orders_enabled: boolean;
      matching_enabled: boolean;
      cancellations_enabled: boolean;
      claims_enabled: boolean;
      venue_frozen: boolean;
      player_frozen: boolean;
    }>(
      `SELECT g.read_only,
              g.new_orders_enabled AND coalesce(v.new_orders_enabled, false)
                AS new_orders_enabled,
              g.matching_enabled AND coalesce(v.matching_enabled, false)
                AS matching_enabled,
              g.cancellations_enabled AND coalesce(v.cancellations_enabled, true)
                AS cancellations_enabled,
              g.claims_enabled AND coalesce(v.claims_enabled, true)
                AS claims_enabled,
              coalesce(v.frozen, false) AS venue_frozen,
              coalesce(p.mutations_frozen, false) AS player_frozen
       FROM market_global_controls g
       LEFT JOIN market_venue_controls v ON v.venue_id = $1
       LEFT JOIN market_player_controls p ON p.account_id = $2
       WHERE g.singleton`,
      [venueId, actor.accountId]
    );
    const row = result.rows[0];
    if (!row) throw new Error("Market controls do not exist");
    const unavailable = row.read_only || row.venue_frozen || row.player_frozen;
    return {
      accessAllowed: await this.access.isAccessAllowed(queryable, actor),
      readOnly: row.read_only,
      newOrdersEnabled: row.new_orders_enabled,
      matchingEnabled: row.matching_enabled,
      cancellationsEnabled: row.cancellations_enabled,
      claimsEnabled: row.claims_enabled,
      venueFrozen: row.venue_frozen,
      playerFrozen: row.player_frozen,
      message: unavailable ? "Market mutations are temporarily restricted." : null
    };
  }

  private async browseItems(
    queryable: Queryable,
    venueId: string,
    playerId: string,
    input: MarketBrowseInput
  ): Promise<{ items: MarketItemSummary[]; nextCursor: string | null }> {
    const requestedLimit = input.limit ?? 24;
    const limit = Math.max(1, Math.min(requestedLimit, this.limits.maxSearchResults));
    const cursor = decodeCursor(input.cursor ?? null);
    const search = input.search?.trim() || null;
    const category = input.category?.trim() || null;
    const listedOnly = input.listedOnly === true;
    const result = await queryable.query<SummaryRow>(
      `${SUMMARY_SELECT}
       WHERE d.market_tradable AND d.market_fungible AND d.market_identity IS NOT NULL
         AND ($2::text IS NULL OR d.category = $2)
         AND ($3::text IS NULL OR to_tsvector('simple', asset.display_name || ' ' || d.category || ' ' || d.item_id)
              @@ plainto_tsquery('simple', $3))
         AND ($4::text IS NULL OR (lower(asset.display_name), asset.item_identity) > ($4, $5))
         AND (NOT $7::boolean OR ${listedIn("$1")})
       GROUP BY d.item_id, asset.item_identity, asset.variant, asset.display_name,
                d.category, b.book_id, b.book_version
       ORDER BY lower(asset.display_name) ASC, asset.item_identity ASC
       LIMIT $6`,
      [venueId, category, search, cursor?.name ?? null, cursor?.itemIdentity ?? null, limit + 1, listedOnly]
    );
    const rodResult = await queryable.query<SummaryRow>(
      `${ROD_SUMMARY_SELECT}
       WHERE d.item_id = 'fishing_rod' AND d.market_tradable
         AND ($3::text IS NULL OR d.category = $3)
         AND ($4::text IS NULL OR to_tsvector('simple', d.display_name || ' ' || d.category || ' ' || d.item_id)
              @@ plainto_tsquery('simple', $4))
         AND ($5::text IS NULL OR (lower(d.display_name), asset.item_identity) > ($5, $6))
         AND (NOT $8::boolean OR ${listedIn("$1")})
       GROUP BY d.item_id, asset.item_identity, asset.variant, d.display_name,
                d.category, b.book_id, b.book_version
       ORDER BY lower(d.display_name) ASC, asset.item_identity ASC
       LIMIT $7`,
      [
        venueId,
        playerId,
        category,
        search,
        cursor?.name ?? null,
        cursor?.itemIdentity ?? null,
        limit + 1,
        listedOnly
      ]
    );
    const copyResult = await queryable.query<SummaryRow>(
      `${COPY_SUMMARY_SELECT}
       WHERE d.item_id IN ('face_mask', 'manor_skin') AND d.market_tradable
         AND ($3::text IS NULL OR d.category = $3)
         AND ($4::text IS NULL OR to_tsvector('simple', asset.display_name || ' ' || d.category || ' ' || d.item_id)
              @@ plainto_tsquery('simple', $4))
         AND ($5::text IS NULL OR (lower(asset.display_name), asset.item_identity) > ($5, $6))
         AND (NOT $8::boolean OR ${listedIn("$1")})
       GROUP BY d.item_id, asset.item_identity, asset.variant, asset.display_name, asset.copy_tag,
                asset.copy_buyer_name, d.category, b.book_id, b.book_version
       ORDER BY lower(asset.display_name) ASC, asset.item_identity ASC
       LIMIT $7`,
      [
        venueId,
        playerId,
        category,
        search,
        cursor?.name ?? null,
        cursor?.itemIdentity ?? null,
        limit + 1,
        listedOnly
      ]
    );
    const rows = [...result.rows, ...rodResult.rows, ...copyResult.rows].sort((left, right) =>
      left.display_name.toLowerCase().localeCompare(right.display_name.toLowerCase()) ||
      left.item_identity.localeCompare(right.item_identity)
    );
    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    const last = pageRows.at(-1);
    return {
      items: pageRows.map(summaryFromRow),
      nextCursor: hasMore && last
        ? encodeCursor({ name: last.display_name.toLowerCase(), itemIdentity: last.item_identity })
        : null
    };
  }

  private async itemSummary(
    queryable: Queryable,
    venueId: string,
    itemIdentity: string,
    priceCurrency: MarketPriceCurrency = "gold"
  ): Promise<MarketItemSummary> {
    const copy = parseShopCopyMarketIdentity(itemIdentity);
    if (copy) {
      const result = await queryable.query<SummaryRow>(`${COPY_ITEM_SUMMARY_SELECT}
       WHERE copy.copy_id = $3 AND copy.item_id = $5 AND d.market_tradable
       GROUP BY d.item_id, copy.copy_id, copy.display_name, d.display_name, d.category, copy.tag,
                copy.original_buyer_name, b.book_id, b.book_version`, [
        venueId, itemIdentity, copy.copyId, priceCurrency, copy.itemId
      ]);
      const row = result.rows[0];
      if (row) return withPriceCurrency(summaryFromRow(row), priceCurrency);
      throw new MarketError("MARKET_ITEM_NOT_TRADABLE", "Item is not authoritatively tradable");
    }
    const rodId = parseFishingRodMarketIdentity(itemIdentity);
    if (rodId) {
      const result = await queryable.query<SummaryRow>(`${ROD_ITEM_SUMMARY_SELECT}
       WHERE rod.rod_id = $3::uuid AND d.item_id = 'fishing_rod' AND d.market_tradable
       GROUP BY d.item_id, rod.rod_id, d.display_name, d.category, b.book_id, b.book_version`, [
        venueId,
        `${FISHING_ROD_MARKET_IDENTITY}:${rodId}`,
        rodId,
        priceCurrency
      ]);
      const row = result.rows[0];
      if (row) return withPriceCurrency(summaryFromRow(row), priceCurrency);
      throw new MarketError(
        "MARKET_ITEM_NOT_TRADABLE",
        "Item is not authoritatively tradable"
      );
    }
    const result = await queryable.query<SummaryRow>(
      `${summarySelect("$3")}
       WHERE asset.item_identity = $2 AND d.market_tradable AND d.market_fungible
         AND d.market_identity IS NOT NULL
       GROUP BY d.item_id, asset.item_identity, asset.variant, asset.display_name,
                d.category, b.book_id, b.book_version`,
      [venueId, itemIdentity, priceCurrency]
    );
    const row = result.rows[0];
    if (!row) {
      throw new MarketError(
        "MARKET_ITEM_NOT_TRADABLE",
        "Item is not authoritatively tradable and fungible"
      );
    }
    return withPriceCurrency(summaryFromRow(row), priceCurrency);
  }

  private async depth(
    queryable: Queryable,
    bookId: string,
    side: "buy" | "sell",
    limit: number
  ): Promise<MarketDepthLevel[]> {
    const direction = side === "sell" ? "ASC" : "DESC";
    const result = await queryable.query<{
      unit_price: string;
      quantity: string;
      order_count: number;
    }>(
      `SELECT limit_unit_price::text AS unit_price,
              sum(remaining_quantity)::text AS quantity,
              count(*)::integer AS order_count
       FROM market_orders
       WHERE book_id = $1 AND side = $2 AND status IN ('open', 'partially_filled')
       GROUP BY limit_unit_price
       ORDER BY limit_unit_price ${direction}
       LIMIT $3`,
      [bookId, side, limit]
    );
    return result.rows.map((row) => ({
      unitPrice: row.unit_price,
      quantity: row.quantity,
      orderCount: Number(row.order_count)
    }));
  }

  private async withReadSnapshot<T>(
    operation: (client: pg.PoolClient) => Promise<T>
  ): Promise<T> {
    const client = await this.pool.connect();
    let committed = false;
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await client.query("SELECT set_config('statement_timeout', $1, true)", [
        `${this.config.MARKET_READ_STATEMENT_TIMEOUT_MS}ms`
      ]);
      const result = await operation(client);
      await client.query("COMMIT");
      committed = true;
      return result;
    } catch (error) {
      if (!committed) await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

/** True when anyone has an open sell order for the row's asset in either price book. */
const listedIn = (venueParam: string): string => `EXISTS (
           SELECT 1 FROM market_order_books lb
           JOIN market_orders lo ON lo.book_id = lb.book_id
           WHERE lb.venue_id = ${venueParam} AND lb.item_identity = asset.item_identity
             AND lo.side = 'sell' AND lo.status IN ('open', 'partially_filled'))`;

/** The item's Glimmer book at a glance, so Glimmer-only listings still show in the catalog. */
const glimmerBookStat = (aggregate: string, side: "buy" | "sell", alias: string): string => `
         (SELECT ${aggregate}::text
          FROM market_order_books gb
          JOIN market_orders go ON go.book_id = gb.book_id
          WHERE gb.venue_id = $1 AND gb.item_identity = asset.item_identity
            AND gb.price_currency = 'glimmer'
            AND go.side = '${side}' AND go.status IN ('open', 'partially_filled')) AS ${alias}`;
const GLIMMER_BOOK_STATS = [
  `
         (SELECT gb.book_version::text FROM market_order_books gb
          WHERE gb.venue_id = $1 AND gb.item_identity = asset.item_identity
            AND gb.price_currency = 'glimmer') AS glimmer_book_version`,
  glimmerBookStat("min(go.limit_unit_price)", "sell", "glimmer_best_ask"),
  glimmerBookStat("max(go.limit_unit_price)", "buy", "glimmer_best_bid"),
  glimmerBookStat("coalesce(sum(go.remaining_quantity), 0)", "sell", "glimmer_sell_quantity"),
  glimmerBookStat("coalesce(sum(go.remaining_quantity), 0)", "buy", "glimmer_buy_quantity")
].join(",");

/** Catalog rows summarize each item's Gold book; a detail read names its book. */
const summarySelect = (priceCurrency: string): string => `
  SELECT d.item_id, asset.item_identity, asset.variant, asset.display_name, d.category,
         b.book_version::text,
         min(o.limit_unit_price) FILTER (
           WHERE o.side = 'sell' AND o.status IN ('open', 'partially_filled')
         )::text AS best_ask,
         max(o.limit_unit_price) FILTER (
           WHERE o.side = 'buy' AND o.status IN ('open', 'partially_filled')
         )::text AS best_bid,
         coalesce(sum(o.remaining_quantity) FILTER (
           WHERE o.side = 'sell' AND o.status IN ('open', 'partially_filled')
         ), 0)::text AS sell_quantity,
         coalesce(sum(o.remaining_quantity) FILTER (
           WHERE o.side = 'buy' AND o.status IN ('open', 'partially_filled')
         ), 0)::text AS buy_quantity,
         (SELECT t.unit_price::text FROM market_trades t
          WHERE t.book_id = b.book_id ORDER BY t.created_at DESC, t.trade_id DESC LIMIT 1) AS last_trade_price,
         ${GLIMMER_BOOK_STATS}
  FROM item_definitions d
  CROSS JOIN LATERAL (
    SELECT CASE WHEN variant = 'default' THEN d.market_identity
                ELSE d.market_identity || ':' || variant END AS item_identity,
           variant,
           CASE WHEN variant = 'default' THEN d.display_name
                ELSE initcap(replace(variant, '_', ' ')) || ' ' || d.display_name END AS display_name
    FROM unnest(d.supported_variants) AS variant
  ) asset
  LEFT JOIN market_order_books b
    ON b.venue_id = $1 AND b.item_identity = asset.item_identity
   AND b.price_currency = ${priceCurrency}
  LEFT JOIN market_orders o
    ON o.book_id = b.book_id AND o.status IN ('open', 'partially_filled')
`;
const SUMMARY_SELECT = summarySelect("'gold'");

const ROD_SUMMARY_SELECT = `
  SELECT d.item_id, asset.item_identity, asset.variant, d.display_name, d.category,
         b.book_version::text,
         min(o.limit_unit_price) FILTER (
           WHERE o.side = 'sell' AND o.status IN ('open', 'partially_filled')
         )::text AS best_ask,
         max(o.limit_unit_price) FILTER (
           WHERE o.side = 'buy' AND o.status IN ('open', 'partially_filled')
         )::text AS best_bid,
         coalesce(sum(o.remaining_quantity) FILTER (
           WHERE o.side = 'sell' AND o.status IN ('open', 'partially_filled')
         ), 0)::text AS sell_quantity,
         coalesce(sum(o.remaining_quantity) FILTER (
           WHERE o.side = 'buy' AND o.status IN ('open', 'partially_filled')
         ), 0)::text AS buy_quantity,
         (SELECT t.unit_price::text FROM market_trades t
          WHERE t.book_id = b.book_id ORDER BY t.created_at DESC, t.trade_id DESC LIMIT 1) AS last_trade_price
  FROM item_definitions d
  CROSS JOIN LATERAL (
    SELECT '${FISHING_ROD_MARKET_IDENTITY}' || ':' || rod.rod_id::text AS item_identity,
           rod.rod_id::text AS variant
    FROM fishing_rods rod
    JOIN player_inventory inventory
      ON inventory.player_id = rod.player_id
     AND inventory.resource_type = 'fishing_rod'
     AND inventory.variant = rod.rod_id::text
     AND inventory.quantity > 0
    WHERE inventory.player_id = $2
    UNION
    SELECT orders.item_identity, orders.variant
    FROM market_orders orders
    JOIN fishing_rods listed_rod
      ON listed_rod.rod_id::text = orders.variant
    WHERE orders.item_id = 'fishing_rod'
      AND orders.item_identity LIKE '${FISHING_ROD_MARKET_IDENTITY}:%'
      AND orders.variant <> 'default'
      AND orders.status IN ('open', 'partially_filled')
  ) asset
  LEFT JOIN market_order_books b
    ON b.venue_id = $1 AND b.item_identity = asset.item_identity AND b.price_currency = 'gold'
  LEFT JOIN market_orders o
    ON o.book_id = b.book_id AND o.status IN ('open', 'partially_filled')
`;

const COPY_SUMMARY_SELECT = `
  SELECT d.item_id, asset.item_identity, asset.variant, asset.display_name, d.category,
         b.book_version::text,
         min(o.limit_unit_price) FILTER (
           WHERE o.side = 'sell' AND o.status IN ('open', 'partially_filled')
         )::text AS best_ask,
         max(o.limit_unit_price) FILTER (
           WHERE o.side = 'buy' AND o.status IN ('open', 'partially_filled')
         )::text AS best_bid,
         coalesce(sum(o.remaining_quantity) FILTER (
           WHERE o.side = 'sell' AND o.status IN ('open', 'partially_filled')
         ), 0)::text AS sell_quantity,
         coalesce(sum(o.remaining_quantity) FILTER (
           WHERE o.side = 'buy' AND o.status IN ('open', 'partially_filled')
         ), 0)::text AS buy_quantity,
         (SELECT t.unit_price::text FROM market_trades t
          WHERE t.book_id = b.book_id ORDER BY t.created_at DESC, t.trade_id DESC LIMIT 1) AS last_trade_price
         , asset.copy_tag, asset.copy_buyer_name
  FROM item_definitions d
  CROSS JOIN LATERAL (
    SELECT d.item_id || ':' || copy.copy_id AS item_identity, copy.copy_id AS variant,
           COALESCE(copy.display_name, d.display_name) AS display_name,
           copy.tag AS copy_tag, copy.original_buyer_name AS copy_buyer_name
    FROM shop_item_copies copy
    WHERE copy.item_id = d.item_id
      AND (EXISTS (SELECT 1 FROM player_inventory inventory
                   WHERE inventory.player_id = $2 AND inventory.resource_type = d.item_id
                     AND inventory.variant = copy.copy_id AND inventory.quantity > 0)
        OR EXISTS (SELECT 1 FROM market_orders orders
                   WHERE orders.item_id = d.item_id AND orders.variant = copy.copy_id
                     AND orders.status IN ('open', 'partially_filled')))
  ) asset
  LEFT JOIN market_order_books b
    ON b.venue_id = $1 AND b.item_identity = asset.item_identity AND b.price_currency = 'gold'
  LEFT JOIN market_orders o
    ON o.book_id = b.book_id AND o.status IN ('open', 'partially_filled')
`;

const COPY_ITEM_SUMMARY_SELECT = `
  SELECT d.item_id, $2::text AS item_identity, copy.copy_id AS variant,
         COALESCE(copy.display_name, d.display_name) AS display_name, d.category,
         b.book_version::text,
         min(o.limit_unit_price) FILTER (
           WHERE o.side = 'sell' AND o.status IN ('open', 'partially_filled')
         )::text AS best_ask,
         max(o.limit_unit_price) FILTER (
           WHERE o.side = 'buy' AND o.status IN ('open', 'partially_filled')
         )::text AS best_bid,
         coalesce(sum(o.remaining_quantity) FILTER (
           WHERE o.side = 'sell' AND o.status IN ('open', 'partially_filled')
         ), 0)::text AS sell_quantity,
         coalesce(sum(o.remaining_quantity) FILTER (
           WHERE o.side = 'buy' AND o.status IN ('open', 'partially_filled')
         ), 0)::text AS buy_quantity,
         (SELECT t.unit_price::text FROM market_trades t
          WHERE t.book_id = b.book_id ORDER BY t.created_at DESC, t.trade_id DESC LIMIT 1) AS last_trade_price
         , copy.tag AS copy_tag, copy.original_buyer_name AS copy_buyer_name
  FROM shop_item_copies copy
  JOIN item_definitions d ON d.item_id = copy.item_id
  LEFT JOIN market_order_books b
    ON b.venue_id = $1 AND b.item_identity = $2 AND b.price_currency = $4
  LEFT JOIN market_orders o
    ON o.book_id = b.book_id AND o.status IN ('open', 'partially_filled')
`;

const ROD_ITEM_SUMMARY_SELECT = `
  SELECT d.item_id, $2::text AS item_identity, rod.rod_id::text AS variant, d.display_name, d.category,
         b.book_version::text,
         min(o.limit_unit_price) FILTER (
           WHERE o.side = 'sell' AND o.status IN ('open', 'partially_filled')
         )::text AS best_ask,
         max(o.limit_unit_price) FILTER (
           WHERE o.side = 'buy' AND o.status IN ('open', 'partially_filled')
         )::text AS best_bid,
         coalesce(sum(o.remaining_quantity) FILTER (
           WHERE o.side = 'sell' AND o.status IN ('open', 'partially_filled')
         ), 0)::text AS sell_quantity,
         coalesce(sum(o.remaining_quantity) FILTER (
           WHERE o.side = 'buy' AND o.status IN ('open', 'partially_filled')
         ), 0)::text AS buy_quantity,
         (SELECT t.unit_price::text FROM market_trades t
          WHERE t.book_id = b.book_id ORDER BY t.created_at DESC, t.trade_id DESC LIMIT 1) AS last_trade_price
  FROM item_definitions d
  JOIN fishing_rods rod ON rod.rod_id = $3::uuid
  LEFT JOIN market_order_books b
    ON b.venue_id = $1 AND b.item_identity = $2 AND b.price_currency = $4
  LEFT JOIN market_orders o
    ON o.book_id = b.book_id AND o.status IN ('open', 'partially_filled')
`;

const ORDER_SELECT = `
  SELECT o.order_id, o.item_id, o.item_identity, o.variant,
         CASE WHEN o.item_id IN ('face_mask', 'manor_skin')
                THEN COALESCE((SELECT c.display_name FROM shop_item_copies c WHERE c.copy_id = o.variant), d.display_name)
              WHEN o.item_id = 'fishing_rod' OR o.variant = 'default' THEN d.display_name
              ELSE initcap(replace(o.variant, '_', ' ')) || ' ' || d.display_name END AS display_name,
         o.side, o.order_policy,
         o.limit_unit_price::text, o.original_quantity::text, o.filled_quantity::text,
         o.remaining_quantity::text, o.status, o.priority_sequence::text, o.created_at,
         o.cancelled_at, o.completed_at, b.price_currency
  FROM market_orders o JOIN item_definitions d ON d.item_id = o.item_id
  JOIN market_order_books b ON b.book_id = o.book_id
`;

function summaryFromRow(row: SummaryRow): MarketItemSummary {
  return {
    itemId: row.item_id,
    itemIdentity: row.item_identity,
    variant: row.variant === "default" ? null : row.variant,
    displayName: row.display_name,
    iconKey: row.item_id,
    category: row.category,
    bestAsk: row.best_ask,
    bestBid: row.best_bid,
    availableSellQuantity: row.sell_quantity,
    availableBuyQuantity: row.buy_quantity,
    lastTradePrice: row.last_trade_price,
    bookVersion: row.book_version ?? "0",
    ...(row.copy_tag && row.copy_buyer_name
      ? { provenance: { tag: row.copy_tag, originalBuyerName: row.copy_buyer_name } }
      : {}),
    // Only items that have a Glimmer book carry these, keeping Gold-only rows unchanged.
    ...(row.glimmer_book_version
      ? {
          glimmerBestAsk: row.glimmer_best_ask ?? null,
          glimmerBestBid: row.glimmer_best_bid ?? null,
          glimmerSellQuantity: row.glimmer_sell_quantity ?? "0",
          glimmerBuyQuantity: row.glimmer_buy_quantity ?? "0",
          glimmerBookVersion: row.glimmer_book_version
        }
      : {})
  };
}

export function orderSnapshot(row: OrderRow): MarketOrderSnapshot {
  return {
    orderId: row.order_id,
    itemId: row.item_id,
    itemIdentity: row.item_identity,
    variant: row.variant === "default" ? null : row.variant,
    displayName: row.display_name,
    side: row.side,
    policy: row.order_policy,
    unitPrice: row.limit_unit_price,
    originalQuantity: row.original_quantity,
    filledQuantity: row.filled_quantity,
    remainingQuantity: row.remaining_quantity,
    status: row.status,
    prioritySequence: row.priority_sequence,
    createdAt: iso(row.created_at),
    cancelledAt: row.cancelled_at ? iso(row.cancelled_at) : null,
    completedAt: row.completed_at ? iso(row.completed_at) : null,
    // Gold stays implicit so existing snapshots keep their shape.
    ...(row.price_currency === "glimmer" ? { priceCurrency: "glimmer" as const } : {})
  };
}

function withPriceCurrency(summary: MarketItemSummary, priceCurrency: MarketPriceCurrency): MarketItemSummary {
  if (priceCurrency !== "glimmer") return summary;
  // A Glimmer book's own summary already is the Glimmer side.
  const {
    glimmerBestAsk: _ask,
    glimmerBestBid: _bid,
    glimmerSellQuantity: _sell,
    glimmerBuyQuantity: _buy,
    glimmerBookVersion: _version,
    ...own
  } = summary;
  void _ask; void _bid; void _sell; void _buy; void _version;
  return { ...own, priceCurrency };
}

function publicTrade(row: TradeRow): MarketPublicTrade {
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

async function equipmentListings(
    queryable: Queryable,
    venue: AuthorizedMarketVenue,
    playerId: string | null
  ): Promise<MarketEquipmentListingSnapshot[]> {
    const result = await queryable.query<{
      listing_id: string;
      venue_id: string;
      equipment_instance_id: string;
      seller_player_id: string;
      asking_price: string;
      status: MarketEquipmentListingSnapshot["status"];
      version: string;
      price_currency: MarketPriceCurrency;
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
    }>(
      `SELECT listing_id::text, venue_id::text,
              equipment_instance_id::text, seller_player_id,
              asking_price::text, status, version::text,
              presentation_snapshot, created_at, price_currency
       FROM market_equipment_listings
       WHERE venue_id = $1
         AND (
           ($2::text IS NULL AND status = 'open')
           OR (
             $2::text IS NOT NULL
             AND (
               seller_player_id = $2
               OR EXISTS (
                 SELECT 1
                 FROM market_equipment_collections collection
                 WHERE collection.listing_id =
                       market_equipment_listings.listing_id
                   AND collection.player_id = $2
                   AND collection.claimed_at IS NULL
               )
             )
           )
         )
       ORDER BY created_at DESC, listing_id DESC
       LIMIT 100`,
      [venue.venueId, playerId]
    );
    const buyerTaxBps = CITY_MARKET_STANDARD_BUYER_TAX_BPS;
    return result.rows.map((row) => {
      const askingPrice = BigInt(row.asking_price);
      const buyerTax =
        askingPrice * BigInt(buyerTaxBps) / 10_000n;
      return {
        listingId: row.listing_id,
        venueId: row.venue_id,
        ...row.presentation_snapshot,
        sellerPlayerId: row.seller_player_id,
        askingPrice: row.asking_price,
        buyerTax: buyerTax.toString(),
        buyerTotal: (askingPrice + buyerTax).toString(),
        buyerTaxBps,
        status: row.status,
        version: row.version,
        createdAt: iso(row.created_at),
        ...(row.price_currency === "glimmer" ? { priceCurrency: "glimmer" as const } : {})
      };
    });
  }

async function equipmentListingsForCollection(
    queryable: Queryable,
    venueId: string,
    playerId: string
  ): Promise<MarketEquipmentListingSnapshot[]> {
    const venue = await queryable.query<{
      venue_key: string;
      display_name: string;
      city_id: string;
      city_name: string;
      market_structure_id: string;
      active_monument_types: AuthorizedMarketVenue["activeMonumentTypes"];
      tax_revision: string;
    }>(
      `SELECT venue.venue_key, venue.display_name, city.id::text AS city_id,
              city.name AS city_name,
              venue.market_structure_id::text,
              ARRAY(
                SELECT monument.district_type
                FROM city_structures monument
                WHERE monument.city_id = city.id
                  AND monument.structure_type = 'monument'
                  AND monument.state = 'active'
                  AND monument.district_type IN ('mining', 'forestry', 'hunting')
                ORDER BY monument.district_type
              ) AS active_monument_types,
              venue.tax_revision::text
       FROM market_venues venue
       JOIN cities city ON city.id = venue.city_id
       WHERE venue.venue_id = $1`,
      [venueId]
    );
    const row = venue.rows[0];
    if (!row) return [];
    return equipmentListings(
      queryable,
      {
        sessionId: crypto.randomUUID(),
        venueId,
        venueKey: row.venue_key,
        displayName: row.display_name,
        cityId: row.city_id,
        cityName: row.city_name,
        marketStructureId: row.market_structure_id,
        activeMonumentTypes: row.active_monument_types,
        taxRevision: row.tax_revision,
        relocationRevision: 0
      },
      playerId
    ).then((listings) =>
      listings.filter((listing) =>
        ["sold", "cancelled"].includes(listing.status)
      )
    );
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function encodeCursor(value: { name: string; itemIdentity: string }): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCursor(raw: string | null): { name: string; itemIdentity: string } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown;
    if (
      !parsed || typeof parsed !== "object" ||
      typeof (parsed as { name?: unknown }).name !== "string" ||
      typeof (parsed as { itemIdentity?: unknown }).itemIdentity !== "string"
    ) throw new Error("invalid cursor");
    return {
      name: (parsed as { name: string }).name,
      itemIdentity: (parsed as { itemIdentity: string }).itemIdentity
    };
  } catch {
    throw new Error("Invalid market cursor");
  }
}
