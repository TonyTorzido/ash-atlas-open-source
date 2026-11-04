CREATE TABLE telemetry.bug_reports (
  report_id uuid PRIMARY KEY,
  public_report_code text NOT NULL UNIQUE CHECK (
    public_report_code ~ '^AA-[A-Z0-9]{6}$'
  ),
  request_id uuid NOT NULL,
  telemetry_schema_version smallint NOT NULL CHECK (
    telemetry_schema_version = 1
  ),
  bug_report_schema_version smallint NOT NULL CHECK (
    bug_report_schema_version = 1
  ),
  run_id uuid NOT NULL REFERENCES telemetry.test_runs(run_id) ON DELETE RESTRICT,
  campaign_id uuid NULL,
  segment_id uuid NULL,
  related_segment_ids uuid[] NOT NULL DEFAULT '{}',
  release_sha text NOT NULL CHECK (release_sha ~ '^[a-f0-9]{40}$'),
  release_generation text NULL,
  world_release_id text NOT NULL,
  population_plan_version text NOT NULL,
  population_spawn_rules_version text NOT NULL,
  balance_version text NOT NULL,
  server_instance_id text NOT NULL,
  player_id text NOT NULL,
  session_id uuid NOT NULL,
  connection_generation integer NOT NULL CHECK (connection_generation >= 0),
  report_marker_at timestamptz NOT NULL,
  available_window_start_at timestamptz NOT NULL,
  window_start_at timestamptz NOT NULL,
  window_end_at timestamptz NOT NULL,
  submitted_at timestamptz NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 80),
  category text NOT NULL CHECK (
    category IN (
      'gameplay', 'movement_travel', 'combat', 'inventory_items',
      'territory_building', 'ui', 'connection_performance', 'other'
    )
  ),
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 2000),
  expected_behavior text NOT NULL DEFAULT '' CHECK (
    length(expected_behavior) <= 1000
  ),
  reproducibility text NOT NULL CHECK (
    reproducibility IN ('once', 'sometimes', 'every_time', 'not_sure')
  ),
  status text NOT NULL DEFAULT 'new' CHECK (
    status IN (
      'new', 'triaged', 'investigating', 'resolved', 'duplicate',
      'cannot_reproduce'
    )
  ),
  duplicate_of_report_id uuid NULL REFERENCES telemetry.bug_reports(report_id)
    ON DELETE RESTRICT,
  export_status text NOT NULL DEFAULT 'pending' CHECK (
    export_status IN ('pending', 'exported', 'acknowledged', 'failed')
  ),
  exported_at timestamptz NULL,
  acknowledged_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (player_id, request_id),
  CHECK (window_end_at = report_marker_at),
  CHECK (window_start_at <= available_window_start_at),
  CHECK (available_window_start_at <= window_end_at),
  CHECK (window_end_at - window_start_at <= interval '5 minutes'),
  CHECK (
    (status = 'duplicate' AND duplicate_of_report_id IS NOT NULL)
    OR (status <> 'duplicate' AND duplicate_of_report_id IS NULL)
  ),
  CHECK (
    (export_status = 'pending' AND exported_at IS NULL AND acknowledged_at IS NULL)
    OR (
      export_status IN ('exported', 'failed')
      AND acknowledged_at IS NULL
    )
    OR (
      export_status = 'acknowledged'
      AND exported_at IS NOT NULL
      AND acknowledged_at IS NOT NULL
    )
  )
);

CREATE INDEX telemetry_bug_reports_submitted_at_idx
  ON telemetry.bug_reports (submitted_at DESC);
CREATE INDEX telemetry_bug_reports_status_submitted_idx
  ON telemetry.bug_reports (status, submitted_at DESC);
CREATE INDEX telemetry_bug_reports_run_idx
  ON telemetry.bug_reports (run_id, submitted_at);
CREATE INDEX telemetry_bug_reports_related_segments_idx
  ON telemetry.bug_reports USING gin (related_segment_ids);

CREATE TABLE telemetry.bug_report_context (
  report_id uuid PRIMARY KEY REFERENCES telemetry.bug_reports(report_id)
    ON DELETE RESTRICT,
  context_schema_version smallint NOT NULL CHECK (context_schema_version = 1),
  client_state jsonb NOT NULL,
  authoritative_player_state jsonb NOT NULL,
  nearby_entities jsonb NOT NULL,
  recent_client_actions jsonb NOT NULL,
  recent_client_errors jsonb NOT NULL,
  network_timeline jsonb NOT NULL,
  performance_history jsonb NOT NULL,
  related_operation_ids text[] NOT NULL DEFAULT '{}',
  related_event_ids uuid[] NOT NULL DEFAULT '{}',
  uncompressed_bytes integer NOT NULL CHECK (
    uncompressed_bytes BETWEEN 2 AND 2000000
  ),
  compressed_bytes integer NOT NULL CHECK (
    compressed_bytes BETWEEN 2 AND 500000
  ),
  content_checksum text NOT NULL CHECK (content_checksum ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (jsonb_typeof(client_state) = 'object'),
  CHECK (jsonb_typeof(authoritative_player_state) = 'object'),
  CHECK (jsonb_typeof(nearby_entities) = 'array'),
  CHECK (jsonb_array_length(nearby_entities) <= 200),
  CHECK (jsonb_typeof(recent_client_actions) = 'array'),
  CHECK (jsonb_array_length(recent_client_actions) <= 800),
  CHECK (jsonb_typeof(recent_client_errors) = 'array'),
  CHECK (jsonb_array_length(recent_client_errors) <= 200),
  CHECK (jsonb_typeof(network_timeline) = 'array'),
  CHECK (jsonb_array_length(network_timeline) <= 400),
  CHECK (jsonb_typeof(performance_history) = 'array'),
  CHECK (jsonb_array_length(performance_history) <= 200),
  CHECK (cardinality(related_operation_ids) <= 256),
  CHECK (cardinality(related_event_ids) <= 256)
);

COMMENT ON TABLE telemetry.bug_reports IS
  'Private authenticated player bug reports correlated with closed-test telemetry.';
COMMENT ON TABLE telemetry.bug_report_context IS
  'Bounded report-only diagnostic context; excludes chat, credentials, raw packets, and GPS.';
