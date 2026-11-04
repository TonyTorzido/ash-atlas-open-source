ALTER TABLE telemetry.test_runs
  ADD COLUMN segment_id uuid NULL,
  ADD COLUMN campaign_id uuid NULL,
  ADD COLUMN segment_sequence bigint NULL,
  ADD COLUMN segment_start_at timestamptz NULL,
  ADD COLUMN segment_end_at timestamptz NULL,
  ADD COLUMN segment_duration_seconds integer NULL,
  ADD COLUMN retention_status text NOT NULL DEFAULT 'retained' CHECK (
    retention_status IN ('retained', 'deleted')
  ),
  ADD COLUMN retention_deleted_at timestamptz NULL,
  ADD CONSTRAINT telemetry_test_runs_segment_shape CHECK (
    (
      segment_id IS NULL
      AND campaign_id IS NULL
      AND segment_sequence IS NULL
      AND segment_start_at IS NULL
      AND segment_end_at IS NULL
      AND segment_duration_seconds IS NULL
    )
    OR (
      segment_id IS NOT NULL
      AND campaign_id IS NOT NULL
      AND segment_sequence IS NOT NULL
      AND segment_sequence >= 0
      AND segment_start_at IS NOT NULL
      AND segment_end_at IS NOT NULL
      AND segment_end_at > segment_start_at
      AND segment_duration_seconds BETWEEN 60 AND 86400
    )
  ),
  ADD CONSTRAINT telemetry_test_runs_retention_deleted_shape CHECK (
    (retention_status = 'retained' AND retention_deleted_at IS NULL)
    OR (retention_status = 'deleted' AND retention_deleted_at IS NOT NULL)
  );

CREATE UNIQUE INDEX telemetry_test_runs_segment_id_idx
  ON telemetry.test_runs (segment_id)
  WHERE segment_id IS NOT NULL;
CREATE UNIQUE INDEX telemetry_test_runs_campaign_sequence_idx
  ON telemetry.test_runs (campaign_id, segment_sequence)
  WHERE campaign_id IS NOT NULL;
CREATE INDEX telemetry_test_runs_segment_retention_idx
  ON telemetry.test_runs (segment_end_at, status, retention_status)
  WHERE segment_id IS NOT NULL;

ALTER TABLE telemetry.export_receipts
  ADD COLUMN manifest_version integer NULL CHECK (
    manifest_version IS NULL OR manifest_version > 0
  ),
  ADD COLUMN ready_manifest_path text NULL CHECK (
    ready_manifest_path IS NULL
    OR (
      ready_manifest_path LIKE '/var/lib/ash-atlas/telemetry-exports/%'
      AND ready_manifest_path LIKE '%.ready.json'
    )
  ),
  ADD COLUMN exporter_version text NULL CHECK (
    exporter_version IS NULL OR length(exporter_version) BETWEEN 1 AND 80
  ),
  ADD COLUMN pseudonymization_key_id text NULL CHECK (
    pseudonymization_key_id IS NULL
    OR length(pseudonymization_key_id) BETWEEN 1 AND 80
  );

CREATE TABLE telemetry.segment_acknowledgments (
  acknowledgment_id uuid PRIMARY KEY,
  telemetry_schema_version smallint NOT NULL CHECK (telemetry_schema_version = 1),
  manifest_version integer NOT NULL CHECK (manifest_version > 0),
  segment_id uuid NOT NULL,
  run_id uuid NOT NULL REFERENCES telemetry.test_runs(run_id) ON DELETE RESTRICT,
  artifact_sha256 text NOT NULL CHECK (artifact_sha256 ~ '^[a-f0-9]{64}$'),
  acknowledged_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (segment_id),
  UNIQUE (run_id)
);

CREATE TABLE telemetry.segment_retention_receipts (
  receipt_id uuid PRIMARY KEY,
  telemetry_schema_version smallint NOT NULL CHECK (telemetry_schema_version = 1),
  segment_id uuid NOT NULL,
  run_id uuid NOT NULL REFERENCES telemetry.test_runs(run_id) ON DELETE RESTRICT,
  acknowledged boolean NOT NULL,
  deleted_row_counts jsonb NOT NULL,
  deleted_artifact_bytes bigint NOT NULL CHECK (deleted_artifact_bytes >= 0),
  deletion_reason text NOT NULL CHECK (
    deletion_reason IN (
      'acknowledged', 'completed_segment_limit', 'hard_age_limit',
      'emergency_byte_cap'
    )
  ),
  archival_data_lost boolean NOT NULL,
  cleaned_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (run_id)
);

