-- Retire the visible Manor Storage fixture without discarding retained custody.
-- Every historical storage row is projected into the owner's persistent Manor
-- recovery pile in this same transaction. The source tables remain as audit
-- history, but future writes are rejected below.

LOCK TABLE
  player_manors,
  manor_storage_stacks,
  manor_storage_overflow,
  equipment_instances,
  player_backpack_instances,
  inventory_operations,
  world_item_drops,
  world_item_system_drop_sources,
  world_item_movements,
  equipment_operations
IN SHARE ROW EXCLUSIVE MODE;
-- Keep the existing deferred custody evidence checks deferred until each
-- destination row has its source and movement ledgers in the same transaction.
SET CONSTRAINTS ALL DEFERRED;

-- The retained overflow ledger was intentionally immutable. The migration is
-- the one audited exception which consumes those rows after their destination
-- evidence has been written.
DROP TRIGGER IF EXISTS manor_storage_overflow_immutable ON manor_storage_overflow;

ALTER TABLE player_backpack_instances
  DROP CONSTRAINT IF EXISTS player_backpack_instances_location_check;
ALTER TABLE player_backpack_instances
  ADD CONSTRAINT player_backpack_instances_location_check CHECK (
    (location = 'inventory'
      AND inventory_slot_index IS NULL
      AND equipped_slot IS NULL
      AND manor_id IS NULL
      AND manor_slot_index IS NULL)
    OR
    (location = 'equipped'
      AND equipped_slot BETWEEN 0 AND 3
      AND inventory_slot_index IS NULL
      AND manor_id IS NULL
      AND manor_slot_index IS NULL)
    OR
    (location = 'manor_storage'
      AND manor_id IS NOT NULL
      AND manor_slot_index IS NOT NULL
      AND equipped_slot IS NULL
      AND inventory_slot_index IS NULL)
    OR
    (location = 'world_drop'
      AND equipped_slot IS NULL
      AND inventory_slot_index IS NULL
      AND manor_id IS NULL
      AND manor_slot_index IS NULL)
    OR
    (location = 'destroyed'
      AND equipped_slot IS NULL
      AND inventory_slot_index IS NULL
      AND manor_id IS NULL
      AND manor_slot_index IS NULL)
  );

ALTER TABLE equipment_operations
  DROP CONSTRAINT IF EXISTS equipment_operations_action_check;
ALTER TABLE equipment_operations
  ADD CONSTRAINT equipment_operations_action_check CHECK (
    action IN (
      'starter_loadout', 'equip', 'unequip', 'package_grant',
      'ground_drop', 'ground_pickup', 'ground_expire', 'prepare', 'imbue',
      'craft', 'limited_purchase', 'manor_storage_recovery'
    )
  );

