-- Retire the legacy Shell identity everywhere it can still represent live
-- custody. 0811 converted ordinary inventory and storage, but durable market,
-- world-drop, and kingdom projections can outlive that migration. Historical
-- requests, movements, trades, ledgers, donations, and expenditures remain
-- immutable Shell records; active projections are settled through their normal
-- append-only evidence and receive Chitin 1:1.

LOCK TABLE item_definitions, player_inventory, inventory_operations,
  inventory_events, manor_storage_stacks, city_warehouse_stacks,
  world_item_drops, world_item_movements, world_item_system_drop_sources,
  market_order_books, market_orders, market_order_escrows, market_collections,
  market_claims, market_ledger_groups, market_ledger_entries, player_wallets,
  wallet_events, market_audit_events, kingdom_treasury_balances
  IN SHARE ROW EXCLUSIVE MODE;

UPDATE manor_storage_stacks
SET item_id = 'chitin', updated_at = clock_timestamp()
WHERE item_id = 'shell';

UPDATE city_warehouse_stacks
SET item_id = 'chitin', updated_at = clock_timestamp()
WHERE item_id = 'shell';

DO $$
DECLARE
  migration_now timestamptz := clock_timestamp();
  stack_row record;
  chitin_stack record;
  order_row record;
  collection_row record;
  treasury_row record;
  operation_key_value text;
  request_id_value text;
  claim_id_value uuid;
  ledger_group_id_value uuid;
  new_drop_id uuid;
  amount_value bigint;
  variant_value text;
  wallet_balance bigint;
  wallet_version bigint;
