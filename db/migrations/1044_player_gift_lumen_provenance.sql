-- Lumen is giftable (it is a material), but zero free minting still holds: a
-- gift claim may credit Lumen only up to what the sender's gift debit removed
-- for that exact gift package. Function last defined in 0991.
CREATE OR REPLACE FUNCTION enforce_lumen_inventory_provenance()
RETURNS trigger AS $$
BEGIN
  IF NEW.delta_quantity > 0 AND NEW.source NOT IN (
    'lumen_admin_grant', 'lumen_wallet_migration', 'atlas_pass_lumen_grant',
    'market_trade_purchase', 'market_manual_cancellation',
    'market_collection_claim', 'market_collection_repair',
    'pickup_dropped_item', 'manor_stack_withdrawal', 'manor_bulk_take',
    'player_gift_claim'
  ) THEN
    RAISE EXCEPTION 'Lumen cannot enter inventory from source %', NEW.source;
  END IF;
  -- A pass credit must be backed by its first-grant or accrual rows.
  IF NEW.delta_quantity > 0 AND NEW.source = 'atlas_pass_lumen_grant' AND NOT (
    EXISTS (
      SELECT 1 FROM premium_pass_first_grants grant_row
      WHERE grant_row.inventory_operation_key = NEW.operation_key
        AND grant_row.player_id = NEW.player_id
        AND grant_row.lumen = NEW.delta_quantity
    )
    OR NEW.delta_quantity = (
      SELECT sum(accrual.lumen) FROM premium_pass_accruals accrual
      WHERE accrual.inventory_operation_key = NEW.operation_key
        AND accrual.player_id = NEW.player_id
    )
  ) THEN
    RAISE EXCEPTION 'Atlas Pass Lumen credit has no matching paid accrual';
  END IF;
  IF NEW.delta_quantity > 0 AND NEW.source = 'player_gift_claim' AND NEW.delta_quantity > COALESCE((
    SELECT sum(-sent.delta_quantity)
    FROM inventory_events sent
    JOIN player_packages package ON package.id::text = sent.source_entity_id
    JOIN player_package_campaigns campaign ON campaign.id = package.campaign_id
    WHERE sent.source = 'player_gift_send'
      AND sent.item_id = 'lumen'
      AND sent.delta_quantity < 0
      AND sent.source_entity_type = 'player_package'
      AND sent.source_entity_id = NEW.source_entity_id
      AND package.recipient_player_id = NEW.player_id
      AND campaign.kind = 'player_gift'
  ), 0) - COALESCE((
    SELECT sum(claimed.delta_quantity)
    FROM inventory_events claimed
    WHERE claimed.source = 'player_gift_claim'
      AND claimed.item_id = 'lumen'
      AND claimed.source_entity_id = NEW.source_entity_id
      AND claimed.player_id = NEW.player_id
  ), 0) THEN
    RAISE EXCEPTION 'Gift Lumen credit has no matching gift debit';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Lumen is a resource in the inventory catalog but its definition row is
-- category 'currency', so the 0698 (item_id, category) foreign key cannot hold
-- a Lumen gift line. Keep the same kind check as a trigger and allow exactly
-- that case; premium wallet currencies (Glimmer) are still refused.
ALTER TABLE player_package_items DROP CONSTRAINT player_package_items_physical_kind_fkey;

CREATE FUNCTION enforce_player_package_item_kind() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE definition_category text;
BEGIN
  IF NEW.canonical_item_id IS NULL THEN RETURN NEW; END IF;
  SELECT category INTO definition_category
  FROM item_definitions WHERE item_id = NEW.canonical_item_id FOR KEY SHARE;
  IF definition_category IS NULL
     OR NOT (
       definition_category = NEW.item_kind
       OR (NEW.item_kind = 'resource' AND definition_category = 'currency'
           AND NOT EXISTS (SELECT 1 FROM market_premium_assets premium
                           WHERE premium.item_id = NEW.canonical_item_id))
     ) THEN
    RAISE EXCEPTION 'Package line kind % does not match item %', NEW.item_kind, NEW.canonical_item_id
      USING ERRCODE = '23503', CONSTRAINT = 'player_package_items_physical_kind_fkey';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER player_package_items_physical_kind
BEFORE INSERT OR UPDATE OF item_kind, canonical_item_id ON player_package_items
FOR EACH ROW EXECUTE FUNCTION enforce_player_package_item_kind();
