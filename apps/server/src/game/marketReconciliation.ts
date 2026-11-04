import type {
  MarketReconciliationIssue,
  MarketReconciliationReport
} from "@ash-atlas/shared";
import type pg from "pg";

import { reconcileDroppedItemCustody } from "./droppedItemReconciliation.js";
import { reconcileMarketDomainBoundaries } from "./marketReconciliationBoundaries.js";
import {
  applyMarketReconciliationFailure,
  marketAutomaticProtectionEnabled,
  type MarketProtectionResult,
  type MarketProtectionMode
} from "./marketReconciliationProtection.js";
import { isRetryablePostgresError } from "./marketRules.js";
import {
  acquireMarketReconciliationSafetyLock,
  MarketSafetyLockSessionError,
  releaseMarketReconciliationSafetyLock
} from "./marketSafetyLock.js";

type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

export type MarketReconciliationFreezeMode = MarketProtectionMode;

export type MarketReconciliationOptions = {
  recordCriticalAudit?: boolean;
  freezeOnFailure?: MarketReconciliationFreezeMode;
  honorAutomaticProtection?: boolean;
};

export type MarketReconciliationRunResult = {
  report: MarketReconciliationReport;
  protection: MarketProtectionResult;
};

export type MarketReconciliationRuntimeOptions = {
  statementTimeoutMs?: number;
  advisoryLockTimeoutMs?: number;
  transactionRetryLimit?: number;
};

type CountRow = {
  order_count: string;
  trade_count: string;
  ledger_group_count: string;
  collection_count: string;
};

type OrderRow = {
  order_id: string;
  venue_id: string;
  book_id: string;
  player_id: string;
  account_id: string;
  item_identity: string;
  item_id: string;
  variant: string;
  side: "buy" | "sell";
  order_policy: "gtc" | "aon_ioc";
  limit_unit_price: string;
  original_quantity: string;
  filled_quantity: string;
  remaining_quantity: string;
  status: "open" | "partially_filled" | "filled" | "cancelled" | "expired";
  cancelled_at: Date | string | null;
  completed_at: Date | string | null;
  expired_at: Date | string | null;
  trade_quantity: string;
  trade_gold_spent: string;
  buyer_fee_bps: number;
  escrow_order_id: string | null;
  escrow_player_id: string | null;
  escrow_asset_kind: "item" | "gold" | "glimmer" | null;
  escrow_item_identity: string | null;
  escrow_item_id: string | null;
  escrow_variant: string | null;
  escrow_initial_amount: string | null;
  escrow_remaining_amount: string | null;
  escrow_ledger_net: string;
  escrow_group_count: string;
  cancel_group_count: string;
  premium_asset?: boolean;
  premium_fee_bps?: number | null;
  premium_fee_reserve?: string | null;
  price_currency?: "gold" | "glimmer" | null;
};

type TradeRow = {
  trade_id: string;
  venue_id: string;
  book_id: string;
  item_identity: string;
  item_id: string;
  variant: string;
  buy_order_id: string;
  sell_order_id: string;
  buyer_player_id: string;
  seller_player_id: string;
  maker_order_id: string;
  quantity: string;
  unit_price: string;
  gross_value: string;
  buyer_fee: string;
  seller_fee: string;
  buyer_fee_policy_id: number;
  buyer_fee_policy_version: number;
  seller_fee_policy_id: number;
  seller_fee_policy_version: number;
  buy_exists: boolean;
  sell_exists: boolean;
  buy_side: string | null;
  sell_side: string | null;
  buy_venue_id: string | null;
  sell_venue_id: string | null;
  buy_book_id: string | null;
  sell_book_id: string | null;
  buy_item_identity: string | null;
  sell_item_identity: string | null;
  buy_item_id: string | null;
  sell_item_id: string | null;
  buy_variant: string | null;
  sell_variant: string | null;
  buy_player_id: string | null;
  sell_player_id: string | null;
  buy_account_id: string | null;
  sell_account_id: string | null;
  buy_limit_unit_price: string | null;
  buy_order_policy: "gtc" | "aon_ioc" | null;
  buy_fee_policy_id: number | null;
  buy_fee_policy_version: number | null;
  buy_remaining_before: string | null;
  sell_limit_unit_price: string | null;
  sell_fee_policy_id: number | null;
  sell_fee_policy_version: number | null;
  maker_limit_unit_price: string | null;
  maker_matches_order: boolean;
  buyer_policy_exists: boolean;
  seller_policy_exists: boolean;
  buyer_fee_bps: number | null;
  buy_reserve_buyer_fee_bps: number | null;
  seller_fee_bps: number | null;
  trade_group_count: string;
  trade_item_entry_count: string;
  trade_gold_entry_count: string;
};

type LedgerGroupRow = {
  ledger_group_id: string;
  group_type: "order_escrow" | "trade" | "cancel" | "claim" | "fee" | "administrative";
  request_id: string | null;
  order_id: string | null;
  trade_id: string | null;
  venue_id: string | null;
  book_id: string | null;
  player_id: string | null;
  asset_kind: "item" | "gold" | null;
  item_identity: string | null;
  order_fee_policy_id: number | null;
  order_fee_policy_version: number | null;
  buyer_fee_policy_id: number | null;
  buyer_fee_policy_version: number | null;
  seller_fee_policy_id: number | null;
  seller_fee_policy_version: number | null;
  fee_provenance_valid: boolean;
  entry_count: string;
  balance: string;
};

type LedgerEntryIssueRow = {
  ledger_entry_id: string;
  ledger_group_id: string;
  group_type: string;
  asset_kind: string;
  item_identity: string | null;
  account_location: string;
  player_id: string | null;
  order_id: string | null;
  trade_id: string | null;
  collection_id: string | null;
  group_order_id: string | null;
  group_trade_id: string | null;
  venue_id: string | null;
  book_id: string | null;
};

type CollectionRow = {
  collection_id: string;
  player_id: string;
  asset_kind: "item" | "gold";
  item_identity: string | null;
  item_id: string | null;
  variant: string | null;
  original_amount: string;
  remaining_amount: string;
  reason:
    | "purchase"
    | "sell_proceeds"
    | "sell_cancel_return"
    | "buy_cancel_refund"
    | "price_improvement_refund"
    | "sell_expired_return"
    | "buy_expired_refund";
  source_order_id: string | null;
  source_trade_id: string | null;
  claimed_at: Date | string | null;
  ledger_net: string;
  ledger_positive: string;
  ledger_negative: string;
  creation_group_matches: boolean;
  source_order_exists: boolean;
  source_order_side: string | null;
  source_order_status: string | null;
  source_order_player_id: string | null;
  source_order_book_id: string | null;
  source_order_item_identity: string | null;
  source_order_item_id: string | null;
  source_order_variant: string | null;
  source_order_limit_unit_price: string | null;
  source_order_remaining_quantity: string | null;
  source_trade_exists: boolean;
  source_trade_book_id: string | null;
  source_trade_item_identity: string | null;
  source_trade_item_id: string | null;
  source_trade_variant: string | null;
  source_trade_buy_order_id: string | null;
  source_trade_sell_order_id: string | null;
  source_trade_buyer_player_id: string | null;
  source_trade_seller_player_id: string | null;
  source_trade_quantity: string | null;
  source_trade_unit_price: string | null;
  source_trade_gross_value: string | null;
  source_trade_seller_fee: string | null;
};

type WalletRow = {
  player_id: string;
  account_id: string;
  player_account_id: string | null;
  gold_balance: string;
  wallet_version: string;
  event_total: string;
  event_count: string;
  latest_balance_after: string | null;
  latest_version_after: string | null;
};

type WalletChainIssueRow = {
  event_id: string;
  player_id: string;
  account_id: string;
  delta_gold: string;
  balance_after: string;
  previous_balance: string;
  version_after: string;
  expected_version: string;
};

type WalletOrphanRow = {
  event_id: string;
  player_id: string;
  account_id: string;
  market_order_id: string | null;
  market_trade_id: string | null;
  wallet_exists: boolean;
  order_exists: boolean;
  trade_exists: boolean;
};

type OrphanEscrowRow = {
  order_id: string;
  player_id: string;
};

type NegativeStateRow = {
  entity_type: string;
  entity_id: string;
  book_id: string | null;
  player_id: string | null;
  details: Record<string, unknown> | string;
};

export type MarketReconciliationSnapshot = {
  counts: CountRow;
  orders: OrderRow[];
  trades: TradeRow[];
  ledgerGroups: LedgerGroupRow[];
  ledgerEntryIssues: LedgerEntryIssueRow[];
  collections: CollectionRow[];
  wallets: WalletRow[];
  walletChainIssues: WalletChainIssueRow[];
  walletOrphans: WalletOrphanRow[];
  orphanEscrows: OrphanEscrowRow[];
  negativeStates: NegativeStateRow[];
};

