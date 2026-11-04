-- Market orders settle immediately. Deferred recovery is reserved for expiration.

ALTER TABLE market_orders
  ADD COLUMN IF NOT EXISTS expires_at timestamptz;
CREATE OR REPLACE FUNCTION enforce_market_order_transition()
RETURNS trigger AS $$
BEGIN
  IF OLD.expires_at IS NOT NULL
     OR NEW.expires_at <> OLD.created_at + interval '7 days'
     OR (to_jsonb(NEW) - 'expires_at') IS DISTINCT FROM (to_jsonb(OLD) - 'expires_at') THEN
    RAISE EXCEPTION 'market order expiration backfill cannot change other fields';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
UPDATE market_orders
SET expires_at = created_at + interval '7 days'
WHERE expires_at IS NULL;
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;
ALTER TABLE market_orders
  ALTER COLUMN expires_at SET DEFAULT (clock_timestamp() + interval '7 days'),
  ALTER COLUMN expires_at SET NOT NULL;
ALTER TABLE market_orders DROP CONSTRAINT IF EXISTS market_orders_status_check;
ALTER TABLE market_orders
  ADD CONSTRAINT market_orders_status_check
  CHECK (status IN ('open', 'partially_filled', 'filled', 'cancelled', 'expired'));
ALTER TABLE market_orders
  ADD COLUMN IF NOT EXISTS expired_at timestamptz;
ALTER TABLE market_orders
  ADD CONSTRAINT market_orders_expired_state_check
  CHECK ((status = 'expired') = (expired_at IS NOT NULL));
CREATE INDEX IF NOT EXISTS market_orders_expiration_idx
  ON market_orders (expires_at, order_id)
  WHERE status IN ('open', 'partially_filled');

ALTER TABLE market_collections DROP CONSTRAINT IF EXISTS market_collections_reason_check;
ALTER TABLE market_collections
  ADD CONSTRAINT market_collections_reason_check
  CHECK (reason IN (
    'purchase', 'sell_proceeds', 'sell_cancel_return', 'buy_cancel_refund',
    'price_improvement_refund', 'sell_expired_return', 'buy_expired_refund'
  ));
ALTER TABLE market_collections
  DROP CONSTRAINT IF EXISTS market_collections_check2;
ALTER TABLE market_collections
  ADD CONSTRAINT market_collections_source_check
  CHECK (
    (reason IN ('purchase', 'sell_proceeds', 'price_improvement_refund')
      AND source_trade_id IS NOT NULL)
    OR
    (reason IN (
      'sell_cancel_return', 'buy_cancel_refund',
      'sell_expired_return', 'buy_expired_refund'
    ) AND source_trade_id IS NULL)
  );
CREATE UNIQUE INDEX IF NOT EXISTS market_collections_expiration_reason_order_idx
  ON market_collections (source_order_id, reason)
  WHERE reason IN ('sell_expired_return', 'buy_expired_refund');

ALTER TABLE market_equipment_listings
  ADD COLUMN IF NOT EXISTS expires_at timestamptz;
UPDATE market_equipment_listings
SET expires_at = created_at + interval '7 days'
WHERE expires_at IS NULL;
ALTER TABLE market_equipment_listings
  ALTER COLUMN expires_at SET DEFAULT (clock_timestamp() + interval '7 days'),
  ALTER COLUMN expires_at SET NOT NULL;
ALTER TABLE market_equipment_listings
  ADD COLUMN IF NOT EXISTS expired_at timestamptz;
ALTER TABLE market_equipment_listings
  DROP CONSTRAINT IF EXISTS market_equipment_listings_status_check;
ALTER TABLE market_equipment_listings
  ADD CONSTRAINT market_equipment_listings_status_check
  CHECK (status IN ('open', 'sold', 'cancelled', 'claimed', 'expired'));
CREATE INDEX IF NOT EXISTS market_equipment_listings_expiration_idx
  ON market_equipment_listings (expires_at, listing_id)
  WHERE status = 'open';

ALTER TABLE market_equipment_collections
  DROP CONSTRAINT IF EXISTS market_equipment_collections_reason_check;
ALTER TABLE market_equipment_collections
  ADD CONSTRAINT market_equipment_collections_reason_check
  CHECK (reason IN ('purchase', 'cancel_return', 'expired_return'));

CREATE TABLE IF NOT EXISTS market_legacy_collection_allowlist (
  collection_kind text NOT NULL
    CHECK (collection_kind IN ('material', 'equipment', 'equipment_gold')),
  collection_identity text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (collection_kind, collection_identity)
);
INSERT INTO market_legacy_collection_allowlist (collection_kind, collection_identity)
SELECT 'material', collection_id::text
FROM market_collections
WHERE reason NOT IN ('sell_expired_return', 'buy_expired_refund')
ON CONFLICT DO NOTHING;
INSERT INTO market_legacy_collection_allowlist (collection_kind, collection_identity)
SELECT 'equipment', collection_id::text
FROM market_equipment_collections
WHERE reason <> 'expired_return'
ON CONFLICT DO NOTHING;
INSERT INTO market_legacy_collection_allowlist (collection_kind, collection_identity)
SELECT 'equipment_gold', collection_id::text
FROM market_equipment_gold_collections
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS market_collection_repairs (
  repair_id bigserial PRIMARY KEY,
  collection_kind text NOT NULL
    CHECK (collection_kind IN ('material', 'equipment', 'equipment_gold')),
  collection_identity text NOT NULL,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  operation_key text NOT NULL UNIQUE,
  repaired_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (collection_kind, collection_identity)
);

