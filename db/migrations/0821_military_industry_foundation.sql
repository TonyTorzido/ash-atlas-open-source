-- Military Industry Foundation: personal Lodge, strategic personnel, and
-- City-owned production jobs. This migration intentionally adds no warfare,
-- deployed-engine, ammunition, or Black Powder state.

ALTER TABLE city_structures
  DROP CONSTRAINT IF EXISTS city_structures_check,
  DROP CONSTRAINT IF EXISTS city_structures_structure_type_check,
  DROP CONSTRAINT IF EXISTS city_structures_owner_check,
  DROP CONSTRAINT IF EXISTS city_structures_owner_shape_check,
  DROP CONSTRAINT IF EXISTS city_structures_civic_tier_check;

ALTER TABLE city_structures
  ADD CONSTRAINT city_structures_structure_type_check CHECK (
    structure_type IN (
      'city_house', 'mayor_house', 'oil_well', 'warehouse', 'cistern_warrens',
      'salon', 'city_kennel', 'market', 'monument', 'weaponsmith', 'armory',
      'barracks', 'siege_workshop', 'powder_works'
    )
  ),
  ADD CONSTRAINT city_structures_owner_shape_check CHECK (
    (structure_type IN ('city_house', 'mayor_house', 'oil_well') AND owner_player_id IS NOT NULL)
    OR
    (structure_type IN (
      'warehouse', 'cistern_warrens', 'salon', 'city_kennel', 'market', 'monument',
      'weaponsmith', 'armory', 'barracks', 'siege_workshop', 'powder_works'
    ) AND owner_player_id IS NULL)
  );

ALTER TABLE city_structures
  ADD CONSTRAINT city_structures_civic_tier_check CHECK (
    (structure_type IN ('market', 'oil_well', 'cistern_warrens', 'salon', 'city_kennel',
      'barracks', 'armory', 'siege_workshop', 'powder_works') AND tier = 1)
    OR (structure_type = 'monument' AND tier BETWEEN 1 AND 3)
    OR structure_type NOT IN ('market', 'oil_well', 'cistern_warrens', 'salon', 'city_kennel',
      'barracks', 'armory', 'siege_workshop', 'powder_works', 'monument')
  );

DROP INDEX IF EXISTS city_structures_one_reserved_facility_type_idx;
CREATE UNIQUE INDEX IF NOT EXISTS city_structures_one_reserved_facility_type_idx
  ON city_structures (city_id, structure_type)
  WHERE state IN ('constructing', 'active')
    AND structure_type IN (
      'warehouse', 'cistern_warrens', 'salon', 'city_kennel', 'armory',
      'weaponsmith', 'barracks', 'siege_workshop', 'powder_works'
    );

CREATE TABLE IF NOT EXISTS player_lodges (
  lodge_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  world_id text NOT NULL,
  region_code text NOT NULL,
  lat double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lon double precision NOT NULL CHECK (lon BETWEEN -180 AND 180),
  geom geometry(Point,4326) NOT NULL,
  footprint_geom geometry(Polygon,4326) NOT NULL,
  footprint_radius_m double precision NOT NULL CHECK (footprint_radius_m > 0),
  level smallint NOT NULL DEFAULT 1 CHECK (level BETWEEN 1 AND 5),
  reserved_capacity integer NOT NULL DEFAULT 0 CHECK (reserved_capacity >= 0),
  placement_revision bigint NOT NULL DEFAULT 1 CHECK (placement_revision > 0),
  built_at timestamptz NOT NULL DEFAULT now(),
  upgraded_at timestamptz NULL,
  removed_at timestamptz NULL,
  removal_reason text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS player_lodges_active_owner_idx
  ON player_lodges(owner_player_id) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS player_lodges_world_geom_idx
  ON player_lodges USING gist(geom);
CREATE INDEX IF NOT EXISTS player_lodges_footprint_geom_idx
  ON player_lodges USING gist(footprint_geom);

CREATE TABLE IF NOT EXISTS military_lodge_operations (
  operation_key text PRIMARY KEY,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  action text NOT NULL CHECK (action IN ('build','upgrade','destroy')),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  lodge_id uuid NULL REFERENCES player_lodges(lodge_id) ON DELETE RESTRICT,
  result jsonb NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NULL,
  UNIQUE(player_id,request_id),
  CHECK ((completed_at IS NULL) = (result IS NULL))
);

CREATE TABLE IF NOT EXISTS military_personnel (
  personnel_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  personnel_type text NOT NULL CHECK (personnel_type IN ('siege_crew')),
  capacity_cost smallint NOT NULL CHECK (capacity_cost = 2),
  status text NOT NULL CHECK (status IN ('training','available','assigned','recovering')),
  created_at timestamptz NOT NULL DEFAULT now(),
  assignment_reference text NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  training_job_id uuid NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS military_personnel_owner_status_idx
  ON military_personnel(owner_player_id,status,created_at,personnel_id);
CREATE UNIQUE INDEX IF NOT EXISTS military_personnel_training_job_idx
  ON military_personnel(training_job_id) WHERE training_job_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS military_facility_jobs (
  job_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_structure_id uuid NOT NULL REFERENCES city_structures(structure_id) ON DELETE RESTRICT,
  owner_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  job_type text NOT NULL CHECK (job_type IN (
    'train_siege_crew','repair_kit_batch','torch_batch','field_ballista_kit'
  )),
  quantity integer NOT NULL CHECK (quantity > 0),
  output_quantity integer NOT NULL CHECK (output_quantity >= 0),
  collected_quantity integer NOT NULL DEFAULT 0 CHECK (collected_quantity >= 0),
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  started_at timestamptz NOT NULL,
  completes_at timestamptz NOT NULL,
  cleared_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (completes_at > started_at),
  CHECK (collected_quantity <= output_quantity),
  UNIQUE(owner_player_id,request_id)
);
CREATE INDEX IF NOT EXISTS military_facility_jobs_queue_idx
  ON military_facility_jobs(facility_structure_id,started_at,created_at,job_id)
  WHERE cleared_at IS NULL;
CREATE INDEX IF NOT EXISTS military_facility_jobs_due_idx
  ON military_facility_jobs(completes_at,job_id) WHERE cleared_at IS NULL;
CREATE INDEX IF NOT EXISTS military_facility_jobs_owner_idx
  ON military_facility_jobs(owner_player_id,started_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'military_personnel_training_job_fk'
  ) THEN
    ALTER TABLE military_personnel
      ADD CONSTRAINT military_personnel_training_job_fk
      FOREIGN KEY (training_job_id) REFERENCES military_facility_jobs(job_id)
      ON DELETE RESTRICT;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS military_job_operations (
  operation_key text PRIMARY KEY,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  action text NOT NULL CHECK (action IN ('collect')),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  job_id uuid NOT NULL REFERENCES military_facility_jobs(job_id) ON DELETE RESTRICT,
  result jsonb NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NULL,
  UNIQUE(player_id,request_id),
  CHECK ((completed_at IS NULL) = (result IS NULL))
);

COMMENT ON TABLE military_personnel IS
  'Strategic player roster units; no world NPC simulation or inventory representation.';
COMMENT ON TABLE military_facility_jobs IS
  'Personal, replay-safe jobs on shared City military facilities.';