export class MarketReconciliationService {
  private readonly statementTimeoutMs: number;
  private readonly advisoryLockTimeoutMs: number;
  private readonly transactionRetryLimit: number;

  constructor(
    private readonly pool: pg.Pool,
    private readonly now: () => Date = () => new Date(),
    options: MarketReconciliationRuntimeOptions = {}
  ) {
    this.statementTimeoutMs = positiveSafeInteger(
      options.statementTimeoutMs ?? 30_000,
      "statement timeout"
    );
    this.advisoryLockTimeoutMs = positiveSafeInteger(
      options.advisoryLockTimeoutMs ?? 15_000,
      "advisory-lock timeout"
    );
    this.transactionRetryLimit = nonnegativeSafeInteger(
      options.transactionRetryLimit ?? 3,
      "transaction retry limit"
    );
  }

  async reconcile(options: MarketReconciliationOptions = {}): Promise<MarketReconciliationReport> {
    return (await this.reconcileRun(options)).report;
  }

  async reconcileRun(
    options: MarketReconciliationOptions = {}
  ): Promise<MarketReconciliationRunResult> {
    const client = await this.pool.connect();
    let lockHeld = false;
    let operationError: unknown;
    let result: MarketReconciliationRunResult | undefined;
    try {
      // This session-level lock is intentionally acquired before BEGIN. A
      // repeatable-read snapshot opened while waiting on a row/xact lock can be
      // older than the mutation it waited for; acquiring the session lock first
      // drains those mutations before PostgreSQL assigns the snapshot.
      await acquireMarketReconciliationSafetyLock(client, this.advisoryLockTimeoutMs);
      lockHeld = true;
      result = await this.reconcileWhileLocked(client, options);
    } catch (error) {
      operationError = error;
    }
    let releaseError: unknown;
    if (lockHeld) {
      try {
        await releaseMarketReconciliationSafetyLock(client);
      } catch (error) {
        releaseError = error;
      }
    }
    const destroyReason = releaseError instanceof Error
      ? releaseError
      : operationError instanceof MarketSafetyLockSessionError
        ? operationError
        : undefined;
    client.release(destroyReason);
    if (operationError) throw operationError;
    if (releaseError) throw releaseError;
    if (!result) throw new Error("Market reconciliation completed without a result");
    return result;
  }

  private async reconcileWhileLocked(
    client: pg.PoolClient,
    options: MarketReconciliationOptions
  ): Promise<MarketReconciliationRunResult> {
    for (let attempt = 0; attempt <= this.transactionRetryLimit; attempt += 1) {
      let began = false;
      try {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
        began = true;
        await client.query("SELECT set_config('statement_timeout', $1, true)", [
          `${this.statementTimeoutMs}ms`
        ]);
        const report = await this.reconcileWithQueryable(client);
        let protection: MarketProtectionResult = {
          protectionApplied: false,
          auditRecorded: false,
          globalReadOnly: false,
          affectedBookIds: affectedBookIds(report),
          frozenBookIds: []
        };

        if (!report.ok) {
          const automaticProtection =
            options.honorAutomaticProtection !== false &&
            await marketAutomaticProtectionEnabled(client);
          const freezeMode = options.freezeOnFailure ??
            (automaticProtection ? "affected_books" : "none");
          const recordCriticalAudit = Boolean(options.recordCriticalAudit || automaticProtection);
          if (recordCriticalAudit || freezeMode !== "none") {
            protection = await applyMarketReconciliationFailure(client, report, {
              recordCriticalAudit,
              freezeMode
            });
          }
        }

        const global = await client.query<{ read_only: boolean }>(
          "SELECT read_only FROM market_global_controls WHERE singleton"
        );
        protection.globalReadOnly = global.rows[0]?.read_only === true;
        await client.query("COMMIT");
        began = false;
        return { report, protection };
      } catch (error) {
        if (began) await rollbackQuietly(client);
        if (isRetryablePostgresError(error) && attempt < this.transactionRetryLimit) continue;
        throw error;
      }
    }
    throw new Error("Market reconciliation transaction retry limit reached");
  }

  async reconcileWithQueryable(queryable: Queryable): Promise<MarketReconciliationReport> {
    const snapshot = await loadMarketReconciliationSnapshot(queryable);
    const report = buildMarketReconciliationReport(snapshot, this.now());
    const boundaryIssues = await reconcileMarketDomainBoundaries(queryable);
    const droppedItemIssues = await reconcileDroppedItemCustody(queryable);
    const exactEquipmentIssues = await reconcileExactEquipmentMarket(queryable);
    const additionalIssues = [
      ...boundaryIssues,
      ...droppedItemIssues,
      ...exactEquipmentIssues
    ];
    if (additionalIssues.length === 0) return report;
    return {
      ...report,
      ok: false,
      issues: [...report.issues, ...additionalIssues]
    };
  }
}

async function reconcileExactEquipmentMarket(
  queryable: Queryable
): Promise<MarketReconciliationIssue[]> {
  const rows = await queryable.query<{
    code: string;
    listing_id: string | null;
    equipment_instance_id: string;
    listing_venue_id: string | null;
    collection_venue_id: string | null;
    location: string;
    owner_player_id: string;
  }>(`
    SELECT
      CASE
        WHEN listing.status = 'open'
         AND equipment.location <> 'market_escrow'
          THEN 'EQUIPMENT_ESCROW_LOCATION_MISMATCH'
        WHEN listing.status IN ('sold', 'cancelled')
         AND equipment.location <> 'market_collection'
          THEN 'EQUIPMENT_COLLECTION_LOCATION_MISMATCH'
        WHEN collection.collection_id IS NOT NULL
         AND collection.venue_id <> listing.venue_id
          THEN 'EQUIPMENT_COLLECTION_VENUE_MISMATCH'
        WHEN collection.collection_id IS NOT NULL
         AND equipment.owner_player_id <> collection.player_id
          THEN 'EQUIPMENT_COLLECTION_OWNER_MISMATCH'
        ELSE NULL
      END AS code,
      listing.listing_id::text,
      equipment.instance_id::text AS equipment_instance_id,
      listing.venue_id::text AS listing_venue_id,
      collection.venue_id::text AS collection_venue_id,
      equipment.location,
      equipment.owner_player_id
    FROM market_equipment_listings listing
    JOIN equipment_instances equipment
      ON equipment.instance_id = listing.equipment_instance_id
    LEFT JOIN market_equipment_collections collection
      ON collection.listing_id = listing.listing_id
     AND collection.claimed_at IS NULL
    WHERE
      (listing.status = 'open' AND equipment.location <> 'market_escrow')
      OR (
        listing.status IN ('sold', 'cancelled')
        AND equipment.location <> 'market_collection'
      )
      OR (
        collection.collection_id IS NOT NULL
        AND (
          collection.venue_id <> listing.venue_id
          OR equipment.owner_player_id <> collection.player_id
        )
      )
  `);
  const duplicateRows = await queryable.query<{
    equipment_instance_id: string;
    custody_count: string;
  }>(`
    SELECT equipment_instance_id::text, count(*)::text AS custody_count
    FROM (
      SELECT equipment_instance_id
      FROM market_equipment_listings
      WHERE status = 'open'
      UNION ALL
      SELECT equipment_instance_id
      FROM market_equipment_collections
      WHERE claimed_at IS NULL
    ) custody
    GROUP BY equipment_instance_id
    HAVING count(*) > 1
  `);
  return [
    ...rows.rows.map((row): MarketReconciliationIssue => ({
      code: row.code,
      scope: "market_equipment",
      entityId: row.listing_id,
      details: {
        equipmentInstanceId: row.equipment_instance_id,
        listingVenueId: row.listing_venue_id,
        collectionVenueId: row.collection_venue_id,
        location: row.location,
        ownerPlayerId: row.owner_player_id
      }
    })),
    ...duplicateRows.rows.map((row): MarketReconciliationIssue => ({
      code: "EQUIPMENT_DUPLICATE_MARKET_CUSTODY",
      scope: "market_equipment",
      entityId: row.equipment_instance_id,
      details: { custodyCount: row.custody_count }
    }))
  ];
}

function affectedBookIds(report: MarketReconciliationReport): string[] {
  return [...new Set(report.issues
    .map((issue) => issue.details.bookId)
    .filter((value): value is string => typeof value === "string" && value.length > 0))]
    .sort();
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Market reconciliation ${name} must be a positive safe integer`);
  }
  return value;
}

function nonnegativeSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Market reconciliation ${name} must be a nonnegative safe integer`);
  }
  return value;
}

