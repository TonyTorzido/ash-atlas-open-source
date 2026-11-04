-- Additive financial-integrity hardening for inventory, wallets, world drops,
-- quotes, fee provenance, controls, and market settlement. 0600 is already
-- deployed and intentionally remains unchanged.

LOCK TABLE player_wallets, wallet_events, player_inventory, inventory_operations,
  inventory_events, world_item_drops, world_item_pickups, market_orders,
  market_order_escrows, market_trades, market_collections, market_ledger_groups,
  market_ledger_entries IN ACCESS EXCLUSIVE MODE;

-- ---------------------------------------------------------------------------
-- Authoritative item catalog and quote replay/replacement state.
-- ---------------------------------------------------------------------------

ALTER TABLE item_definitions
  ADD COLUMN IF NOT EXISTS supported_variants text[] NOT NULL DEFAULT ARRAY['default']::text[];

UPDATE item_definitions
SET market_tradable = true,
    market_fungible = true,
    market_identity = item_id,
    supported_variants = ARRAY['default']::text[],
    updated_at = now()
WHERE item_id IN ('wood', 'stone', 'food', 'ore');

UPDATE item_definitions
SET market_tradable = false,
    market_fungible = false,
    market_identity = NULL,
    supported_variants = ARRAY['default', 'fresh', 'salt']::text[],
    updated_at = now()
WHERE item_id = 'water';

UPDATE item_definitions
SET market_tradable = false,
    market_fungible = false,
    market_identity = NULL,
    supported_variants = ARRAY['default']::text[],
    updated_at = now()
WHERE item_id IN ('starter_sword', 'padded_tunic');

ALTER TABLE item_definitions
  DROP CONSTRAINT IF EXISTS item_definitions_supported_variants_check;
ALTER TABLE item_definitions
  ADD CONSTRAINT item_definitions_supported_variants_check
  CHECK (
    cardinality(supported_variants) > 0
    AND array_position(supported_variants, NULL) IS NULL
    AND NOT ('' = ANY(supported_variants))
  );

ALTER TABLE market_quotes
  ADD COLUMN IF NOT EXISTS replaced_at timestamptz NULL;
ALTER TABLE market_quotes
  DROP CONSTRAINT IF EXISTS market_quotes_terminal_state_check;
ALTER TABLE market_quotes
  ADD CONSTRAINT market_quotes_terminal_state_check
  CHECK (consumed_at IS NULL OR replaced_at IS NULL);
WITH ranked_open_quotes AS (
  SELECT quote_id,
         row_number() OVER (
           PARTITION BY account_id, book_id
           ORDER BY created_at DESC, quote_id DESC
         ) AS position
  FROM market_quotes
  WHERE consumed_at IS NULL AND replaced_at IS NULL
)
UPDATE market_quotes quote
SET replaced_at = now()
FROM ranked_open_quotes ranked
WHERE ranked.quote_id = quote.quote_id AND ranked.position > 1;

CREATE UNIQUE INDEX IF NOT EXISTS market_quotes_account_book_open_unique_idx
  ON market_quotes (account_id, book_id)
  WHERE consumed_at IS NULL AND replaced_at IS NULL;

CREATE TABLE IF NOT EXISTS market_quote_requests (
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 8 AND 128),
  request_hash text NOT NULL CHECK (length(request_hash) = 64),
  -- Deliberately not an FK: quote cleanup must never mutate immutable replay
  -- truth. The durable result is self-contained.
  quote_id uuid NULL,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NULL,
  PRIMARY KEY (account_id, request_id),
  CONSTRAINT market_quote_requests_actor_fk
    FOREIGN KEY (player_id, account_id)
    REFERENCES players(id, account_id) ON DELETE RESTRICT,
  CHECK (
    (result = '{}'::jsonb AND completed_at IS NULL)
    OR (result <> '{}'::jsonb AND completed_at IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS market_quote_requests_created_idx
  ON market_quote_requests (created_at DESC);

CREATE OR REPLACE FUNCTION enforce_market_quote_request_completion()
RETURNS trigger AS $$
BEGIN
  IF OLD.account_id <> NEW.account_id
     OR OLD.player_id <> NEW.player_id
     OR OLD.request_id <> NEW.request_id
     OR OLD.request_hash <> NEW.request_hash
     OR OLD.created_at <> NEW.created_at THEN
    RAISE EXCEPTION 'market quote request identity is immutable';
  END IF;
  IF OLD.result <> '{}'::jsonb OR OLD.completed_at IS NOT NULL THEN
    RAISE EXCEPTION 'completed market quote request is immutable';
  END IF;
  IF NEW.result = '{}'::jsonb OR NEW.completed_at IS NULL OR NEW.quote_id IS NULL THEN
    RAISE EXCEPTION 'market quote request completion requires durable result and quote';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS market_quote_requests_completion_guard ON market_quote_requests;
CREATE TRIGGER market_quote_requests_completion_guard
BEFORE UPDATE ON market_quote_requests
FOR EACH ROW EXECUTE FUNCTION enforce_market_quote_request_completion();

DROP TRIGGER IF EXISTS market_quote_requests_delete_guard ON market_quote_requests;
CREATE TRIGGER market_quote_requests_delete_guard
BEFORE DELETE ON market_quote_requests
FOR EACH ROW EXECUTE FUNCTION reject_market_immutable_mutation();

CREATE OR REPLACE FUNCTION enforce_market_quote_request_commit_result()
RETURNS trigger AS $$
DECLARE
  current_request market_quote_requests%ROWTYPE;
BEGIN
  -- A deferred row trigger retains the row image from the statement that
  -- queued it. A request is deliberately inserted as a placeholder and then
  -- completed in the same transaction, so validate the committed row rather
  -- than the stale INSERT image.
  SELECT * INTO current_request
  FROM market_quote_requests
  WHERE account_id = NEW.account_id AND request_id = NEW.request_id;
  IF NOT FOUND
     OR current_request.result = '{}'::jsonb
     OR current_request.completed_at IS NULL
     OR current_request.quote_id IS NULL
     OR current_request.result ->> 'quoteId'
          IS DISTINCT FROM current_request.quote_id::text THEN
    RAISE EXCEPTION 'market quote request cannot commit without its durable result';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS market_quote_requests_commit_result_guard ON market_quote_requests;
CREATE CONSTRAINT TRIGGER market_quote_requests_commit_result_guard
AFTER INSERT OR UPDATE ON market_quote_requests
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_market_quote_request_commit_result();

-- ---------------------------------------------------------------------------
-- Truthful fee provenance and supported order policies.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM market_orders WHERE order_policy = 'ioc') THEN
    RAISE EXCEPTION
      '0601 cannot migrate retained plain IOC orders; resolve them through an audited operator procedure first';
  END IF;
END;
$$;

ALTER TABLE market_orders
  DROP CONSTRAINT IF EXISTS market_orders_order_policy_check;
ALTER TABLE market_orders
  ADD CONSTRAINT market_orders_order_policy_check
  CHECK (order_policy IN ('gtc', 'aon_ioc'));

ALTER TABLE market_ledger_groups
  ADD COLUMN IF NOT EXISTS order_fee_policy_id smallint NULL,
  ADD COLUMN IF NOT EXISTS order_fee_policy_version integer NULL,
  ADD COLUMN IF NOT EXISTS buyer_fee_policy_id smallint NULL,
  ADD COLUMN IF NOT EXISTS buyer_fee_policy_version integer NULL,
  ADD COLUMN IF NOT EXISTS seller_fee_policy_id smallint NULL,
  ADD COLUMN IF NOT EXISTS seller_fee_policy_version integer NULL;

DROP TRIGGER IF EXISTS market_ledger_groups_immutable ON market_ledger_groups;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM market_ledger_groups g
    JOIN market_orders o ON o.order_id = g.order_id
    WHERE g.group_type IN ('order_escrow', 'cancel')
      AND g.fee_policy_version <> o.fee_policy_version
  ) THEN
    RAISE EXCEPTION 'retained order ledger fee version disagrees with its immutable order';
  END IF;
END;
$$;

UPDATE market_ledger_groups g
SET order_fee_policy_id = o.fee_policy_id,
    order_fee_policy_version = o.fee_policy_version
FROM market_orders o
WHERE g.group_type IN ('order_escrow', 'cancel')
  AND o.order_id = g.order_id;

UPDATE market_ledger_groups g
SET buyer_fee_policy_id = t.buyer_fee_policy_id,
    buyer_fee_policy_version = t.buyer_fee_policy_version,
    seller_fee_policy_id = t.seller_fee_policy_id,
    seller_fee_policy_version = t.seller_fee_policy_version
FROM market_trades t
WHERE g.group_type = 'trade' AND t.trade_id = g.trade_id;

ALTER TABLE market_ledger_groups
  DROP CONSTRAINT IF EXISTS market_ledger_groups_claim_shape_check;
ALTER TABLE market_ledger_groups
  DROP COLUMN IF EXISTS fee_policy_version;

ALTER TABLE market_ledger_groups
  ADD CONSTRAINT market_ledger_groups_order_fee_policy_fk
    FOREIGN KEY (order_fee_policy_id, order_fee_policy_version)
    REFERENCES market_fee_policies(fee_policy_id, version) ON DELETE RESTRICT,
  ADD CONSTRAINT market_ledger_groups_buyer_fee_policy_fk
    FOREIGN KEY (buyer_fee_policy_id, buyer_fee_policy_version)
    REFERENCES market_fee_policies(fee_policy_id, version) ON DELETE RESTRICT,
  ADD CONSTRAINT market_ledger_groups_seller_fee_policy_fk
    FOREIGN KEY (seller_fee_policy_id, seller_fee_policy_version)
    REFERENCES market_fee_policies(fee_policy_id, version) ON DELETE RESTRICT,
  ADD CONSTRAINT market_ledger_groups_source_shape_check CHECK (
    (
      group_type IN ('order_escrow', 'cancel')
      AND order_id IS NOT NULL AND trade_id IS NULL AND claim_id IS NULL
      AND order_fee_policy_id IS NOT NULL AND order_fee_policy_version IS NOT NULL
      AND buyer_fee_policy_id IS NULL AND buyer_fee_policy_version IS NULL
      AND seller_fee_policy_id IS NULL AND seller_fee_policy_version IS NULL
    ) OR (
      group_type = 'trade'
      AND order_id IS NULL AND trade_id IS NOT NULL AND claim_id IS NULL
      AND order_fee_policy_id IS NULL AND order_fee_policy_version IS NULL
      AND buyer_fee_policy_id IS NOT NULL AND buyer_fee_policy_version IS NOT NULL
      AND seller_fee_policy_id IS NOT NULL AND seller_fee_policy_version IS NOT NULL
    ) OR (
      group_type = 'claim'
      AND claim_id IS NOT NULL AND request_id IS NOT NULL
      AND order_id IS NULL AND trade_id IS NULL
      AND order_fee_policy_id IS NULL AND order_fee_policy_version IS NULL
      AND buyer_fee_policy_id IS NULL AND buyer_fee_policy_version IS NULL
      AND seller_fee_policy_id IS NULL AND seller_fee_policy_version IS NULL
    ) OR (
      group_type IN ('fee', 'administrative')
      AND claim_id IS NULL AND order_id IS NULL AND trade_id IS NULL
      AND order_fee_policy_id IS NULL AND order_fee_policy_version IS NULL
      AND buyer_fee_policy_id IS NULL AND buyer_fee_policy_version IS NULL
      AND seller_fee_policy_id IS NULL AND seller_fee_policy_version IS NULL
    )
  );

