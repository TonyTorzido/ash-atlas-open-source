-- Forward-only legacy meat retirement. Convert active custody one-for-one to
-- the matching current cut; unmapped Wild/Raw Meat is retired. Historical
-- inventory slots, Manor storage, queued Kitchen jobs, immutable operations,
-- market identity/history and migration hashes remain unchanged. Existing Kitchen jobs
-- finish with their originally reserved input and promised Simple Food output.
-- Settlement follows 0828's audited inventory/market ledger boundaries.
SET CONSTRAINTS ALL DEFERRED;

LOCK TABLE item_definitions, player_inventory,
  inventory_operations, inventory_events,
  city_warehouse_stacks, world_item_drops,
  world_item_movements, world_item_system_drop_sources, market_order_books,
  market_orders, market_order_escrows, market_collections, market_claims,
  market_ledger_groups, market_ledger_entries, market_audit_events,
  player_wallets, wallet_events, kingdom_treasury_balances,
  player_package_items
  IN SHARE ROW EXCLUSIVE MODE;

CREATE TEMP TABLE meat_replacements (
  source_item text PRIMARY KEY,
  target_item text NOT NULL,
  quantity_multiplier bigint NOT NULL CHECK (quantity_multiplier > 0)
) ON COMMIT DROP;

INSERT INTO meat_replacements (source_item, target_item, quantity_multiplier)
VALUES
  ('deer_meat', 'deer_cut', 1),
  ('wolf_meat', 'wolf_cut', 1),
  ('hog_meat', 'hog_cut', 1),
  ('bear_meat', 'bear_cut', 1),
  ('alligator_meat', 'alligator_tail', 1),
  ('squid_meat', 'squid_cut', 1),
  ('squid_flesh', 'squid_cut', 1),
  -- No species equivalent: return market custody first, then retire it below.
  ('wild_meat', 'wild_meat', 1),
  ('raw_meat', 'raw_meat', 1);

DO $$
DECLARE
  migration_now timestamptz := clock_timestamp();
  source_row record;
  target_stack record;
  storage_row record;
  package_row record;
  drop_row record;
  order_row record;
  collection_row record;
  treasury_row record;
  replacement_row record;
  operation_key_value text;
  request_id_value text;
  claim_id_value uuid;
  ledger_group_id_value uuid;
  new_drop_id uuid;
  player_account_id uuid;
  variant_value text;
  target_quantity bigint;
  stack_quantity_remaining bigint;
  amount_value bigint;
  wallet_balance bigint;
  wallet_version bigint;
  free_slot integer;
  slot_capacity integer;