export async function loadMarketReconciliationSnapshot(
  queryable: Queryable
): Promise<MarketReconciliationSnapshot> {
  const counts = await queryable.query<CountRow>(COUNT_QUERY);
  const orders = await queryable.query<OrderRow>(ORDER_QUERY);
  const trades = await queryable.query<TradeRow>(TRADE_QUERY);
  const ledgerGroups = await queryable.query<LedgerGroupRow>(LEDGER_GROUP_QUERY);
  const ledgerEntryIssues = await queryable.query<LedgerEntryIssueRow>(LEDGER_ENTRY_ISSUE_QUERY);
  const collections = await queryable.query<CollectionRow>(COLLECTION_QUERY);
  const wallets = await queryable.query<WalletRow>(WALLET_QUERY);
  const walletChainIssues = await queryable.query<WalletChainIssueRow>(WALLET_CHAIN_ISSUE_QUERY);
  const walletOrphans = await queryable.query<WalletOrphanRow>(WALLET_ORPHAN_QUERY);
  const orphanEscrows = await queryable.query<OrphanEscrowRow>(ORPHAN_ESCROW_QUERY);
  const negativeStates = await queryable.query<NegativeStateRow>(NEGATIVE_STATE_QUERY);
  const countRow = counts.rows[0];
  if (!countRow) throw new Error("Market reconciliation count query returned no row");
  return {
    counts: countRow,
    orders: orders.rows,
    trades: trades.rows,
    ledgerGroups: ledgerGroups.rows,
    ledgerEntryIssues: ledgerEntryIssues.rows,
    collections: collections.rows,
    wallets: wallets.rows,
    walletChainIssues: walletChainIssues.rows,
    walletOrphans: walletOrphans.rows,
    orphanEscrows: orphanEscrows.rows,
    negativeStates: negativeStates.rows
  };
}

