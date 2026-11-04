-- Manor equipment storage, explicit transfer eligibility, and persistent
-- player protection policy. Existing resource storage and equipment rows are
-- preserved in place.

ALTER TABLE item_definitions
  ADD COLUMN droppable boolean NOT NULL DEFAULT true,
  ADD COLUMN manor_storable boolean NOT NULL DEFAULT true;

UPDATE item_definitions
SET droppable = false
WHERE category = 'equipment';

CREATE TABLE player_item_keep_policies (
  player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  item_id text NOT NULL REFERENCES item_definitions(item_id) ON DELETE RESTRICT,
  variant text NOT NULL DEFAULT 'default',
  keep_quantity bigint NOT NULL
    CHECK (keep_quantity BETWEEN 0 AND 9007199254740991::bigint),
  revision bigint NOT NULL CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, item_id, variant)
);

CREATE TABLE player_unique_item_protections (
  player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  equipment_instance_id uuid NOT NULL
    REFERENCES equipment_instances(instance_id) ON DELETE CASCADE,
  protected boolean NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, equipment_instance_id)
);

CREATE TABLE player_inventory_protection_state (
  player_id text PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  revision bigint NOT NULL DEFAULT 0
    CHECK (revision BETWEEN 0 AND 9007199254740991::bigint),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE inventory_protection_operations (
  operation_key text PRIMARY KEY,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  action text NOT NULL CHECK (action IN ('set_keep', 'set_unique')),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  original_result jsonb NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NULL,
  UNIQUE (player_id, request_id),
  CHECK ((original_result IS NULL) = (completed_at IS NULL))
);

CREATE TABLE inventory_protection_events (
  id bigserial PRIMARY KEY,
  operation_key text NOT NULL
    REFERENCES inventory_protection_operations(operation_key) ON DELETE RESTRICT,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN ('set_keep', 'set_unique')),
  item_id text NULL REFERENCES item_definitions(item_id) ON DELETE RESTRICT,
  variant text NULL,
  equipment_instance_id uuid NULL
    REFERENCES equipment_instances(instance_id) ON DELETE RESTRICT,
  previous_value jsonb NULL,
  next_value jsonb NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION reject_inventory_protection_history_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'inventory protection history is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER inventory_protection_events_immutable
BEFORE UPDATE OR DELETE ON inventory_protection_events
FOR EACH ROW EXECUTE FUNCTION reject_inventory_protection_history_mutation();

ALTER TABLE equipment_instances
  ADD COLUMN manor_id uuid NULL
    REFERENCES player_manors(id) ON DELETE RESTRICT,
  ADD COLUMN manor_slot_index integer NULL
    CHECK (manor_slot_index IS NULL OR manor_slot_index BETWEEN 0 AND 59);

ALTER TABLE equipment_instances
  DROP CONSTRAINT IF EXISTS equipment_instances_location_check,
  DROP CONSTRAINT IF EXISTS equipment_instances_check,
  DROP CONSTRAINT IF EXISTS equipment_instances_equipped_slot_check;

ALTER TABLE equipment_instances
  ADD CONSTRAINT equipment_instances_location_check
    CHECK (location IN ('inventory', 'equipped', 'manor_storage', 'destroyed')),
  ADD CONSTRAINT equipment_instances_location_fields_check
    CHECK (
      (
        location = 'equipped'
        AND equipped_slot IS NOT NULL
        AND manor_id IS NULL
        AND manor_slot_index IS NULL
      )
      OR
      (
        location = 'inventory'
        AND equipped_slot IS NULL
        AND manor_id IS NULL
        AND manor_slot_index IS NULL
      )
      OR
      (
        location = 'manor_storage'
        AND equipped_slot IS NULL
        AND inventory_slot_index IS NULL
        AND manor_id IS NOT NULL
        AND manor_slot_index IS NOT NULL
      )
      OR
      (
        location = 'destroyed'
        AND equipped_slot IS NULL
        AND manor_id IS NULL
        AND manor_slot_index IS NULL
      )
    );

DROP INDEX IF EXISTS equipment_instances_inventory_slot_idx;
CREATE UNIQUE INDEX equipment_instances_inventory_slot_idx
  ON equipment_instances (owner_player_id, inventory_slot_index)
  WHERE location IN ('inventory', 'equipped')
    AND inventory_slot_index IS NOT NULL;

CREATE UNIQUE INDEX equipment_instances_manor_slot_idx
  ON equipment_instances (manor_id, manor_slot_index)
  WHERE location = 'manor_storage';

CREATE INDEX equipment_instances_manor_owner_idx
  ON equipment_instances (owner_player_id, manor_id, manor_slot_index)
  WHERE location = 'manor_storage';

CREATE OR REPLACE FUNCTION keep_resource_slot_clear_of_equipment()
RETURNS trigger AS $$
DECLARE
  effective_capacity integer;
  free_slot integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM equipment_instances equipment
    WHERE equipment.owner_player_id = NEW.player_id
      AND equipment.location IN ('inventory', 'equipped')
      AND equipment.inventory_slot_index = NEW.slot_index
  ) THEN
    RETURN NEW;
  END IF;

  SELECT capacity.unlocked_slots + count(equipment.instance_id)::integer
  INTO effective_capacity
  FROM player_inventory_capacities capacity
  LEFT JOIN equipment_instances equipment
    ON equipment.owner_player_id = capacity.player_id
   AND equipment.location IN ('inventory', 'equipped')
  WHERE capacity.player_id = NEW.player_id
  GROUP BY capacity.unlocked_slots;

  SELECT candidate.slot_index
  INTO free_slot
  FROM generate_series(0, effective_capacity - 1) candidate(slot_index)
  LEFT JOIN player_inventory_slots resource
    ON resource.player_id = NEW.player_id
   AND resource.slot_index = candidate.slot_index
  LEFT JOIN equipment_instances equipment
    ON equipment.owner_player_id = NEW.player_id
   AND equipment.location IN ('inventory', 'equipped')
   AND equipment.inventory_slot_index = candidate.slot_index
  WHERE resource.stack_id IS NULL
    AND equipment.instance_id IS NULL
  ORDER BY candidate.slot_index
  LIMIT 1;

  IF free_slot IS NULL THEN
    RAISE EXCEPTION 'Inventory does not have enough free slots'
      USING ERRCODE = '23514';
  END IF;

  NEW.slot_index := free_slot;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION validate_manor_material_slot()
RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM equipment_instances equipment
    WHERE equipment.location = 'manor_storage'
      AND equipment.manor_id = NEW.manor_id
      AND equipment.manor_slot_index = NEW.slot_index
  ) THEN
    RAISE EXCEPTION 'Manor storage slot is occupied by equipment'
      USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER manor_storage_material_slot_clear
BEFORE INSERT OR UPDATE OF manor_id, slot_index ON manor_storage_stacks
FOR EACH ROW EXECUTE FUNCTION validate_manor_material_slot();

CREATE OR REPLACE FUNCTION validate_manor_equipment_slot()
RETURNS trigger AS $$
BEGIN
  IF NEW.location <> 'manor_storage' THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM manor_storage_stacks stack
    WHERE stack.manor_id = NEW.manor_id
      AND stack.slot_index = NEW.manor_slot_index
  ) THEN
    RAISE EXCEPTION 'Manor storage slot is occupied by a material stack'
      USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER manor_storage_equipment_slot_clear
BEFORE INSERT OR UPDATE OF location, manor_id, manor_slot_index
ON equipment_instances
FOR EACH ROW EXECUTE FUNCTION validate_manor_equipment_slot();

CREATE TABLE manor_storage_equipment_events (
  id bigserial PRIMARY KEY,
  operation_key text NOT NULL
    REFERENCES manor_storage_operations(operation_key) ON DELETE RESTRICT,
  manor_id uuid NOT NULL REFERENCES player_manors(id) ON DELETE RESTRICT,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  equipment_instance_id uuid NOT NULL
    REFERENCES equipment_instances(instance_id) ON DELETE RESTRICT,
  direction text NOT NULL CHECK (direction IN ('deposit', 'withdrawal')),
  slot_before integer NULL,
  slot_after integer NULL,
  inventory_slot_before integer NULL,
  inventory_slot_after integer NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION reject_manor_equipment_event_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'manor equipment events are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER manor_storage_equipment_events_immutable
BEFORE UPDATE OR DELETE ON manor_storage_equipment_events
FOR EACH ROW EXECUTE FUNCTION reject_manor_equipment_event_mutation();
