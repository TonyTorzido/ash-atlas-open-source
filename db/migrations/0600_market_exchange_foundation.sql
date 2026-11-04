-- One authoritative exchange backs both Simple Market and Merchant Market.
-- All monetary values are integer gold units; all quantities are whole units.

ALTER TABLE item_definitions
  ADD COLUMN IF NOT EXISTS market_tradable boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS market_fungible boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS market_identity text NULL,
  ADD COLUMN IF NOT EXISTS market_search_vector tsvector
    GENERATED ALWAYS AS (
      to_tsvector('simple', coalesce(display_name, '') || ' ' || coalesce(category, '') || ' ' || coalesce(item_id, ''))
    ) STORED;

UPDATE item_definitions
SET market_tradable = true,
    market_fungible = true,
    market_identity = item_id,
    updated_at = now()
WHERE item_id IN ('wood', 'stone', 'food', 'ore', 'water');

CREATE UNIQUE INDEX IF NOT EXISTS item_definitions_market_identity_idx
  ON item_definitions (market_identity)
  WHERE market_tradable AND market_fungible;
CREATE INDEX IF NOT EXISTS item_definitions_market_search_idx
  ON item_definitions USING gin (market_search_vector)
  WHERE market_tradable AND market_fungible;
CREATE INDEX IF NOT EXISTS item_definitions_market_category_idx
  ON item_definitions (category, display_name, item_id)
  WHERE market_tradable AND market_fungible;

CREATE UNIQUE INDEX IF NOT EXISTS players_id_account_unique_idx
  ON players (id, account_id);