CREATE OR REPLACE FUNCTION enforce_market_order_transition()
RETURNS trigger AS $$
BEGIN
  IF OLD.status IN ('filled', 'cancelled', 'expired') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'closed market order is immutable';
  END IF;
  IF NEW.order_id <> OLD.order_id
     OR NEW.venue_id <> OLD.venue_id
     OR NEW.player_id <> OLD.player_id
     OR NEW.account_id <> OLD.account_id
     OR NEW.book_id <> OLD.book_id
     OR NEW.item_identity <> OLD.item_identity
     OR NEW.item_id <> OLD.item_id
     OR NEW.variant <> OLD.variant
     OR NEW.side <> OLD.side
     OR NEW.order_policy <> OLD.order_policy
     OR NEW.limit_unit_price <> OLD.limit_unit_price
     OR NEW.original_quantity <> OLD.original_quantity
     OR NEW.priority_sequence <> OLD.priority_sequence
     OR NEW.book_version_created <> OLD.book_version_created
     OR NEW.client_request_id <> OLD.client_request_id
     OR NEW.fee_policy_id <> OLD.fee_policy_id
     OR NEW.fee_policy_version <> OLD.fee_policy_version
     OR NEW.rules_version <> OLD.rules_version
     OR NEW.created_at <> OLD.created_at
     OR NEW.expires_at <> OLD.expires_at THEN
    RAISE EXCEPTION 'immutable market order fields cannot change';
  END IF;
  IF NEW.filled_quantity < OLD.filled_quantity
     OR NEW.remaining_quantity > OLD.remaining_quantity THEN
    RAISE EXCEPTION 'market order fill progress cannot move backward';
  END IF;
  IF OLD.status = 'open'
     AND NEW.status NOT IN ('open', 'partially_filled', 'filled', 'cancelled', 'expired') THEN
    RAISE EXCEPTION 'invalid market order transition';
  ELSIF OLD.status = 'partially_filled'
     AND NEW.status NOT IN ('partially_filled', 'filled', 'cancelled', 'expired') THEN
    RAISE EXCEPTION 'invalid market order transition';
  ELSIF OLD.status IN ('filled', 'cancelled', 'expired')
     AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'closed market order cannot transition';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION validate_market_collection_commit(target_collection_id bigint)
RETURNS void AS $$
DECLARE
  target_collection market_collections%ROWTYPE;
  source_order market_orders%ROWTYPE;
  source_trade market_trades%ROWTYPE;
  source_fee market_fee_policies%ROWTYPE;
  related_count bigint;
  expected_return_amount numeric;
  settlement_group_type text;
  settlement_trade_id uuid;
  settlement_location text;
  claim_source_location text;
