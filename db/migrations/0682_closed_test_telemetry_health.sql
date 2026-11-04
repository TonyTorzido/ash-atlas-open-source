ALTER TABLE telemetry.server_samples
  ADD COLUMN host_load_1m double precision NULL CHECK (host_load_1m >= 0),
  ADD COLUMN host_load_5m double precision NULL CHECK (host_load_5m >= 0),
  ADD COLUMN host_load_15m double precision NULL CHECK (host_load_15m >= 0),
  ADD COLUMN process_pid integer NULL CHECK (process_pid > 0),
  ADD COLUMN process_cpu_percent double precision NULL CHECK (
    process_cpu_percent >= 0
  );

ALTER TABLE telemetry.telemetry_health
  ADD COLUMN rows_dropped_by_event_type jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE telemetry.test_runs
  ADD COLUMN ingestion_closed_at timestamptz NULL,
  ADD CONSTRAINT telemetry_test_runs_ingestion_closed_status CHECK (
    ingestion_closed_at IS NULL OR status IN ('frozen', 'exported', 'failed')
  );

DROP INDEX telemetry.telemetry_inventory_snapshot_revision_reason_idx;
CREATE INDEX telemetry_inventory_snapshot_revision_time_idx
  ON telemetry.player_inventory_snapshots (
    run_id, player_id, inventory_revision, recorded_at
  );

ALTER TABLE combat_balance_summaries
  DROP CONSTRAINT IF EXISTS combat_balance_summaries_schema_version_check,
  ADD CONSTRAINT combat_balance_summaries_schema_version_check
    CHECK (schema_version IN (1, 2, 3));

CREATE VIEW telemetry.authoritative_combat_summaries AS
SELECT
  combat_session_id,
  player_id,
  schema_version,
  active_class_id,
  active_subclass_id,
  active_class_level,
  warrior_level,
  started_at,
  ended_at,
  duration_ms,
  initial_enemy_queue_size,
  maximum_enemy_queue_size,
  player_survived,
  enemies_defeated,
  combat_end_reason,
  payload_sha256,
  summary - ARRAY['playerId', 'combatSessionId'] AS summary,
  action_trace,
  created_at
FROM public.combat_balance_summaries;

COMMENT ON VIEW telemetry.authoritative_combat_summaries IS
  'Bounded authoritative combat summaries with duplicate player identity removed from JSON.';

CREATE OR REPLACE VIEW telemetry.authoritative_progression_events AS
SELECT
  operation_id::text AS operation_id,
  player_id,
  event_type,
  created_at AS event_time,
  xp_delta,
  resulting_xp,
  resulting_level,
  metadata - ARRAY[
    'playerId', 'player_id', 'accountId', 'account_id', 'sessionId', 'session_id'
  ] AS metadata
FROM public.xp_events;

CREATE OR REPLACE VIEW telemetry.authoritative_inventory_events AS
SELECT
  id::text AS event_id,
  operation_key AS operation_id,
  player_id,
  CASE WHEN delta_quantity > 0 THEN 'item_gained' ELSE 'item_consumed' END AS event_type,
  item_id,
  variant,
  quantity_after - delta_quantity AS quantity_before,
  delta_quantity AS quantity_delta,
  quantity_after,
  created_at AS event_time,
  metadata - ARRAY[
    'playerId', 'player_id', 'accountId', 'account_id', 'sessionId', 'session_id'
  ] AS metadata
FROM public.inventory_events;

CREATE OR REPLACE VIEW telemetry.authoritative_wallet_events AS
SELECT
  event_id::text AS event_id,
  operation_key AS operation_id,
  player_id,
  CASE WHEN delta_gold > 0 THEN 'gold_gained' ELSE 'gold_spent' END AS event_type,
  balance_after - delta_gold AS amount_before,
  delta_gold AS amount_delta,
  balance_after AS amount_after,
  created_at AS event_time,
  metadata - ARRAY[
    'playerId', 'player_id', 'accountId', 'account_id', 'sessionId', 'session_id'
  ] AS metadata
FROM public.wallet_events;