BEGIN
  -- A world drop is immutable in identity. Cancel the old Shell custody with
  -- destruction evidence, then create a new system-owned Chitin drop for the
  -- still-live quantity. Expired custody is sunk and is not resurrected.
  FOR stack_row IN
    SELECT d.*
    FROM world_item_drops d
    WHERE d.status = 'active'
      AND d.item_id = 'shell'
      AND d.remaining_quantity > 0
    ORDER BY d.id
  LOOP
    INSERT INTO world_item_movements (
      drop_id, movement_kind, item_id, variant, quantity, reason, created_at
    ) VALUES (
      stack_row.id, 'world_to_destruction', 'shell', stack_row.variant,
      stack_row.remaining_quantity, 'legacy_cancelled_sink', migration_now
    ) ON CONFLICT DO NOTHING;

    UPDATE world_item_drops
    SET status = 'cancelled', remaining_quantity = 0, expired_at = migration_now
    WHERE id = stack_row.id AND status = 'active';

    IF stack_row.expires_at > migration_now THEN
      new_drop_id := gen_random_uuid();
      operation_key_value := 'migration:0815:shell-drop:' || stack_row.id::text;

      INSERT INTO inventory_operations (
        operation_key, player_id, source, source_entity_type, source_entity_id, metadata
      ) VALUES (
        operation_key_value, stack_row.dropped_by, 'world_system_drop',
        'world_item_drop', new_drop_id::text,
        jsonb_build_object(
          'migration', '0815', 'fromDropId', stack_row.id,
          'from', 'shell', 'to', 'chitin'
        )
      ) ON CONFLICT (operation_key) DO NOTHING;

      INSERT INTO world_item_drops (
        id, operation_key, dropped_by, region_code, zone_id, pile_id, pile_order,
        item_id, variant, original_quantity, remaining_quantity, status,
        lat, lon, geom, created_at, expires_at
      ) VALUES (
        new_drop_id, operation_key_value, stack_row.dropped_by, stack_row.region_code,
        stack_row.zone_id, stack_row.pile_id, stack_row.pile_order,
        'chitin', stack_row.variant, stack_row.remaining_quantity,
        stack_row.remaining_quantity, 'active', stack_row.lat, stack_row.lon,
        stack_row.geom, stack_row.created_at, stack_row.expires_at
      ) ON CONFLICT (id) DO NOTHING;

      INSERT INTO world_item_system_drop_sources (
        drop_id, operation_key, source_entity_type, source_entity_id, reason, created_at
      ) VALUES (
        new_drop_id, operation_key_value, 'world_item_drop', stack_row.id::text,
        'shell_to_chitin_migration', migration_now
      ) ON CONFLICT DO NOTHING;

      INSERT INTO world_item_movements (
        drop_id, movement_kind, operation_key, player_id, item_id, variant,
        quantity, reason, created_at
      ) VALUES (
        new_drop_id, 'system_to_world', operation_key_value, stack_row.dropped_by,
        'chitin', stack_row.variant, stack_row.remaining_quantity,
        'shell_to_chitin_migration', migration_now
      ) ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;

  -- Open Shell orders are settled through the existing cancellation shape:
  -- sell escrow returns Shell through an authoritative inventory event, while
  -- buy escrow returns its exact gold amount through a wallet event. The
  -- immutable cancel ledger remains Shell history; the inventory sweep below
  -- changes only the live returned value to Chitin.
  FOR order_row IN
    SELECT o.*, e.asset_kind AS escrow_asset_kind,
           e.remaining_amount::bigint AS escrow_remaining
    FROM market_orders o
    JOIN market_order_escrows e ON e.order_id = o.order_id
    WHERE o.status IN ('open', 'partially_filled')
      AND o.item_id = 'shell'
    ORDER BY o.order_id
  LOOP
    amount_value := order_row.escrow_remaining;
    IF amount_value <= 0 THEN
      RAISE EXCEPTION 'active Shell market order % has no remaining escrow', order_row.order_id;
    END IF;

    IF order_row.side = 'sell' THEN
      IF order_row.escrow_asset_kind <> 'item' THEN
        RAISE EXCEPTION 'Shell sell order % has a non-item escrow', order_row.order_id;
      END IF;
      operation_key_value := 'market-cancel-item:' || order_row.order_id::text;

      INSERT INTO inventory_operations (
        operation_key, player_id, source, source_entity_type, source_entity_id, metadata
      ) VALUES (
        operation_key_value, order_row.player_id, 'market_manual_cancellation',
        'market_order', order_row.order_id::text,
        jsonb_build_object('migration', '0815', 'orderId', order_row.order_id)
      ) ON CONFLICT (operation_key) DO NOTHING;

      IF NOT EXISTS (
        SELECT 1 FROM inventory_events WHERE inventory_events.operation_key = operation_key_value
      ) THEN
        variant_value := COALESCE(order_row.variant, 'default');
        INSERT INTO player_inventory (
          player_id, resource_type, variant, quantity, version, updated_at
        ) VALUES (order_row.player_id, 'shell', variant_value, 0, 0, migration_now)
        ON CONFLICT (player_id, resource_type, variant) DO NOTHING;

        UPDATE player_inventory
        SET quantity = quantity + amount_value, version = version + 1,
            updated_at = migration_now
        WHERE player_id = order_row.player_id
          AND resource_type = 'shell' AND variant = variant_value
        RETURNING quantity::bigint, version::bigint INTO chitin_stack;

        INSERT INTO inventory_events (
          operation_key, player_id, item_id, variant, delta_quantity,
          quantity_after, version_after, source, source_entity_type,
          source_entity_id, metadata
        ) VALUES (
          operation_key_value, order_row.player_id, 'shell', variant_value,
          amount_value, chitin_stack.quantity, chitin_stack.version,
          'market_manual_cancellation', 'market_order', order_row.order_id::text,
          jsonb_build_object('migration', '0815')
        );
      END IF;
    ELSE
      IF order_row.escrow_asset_kind <> 'gold' THEN
        RAISE EXCEPTION 'Shell buy order % has a non-gold escrow', order_row.order_id;
      END IF;
      operation_key_value := 'market-cancel-gold:' || order_row.order_id::text;
      INSERT INTO player_wallets (player_id, account_id, gold_balance, version)
      VALUES (order_row.player_id, order_row.account_id, 0, 0)
      ON CONFLICT (player_id) DO NOTHING;

      IF NOT EXISTS (
        SELECT 1 FROM wallet_events WHERE wallet_events.operation_key = operation_key_value
          AND wallet_events.player_id = order_row.player_id
      ) THEN
        SELECT gold_balance::bigint, version::bigint
        INTO wallet_balance, wallet_version
        FROM player_wallets
        WHERE player_id = order_row.player_id AND account_id = order_row.account_id
        FOR UPDATE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'Shell buy order % has no authoritative wallet', order_row.order_id;
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
          jsonb_build_object('migration', '0815')
        );
      END IF;
    END IF;

    SELECT group_row.ledger_group_id INTO ledger_group_id_value
    FROM market_ledger_groups
      AS group_row
    WHERE group_row.group_type = 'cancel' AND group_row.order_id = order_row.order_id;
    IF NOT FOUND THEN
      ledger_group_id_value := gen_random_uuid();
      INSERT INTO market_ledger_groups (
        ledger_group_id, group_type, request_id, order_id, rules_version,
        order_fee_policy_id, order_fee_policy_version
      ) VALUES (
        ledger_group_id_value, 'cancel',
        'migration:0815:cancel:' || order_row.order_id::text,
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
           'shell_to_chitin_cancel_debit'),
          (ledger_group_id_value, 'item', order_row.item_identity, amount_value,
           'player_inventory', order_row.player_id, order_row.order_id,
           'shell_to_chitin_cancel_credit');
      ELSE
        INSERT INTO market_ledger_entries (
          ledger_group_id, asset_kind, item_identity, amount, account_location,
          player_id, order_id, reason
        ) VALUES
          (ledger_group_id_value, 'gold', NULL, -amount_value, 'buy_escrow',
           order_row.player_id, order_row.order_id, 'shell_to_chitin_cancel_debit'),
          (ledger_group_id_value, 'gold', NULL, amount_value, 'player_wallet',
           order_row.player_id, order_row.order_id, 'shell_to_chitin_cancel_credit');
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

  -- Open item collections are claimed through the canonical claim ledger and
  -- claim-provenance operation, then the resulting Shell is converted by the
  -- inventory sweep. Closed historical collections keep their Shell identity.
  FOR collection_row IN
    SELECT collection.*
    FROM market_collections collection
    WHERE collection.asset_kind = 'item'
      AND collection.item_id = 'shell'
      AND collection.remaining_amount > 0
    ORDER BY collection.collection_id
  LOOP
    amount_value := collection_row.remaining_amount;
    SELECT account_id INTO stack_row
    FROM players
    WHERE id = collection_row.player_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Shell market collection % has no player account', collection_row.collection_id;
    END IF;
    request_id_value := 'migration-0815-shell-collection-' || collection_row.collection_id::text;
    claim_id_value := md5('migration:0815:claim:' || collection_row.collection_id::text)::uuid;
    operation_key_value := 'market-claim-items:' || stack_row.account_id::text || ':' || request_id_value;

    INSERT INTO market_claims (
      claim_id, player_id, account_id, client_request_id, asset_scope,
      item_units_claimed, gold_claimed, result, venue_id
    ) VALUES (
      claim_id_value, collection_row.player_id, stack_row.account_id, request_id_value,
      'items', amount_value, 0,
      jsonb_build_object('itemUnitsClaimed', amount_value::text, 'goldClaimed', '0'),
      collection_row.venue_id
    ) ON CONFLICT (claim_id) DO NOTHING;

    INSERT INTO inventory_operations (
      operation_key, player_id, source, source_entity_type, source_entity_id, metadata
    ) VALUES (
      operation_key_value, collection_row.player_id, 'market_collection_claim',
      'market_claim', request_id_value,
      jsonb_build_object('migration', '0815', 'collectionId', collection_row.collection_id)
    ) ON CONFLICT (operation_key) DO NOTHING;

    IF NOT EXISTS (
      SELECT 1 FROM inventory_events WHERE inventory_events.operation_key = operation_key_value
    ) THEN
      variant_value := COALESCE(collection_row.variant, 'default');
      INSERT INTO player_inventory (
        player_id, resource_type, variant, quantity, version, updated_at
      ) VALUES (collection_row.player_id, 'shell', variant_value, 0, 0, migration_now)
      ON CONFLICT (player_id, resource_type, variant) DO NOTHING;
      UPDATE player_inventory
      SET quantity = quantity + amount_value, version = version + 1,
          updated_at = migration_now
      WHERE player_id = collection_row.player_id
        AND resource_type = 'shell' AND variant = variant_value
      RETURNING quantity::bigint, version::bigint INTO chitin_stack;
      INSERT INTO inventory_events (
        operation_key, player_id, item_id, variant, delta_quantity,
        quantity_after, version_after, source, source_entity_type,
        source_entity_id, metadata
      ) VALUES (
        operation_key_value, collection_row.player_id, 'shell', variant_value,
        amount_value, chitin_stack.quantity, chitin_stack.version,
        'market_collection_claim', 'market_claim', request_id_value,
        jsonb_build_object('migration', '0815')
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
      ) VALUES (ledger_group_id_value, 'claim', request_id_value, claim_id_value, 1);
      INSERT INTO market_ledger_entries (
        ledger_group_id, asset_kind, item_identity, amount, account_location,
        player_id, collection_id, reason
      ) VALUES
        (ledger_group_id_value, 'item', collection_row.item_identity, -amount_value,
         CASE WHEN collection_row.reason IN (
           'sell_cancel_return', 'sell_expired_return'
         ) THEN 'return_collection' ELSE 'buyer_collection' END,
         collection_row.player_id, collection_row.collection_id,
         'shell_to_chitin_claim_debit'),
        (ledger_group_id_value, 'item', collection_row.item_identity, amount_value,
         'player_inventory', collection_row.player_id, NULL,
         'shell_to_chitin_claim_credit');
    END IF;
  END LOOP;

  -- Retire Shell books after their open value is settled. The control trigger
  -- records this freeze with the migration operator/reason/incident context.
  PERFORM set_config(
    'ash_atlas.market_control_operator', 'system:migration:0815-shell-to-chitin', true
  );
  PERFORM set_config(
    'ash_atlas.market_control_reason',
    'Retire legacy Shell market books after 1:1 Chitin conversion', true
  );
  PERFORM set_config(
    'ash_atlas.market_control_incident_id', 'migration:0815:shell-to-chitin', true
  );
  UPDATE market_order_books
  SET frozen = true,
      sensitive_reason = 'Retire legacy Shell market books after 1:1 Chitin conversion',
      updated_at = migration_now
  WHERE item_id = 'shell' OR item_identity = 'shell';

  -- Kingdom treasury is a mutable projection. Donation and expenditure rows
  -- remain immutable Shell history; only the live balance is converted.
  FOR treasury_row IN
    SELECT kingdom_id, COALESCE(variant, 'default') AS variant,
           quantity::bigint AS quantity
    FROM kingdom_treasury_balances
    WHERE resource_type = 'shell' AND quantity > 0
    ORDER BY kingdom_id, COALESCE(variant, 'default')
  LOOP
    INSERT INTO kingdom_treasury_balances (
      kingdom_id, resource_type, variant, quantity, updated_at
    ) VALUES (
      treasury_row.kingdom_id, 'chitin', treasury_row.variant,
      treasury_row.quantity, migration_now
    ) ON CONFLICT (kingdom_id, resource_type, variant)
      DO UPDATE SET quantity = kingdom_treasury_balances.quantity + EXCLUDED.quantity,
                    updated_at = EXCLUDED.updated_at;
    UPDATE kingdom_treasury_balances
    SET quantity = 0, updated_at = migration_now
    WHERE kingdom_id = treasury_row.kingdom_id
      AND resource_type = 'shell'
      AND variant = treasury_row.variant;
  END LOOP;

  -- Convert Shell returned by market settlement and any pre-existing live
  -- stack that was not present when 0811 ran.
  FOR stack_row IN
    SELECT player_id, COALESCE(variant, 'default') AS variant,
           quantity::bigint AS quantity
    FROM player_inventory
    WHERE resource_type = 'shell' AND quantity > 0
    ORDER BY player_id, COALESCE(variant, 'default')
  LOOP
    variant_value := stack_row.variant;
    operation_key_value := 'migration:0815:shell-to-chitin:'
      || stack_row.player_id || ':' || variant_value;
    INSERT INTO inventory_operations (
      operation_key, player_id, source, source_entity_type, source_entity_id, metadata
    ) VALUES (
      operation_key_value, stack_row.player_id, 'equipment_repair_migration',
      'migration', '0815',
      jsonb_build_object('from', 'shell', 'to', 'chitin', 'variant', variant_value)
    ) ON CONFLICT (operation_key) DO NOTHING;
    IF EXISTS (
      SELECT 1 FROM inventory_events WHERE inventory_events.operation_key = operation_key_value
    ) THEN
      CONTINUE;
    END IF;
    INSERT INTO player_inventory (
      player_id, resource_type, variant, quantity, version, updated_at
    ) VALUES (stack_row.player_id, 'chitin', variant_value, 0, 0, migration_now)
    ON CONFLICT (player_id, resource_type, variant) DO NOTHING;
    UPDATE player_inventory
    SET quantity = quantity + stack_row.quantity, version = version + 1,
        updated_at = migration_now
    WHERE player_id = stack_row.player_id
      AND resource_type = 'chitin' AND variant = variant_value
    RETURNING quantity::bigint, version::bigint INTO chitin_stack;
    INSERT INTO inventory_events (
      operation_key, player_id, item_id, variant, delta_quantity,
      quantity_after, version_after, source, source_entity_type,
      source_entity_id, metadata
    ) VALUES (
      operation_key_value, stack_row.player_id, 'chitin', variant_value,
      stack_row.quantity, chitin_stack.quantity, chitin_stack.version,
      'equipment_repair_migration', 'migration', '0815',
      jsonb_build_object('from', 'shell', 'to', 'chitin')
    );
    UPDATE player_inventory
    SET quantity = 0, version = version + 1, updated_at = migration_now
    WHERE player_id = stack_row.player_id
      AND resource_type = 'shell'
      AND variant IS NOT DISTINCT FROM variant_value;
    INSERT INTO inventory_events (
      operation_key, player_id, item_id, variant, delta_quantity,
      quantity_after, version_after, source, source_entity_type,
      source_entity_id, metadata
    )
    SELECT operation_key_value, stack_row.player_id, 'shell', variant,
           -stack_row.quantity, quantity, version,
           'equipment_repair_migration', 'migration', '0815',
           jsonb_build_object('from', 'shell', 'to', 'chitin')
    FROM player_inventory
    WHERE player_id = stack_row.player_id
      AND resource_type = 'shell'
      AND variant IS NOT DISTINCT FROM variant_value;
  END LOOP;