BEGIN
  SELECT * INTO target_collection FROM market_collections
  WHERE collection_id = target_collection_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'market settlement references a missing collection';
  END IF;
  SELECT * INTO source_order FROM market_orders
  WHERE order_id = target_collection.source_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'market collection source order does not exist';
  END IF;

  IF target_collection.reason = 'purchase' THEN
    SELECT * INTO source_trade FROM market_trades
    WHERE trade_id = target_collection.source_trade_id;
    IF NOT FOUND
       OR target_collection.source_order_id <> source_trade.buy_order_id
       OR target_collection.player_id <> source_trade.buyer_player_id
       OR target_collection.asset_kind <> 'item'
       OR target_collection.item_identity <> source_trade.item_identity
       OR target_collection.item_id <> source_trade.item_id
       OR target_collection.variant <> source_trade.variant
       OR target_collection.original_amount <> source_trade.quantity THEN
      RAISE EXCEPTION 'purchase collection provenance is inconsistent';
    END IF;
    settlement_group_type := 'trade';
    settlement_trade_id := source_trade.trade_id;
    settlement_location := 'buyer_collection';
  ELSIF target_collection.reason = 'sell_proceeds' THEN
    SELECT * INTO source_trade FROM market_trades
    WHERE trade_id = target_collection.source_trade_id;
    IF NOT FOUND
       OR target_collection.source_order_id <> source_trade.sell_order_id
       OR target_collection.player_id <> source_trade.seller_player_id
       OR target_collection.asset_kind <> 'gold'
       OR target_collection.original_amount
          <> source_trade.gross_value - source_trade.seller_fee THEN
      RAISE EXCEPTION 'seller proceeds collection provenance is inconsistent';
    END IF;
    settlement_group_type := 'trade';
    settlement_trade_id := source_trade.trade_id;
    settlement_location := 'seller_proceeds';
  ELSIF target_collection.reason = 'price_improvement_refund' THEN
    SELECT * INTO source_trade FROM market_trades
    WHERE trade_id = target_collection.source_trade_id;
    IF NOT FOUND
       OR target_collection.source_order_id <> source_trade.buy_order_id
       OR target_collection.player_id <> source_trade.buyer_player_id
       OR target_collection.asset_kind <> 'gold' THEN
      RAISE EXCEPTION 'price-improvement collection provenance is inconsistent';
    END IF;
    settlement_group_type := 'trade';
    settlement_trade_id := source_trade.trade_id;
    settlement_location := 'refund_balance';
  ELSE
    IF target_collection.player_id <> source_order.player_id
       OR (
         target_collection.reason IN ('sell_cancel_return', 'buy_cancel_refund')
         AND source_order.status <> 'cancelled'
       )
       OR (
         target_collection.reason IN ('sell_expired_return', 'buy_expired_refund')
         AND source_order.status <> 'expired'
       )
       OR (source_order.side = 'sell' AND (
         target_collection.reason NOT IN ('sell_cancel_return', 'sell_expired_return')
         OR target_collection.asset_kind <> 'item'
         OR target_collection.item_identity <> source_order.item_identity
         OR target_collection.item_id <> source_order.item_id
         OR target_collection.variant <> source_order.variant
         OR target_collection.original_amount <> source_order.remaining_quantity
       ))
       OR (source_order.side = 'buy' AND (
         target_collection.reason NOT IN ('buy_cancel_refund', 'buy_expired_refund')
         OR target_collection.asset_kind <> 'gold'
       )) THEN
      RAISE EXCEPTION 'market return collection provenance is inconsistent';
    END IF;
    IF source_order.side = 'buy' THEN
      SELECT * INTO source_fee FROM market_fee_policies
      WHERE fee_policy_id = source_order.fee_policy_id
        AND version = source_order.fee_policy_version;
      expected_return_amount := source_order.limit_unit_price::numeric
        * source_order.remaining_quantity::numeric;
      expected_return_amount := expected_return_amount
        + floor(expected_return_amount * source_fee.buyer_fee_bps::numeric / 10000);
      IF source_fee.fee_policy_id IS NULL
         OR target_collection.original_amount::numeric <> expected_return_amount THEN
        RAISE EXCEPTION 'buy return does not match remaining escrow';
      END IF;
    END IF;
    settlement_group_type := 'cancel';
    settlement_trade_id := NULL;
    settlement_location := CASE
      WHEN target_collection.reason IN ('sell_expired_return', 'buy_expired_refund')
        THEN 'return_collection'
      WHEN source_order.side = 'sell' THEN 'return_collection'
      ELSE 'refund_balance'
    END;
  END IF;

  SELECT count(*) INTO related_count
  FROM market_ledger_entries entry
  JOIN market_ledger_groups group_row USING (ledger_group_id)
  WHERE entry.collection_id = target_collection_id
    AND group_row.group_type = settlement_group_type
    AND group_row.order_id IS NOT DISTINCT FROM CASE
      WHEN settlement_group_type = 'cancel'
        THEN target_collection.source_order_id
      ELSE NULL
    END
    AND group_row.trade_id IS NOT DISTINCT FROM settlement_trade_id
    AND entry.asset_kind = target_collection.asset_kind
    AND entry.item_identity IS NOT DISTINCT FROM target_collection.item_identity
    AND entry.amount = target_collection.original_amount
    AND entry.account_location = settlement_location
    AND entry.player_id = target_collection.player_id
    AND entry.order_id = target_collection.source_order_id
    AND entry.trade_id IS NOT DISTINCT FROM settlement_trade_id;
  IF related_count <> 1 THEN
    RAISE EXCEPTION 'market collection must have exactly one matching settlement credit';
  END IF;

  claim_source_location := CASE
    WHEN target_collection.reason IN ('sell_expired_return', 'buy_expired_refund')
      THEN 'return_collection'
    WHEN target_collection.asset_kind = 'item'
      AND target_collection.reason = 'sell_cancel_return'
      THEN 'return_collection'
    WHEN target_collection.asset_kind = 'item' THEN 'buyer_collection'
    WHEN target_collection.reason = 'sell_proceeds' THEN 'seller_proceeds'
    ELSE 'refund_balance'
  END;
  SELECT count(*) INTO related_count
  FROM market_ledger_entries entry
  JOIN market_ledger_groups group_row USING (ledger_group_id)
  WHERE entry.collection_id = target_collection_id
    AND group_row.group_type = 'claim'
    AND entry.asset_kind = target_collection.asset_kind
    AND entry.item_identity IS NOT DISTINCT FROM target_collection.item_identity
    AND entry.amount = -target_collection.original_amount
    AND entry.account_location = claim_source_location
    AND entry.player_id = target_collection.player_id;
  IF (target_collection.remaining_amount = 0 AND related_count <> 1)
     OR (target_collection.remaining_amount > 0 AND related_count <> 0) THEN
    RAISE EXCEPTION 'market collection claim state does not match its claim ledger';
  END IF;
  SELECT count(*) INTO related_count FROM market_ledger_entries
  WHERE collection_id = target_collection_id;
  IF related_count <> (CASE WHEN target_collection.remaining_amount = 0 THEN 2 ELSE 1 END) THEN
    RAISE EXCEPTION 'market collection has an unexpected ledger reference';
  END IF;
  IF target_collection.source_trade_id IS NOT NULL THEN
    PERFORM validate_market_trade_commit(target_collection.source_trade_id);
  ELSE
    PERFORM validate_market_order_commit(target_collection.source_order_id);
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION validate_market_order_commit(target_order_id uuid)
RETURNS void AS $$
DECLARE
  target_order market_orders%ROWTYPE;
  target_escrow market_order_escrows%ROWTYPE;
  target_fee market_fee_policies%ROWTYPE;
  recovery_collection market_collections%ROWTYPE;
  escrow_group_id uuid;
  close_group_id uuid;
  related_count bigint;
  settled_quantity numeric;
  expected_amount numeric;
  debit_location text;
  credit_location text;
