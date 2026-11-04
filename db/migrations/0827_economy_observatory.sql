-- Economy Observatory V1
--
-- The observatory is an additive, read-mostly analytical layer.  The
-- authoritative game tables remain the source of truth; the event ledger
-- below gives us one immutable, typed projection of their economic edges.

CREATE TABLE IF NOT EXISTS economy_transfer_groups (
  transfer_group_id uuid PRIMARY KEY,
  operation_key text NOT NULL UNIQUE,
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 240),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS economy_events (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_group_id uuid NOT NULL DEFAULT gen_random_uuid(),
  transfer_group_id uuid NULL REFERENCES economy_transfer_groups(transfer_group_id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  leg text NOT NULL CHECK (leg IN ('debit', 'credit')),
  event_kind text NOT NULL CHECK (
    event_kind IN ('SOURCE', 'SINK', 'TRANSFER', 'TRANSFORM', 'ADMIN', 'UNKNOWN')
  ),
  asset_kind text NOT NULL CHECK (asset_kind IN ('fungible', 'unique')),
  asset_id text NOT NULL CHECK (length(asset_id) BETWEEN 1 AND 160),
  item_id text NULL REFERENCES item_definitions(item_id) ON DELETE RESTRICT,
  variant text NOT NULL DEFAULT 'default' CHECK (length(variant) BETWEEN 1 AND 80),
  unique_asset_instance_id uuid NULL,
  quantity bigint NOT NULL CHECK (quantity > 0),
  custody_type text NOT NULL CHECK (custody_type IN (
    'player_inventory', 'player_wallet', 'equipment', 'backpack',
    'manor_storage', 'city_warehouse', 'city_treasury', 'city_gold_reserve',
    'kingdom_treasury', 'market_escrow', 'market_collection',
    'world_drop', 'external', 'unknown'
  )),
  custody_id text NOT NULL CHECK (length(custody_id) BETWEEN 1 AND 160),
  player_id text NULL REFERENCES players(id) ON DELETE RESTRICT,
  organization_type text NULL CHECK (organization_type IN ('city', 'kingdom', 'world')),
  organization_id text NULL,
  source_system text NULL,
  source_id text NULL,
  source_operation_key text NULL,
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 240),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (octet_length(metadata::text) <= 16384),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  coverage_domain text NOT NULL DEFAULT 'unknown'
    CHECK (length(coverage_domain) BETWEEN 1 AND 80),
  CONSTRAINT economy_event_asset_shape CHECK (
    (asset_kind = 'unique' AND unique_asset_instance_id IS NOT NULL AND quantity = 1)
    OR
    (asset_kind = 'fungible' AND unique_asset_instance_id IS NULL)
  ),
  CONSTRAINT economy_event_transfer_shape CHECK (
    (event_kind = 'TRANSFER' AND transfer_group_id IS NOT NULL)
    OR
    (event_kind <> 'TRANSFER' AND transfer_group_id IS NULL)
  ),
  CONSTRAINT economy_event_kind_leg_shape CHECK (
    (event_kind = 'SOURCE' AND leg = 'credit')
    OR (event_kind = 'SINK' AND leg = 'debit')
    OR event_kind IN ('TRANSFER', 'TRANSFORM', 'ADMIN', 'UNKNOWN')
  ),
  CONSTRAINT economy_event_source_shape CHECK (
    (source_system IS NULL AND source_id IS NULL)
    OR
    (source_system IS NOT NULL AND source_id IS NOT NULL
      AND length(source_system) BETWEEN 1 AND 80
      AND length(source_id) BETWEEN 1 AND 240)
  ),
  CONSTRAINT economy_event_owner_shape CHECK (
    (organization_type IS NULL AND organization_id IS NULL)
    OR
    (organization_type IS NOT NULL AND organization_id IS NOT NULL
      AND length(organization_id) BETWEEN 1 AND 160)
  )
);

-- Keep the full nullable-safe unique index as the conflict arbiter for
-- idempotent projections. PostgreSQL cannot infer a partial index from
-- ON CONFLICT (source_system, source_id); NULL source identities remain
-- naturally repeatable under a regular UNIQUE index.
CREATE UNIQUE INDEX IF NOT EXISTS economy_events_source_identity_idx
  ON economy_events (source_system, source_id);
CREATE INDEX IF NOT EXISTS economy_events_occurred_idx
  ON economy_events (occurred_at DESC, event_id);
CREATE INDEX IF NOT EXISTS economy_events_asset_idx
  ON economy_events (asset_id, variant, occurred_at DESC);
CREATE INDEX IF NOT EXISTS economy_events_transfer_group_idx
  ON economy_events (transfer_group_id, event_id)
  WHERE transfer_group_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS economy_events_player_idx
  ON economy_events (player_id, occurred_at DESC)
  WHERE player_id IS NOT NULL;

CREATE OR REPLACE FUNCTION reject_economy_event_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'economy events and transfer groups are append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS economy_events_immutable ON economy_events;
CREATE TRIGGER economy_events_immutable
BEFORE UPDATE OR DELETE ON economy_events
FOR EACH ROW EXECUTE FUNCTION reject_economy_event_mutation();

DROP TRIGGER IF EXISTS economy_transfer_groups_immutable ON economy_transfer_groups;
CREATE TRIGGER economy_transfer_groups_immutable
BEFORE UPDATE OR DELETE ON economy_transfer_groups
FOR EACH ROW EXECUTE FUNCTION reject_economy_event_mutation();

CREATE OR REPLACE FUNCTION economy_assert_transfer_group_balanced()
RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM economy_events event
    WHERE event.transfer_group_id = NEW.transfer_group_id
    GROUP BY event.asset_kind, event.asset_id, event.variant,
             event.unique_asset_instance_id
    HAVING count(*) FILTER (WHERE event.leg = 'debit') = 0
        OR count(*) FILTER (WHERE event.leg = 'credit') = 0
        OR sum(CASE WHEN event.leg = 'credit' THEN event.quantity ELSE -event.quantity END) <> 0
  ) THEN
    RAISE EXCEPTION 'economy transfer group % is not globally net zero', NEW.transfer_group_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS economy_events_transfer_balance ON economy_events;
CREATE CONSTRAINT TRIGGER economy_events_transfer_balance
AFTER INSERT OR UPDATE ON economy_events
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION economy_assert_transfer_group_balanced();

