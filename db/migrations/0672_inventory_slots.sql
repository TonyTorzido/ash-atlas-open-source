UPDATE item_definitions
SET max_stack = 250,
    updated_at = now()
WHERE item_id = 'wood';

CREATE TABLE player_inventory_capacities (
  player_id text PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  unlocked_slots integer NOT NULL DEFAULT 16 CHECK (unlocked_slots >= 16),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO player_inventory_capacities (player_id, unlocked_slots)
SELECT id, 16
FROM players
ON CONFLICT (player_id) DO NOTHING;

CREATE TABLE player_inventory_slots (
  stack_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  slot_index integer NOT NULL CHECK (slot_index >= 0),
  resource_type text NOT NULL REFERENCES item_definitions(item_id),
  variant text NOT NULL DEFAULT 'default',
  quantity bigint NOT NULL CHECK (quantity > 0 AND quantity <= 9007199254740991::bigint),
  manual_split boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (player_id, slot_index)
);

CREATE INDEX player_inventory_slots_identity_idx
  ON player_inventory_slots (player_id, resource_type, variant, manual_split, slot_index);

CREATE TABLE inventory_stack_operations (
  operation_key text PRIMARY KEY,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN ('split', 'restack')),
  stack_id uuid NOT NULL,
  quantity bigint NULL CHECK (quantity IS NULL OR quantity > 0),
  result_stack_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

WITH source AS (
  SELECT inventory.player_id,
         inventory.resource_type,
         inventory.variant,
         inventory.quantity,
         COALESCE(definition.max_stack::bigint, inventory.quantity) AS max_stack
  FROM player_inventory inventory
  JOIN item_definitions definition ON definition.item_id = inventory.resource_type
  WHERE inventory.quantity > 0
),
expanded AS (
  SELECT source.*,
         part
  FROM source
  CROSS JOIN LATERAL generate_series(
    1::bigint,
    ((source.quantity + source.max_stack - 1) / source.max_stack)::bigint
  ) AS part
),
numbered AS (
  SELECT expanded.*,
         row_number() OVER (
           PARTITION BY player_id
           ORDER BY resource_type, variant, part
         ) - 1 AS slot_index
  FROM expanded
)
INSERT INTO player_inventory_slots (
  player_id,
  slot_index,
  resource_type,
  variant,
  quantity,
  manual_split
)
SELECT player_id,
       slot_index,
       resource_type,
       variant,
       LEAST(max_stack, quantity - ((part - 1) * max_stack)),
       false
FROM numbered
ORDER BY player_id, slot_index;

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

  INSERT INTO player_inventory_capacities (player_id, unlocked_slots)
  VALUES (NEW.player_id, 16)
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
      WHERE occupied.stack_id IS NULL
      ORDER BY candidate.slot_index
      LIMIT 1;

      IF free_slot IS NULL THEN
        RAISE EXCEPTION 'Inventory does not have enough free slots'
          USING ERRCODE = '23514';
      END IF;

      moved_quantity := LEAST(remaining_quantity, maximum_stack);
      INSERT INTO player_inventory_slots (
        player_id,
        slot_index,
        resource_type,
        variant,
        quantity,
        manual_split
      )
      VALUES (
        NEW.player_id,
        free_slot,
        NEW.resource_type,
        NEW.variant,
        moved_quantity,
        false
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
        DELETE FROM player_inventory_slots
        WHERE stack_id = target_stack.stack_id;
      ELSE
        UPDATE player_inventory_slots
        SET quantity = quantity - moved_quantity,
            updated_at = now()
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

CREATE TRIGGER player_inventory_slots_sync
AFTER INSERT OR UPDATE OF quantity ON player_inventory
FOR EACH ROW
EXECUTE FUNCTION sync_player_inventory_slots();
