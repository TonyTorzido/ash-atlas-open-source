import type { MarketReconciliationIssue } from "@ash-atlas/shared";
import type pg from "pg";

type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

type BoundaryIssueRow = {
  code: string;
  scope: string;
  entity_id: string | null;
  player_id: string | null;
  book_id: string | null;
  details: Record<string, unknown> | string;
};

/**
 * Reconciles the market journal against the authoritative inventory and wallet
 * event streams. Balanced market entries alone are insufficient: the asset must
 * also have crossed the real domain boundary by exactly the journaled amount.
 */
export async function reconcileMarketDomainBoundaries(
  queryable: Queryable
): Promise<MarketReconciliationIssue[]> {
  const results = [];
  // A PoolClient cannot execute concurrent queries safely. Reconciliation runs
  // inside one repeatable-read snapshot, so preserve that snapshot explicitly.
  for (const query of [
    ORDER_BOUNDARY_QUERY,
    PREMIUM_BOUNDARY_QUERY,
    CLAIM_BOUNDARY_QUERY,
    CLAIM_ITEM_IDENTITY_QUERY,
    ORPHAN_MARKET_DOMAIN_QUERY,
    INVENTORY_CHAIN_QUERY
  ]) {
    results.push(await queryable.query<BoundaryIssueRow>(query));
  }

  return results.flatMap((result) => result.rows.map((row) => ({
    code: row.code,
    scope: row.scope,
    entityId: row.entity_id,
    details: {
      ...parseDetails(row.details),
      ...(row.player_id ? { playerId: row.player_id } : {}),
      ...(row.book_id ? { bookId: row.book_id } : {})
    }
  })));
}

function parseDetails(value: Record<string, unknown> | string): Record<string, unknown> {
  if (typeof value !== "string") return value;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : { value: parsed };
  } catch {
    return { value };
  }
}

const ORDER_BOUNDARY_QUERY = `/* market-reconcile:domain-order-boundaries */
  WITH sell_boundaries AS (
    SELECT o.order_id, o.book_id, o.player_id, o.item_id, o.variant,
           o.original_quantity,
           count(DISTINCT io.operation_key)::bigint AS operation_count,
           coalesce(sum(ie.delta_quantity), 0)::bigint AS event_delta,
           count(*) FILTER (
             WHERE ie.operation_key IS NOT NULL AND (
               ie.player_id <> o.player_id OR ie.item_id <> o.item_id OR
               ie.variant <> o.variant OR ie.delta_quantity >= 0 OR
               io.player_id <> o.player_id OR io.source <> 'market_sell_escrow' OR
               io.source_entity_type <> 'market_order' OR
               io.source_entity_id <> o.order_id::text
             )
           )::bigint AS invalid_event_count
    FROM market_orders o
    LEFT JOIN inventory_operations io
      ON io.operation_key = 'market-sell-escrow:' || o.account_id::text || ':' || o.client_request_id
    LEFT JOIN inventory_events ie ON ie.operation_key = io.operation_key
    WHERE o.side = 'sell'
      AND NOT EXISTS (SELECT 1 FROM market_premium_assets pa WHERE pa.item_id = o.item_id)
    GROUP BY o.order_id, o.book_id, o.player_id, o.item_id, o.variant, o.original_quantity
  ), buy_boundaries AS (
    SELECT o.order_id, o.book_id, o.player_id, o.account_id,
           e.initial_amount,
           count(we.event_id)::bigint AS event_count,
           coalesce(sum(we.delta_gold), 0)::bigint AS event_delta,
           count(*) FILTER (
             WHERE we.event_id IS NOT NULL AND (
               we.player_id <> o.player_id OR we.account_id <> o.account_id OR
               we.reason <> 'market_buy_escrow' OR we.market_order_id <> o.order_id
             )
           )::bigint AS invalid_event_count
    FROM market_orders o
    JOIN market_order_escrows e ON e.order_id = o.order_id
    LEFT JOIN wallet_events we
      ON we.operation_key = 'market-buy-escrow:' || o.account_id::text || ':' || o.client_request_id
     AND we.player_id = o.player_id
    WHERE o.side = 'buy'
      -- Glimmer-priced buys escrow from the premium wallet (premium boundary query).
      AND e.asset_kind = 'gold'
    GROUP BY o.order_id, o.book_id, o.player_id, o.account_id, e.initial_amount
  )
  SELECT 'MARKET_SELL_INVENTORY_BOUNDARY_MISMATCH'::text AS code,
         'order'::text AS scope, order_id::text AS entity_id,
         player_id, book_id,
         jsonb_build_object(
           'itemId', item_id, 'variant', variant,
           'expectedDelta', (-original_quantity)::text,
           'actualDelta', event_delta::text,
           'operationCount', operation_count::text,
           'invalidEventCount', invalid_event_count::text
         ) AS details
  FROM sell_boundaries
  WHERE operation_count <> 1 OR event_delta <> -original_quantity OR invalid_event_count <> 0
  UNION ALL
  SELECT 'MARKET_BUY_WALLET_BOUNDARY_MISMATCH'::text,
         'order'::text, order_id::text, player_id, book_id,
         jsonb_build_object(
           'expectedDelta', (-initial_amount)::text,
           'actualDelta', event_delta::text,
           'eventCount', event_count::text,
           'invalidEventCount', invalid_event_count::text
         )
  FROM buy_boundaries
  WHERE event_count <> 1 OR event_delta <> -initial_amount OR invalid_event_count <> 0
`;

