-- Glimmer exchange and Lumen as a carried item.
--
-- Lumen (owner decision 2026-10-02) is a normal stackable inventory item: it is
-- carried, dropped and picked up through the dropped-item system, stored like
-- any item, and traded on the market as an ordinary Gold-priced item with the
-- venue's normal item custody, escrow and Collections. Existing premium-wallet
-- Lumen balances move into inventory below (audited, one event pair per
-- account), after which the Lumen wallet accepts no further events. Lumen may
-- only enter inventory from the audited admin grant, this migration, or a
-- custody move (market, ground pickup, manor storage); a Lumen ground drop must
-- be backed by the player's own inventory debit.
--
-- Glimmer is one fungible asset with its own Gold-priced order book on the
-- existing exchange: same locked book, maker pricing, escrow, journal,
-- reconciliation and circuit breakers. Custody is the premium wallet, never
-- inventory:
--   * sell escrow is a premium-wallet debit (`market-sell-escrow:` key);
--   * a fill credits the buyer's premium wallet (`market-trade-premium:`);
--   * cancellation and expiration return unused escrow to the seller's
--     premium wallet (`market-cancel-premium:`), with no Collection row.
-- The seller pays the currency fee (bps snapshotted per order, 5% today) to the
-- fee sink. It is reserved in escrow when the order is created and charged per
-- fill as ceil(cumulative filled * bps / 10000) minus what was already charged,
-- so a fully filled order pays exactly ceil(quantity * bps / 10000).
--
-- The new premium-wallet reasons are `market`, where every event must match
-- exactly one filled, cancelled or expired premium order, and
-- `inventory_migration`, the one-time Lumen debit below. There is no new free
-- source of either currency.

-- ---------------------------------------------------------------------------
-- Item definitions. Glimmer's row only anchors its order book's foreign keys;
-- it is not a compiled inventory item and every inventory table rejects it.
-- Lumen is a compiled, droppable inventory item: weightless like a currency
-- (0 g, so carrying it can never hit carry capacity), stacks of 1,000,000.
-- ---------------------------------------------------------------------------

ALTER TABLE item_definitions
  DROP CONSTRAINT IF EXISTS item_definitions_unit_weight_grams_check;
ALTER TABLE item_definitions
  ADD CONSTRAINT item_definitions_unit_weight_grams_check
  CHECK (unit_weight_grams > 0 OR (unit_weight_grams = 0 AND category = 'currency'));

INSERT INTO item_definitions (
  item_id, display_name, category, stackable, max_stack, droppable,
  manor_storable, market_tradable, market_fungible, market_identity,
  supported_variants, unit_weight_grams, rarity
) VALUES
  ('glimmer', 'Glimmer', 'currency', true, 2147483647, false, false, true, true,
   'currency:glimmer', ARRAY['default']::text[], 1, 'common'),
  ('lumen', 'Lumen', 'currency', true, 1000000, true, true, true, true,
   'lumen', ARRAY['default']::text[], 0, 'common')
ON CONFLICT (item_id) DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM item_definitions
    WHERE item_id = 'glimmer' AND display_name = 'Glimmer'
      AND market_identity = 'currency:glimmer'
      AND category = 'currency' AND market_tradable AND market_fungible
      AND NOT droppable AND NOT manor_storable
      AND supported_variants = ARRAY['default']::text[]
  ) OR NOT EXISTS (
    SELECT 1 FROM item_definitions
    WHERE item_id = 'lumen' AND display_name = 'Lumen' AND market_identity = 'lumen'
      AND category = 'currency' AND stackable AND max_stack = 1000000
      AND droppable AND manor_storable AND market_tradable AND market_fungible
      AND unit_weight_grams = 0 AND rarity = 'common'
      AND supported_variants = ARRAY['default']::text[]
  ) THEN
    RAISE EXCEPTION 'premium currency item definitions conflict with existing rows';
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS market_premium_assets (
  item_id text PRIMARY KEY REFERENCES item_definitions(item_id) ON DELETE RESTRICT,
  currency text NOT NULL UNIQUE REFERENCES premium_currencies(currency) ON DELETE RESTRICT,
  market_identity text NOT NULL UNIQUE,
  seller_fee_bps integer NOT NULL CHECK (seller_fee_bps BETWEEN 0 AND 10000),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (item_id = currency AND market_identity = 'currency:' || currency)
);

INSERT INTO market_premium_assets (item_id, currency, market_identity, seller_fee_bps)
VALUES ('glimmer', 'glimmer', 'currency:glimmer', 500)
ON CONFLICT (item_id) DO NOTHING;

DROP TRIGGER IF EXISTS market_premium_assets_immutable ON market_premium_assets;
CREATE TRIGGER market_premium_assets_immutable
BEFORE UPDATE OR DELETE ON market_premium_assets
FOR EACH ROW EXECUTE FUNCTION reject_market_immutable_mutation();

CREATE OR REPLACE FUNCTION market_premium_currency_fee(filled_quantity numeric, fee_bps integer)
RETURNS numeric
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT ceil(filled_quantity * fee_bps::numeric / 10000)
$$;

