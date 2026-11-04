-- Species carcass and meat foundation.
--
-- Combat V5 grants uncommon carcasses.  The existing Butcher station is the
-- only producer of meat.  Raw Meat remains addressable for immutable history,
-- while active custody is converted 1:1 to the explicit Wild Meat
-- compatibility material.

LOCK TABLE item_definitions, player_inventory, player_inventory_slots,
  inventory_operations, inventory_events, manor_storage_stacks,
  city_warehouse_stacks, world_item_drops, world_item_movements,
  world_item_system_drop_sources, market_order_books, market_orders,
  market_order_escrows, market_collections, market_claims,
  market_ledger_groups, market_ledger_entries, market_audit_events,
  player_wallets, wallet_events,
  kingdom_treasury_balances, butcher_jobs, player_packages, player_package_items
  IN SHARE ROW EXCLUSIVE MODE;

INSERT INTO item_definitions (
  item_id, display_name, category, rarity, stackable, max_stack,
  droppable, manor_storable, market_tradable, market_fungible,
  market_identity, supported_variants
)
VALUES
  ('deer_carcass', 'Deer Carcass', 'resource', 'uncommon', true, 125, true, true, true, true, 'deer_carcass', ARRAY['default']::text[]),
  ('wolf_carcass', 'Wolf Carcass', 'resource', 'uncommon', true, 125, true, true, true, true, 'wolf_carcass', ARRAY['default']::text[]),
  ('hog_carcass', 'Hog Carcass', 'resource', 'uncommon', true, 125, true, true, true, true, 'hog_carcass', ARRAY['default']::text[]),
  ('bear_carcass', 'Bear Carcass', 'resource', 'uncommon', true, 125, true, true, true, true, 'bear_carcass', ARRAY['default']::text[]),
  ('alligator_carcass', 'Alligator Carcass', 'resource', 'uncommon', true, 125, true, true, true, true, 'alligator_carcass', ARRAY['default']::text[]),
  ('wild_carcass', 'Wild Carcass', 'resource', 'uncommon', true, 125, true, true, true, true, 'wild_carcass', ARRAY['default']::text[]),
  ('squid_meat', 'Squid Meat', 'resource', 'common', true, 500, true, true, true, true, 'squid_meat', ARRAY['default']::text[]),
  ('deer_meat', 'Deer Meat', 'resource', 'common', true, 500, true, true, true, true, 'deer_meat', ARRAY['default']::text[]),
  ('wolf_meat', 'Wolf Meat', 'resource', 'common', true, 500, true, true, true, true, 'wolf_meat', ARRAY['default']::text[]),
  ('hog_meat', 'Hog Meat', 'resource', 'common', true, 500, true, true, true, true, 'hog_meat', ARRAY['default']::text[]),
  ('bear_meat', 'Bear Meat', 'resource', 'common', true, 500, true, true, true, true, 'bear_meat', ARRAY['default']::text[]),
  ('alligator_meat', 'Alligator Meat', 'resource', 'common', true, 500, true, true, true, true, 'alligator_meat', ARRAY['default']::text[]),
  ('wild_meat', 'Wild Meat', 'resource', 'common', true, 500, true, true, true, true, 'wild_meat', ARRAY['default']::text[])