END;
$$;

-- Active Shell custody must be empty after the transaction. Historical rows
-- are intentionally excluded from these assertions and cannot rematerialize
-- value because their active projections are closed/frozen above.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM player_inventory WHERE resource_type = 'shell' AND quantity > 0)
     OR EXISTS (
       SELECT 1 FROM manor_storage_stacks WHERE item_id = 'shell'
     )
     OR EXISTS (
       SELECT 1 FROM city_warehouse_stacks WHERE item_id = 'shell'
     )
     OR EXISTS (
       SELECT 1 FROM world_item_drops
       WHERE status = 'active' AND item_id = 'shell' AND remaining_quantity > 0
     )
     OR EXISTS (
       SELECT 1 FROM market_orders
       WHERE status IN ('open', 'partially_filled') AND item_id = 'shell'
     )
     OR EXISTS (
       SELECT 1
       FROM market_order_escrows escrow
       JOIN market_orders order_row ON order_row.order_id = escrow.order_id
       WHERE escrow.remaining_amount > 0 AND order_row.item_id = 'shell'
     )
     OR EXISTS (
       SELECT 1 FROM market_collections
       WHERE remaining_amount > 0 AND item_id = 'shell'
     )
     OR EXISTS (
       SELECT 1 FROM kingdom_treasury_balances
       WHERE resource_type = 'shell' AND quantity > 0
     )
     OR EXISTS (
       SELECT 1 FROM market_order_books
       WHERE (item_id = 'shell' OR item_identity = 'shell') AND NOT frozen
     ) THEN
    RAISE EXCEPTION '0815 left live legacy Shell custody or an unfrozen Shell market book';
  END IF;
END;
$$;

UPDATE item_definitions
SET display_name = 'Shell (Legacy)',
    droppable = false,
    market_tradable = false,
    market_fungible = false,
    market_identity = NULL,
    updated_at = clock_timestamp()
WHERE item_id = 'shell';