CREATE OR REPLACE FUNCTION telemetry.rotate_hourly_segment(
  p_run_id uuid,
  p_boundary timestamptz,
  p_next_run_id uuid,
  p_next_segment_id uuid
)
RETURNS TABLE (
  run_id uuid,
  segment_id uuid,
  campaign_id uuid,
  segment_sequence bigint,
  segment_start_at timestamptz,
  segment_end_at timestamptz,
  release_sha text,
  release_generation text,
  world_release_id text,
  population_plan_version text,
  population_spawn_rules_version text,
  balance_version text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, telemetry
AS $function$
DECLARE
  previous_run telemetry.test_runs%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('ash-atlas-hourly-telemetry-segment'));

  SELECT *
  INTO previous_run
  FROM telemetry.test_runs
  WHERE telemetry.test_runs.run_id = p_run_id
  FOR UPDATE;

  IF NOT FOUND OR previous_run.segment_id IS NULL THEN
    RAISE EXCEPTION 'run is not an hourly telemetry segment';
  END IF;

  IF previous_run.status <> 'active' THEN
    RETURN QUERY
    SELECT next_run.run_id, next_run.segment_id, next_run.campaign_id,
           next_run.segment_sequence, next_run.segment_start_at,
           next_run.segment_end_at, next_run.release_sha,
           next_run.release_generation, next_run.world_release_id,
           next_run.population_plan_version,
           next_run.population_spawn_rules_version, next_run.balance_version
    FROM telemetry.test_runs AS next_run
    WHERE next_run.campaign_id = previous_run.campaign_id
      AND next_run.segment_sequence = previous_run.segment_sequence + 1
      AND next_run.status = 'active';
    IF FOUND THEN RETURN; END IF;
    RAISE EXCEPTION 'hourly telemetry segment is no longer active';
  END IF;

  IF p_boundary <> previous_run.segment_end_at THEN
    RAISE EXCEPTION 'rotation boundary does not match the scheduled segment end';
  END IF;

  UPDATE telemetry.test_runs
  SET status = 'frozen',
      ended_at = p_boundary,
      ingestion_closed_at = clock_timestamp(),
      updated_at = clock_timestamp()
  WHERE telemetry.test_runs.run_id = p_run_id;

  INSERT INTO telemetry.test_runs (
    run_id, telemetry_schema_version, run_name, started_at, status,
    release_sha, release_generation, world_release_id,
    population_plan_version, population_spawn_rules_version,
    population_candidate_layout_version, permanent_stone_placement_version,
    balance_version, server_instance_id, capacity_configuration, notes,
    reset_wipe_marker, segment_id, campaign_id, segment_sequence,
    segment_start_at, segment_end_at, segment_duration_seconds
  ) VALUES (
    p_next_run_id, previous_run.telemetry_schema_version, previous_run.run_name,
    p_boundary, 'active', previous_run.release_sha,
    previous_run.release_generation, previous_run.world_release_id,
    previous_run.population_plan_version,
    previous_run.population_spawn_rules_version,
    previous_run.population_candidate_layout_version,
    previous_run.permanent_stone_placement_version,
    previous_run.balance_version, previous_run.server_instance_id,
    previous_run.capacity_configuration, previous_run.notes, false,
    p_next_segment_id, previous_run.campaign_id,
    previous_run.segment_sequence + 1, p_boundary,
    p_boundary + make_interval(secs => previous_run.segment_duration_seconds),
    previous_run.segment_duration_seconds
  );

  RETURN QUERY
  SELECT next_run.run_id, next_run.segment_id, next_run.campaign_id,
         next_run.segment_sequence, next_run.segment_start_at,
         next_run.segment_end_at, next_run.release_sha,
         next_run.release_generation, next_run.world_release_id,
         next_run.population_plan_version,
         next_run.population_spawn_rules_version, next_run.balance_version
  FROM telemetry.test_runs AS next_run
  WHERE next_run.run_id = p_next_run_id;
END
$function$;

REVOKE ALL ON FUNCTION telemetry.rotate_hourly_segment(
  uuid, timestamptz, uuid, uuid
) FROM PUBLIC;

COMMENT ON FUNCTION telemetry.rotate_hourly_segment(
  uuid, timestamptz, uuid, uuid
) IS
  'Atomically closes one drained hourly segment and starts its successor.';