CREATE TRIGGER market_ledger_groups_immutable
BEFORE UPDATE OR DELETE ON market_ledger_groups
FOR EACH ROW EXECUTE FUNCTION reject_market_immutable_mutation();

ALTER TABLE market_ledger_entries
  DROP CONSTRAINT IF EXISTS market_ledger_entries_location_shape_check;
ALTER TABLE market_ledger_entries
  ADD CONSTRAINT market_ledger_entries_location_shape_check CHECK (
    (account_location NOT IN ('player_inventory', 'player_wallet') OR player_id IS NOT NULL)
    AND (
      account_location NOT IN ('sell_escrow', 'buy_escrow')
      OR (order_id IS NOT NULL AND player_id IS NOT NULL AND collection_id IS NULL)
    )
    AND (
      account_location <> 'fee_sink'
      OR (trade_id IS NOT NULL AND player_id IS NULL AND order_id IS NULL AND collection_id IS NULL)
    )
  );

-- ---------------------------------------------------------------------------
-- Bigint quantities and versioned authoritative wallet/inventory transitions.
-- ---------------------------------------------------------------------------

ALTER TABLE player_inventory
  ALTER COLUMN quantity TYPE bigint USING quantity::bigint;
ALTER TABLE inventory_events
  ALTER COLUMN delta_quantity TYPE bigint USING delta_quantity::bigint,
  ALTER COLUMN quantity_after TYPE bigint USING quantity_after::bigint;
ALTER TABLE world_item_drops
  ALTER COLUMN quantity TYPE bigint USING quantity::bigint;
ALTER TABLE world_item_pickups
  ALTER COLUMN requested_quantity TYPE bigint USING requested_quantity::bigint,
  ALTER COLUMN granted_quantity TYPE bigint USING granted_quantity::bigint,
  ALTER COLUMN remaining_quantity TYPE bigint USING remaining_quantity::bigint;

ALTER TABLE player_inventory
  ADD COLUMN IF NOT EXISTS version bigint NULL;
ALTER TABLE wallet_events
  ADD COLUMN IF NOT EXISTS version_after bigint NULL;
ALTER TABLE inventory_events
  ADD COLUMN IF NOT EXISTS version_after bigint NULL;

DROP TRIGGER IF EXISTS wallet_events_immutable ON wallet_events;
DROP TRIGGER IF EXISTS inventory_events_immutable ON inventory_events;

-- Retained-history backfill inserts genesis events before later ALTER TABLE
-- validation. Temporarily remove outgoing FKs so PostgreSQL has no pending FK
-- trigger events that would make those ALTERs illegal in the same migration
-- transaction; every relationship is restored and validated below.
ALTER TABLE wallet_events
  DROP CONSTRAINT IF EXISTS wallet_events_player_id_fkey,
  DROP CONSTRAINT IF EXISTS wallet_events_account_id_fkey,
  DROP CONSTRAINT IF EXISTS wallet_events_actor_fk,
  DROP CONSTRAINT IF EXISTS wallet_events_market_order_fk,
  DROP CONSTRAINT IF EXISTS wallet_events_market_trade_fk;
ALTER TABLE inventory_events
  DROP CONSTRAINT IF EXISTS inventory_events_operation_key_fkey,
  DROP CONSTRAINT IF EXISTS inventory_events_player_id_fkey,
  DROP CONSTRAINT IF EXISTS inventory_events_item_id_fkey;

CREATE TEMP TABLE wallet_0601_opening ON COMMIT DROP AS
WITH first_events AS (
  SELECT DISTINCT ON (player_id, account_id)
         player_id, account_id, event_id, delta_gold, balance_after, created_at
  FROM wallet_events
  ORDER BY player_id, account_id, event_id
)
SELECT wallet.player_id, wallet.account_id,
       first_events.event_id AS first_event_id,
       first_events.created_at AS first_event_created_at,
       CASE
         WHEN first_events.event_id IS NULL THEN wallet.gold_balance
         ELSE first_events.balance_after - first_events.delta_gold
       END::bigint AS opening_balance
FROM player_wallets wallet
LEFT JOIN first_events
  ON first_events.player_id = wallet.player_id
 AND first_events.account_id = wallet.account_id;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM wallet_0601_opening WHERE opening_balance < 0) THEN
    RAISE EXCEPTION 'retained wallet history implies a negative opening balance';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM wallet_events event
    LEFT JOIN player_wallets wallet
      ON wallet.player_id = event.player_id AND wallet.account_id = event.account_id
    WHERE wallet.player_id IS NULL
  ) THEN
    RAISE EXCEPTION 'retained wallet event has no authoritative wallet';
  END IF;
  IF EXISTS (
    WITH ordered AS (
      SELECT event_id, player_id, account_id, delta_gold, balance_after,
             lag(balance_after) OVER (
               PARTITION BY player_id, account_id ORDER BY event_id
             ) AS previous_balance
      FROM wallet_events
    )
    SELECT 1 FROM ordered
    WHERE previous_balance IS NOT NULL
      AND balance_after <> previous_balance + delta_gold
  ) THEN
    RAISE EXCEPTION 'retained wallet event history is not a valid chain';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM player_wallets wallet
    JOIN LATERAL (
      SELECT balance_after
      FROM wallet_events event
      WHERE event.player_id = wallet.player_id
        AND event.account_id = wallet.account_id
      ORDER BY event_id DESC LIMIT 1
    ) latest ON true
    WHERE latest.balance_after <> wallet.gold_balance
  ) THEN
    RAISE EXCEPTION 'retained wallet balance disagrees with its latest event';
  END IF;
END;
$$;

WITH numbered AS (
  SELECT event.event_id,
         row_number() OVER (
           PARTITION BY event.player_id, event.account_id ORDER BY event.event_id
         )::bigint
         + CASE WHEN opening.opening_balance > 0 THEN 1 ELSE 0 END AS version_after
  FROM wallet_events event
  JOIN wallet_0601_opening opening
    ON opening.player_id = event.player_id AND opening.account_id = event.account_id
)
UPDATE wallet_events e
SET version_after = numbered.version_after
FROM numbered
WHERE numbered.event_id = e.event_id;

INSERT INTO wallet_events (
  operation_key, player_id, account_id, delta_gold, balance_after, version_after,
  reason, metadata, created_at
)
SELECT '0601-wallet-genesis:' || opening.player_id,
       opening.player_id, opening.account_id,
       opening.opening_balance, opening.opening_balance, 1,
       'economy_hardening_genesis',
       jsonb_build_object('migration', '0601_market_economy_hardening'),
       coalesce(opening.first_event_created_at - interval '1 microsecond', now())
FROM wallet_0601_opening opening
WHERE opening.opening_balance > 0;

UPDATE player_wallets w
SET version = history.event_count
FROM (
  SELECT player_id, account_id, count(*)::bigint AS event_count
  FROM wallet_events
  GROUP BY player_id, account_id
) history
WHERE history.player_id = w.player_id AND history.account_id = w.account_id;
UPDATE player_wallets w
SET version = 0
WHERE NOT EXISTS (
  SELECT 1 FROM wallet_events e
  WHERE e.player_id = w.player_id AND e.account_id = w.account_id
);

CREATE TEMP TABLE inventory_0601_opening ON COMMIT DROP AS
WITH first_events AS (
  SELECT DISTINCT ON (player_id, item_id, variant)
         player_id, item_id, variant, id, delta_quantity, quantity_after, created_at
  FROM inventory_events
  ORDER BY player_id, item_id, variant, id
)
SELECT stack.player_id, stack.resource_type AS item_id, stack.variant,
       first_events.id AS first_event_id,
       first_events.created_at AS first_event_created_at,
       CASE
         WHEN first_events.id IS NULL THEN stack.quantity
         ELSE first_events.quantity_after - first_events.delta_quantity
       END::bigint AS opening_quantity
FROM player_inventory stack
LEFT JOIN first_events
  ON first_events.player_id = stack.player_id
 AND first_events.item_id = stack.resource_type
 AND first_events.variant = stack.variant;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM inventory_0601_opening WHERE opening_quantity < 0) THEN
    RAISE EXCEPTION 'retained inventory history implies a negative opening quantity';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM inventory_events e
    LEFT JOIN player_inventory stack
      ON stack.player_id = e.player_id
     AND stack.resource_type = e.item_id
     AND stack.variant = e.variant
    WHERE stack.player_id IS NULL
  ) THEN
    RAISE EXCEPTION 'retained inventory event has no authoritative stack';
  END IF;
  IF EXISTS (
    WITH ordered AS (
      SELECT id, player_id, item_id, variant, delta_quantity, quantity_after,
             lag(quantity_after) OVER (
               PARTITION BY player_id, item_id, variant ORDER BY id
             ) AS previous_quantity
      FROM inventory_events
    )
    SELECT 1 FROM ordered
    WHERE previous_quantity IS NOT NULL
      AND quantity_after <> previous_quantity + delta_quantity
  ) THEN
    RAISE EXCEPTION 'retained inventory event history is not a valid chain';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM player_inventory stack
    JOIN LATERAL (
      SELECT quantity_after
      FROM inventory_events e
      WHERE e.player_id = stack.player_id
        AND e.item_id = stack.resource_type
        AND e.variant = stack.variant
      ORDER BY id DESC LIMIT 1
    ) latest ON true
    WHERE latest.quantity_after <> stack.quantity
  ) THEN
    RAISE EXCEPTION 'retained inventory stack disagrees with its latest event';
  END IF;
END;
$$;

WITH numbered AS (
  SELECT e.id,
         row_number() OVER (
           PARTITION BY e.player_id, e.item_id, e.variant ORDER BY e.id
         )::bigint
         + CASE WHEN opening.opening_quantity > 0 THEN 1 ELSE 0 END AS version_after
  FROM inventory_events e
  JOIN inventory_0601_opening opening
    ON opening.player_id = e.player_id
   AND opening.item_id = e.item_id
   AND opening.variant = e.variant
)
UPDATE inventory_events e
SET version_after = numbered.version_after
FROM numbered
WHERE numbered.id = e.id;

INSERT INTO inventory_operations (
  operation_key, player_id, source, source_entity_type, source_entity_id, metadata, created_at
)
SELECT '0601-inventory-genesis:' || md5(
         opening.player_id || chr(31) || opening.item_id || chr(31) || opening.variant
       ),
       opening.player_id, 'economy_hardening_genesis', 'inventory_stack',
       opening.player_id || ':' || opening.item_id || ':' || opening.variant,
       jsonb_build_object('migration', '0601_market_economy_hardening'),
       coalesce(opening.first_event_created_at - interval '1 microsecond', now())
FROM inventory_0601_opening opening
WHERE opening.opening_quantity > 0;

INSERT INTO inventory_events (
  operation_key, player_id, item_id, variant, delta_quantity, quantity_after,
  version_after, source, source_entity_type, source_entity_id, metadata, created_at
)
SELECT '0601-inventory-genesis:' || md5(
         opening.player_id || chr(31) || opening.item_id || chr(31) || opening.variant
       ),
       opening.player_id, opening.item_id, opening.variant,
       opening.opening_quantity, opening.opening_quantity, 1,
       'economy_hardening_genesis', 'inventory_stack',
       opening.player_id || ':' || opening.item_id || ':' || opening.variant,
       jsonb_build_object('migration', '0601_market_economy_hardening'),
       coalesce(opening.first_event_created_at - interval '1 microsecond', now())
FROM inventory_0601_opening opening
WHERE opening.opening_quantity > 0
ON CONFLICT (operation_key, item_id, variant) DO NOTHING;

