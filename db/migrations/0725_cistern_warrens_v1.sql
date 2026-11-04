ALTER TABLE city_structures
  DROP CONSTRAINT IF EXISTS city_structures_structure_type_check,
  DROP CONSTRAINT IF EXISTS city_structures_owner_shape_check,
  DROP CONSTRAINT IF EXISTS city_structures_civic_tier_check;

ALTER TABLE city_structures
  ADD CONSTRAINT city_structures_structure_type_check CHECK (
    structure_type IN (
      'city_house', 'mayor_house', 'oil_well', 'warehouse', 'cistern_warrens',
      'market', 'monument', 'weaponsmith', 'armory'
    )
  ),
  ADD CONSTRAINT city_structures_owner_shape_check CHECK (
    (
      structure_type IN ('city_house', 'mayor_house', 'oil_well')
      AND owner_player_id IS NOT NULL
    )
    OR (
      structure_type IN (
        'warehouse', 'cistern_warrens', 'market', 'monument', 'weaponsmith', 'armory'
      )
      AND owner_player_id IS NULL
    )
  ),
  ADD CONSTRAINT city_structures_civic_tier_check CHECK (
    (structure_type IN ('market', 'oil_well', 'cistern_warrens') AND tier = 1)
    OR (structure_type = 'monument' AND tier BETWEEN 1 AND 3)
    OR structure_type NOT IN ('market', 'oil_well', 'cistern_warrens', 'monument')
  );

CREATE UNIQUE INDEX city_structures_one_reserved_sewer_per_city_idx
  ON city_structures (city_id)
  WHERE structure_type = 'cistern_warrens' AND state IN ('constructing', 'active');

CREATE TABLE cistern_warrens_presence (
  player_id text PRIMARY KEY REFERENCES players(id) ON DELETE RESTRICT,
  sewer_structure_id uuid NOT NULL
    REFERENCES city_structures(structure_id) ON DELETE RESTRICT,
  session_id uuid NOT NULL UNIQUE,
  local_x double precision NOT NULL CHECK (local_x BETWEEN 0 AND 160),
  local_y double precision NOT NULL CHECK (local_y BETWEEN 0 AND 160),
  return_region_code text NOT NULL,
  return_lat double precision NOT NULL CHECK (return_lat BETWEEN -90 AND 90),
  return_lon double precision NOT NULL CHECK (return_lon BETWEEN -180 AND 180),
  entered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX cistern_warrens_presence_sewer_idx
  ON cistern_warrens_presence (sewer_structure_id);

CREATE TABLE cistern_warrens_encounters (
  sewer_structure_id uuid NOT NULL
    REFERENCES city_structures(structure_id) ON DELETE RESTRICT,
  encounter_id text NOT NULL,
  defeated_at timestamptz NOT NULL,
  respawn_at timestamptz NOT NULL CHECK (respawn_at > defeated_at),
  PRIMARY KEY (sewer_structure_id, encounter_id)
);