BEGIN
  SELECT * INTO target_order FROM market_orders WHERE order_id = target_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'market settlement references a missing order';
  END IF;
  SELECT * INTO target_escrow FROM market_order_escrows WHERE order_id = target_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'market order must have exactly one escrow';
  END IF;
  SELECT * INTO target_fee FROM market_fee_policies
  WHERE fee_policy_id = target_order.fee_policy_id
    AND version = target_order.fee_policy_version;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'market order fee snapshot does not exist';
  END IF;
  IF target_escrow.player_id <> target_order.player_id THEN
    RAISE EXCEPTION 'market escrow owner does not match its order';
  END IF;
  IF target_order.side = 'sell' THEN
    IF target_escrow.asset_kind <> 'item'
       OR target_escrow.item_identity IS DISTINCT FROM target_order.item_identity
       OR target_escrow.item_id IS DISTINCT FROM target_order.item_id
       OR target_escrow.variant IS DISTINCT FROM target_order.variant
       OR target_escrow.initial_amount <> target_order.original_quantity THEN
      RAISE EXCEPTION 'sell escrow asset or amount does not match its order';
    END IF;
  ELSE
    IF target_escrow.asset_kind <> 'gold'
       OR target_escrow.item_identity IS NOT NULL
       OR target_escrow.item_id IS NOT NULL
       OR target_escrow.variant IS NOT NULL THEN
      RAISE EXCEPTION 'buy escrow asset does not match its order';
    END IF;
    IF target_order.order_policy <> 'aon_ioc' THEN
      expected_amount := target_order.limit_unit_price::numeric
        * target_order.original_quantity::numeric;
      expected_amount := expected_amount
        + floor(expected_amount * target_fee.buyer_fee_bps::numeric / 10000);
      IF target_escrow.initial_amount::numeric <> expected_amount THEN
        RAISE EXCEPTION 'buy escrow initial amount does not match its order limit';
      END IF;
    END IF;
  END IF;
  IF target_order.order_policy = 'aon_ioc' AND target_order.status <> 'filled' THEN
    RAISE EXCEPTION 'atomic immediate order cannot commit without a complete fill';
  END IF;
  IF target_order.status IN ('filled', 'cancelled', 'expired') THEN
    IF target_escrow.remaining_amount <> 0 THEN
      RAISE EXCEPTION 'closed market order must have empty escrow';
    END IF;
  ELSIF target_escrow.remaining_amount <= 0 THEN
    RAISE EXCEPTION 'open market order must retain escrow';
  ELSIF target_order.side = 'sell' THEN
    IF target_escrow.remaining_amount <> target_order.remaining_quantity THEN
      RAISE EXCEPTION 'sell escrow remaining amount does not match open quantity';
    END IF;
  ELSE
    expected_amount := target_order.limit_unit_price::numeric
      * target_order.remaining_quantity::numeric;
    expected_amount := expected_amount
      + floor(expected_amount * target_fee.buyer_fee_bps::numeric / 10000);
    IF target_escrow.remaining_amount::numeric <> expected_amount THEN
      RAISE EXCEPTION 'buy escrow remaining amount does not match open quantity';
    END IF;
  END IF;
  SELECT coalesce(sum(quantity), 0) INTO settled_quantity
  FROM market_trades
  WHERE buy_order_id = target_order_id OR sell_order_id = target_order_id;
  IF settled_quantity <> target_order.filled_quantity::numeric THEN
    RAISE EXCEPTION 'order fill progress does not match its durable trades';
  END IF;

  SELECT count(*) INTO related_count FROM market_ledger_groups
  WHERE group_type = 'order_escrow' AND order_id = target_order_id;
  IF related_count <> 1 THEN
    RAISE EXCEPTION 'market order must have exactly one escrow ledger group';
  END IF;
  SELECT ledger_group_id INTO escrow_group_id FROM market_ledger_groups
  WHERE group_type = 'order_escrow' AND order_id = target_order_id;
  debit_location := CASE WHEN target_order.side = 'sell'
    THEN 'player_inventory' ELSE 'player_wallet' END;
  credit_location := CASE WHEN target_order.side = 'sell'
    THEN 'sell_escrow' ELSE 'buy_escrow' END;
  SELECT count(*) INTO related_count FROM market_ledger_entries
  WHERE ledger_group_id = escrow_group_id;
  IF related_count <> 2
     OR NOT EXISTS (
       SELECT 1 FROM market_ledger_entries WHERE ledger_group_id = escrow_group_id
         AND asset_kind = target_escrow.asset_kind
         AND item_identity IS NOT DISTINCT FROM target_escrow.item_identity
         AND amount = -target_escrow.initial_amount
         AND account_location = debit_location
         AND player_id = target_order.player_id AND order_id = target_order_id
         AND trade_id IS NULL AND collection_id IS NULL
     )
     OR NOT EXISTS (
       SELECT 1 FROM market_ledger_entries WHERE ledger_group_id = escrow_group_id
         AND asset_kind = target_escrow.asset_kind
         AND item_identity IS NOT DISTINCT FROM target_escrow.item_identity
         AND amount = target_escrow.initial_amount
         AND account_location = credit_location
         AND player_id = target_order.player_id AND order_id = target_order_id
         AND trade_id IS NULL AND collection_id IS NULL
     ) THEN
    RAISE EXCEPTION 'market escrow ledger does not match its order';
  END IF;

  SELECT count(*) INTO related_count FROM market_ledger_groups
  WHERE group_type = 'cancel' AND order_id = target_order_id;
  IF target_order.status IN ('cancelled', 'expired') THEN
    IF related_count <> 1 THEN
      RAISE EXCEPTION 'closed market order must have exactly one return ledger group';
    END IF;
    SELECT ledger_group_id INTO close_group_id FROM market_ledger_groups
    WHERE group_type = 'cancel' AND order_id = target_order_id;
    IF target_order.status = 'cancelled' THEN
      SELECT count(*) INTO related_count
      FROM market_collections collection
      JOIN market_legacy_collection_allowlist allowlist
        ON allowlist.collection_kind = 'material'
       AND allowlist.collection_identity = collection.collection_id::text
      WHERE collection.source_order_id = target_order_id
        AND collection.reason IN ('sell_cancel_return', 'buy_cancel_refund');
      IF related_count > 1 THEN
        RAISE EXCEPTION 'manually cancelled market order has duplicate legacy returns';
      ELSIF related_count = 1 THEN
        SELECT collection.* INTO recovery_collection
        FROM market_collections collection
        JOIN market_legacy_collection_allowlist allowlist
          ON allowlist.collection_kind = 'material'
         AND allowlist.collection_identity = collection.collection_id::text
        WHERE collection.source_order_id = target_order_id
          AND collection.reason IN ('sell_cancel_return', 'buy_cancel_refund');
        expected_amount := recovery_collection.original_amount;
        credit_location := CASE WHEN target_order.side = 'sell'
          THEN 'return_collection' ELSE 'refund_balance' END;
      ELSE
        expected_amount := CASE WHEN target_order.side = 'sell'
          THEN target_order.remaining_quantity::numeric
          ELSE target_order.limit_unit_price::numeric
            * target_order.remaining_quantity::numeric
        END;
        IF target_order.side = 'buy' THEN
          expected_amount := expected_amount
            + floor(expected_amount * target_fee.buyer_fee_bps::numeric / 10000);
        END IF;
        credit_location := CASE WHEN target_order.side = 'sell'
          THEN 'player_inventory' ELSE 'player_wallet' END;
      END IF;
    ELSE
      SELECT count(*) INTO related_count FROM market_collections
      WHERE source_order_id = target_order_id
        AND reason IN ('sell_expired_return', 'buy_expired_refund');
      IF related_count <> 1 THEN
        RAISE EXCEPTION 'expired market order must have exactly one recovery collection';
      END IF;
      SELECT * INTO recovery_collection FROM market_collections
      WHERE source_order_id = target_order_id
        AND reason IN ('sell_expired_return', 'buy_expired_refund');
      expected_amount := recovery_collection.original_amount;
      credit_location := 'return_collection';
    END IF;
    debit_location := CASE WHEN target_order.side = 'sell'
      THEN 'sell_escrow' ELSE 'buy_escrow' END;
    SELECT count(*) INTO related_count FROM market_ledger_entries
    WHERE ledger_group_id = close_group_id;
    IF related_count <> 2
       OR NOT EXISTS (
         SELECT 1 FROM market_ledger_entries WHERE ledger_group_id = close_group_id
           AND asset_kind = target_escrow.asset_kind
           AND item_identity IS NOT DISTINCT FROM target_escrow.item_identity
           AND amount = -expected_amount AND account_location = debit_location
           AND player_id = target_order.player_id AND order_id = target_order_id
           AND trade_id IS NULL AND collection_id IS NULL
       )
       OR NOT EXISTS (
         SELECT 1 FROM market_ledger_entries WHERE ledger_group_id = close_group_id
           AND asset_kind = target_escrow.asset_kind
           AND item_identity IS NOT DISTINCT FROM target_escrow.item_identity
           AND amount = expected_amount AND account_location = credit_location
           AND player_id = target_order.player_id AND order_id = target_order_id
           AND trade_id IS NULL
           AND collection_id IS NOT DISTINCT FROM recovery_collection.collection_id
       ) THEN
      RAISE EXCEPTION 'market order return ledger is inconsistent';
    END IF;
  ELSIF related_count <> 0 OR EXISTS (
    SELECT 1 FROM market_collections
    WHERE source_order_id = target_order_id
      AND reason IN (
        'sell_cancel_return', 'buy_cancel_refund',
        'sell_expired_return', 'buy_expired_refund'
      )
  ) THEN
    RAISE EXCEPTION 'open or filled market order cannot have return settlement';
  END IF;