// Glimmer: every premium-wallet journal entry (the Glimmer item, or a
// Glimmer price leg) has exactly one matching `market` premium wallet event,
// and every such event has its entry.
const PREMIUM_BOUNDARY_QUERY = `/* market-reconcile:domain-premium-boundaries */
  WITH ledger AS (
    SELECT e.ledger_entry_id, e.player_id, e.amount,
           coalesce(pa.currency, 'glimmer') AS currency,
           g.group_type,
           coalesce(e.trade_id, g.trade_id) AS trade_id,
           coalesce(e.order_id, g.order_id) AS order_id
    FROM market_ledger_entries e
    JOIN market_ledger_groups g ON g.ledger_group_id = e.ledger_group_id
    LEFT JOIN market_premium_assets pa ON pa.market_identity = e.item_identity
    WHERE e.account_location = 'premium_wallet'
      AND (pa.item_id IS NOT NULL OR e.asset_kind = 'glimmer')
  ), events AS (
    SELECT ev.event_id, ev.account_id, ev.actor_player_id, ev.currency, ev.delta,
           ev.operation_key, ev.ref_type, ev.ref_id
    FROM premium_wallet_events ev
    WHERE ev.reason = 'market'
  ), matched AS (
    SELECT l.ledger_entry_id, ev.event_id
    FROM ledger l
    JOIN events ev
      ON ev.actor_player_id = l.player_id
     AND ev.currency = l.currency
     AND ev.delta = l.amount
     AND (
       (l.group_type = 'trade' AND ev.ref_type = 'market_trade'
         AND ev.ref_id = l.trade_id::text
         AND ev.operation_key IN (
           'market-trade-premium:' || l.trade_id::text,
           'market-trade-proceeds:' || l.trade_id::text,
           'market-trade-refund:' || l.trade_id::text
         ))
       OR (l.group_type = 'order_escrow' AND ev.ref_type = 'market_order'
         AND ev.ref_id = l.order_id::text AND ev.delta < 0)
       OR (l.group_type = 'cancel' AND ev.ref_type = 'market_order'
         AND ev.ref_id = l.order_id::text
         AND ev.operation_key = 'market-cancel-premium:' || l.order_id::text)
     )
  )
  SELECT 'MARKET_PREMIUM_LEDGER_WITHOUT_WALLET_EVENT'::text AS code,
         'ledger_entry'::text AS scope, l.ledger_entry_id::text AS entity_id,
         l.player_id, NULL::uuid AS book_id,
         jsonb_build_object('currency', l.currency, 'amount', l.amount::text,
                            'groupType', l.group_type) AS details
  FROM ledger l
  WHERE (SELECT count(*) FROM matched m WHERE m.ledger_entry_id = l.ledger_entry_id) <> 1
  UNION ALL
  SELECT 'MARKET_PREMIUM_WALLET_EVENT_WITHOUT_LEDGER'::text,
         'premium_wallet_event'::text, ev.event_id::text,
         ev.actor_player_id, NULL::uuid,
         jsonb_build_object('currency', ev.currency, 'delta', ev.delta::text,
                            'operationKey', ev.operation_key)
  FROM events ev
  WHERE (SELECT count(*) FROM matched m WHERE m.event_id = ev.event_id) <> 1
`;

