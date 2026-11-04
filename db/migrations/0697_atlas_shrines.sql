INSERT INTO item_definitions (
  item_id, display_name, category, stackable, max_stack,
  droppable, manor_storable, market_tradable, market_fungible,
  market_identity, supported_variants
) VALUES (
  'atlas_shrine_shard', 'Atlas Shrine Shard', 'resource', true, 25,
  true, true, false, false, NULL, ARRAY['default']::text[]
)
ON CONFLICT (item_id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
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

CREATE TABLE IF NOT EXISTS player_atlas_shrine_progression (
  player_id text PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  unlocked_slots smallint NOT NULL DEFAULT 0
    CONSTRAINT player_atlas_shrine_unlocked_slots_range
    CHECK (unlocked_slots BETWEEN 0 AND 25),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO player_atlas_shrine_progression (player_id)
SELECT id FROM players
ON CONFLICT (player_id) DO NOTHING;

DROP TRIGGER IF EXISTS player_atlas_shrine_progression_set_updated_at
  ON player_atlas_shrine_progression;
CREATE TRIGGER player_atlas_shrine_progression_set_updated_at
BEFORE UPDATE ON player_atlas_shrine_progression
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS atlas_shrine_unlock_operations (
  operation_key text PRIMARY KEY,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  slot_number smallint NOT NULL CHECK (slot_number BETWEEN 1 AND 25),
  shard_cost smallint NOT NULL CHECK (shard_cost = slot_number),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (player_id, slot_number)
);

ALTER TABLE flags
  DROP CONSTRAINT IF EXISTS flags_reinforcement_level_check;
ALTER TABLE flags
  ADD CONSTRAINT flags_reinforcement_level_check
  CHECK (reinforcement_level BETWEEN 0 AND 2);
ALTER TABLE flags
  DROP CONSTRAINT IF EXISTS flags_atlas_shrine_personal_check;
ALTER TABLE flags
  ADD CONSTRAINT flags_atlas_shrine_personal_check
  CHECK (
    reinforcement_level <> 2
    OR (
      control_type = 'personal'
      AND city_id IS NULL
      AND kingdom_id IS NULL
    )
  );

CREATE INDEX IF NOT EXISTS flags_atlas_shrine_owner_idx
  ON flags (owner_id, id)
  WHERE reinforcement_level = 2;

ALTER TABLE combat_reward_settlements
  ADD COLUMN IF NOT EXISTS atlas_shrine_shard_quantity smallint NOT NULL DEFAULT 0
    CHECK (atlas_shrine_shard_quantity BETWEEN 0 AND 2);