END;
$$ LANGUAGE plpgsql;

-- Material settlement now credits authoritative inventory and wallets directly.
-- Expiration remains the only path that creates a new recovery collection.
CREATE OR REPLACE FUNCTION validate_market_trade_commit(target_trade_id uuid)
RETURNS void AS $$
DECLARE
  target_trade market_trades%ROWTYPE;
  buy_order market_orders%ROWTYPE;
  sell_order market_orders%ROWTYPE;
  maker_order market_orders%ROWTYPE;
  buyer_fee_policy market_fee_policies%ROWTYPE;
  seller_fee_policy market_fee_policies%ROWTYPE;
  trade_group_id uuid;
  related_count bigint;
  expected_entries integer;
  seller_proceeds bigint;
  refund_amount bigint;
  fee_total bigint;
  legacy_collection_count bigint;
BEGIN
  SELECT * INTO target_trade FROM market_trades WHERE trade_id = target_trade_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'market settlement references a missing trade';
  END IF;
  SELECT * INTO buy_order FROM market_orders WHERE order_id = target_trade.buy_order_id;
  SELECT * INTO sell_order FROM market_orders WHERE order_id = target_trade.sell_order_id;
  SELECT * INTO maker_order FROM market_orders WHERE order_id = target_trade.maker_order_id;
  IF buy_order.order_id IS NULL OR sell_order.order_id IS NULL OR maker_order.order_id IS NULL
     OR buy_order.side <> 'buy' OR sell_order.side <> 'sell'
     OR buy_order.account_id = sell_order.account_id
     OR buy_order.player_id <> target_trade.buyer_player_id
     OR sell_order.player_id <> target_trade.seller_player_id
     OR buy_order.venue_id <> target_trade.venue_id
     OR sell_order.venue_id <> target_trade.venue_id
     OR buy_order.book_id <> target_trade.book_id
     OR sell_order.book_id <> target_trade.book_id
     OR buy_order.item_identity <> target_trade.item_identity
     OR sell_order.item_identity <> target_trade.item_identity
     OR buy_order.item_id <> target_trade.item_id
     OR sell_order.item_id <> target_trade.item_id
     OR buy_order.variant <> target_trade.variant
     OR sell_order.variant <> target_trade.variant THEN
    RAISE EXCEPTION 'market trade buy/sell relationships are inconsistent';
  END IF;
  IF target_trade.seller_fee_policy_id <> sell_order.fee_policy_id
     OR target_trade.seller_fee_policy_version <> sell_order.fee_policy_version THEN
    RAISE EXCEPTION 'market trade seller fee snapshot does not match its order';
  END IF;
  SELECT * INTO buyer_fee_policy FROM market_fee_policies
  WHERE fee_policy_id = target_trade.buyer_fee_policy_id
    AND version = target_trade.buyer_fee_policy_version;
  SELECT * INTO seller_fee_policy FROM market_fee_policies
  WHERE fee_policy_id = target_trade.seller_fee_policy_id
    AND version = target_trade.seller_fee_policy_version;
  IF buyer_fee_policy.fee_policy_id IS NULL OR seller_fee_policy.fee_policy_id IS NULL
     OR target_trade.applied_buyer_tax_bps <> buyer_fee_policy.buyer_fee_bps
     OR target_trade.buyer_fee::numeric
        <> floor(target_trade.gross_value::numeric * buyer_fee_policy.buyer_fee_bps::numeric / 10000)
     OR target_trade.seller_fee::numeric
        <> floor(target_trade.gross_value::numeric * seller_fee_policy.seller_fee_bps::numeric / 10000) THEN
    RAISE EXCEPTION 'market trade fees do not match immutable fee snapshots';
  END IF;
  IF target_trade.maker_order_id NOT IN (target_trade.buy_order_id, target_trade.sell_order_id)
     OR maker_order.limit_unit_price <> target_trade.unit_price
     OR target_trade.quantity > buy_order.original_quantity
     OR target_trade.quantity > sell_order.original_quantity THEN
    RAISE EXCEPTION 'market trade maker, price, or quantity is inconsistent';
  END IF;

  SELECT count(*) INTO legacy_collection_count
  FROM market_collections collection
  JOIN market_legacy_collection_allowlist allowlist
    ON allowlist.collection_kind = 'material'
   AND allowlist.collection_identity = collection.collection_id::text
  WHERE collection.source_trade_id = target_trade_id;
  IF legacy_collection_count > 0 THEN
    SELECT count(*) INTO related_count FROM market_collections
    WHERE source_trade_id = target_trade_id AND reason = 'purchase'
      AND player_id = target_trade.buyer_player_id
      AND original_amount = target_trade.quantity;
    IF related_count <> 1 THEN
      RAISE EXCEPTION 'legacy market trade buyer collection is inconsistent';
    END IF;
    seller_proceeds := target_trade.gross_value - target_trade.seller_fee;
    SELECT count(*) INTO related_count FROM market_collections
    WHERE source_trade_id = target_trade_id AND reason = 'sell_proceeds'
      AND player_id = target_trade.seller_player_id
      AND original_amount = seller_proceeds;
    IF (seller_proceeds > 0 AND related_count <> 1)
       OR (seller_proceeds = 0 AND related_count <> 0) THEN
      RAISE EXCEPTION 'legacy market trade seller collection is inconsistent';
    END IF;
    SELECT count(*) INTO related_count FROM market_ledger_groups
    WHERE group_type = 'trade' AND trade_id = target_trade_id;
    IF related_count <> 1 THEN
      RAISE EXCEPTION 'legacy market trade must retain one settlement ledger group';
    END IF;
    PERFORM validate_market_order_commit(target_trade.buy_order_id);
    PERFORM validate_market_order_commit(target_trade.sell_order_id);
    RETURN;
  END IF;
  SELECT count(*) INTO related_count FROM market_collections
  WHERE source_trade_id = target_trade_id;
  IF related_count <> 0 THEN
    RAISE EXCEPTION 'immediately settled market trade cannot create a collection';
  END IF;
  SELECT count(*), coalesce(sum(delta_gold), 0)
  INTO related_count, refund_amount
  FROM wallet_events
  WHERE market_trade_id = target_trade_id
    AND player_id = target_trade.buyer_player_id
    AND reason = 'market_trade_price_improvement';
  IF related_count > 1 OR refund_amount < 0 THEN
    RAISE EXCEPTION 'market trade buyer refund wallet transition is inconsistent';
  END IF;
  seller_proceeds := target_trade.gross_value - target_trade.seller_fee;
  SELECT count(*) INTO related_count
  FROM wallet_events
  WHERE market_trade_id = target_trade_id
    AND player_id = target_trade.seller_player_id
    AND reason = 'market_trade_seller_proceeds'
    AND delta_gold = seller_proceeds;
  IF (seller_proceeds > 0 AND related_count <> 1)
     OR (seller_proceeds = 0 AND related_count <> 0) THEN
    RAISE EXCEPTION 'market trade seller wallet transition is inconsistent';
  END IF;
  SELECT count(*) INTO related_count
  FROM inventory_events
  WHERE operation_key = 'market-trade-item:' || target_trade_id::text
    AND player_id = target_trade.buyer_player_id
    AND item_id = target_trade.item_id
    AND variant = target_trade.variant
    AND delta_quantity = target_trade.quantity;
  IF related_count <> 1 THEN
    RAISE EXCEPTION 'market trade buyer inventory transition is inconsistent';
  END IF;

  SELECT count(*) INTO related_count FROM market_ledger_groups
  WHERE group_type = 'trade' AND trade_id = target_trade_id;
  IF related_count <> 1 THEN
    RAISE EXCEPTION 'market trade must have exactly one settlement ledger group';
  END IF;
  SELECT ledger_group_id INTO trade_group_id FROM market_ledger_groups
  WHERE group_type = 'trade' AND trade_id = target_trade_id;
  fee_total := target_trade.buyer_fee + target_trade.seller_fee;
  expected_entries := 3
    + CASE WHEN seller_proceeds > 0 THEN 1 ELSE 0 END
    + CASE WHEN refund_amount > 0 THEN 1 ELSE 0 END
    + CASE WHEN fee_total > 0 THEN 1 ELSE 0 END;
  SELECT count(*) INTO related_count FROM market_ledger_entries
  WHERE ledger_group_id = trade_group_id;
  IF related_count <> expected_entries
     OR NOT EXISTS (
       SELECT 1 FROM market_ledger_entries WHERE ledger_group_id = trade_group_id
         AND asset_kind = 'item' AND item_identity = target_trade.item_identity
         AND amount = -target_trade.quantity AND account_location = 'sell_escrow'
         AND player_id = target_trade.seller_player_id
         AND order_id = target_trade.sell_order_id AND trade_id = target_trade_id
         AND collection_id IS NULL
     )
     OR NOT EXISTS (
       SELECT 1 FROM market_ledger_entries WHERE ledger_group_id = trade_group_id
         AND asset_kind = 'item' AND item_identity = target_trade.item_identity
         AND amount = target_trade.quantity AND account_location = 'player_inventory'
         AND player_id = target_trade.buyer_player_id
         AND order_id = target_trade.buy_order_id AND trade_id = target_trade_id
         AND collection_id IS NULL
     )
     OR NOT EXISTS (
       SELECT 1 FROM market_ledger_entries WHERE ledger_group_id = trade_group_id
         AND asset_kind = 'gold' AND item_identity IS NULL
         AND amount = -(target_trade.gross_value + target_trade.buyer_fee + refund_amount)
         AND account_location = 'buy_escrow'
         AND player_id = target_trade.buyer_player_id
         AND order_id = target_trade.buy_order_id AND trade_id = target_trade_id
         AND collection_id IS NULL
     ) THEN
    RAISE EXCEPTION 'market trade base ledger settlement is inconsistent';
  END IF;
  IF seller_proceeds > 0 AND NOT EXISTS (
    SELECT 1 FROM market_ledger_entries WHERE ledger_group_id = trade_group_id
      AND asset_kind = 'gold' AND item_identity IS NULL
      AND amount = seller_proceeds AND account_location = 'player_wallet'
      AND player_id = target_trade.seller_player_id
      AND order_id = target_trade.sell_order_id AND trade_id = target_trade_id
      AND collection_id IS NULL
  ) THEN
    RAISE EXCEPTION 'market trade seller ledger settlement is inconsistent';
  END IF;
  IF refund_amount > 0 AND NOT EXISTS (
    SELECT 1 FROM market_ledger_entries WHERE ledger_group_id = trade_group_id
      AND asset_kind = 'gold' AND item_identity IS NULL
      AND amount = refund_amount AND account_location = 'player_wallet'
      AND player_id = target_trade.buyer_player_id
      AND order_id = target_trade.buy_order_id AND trade_id = target_trade_id
      AND collection_id IS NULL
  ) THEN
    RAISE EXCEPTION 'market trade refund ledger settlement is inconsistent';
  END IF;
  IF fee_total > 0 AND NOT EXISTS (
    SELECT 1 FROM market_ledger_entries WHERE ledger_group_id = trade_group_id
      AND asset_kind = 'gold' AND item_identity IS NULL
      AND amount = fee_total AND account_location = 'fee_sink'
      AND player_id IS NULL AND order_id IS NULL AND trade_id = target_trade_id
      AND collection_id IS NULL
  ) THEN
    RAISE EXCEPTION 'market trade fee ledger settlement is inconsistent';
  END IF;
  PERFORM validate_market_order_commit(target_trade.buy_order_id);
  PERFORM validate_market_order_commit(target_trade.sell_order_id);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION validate_market_trade_hardening_commit(target_trade_id uuid)