ON CONFLICT (item_id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  category = EXCLUDED.category,
  rarity = EXCLUDED.rarity,
  stackable = EXCLUDED.stackable,
  max_stack = EXCLUDED.max_stack,
  droppable = EXCLUDED.droppable,
  manor_storable = EXCLUDED.manor_storable,
  market_tradable = EXCLUDED.market_tradable,
  market_fungible = EXCLUDED.market_fungible,
  market_identity = EXCLUDED.market_identity,
  supported_variants = EXCLUDED.supported_variants,
  updated_at = clock_timestamp();

-- Raw Meat is retained only as an immutable historical identity.
UPDATE item_definitions
SET display_name = 'Raw Meat (Legacy)',
    droppable = false,
    market_tradable = false,
    market_fungible = false,
    market_identity = NULL,
    updated_at = clock_timestamp()
WHERE item_id = 'raw_meat';

ALTER TABLE butcher_jobs
  DROP CONSTRAINT IF EXISTS butcher_jobs_recipe_id_check,
  DROP CONSTRAINT IF EXISTS butcher_jobs_output_quantity_check;
ALTER TABLE butcher_jobs
  ADD CONSTRAINT butcher_jobs_recipe_id_check
    CHECK (recipe_id IN (
      'deer_carcass', 'wolf_carcass', 'hog_carcass', 'bear_carcass',
      'alligator_carcass', 'wild_carcass', 'squid_flesh', 'crab_carapace'
    )),
  ADD CONSTRAINT butcher_jobs_output_quantity_check
    CHECK (output_quantity BETWEEN 1 AND 250);

-- These are mutable storage projections.  Overflow ledgers and historical
-- events retain Raw Meat as evidence and are intentionally untouched.
UPDATE manor_storage_stacks
SET item_id = 'wild_meat', updated_at = clock_timestamp()
WHERE item_id = 'raw_meat';
UPDATE city_warehouse_stacks
SET item_id = 'wild_meat', updated_at = clock_timestamp()
WHERE item_id = 'raw_meat';

DO $$
DECLARE
  migration_now timestamptz := clock_timestamp();
  raw_stack record;
  target_stack record;
  package_raw record;
  package_target record;
  operation_key_value text;
  variant_value text;
  new_drop_id uuid;
  drop_row record;
  order_row record;
  collection_row record;
  claim_id_value uuid;
  request_id_value text;
  ledger_group_id_value uuid;
  amount_value bigint;
  wallet_balance bigint;
  wallet_version bigint;
  player_account_id uuid;
BEGIN
  -- Convert every active player stack through the append-only inventory
  -- operation/event chain.  Re-running the migration sees the operation and
  -- makes no additional grant.
  FOR raw_stack IN
    SELECT player_id, COALESCE(variant, 'default') AS variant,
           quantity::bigint AS quantity
    FROM player_inventory
    WHERE resource_type = 'raw_meat' AND quantity > 0
    ORDER BY player_id, COALESCE(variant, 'default')
  LOOP
    variant_value := raw_stack.variant;
    operation_key_value := 'migration:0818:raw-meat-to-wild-meat:'
      || raw_stack.player_id || ':' || variant_value;

    INSERT INTO inventory_operations (
      operation_key, player_id, source, source_entity_type, source_entity_id, metadata
    ) VALUES (
      operation_key_value, raw_stack.player_id, 'species_meat_migration',
      'migration', '0818',
      jsonb_build_object('from', 'raw_meat', 'to', 'wild_meat', 'variant', variant_value)
    ) ON CONFLICT (operation_key) DO NOTHING;

    IF EXISTS (
      SELECT 1 FROM inventory_events
      WHERE inventory_events.operation_key = operation_key_value
    ) THEN
      CONTINUE;
    END IF;

    INSERT INTO player_inventory (
      player_id, resource_type, variant, quantity, version, updated_at
    ) VALUES (
      raw_stack.player_id, 'wild_meat', variant_value, 0, 0, migration_now
    ) ON CONFLICT (player_id, resource_type, variant) DO NOTHING;

    UPDATE player_inventory
    SET quantity = quantity + raw_stack.quantity,
        version = COALESCE(version, 0) + 1,
        updated_at = migration_now
    WHERE player_id = raw_stack.player_id
      AND resource_type = 'wild_meat'
      AND variant = variant_value
    RETURNING quantity::bigint, version::bigint INTO target_stack;

    INSERT INTO inventory_events (
      operation_key, player_id, item_id, variant, delta_quantity,
      quantity_after, version_after, source, source_entity_type,
      source_entity_id, metadata
    ) VALUES (
      operation_key_value, raw_stack.player_id, 'wild_meat', variant_value,
      raw_stack.quantity, target_stack.quantity, target_stack.version,
      'species_meat_migration', 'migration', '0818',
      jsonb_build_object('from', 'raw_meat', 'to', 'wild_meat')
    );

    UPDATE player_inventory
    SET quantity = 0,
        version = COALESCE(version, 0) + 1,
        updated_at = migration_now
    WHERE player_id = raw_stack.player_id
      AND resource_type = 'raw_meat'
      AND variant IS NOT DISTINCT FROM variant_value;

    INSERT INTO inventory_events (
      operation_key, player_id, item_id, variant, delta_quantity,
      quantity_after, version_after, source, source_entity_type,
      source_entity_id, metadata
    )
    SELECT operation_key_value, raw_stack.player_id, 'raw_meat', variant,
           -raw_stack.quantity, quantity, version,
           'species_meat_migration', 'migration', '0818',
           jsonb_build_object('from', 'raw_meat', 'to', 'wild_meat')
    FROM player_inventory
    WHERE player_id = raw_stack.player_id
      AND resource_type = 'raw_meat'
      AND variant IS NOT DISTINCT FROM variant_value;
  END LOOP;

  -- Slot rows are a mutable projection normally synchronized by the aggregate
  -- inventory trigger. Convert any legacy row left behind by an older repair
  -- or slot backfill directly; the two identities share the same stack cap.
  UPDATE player_inventory_slots
  SET resource_type = 'wild_meat', updated_at = migration_now
  WHERE resource_type = 'raw_meat' AND quantity > 0;

  -- Pending developer packages are another live custody projection. Preserve
  -- already-claimed Raw Meat lines as history; convert only unclaimed value.
  -- Merge into an existing Wild Meat line when the package already contains
  -- one, avoiding a duplicate identity under the package's unique index.
  FOR package_raw IN
    SELECT package_id, line_number, item_kind, variant,
           original_quantity::bigint AS original_quantity,
           remaining_quantity::bigint AS remaining_quantity
    FROM player_package_items
    WHERE canonical_item_id = 'raw_meat' AND remaining_quantity > 0
    ORDER BY package_id, line_number
  LOOP
    SELECT package_id, line_number, original_quantity::bigint AS original_quantity,
           remaining_quantity::bigint AS remaining_quantity
    INTO package_target
    FROM player_package_items
    WHERE package_id = package_raw.package_id
      AND item_kind = package_raw.item_kind
      AND canonical_item_id = 'wild_meat'
      AND variant IS NOT DISTINCT FROM package_raw.variant
    FOR UPDATE;

    IF FOUND THEN
      UPDATE player_package_items
      SET original_quantity = original_quantity + package_raw.remaining_quantity,
          remaining_quantity = remaining_quantity + package_raw.remaining_quantity,
          metadata = metadata || jsonb_build_object(
            'migration', '0818', 'from', 'raw_meat', 'to', 'wild_meat'
          )
      WHERE package_id = package_target.package_id
        AND line_number = package_target.line_number;
      UPDATE player_package_items
      SET remaining_quantity = 0,
          metadata = metadata || jsonb_build_object(
            'migration', '0818', 'from', 'raw_meat', 'to', 'wild_meat'
          )
      WHERE package_id = package_raw.package_id
        AND line_number = package_raw.line_number;
    ELSE
      UPDATE player_package_items
      SET canonical_item_id = 'wild_meat',
          metadata = metadata || jsonb_build_object(
            'migration', '0818', 'from', 'raw_meat', 'to', 'wild_meat'
          )
      WHERE package_id = package_raw.package_id
        AND line_number = package_raw.line_number
        AND canonical_item_id = 'raw_meat'
        AND remaining_quantity > 0;
    END IF;
  END LOOP;

  -- Active ground drops are immutable identities.  Sink the Raw Meat drop and
  -- recreate the live quantity as a system-owned Wild Meat drop.
  FOR drop_row IN
    SELECT d.*
    FROM world_item_drops d
    WHERE d.status = 'active'
      AND d.item_id = 'raw_meat'
      AND d.remaining_quantity > 0
    ORDER BY d.id
  LOOP
    INSERT INTO world_item_movements (
      drop_id, movement_kind, item_id, variant, quantity, reason, created_at
    ) VALUES (
      drop_row.id, 'world_to_destruction', 'raw_meat', drop_row.variant,
      drop_row.remaining_quantity, 'legacy_cancelled_sink', migration_now
    ) ON CONFLICT DO NOTHING;

    UPDATE world_item_drops
    SET status = 'cancelled', remaining_quantity = 0, expired_at = migration_now
    WHERE id = drop_row.id AND status = 'active';

    IF drop_row.expires_at > migration_now THEN
      new_drop_id := gen_random_uuid();
      operation_key_value := 'migration:0818:raw-meat-drop:' || drop_row.id::text;

      INSERT INTO inventory_operations (
        operation_key, player_id, source, source_entity_type, source_entity_id, metadata
      ) VALUES (
        operation_key_value, drop_row.dropped_by, 'world_system_drop',
        'world_item_drop', new_drop_id::text,
        jsonb_build_object('migration', '0818', 'fromDropId', drop_row.id,
                           'from', 'raw_meat', 'to', 'wild_meat')
      ) ON CONFLICT (operation_key) DO NOTHING;

      INSERT INTO world_item_drops (
        id, operation_key, dropped_by, region_code, zone_id, pile_id, pile_order,
        item_id, variant, original_quantity, remaining_quantity, status,
        lat, lon, geom, created_at, expires_at
      ) VALUES (
        new_drop_id, operation_key_value, drop_row.dropped_by,
        drop_row.region_code, drop_row.zone_id, drop_row.pile_id, drop_row.pile_order,
        'wild_meat', drop_row.variant, drop_row.remaining_quantity,
        drop_row.remaining_quantity, 'active', drop_row.lat, drop_row.lon,
        drop_row.geom, drop_row.created_at, drop_row.expires_at
      ) ON CONFLICT (id) DO NOTHING;

      INSERT INTO world_item_system_drop_sources (
        drop_id, operation_key, source_entity_type, source_entity_id, reason, created_at
      ) VALUES (
        new_drop_id, operation_key_value, 'world_item_drop', drop_row.id::text,
        'raw_meat_to_wild_meat_migration', migration_now
      ) ON CONFLICT DO NOTHING;

      INSERT INTO world_item_movements (
        drop_id, movement_kind, operation_key, player_id, item_id, variant,
        quantity, reason, created_at
      ) VALUES (
        new_drop_id, 'system_to_world', operation_key_value, drop_row.dropped_by,
        'wild_meat', drop_row.variant, drop_row.remaining_quantity,
        'raw_meat_to_wild_meat_migration', migration_now
      ) ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;

  -- Open Raw Meat orders are cancelled through the existing market settlement
  -- shape.  Sell escrow returns Wild Meat; buy escrow returns its exact gold.
  FOR order_row IN
    SELECT o.*, e.asset_kind AS escrow_asset_kind,
           e.remaining_amount::bigint AS escrow_remaining
    FROM market_orders o
    JOIN market_order_escrows e ON e.order_id = o.order_id
    WHERE o.status IN ('open', 'partially_filled')
      AND o.item_id = 'raw_meat'
    ORDER BY o.order_id
  LOOP
    amount_value := order_row.escrow_remaining;
    IF amount_value <= 0 THEN
      RAISE EXCEPTION 'active Raw Meat market order % has no remaining escrow', order_row.order_id;
    END IF;

    IF order_row.side = 'sell' THEN
      IF order_row.escrow_asset_kind <> 'item' THEN
        RAISE EXCEPTION 'Raw Meat sell order % has a non-item escrow', order_row.order_id;
      END IF;
      operation_key_value := 'market-cancel-item:' || order_row.order_id::text;
      INSERT INTO inventory_operations (
        operation_key, player_id, source, source_entity_type, source_entity_id, metadata
      ) VALUES (
        operation_key_value, order_row.player_id, 'market_manual_cancellation',
        'market_order', order_row.order_id::text,
        jsonb_build_object('migration', '0818', 'orderId', order_row.order_id)
      ) ON CONFLICT (operation_key) DO NOTHING;

      IF NOT EXISTS (
        SELECT 1 FROM inventory_events WHERE inventory_events.operation_key = operation_key_value
      ) THEN
        INSERT INTO player_inventory (
          player_id, resource_type, variant, quantity, version, updated_at
        ) VALUES (order_row.player_id, 'wild_meat', COALESCE(order_row.variant, 'default'), 0, 0, migration_now)
        ON CONFLICT (player_id, resource_type, variant) DO NOTHING;
        UPDATE player_inventory
        SET quantity = quantity + amount_value,
            version = COALESCE(version, 0) + 1,
            updated_at = migration_now
        WHERE player_id = order_row.player_id
          AND resource_type = 'wild_meat'
          AND variant = COALESCE(order_row.variant, 'default')
        RETURNING quantity::bigint, version::bigint INTO target_stack;
        INSERT INTO inventory_events (
          operation_key, player_id, item_id, variant, delta_quantity,
          quantity_after, version_after, source, source_entity_type,
          source_entity_id, metadata
        ) VALUES (
          operation_key_value, order_row.player_id, 'wild_meat',
          COALESCE(order_row.variant, 'default'), amount_value,
          target_stack.quantity, target_stack.version,
          'market_manual_cancellation', 'market_order', order_row.order_id::text,
          jsonb_build_object('migration', '0818', 'from', 'raw_meat', 'to', 'wild_meat')
        );
      END IF;
    ELSE
      IF order_row.escrow_asset_kind <> 'gold' THEN
        RAISE EXCEPTION 'Raw Meat buy order % has a non-gold escrow', order_row.order_id;
      END IF;
      operation_key_value := 'market-cancel-gold:' || order_row.order_id::text;
      INSERT INTO player_wallets (player_id, account_id, gold_balance, version)
      VALUES (order_row.player_id, order_row.account_id, 0, 0)
      ON CONFLICT (player_id) DO NOTHING;
      IF NOT EXISTS (
        SELECT 1 FROM wallet_events
        WHERE wallet_events.operation_key = operation_key_value
          AND wallet_events.player_id = order_row.player_id
      ) THEN
        SELECT gold_balance::bigint, version::bigint
        INTO wallet_balance, wallet_version
        FROM player_wallets
        WHERE player_id = order_row.player_id
          AND account_id = order_row.account_id
        FOR UPDATE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'Raw Meat buy order % has no authoritative wallet', order_row.order_id;
        END IF;
        UPDATE player_wallets
        SET gold_balance = wallet_balance + amount_value,
            version = wallet_version + 1,
            updated_at = migration_now
        WHERE player_id = order_row.player_id;
        INSERT INTO wallet_events (
          operation_key, player_id, account_id, delta_gold, balance_after,
          version_after, reason, market_order_id, metadata
        ) VALUES (
          operation_key_value, order_row.player_id, order_row.account_id, amount_value,
          wallet_balance + amount_value, wallet_version + 1,
          'market_manual_cancellation', order_row.order_id,
          jsonb_build_object('migration', '0818')
        );
      END IF;
    END IF;

    SELECT group_row.ledger_group_id INTO ledger_group_id_value
    FROM market_ledger_groups AS group_row
    WHERE group_row.group_type = 'cancel' AND group_row.order_id = order_row.order_id;
    IF NOT FOUND THEN
      ledger_group_id_value := gen_random_uuid();
      INSERT INTO market_ledger_groups (
        ledger_group_id, group_type, request_id, order_id, rules_version,
        order_fee_policy_id, order_fee_policy_version
      ) VALUES (
        ledger_group_id_value, 'cancel', 'migration:0818:cancel:' || order_row.order_id::text,
        order_row.order_id, order_row.rules_version,
        order_row.fee_policy_id, order_row.fee_policy_version
      );
      IF order_row.side = 'sell' THEN
        INSERT INTO market_ledger_entries (
          ledger_group_id, asset_kind, item_identity, amount, account_location,
          player_id, order_id, reason
        ) VALUES
          (ledger_group_id_value, 'item', order_row.item_identity, -amount_value,
           'sell_escrow', order_row.player_id, order_row.order_id, 'raw_meat_to_wild_meat_cancel_debit'),
          (ledger_group_id_value, 'item', order_row.item_identity, amount_value,
           'player_inventory', order_row.player_id, order_row.order_id, 'raw_meat_to_wild_meat_cancel_credit');
      ELSE
        INSERT INTO market_ledger_entries (
          ledger_group_id, asset_kind, item_identity, amount, account_location,
          player_id, order_id, reason
        ) VALUES
          (ledger_group_id_value, 'gold', NULL, -amount_value, 'buy_escrow',
           order_row.player_id, order_row.order_id, 'raw_meat_to_wild_meat_cancel_debit'),
          (ledger_group_id_value, 'gold', NULL, amount_value, 'player_wallet',
           order_row.player_id, order_row.order_id, 'raw_meat_to_wild_meat_cancel_credit');
      END IF;
    END IF;

    UPDATE market_order_escrows
    SET remaining_amount = 0, updated_at = migration_now
    WHERE order_id = order_row.order_id AND remaining_amount > 0;
    UPDATE market_orders
    SET status = 'cancelled', cancelled_at = migration_now
    WHERE order_id = order_row.order_id
      AND status IN ('open', 'partially_filled');
    UPDATE market_order_books
    SET book_version = book_version + 1, updated_at = migration_now
    WHERE book_id = order_row.book_id AND venue_id = order_row.venue_id;
  END LOOP;

  -- Unclaimed trade/cancellation collections are active custody. Claim them
  -- through the normal claim ledger, while the immutable ledger retains Raw
  -- Meat as historical item identity.
  FOR collection_row IN
    SELECT collection.*
    FROM market_collections collection
    WHERE collection.asset_kind = 'item'
      AND collection.item_id = 'raw_meat'
      AND collection.remaining_amount > 0
    ORDER BY collection.collection_id
  LOOP
    amount_value := collection_row.remaining_amount;
    SELECT account_id INTO player_account_id
    FROM players WHERE id = collection_row.player_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Raw Meat market collection % has no player account', collection_row.collection_id;
    END IF;
    request_id_value := 'migration-0818-raw-meat-collection-' || collection_row.collection_id::text;
    claim_id_value := md5('migration:0818:claim:' || collection_row.collection_id::text)::uuid;
    operation_key_value := 'market-claim-items:' || player_account_id::text || ':' || request_id_value;

    INSERT INTO market_claims (
      claim_id, player_id, account_id, client_request_id, asset_scope,
      item_units_claimed, gold_claimed, result, venue_id
    ) VALUES (
      claim_id_value, collection_row.player_id, player_account_id, request_id_value,
      'items', amount_value, 0,
      jsonb_build_object('itemUnitsClaimed', amount_value::text, 'goldClaimed', '0'),
      collection_row.venue_id
    ) ON CONFLICT (claim_id) DO NOTHING;

    INSERT INTO inventory_operations (
      operation_key, player_id, source, source_entity_type, source_entity_id, metadata
    ) VALUES (
      operation_key_value, collection_row.player_id, 'market_collection_claim',
      'market_claim', request_id_value,
      jsonb_build_object('migration', '0818', 'collectionId', collection_row.collection_id)
    ) ON CONFLICT (operation_key) DO NOTHING;

    IF NOT EXISTS (
      SELECT 1 FROM inventory_events WHERE inventory_events.operation_key = operation_key_value
    ) THEN
      INSERT INTO player_inventory (
        player_id, resource_type, variant, quantity, version, updated_at
      ) VALUES (
        collection_row.player_id, 'raw_meat', COALESCE(collection_row.variant, 'default'), 0, 0, migration_now
      ) ON CONFLICT (player_id, resource_type, variant) DO NOTHING;
      UPDATE player_inventory
      SET quantity = quantity + amount_value,
          version = COALESCE(version, 0) + 1,
          updated_at = migration_now
      WHERE player_id = collection_row.player_id
        AND resource_type = 'raw_meat'
        AND variant = COALESCE(collection_row.variant, 'default')
      RETURNING quantity::bigint, version::bigint INTO target_stack;
      INSERT INTO inventory_events (
        operation_key, player_id, item_id, variant, delta_quantity,
        quantity_after, version_after, source, source_entity_type,
        source_entity_id, metadata
      ) VALUES (
        operation_key_value, collection_row.player_id, 'raw_meat',
        COALESCE(collection_row.variant, 'default'), amount_value,
        target_stack.quantity, target_stack.version,
        'market_collection_claim', 'market_claim', request_id_value,
        jsonb_build_object('migration', '0818', 'from', 'raw_meat', 'to', 'wild_meat')
      );
    END IF;

    UPDATE market_collections
    SET remaining_amount = 0, claimed_at = migration_now, updated_at = migration_now
    WHERE collection_id = collection_row.collection_id AND remaining_amount > 0;

    SELECT group_row.ledger_group_id INTO ledger_group_id_value
    FROM market_ledger_groups AS group_row
    WHERE group_row.group_type = 'claim' AND group_row.claim_id = claim_id_value;
    IF NOT FOUND THEN
      ledger_group_id_value := gen_random_uuid();
      INSERT INTO market_ledger_groups (
        ledger_group_id, group_type, request_id, claim_id, rules_version
      ) VALUES (
        ledger_group_id_value, 'claim', request_id_value, claim_id_value, 1
      );
      INSERT INTO market_ledger_entries (
        ledger_group_id, asset_kind, item_identity, amount, account_location,
        player_id, collection_id, reason
      ) VALUES
        (ledger_group_id_value, 'item', collection_row.item_identity, -amount_value,
         CASE WHEN collection_row.reason IN ('sell_cancel_return', 'sell_expired_return')
           THEN 'return_collection' ELSE 'buyer_collection' END,
         collection_row.player_id, collection_row.collection_id, 'raw_meat_to_wild_meat_claim_debit'),
        (ledger_group_id_value, 'item', collection_row.item_identity, amount_value,
         'player_inventory', collection_row.player_id, NULL, 'raw_meat_to_wild_meat_claim_credit');
    END IF;

    -- The claim ledger intentionally remains a balanced Raw Meat historical
    -- transfer. Convert the just-claimed live stack through a distinct
    -- migration operation so claim provenance can validate before commit.
    operation_key_value := 'migration:0818:raw-meat-collection-to-wild-meat:'
      || collection_row.collection_id::text;
    INSERT INTO inventory_operations (
      operation_key, player_id, source, source_entity_type, source_entity_id, metadata
    ) VALUES (
      operation_key_value, collection_row.player_id, 'species_meat_migration',
      'market_collection', collection_row.collection_id::text,
      jsonb_build_object('migration', '0818', 'from', 'raw_meat', 'to', 'wild_meat')
    ) ON CONFLICT (operation_key) DO NOTHING;
    IF NOT EXISTS (
      SELECT 1 FROM inventory_events WHERE inventory_events.operation_key = operation_key_value
    ) THEN
      INSERT INTO player_inventory (
        player_id, resource_type, variant, quantity, version, updated_at
      ) VALUES (
        collection_row.player_id, 'wild_meat', COALESCE(collection_row.variant, 'default'), 0, 0, migration_now
      ) ON CONFLICT (player_id, resource_type, variant) DO NOTHING;
      UPDATE player_inventory
      SET quantity = quantity + amount_value,
          version = COALESCE(version, 0) + 1,
          updated_at = migration_now
      WHERE player_id = collection_row.player_id
        AND resource_type = 'wild_meat'
        AND variant = COALESCE(collection_row.variant, 'default')
      RETURNING quantity::bigint, version::bigint INTO target_stack;
      INSERT INTO inventory_events (
        operation_key, player_id, item_id, variant, delta_quantity,
        quantity_after, version_after, source, source_entity_type,
        source_entity_id, metadata
      ) VALUES (
        operation_key_value, collection_row.player_id, 'wild_meat',
        COALESCE(collection_row.variant, 'default'), amount_value,
        target_stack.quantity, target_stack.version,
        'species_meat_migration', 'market_collection', collection_row.collection_id::text,
        jsonb_build_object('from', 'raw_meat', 'to', 'wild_meat')
      );

      UPDATE player_inventory
      SET quantity = quantity - amount_value,
          version = COALESCE(version, 0) + 1,
          updated_at = migration_now
      WHERE player_id = collection_row.player_id
        AND resource_type = 'raw_meat'
        AND variant IS NOT DISTINCT FROM COALESCE(collection_row.variant, 'default');
      INSERT INTO inventory_events (
        operation_key, player_id, item_id, variant, delta_quantity,
        quantity_after, version_after, source, source_entity_type,
        source_entity_id, metadata
      )
      SELECT operation_key_value, collection_row.player_id, 'raw_meat', variant,
             -amount_value, quantity, version,
             'species_meat_migration', 'market_collection', collection_row.collection_id::text,
             jsonb_build_object('from', 'raw_meat', 'to', 'wild_meat')
      FROM player_inventory
      WHERE player_id = collection_row.player_id
        AND resource_type = 'raw_meat'
        AND variant IS NOT DISTINCT FROM COALESCE(collection_row.variant, 'default');
    END IF;
  END LOOP;

  -- Kingdom balances are mutable projections; donation and expenditure
  -- ledgers remain immutable Raw Meat history.
  FOR raw_stack IN
    SELECT kingdom_id, COALESCE(variant, 'default') AS variant,
           quantity::bigint AS quantity
    FROM kingdom_treasury_balances
    WHERE resource_type = 'raw_meat' AND quantity > 0
    ORDER BY kingdom_id, COALESCE(variant, 'default')
  LOOP
    INSERT INTO kingdom_treasury_balances (
      kingdom_id, resource_type, variant, quantity, updated_at
    ) VALUES (
      raw_stack.kingdom_id, 'wild_meat', raw_stack.variant, raw_stack.quantity, migration_now
    ) ON CONFLICT (kingdom_id, resource_type, variant)
      DO UPDATE SET quantity = kingdom_treasury_balances.quantity + EXCLUDED.quantity,
                    updated_at = EXCLUDED.updated_at;
    UPDATE kingdom_treasury_balances
    SET quantity = 0, updated_at = migration_now
    WHERE kingdom_id = raw_stack.kingdom_id
      AND resource_type = 'raw_meat'
      AND variant = raw_stack.variant;
  END LOOP;

  -- Freeze the retired Raw Meat books after all live escrow/collections have
  -- been settled.  Existing trade and ledger rows are intentionally retained.
  PERFORM set_config(
    'ash_atlas.market_control_operator', 'system:migration:0818-raw-meat-to-wild-meat', true
  );
  PERFORM set_config(
    'ash_atlas.market_control_reason',
    'Retire legacy Raw Meat market books after 1:1 Wild Meat conversion', true
  );
  PERFORM set_config(
    'ash_atlas.market_control_incident_id', 'migration:0818:raw-meat-to-wild-meat', true
  );
  UPDATE market_order_books
  SET frozen = true,
      sensitive_reason = 'Retire legacy Raw Meat market books after 1:1 Wild Meat conversion',
      updated_at = migration_now
  WHERE item_id = 'raw_meat' OR item_identity = 'raw_meat';
END;
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM player_inventory WHERE resource_type = 'raw_meat' AND quantity > 0)
     OR EXISTS (SELECT 1 FROM player_inventory_slots WHERE resource_type = 'raw_meat' AND quantity > 0)
     OR EXISTS (SELECT 1 FROM manor_storage_stacks WHERE item_id = 'raw_meat')
     OR EXISTS (SELECT 1 FROM city_warehouse_stacks WHERE item_id = 'raw_meat')
     OR EXISTS (SELECT 1 FROM world_item_drops WHERE status = 'active' AND item_id = 'raw_meat' AND remaining_quantity > 0)
     OR EXISTS (SELECT 1 FROM market_orders WHERE status IN ('open', 'partially_filled') AND item_id = 'raw_meat')
     OR EXISTS (SELECT 1 FROM market_collections WHERE remaining_amount > 0 AND item_id = 'raw_meat')
     OR EXISTS (SELECT 1 FROM market_order_escrows escrow
       JOIN market_orders order_row ON order_row.order_id = escrow.order_id
       WHERE escrow.remaining_amount > 0 AND order_row.item_id = 'raw_meat')
     OR EXISTS (SELECT 1 FROM kingdom_treasury_balances WHERE resource_type = 'raw_meat' AND quantity > 0)
     OR EXISTS (SELECT 1 FROM player_package_items
       WHERE canonical_item_id = 'raw_meat' AND remaining_quantity > 0)
     OR EXISTS (SELECT 1 FROM market_order_books
       WHERE (item_id = 'raw_meat' OR item_identity = 'raw_meat') AND NOT frozen) THEN
    RAISE EXCEPTION '0818 left live legacy Raw Meat custody';
  END IF;
END;
$$;
