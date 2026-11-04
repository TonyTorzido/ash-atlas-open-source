INSERT INTO item_definitions (
  item_id, display_name, category, stackable, max_stack,
  droppable, manor_storable, market_tradable, market_fungible,
  market_identity, supported_variants
) VALUES (
  'crude_oil', 'Crude Oil', 'resource', true, 240,
  true, true, true, true, 'crude_oil', ARRAY['default']::text[]
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

ALTER TABLE city_structures
  DROP CONSTRAINT IF EXISTS city_structures_check1,
  DROP CONSTRAINT IF EXISTS city_structures_structure_type_check,
  DROP CONSTRAINT IF EXISTS city_structures_owner_shape_check,
  DROP CONSTRAINT IF EXISTS city_structures_civic_tier_check,
  DROP CONSTRAINT IF EXISTS city_structures_state_timestamps_check;

ALTER TABLE city_structures
  ADD CONSTRAINT city_structures_structure_type_check CHECK (
    structure_type IN (
      'city_house', 'mayor_house', 'oil_well', 'warehouse', 'market',
      'monument', 'weaponsmith', 'armory'
    )
  ),
  ADD CONSTRAINT city_structures_owner_shape_check CHECK (
    (
      structure_type IN ('city_house', 'mayor_house', 'oil_well')
      AND owner_player_id IS NOT NULL
    )
    OR (
      structure_type IN (
        'warehouse', 'market', 'monument', 'weaponsmith', 'armory'
      )
      AND owner_player_id IS NULL
    )
  ),
  ADD CONSTRAINT city_structures_civic_tier_check CHECK (
    (structure_type IN ('market', 'oil_well') AND tier = 1)
    OR (structure_type = 'monument' AND tier BETWEEN 1 AND 3)
    OR structure_type NOT IN ('market', 'oil_well', 'monument')
  ),
  ADD CONSTRAINT city_structures_state_timestamps_check CHECK (
    (
      state = 'constructing'
      AND destroyed_at IS NULL
      AND construction_started_at IS NOT NULL
      AND construction_completes_at IS NOT NULL
    )
    OR (
      state = 'active'
      AND built_at IS NOT NULL
      AND destroyed_at IS NULL
      AND (
        (construction_started_at IS NULL AND construction_completes_at IS NULL)
        OR
        (construction_started_at IS NOT NULL AND construction_completes_at IS NOT NULL)
      )
    )
    OR (
      state = 'destroyed'
      AND destroyed_at IS NOT NULL
      AND (
        (
          built_at IS NULL
          AND construction_started_at IS NOT NULL
          AND construction_completes_at IS NOT NULL
        )
        OR (
          built_at IS NOT NULL
          AND (
            (construction_started_at IS NULL AND construction_completes_at IS NULL)
            OR
            (construction_started_at IS NOT NULL AND construction_completes_at IS NOT NULL)
          )
        )
      )
    )
  );

CREATE UNIQUE INDEX city_structures_one_reserved_oil_well_per_player_idx
  ON city_structures (owner_player_id)
  WHERE structure_type = 'oil_well' AND state IN ('constructing', 'active');

ALTER TABLE city_structure_operations
  DROP CONSTRAINT IF EXISTS city_structure_operations_action_check;
ALTER TABLE city_structure_operations
  ADD CONSTRAINT city_structure_operations_action_check CHECK (
    action IN (
      'build_house', 'destroy_house', 'build_oil_well', 'destroy_oil_well',
      'build_facility', 'upgrade_facility', 'destroy_facility',
      'claim_mayor', 'relinquish_mayor', 'expire_founder_grace',
      'build_market', 'build_monument', 'upgrade_monument', 'destroy_monument'
    )
  );

ALTER TABLE city_structure_events
  DROP CONSTRAINT IF EXISTS city_structure_events_event_type_check;
ALTER TABLE city_structure_events
  ADD CONSTRAINT city_structure_events_event_type_check CHECK (
    event_type IN (
      'built', 'activated', 'upgraded', 'destroyed', 'cancelled',
      'promoted_to_mayor_house', 'demoted_to_city_house',
      'market_built', 'market_activated', 'monument_built',
      'monument_activated', 'monument_upgraded', 'monument_destroyed'
    )
  );

CREATE TABLE city_oil_well_production (
  structure_id uuid PRIMARY KEY
    REFERENCES city_structures(structure_id) ON DELETE RESTRICT,
  owner_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  stored_crude_oil smallint NOT NULL DEFAULT 0 CHECK (stored_crude_oil BETWEEN 0 AND 120),
  production_cursor timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX city_oil_well_production_owner_idx
  ON city_oil_well_production (owner_player_id);

CREATE TABLE city_oil_well_operations (
  operation_key text PRIMARY KEY,
  actor_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  structure_id uuid NOT NULL REFERENCES city_structures(structure_id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action = 'harvest'),
  result jsonb NULL CHECK (result IS NULL OR octet_length(result::text) <= 262144),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz NULL,
  UNIQUE (actor_player_id, request_id),
  CHECK ((completed_at IS NULL) = (result IS NULL))
);

COMMENT ON TABLE city_oil_well_production IS
  'Lazy, row-locked Crude Oil production state. No periodic production worker is required.';
