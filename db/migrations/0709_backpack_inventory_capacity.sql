-- Backpack capacity is independent from combat equipment. During rolling
-- cutover, unlocked_slots intentionally remains a non-equality projection so
-- the previous release can still insert its explicit legacy value.

DO $$
DECLARE
  invalid_players text;
BEGIN
  SELECT string_agg(player_id, ', ' ORDER BY player_id)
  INTO invalid_players
  FROM player_inventory_capacities
  WHERE unlocked_slots > 100;
  IF invalid_players IS NOT NULL THEN
    RAISE EXCEPTION
      'Backpack migration refused player inventory capacities above 100: %',
      invalid_players;
  END IF;
END;
$$;

ALTER TABLE player_inventory_capacities
  DROP CONSTRAINT IF EXISTS player_inventory_capacities_unlocked_slots_check;

ALTER TABLE player_inventory_capacities
  ALTER COLUMN unlocked_slots SET DEFAULT 40,
  ADD COLUMN base_slots integer NOT NULL DEFAULT 40,
  ADD COLUMN backpack_bonus_slots integer NOT NULL DEFAULT 0;

UPDATE player_inventory_capacities
SET base_slots = GREATEST(unlocked_slots, 40),
    backpack_bonus_slots = 0,
    unlocked_slots = GREATEST(unlocked_slots, 40),
    updated_at = now()
WHERE base_slots IS DISTINCT FROM GREATEST(unlocked_slots, 40)
   OR backpack_bonus_slots <> 0
   OR unlocked_slots < 40;

ALTER TABLE player_inventory_capacities
  ADD CONSTRAINT player_inventory_capacities_base_slots_check
    CHECK (base_slots BETWEEN 40 AND 100),
  ADD CONSTRAINT player_inventory_capacities_backpack_bonus_slots_check
    CHECK (backpack_bonus_slots BETWEEN 0 AND 60),
  ADD CONSTRAINT player_inventory_capacities_unlocked_slots_check
    CHECK (unlocked_slots BETWEEN 16 AND 100);

CREATE TABLE player_backpack_state (
  player_id text PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE player_backpack_instances (
  instance_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  definition_id text NOT NULL CHECK (
    definition_id IN (
      'starter_backpack',
      'traveler_backpack',
      'explorer_backpack',
      'trailblazer_backpack'
    )
  ),
  location text NOT NULL,
  equipped_slot integer NULL,
  inventory_slot_index integer NULL,
  manor_id uuid NULL REFERENCES player_manors(id) ON DELETE RESTRICT,
  manor_slot_index integer NULL,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by_operation_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT player_backpack_instances_location_check CHECK (
    (location = 'inventory'
      AND inventory_slot_index IS NOT NULL
      AND inventory_slot_index >= 0
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
      AND manor_slot_index BETWEEN 0 AND 59
      AND equipped_slot IS NULL
      AND inventory_slot_index IS NULL)
    OR
    (location = 'destroyed'
      AND equipped_slot IS NULL
      AND inventory_slot_index IS NULL
      AND manor_id IS NULL
      AND manor_slot_index IS NULL)
  )
);

CREATE UNIQUE INDEX player_backpack_equipped_slot_idx
  ON player_backpack_instances (owner_player_id, equipped_slot)
  WHERE location = 'equipped';
CREATE UNIQUE INDEX player_backpack_inventory_slot_idx
  ON player_backpack_instances (owner_player_id, inventory_slot_index)
  WHERE location = 'inventory';
CREATE UNIQUE INDEX player_backpack_manor_slot_idx
  ON player_backpack_instances (manor_id, manor_slot_index)
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
  ) AND NOT EXISTS (
    SELECT 1
    FROM player_backpack_instances backpack
    WHERE backpack.owner_player_id = NEW.player_id
      AND backpack.location = 'inventory'
      AND backpack.inventory_slot_index = NEW.slot_index
  ) THEN
    RETURN NEW;
  END IF;

  SELECT capacity.unlocked_slots +
         count(DISTINCT equipment.instance_id)::integer +
         count(DISTINCT backpack.instance_id)::integer
  INTO effective_capacity
  FROM player_inventory_capacities capacity
  LEFT JOIN equipment_instances equipment
    ON equipment.owner_player_id = capacity.player_id
   AND equipment.location IN ('inventory', 'equipped')
  LEFT JOIN player_backpack_instances backpack
    ON backpack.owner_player_id = capacity.player_id
   AND backpack.location = 'inventory'
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
  LEFT JOIN player_backpack_instances backpack
    ON backpack.owner_player_id = NEW.player_id
   AND backpack.location = 'inventory'
   AND backpack.inventory_slot_index = candidate.slot_index
  WHERE resource.stack_id IS NULL
    AND equipment.instance_id IS NULL
    AND backpack.instance_id IS NULL
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

