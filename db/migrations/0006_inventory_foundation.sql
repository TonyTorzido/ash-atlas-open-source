CREATE TABLE IF NOT EXISTS item_definitions (
  item_id text PRIMARY KEY,
  display_name text NOT NULL,
  category text NOT NULL,
  stackable boolean NOT NULL DEFAULT true,
  max_stack integer NULL CHECK (max_stack IS NULL OR max_stack > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO item_definitions (item_id, display_name, category, stackable, max_stack)
VALUES
  ('wood', 'Wood', 'resource', true, NULL),
  ('stone', 'Stone', 'resource', true, NULL),
  ('food', 'Food', 'resource', true, NULL),
  ('ore', 'Ore', 'resource', true, NULL),
  ('water', 'Water', 'resource', true, NULL)
ON CONFLICT (item_id) DO NOTHING;

ALTER TABLE player_inventory
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'player_inventory_quantity_nonnegative'
  ) THEN
    ALTER TABLE player_inventory
      ADD CONSTRAINT player_inventory_quantity_nonnegative CHECK (quantity >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'player_inventory_item_definition_fk'
  ) THEN
    ALTER TABLE player_inventory
      ADD CONSTRAINT player_inventory_item_definition_fk
      FOREIGN KEY (resource_type) REFERENCES item_definitions(item_id);
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS player_inventory_set_updated_at ON player_inventory;
CREATE TRIGGER player_inventory_set_updated_at
BEFORE UPDATE ON player_inventory
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS inventory_operations (
  operation_key text PRIMARY KEY,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  source text NOT NULL,
  source_entity_type text NULL,
  source_entity_id text NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS inventory_operations_player_created_idx
  ON inventory_operations (player_id, created_at DESC);

CREATE INDEX IF NOT EXISTS inventory_operations_source_entity_idx
  ON inventory_operations (source_entity_type, source_entity_id)
  WHERE source_entity_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS inventory_events (
  id bigserial PRIMARY KEY,
  operation_key text NOT NULL REFERENCES inventory_operations(operation_key) ON DELETE RESTRICT,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  item_id text NOT NULL REFERENCES item_definitions(item_id),
  variant text NOT NULL DEFAULT 'default',
  delta_quantity integer NOT NULL CHECK (delta_quantity <> 0),
  quantity_after integer NOT NULL CHECK (quantity_after >= 0),
  source text NOT NULL,
  source_entity_type text NULL,
  source_entity_id text NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (operation_key, item_id, variant)
);

CREATE INDEX IF NOT EXISTS inventory_events_player_created_idx
  ON inventory_events (player_id, created_at DESC);

CREATE INDEX IF NOT EXISTS inventory_events_item_created_idx
  ON inventory_events (item_id, created_at DESC);

CREATE INDEX IF NOT EXISTS inventory_events_source_entity_idx
  ON inventory_events (source_entity_type, source_entity_id)
  WHERE source_entity_id IS NOT NULL;