const CLAIM_BOUNDARY_QUERY = `/* market-reconcile:domain-claim-boundaries */
  WITH claim_ledger AS (
    SELECT c.claim_id,
           count(DISTINCT g.ledger_group_id)::bigint AS group_count,
           coalesce(sum(e.amount) FILTER (
             WHERE e.amount > 0 AND e.account_location = 'player_inventory'
           ), 0)::bigint AS item_credit,
           coalesce(sum(e.amount) FILTER (
             WHERE e.amount > 0 AND e.account_location = 'player_wallet'
           ), 0)::bigint AS gold_credit,
           count(*) FILTER (
             WHERE e.ledger_entry_id IS NOT NULL AND e.player_id IS DISTINCT FROM c.player_id
           )::bigint AS wrong_player_entries
    FROM market_claims c
    LEFT JOIN market_ledger_groups g
      ON g.group_type = 'claim' AND g.claim_id = c.claim_id
    LEFT JOIN market_ledger_entries e ON e.ledger_group_id = g.ledger_group_id
    GROUP BY c.claim_id
  ), inventory_claims AS (
    SELECT c.claim_id,
           count(DISTINCT io.operation_key)::bigint AS operation_count,
           coalesce(sum(ie.delta_quantity), 0)::bigint AS event_delta,
           count(*) FILTER (
             WHERE ie.operation_key IS NOT NULL AND (
               ie.player_id <> c.player_id OR ie.delta_quantity <= 0 OR
               io.player_id <> c.player_id OR io.source <> 'market_collection_claim' OR
               io.source_entity_type <> 'market_claim' OR
               io.source_entity_id <> c.client_request_id
             )
           )::bigint AS invalid_event_count
    FROM market_claims c
    LEFT JOIN inventory_operations io
      ON io.operation_key = 'market-claim-items:' || c.account_id::text || ':' || c.client_request_id
    LEFT JOIN inventory_events ie ON ie.operation_key = io.operation_key
    GROUP BY c.claim_id
  ), wallet_claims AS (
    SELECT c.claim_id,
           count(we.event_id)::bigint AS event_count,
           coalesce(sum(we.delta_gold), 0)::bigint AS event_delta,
           count(*) FILTER (
             WHERE we.event_id IS NOT NULL AND (
               we.player_id <> c.player_id OR we.account_id <> c.account_id OR
               we.reason <> 'market_collection_claim' OR we.delta_gold <= 0
             )
           )::bigint AS invalid_event_count
    FROM market_claims c
    LEFT JOIN wallet_events we
      ON we.operation_key = 'market-claim-gold:' || c.account_id::text || ':' || c.client_request_id
     AND we.player_id = c.player_id
    GROUP BY c.claim_id
  )
  SELECT 'MARKET_CLAIM_DOMAIN_BOUNDARY_MISMATCH'::text AS code,
         'claim'::text AS scope, c.claim_id::text AS entity_id,
         c.player_id, NULL::uuid AS book_id,
         jsonb_build_object(
           'requestId', c.client_request_id,
           'expectedItemUnits', c.item_units_claimed::text,
           'inventoryEventUnits', i.event_delta::text,
           'itemLedgerCredit', l.item_credit::text,
           'inventoryOperationCount', i.operation_count::text,
           'inventoryInvalidEventCount', i.invalid_event_count::text,
           'expectedGold', c.gold_claimed::text,
           'walletEventGold', w.event_delta::text,
           'goldLedgerCredit', l.gold_credit::text,
           'walletEventCount', w.event_count::text,
           'walletInvalidEventCount', w.invalid_event_count::text,
           'ledgerGroupCount', l.group_count::text,
           'wrongPlayerLedgerEntries', l.wrong_player_entries::text
         ) AS details
  FROM market_claims c
  JOIN claim_ledger l ON l.claim_id = c.claim_id
  JOIN inventory_claims i ON i.claim_id = c.claim_id
  JOIN wallet_claims w ON w.claim_id = c.claim_id
  WHERE
    i.event_delta <> c.item_units_claimed OR
    l.item_credit <> c.item_units_claimed OR
    i.operation_count <> CASE WHEN c.item_units_claimed > 0 THEN 1 ELSE 0 END OR
    i.invalid_event_count <> 0 OR
    w.event_delta <> c.gold_claimed OR
    l.gold_credit <> c.gold_claimed OR
    w.event_count <> CASE WHEN c.gold_claimed > 0 THEN 1 ELSE 0 END OR
    w.invalid_event_count <> 0 OR
    l.group_count <> CASE WHEN c.item_units_claimed > 0 OR c.gold_claimed > 0 THEN 1 ELSE 0 END OR
    l.wrong_player_entries <> 0
`;