CREATE OR REPLACE FUNCTION economy_classify_inventory_source(source_value text)
RETURNS text AS $$
DECLARE source_key text := lower(coalesce(source_value, ''));
BEGIN
  IF source_key ~ '(craft|process|smelt|cook|furnace|tannery|butcher|loom|repair_kit|transform)' THEN
    RETURN 'TRANSFORM';
  ELSIF source_key ~ '(development|dev_|admin|moderation|migration)' THEN
    RETURN 'ADMIN';
  ELSIF source_key ~ '(harvest|reward|starter|spawn|production|grant|overture|replenish|combat)' THEN
    RETURN 'SOURCE';
  ELSIF source_key ~ '(consume|hunger|construction|build|repair|burn|destroy|spend|fee|tax|demolition)' THEN
    RETURN 'SINK';
  END IF;
  RETURN 'UNKNOWN';
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION economy_classify_wallet_reason(reason_value text)
RETURNS text AS $$
DECLARE reason_key text := lower(coalesce(reason_value, ''));
BEGIN
  IF reason_key ~ '(development|dev_|admin|moderation)' THEN
    RETURN 'ADMIN';
  ELSIF reason_key ~ '(reward|compensation|refund|mint|grant)' THEN
    RETURN 'SOURCE';
  ELSIF reason_key ~ '(fee|tax|spend|purchase|construction|repair|donation)' THEN
    RETURN 'SINK';
  END IF;
  RETURN 'UNKNOWN';
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION record_inventory_economy_event()
RETURNS trigger AS $$
DECLARE event_kind_value text := economy_classify_inventory_source(NEW.source);
BEGIN
  -- Market inventory movements are represented by the market double-entry
  -- ledger trigger below. Projecting them here as SOURCE/SINK would count an
  -- ownership transfer as global creation or destruction.
  IF lower(NEW.source) LIKE 'market%'
     OR lower(NEW.source) IN ('drop_item', 'pickup_dropped_item')
     OR lower(NEW.source) IN ('kingdom_donation', 'city_warehouse_donation', 'city_warehouse_bulk_donation')
     OR lower(NEW.source) LIKE 'manor_stack_%'
     OR lower(NEW.source) LIKE 'manor_bulk_%' THEN
    RETURN NEW;
  END IF;
  INSERT INTO economy_events (
    event_group_id, leg, event_kind, asset_kind, asset_id, item_id, variant,
    quantity, custody_type, custody_id, player_id, source_system, source_id,
    source_operation_key, reason, metadata, occurred_at, coverage_domain
  ) VALUES (
    gen_random_uuid(),
    CASE WHEN NEW.delta_quantity > 0 THEN 'credit' ELSE 'debit' END,
    event_kind_value, 'fungible', NEW.item_id, NEW.item_id, NEW.variant,
    abs(NEW.delta_quantity), 'player_inventory', NEW.player_id, NEW.player_id,
    'inventory_events', NEW.id::text, NEW.operation_key, NEW.source,
    coalesce(NEW.metadata, '{}'::jsonb), NEW.created_at, 'inventory'
  ) ON CONFLICT (source_system, source_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS inventory_events_economy_observatory ON inventory_events;
CREATE TRIGGER inventory_events_economy_observatory
AFTER INSERT ON inventory_events
FOR EACH ROW EXECUTE FUNCTION record_inventory_economy_event();

CREATE OR REPLACE FUNCTION record_wallet_economy_event()
RETURNS trigger AS $$
BEGIN
  -- Market wallet movements are represented by market_ledger_entries. Keep
  -- the wallet projection for external/admin economy changes only so a trade
  -- cannot be counted again as currency creation or destruction.
  IF lower(NEW.reason) LIKE 'market%' OR lower(NEW.reason) = 'city_gold_donation' THEN
    RETURN NEW;
  END IF;
  INSERT INTO economy_events (
    event_group_id, leg, event_kind, asset_kind, asset_id, variant,
    quantity, custody_type, custody_id, player_id, source_system, source_id,
    source_operation_key, reason, metadata, occurred_at, coverage_domain
  ) VALUES (
    gen_random_uuid(),
    CASE WHEN NEW.delta_gold > 0 THEN 'credit' ELSE 'debit' END,
    economy_classify_wallet_reason(NEW.reason), 'fungible', 'gold', 'default',
    abs(NEW.delta_gold), 'player_wallet', NEW.player_id, NEW.player_id,
    'wallet_events', NEW.event_id::text, NEW.operation_key, NEW.reason,
    coalesce(NEW.metadata, '{}'::jsonb), NEW.created_at, 'wallet'
  ) ON CONFLICT (source_system, source_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS wallet_events_economy_observatory ON wallet_events;
CREATE TRIGGER wallet_events_economy_observatory
AFTER INSERT ON wallet_events
FOR EACH ROW EXECUTE FUNCTION record_wallet_economy_event();

CREATE OR REPLACE FUNCTION record_city_coin_economy_event()
RETURNS trigger AS $$
BEGIN
  INSERT INTO economy_events (
    event_group_id, leg, event_kind, asset_kind, asset_id, variant,
    quantity, custody_type, custody_id, player_id, organization_type,
    organization_id, source_system, source_id, source_operation_key, reason,
    metadata, occurred_at, coverage_domain
  ) VALUES (
    gen_random_uuid(),
    CASE WHEN NEW.delta > 0 THEN 'credit' ELSE 'debit' END,
    CASE WHEN NEW.entry_type = 'construction_spend' THEN 'SINK' ELSE 'SOURCE' END,
    'fungible', 'city_coin', 'default', abs(NEW.delta), 'city_treasury',
    NEW.city_id::text, NEW.player_id, 'city', NEW.city_id::text,
    'city_coin_ledger', NEW.entry_id::text, NEW.operation_key, NEW.entry_type,
    coalesce(NEW.metadata, '{}'::jsonb), NEW.created_at, 'city_treasury'
  ) ON CONFLICT (source_system, source_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS city_coin_ledger_economy_observatory ON city_coin_ledger;
CREATE TRIGGER city_coin_ledger_economy_observatory
AFTER INSERT ON city_coin_ledger
FOR EACH ROW EXECUTE FUNCTION record_city_coin_economy_event();

CREATE OR REPLACE FUNCTION record_city_gold_economy_event()
RETURNS trigger AS $$
DECLARE
  transfer_id uuid;
  operation_value text := 'city-gold:' || NEW.operation_key;
BEGIN
  IF NEW.entry_type = 'member_donation' AND NEW.player_id IS NOT NULL THEN
    INSERT INTO economy_transfer_groups (
      transfer_group_id, operation_key, reason
    ) VALUES (
      gen_random_uuid(), operation_value, 'City Gold donation'
    ) ON CONFLICT (operation_key) DO NOTHING;
    SELECT group_row.transfer_group_id
    INTO transfer_id
    FROM economy_transfer_groups group_row
    WHERE group_row.operation_key = operation_value;

    INSERT INTO economy_events (
      event_group_id, transfer_group_id, leg, event_kind, asset_kind, asset_id,
      variant, quantity, custody_type, custody_id, player_id,
      organization_type, organization_id, source_system, source_id,
      source_operation_key, reason, metadata, occurred_at, coverage_domain
    ) VALUES
    (
      transfer_id, transfer_id, 'debit', 'TRANSFER', 'fungible', 'gold', 'default',
      abs(NEW.delta), 'player_wallet', NEW.player_id, NEW.player_id,
      NULL, NULL, 'city_gold_ledger', NEW.entry_id::text || ':debit',
      NEW.operation_key, 'city_gold_donation', coalesce(NEW.metadata, '{}'::jsonb),
      NEW.created_at, 'city_treasury'
    ),
    (
      transfer_id, transfer_id, 'credit', 'TRANSFER', 'fungible', 'gold', 'default',
      abs(NEW.delta), 'city_gold_reserve', NEW.city_id::text, NEW.player_id,
      'city', NEW.city_id::text, 'city_gold_ledger', NEW.entry_id::text || ':credit',
      NEW.operation_key, 'city_gold_donation', coalesce(NEW.metadata, '{}'::jsonb),
      NEW.created_at, 'city_treasury'
    ) ON CONFLICT (source_system, source_id) DO NOTHING;
    RETURN NEW;
  END IF;

  INSERT INTO economy_events (
    event_group_id, leg, event_kind, asset_kind, asset_id, variant,
    quantity, custody_type, custody_id, player_id, organization_type,
    organization_id, source_system, source_id, source_operation_key, reason,
    metadata, occurred_at, coverage_domain
  ) VALUES (
    gen_random_uuid(),
    CASE WHEN NEW.delta > 0 THEN 'credit' ELSE 'debit' END,
    CASE WHEN NEW.entry_type = 'construction_spend' THEN 'SINK' ELSE 'SOURCE' END,
    'fungible', 'gold', 'default', abs(NEW.delta), 'city_gold_reserve',
    NEW.city_id::text, NEW.player_id, 'city', NEW.city_id::text,
    'city_gold_ledger', NEW.entry_id::text, NEW.operation_key, NEW.entry_type,
    coalesce(NEW.metadata, '{}'::jsonb), NEW.created_at, 'city_treasury'
  ) ON CONFLICT (source_system, source_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS city_gold_ledger_economy_observatory ON city_gold_ledger;
CREATE TRIGGER city_gold_ledger_economy_observatory
AFTER INSERT ON city_gold_ledger
FOR EACH ROW EXECUTE FUNCTION record_city_gold_economy_event();

CREATE OR REPLACE FUNCTION record_city_warehouse_economy_event()
RETURNS trigger AS $$
DECLARE
  transfer_id uuid := gen_random_uuid();
  operation_value text := 'city-warehouse:' || NEW.operation_key;
BEGIN
  IF NEW.item_id IS NULL OR NEW.quantity IS NULL OR NEW.quantity <= 0 THEN
    RETURN NEW;
  END IF;

  IF NEW.event_type = 'donated' THEN
    INSERT INTO economy_transfer_groups (
      transfer_group_id, operation_key, reason
    ) VALUES (
      transfer_id, operation_value, 'City Warehouse donation'
    ) ON CONFLICT (operation_key) DO NOTHING;
    SELECT group_row.transfer_group_id
    INTO transfer_id
    FROM economy_transfer_groups group_row
    WHERE group_row.operation_key = operation_value;

    INSERT INTO economy_events (
      event_group_id, transfer_group_id, leg, event_kind, asset_kind, asset_id,
      item_id, variant, quantity, custody_type, custody_id, player_id,
      organization_type, organization_id, source_system, source_id,
      source_operation_key, reason, metadata, occurred_at, coverage_domain
    ) VALUES
    (
      transfer_id, transfer_id, 'debit', 'TRANSFER', 'fungible', NEW.item_id,
      NEW.item_id, coalesce(NEW.variant, 'default'), NEW.quantity,
      'player_inventory', NEW.actor_player_id, NEW.actor_player_id,
      NULL, NULL, 'city_warehouse_events', NEW.event_id::text || ':debit',
      NEW.operation_key, 'city_warehouse_donation',
      jsonb_build_object('cityId', NEW.city_id), NEW.created_at, 'city_warehouse'
    ),
    (
      transfer_id, transfer_id, 'credit', 'TRANSFER', 'fungible', NEW.item_id,
      NEW.item_id, coalesce(NEW.variant, 'default'), NEW.quantity,
      'city_warehouse', NEW.city_id::text, NULL,
      'city', NEW.city_id::text, 'city_warehouse_events',
      NEW.event_id::text || ':credit', NEW.operation_key,
      'city_warehouse_donation', jsonb_build_object('playerId', NEW.actor_player_id),
      NEW.created_at, 'city_warehouse'
    ) ON CONFLICT (source_system, source_id) DO NOTHING;
  ELSIF NEW.event_type = 'consumed' THEN
    INSERT INTO economy_events (
      event_group_id, leg, event_kind, asset_kind, asset_id, item_id, variant,
      quantity, custody_type, custody_id, player_id, organization_type,
      organization_id, source_system, source_id, source_operation_key, reason,
      metadata, occurred_at, coverage_domain
    ) VALUES (
      gen_random_uuid(), 'debit', 'SINK', 'fungible', NEW.item_id, NEW.item_id,
      coalesce(NEW.variant, 'default'), NEW.quantity, 'city_warehouse',
      NEW.city_id::text, NEW.actor_player_id, 'city', NEW.city_id::text,
      'city_warehouse_events', NEW.event_id::text || ':sink', NEW.operation_key,
      'city_warehouse_consume', coalesce(NEW.details, '{}'::jsonb), NEW.created_at,
      'city_warehouse'
    ) ON CONFLICT (source_system, source_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS city_warehouse_events_economy_observatory ON city_warehouse_events;
CREATE TRIGGER city_warehouse_events_economy_observatory
AFTER INSERT ON city_warehouse_events
FOR EACH ROW EXECUTE FUNCTION record_city_warehouse_economy_event();

CREATE OR REPLACE FUNCTION record_kingdom_donation_economy_transfer()
RETURNS trigger AS $$
DECLARE transfer_id uuid := gen_random_uuid();
BEGIN
  INSERT INTO economy_transfer_groups (
    transfer_group_id, operation_key, reason
  ) VALUES (
    transfer_id, 'kingdom-donation:' || NEW.id::text, 'Kingdom donation'
  ) ON CONFLICT (operation_key) DO NOTHING;
  INSERT INTO economy_events (
    event_group_id, transfer_group_id, leg, event_kind, asset_kind, asset_id,
    item_id, variant, quantity, custody_type, custody_id, player_id,
    organization_type, organization_id, source_system, source_id,
    source_operation_key, reason, metadata, occurred_at, coverage_domain
  ) VALUES
  (
    transfer_id, transfer_id, 'debit', 'TRANSFER', 'fungible', NEW.resource_type,
    NEW.resource_type, NEW.variant, NEW.quantity, 'player_inventory',
    NEW.donor_player_id, NEW.donor_player_id, NULL, NULL,
    'kingdom_donations', NEW.id::text || ':debit', NEW.request_id,
    'kingdom_donation', jsonb_build_object('kingdomId', NEW.kingdom_id),
    NEW.created_at, 'kingdom_treasury'
  ),
  (
    transfer_id, transfer_id, 'credit', 'TRANSFER', 'fungible', NEW.resource_type,
    NEW.resource_type, NEW.variant, NEW.quantity, 'kingdom_treasury',
    NEW.kingdom_id::text, NULL, 'kingdom', NEW.kingdom_id::text,
    'kingdom_donations', NEW.id::text || ':credit', NEW.request_id,
    'kingdom_donation', jsonb_build_object('playerId', NEW.donor_player_id),
    NEW.created_at, 'kingdom_treasury'
  ) ON CONFLICT (source_system, source_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS kingdom_donations_economy_observatory ON kingdom_donations;
CREATE TRIGGER kingdom_donations_economy_observatory
AFTER INSERT ON kingdom_donations
FOR EACH ROW EXECUTE FUNCTION record_kingdom_donation_economy_transfer();

CREATE OR REPLACE FUNCTION record_world_item_movement_economy_event()
RETURNS trigger AS $$
DECLARE
  transfer_id uuid := gen_random_uuid();
  operation_value text := 'world-item-movement:' || NEW.movement_id::text;
  world_custody text := NEW.drop_id::text;
BEGIN
  IF NEW.movement_kind = 'world_to_destruction' THEN
    INSERT INTO economy_events (
      event_group_id, leg, event_kind, asset_kind, asset_id, item_id, variant,
      quantity, custody_type, custody_id, organization_type, organization_id,
      source_system, source_id, source_operation_key, reason, metadata,
      occurred_at, coverage_domain
    ) VALUES (
      gen_random_uuid(), 'debit', 'SINK', 'fungible', NEW.item_id, NEW.item_id,
      NEW.variant, NEW.quantity, 'world_drop', world_custody, 'world', 'world',
      'world_item_movements', NEW.movement_id::text, NEW.operation_key,
      NEW.reason, jsonb_build_object('dropId', NEW.drop_id), NEW.created_at,
      'world_drops'
    ) ON CONFLICT (source_system, source_id) DO NOTHING;
    RETURN NEW;
  END IF;

  IF NEW.movement_kind = 'system_to_world' THEN
    INSERT INTO economy_events (
      event_group_id, leg, event_kind, asset_kind, asset_id, item_id, variant,
      quantity, custody_type, custody_id, organization_type, organization_id,
      source_system, source_id, source_operation_key, reason, metadata,
      occurred_at, coverage_domain
    ) VALUES (
      gen_random_uuid(), 'credit', 'SOURCE', 'fungible', NEW.item_id, NEW.item_id,
      NEW.variant, NEW.quantity, 'world_drop', world_custody, 'world', 'world',
      'world_item_movements', NEW.movement_id::text, NEW.operation_key,
      NEW.reason, jsonb_build_object('dropId', NEW.drop_id), NEW.created_at,
      'world_drops'
    ) ON CONFLICT (source_system, source_id) DO NOTHING;
    RETURN NEW;
  END IF;

  INSERT INTO economy_transfer_groups (
    transfer_group_id, operation_key, reason
  ) VALUES (
    transfer_id, operation_value, 'World item custody movement'
  ) ON CONFLICT (operation_key) DO NOTHING;
  SELECT group_row.transfer_group_id
  INTO transfer_id
  FROM economy_transfer_groups group_row
  WHERE group_row.operation_key = operation_value;

  INSERT INTO economy_events (
    event_group_id, transfer_group_id, leg, event_kind, asset_kind, asset_id,
    item_id, variant, quantity, custody_type, custody_id, player_id,
    organization_type, organization_id, source_system, source_id,
    source_operation_key, reason, metadata, occurred_at, coverage_domain
  ) VALUES
  (
    transfer_id, transfer_id, 'debit', 'TRANSFER', 'fungible', NEW.item_id,
    NEW.item_id, NEW.variant, NEW.quantity,
    CASE WHEN NEW.movement_kind = 'player_to_world' THEN 'player_inventory' ELSE 'world_drop' END,
    CASE WHEN NEW.movement_kind = 'player_to_world' THEN NEW.player_id ELSE world_custody END,
    CASE WHEN NEW.movement_kind = 'player_to_world' THEN NEW.player_id ELSE NULL END,
    CASE WHEN NEW.movement_kind = 'player_to_world' THEN NULL ELSE 'world' END,
    CASE WHEN NEW.movement_kind = 'player_to_world' THEN NULL ELSE 'world' END,
    'world_item_movements', NEW.movement_id::text || ':debit', NEW.operation_key,
    NEW.reason, jsonb_build_object('dropId', NEW.drop_id, 'movementKind', NEW.movement_kind),
    NEW.created_at, 'world_drops'
  ),
  (
    transfer_id, transfer_id, 'credit', 'TRANSFER', 'fungible', NEW.item_id,
    NEW.item_id, NEW.variant, NEW.quantity,
    CASE WHEN NEW.movement_kind = 'player_to_world' THEN 'world_drop' ELSE 'player_inventory' END,
    CASE WHEN NEW.movement_kind = 'player_to_world' THEN world_custody ELSE NEW.player_id END,
    CASE WHEN NEW.movement_kind = 'player_to_world' THEN NULL ELSE NEW.player_id END,
    CASE WHEN NEW.movement_kind = 'player_to_world' THEN 'world' ELSE NULL END,
    CASE WHEN NEW.movement_kind = 'player_to_world' THEN 'world' ELSE NULL END,
    'world_item_movements', NEW.movement_id::text || ':credit', NEW.operation_key,
    NEW.reason, jsonb_build_object('dropId', NEW.drop_id, 'movementKind', NEW.movement_kind),
    NEW.created_at, 'world_drops'
  ) ON CONFLICT (source_system, source_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS world_item_movements_economy_observatory ON world_item_movements;
CREATE TRIGGER world_item_movements_economy_observatory
AFTER INSERT ON world_item_movements
FOR EACH ROW EXECUTE FUNCTION record_world_item_movement_economy_event();

CREATE OR REPLACE FUNCTION record_equipment_operation_economy_event()
RETURNS trigger AS $$
DECLARE
  transfer_id uuid := gen_random_uuid();
  operation_value text := 'equipment-operation:' || NEW.operation_key;
  definition_value text;
  instance_value text := NEW.instance_id::text;
BEGIN
  IF NEW.action NOT IN ('ground_drop', 'ground_pickup', 'ground_expire')
     OR NEW.instance_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT instance.definition_id
  INTO definition_value
  FROM equipment_instances instance
  WHERE instance.instance_id = NEW.instance_id;
  IF definition_value IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.action = 'ground_expire' THEN
    INSERT INTO economy_events (
      event_group_id, leg, event_kind, asset_kind, asset_id, item_id, variant,
      unique_asset_instance_id, quantity, custody_type, custody_id,
      organization_type, organization_id, source_system, source_id,
      source_operation_key, reason, metadata, occurred_at, coverage_domain
    ) VALUES (
      gen_random_uuid(), 'debit', 'SINK', 'unique', definition_value, definition_value,
      'unique', NEW.instance_id, 1, 'world_drop', instance_value, 'world', 'world',
      'equipment_operations', NEW.operation_key, NEW.operation_key, NEW.action,
      coalesce(NEW.result, '{}'::jsonb), coalesce(NEW.completed_at, NEW.created_at),
      'equipment'
    ) ON CONFLICT (source_system, source_id) DO NOTHING;
    RETURN NEW;
  END IF;

  INSERT INTO economy_transfer_groups (
    transfer_group_id, operation_key, reason
  ) VALUES (
    transfer_id, operation_value, 'Unique equipment ground movement'
  ) ON CONFLICT (operation_key) DO NOTHING;
  SELECT group_row.transfer_group_id
  INTO transfer_id
  FROM economy_transfer_groups group_row
  WHERE group_row.operation_key = operation_value;

  INSERT INTO economy_events (
    event_group_id, transfer_group_id, leg, event_kind, asset_kind, asset_id,
    item_id, variant, unique_asset_instance_id, quantity, custody_type,
    custody_id, player_id, organization_type, organization_id, source_system,
    source_id, source_operation_key, reason, metadata, occurred_at,
    coverage_domain
  ) VALUES
  (
    transfer_id, transfer_id, 'debit', 'TRANSFER', 'unique', definition_value,
    definition_value, 'unique', NEW.instance_id, 1,
    CASE WHEN NEW.action = 'ground_drop' THEN 'equipment' ELSE 'world_drop' END,
    CASE WHEN NEW.action = 'ground_drop' THEN instance_value ELSE instance_value END,
    CASE WHEN NEW.action = 'ground_drop' THEN NEW.player_id ELSE NULL END,
    CASE WHEN NEW.action = 'ground_drop' THEN NULL ELSE 'world' END,
    CASE WHEN NEW.action = 'ground_drop' THEN NULL ELSE 'world' END,
    'equipment_operations', NEW.operation_key || ':debit', NEW.operation_key,
    NEW.action, coalesce(NEW.result, '{}'::jsonb), coalesce(NEW.completed_at, NEW.created_at),
    'equipment'
  ),
  (
    transfer_id, transfer_id, 'credit', 'TRANSFER', 'unique', definition_value,
    definition_value, 'unique', NEW.instance_id, 1,
    CASE WHEN NEW.action = 'ground_drop' THEN 'world_drop' ELSE 'equipment' END,
    CASE WHEN NEW.action = 'ground_drop' THEN instance_value ELSE instance_value END,
    CASE WHEN NEW.action = 'ground_drop' THEN NULL ELSE NEW.player_id END,
    CASE WHEN NEW.action = 'ground_drop' THEN 'world' ELSE NULL END,
    CASE WHEN NEW.action = 'ground_drop' THEN 'world' ELSE NULL END,
    'equipment_operations', NEW.operation_key || ':credit', NEW.operation_key,
    NEW.action, coalesce(NEW.result, '{}'::jsonb), coalesce(NEW.completed_at, NEW.created_at),
    'equipment'
  ) ON CONFLICT (source_system, source_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS equipment_operations_economy_observatory ON equipment_operations;
CREATE TRIGGER equipment_operations_economy_observatory
AFTER INSERT ON equipment_operations
FOR EACH ROW EXECUTE FUNCTION record_equipment_operation_economy_event();

CREATE OR REPLACE FUNCTION record_manor_storage_stack_economy_transfer()
RETURNS trigger AS $$
DECLARE
  quantity_delta bigint := coalesce(NEW.quantity_after, 0) - coalesce(NEW.quantity_before, 0);
  transfer_id uuid := gen_random_uuid();
  operation_value text := 'manor-storage:' || NEW.operation_key;
  debit_custody text;
  debit_id text;
  debit_player text;
  credit_custody text;
  credit_id text;
  credit_player text;
BEGIN
  IF NEW.action NOT IN ('transfer', 'bulk_store', 'bulk_take')
     OR NEW.item_id IS NULL OR quantity_delta = 0 THEN
    RETURN NEW;
  END IF;

  IF quantity_delta > 0 THEN
    debit_custody := 'player_inventory';
    debit_id := NEW.player_id;
    debit_player := NEW.player_id;
    credit_custody := 'manor_storage';
    credit_id := NEW.manor_id::text;
    credit_player := NEW.player_id;
  ELSE
    debit_custody := 'manor_storage';
    debit_id := NEW.manor_id::text;
    debit_player := NEW.player_id;
    credit_custody := 'player_inventory';
    credit_id := NEW.player_id;
    credit_player := NEW.player_id;
  END IF;

  INSERT INTO economy_transfer_groups (
    transfer_group_id, operation_key, reason
    ) VALUES (
      transfer_id, operation_value, 'Manor storage transfer'
  ) ON CONFLICT (operation_key) DO NOTHING;
  SELECT group_row.transfer_group_id
  INTO transfer_id
  FROM economy_transfer_groups group_row
  WHERE group_row.operation_key = operation_value;

  INSERT INTO economy_events (
    event_group_id, transfer_group_id, leg, event_kind, asset_kind, asset_id,
    item_id, variant, quantity, custody_type, custody_id, player_id,
    source_system, source_id, source_operation_key, reason, metadata,
    occurred_at, coverage_domain
  ) VALUES
  (
    transfer_id, transfer_id, 'debit', 'TRANSFER', 'fungible', NEW.item_id,
    NEW.item_id, coalesce(NEW.variant, 'default'), abs(quantity_delta),
    debit_custody, debit_id, debit_player, 'manor_storage_stack_events',
    NEW.id::text || ':debit', NEW.operation_key, 'manor_storage_transfer',
    jsonb_build_object('action', NEW.action, 'manorId', NEW.manor_id),
    NEW.created_at, 'manor_storage'
  ),
  (
    transfer_id, transfer_id, 'credit', 'TRANSFER', 'fungible', NEW.item_id,
    NEW.item_id, coalesce(NEW.variant, 'default'), abs(quantity_delta),
    credit_custody, credit_id, credit_player, 'manor_storage_stack_events',
    NEW.id::text || ':credit', NEW.operation_key, 'manor_storage_transfer',
    jsonb_build_object('action', NEW.action, 'manorId', NEW.manor_id),
    NEW.created_at, 'manor_storage'
  ) ON CONFLICT (source_system, source_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS manor_storage_stack_events_economy_observatory ON manor_storage_stack_events;
CREATE TRIGGER manor_storage_stack_events_economy_observatory
AFTER INSERT ON manor_storage_stack_events
FOR EACH ROW EXECUTE FUNCTION record_manor_storage_stack_economy_transfer();

CREATE OR REPLACE FUNCTION record_market_economy_transfer()
RETURNS trigger AS $$
DECLARE
  transfer_id uuid := NEW.ledger_group_id;
  custody_value text := CASE NEW.account_location
    WHEN 'player_inventory' THEN 'player_inventory'
    WHEN 'sell_escrow' THEN 'market_escrow'
    WHEN 'buyer_collection' THEN 'market_collection'
    WHEN 'return_collection' THEN 'market_collection'
    WHEN 'player_wallet' THEN 'player_wallet'
    WHEN 'buy_escrow' THEN 'market_escrow'
    WHEN 'seller_proceeds' THEN 'market_collection'
    WHEN 'refund_balance' THEN 'market_collection'
    WHEN 'fee_sink' THEN 'external'
    ELSE 'unknown'
  END;
BEGIN
  INSERT INTO economy_transfer_groups (
    transfer_group_id, operation_key, reason
  ) VALUES (
    transfer_id, 'market-ledger:' || transfer_id::text, NEW.reason
  ) ON CONFLICT (transfer_group_id) DO NOTHING;
  INSERT INTO economy_events (
    event_group_id, transfer_group_id, leg, event_kind, asset_kind, asset_id,
    variant, quantity, custody_type, custody_id, player_id, source_system,
    source_id, source_operation_key, reason, metadata, occurred_at, coverage_domain
  ) VALUES (
    transfer_id, transfer_id,
    CASE WHEN NEW.amount < 0 THEN 'debit' ELSE 'credit' END,
    'TRANSFER',
    CASE WHEN NEW.asset_kind = 'item' THEN 'fungible' ELSE 'fungible' END,
    coalesce(NEW.item_identity, 'gold'), 'default', abs(NEW.amount), custody_value,
    coalesce(NEW.player_id::text, NEW.account_location), NEW.player_id,
    'market_ledger_entries', NEW.ledger_entry_id::text, transfer_id::text,
    NEW.reason, jsonb_build_object('accountLocation', NEW.account_location),
    NEW.created_at, 'market'
  ) ON CONFLICT (source_system, source_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS market_ledger_entries_economy_observatory ON market_ledger_entries;
CREATE TRIGGER market_ledger_entries_economy_observatory
AFTER INSERT ON market_ledger_entries
FOR EACH ROW EXECUTE FUNCTION record_market_economy_transfer();

CREATE TABLE IF NOT EXISTS economy_instrumentation_coverage (
  domain_key text PRIMARY KEY CHECK (length(domain_key) BETWEEN 1 AND 80),
  status text NOT NULL CHECK (status IN ('complete', 'partial', 'unavailable')),
  reliable_from timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_observed_at timestamptz NULL,
  notes text NOT NULL CHECK (length(notes) <= 500),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO economy_instrumentation_coverage (domain_key, status, notes)
VALUES
  ('inventory', 'complete', 'Authoritative inventory events are projected by an AFTER INSERT trigger.'),
  ('wallet', 'complete', 'Authoritative wallet events are projected by an AFTER INSERT trigger.'),
  ('equipment', 'partial', 'Current unique equipment custody is read from equipment_instances; unique transfer history is not backfilled.'),
  ('backpack', 'partial', 'Current unique backpack custody is read from player_backpack_instances; unique transfer history is not backfilled.'),
  ('manor_storage', 'partial', 'Current manor stacks and migration-retained overflow are read directly; fungible storage transfers are projected, unique transfer history is not backfilled.'),
  ('city_warehouse', 'complete', 'Current city warehouse stacks are read directly; donation and consumption boundaries are projected from immutable warehouse events.'),
  ('city_treasury', 'complete', 'City coin and gold ledger boundaries are projected and balances are read directly.'),
  ('kingdom_treasury', 'partial', 'Kingdom balances and donation/expenditure boundaries are projected; legacy mutations remain partial.'),
  ('market', 'partial', 'Fungible market ledger rows are projected as balanced transfer groups; unique equipment market custody is current-state only.'),
  ('harvest', 'complete', 'Harvest outputs terminate at authoritative inventory events.'),
  ('crafting', 'complete', 'Crafting and processing terminate at typed inventory events.'),
  ('construction', 'partial', 'Material spends terminate at inventory events; durable structure value is not monetized.'),
  ('world_drops', 'partial', 'New ground-drop movements are projected as transfers or sinks; historical movement rows are not backfilled.'),
  ('packages', 'partial', 'Pending package rows are represented as committed/future supply until claimed.'),
  ('sessions', 'complete', 'Connection lifecycle and non-PING gameplay activity are persisted by the session sink.')
ON CONFLICT (domain_key) DO UPDATE
SET status = EXCLUDED.status, notes = EXCLUDED.notes, updated_at = clock_timestamp();

CREATE TABLE IF NOT EXISTS economy_snapshot_runs (
  snapshot_id uuid PRIMARY KEY,
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz NOT NULL,
  completed_at timestamptz NULL,
  snapshot_as_of timestamptz NULL,
  isolation_level text NOT NULL DEFAULT 'REPEATABLE READ',
  status text NOT NULL CHECK (status IN ('running', 'completed', 'partial', 'failed')),
  source_watermarks jsonb NOT NULL DEFAULT '{}'::jsonb,
  reconciliation jsonb NOT NULL DEFAULT '{}'::jsonb,
  stale_sources text[] NOT NULL DEFAULT '{}',
  error text NULL,
  CHECK (completed_at IS NULL OR completed_at >= started_at),
  CHECK ((status = 'running') = (completed_at IS NULL))
);

CREATE TABLE IF NOT EXISTS economy_snapshot_holdings (
  holding_id bigserial PRIMARY KEY,
  snapshot_id uuid NOT NULL REFERENCES economy_snapshot_runs(snapshot_id) ON DELETE CASCADE,
  supply_scope text NOT NULL CHECK (supply_scope IN (
    'existing_world_supply', 'player_controlled_existing_supply',
    'organization_existing_supply', 'world_available_supply',
    'committed_or_future_supply'
  )),
  asset_kind text NOT NULL CHECK (asset_kind IN ('fungible', 'unique')),
  asset_id text NOT NULL,
  item_id text NULL,
  variant text NOT NULL DEFAULT 'default',
  unique_asset_instance_id uuid NULL,
  quantity bigint NOT NULL CHECK (quantity > 0),
  custody_type text NOT NULL,
  custody_id text NOT NULL,
  player_id text NULL,
  organization_type text NULL,
  organization_id text NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((asset_kind = 'unique' AND quantity = 1) OR asset_kind = 'fungible')
);

CREATE INDEX IF NOT EXISTS economy_snapshot_holdings_lookup_idx
  ON economy_snapshot_holdings (snapshot_id, supply_scope, asset_id, variant);
CREATE INDEX IF NOT EXISTS economy_snapshot_holdings_player_idx
  ON economy_snapshot_holdings (snapshot_id, player_id, asset_id)
  WHERE player_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS economy_sessions (
  session_id uuid PRIMARY KEY,
  connection_id text NOT NULL UNIQUE,
  account_id uuid NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  auth_session_id text NULL,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  connected_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  last_gameplay_at timestamptz NULL,
  disconnected_at timestamptz NULL,
  connected_seconds bigint NOT NULL DEFAULT 0 CHECK (connected_seconds >= 0),
  active_seconds bigint NOT NULL DEFAULT 0 CHECK (active_seconds >= 0),
  inactive_seconds bigint NOT NULL DEFAULT 0 CHECK (inactive_seconds >= 0),
  state text NOT NULL CHECK (state IN ('connected', 'closed')),
  close_reason text NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (disconnected_at IS NULL OR disconnected_at >= connected_at),
  CHECK ((state = 'connected') = (disconnected_at IS NULL)),
  CHECK (active_seconds <= connected_seconds),
  CHECK (inactive_seconds = connected_seconds - active_seconds)
);

CREATE INDEX IF NOT EXISTS economy_sessions_player_idx
  ON economy_sessions (player_id, connected_at DESC);
CREATE INDEX IF NOT EXISTS economy_sessions_state_idx
  ON economy_sessions (state, last_seen_at DESC);

CREATE OR REPLACE VIEW economy_current_holdings AS
WITH fungible AS (
  SELECT 'player_controlled_existing_supply'::text AS supply_scope, true AS existing_supply,
         'fungible'::text AS asset_kind, inventory.resource_type AS asset_id,
         inventory.resource_type AS item_id, coalesce(inventory.variant, 'default') AS variant,
         inventory.quantity::bigint AS quantity, 'player_inventory'::text AS custody_type,
         inventory.player_id AS custody_id, inventory.player_id, NULL::text AS organization_type,
         NULL::text AS organization_id
  FROM player_inventory inventory WHERE inventory.quantity > 0
  UNION ALL
  SELECT 'existing_world_supply', true, 'fungible', inventory.resource_type,
         inventory.resource_type, coalesce(inventory.variant, 'default'), inventory.quantity::bigint,
         'player_inventory', inventory.player_id, inventory.player_id, NULL, NULL
  FROM player_inventory inventory WHERE inventory.quantity > 0
  UNION ALL
  SELECT 'player_controlled_existing_supply', true, 'fungible', stack.item_id, stack.item_id,
         stack.variant, stack.quantity, 'manor_storage', stack.manor_id::text, manor.owner_player_id,
         NULL, NULL
  FROM manor_storage_stacks stack JOIN player_manors manor ON manor.id = stack.manor_id
  WHERE stack.quantity > 0
  UNION ALL
  SELECT 'existing_world_supply', true, 'fungible', stack.item_id, stack.item_id,
         stack.variant, stack.quantity, 'manor_storage', stack.manor_id::text, manor.owner_player_id,
         NULL, NULL
  FROM manor_storage_stacks stack JOIN player_manors manor ON manor.id = stack.manor_id
  WHERE stack.quantity > 0
  UNION ALL
  SELECT 'player_controlled_existing_supply', true, 'fungible', overflow.item_id, overflow.item_id,
         overflow.variant, overflow.quantity, 'manor_storage', overflow.manor_id::text, manor.owner_player_id,
         NULL, NULL
  FROM manor_storage_overflow overflow JOIN player_manors manor ON manor.id = overflow.manor_id
  WHERE overflow.quantity > 0
  UNION ALL
  SELECT 'existing_world_supply', true, 'fungible', overflow.item_id, overflow.item_id,
         overflow.variant, overflow.quantity, 'manor_storage', overflow.manor_id::text, manor.owner_player_id,
         NULL, NULL
  FROM manor_storage_overflow overflow JOIN player_manors manor ON manor.id = overflow.manor_id
  WHERE overflow.quantity > 0
  UNION ALL
  SELECT 'organization_existing_supply', true, 'fungible', stack.item_id, stack.item_id,
         stack.variant, stack.quantity, 'city_warehouse', stack.city_id::text, NULL, 'city', stack.city_id::text
  FROM city_warehouse_stacks stack WHERE stack.quantity > 0
  UNION ALL
  SELECT 'existing_world_supply', true, 'fungible', stack.item_id, stack.item_id,
         stack.variant, stack.quantity, 'city_warehouse', stack.city_id::text, NULL, 'city', stack.city_id::text
  FROM city_warehouse_stacks stack WHERE stack.quantity > 0
  UNION ALL
  SELECT 'organization_existing_supply', true, 'fungible', balance.resource_type, balance.resource_type,
         balance.variant, balance.quantity, 'kingdom_treasury', balance.kingdom_id::text, NULL,
         'kingdom', balance.kingdom_id::text
  FROM kingdom_treasury_balances balance WHERE balance.quantity > 0
  UNION ALL
  SELECT 'existing_world_supply', true, 'fungible', balance.resource_type, balance.resource_type,
         balance.variant, balance.quantity, 'kingdom_treasury', balance.kingdom_id::text, NULL,
         'kingdom', balance.kingdom_id::text
  FROM kingdom_treasury_balances balance WHERE balance.quantity > 0
  UNION ALL
  SELECT 'world_available_supply', true, 'fungible', drop_row.item_id, drop_row.item_id,
         drop_row.variant, drop_row.remaining_quantity, 'world_drop', drop_row.id::text, NULL, 'world', NULL
  FROM world_item_drops drop_row
  WHERE drop_row.status = 'active' AND drop_row.remaining_quantity > 0
  UNION ALL
  SELECT 'existing_world_supply', true, 'fungible', drop_row.item_id, drop_row.item_id,
         drop_row.variant, drop_row.remaining_quantity, 'world_drop', drop_row.id::text, NULL, 'world', NULL
  FROM world_item_drops drop_row
  WHERE drop_row.status = 'active' AND drop_row.remaining_quantity > 0
  UNION ALL
  SELECT 'player_controlled_existing_supply', true, 'fungible', 'gold', NULL, 'default', wallet.gold_balance,
         'player_wallet', wallet.player_id, wallet.player_id, NULL, NULL
  FROM player_wallets wallet WHERE wallet.gold_balance > 0
  UNION ALL
  SELECT 'existing_world_supply', true, 'fungible', 'gold', NULL, 'default', wallet.gold_balance,
         'player_wallet', wallet.player_id, wallet.player_id, NULL, NULL
  FROM player_wallets wallet WHERE wallet.gold_balance > 0
  UNION ALL
  SELECT 'organization_existing_supply', true, 'fungible', 'gold', NULL, 'default', reserve.balance,
         'city_gold_reserve', reserve.city_id::text, NULL, 'city', reserve.city_id::text
  FROM city_gold_reserves reserve WHERE reserve.balance > 0
  UNION ALL
  SELECT 'existing_world_supply', true, 'fungible', 'gold', NULL, 'default', reserve.balance,
         'city_gold_reserve', reserve.city_id::text, NULL, 'city', reserve.city_id::text
  FROM city_gold_reserves reserve WHERE reserve.balance > 0
  UNION ALL
  SELECT 'organization_existing_supply', true, 'fungible', 'city_coin', NULL, 'default', treasury.balance,
         'city_treasury', treasury.city_id::text, NULL, 'city', treasury.city_id::text
  FROM city_treasuries treasury WHERE treasury.balance > 0
  UNION ALL
  SELECT 'existing_world_supply', true, 'fungible', 'city_coin', NULL, 'default', treasury.balance,
         'city_treasury', treasury.city_id::text, NULL, 'city', treasury.city_id::text
  FROM city_treasuries treasury WHERE treasury.balance > 0
  UNION ALL
  SELECT 'committed_or_future_supply', true, 'fungible', coalesce(escrow.item_identity, escrow.item_id, 'gold'),
         escrow.item_id, coalesce(escrow.variant, 'default'), escrow.remaining_amount, 'market_escrow',
         escrow.order_id::text, escrow.player_id, NULL, NULL
  FROM market_order_escrows escrow WHERE escrow.remaining_amount > 0
  UNION ALL
  SELECT 'existing_world_supply', true, 'fungible', coalesce(escrow.item_identity, escrow.item_id, 'gold'),
         escrow.item_id, coalesce(escrow.variant, 'default'), escrow.remaining_amount, 'market_escrow',
         escrow.order_id::text, escrow.player_id, NULL, NULL
  FROM market_order_escrows escrow WHERE escrow.remaining_amount > 0
  UNION ALL
  SELECT 'committed_or_future_supply', true, 'fungible', coalesce(collection.item_identity, collection.item_id, 'gold'),
         collection.item_id, coalesce(collection.variant, 'default'), collection.remaining_amount,
         'market_collection', collection.collection_id::text, collection.player_id, NULL, NULL
  FROM market_collections collection WHERE collection.remaining_amount > 0
  UNION ALL
  SELECT 'existing_world_supply', true, 'fungible', coalesce(collection.item_identity, collection.item_id, 'gold'),
         collection.item_id, coalesce(collection.variant, 'default'), collection.remaining_amount,
         'market_collection', collection.collection_id::text, collection.player_id, NULL, NULL
  FROM market_collections collection WHERE collection.remaining_amount > 0
  UNION ALL
  SELECT 'committed_or_future_supply', false, 'fungible', package_item.canonical_item_id,
         package_item.canonical_item_id, coalesce(package_item.variant, 'default'),
         package_item.remaining_quantity, 'external', package_item.package_id::text, package.recipient_player_id,
         NULL, NULL
  FROM player_package_items package_item
  JOIN player_packages package ON package.id = package_item.package_id
  WHERE package_item.remaining_quantity > 0
  UNION ALL
  SELECT 'committed_or_future_supply', false, 'fungible', job.job_type, NULL, 'default',
         (job.output_quantity - job.collected_quantity)::bigint, 'external', job.job_id::text,
         job.owner_player_id, NULL, NULL
  FROM military_facility_jobs job
  WHERE job.cleared_at IS NULL AND job.output_quantity > job.collected_quantity
), unique_assets AS (
  SELECT 'player_controlled_existing_supply'::text AS supply_scope, true AS existing_supply,
         'unique'::text AS asset_kind, equipment.definition_id AS asset_id, equipment.definition_id AS item_id,
         'unique'::text AS variant, equipment.instance_id AS unique_asset_instance_id,
         1::bigint AS quantity, 'equipment'::text AS custody_type,
         equipment.instance_id::text AS custody_id, equipment.owner_player_id AS player_id,
         NULL::text AS organization_type, NULL::text AS organization_id
  FROM equipment_instances equipment
  WHERE equipment.location IN ('inventory', 'equipped')
  UNION ALL
  SELECT 'player_controlled_existing_supply', true, 'unique', equipment.definition_id, equipment.definition_id,
         'unique', equipment.instance_id, 1::bigint, 'manor_storage', equipment.manor_id::text,
         equipment.owner_player_id, NULL, NULL
  FROM equipment_instances equipment WHERE equipment.location = 'manor_storage'
  UNION ALL
  SELECT 'committed_or_future_supply', true, 'unique', equipment.definition_id, equipment.definition_id,
         'unique', equipment.instance_id, 1::bigint, 'market_escrow', equipment.market_listing_id::text,
         equipment.owner_player_id, NULL, NULL
  FROM equipment_instances equipment WHERE equipment.location = 'market_escrow'
  UNION ALL
  SELECT 'committed_or_future_supply', true, 'unique', equipment.definition_id, equipment.definition_id,
         'unique', equipment.instance_id, 1::bigint, 'market_collection', equipment.market_collection_id::text,
         equipment.owner_player_id, NULL, NULL
  FROM equipment_instances equipment WHERE equipment.location = 'market_collection'
  UNION ALL
  SELECT 'world_available_supply', true, 'unique', equipment.definition_id, equipment.definition_id,
         'unique', equipment.instance_id, 1::bigint, 'world_drop', equipment.instance_id::text,
         NULL, 'world', NULL
  FROM equipment_instances equipment WHERE equipment.location = 'world_drop'
  UNION ALL
  SELECT 'existing_world_supply', true, 'unique', equipment.definition_id, equipment.definition_id,
         'unique', equipment.instance_id, 1::bigint,
         CASE equipment.location
           WHEN 'manor_storage' THEN 'manor_storage'
           WHEN 'market_escrow' THEN 'market_escrow'
           WHEN 'market_collection' THEN 'market_collection'
           WHEN 'world_drop' THEN 'world_drop'
           ELSE 'equipment'
         END,
         CASE equipment.location
           WHEN 'manor_storage' THEN equipment.manor_id::text
           WHEN 'market_escrow' THEN equipment.market_listing_id::text
           WHEN 'market_collection' THEN equipment.market_collection_id::text
           ELSE equipment.instance_id::text
         END,
         CASE WHEN equipment.location = 'world_drop' THEN NULL ELSE equipment.owner_player_id END,
         CASE WHEN equipment.location = 'world_drop' THEN 'world' ELSE NULL END,
         NULL
  FROM equipment_instances equipment WHERE equipment.location <> 'destroyed'
  UNION ALL
  SELECT 'player_controlled_existing_supply', true, 'unique', backpack.definition_id, backpack.definition_id,
         'unique', backpack.instance_id, 1::bigint, 'backpack'::text, backpack.instance_id::text,
         backpack.owner_player_id, NULL, NULL
  FROM player_backpack_instances backpack WHERE backpack.location IN ('inventory', 'equipped')
  UNION ALL
  SELECT 'player_controlled_existing_supply', true, 'unique', backpack.definition_id, backpack.definition_id,
         'unique', backpack.instance_id, 1::bigint, 'manor_storage'::text, backpack.manor_id::text,
         backpack.owner_player_id, NULL, NULL
  FROM player_backpack_instances backpack WHERE backpack.location = 'manor_storage'
  UNION ALL
  SELECT 'existing_world_supply', true, 'unique', backpack.definition_id, backpack.definition_id,
         'unique', backpack.instance_id, 1::bigint,
         CASE WHEN backpack.location = 'manor_storage' THEN 'manor_storage' ELSE 'backpack' END,
         CASE WHEN backpack.location = 'manor_storage' THEN backpack.manor_id::text ELSE backpack.instance_id::text END,
         backpack.owner_player_id, NULL, NULL
  FROM player_backpack_instances backpack WHERE backpack.location <> 'destroyed'
)
SELECT supply_scope, existing_supply, asset_kind, asset_id, item_id, variant, NULL::uuid AS unique_asset_instance_id,
       quantity, custody_type, custody_id, player_id, organization_type, organization_id
FROM fungible
UNION ALL
SELECT supply_scope, existing_supply, asset_kind, asset_id, item_id, variant,
       unique_asset_instance_id, quantity, custody_type, custody_id, player_id,
       organization_type, organization_id
FROM unique_assets;

COMMENT ON VIEW economy_current_holdings IS
  'Read-only V1 custody projection. Existing world supply is the aggregate of current non-future rows; committed/future rows are explicit and never added to it unless they are already existing escrow/collection custody.';
