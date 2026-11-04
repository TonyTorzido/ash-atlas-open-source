-- Survey Stake Kit and Compass. A kit names a spot (up to 50 reusable markers per player, private to
-- the owner); the Compass unlocks the worldwide overview plus one active waypoint and wears out
-- after 30 days of use. Forward-only and idempotent.

INSERT INTO item_definitions (
  item_id, display_name, category, rarity, stackable, max_stack,
  droppable, manor_storable, market_tradable, market_fungible,
  market_identity, supported_variants, unit_weight_grams
)
VALUES
  ('survey_stake_kit', 'Survey Stake Kit', 'consumable', 'uncommon', true, 25, true, true, false, false, NULL, ARRAY['default']::text[], 10),
  ('compass', 'Compass', 'resource', 'uncommon', false, 1, false, true, false, false, NULL, ARRAY['default']::text[], 1000)
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

CREATE TABLE IF NOT EXISTS player_map_markers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  -- Replay guard: a retried create returns the same marker and never consumes a second kit.
  request_id text NOT NULL,
  name text NOT NULL CHECK (name = btrim(name) AND char_length(name) BETWEEN 1 AND 32),
  lat double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lon double precision NOT NULL CHECK (lon BETWEEN -180 AND 180),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT player_map_markers_request UNIQUE (player_id, request_id)
);

CREATE INDEX IF NOT EXISTS player_map_markers_player_idx
  ON player_map_markers (player_id, created_at, id);

-- One active waypoint per player. A marker waypoint follows its marker's deletion.
CREATE TABLE IF NOT EXISTS player_map_waypoints (
  player_id text PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  marker_id uuid REFERENCES player_map_markers(id) ON DELETE CASCADE,
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 64),
  lat double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lon double precision NOT NULL CHECK (lon BETWEEN -180 AND 180),
  set_at timestamptz NOT NULL DEFAULT now()
);

-- Compass wear: the Compass is a single carried tool, so wear is tracked per player.
CREATE TABLE IF NOT EXISTS player_compass_wear (
  player_id text PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  days_used integer NOT NULL DEFAULT 0 CHECK (days_used BETWEEN 0 AND 30),
  last_used_day date,
  updated_at timestamptz NOT NULL DEFAULT now()
);
