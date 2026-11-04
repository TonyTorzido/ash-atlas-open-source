INSERT INTO item_definitions (
  item_id, display_name, category, stackable, max_stack,
  market_tradable, market_fungible, market_identity, supported_variants
) VALUES (
  'balsam_resin', 'Balsam Resin', 'consumable', true, NULL,
  false, false, NULL, ARRAY['default']::text[]
)
ON CONFLICT (item_id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  category = EXCLUDED.category,
  stackable = EXCLUDED.stackable,
  max_stack = EXCLUDED.max_stack,
  market_tradable = EXCLUDED.market_tradable,
  market_fungible = EXCLUDED.market_fungible,
  market_identity = EXCLUDED.market_identity,
  supported_variants = EXCLUDED.supported_variants,
  updated_at = now();

ALTER TABLE collectible_nodes
  ADD COLUMN IF NOT EXISTS resin_harvested_life_revision bigint NULL
    CHECK (
      resin_harvested_life_revision IS NULL
      OR resin_harvested_life_revision >= 0
    );

CREATE TABLE IF NOT EXISTS balsam_resin_effects (
  effect_id uuid PRIMARY KEY,
  operation_key text NOT NULL UNIQUE
    REFERENCES inventory_operations(operation_key) ON DELETE RESTRICT,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  started_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'completed', 'cleared')),
  cleared_reason text NULL,
  completed_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at >= started_at),
  CHECK (
    (status = 'active' AND completed_at IS NULL)
    OR (status <> 'active' AND completed_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS balsam_resin_effects_one_active_player_idx
  ON balsam_resin_effects (player_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS balsam_resin_effects_player_created_idx
  ON balsam_resin_effects (player_id, created_at DESC);

DROP TRIGGER IF EXISTS balsam_resin_effects_set_updated_at
  ON balsam_resin_effects;
CREATE TRIGGER balsam_resin_effects_set_updated_at
BEFORE UPDATE ON balsam_resin_effects
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