RETURNS void AS $$
DECLARE
  target_trade market_trades%ROWTYPE;
  buy_order market_orders%ROWTYPE;
  sell_order market_orders%ROWTYPE;
  maker_order market_orders%ROWTYPE;
  taker_order market_orders%ROWTYPE;
  buyer_fee_policy market_fee_policies%ROWTYPE;
  buy_reserve_fee_policy market_fee_policies%ROWTYPE;
  prior_fill_quantity numeric;
  remaining_before numeric;
  remaining_after numeric;
  required_before numeric;
  required_after numeric;
  expected_refund numeric;
  refund_count bigint;
  refund_total numeric;
BEGIN
  SELECT * INTO target_trade FROM market_trades WHERE trade_id = target_trade_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'market hardening validator references a missing trade';
  END IF;
  SELECT * INTO buy_order FROM market_orders WHERE order_id = target_trade.buy_order_id;
  SELECT * INTO sell_order FROM market_orders WHERE order_id = target_trade.sell_order_id;
  SELECT * INTO maker_order FROM market_orders WHERE order_id = target_trade.maker_order_id;
  SELECT * INTO taker_order FROM market_orders
  WHERE order_id = CASE
    WHEN target_trade.maker_order_id = target_trade.buy_order_id
      THEN target_trade.sell_order_id
    ELSE target_trade.buy_order_id
  END;
  SELECT * INTO buyer_fee_policy FROM market_fee_policies
  WHERE fee_policy_id = target_trade.buyer_fee_policy_id
    AND version = target_trade.buyer_fee_policy_version;
  SELECT * INTO buy_reserve_fee_policy FROM market_fee_policies
  WHERE fee_policy_id = buy_order.fee_policy_id
    AND version = buy_order.fee_policy_version;

  IF buy_order.order_id IS NULL OR sell_order.order_id IS NULL
     OR maker_order.order_id IS NULL OR taker_order.order_id IS NULL
     OR buyer_fee_policy.fee_policy_id IS NULL
     OR buy_reserve_fee_policy.fee_policy_id IS NULL THEN
    RAISE EXCEPTION 'market hardening trade relationship is incomplete';
  END IF;
  IF target_trade.unit_price > buy_order.limit_unit_price
     OR target_trade.unit_price < sell_order.limit_unit_price
     OR maker_order.limit_unit_price <> target_trade.unit_price
     OR maker_order.priority_sequence >= taker_order.priority_sequence THEN
    RAISE EXCEPTION 'market trade price or priority is inconsistent';
  END IF;

  IF buy_order.order_policy = 'aon_ioc' THEN
    expected_refund := 0;
  ELSE
    SELECT coalesce(sum(quantity), 0) INTO prior_fill_quantity
    FROM market_trades
    WHERE buy_order_id = buy_order.order_id
      AND book_id = target_trade.book_id
      AND book_version < target_trade.book_version;
    remaining_before := buy_order.original_quantity::numeric - prior_fill_quantity;
    remaining_after := remaining_before - target_trade.quantity::numeric;
    required_before := buy_order.limit_unit_price::numeric * remaining_before;
    required_before := required_before
      + floor(required_before * buy_reserve_fee_policy.buyer_fee_bps::numeric / 10000);
    required_after := buy_order.limit_unit_price::numeric * remaining_after;
    required_after := required_after
      + floor(required_after * buy_reserve_fee_policy.buyer_fee_bps::numeric / 10000);
    expected_refund := required_before - required_after
      - target_trade.gross_value::numeric - target_trade.buyer_fee::numeric;
    IF remaining_before <= 0 OR remaining_after < 0 OR expected_refund < 0 THEN
      RAISE EXCEPTION 'market trade implies an invalid price-improvement refund';
    END IF;
  END IF;

  SELECT count(*), coalesce(sum(delta_gold), 0)
  INTO refund_count, refund_total
  FROM wallet_events
  WHERE market_trade_id = target_trade_id
    AND player_id = target_trade.buyer_player_id
    AND reason = 'market_trade_price_improvement';
  IF expected_refund > 0 AND refund_count = 0 THEN
    SELECT count(*), coalesce(sum(original_amount), 0)
    INTO refund_count, refund_total
    FROM market_collections
    WHERE source_trade_id = target_trade_id
      AND player_id = target_trade.buyer_player_id
      AND reason = 'price_improvement_refund';
  END IF;
  IF (expected_refund = 0 AND (refund_count <> 0 OR refund_total <> 0))
     OR (expected_refund > 0
       AND (refund_count <> 1 OR refund_total <> expected_refund)) THEN
    RAISE EXCEPTION 'market price-improvement wallet transition is not independently correct';
  END IF;
END;
$$ LANGUAGE plpgsql;
