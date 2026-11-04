-- Wild Flax and Cloth crafting.
--
-- Flax is a generation-scoped, land-only Population V2 collectible. Cloth is
-- a durable, tradable input for Tunics and their repairs. The Loom uses the
-- same transactional station/job pattern as the existing processing stations.

INSERT INTO item_definitions (
  item_id, display_name, category, rarity, stackable, max_stack,
  droppable, manor_storable, market_tradable, market_fungible,
  market_identity, supported_variants
)
VALUES
  ('flax_fiber', 'Flax Fiber', 'resource', 'common', true, 250,
   true, true, true, true, 'flax_fiber', ARRAY['default']::text[]),
  ('cloth', 'Cloth', 'resource', 'common', true, 250,
   true, true, true, true, 'cloth', ARRAY['default']::text[])
ON CONFLICT (item_id) DO UPDATE SET
  display_name=EXCLUDED.display_name,
  category=EXCLUDED.category,
  rarity=EXCLUDED.rarity,
  stackable=EXCLUDED.stackable,
  max_stack=EXCLUDED.max_stack,
  droppable=EXCLUDED.droppable,
  manor_storable=EXCLUDED.manor_storable,
  market_tradable=EXCLUDED.market_tradable,
  market_fungible=EXCLUDED.market_fungible,
  market_identity=EXCLUDED.market_identity,
  supported_variants=EXCLUDED.supported_variants,
  updated_at=now();

-- The original Population V2 collectible guard encoded the tree's yield
-- shape. Keep that compatibility while admitting the Flax plant shape.
ALTER TABLE collectible_nodes
  DROP CONSTRAINT IF EXISTS collectible_nodes_population_v2_owner_complete,
  ADD CONSTRAINT collectible_nodes_population_v2_owner_complete CHECK (
    placement_version IS NOT NULL
    AND (
      (resource_type = 'wood' AND quantity IN (4, 10, 20))
      OR
      (resource_type = 'flax_fiber' AND quantity = 3)
    )
    AND population_v2_entity_id IS NOT NULL
    AND id = population_v2_entity_id::text
    AND population_v2_plan_id IS NOT NULL
    AND population_v2_state_revision IS NOT NULL
    AND physical_population_zone_v2_id IS NOT NULL
    AND population_cutover_revision IS NOT NULL
  );

ALTER TABLE population_spawn_slots_v2
  DROP CONSTRAINT IF EXISTS population_spawn_slots_v2_entity_shape_check,
  ADD CONSTRAINT population_spawn_slots_v2_entity_shape_check CHECK (
    (
      archetype IN ('tree', 'flax', 'stone_mine', 'coal_mine', 'iron_mine')
      AND encounter_id IS NULL AND pack_id IS NULL
      AND pack_member_index IS NULL
    )
    OR
    (
      archetype NOT IN ('tree', 'flax', 'stone_mine', 'coal_mine', 'iron_mine')
      AND encounter_id IS NOT NULL
      AND (
        (pack_id IS NULL AND pack_member_index IS NULL)
        OR (pack_id IS NOT NULL AND pack_member_index IS NOT NULL)
      )
    )
  );

CREATE TABLE player_looms (
  loom_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  manor_id uuid NOT NULL REFERENCES player_manors(id) ON DELETE RESTRICT,
  owner_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  world_id text NOT NULL,
  region_code text NOT NULL,
  lat double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lon double precision NOT NULL CHECK (lon BETWEEN -180 AND 180),
  geom geometry(Point,4326) NOT NULL,
  placement_revision bigint NOT NULL DEFAULT 1 CHECK (placement_revision > 0),
  built_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz NULL,
  removal_reason text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX player_looms_world_geom_idx ON player_looms USING gist (geom);
CREATE UNIQUE INDEX player_looms_active_owner_unique
  ON player_looms(owner_player_id) WHERE removed_at IS NULL;

CREATE TABLE loom_build_jobs (
  build_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  request_id text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  manor_id uuid NOT NULL REFERENCES player_manors(id) ON DELETE RESTRICT,
  world_id text NOT NULL,
  region_code text NOT NULL,
  lat double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lon double precision NOT NULL CHECK (lon BETWEEN -180 AND 180),
  geom geometry(Point,4326) NOT NULL,
  status text NOT NULL DEFAULT 'constructing'
    CHECK (status IN ('constructing','completed','cancelled')),
  started_at timestamptz NOT NULL,
  completes_at timestamptz NOT NULL,
  loom_id uuid NULL REFERENCES player_looms(loom_id) ON DELETE RESTRICT,
  cancel_reason text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_player_id,request_id),
  CHECK (completes_at > started_at),
  CHECK ((status='completed')=(loom_id IS NOT NULL))
);
CREATE UNIQUE INDEX loom_build_jobs_active_owner_idx
  ON loom_build_jobs(owner_player_id) WHERE status='constructing';
CREATE INDEX loom_build_jobs_due_idx
  ON loom_build_jobs(completes_at,build_id) WHERE status='constructing';

CREATE TABLE loom_jobs (
  job_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loom_id uuid NOT NULL REFERENCES player_looms(loom_id) ON DELETE RESTRICT,
  owner_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  recipe_id text NOT NULL CHECK (recipe_id = 'flax_fiber'),
  requested_input_quantity integer NOT NULL CHECK (
    requested_input_quantity BETWEEN 2 AND 24
    AND requested_input_quantity % 2 = 0
  ),
  output_quantity integer NOT NULL CHECK (
    output_quantity BETWEEN 1 AND 12
    AND output_quantity * 2 = requested_input_quantity
  ),
  collected_quantity integer NOT NULL DEFAULT 0 CHECK (collected_quantity >= 0),
  started_at timestamptz NOT NULL,
  completes_at timestamptz NOT NULL,
  cleared_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (completes_at > started_at),
  CHECK (collected_quantity <= output_quantity)
);
CREATE INDEX loom_jobs_queue_idx
  ON loom_jobs(loom_id,started_at,created_at,job_id) WHERE cleared_at IS NULL;
CREATE INDEX loom_jobs_owner_idx ON loom_jobs(owner_player_id,started_at DESC);

CREATE TABLE loom_operations (
  operation_key text PRIMARY KEY,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  request_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('build','start','collect')),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  loom_id uuid NOT NULL REFERENCES player_looms(loom_id) ON DELETE RESTRICT,
  job_id uuid NULL REFERENCES loom_jobs(job_id) ON DELETE RESTRICT,
  result_quantity integer NOT NULL DEFAULT 0 CHECK (result_quantity >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(player_id,request_id)
);
CREATE INDEX loom_operations_loom_idx ON loom_operations(loom_id,created_at DESC);
