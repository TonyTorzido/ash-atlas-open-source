CREATE OR REPLACE FUNCTION telemetry.ensure_runtime_hourly_segment(
  p_next_run_id uuid,
  p_next_segment_id uuid,
  p_release_sha text,
  p_release_generation text,
  p_world_release_id text,
  p_population_plan_version text,
  p_population_spawn_rules_version text,
  p_balance_version text,
  p_server_instance_id text,
  p_segment_duration_seconds integer
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
  balance_version text,
  activation_action text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, telemetry
AS $function$
DECLARE
  current_run telemetry.test_runs%ROWTYPE;
  boundary_start timestamptz;
  boundary_end timestamptz;
BEGIN
  IF p_segment_duration_seconds < 60
     OR p_segment_duration_seconds > 86400 THEN
    RAISE EXCEPTION 'telemetry segment duration is outside the allowed range';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('ash-atlas-hourly-telemetry-segment'));

  SELECT *
  INTO current_run
  FROM telemetry.test_runs
  WHERE status = 'active'
  ORDER BY started_at DESC
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND OR current_run.segment_id IS NULL THEN
    RETURN;
  END IF;

  IF current_run.segment_end_at > clock_timestamp()
     AND current_run.segment_duration_seconds = p_segment_duration_seconds
     AND current_run.release_sha = p_release_sha
     AND current_run.release_generation IS NOT DISTINCT FROM p_release_generation
     AND current_run.world_release_id = p_world_release_id
     AND current_run.population_plan_version = p_population_plan_version
     AND current_run.population_spawn_rules_version =
       p_population_spawn_rules_version
     AND current_run.balance_version = p_balance_version THEN
    RETURN QUERY
    SELECT current_run.run_id, current_run.segment_id, current_run.campaign_id,
           current_run.segment_sequence, current_run.segment_start_at,
           current_run.segment_end_at, current_run.release_sha,
           current_run.release_generation, current_run.world_release_id,
           current_run.population_plan_version,
           current_run.population_spawn_rules_version,
           current_run.balance_version, 'retained'::text;
    RETURN;
  END IF;

  UPDATE telemetry.test_runs
  SET status = 'frozen',
      ended_at = LEAST(clock_timestamp(), current_run.segment_end_at),
      ingestion_closed_at = clock_timestamp(),
      updated_at = clock_timestamp()
  WHERE telemetry.test_runs.run_id = current_run.run_id
    AND status = 'active';

  boundary_start := to_timestamp(
    floor(extract(epoch FROM clock_timestamp()) / p_segment_duration_seconds)
      * p_segment_duration_seconds
  );
  boundary_end := boundary_start
    + make_interval(secs => p_segment_duration_seconds);

  INSERT INTO telemetry.test_runs (
    run_id, telemetry_schema_version, run_name, started_at, status,
    release_sha, release_generation, world_release_id,
    population_plan_version, population_spawn_rules_version,
    population_candidate_layout_version, permanent_stone_placement_version,
    balance_version, server_instance_id, capacity_configuration, notes,
    reset_wipe_marker, segment_id, campaign_id, segment_sequence,
    segment_start_at, segment_end_at, segment_duration_seconds
  ) VALUES (
    p_next_run_id, current_run.telemetry_schema_version, current_run.run_name,
    clock_timestamp(), 'active', p_release_sha, p_release_generation,
    p_world_release_id, p_population_plan_version,
    p_population_spawn_rules_version,
    current_run.population_candidate_layout_version,
    current_run.permanent_stone_placement_version, p_balance_version,
    p_server_instance_id, current_run.capacity_configuration,
    current_run.notes, false, p_next_segment_id, current_run.campaign_id,
    current_run.segment_sequence + 1, boundary_start, boundary_end,
    p_segment_duration_seconds
  );

  RETURN QUERY
  SELECT next_run.run_id, next_run.segment_id, next_run.campaign_id,
         next_run.segment_sequence, next_run.segment_start_at,
         next_run.segment_end_at, next_run.release_sha,
         next_run.release_generation, next_run.world_release_id,
         next_run.population_plan_version,
         next_run.population_spawn_rules_version, next_run.balance_version,
         'created'::text
  FROM telemetry.test_runs AS next_run
  WHERE next_run.run_id = p_next_run_id;
END
$function$;

REVOKE ALL ON FUNCTION telemetry.ensure_runtime_hourly_segment(
  uuid, uuid, text, text, text, text, text, text, text, integer
) FROM PUBLIC;

DO $grant$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'ash_atlas_telemetry_writer'
  ) THEN
    GRANT EXECUTE ON FUNCTION telemetry.ensure_runtime_hourly_segment(
      uuid, uuid, text, text, text, text, text, text, text, integer
    ) TO ash_atlas_telemetry_writer;
  END IF;
END
$grant$;

COMMENT ON FUNCTION telemetry.ensure_runtime_hourly_segment(
  uuid, uuid, text, text, text, text, text, text, text, integer
) IS
  'Atomically replaces an expired or runtime-mismatched active hourly segment while preserving its campaign and captured rows.';