export function buildMarketReconciliationReport(
  snapshot: MarketReconciliationSnapshot,
  checkedAt = new Date()
): MarketReconciliationReport {
  const issues: MarketReconciliationIssue[] = [];
  const add = (
    code: string,
    scope: string,
    entityId: string | null,
    details: Record<string, unknown>
  ) => issues.push({ code, scope, entityId, details });

  for (const order of snapshot.orders) {
    const context = orderContext(order);
    const original = BigInt(order.original_quantity);
    const filled = BigInt(order.filled_quantity);
    const remaining = BigInt(order.remaining_quantity);
    const traded = BigInt(order.trade_quantity);
    const limit = BigInt(order.limit_unit_price);
    if (filled + remaining !== original) {
      add("ORDER_QUANTITY_MISMATCH", "order", order.order_id, {
        ...context,
        originalQuantity: order.original_quantity,
        filledQuantity: order.filled_quantity,
        remainingQuantity: order.remaining_quantity
      });
    }
    const statusValid =
      (order.status === "open" && filled === 0n && remaining > 0n && !order.cancelled_at && !order.completed_at && !order.expired_at) ||
      (order.status === "partially_filled" && filled > 0n && remaining > 0n && !order.cancelled_at && !order.completed_at && !order.expired_at) ||
      (order.status === "filled" && remaining === 0n && filled === original && !order.cancelled_at && Boolean(order.completed_at) && !order.expired_at) ||
      (order.status === "cancelled" && remaining > 0n && Boolean(order.cancelled_at) && !order.completed_at && !order.expired_at) ||
      (order.status === "expired" && remaining > 0n && !order.cancelled_at && !order.completed_at && Boolean(order.expired_at));
    if (!statusValid) {
      add("ORDER_STATUS_MISMATCH", "order", order.order_id, {
        ...context,
        status: order.status,
        originalQuantity: order.original_quantity,
        filledQuantity: order.filled_quantity,
        remainingQuantity: order.remaining_quantity,
        cancelledAt: isoOrNull(order.cancelled_at),
        completedAt: isoOrNull(order.completed_at),
        expiredAt: isoOrNull(order.expired_at)
      });
    }
    if (traded !== filled) {
      add("ORDER_TRADE_QUANTITY_MISMATCH", "order", order.order_id, {
        ...context,
        filledQuantity: order.filled_quantity,
        tradeQuantity: order.trade_quantity
      });
    }
    if (!order.escrow_order_id) {
      add("ORDER_ESCROW_MISSING", "order", order.order_id, context);
    } else {
      const expectedKind = order.side === "sell"
        ? "item"
        : order.price_currency === "glimmer" ? "glimmer" : "gold";
      if (
        order.escrow_player_id !== order.player_id ||
        order.escrow_asset_kind !== expectedKind ||
        (order.side === "sell" && (
          order.escrow_item_identity !== order.item_identity ||
          order.escrow_item_id !== order.item_id ||
          order.escrow_variant !== order.variant
        )) ||
        (order.side === "buy" && (
          order.escrow_item_identity !== null ||
          order.escrow_item_id !== null ||
          order.escrow_variant !== null
        ))
      ) {
        add("ORDER_ESCROW_ASSET_MISMATCH", "order", order.order_id, {
          ...context,
          side: order.side,
          escrowPlayerId: order.escrow_player_id,
          escrowAssetKind: order.escrow_asset_kind,
          escrowItemIdentity: order.escrow_item_identity,
          escrowItemId: order.escrow_item_id,
          escrowVariant: order.escrow_variant
        });
      }
      if (order.premium_asset && order.side === "sell" && order.premium_fee_reserve == null) {
        add("PREMIUM_ORDER_FEE_TERMS_MISSING", "order", order.order_id, context);
      }
      const premiumReserve = BigInt(order.premium_fee_reserve ?? "0");
      const premiumUnusedReserve = order.premium_fee_bps == null
        ? 0n
        : premiumReserve - premiumFee(filled, order.premium_fee_bps);
      const initial = BigInt(order.escrow_initial_amount ?? "0");
      const escrowRemaining = BigInt(order.escrow_remaining_amount ?? "0");
      const limitValue = limit * original;
      const expectedInitial = order.side === "sell"
        ? original + premiumReserve
        : order.order_policy === "aon_ioc"
          ? BigInt(order.trade_gold_spent)
          : limitValue + fee(limitValue, order.buyer_fee_bps);
      const remainingLimitValue = limit * remaining;
      const expectedRemaining =
        order.status === "open" || order.status === "partially_filled"
          ? order.side === "sell"
            ? remaining + premiumUnusedReserve
            : remainingLimitValue + fee(remainingLimitValue, order.buyer_fee_bps)
          : 0n;
      if (initial !== expectedInitial) {
        add("ORDER_ESCROW_INITIAL_MISMATCH", "order", order.order_id, {
          ...context,
          expected: expectedInitial.toString(),
          actual: initial.toString()
        });
      }
      if (escrowRemaining !== expectedRemaining) {
        add(
          order.status === "filled" || order.status === "cancelled" || order.status === "expired"
            ? "CLOSED_ORDER_ESCROW_NONZERO"
            : "ORDER_ESCROW_REMAINDER_MISMATCH",
          "order",
          order.order_id,
          {
            ...context,
            status: order.status,
            expected: expectedRemaining.toString(),
            actual: escrowRemaining.toString()
          }
        );
      }
      if (BigInt(order.escrow_ledger_net) !== escrowRemaining) {
        add("ORDER_ESCROW_LEDGER_BALANCE_MISMATCH", "order", order.order_id, {
          ...context,
          escrowRemaining: escrowRemaining.toString(),
          escrowLedgerNet: order.escrow_ledger_net
        });
      }
    }
    if (BigInt(order.escrow_group_count) !== 1n) {
      add("ORDER_ESCROW_LEDGER_GROUP_MISMATCH", "order", order.order_id, {
        ...context,
        groupCount: order.escrow_group_count
      });
    }
    const expectedCancelGroups =
      order.status === "cancelled" || order.status === "expired" ? 1n : 0n;
    if (BigInt(order.cancel_group_count) !== expectedCancelGroups) {
      add("ORDER_CANCEL_LEDGER_GROUP_MISMATCH", "order", order.order_id, {
        ...context,
        expected: expectedCancelGroups.toString(),
        actual: order.cancel_group_count
      });
    }
  }

  for (const trade of snapshot.trades) {
    const context = tradeContext(trade);
    const quantity = BigInt(trade.quantity);
    const unitPrice = BigInt(trade.unit_price);
    const gross = BigInt(trade.gross_value);
    if (gross !== quantity * unitPrice) {
      add("TRADE_GROSS_VALUE_MISMATCH", "trade", trade.trade_id, {
        ...context,
        quantity: trade.quantity,
        unitPrice: trade.unit_price,
        grossValue: trade.gross_value
      });
    }
    if (
      !trade.buy_exists || !trade.sell_exists ||
      trade.buy_side !== "buy" || trade.sell_side !== "sell" ||
      trade.buy_venue_id !== trade.venue_id || trade.sell_venue_id !== trade.venue_id ||
      trade.buy_book_id !== trade.book_id || trade.sell_book_id !== trade.book_id ||
      trade.buy_item_identity !== trade.item_identity || trade.sell_item_identity !== trade.item_identity ||
      trade.buy_item_id !== trade.item_id || trade.sell_item_id !== trade.item_id ||
      trade.buy_variant !== trade.variant || trade.sell_variant !== trade.variant ||
      trade.buy_player_id !== trade.buyer_player_id || trade.sell_player_id !== trade.seller_player_id ||
      trade.sell_fee_policy_id !== trade.seller_fee_policy_id ||
      trade.sell_fee_policy_version !== trade.seller_fee_policy_version
    ) {
      add("TRADE_ORDER_REFERENCE_MISMATCH", "trade", trade.trade_id, {
        ...context,
        buyOrderId: trade.buy_order_id,
        sellOrderId: trade.sell_order_id
      });
    }
    if (
      trade.buyer_player_id === trade.seller_player_id ||
      (trade.buy_account_id !== null && trade.buy_account_id === trade.sell_account_id)
    ) {
      add("TRADE_SELF_MATCH", "trade", trade.trade_id, {
        ...context,
        buyerPlayerId: trade.buyer_player_id,
        sellerPlayerId: trade.seller_player_id,
        accountId: trade.buy_account_id
      });
    }
    const buyLimit = BigInt(trade.buy_limit_unit_price ?? "0");
    const sellLimit = BigInt(trade.sell_limit_unit_price ?? "0");
    const makerLimit = BigInt(trade.maker_limit_unit_price ?? "0");
    if (buyLimit < unitPrice || sellLimit > unitPrice) {
      add("TRADE_OUTSIDE_ORDER_LIMITS", "trade", trade.trade_id, {
        ...context,
        buyLimit: buyLimit.toString(),
        sellLimit: sellLimit.toString(),
        unitPrice: unitPrice.toString()
      });
    }
    if (!trade.maker_matches_order || makerLimit !== unitPrice) {
      add("TRADE_MAKER_PRICE_MISMATCH", "trade", trade.trade_id, {
        ...context,
        makerOrderId: trade.maker_order_id,
        makerLimit: makerLimit.toString(),
        unitPrice: unitPrice.toString()
      });
    }
    if (
      !trade.buyer_policy_exists || !trade.seller_policy_exists ||
      trade.buyer_fee_bps === null || trade.seller_fee_bps === null
    ) {
      add("TRADE_FEE_POLICY_MISSING", "trade", trade.trade_id, {
        ...context,
        buyerFeePolicyId: trade.buyer_fee_policy_id,
        buyerFeePolicyVersion: trade.buyer_fee_policy_version,
        sellerFeePolicyId: trade.seller_fee_policy_id,
        sellerFeePolicyVersion: trade.seller_fee_policy_version
      });
    } else {
      const expectedBuyerFee = fee(gross, trade.buyer_fee_bps);
      const expectedSellerFee = fee(gross, trade.seller_fee_bps);
      if (
        BigInt(trade.buyer_fee) !== expectedBuyerFee ||
        BigInt(trade.seller_fee) !== expectedSellerFee
      ) {
        add("TRADE_FEE_MISMATCH", "trade", trade.trade_id, {
          ...context,
          expectedBuyerFee: expectedBuyerFee.toString(),
          actualBuyerFee: trade.buyer_fee,
          expectedSellerFee: expectedSellerFee.toString(),
          actualSellerFee: trade.seller_fee
        });
      }
    }
    if (BigInt(trade.trade_group_count) !== 1n) {
      add("TRADE_LEDGER_GROUP_MISMATCH", "trade", trade.trade_id, {
        ...context,
        groupCount: trade.trade_group_count
      });
    }
    if (BigInt(trade.trade_item_entry_count) === 0n || BigInt(trade.trade_gold_entry_count) === 0n) {
      add("TRADE_LEDGER_ASSET_MISSING", "trade", trade.trade_id, {
        ...context,
        itemEntryCount: trade.trade_item_entry_count,
        goldEntryCount: trade.trade_gold_entry_count
      });
    }
  }

  for (const group of snapshot.ledgerGroups) {
    const context = compactDetails({
      venueId: group.venue_id,
      bookId: group.book_id,
      playerId: group.player_id,
      groupType: group.group_type,
      assetKind: group.asset_kind,
      itemIdentity: group.item_identity,
      orderFeePolicyId: group.order_fee_policy_id,
      orderFeePolicyVersion: group.order_fee_policy_version,
      buyerFeePolicyId: group.buyer_fee_policy_id,
      buyerFeePolicyVersion: group.buyer_fee_policy_version,
      sellerFeePolicyId: group.seller_fee_policy_id,
      sellerFeePolicyVersion: group.seller_fee_policy_version
    });
    const entryCount = BigInt(group.entry_count);
    if (entryCount === 0n) {
      add("LEDGER_GROUP_EMPTY", "ledger_group", group.ledger_group_id, context);
    } else if (BigInt(group.balance) !== 0n) {
      add("LEDGER_GROUP_UNBALANCED", "ledger_group", group.ledger_group_id, {
        ...context,
        balance: group.balance,
        entryCount: group.entry_count
      });
    }
    const referenceValid =
      ((group.group_type === "order_escrow" || group.group_type === "cancel") && group.order_id !== null) ||
      (group.group_type === "trade" && group.trade_id !== null) ||
      (group.group_type === "claim" && group.request_id !== null) ||
      group.group_type === "fee" ||
      group.group_type === "administrative";
    if (!referenceValid) {
      add("LEDGER_GROUP_REFERENCE_MISSING", "ledger_group", group.ledger_group_id, context);
    }
    if (!group.fee_provenance_valid) {
      add(
        "LEDGER_GROUP_FEE_PROVENANCE_MISMATCH",
        "ledger_group",
        group.ledger_group_id,
        context
      );
    }
  }

  for (const entry of snapshot.ledgerEntryIssues) {
    add("LEDGER_ENTRY_LOCATION_MISMATCH", "ledger_entry", entry.ledger_entry_id, compactDetails({
      venueId: entry.venue_id,
      bookId: entry.book_id,
      playerId: entry.player_id,
      ledgerGroupId: entry.ledger_group_id,
      groupType: entry.group_type,
      assetKind: entry.asset_kind,
      itemIdentity: entry.item_identity,
      accountLocation: entry.account_location,
      orderId: entry.order_id,
      tradeId: entry.trade_id,
      collectionId: entry.collection_id,
      groupOrderId: entry.group_order_id,
      groupTradeId: entry.group_trade_id
    }));
  }

  const collectionTotals = new Map<string, bigint>();
  for (const collection of snapshot.collections) {
    const context = collectionContext(collection);
    const original = BigInt(collection.original_amount);
    const remaining = BigInt(collection.remaining_amount);
    const claimed = original - remaining;
    if ((remaining === 0n) !== Boolean(collection.claimed_at)) {
      add("COLLECTION_CLAIM_STATE_MISMATCH", "collection", collection.collection_id, {
        ...context,
        originalAmount: collection.original_amount,
        remainingAmount: collection.remaining_amount,
        claimedAt: isoOrNull(collection.claimed_at)
      });
    }
    if (
      BigInt(collection.ledger_net) !== remaining ||
      BigInt(collection.ledger_positive) !== original ||
      -BigInt(collection.ledger_negative) !== claimed
    ) {
      add("COLLECTION_LEDGER_MISMATCH", "collection", collection.collection_id, {
        ...context,
        originalAmount: original.toString(),
        remainingAmount: remaining.toString(),
        ledgerNet: collection.ledger_net,
        ledgerPositive: collection.ledger_positive,
        ledgerNegative: collection.ledger_negative
      });
    }
    if (!validCollectionSource(collection)) {
      add("COLLECTION_SOURCE_MISMATCH", "collection", collection.collection_id, context);
    }
    if (!collection.creation_group_matches) {
      add("COLLECTION_CREATION_LEDGER_GROUP_MISMATCH", "collection", collection.collection_id, context);
    }
    const sourceKey = collectionSourceKey(collection);
    if (sourceKey) collectionTotals.set(sourceKey, (collectionTotals.get(sourceKey) ?? 0n) + original);
  }

  for (const trade of snapshot.trades) {
    const context = tradeContext(trade);
    const quantity = BigInt(trade.quantity);
    const gross = BigInt(trade.gross_value);
    const sellerProceeds = gross - BigInt(trade.seller_fee);
    const improvement = expectedPriceImprovementRefund(trade);
    const legacyKeys = [
      `trade:${trade.trade_id}:purchase`,
      `trade:${trade.trade_id}:sell_proceeds`,
      `trade:${trade.trade_id}:price_improvement_refund`
    ];
    if (legacyKeys.some((key) => collectionTotals.has(key))) {
      assertCollectionTotal(add, collectionTotals, legacyKeys[0]!, quantity,
        "TRADE_PURCHASE_COLLECTION_MISMATCH", "trade", trade.trade_id, context);
      assertCollectionTotal(add, collectionTotals, legacyKeys[1]!, sellerProceeds,
        "TRADE_PROCEEDS_COLLECTION_MISMATCH", "trade", trade.trade_id, context);
      assertCollectionTotal(add, collectionTotals, legacyKeys[2]!, improvement,
        "TRADE_PRICE_IMPROVEMENT_COLLECTION_MISMATCH", "trade", trade.trade_id, context);
    }
  }

  for (const order of snapshot.orders) {
    if (order.status !== "cancelled" && order.status !== "expired") continue;
    // Premium escrow returns straight to the premium wallet; there is no Collection.
    if (order.premium_asset && order.side === "sell") continue;
    if (order.side === "buy" && order.price_currency === "glimmer") continue;
    const expected = order.side === "sell"
      ? BigInt(order.remaining_quantity)
      : (() => {
          const remainingValue = BigInt(order.limit_unit_price) * BigInt(order.remaining_quantity);
          return remainingValue + fee(remainingValue, order.buyer_fee_bps);
        })();
    const reason = order.status === "expired"
      ? order.side === "sell" ? "sell_expired_return" : "buy_expired_refund"
      : order.side === "sell" ? "sell_cancel_return" : "buy_cancel_refund";
    const key = `order:${order.order_id}:${reason}`;
    if (order.status === "expired" || collectionTotals.has(key)) {
      assertCollectionTotal(
        add,
        collectionTotals,
        key,
        expected,
        order.status === "expired"
          ? "ORDER_EXPIRATION_COLLECTION_MISMATCH"
          : "ORDER_CANCEL_COLLECTION_MISMATCH",
        "order",
        order.order_id,
        orderContext(order)
      );
    }
  }

  for (const wallet of snapshot.wallets) {
    const context = { playerId: wallet.player_id, accountId: wallet.account_id };
    if (wallet.player_account_id !== wallet.account_id) {
      add("WALLET_ACCOUNT_MISMATCH", "wallet", wallet.player_id, {
        ...context,
        playerAccountId: wallet.player_account_id
      });
    }
    if (BigInt(wallet.gold_balance) !== BigInt(wallet.event_total)) {
      add("WALLET_EVENT_TOTAL_MISMATCH", "wallet", wallet.player_id, {
        ...context,
        goldBalance: wallet.gold_balance,
        eventTotal: wallet.event_total
      });
    }
    if (
      BigInt(wallet.wallet_version) !== BigInt(wallet.event_count)
      || BigInt(wallet.wallet_version) !== BigInt(wallet.latest_version_after ?? "0")
    ) {
      add("WALLET_EVENT_VERSION_MISMATCH", "wallet", wallet.player_id, {
        ...context,
        walletVersion: wallet.wallet_version,
        eventCount: wallet.event_count,
        latestVersionAfter: wallet.latest_version_after
      });
    }
    const expectedLatest = BigInt(wallet.event_count) === 0n ? 0n : BigInt(wallet.latest_balance_after ?? "0");
    if (BigInt(wallet.gold_balance) !== expectedLatest) {
      add("WALLET_LATEST_EVENT_MISMATCH", "wallet", wallet.player_id, {
        ...context,
        goldBalance: wallet.gold_balance,
        latestBalanceAfter: wallet.latest_balance_after,
        eventCount: wallet.event_count
      });
    }
  }

  for (const row of snapshot.walletChainIssues) {
    add("WALLET_EVENT_CHAIN_MISMATCH", "wallet_event", row.event_id, {
      playerId: row.player_id,
      accountId: row.account_id,
      deltaGold: row.delta_gold,
      previousBalance: row.previous_balance,
      balanceAfter: row.balance_after,
      versionAfter: row.version_after,
      expectedVersion: row.expected_version
    });
  }
  for (const row of snapshot.walletOrphans) {
    add("WALLET_EVENT_ORPHANED", "wallet_event", row.event_id, compactDetails({
      playerId: row.player_id,
      accountId: row.account_id,
      marketOrderId: row.market_order_id,
      marketTradeId: row.market_trade_id,
      walletExists: row.wallet_exists,
      orderExists: row.order_exists,
      tradeExists: row.trade_exists
    }));
  }
  for (const row of snapshot.orphanEscrows) {
    add("ORPHAN_ESCROW", "escrow", row.order_id, {
      playerId: row.player_id
    });
  }
  for (const row of snapshot.negativeStates) {
    const parsedDetails = typeof row.details === "string" ? safeJson(row.details) : row.details;
    add("NEGATIVE_OR_INVALID_STATE", row.entity_type, row.entity_id, {
      ...compactDetails({ bookId: row.book_id, playerId: row.player_id }),
      state: parsedDetails
    });
  }

  return {
    ok: issues.length === 0,
    checkedAt: checkedAt.toISOString(),
    orderCount: safeCount(snapshot.counts.order_count),
    tradeCount: safeCount(snapshot.counts.trade_count),
    ledgerGroupCount: safeCount(snapshot.counts.ledger_group_count),
    collectionCount: safeCount(snapshot.counts.collection_count),
    issues
  };
}

