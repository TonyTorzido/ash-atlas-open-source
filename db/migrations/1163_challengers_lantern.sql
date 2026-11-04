-- Challenger's Lantern: a second dungeon lantern beside the Cinder Lantern. Crafted from a
-- Lamp Sheath and 24 Lumen, 12 charges, one spent per dungeon entry; +3 Attack and +1 Defense
-- against monsters while the run was entered on it. Lantern state gains a `kind` so a player can
-- carry one of each. Forward-only and idempotent.
INSERT INTO item_definitions (
  item_id, display_name, category, rarity, stackable, max_stack,
  droppable, manor_storable, market_tradable, market_fungible,
  market_identity, supported_variants, unit_weight_grams
)
VALUES
  ('challengers_lantern', 'Challenger''s Lantern', 'resource', 'rare', true, 1, false, true, false, false, NULL, ARRAY['default']::text[], 10)
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
  unit_weight_grams = EXCLUDED.unit_weight_grams,
  updated_at = now();

ALTER TABLE cinder_lanterns
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'cinder';
ALTER TABLE cinder_lantern_runs
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'cinder';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'cinder_lanterns'::regclass AND contype = 'p'
      AND conkey @> ARRAY[(SELECT attnum FROM pg_attribute
                           WHERE attrelid = 'cinder_lanterns'::regclass AND attname = 'kind')]
  ) THEN
    ALTER TABLE cinder_lanterns DROP CONSTRAINT cinder_lanterns_pkey;
    ALTER TABLE cinder_lanterns ADD PRIMARY KEY (player_id, kind);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'cinder_lantern_runs'::regclass AND contype = 'p'
      AND conkey @> ARRAY[(SELECT attnum FROM pg_attribute
                           WHERE attrelid = 'cinder_lantern_runs'::regclass AND attname = 'kind')]
  ) THEN
    ALTER TABLE cinder_lantern_runs DROP CONSTRAINT cinder_lantern_runs_pkey;
    ALTER TABLE cinder_lantern_runs ADD PRIMARY KEY (player_id, run_id, kind);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'cinder_lanterns'::regclass AND conname = 'cinder_lanterns_kind_check'
  ) THEN
    ALTER TABLE cinder_lanterns
      ADD CONSTRAINT cinder_lanterns_kind_check CHECK (kind IN ('cinder', 'challenger'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'cinder_lantern_runs'::regclass AND conname = 'cinder_lantern_runs_kind_check'
  ) THEN
    ALTER TABLE cinder_lantern_runs
      ADD CONSTRAINT cinder_lantern_runs_kind_check CHECK (kind IN ('cinder', 'challenger'));
  END IF;
END
$$;
