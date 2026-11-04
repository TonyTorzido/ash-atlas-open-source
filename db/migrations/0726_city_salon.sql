ALTER TABLE city_structures
  DROP CONSTRAINT IF EXISTS city_structures_structure_type_check,
  DROP CONSTRAINT IF EXISTS city_structures_owner_shape_check,
  DROP CONSTRAINT IF EXISTS city_structures_civic_tier_check;

ALTER TABLE city_structures
  ADD CONSTRAINT city_structures_structure_type_check CHECK (
    structure_type IN (
      'city_house', 'mayor_house', 'oil_well', 'warehouse', 'cistern_warrens',
      'salon', 'market', 'monument', 'weaponsmith', 'armory'
    )
  ),
  ADD CONSTRAINT city_structures_owner_shape_check CHECK (
    (
      structure_type IN ('city_house', 'mayor_house', 'oil_well')
      AND owner_player_id IS NOT NULL
    )
    OR (
      structure_type IN (
        'warehouse', 'cistern_warrens', 'salon', 'market', 'monument',
        'weaponsmith', 'armory'
      )
      AND owner_player_id IS NULL
    )
  ),
  ADD CONSTRAINT city_structures_civic_tier_check CHECK (
    (structure_type IN ('market', 'oil_well', 'cistern_warrens', 'salon') AND tier = 1)
    OR (structure_type = 'monument' AND tier BETWEEN 1 AND 3)
    OR structure_type NOT IN ('market', 'oil_well', 'cistern_warrens', 'salon', 'monument')
  );

CREATE UNIQUE INDEX city_structures_one_reserved_salon_per_city_idx
  ON city_structures (city_id)
  WHERE structure_type = 'salon' AND state IN ('constructing', 'active');

ALTER TABLE players
  ADD COLUMN hair_appearance_id text NULL,
  ADD COLUMN eyes_appearance_id text NULL,
  ADD COLUMN nose_mouth_appearance_id text NULL,
  ADD COLUMN base_appearance_revision bigint NOT NULL DEFAULT 0
    CHECK (base_appearance_revision >= 0);

CREATE TABLE salon_presence (
  player_id text PRIMARY KEY REFERENCES players(id) ON DELETE RESTRICT,
  salon_structure_id uuid NOT NULL
    REFERENCES city_structures(structure_id) ON DELETE RESTRICT,
  session_id uuid NOT NULL UNIQUE,
  local_x double precision NOT NULL CHECK (local_x BETWEEN 0 AND 1000),
  local_y double precision NOT NULL CHECK (local_y BETWEEN 0 AND 1000),
  return_region_code text NOT NULL,
  return_lat double precision NOT NULL CHECK (return_lat BETWEEN -90 AND 90),
  return_lon double precision NOT NULL CHECK (return_lon BETWEEN -180 AND 180),
  entered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX salon_presence_structure_idx
  ON salon_presence (salon_structure_id);

CREATE TABLE salon_appearance_operations (
  operation_key text PRIMARY KEY,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  salon_structure_id uuid NOT NULL
    REFERENCES city_structures(structure_id) ON DELETE RESTRICT,
  request_hash text NOT NULL CHECK (length(request_hash) = 64),
  catalog_revision integer NOT NULL CHECK (catalog_revision >= 0),
  prior_revision bigint NOT NULL CHECK (prior_revision >= 0),
  resulting_revision bigint NULL CHECK (resulting_revision IS NULL OR resulting_revision > prior_revision),
  intent jsonb NOT NULL CHECK (octet_length(intent::text) <= 8192),
  result jsonb NULL CHECK (result IS NULL OR octet_length(result::text) <= 65536),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz NULL,
  UNIQUE (player_id, request_id),
  CHECK ((completed_at IS NULL) = (result IS NULL)),
  CHECK ((resulting_revision IS NULL) = (completed_at IS NULL))
);