const COUNT_QUERY = `/* market-reconcile:counts */
  SELECT
    (SELECT count(*) FROM market_orders)::text AS order_count,
    (SELECT count(*) FROM market_trades)::text AS trade_count,
    (SELECT count(*) FROM market_ledger_groups)::text AS ledger_group_count,
    (SELECT count(*) FROM market_collections)::text AS collection_count
`;

const ORDER_QUERY = `/* market-reconcile:orders */
  WITH order_trade_totals AS (
    SELECT order_id, sum(quantity)::text AS trade_quantity
    FROM (
      SELECT buy_order_id AS order_id, quantity FROM market_trades
      UNION ALL
      SELECT sell_order_id AS order_id, quantity FROM market_trades
    ) sides
    GROUP BY order_id
  )
  SELECT o.order_id, o.venue_id, o.book_id, o.player_id, o.account_id,
         o.item_identity, o.item_id, o.variant, o.side, o.order_policy,
         o.limit_unit_price::text, o.original_quantity::text,
         o.filled_quantity::text, o.remaining_quantity::text, o.status,
         o.cancelled_at, o.completed_at, o.expired_at,
         coalesce(tt.trade_quantity, '0') AS trade_quantity,
         coalesce((SELECT sum(t.gross_value + t.buyer_fee)::text
                   FROM market_trades t WHERE t.buy_order_id = o.order_id), '0') AS trade_gold_spent,
         coalesce(fp.buyer_fee_bps, 0) AS buyer_fee_bps,
         e.order_id AS escrow_order_id, e.player_id AS escrow_player_id,
         e.asset_kind AS escrow_asset_kind, e.item_identity AS escrow_item_identity,
         e.item_id AS escrow_item_id, e.variant AS escrow_variant,
         e.initial_amount::text AS escrow_initial_amount,
         e.remaining_amount::text AS escrow_remaining_amount,
         coalesce((SELECT sum(le.amount)::text
                   FROM market_ledger_entries le
                   WHERE le.order_id = o.order_id
                     AND le.account_location = CASE
                       WHEN o.side = 'sell' THEN 'sell_escrow'
                       ELSE 'buy_escrow'
                     END
                     AND (o.side = 'buy' OR le.item_identity = o.item_identity)), '0') AS escrow_ledger_net,
         (SELECT count(*)::text FROM market_ledger_groups g
          WHERE g.order_id = o.order_id AND g.group_type = 'order_escrow') AS escrow_group_count,
         (SELECT count(*)::text FROM market_ledger_groups g
          WHERE g.order_id = o.order_id AND g.group_type = 'cancel') AS cancel_group_count,
         (pa.item_id IS NOT NULL) AS premium_asset,
         pt.seller_fee_bps AS premium_fee_bps,
         pt.fee_reserve::text AS premium_fee_reserve,
         bk.price_currency
  FROM market_orders o
  LEFT JOIN market_order_books bk ON bk.book_id = o.book_id
  LEFT JOIN market_premium_assets pa ON pa.item_id = o.item_id
  LEFT JOIN market_premium_sell_terms pt ON pt.order_id = o.order_id
  LEFT JOIN order_trade_totals tt ON tt.order_id = o.order_id
  LEFT JOIN market_order_escrows e ON e.order_id = o.order_id
  LEFT JOIN market_fee_policies fp
    ON fp.fee_policy_id = o.fee_policy_id AND fp.version = o.fee_policy_version
  ORDER BY o.order_id
`;