BEGIN
  -- Convert aggregate player inventory through the append-only operation and
  -- event chain.  The operation key makes a second execution a no-op.
  FOR source_row IN
    SELECT inventory.player_id, inventory.resource_type,
           inventory.variant AS source_variant,
           COALESCE(inventory.variant, 'default') AS variant,
           inventory.quantity::bigint AS quantity,
           replacement.target_item,
           replacement.quantity_multiplier
    FROM player_inventory inventory
    JOIN meat_replacements replacement
      ON replacement.source_item = inventory.resource_type
    WHERE inventory.quantity > 0 AND replacement.source_item <> replacement.target_item
    ORDER BY inventory.player_id, inventory.resource_type,
             COALESCE(inventory.variant, 'default')
  LOOP
    IF source_row.quantity > floor(9007199254740991::numeric / source_row.quantity_multiplier) THEN
      RAISE EXCEPTION 'Legacy meat migration quantity exceeds safe integer for %/%',
        source_row.player_id, source_row.resource_type;
    END IF;
    target_quantity := source_row.quantity * source_row.quantity_multiplier;
    operation_key_value := 'migration:0862:meat-to-cut:'
      || source_row.resource_type || ':' || source_row.player_id || ':' || source_row.variant;

    INSERT INTO inventory_operations (
      operation_key, player_id, source, source_entity_type, source_entity_id, metadata
    ) VALUES (
      operation_key_value, source_row.player_id, 'legacy_meat_retirement',
      'migration', '0862',
      jsonb_build_object(
        'from', source_row.resource_type, 'to', source_row.target_item,
        'quantityMultiplier', source_row.quantity_multiplier, 'variant', source_row.variant
      )
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
      source_row.player_id, source_row.target_item, source_row.variant, 0, 0, migration_now
    ) ON CONFLICT (player_id, resource_type, variant) DO NOTHING;

    UPDATE player_inventory
    SET quantity = quantity + target_quantity,
        version = COALESCE(version, 0) + 1,
        updated_at = migration_now
    WHERE player_id = source_row.player_id
      AND resource_type = source_row.target_item
      AND variant = source_row.variant
    RETURNING quantity::bigint, version::bigint INTO target_stack;

    INSERT INTO inventory_events (
      operation_key, player_id, item_id, variant, delta_quantity,
      quantity_after, version_after, source, source_entity_type,
      source_entity_id, metadata
    ) VALUES (
      operation_key_value, source_row.player_id, source_row.target_item,
      source_row.variant, target_quantity, target_stack.quantity, target_stack.version,
      'legacy_meat_retirement', 'migration', '0862',
      jsonb_build_object('from', source_row.resource_type, 'to', source_row.target_item)
    );

    UPDATE player_inventory
    SET quantity = 0,
        version = COALESCE(version, 0) + 1,
        updated_at = migration_now
    WHERE player_id = source_row.player_id
      AND resource_type = source_row.resource_type
      AND variant IS NOT DISTINCT FROM source_row.source_variant;

    INSERT INTO inventory_events (
      operation_key, player_id, item_id, variant, delta_quantity,
      quantity_after, version_after, source, source_entity_type,
      source_entity_id, metadata
    )
    SELECT operation_key_value, source_row.player_id, source_row.resource_type,
           COALESCE(inventory.variant, 'default'), -source_row.quantity,
           inventory.quantity, inventory.version, 'legacy_meat_retirement',
           'migration', '0862',
           jsonb_build_object('from', source_row.resource_type, 'to', source_row.target_item)
    FROM player_inventory inventory
    WHERE inventory.player_id = source_row.player_id
      AND inventory.resource_type = source_row.resource_type
      AND inventory.variant IS NOT DISTINCT FROM source_row.source_variant;
  END LOOP;

  -- One-for-one conversion preserves warehouse stack identity, quantity and slot.
  -- Player slots and Manor storage are archival and remain untouched.
  UPDATE city_warehouse_stacks stacks
  SET item_id = replacement.target_item,
      version = stacks.version + 1,
      updated_at = migration_now
  FROM meat_replacements replacement
  WHERE stacks.item_id = replacement.source_item
    AND stacks.quantity > 0 AND replacement.source_item <> replacement.target_item;

  -- Unclaimed package lines are live custody.  Merge into an existing target
  -- line where possible; otherwise retarget the line and retain migration
  -- provenance in metadata.
  FOR package_row IN
    SELECT package_items.*, replacement.target_item, replacement.quantity_multiplier
    FROM player_package_items package_items
    JOIN meat_replacements replacement
      ON replacement.source_item = package_items.canonical_item_id
    WHERE package_items.remaining_quantity > 0
    ORDER BY package_items.package_id, package_items.line_number
  LOOP
    IF package_row.canonical_item_id = package_row.target_item THEN
      UPDATE player_package_items SET remaining_quantity = 0,
        metadata = metadata || '{"retiredByMigration":"0862","reason":"no_current_species_cut"}'::jsonb
      WHERE package_id = package_row.package_id AND line_number = package_row.line_number;
      CONTINUE;
    END IF;
    target_quantity := package_row.remaining_quantity * package_row.quantity_multiplier;
    SELECT package_id, line_number INTO replacement_row
    FROM player_package_items target
    WHERE target.package_id = package_row.package_id
      AND target.item_kind = package_row.item_kind
      AND target.canonical_item_id = package_row.target_item
      AND target.variant IS NOT DISTINCT FROM package_row.variant
    FOR UPDATE;
    IF FOUND THEN
      UPDATE player_package_items
      SET original_quantity = original_quantity + target_quantity,
          remaining_quantity = remaining_quantity + target_quantity,
          metadata = metadata || jsonb_build_object(
            'migration', '0862', 'from', package_row.canonical_item_id,
            'to', package_row.target_item
          )
      WHERE package_id = replacement_row.package_id
        AND line_number = replacement_row.line_number;
      UPDATE player_package_items
      SET remaining_quantity = 0,
          metadata = metadata || jsonb_build_object(
            'migration', '0862', 'from', package_row.canonical_item_id,
            'to', package_row.target_item
          )
      WHERE package_id = package_row.package_id
        AND line_number = package_row.line_number;
    ELSE
      UPDATE player_package_items
      SET canonical_item_id = package_row.target_item,
          original_quantity = (original_quantity - remaining_quantity) + target_quantity,
          remaining_quantity = target_quantity,
          metadata = metadata || jsonb_build_object(
            'migration', '0862', 'from', package_row.canonical_item_id,
            'to', package_row.target_item
          )
      WHERE package_id = package_row.package_id
        AND line_number = package_row.line_number;
    END IF;
  END LOOP;

  -- Ground drops are immutable identities.  Sink the old active drop and
  -- recreate the remaining quantity as a system-owned cut drop.
  FOR drop_row IN
    SELECT drops.*, replacement.target_item, replacement.quantity_multiplier
    FROM world_item_drops drops
    JOIN meat_replacements replacement ON replacement.source_item = drops.item_id
    WHERE drops.status = 'active' AND drops.remaining_quantity > 0
    ORDER BY drops.id
  LOOP
    target_quantity := drop_row.remaining_quantity * drop_row.quantity_multiplier;
    INSERT INTO world_item_movements (
      drop_id, movement_kind, item_id, variant, quantity, reason, created_at
    ) VALUES (
      drop_row.id, 'world_to_destruction', drop_row.item_id, drop_row.variant,
      drop_row.remaining_quantity, 'legacy_cancelled_sink', migration_now
    ) ON CONFLICT DO NOTHING;

    UPDATE world_item_drops
    SET status = 'cancelled', remaining_quantity = 0, expired_at = migration_now
    WHERE id = drop_row.id AND status = 'active';

    IF drop_row.item_id <> drop_row.target_item AND
       (drop_row.expires_at IS NULL OR drop_row.expires_at > migration_now) THEN
      new_drop_id := gen_random_uuid();
      operation_key_value := 'migration:0862:legacy-meat-drop:' || drop_row.id::text;
      INSERT INTO inventory_operations (
        operation_key, player_id, source, source_entity_type, source_entity_id, metadata
      ) VALUES (
        operation_key_value, drop_row.dropped_by, 'world_system_drop',
        'world_item_drop', new_drop_id::text,
        jsonb_build_object('migration', '0862', 'fromDropId', drop_row.id,
          'from', drop_row.item_id, 'to', drop_row.target_item,
          'quantityMultiplier', drop_row.quantity_multiplier)
      ) ON CONFLICT (operation_key) DO NOTHING;
      INSERT INTO world_item_drops (
        id, operation_key, dropped_by, region_code, zone_id, pile_id, pile_order,
        item_id, variant, original_quantity, remaining_quantity, status,
        lat, lon, geom, created_at, expires_at, manor_id, space_id, local_x, local_y
      ) VALUES (
        new_drop_id, operation_key_value, drop_row.dropped_by, drop_row.region_code,
        drop_row.zone_id, drop_row.pile_id, drop_row.pile_order,
        drop_row.target_item, drop_row.variant, target_quantity, target_quantity,
        'active', drop_row.lat, drop_row.lon, drop_row.geom,
        drop_row.created_at, drop_row.expires_at, drop_row.manor_id, drop_row.space_id, drop_row.local_x, drop_row.local_y
      ) ON CONFLICT (id) DO NOTHING;
      INSERT INTO world_item_system_drop_sources (
        drop_id, operation_key, source_entity_type, source_entity_id, reason, created_at
      ) VALUES (
        new_drop_id, operation_key_value, 'world_item_drop', drop_row.id::text,
        'meat_to_cut_migration', migration_now
      ) ON CONFLICT DO NOTHING;
      INSERT INTO world_item_movements (
        drop_id, movement_kind, operation_key, player_id, item_id, variant,
        quantity, reason, created_at
      ) VALUES (
        new_drop_id, 'system_to_world', operation_key_value, drop_row.dropped_by,
        drop_row.target_item, drop_row.variant, target_quantity,
        'meat_to_cut_migration', migration_now
      ) ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;

  -- Cancel open legacy meat orders through the established escrow and ledger
  -- shape.  Sell escrow returns current cuts; buy escrow returns gold.
  FOR order_row IN
    SELECT orders.*, escrows.asset_kind AS escrow_asset_kind,
           escrows.remaining_amount::bigint AS escrow_remaining,
           replacement.target_item, replacement.quantity_multiplier
    FROM market_orders orders
    JOIN market_order_escrows escrows ON escrows.order_id = orders.order_id
    JOIN meat_replacements replacement ON replacement.source_item = orders.item_id
    WHERE orders.status IN ('open', 'partially_filled')
    ORDER BY orders.order_id
  LOOP
    IF order_row.escrow_remaining <= 0 THEN
      RAISE EXCEPTION 'Active legacy meat market order % has no remaining escrow', order_row.order_id;
    END IF;
    amount_value := order_row.escrow_remaining;
    IF order_row.side = 'sell' THEN
      IF order_row.escrow_asset_kind <> 'item' THEN
        RAISE EXCEPTION 'Legacy meat sell order % has a non-item escrow', order_row.order_id;
      END IF;
      target_quantity := amount_value * order_row.quantity_multiplier;
      operation_key_value := 'market-cancel-item:' || order_row.order_id::text;
      INSERT INTO inventory_operations (
        operation_key, player_id, source, source_entity_type, source_entity_id, metadata
      ) VALUES (
        operation_key_value, order_row.player_id, 'market_manual_cancellation',
        'market_order', order_row.order_id::text,
        jsonb_build_object('migration', '0862', 'from', order_row.item_id,
          'to', order_row.target_item, 'quantityMultiplier', order_row.quantity_multiplier)
      ) ON CONFLICT (operation_key) DO NOTHING;
      IF NOT EXISTS (
        SELECT 1 FROM inventory_events WHERE inventory_events.operation_key = operation_key_value
      ) THEN
        variant_value := COALESCE(order_row.variant, 'default');
        INSERT INTO player_inventory (
          player_id, resource_type, variant, quantity, version, updated_at
        ) VALUES (order_row.player_id, order_row.target_item, variant_value, 0, 0, migration_now)
        ON CONFLICT (player_id, resource_type, variant) DO NOTHING;
        UPDATE player_inventory
        SET quantity = quantity + target_quantity, version = version + 1, updated_at = migration_now
        WHERE player_id = order_row.player_id
          AND resource_type = order_row.target_item AND variant = variant_value
        RETURNING quantity::bigint, version::bigint INTO target_stack;
        INSERT INTO inventory_events (
          operation_key, player_id, item_id, variant, delta_quantity,
          quantity_after, version_after, source, source_entity_type,
          source_entity_id, metadata
        ) VALUES (
          operation_key_value, order_row.player_id, order_row.target_item, variant_value,
          target_quantity, target_stack.quantity, target_stack.version,
          'market_manual_cancellation', 'market_order', order_row.order_id::text,
          jsonb_build_object('migration', '0862', 'from', order_row.item_id, 'to', order_row.target_item)
        );
      END IF;
    ELSE
      IF order_row.escrow_asset_kind <> 'gold' THEN
        RAISE EXCEPTION 'Legacy meat buy order % has a non-gold escrow', order_row.order_id;
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
        SELECT gold_balance::bigint, version::bigint INTO wallet_balance, wallet_version
        FROM player_wallets
        WHERE player_id = order_row.player_id AND account_id = order_row.account_id
        FOR UPDATE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'Legacy meat buy order % has no authoritative wallet', order_row.order_id;
        END IF;
        UPDATE player_wallets
        SET gold_balance = wallet_balance + amount_value,
            version = wallet_version + 1, updated_at = migration_now
        WHERE player_id = order_row.player_id;
        INSERT INTO wallet_events (
          operation_key, player_id, account_id, delta_gold, balance_after,
          version_after, reason, market_order_id, metadata
        ) VALUES (
          operation_key_value, order_row.player_id, order_row.account_id, amount_value,
          wallet_balance + amount_value, wallet_version + 1,
          'market_manual_cancellation', order_row.order_id,
          jsonb_build_object('migration', '0862')
        );
      END IF;
    END IF;

    SELECT ledger_group.ledger_group_id INTO ledger_group_id_value
    FROM market_ledger_groups ledger_group
    WHERE ledger_group.group_type = 'cancel' AND ledger_group.order_id = order_row.order_id;
    IF NOT FOUND THEN
      ledger_group_id_value := gen_random_uuid();
      INSERT INTO market_ledger_groups (
        ledger_group_id, group_type, request_id, order_id, rules_version,
        order_fee_policy_id, order_fee_policy_version
      ) VALUES (
        ledger_group_id_value, 'cancel', 'migration:0862:cancel:' || order_row.order_id::text,
        order_row.order_id, order_row.rules_version,
        order_row.fee_policy_id, order_row.fee_policy_version
      );
      IF order_row.side = 'sell' THEN
        INSERT INTO market_ledger_entries (
          ledger_group_id, asset_kind, item_identity, amount, account_location,
          player_id, order_id, reason
        ) VALUES
          (ledger_group_id_value, 'item', order_row.item_identity, -amount_value,
           'sell_escrow', order_row.player_id, order_row.order_id,
           'meat_to_cut_cancel_debit'),
          (ledger_group_id_value, 'item', order_row.item_identity, amount_value,
           'player_inventory', order_row.player_id, order_row.order_id,
           'meat_to_cut_cancel_credit');
      ELSE
        INSERT INTO market_ledger_entries (
          ledger_group_id, asset_kind, item_identity, amount, account_location,
          player_id, order_id, reason
        ) VALUES
          (ledger_group_id_value, 'gold', NULL, -amount_value, 'buy_escrow',
           order_row.player_id, order_row.order_id, 'meat_to_cut_cancel_debit'),
          (ledger_group_id_value, 'gold', NULL, amount_value, 'player_wallet',
           order_row.player_id, order_row.order_id, 'meat_to_cut_cancel_credit');
      END IF;
    END IF;
    UPDATE market_order_escrows
    SET remaining_amount = 0, updated_at = migration_now
    WHERE order_id = order_row.order_id AND remaining_amount > 0;
    UPDATE market_orders
    SET status = 'cancelled', cancelled_at = migration_now
    WHERE order_id = order_row.order_id AND status IN ('open', 'partially_filled');
    UPDATE market_order_books
    SET book_version = book_version + 1, updated_at = migration_now
    WHERE book_id = order_row.book_id AND venue_id = order_row.venue_id;
  END LOOP;

  -- Settle unclaimed item collections into current cuts while keeping the
  -- collection and market ledger rows as historical legacy meat evidence.
  FOR collection_row IN
    SELECT collections.*, replacement.target_item, replacement.quantity_multiplier
    FROM market_collections collections
    JOIN meat_replacements replacement ON replacement.source_item = collections.item_id
    WHERE collections.asset_kind = 'item' AND collections.remaining_amount > 0
    ORDER BY collections.collection_id
  LOOP
    amount_value := collection_row.remaining_amount;
    target_quantity := amount_value * collection_row.quantity_multiplier;
    SELECT account_id INTO player_account_id FROM players WHERE id = collection_row.player_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Legacy meat market collection % has no player account', collection_row.collection_id;
    END IF;
    request_id_value := 'migration-0862-legacy meat-collection-' || collection_row.collection_id::text;
    claim_id_value := md5('migration:0862:claim:' || collection_row.collection_id::text)::uuid;
    operation_key_value := 'market-claim-items:' || player_account_id::text || ':' || request_id_value;
    variant_value := COALESCE(collection_row.variant, 'default');
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
      jsonb_build_object('migration', '0862', 'collectionId', collection_row.collection_id,
        'from', collection_row.item_id, 'to', collection_row.target_item)
    ) ON CONFLICT (operation_key) DO NOTHING;
    IF NOT EXISTS (
      SELECT 1 FROM inventory_events WHERE inventory_events.operation_key = operation_key_value
    ) THEN
      INSERT INTO player_inventory (
        player_id, resource_type, variant, quantity, version, updated_at
      ) VALUES (collection_row.player_id, collection_row.item_id, variant_value, 0, 0, migration_now)
      ON CONFLICT (player_id, resource_type, variant) DO NOTHING;
      UPDATE player_inventory
      SET quantity = quantity + amount_value, version = version + 1, updated_at = migration_now
      WHERE player_id = collection_row.player_id
        AND resource_type = collection_row.item_id AND variant = variant_value
      RETURNING quantity::bigint, version::bigint INTO target_stack;
      INSERT INTO inventory_events (
        operation_key, player_id, item_id, variant, delta_quantity,
        quantity_after, version_after, source, source_entity_type,
        source_entity_id, metadata
      ) VALUES (
        operation_key_value, collection_row.player_id, collection_row.item_id, variant_value,
        amount_value, target_stack.quantity, target_stack.version,
        'market_collection_claim', 'market_claim', request_id_value,
        jsonb_build_object('migration', '0862', 'from', collection_row.item_id,
          'to', collection_row.target_item)
      );
    END IF;
    UPDATE market_collections
    SET remaining_amount = 0, claimed_at = migration_now, updated_at = migration_now
    WHERE collection_id = collection_row.collection_id AND remaining_amount > 0;
    SELECT ledger_group.ledger_group_id INTO ledger_group_id_value
    FROM market_ledger_groups ledger_group
    WHERE ledger_group.group_type = 'claim' AND ledger_group.claim_id = claim_id_value;
    IF NOT FOUND THEN
      ledger_group_id_value := gen_random_uuid();
      INSERT INTO market_ledger_groups (
        ledger_group_id, group_type, request_id, claim_id, rules_version
      ) VALUES (ledger_group_id_value, 'claim', request_id_value, claim_id_value, 1);
      INSERT INTO market_ledger_entries (
        ledger_group_id, asset_kind, item_identity, amount, account_location,
        player_id, collection_id, reason
      ) VALUES
        (ledger_group_id_value, 'item', collection_row.item_identity, -amount_value,
         CASE WHEN collection_row.reason IN ('sell_cancel_return', 'sell_expired_return')
           THEN 'return_collection' ELSE 'buyer_collection' END,
         collection_row.player_id, collection_row.collection_id,
         'meat_to_cut_claim_debit'),
        (ledger_group_id_value, 'item', collection_row.item_identity, amount_value,
         'player_inventory', collection_row.player_id, NULL,
         'meat_to_cut_claim_credit');
    END IF;

    IF collection_row.item_id = collection_row.target_item THEN CONTINUE; END IF;
    -- Keep the market claim's historical legacy meat boundary balanced, then
    -- convert the claimed live custody through a separate migration operation
    -- so market reconciliation can still validate the original claim.
    operation_key_value := 'migration:0862:legacy-meat-collection-to-meat:'
      || collection_row.collection_id::text;
    INSERT INTO inventory_operations (
      operation_key, player_id, source, source_entity_type, source_entity_id, metadata
    ) VALUES (
      operation_key_value, collection_row.player_id, 'legacy_meat_retirement',
      'market_collection', collection_row.collection_id::text,
      jsonb_build_object('migration', '0862', 'from', collection_row.item_id,
        'to', collection_row.target_item, 'quantityMultiplier', collection_row.quantity_multiplier)
    ) ON CONFLICT (operation_key) DO NOTHING;
    IF NOT EXISTS (
      SELECT 1 FROM inventory_events WHERE inventory_events.operation_key = operation_key_value
    ) THEN
      INSERT INTO player_inventory (
        player_id, resource_type, variant, quantity, version, updated_at
      ) VALUES (
        collection_row.player_id, collection_row.target_item, variant_value, 0, 0, migration_now
      ) ON CONFLICT (player_id, resource_type, variant) DO NOTHING;
      UPDATE player_inventory
      SET quantity = quantity + target_quantity, version = version + 1, updated_at = migration_now
      WHERE player_id = collection_row.player_id
        AND resource_type = collection_row.target_item AND variant = variant_value
      RETURNING quantity::bigint, version::bigint INTO target_stack;
      INSERT INTO inventory_events (
        operation_key, player_id, item_id, variant, delta_quantity,
        quantity_after, version_after, source, source_entity_type,
        source_entity_id, metadata
      ) VALUES (
        operation_key_value, collection_row.player_id, collection_row.target_item, variant_value,
        target_quantity, target_stack.quantity, target_stack.version,
        'legacy_meat_retirement', 'market_collection', collection_row.collection_id::text,
        jsonb_build_object('from', collection_row.item_id, 'to', collection_row.target_item)
      );
      UPDATE player_inventory
      SET quantity = quantity - amount_value, version = version + 1, updated_at = migration_now
      WHERE player_id = collection_row.player_id
        AND resource_type = collection_row.item_id
        AND variant = variant_value;
      INSERT INTO inventory_events (
        operation_key, player_id, item_id, variant, delta_quantity,
        quantity_after, version_after, source, source_entity_type,
        source_entity_id, metadata
      )
      SELECT operation_key_value, collection_row.player_id, collection_row.item_id, variant,
             -amount_value, quantity, version, 'legacy_meat_retirement',
             'market_collection', collection_row.collection_id::text,
             jsonb_build_object('from', collection_row.item_id, 'to', collection_row.target_item)
      FROM player_inventory
      WHERE player_id = collection_row.player_id
        AND resource_type = collection_row.item_id
        AND variant = variant_value;
    END IF;
  END LOOP;

  -- Treasury is a mutable projection; donation and expenditure history stays
  -- untouched and continues to name the retired legacy meat identity.
  FOR treasury_row IN
    SELECT balances.kingdom_id, COALESCE(balances.variant, 'default') AS variant,
           balances.resource_type, balances.quantity::bigint AS quantity,
           replacement.target_item, replacement.quantity_multiplier
    FROM kingdom_treasury_balances balances
    JOIN meat_replacements replacement ON replacement.source_item = balances.resource_type
    WHERE balances.quantity > 0 AND replacement.source_item <> replacement.target_item
    ORDER BY balances.kingdom_id, balances.resource_type,
             COALESCE(balances.variant, 'default')
  LOOP
    target_quantity := treasury_row.quantity * treasury_row.quantity_multiplier;
    INSERT INTO kingdom_treasury_balances (
      kingdom_id, resource_type, variant, quantity, updated_at
    ) VALUES (
      treasury_row.kingdom_id, treasury_row.target_item, treasury_row.variant,
      target_quantity, migration_now
    ) ON CONFLICT (kingdom_id, resource_type, variant)
      DO UPDATE SET quantity = kingdom_treasury_balances.quantity + EXCLUDED.quantity,
                    updated_at = EXCLUDED.updated_at;
    UPDATE kingdom_treasury_balances
    SET quantity = 0, updated_at = migration_now
    WHERE kingdom_id = treasury_row.kingdom_id
      AND resource_type = treasury_row.resource_type
      AND variant = treasury_row.variant;
  END LOOP;

  -- Retire unmapped meat only after all market claims and cancellation refunds
  -- have arrived. The debit is an ordinary append-only inventory operation.
  FOR source_row IN
    SELECT * FROM player_inventory WHERE resource_type IN ('wild_meat','raw_meat') AND quantity > 0
    ORDER BY player_id,resource_type,variant
  LOOP
    operation_key_value := 'migration:0862:retire:' || source_row.player_id || ':' ||
      source_row.resource_type || ':' || source_row.variant;
    INSERT INTO inventory_operations(operation_key,player_id,source,source_entity_type,source_entity_id,metadata)
    VALUES(operation_key_value,source_row.player_id,'legacy_meat_retirement','migration','0862',
      '{"reason":"no_current_species_cut"}');
    UPDATE player_inventory SET quantity=0,version=version+1,updated_at=migration_now
    WHERE player_id=source_row.player_id AND resource_type=source_row.resource_type AND variant=source_row.variant;
    INSERT INTO inventory_events(operation_key,player_id,item_id,variant,delta_quantity,quantity_after,
      version_after,source,source_entity_type,source_entity_id,metadata)
    VALUES(operation_key_value,source_row.player_id,source_row.resource_type,source_row.variant,
      -source_row.quantity,0,source_row.version+1,'legacy_meat_retirement','migration','0862',
      '{"reason":"no_current_species_cut"}');
  END LOOP;
  DELETE FROM city_warehouse_stacks WHERE item_id IN ('wild_meat','raw_meat');
  UPDATE kingdom_treasury_balances SET quantity=0,updated_at=migration_now
    WHERE resource_type IN ('wild_meat','raw_meat') AND quantity>0;

  -- Freeze books only after every live order and collection is settled.
  PERFORM set_config(
    'ash_atlas.market_control_operator', 'system:migration:0862-legacy-meat-retirement', true
  );
  PERFORM set_config(
    'ash_atlas.market_control_reason',
    'Retire legacy meat market books after species cut conversion', true
  );
  PERFORM set_config(
    'ash_atlas.market_control_incident_id', 'migration:0862:legacy-meat-retirement', true
  );
  UPDATE market_order_books
  SET frozen = true,
      sensitive_reason = 'Retire legacy meat market books after species cut conversion',
      updated_at = migration_now
  WHERE item_id IN (SELECT source_item FROM meat_replacements)
     OR item_identity IN (SELECT source_item FROM meat_replacements);