const CLAIM_ITEM_IDENTITY_QUERY = `/* market-reconcile:domain-claim-item-identities */
  WITH inventory_by_item AS (
    SELECT c.claim_id, c.player_id,
           CASE
             WHEN ie.variant = 'default' THEN coalesce(d.market_identity, ie.item_id)
             ELSE coalesce(d.market_identity, ie.item_id) || ':' || ie.variant
           END AS item_identity,
           sum(ie.delta_quantity)::bigint AS amount
    FROM market_claims c
    JOIN inventory_operations io
      ON io.operation_key = 'market-claim-items:' || c.account_id::text || ':' || c.client_request_id
    JOIN inventory_events ie ON ie.operation_key = io.operation_key
    LEFT JOIN item_definitions d ON d.item_id = ie.item_id
    GROUP BY c.claim_id, c.player_id,
             CASE
               WHEN ie.variant = 'default' THEN coalesce(d.market_identity, ie.item_id)
               ELSE coalesce(d.market_identity, ie.item_id) || ':' || ie.variant
             END
  ), ledger_by_item AS (
    SELECT c.claim_id, c.player_id, e.item_identity,
           sum(e.amount)::bigint AS amount
    FROM market_claims c
    JOIN market_ledger_groups g
      ON g.group_type = 'claim' AND g.claim_id = c.claim_id
    JOIN market_ledger_entries e ON e.ledger_group_id = g.ledger_group_id
    WHERE e.account_location = 'player_inventory' AND e.amount > 0
    GROUP BY c.claim_id, c.player_id, e.item_identity
  ), compared AS (
    SELECT coalesce(i.claim_id, l.claim_id) AS claim_id,
           coalesce(i.player_id, l.player_id) AS player_id,
           coalesce(i.item_identity, l.item_identity) AS item_identity,
           coalesce(i.amount, 0)::bigint AS inventory_amount,
           coalesce(l.amount, 0)::bigint AS ledger_amount
    FROM inventory_by_item i
    FULL OUTER JOIN ledger_by_item l
      ON l.claim_id = i.claim_id AND l.item_identity = i.item_identity
  )
  SELECT 'MARKET_CLAIM_ITEM_IDENTITY_MISMATCH'::text AS code,
         'claim'::text AS scope, claim_id::text AS entity_id,
         player_id, NULL::uuid AS book_id,
         jsonb_build_object(
           'itemIdentity', item_identity,
           'inventoryAmount', inventory_amount::text,
           'ledgerAmount', ledger_amount::text
         ) AS details
  FROM compared
  WHERE inventory_amount <> ledger_amount
`;