const TRADE_QUERY = `/* market-reconcile:trades */
  WITH trades_with_progress AS (
    SELECT t.*,
           coalesce(sum(t.quantity) OVER (
             PARTITION BY t.buy_order_id
             ORDER BY t.book_version
             ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
           ), 0) AS buy_quantity_before
    FROM market_trades t
  )
  SELECT t.trade_id, t.venue_id, t.book_id, t.item_identity, t.item_id, t.variant,
         t.buy_order_id, t.sell_order_id, t.buyer_player_id, t.seller_player_id,
         t.maker_order_id, t.quantity::text, t.unit_price::text, t.gross_value::text,
         t.buyer_fee::text, t.seller_fee::text,
         t.buyer_fee_policy_id, t.buyer_fee_policy_version,
         t.seller_fee_policy_id, t.seller_fee_policy_version,
         (b.order_id IS NOT NULL) AS buy_exists, (s.order_id IS NOT NULL) AS sell_exists,
         b.side AS buy_side, s.side AS sell_side,
         b.venue_id AS buy_venue_id, s.venue_id AS sell_venue_id,
         b.book_id AS buy_book_id, s.book_id AS sell_book_id,
         b.item_identity AS buy_item_identity, s.item_identity AS sell_item_identity,
         b.item_id AS buy_item_id, s.item_id AS sell_item_id,
         b.variant AS buy_variant, s.variant AS sell_variant,
         b.player_id AS buy_player_id, s.player_id AS sell_player_id,
         b.account_id AS buy_account_id, s.account_id AS sell_account_id,
         b.limit_unit_price::text AS buy_limit_unit_price,
         b.order_policy AS buy_order_policy,
         b.fee_policy_id AS buy_fee_policy_id,
         b.fee_policy_version AS buy_fee_policy_version,
         (b.original_quantity - t.buy_quantity_before)::text AS buy_remaining_before,
         s.limit_unit_price::text AS sell_limit_unit_price,
         s.fee_policy_id AS sell_fee_policy_id,
         s.fee_policy_version AS sell_fee_policy_version,
         maker.limit_unit_price::text AS maker_limit_unit_price,
         (maker.order_id IN (t.buy_order_id, t.sell_order_id)) AS maker_matches_order,
         (bfp.fee_policy_id IS NOT NULL) AS buyer_policy_exists,
         (sfp.fee_policy_id IS NOT NULL) AS seller_policy_exists,
         bfp.buyer_fee_bps,
         brfp.buyer_fee_bps AS buy_reserve_buyer_fee_bps,
         sfp.seller_fee_bps,
         (SELECT count(*)::text FROM market_ledger_groups g
          WHERE g.trade_id = t.trade_id AND g.group_type = 'trade') AS trade_group_count,
         (SELECT count(*)::text
          FROM market_ledger_entries le
          JOIN market_ledger_groups lg ON lg.ledger_group_id = le.ledger_group_id
          WHERE lg.trade_id = t.trade_id AND lg.group_type = 'trade'
            AND le.asset_kind = 'item') AS trade_item_entry_count,
         (SELECT count(*)::text
          FROM market_ledger_entries le
          JOIN market_ledger_groups lg ON lg.ledger_group_id = le.ledger_group_id
          WHERE lg.trade_id = t.trade_id AND lg.group_type = 'trade'
            AND le.asset_kind IN ('gold', 'glimmer')) AS trade_gold_entry_count
  FROM trades_with_progress t
  LEFT JOIN market_orders b ON b.order_id = t.buy_order_id
  LEFT JOIN market_orders s ON s.order_id = t.sell_order_id
  LEFT JOIN market_orders maker ON maker.order_id = t.maker_order_id
  LEFT JOIN market_fee_policies bfp
    ON bfp.fee_policy_id = t.buyer_fee_policy_id AND bfp.version = t.buyer_fee_policy_version
  LEFT JOIN market_fee_policies brfp
    ON brfp.fee_policy_id = b.fee_policy_id AND brfp.version = b.fee_policy_version
  LEFT JOIN market_fee_policies sfp
    ON sfp.fee_policy_id = t.seller_fee_policy_id AND sfp.version = t.seller_fee_policy_version
  ORDER BY t.trade_id
`;

const LEDGER_GROUP_QUERY = `/* market-reconcile:ledger-groups */
  SELECT g.ledger_group_id, g.group_type, g.request_id, g.order_id, g.trade_id,
         coalesce(o.venue_id, t.venue_id) AS venue_id,
         coalesce(o.book_id, t.book_id) AS book_id,
         o.player_id AS player_id,
         e.asset_kind, e.item_identity,
         g.order_fee_policy_id, g.order_fee_policy_version,
         g.buyer_fee_policy_id, g.buyer_fee_policy_version,
         g.seller_fee_policy_id, g.seller_fee_policy_version,
         coalesce(CASE
           WHEN g.group_type IN ('order_escrow', 'cancel') THEN
             o.order_id IS NOT NULL
             AND g.order_fee_policy_id = o.fee_policy_id
             AND g.order_fee_policy_version = o.fee_policy_version
             AND g.buyer_fee_policy_id IS NULL
             AND g.buyer_fee_policy_version IS NULL
             AND g.seller_fee_policy_id IS NULL
             AND g.seller_fee_policy_version IS NULL
           WHEN g.group_type = 'trade' THEN
             t.trade_id IS NOT NULL
             AND g.order_fee_policy_id IS NULL
             AND g.order_fee_policy_version IS NULL
             AND g.buyer_fee_policy_id = t.buyer_fee_policy_id
             AND g.buyer_fee_policy_version = t.buyer_fee_policy_version
             AND g.seller_fee_policy_id = t.seller_fee_policy_id
             AND g.seller_fee_policy_version = t.seller_fee_policy_version
           ELSE
             g.order_fee_policy_id IS NULL
             AND g.order_fee_policy_version IS NULL
             AND g.buyer_fee_policy_id IS NULL
             AND g.buyer_fee_policy_version IS NULL
             AND g.seller_fee_policy_id IS NULL
             AND g.seller_fee_policy_version IS NULL
         END, false) AS fee_provenance_valid,
         count(e.ledger_entry_id)::text AS entry_count,
         coalesce(sum(e.amount), 0)::text AS balance
  FROM market_ledger_groups g
  LEFT JOIN market_ledger_entries e ON e.ledger_group_id = g.ledger_group_id
  LEFT JOIN market_orders o ON o.order_id = g.order_id
  LEFT JOIN market_trades t ON t.trade_id = g.trade_id
  GROUP BY g.ledger_group_id, g.group_type, g.request_id, g.order_id, g.trade_id,
           o.order_id, o.fee_policy_id, o.fee_policy_version,
           t.trade_id, t.buyer_fee_policy_id, t.buyer_fee_policy_version,
           t.seller_fee_policy_id, t.seller_fee_policy_version,
           o.venue_id, t.venue_id, o.book_id, t.book_id, o.player_id,
           e.asset_kind, e.item_identity
  ORDER BY g.ledger_group_id, e.asset_kind, e.item_identity
`;

const LEDGER_ENTRY_ISSUE_QUERY = `/* market-reconcile:ledger-entry-issues */
  SELECT e.ledger_entry_id::text, e.ledger_group_id, g.group_type,
         e.asset_kind, e.item_identity, e.account_location, e.player_id,
         e.order_id, e.trade_id, e.collection_id::text,
         g.order_id AS group_order_id, g.trade_id AS group_trade_id,
         coalesce(o.venue_id, t.venue_id) AS venue_id,
         coalesce(o.book_id, t.book_id) AS book_id
  FROM market_ledger_entries e
  JOIN market_ledger_groups g ON g.ledger_group_id = e.ledger_group_id
  LEFT JOIN market_orders o ON o.order_id = coalesce(e.order_id, g.order_id)
  LEFT JOIN market_trades t ON t.trade_id = coalesce(e.trade_id, g.trade_id)
  WHERE
    (e.asset_kind = 'item' AND NOT EXISTS (
      SELECT 1 FROM market_premium_assets pa WHERE pa.market_identity = e.item_identity
    ) AND e.account_location NOT IN (
      'player_inventory', 'sell_escrow', 'buyer_collection', 'return_collection'
    )) OR
    (e.asset_kind = 'item' AND EXISTS (
      SELECT 1 FROM market_premium_assets pa WHERE pa.market_identity = e.item_identity
    ) AND e.account_location NOT IN ('premium_wallet', 'sell_escrow', 'fee_sink')) OR
    (e.account_location = 'premium_wallet' AND e.player_id IS NULL) OR
    (e.asset_kind = 'glimmer' AND e.account_location NOT IN (
      'premium_wallet', 'buy_escrow', 'fee_sink'
    )) OR
    (e.asset_kind = 'gold' AND e.account_location NOT IN (
      'player_wallet', 'buy_escrow', 'seller_proceeds', 'refund_balance', 'return_collection', 'fee_sink'
    )) OR
    (e.account_location IN ('player_inventory', 'player_wallet') AND e.player_id IS NULL) OR
    (e.account_location IN ('sell_escrow', 'buy_escrow') AND e.order_id IS NULL) OR
    (e.account_location IN ('buyer_collection', 'return_collection', 'seller_proceeds', 'refund_balance')
      AND e.collection_id IS NULL) OR
    (e.trade_id IS NOT NULL AND g.trade_id IS NOT NULL AND e.trade_id <> g.trade_id) OR
    (e.order_id IS NOT NULL AND g.order_id IS NOT NULL AND e.order_id <> g.order_id)
  ORDER BY e.ledger_entry_id
`;

