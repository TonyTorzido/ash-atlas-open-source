-- Demolition Factory and expendable Bomber demolition.
--
-- This is a forward-only compatibility migration. Legacy Siege Workshop and
-- Powder Works rows remain valid historical data, while one deterministic
-- legacy military facility per City is converted in place when the City does
-- not already have the consolidated factory. Legacy charge custody is settled
-- to its exact recipe inputs before the old live state is retired.

LOCK TABLE item_definitions, city_structures, military_facility_jobs,
  military_units, military_unit_groups, military_siege_operations,
  player_inventory, player_inventory_slots, inventory_operations,
  inventory_events, manor_storage_stacks, city_warehouse_stacks,
  world_item_drops, world_item_pickups, world_item_movements,
  market_order_books, market_orders, market_order_escrows, market_collections,
  market_claims, market_ledger_groups, market_ledger_entries,
  player_wallets, wallet_events, player_package_items,
  kingdom_treasury_balances
  IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE IF NOT EXISTS military_facility_migrations (
  migration_id bigserial PRIMARY KEY,
  city_id uuid NOT NULL REFERENCES cities(id) ON DELETE RESTRICT,
  source_structure_id uuid NOT NULL UNIQUE REFERENCES city_structures(structure_id) ON DELETE CASCADE,
  source_type text NOT NULL CHECK (source_type IN ('siege_workshop', 'powder_works')),
  target_type text NOT NULL CHECK (target_type = 'demolition_factory'),
  action text NOT NULL CHECK (action = 'converted_in_place'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

ALTER TABLE city_structures
  DROP CONSTRAINT IF EXISTS city_structures_check,
  DROP CONSTRAINT IF EXISTS city_structures_structure_type_check,
  DROP CONSTRAINT IF EXISTS city_structures_owner_check,
  DROP CONSTRAINT IF EXISTS city_structures_owner_shape_check,
  DROP CONSTRAINT IF EXISTS city_structures_civic_tier_check;

ALTER TABLE city_structures
  ADD CONSTRAINT city_structures_structure_type_check CHECK (
    structure_type IN (
      'city_house', 'mayor_house', 'oil_well', 'warehouse', 'cistern_warrens',
      'salon', 'city_kennel', 'market', 'monument', 'weaponsmith', 'armory',
      'barracks', 'demolition_factory', 'siege_workshop', 'powder_works'
    )
  ),
  ADD CONSTRAINT city_structures_owner_shape_check CHECK (
    (structure_type IN ('city_house', 'mayor_house', 'oil_well') AND owner_player_id IS NOT NULL)
    OR
    (structure_type IN (
      'warehouse', 'cistern_warrens', 'salon', 'city_kennel', 'market', 'monument',
      'weaponsmith', 'armory', 'barracks', 'demolition_factory',
      'siege_workshop', 'powder_works'
    ) AND owner_player_id IS NULL)
  ),
  ADD CONSTRAINT city_structures_civic_tier_check CHECK (
    (structure_type IN ('market', 'oil_well', 'cistern_warrens', 'salon', 'city_kennel',
      'barracks', 'armory', 'demolition_factory', 'siege_workshop', 'powder_works') AND tier = 1)
    OR (structure_type = 'monument' AND tier BETWEEN 1 AND 3)
    OR structure_type NOT IN ('market', 'oil_well', 'cistern_warrens', 'salon', 'city_kennel',
      'barracks', 'armory', 'demolition_factory', 'siege_workshop', 'powder_works', 'monument')
  );

DROP INDEX IF EXISTS city_structures_one_active_facility_type_idx;
DROP INDEX IF EXISTS city_structures_one_reserved_facility_type_idx;
CREATE UNIQUE INDEX IF NOT EXISTS city_structures_one_reserved_facility_type_idx
  ON city_structures (city_id, structure_type)
  WHERE state IN ('constructing', 'active')
    AND structure_type IN (
      'warehouse', 'cistern_warrens', 'salon', 'city_kennel', 'armory',
      'weaponsmith', 'barracks', 'demolition_factory',
      'siege_workshop', 'powder_works'
    );

-- Preserve an existing building's identity, location, construction state and
-- invested value. If both legacy buildings exist, only the first deterministic
-- candidate is converted; the other remains inert compatibility data.
DO $$
DECLARE
  legacy record;
BEGIN
  FOR legacy IN
    SELECT structure_id, city_id, structure_type
    FROM city_structures candidate
    WHERE candidate.structure_type IN ('siege_workshop', 'powder_works')
      AND candidate.state IN ('constructing', 'active')
      AND NOT EXISTS (
        SELECT 1 FROM city_structures factory
        WHERE factory.city_id = candidate.city_id
          AND factory.structure_type = 'demolition_factory'
          AND factory.state IN ('constructing', 'active')
      )
    ORDER BY city_id,
      CASE WHEN state = 'active' THEN 0 ELSE 1 END,
      CASE WHEN structure_type = 'siege_workshop' THEN 0 ELSE 1 END,
      created_at, structure_id
  LOOP
    UPDATE city_structures
    SET structure_type = 'demolition_factory',
        footprint_radius_m = 22,
        footprint_geom = ST_Buffer(
          ST_SetSRID(ST_MakePoint(lon, lat), 4326)::geography,
          22
        )::geometry,
        updated_at = clock_timestamp()
    WHERE structure_id = legacy.structure_id
      AND structure_type = legacy.structure_type
      AND NOT EXISTS (
        SELECT 1 FROM city_structures factory
        WHERE factory.city_id = legacy.city_id
          AND factory.structure_type = 'demolition_factory'
          AND factory.state IN ('constructing', 'active')
      );

    IF FOUND THEN
      INSERT INTO military_facility_migrations (
        city_id, source_structure_id, source_type, target_type, action
      ) VALUES (
        legacy.city_id, legacy.structure_id, legacy.structure_type,
        'demolition_factory', 'converted_in_place'
      ) ON CONFLICT (source_structure_id) DO NOTHING;
    END IF;
  END LOOP;
END $$;

CREATE TABLE IF NOT EXISTS demolition_charge_settlements (
  settlement_key text PRIMARY KEY,
  player_id text NULL REFERENCES players(id) ON DELETE RESTRICT,
  source text NOT NULL,
  source_id text NOT NULL,
  charge_quantity bigint NOT NULL CHECK (charge_quantity > 0),
  sulfur_quantity bigint NOT NULL CHECK (sulfur_quantity = charge_quantity * 2),
  coal_quantity bigint NOT NULL CHECK (coal_quantity = charge_quantity * 4),
  crude_oil_quantity bigint NOT NULL CHECK (crude_oil_quantity = charge_quantity * 10),
  cloth_quantity bigint NOT NULL CHECK (cloth_quantity = charge_quantity),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Reimburse inputs for charge jobs whose inputs were already debited. A job
-- still in flight returns its batch inputs; a completed uncollected job
-- returns one recipe per uncollected charge. Collected output is settled below
-- through the live custody projections and is never refunded twice.
DO $$
DECLARE
  job_row record;
  refund_quantity bigint;
  item_row record;
  target_stack record;
  operation_key_value text;
BEGIN
  FOR job_row IN
    SELECT job_id, owner_player_id, quantity::bigint, output_quantity::bigint,
           collected_quantity::bigint, completes_at
    FROM military_facility_jobs
    WHERE job_type = 'demolition_charge_batch' AND cleared_at IS NULL
    ORDER BY job_id
  LOOP
    refund_quantity := CASE
      WHEN job_row.completes_at > clock_timestamp() THEN job_row.quantity
      ELSE GREATEST(0, job_row.output_quantity - job_row.collected_quantity)
    END;
    IF refund_quantity > 0 THEN
      INSERT INTO demolition_charge_settlements (
        settlement_key, player_id, source, source_id, charge_quantity,
        sulfur_quantity, coal_quantity, crude_oil_quantity, cloth_quantity
      ) VALUES (
        'job:' || job_row.job_id::text, job_row.owner_player_id,
        'military_facility_job', job_row.job_id::text, refund_quantity,
        refund_quantity * 2, refund_quantity * 4, refund_quantity * 10, refund_quantity
      ) ON CONFLICT (settlement_key) DO NOTHING;

      FOR item_row IN
        SELECT * FROM (VALUES
          ('sulfur', refund_quantity * 2),
          ('coal', refund_quantity * 4),
          ('crude_oil', refund_quantity * 10),
          ('cloth', refund_quantity)
        ) AS refund(item_id, amount)
      LOOP
        operation_key_value := 'migration:0824:charge-job:' || job_row.job_id::text || ':' || item_row.item_id;
        INSERT INTO inventory_operations (
          operation_key, player_id, source, source_entity_type, source_entity_id, metadata
        ) VALUES (
          operation_key_value, job_row.owner_player_id, 'demolition_charge_retirement',
          'military_facility_job', job_row.job_id::text,
          jsonb_build_object('migration', '0824', 'recipeInput', item_row.item_id)
        ) ON CONFLICT (operation_key) DO NOTHING;
        IF NOT EXISTS (
          SELECT 1 FROM inventory_events WHERE inventory_events.operation_key = operation_key_value
        ) THEN
          INSERT INTO player_inventory (player_id, resource_type, variant, quantity, version)
          VALUES (job_row.owner_player_id, item_row.item_id, 'default', 0, 0)
          ON CONFLICT (player_id, resource_type, variant) DO NOTHING;
          UPDATE player_inventory
          SET quantity = quantity + item_row.amount,
              version = COALESCE(version, 0) + 1,
              updated_at = clock_timestamp()
          WHERE player_id = job_row.owner_player_id
            AND resource_type = item_row.item_id AND variant = 'default'
          RETURNING quantity, version INTO target_stack;
          INSERT INTO inventory_events (
            operation_key, player_id, item_id, variant, delta_quantity,
            quantity_after, version_after, source, source_entity_type,
            source_entity_id, metadata
          ) VALUES (
            operation_key_value, job_row.owner_player_id, item_row.item_id, 'default',
            item_row.amount, target_stack.quantity, target_stack.version,
            'demolition_charge_retirement', 'military_facility_job', job_row.job_id::text,
            jsonb_build_object('migration', '0824')
          );
        END IF;
      END LOOP;
    END IF;
  END LOOP;

  UPDATE military_facility_jobs
  SET collected_quantity = output_quantity,
      cleared_at = COALESCE(cleared_at, clock_timestamp()),
      updated_at = clock_timestamp()
  WHERE job_type = 'demolition_charge_batch' AND cleared_at IS NULL;
END $$;

-- Settle active player inventory stacks through the append-only inventory
-- chain, then remove the obsolete stack projection.
DO $$
DECLARE
  charge_row record;
  item_row record;
  target_stack record;
  operation_key_value text;
  retired_charge_quantity bigint;
BEGIN
  FOR charge_row IN
    SELECT player_id, COALESCE(variant, 'default') AS variant,
           quantity::bigint AS quantity
    FROM player_inventory
    WHERE resource_type = 'demolition_charge' AND quantity > 0
    ORDER BY player_id, COALESCE(variant, 'default')
  LOOP
    retired_charge_quantity := charge_row.quantity;
    INSERT INTO demolition_charge_settlements (
      settlement_key, player_id, source, source_id, charge_quantity,
      sulfur_quantity, coal_quantity, crude_oil_quantity, cloth_quantity
    ) VALUES (
      'inventory:' || charge_row.player_id || ':' || charge_row.variant,
      charge_row.player_id, 'player_inventory', charge_row.player_id || ':' || charge_row.variant,
      charge_row.quantity, charge_row.quantity * 2, charge_row.quantity * 4,
      charge_row.quantity * 10, charge_row.quantity
    ) ON CONFLICT (settlement_key) DO NOTHING;

    FOR item_row IN
      SELECT * FROM (VALUES
        ('sulfur', charge_row.quantity * 2),
        ('coal', charge_row.quantity * 4),
        ('crude_oil', charge_row.quantity * 10),
        ('cloth', charge_row.quantity)
      ) AS refund(item_id, amount)
    LOOP
      operation_key_value := 'migration:0824:inventory:' || charge_row.player_id || ':' || charge_row.variant || ':' || item_row.item_id;
      INSERT INTO inventory_operations (
        operation_key, player_id, source, source_entity_type, source_entity_id, metadata
      ) VALUES (
        operation_key_value, charge_row.player_id, 'demolition_charge_retirement',
        'player_inventory', charge_row.player_id,
        jsonb_build_object('migration', '0824', 'recipeInput', item_row.item_id)
      ) ON CONFLICT (operation_key) DO NOTHING;
      IF NOT EXISTS (
        SELECT 1 FROM inventory_events WHERE inventory_events.operation_key = operation_key_value
      ) THEN
        INSERT INTO player_inventory (player_id, resource_type, variant, quantity, version)
        VALUES (charge_row.player_id, item_row.item_id, charge_row.variant, 0, 0)
        ON CONFLICT (player_id, resource_type, variant) DO NOTHING;
        UPDATE player_inventory
        SET quantity = quantity + item_row.amount,
            version = COALESCE(version, 0) + 1,
            updated_at = clock_timestamp()
        WHERE player_id = charge_row.player_id
          AND resource_type = item_row.item_id AND variant = charge_row.variant
        RETURNING quantity, version INTO target_stack;
        INSERT INTO inventory_events (
          operation_key, player_id, item_id, variant, delta_quantity,
          quantity_after, version_after, source, source_entity_type,
          source_entity_id, metadata
        ) VALUES (
          operation_key_value, charge_row.player_id, item_row.item_id, charge_row.variant,
          item_row.amount, target_stack.quantity, target_stack.version,
          'demolition_charge_retirement', 'player_inventory', charge_row.player_id,
          jsonb_build_object('migration', '0824')
        );
      END IF;
    END LOOP;

    operation_key_value := 'migration:0824:inventory-retire:' || charge_row.player_id || ':' || charge_row.variant;
    INSERT INTO inventory_operations (
      operation_key, player_id, source, source_entity_type, source_entity_id, metadata
    ) VALUES (
      operation_key_value, charge_row.player_id, 'demolition_charge_retirement',
      'player_inventory', charge_row.player_id,
      jsonb_build_object('migration', '0824', 'retiredItem', 'demolition_charge')
    ) ON CONFLICT (operation_key) DO NOTHING;
    UPDATE player_inventory
    SET quantity = 0, version = version + 1, updated_at = clock_timestamp()
    WHERE player_id = charge_row.player_id
      AND resource_type = 'demolition_charge'
      AND variant = charge_row.variant
    RETURNING quantity, version INTO target_stack;
    INSERT INTO inventory_events (
      operation_key, player_id, item_id, variant, delta_quantity,
      quantity_after, version_after, source, source_entity_type,
      source_entity_id, metadata
    ) VALUES (
      operation_key_value, charge_row.player_id, 'demolition_charge', charge_row.variant,
      -retired_charge_quantity, 0, target_stack.version,
      'demolition_charge_retirement', 'player_inventory', charge_row.player_id,
      jsonb_build_object('migration', '0824', 'retiredItem', 'demolition_charge')
    );
  END LOOP;
END $$;

DELETE FROM player_inventory_slots WHERE resource_type = 'demolition_charge';

-- Temporary migration helpers keep every returned stack on the authoritative
-- append-only inventory chain. They disappear with the migration session.
CREATE OR REPLACE FUNCTION pg_temp.migration_0824_grant_charge(
  target_player_id text,
  target_variant text,
  target_operation_key text,
  target_source text,
  target_entity_type text,
  target_entity_id text,
  target_quantity bigint
) RETURNS void AS $$
DECLARE
  target_stack record;
BEGIN
  INSERT INTO inventory_operations (
    operation_key, player_id, source, source_entity_type, source_entity_id, metadata
  ) VALUES (
    target_operation_key, target_player_id, target_source, target_entity_type,
    target_entity_id, jsonb_build_object('migration', '0824')
  ) ON CONFLICT (operation_key) DO NOTHING;
  IF EXISTS (
    SELECT 1 FROM inventory_events WHERE inventory_events.operation_key = target_operation_key
  ) THEN
    RETURN;
  END IF;
  INSERT INTO player_inventory (player_id, resource_type, variant, quantity, version)
  VALUES (target_player_id, 'demolition_charge', target_variant, 0, 0)
  ON CONFLICT (player_id, resource_type, variant) DO NOTHING;
  UPDATE player_inventory
  SET quantity = quantity + target_quantity,
      version = COALESCE(version, 0) + 1,
      updated_at = clock_timestamp()
  WHERE player_id = target_player_id
    AND resource_type = 'demolition_charge'
    AND variant = target_variant
  RETURNING quantity, version INTO target_stack;
  INSERT INTO inventory_events (
    operation_key, player_id, item_id, variant, delta_quantity,
    quantity_after, version_after, source, source_entity_type,
    source_entity_id, metadata
  ) VALUES (
    target_operation_key, target_player_id, 'demolition_charge', target_variant,
    target_quantity, target_stack.quantity, target_stack.version,
    target_source, target_entity_type, target_entity_id,
    jsonb_build_object('migration', '0824')
  );
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION pg_temp.migration_0824_grant_recipe(
  target_player_id text,
  target_variant text,
  target_source text,
  target_entity_type text,
  target_entity_id text,
  target_quantity bigint
) RETURNS void AS $$
DECLARE
  item_row record;
  target_stack record;
  target_operation_key text;
BEGIN
  FOR item_row IN
    SELECT * FROM (VALUES
      ('sulfur', target_quantity * 2),
      ('coal', target_quantity * 4),
      ('crude_oil', target_quantity * 10),
      ('cloth', target_quantity)
    ) AS refund(item_id, amount)
  LOOP
    target_operation_key := 'migration:0824:recipe:' || target_source || ':'
      || target_entity_id || ':' || target_variant || ':' || item_row.item_id;
    INSERT INTO inventory_operations (
      operation_key, player_id, source, source_entity_type, source_entity_id, metadata
    ) VALUES (
      target_operation_key, target_player_id, target_source, target_entity_type,
      target_entity_id, jsonb_build_object('migration', '0824', 'recipeInput', item_row.item_id)
    ) ON CONFLICT (operation_key) DO NOTHING;
    IF EXISTS (
      SELECT 1 FROM inventory_events WHERE inventory_events.operation_key = target_operation_key
    ) THEN
      CONTINUE;
    END IF;
    INSERT INTO player_inventory (player_id, resource_type, variant, quantity, version)
    VALUES (target_player_id, item_row.item_id, target_variant, 0, 0)
    ON CONFLICT (player_id, resource_type, variant) DO NOTHING;
    UPDATE player_inventory
    SET quantity = quantity + item_row.amount,
        version = COALESCE(version, 0) + 1,
        updated_at = clock_timestamp()
    WHERE player_id = target_player_id
      AND resource_type = item_row.item_id AND variant = target_variant
    RETURNING quantity, version INTO target_stack;
    INSERT INTO inventory_events (
      operation_key, player_id, item_id, variant, delta_quantity,
      quantity_after, version_after, source, source_entity_type,
      source_entity_id, metadata
    ) VALUES (
      target_operation_key, target_player_id, item_row.item_id, target_variant,
      item_row.amount, target_stack.quantity, target_stack.version,
      target_source, target_entity_type, target_entity_id,
      jsonb_build_object('migration', '0824')
    );
  END LOOP;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION pg_temp.migration_0824_retire_charge_stack(
  target_player_id text,
  target_variant text,
  target_operation_key text,
  target_source text,
  target_entity_type text,
  target_entity_id text
) RETURNS void AS $$
DECLARE
  target_stack record;
  retired_quantity bigint;
BEGIN
  SELECT quantity, version INTO target_stack
  FROM player_inventory
  WHERE player_id = target_player_id
    AND resource_type = 'demolition_charge'
    AND variant = target_variant
  FOR UPDATE;
  IF NOT FOUND OR target_stack.quantity <= 0 THEN
    RETURN;
  END IF;
  retired_quantity := target_stack.quantity;
  INSERT INTO inventory_operations (
    operation_key, player_id, source, source_entity_type, source_entity_id, metadata
  ) VALUES (
    target_operation_key, target_player_id, target_source, target_entity_type,
    target_entity_id, jsonb_build_object('migration', '0824', 'retiredItem', 'demolition_charge')
  ) ON CONFLICT (operation_key) DO NOTHING;
  IF EXISTS (
    SELECT 1 FROM inventory_events WHERE inventory_events.operation_key = target_operation_key
  ) THEN
    RETURN;
  END IF;
  UPDATE player_inventory
  SET quantity = 0, version = version + 1, updated_at = clock_timestamp()
  WHERE player_id = target_player_id
    AND resource_type = 'demolition_charge'
    AND variant = target_variant
  RETURNING quantity, version INTO target_stack;
  INSERT INTO inventory_events (
    operation_key, player_id, item_id, variant, delta_quantity,
    quantity_after, version_after, source, source_entity_type,
    source_entity_id, metadata
  ) VALUES (
    target_operation_key, target_player_id, 'demolition_charge', target_variant,
    -retired_quantity, 0, target_stack.version,
    target_source, target_entity_type, target_entity_id,
    jsonb_build_object('migration', '0824', 'retiredItem', 'demolition_charge')
  );
END $$ LANGUAGE plpgsql;

-- Pending developer packages are another live custody projection.  Deliver
-- the exact recipe value to the package recipient and leave the original
-- charge line as a zero-remaining historical record.
DO $$
DECLARE
  package_row record;
BEGIN
  FOR package_row IN
    SELECT item.package_id, item.line_number, item.variant,
           item.remaining_quantity::bigint AS quantity,
           package.recipient_player_id
    FROM player_package_items item
    JOIN player_packages package ON package.id = item.package_id
    WHERE item.canonical_item_id = 'demolition_charge'
      AND item.remaining_quantity > 0
    ORDER BY item.package_id, item.line_number
  LOOP
    INSERT INTO demolition_charge_settlements (
      settlement_key, player_id, source, source_id, charge_quantity,
      sulfur_quantity, coal_quantity, crude_oil_quantity, cloth_quantity
    ) VALUES (
      'package:' || package_row.package_id::text || ':' || package_row.line_number::text,
      package_row.recipient_player_id, 'player_package_item',
      package_row.package_id::text || ':' || package_row.line_number::text,
      package_row.quantity, package_row.quantity * 2, package_row.quantity * 4,
      package_row.quantity * 10, package_row.quantity
    ) ON CONFLICT (settlement_key) DO NOTHING;

    PERFORM pg_temp.migration_0824_grant_recipe(
      package_row.recipient_player_id,
      COALESCE(package_row.variant, 'default'),
      'demolition_charge_retirement', 'player_package_item',
      package_row.package_id::text || ':' || package_row.line_number::text,
      package_row.quantity
    );
    UPDATE player_package_items
    SET remaining_quantity = 0,
        metadata = metadata || jsonb_build_object(
          'migration', '0824', 'from', 'demolition_charge', 'settled', true
        )
    WHERE package_id = package_row.package_id
      AND line_number = package_row.line_number
      AND canonical_item_id = 'demolition_charge'
      AND remaining_quantity > 0;
  END LOOP;
END $$;

-- Active ground drops cannot retain an item that current pickup code refuses.
-- Sink each remaining charge through the canonical immutable movement ledger
-- and return the value to the player who created the drop.
DO $$
DECLARE
  drop_row record;
  migration_now timestamptz := clock_timestamp();
BEGIN
  FOR drop_row IN
    SELECT id, dropped_by, variant, remaining_quantity::bigint AS quantity
    FROM world_item_drops
    WHERE status = 'active'
      AND item_id = 'demolition_charge'
      AND remaining_quantity > 0
    ORDER BY id
  LOOP
    INSERT INTO demolition_charge_settlements (
      settlement_key, player_id, source, source_id, charge_quantity,
      sulfur_quantity, coal_quantity, crude_oil_quantity, cloth_quantity
    ) VALUES (
      'drop:' || drop_row.id::text, drop_row.dropped_by,
      'world_item_drop', drop_row.id::text, drop_row.quantity,
      drop_row.quantity * 2, drop_row.quantity * 4,
      drop_row.quantity * 10, drop_row.quantity
    ) ON CONFLICT (settlement_key) DO NOTHING;

    INSERT INTO world_item_movements (
      drop_id, movement_kind, item_id, variant, quantity, reason, created_at
    ) VALUES (
      drop_row.id, 'world_to_destruction', 'demolition_charge',
      COALESCE(drop_row.variant, 'default'), drop_row.quantity,
      'legacy_cancelled_sink', migration_now
    ) ON CONFLICT DO NOTHING;
    UPDATE world_item_drops
    SET status = 'cancelled', remaining_quantity = 0, expired_at = migration_now
    WHERE id = drop_row.id AND status = 'active';

    PERFORM pg_temp.migration_0824_grant_recipe(
      drop_row.dropped_by, COALESCE(drop_row.variant, 'default'),
      'demolition_charge_retirement', 'world_item_drop', drop_row.id::text,
      drop_row.quantity
    );
  END LOOP;
END $$;

-- Cancel open/partially-filled charge listings through the existing market
-- return and claim ledgers. Sell escrows are claimed as the historical charge
-- identity, then converted to the exact recipe inputs below; buy escrows return
-- their exact Gold through the normal wallet/claim chain.
DO $$
DECLARE
  order_row record;
  collection_id_value bigint;
  claim_id_value uuid;
  claim_request_id text;
  claim_operation_key text;
  cancel_group_id uuid;
  claim_group_id uuid;
  amount_value bigint;
  wallet_row record;
  wallet_operation_key text;
BEGIN
  FOR order_row IN
    SELECT o.*, e.asset_kind AS escrow_asset_kind,
           e.remaining_amount::bigint AS escrow_remaining
    FROM market_orders o
    JOIN market_order_escrows e ON e.order_id = o.order_id
    WHERE o.status IN ('open', 'partially_filled')
      AND o.item_id = 'demolition_charge'
    ORDER BY o.order_id
  LOOP
    amount_value := order_row.escrow_remaining;
    IF amount_value <= 0 THEN
      RAISE EXCEPTION 'active Demolition Charge order % has no remaining escrow', order_row.order_id;
    END IF;

    IF order_row.side = 'sell' THEN
      IF order_row.escrow_asset_kind <> 'item' THEN
        RAISE EXCEPTION 'Demolition Charge sell order % has a non-item escrow', order_row.order_id;
      END IF;
      INSERT INTO market_collections (
        player_id, asset_kind, item_identity, item_id, variant,
        original_amount, remaining_amount, reason, source_order_id,
        source_trade_id, venue_id
      ) VALUES (
        order_row.player_id, 'item', order_row.item_identity, 'demolition_charge',
        order_row.variant, amount_value, amount_value, 'sell_cancel_return',
        order_row.order_id, NULL, order_row.venue_id
      ) ON CONFLICT (source_order_id, reason)
        WHERE reason IN ('sell_cancel_return', 'buy_cancel_refund') DO NOTHING
      RETURNING collection_id INTO collection_id_value;
      IF collection_id_value IS NULL THEN
        SELECT collection_id INTO collection_id_value
        FROM market_collections
        WHERE source_order_id = order_row.order_id AND reason = 'sell_cancel_return';
      END IF;
    ELSE
      IF order_row.escrow_asset_kind <> 'gold' THEN
        RAISE EXCEPTION 'Demolition Charge buy order % has a non-gold escrow', order_row.order_id;
      END IF;
      INSERT INTO market_collections (
        player_id, asset_kind, item_identity, item_id, variant,
        original_amount, remaining_amount, reason, source_order_id,
        source_trade_id, venue_id
      ) VALUES (
        order_row.player_id, 'gold', NULL, NULL, NULL, amount_value, amount_value,
        'buy_cancel_refund', order_row.order_id, NULL, order_row.venue_id
      ) ON CONFLICT (source_order_id, reason)
        WHERE reason IN ('sell_cancel_return', 'buy_cancel_refund') DO NOTHING
      RETURNING collection_id INTO collection_id_value;
      IF collection_id_value IS NULL THEN
        SELECT collection_id INTO collection_id_value
        FROM market_collections
        WHERE source_order_id = order_row.order_id AND reason = 'buy_cancel_refund';
      END IF;
    END IF;

    SELECT ledger_group_id INTO cancel_group_id
    FROM market_ledger_groups
    WHERE group_type = 'cancel' AND order_id = order_row.order_id;
    IF cancel_group_id IS NULL THEN
      cancel_group_id := gen_random_uuid();
      INSERT INTO market_ledger_groups (
        ledger_group_id, group_type, request_id, order_id, rules_version,
        order_fee_policy_id, order_fee_policy_version
      ) VALUES (
        cancel_group_id, 'cancel', 'migration:0824:cancel:' || order_row.order_id::text,
        order_row.order_id, order_row.rules_version,
        order_row.fee_policy_id, order_row.fee_policy_version
      );
      IF order_row.side = 'sell' THEN
        INSERT INTO market_ledger_entries (
          ledger_group_id, asset_kind, item_identity, amount, account_location,
          player_id, order_id, reason
        ) VALUES
          (cancel_group_id, 'item', order_row.item_identity, -amount_value,
           'sell_escrow', order_row.player_id, order_row.order_id, 'demolition_charge_retirement'),
          (cancel_group_id, 'item', order_row.item_identity, amount_value,
           'return_collection', order_row.player_id, order_row.order_id, 'demolition_charge_retirement');
      ELSE
        INSERT INTO market_ledger_entries (
          ledger_group_id, asset_kind, item_identity, amount, account_location,
          player_id, order_id, reason
        ) VALUES
          (cancel_group_id, 'gold', NULL, -amount_value,
           'buy_escrow', order_row.player_id, order_row.order_id, 'demolition_charge_retirement'),
          (cancel_group_id, 'gold', NULL, amount_value,
           'refund_balance', order_row.player_id, order_row.order_id, 'demolition_charge_retirement');
      END IF;
    END IF;

    UPDATE market_order_escrows
    SET remaining_amount = 0, updated_at = clock_timestamp()
    WHERE order_id = order_row.order_id AND remaining_amount > 0;
    UPDATE market_orders
    SET status = 'cancelled', cancelled_at = clock_timestamp()
    WHERE order_id = order_row.order_id
      AND status IN ('open', 'partially_filled');
    UPDATE market_order_books
    SET book_version = book_version + 1, updated_at = clock_timestamp()
    WHERE book_id = order_row.book_id AND venue_id = order_row.venue_id;

    claim_request_id := 'migration-0824-charge-order-' || order_row.order_id::text;
    claim_id_value := md5('migration:0824:claim:' || order_row.order_id::text)::uuid;
    IF order_row.side = 'sell' THEN
      claim_operation_key := 'market-claim-items:' || order_row.account_id::text || ':' || claim_request_id;
      INSERT INTO market_claims (
        claim_id, player_id, account_id, client_request_id, asset_scope,
        item_units_claimed, gold_claimed, result, venue_id
      ) VALUES (
        claim_id_value, order_row.player_id, order_row.account_id, claim_request_id,
        'items', amount_value, 0,
        jsonb_build_object('itemUnitsClaimed', amount_value::text, 'goldClaimed', '0'),
        order_row.venue_id
      ) ON CONFLICT (claim_id) DO NOTHING;
      PERFORM pg_temp.migration_0824_grant_charge(
        order_row.player_id, COALESCE(order_row.variant, 'default'), claim_operation_key,
        'market_collection_claim', 'market_claim', claim_request_id, amount_value
      );
      SELECT ledger_group_id INTO claim_group_id
      FROM market_ledger_groups
      WHERE group_type = 'claim' AND claim_id = claim_id_value;
      IF claim_group_id IS NULL THEN
        claim_group_id := gen_random_uuid();
        INSERT INTO market_ledger_groups (
          ledger_group_id, group_type, request_id, claim_id, rules_version
        ) VALUES (claim_group_id, 'claim', claim_request_id, claim_id_value, 1);
        INSERT INTO market_ledger_entries (
          ledger_group_id, asset_kind, item_identity, amount, account_location,
          player_id, collection_id, reason
        ) VALUES
          (claim_group_id, 'item', order_row.item_identity, -amount_value,
           'return_collection', order_row.player_id, collection_id_value, 'demolition_charge_retirement'),
          (claim_group_id, 'item', order_row.item_identity, amount_value,
           'player_inventory', order_row.player_id, NULL, 'demolition_charge_retirement');
      END IF;
      UPDATE market_collections
      SET remaining_amount = 0, claimed_at = clock_timestamp(), updated_at = clock_timestamp()
      WHERE collection_id = collection_id_value AND remaining_amount > 0;
    ELSE
      claim_operation_key := 'market-claim-gold:' || order_row.account_id::text || ':' || claim_request_id;
      INSERT INTO market_claims (
        claim_id, player_id, account_id, client_request_id, asset_scope,
        item_units_claimed, gold_claimed, result, venue_id
      ) VALUES (
        claim_id_value, order_row.player_id, order_row.account_id, claim_request_id,
        'gold', 0, amount_value,
        jsonb_build_object('itemUnitsClaimed', '0', 'goldClaimed', amount_value::text),
        order_row.venue_id
      ) ON CONFLICT (claim_id) DO NOTHING;
      SELECT gold_balance::bigint, version::bigint INTO wallet_row
      FROM player_wallets
      WHERE player_id = order_row.player_id AND account_id = order_row.account_id
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Demolition Charge buy order % has no authoritative wallet', order_row.order_id;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM wallet_events
        WHERE operation_key = claim_operation_key
          AND player_id = order_row.player_id
      ) THEN
        UPDATE player_wallets
        SET gold_balance = wallet_row.gold_balance + amount_value,
            version = wallet_row.version + 1, updated_at = clock_timestamp()
        WHERE player_id = order_row.player_id;
        INSERT INTO wallet_events (
          operation_key, player_id, account_id, delta_gold, balance_after,
          version_after, reason, metadata
        ) VALUES (
          claim_operation_key, order_row.player_id, order_row.account_id, amount_value,
          wallet_row.gold_balance + amount_value, wallet_row.version + 1,
          'market_collection_claim', jsonb_build_object('migration', '0824')
        );
      END IF;
      SELECT ledger_group_id INTO claim_group_id
      FROM market_ledger_groups
      WHERE group_type = 'claim' AND claim_id = claim_id_value;
      IF claim_group_id IS NULL THEN
        claim_group_id := gen_random_uuid();
        INSERT INTO market_ledger_groups (
          ledger_group_id, group_type, request_id, claim_id, rules_version
        ) VALUES (claim_group_id, 'claim', claim_request_id, claim_id_value, 1);
        INSERT INTO market_ledger_entries (
          ledger_group_id, asset_kind, item_identity, amount, account_location,
          player_id, collection_id, reason
        ) VALUES
          (claim_group_id, 'gold', NULL, -amount_value,
           'refund_balance', order_row.player_id, collection_id_value, 'demolition_charge_retirement'),
          (claim_group_id, 'gold', NULL, amount_value,
           'player_wallet', order_row.player_id, NULL, 'demolition_charge_retirement');
      END IF;
      UPDATE market_collections
      SET remaining_amount = 0, claimed_at = clock_timestamp(), updated_at = clock_timestamp()
      WHERE collection_id = collection_id_value AND remaining_amount > 0;
    END IF;
  END LOOP;
END $$;

-- Existing unclaimed item collections can outlive their source order. Claim
-- each legacy stack through the market claim/ledger shape first, then the
-- final inventory conversion below settles it to exact recipe inputs.
DO $$
DECLARE
  collection_row record;
  account_id_value uuid;
  amount_value bigint;
  request_id_value text;
  claim_id_value uuid;
  claim_operation_key text;
  claim_group_id uuid;
  collection_location text;
BEGIN
  FOR collection_row IN
    SELECT collection.*
    FROM market_collections collection
    WHERE collection.asset_kind = 'item'
      AND collection.item_id = 'demolition_charge'
      AND collection.remaining_amount > 0
    ORDER BY collection.collection_id
  LOOP
    amount_value := collection_row.remaining_amount;
    SELECT player.account_id INTO account_id_value
    FROM players player
    WHERE player.id = collection_row.player_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Demolition Charge market collection % has no player account', collection_row.collection_id;
    END IF;

    INSERT INTO demolition_charge_settlements (
      settlement_key, player_id, source, source_id, charge_quantity,
      sulfur_quantity, coal_quantity, crude_oil_quantity, cloth_quantity
    ) VALUES (
      'collection:' || collection_row.collection_id::text,
      collection_row.player_id, 'market_collection',
      collection_row.collection_id::text, amount_value, amount_value * 2,
      amount_value * 4, amount_value * 10, amount_value
    ) ON CONFLICT (settlement_key) DO NOTHING;

    request_id_value := 'migration-0824-charge-collection-' || collection_row.collection_id::text;
    claim_id_value := md5('migration:0824:claim:' || collection_row.collection_id::text)::uuid;
    claim_operation_key := 'market-claim-items:' || account_id_value::text || ':' || request_id_value;
    INSERT INTO market_claims (
      claim_id, player_id, account_id, client_request_id, asset_scope,
      item_units_claimed, gold_claimed, result, venue_id
    ) VALUES (
      claim_id_value, collection_row.player_id, account_id_value, request_id_value,
      'items', amount_value, 0,
      jsonb_build_object('itemUnitsClaimed', amount_value::text, 'goldClaimed', '0'),
      collection_row.venue_id
    ) ON CONFLICT (claim_id) DO NOTHING;
    PERFORM pg_temp.migration_0824_grant_charge(
      collection_row.player_id, COALESCE(collection_row.variant, 'default'),
      claim_operation_key, 'market_collection_claim', 'market_collection',
      collection_row.collection_id::text, amount_value
    );

    SELECT ledger_group_id INTO claim_group_id
    FROM market_ledger_groups
    WHERE group_type = 'claim' AND claim_id = claim_id_value;
    IF claim_group_id IS NULL THEN
      claim_group_id := gen_random_uuid();
      INSERT INTO market_ledger_groups (
        ledger_group_id, group_type, request_id, claim_id, rules_version
      ) VALUES (claim_group_id, 'claim', request_id_value, claim_id_value, 1);
      collection_location := CASE
        WHEN collection_row.reason IN ('purchase', 'sell_proceeds', 'price_improvement_refund')
          THEN 'buyer_collection'
        ELSE 'return_collection'
      END;
      INSERT INTO market_ledger_entries (
        ledger_group_id, asset_kind, item_identity, amount, account_location,
        player_id, collection_id, reason
      ) VALUES
        (claim_group_id, 'item', collection_row.item_identity, -amount_value,
         collection_location, collection_row.player_id, collection_row.collection_id,
         'demolition_charge_retirement'),
        (claim_group_id, 'item', collection_row.item_identity, amount_value,
         'player_inventory', collection_row.player_id, NULL,
         'demolition_charge_retirement');
    END IF;

    UPDATE market_collections
    SET remaining_amount = 0, claimed_at = clock_timestamp(), updated_at = clock_timestamp()
    WHERE collection_id = collection_row.collection_id AND remaining_amount > 0;
  END LOOP;
END $$;

-- Manor stacks are another live custody projection. Move their exact value to
-- the owning player's inventory before converting the legacy identity.
DO $$
DECLARE
  storage_row record;
  owner_id_value text;
  charge_operation_key text;
BEGIN
  FOR storage_row IN
    SELECT stack.stack_id, stack.manor_id, stack.variant, stack.quantity::bigint,
           manor.owner_player_id
    FROM manor_storage_stacks stack
    JOIN player_manors manor ON manor.id = stack.manor_id
    WHERE stack.item_id = 'demolition_charge' AND stack.quantity > 0
    ORDER BY stack.stack_id
  LOOP
    owner_id_value := storage_row.owner_player_id;
    INSERT INTO demolition_charge_settlements (
      settlement_key, player_id, source, source_id, charge_quantity,
      sulfur_quantity, coal_quantity, crude_oil_quantity, cloth_quantity
    ) VALUES (
      'manor:' || storage_row.stack_id::text, owner_id_value,
      'manor_storage_stack', storage_row.stack_id::text, storage_row.quantity,
      storage_row.quantity * 2, storage_row.quantity * 4,
      storage_row.quantity * 10, storage_row.quantity
    ) ON CONFLICT (settlement_key) DO NOTHING;
    charge_operation_key := 'migration:0824:manor:' || storage_row.stack_id::text;
    PERFORM pg_temp.migration_0824_grant_charge(
      owner_id_value, COALESCE(storage_row.variant, 'default'), charge_operation_key,
      'demolition_charge_retirement', 'manor_storage_stack', storage_row.stack_id::text,
      storage_row.quantity
    );
    DELETE FROM manor_storage_stacks WHERE stack_id = storage_row.stack_id;
  END LOOP;
END $$;

-- City warehouse value stays in its City. Reuse each retired slot for Sulfur
-- and append the other three exact recipe inputs at fresh slots.
DO $$
DECLARE
  warehouse_row record;
  next_slot integer;
BEGIN
  FOR warehouse_row IN
    SELECT stack_id, city_id, slot_index, variant, quantity::bigint
    FROM city_warehouse_stacks
    WHERE item_id = 'demolition_charge' AND quantity > 0
    ORDER BY city_id, slot_index, stack_id
  LOOP
    UPDATE city_warehouse_stacks
    SET item_id = 'sulfur', quantity = warehouse_row.quantity * 2,
        version = version + 1, updated_at = clock_timestamp()
    WHERE stack_id = warehouse_row.stack_id;
    SELECT COALESCE(MAX(slot_index), warehouse_row.slot_index) + 1
    INTO next_slot
    FROM city_warehouse_stacks WHERE city_id = warehouse_row.city_id;
    INSERT INTO city_warehouse_stacks (
      stack_id, city_id, slot_index, item_id, variant, quantity, version
    ) VALUES
      (gen_random_uuid(), warehouse_row.city_id, next_slot, 'coal', warehouse_row.variant, warehouse_row.quantity * 4, 1),
      (gen_random_uuid(), warehouse_row.city_id, next_slot + 1, 'crude_oil', warehouse_row.variant, warehouse_row.quantity * 10, 1),
      (gen_random_uuid(), warehouse_row.city_id, next_slot + 2, 'cloth', warehouse_row.variant, warehouse_row.quantity, 1);
    INSERT INTO demolition_charge_settlements (
      settlement_key, player_id, source, source_id, charge_quantity,
      sulfur_quantity, coal_quantity, crude_oil_quantity, cloth_quantity
    ) VALUES (
      'warehouse:' || warehouse_row.stack_id::text, NULL,
      'city_warehouse_stack', warehouse_row.stack_id::text, warehouse_row.quantity,
      warehouse_row.quantity * 2, warehouse_row.quantity * 4,
      warehouse_row.quantity * 10, warehouse_row.quantity
    ) ON CONFLICT (settlement_key) DO NOTHING;
  END LOOP;
END $$;

-- Kingdom treasury balances are also mutable item custody. Preserve their
-- value in the same treasury while replacing the retired identity.
DO $$
DECLARE
  treasury_row record;
  item_row record;
BEGIN
  FOR treasury_row IN
    SELECT kingdom_id, variant, quantity::bigint AS quantity
    FROM kingdom_treasury_balances
    WHERE resource_type = 'demolition_charge' AND quantity > 0
    ORDER BY kingdom_id, variant
  LOOP
    FOR item_row IN
      SELECT * FROM (VALUES
        ('sulfur', treasury_row.quantity * 2),
        ('coal', treasury_row.quantity * 4),
        ('crude_oil', treasury_row.quantity * 10),
        ('cloth', treasury_row.quantity)
      ) AS refund(item_id, amount)
    LOOP
      INSERT INTO kingdom_treasury_balances (
        kingdom_id, resource_type, variant, quantity, updated_at
      ) VALUES (
        treasury_row.kingdom_id, item_row.item_id, treasury_row.variant,
        item_row.amount, clock_timestamp()
      ) ON CONFLICT (kingdom_id, resource_type, variant)
      DO UPDATE SET quantity = kingdom_treasury_balances.quantity + EXCLUDED.quantity,
                    updated_at = EXCLUDED.updated_at;
    END LOOP;
    INSERT INTO demolition_charge_settlements (
      settlement_key, player_id, source, source_id, charge_quantity,
      sulfur_quantity, coal_quantity, crude_oil_quantity, cloth_quantity
    ) VALUES (
      'kingdom:' || treasury_row.kingdom_id::text || ':' || treasury_row.variant,
      NULL, 'kingdom_treasury_balance',
      treasury_row.kingdom_id::text || ':' || treasury_row.variant,
      treasury_row.quantity, treasury_row.quantity * 2,
      treasury_row.quantity * 4, treasury_row.quantity * 10, treasury_row.quantity
    ) ON CONFLICT (settlement_key) DO NOTHING;
    UPDATE kingdom_treasury_balances
    SET quantity = 0, updated_at = clock_timestamp()
    WHERE kingdom_id = treasury_row.kingdom_id
      AND resource_type = 'demolition_charge'
      AND variant = treasury_row.variant;
  END LOOP;
END $$;

-- Any charge returned by a market claim or manor transfer is now converted to
-- its exact recipe inputs. The charge row is zeroed only after all four
-- append-only grants succeed, so a failed conversion rolls back atomically.
DO $$
DECLARE
  charge_row record;
BEGIN
  FOR charge_row IN
    SELECT player_id, COALESCE(variant, 'default') AS variant, quantity::bigint
    FROM player_inventory
    WHERE resource_type = 'demolition_charge' AND quantity > 0
    ORDER BY player_id, COALESCE(variant, 'default')
  LOOP
    PERFORM pg_temp.migration_0824_grant_recipe(
      charge_row.player_id, charge_row.variant, 'demolition_charge_retirement',
      'player_inventory_conversion', charge_row.player_id || ':' || charge_row.variant,
      charge_row.quantity
    );
    PERFORM pg_temp.migration_0824_retire_charge_stack(
      charge_row.player_id, charge_row.variant,
      'migration:0824:inventory-conversion-retire:' || charge_row.player_id || ':' || charge_row.variant,
      'demolition_charge_retirement', 'player_inventory_conversion', charge_row.player_id
    );
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM player_inventory
    WHERE resource_type = 'demolition_charge' AND quantity > 0
  ) OR EXISTS (
    SELECT 1 FROM player_inventory_slots
    WHERE resource_type = 'demolition_charge' AND quantity > 0
  ) OR EXISTS (
    SELECT 1 FROM manor_storage_stacks
    WHERE item_id = 'demolition_charge' AND quantity > 0
  ) OR EXISTS (
    SELECT 1 FROM city_warehouse_stacks
    WHERE item_id = 'demolition_charge' AND quantity > 0
  ) OR EXISTS (
    SELECT 1 FROM player_package_items
    WHERE canonical_item_id = 'demolition_charge' AND remaining_quantity > 0
  ) OR EXISTS (
    SELECT 1 FROM world_item_drops
    WHERE status = 'active' AND item_id = 'demolition_charge' AND remaining_quantity > 0
  ) OR EXISTS (
    SELECT 1 FROM market_orders
    WHERE status IN ('open', 'partially_filled') AND item_id = 'demolition_charge'
  ) OR EXISTS (
    SELECT 1 FROM market_order_escrows escrow
    JOIN market_orders order_row ON order_row.order_id = escrow.order_id
    WHERE escrow.remaining_amount > 0 AND order_row.item_id = 'demolition_charge'
  ) OR EXISTS (
    SELECT 1 FROM market_collections
    WHERE remaining_amount > 0 AND item_id = 'demolition_charge'
  ) OR EXISTS (
    SELECT 1 FROM kingdom_treasury_balances
    WHERE resource_type = 'demolition_charge' AND quantity > 0
  ) OR EXISTS (
    SELECT 1 FROM military_facility_jobs
    WHERE job_type = 'demolition_charge_batch' AND cleared_at IS NULL
  ) THEN
    RAISE EXCEPTION '0824 left live legacy Demolition Charge custody';
  END IF;
END $$;

-- Historical books and ledger rows remain queryable, but no current market
-- operation may reopen a retired charge identity.
SELECT set_config(
  'ash_atlas.market_control_operator', 'system:migration:0824-demolition-charge-retirement', true
);
SELECT set_config(
  'ash_atlas.market_control_reason',
  'Retire Demolition Charge market books after exact recipe settlement', true
);
SELECT set_config(
  'ash_atlas.market_control_incident_id', 'migration:0824-demolition-charge-retirement', true
);
UPDATE market_order_books
SET frozen = true,
    sensitive_reason = 'Retire Demolition Charge market books after exact recipe settlement',
    updated_at = clock_timestamp()
WHERE item_id = 'demolition_charge' OR item_identity = 'demolition_charge';

-- Charge identity remains only as immutable FK/history data; it cannot be
-- produced, stored, listed, or picked up by current systems.
UPDATE item_definitions
SET display_name = 'Demolition Charge (Legacy)',
    droppable = false,
    manor_storable = false,
    market_tradable = false,
    market_fungible = false,
    market_identity = NULL,
    updated_at = clock_timestamp()
WHERE item_id = 'demolition_charge';

ALTER TABLE military_facility_jobs
  DROP CONSTRAINT IF EXISTS military_facility_jobs_job_type_check;
ALTER TABLE military_facility_jobs
  ADD CONSTRAINT military_facility_jobs_job_type_check CHECK (job_type IN (
    'train_siege_crew', 'train_infantry', 'train_archer', 'train_bomber',
    'manufacture_field_ballista', 'repair_kit_batch', 'torch_batch',
    'field_ballista_kit'
  ) OR (job_type = 'demolition_charge_batch' AND cleared_at IS NOT NULL));

ALTER TABLE military_units
  DROP COLUMN IF EXISTS carried_demolition_charge;

ALTER TABLE military_siege_operations
  DROP CONSTRAINT IF EXISTS military_siege_operations_action_check,
  DROP CONSTRAINT IF EXISTS military_siege_operations_damage_check;

-- A committed demolition removes its target Flag, but its immutable operation
-- row must remain available for replay/idempotency. Historical siege rows keep
-- their flag identity without a destructive FK cascade.
ALTER TABLE military_siege_operations
  DROP CONSTRAINT IF EXISTS military_siege_operations_flag_id_fkey;

UPDATE military_siege_operations
SET status = 'cancelled', completed_at = COALESCE(completed_at, clock_timestamp())
WHERE action = 'bomber_breach' AND status = 'pending';

ALTER TABLE military_siege_operations
  ADD CONSTRAINT military_siege_operations_action_check
    CHECK (action IN ('bomber_breach', 'demolish_flag', 'ballista_volley')),
  ADD CONSTRAINT military_siege_operations_damage_check CHECK (damage >= 0),
  DROP COLUMN IF EXISTS consumed_charges,
  ADD COLUMN IF NOT EXISTS group_revision bigint NULL,
  ADD COLUMN IF NOT EXISTS member_revisions jsonb NULL,
  ADD COLUMN IF NOT EXISTS target_lat double precision NULL,
  ADD COLUMN IF NOT EXISTS target_lon double precision NULL,
  ADD COLUMN IF NOT EXISTS consumed_unit_id uuid NULL;

CREATE INDEX IF NOT EXISTS military_siege_operations_demolition_due_idx
  ON military_siege_operations(completes_at, operation_key)
  WHERE action = 'demolish_flag' AND status = 'pending';

COMMENT ON TABLE military_facility_migrations IS
  'Forward-only in-place conversion audit for legacy Siege Workshop/Powder Works rows.';
COMMENT ON TABLE demolition_charge_settlements IS
  'Exact one-charge recipe restitution audit: 2 Sulfur, 4 Coal, 10 Crude Oil, 1 Cloth.';
COMMENT ON TABLE military_siege_operations IS
  'Replay-safe Bomber demolition and Ballista damage ledger; Bomber demolition consumes one underlying member atomically.';
