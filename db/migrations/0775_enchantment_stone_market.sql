-- Enable exact-variant Enchantment Stone drops and market custody without
-- rewriting any existing inventory, drop, order, trade, or collection rows.

UPDATE item_definitions
SET droppable = true,
    market_tradable = true,
    market_fungible = true,
    market_identity = 'enchantment_stone',
    updated_at = now()
WHERE item_id = 'enchantment_stone';

-- Claim provenance must compare the market identity with the exact inventory
-- item/variant tuple. The original validator treated every item_identity as an
-- inventory item_id, which is only valid for the default variant.
CREATE OR REPLACE FUNCTION validate_market_claim_asset_provenance(target_claim_id uuid)
RETURNS void AS $$
DECLARE
  target_claim market_claims%ROWTYPE;
  claim_group_id uuid;
  operation_count bigint;
  event_count bigint;
  event_total numeric;
  expected_operation_key text;
BEGIN
  SELECT * INTO target_claim FROM market_claims WHERE claim_id = target_claim_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'market asset provenance references a missing claim';
  END IF;
  SELECT ledger_group_id INTO claim_group_id
  FROM market_ledger_groups
  WHERE group_type = 'claim' AND claim_id = target_claim_id;

  expected_operation_key :=
    'market-claim-items:' || target_claim.account_id::text || ':'
      || target_claim.client_request_id;
  SELECT count(*) INTO operation_count
  FROM inventory_operations operation
  WHERE operation.operation_key = expected_operation_key
    AND operation.player_id = target_claim.player_id
    AND operation.source = 'market_collection_claim'
    AND operation.source_entity_type = 'market_claim'
    AND operation.source_entity_id = target_claim.client_request_id;
  SELECT count(*), coalesce(sum(delta_quantity), 0)
  INTO event_count, event_total
  FROM inventory_events event
  WHERE event.operation_key = expected_operation_key
    AND event.player_id = target_claim.player_id
    AND event.source = 'market_collection_claim'
    AND event.source_entity_type = 'market_claim'
    AND event.source_entity_id = target_claim.client_request_id
    AND event.delta_quantity > 0;
  IF (target_claim.item_units_claimed = 0
        AND (operation_count <> 0 OR event_count <> 0 OR event_total <> 0))
     OR (target_claim.item_units_claimed > 0
        AND (operation_count <> 1 OR event_count = 0
          OR event_total <> target_claim.item_units_claimed)) THEN
    RAISE EXCEPTION 'market item claim lacks its exact authoritative inventory transition';
  END IF;
  IF EXISTS (
    SELECT 1 FROM inventory_events event
    WHERE event.operation_key = expected_operation_key
      AND (
        event.player_id IS DISTINCT FROM target_claim.player_id
        OR event.source IS DISTINCT FROM 'market_collection_claim'
        OR event.source_entity_type IS DISTINCT FROM 'market_claim'
        OR event.source_entity_id IS DISTINCT FROM target_claim.client_request_id
        OR event.delta_quantity <= 0
      )
  ) THEN
    RAISE EXCEPTION 'market item claim inventory transition has incompatible provenance';
  END IF;
  IF target_claim.item_units_claimed > 0 AND EXISTS (
    WITH expected AS (
      SELECT entry.item_identity, sum(entry.amount)::numeric AS quantity
      FROM market_ledger_entries entry
      WHERE entry.ledger_group_id = claim_group_id
        AND entry.asset_kind = 'item'
        AND entry.account_location = 'player_inventory'
        AND entry.amount > 0
      GROUP BY entry.item_identity
    ), actual AS (
      SELECT CASE
               WHEN event.variant = 'default'
                 THEN coalesce(definition.market_identity, event.item_id)
               ELSE coalesce(definition.market_identity, event.item_id)
                 || ':' || event.variant
             END AS item_identity,
             sum(event.delta_quantity)::numeric AS quantity
      FROM inventory_events event
      LEFT JOIN item_definitions definition ON definition.item_id = event.item_id
      WHERE event.operation_key = expected_operation_key
        AND event.player_id = target_claim.player_id
      GROUP BY coalesce(definition.market_identity, event.item_id), event.variant
    )
    SELECT 1
    FROM expected
    FULL JOIN actual USING (item_identity)
    WHERE expected.item_identity IS NULL OR actual.item_identity IS NULL
       OR expected.quantity IS DISTINCT FROM actual.quantity
  ) THEN
    RAISE EXCEPTION 'market item claim inventory identity does not match its claim ledger';
  END IF;

  expected_operation_key :=
    'market-claim-gold:' || target_claim.account_id::text || ':'
      || target_claim.client_request_id;
  SELECT count(*), coalesce(sum(delta_gold), 0)
  INTO event_count, event_total
  FROM wallet_events event
  WHERE event.operation_key = expected_operation_key
    AND event.player_id = target_claim.player_id
    AND event.account_id = target_claim.account_id
    AND event.reason = 'market_collection_claim'
    AND event.market_order_id IS NULL
    AND event.market_trade_id IS NULL
    AND event.delta_gold > 0;
  IF (target_claim.gold_claimed = 0 AND (event_count <> 0 OR event_total <> 0))
     OR (target_claim.gold_claimed > 0
       AND (event_count <> 1 OR event_total <> target_claim.gold_claimed)) THEN
    RAISE EXCEPTION 'market gold claim lacks its exact authoritative wallet transition';
  END IF;
  IF EXISTS (
    SELECT 1 FROM wallet_events event
    WHERE event.operation_key = expected_operation_key
      AND (
        event.player_id IS DISTINCT FROM target_claim.player_id
        OR event.account_id IS DISTINCT FROM target_claim.account_id
        OR event.reason IS DISTINCT FROM 'market_collection_claim'
        OR event.market_order_id IS NOT NULL
        OR event.market_trade_id IS NOT NULL
        OR event.delta_gold <= 0
      )
  ) THEN
    RAISE EXCEPTION 'market gold claim wallet transition has incompatible provenance';
  END IF;
END;
$$ LANGUAGE plpgsql;