const COLLECTION_QUERY = `/* market-reconcile:collections */
  WITH collection_ledger AS (
    SELECT collection_id,
           coalesce(sum(amount), 0)::text AS ledger_net,
           coalesce(sum(amount) FILTER (WHERE amount > 0), 0)::text AS ledger_positive,
           coalesce(sum(amount) FILTER (WHERE amount < 0), 0)::text AS ledger_negative
    FROM market_ledger_entries
    WHERE collection_id IS NOT NULL
    GROUP BY collection_id
  )
  SELECT c.collection_id::text, c.player_id, c.asset_kind, c.item_identity,
         c.item_id, c.variant, c.original_amount::text, c.remaining_amount::text,
         c.reason, c.source_order_id, c.source_trade_id, c.claimed_at,
         coalesce(cl.ledger_net, '0') AS ledger_net,
         coalesce(cl.ledger_positive, '0') AS ledger_positive,
         coalesce(cl.ledger_negative, '0') AS ledger_negative,
         EXISTS (
           SELECT 1
           FROM market_ledger_entries cle
           JOIN market_ledger_groups clg ON clg.ledger_group_id = cle.ledger_group_id
           WHERE cle.collection_id = c.collection_id AND cle.amount > 0
             AND (
               (c.reason IN ('purchase', 'sell_proceeds', 'price_improvement_refund')
                 AND clg.group_type = 'trade' AND clg.trade_id = c.source_trade_id)
               OR
               (c.reason IN (
                  'sell_cancel_return', 'buy_cancel_refund',
                  'sell_expired_return', 'buy_expired_refund'
                )
                 AND clg.group_type = 'cancel' AND clg.order_id = c.source_order_id)
             )
         ) AS creation_group_matches,
         (o.order_id IS NOT NULL) AS source_order_exists,
         o.side AS source_order_side, o.status AS source_order_status,
         o.player_id AS source_order_player_id, o.book_id AS source_order_book_id,
         o.item_identity AS source_order_item_identity, o.item_id AS source_order_item_id,
         o.variant AS source_order_variant,
         o.limit_unit_price::text AS source_order_limit_unit_price,
         o.remaining_quantity::text AS source_order_remaining_quantity,
         (t.trade_id IS NOT NULL) AS source_trade_exists,
         t.book_id AS source_trade_book_id, t.item_identity AS source_trade_item_identity,
         t.item_id AS source_trade_item_id, t.variant AS source_trade_variant,
         t.buy_order_id AS source_trade_buy_order_id,
         t.sell_order_id AS source_trade_sell_order_id,
         t.buyer_player_id AS source_trade_buyer_player_id,
         t.seller_player_id AS source_trade_seller_player_id,
         t.quantity::text AS source_trade_quantity,
         t.unit_price::text AS source_trade_unit_price,
         t.gross_value::text AS source_trade_gross_value,
         t.seller_fee::text AS source_trade_seller_fee
  FROM market_collections c
  LEFT JOIN collection_ledger cl ON cl.collection_id = c.collection_id
  LEFT JOIN market_orders o ON o.order_id = c.source_order_id
  LEFT JOIN market_trades t ON t.trade_id = c.source_trade_id
  ORDER BY c.collection_id
`;

const WALLET_QUERY = `/* market-reconcile:wallets */
  WITH event_totals AS (
    SELECT player_id, account_id, sum(delta_gold)::text AS event_total,
           count(*)::text AS event_count
    FROM wallet_events GROUP BY player_id, account_id
  ), latest AS (
    SELECT DISTINCT ON (player_id, account_id)
           player_id, account_id, balance_after::text AS latest_balance_after,
           version_after::text AS latest_version_after
    FROM wallet_events
    ORDER BY player_id, account_id, version_after DESC
  )
  SELECT w.player_id, w.account_id, p.account_id AS player_account_id,
         w.gold_balance::text, w.version::text AS wallet_version,
         coalesce(et.event_total, '0') AS event_total,
         coalesce(et.event_count, '0') AS event_count,
         latest.latest_balance_after, latest.latest_version_after
  FROM player_wallets w
  LEFT JOIN players p ON p.id = w.player_id
  LEFT JOIN event_totals et ON et.player_id = w.player_id AND et.account_id = w.account_id
  LEFT JOIN latest ON latest.player_id = w.player_id AND latest.account_id = w.account_id
  ORDER BY w.player_id
`;

const WALLET_CHAIN_ISSUE_QUERY = `/* market-reconcile:wallet-chain */
  WITH ordered AS (
    SELECT event_id, player_id, account_id, delta_gold, balance_after, version_after,
           lag(balance_after, 1, 0) OVER (
             PARTITION BY player_id, account_id ORDER BY version_after
           ) AS previous_balance,
           row_number() OVER (
             PARTITION BY player_id, account_id ORDER BY version_after
           ) AS expected_version
    FROM wallet_events
  )
  SELECT event_id::text, player_id, account_id, delta_gold::text,
         balance_after::text, previous_balance::text,
         version_after::text, expected_version::text
  FROM ordered
  WHERE balance_after <> previous_balance + delta_gold
     OR version_after <> expected_version
  ORDER BY player_id, account_id, version_after
`;

const WALLET_ORPHAN_QUERY = `/* market-reconcile:wallet-orphans */
  SELECT e.event_id::text, e.player_id, e.account_id,
         e.market_order_id, e.market_trade_id,
         (w.player_id IS NOT NULL) AS wallet_exists,
         (e.market_order_id IS NULL OR o.order_id IS NOT NULL) AS order_exists,
         (e.market_trade_id IS NULL OR t.trade_id IS NOT NULL) AS trade_exists
  FROM wallet_events e
  LEFT JOIN player_wallets w ON w.player_id = e.player_id AND w.account_id = e.account_id
  LEFT JOIN market_orders o ON o.order_id = e.market_order_id
  LEFT JOIN market_trades t ON t.trade_id = e.market_trade_id
  WHERE w.player_id IS NULL
     OR (e.market_order_id IS NOT NULL AND o.order_id IS NULL)
     OR (e.market_trade_id IS NOT NULL AND t.trade_id IS NULL)
  ORDER BY e.event_id
`;

const ORPHAN_ESCROW_QUERY = `/* market-reconcile:orphan-escrows */
  SELECT e.order_id, e.player_id
  FROM market_order_escrows e
  LEFT JOIN market_orders o ON o.order_id = e.order_id
  WHERE o.order_id IS NULL
  ORDER BY e.order_id
`;