CREATE TABLE backpack_operations (
  operation_key text PRIMARY KEY,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  account_id text NOT NULL,
  request_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('create', 'equip', 'unequip', 'upgrade')),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  instance_id uuid NULL REFERENCES player_backpack_instances(instance_id) ON DELETE RESTRICT,
  target_equipped_slot integer NULL CHECK (
    target_equipped_slot IS NULL OR target_equipped_slot BETWEEN 0 AND 3
  ),
  requested_tier text NULL CHECK (
    requested_tier IS NULL OR requested_tier IN (
      'starter_backpack',
      'traveler_backpack',
      'explorer_backpack',
      'trailblazer_backpack'
    )
  ),
  leather_cost bigint NOT NULL DEFAULT 0 CHECK (leather_cost >= 0),
  gold_cost bigint NOT NULL DEFAULT 0 CHECK (gold_cost >= 0),
  capacity_before integer NULL,
  capacity_after integer NULL,
  original_result jsonb NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NULL,
  UNIQUE (player_id, request_id),
  CHECK ((original_result IS NULL) = (completed_at IS NULL))
);

ALTER TABLE player_backpack_instances
  ADD CONSTRAINT player_backpack_created_operation_fk
  FOREIGN KEY (created_by_operation_key)
  REFERENCES backpack_operations(operation_key)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE backpack_events (
  id bigserial PRIMARY KEY,
  operation_key text NOT NULL REFERENCES backpack_operations(operation_key) ON DELETE RESTRICT,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  action text NOT NULL,
  instance_id uuid NOT NULL REFERENCES player_backpack_instances(instance_id) ON DELETE RESTRICT,
  definition_before text NULL,
  definition_after text NOT NULL,
  location_before text NULL,
  location_after text NOT NULL,
  equipped_slot_before integer NULL,
  equipped_slot_after integer NULL,
  capacity_before integer NOT NULL,
  capacity_after integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE manor_storage_backpack_events (
  id bigserial PRIMARY KEY,
  operation_key text NOT NULL REFERENCES manor_storage_operations(operation_key) ON DELETE RESTRICT,
  manor_id uuid NOT NULL REFERENCES player_manors(id) ON DELETE RESTRICT,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  backpack_instance_id uuid NOT NULL
    REFERENCES player_backpack_instances(instance_id) ON DELETE RESTRICT,
  direction text NOT NULL CHECK (direction IN ('deposit', 'withdrawal')),
  slot_before integer NULL,
  slot_after integer NULL,
  inventory_slot_before integer NULL,
  inventory_slot_after integer NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION reject_backpack_event_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'backpack events are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER backpack_events_immutable
BEFORE UPDATE OR DELETE ON backpack_events
FOR EACH ROW EXECUTE FUNCTION reject_backpack_event_mutation();

CREATE OR REPLACE FUNCTION sync_player_inventory_slots()
RETURNS trigger AS $$
DECLARE
  delta_quantity bigint;
  remaining_quantity bigint;
  maximum_stack bigint;
  capacity integer;
  free_slot integer;
  moved_quantity bigint;
  preferred_stack_id uuid;
  preferred_stack_text text;
  target_stack player_inventory_slots%ROWTYPE;
BEGIN
  delta_quantity := NEW.quantity - CASE WHEN TG_OP = 'INSERT' THEN 0 ELSE OLD.quantity END;
  IF delta_quantity = 0 THEN
    RETURN NEW;
  END IF;

  INSERT INTO player_inventory_capacities (player_id)
  VALUES (NEW.player_id)
  ON CONFLICT (player_id) DO NOTHING;

  SELECT unlocked_slots
  INTO capacity
  FROM player_inventory_capacities
  WHERE player_id = NEW.player_id
  FOR UPDATE;

  SELECT COALESCE(max_stack::bigint, 9007199254740991::bigint)
  INTO maximum_stack
  FROM item_definitions
  WHERE item_id = NEW.resource_type;

  IF delta_quantity > 0 THEN
    remaining_quantity := delta_quantity;
    FOR target_stack IN
      SELECT *
      FROM player_inventory_slots
      WHERE player_id = NEW.player_id
        AND resource_type = NEW.resource_type
        AND variant = NEW.variant
        AND manual_split = false
        AND quantity < maximum_stack
      ORDER BY slot_index
      FOR UPDATE
    LOOP
      moved_quantity := LEAST(remaining_quantity, maximum_stack - target_stack.quantity);
      UPDATE player_inventory_slots
      SET quantity = quantity + moved_quantity,
          updated_at = now()
      WHERE stack_id = target_stack.stack_id;
      remaining_quantity := remaining_quantity - moved_quantity;
      EXIT WHEN remaining_quantity = 0;
    END LOOP;

    WHILE remaining_quantity > 0 LOOP
      SELECT candidate.slot_index
      INTO free_slot
      FROM generate_series(0, capacity - 1) AS candidate(slot_index)
      LEFT JOIN player_inventory_slots occupied
        ON occupied.player_id = NEW.player_id
       AND occupied.slot_index = candidate.slot_index
      LEFT JOIN equipment_instances equipment
        ON equipment.owner_player_id = NEW.player_id
       AND equipment.location IN ('inventory', 'equipped')
       AND equipment.inventory_slot_index = candidate.slot_index
      LEFT JOIN player_backpack_instances backpack
        ON backpack.owner_player_id = NEW.player_id
       AND backpack.location = 'inventory'
       AND backpack.inventory_slot_index = candidate.slot_index
      WHERE occupied.stack_id IS NULL
        AND equipment.instance_id IS NULL
        AND backpack.instance_id IS NULL
      ORDER BY candidate.slot_index
      LIMIT 1;

      IF free_slot IS NULL THEN
        RAISE EXCEPTION 'Inventory does not have enough free slots'
          USING ERRCODE = '23514';
      END IF;

      moved_quantity := LEAST(remaining_quantity, maximum_stack);
      INSERT INTO player_inventory_slots (
        player_id, slot_index, resource_type, variant, quantity, manual_split
      )
      VALUES (
        NEW.player_id, free_slot, NEW.resource_type, NEW.variant,
        moved_quantity, false
      );
      remaining_quantity := remaining_quantity - moved_quantity;
    END LOOP;
  ELSE
    remaining_quantity := -delta_quantity;
    preferred_stack_text := current_setting(
      'ash_atlas.inventory_preferred_stack_id',
      true
    );
    IF preferred_stack_text IS NOT NULL AND preferred_stack_text <> '' THEN
      preferred_stack_id := preferred_stack_text::uuid;
    END IF;

    FOR target_stack IN
      SELECT *
      FROM player_inventory_slots
      WHERE player_id = NEW.player_id
        AND resource_type = NEW.resource_type
        AND variant = NEW.variant
      ORDER BY
        (stack_id = preferred_stack_id) DESC,
        manual_split ASC,
        slot_index DESC
      FOR UPDATE
    LOOP
      moved_quantity := LEAST(remaining_quantity, target_stack.quantity);
      IF moved_quantity = target_stack.quantity THEN
        DELETE FROM player_inventory_slots WHERE stack_id = target_stack.stack_id;
      ELSE
        UPDATE player_inventory_slots
        SET quantity = quantity - moved_quantity, updated_at = now()
        WHERE stack_id = target_stack.stack_id;
      END IF;
      remaining_quantity := remaining_quantity - moved_quantity;
      EXIT WHEN remaining_quantity = 0;
    END LOOP;

    IF remaining_quantity > 0 THEN
      RAISE EXCEPTION 'Inventory slot state does not contain enough items';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION advance_player_inventory_revision(target_player_id text)
RETURNS void AS $$
BEGIN
  INSERT INTO player_inventory_capacities (player_id, inventory_revision)
  VALUES (target_player_id, 1)
  ON CONFLICT (player_id) DO UPDATE
  SET inventory_revision = player_inventory_capacities.inventory_revision + 1,
      updated_at = now();
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION advance_backpack_inventory_revision()
RETURNS trigger AS $$
DECLARE
  previous_player_id text;
  next_player_id text;
BEGIN
  previous_player_id := CASE
    WHEN TG_OP = 'INSERT' THEN NULL
    ELSE OLD.owner_player_id
  END;
  next_player_id := CASE
    WHEN TG_OP = 'DELETE' THEN NULL
    ELSE NEW.owner_player_id
  END;

  IF previous_player_id IS NOT NULL THEN
    PERFORM advance_player_inventory_revision(previous_player_id);
  END IF;
  IF next_player_id IS NOT NULL
     AND next_player_id IS DISTINCT FROM previous_player_id THEN
    PERFORM advance_player_inventory_revision(next_player_id);
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER player_backpack_instances_advance_inventory_revision
AFTER INSERT OR UPDATE OR DELETE ON player_backpack_instances
FOR EACH ROW EXECUTE FUNCTION advance_backpack_inventory_revision();
