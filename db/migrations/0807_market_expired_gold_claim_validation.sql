-- Expired buy orders introduced gold recovery in return_collection in 0716.
-- Preserve every claim invariant while accepting that authoritative source.
CREATE OR REPLACE FUNCTION validate_market_claim_commit(target_claim_id uuid)
RETURNS void AS $$
DECLARE
  target_claim market_claims%ROWTYPE;
  claim_group market_ledger_groups%ROWTYPE;
  related_count bigint;
  item_destination_total numeric;
  gold_destination_total numeric;
BEGIN
  SELECT * INTO target_claim
  FROM market_claims
  WHERE claim_id = target_claim_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'market claim ledger group references a missing claim';
  END IF;

  IF (target_claim.asset_scope = 'items' AND target_claim.gold_claimed <> 0)
     OR (target_claim.asset_scope = 'gold' AND target_claim.item_units_claimed <> 0) THEN
    RAISE EXCEPTION 'market claim totals do not match its asset scope';
  END IF;

  SELECT count(*) INTO related_count
  FROM market_ledger_groups
  WHERE group_type = 'claim' AND claim_id = target_claim_id;
  IF target_claim.item_units_claimed = 0 AND target_claim.gold_claimed = 0 THEN
    IF related_count <> 0 THEN
      RAISE EXCEPTION 'zero-value market claim cannot have a settlement ledger group';
    END IF;
    RETURN;
  END IF;
  IF related_count <> 1 THEN
    RAISE EXCEPTION 'positive market claim must have exactly one settlement ledger group';
  END IF;
  SELECT * INTO claim_group
  FROM market_ledger_groups
  WHERE group_type = 'claim' AND claim_id = target_claim_id;

  IF claim_group.request_id IS DISTINCT FROM target_claim.client_request_id
     OR claim_group.order_id IS NOT NULL OR claim_group.trade_id IS NOT NULL
     OR NOT EXISTS (
       SELECT 1 FROM players
       WHERE id = target_claim.player_id AND account_id = target_claim.account_id
     ) THEN
    RAISE EXCEPTION 'market claim ledger request or actor does not match its claim';
  END IF;

  SELECT
    coalesce(sum(amount) FILTER (
      WHERE asset_kind = 'item' AND amount > 0 AND account_location = 'player_inventory'
    ), 0),
    coalesce(sum(amount) FILTER (
      WHERE asset_kind = 'gold' AND amount > 0 AND account_location = 'player_wallet'
    ), 0)
  INTO item_destination_total, gold_destination_total
  FROM market_ledger_entries
  WHERE ledger_group_id = claim_group.ledger_group_id;
  IF item_destination_total <> target_claim.item_units_claimed::numeric
     OR gold_destination_total <> target_claim.gold_claimed::numeric THEN
    RAISE EXCEPTION 'market claim destination totals do not match its claimed amounts';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM market_ledger_entries entry
    WHERE entry.ledger_group_id = claim_group.ledger_group_id
      AND (
        entry.player_id IS DISTINCT FROM target_claim.player_id
        OR entry.order_id IS NOT NULL OR entry.trade_id IS NOT NULL
        OR (entry.amount > 0 AND entry.collection_id IS NOT NULL)
        OR (entry.amount < 0 AND entry.collection_id IS NULL)
        OR (entry.asset_kind = 'item' AND entry.amount > 0
            AND entry.account_location <> 'player_inventory')
        OR (entry.asset_kind = 'item' AND entry.amount < 0
            AND entry.account_location NOT IN ('buyer_collection', 'return_collection'))
        OR (entry.asset_kind = 'gold' AND entry.amount > 0
            AND entry.account_location <> 'player_wallet')
        OR (entry.asset_kind = 'gold' AND entry.amount < 0
            AND entry.account_location NOT IN ('seller_proceeds', 'refund_balance', 'return_collection'))
      )
  ) THEN
    RAISE EXCEPTION 'market claim ledger contains an invalid source or destination entry';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM market_ledger_entries entry
    LEFT JOIN market_collections collection
      ON collection.collection_id = entry.collection_id
    WHERE entry.ledger_group_id = claim_group.ledger_group_id
      AND entry.amount < 0
      AND (
        collection.collection_id IS NULL
        OR collection.player_id <> target_claim.player_id
        OR collection.remaining_amount <> 0
        OR collection.asset_kind <> entry.asset_kind
        OR collection.item_identity IS DISTINCT FROM entry.item_identity
        OR collection.original_amount <> -entry.amount
      )
  ) THEN
    RAISE EXCEPTION 'market claim ledger source collection does not match its claim';
  END IF;
END;
$$ LANGUAGE plpgsql;