const NEGATIVE_STATE_QUERY = `/* market-reconcile:negative-state */
  SELECT entity_type, entity_id, book_id, player_id, details
  FROM (
    SELECT 'wallet'::text AS entity_type, w.player_id AS entity_id,
           NULL::uuid AS book_id, w.player_id,
           jsonb_build_object('goldBalance', w.gold_balance) AS details
    FROM player_wallets w WHERE w.gold_balance < 0 OR w.version < 0
    UNION ALL
    SELECT 'inventory',
           concat(i.player_id, ':', i.resource_type, ':', i.variant),
           NULL::uuid, i.player_id,
           jsonb_build_object('quantity', i.quantity)
    FROM player_inventory i WHERE i.quantity < 0
    UNION ALL
    SELECT 'order', o.order_id::text, o.book_id, o.player_id,
           jsonb_build_object(
             'limitUnitPrice', o.limit_unit_price,
             'originalQuantity', o.original_quantity,
             'filledQuantity', o.filled_quantity,
             'remainingQuantity', o.remaining_quantity
           )
    FROM market_orders o
    WHERE o.limit_unit_price <= 0 OR o.original_quantity <= 0
       OR o.filled_quantity < 0 OR o.remaining_quantity < 0
    UNION ALL
    SELECT 'escrow', e.order_id::text, o.book_id, e.player_id,
           jsonb_build_object('initialAmount', e.initial_amount, 'remainingAmount', e.remaining_amount)
    FROM market_order_escrows e LEFT JOIN market_orders o ON o.order_id = e.order_id
    WHERE e.initial_amount <= 0 OR e.remaining_amount < 0 OR e.remaining_amount > e.initial_amount
    UNION ALL
    SELECT 'trade', t.trade_id::text, t.book_id, t.buyer_player_id,
           jsonb_build_object(
             'quantity', t.quantity, 'unitPrice', t.unit_price, 'grossValue', t.gross_value,
             'buyerFee', t.buyer_fee, 'sellerFee', t.seller_fee
           )
    FROM market_trades t
    WHERE t.quantity <= 0 OR t.unit_price <= 0 OR t.gross_value <= 0
       OR t.buyer_fee < 0 OR t.seller_fee < 0
    UNION ALL
    SELECT 'collection', c.collection_id::text, o.book_id, c.player_id,
           jsonb_build_object('originalAmount', c.original_amount, 'remainingAmount', c.remaining_amount)
    FROM market_collections c LEFT JOIN market_orders o ON o.order_id = c.source_order_id
    WHERE c.original_amount <= 0 OR c.remaining_amount < 0 OR c.remaining_amount > c.original_amount
    UNION ALL
    SELECT 'claim', c.claim_id::text, NULL::uuid, c.player_id,
           jsonb_build_object('itemUnitsClaimed', c.item_units_claimed, 'goldClaimed', c.gold_claimed)
    FROM market_claims c WHERE c.item_units_claimed < 0 OR c.gold_claimed < 0
    UNION ALL
    SELECT 'quote', q.quote_id::text, q.book_id, q.player_id,
           jsonb_build_object(
             'requestedQuantity', q.requested_quantity,
             'fillableQuantity', q.fillable_quantity,
             'quotedTotal', q.quoted_total
           )
    FROM market_quotes q
    WHERE q.requested_quantity <= 0 OR q.fillable_quantity < 0
       OR q.fillable_quantity > q.requested_quantity OR q.quoted_total < 0
  ) invalid
  ORDER BY entity_type, entity_id
`;

function validCollectionSource(row: CollectionRow): boolean {
  if (row.asset_kind === "item" && (!row.item_identity || !row.item_id || !row.variant)) return false;
  if (row.asset_kind === "gold" && (row.item_identity || row.item_id || row.variant)) return false;
  switch (row.reason) {
    case "purchase":
      return row.asset_kind === "item" && row.source_trade_exists && row.source_order_exists &&
        row.source_order_id === row.source_trade_buy_order_id &&
        row.source_order_side === "buy" && row.player_id === row.source_trade_buyer_player_id &&
        row.item_identity === row.source_trade_item_identity && row.item_id === row.source_trade_item_id &&
        row.variant === row.source_trade_variant;
    case "sell_proceeds":
      return row.asset_kind === "gold" && row.source_trade_exists && row.source_order_exists &&
        row.source_order_id === row.source_trade_sell_order_id &&
        row.source_order_side === "sell" && row.player_id === row.source_trade_seller_player_id;
    case "price_improvement_refund":
      return row.asset_kind === "gold" && row.source_trade_exists && row.source_order_exists &&
        row.source_order_id === row.source_trade_buy_order_id &&
        row.source_order_side === "buy" && row.player_id === row.source_trade_buyer_player_id;
    case "sell_cancel_return":
      return row.asset_kind === "item" && row.source_trade_id === null && row.source_order_exists &&
        row.source_order_side === "sell" && row.source_order_status === "cancelled" &&
        row.player_id === row.source_order_player_id &&
        row.item_identity === row.source_order_item_identity && row.item_id === row.source_order_item_id &&
        row.variant === row.source_order_variant;
    case "buy_cancel_refund":
      return row.asset_kind === "gold" && row.source_trade_id === null && row.source_order_exists &&
        row.source_order_side === "buy" && row.source_order_status === "cancelled" &&
        row.player_id === row.source_order_player_id;
    case "sell_expired_return":
      return row.asset_kind === "item" && row.source_trade_id === null && row.source_order_exists &&
        row.source_order_side === "sell" && row.source_order_status === "expired" &&
        row.player_id === row.source_order_player_id &&
        row.item_identity === row.source_order_item_identity && row.item_id === row.source_order_item_id &&
        row.variant === row.source_order_variant;
    case "buy_expired_refund":
      return row.asset_kind === "gold" && row.source_trade_id === null && row.source_order_exists &&
        row.source_order_side === "buy" && row.source_order_status === "expired" &&
        row.player_id === row.source_order_player_id;
  }
}

function collectionSourceKey(row: CollectionRow): string | null {
  if (row.source_trade_id && ["purchase", "sell_proceeds", "price_improvement_refund"].includes(row.reason)) {
    return `trade:${row.source_trade_id}:${row.reason}`;
  }
  if (
    row.source_order_id &&
    [
      "sell_cancel_return",
      "buy_cancel_refund",
      "sell_expired_return",
      "buy_expired_refund"
    ].includes(row.reason)
  ) {
    return `order:${row.source_order_id}:${row.reason}`;
  }
  return null;
}

function assertCollectionTotal(
  add: (code: string, scope: string, entityId: string | null, details: Record<string, unknown>) => void,
  totals: Map<string, bigint>,
  key: string,
  expected: bigint,
  code: string,
  scope: string,
  entityId: string,
  context: Record<string, unknown>
): void {
  const actual = totals.get(key) ?? 0n;
  if (actual !== expected) {
    add(code, scope, entityId, {
      ...context,
      expected: expected.toString(),
      actual: actual.toString()
    });
  }
}

function orderContext(row: Pick<OrderRow, "venue_id" | "book_id" | "player_id" | "account_id">) {
  return {
    venueId: row.venue_id,
    bookId: row.book_id,
    playerId: row.player_id,
    accountId: row.account_id
  };
}

function tradeContext(row: Pick<TradeRow, "venue_id" | "book_id" | "buyer_player_id" | "seller_player_id">) {
  return {
    venueId: row.venue_id,
    bookId: row.book_id,
    buyerPlayerId: row.buyer_player_id,
    sellerPlayerId: row.seller_player_id
  };
}

function collectionContext(row: CollectionRow): Record<string, unknown> {
  return compactDetails({
    bookId: row.source_order_book_id ?? row.source_trade_book_id,
    playerId: row.player_id,
    assetKind: row.asset_kind,
    itemIdentity: row.item_identity,
    itemId: row.item_id,
    variant: row.variant,
    reason: row.reason,
    sourceOrderId: row.source_order_id,
    sourceTradeId: row.source_trade_id
  });
}

function compactDetails(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== null && value !== undefined));
}

function premiumFee(filled: bigint, basisPoints: number): bigint {
  const scaled = filled * BigInt(basisPoints);
  return scaled === 0n ? 0n : (scaled + 9_999n) / 10_000n;
}

function fee(value: bigint, basisPoints: number): bigint {
  return (value * BigInt(basisPoints)) / 10_000n;
}

function expectedPriceImprovementRefund(trade: TradeRow): bigint {
  if (
    trade.buy_order_policy === "aon_ioc" || trade.buy_limit_unit_price === null ||
    trade.buy_remaining_before === null || trade.buyer_fee_bps === null ||
    trade.buy_reserve_buyer_fee_bps === null
  ) return 0n;
  const quantity = BigInt(trade.quantity);
  const remainingBefore = BigInt(trade.buy_remaining_before);
  const remainingAfter = remainingBefore - quantity;
  if (remainingAfter < 0n) return 0n;
  const limit = BigInt(trade.buy_limit_unit_price);
  const requiredBefore = limit * remainingBefore
    + fee(limit * remainingBefore, trade.buy_reserve_buyer_fee_bps);
  const requiredAfter = limit * remainingAfter
    + fee(limit * remainingAfter, trade.buy_reserve_buyer_fee_bps);
  const gross = BigInt(trade.gross_value);
  return requiredBefore - requiredAfter - gross - fee(gross, trade.buyer_fee_bps);
}

function safeCount(value: string): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : Number.MAX_SAFE_INTEGER;
}

function isoOrNull(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function safeJson(value: string): Record<string, unknown> | string {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : value;
  } catch {
    return value;
  }
}

async function rollbackQuietly(queryable: Queryable): Promise<void> {
  try {
    await queryable.query("ROLLBACK");
  } catch {
    // Preserve the original transaction error.
  }
}
