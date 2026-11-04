CREATE TABLE world_environment_cells (
  world_identity_key text NOT NULL CHECK (world_identity_key ~ '^[a-f0-9]{64}$'),
  release_id text NOT NULL CHECK (release_id <> ''),
  profile_set_fingerprint text NOT NULL CHECK (profile_set_fingerprint ~ '^[a-f0-9]{64}$'),
  build_contract_fingerprint text NOT NULL CHECK (build_contract_fingerprint ~ '^[a-f0-9]{64}$'),
  boundary_release_id text NOT NULL CHECK (boundary_release_id <> ''),
  profile_version text NOT NULL CHECK (profile_version <> ''),
  candidate_slot_version text NOT NULL CHECK (candidate_slot_version <> ''),
  source_runtime_sha text NOT NULL CHECK (source_runtime_sha <> ''),
  cell_id text NOT NULL CHECK (cell_id <> ''),
  region_code text NOT NULL CHECK (region_code <> ''),
  center_lat double precision NOT NULL CHECK (center_lat BETWEEN -90 AND 90),
  center_lon double precision NOT NULL CHECK (center_lon BETWEEN -180 AND 180),
  center_geom geometry(Point, 4326) NOT NULL,
  package_id text NULL,
  country_id text NULL,
  country_name text NULL,
  region_id text NULL,
  region_name text NULL,
  settlement_id text NULL,
  settlement_name text NULL,
  biome_id text NULL,
  biome_name text NULL,
  ecoregion_id text NULL,
  ecoregion_name text NULL,
  land_cover_class text NULL,
  terrain_class text NULL,
  elevation_m double precision NULL,
  elevation_band text NULL,
  is_land boolean NOT NULL,
  is_saltwater boolean NOT NULL,
  inside_major_lake boolean NOT NULL,
  is_coastal boolean NULL,
  spawn_profile_key text NOT NULL CHECK (spawn_profile_key <> ''),
  spawn_rules_version text NOT NULL CHECK (spawn_rules_version <> ''),
  environment_profile jsonb NOT NULL
    CHECK (jsonb_typeof(environment_profile) = 'object'),
  candidate_slots jsonb NOT NULL
    CHECK (
      CASE
        WHEN jsonb_typeof(candidate_slots) = 'array'
          THEN jsonb_array_length(candidate_slots) BETWEEN 96 AND 128
        ELSE false
      END
    ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (
    world_identity_key,
    profile_version,
    candidate_slot_version,
    cell_id
  )
);

CREATE INDEX world_environment_cells_region_idx
  ON world_environment_cells (region_code, cell_id);
CREATE INDEX world_environment_cells_package_idx
  ON world_environment_cells (package_id)
  WHERE package_id IS NOT NULL;
CREATE INDEX world_environment_cells_center_geom_idx
  ON world_environment_cells USING gist (center_geom);

CREATE FUNCTION reject_world_environment_cell_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'world environment profiles are immutable; write a new identity or profile version'
    USING ERRCODE = '23514',
          CONSTRAINT = 'world_environment_cells_immutable';
END;
$$;

CREATE TRIGGER world_environment_cells_reject_update
BEFORE UPDATE ON world_environment_cells
FOR EACH ROW EXECUTE FUNCTION reject_world_environment_cell_update();

COMMENT ON TABLE world_environment_cells IS
  'Immutable, release-keyed gameplay geography compiled once per stable spawn cell.';
COMMENT ON COLUMN world_environment_cells.source_runtime_sha IS
  'Runtime provenance only; excluded from durable World-data identity and uniqueness.';
COMMENT ON COLUMN world_environment_cells.candidate_slots IS
  'Reusable deterministic placement slots; normal population generations do not call World.';

CREATE TABLE world_environment_profile_jobs (
  job_key text PRIMARY KEY CHECK (job_key ~ '^[a-f0-9]{64}$'),
  world_identity_key text NOT NULL CHECK (world_identity_key ~ '^[a-f0-9]{64}$'),
  release_id text NOT NULL CHECK (release_id <> ''),
  profile_set_fingerprint text NOT NULL CHECK (profile_set_fingerprint ~ '^[a-f0-9]{64}$'),
  build_contract_fingerprint text NOT NULL CHECK (build_contract_fingerprint ~ '^[a-f0-9]{64}$'),
  boundary_release_id text NOT NULL CHECK (boundary_release_id <> ''),
  profile_version text NOT NULL CHECK (profile_version <> ''),
  candidate_slot_version text NOT NULL CHECK (candidate_slot_version <> ''),
  source_runtime_sha text NOT NULL CHECK (source_runtime_sha <> ''),
  cell_id text NOT NULL CHECK (cell_id <> ''),
  region_code text NOT NULL CHECK (region_code <> ''),
  center_lat double precision NOT NULL CHECK (center_lat BETWEEN -90 AND 90),
  center_lon double precision NOT NULL CHECK (center_lon BETWEEN -180 AND 180),
  reason text NOT NULL CHECK (reason <> ''),
  priority smallint NOT NULL CHECK (priority BETWEEN 0 AND 3),
  status text NOT NULL CHECK (
    status IN ('pending', 'leased', 'ready', 'retryable-failure', 'terminal-failure')
  ),
  owner_id text NULL,
  owner_generation bigint NOT NULL DEFAULT 0 CHECK (owner_generation >= 0),
  lease_expires_at timestamptz NULL,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_retry_at timestamptz NULL,
  last_error text NULL,
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz NULL,
  completed_at timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (
    world_identity_key,
    profile_version,
    candidate_slot_version,
    cell_id
  ),
  CHECK (
    (status = 'leased' AND owner_id IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR
    (status <> 'leased' AND owner_id IS NULL AND lease_expires_at IS NULL)
  ),
  CHECK (
    (status IN ('pending', 'retryable-failure') AND next_retry_at IS NOT NULL)
    OR
    (status IN ('leased', 'ready', 'terminal-failure') AND next_retry_at IS NULL)
  ),
  CHECK (
    (status = 'ready' AND completed_at IS NOT NULL)
    OR
    (status <> 'ready' AND completed_at IS NULL)
  )
);

CREATE INDEX world_environment_profile_jobs_claim_idx
  ON world_environment_profile_jobs (priority, next_retry_at, requested_at, job_key)
  WHERE status IN ('pending', 'retryable-failure');
CREATE INDEX world_environment_profile_jobs_expired_lease_idx
  ON world_environment_profile_jobs (lease_expires_at)
  WHERE status = 'leased';
CREATE INDEX world_environment_profile_jobs_operational_metrics_idx
  ON world_environment_profile_jobs (status, requested_at, lease_expires_at)
  WHERE status <> 'ready';

DROP TRIGGER IF EXISTS world_environment_profile_jobs_set_updated_at
  ON world_environment_profile_jobs;
CREATE TRIGGER world_environment_profile_jobs_set_updated_at
BEFORE UPDATE ON world_environment_profile_jobs
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE world_environment_profile_jobs IS
  'Durable, deduplicated and generation-fenced leases for gameplay profile materialization.';

ALTER TABLE generated_world_mobs
  ADD COLUMN environment_world_identity_key text NULL,
  ADD COLUMN environment_profile_version text NULL,
  ADD COLUMN environment_candidate_slot_version text NULL,
  ADD COLUMN environment_cell_id text NULL,
  ADD COLUMN environment_slot_id text NULL,
  ADD COLUMN environment_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE generated_world_mobs
  ADD CONSTRAINT generated_world_mobs_environment_reference_complete
  CHECK (
    (
      environment_world_identity_key IS NULL
      AND environment_profile_version IS NULL
      AND environment_candidate_slot_version IS NULL
      AND environment_cell_id IS NULL
      AND environment_slot_id IS NULL
    )
    OR
    (
      environment_world_identity_key IS NOT NULL
      AND environment_profile_version IS NOT NULL
      AND environment_candidate_slot_version IS NOT NULL
      AND environment_cell_id IS NOT NULL
      AND environment_slot_id IS NOT NULL
    )
  ),
  ADD CONSTRAINT generated_world_mobs_environment_snapshot_object
    CHECK (jsonb_typeof(environment_snapshot) = 'object'),
  ADD CONSTRAINT generated_world_mobs_environment_cell_fk
    FOREIGN KEY (
      environment_world_identity_key,
      environment_profile_version,
      environment_candidate_slot_version,
      environment_cell_id
    )
    REFERENCES world_environment_cells (
      world_identity_key,
      profile_version,
      candidate_slot_version,
      cell_id
    )
    ON DELETE RESTRICT;

CREATE INDEX generated_world_mobs_environment_cell_idx
  ON generated_world_mobs (
    environment_world_identity_key,
    environment_profile_version,
    environment_candidate_slot_version,
    environment_cell_id
  )
  WHERE environment_world_identity_key IS NOT NULL;

ALTER TABLE environmental_population_events
  DROP CONSTRAINT IF EXISTS environmental_population_events_rolled_tree_count_check,
  DROP CONSTRAINT IF EXISTS environmental_population_events_actual_tree_count_check,
  ADD CONSTRAINT environmental_population_events_rolled_tree_count_check
    CHECK (rolled_tree_count BETWEEN 1 AND 9),
  ADD CONSTRAINT environmental_population_events_actual_tree_count_check
    CHECK (actual_tree_count BETWEEN 0 AND 9);

CREATE OR REPLACE FUNCTION protect_generated_world_mob()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.entity_id IS DISTINCT FROM OLD.entity_id OR
     NEW.encounter_id IS DISTINCT FROM OLD.encounter_id OR
     NEW.mob_archetype IS DISTINCT FROM OLD.mob_archetype OR
     NEW.pack_id IS DISTINCT FROM OLD.pack_id OR
     NEW.source_population_area_id IS DISTINCT FROM OLD.source_population_area_id OR
     NEW.source_generation IS DISTINCT FROM OLD.source_generation OR
     NEW.spawn_cell_id IS DISTINCT FROM OLD.spawn_cell_id OR
     NEW.region_code IS DISTINCT FROM OLD.region_code OR
     NEW.lat IS DISTINCT FROM OLD.lat OR NEW.lon IS DISTINCT FROM OLD.lon OR
     NEW.geom IS DISTINCT FROM OLD.geom OR
     NEW.anchor_lat IS DISTINCT FROM OLD.anchor_lat OR
     NEW.anchor_lon IS DISTINCT FROM OLD.anchor_lon OR
     NEW.placement_version IS DISTINCT FROM OLD.placement_version OR
     NEW.environment_world_identity_key IS DISTINCT FROM OLD.environment_world_identity_key OR
     NEW.environment_profile_version IS DISTINCT FROM OLD.environment_profile_version OR
     NEW.environment_candidate_slot_version IS DISTINCT FROM OLD.environment_candidate_slot_version OR
     NEW.environment_cell_id IS DISTINCT FROM OLD.environment_cell_id OR
     NEW.environment_slot_id IS DISTINCT FROM OLD.environment_slot_id OR
     NEW.environment_snapshot IS DISTINCT FROM OLD.environment_snapshot OR
     (OLD.killed_at IS NOT NULL AND NEW.killed_at IS NULL) OR
     (OLD.killed_by_player_id IS NOT NULL AND NEW.killed_by_player_id IS NULL)
  THEN
    RAISE EXCEPTION
      'generated world mob identity, encounter, placement, environment, ownership, and death are immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'generated_world_mobs_current_immutable';
  END IF;
  RETURN NEW;
END;
$$;