END;
$$;

-- Leave the old item rows as explicit historical tombstones.  This prevents
-- future drops, package grants, or market listings while preserving FK-safe
-- historical evidence.
UPDATE item_definitions
SET display_name = CASE WHEN display_name LIKE '% (Legacy)' THEN display_name ELSE display_name || ' (Legacy)' END,
    droppable = false,
    market_tradable = false,
    market_fungible = false,
    market_identity = NULL,
    updated_at = clock_timestamp()
WHERE item_id IN (SELECT source_item FROM meat_replacements);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM player_inventory
    WHERE resource_type IN (SELECT source_item FROM meat_replacements) AND quantity > 0
  ) OR EXISTS (
    SELECT 1 FROM city_warehouse_stacks
    WHERE item_id IN (SELECT source_item FROM meat_replacements)
  ) OR EXISTS (
    SELECT 1 FROM world_item_drops
    WHERE status = 'active'
      AND item_id IN (SELECT source_item FROM meat_replacements)
      AND remaining_quantity > 0
  ) OR EXISTS (
    SELECT 1 FROM market_orders
    WHERE status IN ('open', 'partially_filled')
      AND item_id IN (SELECT source_item FROM meat_replacements)
  ) OR EXISTS (
    SELECT 1
    FROM market_order_escrows escrow
    JOIN market_orders orders ON orders.order_id = escrow.order_id
    WHERE escrow.remaining_amount > 0
      AND orders.item_id IN (SELECT source_item FROM meat_replacements)
  ) OR EXISTS (
    SELECT 1 FROM market_collections
    WHERE remaining_amount > 0
      AND item_id IN (SELECT source_item FROM meat_replacements)
  ) OR EXISTS (
    SELECT 1 FROM kingdom_treasury_balances
    WHERE resource_type IN (SELECT source_item FROM meat_replacements) AND quantity > 0
  ) OR EXISTS (
    SELECT 1 FROM player_package_items
    WHERE canonical_item_id IN (SELECT source_item FROM meat_replacements)
      AND remaining_quantity > 0
  ) OR EXISTS (
    SELECT 1 FROM market_order_books
    WHERE (item_id IN (SELECT source_item FROM meat_replacements)
       OR item_identity IN (SELECT source_item FROM meat_replacements))
      AND NOT frozen
  ) THEN
    RAISE EXCEPTION '0862 left live legacy meat custody or an unfrozen market book';
  END IF;
END;
$$;
