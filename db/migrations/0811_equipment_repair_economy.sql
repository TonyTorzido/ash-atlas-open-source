-- Equipment repair economy.
--
-- Condition is instance state, not item-definition state. Existing instances
-- therefore begin at full condition and retain every other identity/metadata
-- field. Shell is retained as a historical definition, while live custody is
-- converted to Chitin through the same append-only inventory event chain used
-- by normal inventory transitions.

-- Serialize the conversion against normal inventory/storage writers. The
-- migration runner executes this file in one transaction, so no live custody
-- operation can observe a half-converted Shell stack.
LOCK TABLE item_definitions, equipment_instances, player_inventory,
  inventory_operations, inventory_events, manor_storage_stacks,
  city_warehouse_stacks IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE equipment_instances
  ADD COLUMN IF NOT EXISTS condition smallint NOT NULL DEFAULT 100;

ALTER TABLE equipment_instances
  DROP CONSTRAINT IF EXISTS equipment_instances_condition_check;
ALTER TABLE equipment_instances
  ADD CONSTRAINT equipment_instances_condition_check
  CHECK (condition BETWEEN 0 AND 100);

COMMENT ON COLUMN equipment_instances.condition IS
  'Durable chest-armor condition. 0 is broken and 100 is fully repaired.';

INSERT INTO item_definitions (
  item_id, display_name, category, rarity, stackable, max_stack,
  droppable, manor_storable, market_tradable, market_fungible,
  market_identity, supported_variants
)
VALUES
  ('chitin', 'Chitin', 'resource', 'common', true, 500,
   true, true, true, true, 'chitin', ARRAY['default']::text[]),
  ('repair_kit', 'Repair Kit', 'consumable', 'uncommon', true, 50,
   true, true, true, true, 'repair_kit', ARRAY['default']::text[])
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
  updated_at = now();

-- Shell remains addressable for retained historical events, but cannot be
-- newly listed or granted by the active catalog.
UPDATE item_definitions
SET display_name = 'Shell (Legacy)',
    droppable = false,
    market_tradable = false,
    market_fungible = false,
    market_identity = NULL,
    updated_at = now()
WHERE item_id = 'shell';

CREATE TABLE IF NOT EXISTS equipment_repair_operations (
  operation_key text PRIMARY KEY,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN ('death_wear', 'repair', 'craft_repair_kit')),
  request_id text NULL CHECK (request_id IS NULL OR length(request_id) BETWEEN 1 AND 128),
  request_hash text NULL CHECK (request_hash IS NULL OR request_hash ~ '^[0-9a-f]{64}$'),
  instance_id uuid NULL REFERENCES equipment_instances(instance_id) ON DELETE RESTRICT,
  expected_condition smallint NULL CHECK (expected_condition IS NULL OR expected_condition BETWEEN 0 AND 100),
  result jsonb NULL CHECK (result IS NULL OR octet_length(result::text) <= 262144),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NULL,
  UNIQUE (player_id, request_id),
  CHECK ((completed_at IS NULL) = (result IS NULL))
);
CREATE INDEX IF NOT EXISTS equipment_repair_operations_player_created_idx
  ON equipment_repair_operations (player_id, created_at DESC);
CREATE INDEX IF NOT EXISTS equipment_repair_operations_instance_created_idx
  ON equipment_repair_operations (instance_id, created_at DESC)
  WHERE instance_id IS NOT NULL;

-- Live manor/warehouse rows are mutable custody projections. The retained
-- manor overflow ledger and historical event rows remain append-only and
-- retain their original Shell identity.
UPDATE manor_storage_stacks
SET item_id = 'chitin', updated_at = now()
WHERE item_id = 'shell';
UPDATE city_warehouse_stacks
SET item_id = 'chitin', updated_at = now()
WHERE item_id = 'shell';

-- Convert every live player shell stack exactly once. The operation and two
-- inventory events make the conversion replay-safe and preserve the complete
-- quantity/version history under the immutable asset guards.
DO $$
DECLARE
  shell_stack record;
  chitin_row record;
  op_key text;
  variant_value text;
BEGIN
  FOR shell_stack IN
    SELECT player_id, COALESCE(variant, 'default') AS variant, quantity::bigint AS quantity
    FROM player_inventory
    WHERE resource_type = 'shell' AND quantity > 0
    ORDER BY player_id, COALESCE(variant, 'default')
  LOOP
    variant_value := shell_stack.variant;
    op_key := 'migration:0811:shell-to-chitin:' || shell_stack.player_id || ':' || variant_value;

    INSERT INTO inventory_operations (
      operation_key, player_id, source, source_entity_type, source_entity_id, metadata
    ) VALUES (
      op_key, shell_stack.player_id, 'equipment_repair_migration',
      'migration', '0811',
      jsonb_build_object('from', 'shell', 'to', 'chitin', 'variant', variant_value)
    ) ON CONFLICT (operation_key) DO NOTHING;

    IF EXISTS (
      SELECT 1 FROM inventory_events WHERE inventory_events.operation_key = op_key
    ) THEN
      CONTINUE;
    END IF;

    INSERT INTO player_inventory (
      player_id, resource_type, variant, quantity, version, updated_at
    ) VALUES (shell_stack.player_id, 'chitin', variant_value, 0, 0, now())
    ON CONFLICT (player_id, resource_type, variant) DO NOTHING;

    UPDATE player_inventory
    SET quantity = quantity + shell_stack.quantity,
        version = COALESCE(version, 0) + 1,
        updated_at = now()
    WHERE player_id = shell_stack.player_id
      AND resource_type = 'chitin'
      AND variant = variant_value
    RETURNING quantity::bigint, version::bigint INTO chitin_row;

    INSERT INTO inventory_events (
      operation_key, player_id, item_id, variant, delta_quantity,
      quantity_after, version_after, source, source_entity_type,
      source_entity_id, metadata
    ) VALUES (
      op_key, shell_stack.player_id, 'chitin', variant_value,
      shell_stack.quantity, chitin_row.quantity, chitin_row.version,
      'equipment_repair_migration', 'migration', '0811',
      jsonb_build_object('from', 'shell', 'to', 'chitin')
    );

    UPDATE player_inventory
    SET quantity = 0,
        version = COALESCE(version, 0) + 1,
        updated_at = now()
    WHERE player_id = shell_stack.player_id
      AND resource_type = 'shell'
      AND variant IS NOT DISTINCT FROM variant_value;

    INSERT INTO inventory_events (
      operation_key, player_id, item_id, variant, delta_quantity,
      quantity_after, version_after, source, source_entity_type,
      source_entity_id, metadata
    )
    SELECT op_key, shell_stack.player_id, 'shell', variant,
           -shell_stack.quantity, quantity, version,
           'equipment_repair_migration', 'migration', '0811',
           jsonb_build_object('from', 'shell', 'to', 'chitin')
    FROM player_inventory
    WHERE player_id = shell_stack.player_id
      AND resource_type = 'shell'
      AND variant IS NOT DISTINCT FROM variant_value;
  END LOOP;
END;
$$;