CREATE TABLE IF NOT EXISTS backpack_drop_operations (
  operation_key text PRIMARY KEY,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  request_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('manor_storage_recovery', 'pickup')),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  instance_id uuid NOT NULL REFERENCES player_backpack_instances(instance_id) ON DELETE RESTRICT,
  drop_id uuid NULL,
  original_result jsonb NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NULL,
  CHECK ((completed_at IS NULL AND original_result IS NULL)
    OR (completed_at IS NOT NULL AND original_result IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS backpack_drop_operations_instance_idx
  ON backpack_drop_operations (instance_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS backpack_drop_operations_player_request_idx
  ON backpack_drop_operations (player_id, request_id, action);

CREATE TABLE IF NOT EXISTS world_backpack_drops (
  id uuid PRIMARY KEY,
  operation_key text NOT NULL UNIQUE
    REFERENCES backpack_drop_operations(operation_key) ON DELETE RESTRICT,
  backpack_instance_id uuid NOT NULL UNIQUE
    REFERENCES player_backpack_instances(instance_id) ON DELETE RESTRICT,
  dropped_by text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  region_code text NOT NULL,
  zone_id text NOT NULL CHECK (zone_id <> ''),
  pile_id text NOT NULL CHECK (pile_id <> ''),
  pile_order integer NOT NULL DEFAULT 0 CHECK (pile_order >= 0),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'picked_up')),
  lat double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lon double precision NOT NULL CHECK (lon BETWEEN -180 AND 180),
  geom geometry(Point, 4326) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  pickup_operation_key text NULL UNIQUE
    REFERENCES backpack_drop_operations(operation_key) ON DELETE RESTRICT,
  picked_up_by text NULL REFERENCES players(id) ON DELETE RESTRICT,
  picked_up_at timestamptz NULL,
  manor_id uuid NULL REFERENCES player_manors(id) ON DELETE RESTRICT,
  space_id text NULL,
  local_x double precision NULL,
  local_y double precision NULL,
  CHECK (expires_at > created_at),
  CHECK (
    (manor_id IS NULL AND space_id IS NULL AND local_x IS NULL AND local_y IS NULL)
    OR (manor_id IS NOT NULL
      AND space_id IN ('manor_foyer', 'manor_main_room')
      AND local_x IS NOT NULL AND local_y IS NOT NULL
      AND local_x >= 0 AND local_y >= 0)
  ),
  CHECK (
    (status = 'active' AND pickup_operation_key IS NULL
      AND picked_up_by IS NULL AND picked_up_at IS NULL)
    OR (status = 'picked_up' AND pickup_operation_key IS NOT NULL
      AND picked_up_by IS NOT NULL AND picked_up_at IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS world_backpack_drops_active_manor_idx
  ON world_backpack_drops (manor_id, space_id, created_at, id)
  WHERE status = 'active' AND manor_id IS NOT NULL;

-- Backpacks in the recovery pile still contribute the same owned capacity as
-- Manor Storage. Ordinary world-drop backpacks (if introduced later) do not.
CREATE OR REPLACE FUNCTION player_inventory_maximum_grams(target_player_id text) RETURNS numeric
LANGUAGE sql VOLATILE AS $$
  SELECT capacity.base_capacity_grams::numeric+COALESCE((
    SELECT sum(level.capacity_bonus_grams) FROM player_backpack_instances backpack
    JOIN backpack_level_definitions level ON level.level=backpack.upgrade_level
    WHERE backpack.owner_player_id=target_player_id
      AND (
        backpack.location IN ('inventory','equipped','manor_storage')
        OR (backpack.location='world_drop' AND EXISTS (
          SELECT 1 FROM world_backpack_drops drop_row
          WHERE drop_row.backpack_instance_id=backpack.instance_id
            AND drop_row.manor_id IS NOT NULL
            AND drop_row.status='active'
        ))
      )
  ),0) FROM player_inventory_capacities capacity WHERE capacity.player_id=target_player_id;
$$;

CREATE TEMP TABLE manor_storage_recovery_sources (
  source_kind text NOT NULL,
  source_order integer NOT NULL,
  source_id uuid NOT NULL,
  manor_id uuid NOT NULL,
  owner_player_id text NOT NULL,
  item_id text NOT NULL,
  variant text NOT NULL,
  quantity bigint NOT NULL,
  source_version bigint NOT NULL,
  source_created_at timestamptz NOT NULL,
  PRIMARY KEY (source_kind, source_id)
) ON COMMIT DROP;

INSERT INTO manor_storage_recovery_sources (
  source_kind, source_order, source_id, manor_id, owner_player_id,
  item_id, variant, quantity, source_version, source_created_at
)
SELECT 'stack', 0, stack.stack_id, stack.manor_id, manor.owner_player_id,
       stack.item_id, COALESCE(stack.variant, 'default'), stack.quantity,
       stack.version, stack.created_at
FROM manor_storage_stacks stack
JOIN player_manors manor ON manor.id=stack.manor_id
WHERE stack.quantity > 0
UNION ALL
SELECT 'overflow', 1, overflow.stack_id, overflow.manor_id, manor.owner_player_id,
       overflow.item_id, COALESCE(overflow.variant, 'default'), overflow.quantity,
       overflow.legacy_version, overflow.created_at
FROM manor_storage_overflow overflow
JOIN player_manors manor ON manor.id=overflow.manor_id
WHERE overflow.quantity > 0
UNION ALL
SELECT 'equipment', 2, equipment.instance_id, equipment.manor_id,
       equipment.owner_player_id, equipment.definition_id, 'default', 1,
       GREATEST(equipment.item_level::bigint, 1), equipment.created_at
FROM equipment_instances equipment
WHERE equipment.location='manor_storage'
  AND equipment.manor_id IS NOT NULL
UNION ALL
SELECT 'backpack', 3, backpack.instance_id, backpack.manor_id,
       backpack.owner_player_id, backpack.definition_id, 'default', 1,
       GREATEST(backpack.version, 1), backpack.created_at
FROM player_backpack_instances backpack
WHERE backpack.location='manor_storage'
  AND backpack.manor_id IS NOT NULL;

DO $$
DECLARE
  source_row RECORD;
  pile_id text;
  zone_id text;
  recovery_operation_key text;
  recovery_drop_id uuid;
  pile_order integer;
  recovery_created_at timestamptz;
BEGIN
  -- Every source category is ordered deterministically, then assigned one
  -- contiguous visual order within its owner's single recovery pile.
  FOR source_row IN
    SELECT source.*,
           row_number() OVER (
             PARTITION BY source.manor_id
             ORDER BY source.source_order, source.source_id
           ) - 1 AS contiguous_pile_order
    FROM manor_storage_recovery_sources source
    ORDER BY source.manor_id, source.source_order, source.source_id
  LOOP
    pile_id := 'manor-storage-recovery:' || source_row.manor_id::text;
    zone_id := 'manor:' || source_row.manor_id::text || ':manor_main_room';
    pile_order := source_row.contiguous_pile_order::integer;
    recovery_created_at := GREATEST(source_row.source_created_at, TIMESTAMPTZ 'epoch');

    IF source_row.source_kind IN ('stack', 'overflow') THEN
      recovery_operation_key := 'manor-storage-recovery:item:' || source_row.source_kind || ':'
        || source_row.manor_id::text
        || ':' || source_row.source_id::text;
      recovery_drop_id := md5(recovery_operation_key)::uuid;
      INSERT INTO inventory_operations (
        operation_key, player_id, source, source_entity_type, source_entity_id,
        metadata, created_at
      ) VALUES (
        recovery_operation_key, source_row.owner_player_id, 'world_system_drop',
        'world_item_drop', recovery_drop_id::text,
        jsonb_build_object(
          'reason', 'manor_storage_recovery',
          'sourceKind', source_row.source_kind,
          'sourceId', source_row.source_id::text,
          'sourceVersion', source_row.source_version
        ), recovery_created_at
      ) ON CONFLICT (operation_key) DO NOTHING;

      INSERT INTO world_item_drops (
        id, operation_key, dropped_by, region_code, zone_id, pile_id, pile_order,
        item_id, variant, original_quantity, remaining_quantity, status,
        lat, lon, geom, created_at, expires_at, manor_id, space_id, local_x, local_y
      ) VALUES (
        recovery_drop_id, recovery_operation_key, source_row.owner_player_id,
        'interior:manor:' || source_row.manor_id::text, zone_id, pile_id, pile_order,
        source_row.item_id, source_row.variant, source_row.quantity, source_row.quantity,
        'active', 0, 0, ST_SetSRID(ST_MakePoint(0,0),4326), recovery_created_at,
        TIMESTAMPTZ '9999-12-31 23:59:59.999+00', source_row.manor_id,
        'manor_main_room', 877.8, 307.23
      ) ON CONFLICT (operation_key) DO NOTHING;

      INSERT INTO world_item_system_drop_sources (
        drop_id, operation_key, source_entity_type, source_entity_id, reason, created_at
      ) VALUES (
        recovery_drop_id, recovery_operation_key, 'manor_storage_' || source_row.source_kind,
        source_row.source_id::text, 'manor_storage_recovery', recovery_created_at
      ) ON CONFLICT (drop_id, operation_key) DO NOTHING;

      INSERT INTO world_item_movements (
        drop_id, movement_kind, operation_key, pickup_operation_key, player_id,
        item_id, variant, quantity, reason, created_at
      ) VALUES (
        recovery_drop_id, 'system_to_world', recovery_operation_key, NULL, source_row.owner_player_id,
        source_row.item_id, source_row.variant, source_row.quantity,
        'manor_storage_recovery', recovery_created_at
      ) ON CONFLICT DO NOTHING;

      PERFORM set_config('ash_atlas.manor_storage_recovery', '1', true);
      DELETE FROM manor_storage_stacks
      WHERE stack_id=source_row.source_id;
      DELETE FROM manor_storage_overflow
      WHERE stack_id=source_row.source_id;
    ELSIF source_row.source_kind = 'equipment' THEN
      recovery_operation_key := 'manor-storage-recovery:equipment:' || source_row.manor_id::text
        || ':' || source_row.source_id::text;
      recovery_drop_id := md5(recovery_operation_key)::uuid;
      INSERT INTO equipment_operations (
        operation_key, player_id, action, instance_id, result, created_at, completed_at
      ) VALUES (
        recovery_operation_key, source_row.owner_player_id, 'manor_storage_recovery',
        source_row.source_id, jsonb_build_object(
          'dropId', recovery_drop_id, 'sourceKind', source_row.source_kind,
          'sourceId', source_row.source_id::text
        ), recovery_created_at, recovery_created_at
      ) ON CONFLICT (operation_key) DO NOTHING;

      INSERT INTO world_equipment_drops (
        id, operation_key, equipment_instance_id, item_id, dropped_by,
        region_code, zone_id, pile_id, pile_order, status, lat, lon, geom,
        created_at, expires_at, manor_id, space_id, local_x, local_y
      ) VALUES (
        recovery_drop_id, recovery_operation_key, source_row.source_id, source_row.item_id,
        source_row.owner_player_id, 'interior:manor:' || source_row.manor_id::text,
        zone_id, pile_id, pile_order, 'active', 0, 0,
        ST_SetSRID(ST_MakePoint(0,0),4326), recovery_created_at,
        TIMESTAMPTZ '9999-12-31 23:59:59.999+00', source_row.manor_id,
        'manor_main_room', 877.8, 307.23
      ) ON CONFLICT (operation_key) DO NOTHING;

      PERFORM set_config('ash_atlas.manor_storage_recovery', '1', true);
      UPDATE equipment_instances
      SET location='world_drop', equipped_slot=NULL, inventory_slot_index=NULL,
          manor_id=NULL, manor_slot_index=NULL, updated_at=now()
      WHERE instance_id=source_row.source_id AND location='manor_storage';
    ELSE
      recovery_operation_key := 'manor-storage-recovery:backpack:' || source_row.manor_id::text
        || ':' || source_row.source_id::text;
      recovery_drop_id := md5(recovery_operation_key)::uuid;
      INSERT INTO backpack_drop_operations (
        operation_key, player_id, request_id, action, request_hash, instance_id,
        drop_id, original_result, created_at, completed_at
      ) VALUES (
        recovery_operation_key, source_row.owner_player_id, source_row.source_id::text,
        'manor_storage_recovery', encode(sha256(convert_to(recovery_operation_key,'UTF8')),'hex'),
        source_row.source_id, recovery_drop_id,
        jsonb_build_object('dropId', recovery_drop_id, 'backpackInstanceId', source_row.source_id::text),
        recovery_created_at, recovery_created_at
      ) ON CONFLICT (operation_key) DO NOTHING;

      INSERT INTO world_backpack_drops (
        id, operation_key, backpack_instance_id, dropped_by,
        region_code, zone_id, pile_id, pile_order, status, lat, lon, geom,
        created_at, expires_at, manor_id, space_id, local_x, local_y
      ) VALUES (
        recovery_drop_id, recovery_operation_key, source_row.source_id, source_row.owner_player_id,
        'interior:manor:' || source_row.manor_id::text, zone_id, pile_id, pile_order,
        'active', 0, 0, ST_SetSRID(ST_MakePoint(0,0),4326), recovery_created_at,
        TIMESTAMPTZ '9999-12-31 23:59:59.999+00', source_row.manor_id,
        'manor_main_room', 877.8, 307.23
      ) ON CONFLICT (operation_key) DO NOTHING;

      PERFORM set_config('ash_atlas.manor_storage_recovery', '1', true);
      UPDATE player_backpack_instances
      SET location='world_drop', equipped_slot=NULL, inventory_slot_index=NULL,
          manor_id=NULL, manor_slot_index=NULL, updated_at=now()
      WHERE instance_id=source_row.source_id AND location='manor_storage';
    END IF;
  END LOOP;
END $$;

-- Once the conversion has committed, no new custody may be placed back in
-- retired storage. The migration flag is transaction-local and cannot be set
-- by ordinary application queries.
CREATE OR REPLACE FUNCTION reject_retired_manor_storage_write()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  location text;
BEGIN
  -- Equipment and backpack rows share this trigger with their other custody
  -- locations. Only a mutation that would touch retired Manor Storage is
  -- rejected; normal inventory/world/market transitions remain available.
  IF TG_TABLE_NAME IN ('equipment_instances', 'player_backpack_instances') THEN
    IF TG_OP = 'DELETE' THEN
      location := OLD.location;
      IF location IS DISTINCT FROM 'manor_storage' THEN
        RETURN OLD;
      END IF;
    ELSIF TG_OP = 'INSERT' THEN
      IF NEW.location IS DISTINCT FROM 'manor_storage' THEN
        RETURN NEW;
      END IF;
    ELSIF OLD.location IS DISTINCT FROM 'manor_storage'
      AND NEW.location IS DISTINCT FROM 'manor_storage' THEN
      RETURN NEW;
    END IF;
  END IF;
  IF current_setting('ash_atlas.manor_storage_recovery', true) <> '1' THEN
    RAISE EXCEPTION 'Manor Storage is retired; recover items from the Manor recovery pile'
      USING ERRCODE='55000';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$;

DROP TRIGGER IF EXISTS manor_storage_stacks_retired_guard ON manor_storage_stacks;
CREATE TRIGGER manor_storage_stacks_retired_guard
BEFORE INSERT OR UPDATE OR DELETE ON manor_storage_stacks
FOR EACH ROW EXECUTE FUNCTION reject_retired_manor_storage_write();
DROP TRIGGER IF EXISTS manor_storage_overflow_retired_guard ON manor_storage_overflow;
CREATE TRIGGER manor_storage_overflow_retired_guard
BEFORE INSERT OR UPDATE OR DELETE ON manor_storage_overflow
FOR EACH ROW EXECUTE FUNCTION reject_retired_manor_storage_write();
DROP TRIGGER IF EXISTS equipment_instances_manor_storage_retired_guard ON equipment_instances;
CREATE TRIGGER equipment_instances_manor_storage_retired_guard
BEFORE INSERT OR UPDATE OR DELETE ON equipment_instances
FOR EACH ROW EXECUTE FUNCTION reject_retired_manor_storage_write();
DROP TRIGGER IF EXISTS player_backpacks_manor_storage_retired_guard ON player_backpack_instances;
CREATE TRIGGER player_backpacks_manor_storage_retired_guard
BEFORE INSERT OR UPDATE OR DELETE ON player_backpack_instances
FOR EACH ROW EXECUTE FUNCTION reject_retired_manor_storage_write();

-- Restore the immutable audit trigger after the migration's controlled delete.
CREATE TRIGGER manor_storage_overflow_immutable
BEFORE INSERT OR UPDATE OR DELETE ON manor_storage_overflow
FOR EACH ROW EXECUTE FUNCTION reject_manor_storage_overflow_mutation();
