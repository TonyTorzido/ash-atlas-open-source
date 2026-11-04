UPDATE item_definitions
SET droppable = true,
    updated_at = now()
WHERE category = 'equipment';

ALTER TABLE equipment_operations
  DROP CONSTRAINT IF EXISTS equipment_operations_action_check;
ALTER TABLE equipment_operations
  ADD CONSTRAINT equipment_operations_action_check CHECK (
    action IN (
      'starter_loadout', 'equip', 'unequip', 'package_grant',
      'ground_drop', 'ground_pickup', 'ground_expire'
    )
  );

ALTER TABLE equipment_instances
  DROP CONSTRAINT IF EXISTS equipment_instances_location_check,
  DROP CONSTRAINT IF EXISTS equipment_instances_location_fields_check;
ALTER TABLE equipment_instances
  ADD CONSTRAINT equipment_instances_location_check CHECK (
    location IN (
      'inventory', 'equipped', 'manor_storage', 'market_escrow',
      'market_collection', 'world_drop', 'destroyed'
    )
  ),
  ADD CONSTRAINT equipment_instances_location_fields_check CHECK (
    (
      location = 'equipped'
      AND equipped_slot IS NOT NULL
      AND inventory_slot_index IS NOT NULL
      AND manor_id IS NULL AND manor_slot_index IS NULL
      AND market_listing_id IS NULL AND market_collection_id IS NULL
    )
    OR (
      location = 'inventory'
      AND equipped_slot IS NULL
      AND inventory_slot_index IS NOT NULL
      AND manor_id IS NULL AND manor_slot_index IS NULL
      AND market_listing_id IS NULL AND market_collection_id IS NULL
    )
    OR (
      location = 'manor_storage'
      AND equipped_slot IS NULL
      AND inventory_slot_index IS NULL
      AND manor_id IS NOT NULL AND manor_slot_index IS NOT NULL
      AND market_listing_id IS NULL AND market_collection_id IS NULL
    )
    OR (
      location = 'market_escrow'
      AND equipped_slot IS NULL
      AND inventory_slot_index IS NULL
      AND manor_id IS NULL AND manor_slot_index IS NULL
      AND market_listing_id IS NOT NULL AND market_collection_id IS NULL
    )
    OR (
      location = 'market_collection'
      AND equipped_slot IS NULL
      AND inventory_slot_index IS NULL
      AND manor_id IS NULL AND manor_slot_index IS NULL
      AND market_listing_id IS NOT NULL AND market_collection_id IS NOT NULL
    )
    OR (
      location IN ('world_drop', 'destroyed')
      AND equipped_slot IS NULL
      AND inventory_slot_index IS NULL
      AND manor_id IS NULL AND manor_slot_index IS NULL
      AND market_listing_id IS NULL AND market_collection_id IS NULL
    )
  );

CREATE TABLE world_equipment_drops (
  id uuid PRIMARY KEY,
  operation_key text NOT NULL UNIQUE
    REFERENCES equipment_operations(operation_key) ON DELETE RESTRICT,
  equipment_instance_id uuid NOT NULL
    REFERENCES equipment_instances(instance_id) ON DELETE RESTRICT,
  item_id text NOT NULL REFERENCES item_definitions(item_id) ON DELETE RESTRICT,
  dropped_by text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  region_code text NOT NULL,
  zone_id text NOT NULL CHECK (zone_id <> ''),
  pile_id text NOT NULL CHECK (pile_id <> ''),
  pile_order integer NOT NULL DEFAULT 0 CHECK (pile_order >= 0),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'picked_up', 'expired')),
  lat double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lon double precision NOT NULL CHECK (lon BETWEEN -180 AND 180),
  geom geometry(Point, 4326) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  expired_at timestamptz NULL,
  pickup_operation_key text NULL UNIQUE
    REFERENCES equipment_operations(operation_key) ON DELETE RESTRICT,
  picked_up_by text NULL REFERENCES players(id) ON DELETE RESTRICT,
  picked_up_at timestamptz NULL,
  CHECK (expires_at > created_at),
  CHECK (
    (status = 'active' AND expired_at IS NULL AND pickup_operation_key IS NULL
      AND picked_up_by IS NULL AND picked_up_at IS NULL)
    OR (status = 'picked_up' AND expired_at IS NULL AND pickup_operation_key IS NOT NULL
      AND picked_up_by IS NOT NULL AND picked_up_at IS NOT NULL)
    OR (status = 'expired' AND expired_at IS NOT NULL AND pickup_operation_key IS NULL
      AND picked_up_by IS NULL AND picked_up_at IS NULL)
  )
);

CREATE UNIQUE INDEX world_equipment_drops_one_active_instance_idx
  ON world_equipment_drops (equipment_instance_id)
  WHERE status = 'active';
CREATE INDEX world_equipment_drops_active_geom_idx
  ON world_equipment_drops USING gist (geom)
  WHERE status = 'active';
CREATE INDEX world_equipment_drops_region_status_expiry_idx
  ON world_equipment_drops (region_code, status, expires_at);
CREATE INDEX world_equipment_drops_due_expiry_idx
  ON world_equipment_drops (expires_at, id)
  WHERE status = 'active';