-- Per-order snapshot of the currency fee terms for premium sell orders.
CREATE TABLE IF NOT EXISTS market_premium_sell_terms (
  order_id uuid PRIMARY KEY REFERENCES market_orders(order_id) ON DELETE RESTRICT,
  item_id text NOT NULL REFERENCES market_premium_assets(item_id) ON DELETE RESTRICT,
  seller_fee_bps integer NOT NULL CHECK (seller_fee_bps BETWEEN 0 AND 10000),
  fee_reserve bigint NOT NULL CHECK (fee_reserve >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS market_premium_sell_terms_immutable ON market_premium_sell_terms;
CREATE TRIGGER market_premium_sell_terms_immutable
BEFORE UPDATE OR DELETE ON market_premium_sell_terms
FOR EACH ROW EXECUTE FUNCTION reject_market_immutable_mutation();

CREATE OR REPLACE FUNCTION enforce_market_premium_sell_terms_insert()
RETURNS trigger AS $$
DECLARE
  target_order market_orders%ROWTYPE;
  premium_asset market_premium_assets%ROWTYPE;
BEGIN
  SELECT * INTO target_order FROM market_orders WHERE order_id = NEW.order_id;
  SELECT * INTO premium_asset FROM market_premium_assets WHERE item_id = NEW.item_id;
  IF target_order.order_id IS NULL OR premium_asset.item_id IS NULL
     OR target_order.side <> 'sell'
     OR target_order.item_id <> NEW.item_id
     OR NEW.seller_fee_bps <> premium_asset.seller_fee_bps
     OR NEW.fee_reserve::numeric <> market_premium_currency_fee(
       target_order.original_quantity::numeric, NEW.seller_fee_bps
     ) THEN
    RAISE EXCEPTION 'premium sell terms do not match their order and currency';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS market_premium_sell_terms_insert_guard ON market_premium_sell_terms;
CREATE TRIGGER market_premium_sell_terms_insert_guard
BEFORE INSERT ON market_premium_sell_terms
FOR EACH ROW EXECUTE FUNCTION enforce_market_premium_sell_terms_insert();

-- ---------------------------------------------------------------------------
-- Custody boundaries: Glimmer never enters inventory or Collections, and only
-- premium identities may use the premium-wallet journal location.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION reject_premium_currency_inventory()
RETURNS trigger AS $$
DECLARE
  target_item_id text := CASE
    WHEN TG_TABLE_NAME = 'player_inventory' THEN to_jsonb(NEW)->>'resource_type'
    ELSE to_jsonb(NEW)->>'item_id'
  END;
BEGIN
  IF target_item_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM market_premium_assets WHERE item_id = target_item_id) THEN
    RAISE EXCEPTION 'premium currency cannot be held in %', TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS player_inventory_premium_currency_guard ON player_inventory;
CREATE TRIGGER player_inventory_premium_currency_guard
BEFORE INSERT OR UPDATE ON player_inventory
FOR EACH ROW EXECUTE FUNCTION reject_premium_currency_inventory();
DROP TRIGGER IF EXISTS inventory_events_premium_currency_guard ON inventory_events;
CREATE TRIGGER inventory_events_premium_currency_guard
BEFORE INSERT ON inventory_events
FOR EACH ROW EXECUTE FUNCTION reject_premium_currency_inventory();
DROP TRIGGER IF EXISTS market_collections_premium_currency_guard ON market_collections;
CREATE TRIGGER market_collections_premium_currency_guard
BEFORE INSERT ON market_collections
FOR EACH ROW EXECUTE FUNCTION reject_premium_currency_inventory();

ALTER TABLE market_ledger_entries
  DROP CONSTRAINT IF EXISTS market_ledger_entries_account_location_check;
ALTER TABLE market_ledger_entries
  ADD CONSTRAINT market_ledger_entries_account_location_check
  CHECK (account_location IN (
    'player_inventory', 'sell_escrow', 'buyer_collection', 'return_collection',
    'player_wallet', 'buy_escrow', 'seller_proceeds', 'refund_balance', 'fee_sink',
    'premium_wallet'
  ));
ALTER TABLE market_ledger_entries
  DROP CONSTRAINT IF EXISTS market_ledger_entries_premium_wallet_shape_check;
ALTER TABLE market_ledger_entries
  ADD CONSTRAINT market_ledger_entries_premium_wallet_shape_check
  CHECK (
    account_location <> 'premium_wallet'
    OR (asset_kind = 'item' AND player_id IS NOT NULL AND collection_id IS NULL)
  );

-- ---------------------------------------------------------------------------
-- Glimmer as a second price currency (owner decision 2026-10-02). Every book
-- is priced in Gold or Glimmer; the Gold and Glimmer books of one item are
-- separate rows and never match each other. Glimmer's own book stays Gold.
-- The Glimmer price leg uses asset kind `glimmer` (no item identity): buy
-- escrow is a premium-wallet debit, seller proceeds and price-improvement
-- refunds are premium-wallet credits at fill, fees go to the fee sink in
-- Glimmer, and unused buy escrow returns straight to the premium wallet on
-- cancellation or expiration. Every such wallet event is a `market` event the
-- provenance guard ties to exactly one order or trade.
-- ---------------------------------------------------------------------------

ALTER TABLE market_order_books
  ADD COLUMN IF NOT EXISTS price_currency text NOT NULL DEFAULT 'gold';
ALTER TABLE market_order_books
  DROP CONSTRAINT IF EXISTS market_order_books_price_currency_check;
ALTER TABLE market_order_books
  ADD CONSTRAINT market_order_books_price_currency_check
  CHECK (
    price_currency IN ('gold', 'glimmer')
    AND NOT (price_currency = 'glimmer' AND item_id = 'glimmer')
  );
ALTER TABLE market_order_books
  DROP CONSTRAINT IF EXISTS market_order_books_venue_id_item_identity_key;
ALTER TABLE market_order_books
  DROP CONSTRAINT IF EXISTS market_order_books_venue_identity_currency_key;
ALTER TABLE market_order_books
  ADD CONSTRAINT market_order_books_venue_identity_currency_key
  UNIQUE (venue_id, item_identity, price_currency);

CREATE OR REPLACE FUNCTION reject_market_book_price_currency_change()
RETURNS trigger AS $$
BEGIN
  IF NEW.price_currency IS DISTINCT FROM OLD.price_currency THEN
    RAISE EXCEPTION 'market book price currency is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS market_order_books_price_currency_immutable ON market_order_books;
CREATE TRIGGER market_order_books_price_currency_immutable
BEFORE UPDATE ON market_order_books
FOR EACH ROW EXECUTE FUNCTION reject_market_book_price_currency_change();

-- The Glimmer rate breaker marks its freeze with sensitive_reason
-- 'premium_rate_breaker', which lets owners still cancel. The mark must never
-- outlive that freeze: any change of the frozen flag that does not set the
-- reason itself clears a stale breaker mark.
CREATE OR REPLACE FUNCTION clear_stale_premium_rate_breaker_mark()
RETURNS trigger AS $$
BEGIN
  IF NEW.frozen IS DISTINCT FROM OLD.frozen
     AND OLD.sensitive_reason = 'premium_rate_breaker'
     AND NEW.sensitive_reason IS NOT DISTINCT FROM OLD.sensitive_reason THEN
    NEW.sensitive_reason := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS market_order_books_breaker_mark_guard ON market_order_books;
CREATE TRIGGER market_order_books_breaker_mark_guard
BEFORE UPDATE OF frozen ON market_order_books
FOR EACH ROW EXECUTE FUNCTION clear_stale_premium_rate_breaker_mark();

-- Equipment listings follow the same rule: the seller prices an exact-instance
-- listing in Gold or Glimmer. A Glimmer purchase debits the buyer's premium
-- wallet for asking price plus buyer tax (`market-equipment-buy:` key, the
-- tax leaves supply) and credits the seller's premium wallet with the asking
-- price (`market-equipment-seller:<listing>`). The equipment ledger records the
-- Glimmer amounts in `glimmer_delta`.
ALTER TABLE market_equipment_listings
  ADD COLUMN IF NOT EXISTS price_currency text NOT NULL DEFAULT 'gold';
ALTER TABLE market_equipment_listings
  DROP CONSTRAINT IF EXISTS market_equipment_listings_price_currency_check;
ALTER TABLE market_equipment_listings
  ADD CONSTRAINT market_equipment_listings_price_currency_check
  CHECK (price_currency IN ('gold', 'glimmer'));
DROP TRIGGER IF EXISTS market_equipment_listings_price_currency_immutable ON market_equipment_listings;
CREATE TRIGGER market_equipment_listings_price_currency_immutable
BEFORE UPDATE ON market_equipment_listings
FOR EACH ROW EXECUTE FUNCTION reject_market_book_price_currency_change();

-- At commit, a listing that became sold has exactly the money events of its
-- currency: Glimmer, one buyer debit and one seller credit and no Gold in its
-- ledger; Gold, no Glimmer wallet events and no Glimmer in its ledger.
CREATE OR REPLACE FUNCTION enforce_market_equipment_sale_currency()
RETURNS trigger AS $$
DECLARE
  debits bigint;
  credits bigint;
BEGIN
  SELECT count(*) FILTER (WHERE delta < 0), count(*) FILTER (WHERE delta > 0)
  INTO debits, credits
  FROM premium_wallet_events
  WHERE ref_type = 'market_equipment_listing' AND ref_id = NEW.listing_id::text;
  IF NEW.price_currency = 'glimmer' THEN
    IF debits <> 1 OR credits <> 1 OR EXISTS (
      SELECT 1 FROM market_equipment_ledger
      WHERE listing_id = NEW.listing_id AND gold_delta IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'Glimmer equipment sale must have one Glimmer debit, one Glimmer credit and no Gold';
    END IF;
  ELSIF debits + credits <> 0 OR EXISTS (
    SELECT 1 FROM market_equipment_ledger
    WHERE listing_id = NEW.listing_id AND glimmer_delta IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Gold equipment sale cannot move Glimmer';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS market_equipment_listings_sale_currency_guard ON market_equipment_listings;
CREATE CONSTRAINT TRIGGER market_equipment_listings_sale_currency_guard
AFTER UPDATE ON market_equipment_listings
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (OLD.status = 'open' AND NEW.status = 'sold')
EXECUTE FUNCTION enforce_market_equipment_sale_currency();

ALTER TABLE market_equipment_ledger
  ADD COLUMN IF NOT EXISTS glimmer_delta bigint NULL;

-- Economy Observatory: an equipment sale is a buyer-to-seller transfer of the
-- asking price plus a SINK of the buyer tax (Gold or Glimmer). The matching
-- wallet events are `market`/`market_equipment_*` and are not projected, so
-- each sale is counted exactly once.
CREATE OR REPLACE FUNCTION record_market_equipment_economy_event()
RETURNS trigger AS $$
DECLARE
  sale market_equipment_listings%ROWTYPE;
  amount bigint := coalesce(NEW.glimmer_delta, NEW.gold_delta);
  asset_value text := CASE WHEN NEW.glimmer_delta IS NOT NULL THEN 'currency:glimmer' ELSE 'gold' END;
  transfer_id uuid;
BEGIN
  IF amount IS NULL OR NEW.entry_type NOT IN ('seller_proceeds', 'tax_burn') THEN
    RETURN NEW;
  END IF;
  SELECT * INTO sale FROM market_equipment_listings WHERE listing_id = NEW.listing_id;
  IF sale.buyer_player_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.entry_type = 'tax_burn' THEN
    INSERT INTO economy_events (
      leg, event_kind, asset_kind, asset_id, variant, quantity, custody_type,
      custody_id, player_id, source_system, source_id, source_operation_key,
      reason, metadata, occurred_at, coverage_domain
    ) VALUES (
      'debit', 'SINK', 'fungible', asset_value, 'default', abs(amount), 'player_wallet',
      sale.buyer_player_id, sale.buyer_player_id, 'market_equipment_ledger',
      NEW.entry_id::text, NEW.operation_key, 'market_equipment_buyer_tax',
      jsonb_build_object('listingId', sale.listing_id), NEW.created_at, 'market'
    ) ON CONFLICT (source_system, source_id) DO NOTHING;
    RETURN NEW;
  END IF;
  transfer_id := sale.listing_id;
  INSERT INTO economy_transfer_groups (transfer_group_id, operation_key, reason)
  VALUES (transfer_id, 'market-equipment-sale:' || sale.listing_id::text, 'market_equipment_sale')
  ON CONFLICT (transfer_group_id) DO NOTHING;
  INSERT INTO economy_events (
    event_group_id, transfer_group_id, leg, event_kind, asset_kind, asset_id,
    variant, quantity, custody_type, custody_id, player_id, source_system,
    source_id, source_operation_key, reason, metadata, occurred_at, coverage_domain
  ) VALUES
    (transfer_id, transfer_id, 'debit', 'TRANSFER', 'fungible', asset_value, 'default',
     abs(amount), 'player_wallet', sale.buyer_player_id, sale.buyer_player_id,
     'market_equipment_ledger', NEW.entry_id::text || ':debit', NEW.operation_key,
     'market_equipment_sale', jsonb_build_object('listingId', sale.listing_id),
     NEW.created_at, 'market'),
    (transfer_id, transfer_id, 'credit', 'TRANSFER', 'fungible', asset_value, 'default',
     abs(amount), 'player_wallet', sale.seller_player_id, sale.seller_player_id,
     'market_equipment_ledger', NEW.entry_id::text || ':credit', NEW.operation_key,
     'market_equipment_sale', jsonb_build_object('listingId', sale.listing_id),
     NEW.created_at, 'market')
  ON CONFLICT (source_system, source_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS market_equipment_ledger_economy_observatory ON market_equipment_ledger;
CREATE TRIGGER market_equipment_ledger_economy_observatory
AFTER INSERT ON market_equipment_ledger
FOR EACH ROW EXECUTE FUNCTION record_market_equipment_economy_event();
ALTER TABLE market_equipment_ledger
  DROP CONSTRAINT IF EXISTS market_equipment_ledger_glimmer_delta_check;
ALTER TABLE market_equipment_ledger
  ADD CONSTRAINT market_equipment_ledger_glimmer_delta_check
  CHECK (
    (glimmer_delta IS NULL OR glimmer_delta <> 0)
    AND (glimmer_delta IS NULL OR gold_delta IS NULL)
  );

CREATE OR REPLACE FUNCTION market_book_price_asset(target_book_id uuid)
RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT CASE price_currency WHEN 'glimmer' THEN 'glimmer' ELSE 'gold' END
  FROM market_order_books WHERE book_id = target_book_id
$$;

DO $$
DECLARE
  existing record;
BEGIN
  FOR existing IN
    SELECT conrelid::regclass AS table_name, conname
    FROM pg_constraint
    WHERE contype = 'c'
      AND conrelid IN ('market_order_escrows'::regclass, 'market_ledger_entries'::regclass)
      AND pg_get_constraintdef(oid) LIKE '%asset_kind%'
      AND pg_get_constraintdef(oid) LIKE '%gold%'
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', existing.table_name, existing.conname);
  END LOOP;
END;
$$;
ALTER TABLE market_order_escrows
  ADD CONSTRAINT market_order_escrows_asset_kind_check
  CHECK (asset_kind IN ('item', 'gold', 'glimmer'));
ALTER TABLE market_order_escrows
  ADD CONSTRAINT market_order_escrows_asset_shape_check
  CHECK (
    (asset_kind = 'item' AND item_identity IS NOT NULL AND item_id IS NOT NULL AND variant IS NOT NULL)
    OR
    (asset_kind IN ('gold', 'glimmer') AND item_identity IS NULL AND item_id IS NULL AND variant IS NULL)
  );
ALTER TABLE market_ledger_entries
  ADD CONSTRAINT market_ledger_entries_asset_kind_check
  CHECK (asset_kind IN ('item', 'gold', 'glimmer'));
ALTER TABLE market_ledger_entries
  DROP CONSTRAINT IF EXISTS market_ledger_entries_premium_wallet_shape_check;
ALTER TABLE market_ledger_entries
  ADD CONSTRAINT market_ledger_entries_premium_wallet_shape_check
  CHECK (
    account_location <> 'premium_wallet'
    OR (asset_kind IN ('item', 'glimmer') AND player_id IS NOT NULL AND collection_id IS NULL)
  );

CREATE OR REPLACE FUNCTION enforce_market_premium_ledger_location()
RETURNS trigger AS $$
DECLARE
  premium boolean := NEW.asset_kind = 'item' AND EXISTS (
    SELECT 1 FROM market_premium_assets WHERE market_identity = NEW.item_identity
  );
BEGIN
  IF premium AND NEW.account_location NOT IN ('premium_wallet', 'sell_escrow', 'fee_sink') THEN
    RAISE EXCEPTION 'premium currency journal entries are limited to premium wallet, sell escrow and fee sink';
  END IF;
  IF NEW.asset_kind = 'glimmer'
     AND NEW.account_location NOT IN ('premium_wallet', 'buy_escrow', 'fee_sink') THEN
    RAISE EXCEPTION 'Glimmer price legs are limited to premium wallet, buy escrow and fee sink';
  END IF;
  IF NOT premium AND NEW.asset_kind <> 'glimmer' AND NEW.account_location = 'premium_wallet' THEN
    RAISE EXCEPTION 'only premium currency can use the premium wallet journal location';
  END IF;
  IF NOT premium AND NEW.asset_kind = 'item' AND NEW.account_location = 'fee_sink' THEN
    RAISE EXCEPTION 'only premium currency fees can move items to the fee sink';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS market_ledger_entries_premium_location_guard ON market_ledger_entries;
CREATE TRIGGER market_ledger_entries_premium_location_guard
BEFORE INSERT ON market_ledger_entries
FOR EACH ROW EXECUTE FUNCTION enforce_market_premium_ledger_location();

-- ---------------------------------------------------------------------------
-- Premium wallet: `market` is the exchange reason. It credits only through a
-- filled trade or the return of an order's own escrow.
-- ---------------------------------------------------------------------------

ALTER TABLE premium_wallet_events
  DROP CONSTRAINT IF EXISTS premium_wallet_events_reason_check;
ALTER TABLE premium_wallet_events
  ADD CONSTRAINT premium_wallet_events_reason_check
  CHECK (reason IN ('admin', 'spend', 'market', 'inventory_migration'));
ALTER TABLE premium_wallet_events
  DROP CONSTRAINT IF EXISTS premium_wallet_events_market_shape;
ALTER TABLE premium_wallet_events
  ADD CONSTRAINT premium_wallet_events_market_shape
  CHECK (
    reason <> 'market'
    OR (
      actor_player_id IS NOT NULL
      AND ref_type IN ('market_order', 'market_trade', 'market_equipment_listing')
      AND ref_id IS NOT NULL
      AND (ref_type IN ('market_order', 'market_equipment_listing') OR delta > 0)
    )
  );
ALTER TABLE premium_wallet_events
  DROP CONSTRAINT IF EXISTS premium_wallet_events_inventory_migration_shape;
ALTER TABLE premium_wallet_events
  ADD CONSTRAINT premium_wallet_events_inventory_migration_shape
  CHECK (
    reason <> 'inventory_migration'
    OR (currency = 'lumen' AND delta < 0 AND actor_player_id IS NOT NULL
        AND ref_type = 'inventory_operation' AND ref_id = operation_key)
  );

-- ---------------------------------------------------------------------------
-- Lumen: wallet balances move into the owner's inventory, then the Lumen
-- wallet is closed. Each account gets one wallet debit and one inventory
-- credit under the same operation key. Lumen weighs nothing, so the move can
-- never exceed carrying capacity. A wallet whose account has no player keeps
-- its balance in place (frozen by the closed wallet, still auditable) and is
-- reported with a NOTICE; nothing is lost or duplicated.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  lumen_wallet record;
  target_player text;
  operation text;
  migration_metadata jsonb;
  stack record;
BEGIN
  FOR lumen_wallet IN
    SELECT account_id, balance, version FROM premium_wallets
    WHERE currency = 'lumen' AND balance > 0
    ORDER BY account_id
    FOR UPDATE
  LOOP
    SELECT id INTO target_player FROM players WHERE account_id = lumen_wallet.account_id;
    IF target_player IS NULL THEN
      RAISE NOTICE 'Lumen wallet % (balance %) has no player; balance left frozen in the closed wallet',
        lumen_wallet.account_id, lumen_wallet.balance;
      CONTINUE;
    END IF;
    operation := 'premium-lumen-to-inventory:0917:' || lumen_wallet.account_id::text;
    migration_metadata := jsonb_build_object(
      'migration', '0917_premium_currency_exchange',
      'walletBalance', lumen_wallet.balance::text
    );
    UPDATE premium_wallets
    SET balance = 0, version = version + 1
    WHERE account_id = lumen_wallet.account_id AND currency = 'lumen';
    INSERT INTO premium_wallet_events (
      account_id, currency, operation_key, delta, balance_after, version_after,
      reason, actor_player_id, ref_type, ref_id, metadata
    ) VALUES (
      lumen_wallet.account_id, 'lumen', operation, -lumen_wallet.balance, 0,
      lumen_wallet.version + 1, 'inventory_migration', target_player,
      'inventory_operation', operation, migration_metadata
    );
    PERFORM lock_player_inventory_carry(target_player);
    INSERT INTO inventory_operations (
      operation_key, player_id, source, source_entity_type, source_entity_id, metadata
    ) VALUES (
      operation, target_player, 'lumen_wallet_migration', 'premium_wallet',
      lumen_wallet.account_id::text, migration_metadata
    );
    INSERT INTO player_inventory (player_id, resource_type, variant, quantity, version, updated_at)
    VALUES (target_player, 'lumen', 'default', lumen_wallet.balance, 1, now())
    ON CONFLICT (player_id, resource_type, variant) DO UPDATE SET
      quantity = player_inventory.quantity + EXCLUDED.quantity,
      version = player_inventory.version + 1,
      updated_at = now()
    RETURNING quantity, version INTO stack;
    INSERT INTO inventory_events (
      operation_key, player_id, item_id, variant, delta_quantity, quantity_after,
      version_after, source, source_entity_type, source_entity_id, metadata
    ) VALUES (
      operation, target_player, 'lumen', 'default', lumen_wallet.balance,
      stack.quantity, stack.version, 'lumen_wallet_migration', 'premium_wallet',
      lumen_wallet.account_id::text, migration_metadata
    );
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION reject_retired_lumen_wallet_event()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Lumen is an inventory item; the Lumen premium wallet is closed';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS premium_wallet_events_lumen_retired ON premium_wallet_events;
CREATE TRIGGER premium_wallet_events_lumen_retired
BEFORE INSERT ON premium_wallet_events
FOR EACH ROW WHEN (NEW.currency = 'lumen')
EXECUTE FUNCTION reject_retired_lumen_wallet_event();

-- Zero free minting: Lumen enters inventory only from the audited admin grant,
-- the migration above, or a move of existing custody.
CREATE OR REPLACE FUNCTION enforce_lumen_inventory_provenance()
RETURNS trigger AS $$
BEGIN
  IF NEW.delta_quantity > 0 AND NEW.source NOT IN (
    'lumen_admin_grant', 'lumen_wallet_migration',
    'market_trade_purchase', 'market_manual_cancellation',
    'market_collection_claim', 'market_collection_repair',
    'pickup_dropped_item', 'manor_stack_withdrawal', 'manor_bulk_take'
  ) THEN
    RAISE EXCEPTION 'Lumen cannot enter inventory from source %', NEW.source;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS inventory_events_lumen_provenance_guard ON inventory_events;
CREATE TRIGGER inventory_events_lumen_provenance_guard
BEFORE INSERT ON inventory_events
FOR EACH ROW WHEN (NEW.item_id = 'lumen')
EXECUTE FUNCTION enforce_lumen_inventory_provenance();

-- A Lumen ground drop is the dropping player's own inventory debit, and its
-- quantity can only shrink (pickups, expiry), never merge or grow.
CREATE OR REPLACE FUNCTION enforce_lumen_ground_drop_provenance()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.item_id IS DISTINCT FROM OLD.item_id
       OR NEW.original_quantity > OLD.original_quantity
       OR NEW.remaining_quantity > OLD.remaining_quantity THEN
      RAISE EXCEPTION 'Lumen ground drops cannot grow';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM inventory_events event
    WHERE event.operation_key = NEW.operation_key
      AND event.player_id = NEW.dropped_by
      AND event.item_id = 'lumen'
      AND event.source = 'drop_item'
      AND event.delta_quantity = -NEW.original_quantity
  ) THEN
    RAISE EXCEPTION 'Lumen ground drop has no matching inventory debit';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS world_item_drops_lumen_provenance_guard ON world_item_drops;
CREATE TRIGGER world_item_drops_lumen_provenance_guard
BEFORE INSERT ON world_item_drops
FOR EACH ROW WHEN (NEW.item_id = 'lumen')
EXECUTE FUNCTION enforce_lumen_ground_drop_provenance();
DROP TRIGGER IF EXISTS world_item_drops_lumen_quantity_guard ON world_item_drops;
CREATE TRIGGER world_item_drops_lumen_quantity_guard
BEFORE UPDATE ON world_item_drops
FOR EACH ROW WHEN (OLD.item_id = 'lumen' OR NEW.item_id = 'lumen')
EXECUTE FUNCTION enforce_lumen_ground_drop_provenance();

-- Market movements are projected from market_ledger_entries as transfers;
-- projecting the wallet side too would double count them.
CREATE OR REPLACE FUNCTION record_premium_wallet_economy_event()
RETURNS trigger AS $$
BEGIN
  IF NEW.reason = 'market' THEN
    RETURN NEW;
  END IF;
  INSERT INTO economy_events (
    event_group_id, leg, event_kind, asset_kind, asset_id, variant,
    quantity, custody_type, custody_id, player_id, source_system, source_id,
    source_operation_key, reason, metadata, occurred_at, coverage_domain
  ) VALUES (
    gen_random_uuid(),
    CASE WHEN NEW.delta > 0 THEN 'credit' ELSE 'debit' END,
    CASE WHEN NEW.reason = 'spend' THEN 'SINK' ELSE 'ADMIN' END,
    'fungible', 'currency:' || NEW.currency, 'default',
    abs(NEW.delta), 'player_wallet', NEW.account_id::text, NEW.actor_player_id,
    'premium_wallet_events', NEW.event_id::text, NEW.operation_key, NEW.reason,
    NEW.metadata, NEW.created_at, 'premium_wallet'
  ) ON CONFLICT (source_system, source_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Market fees and buyer tax (Gold and Glimmer) leave supply: their fee-sink
-- leg is projected as a transfer into the market fee holding plus a SINK out
-- of it, so the transfer group still nets to zero and the fee reads as a sink,
-- once. (Before 0917 Gold fees read as a transfer to external custody.)
CREATE OR REPLACE FUNCTION record_market_economy_transfer()
RETURNS trigger AS $$
DECLARE
  transfer_id uuid := NEW.ledger_group_id;
  market_fee boolean := NEW.account_location = 'fee_sink';
  asset_value text := CASE WHEN NEW.asset_kind = 'glimmer' THEN 'currency:glimmer'
    ELSE coalesce(NEW.item_identity, 'gold') END;
  custody_value text := CASE NEW.account_location
    WHEN 'player_inventory' THEN 'player_inventory'
    WHEN 'sell_escrow' THEN 'market_escrow'
    WHEN 'buyer_collection' THEN 'market_collection'
    WHEN 'return_collection' THEN 'market_collection'
    WHEN 'player_wallet' THEN 'player_wallet'
    WHEN 'premium_wallet' THEN 'player_wallet'
    WHEN 'buy_escrow' THEN 'market_escrow'
    WHEN 'seller_proceeds' THEN 'market_collection'
    WHEN 'refund_balance' THEN 'market_collection'
    WHEN 'fee_sink' THEN 'market_escrow'
    ELSE 'unknown'
  END;
BEGIN
  INSERT INTO economy_transfer_groups (
    transfer_group_id, operation_key, reason
  ) VALUES (
    transfer_id, 'market-ledger:' || transfer_id::text, NEW.reason
  ) ON CONFLICT (transfer_group_id) DO NOTHING;
  IF market_fee THEN
    INSERT INTO economy_events (
      event_group_id, leg, event_kind, asset_kind, asset_id, variant, quantity,
      custody_type, custody_id, player_id, source_system, source_id,
      source_operation_key, reason, metadata, occurred_at, coverage_domain
    ) VALUES (
      transfer_id, 'debit', 'SINK', 'fungible', asset_value, 'default',
      abs(NEW.amount), 'market_escrow', 'fee_sink', NULL,
      'market_ledger_entries', NEW.ledger_entry_id::text || ':sink', transfer_id::text,
      NEW.reason, jsonb_build_object('accountLocation', 'fee_sink'),
      NEW.created_at, 'market'
    ) ON CONFLICT (source_system, source_id) DO NOTHING;
  END IF;
  INSERT INTO economy_events (
    event_group_id, transfer_group_id, leg, event_kind, asset_kind, asset_id,
    variant, quantity, custody_type, custody_id, player_id, source_system,
    source_id, source_operation_key, reason, metadata, occurred_at, coverage_domain
  ) VALUES (
    transfer_id, transfer_id,
    CASE WHEN NEW.amount < 0 THEN 'debit' ELSE 'credit' END,
    'TRANSFER',
    CASE WHEN NEW.asset_kind = 'item' THEN 'fungible' ELSE 'fungible' END,
    asset_value,
    'default', abs(NEW.amount), custody_value,
    coalesce(NEW.player_id::text, NEW.account_location), NEW.player_id,
    'market_ledger_entries', NEW.ledger_entry_id::text, transfer_id::text,
    NEW.reason, jsonb_build_object('accountLocation', NEW.account_location),
    NEW.created_at, 'market'
  ) ON CONFLICT (source_system, source_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Order validator (replaces 0716): premium sells escrow quantity plus the fee
-- reserve, debit the premium wallet, and return unused escrow directly to the
-- premium wallet on cancellation or expiration. Glimmer-priced buys escrow
-- Glimmer from the premium wallet and return it the same way.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION validate_market_order_commit(target_order_id uuid)
RETURNS void AS $$
DECLARE
  target_order market_orders%ROWTYPE;
  target_escrow market_order_escrows%ROWTYPE;
  target_fee market_fee_policies%ROWTYPE;
  recovery_collection market_collections%ROWTYPE;
  premium_asset market_premium_assets%ROWTYPE;
  premium_terms market_premium_sell_terms%ROWTYPE;
  premium_sell boolean;
  glimmer_buy boolean;
  price_asset text;
  wallet_currency text;
  unused_fee_reserve numeric := 0;
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

  SELECT * INTO premium_asset FROM market_premium_assets
  WHERE item_id = target_order.item_id;
  SELECT * INTO premium_terms FROM market_premium_sell_terms
  WHERE order_id = target_order_id;
  premium_sell := premium_asset.item_id IS NOT NULL AND target_order.side = 'sell';
  price_asset := market_book_price_asset(target_order.book_id);
  IF price_asset IS NULL THEN
    RAISE EXCEPTION 'market order book does not exist';
  END IF;
  glimmer_buy := target_order.side = 'buy' AND price_asset = 'glimmer';
  wallet_currency := CASE WHEN premium_sell THEN premium_asset.currency ELSE 'glimmer' END;
  IF premium_sell THEN
    IF premium_terms.order_id IS NULL
       OR premium_terms.item_id <> target_order.item_id
       OR target_order.item_identity <> premium_asset.market_identity
       OR premium_terms.fee_reserve::numeric <> market_premium_currency_fee(
         target_order.original_quantity::numeric, premium_terms.seller_fee_bps
       ) THEN
      RAISE EXCEPTION 'premium sell order fee terms are missing or inconsistent';
    END IF;
    unused_fee_reserve := premium_terms.fee_reserve::numeric
      - market_premium_currency_fee(
          target_order.filled_quantity::numeric, premium_terms.seller_fee_bps
        );
    IF unused_fee_reserve < 0 THEN
      RAISE EXCEPTION 'premium sell order charged more fee than it reserved';
    END IF;
  ELSIF premium_terms.order_id IS NOT NULL THEN
    RAISE EXCEPTION 'only premium sell orders can carry premium fee terms';
  END IF;

  IF target_order.side = 'sell' THEN
    IF target_escrow.asset_kind <> 'item'
       OR target_escrow.item_identity IS DISTINCT FROM target_order.item_identity
       OR target_escrow.item_id IS DISTINCT FROM target_order.item_id
       OR target_escrow.variant IS DISTINCT FROM target_order.variant
       OR target_escrow.initial_amount
          <> target_order.original_quantity + coalesce(premium_terms.fee_reserve, 0) THEN
      RAISE EXCEPTION 'sell escrow asset or amount does not match its order';
    END IF;
  ELSE
    IF target_escrow.asset_kind <> price_asset
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
    IF target_escrow.remaining_amount::numeric
       <> target_order.remaining_quantity::numeric + unused_fee_reserve THEN
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
  debit_location := CASE
    WHEN premium_sell OR glimmer_buy THEN 'premium_wallet'
    WHEN target_order.side = 'sell' THEN 'player_inventory'
    ELSE 'player_wallet'
  END;
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
    IF premium_sell OR glimmer_buy THEN
      IF EXISTS (SELECT 1 FROM market_collections WHERE source_order_id = target_order_id) THEN
        RAISE EXCEPTION 'premium currency orders return escrow directly to the premium wallet';
      END IF;
      IF premium_sell THEN
        expected_amount := target_order.remaining_quantity::numeric + unused_fee_reserve;
      ELSE
        expected_amount := target_order.limit_unit_price::numeric
          * target_order.remaining_quantity::numeric;
        expected_amount := expected_amount
          + floor(expected_amount * target_fee.buyer_fee_bps::numeric / 10000);
      END IF;
      credit_location := 'premium_wallet';
      SELECT count(*) INTO related_count
      FROM premium_wallet_events event
      WHERE event.account_id = target_order.account_id
        AND event.operation_key = 'market-cancel-premium:' || target_order_id::text
        AND event.currency = wallet_currency
        AND event.delta::numeric = expected_amount
        AND event.reason = 'market'
        AND event.actor_player_id = target_order.player_id
        AND event.ref_type = 'market_order'
        AND event.ref_id = target_order_id::text;
      IF related_count <> 1 THEN
        RAISE EXCEPTION 'premium order return lacks its exact premium wallet credit';
      END IF;
    ELSIF target_order.status = 'cancelled' THEN
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
  ) OR ((premium_sell OR glimmer_buy) AND EXISTS (
    SELECT 1 FROM premium_wallet_events
    WHERE account_id = target_order.account_id
      AND operation_key = 'market-cancel-premium:' || target_order_id::text
  )) THEN
    RAISE EXCEPTION 'open or filled market order cannot have return settlement';
  END IF;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Escrow journal validator (replaces 0601): a premium sell escrow, and a
-- Glimmer-priced buy escrow, is backed by exactly one premium-wallet debit
-- instead of an inventory or Gold wallet transition.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION validate_market_order_journal_commit(target_order_id uuid)
RETURNS void AS $$
DECLARE
  target_order market_orders%ROWTYPE;
  target_escrow market_order_escrows%ROWTYPE;
  target_fee market_fee_policies%ROWTYPE;
  premium_asset market_premium_assets%ROWTYPE;
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
  SELECT * INTO premium_asset FROM market_premium_assets
  WHERE item_id = target_order.item_id;

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

  IF target_order.side = 'sell' AND premium_asset.item_id IS NOT NULL THEN
    SELECT count(*) INTO authoritative_transition_count
    FROM premium_wallet_events event
    WHERE event.account_id = target_order.account_id
      AND event.operation_key =
            'market-sell-escrow:' || target_order.account_id::text || ':'
              || target_order.client_request_id
      AND event.currency = premium_asset.currency
      AND event.delta = -target_escrow.initial_amount
      AND event.reason = 'market'
      AND event.actor_player_id = target_order.player_id
      AND event.ref_type = 'market_order'
      AND event.ref_id = target_order.order_id::text;
    IF EXISTS (
      SELECT 1 FROM inventory_operations
      WHERE operation_key =
        'market-sell-escrow:' || target_order.account_id::text || ':'
          || target_order.client_request_id
    ) THEN
      RAISE EXCEPTION 'premium sell escrow cannot have an inventory transition';
    END IF;
  ELSIF target_order.side = 'buy' AND market_book_price_asset(target_order.book_id) = 'glimmer' THEN
    SELECT count(*) INTO authoritative_transition_count
    FROM premium_wallet_events event
    WHERE event.account_id = target_order.account_id
      AND event.operation_key =
            'market-buy-escrow:' || target_order.account_id::text || ':'
              || target_order.client_request_id
      AND event.currency = 'glimmer'
      AND event.delta = -target_escrow.initial_amount
      AND event.reason = 'market'
      AND event.actor_player_id = target_order.player_id
      AND event.ref_type = 'market_order'
      AND event.ref_id = target_order.order_id::text;
    IF EXISTS (
      SELECT 1 FROM wallet_events
      WHERE operation_key =
        'market-buy-escrow:' || target_order.account_id::text || ':'
          || target_order.client_request_id
    ) THEN
      RAISE EXCEPTION 'Glimmer-priced buy escrow cannot have a Gold wallet transition';
    END IF;
  ELSIF target_order.side = 'sell' THEN
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

-- ---------------------------------------------------------------------------
-- Trade validator (replaces 0716): a premium fill credits the buyer's premium
-- wallet and moves the seller's currency fee from sell escrow to the fee sink.
-- On a Glimmer-priced book the price leg is Glimmer: seller proceeds and the
-- buyer's price-improvement refund are premium-wallet credits.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION validate_market_trade_commit(target_trade_id uuid)
RETURNS void AS $$
DECLARE
  target_trade market_trades%ROWTYPE;
  buy_order market_orders%ROWTYPE;
  sell_order market_orders%ROWTYPE;
  maker_order market_orders%ROWTYPE;
  buyer_fee_policy market_fee_policies%ROWTYPE;
  seller_fee_policy market_fee_policies%ROWTYPE;
  premium_asset market_premium_assets%ROWTYPE;
  premium_terms market_premium_sell_terms%ROWTYPE;
  trade_group_id uuid;
  related_count bigint;
  expected_entries integer;
  seller_proceeds bigint;
  refund_amount bigint;
  fee_total bigint;
  legacy_collection_count bigint;
  prior_sell_fill numeric;
  currency_fee numeric := 0;
  price_asset text;
  price_wallet text;
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

  price_asset := market_book_price_asset(target_trade.book_id);
  price_wallet := CASE WHEN price_asset = 'glimmer' THEN 'premium_wallet' ELSE 'player_wallet' END;
  SELECT * INTO premium_asset FROM market_premium_assets
  WHERE item_id = target_trade.item_id;
  IF premium_asset.item_id IS NOT NULL THEN
    SELECT * INTO premium_terms FROM market_premium_sell_terms
    WHERE order_id = sell_order.order_id;
    IF premium_terms.order_id IS NULL THEN
      RAISE EXCEPTION 'premium trade sell order has no fee terms';
    END IF;
    SELECT coalesce(sum(quantity), 0) INTO prior_sell_fill
    FROM market_trades
    WHERE sell_order_id = sell_order.order_id
      AND book_id = target_trade.book_id
      AND book_version < target_trade.book_version;
    currency_fee :=
      market_premium_currency_fee(prior_sell_fill + target_trade.quantity::numeric, premium_terms.seller_fee_bps)
      - market_premium_currency_fee(prior_sell_fill, premium_terms.seller_fee_bps);
  END IF;

  SELECT count(*) INTO legacy_collection_count
  FROM market_collections collection
  JOIN market_legacy_collection_allowlist allowlist
    ON allowlist.collection_kind = 'material'
   AND allowlist.collection_identity = collection.collection_id::text
  WHERE collection.source_trade_id = target_trade_id;
  IF legacy_collection_count > 0 AND price_asset = 'gold' THEN
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
  seller_proceeds := target_trade.gross_value - target_trade.seller_fee;
  IF price_asset = 'glimmer' THEN
    IF EXISTS (SELECT 1 FROM wallet_events WHERE market_trade_id = target_trade_id) THEN
      RAISE EXCEPTION 'Glimmer-priced trade cannot move Gold';
    END IF;
    SELECT count(*), coalesce(sum(delta), 0)
    INTO related_count, refund_amount
    FROM premium_wallet_events
    WHERE account_id = buy_order.account_id
      AND operation_key = 'market-trade-refund:' || target_trade_id::text
      AND currency = 'glimmer' AND reason = 'market'
      AND actor_player_id = target_trade.buyer_player_id
      AND ref_type = 'market_trade' AND ref_id = target_trade_id::text;
    IF related_count > 1 OR refund_amount < 0 THEN
      RAISE EXCEPTION 'market trade buyer refund wallet transition is inconsistent';
    END IF;
    SELECT count(*) INTO related_count
    FROM premium_wallet_events
    WHERE account_id = sell_order.account_id
      AND operation_key = 'market-trade-proceeds:' || target_trade_id::text
      AND currency = 'glimmer' AND reason = 'market'
      AND actor_player_id = target_trade.seller_player_id
      AND ref_type = 'market_trade' AND ref_id = target_trade_id::text
      AND delta = seller_proceeds;
  ELSE
    SELECT count(*), coalesce(sum(delta_gold), 0)
    INTO related_count, refund_amount
    FROM wallet_events
    WHERE market_trade_id = target_trade_id
      AND player_id = target_trade.buyer_player_id
      AND reason = 'market_trade_price_improvement';
    IF related_count > 1 OR refund_amount < 0 THEN
      RAISE EXCEPTION 'market trade buyer refund wallet transition is inconsistent';
    END IF;
    SELECT count(*) INTO related_count
    FROM wallet_events
    WHERE market_trade_id = target_trade_id
      AND player_id = target_trade.seller_player_id
      AND reason = 'market_trade_seller_proceeds'
      AND delta_gold = seller_proceeds;
  END IF;
  IF (seller_proceeds > 0 AND related_count <> 1)
     OR (seller_proceeds = 0 AND related_count <> 0) THEN
    RAISE EXCEPTION 'market trade seller wallet transition is inconsistent';
  END IF;
  IF premium_asset.item_id IS NOT NULL THEN
    SELECT count(*) INTO related_count
    FROM premium_wallet_events event
    WHERE event.account_id = buy_order.account_id
      AND event.operation_key = 'market-trade-premium:' || target_trade_id::text
      AND event.currency = premium_asset.currency
      AND event.delta = target_trade.quantity
      AND event.reason = 'market'
      AND event.actor_player_id = target_trade.buyer_player_id
      AND event.ref_type = 'market_trade'
      AND event.ref_id = target_trade_id::text;
    IF related_count <> 1 OR EXISTS (
      SELECT 1 FROM inventory_events
      WHERE operation_key = 'market-trade-item:' || target_trade_id::text
    ) THEN
      RAISE EXCEPTION 'market trade buyer premium wallet transition is inconsistent';
    END IF;
  ELSE
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
    + CASE WHEN fee_total > 0 THEN 1 ELSE 0 END
    + CASE WHEN currency_fee > 0 THEN 1 ELSE 0 END;
  SELECT count(*) INTO related_count FROM market_ledger_entries
  WHERE ledger_group_id = trade_group_id;
  IF related_count <> expected_entries
     OR NOT EXISTS (
       SELECT 1 FROM market_ledger_entries WHERE ledger_group_id = trade_group_id
         AND asset_kind = 'item' AND item_identity = target_trade.item_identity
         AND amount::numeric = -(target_trade.quantity::numeric + currency_fee)
         AND account_location = 'sell_escrow'
         AND player_id = target_trade.seller_player_id
         AND order_id = target_trade.sell_order_id AND trade_id = target_trade_id
         AND collection_id IS NULL
     )
     OR NOT EXISTS (
       SELECT 1 FROM market_ledger_entries WHERE ledger_group_id = trade_group_id
         AND asset_kind = 'item' AND item_identity = target_trade.item_identity
         AND amount = target_trade.quantity
         AND account_location = CASE WHEN premium_asset.item_id IS NOT NULL
           THEN 'premium_wallet' ELSE 'player_inventory' END
         AND player_id = target_trade.buyer_player_id
         AND order_id = target_trade.buy_order_id AND trade_id = target_trade_id
         AND collection_id IS NULL
     )
     OR NOT EXISTS (
       SELECT 1 FROM market_ledger_entries WHERE ledger_group_id = trade_group_id
         AND asset_kind = price_asset AND item_identity IS NULL
         AND amount = -(target_trade.gross_value + target_trade.buyer_fee + refund_amount)
         AND account_location = 'buy_escrow'
         AND player_id = target_trade.buyer_player_id
         AND order_id = target_trade.buy_order_id AND trade_id = target_trade_id
         AND collection_id IS NULL
     ) THEN
    RAISE EXCEPTION 'market trade base ledger settlement is inconsistent';
  END IF;
  IF currency_fee > 0 AND NOT EXISTS (
    SELECT 1 FROM market_ledger_entries WHERE ledger_group_id = trade_group_id
      AND asset_kind = 'item' AND item_identity = target_trade.item_identity
      AND amount::numeric = currency_fee AND account_location = 'fee_sink'
      AND player_id IS NULL AND order_id IS NULL AND trade_id = target_trade_id
      AND collection_id IS NULL
  ) THEN
    RAISE EXCEPTION 'market trade currency fee ledger settlement is inconsistent';
  END IF;
  IF seller_proceeds > 0 AND NOT EXISTS (
    SELECT 1 FROM market_ledger_entries WHERE ledger_group_id = trade_group_id
      AND asset_kind = price_asset AND item_identity IS NULL
      AND amount = seller_proceeds AND account_location = price_wallet
      AND player_id = target_trade.seller_player_id
      AND order_id = target_trade.sell_order_id AND trade_id = target_trade_id
      AND collection_id IS NULL
  ) THEN
    RAISE EXCEPTION 'market trade seller ledger settlement is inconsistent';
  END IF;
  IF refund_amount > 0 AND NOT EXISTS (
    SELECT 1 FROM market_ledger_entries WHERE ledger_group_id = trade_group_id
      AND asset_kind = price_asset AND item_identity IS NULL
      AND amount = refund_amount AND account_location = price_wallet
      AND player_id = target_trade.buyer_player_id
      AND order_id = target_trade.buy_order_id AND trade_id = target_trade_id
      AND collection_id IS NULL
  ) THEN
    RAISE EXCEPTION 'market trade refund ledger settlement is inconsistent';
  END IF;
  IF fee_total > 0 AND NOT EXISTS (
    SELECT 1 FROM market_ledger_entries WHERE ledger_group_id = trade_group_id
      AND asset_kind = price_asset AND item_identity IS NULL
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

-- ---------------------------------------------------------------------------
-- Trade hardening validator (replaces 0716): a Glimmer-priced buy's
-- price-improvement refund is its exact premium-wallet credit.
-- ---------------------------------------------------------------------------

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

  IF market_book_price_asset(target_trade.book_id) = 'glimmer' THEN
    SELECT count(*), coalesce(sum(delta), 0)
    INTO refund_count, refund_total
    FROM premium_wallet_events
    WHERE account_id = buy_order.account_id
      AND operation_key = 'market-trade-refund:' || target_trade_id::text
      AND currency = 'glimmer'
      AND reason = 'market'
      AND actor_player_id = target_trade.buyer_player_id
      AND ref_type = 'market_trade'
      AND ref_id = target_trade_id::text;
  ELSE
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
  END IF;
  IF (expected_refund = 0 AND (refund_count <> 0 OR refund_total <> 0))
     OR (expected_refund > 0
       AND (refund_count <> 1 OR refund_total <> expected_refund)) THEN
    RAISE EXCEPTION 'market price-improvement wallet transition is not independently correct';
  END IF;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Reverse boundary: every `market` premium-wallet event must be exactly one
-- of: a Glimmer sell order's escrow debit or return; a Glimmer-priced buy
-- order's escrow debit or return; a Glimmer fill's buyer credit; a
-- Glimmer-priced fill's seller proceeds or buyer refund; or a Glimmer-priced
-- equipment sale's buyer debit or seller proceeds.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION validate_premium_market_wallet_event(target_event_id bigint)
RETURNS void AS $$
DECLARE
  target_event premium_wallet_events%ROWTYPE;
  premium_asset market_premium_assets%ROWTYPE;
  target_order market_orders%ROWTYPE;
  target_trade market_trades%ROWTYPE;
  buy_order market_orders%ROWTYPE;
  sell_order market_orders%ROWTYPE;
  glimmer_buy boolean;
  premium_sell boolean;
  glimmer_priced boolean;
  target_listing market_equipment_listings%ROWTYPE;
  equipment_debits bigint;
  equipment_credits bigint;
BEGIN
  SELECT * INTO target_event FROM premium_wallet_events WHERE event_id = target_event_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'premium market provenance references a missing event';
  END IF;
  IF target_event.reason <> 'market' THEN
    RETURN;
  END IF;
  SELECT * INTO premium_asset FROM market_premium_assets
  WHERE currency = target_event.currency;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'premium market event currency has no exchange asset';
  END IF;
  IF target_event.ref_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'premium market event reference is malformed';
  END IF;

  IF target_event.ref_type = 'market_order' THEN
    SELECT * INTO target_order FROM market_orders
    WHERE order_id = target_event.ref_id::uuid;
    premium_sell := target_order.side = 'sell' AND target_order.item_id = premium_asset.item_id;
    glimmer_buy := target_order.side = 'buy' AND target_event.currency = 'glimmer'
      AND market_book_price_asset(target_order.book_id) = 'glimmer';
    IF target_order.order_id IS NULL
       OR NOT (coalesce(premium_sell, false) OR coalesce(glimmer_buy, false))
       OR target_order.account_id <> target_event.account_id
       OR target_order.player_id <> target_event.actor_player_id
       OR (target_event.delta < 0 AND target_event.operation_key <>
             CASE WHEN premium_sell THEN 'market-sell-escrow:' ELSE 'market-buy-escrow:' END
               || target_order.account_id::text || ':' || target_order.client_request_id)
       OR (target_event.delta > 0 AND (
             target_event.operation_key <> 'market-cancel-premium:' || target_order.order_id::text
             OR target_order.status NOT IN ('cancelled', 'expired')
           )) THEN
      RAISE EXCEPTION 'premium market order event has no matching premium order';
    END IF;
    PERFORM validate_market_order_commit(target_order.order_id);
    PERFORM validate_market_order_journal_commit(target_order.order_id);
  ELSIF target_event.ref_type = 'market_trade' THEN
    SELECT * INTO target_trade FROM market_trades
    WHERE trade_id = target_event.ref_id::uuid;
    SELECT * INTO buy_order FROM market_orders
    WHERE order_id = target_trade.buy_order_id;
    SELECT * INTO sell_order FROM market_orders
    WHERE order_id = target_trade.sell_order_id;
    glimmer_priced := target_event.currency = 'glimmer'
      AND market_book_price_asset(target_trade.book_id) = 'glimmer';
    IF target_trade.trade_id IS NULL OR buy_order.order_id IS NULL
       OR sell_order.order_id IS NULL OR target_event.delta <= 0
       OR NOT (
         (target_event.operation_key = 'market-trade-premium:' || target_trade.trade_id::text
           AND target_trade.item_id = premium_asset.item_id
           AND buy_order.account_id = target_event.account_id
           AND target_trade.buyer_player_id = target_event.actor_player_id)
         OR (target_event.operation_key = 'market-trade-refund:' || target_trade.trade_id::text
           AND coalesce(glimmer_priced, false)
           AND buy_order.account_id = target_event.account_id
           AND target_trade.buyer_player_id = target_event.actor_player_id)
         OR (target_event.operation_key = 'market-trade-proceeds:' || target_trade.trade_id::text
           AND coalesce(glimmer_priced, false)
           AND sell_order.account_id = target_event.account_id
           AND target_trade.seller_player_id = target_event.actor_player_id)
       ) THEN
      RAISE EXCEPTION 'premium market trade event has no matching premium fill';
    END IF;
    PERFORM validate_market_trade_commit(target_trade.trade_id);
    PERFORM validate_market_trade_hardening_commit(target_trade.trade_id);
  ELSIF target_event.ref_type = 'market_equipment_listing' THEN
    -- Glimmer-priced equipment: exactly one buyer debit (asking price plus the
    -- recorded buyer tax) and one seller credit (asking price) per sold listing.
    SELECT * INTO target_listing FROM market_equipment_listings
    WHERE listing_id = target_event.ref_id::uuid;
    IF target_listing.listing_id IS NULL
       OR target_event.currency <> 'glimmer'
       OR target_listing.price_currency <> 'glimmer'
       OR target_listing.status NOT IN ('sold', 'claimed')
       OR target_listing.buyer_player_id IS NULL
       OR target_listing.buyer_tax IS NULL THEN
      RAISE EXCEPTION 'premium market equipment event has no matching Glimmer sale';
    END IF;
    IF target_event.delta < 0 THEN
      IF target_event.actor_player_id <> target_listing.buyer_player_id
         OR target_event.account_id <> (
           SELECT account_id FROM players WHERE id = target_listing.buyer_player_id
         )
         OR target_event.delta <> -(target_listing.asking_price + target_listing.buyer_tax)
         OR target_event.operation_key NOT LIKE 'market-equipment-buy:%'
         OR NOT EXISTS (
           SELECT 1 FROM market_equipment_ledger entry
           WHERE entry.listing_id = target_listing.listing_id
             AND entry.operation_key = target_event.operation_key
             AND entry.entry_type = 'buyer_debit'
             AND entry.glimmer_delta = target_event.delta
         ) THEN
        RAISE EXCEPTION 'premium market equipment purchase debit does not match its sale';
      END IF;
    ELSE
      IF target_event.actor_player_id <> target_listing.seller_player_id
         OR target_event.account_id <> (
           SELECT account_id FROM players WHERE id = target_listing.seller_player_id
         )
         OR target_event.delta <> target_listing.asking_price
         OR target_event.operation_key <> 'market-equipment-seller:' || target_listing.listing_id::text THEN
        RAISE EXCEPTION 'premium market equipment proceeds do not match their sale';
      END IF;
    END IF;
    SELECT count(*) FILTER (WHERE delta < 0), count(*) FILTER (WHERE delta > 0)
    INTO equipment_debits, equipment_credits
    FROM premium_wallet_events
    WHERE reason = 'market' AND ref_type = 'market_equipment_listing'
      AND ref_id = target_listing.listing_id::text;
    IF equipment_debits <> 1 OR equipment_credits <> 1 THEN
      RAISE EXCEPTION 'Glimmer equipment sale must have exactly one debit and one credit';
    END IF;
    IF EXISTS (
      SELECT 1 FROM market_equipment_ledger
      WHERE listing_id = target_listing.listing_id AND gold_delta IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'Glimmer-priced equipment sale cannot move Gold';
    END IF;
  ELSE
    RAISE EXCEPTION 'premium market event has an unsupported reference';
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enforce_premium_market_wallet_event()
RETURNS trigger AS $$
BEGIN
  PERFORM validate_premium_market_wallet_event(NEW.event_id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS premium_wallet_events_market_provenance_guard ON premium_wallet_events;
CREATE CONSTRAINT TRIGGER premium_wallet_events_market_provenance_guard
AFTER INSERT ON premium_wallet_events
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (NEW.reason = 'market')
EXECUTE FUNCTION enforce_premium_market_wallet_event();

CREATE OR REPLACE FUNCTION enforce_market_premium_sell_terms_commit()
RETURNS trigger AS $$
BEGIN
  PERFORM validate_market_order_commit(NEW.order_id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS market_premium_sell_terms_commit_guard ON market_premium_sell_terms;
CREATE CONSTRAINT TRIGGER market_premium_sell_terms_commit_guard
AFTER INSERT ON market_premium_sell_terms
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_market_premium_sell_terms_commit();
