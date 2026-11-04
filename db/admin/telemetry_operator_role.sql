\set ON_ERROR_STOP on

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ash_atlas_telemetry_operator') THEN
    CREATE ROLE ash_atlas_telemetry_operator
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
END
$roles$;

REVOKE ALL ON SCHEMA public FROM ash_atlas_telemetry_operator;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ash_atlas_telemetry_operator;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ash_atlas_telemetry_operator;

GRANT CONNECT ON DATABASE :"DBNAME" TO ash_atlas_telemetry_operator;
GRANT USAGE ON SCHEMA telemetry TO ash_atlas_telemetry_operator;
GRANT SELECT, INSERT, UPDATE ON telemetry.test_runs
  TO ash_atlas_telemetry_operator;
GRANT SELECT ON telemetry.telemetry_health
  TO ash_atlas_telemetry_operator;
GRANT SELECT, INSERT ON telemetry.export_receipts
  TO ash_atlas_telemetry_operator;
GRANT SELECT, INSERT ON telemetry.cleanup_receipts
  TO ash_atlas_telemetry_operator;
GRANT SELECT, INSERT ON
  telemetry.segment_acknowledgments,
  telemetry.segment_retention_receipts
TO ash_atlas_telemetry_operator;
GRANT SELECT, UPDATE ON telemetry.bug_reports
  TO ash_atlas_telemetry_operator;
GRANT SELECT ON telemetry.bug_report_context
  TO ash_atlas_telemetry_operator;
GRANT SELECT, DELETE ON
  telemetry.server_samples,
  telemetry.world_samples,
  telemetry.gameplay_events,
  telemetry.player_snapshots,
  telemetry.player_inventory_snapshots,
  telemetry.client_samples,
  telemetry.session_summaries
TO ash_atlas_telemetry_operator;

-- Provision a separate LOGIN role outside Git:
--   CREATE ROLE ash_atlas_telemetry_ops LOGIN PASSWORD '<secret>'
--     IN ROLE ash_atlas_telemetry_operator;