const ORPHAN_MARKET_DOMAIN_QUERY = `/* market-reconcile:reverse-market-domain-boundaries */
  SELECT 'ORPHAN_MARKET_INVENTORY_OPERATION'::text AS code,
         'inventory_operation'::text AS scope,
         io.operation_key::text AS entity_id,
         io.player_id, NULL::uuid AS book_id,
         jsonb_build_object(
           'source', io.source,
           'sourceEntityType', io.source_entity_type,
           'sourceEntityId', io.source_entity_id
         ) AS details
  FROM inventory_operations io
  WHERE
    (
      (io.source = 'market_sell_escrow' OR io.operation_key LIKE 'market-sell-escrow:%')
      AND NOT EXISTS (
        SELECT 1
        FROM market_orders o
        WHERE o.side = 'sell'
          AND o.order_id::text = io.source_entity_id
          AND o.player_id = io.player_id
          AND io.source = 'market_sell_escrow'
          AND io.source_entity_type = 'market_order'
          AND io.operation_key = 'market-sell-escrow:' || o.account_id::text || ':' || o.client_request_id
      )
    ) OR (
      (io.source = 'market_collection_claim' OR io.operation_key LIKE 'market-claim-items:%')
      AND NOT EXISTS (
        SELECT 1
        FROM market_claims c
        WHERE c.client_request_id = io.source_entity_id
          AND c.player_id = io.player_id
          AND c.item_units_claimed > 0
          AND io.source = 'market_collection_claim'
          AND io.source_entity_type = 'market_claim'
          AND io.operation_key = 'market-claim-items:' || c.account_id::text || ':' || c.client_request_id
      )
    )
  UNION ALL
  SELECT 'ORPHAN_MARKET_INVENTORY_EVENT'::text,
         'inventory_event'::text, ie.id::text, ie.player_id, NULL::uuid,
         jsonb_build_object(
           'operationKey', ie.operation_key,
           'source', ie.source,
           'itemId', ie.item_id,
           'variant', ie.variant,
           'delta', ie.delta_quantity::text
         )
  FROM inventory_events ie
  JOIN inventory_operations io ON io.operation_key = ie.operation_key
  WHERE
    (
      ie.source IN ('market_sell_escrow', 'market_collection_claim')
      OR ie.operation_key LIKE 'market-sell-escrow:%'
      OR ie.operation_key LIKE 'market-claim-items:%'
    )
    AND (
      ie.source <> io.source
      OR NOT (
        (io.source = 'market_sell_escrow' AND EXISTS (
          SELECT 1 FROM market_orders o
          WHERE o.side = 'sell' AND o.order_id::text = io.source_entity_id
            AND o.player_id = ie.player_id AND o.item_id = ie.item_id
            AND o.variant = ie.variant AND ie.delta_quantity = -o.original_quantity
            AND io.source_entity_type = 'market_order'
            AND io.operation_key = 'market-sell-escrow:' || o.account_id::text || ':' || o.client_request_id
        ))
        OR
        (io.source = 'market_collection_claim' AND EXISTS (
          SELECT 1 FROM market_claims c
          WHERE c.client_request_id = io.source_entity_id
            AND c.player_id = ie.player_id AND c.item_units_claimed > 0
            AND ie.delta_quantity > 0 AND io.source_entity_type = 'market_claim'
            AND io.operation_key = 'market-claim-items:' || c.account_id::text || ':' || c.client_request_id
        ))
      )
    )
  UNION ALL
  SELECT 'ORPHAN_MARKET_WALLET_EVENT'::text,
         'wallet_event'::text, we.event_id::text, we.player_id, NULL::uuid,
         jsonb_build_object(
           'operationKey', we.operation_key,
           'reason', we.reason,
           'accountId', we.account_id,
           'delta', we.delta_gold::text,
           'marketOrderId', we.market_order_id
         )
  FROM wallet_events we
  WHERE
    (
      we.reason = 'market_buy_escrow'
      OR we.operation_key LIKE 'market-buy-escrow:%'
    ) AND NOT EXISTS (
      SELECT 1
      FROM market_orders o
      JOIN market_order_escrows e ON e.order_id = o.order_id AND e.asset_kind = 'gold'
      WHERE o.side = 'buy' AND o.order_id = we.market_order_id
        AND o.player_id = we.player_id AND o.account_id = we.account_id
        AND we.reason = 'market_buy_escrow'
        AND we.delta_gold = -e.initial_amount
        AND we.operation_key = 'market-buy-escrow:' || o.account_id::text || ':' || o.client_request_id
    )
    OR (
      we.reason = 'market_collection_claim'
      OR we.operation_key LIKE 'market-claim-gold:%'
    ) AND NOT EXISTS (
      SELECT 1
      FROM market_claims c
      WHERE c.player_id = we.player_id AND c.account_id = we.account_id
        AND c.gold_claimed > 0 AND c.gold_claimed = we.delta_gold
        AND we.reason = 'market_collection_claim'
        AND we.operation_key = 'market-claim-gold:' || c.account_id::text || ':' || c.client_request_id
    )
  UNION ALL
  SELECT 'ORPHAN_MARKET_CLAIM_LEDGER_GROUP'::text,
         'ledger_group'::text, g.ledger_group_id::text,
         owner.player_id, NULL::uuid,
         jsonb_build_object(
           'claimId', g.claim_id,
           'requestId', g.request_id,
           'linkedClaimExists', c.claim_id IS NOT NULL,
           'distinctPlayers', owner.player_count::text
         )
  FROM market_ledger_groups g
  LEFT JOIN market_claims c ON c.claim_id = g.claim_id
  LEFT JOIN LATERAL (
    SELECT min(player_id) AS player_id, count(DISTINCT player_id)::bigint AS player_count
    FROM market_ledger_entries e
    WHERE e.ledger_group_id = g.ledger_group_id
  ) owner ON true
  WHERE g.group_type = 'claim' AND (
    c.claim_id IS NULL OR g.request_id <> c.client_request_id
    OR owner.player_count <> 1 OR owner.player_id <> c.player_id
  )
`;

