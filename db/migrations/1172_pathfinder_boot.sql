-- Pathfinder Boot (utility gear, boots slot) and its single travel mark per player. Forward-only and idempotent.
INSERT INTO item_definitions (
  item_id, display_name, category, equipment_family_id, equipment_role, rarity,
  stackable, max_stack, droppable, manor_storable,
  market_tradable, market_fungible, market_identity, supported_variants, unit_weight_grams
) VALUES
  ('pathfinder_boot', 'Pathfinder Boot', 'equipment', 'utility_boot', 'special', 'rare', false, 1, true, true, false, false, NULL, ARRAY['default']::text[], 150)
ON CONFLICT (item_id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  category = EXCLUDED.category,
  equipment_family_id = EXCLUDED.equipment_family_id,
  equipment_role = EXCLUDED.equipment_role,
  rarity = EXCLUDED.rarity,
  stackable = EXCLUDED.stackable,
  max_stack = EXCLUDED.max_stack,
  droppable = EXCLUDED.droppable,
  manor_storable = EXCLUDED.manor_storable,
  market_tradable = EXCLUDED.market_tradable,
  market_fungible = EXCLUDED.market_fungible,
  market_identity = EXCLUDED.market_identity,
  supported_variants = EXCLUDED.supported_variants,
  unit_weight_grams = EXCLUDED.unit_weight_grams;

ALTER TABLE equipment_instances
  DROP CONSTRAINT IF EXISTS equipment_instances_uses_remaining_check;
ALTER TABLE equipment_instances
  ADD CONSTRAINT equipment_instances_uses_remaining_check CHECK (
    CASE
      WHEN definition_id IN ('lumber_glove', 'delver_glove', 'artisan_glove', 'lodestone_boot', 'coinwright_glove', 'tiller_boot', 'pathfinder_boot')
        THEN uses_remaining IS NOT NULL AND uses_remaining >= 0
      ELSE uses_remaining IS NULL
    END
  );

-- One mark per player: a new mark replaces the old row. expires_at is authoritative for travel.
CREATE TABLE IF NOT EXISTS player_pathfinder_marks (
  player_id text PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  flag_id uuid NOT NULL,
  name text NOT NULL,
  lat double precision NOT NULL,
  lon double precision NOT NULL,
  request_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Request ledger so a replayed mark request never charges a second use.
CREATE TABLE IF NOT EXISTS player_pathfinder_mark_requests (
  player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  request_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, request_id)
);
