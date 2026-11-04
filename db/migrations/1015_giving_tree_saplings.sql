-- Giving Tree saplings (docs/giving-trees.md): players plant a Giving Berry or a pulled sapling on
-- open land; it needs tending, then matures into a permanent Giving Tree that regrows berries.
-- Rows are the durable truth. Lifecycle timestamps (death_at, mature_at) are stored so a bounded
-- sweep and every read can settle a sapling with plain comparisons. Forward-only and idempotent.

CREATE TABLE IF NOT EXISTS player_saplings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  region_code TEXT NOT NULL,
  lat DOUBLE PRECISION NOT NULL,
  lon DOUBLE PRECISION NOT NULL,
  status TEXT NOT NULL DEFAULT 'sapling',
  planted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_tended_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  fast_growth BOOLEAN NOT NULL DEFAULT false,
  death_at TIMESTAMPTZ NOT NULL,
  mature_at TIMESTAMPTZ NOT NULL,
  matured_at TIMESTAMPTZ NULL,
  died_at TIMESTAMPTZ NULL,
  pulled_at TIMESTAMPTZ NULL,
  pulled_by_player_id TEXT NULL REFERENCES players(id) ON DELETE SET NULL,
  berry_ready_at TIMESTAMPTZ NULL,
  tend_count INTEGER NOT NULL DEFAULT 0 CHECK (tend_count >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (owner_player_id, request_id),
  CHECK (length(request_id) > 0),
  CHECK (length(region_code) > 0),
  CHECK (lat >= -90 AND lat <= 90),
  CHECK (lon >= -180 AND lon <= 180),
  CHECK (status IN ('sapling', 'grown', 'dead', 'pulled')),
  CHECK (status <> 'grown' OR (matured_at IS NOT NULL AND berry_ready_at IS NOT NULL)),
  CHECK (status <> 'dead' OR died_at IS NOT NULL),
  CHECK (status <> 'pulled' OR (pulled_at IS NOT NULL))
);

-- Live rows only: the settle sweep, the per-player cap, spacing and the nearby view all read these.
CREATE INDEX IF NOT EXISTS player_saplings_live_owner_idx
  ON player_saplings (owner_player_id) WHERE status IN ('sapling', 'grown');
CREATE INDEX IF NOT EXISTS player_saplings_sapling_due_idx
  ON player_saplings (LEAST(death_at, mature_at)) WHERE status = 'sapling';
CREATE INDEX IF NOT EXISTS player_saplings_live_geom_idx
  ON player_saplings USING gist ((ST_SetSRID(ST_MakePoint(lon, lat), 4326)::geography))
  WHERE status IN ('sapling', 'grown');

-- The item a Grove Lore rank 3 player gets back when pulling a sapling.
INSERT INTO item_definitions (
  item_id, display_name, category, rarity, stackable, max_stack,
  droppable, manor_storable, market_tradable, market_fungible,
  market_identity, supported_variants, unit_weight_grams
)
VALUES
  ('giving_tree_sapling', 'Giving Tree Sapling', 'resource', 'uncommon', true, 25, true, true, true, true, 'giving_tree_sapling', ARRAY['default']::text[], 500)
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
