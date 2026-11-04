INSERT INTO item_definitions (
  item_id, display_name, category, stackable, max_stack,
  droppable, manor_storable, market_tradable, market_fungible,
  market_identity, supported_variants
)
VALUES
  ('venomsteel_bar', 'Venomsteel Bar', 'resource', true, 250, true, true, true, true,
   'venomsteel_bar', ARRAY['default']::text[]),
  ('venomsteel_core', 'Venomsteel Core', 'resource', true, 250, true, true, true, true,
   'venomsteel_core', ARRAY['default']::text[])
ON CONFLICT (item_id) DO UPDATE
SET display_name = EXCLUDED.display_name,
    category = EXCLUDED.category,
    stackable = EXCLUDED.stackable,
    max_stack = EXCLUDED.max_stack,
    droppable = EXCLUDED.droppable,
    manor_storable = EXCLUDED.manor_storable,
    market_tradable = EXCLUDED.market_tradable,
    market_fungible = EXCLUDED.market_fungible,
    market_identity = EXCLUDED.market_identity,
    supported_variants = EXCLUDED.supported_variants,
    updated_at = now();

CREATE TABLE IF NOT EXISTS player_stats (
  player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  stat_key text NOT NULL CHECK (stat_key ~ '^[a-z][a-z0-9_]{0,63}$'),
  value bigint NOT NULL DEFAULT 0 CHECK (value >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, stat_key)
);

CREATE TABLE IF NOT EXISTS player_achievements (
  player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  achievement_id text NOT NULL CHECK (achievement_id ~ '^[a-z][a-z0-9_]{0,63}$'),
  unlocked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, achievement_id)
);
CREATE INDEX IF NOT EXISTS player_achievements_unlocked_idx
  ON player_achievements (player_id, unlocked_at DESC);

ALTER TABLE furnace_smelt_jobs
  ADD COLUMN IF NOT EXISTS recipe_id text;
UPDATE furnace_smelt_jobs SET recipe_id = 'iron_bar' WHERE recipe_id IS NULL;
ALTER TABLE furnace_smelt_jobs
  ALTER COLUMN recipe_id SET NOT NULL;
ALTER TABLE furnace_smelt_jobs
  DROP CONSTRAINT IF EXISTS furnace_smelt_jobs_recipe_id_check;
ALTER TABLE furnace_smelt_jobs
  ADD CONSTRAINT furnace_smelt_jobs_recipe_id_check
    CHECK (recipe_id IN ('iron_bar', 'venomsteel_bar', 'venomsteel_core'));

ALTER TABLE equipment_operations
  ADD COLUMN IF NOT EXISTS request_hash text NULL;
ALTER TABLE equipment_operations
  DROP CONSTRAINT IF EXISTS equipment_operations_action_check;
ALTER TABLE equipment_operations
  ADD CONSTRAINT equipment_operations_action_check CHECK (
    action IN (
      'starter_loadout', 'equip', 'unequip', 'package_grant',
      'ground_drop', 'ground_pickup', 'ground_expire', 'prepare', 'imbue'
    )
  );
ALTER TABLE equipment_operations
  DROP CONSTRAINT IF EXISTS equipment_operations_request_hash_check;
ALTER TABLE equipment_operations
  ADD CONSTRAINT equipment_operations_request_hash_check CHECK (
    request_hash IS NULL OR request_hash ~ '^[0-9a-f]{64}$'
  );