UPDATE player_inventory stack
SET version = history.event_count
FROM (
  SELECT player_id, item_id, variant, count(*)::bigint AS event_count
  FROM inventory_events
  GROUP BY player_id, item_id, variant
) history
WHERE history.player_id = stack.player_id
  AND history.item_id = stack.resource_type
  AND history.variant = stack.variant;
UPDATE player_inventory stack
SET version = 0
WHERE NOT EXISTS (
  SELECT 1 FROM inventory_events e
  WHERE e.player_id = stack.player_id
    AND e.item_id = stack.resource_type
    AND e.variant = stack.variant
);

ALTER TABLE player_inventory
  ALTER COLUMN version SET NOT NULL,
  ALTER COLUMN version SET DEFAULT 0,
  ADD CONSTRAINT player_inventory_version_nonnegative CHECK (version >= 0),
  ADD CONSTRAINT player_inventory_safe_quantity CHECK (quantity <= 9007199254740991::bigint),
  ADD CONSTRAINT player_inventory_identity_unique
    UNIQUE (player_id, resource_type, variant);
ALTER TABLE player_wallets
  ADD CONSTRAINT player_wallets_identity_unique UNIQUE (player_id, account_id);
ALTER TABLE wallet_events
  ALTER COLUMN version_after SET NOT NULL,
  ADD CONSTRAINT wallet_events_version_positive CHECK (version_after > 0),
  ADD CONSTRAINT wallet_events_wallet_version_unique
    UNIQUE (player_id, account_id, version_after),
  ADD CONSTRAINT wallet_events_wallet_fk
    FOREIGN KEY (player_id, account_id)
    REFERENCES player_wallets(player_id, account_id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT wallet_events_player_id_fkey
    FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE RESTRICT,
  ADD CONSTRAINT wallet_events_account_id_fkey
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE RESTRICT,
  ADD CONSTRAINT wallet_events_actor_fk
    FOREIGN KEY (player_id, account_id)
    REFERENCES players(id, account_id) ON DELETE RESTRICT,
  ADD CONSTRAINT wallet_events_market_order_fk
    FOREIGN KEY (market_order_id) REFERENCES market_orders(order_id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT wallet_events_market_trade_fk
    FOREIGN KEY (market_trade_id) REFERENCES market_trades(trade_id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE inventory_events
  ALTER COLUMN version_after SET NOT NULL,
  ADD CONSTRAINT inventory_events_version_positive CHECK (version_after > 0),
  ADD CONSTRAINT inventory_events_stack_version_unique
    UNIQUE (player_id, item_id, variant, version_after),
  ADD CONSTRAINT inventory_events_safe_quantity_after
    CHECK (quantity_after <= 9007199254740991::bigint),
  ADD CONSTRAINT inventory_events_safe_delta
    CHECK (delta_quantity BETWEEN -9007199254740991::bigint AND 9007199254740991::bigint),
  ADD CONSTRAINT inventory_events_stack_fk
    FOREIGN KEY (player_id, item_id, variant)
    REFERENCES player_inventory(player_id, resource_type, variant)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT inventory_events_operation_key_fkey
    FOREIGN KEY (operation_key)
    REFERENCES inventory_operations(operation_key) ON DELETE RESTRICT,
  ADD CONSTRAINT inventory_events_player_id_fkey
    FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE RESTRICT,
  ADD CONSTRAINT inventory_events_item_id_fkey
    FOREIGN KEY (item_id) REFERENCES item_definitions(item_id);

CREATE INDEX IF NOT EXISTS wallet_events_chain_idx
  ON wallet_events (player_id, account_id, version_after);
CREATE INDEX IF NOT EXISTS inventory_events_chain_idx
  ON inventory_events (player_id, item_id, variant, version_after);

CREATE OR REPLACE FUNCTION reject_authoritative_asset_identity_mutation()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'authoritative asset rows cannot be deleted';
  END IF;
  IF TG_TABLE_NAME = 'player_wallets' THEN
    IF NEW.player_id IS DISTINCT FROM OLD.player_id
       OR NEW.account_id IS DISTINCT FROM OLD.account_id THEN
      RAISE EXCEPTION 'wallet identity is immutable';
    END IF;
  ELSIF TG_TABLE_NAME = 'player_inventory' THEN
    IF NEW.player_id IS DISTINCT FROM OLD.player_id
       OR NEW.resource_type IS DISTINCT FROM OLD.resource_type
       OR NEW.variant IS DISTINCT FROM OLD.variant THEN
      RAISE EXCEPTION 'inventory stack identity is immutable';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION validate_wallet_event_chain(
  target_player_id text,
  target_account_id uuid
)
RETURNS void AS $$
DECLARE
  target_wallet player_wallets%ROWTYPE;
  event_count bigint;
  event_total numeric;
  latest_balance bigint;
  latest_version bigint;
BEGIN
  SELECT * INTO target_wallet
  FROM player_wallets
  WHERE player_id = target_player_id AND account_id = target_account_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'wallet event chain has no authoritative wallet';
  END IF;

  SELECT count(*), coalesce(sum(delta_gold), 0),
         coalesce(max(version_after), 0),
         (array_agg(balance_after ORDER BY version_after DESC))[1]
  INTO event_count, event_total, latest_version, latest_balance
  FROM wallet_events
  WHERE player_id = target_player_id AND account_id = target_account_id;

  IF event_count <> target_wallet.version OR latest_version <> target_wallet.version THEN
    RAISE EXCEPTION 'wallet version does not match exactly one event per transition';
  END IF;
  IF target_wallet.version = 0 THEN
    IF target_wallet.gold_balance <> 0 OR event_count <> 0 THEN
      RAISE EXCEPTION 'version-zero wallet must have zero balance and no events';
    END IF;
    RETURN;
  END IF;
  IF event_total <> target_wallet.gold_balance
     OR latest_balance <> target_wallet.gold_balance THEN
    RAISE EXCEPTION 'wallet balance does not match its durable event chain';
  END IF;
  IF EXISTS (
    WITH ordered AS (
      SELECT version_after, delta_gold, balance_after,
             lag(balance_after, 1, 0::bigint) OVER (ORDER BY version_after) AS previous_balance,
             row_number() OVER (ORDER BY version_after) AS expected_version
      FROM wallet_events
      WHERE player_id = target_player_id AND account_id = target_account_id
    )
    SELECT 1 FROM ordered
    WHERE version_after <> expected_version
       OR balance_after <> previous_balance + delta_gold
  ) THEN
    RAISE EXCEPTION 'wallet event chain contains an invalid transition';
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION validate_inventory_event_chain(
  target_player_id text,
  target_item_id text,
  target_variant text
)
RETURNS void AS $$
DECLARE
  target_stack player_inventory%ROWTYPE;
  event_count bigint;
  event_total numeric;
  latest_quantity bigint;
  latest_version bigint;
BEGIN
  SELECT * INTO target_stack
  FROM player_inventory
  WHERE player_id = target_player_id
    AND resource_type = target_item_id
    AND variant = target_variant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'inventory event chain has no authoritative stack';
  END IF;

  SELECT count(*), coalesce(sum(delta_quantity), 0),
         coalesce(max(version_after), 0),
         (array_agg(quantity_after ORDER BY version_after DESC))[1]
  INTO event_count, event_total, latest_version, latest_quantity
  FROM inventory_events
  WHERE player_id = target_player_id
    AND item_id = target_item_id
    AND variant = target_variant;

  IF event_count <> target_stack.version OR latest_version <> target_stack.version THEN
    RAISE EXCEPTION 'inventory version does not match exactly one event per transition';
  END IF;
  IF (
    SELECT coalesce(sum(quantity::numeric), 0)
    FROM player_inventory
    WHERE player_id = target_player_id AND resource_type = target_item_id
  ) > 9007199254740991::numeric THEN
    RAISE EXCEPTION 'inventory item total across variants exceeds the safe protocol range';
  END IF;
  IF target_stack.version = 0 THEN
    IF target_stack.quantity <> 0 OR event_count <> 0 THEN
      RAISE EXCEPTION 'version-zero inventory stack must have zero quantity and no events';
    END IF;
    RETURN;
  END IF;
  IF event_total <> target_stack.quantity
     OR latest_quantity <> target_stack.quantity THEN
    RAISE EXCEPTION 'inventory quantity does not match its durable event chain';
  END IF;
  IF EXISTS (
    WITH ordered AS (
      SELECT version_after, delta_quantity, quantity_after,
             lag(quantity_after, 1, 0::bigint) OVER (ORDER BY version_after) AS previous_quantity,
             row_number() OVER (ORDER BY version_after) AS expected_version
      FROM inventory_events
      WHERE player_id = target_player_id
        AND item_id = target_item_id
        AND variant = target_variant
    )
    SELECT 1 FROM ordered
    WHERE version_after <> expected_version
       OR quantity_after <> previous_quantity + delta_quantity
  ) THEN
    RAISE EXCEPTION 'inventory event chain contains an invalid transition';
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enforce_wallet_row_commit()
RETURNS trigger AS $$
BEGIN
  PERFORM validate_wallet_event_chain(NEW.player_id, NEW.account_id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enforce_wallet_event_commit()
RETURNS trigger AS $$
BEGIN
  PERFORM validate_wallet_event_chain(NEW.player_id, NEW.account_id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enforce_inventory_row_commit()
RETURNS trigger AS $$
BEGIN
  PERFORM validate_inventory_event_chain(NEW.player_id, NEW.resource_type, NEW.variant);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enforce_inventory_event_commit()
RETURNS trigger AS $$
BEGIN
  PERFORM validate_inventory_event_chain(NEW.player_id, NEW.item_id, NEW.variant);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS player_wallets_identity_guard ON player_wallets;
CREATE TRIGGER player_wallets_identity_guard
BEFORE UPDATE OR DELETE ON player_wallets
FOR EACH ROW EXECUTE FUNCTION reject_authoritative_asset_identity_mutation();
DROP TRIGGER IF EXISTS player_inventory_identity_guard ON player_inventory;
CREATE TRIGGER player_inventory_identity_guard
BEFORE UPDATE OR DELETE ON player_inventory
FOR EACH ROW EXECUTE FUNCTION reject_authoritative_asset_identity_mutation();

DROP TRIGGER IF EXISTS player_wallets_event_chain_guard ON player_wallets;
CREATE CONSTRAINT TRIGGER player_wallets_event_chain_guard
AFTER INSERT OR UPDATE ON player_wallets
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_wallet_row_commit();
DROP TRIGGER IF EXISTS wallet_events_chain_guard ON wallet_events;
CREATE CONSTRAINT TRIGGER wallet_events_chain_guard
AFTER INSERT ON wallet_events
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_wallet_event_commit();
DROP TRIGGER IF EXISTS player_inventory_event_chain_guard ON player_inventory;
CREATE CONSTRAINT TRIGGER player_inventory_event_chain_guard
AFTER INSERT OR UPDATE ON player_inventory
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_inventory_row_commit();
DROP TRIGGER IF EXISTS inventory_events_chain_guard ON inventory_events;
CREATE CONSTRAINT TRIGGER inventory_events_chain_guard
AFTER INSERT ON inventory_events
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_inventory_event_commit();

-- Pre-0601 drop creation wrote the correct source kind but could not populate
-- the deterministic drop id until after reserving the inventory operation.
-- Complete that retained provenance before the asset history becomes
-- immutable.
UPDATE inventory_operations operation
SET source_entity_id = drop.id::text
FROM world_item_drops drop
WHERE operation.operation_key = drop.operation_key
  AND operation.player_id = drop.dropped_by
  AND operation.source = 'drop_item'
  AND operation.source_entity_type = 'world_item_drop'
  AND operation.source_entity_id IS NULL;
UPDATE inventory_events event
SET source_entity_id = drop.id::text
FROM world_item_drops drop
WHERE event.operation_key = drop.operation_key
  AND event.player_id = drop.dropped_by
  AND event.source = 'drop_item'
  AND event.source_entity_type = 'world_item_drop'
  AND event.source_entity_id IS NULL;

CREATE TRIGGER wallet_events_immutable
BEFORE UPDATE OR DELETE ON wallet_events
FOR EACH ROW EXECUTE FUNCTION reject_market_immutable_mutation();
CREATE TRIGGER inventory_events_immutable
BEFORE UPDATE OR DELETE ON inventory_events
FOR EACH ROW EXECUTE FUNCTION reject_market_immutable_mutation();

DROP TRIGGER IF EXISTS inventory_operations_immutable ON inventory_operations;
CREATE TRIGGER inventory_operations_immutable
BEFORE UPDATE OR DELETE ON inventory_operations
FOR EACH ROW EXECUTE FUNCTION reject_market_immutable_mutation();

-- ---------------------------------------------------------------------------
-- Durable dropped-item request replay, custody movements, and destruction.
-- ---------------------------------------------------------------------------

-- Backfill the pre-0009 one-shot pickup representation into the durable pickup
-- table before deriving immutable original quantities.
INSERT INTO world_item_pickups (
  operation_key, drop_id, player_id, pickup_mode, requested_quantity,
  granted_quantity, remaining_quantity, resulting_status, created_at
)
SELECT d.pickup_operation_key, d.id, d.picked_up_by, 'all', NULL,
       d.quantity, 0, 'picked_up', coalesce(d.picked_up_at, d.created_at)
FROM world_item_drops d
WHERE d.status = 'picked_up'
  AND d.pickup_operation_key IS NOT NULL
  AND d.picked_up_by IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM world_item_pickups pickup
    WHERE pickup.operation_key = d.pickup_operation_key
  );

ALTER TABLE world_item_drops
  RENAME COLUMN quantity TO remaining_quantity;
ALTER TABLE world_item_drops
  ADD COLUMN IF NOT EXISTS original_quantity bigint NULL,
  ADD COLUMN IF NOT EXISTS expired_at timestamptz NULL;

WITH pickup_totals AS (
  SELECT drop_id, coalesce(sum(granted_quantity), 0)::bigint AS picked_quantity
  FROM world_item_pickups
  GROUP BY drop_id
)
UPDATE world_item_drops d
SET original_quantity = CASE
      WHEN d.status = 'picked_up'
        THEN greatest(coalesce(pickup_totals.picked_quantity, 0), d.remaining_quantity)
      ELSE d.remaining_quantity + coalesce(pickup_totals.picked_quantity, 0)
    END,
    expired_at = CASE
      WHEN d.status IN ('expired', 'cancelled') THEN d.expires_at
      ELSE NULL
    END
FROM pickup_totals
WHERE pickup_totals.drop_id = d.id;

UPDATE world_item_drops d
SET original_quantity = d.remaining_quantity,
    expired_at = CASE
      WHEN d.status IN ('expired', 'cancelled') THEN d.expires_at
      ELSE NULL
    END
WHERE d.original_quantity IS NULL;

UPDATE world_item_drops
SET remaining_quantity = 0
WHERE status IN ('picked_up', 'expired', 'cancelled');

ALTER TABLE world_item_drops
  DROP CONSTRAINT IF EXISTS world_item_drops_quantity_check;
ALTER TABLE world_item_drops
  ALTER COLUMN original_quantity SET NOT NULL,
  ADD CONSTRAINT world_item_drops_original_quantity_positive
    CHECK (original_quantity > 0),
  ADD CONSTRAINT world_item_drops_remaining_quantity_bounds
    CHECK (remaining_quantity >= 0 AND remaining_quantity <= original_quantity),
  ADD CONSTRAINT world_item_drops_safe_quantities
    CHECK (
      original_quantity <= 9007199254740991::bigint
      AND remaining_quantity <= 9007199254740991::bigint
    ),
  ADD CONSTRAINT world_item_drops_expiry_time_check
    CHECK (status <> 'expired' OR expired_at >= expires_at),
  ADD CONSTRAINT world_item_drops_custody_state_check CHECK (
    (status = 'active' AND remaining_quantity > 0 AND expired_at IS NULL)
    OR (status = 'picked_up' AND remaining_quantity = 0 AND expired_at IS NULL)
    OR (status IN ('expired', 'cancelled') AND remaining_quantity = 0 AND expired_at IS NOT NULL)
  );

ALTER TABLE world_item_pickups
  ADD COLUMN IF NOT EXISTS pickup_sequence bigserial;
WITH numbered_pickups AS (
  SELECT operation_key,
         row_number() OVER (
           PARTITION BY drop_id
           ORDER BY remaining_quantity DESC, created_at, operation_key
         )::bigint AS pickup_sequence
  FROM world_item_pickups
)
UPDATE world_item_pickups pickup
SET pickup_sequence = numbered.pickup_sequence
FROM numbered_pickups numbered
WHERE numbered.operation_key = pickup.operation_key;
SELECT setval(
  pg_get_serial_sequence('world_item_pickups', 'pickup_sequence'),
  greatest(coalesce((SELECT max(pickup_sequence) FROM world_item_pickups), 1), 1),
  EXISTS (SELECT 1 FROM world_item_pickups)
);
ALTER TABLE world_item_pickups
  ADD CONSTRAINT world_item_pickups_drop_sequence_unique
    UNIQUE (drop_id, pickup_sequence),
  ADD CONSTRAINT world_item_pickups_intent_result_check CHECK (
    (pickup_mode = 'all' AND requested_quantity IS NULL
      AND remaining_quantity = 0 AND resulting_status = 'picked_up')
    OR
    (pickup_mode = 'quantity' AND requested_quantity = granted_quantity)
  ),
  ADD CONSTRAINT world_item_pickups_safe_quantities CHECK (
    (requested_quantity IS NULL OR requested_quantity <= 9007199254740991::bigint)
    AND granted_quantity <= 9007199254740991::bigint
    AND remaining_quantity <= 9007199254740991::bigint
  );

CREATE TABLE IF NOT EXISTS world_item_drop_requests (
  operation_key text PRIMARY KEY
    REFERENCES inventory_operations(operation_key) ON DELETE RESTRICT,
  drop_id uuid NOT NULL UNIQUE REFERENCES world_item_drops(id) ON DELETE RESTRICT,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  request_hash text NOT NULL CHECK (length(request_hash) = 64),
  original_result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO world_item_drop_requests (
  operation_key, drop_id, player_id, request_hash, original_result, created_at
)
SELECT d.operation_key, d.id, d.dropped_by,
       encode(sha256(convert_to(
         d.dropped_by || chr(31) || d.item_id || chr(31) || d.variant || chr(31)
           || d.original_quantity::text,
         'UTF8'
       )), 'hex'),
       jsonb_build_object(
         'drop', jsonb_build_object(
           'dropId', d.id,
           'droppedBy', d.dropped_by,
           'regionCode', d.region_code,
           'itemId', d.item_id,
           'variant', CASE WHEN d.variant = 'default' THEN NULL ELSE to_jsonb(d.variant) END,
           'quantity', d.original_quantity,
           'status', 'active',
           'lat', d.lat,
           'lon', d.lon,
           'createdAt', d.created_at,
           'expiresAt', d.expires_at,
           'pickedUpBy', NULL,
           'pickedUpAt', NULL
         ),
         'legacyBackfill', true
       ),
       d.created_at
FROM world_item_drops d
ON CONFLICT (operation_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS world_item_movements (
  movement_id bigserial PRIMARY KEY,
  drop_id uuid NOT NULL REFERENCES world_item_drops(id) ON DELETE RESTRICT,
  movement_kind text NOT NULL CHECK (movement_kind IN (
    'player_to_world', 'world_to_player', 'world_to_destruction'
  )),
  operation_key text NULL REFERENCES inventory_operations(operation_key) ON DELETE RESTRICT,
  pickup_operation_key text NULL
    REFERENCES world_item_pickups(operation_key) ON DELETE RESTRICT,
  player_id text NULL REFERENCES players(id) ON DELETE RESTRICT,
  item_id text NOT NULL REFERENCES item_definitions(item_id) ON DELETE RESTRICT,
  variant text NOT NULL,
  quantity bigint NOT NULL CHECK (
    quantity > 0 AND quantity <= 9007199254740991::bigint
  ),
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (movement_kind = 'player_to_world'
      AND operation_key IS NOT NULL AND pickup_operation_key IS NULL AND player_id IS NOT NULL)
    OR (movement_kind = 'world_to_player'
      AND operation_key IS NOT NULL AND pickup_operation_key = operation_key AND player_id IS NOT NULL)
    OR (movement_kind = 'world_to_destruction'
      AND operation_key IS NULL AND pickup_operation_key IS NULL AND player_id IS NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS world_item_movements_creation_unique_idx
  ON world_item_movements (drop_id) WHERE movement_kind = 'player_to_world';
CREATE UNIQUE INDEX IF NOT EXISTS world_item_movements_pickup_unique_idx
  ON world_item_movements (pickup_operation_key)
  WHERE movement_kind = 'world_to_player';
CREATE UNIQUE INDEX IF NOT EXISTS world_item_movements_destruction_unique_idx
  ON world_item_movements (drop_id) WHERE movement_kind = 'world_to_destruction';
CREATE INDEX IF NOT EXISTS world_item_movements_drop_kind_idx
  ON world_item_movements (drop_id, movement_kind, movement_id);
CREATE INDEX IF NOT EXISTS world_item_drops_due_expiry_idx
  ON world_item_drops (expires_at, id) WHERE status = 'active';

INSERT INTO world_item_movements (
  drop_id, movement_kind, operation_key, player_id, item_id, variant,
  quantity, reason, created_at
)
SELECT d.id, 'player_to_world', d.operation_key, d.dropped_by, d.item_id, d.variant,
       d.original_quantity, 'drop_created', d.created_at
FROM world_item_drops d
ON CONFLICT DO NOTHING;

INSERT INTO world_item_movements (
  drop_id, movement_kind, operation_key, pickup_operation_key, player_id,
  item_id, variant, quantity, reason, created_at
)
SELECT pickup.drop_id, 'world_to_player', pickup.operation_key, pickup.operation_key,
       pickup.player_id, d.item_id, d.variant, pickup.granted_quantity,
       'drop_picked_up', pickup.created_at
FROM world_item_pickups pickup
JOIN world_item_drops d ON d.id = pickup.drop_id
ON CONFLICT DO NOTHING;

INSERT INTO world_item_movements (
  drop_id, movement_kind, item_id, variant, quantity, reason, created_at
)
SELECT d.id, 'world_to_destruction', d.item_id, d.variant,
       d.original_quantity - coalesce(picked.picked_quantity, 0),
       CASE WHEN d.status = 'cancelled' THEN 'legacy_cancelled_sink' ELSE 'expired_sink' END,
       coalesce(d.expired_at, d.expires_at)
FROM world_item_drops d
LEFT JOIN (
  SELECT drop_id, sum(granted_quantity)::bigint AS picked_quantity
  FROM world_item_pickups GROUP BY drop_id
) picked ON picked.drop_id = d.id
WHERE d.status IN ('expired', 'cancelled')
  AND d.original_quantity - coalesce(picked.picked_quantity, 0) > 0
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION validate_world_item_drop_commit(target_drop_id uuid)
RETURNS void AS $$
DECLARE
  target_drop world_item_drops%ROWTYPE;
  target_request world_item_drop_requests%ROWTYPE;
  creation_count bigint;
  creation_quantity numeric;
  pickup_quantity numeric;
  destruction_count bigint;
  destruction_quantity numeric;
  request_count bigint;
  expected_request_hash text;
BEGIN
  SELECT * INTO target_drop FROM world_item_drops WHERE id = target_drop_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'world item movement references a missing drop';
  END IF;

  SELECT count(*), coalesce(sum(quantity), 0)
  INTO creation_count, creation_quantity
  FROM world_item_movements
  WHERE drop_id = target_drop_id AND movement_kind = 'player_to_world';
  SELECT coalesce(sum(quantity), 0)
  INTO pickup_quantity
  FROM world_item_movements
  WHERE drop_id = target_drop_id AND movement_kind = 'world_to_player';
  SELECT count(*), coalesce(sum(quantity), 0)
  INTO destruction_count, destruction_quantity
  FROM world_item_movements
  WHERE drop_id = target_drop_id AND movement_kind = 'world_to_destruction';
  SELECT count(*) INTO request_count
  FROM world_item_drop_requests
  WHERE drop_id = target_drop_id AND operation_key = target_drop.operation_key
    AND player_id = target_drop.dropped_by;

  IF request_count <> 1 THEN
    RAISE EXCEPTION 'world item drop must have one immutable replay result';
  END IF;
  SELECT * INTO target_request
  FROM world_item_drop_requests
  WHERE drop_id = target_drop_id AND operation_key = target_drop.operation_key;
  expected_request_hash := encode(sha256(convert_to(
    target_drop.dropped_by || chr(31) || target_drop.item_id || chr(31)
      || target_drop.variant || chr(31) || target_drop.original_quantity::text,
    'UTF8'
  )), 'hex');
  IF target_request.player_id IS DISTINCT FROM target_drop.dropped_by
     OR target_request.request_hash IS DISTINCT FROM expected_request_hash
     OR target_request.original_result #>> '{drop,dropId}'
          IS DISTINCT FROM target_drop.id::text
     OR target_request.original_result #>> '{drop,droppedBy}'
          IS DISTINCT FROM target_drop.dropped_by
     OR target_request.original_result #>> '{drop,regionCode}'
          IS DISTINCT FROM target_drop.region_code
     OR target_request.original_result #>> '{drop,itemId}'
          IS DISTINCT FROM target_drop.item_id
     OR target_request.original_result #> '{drop,variant}' IS DISTINCT FROM
          (CASE WHEN target_drop.variant = 'default' THEN 'null'::jsonb
                ELSE to_jsonb(target_drop.variant) END)
     OR target_request.original_result #>> '{drop,quantity}'
          IS DISTINCT FROM target_drop.original_quantity::text
     OR target_request.original_result #>> '{drop,status}' IS DISTINCT FROM 'active'
     OR (target_request.original_result #>> '{drop,lat}')::double precision
          IS DISTINCT FROM target_drop.lat
     OR (target_request.original_result #>> '{drop,lon}')::double precision
          IS DISTINCT FROM target_drop.lon
     OR (target_request.original_result #>> '{drop,createdAt}')::timestamptz
          IS DISTINCT FROM target_drop.created_at
     OR (target_request.original_result #>> '{drop,expiresAt}')::timestamptz
          IS DISTINCT FROM target_drop.expires_at
     OR target_request.original_result #> '{drop,pickedUpBy}' IS DISTINCT FROM 'null'::jsonb
     OR target_request.original_result #> '{drop,pickedUpAt}' IS DISTINCT FROM 'null'::jsonb
     OR (
       coalesce((target_request.original_result ->> 'legacyBackfill')::boolean, false) = false
       AND jsonb_typeof(target_request.original_result -> 'inventory') IS DISTINCT FROM 'object'
     ) THEN
    RAISE EXCEPTION 'world item drop replay intent or original result is inconsistent';
  END IF;
  IF creation_count <> 1 OR creation_quantity <> target_drop.original_quantity THEN
    RAISE EXCEPTION 'world item drop creation custody movement is inconsistent';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM world_item_movements movement
    WHERE movement.drop_id = target_drop_id
      AND movement.movement_kind = 'player_to_world'
      AND (
        movement.operation_key IS DISTINCT FROM target_drop.operation_key
        OR movement.player_id IS DISTINCT FROM target_drop.dropped_by
        OR movement.reason IS DISTINCT FROM 'drop_created'
      )
  ) THEN
    RAISE EXCEPTION 'world item drop creation actor or operation is inconsistent';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM world_item_movements movement
    WHERE movement.drop_id = target_drop_id
      AND (movement.item_id <> target_drop.item_id OR movement.variant <> target_drop.variant)
  ) THEN
    RAISE EXCEPTION 'world item movement identity disagrees with its drop';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM world_item_movements movement
    LEFT JOIN inventory_operations inventory_operation
      ON inventory_operation.operation_key = movement.operation_key
    LEFT JOIN inventory_events event
      ON event.operation_key = movement.operation_key
     AND event.player_id = movement.player_id
     AND event.item_id = target_drop.item_id
     AND event.variant = target_drop.variant
    WHERE movement.drop_id = target_drop_id
      AND movement.movement_kind IN ('player_to_world', 'world_to_player')
      AND (
        inventory_operation.operation_key IS NULL
        OR inventory_operation.player_id IS DISTINCT FROM movement.player_id
        OR inventory_operation.source IS DISTINCT FROM CASE
          WHEN movement.movement_kind = 'player_to_world' THEN 'drop_item'
          ELSE 'pickup_dropped_item'
        END
        OR inventory_operation.source_entity_type IS DISTINCT FROM 'world_item_drop'
        OR inventory_operation.source_entity_id IS DISTINCT FROM target_drop.id::text
        OR event.id IS NULL
        OR event.source IS DISTINCT FROM CASE
          WHEN movement.movement_kind = 'player_to_world' THEN 'drop_item'
          ELSE 'pickup_dropped_item'
        END
        OR event.source_entity_type IS DISTINCT FROM 'world_item_drop'
        OR event.source_entity_id IS DISTINCT FROM target_drop.id::text
        OR event.delta_quantity <> CASE
          WHEN movement.movement_kind = 'player_to_world' THEN -movement.quantity
          ELSE movement.quantity
        END
        OR movement.reason IS DISTINCT FROM CASE
          WHEN movement.movement_kind = 'player_to_world' THEN 'drop_created'
          ELSE 'drop_picked_up'
        END
      )
  ) THEN
    RAISE EXCEPTION 'world item movement lacks its exact inventory transition';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM world_item_movements movement
    JOIN inventory_events event ON event.operation_key = movement.operation_key
    WHERE movement.drop_id = target_drop_id
      AND movement.movement_kind IN ('player_to_world', 'world_to_player')
      AND (
        event.player_id IS DISTINCT FROM movement.player_id
        OR event.item_id IS DISTINCT FROM target_drop.item_id
        OR event.variant IS DISTINCT FROM target_drop.variant
        OR event.delta_quantity IS DISTINCT FROM CASE
          WHEN movement.movement_kind = 'player_to_world' THEN -movement.quantity
          ELSE movement.quantity
        END
        OR event.source IS DISTINCT FROM CASE
          WHEN movement.movement_kind = 'player_to_world' THEN 'drop_item'
          ELSE 'pickup_dropped_item'
        END
        OR event.source_entity_type IS DISTINCT FROM 'world_item_drop'
        OR event.source_entity_id IS DISTINCT FROM target_drop.id::text
      )
  ) THEN
    RAISE EXCEPTION 'world item operation contains an incompatible inventory transition';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM world_item_pickups pickup
    LEFT JOIN world_item_movements movement
      ON movement.pickup_operation_key = pickup.operation_key
     AND movement.movement_kind = 'world_to_player'
    WHERE pickup.drop_id = target_drop_id
      AND (
        movement.movement_id IS NULL
        OR movement.drop_id IS DISTINCT FROM pickup.drop_id
        OR movement.player_id <> pickup.player_id
        OR movement.quantity <> pickup.granted_quantity
      )
  ) THEN
    RAISE EXCEPTION 'world item pickup lacks one exact custody movement';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM (
      SELECT pickup.operation_key, pickup.remaining_quantity, pickup.resulting_status,
             target_drop.original_quantity - sum(pickup.granted_quantity) OVER (
               PARTITION BY pickup.drop_id ORDER BY pickup.pickup_sequence
             ) AS expected_remaining
      FROM world_item_pickups pickup
      WHERE pickup.drop_id = target_drop_id
    ) ordered
    WHERE ordered.remaining_quantity <> ordered.expected_remaining
       OR (ordered.remaining_quantity = 0) <> (ordered.resulting_status = 'picked_up')
  ) THEN
    RAISE EXCEPTION 'world item pickup remainder chain is inconsistent';
  END IF;
  IF pickup_quantity + destruction_quantity + target_drop.remaining_quantity
     <> target_drop.original_quantity THEN
    RAISE EXCEPTION 'world item custody does not conserve original quantity';
  END IF;
  IF target_drop.status = 'active' AND destruction_count <> 0 THEN
    RAISE EXCEPTION 'active world item cannot have destruction movement';
  ELSIF target_drop.status = 'picked_up' THEN
    IF pickup_quantity <> target_drop.original_quantity OR destruction_count <> 0
       OR NOT EXISTS (
         SELECT 1
         FROM world_item_pickups pickup
         WHERE pickup.drop_id = target_drop.id
           AND pickup.operation_key = target_drop.pickup_operation_key
           AND pickup.player_id = target_drop.picked_up_by
           AND pickup.remaining_quantity = 0
           AND pickup.resulting_status = 'picked_up'
           AND pickup.created_at = target_drop.picked_up_at
       ) THEN
      RAISE EXCEPTION 'picked-up world item custody or terminal evidence is incomplete';
    END IF;
  ELSIF target_drop.status IN ('expired', 'cancelled') THEN
    IF destruction_count <> 1 OR destruction_quantity <= 0
       OR NOT EXISTS (
         SELECT 1
         FROM world_item_movements movement
         WHERE movement.drop_id = target_drop.id
           AND movement.movement_kind = 'world_to_destruction'
           AND movement.created_at = target_drop.expired_at
           AND movement.reason = CASE WHEN target_drop.status = 'cancelled'
             THEN 'legacy_cancelled_sink' ELSE 'expired_sink' END
       ) THEN
      RAISE EXCEPTION 'expired world item must retain exact destruction evidence';
    END IF;
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enforce_world_item_drop_commit()
RETURNS trigger AS $$
BEGIN
  PERFORM validate_world_item_drop_commit(NEW.id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enforce_world_item_drop_child_commit()
RETURNS trigger AS $$
BEGIN
  PERFORM validate_world_item_drop_commit(NEW.drop_id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enforce_world_item_drop_transition()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'world item drops cannot be deleted';
  END IF;
  IF NEW.id <> OLD.id OR NEW.operation_key <> OLD.operation_key
     OR NEW.dropped_by <> OLD.dropped_by OR NEW.region_code <> OLD.region_code
     OR NEW.item_id <> OLD.item_id OR NEW.variant <> OLD.variant
     OR NEW.original_quantity <> OLD.original_quantity
     OR NEW.lat <> OLD.lat OR NEW.lon <> OLD.lon OR NOT ST_Equals(NEW.geom, OLD.geom)
     OR NEW.created_at <> OLD.created_at OR NEW.expires_at <> OLD.expires_at THEN
    RAISE EXCEPTION 'world item drop identity and original quantity are immutable';
  END IF;
  IF NEW.remaining_quantity > OLD.remaining_quantity THEN
    RAISE EXCEPTION 'world item drop remaining quantity cannot increase';
  END IF;
  IF OLD.status <> 'active' AND (
       NEW.status IS DISTINCT FROM OLD.status
       OR NEW.remaining_quantity IS DISTINCT FROM OLD.remaining_quantity
       OR NEW.pickup_operation_key IS DISTINCT FROM OLD.pickup_operation_key
       OR NEW.picked_up_by IS DISTINCT FROM OLD.picked_up_by
       OR NEW.picked_up_at IS DISTINCT FROM OLD.picked_up_at
       OR NEW.expired_at IS DISTINCT FROM OLD.expired_at
     ) THEN
    RAISE EXCEPTION 'terminal world item drop state is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS world_item_drops_transition_guard ON world_item_drops;
CREATE TRIGGER world_item_drops_transition_guard
BEFORE UPDATE OR DELETE ON world_item_drops
FOR EACH ROW EXECUTE FUNCTION enforce_world_item_drop_transition();
DROP TRIGGER IF EXISTS world_item_pickups_immutable ON world_item_pickups;
CREATE TRIGGER world_item_pickups_immutable
BEFORE UPDATE OR DELETE ON world_item_pickups
FOR EACH ROW EXECUTE FUNCTION reject_market_immutable_mutation();
DROP TRIGGER IF EXISTS world_item_drop_requests_immutable ON world_item_drop_requests;
CREATE TRIGGER world_item_drop_requests_immutable
BEFORE UPDATE OR DELETE ON world_item_drop_requests
FOR EACH ROW EXECUTE FUNCTION reject_market_immutable_mutation();
DROP TRIGGER IF EXISTS world_item_movements_immutable ON world_item_movements;
CREATE TRIGGER world_item_movements_immutable
BEFORE UPDATE OR DELETE ON world_item_movements
FOR EACH ROW EXECUTE FUNCTION reject_market_immutable_mutation();

DROP TRIGGER IF EXISTS world_item_drops_commit_guard ON world_item_drops;
CREATE CONSTRAINT TRIGGER world_item_drops_commit_guard
AFTER INSERT OR UPDATE ON world_item_drops
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_world_item_drop_commit();
DROP TRIGGER IF EXISTS world_item_pickups_commit_guard ON world_item_pickups;
CREATE CONSTRAINT TRIGGER world_item_pickups_commit_guard
AFTER INSERT ON world_item_pickups
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_world_item_drop_child_commit();
DROP TRIGGER IF EXISTS world_item_drop_requests_commit_guard ON world_item_drop_requests;
CREATE CONSTRAINT TRIGGER world_item_drop_requests_commit_guard
AFTER INSERT ON world_item_drop_requests
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_world_item_drop_child_commit();
DROP TRIGGER IF EXISTS world_item_movements_commit_guard ON world_item_movements;
CREATE CONSTRAINT TRIGGER world_item_movements_commit_guard
AFTER INSERT ON world_item_movements
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_world_item_drop_child_commit();

-- ---------------------------------------------------------------------------
-- Every sensitive control change is automatically and immutably audited in
-- the same transaction. Callers provide operator context through SET LOCAL.
-- ---------------------------------------------------------------------------

ALTER TABLE market_venue_controls
  ADD CONSTRAINT market_venue_controls_sensitive_reason_bounded CHECK (
    sensitive_reason IS NULL OR (
      char_length(sensitive_reason) <= 240
      AND sensitive_reason !~ '[[:cntrl:]]'
    )
  );
ALTER TABLE market_player_controls
  ADD CONSTRAINT market_player_controls_sensitive_reason_bounded CHECK (
    sensitive_reason IS NULL OR (
      char_length(sensitive_reason) <= 240
      AND sensitive_reason !~ '[[:cntrl:]]'
    )
  );
ALTER TABLE market_order_books
  ADD CONSTRAINT market_order_books_sensitive_reason_bounded CHECK (
    sensitive_reason IS NULL OR (
      char_length(sensitive_reason) <= 240
      AND sensitive_reason !~ '[[:cntrl:]]'
    )
  );

CREATE OR REPLACE FUNCTION audit_market_control_change()
RETURNS trigger AS $$
DECLARE
  operator_identity text := nullif(
    current_setting('ash_atlas.market_control_operator', true), ''
  );
  change_reason text := nullif(
    current_setting('ash_atlas.market_control_reason', true), ''
  );
  incident_id text := nullif(
    current_setting('ash_atlas.market_control_incident_id', true), ''
  );
  prior_state jsonb;
  resulting_state jsonb;
  target_scope jsonb;
  target_venue_id uuid := NULL;
  target_book_id uuid := NULL;
  target_player_id text := NULL;
  sensitive_change boolean := false;
BEGIN
  IF TG_TABLE_NAME = 'market_global_controls' THEN
    prior_state := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE jsonb_build_object(
      'readOnly', OLD.read_only,
      'newOrdersEnabled', OLD.new_orders_enabled,
      'matchingEnabled', OLD.matching_enabled,
      'cancellationsEnabled', OLD.cancellations_enabled,
      'claimsEnabled', OLD.claims_enabled,
      'autoPauseOnInvariantFailure', OLD.auto_pause_on_invariant_failure,
      'rulesVersion', OLD.rules_version
    ) END;
    resulting_state := jsonb_build_object(
      'readOnly', NEW.read_only,
      'newOrdersEnabled', NEW.new_orders_enabled,
      'matchingEnabled', NEW.matching_enabled,
      'cancellationsEnabled', NEW.cancellations_enabled,
      'claimsEnabled', NEW.claims_enabled,
      'autoPauseOnInvariantFailure', NEW.auto_pause_on_invariant_failure,
      'rulesVersion', NEW.rules_version
    );
    target_scope := jsonb_build_object('type', 'global', 'id', 'global');
    sensitive_change := TG_OP = 'UPDATE' AND prior_state IS DISTINCT FROM resulting_state;
  ELSIF TG_TABLE_NAME = 'market_venue_controls' THEN
    prior_state := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE jsonb_build_object(
      'frozen', OLD.frozen, 'sensitiveReason', OLD.sensitive_reason
    ) END;
    resulting_state := jsonb_build_object(
      'frozen', NEW.frozen, 'sensitiveReason', NEW.sensitive_reason
    );
    target_scope := jsonb_build_object('type', 'venue', 'id', NEW.venue_id);
    target_venue_id := NEW.venue_id;
    sensitive_change := CASE WHEN TG_OP = 'INSERT'
      THEN NEW.frozen OR NEW.sensitive_reason IS NOT NULL
      ELSE prior_state IS DISTINCT FROM resulting_state
    END;
  ELSIF TG_TABLE_NAME = 'market_player_controls' THEN
    prior_state := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE jsonb_build_object(
      'mutationsFrozen', OLD.mutations_frozen, 'sensitiveReason', OLD.sensitive_reason
    ) END;
    resulting_state := jsonb_build_object(
      'mutationsFrozen', NEW.mutations_frozen, 'sensitiveReason', NEW.sensitive_reason
    );
    target_scope := jsonb_build_object(
      'type', 'player', 'id', NEW.player_id, 'accountId', NEW.account_id
    );
    target_player_id := NEW.player_id;
    sensitive_change := CASE WHEN TG_OP = 'INSERT'
      THEN NEW.mutations_frozen OR NEW.sensitive_reason IS NOT NULL
      ELSE prior_state IS DISTINCT FROM resulting_state
    END;
  ELSIF TG_TABLE_NAME = 'market_order_books' THEN
    prior_state := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE jsonb_build_object(
      'frozen', OLD.frozen, 'sensitiveReason', OLD.sensitive_reason
    ) END;
    resulting_state := jsonb_build_object(
      'frozen', NEW.frozen, 'sensitiveReason', NEW.sensitive_reason
    );
    target_scope := jsonb_build_object('type', 'book', 'id', NEW.book_id);
    target_venue_id := NEW.venue_id;
    target_book_id := NEW.book_id;
    sensitive_change := CASE WHEN TG_OP = 'INSERT'
      THEN NEW.frozen OR NEW.sensitive_reason IS NOT NULL
      ELSE prior_state IS DISTINCT FROM resulting_state
    END;
  ELSE
    RAISE EXCEPTION 'unsupported market control audit target %', TG_TABLE_NAME;
  END IF;

  IF NOT sensitive_change THEN
    RETURN NEW;
  END IF;
  IF operator_identity IS NULL OR btrim(operator_identity) = '' THEN
    RAISE EXCEPTION 'market control change requires operator identity';
  END IF;
  IF change_reason IS NULL OR btrim(change_reason) = '' THEN
    RAISE EXCEPTION 'market control change requires a reason';
  END IF;
  IF char_length(operator_identity) > 160
     OR operator_identity ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'market control operator identity is invalid or too long';
  END IF;
  IF char_length(change_reason) > 240
     OR change_reason ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'market control reason is invalid or too long';
  END IF;
  IF incident_id IS NOT NULL
     AND (char_length(incident_id) > 160 OR incident_id ~ '[[:cntrl:]]') THEN
    RAISE EXCEPTION 'market control incident id is invalid or too long';
  END IF;

  INSERT INTO market_audit_events (
    severity, event_type, venue_id, book_id, player_id, evidence
  ) VALUES (
    'warning', 'market_control_changed', target_venue_id, target_book_id,
    target_player_id,
    jsonb_build_object(
      'operatorIdentity', operator_identity,
      'reason', change_reason,
      'incidentId', incident_id,
      'targetScope', target_scope,
      'priorState', prior_state,
      'resultingState', resulting_state
    )
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION reject_market_control_delete()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'market control rows cannot be deleted';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS market_global_controls_audit ON market_global_controls;
CREATE TRIGGER market_global_controls_audit
AFTER INSERT OR UPDATE ON market_global_controls
FOR EACH ROW EXECUTE FUNCTION audit_market_control_change();
DROP TRIGGER IF EXISTS market_venue_controls_audit ON market_venue_controls;
CREATE TRIGGER market_venue_controls_audit
AFTER INSERT OR UPDATE ON market_venue_controls
FOR EACH ROW EXECUTE FUNCTION audit_market_control_change();
DROP TRIGGER IF EXISTS market_player_controls_audit ON market_player_controls;
CREATE TRIGGER market_player_controls_audit
AFTER INSERT OR UPDATE ON market_player_controls
FOR EACH ROW EXECUTE FUNCTION audit_market_control_change();
DROP TRIGGER IF EXISTS market_order_books_control_audit ON market_order_books;
CREATE TRIGGER market_order_books_control_audit
AFTER INSERT OR UPDATE ON market_order_books
FOR EACH ROW EXECUTE FUNCTION audit_market_control_change();

DROP TRIGGER IF EXISTS market_global_controls_delete_guard ON market_global_controls;
CREATE TRIGGER market_global_controls_delete_guard
BEFORE DELETE ON market_global_controls
FOR EACH ROW EXECUTE FUNCTION reject_market_control_delete();
DROP TRIGGER IF EXISTS market_venue_controls_delete_guard ON market_venue_controls;
CREATE TRIGGER market_venue_controls_delete_guard
BEFORE DELETE ON market_venue_controls
FOR EACH ROW EXECUTE FUNCTION reject_market_control_delete();
DROP TRIGGER IF EXISTS market_player_controls_delete_guard ON market_player_controls;
CREATE TRIGGER market_player_controls_delete_guard
BEFORE DELETE ON market_player_controls
FOR EACH ROW EXECUTE FUNCTION reject_market_control_delete();
DROP TRIGGER IF EXISTS market_order_books_delete_guard ON market_order_books;
CREATE TRIGGER market_order_books_delete_guard
BEFORE DELETE ON market_order_books
FOR EACH ROW EXECUTE FUNCTION reject_market_control_delete();

-- ---------------------------------------------------------------------------
-- Independent COMMIT-time escrow/journal and settlement validation.
-- These checks intentionally do not trust application-computed refunds or an
-- internally balanced journal group.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION validate_market_order_journal_commit(target_order_id uuid)
RETURNS void AS $$
DECLARE
  target_order market_orders%ROWTYPE;
  target_escrow market_order_escrows%ROWTYPE;
  target_fee market_fee_policies%ROWTYPE;
  escrow_location text;
  escrow_net numeric;
  expected_initial numeric;
  authoritative_transition_count bigint;
BEGIN
  SELECT * INTO target_order FROM market_orders WHERE order_id = target_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'market journal references a missing order';
  END IF;
  SELECT * INTO target_escrow FROM market_order_escrows WHERE order_id = target_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'market order journal requires exactly one escrow row';
  END IF;
  SELECT * INTO target_fee
  FROM market_fee_policies
  WHERE fee_policy_id = target_order.fee_policy_id
    AND version = target_order.fee_policy_version;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'market order journal fee policy does not exist';
  END IF;

  escrow_location := CASE
    WHEN target_order.side = 'sell' THEN 'sell_escrow'
    ELSE 'buy_escrow'
  END;
  SELECT coalesce(sum(amount), 0) INTO escrow_net
  FROM market_ledger_entries
  WHERE order_id = target_order_id AND account_location = escrow_location;

  IF escrow_net <> target_escrow.remaining_amount THEN
    RAISE EXCEPTION 'market escrow row does not match cumulative journal net';
  END IF;
  IF target_order.status IN ('filled', 'cancelled') AND escrow_net <> 0 THEN
    RAISE EXCEPTION 'closed market order retains journal escrow';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM market_ledger_entries entry
    WHERE entry.order_id = target_order_id
      AND entry.account_location = escrow_location
      AND (
        entry.player_id IS DISTINCT FROM target_order.player_id
        OR entry.asset_kind <> target_escrow.asset_kind
        OR entry.item_identity IS DISTINCT FROM target_escrow.item_identity
      )
  ) THEN
    RAISE EXCEPTION 'market escrow journal identity is inconsistent with its order';
  END IF;

  IF target_order.side = 'sell' THEN
    SELECT count(*) INTO authoritative_transition_count
    FROM inventory_operations operation
    JOIN inventory_events event
      ON event.operation_key = operation.operation_key
     AND event.player_id = operation.player_id
    WHERE operation.operation_key =
            'market-sell-escrow:' || target_order.account_id::text || ':'
              || target_order.client_request_id
      AND operation.player_id = target_order.player_id
      AND operation.source = 'market_sell_escrow'
      AND operation.source_entity_type = 'market_order'
      AND operation.source_entity_id = target_order.order_id::text
      AND event.item_id = target_order.item_id
      AND event.variant = target_order.variant
      AND event.delta_quantity = -target_order.original_quantity
      AND event.source = 'market_sell_escrow'
      AND event.source_entity_type = 'market_order'
      AND event.source_entity_id = target_order.order_id::text;
  ELSE
    SELECT count(*) INTO authoritative_transition_count
    FROM wallet_events event
    WHERE event.operation_key =
            'market-buy-escrow:' || target_order.account_id::text || ':'
              || target_order.client_request_id
      AND event.player_id = target_order.player_id
      AND event.account_id = target_order.account_id
      AND event.delta_gold = -target_escrow.initial_amount
      AND event.reason = 'market_buy_escrow'
      AND event.market_order_id = target_order.order_id
      AND event.market_trade_id IS NULL;
  END IF;
  IF authoritative_transition_count <> 1 THEN
    RAISE EXCEPTION 'market order escrow lacks its exact authoritative asset transition';
  END IF;
  IF target_order.side = 'sell' AND EXISTS (
    SELECT 1
    FROM inventory_events event
    WHERE event.operation_key =
            'market-sell-escrow:' || target_order.account_id::text || ':'
              || target_order.client_request_id
      AND (
        event.player_id IS DISTINCT FROM target_order.player_id
        OR event.item_id IS DISTINCT FROM target_order.item_id
        OR event.variant IS DISTINCT FROM target_order.variant
        OR event.delta_quantity IS DISTINCT FROM -target_order.original_quantity
        OR event.source IS DISTINCT FROM 'market_sell_escrow'
        OR event.source_entity_type IS DISTINCT FROM 'market_order'
        OR event.source_entity_id IS DISTINCT FROM target_order.order_id::text
      )
  ) THEN
    RAISE EXCEPTION 'market sell escrow operation contains an incompatible inventory transition';
  END IF;

  IF target_order.side = 'buy' AND target_order.order_policy = 'aon_ioc' THEN
    SELECT coalesce(sum(gross_value::numeric + buyer_fee::numeric), 0)
    INTO expected_initial
    FROM market_trades
    WHERE buy_order_id = target_order_id;
    IF target_order.status <> 'filled'
       OR target_escrow.initial_amount::numeric <> expected_initial THEN
      RAISE EXCEPTION 'atomic buy escrow does not equal its exact durable fills';
    END IF;
  END IF;
END;
$$ LANGUAGE plpgsql;

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
      SELECT entry.item_identity AS item_id, sum(entry.amount)::numeric AS quantity
      FROM market_ledger_entries entry
      WHERE entry.ledger_group_id = claim_group_id
        AND entry.asset_kind = 'item'
        AND entry.account_location = 'player_inventory'
        AND entry.amount > 0
      GROUP BY entry.item_identity
    ), actual AS (
      SELECT event.item_id, sum(event.delta_quantity)::numeric AS quantity
      FROM inventory_events event
      WHERE event.operation_key = expected_operation_key
        AND event.player_id = target_claim.player_id
      GROUP BY event.item_id
    )
    SELECT 1
    FROM expected
    FULL JOIN actual USING (item_id)
    WHERE expected.item_id IS NULL OR actual.item_id IS NULL
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

CREATE OR REPLACE FUNCTION validate_market_trade_hardening_commit(target_trade_id uuid)
RETURNS void AS $$
DECLARE
  target_trade market_trades%ROWTYPE;
  buy_order market_orders%ROWTYPE;
  sell_order market_orders%ROWTYPE;
  maker_order market_orders%ROWTYPE;
  taker_order market_orders%ROWTYPE;
  buyer_fee_policy market_fee_policies%ROWTYPE;
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
  SELECT * INTO taker_order
  FROM market_orders
  WHERE order_id = CASE
    WHEN target_trade.maker_order_id = target_trade.buy_order_id
      THEN target_trade.sell_order_id
    ELSE target_trade.buy_order_id
  END;
  SELECT * INTO buyer_fee_policy
  FROM market_fee_policies
  WHERE fee_policy_id = target_trade.buyer_fee_policy_id
    AND version = target_trade.buyer_fee_policy_version;

  IF buy_order.order_id IS NULL OR sell_order.order_id IS NULL
     OR maker_order.order_id IS NULL OR taker_order.order_id IS NULL
     OR buyer_fee_policy.fee_policy_id IS NULL THEN
    RAISE EXCEPTION 'market hardening trade relationship is incomplete';
  END IF;
  IF target_trade.unit_price > buy_order.limit_unit_price THEN
    RAISE EXCEPTION 'market trade price exceeds buyer limit';
  END IF;
  IF target_trade.unit_price < sell_order.limit_unit_price THEN
    RAISE EXCEPTION 'market trade price is below seller limit';
  END IF;
  IF maker_order.limit_unit_price <> target_trade.unit_price
     OR maker_order.priority_sequence >= taker_order.priority_sequence THEN
    RAISE EXCEPTION 'market maker identity, price, or priority is inconsistent';
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
    IF remaining_before <= 0 OR remaining_after < 0 THEN
      RAISE EXCEPTION 'market trade sequence exceeds buy order quantity';
    END IF;
    required_before := buy_order.limit_unit_price::numeric * remaining_before;
    required_before := required_before
      + floor(required_before * buyer_fee_policy.buyer_fee_bps::numeric / 10000);
    required_after := buy_order.limit_unit_price::numeric * remaining_after;
    required_after := required_after
      + floor(required_after * buyer_fee_policy.buyer_fee_bps::numeric / 10000);
    expected_refund := required_before - required_after
      - target_trade.gross_value::numeric - target_trade.buyer_fee::numeric;
    IF expected_refund < 0 THEN
      RAISE EXCEPTION 'market trade implies a negative price-improvement refund';
    END IF;
  END IF;

  SELECT count(*), coalesce(sum(original_amount), 0)
  INTO refund_count, refund_total
  FROM market_collections
  WHERE source_trade_id = target_trade_id
    AND reason = 'price_improvement_refund';
  IF (expected_refund = 0 AND (refund_count <> 0 OR refund_total <> 0))
     OR (expected_refund > 0 AND (refund_count <> 1 OR refund_total <> expected_refund)) THEN
    RAISE EXCEPTION 'market price-improvement refund is not independently correct';
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION validate_market_ledger_entry_compatibility(
  target_ledger_entry_id bigint
)
RETURNS void AS $$
DECLARE
  target_entry market_ledger_entries%ROWTYPE;
  target_group market_ledger_groups%ROWTYPE;
  target_trade market_trades%ROWTYPE;
BEGIN
  SELECT * INTO target_entry
  FROM market_ledger_entries WHERE ledger_entry_id = target_ledger_entry_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'market ledger compatibility references a missing entry';
  END IF;
  SELECT * INTO target_group
  FROM market_ledger_groups WHERE ledger_group_id = target_entry.ledger_group_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'market ledger entry references a missing group';
  END IF;

  IF target_group.group_type IN ('order_escrow', 'cancel') THEN
    IF target_entry.order_id IS DISTINCT FROM target_group.order_id
       OR target_entry.trade_id IS NOT NULL THEN
      RAISE EXCEPTION 'order ledger entry source is incompatible with its group';
    END IF;
  ELSIF target_group.group_type = 'trade' THEN
    SELECT * INTO target_trade FROM market_trades WHERE trade_id = target_group.trade_id;
    IF target_entry.trade_id IS DISTINCT FROM target_group.trade_id
       OR (
         target_entry.order_id IS NOT NULL
         AND target_entry.order_id NOT IN (target_trade.buy_order_id, target_trade.sell_order_id)
       ) THEN
      RAISE EXCEPTION 'trade ledger entry source is incompatible with its group';
    END IF;
  ELSIF target_group.group_type = 'claim' THEN
    IF target_entry.order_id IS NOT NULL OR target_entry.trade_id IS NOT NULL THEN
      RAISE EXCEPTION 'claim ledger entry cannot claim an order or trade identity';
    END IF;
  ELSE
    RAISE EXCEPTION 'unsupported fee or administrative ledger groups cannot move economic assets';
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION validate_market_ledger_group_hardening(
  target_ledger_group_id uuid
)
RETURNS void AS $$
DECLARE
  target_group market_ledger_groups%ROWTYPE;
  target_order market_orders%ROWTYPE;
  target_trade market_trades%ROWTYPE;
  target_entry_id bigint;
BEGIN
  SELECT * INTO target_group
  FROM market_ledger_groups WHERE ledger_group_id = target_ledger_group_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'market hardening validator references a missing ledger group';
  END IF;

  IF target_group.group_type IN ('order_escrow', 'cancel') THEN
    SELECT * INTO target_order FROM market_orders WHERE order_id = target_group.order_id;
    IF target_order.order_id IS NULL
       OR target_group.order_fee_policy_id <> target_order.fee_policy_id
       OR target_group.order_fee_policy_version <> target_order.fee_policy_version THEN
      RAISE EXCEPTION 'order ledger fee provenance is inconsistent';
    END IF;
    PERFORM validate_market_order_journal_commit(target_group.order_id);
  ELSIF target_group.group_type = 'trade' THEN
    SELECT * INTO target_trade FROM market_trades WHERE trade_id = target_group.trade_id;
    IF target_trade.trade_id IS NULL
       OR target_group.buyer_fee_policy_id <> target_trade.buyer_fee_policy_id
       OR target_group.buyer_fee_policy_version <> target_trade.buyer_fee_policy_version
       OR target_group.seller_fee_policy_id <> target_trade.seller_fee_policy_id
       OR target_group.seller_fee_policy_version <> target_trade.seller_fee_policy_version THEN
      RAISE EXCEPTION 'trade ledger fee provenance is inconsistent';
    END IF;
    PERFORM validate_market_trade_hardening_commit(target_group.trade_id);
    PERFORM validate_market_order_journal_commit(target_trade.buy_order_id);
    PERFORM validate_market_order_journal_commit(target_trade.sell_order_id);
  ELSIF target_group.group_type = 'claim' THEN
    PERFORM validate_market_claim_commit(target_group.claim_id);
    PERFORM validate_market_ledger_group_collections(target_ledger_group_id);
    PERFORM validate_market_claim_asset_provenance(target_group.claim_id);
  ELSIF target_group.group_type IN ('fee', 'administrative') THEN
    RAISE EXCEPTION 'unsupported fee or administrative ledger group';
  END IF;

  FOR target_entry_id IN
    SELECT ledger_entry_id FROM market_ledger_entries
    WHERE ledger_group_id = target_ledger_group_id
  LOOP
    PERFORM validate_market_ledger_entry_compatibility(target_entry_id);
  END LOOP;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enforce_market_order_journal_commit()
RETURNS trigger AS $$
BEGIN
  PERFORM validate_market_order_journal_commit(NEW.order_id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enforce_market_claim_asset_commit()
RETURNS trigger AS $$
BEGIN
  PERFORM validate_market_claim_asset_provenance(NEW.claim_id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enforce_market_inventory_asset_provenance()
RETURNS trigger AS $$
DECLARE
  target_order_id uuid;
  target_claim_id uuid;
  target_drop_id uuid;
BEGIN
  IF NEW.source = 'market_sell_escrow'
     OR NEW.operation_key LIKE 'market-sell-escrow:%' THEN
    SELECT order_id INTO target_order_id
    FROM market_orders order_row
    WHERE order_row.side = 'sell'
      AND order_row.player_id = NEW.player_id
      AND NEW.operation_key =
        'market-sell-escrow:' || order_row.account_id::text || ':'
          || order_row.client_request_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'market sell asset transition has no matching order';
    END IF;
    PERFORM validate_market_order_journal_commit(target_order_id);
  ELSIF NEW.source = 'market_collection_claim'
        OR NEW.operation_key LIKE 'market-claim-items:%' THEN
    SELECT claim_id INTO target_claim_id
    FROM market_claims claim
    WHERE claim.player_id = NEW.player_id
      AND NEW.operation_key =
        'market-claim-items:' || claim.account_id::text || ':'
          || claim.client_request_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'market inventory claim transition has no matching claim';
    END IF;
    PERFORM validate_market_claim_asset_provenance(target_claim_id);
  ELSIF NEW.source IN ('drop_item', 'pickup_dropped_item')
        OR NEW.operation_key LIKE 'drop-dropped-item:%'
        OR NEW.operation_key LIKE 'pickup-dropped-item:%' THEN
    SELECT drop_id INTO target_drop_id
    FROM (
      SELECT drop.id AS drop_id
      FROM world_item_drops drop
      WHERE drop.operation_key = NEW.operation_key
      UNION ALL
      SELECT pickup.drop_id
      FROM world_item_pickups pickup
      WHERE pickup.operation_key = NEW.operation_key
    ) matched_drop
    LIMIT 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'world item inventory transition has no matching custody record';
    END IF;
    PERFORM validate_world_item_drop_commit(target_drop_id);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enforce_market_wallet_asset_provenance()
RETURNS trigger AS $$
DECLARE
  target_order_id uuid;
  target_claim_id uuid;
BEGIN
  IF NEW.reason = 'market_buy_escrow'
     OR NEW.operation_key LIKE 'market-buy-escrow:%' THEN
    SELECT order_id INTO target_order_id
    FROM market_orders order_row
    WHERE order_row.side = 'buy'
      AND order_row.player_id = NEW.player_id
      AND order_row.account_id = NEW.account_id
      AND NEW.operation_key =
        'market-buy-escrow:' || order_row.account_id::text || ':'
          || order_row.client_request_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'market buy asset transition has no matching order';
    END IF;
    PERFORM validate_market_order_journal_commit(target_order_id);
  ELSIF NEW.reason = 'market_collection_claim'
        OR NEW.operation_key LIKE 'market-claim-gold:%' THEN
    SELECT claim_id INTO target_claim_id
    FROM market_claims claim
    WHERE claim.player_id = NEW.player_id
      AND claim.account_id = NEW.account_id
      AND NEW.operation_key =
        'market-claim-gold:' || claim.account_id::text || ':'
          || claim.client_request_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'market wallet claim transition has no matching claim';
    END IF;
    PERFORM validate_market_claim_asset_provenance(target_claim_id);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enforce_market_trade_hardening_commit()
RETURNS trigger AS $$
BEGIN
  PERFORM validate_market_trade_hardening_commit(NEW.trade_id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enforce_market_collection_hardening_commit()
RETURNS trigger AS $$
BEGIN
  IF NEW.source_trade_id IS NOT NULL THEN
    PERFORM validate_market_trade_hardening_commit(NEW.source_trade_id);
  END IF;
  IF NEW.source_order_id IS NOT NULL THEN
    PERFORM validate_market_order_journal_commit(NEW.source_order_id);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enforce_market_ledger_group_hardening()
RETURNS trigger AS $$
BEGIN
  PERFORM validate_market_ledger_group_hardening(NEW.ledger_group_id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enforce_market_ledger_entry_hardening()
RETURNS trigger AS $$
BEGIN
  PERFORM validate_market_ledger_entry_compatibility(NEW.ledger_entry_id);
  PERFORM validate_market_ledger_group_hardening(NEW.ledger_group_id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS market_orders_journal_guard ON market_orders;
CREATE CONSTRAINT TRIGGER market_orders_journal_guard
AFTER INSERT OR UPDATE ON market_orders
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_market_order_journal_commit();
DROP TRIGGER IF EXISTS market_order_escrows_journal_guard ON market_order_escrows;
CREATE CONSTRAINT TRIGGER market_order_escrows_journal_guard
AFTER INSERT OR UPDATE ON market_order_escrows
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_market_order_journal_commit();
DROP TRIGGER IF EXISTS market_trades_hardening_guard ON market_trades;
DROP TRIGGER IF EXISTS market_trades_00_hardening_guard ON market_trades;
CREATE CONSTRAINT TRIGGER market_trades_00_hardening_guard
AFTER INSERT ON market_trades
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_market_trade_hardening_commit();
DROP TRIGGER IF EXISTS market_collections_hardening_guard ON market_collections;
DROP TRIGGER IF EXISTS market_collections_00_hardening_guard ON market_collections;
CREATE CONSTRAINT TRIGGER market_collections_00_hardening_guard
AFTER INSERT OR UPDATE ON market_collections
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_market_collection_hardening_commit();
DROP TRIGGER IF EXISTS market_ledger_groups_hardening_guard ON market_ledger_groups;
CREATE CONSTRAINT TRIGGER market_ledger_groups_hardening_guard
AFTER INSERT ON market_ledger_groups
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_market_ledger_group_hardening();
DROP TRIGGER IF EXISTS market_ledger_entries_hardening_guard ON market_ledger_entries;
CREATE CONSTRAINT TRIGGER market_ledger_entries_hardening_guard
AFTER INSERT ON market_ledger_entries
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_market_ledger_entry_hardening();
DROP TRIGGER IF EXISTS market_claims_asset_provenance_guard ON market_claims;
DROP TRIGGER IF EXISTS market_claims_z_asset_provenance_guard ON market_claims;
CREATE CONSTRAINT TRIGGER market_claims_z_asset_provenance_guard
AFTER INSERT ON market_claims
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_market_claim_asset_commit();
DROP TRIGGER IF EXISTS inventory_operations_market_provenance_guard ON inventory_operations;
CREATE CONSTRAINT TRIGGER inventory_operations_market_provenance_guard
AFTER INSERT ON inventory_operations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_market_inventory_asset_provenance();
DROP TRIGGER IF EXISTS inventory_events_market_provenance_guard ON inventory_events;
CREATE CONSTRAINT TRIGGER inventory_events_market_provenance_guard
AFTER INSERT ON inventory_events
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_market_inventory_asset_provenance();
DROP TRIGGER IF EXISTS wallet_events_market_provenance_guard ON wallet_events;
CREATE CONSTRAINT TRIGGER wallet_events_market_provenance_guard
AFTER INSERT ON wallet_events
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_market_wallet_asset_provenance();

-- Replacing/adding validators does not retroactively fire triggers. Validate all
-- retained financial history before the migration can be recorded as applied.
DO $$
DECLARE
  target_order_id uuid;
  target_trade_id uuid;
  target_claim_id uuid;
  target_group_id uuid;
  target_drop_id uuid;
  wallet_key record;
  inventory_key record;
BEGIN
  FOR wallet_key IN
    SELECT player_id, account_id FROM player_wallets
  LOOP
    PERFORM validate_wallet_event_chain(wallet_key.player_id, wallet_key.account_id);
  END LOOP;
  FOR inventory_key IN
    SELECT player_id, resource_type, variant FROM player_inventory
  LOOP
    PERFORM validate_inventory_event_chain(
      inventory_key.player_id, inventory_key.resource_type, inventory_key.variant
    );
  END LOOP;
  FOR target_order_id IN SELECT order_id FROM market_orders LOOP
    PERFORM validate_market_order_commit(target_order_id);
    PERFORM validate_market_order_journal_commit(target_order_id);
  END LOOP;
  FOR target_trade_id IN SELECT trade_id FROM market_trades LOOP
    PERFORM validate_market_trade_commit(target_trade_id);
    PERFORM validate_market_trade_hardening_commit(target_trade_id);
  END LOOP;
  FOR target_claim_id IN SELECT claim_id FROM market_claims LOOP
    PERFORM validate_market_claim_commit(target_claim_id);
    PERFORM validate_market_claim_asset_provenance(target_claim_id);
  END LOOP;
  FOR target_group_id IN SELECT ledger_group_id FROM market_ledger_groups LOOP
    PERFORM validate_market_ledger_group_hardening(target_group_id);
  END LOOP;
  FOR target_drop_id IN SELECT id FROM world_item_drops LOOP
    PERFORM validate_world_item_drop_commit(target_drop_id);
  END LOOP;
END;
$$;