const INVENTORY_CHAIN_QUERY = `/* market-reconcile:inventory-event-chain */
  WITH ordered AS (
    SELECT id AS event_id, player_id, item_id, variant, delta_quantity, quantity_after,
           version_after,
           lag(quantity_after, 1, 0) OVER (
             PARTITION BY player_id, item_id, variant ORDER BY version_after
           ) AS previous_quantity,
           row_number() OVER (
             PARTITION BY player_id, item_id, variant ORDER BY version_after
           ) AS expected_version
    FROM inventory_events
  ), chain_issues AS (
    SELECT 'INVENTORY_EVENT_CHAIN_MISMATCH'::text AS code,
           'inventory_event'::text AS scope, event_id::text AS entity_id,
           player_id, NULL::uuid AS book_id,
           jsonb_build_object(
             'itemId', item_id, 'variant', variant,
             'previousQuantity', previous_quantity::text,
             'delta', delta_quantity::text,
             'quantityAfter', quantity_after::text,
             'versionAfter', version_after::text,
             'expectedVersion', expected_version::text
           ) AS details
    FROM ordered
    WHERE quantity_after <> previous_quantity + delta_quantity
       OR version_after <> expected_version
  ), latest AS (
    SELECT DISTINCT ON (player_id, item_id, variant)
           id AS event_id, player_id, item_id, variant, quantity_after, version_after
    FROM inventory_events
    ORDER BY player_id, item_id, variant, version_after DESC
  ), current_issues AS (
    SELECT 'INVENTORY_LATEST_EVENT_MISMATCH'::text AS code,
           'inventory'::text AS scope,
           (l.player_id || ':' || l.item_id || ':' || l.variant)::text AS entity_id,
           l.player_id, NULL::uuid AS book_id,
           jsonb_build_object(
             'itemId', l.item_id, 'variant', l.variant,
             'latestEventId', l.event_id::text,
             'latestQuantity', l.quantity_after::text,
             'currentQuantity', pi.quantity::text,
             'latestVersionAfter', l.version_after::text,
             'currentVersion', pi.version::text
           ) AS details
    FROM latest l
    LEFT JOIN player_inventory pi
      ON pi.player_id = l.player_id AND pi.resource_type = l.item_id
     AND pi.variant IS NOT DISTINCT FROM l.variant
    WHERE pi.player_id IS NULL OR pi.quantity <> l.quantity_after
       OR pi.version <> l.version_after
  )
  SELECT * FROM chain_issues
  UNION ALL
  SELECT * FROM current_issues
`;
