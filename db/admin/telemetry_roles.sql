\set ON_ERROR_STOP on

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ash_atlas_telemetry_writer') THEN
    CREATE ROLE ash_atlas_telemetry_writer
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ash_atlas_telemetry_exporter') THEN
    CREATE ROLE ash_atlas_telemetry_exporter
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
END
$roles$;

REVOKE ALL ON SCHEMA public FROM ash_atlas_telemetry_writer;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ash_atlas_telemetry_writer;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ash_atlas_telemetry_writer;
REVOKE ALL ON SCHEMA public FROM ash_atlas_telemetry_exporter;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ash_atlas_telemetry_exporter;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ash_atlas_telemetry_exporter;

GRANT CONNECT ON DATABASE :"DBNAME" TO
  ash_atlas_telemetry_writer,
  ash_atlas_telemetry_exporter;

GRANT USAGE ON SCHEMA telemetry TO
  ash_atlas_telemetry_writer,
  ash_atlas_telemetry_exporter;

GRANT SELECT ON telemetry.test_runs TO ash_atlas_telemetry_writer;
GRANT UPDATE (ingestion_closed_at, updated_at) ON telemetry.test_runs
  TO ash_atlas_telemetry_writer;
GRANT INSERT ON
  telemetry.server_samples,
  telemetry.world_samples,
  telemetry.gameplay_events,
  telemetry.player_snapshots,
  telemetry.player_inventory_snapshots,
  telemetry.client_samples,
  telemetry.session_summaries
TO ash_atlas_telemetry_writer;
GRANT SELECT, INSERT ON
  telemetry.bug_reports,
  telemetry.bug_report_context
TO ash_atlas_telemetry_writer;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA telemetry
  TO ash_atlas_telemetry_writer;
GRANT SELECT, INSERT, UPDATE ON telemetry.telemetry_health
  TO ash_atlas_telemetry_writer;
GRANT EXECUTE ON FUNCTION telemetry.rotate_hourly_segment(
  uuid, timestamptz, uuid, uuid
) TO ash_atlas_telemetry_writer;
GRANT EXECUTE ON FUNCTION telemetry.ensure_runtime_hourly_segment(
  uuid, uuid, text, text, text, text, text, text, text, integer
) TO ash_atlas_telemetry_writer;

GRANT SELECT ON ALL TABLES IN SCHEMA telemetry
  TO ash_atlas_telemetry_exporter;

ALTER DEFAULT PRIVILEGES IN SCHEMA telemetry
  REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA telemetry
  REVOKE ALL ON SEQUENCES FROM PUBLIC;

-- Provision separate LOGIN roles outside this file so no password enters Git:
--
--   CREATE ROLE ash_atlas_telemetry_ingest LOGIN PASSWORD '<secret>'
--     IN ROLE ash_atlas_telemetry_writer;
--   CREATE ROLE ash_atlas_telemetry_export LOGIN PASSWORD '<different-secret>'
--     IN ROLE ash_atlas_telemetry_exporter;
--
-- Store each connection URL in a root-readable service EnvironmentFile (0600).
