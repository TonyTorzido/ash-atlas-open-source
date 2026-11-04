-- Permanent, authored repeatable resources and the first-pass gathering economy.

INSERT INTO item_definitions (
  item_id, display_name, category, stackable, max_stack,
  market_tradable, market_fungible, market_identity, supported_variants
) VALUES (
  'leather', 'Leather', 'resource', true, NULL,
  true, true, 'leather', ARRAY['default']::text[]
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

ALTER TABLE flags
  ADD COLUMN IF NOT EXISTS reinforcement_level smallint NOT NULL DEFAULT 0
    CHECK (reinforcement_level BETWEEN 0 AND 1),
  ADD COLUMN IF NOT EXISTS reinforced_operation_key text NULL UNIQUE,
  ADD COLUMN IF NOT EXISTS reinforced_at timestamptz NULL;

CREATE TABLE IF NOT EXISTS repeatable_resource_nodes (
  id uuid PRIMARY KEY,
  node_type text NOT NULL CHECK (node_type IN ('stone_mine')),
  region_code text NOT NULL,
  lat double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lon double precision NOT NULL CHECK (lon BETWEEN -180 AND 180),
  geom geometry(Point, 4326) NOT NULL,
  yield_item_id text NOT NULL REFERENCES item_definitions(item_id) ON DELETE RESTRICT,
  yield_quantity integer NOT NULL CHECK (yield_quantity > 0),
  regeneration_interval interval NOT NULL CHECK (regeneration_interval > interval '0'),
  ready_at timestamptz NOT NULL DEFAULT '-infinity',
  harvest_revision bigint NOT NULL DEFAULT 0 CHECK (harvest_revision >= 0),
  last_harvested_by text NULL REFERENCES players(id) ON DELETE SET NULL,
  authored_source text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (node_type <> 'stone_mine' OR (yield_item_id = 'stone' AND yield_quantity = 5)),
  CHECK (node_type <> 'stone_mine' OR regeneration_interval = interval '5 hours 50 minutes')
);

CREATE INDEX IF NOT EXISTS repeatable_resource_nodes_region_geom_idx
  ON repeatable_resource_nodes USING gist ((geom::geography));
CREATE INDEX IF NOT EXISTS repeatable_resource_nodes_ready_idx
  ON repeatable_resource_nodes (region_code, ready_at);

DROP TRIGGER IF EXISTS repeatable_resource_nodes_set_updated_at ON repeatable_resource_nodes;
CREATE TRIGGER repeatable_resource_nodes_set_updated_at
BEFORE UPDATE ON repeatable_resource_nodes
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS repeatable_resource_harvests (
  operation_key text PRIMARY KEY,
  request_id text NOT NULL,
  node_id uuid NOT NULL REFERENCES repeatable_resource_nodes(id) ON DELETE RESTRICT,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  harvest_revision bigint NOT NULL CHECK (harvest_revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (player_id, request_id),
  UNIQUE (node_id, harvest_revision)
);

-- Small, reviewable authored seed set for the current Albuquerque development area.
INSERT INTO repeatable_resource_nodes (
  id, node_type, region_code, lat, lon, geom, yield_item_id, yield_quantity,
  regeneration_interval, authored_source
) VALUES
  ('00000000-0000-4000-8000-000000000616', 'stone_mine', 'world_v1_lat35_lon-107',
   35.089250, -106.642500, ST_SetSRID(ST_MakePoint(-106.642500, 35.089250), 4326),
   'stone', 5, interval '5 hours 50 minutes', 'development_seed_v1'),
  ('00000000-0000-4000-8000-000000000617', 'stone_mine', 'world_v1_lat35_lon-107',
   35.050800, -106.708300, ST_SetSRID(ST_MakePoint(-106.708300, 35.050800), 4326),
   'stone', 5, interval '5 hours 50 minutes', 'development_seed_v1')
ON CONFLICT (id) DO NOTHING;