CREATE TABLE IF NOT EXISTS player_wallets (
  player_id text PRIMARY KEY REFERENCES players(id) ON DELETE RESTRICT,
  account_id uuid NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE RESTRICT,
  gold_balance bigint NOT NULL DEFAULT 0 CHECK (gold_balance >= 0),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS player_wallets_set_updated_at ON player_wallets;
CREATE TRIGGER player_wallets_set_updated_at
BEFORE UPDATE ON player_wallets
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS wallet_events (
  event_id bigserial PRIMARY KEY,
  operation_key text NOT NULL,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  delta_gold bigint NOT NULL CHECK (delta_gold <> 0),
  balance_after bigint NOT NULL CHECK (balance_after >= 0),
  reason text NOT NULL,
  market_order_id uuid NULL,
  market_trade_id uuid NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (operation_key, player_id)
);
CREATE INDEX IF NOT EXISTS wallet_events_player_created_idx
  ON wallet_events (player_id, created_at DESC);

CREATE TABLE IF NOT EXISTS market_fee_policies (
  fee_policy_id smallint PRIMARY KEY,
  version integer NOT NULL UNIQUE CHECK (version > 0),
  listing_fee bigint NOT NULL DEFAULT 0 CHECK (listing_fee >= 0),
  buyer_fee_bps integer NOT NULL DEFAULT 0 CHECK (buyer_fee_bps BETWEEN 0 AND 10000),
  seller_fee_bps integer NOT NULL DEFAULT 0 CHECK (seller_fee_bps BETWEEN 0 AND 10000),
  cancellation_fee bigint NOT NULL DEFAULT 0 CHECK (cancellation_fee >= 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (fee_policy_id, version)
);

INSERT INTO market_fee_policies (
  fee_policy_id, version, listing_fee, buyer_fee_bps, seller_fee_bps, cancellation_fee, active
) VALUES (1, 1, 0, 0, 0, 0, true)
ON CONFLICT (fee_policy_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS market_venues (
  venue_id uuid PRIMARY KEY,
  venue_key text NOT NULL UNIQUE,
  display_name text NOT NULL,
  scope_type text NOT NULL CHECK (scope_type IN ('global_test', 'trade_hub', 'regional')),
  access_policy_id text NOT NULL,
  fee_policy_id smallint NOT NULL REFERENCES market_fee_policies(fee_policy_id),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO market_venues (
  venue_id, venue_key, display_name, scope_type, access_policy_id, fee_policy_id, active
) VALUES (
  '00000000-0000-4000-8000-000000000600',
  'global',
  'Ash Atlas Global Exchange',
  'global_test',
  'global-development-v1',
  1,
  true
) ON CONFLICT (venue_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS market_global_controls (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  read_only boolean NOT NULL DEFAULT false,
  new_orders_enabled boolean NOT NULL DEFAULT true,
  matching_enabled boolean NOT NULL DEFAULT true,
  cancellations_enabled boolean NOT NULL DEFAULT true,
  claims_enabled boolean NOT NULL DEFAULT true,
  auto_pause_on_invariant_failure boolean NOT NULL DEFAULT true,
  rules_version integer NOT NULL DEFAULT 1 CHECK (rules_version > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO market_global_controls (singleton) VALUES (true)
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS market_venue_controls (
  venue_id uuid PRIMARY KEY REFERENCES market_venues(venue_id) ON DELETE RESTRICT,
  frozen boolean NOT NULL DEFAULT false,
  sensitive_reason text NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO market_venue_controls (venue_id)
SELECT venue_id FROM market_venues WHERE venue_key = 'global'
ON CONFLICT (venue_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS market_player_controls (
  account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE RESTRICT,
  player_id text NOT NULL UNIQUE REFERENCES players(id) ON DELETE RESTRICT,
  mutations_frozen boolean NOT NULL DEFAULT false,
  sensitive_reason text NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE SEQUENCE IF NOT EXISTS market_priority_sequence AS bigint START WITH 1;

CREATE TABLE IF NOT EXISTS market_order_books (
  book_id uuid PRIMARY KEY,
  venue_id uuid NOT NULL REFERENCES market_venues(venue_id) ON DELETE RESTRICT,
  item_identity text NOT NULL,
  item_id text NOT NULL REFERENCES item_definitions(item_id) ON DELETE RESTRICT,
  variant text NOT NULL DEFAULT 'default',
  book_version bigint NOT NULL DEFAULT 0 CHECK (book_version >= 0),
  frozen boolean NOT NULL DEFAULT false,
  sensitive_reason text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id, item_identity),
  UNIQUE (book_id, venue_id),
  CHECK (length(item_identity) BETWEEN 1 AND 160),
  CHECK (length(variant) BETWEEN 1 AND 80)
);
CREATE INDEX IF NOT EXISTS market_order_books_item_idx
  ON market_order_books (item_id, venue_id);

CREATE TABLE IF NOT EXISTS market_requests (
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 8 AND 128),
  action text NOT NULL CHECK (action IN (
    'create_buy', 'create_sell', 'simple_buy', 'cancel_order', 'claim_items', 'claim_gold', 'claim_all'
  )),
  request_hash text NOT NULL CHECK (length(request_hash) = 64),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, request_id)
);
CREATE INDEX IF NOT EXISTS market_requests_player_idx
  ON market_requests (player_id, created_at DESC);
CREATE INDEX IF NOT EXISTS market_requests_created_idx
  ON market_requests (created_at DESC);

CREATE TABLE IF NOT EXISTS market_orders (
  order_id uuid PRIMARY KEY,
  venue_id uuid NOT NULL REFERENCES market_venues(venue_id) ON DELETE RESTRICT,
  book_id uuid NOT NULL,
  item_identity text NOT NULL,
  item_id text NOT NULL REFERENCES item_definitions(item_id) ON DELETE RESTRICT,
  variant text NOT NULL DEFAULT 'default',
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  side text NOT NULL CHECK (side IN ('buy', 'sell')),
  order_policy text NOT NULL DEFAULT 'gtc' CHECK (order_policy IN ('gtc', 'ioc', 'aon_ioc')),
  limit_unit_price bigint NOT NULL CHECK (limit_unit_price > 0),
  original_quantity bigint NOT NULL CHECK (original_quantity > 0),
  remaining_quantity bigint NOT NULL CHECK (remaining_quantity >= 0),
  filled_quantity bigint NOT NULL DEFAULT 0 CHECK (filled_quantity >= 0),
  status text NOT NULL CHECK (status IN ('open', 'partially_filled', 'filled', 'cancelled')),
  priority_sequence bigint NOT NULL DEFAULT nextval('market_priority_sequence') CHECK (priority_sequence > 0),
  book_version_created bigint NOT NULL CHECK (book_version_created >= 0),
  client_request_id text NOT NULL CHECK (length(client_request_id) BETWEEN 8 AND 128),
  fee_policy_id smallint NOT NULL REFERENCES market_fee_policies(fee_policy_id),
  fee_policy_version integer NOT NULL CHECK (fee_policy_version > 0),
  rules_version integer NOT NULL CHECK (rules_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz NULL,
  completed_at timestamptz NULL,
  FOREIGN KEY (book_id, venue_id) REFERENCES market_order_books(book_id, venue_id) ON DELETE RESTRICT,
  FOREIGN KEY (fee_policy_id, fee_policy_version)
    REFERENCES market_fee_policies(fee_policy_id, version) ON DELETE RESTRICT,
  UNIQUE (book_id, priority_sequence),
  UNIQUE (order_id, player_id),
  UNIQUE (account_id, client_request_id),
  CHECK (filled_quantity + remaining_quantity = original_quantity),
  CHECK ((status = 'filled') = (remaining_quantity = 0)),
  CHECK (status <> 'open' OR filled_quantity = 0),
  CHECK (status <> 'partially_filled' OR (filled_quantity > 0 AND remaining_quantity > 0)),
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  CHECK ((status = 'filled') = (completed_at IS NOT NULL)),
  CHECK (length(item_identity) BETWEEN 1 AND 160),
  CHECK (length(variant) BETWEEN 1 AND 80)
);

CREATE INDEX IF NOT EXISTS market_orders_sell_match_idx
  ON market_orders (book_id, limit_unit_price ASC, priority_sequence ASC)
  WHERE side = 'sell' AND status IN ('open', 'partially_filled');
CREATE INDEX IF NOT EXISTS market_orders_buy_match_idx
  ON market_orders (book_id, limit_unit_price DESC, priority_sequence ASC)
  WHERE side = 'buy' AND status IN ('open', 'partially_filled');
CREATE INDEX IF NOT EXISTS market_orders_player_open_idx
  ON market_orders (player_id, created_at DESC, order_id)
  WHERE status IN ('open', 'partially_filled');
CREATE INDEX IF NOT EXISTS market_orders_player_history_idx
  ON market_orders (player_id, created_at DESC, order_id);
CREATE INDEX IF NOT EXISTS market_orders_account_open_idx
  ON market_orders (account_id, book_id, created_at DESC)
  WHERE status IN ('open', 'partially_filled');
CREATE INDEX IF NOT EXISTS market_orders_book_open_idx
  ON market_orders (book_id, order_id)
  WHERE status IN ('open', 'partially_filled');
CREATE INDEX IF NOT EXISTS market_orders_reconcile_idx
  ON market_orders (status, book_id, order_id);

CREATE TABLE IF NOT EXISTS market_order_escrows (
  order_id uuid PRIMARY KEY REFERENCES market_orders(order_id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  asset_kind text NOT NULL CHECK (asset_kind IN ('item', 'gold')),
  item_identity text NULL,
  item_id text NULL REFERENCES item_definitions(item_id) ON DELETE RESTRICT,
  variant text NULL,
  initial_amount bigint NOT NULL CHECK (initial_amount > 0),
  remaining_amount bigint NOT NULL CHECK (remaining_amount >= 0 AND remaining_amount <= initial_amount),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (asset_kind = 'item' AND item_identity IS NOT NULL AND item_id IS NOT NULL AND variant IS NOT NULL)
    OR
    (asset_kind = 'gold' AND item_identity IS NULL AND item_id IS NULL AND variant IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS market_order_escrows_reconcile_idx
  ON market_order_escrows (asset_kind, remaining_amount, order_id);

CREATE TABLE IF NOT EXISTS market_trades (
  trade_id uuid PRIMARY KEY,
  venue_id uuid NOT NULL REFERENCES market_venues(venue_id) ON DELETE RESTRICT,
  book_id uuid NOT NULL REFERENCES market_order_books(book_id) ON DELETE RESTRICT,
  item_identity text NOT NULL,
  item_id text NOT NULL REFERENCES item_definitions(item_id) ON DELETE RESTRICT,
  variant text NOT NULL,
  buy_order_id uuid NOT NULL REFERENCES market_orders(order_id) ON DELETE RESTRICT,
  sell_order_id uuid NOT NULL REFERENCES market_orders(order_id) ON DELETE RESTRICT,
  buyer_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  seller_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  maker_order_id uuid NOT NULL REFERENCES market_orders(order_id) ON DELETE RESTRICT,
  quantity bigint NOT NULL CHECK (quantity > 0),
  unit_price bigint NOT NULL CHECK (unit_price > 0),
  gross_value bigint NOT NULL CHECK (gross_value > 0),
  buyer_fee bigint NOT NULL DEFAULT 0 CHECK (buyer_fee >= 0),
  seller_fee bigint NOT NULL DEFAULT 0 CHECK (seller_fee >= 0),
  book_version bigint NOT NULL CHECK (book_version > 0),
  buyer_fee_policy_id smallint NOT NULL,
  buyer_fee_policy_version integer NOT NULL CHECK (buyer_fee_policy_version > 0),
  seller_fee_policy_id smallint NOT NULL,
  seller_fee_policy_version integer NOT NULL CHECK (seller_fee_policy_version > 0),
  rules_version integer NOT NULL CHECK (rules_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (buyer_fee_policy_id, buyer_fee_policy_version)
    REFERENCES market_fee_policies(fee_policy_id, version) ON DELETE RESTRICT,
  FOREIGN KEY (seller_fee_policy_id, seller_fee_policy_version)
    REFERENCES market_fee_policies(fee_policy_id, version) ON DELETE RESTRICT,
  UNIQUE (book_id, book_version),
  UNIQUE (buy_order_id, sell_order_id),
  CHECK (buy_order_id <> sell_order_id),
  CHECK (buyer_player_id <> seller_player_id),
  CHECK (gross_value::numeric = quantity::numeric * unit_price::numeric),
  CHECK (buyer_fee <= gross_value AND seller_fee <= gross_value)
);
CREATE INDEX IF NOT EXISTS market_trades_book_recent_idx
  ON market_trades (book_id, created_at DESC, trade_id);
CREATE INDEX IF NOT EXISTS market_trades_buyer_recent_idx
  ON market_trades (buyer_player_id, created_at DESC, trade_id);
CREATE INDEX IF NOT EXISTS market_trades_seller_recent_idx
  ON market_trades (seller_player_id, created_at DESC, trade_id);
CREATE INDEX IF NOT EXISTS market_trades_orders_idx
  ON market_trades (buy_order_id, sell_order_id);

CREATE TABLE IF NOT EXISTS market_collections (
  collection_id bigserial PRIMARY KEY,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  asset_kind text NOT NULL CHECK (asset_kind IN ('item', 'gold')),
  item_identity text NULL,
  item_id text NULL REFERENCES item_definitions(item_id) ON DELETE RESTRICT,
  variant text NULL,
  original_amount bigint NOT NULL CHECK (original_amount > 0),
  remaining_amount bigint NOT NULL CHECK (remaining_amount >= 0 AND remaining_amount <= original_amount),
  reason text NOT NULL CHECK (reason IN ('purchase', 'sell_proceeds', 'sell_cancel_return', 'buy_cancel_refund', 'price_improvement_refund')),
  source_order_id uuid NULL REFERENCES market_orders(order_id) ON DELETE RESTRICT,
  source_trade_id uuid NULL REFERENCES market_trades(trade_id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz NULL,
  CHECK (
    (asset_kind = 'item' AND item_identity IS NOT NULL AND item_id IS NOT NULL AND variant IS NOT NULL)
    OR
    (asset_kind = 'gold' AND item_identity IS NULL AND item_id IS NULL AND variant IS NULL)
  ),
  CHECK (source_order_id IS NOT NULL),
  CHECK (
    (reason IN ('purchase', 'sell_proceeds', 'price_improvement_refund') AND source_trade_id IS NOT NULL)
    OR
    (reason IN ('sell_cancel_return', 'buy_cancel_refund') AND source_trade_id IS NULL)
  ),
  CHECK ((remaining_amount = 0) = (claimed_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS market_collections_trade_reason_player_idx
  ON market_collections (source_trade_id, reason, player_id)
  WHERE source_trade_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS market_collections_cancel_reason_order_idx
  ON market_collections (source_order_id, reason)
  WHERE reason IN ('sell_cancel_return', 'buy_cancel_refund');
CREATE INDEX IF NOT EXISTS market_collections_player_open_idx
  ON market_collections (player_id, asset_kind, collection_id)
  WHERE remaining_amount > 0;
CREATE INDEX IF NOT EXISTS market_collections_reconcile_idx
  ON market_collections (asset_kind, reason, source_order_id, source_trade_id, remaining_amount);

CREATE TABLE IF NOT EXISTS market_claims (
  claim_id uuid PRIMARY KEY,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  client_request_id text NOT NULL CHECK (length(client_request_id) BETWEEN 8 AND 128),
  asset_scope text NOT NULL CHECK (asset_scope IN ('items', 'gold', 'all')),
  item_units_claimed bigint NOT NULL DEFAULT 0 CHECK (item_units_claimed >= 0),
  gold_claimed bigint NOT NULL DEFAULT 0 CHECK (gold_claimed >= 0),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, client_request_id)
);

CREATE TABLE IF NOT EXISTS market_quotes (
  quote_id uuid PRIMARY KEY,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  venue_id uuid NOT NULL REFERENCES market_venues(venue_id) ON DELETE RESTRICT,
  book_id uuid NOT NULL REFERENCES market_order_books(book_id) ON DELETE RESTRICT,
  item_identity text NOT NULL,
  requested_quantity bigint NOT NULL CHECK (requested_quantity > 0),
  fillable_quantity bigint NOT NULL CHECK (fillable_quantity >= 0),
  quoted_total bigint NOT NULL CHECK (quoted_total >= 0),
  maximum_unit_price bigint NULL CHECK (maximum_unit_price IS NULL OR maximum_unit_price > 0),
  book_version bigint NOT NULL CHECK (book_version >= 0),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (fillable_quantity <= requested_quantity),
  CHECK ((fillable_quantity = 0) = (maximum_unit_price IS NULL))
);
CREATE INDEX IF NOT EXISTS market_quotes_player_expiry_idx
  ON market_quotes (player_id, expires_at DESC);

CREATE TABLE IF NOT EXISTS market_ledger_groups (
  ledger_group_id uuid PRIMARY KEY,
  group_type text NOT NULL CHECK (group_type IN ('order_escrow', 'trade', 'cancel', 'claim', 'fee', 'administrative')),
  request_id text NULL,
  claim_id uuid NULL REFERENCES market_claims(claim_id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  order_id uuid NULL REFERENCES market_orders(order_id) ON DELETE RESTRICT,
  trade_id uuid NULL REFERENCES market_trades(trade_id) ON DELETE RESTRICT,
  rules_version integer NOT NULL CHECK (rules_version > 0),
  fee_policy_version integer NOT NULL CHECK (fee_policy_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT market_ledger_groups_claim_shape_check CHECK (
    (
      group_type = 'claim' AND claim_id IS NOT NULL AND request_id IS NOT NULL
      AND order_id IS NULL AND trade_id IS NULL
    ) OR (
      group_type <> 'claim' AND claim_id IS NULL
    )
  )
);

CREATE TABLE IF NOT EXISTS market_ledger_entries (
  ledger_entry_id bigserial PRIMARY KEY,
  ledger_group_id uuid NOT NULL REFERENCES market_ledger_groups(ledger_group_id) ON DELETE RESTRICT,
  asset_kind text NOT NULL CHECK (asset_kind IN ('item', 'gold')),
  item_identity text NULL,
  amount bigint NOT NULL CHECK (amount <> 0),
  account_location text NOT NULL CHECK (account_location IN (
    'player_inventory', 'sell_escrow', 'buyer_collection', 'return_collection',
    'player_wallet', 'buy_escrow', 'seller_proceeds', 'refund_balance', 'fee_sink'
  )),
  player_id text NULL REFERENCES players(id) ON DELETE RESTRICT,
  order_id uuid NULL REFERENCES market_orders(order_id) ON DELETE RESTRICT,
  trade_id uuid NULL REFERENCES market_trades(trade_id) ON DELETE RESTRICT,
  collection_id bigint NULL REFERENCES market_collections(collection_id) ON DELETE RESTRICT,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((asset_kind = 'item') = (item_identity IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS market_ledger_entries_group_idx
  ON market_ledger_entries (ledger_group_id, asset_kind, item_identity);
CREATE INDEX IF NOT EXISTS market_ledger_entries_player_idx
  ON market_ledger_entries (player_id, created_at DESC)
  WHERE player_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS market_ledger_entries_order_idx
  ON market_ledger_entries (order_id, ledger_entry_id)
  WHERE order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS market_ledger_entries_trade_idx
  ON market_ledger_entries (trade_id, ledger_entry_id)
  WHERE trade_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS market_audit_events (
  audit_event_id bigserial PRIMARY KEY,
  severity text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  event_type text NOT NULL,
  venue_id uuid NULL REFERENCES market_venues(venue_id) ON DELETE RESTRICT,
  book_id uuid NULL REFERENCES market_order_books(book_id) ON DELETE RESTRICT,
  player_id text NULL REFERENCES players(id) ON DELETE RESTRICT,
  order_id uuid NULL REFERENCES market_orders(order_id) ON DELETE RESTRICT,
  trade_id uuid NULL REFERENCES market_trades(trade_id) ON DELETE RESTRICT,
  request_id text NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS market_audit_events_severity_created_idx
  ON market_audit_events (severity, created_at DESC);
CREATE INDEX IF NOT EXISTS market_audit_events_scope_idx
  ON market_audit_events (venue_id, book_id, player_id, created_at DESC);

CREATE TABLE IF NOT EXISTS market_rate_windows (
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  action_bucket text NOT NULL,
  window_started_at timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count > 0),
  PRIMARY KEY (player_id, action_bucket, window_started_at)
);
CREATE INDEX IF NOT EXISTS market_rate_windows_cleanup_idx
  ON market_rate_windows (window_started_at);

ALTER TABLE player_wallets
  ADD CONSTRAINT player_wallets_actor_fk
  FOREIGN KEY (player_id, account_id) REFERENCES players(id, account_id) ON DELETE RESTRICT;
ALTER TABLE wallet_events
  ADD CONSTRAINT wallet_events_actor_fk
  FOREIGN KEY (player_id, account_id) REFERENCES players(id, account_id) ON DELETE RESTRICT;
ALTER TABLE market_player_controls
  ADD CONSTRAINT market_player_controls_actor_fk
  FOREIGN KEY (player_id, account_id) REFERENCES players(id, account_id) ON DELETE RESTRICT;
ALTER TABLE market_requests
  ADD CONSTRAINT market_requests_actor_fk
  FOREIGN KEY (player_id, account_id) REFERENCES players(id, account_id) ON DELETE RESTRICT;
ALTER TABLE market_orders
  ADD CONSTRAINT market_orders_actor_fk
  FOREIGN KEY (player_id, account_id) REFERENCES players(id, account_id) ON DELETE RESTRICT;
ALTER TABLE market_order_escrows
  ADD CONSTRAINT market_order_escrows_owner_fk
  FOREIGN KEY (order_id, player_id) REFERENCES market_orders(order_id, player_id)
  ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE market_claims
  ADD CONSTRAINT market_claims_actor_fk
  FOREIGN KEY (player_id, account_id) REFERENCES players(id, account_id) ON DELETE RESTRICT;
ALTER TABLE market_quotes
  ADD CONSTRAINT market_quotes_actor_fk
  FOREIGN KEY (player_id, account_id) REFERENCES players(id, account_id) ON DELETE RESTRICT;
ALTER TABLE wallet_events
  ADD CONSTRAINT wallet_events_market_order_fk
  FOREIGN KEY (market_order_id) REFERENCES market_orders(order_id)
  ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE wallet_events
  ADD CONSTRAINT wallet_events_market_trade_fk
  FOREIGN KEY (market_trade_id) REFERENCES market_trades(trade_id)
  ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

-- Composite identities make it impossible for an order or trade to point at a
-- real row while lying about the venue, book, item, variant, or owner attached
-- to that row. The service inserts escrow before its order, so the ownership
-- edge remains deferred until the transaction boundary.
ALTER TABLE market_order_books
  ADD CONSTRAINT market_order_books_full_identity_unique
  UNIQUE (book_id, venue_id, item_identity, item_id, variant);
ALTER TABLE market_orders
  ADD CONSTRAINT market_orders_full_identity_unique
  UNIQUE (order_id, venue_id, book_id, item_identity, item_id, variant, player_id);
ALTER TABLE market_orders
  ADD CONSTRAINT market_orders_book_identity_fk
  FOREIGN KEY (book_id, venue_id, item_identity, item_id, variant)
  REFERENCES market_order_books (book_id, venue_id, item_identity, item_id, variant)
  ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE market_trades
  ADD CONSTRAINT market_trades_buy_order_identity_fk
  FOREIGN KEY (
    buy_order_id, venue_id, book_id, item_identity, item_id, variant, buyer_player_id
  ) REFERENCES market_orders (
    order_id, venue_id, book_id, item_identity, item_id, variant, player_id
  ) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE market_trades
  ADD CONSTRAINT market_trades_sell_order_identity_fk
  FOREIGN KEY (
    sell_order_id, venue_id, book_id, item_identity, item_id, variant, seller_player_id
  ) REFERENCES market_orders (
    order_id, venue_id, book_id, item_identity, item_id, variant, player_id
  ) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE market_trades
  ADD CONSTRAINT market_trades_maker_is_party_check
  CHECK (maker_order_id IN (buy_order_id, sell_order_id));

CREATE UNIQUE INDEX IF NOT EXISTS market_ledger_groups_order_escrow_unique_idx
  ON market_ledger_groups (order_id)
  WHERE group_type = 'order_escrow';
CREATE UNIQUE INDEX IF NOT EXISTS market_ledger_groups_trade_unique_idx
  ON market_ledger_groups (trade_id)
  WHERE group_type = 'trade';
CREATE UNIQUE INDEX IF NOT EXISTS market_ledger_groups_cancel_unique_idx
  ON market_ledger_groups (order_id)
  WHERE group_type = 'cancel';
CREATE UNIQUE INDEX IF NOT EXISTS market_ledger_groups_claim_unique_idx
  ON market_ledger_groups (claim_id)
  WHERE group_type = 'claim';
CREATE INDEX IF NOT EXISTS market_ledger_groups_request_idx
  ON market_ledger_groups (request_id)
  WHERE request_id IS NOT NULL;

CREATE OR REPLACE FUNCTION reject_market_immutable_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'committed market financial history is immutable';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enforce_market_fee_policy_immutability()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'market fee policies cannot be deleted';
  END IF;
  IF NEW.fee_policy_id IS DISTINCT FROM OLD.fee_policy_id
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.listing_fee IS DISTINCT FROM OLD.listing_fee
     OR NEW.buyer_fee_bps IS DISTINCT FROM OLD.buyer_fee_bps
     OR NEW.seller_fee_bps IS DISTINCT FROM OLD.seller_fee_bps
     OR NEW.cancellation_fee IS DISTINCT FROM OLD.cancellation_fee
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'market fee policy economic terms are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS market_fee_policies_immutable_terms ON market_fee_policies;
CREATE TRIGGER market_fee_policies_immutable_terms
BEFORE UPDATE OR DELETE ON market_fee_policies
FOR EACH ROW EXECUTE FUNCTION enforce_market_fee_policy_immutability();

DROP TRIGGER IF EXISTS wallet_events_immutable ON wallet_events;
CREATE TRIGGER wallet_events_immutable
BEFORE UPDATE OR DELETE ON wallet_events
FOR EACH ROW EXECUTE FUNCTION reject_market_immutable_mutation();

DROP TRIGGER IF EXISTS inventory_events_immutable ON inventory_events;
CREATE TRIGGER inventory_events_immutable
BEFORE UPDATE OR DELETE ON inventory_events
FOR EACH ROW EXECUTE FUNCTION reject_market_immutable_mutation();

DROP TRIGGER IF EXISTS market_trades_immutable ON market_trades;
CREATE TRIGGER market_trades_immutable
BEFORE UPDATE OR DELETE ON market_trades
FOR EACH ROW EXECUTE FUNCTION reject_market_immutable_mutation();

DROP TRIGGER IF EXISTS market_ledger_groups_immutable ON market_ledger_groups;
CREATE TRIGGER market_ledger_groups_immutable
BEFORE UPDATE OR DELETE ON market_ledger_groups
FOR EACH ROW EXECUTE FUNCTION reject_market_immutable_mutation();

DROP TRIGGER IF EXISTS market_ledger_entries_immutable ON market_ledger_entries;
CREATE TRIGGER market_ledger_entries_immutable
BEFORE UPDATE OR DELETE ON market_ledger_entries
FOR EACH ROW EXECUTE FUNCTION reject_market_immutable_mutation();

DROP TRIGGER IF EXISTS market_claims_immutable ON market_claims;
CREATE TRIGGER market_claims_immutable
BEFORE UPDATE OR DELETE ON market_claims
FOR EACH ROW EXECUTE FUNCTION reject_market_immutable_mutation();

DROP TRIGGER IF EXISTS market_audit_events_immutable ON market_audit_events;
CREATE TRIGGER market_audit_events_immutable
BEFORE UPDATE OR DELETE ON market_audit_events
FOR EACH ROW EXECUTE FUNCTION reject_market_immutable_mutation();

CREATE OR REPLACE FUNCTION enforce_market_request_completion()
RETURNS trigger AS $$
BEGIN
  IF OLD.player_id <> NEW.player_id OR OLD.account_id <> NEW.account_id
     OR OLD.request_id <> NEW.request_id OR OLD.action <> NEW.action
     OR OLD.request_hash <> NEW.request_hash OR OLD.created_at <> NEW.created_at THEN
    RAISE EXCEPTION 'market request identity is immutable';
  END IF;
  IF OLD.result <> '{}'::jsonb THEN
    RAISE EXCEPTION 'completed market request result is immutable';
  END IF;
  IF NEW.result = '{}'::jsonb THEN
    RAISE EXCEPTION 'market request completion requires a result';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS market_requests_completion_guard ON market_requests;
CREATE TRIGGER market_requests_completion_guard
BEFORE UPDATE ON market_requests
FOR EACH ROW EXECUTE FUNCTION enforce_market_request_completion();

DROP TRIGGER IF EXISTS market_requests_delete_guard ON market_requests;
CREATE TRIGGER market_requests_delete_guard
BEFORE DELETE ON market_requests
FOR EACH ROW EXECUTE FUNCTION reject_market_immutable_mutation();

CREATE OR REPLACE FUNCTION enforce_market_request_commit_result()
RETURNS trigger AS $$
DECLARE
  committed_result jsonb;
BEGIN
  SELECT result INTO committed_result
  FROM market_requests
  WHERE account_id = NEW.account_id AND request_id = NEW.request_id;

  IF NOT FOUND
     OR jsonb_typeof(committed_result) <> 'object'
     OR committed_result = '{}'::jsonb THEN
    RAISE EXCEPTION 'market request cannot commit without a nonempty result';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS market_requests_commit_result_guard ON market_requests;
CREATE CONSTRAINT TRIGGER market_requests_commit_result_guard
AFTER INSERT OR UPDATE ON market_requests
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_market_request_commit_result();

CREATE OR REPLACE FUNCTION enforce_market_ledger_group_balance()
RETURNS trigger AS $$
DECLARE
  target_group uuid;
BEGIN
  target_group := coalesce(NEW.ledger_group_id, OLD.ledger_group_id);
  IF NOT EXISTS (
    SELECT 1 FROM market_ledger_entries WHERE ledger_group_id = target_group
  ) THEN
    RAISE EXCEPTION 'market ledger group must contain entries';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM market_ledger_entries
    WHERE ledger_group_id = target_group
    GROUP BY asset_kind, item_identity
    HAVING sum(amount) <> 0
  ) THEN
    RAISE EXCEPTION 'market ledger group is not balanced';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS market_ledger_entries_balance_guard ON market_ledger_entries;
CREATE CONSTRAINT TRIGGER market_ledger_entries_balance_guard
AFTER INSERT ON market_ledger_entries
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_market_ledger_group_balance();

DROP TRIGGER IF EXISTS market_ledger_groups_balance_guard ON market_ledger_groups;
CREATE CONSTRAINT TRIGGER market_ledger_groups_balance_guard
AFTER INSERT ON market_ledger_groups
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_market_ledger_group_balance();

CREATE OR REPLACE FUNCTION enforce_market_order_transition()
RETURNS trigger AS $$
BEGIN
  IF OLD.status IN ('filled', 'cancelled') AND NEW IS DISTINCT FROM OLD THEN
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
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'immutable market order fields cannot change';
  END IF;

  IF NEW.filled_quantity < OLD.filled_quantity OR NEW.remaining_quantity > OLD.remaining_quantity THEN
    RAISE EXCEPTION 'market order fill progress cannot move backward';
  END IF;

  IF OLD.status = 'open' AND NEW.status NOT IN ('open', 'partially_filled', 'filled', 'cancelled') THEN
    RAISE EXCEPTION 'invalid market order transition';
  ELSIF OLD.status = 'partially_filled' AND NEW.status NOT IN ('partially_filled', 'filled', 'cancelled') THEN
    RAISE EXCEPTION 'invalid market order transition';
  ELSIF OLD.status IN ('filled', 'cancelled') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'closed market order cannot transition';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS market_orders_transition_guard ON market_orders;
CREATE TRIGGER market_orders_transition_guard
BEFORE UPDATE ON market_orders
FOR EACH ROW EXECUTE FUNCTION enforce_market_order_transition();

DROP TRIGGER IF EXISTS market_orders_delete_guard ON market_orders;
CREATE TRIGGER market_orders_delete_guard
BEFORE DELETE ON market_orders
FOR EACH ROW EXECUTE FUNCTION reject_market_immutable_mutation();

CREATE OR REPLACE FUNCTION enforce_market_escrow_transition()
RETURNS trigger AS $$
BEGIN
  IF OLD.remaining_amount = 0 AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'closed market escrow is immutable';
  END IF;
  IF NEW.order_id <> OLD.order_id
     OR NEW.player_id <> OLD.player_id
     OR NEW.asset_kind <> OLD.asset_kind
     OR NEW.item_identity IS DISTINCT FROM OLD.item_identity
     OR NEW.item_id IS DISTINCT FROM OLD.item_id
     OR NEW.variant IS DISTINCT FROM OLD.variant
     OR NEW.initial_amount <> OLD.initial_amount
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'immutable market escrow fields cannot change';
  END IF;
  IF NEW.remaining_amount > OLD.remaining_amount THEN
    RAISE EXCEPTION 'market escrow remaining amount cannot increase';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS market_order_escrows_transition_guard ON market_order_escrows;
CREATE TRIGGER market_order_escrows_transition_guard
BEFORE UPDATE ON market_order_escrows
FOR EACH ROW EXECUTE FUNCTION enforce_market_escrow_transition();

DROP TRIGGER IF EXISTS market_order_escrows_delete_guard ON market_order_escrows;
CREATE TRIGGER market_order_escrows_delete_guard
BEFORE DELETE ON market_order_escrows
FOR EACH ROW EXECUTE FUNCTION reject_market_immutable_mutation();

CREATE OR REPLACE FUNCTION enforce_market_collection_transition()
RETURNS trigger AS $$
BEGIN
  IF OLD.remaining_amount = 0 AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'closed market collection is immutable';
  END IF;
  IF NEW.collection_id <> OLD.collection_id
     OR NEW.player_id <> OLD.player_id
     OR NEW.asset_kind <> OLD.asset_kind
     OR NEW.item_identity IS DISTINCT FROM OLD.item_identity
     OR NEW.item_id IS DISTINCT FROM OLD.item_id
     OR NEW.variant IS DISTINCT FROM OLD.variant
     OR NEW.original_amount <> OLD.original_amount
     OR NEW.reason <> OLD.reason
     OR NEW.source_order_id IS DISTINCT FROM OLD.source_order_id
     OR NEW.source_trade_id IS DISTINCT FROM OLD.source_trade_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'immutable market collection provenance cannot change';
  END IF;
  IF NEW.remaining_amount > OLD.remaining_amount THEN
    RAISE EXCEPTION 'market collection remaining amount cannot increase';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS market_collections_transition_guard ON market_collections;
CREATE TRIGGER market_collections_transition_guard
BEFORE UPDATE ON market_collections
FOR EACH ROW EXECUTE FUNCTION enforce_market_collection_transition();

DROP TRIGGER IF EXISTS market_collections_delete_guard ON market_collections;
CREATE TRIGGER market_collections_delete_guard
BEFORE DELETE ON market_collections
FOR EACH ROW EXECUTE FUNCTION reject_market_immutable_mutation();

DROP TRIGGER IF EXISTS market_order_books_set_updated_at ON market_order_books;
CREATE TRIGGER market_order_books_set_updated_at
BEFORE UPDATE ON market_order_books
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS market_order_escrows_set_updated_at ON market_order_escrows;
CREATE TRIGGER market_order_escrows_set_updated_at
BEFORE UPDATE ON market_order_escrows
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS market_collections_set_updated_at ON market_collections;
CREATE TRIGGER market_collections_set_updated_at
BEFORE UPDATE ON market_collections
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Cross-table economic relationships are checked at COMMIT. This preserves the
-- service's intentional insert order (escrow before order; settlement rows before
-- journal rows) without allowing any incomplete composition to become durable.
CREATE OR REPLACE FUNCTION validate_market_order_commit(target_order_id uuid)
RETURNS void AS $$
DECLARE
  target_order market_orders%ROWTYPE;
  target_escrow market_order_escrows%ROWTYPE;
  target_fee market_fee_policies%ROWTYPE;
  cancel_collection market_collections%ROWTYPE;
  escrow_group_id uuid;
  cancel_group_id uuid;
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
  SELECT * INTO target_fee
  FROM market_fee_policies
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
      expected_amount := target_order.limit_unit_price::numeric * target_order.original_quantity::numeric;
      expected_amount := expected_amount + floor(expected_amount * target_fee.buyer_fee_bps::numeric / 10000);
      IF target_escrow.initial_amount::numeric <> expected_amount THEN
        RAISE EXCEPTION 'buy escrow initial amount does not match its order limit';
      END IF;
    END IF;
  END IF;

  IF target_order.order_policy = 'aon_ioc' AND target_order.status <> 'filled' THEN
    RAISE EXCEPTION 'atomic immediate order cannot commit without a complete fill';
  END IF;
  IF target_order.status IN ('filled', 'cancelled') THEN
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
    expected_amount := target_order.limit_unit_price::numeric * target_order.remaining_quantity::numeric;
    expected_amount := expected_amount + floor(expected_amount * target_fee.buyer_fee_bps::numeric / 10000);
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

  SELECT count(*) INTO related_count
  FROM market_ledger_groups
  WHERE group_type = 'order_escrow' AND order_id = target_order_id;
  IF related_count <> 1 THEN
    RAISE EXCEPTION 'market order must have exactly one escrow ledger group';
  END IF;
  SELECT ledger_group_id INTO escrow_group_id
  FROM market_ledger_groups
  WHERE group_type = 'order_escrow' AND order_id = target_order_id;

  debit_location := CASE WHEN target_order.side = 'sell' THEN 'player_inventory' ELSE 'player_wallet' END;
  credit_location := CASE WHEN target_order.side = 'sell' THEN 'sell_escrow' ELSE 'buy_escrow' END;
  SELECT count(*) INTO related_count
  FROM market_ledger_entries
  WHERE ledger_group_id = escrow_group_id;
  IF related_count <> 2
     OR NOT EXISTS (
       SELECT 1 FROM market_ledger_entries
       WHERE ledger_group_id = escrow_group_id
         AND asset_kind = target_escrow.asset_kind
         AND item_identity IS NOT DISTINCT FROM target_escrow.item_identity
         AND amount = -target_escrow.initial_amount
         AND account_location = debit_location
         AND player_id = target_order.player_id
         AND order_id = target_order_id
         AND trade_id IS NULL AND collection_id IS NULL
     )
     OR NOT EXISTS (
       SELECT 1 FROM market_ledger_entries
       WHERE ledger_group_id = escrow_group_id
         AND asset_kind = target_escrow.asset_kind
         AND item_identity IS NOT DISTINCT FROM target_escrow.item_identity
         AND amount = target_escrow.initial_amount
         AND account_location = credit_location
         AND player_id = target_order.player_id
         AND order_id = target_order_id
         AND trade_id IS NULL AND collection_id IS NULL
     ) THEN
    RAISE EXCEPTION 'market escrow ledger does not match its order';
  END IF;

  SELECT count(*) INTO related_count
  FROM market_ledger_groups
  WHERE group_type = 'cancel' AND order_id = target_order_id;
  IF target_order.status = 'cancelled' THEN
    IF related_count <> 1 THEN
      RAISE EXCEPTION 'cancelled market order must have exactly one cancel ledger group';
    END IF;
    SELECT ledger_group_id INTO cancel_group_id
    FROM market_ledger_groups
    WHERE group_type = 'cancel' AND order_id = target_order_id;
    SELECT count(*) INTO related_count
    FROM market_collections
    WHERE source_order_id = target_order_id
      AND reason IN ('sell_cancel_return', 'buy_cancel_refund');
    IF related_count <> 1 THEN
      RAISE EXCEPTION 'cancelled market order must have exactly one return collection';
    END IF;
    SELECT * INTO cancel_collection
    FROM market_collections
    WHERE source_order_id = target_order_id
      AND reason IN ('sell_cancel_return', 'buy_cancel_refund');
    debit_location := CASE WHEN target_order.side = 'sell' THEN 'sell_escrow' ELSE 'buy_escrow' END;
    credit_location := CASE WHEN target_order.side = 'sell' THEN 'return_collection' ELSE 'refund_balance' END;
    SELECT count(*) INTO related_count
    FROM market_ledger_entries
    WHERE ledger_group_id = cancel_group_id;
    IF related_count <> 2
       OR NOT EXISTS (
         SELECT 1 FROM market_ledger_entries
         WHERE ledger_group_id = cancel_group_id
           AND asset_kind = target_escrow.asset_kind
           AND item_identity IS NOT DISTINCT FROM target_escrow.item_identity
           AND amount = -cancel_collection.original_amount
           AND account_location = debit_location
           AND player_id = target_order.player_id AND order_id = target_order_id
           AND trade_id IS NULL AND collection_id IS NULL
       )
       OR NOT EXISTS (
         SELECT 1 FROM market_ledger_entries
         WHERE ledger_group_id = cancel_group_id
           AND asset_kind = cancel_collection.asset_kind
           AND item_identity IS NOT DISTINCT FROM cancel_collection.item_identity
           AND amount = cancel_collection.original_amount
           AND account_location = credit_location
           AND player_id = target_order.player_id AND order_id = target_order_id
           AND trade_id IS NULL AND collection_id = cancel_collection.collection_id
       ) THEN
      RAISE EXCEPTION 'market cancel ledger does not match its order and collection';
    END IF;
  ELSE
    IF related_count <> 0 OR EXISTS (
      SELECT 1 FROM market_collections
      WHERE source_order_id = target_order_id
        AND reason IN ('sell_cancel_return', 'buy_cancel_refund')
    ) THEN
      RAISE EXCEPTION 'non-cancelled market order cannot have cancellation settlement';
    END IF;
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION validate_market_trade_commit(target_trade_id uuid)
RETURNS void AS $$
DECLARE
  target_trade market_trades%ROWTYPE;
  buy_order market_orders%ROWTYPE;
  sell_order market_orders%ROWTYPE;
  maker_order market_orders%ROWTYPE;
  buyer_fee_policy market_fee_policies%ROWTYPE;
  seller_fee_policy market_fee_policies%ROWTYPE;
  purchase_collection market_collections%ROWTYPE;
  proceeds_collection market_collections%ROWTYPE;
  refund_collection market_collections%ROWTYPE;
  trade_group_id uuid;
  related_count bigint;
  expected_entries integer;
  seller_proceeds bigint;
  refund_amount bigint := 0;
  fee_total bigint;
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
  IF target_trade.buyer_fee_policy_id <> buy_order.fee_policy_id
     OR target_trade.buyer_fee_policy_version <> buy_order.fee_policy_version
     OR target_trade.seller_fee_policy_id <> sell_order.fee_policy_id
     OR target_trade.seller_fee_policy_version <> sell_order.fee_policy_version THEN
    RAISE EXCEPTION 'market trade fee snapshots do not match their orders';
  END IF;
  SELECT * INTO buyer_fee_policy
  FROM market_fee_policies
  WHERE fee_policy_id = target_trade.buyer_fee_policy_id
    AND version = target_trade.buyer_fee_policy_version;
  SELECT * INTO seller_fee_policy
  FROM market_fee_policies
  WHERE fee_policy_id = target_trade.seller_fee_policy_id
    AND version = target_trade.seller_fee_policy_version;
  IF buyer_fee_policy.fee_policy_id IS NULL OR seller_fee_policy.fee_policy_id IS NULL
     OR target_trade.buyer_fee::numeric
        <> floor(target_trade.gross_value::numeric * buyer_fee_policy.buyer_fee_bps::numeric / 10000)
     OR target_trade.seller_fee::numeric
        <> floor(target_trade.gross_value::numeric * seller_fee_policy.seller_fee_bps::numeric / 10000) THEN
    RAISE EXCEPTION 'market trade fees do not match immutable fee snapshots';
  END IF;
  IF target_trade.maker_order_id NOT IN (target_trade.buy_order_id, target_trade.sell_order_id)
     OR maker_order.limit_unit_price <> target_trade.unit_price THEN
    RAISE EXCEPTION 'market trade maker relationship or maker price is inconsistent';
  END IF;
  IF target_trade.quantity > buy_order.original_quantity
     OR target_trade.quantity > sell_order.original_quantity THEN
    RAISE EXCEPTION 'market trade quantity exceeds a related order';
  END IF;

  SELECT count(*) INTO related_count
  FROM market_ledger_groups
  WHERE group_type = 'trade' AND trade_id = target_trade_id;
  IF related_count <> 1 THEN
    RAISE EXCEPTION 'market trade must have exactly one settlement ledger group';
  END IF;
  SELECT ledger_group_id INTO trade_group_id
  FROM market_ledger_groups
  WHERE group_type = 'trade' AND trade_id = target_trade_id;

  SELECT count(*) INTO related_count
  FROM market_collections
  WHERE source_trade_id = target_trade_id AND reason = 'purchase';
  IF related_count <> 1 THEN
    RAISE EXCEPTION 'market trade must have exactly one buyer item collection';
  END IF;
  SELECT * INTO purchase_collection
  FROM market_collections
  WHERE source_trade_id = target_trade_id AND reason = 'purchase';
  IF purchase_collection.player_id <> target_trade.buyer_player_id
     OR purchase_collection.source_order_id <> target_trade.buy_order_id
     OR purchase_collection.asset_kind <> 'item'
     OR purchase_collection.item_identity <> target_trade.item_identity
     OR purchase_collection.item_id <> target_trade.item_id
     OR purchase_collection.variant <> target_trade.variant
     OR purchase_collection.original_amount <> target_trade.quantity THEN
    RAISE EXCEPTION 'market trade buyer collection provenance is inconsistent';
  END IF;

  seller_proceeds := target_trade.gross_value - target_trade.seller_fee;
  SELECT count(*) INTO related_count
  FROM market_collections
  WHERE source_trade_id = target_trade_id AND reason = 'sell_proceeds';
  IF (seller_proceeds > 0 AND related_count <> 1)
     OR (seller_proceeds = 0 AND related_count <> 0) THEN
    RAISE EXCEPTION 'market trade seller collection count is inconsistent';
  END IF;
  IF seller_proceeds > 0 THEN
    SELECT * INTO proceeds_collection
    FROM market_collections
    WHERE source_trade_id = target_trade_id AND reason = 'sell_proceeds';
    IF proceeds_collection.player_id <> target_trade.seller_player_id
       OR proceeds_collection.source_order_id <> target_trade.sell_order_id
       OR proceeds_collection.asset_kind <> 'gold'
       OR proceeds_collection.original_amount <> seller_proceeds THEN
      RAISE EXCEPTION 'market trade seller collection provenance is inconsistent';
    END IF;
  END IF;

  SELECT count(*) INTO related_count
  FROM market_collections
  WHERE source_trade_id = target_trade_id AND reason = 'price_improvement_refund';
  IF related_count > 1 THEN
    RAISE EXCEPTION 'market trade has duplicate price-improvement collections';
  END IF;
  IF related_count = 1 THEN
    SELECT * INTO refund_collection
    FROM market_collections
    WHERE source_trade_id = target_trade_id AND reason = 'price_improvement_refund';
    IF refund_collection.player_id <> target_trade.buyer_player_id
       OR refund_collection.source_order_id <> target_trade.buy_order_id
       OR refund_collection.asset_kind <> 'gold' THEN
      RAISE EXCEPTION 'market trade refund collection provenance is inconsistent';
    END IF;
    refund_amount := refund_collection.original_amount;
  END IF;

  SELECT count(*) INTO related_count
  FROM market_collections
  WHERE source_trade_id = target_trade_id;
  expected_entries := 1 + CASE WHEN seller_proceeds > 0 THEN 1 ELSE 0 END
    + CASE WHEN refund_amount > 0 THEN 1 ELSE 0 END;
  IF related_count <> expected_entries THEN
    RAISE EXCEPTION 'market trade has an unexpected settlement collection';
  END IF;

  fee_total := target_trade.buyer_fee + target_trade.seller_fee;
  expected_entries := 3
    + CASE WHEN seller_proceeds > 0 THEN 1 ELSE 0 END
    + CASE WHEN refund_amount > 0 THEN 1 ELSE 0 END
    + CASE WHEN fee_total > 0 THEN 1 ELSE 0 END;
  SELECT count(*) INTO related_count
  FROM market_ledger_entries
  WHERE ledger_group_id = trade_group_id;
  IF related_count <> expected_entries
     OR NOT EXISTS (
       SELECT 1 FROM market_ledger_entries
       WHERE ledger_group_id = trade_group_id
         AND asset_kind = 'item' AND item_identity = target_trade.item_identity
         AND amount = -target_trade.quantity AND account_location = 'sell_escrow'
         AND player_id = target_trade.seller_player_id
         AND order_id = target_trade.sell_order_id AND trade_id = target_trade_id
         AND collection_id IS NULL
     )
     OR NOT EXISTS (
       SELECT 1 FROM market_ledger_entries
       WHERE ledger_group_id = trade_group_id
         AND asset_kind = 'item' AND item_identity = target_trade.item_identity
         AND amount = target_trade.quantity AND account_location = 'buyer_collection'
         AND player_id = target_trade.buyer_player_id
         AND order_id = target_trade.buy_order_id AND trade_id = target_trade_id
         AND collection_id = purchase_collection.collection_id
     )
     OR NOT EXISTS (
       SELECT 1 FROM market_ledger_entries
       WHERE ledger_group_id = trade_group_id
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
    SELECT 1 FROM market_ledger_entries
    WHERE ledger_group_id = trade_group_id
      AND asset_kind = 'gold' AND item_identity IS NULL
      AND amount = seller_proceeds AND account_location = 'seller_proceeds'
      AND player_id = target_trade.seller_player_id
      AND order_id = target_trade.sell_order_id AND trade_id = target_trade_id
      AND collection_id = proceeds_collection.collection_id
  ) THEN
    RAISE EXCEPTION 'market trade seller ledger settlement is inconsistent';
  END IF;
  IF refund_amount > 0 AND NOT EXISTS (
    SELECT 1 FROM market_ledger_entries
    WHERE ledger_group_id = trade_group_id
      AND asset_kind = 'gold' AND item_identity IS NULL
      AND amount = refund_amount AND account_location = 'refund_balance'
      AND player_id = target_trade.buyer_player_id
      AND order_id = target_trade.buy_order_id AND trade_id = target_trade_id
      AND collection_id = refund_collection.collection_id
  ) THEN
    RAISE EXCEPTION 'market trade refund ledger settlement is inconsistent';
  END IF;
  IF fee_total > 0 AND NOT EXISTS (
    SELECT 1 FROM market_ledger_entries
    WHERE ledger_group_id = trade_group_id
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

CREATE OR REPLACE FUNCTION validate_market_collection_commit(target_collection_id bigint)
RETURNS void AS $$
DECLARE
  target_collection market_collections%ROWTYPE;
  source_order market_orders%ROWTYPE;
  source_trade market_trades%ROWTYPE;
  source_fee market_fee_policies%ROWTYPE;
  related_count bigint;
  expected_cancel_amount numeric;
  settlement_group_type text;
  settlement_trade_id uuid;
  settlement_location text;
  claim_source_location text;
BEGIN
  SELECT * INTO target_collection
  FROM market_collections
  WHERE collection_id = target_collection_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'market settlement references a missing collection';
  END IF;
  SELECT * INTO source_order
  FROM market_orders
  WHERE order_id = target_collection.source_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'market collection source order does not exist';
  END IF;

  IF target_collection.reason = 'purchase' THEN
    SELECT * INTO source_trade
    FROM market_trades
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
    SELECT * INTO source_trade
    FROM market_trades
    WHERE trade_id = target_collection.source_trade_id;
    IF NOT FOUND
       OR target_collection.source_order_id <> source_trade.sell_order_id
       OR target_collection.player_id <> source_trade.seller_player_id
       OR target_collection.asset_kind <> 'gold'
       OR target_collection.original_amount <> source_trade.gross_value - source_trade.seller_fee THEN
      RAISE EXCEPTION 'seller proceeds collection provenance is inconsistent';
    END IF;
    settlement_group_type := 'trade';
    settlement_trade_id := source_trade.trade_id;
    settlement_location := 'seller_proceeds';
  ELSIF target_collection.reason = 'price_improvement_refund' THEN
    SELECT * INTO source_trade
    FROM market_trades
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
    IF source_order.status <> 'cancelled'
       OR target_collection.player_id <> source_order.player_id
       OR (source_order.side = 'sell' AND (
         target_collection.reason <> 'sell_cancel_return'
         OR target_collection.asset_kind <> 'item'
         OR target_collection.item_identity <> source_order.item_identity
         OR target_collection.item_id <> source_order.item_id
         OR target_collection.variant <> source_order.variant
         OR target_collection.original_amount <> source_order.remaining_quantity
       ))
       OR (source_order.side = 'buy' AND (
         target_collection.reason <> 'buy_cancel_refund'
         OR target_collection.asset_kind <> 'gold'
       )) THEN
      RAISE EXCEPTION 'cancellation collection provenance is inconsistent';
    END IF;
    IF source_order.side = 'buy' THEN
      SELECT * INTO source_fee
      FROM market_fee_policies
      WHERE fee_policy_id = source_order.fee_policy_id
        AND version = source_order.fee_policy_version;
      expected_cancel_amount := source_order.limit_unit_price::numeric
        * source_order.remaining_quantity::numeric;
      expected_cancel_amount := expected_cancel_amount
        + floor(expected_cancel_amount * source_fee.buyer_fee_bps::numeric / 10000);
      IF source_fee.fee_policy_id IS NULL
         OR target_collection.original_amount::numeric <> expected_cancel_amount THEN
        RAISE EXCEPTION 'buy cancellation refund does not match remaining escrow';
      END IF;
    END IF;
    settlement_group_type := 'cancel';
    settlement_trade_id := NULL;
    settlement_location := CASE
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
      WHEN settlement_group_type = 'cancel' THEN target_collection.source_order_id
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
    WHEN target_collection.asset_kind = 'item' AND target_collection.reason = 'sell_cancel_return'
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

  SELECT count(*) INTO related_count
  FROM market_ledger_entries
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
            AND entry.account_location NOT IN ('seller_proceeds', 'refund_balance'))
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

CREATE OR REPLACE FUNCTION enforce_market_claim_commit()
RETURNS trigger AS $$
BEGIN
  PERFORM validate_market_claim_commit(NEW.claim_id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS market_claims_commit_guard ON market_claims;
CREATE CONSTRAINT TRIGGER market_claims_commit_guard
AFTER INSERT ON market_claims
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_market_claim_commit();

CREATE OR REPLACE FUNCTION enforce_market_order_commit()
RETURNS trigger AS $$
BEGIN
  PERFORM validate_market_order_commit(NEW.order_id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS market_orders_commit_guard ON market_orders;
CREATE CONSTRAINT TRIGGER market_orders_commit_guard
AFTER INSERT OR UPDATE ON market_orders
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_market_order_commit();

DROP TRIGGER IF EXISTS market_order_escrows_commit_guard ON market_order_escrows;
CREATE CONSTRAINT TRIGGER market_order_escrows_commit_guard
AFTER INSERT OR UPDATE ON market_order_escrows
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_market_order_commit();

CREATE OR REPLACE FUNCTION enforce_market_trade_commit()
RETURNS trigger AS $$
BEGIN
  PERFORM validate_market_trade_commit(NEW.trade_id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS market_trades_commit_guard ON market_trades;
CREATE CONSTRAINT TRIGGER market_trades_commit_guard
AFTER INSERT ON market_trades
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_market_trade_commit();

CREATE OR REPLACE FUNCTION enforce_market_collection_commit()
RETURNS trigger AS $$
BEGIN
  PERFORM validate_market_collection_commit(NEW.collection_id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS market_collections_commit_guard ON market_collections;
CREATE CONSTRAINT TRIGGER market_collections_commit_guard
AFTER INSERT OR UPDATE ON market_collections
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_market_collection_commit();

CREATE OR REPLACE FUNCTION validate_market_ledger_group_collections(target_ledger_group_id uuid)
RETURNS void AS $$
DECLARE
  target_collection_id bigint;
BEGIN
  FOR target_collection_id IN
    SELECT DISTINCT collection_id
    FROM market_ledger_entries
    WHERE ledger_group_id = target_ledger_group_id
      AND collection_id IS NOT NULL
  LOOP
    PERFORM validate_market_collection_commit(target_collection_id);
  END LOOP;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enforce_market_ledger_group_relationship()
RETURNS trigger AS $$
BEGIN
  IF NEW.group_type IN ('order_escrow', 'cancel') THEN
    IF NEW.order_id IS NULL OR NEW.trade_id IS NOT NULL THEN
      RAISE EXCEPTION 'order settlement ledger group has invalid source shape';
    END IF;
    PERFORM validate_market_order_commit(NEW.order_id);
  ELSIF NEW.group_type = 'trade' THEN
    IF NEW.trade_id IS NULL OR NEW.order_id IS NOT NULL THEN
      RAISE EXCEPTION 'trade settlement ledger group has invalid source shape';
    END IF;
    PERFORM validate_market_trade_commit(NEW.trade_id);
  ELSIF NEW.group_type = 'claim' THEN
    IF NEW.claim_id IS NULL OR NEW.request_id IS NULL
       OR NEW.order_id IS NOT NULL OR NEW.trade_id IS NOT NULL THEN
      RAISE EXCEPTION 'claim ledger group has invalid source shape';
    END IF;
    PERFORM validate_market_claim_commit(NEW.claim_id);
  END IF;
  PERFORM validate_market_ledger_group_collections(NEW.ledger_group_id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS market_ledger_groups_relationship_guard ON market_ledger_groups;
CREATE CONSTRAINT TRIGGER market_ledger_groups_relationship_guard
AFTER INSERT ON market_ledger_groups
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_market_ledger_group_relationship();

CREATE OR REPLACE FUNCTION enforce_market_ledger_entry_relationship()
RETURNS trigger AS $$
BEGIN
  IF NEW.collection_id IS NOT NULL THEN
    PERFORM validate_market_collection_commit(NEW.collection_id);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS market_ledger_entries_relationship_guard ON market_ledger_entries;
CREATE CONSTRAINT TRIGGER market_ledger_entries_relationship_guard
AFTER INSERT ON market_ledger_entries
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_market_ledger_entry_relationship();

CREATE OR REPLACE FUNCTION enforce_market_ledger_group_append_window()
RETURNS trigger AS $$
DECLARE
  group_xmin xid;
BEGIN
  SELECT xmin INTO group_xmin
  FROM market_ledger_groups
  WHERE ledger_group_id = NEW.ledger_group_id;
  IF group_xmin IS NULL OR group_xmin <> pg_current_xact_id()::xid THEN
    RAISE EXCEPTION 'committed market ledger group cannot accept new entries';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS market_ledger_entries_append_guard ON market_ledger_entries;
CREATE TRIGGER market_ledger_entries_append_guard
BEFORE INSERT ON market_ledger_entries
FOR EACH ROW EXECUTE FUNCTION enforce_market_ledger_group_append_window();
