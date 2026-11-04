CREATE SCHEMA telemetry;

REVOKE ALL ON SCHEMA telemetry FROM PUBLIC;

CREATE TABLE telemetry.test_runs (
  run_id uuid PRIMARY KEY,
  telemetry_schema_version smallint NOT NULL CHECK (telemetry_schema_version = 1),
  run_name text NOT NULL CHECK (length(run_name) BETWEEN 1 AND 120),
  started_at timestamptz NOT NULL,
  ended_at timestamptz NULL,
  status text NOT NULL CHECK (
    status IN ('preparing', 'active', 'frozen', 'exported', 'failed')
  ),
  release_sha text NOT NULL CHECK (release_sha ~ '^[a-f0-9]{40}$'),
  release_generation text NULL CHECK (
    release_generation IS NULL OR release_generation ~ '^test/t[0-9]+$'
  ),
  world_release_id text NOT NULL CHECK (length(world_release_id) BETWEEN 1 AND 160),
  population_plan_version text NOT NULL CHECK (
    length(population_plan_version) BETWEEN 1 AND 160
  ),
  population_spawn_rules_version text NOT NULL CHECK (
    length(population_spawn_rules_version) BETWEEN 1 AND 160
  ),
  population_candidate_layout_version text NOT NULL CHECK (
    length(population_candidate_layout_version) BETWEEN 1 AND 160
  ),
  permanent_stone_placement_version text NOT NULL CHECK (
    length(permanent_stone_placement_version) BETWEEN 1 AND 160
  ),
  balance_version text NOT NULL CHECK (length(balance_version) BETWEEN 1 AND 160),
  server_instance_id text NOT NULL CHECK (length(server_instance_id) BETWEEN 1 AND 160),
  capacity_configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes text NOT NULL DEFAULT '' CHECK (length(notes) <= 4000),
  reset_wipe_marker boolean NOT NULL DEFAULT false,
  export_status text NOT NULL DEFAULT 'not_exported' CHECK (
    export_status IN ('not_exported', 'exporting', 'verified', 'failed')
  ),
  protected_from_retention boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (status IN ('preparing', 'active') AND ended_at IS NULL)
    OR (status IN ('frozen', 'exported', 'failed') AND ended_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX telemetry_one_active_run_idx
  ON telemetry.test_runs ((true))
  WHERE status = 'active';
CREATE INDEX telemetry_test_runs_started_idx
  ON telemetry.test_runs (started_at DESC);

CREATE TABLE telemetry.server_samples (
  sample_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  telemetry_schema_version smallint NOT NULL CHECK (telemetry_schema_version = 1),
  run_id uuid NOT NULL REFERENCES telemetry.test_runs(run_id) ON DELETE RESTRICT,
  release_sha text NOT NULL CHECK (release_sha ~ '^[a-f0-9]{40}$'),
  release_generation text NULL,
  world_release_id text NOT NULL,
  population_plan_version text NOT NULL,
  population_spawn_rules_version text NOT NULL,
  balance_version text NOT NULL,
  server_instance_id text NOT NULL,
  recorded_at timestamptz NOT NULL,
  sample_source text NOT NULL DEFAULT 'game_server' CHECK (
    sample_source IN ('game_server', 'host_agent')
  ),
  active_players integer NULL CHECK (active_players >= 0),
  link_dead_players integer NULL CHECK (link_dead_players >= 0),
  active_websocket_connections integer NULL CHECK (active_websocket_connections >= 0),
  connections_by_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  process_cpu_user_ms double precision NULL CHECK (process_cpu_user_ms >= 0),
  process_cpu_system_ms double precision NULL CHECK (process_cpu_system_ms >= 0),
  host_cpu_percent double precision NULL CHECK (
    host_cpu_percent BETWEEN 0 AND 100
  ),
  process_rss_bytes bigint NULL CHECK (process_rss_bytes >= 0),
  node_heap_used_bytes bigint NULL CHECK (node_heap_used_bytes >= 0),
  node_heap_total_bytes bigint NULL CHECK (node_heap_total_bytes >= 0),
  node_external_memory_bytes bigint NULL CHECK (node_external_memory_bytes >= 0),
  host_available_memory_bytes bigint NULL CHECK (host_available_memory_bytes >= 0),
  swap_used_bytes bigint NULL CHECK (swap_used_bytes >= 0),
  event_loop_delay_mean_ms double precision NULL CHECK (event_loop_delay_mean_ms >= 0),
  event_loop_delay_p50_ms double precision NULL CHECK (event_loop_delay_p50_ms >= 0),
  event_loop_delay_p95_ms double precision NULL CHECK (event_loop_delay_p95_ms >= 0),
  event_loop_delay_p99_ms double precision NULL CHECK (event_loop_delay_p99_ms >= 0),
  event_loop_delay_max_ms double precision NULL CHECK (event_loop_delay_max_ms >= 0),
  gc_counts_by_type jsonb NOT NULL DEFAULT '{}'::jsonb,
  gc_pause_ms_by_type jsonb NOT NULL DEFAULT '{}'::jsonb,
  current_server_tick bigint NULL CHECK (current_server_tick >= 0),
  tick_count integer NULL CHECK (tick_count >= 0),
  tick_mean_ms double precision NULL CHECK (tick_mean_ms >= 0),
  tick_p50_ms double precision NULL CHECK (tick_p50_ms >= 0),
  tick_p95_ms double precision NULL CHECK (tick_p95_ms >= 0),
  tick_p99_ms double precision NULL CHECK (tick_p99_ms >= 0),
  tick_max_ms double precision NULL CHECK (tick_max_ms >= 0),
  ticks_over_25_ms integer NULL CHECK (ticks_over_25_ms >= 0),
  ticks_over_50_ms integer NULL CHECK (ticks_over_50_ms >= 0),
  ticks_over_100_ms integer NULL CHECK (ticks_over_100_ms >= 0),
  world_command_queue_depth integer NULL CHECK (world_command_queue_depth >= 0),
  world_command_queue_max_depth integer NULL CHECK (world_command_queue_max_depth >= 0),
  commands_accepted bigint NULL CHECK (commands_accepted >= 0),
  commands_processed bigint NULL CHECK (commands_processed >= 0),
  commands_rejected bigint NULL CHECK (commands_rejected >= 0),
  commands_duplicate bigint NULL CHECK (commands_duplicate >= 0),
  commands_stale bigint NULL CHECK (commands_stale >= 0),
  commands_overflowed bigint NULL CHECK (commands_overflowed >= 0),
  world_deltas_sent bigint NULL CHECK (world_deltas_sent >= 0),
  combat_deltas_sent bigint NULL CHECK (combat_deltas_sent >= 0),
  websocket_messages_sent bigint NULL CHECK (websocket_messages_sent >= 0),
  websocket_bytes_sent bigint NULL CHECK (websocket_bytes_sent >= 0),
  websocket_messages_received bigint NULL CHECK (websocket_messages_received >= 0),
  websocket_bytes_received bigint NULL CHECK (websocket_bytes_received >= 0),
  websocket_messages_by_family jsonb NOT NULL DEFAULT '{}'::jsonb,
  replaceable_messages_skipped bigint NULL CHECK (replaceable_messages_skipped >= 0),
  replaceable_messages_coalesced bigint NULL CHECK (replaceable_messages_coalesced >= 0),
  backpressure_closures bigint NULL CHECK (backpressure_closures >= 0),
  gameplay_pool_total integer NULL CHECK (gameplay_pool_total >= 0),
  gameplay_pool_idle integer NULL CHECK (gameplay_pool_idle >= 0),
  gameplay_pool_active integer NULL CHECK (gameplay_pool_active >= 0),
  gameplay_pool_waiting integer NULL CHECK (gameplay_pool_waiting >= 0),
  gameplay_query_timing jsonb NOT NULL DEFAULT '{}'::jsonb,
  gameplay_database_errors bigint NULL CHECK (gameplay_database_errors >= 0),
  gameplay_database_lock_waits bigint NULL CHECK (gameplay_database_lock_waits >= 0),
  population_preparation_queue_depth integer NULL CHECK (
    population_preparation_queue_depth >= 0
  ),
  population_preparation_timing jsonb NOT NULL DEFAULT '{}'::jsonb,
  resource_vision_queue_depth integer NULL CHECK (resource_vision_queue_depth >= 0),
  resource_vision_timing jsonb NOT NULL DEFAULT '{}'::jsonb,
  telemetry_queue_depth integer NULL CHECK (telemetry_queue_depth >= 0),
  telemetry_rows_flushed bigint NULL CHECK (telemetry_rows_flushed >= 0),
  telemetry_rows_dropped_by_priority jsonb NOT NULL DEFAULT '{}'::jsonb,
  telemetry_flush_duration_ms double precision NULL CHECK (
    telemetry_flush_duration_ms >= 0
  ),
  telemetry_write_failures bigint NULL CHECK (telemetry_write_failures >= 0),
  disk_free_bytes bigint NULL CHECK (disk_free_bytes >= 0),
  disk_read_bytes bigint NULL CHECK (disk_read_bytes >= 0),
  disk_write_bytes bigint NULL CHECK (disk_write_bytes >= 0),
  host_network_receive_bytes bigint NULL CHECK (host_network_receive_bytes >= 0),
  host_network_transmit_bytes bigint NULL CHECK (host_network_transmit_bytes >= 0),
  service_uptime_seconds double precision NULL CHECK (service_uptime_seconds >= 0),
  restart_boot_identifier text NULL CHECK (
    restart_boot_identifier IS NULL OR length(restart_boot_identifier) BETWEEN 1 AND 200
  )
);

CREATE INDEX telemetry_server_samples_run_time_idx
  ON telemetry.server_samples (run_id, recorded_at);
CREATE INDEX telemetry_server_samples_retention_idx
  ON telemetry.server_samples (recorded_at);

CREATE TABLE telemetry.world_samples (
  sample_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  telemetry_schema_version smallint NOT NULL CHECK (telemetry_schema_version = 1),
  run_id uuid NOT NULL REFERENCES telemetry.test_runs(run_id) ON DELETE RESTRICT,
  release_sha text NOT NULL CHECK (release_sha ~ '^[a-f0-9]{40}$'),
  release_generation text NULL,
  world_release_id text NOT NULL,
  population_plan_version text NOT NULL,
  population_spawn_rules_version text NOT NULL,
  balance_version text NOT NULL,
  server_instance_id text NOT NULL,
  recorded_at timestamptz NOT NULL,
  scope_type text NOT NULL CHECK (scope_type IN ('global', 'region', 'zone')),
  scope_id text NOT NULL CHECK (length(scope_id) BETWEEN 1 AND 160),
  entity_category text NOT NULL CHECK (length(entity_category) BETWEEN 1 AND 80),
  planned_count bigint NULL CHECK (planned_count >= 0),
  persisted_count bigint NULL CHECK (persisted_count >= 0),
  ready_alive_count bigint NULL CHECK (ready_alive_count >= 0),
  dead_harvested_count bigint NULL CHECK (dead_harvested_count >= 0),
  respawn_pending_count bigint NULL CHECK (respawn_pending_count >= 0),
  suppressed_count bigint NULL CHECK (suppressed_count >= 0),
  active_runtime_count bigint NULL CHECK (active_runtime_count >= 0),
  sleeping_count bigint NULL CHECK (sleeping_count >= 0),
  visible_count bigint NULL CHECK (visible_count >= 0),
  reconciliation_source text NOT NULL DEFAULT 'runtime' CHECK (
    reconciliation_source IN ('runtime', 'postgres_reconciliation')
  ),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX telemetry_world_samples_run_time_idx
  ON telemetry.world_samples (run_id, recorded_at);
CREATE INDEX telemetry_world_samples_category_time_idx
  ON telemetry.world_samples (entity_category, recorded_at);
CREATE INDEX telemetry_world_samples_retention_idx
  ON telemetry.world_samples (recorded_at);

CREATE TABLE telemetry.gameplay_events (
  event_id uuid PRIMARY KEY,
  telemetry_schema_version smallint NOT NULL CHECK (telemetry_schema_version = 1),
  run_id uuid NOT NULL REFERENCES telemetry.test_runs(run_id) ON DELETE RESTRICT,
  release_sha text NOT NULL CHECK (release_sha ~ '^[a-f0-9]{40}$'),
  release_generation text NULL,
  world_release_id text NOT NULL,
  population_plan_version text NOT NULL,
  population_spawn_rules_version text NOT NULL,
  balance_version text NOT NULL,
  server_instance_id text NOT NULL,
  event_time timestamptz NOT NULL,
  event_family text NOT NULL CHECK (
    event_family IN (
      'connection', 'session', 'travel', 'harvest', 'combat', 'economy',
      'progression', 'settlement', 'social', 'population', 'persistence'
    )
  ),
  event_type text NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9_]{1,79}$'),
  event_schema_version smallint NOT NULL CHECK (event_schema_version > 0),
  priority text NOT NULL CHECK (priority IN ('critical', 'important', 'routine')),
  player_id text NULL,
  other_actor_id text NULL,
  target_id text NULL,
  session_id uuid NULL,
  operation_id text NULL CHECK (
    operation_id IS NULL OR length(operation_id) BETWEEN 1 AND 160
  ),
  connection_generation bigint NULL CHECK (connection_generation >= 0),
  gameplay_zone_id text NULL,
  source_type text NULL,
  source_entity_id text NULL,
  item_or_currency_id text NULL,
  item_variant text NULL,
  quantity_before bigint NULL,
  quantity_delta bigint NULL,
  quantity_after bigint NULL,
  applied_state text NULL CHECK (
    applied_state IS NULL OR applied_state IN ('applied', 'replayed', 'rejected', 'failed')
  ),
  rejection_code text NULL CHECK (
    rejection_code IS NULL OR length(rejection_code) BETWEEN 1 AND 120
  ),
  duration_ms double precision NULL CHECK (duration_ms IS NULL OR duration_ms >= 0),
  distance_m double precision NULL CHECK (distance_m IS NULL OR distance_m >= 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CHECK (octet_length(metadata::text) <= 16384)
);

CREATE INDEX telemetry_gameplay_events_run_time_idx
  ON telemetry.gameplay_events (run_id, event_time);
CREATE INDEX telemetry_gameplay_events_player_time_idx
  ON telemetry.gameplay_events (player_id, event_time)
  WHERE player_id IS NOT NULL;
CREATE INDEX telemetry_gameplay_events_type_time_idx
  ON telemetry.gameplay_events (event_type, event_time);
CREATE INDEX telemetry_gameplay_events_session_idx
  ON telemetry.gameplay_events (session_id)
  WHERE session_id IS NOT NULL;
CREATE INDEX telemetry_gameplay_events_operation_idx
  ON telemetry.gameplay_events (operation_id)
  WHERE operation_id IS NOT NULL;

CREATE TABLE telemetry.player_inventory_snapshots (
  inventory_snapshot_id uuid PRIMARY KEY,
  telemetry_schema_version smallint NOT NULL CHECK (telemetry_schema_version = 1),
  run_id uuid NOT NULL REFERENCES telemetry.test_runs(run_id) ON DELETE RESTRICT,
  release_sha text NOT NULL CHECK (release_sha ~ '^[a-f0-9]{40}$'),
  release_generation text NULL,
  world_release_id text NOT NULL,
  population_plan_version text NOT NULL,
  population_spawn_rules_version text NOT NULL,
  balance_version text NOT NULL,
  server_instance_id text NOT NULL,
  recorded_at timestamptz NOT NULL,
  player_id text NOT NULL,
  session_id uuid NULL,
  snapshot_reason text NOT NULL CHECK (
    snapshot_reason IN (
      'login', 'interval_changed', 'consistency_checkpoint', 'logout',
      'terminal_disconnect', 'run_freeze', 'progression_change', 'ownership_change'
    )
  ),
  inventory_revision bigint NOT NULL CHECK (inventory_revision >= 0),
  items jsonb NOT NULL,
  item_stack_count integer NOT NULL CHECK (item_stack_count >= 0),
  total_quantity bigint NOT NULL CHECK (total_quantity >= 0),
  CHECK (octet_length(items::text) <= 262144)
);

CREATE UNIQUE INDEX telemetry_inventory_snapshot_revision_reason_idx
  ON telemetry.player_inventory_snapshots (
    run_id, player_id, inventory_revision, snapshot_reason
  );
CREATE INDEX telemetry_inventory_snapshots_run_time_idx
  ON telemetry.player_inventory_snapshots (run_id, recorded_at);
CREATE INDEX telemetry_inventory_snapshots_player_time_idx
  ON telemetry.player_inventory_snapshots (player_id, recorded_at);

CREATE TABLE telemetry.player_snapshots (
  player_snapshot_id uuid PRIMARY KEY,
  telemetry_schema_version smallint NOT NULL CHECK (telemetry_schema_version = 1),
  run_id uuid NOT NULL REFERENCES telemetry.test_runs(run_id) ON DELETE RESTRICT,
  release_sha text NOT NULL CHECK (release_sha ~ '^[a-f0-9]{40}$'),
  release_generation text NULL,
  world_release_id text NOT NULL,
  population_plan_version text NOT NULL,
  population_spawn_rules_version text NOT NULL,
  balance_version text NOT NULL,
  server_instance_id text NOT NULL,
  recorded_at timestamptz NOT NULL,
  player_id text NOT NULL,
  session_id uuid NULL,
  snapshot_reason text NOT NULL CHECK (
    snapshot_reason IN (
      'login', 'interval', 'logout', 'terminal_disconnect', 'run_freeze',
      'progression_change', 'ownership_change'
    )
  ),
  online_duration_seconds bigint NOT NULL CHECK (online_duration_seconds >= 0),
  level integer NULL CHECK (level IS NULL OR level >= 0),
  total_xp bigint NULL CHECK (total_xp IS NULL OR total_xp >= 0),
  class_id text NULL,
  subclass_id text NULL,
  class_loadout jsonb NOT NULL DEFAULT '{}'::jsonb,
  profession_progression jsonb NOT NULL DEFAULT '{}'::jsonb,
  gold bigint NULL CHECK (gold IS NULL OR gold >= 0),
  inventory_revision bigint NULL CHECK (inventory_revision IS NULL OR inventory_revision >= 0),
  inventory_snapshot_id uuid NULL REFERENCES telemetry.player_inventory_snapshots(
    inventory_snapshot_id
  ) ON DELETE RESTRICT,
  equipment_revision bigint NULL CHECK (equipment_revision IS NULL OR equipment_revision >= 0),
  equipped_items jsonb NOT NULL DEFAULT '[]'::jsonb,
  current_hp integer NULL CHECK (current_hp IS NULL OR current_hp >= 0),
  maximum_hp integer NULL CHECK (maximum_hp IS NULL OR maximum_hp >= 0),
  life_state text NULL CHECK (
    life_state IS NULL OR life_state IN ('alive', 'defeated')
  ),
  combat_state text NULL,
  personal_flag_count integer NULL CHECK (personal_flag_count IS NULL OR personal_flag_count >= 0),
  city_id text NULL,
  city_role text NULL,
  kingdom_id text NULL,
  kingdom_role text NULL,
  manor_id text NULL,
  party_id uuid NULL,
  coarse_zone_id text NULL,
  current_flag_id text NULL,
  cumulative_counters jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_authoritative_activity_at timestamptz NULL
);

CREATE INDEX telemetry_player_snapshots_run_time_idx
  ON telemetry.player_snapshots (run_id, recorded_at);
CREATE INDEX telemetry_player_snapshots_player_time_idx
  ON telemetry.player_snapshots (player_id, recorded_at);

CREATE TABLE telemetry.client_samples (
  client_sample_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  telemetry_schema_version smallint NOT NULL CHECK (telemetry_schema_version = 1),
  run_id uuid NOT NULL REFERENCES telemetry.test_runs(run_id) ON DELETE RESTRICT,
  release_sha text NOT NULL CHECK (release_sha ~ '^[a-f0-9]{40}$'),
  release_generation text NULL,
  world_release_id text NOT NULL,
  population_plan_version text NOT NULL,
  population_spawn_rules_version text NOT NULL,
  balance_version text NOT NULL,
  server_instance_id text NOT NULL,
  recorded_at timestamptz NOT NULL,
  player_id text NOT NULL,
  session_id uuid NOT NULL,
  connection_generation bigint NULL CHECK (connection_generation >= 0),
  client_sequence bigint NOT NULL CHECK (client_sequence >= 0),
  sample_reason text NOT NULL CHECK (
    sample_reason IN (
      'interval', 'reconnect_success', 'reconnect_failure', 'protocol_failure',
      'severe_frame_stall', 'world_resync', 'repeated_send_failure'
    )
  ),
  device_category text NOT NULL CHECK (
    device_category IN ('phone', 'tablet', 'desktop', 'unknown')
  ),
  operating_system_family text NOT NULL CHECK (length(operating_system_family) <= 40),
  browser_family text NOT NULL CHECK (length(browser_family) <= 40),
  browser_major_version integer NULL CHECK (browser_major_version >= 0),
  installed_pwa boolean NOT NULL,
  foreground_state text NOT NULL CHECK (
    foreground_state IN ('foreground', 'background')
  ),
  viewport_width integer NOT NULL CHECK (viewport_width BETWEEN 1 AND 16384),
  viewport_height integer NOT NULL CHECK (viewport_height BETWEEN 1 AND 16384),
  screen_size_class text NOT NULL CHECK (
    screen_size_class IN ('small', 'medium', 'large')
  ),
  fps_mean double precision NOT NULL CHECK (fps_mean BETWEEN 0 AND 1000),
  frame_time_p50_ms double precision NOT NULL CHECK (frame_time_p50_ms >= 0),
  frame_time_p95_ms double precision NOT NULL CHECK (frame_time_p95_ms >= 0),
  frame_time_p99_ms double precision NOT NULL CHECK (frame_time_p99_ms >= 0),
  frame_time_max_ms double precision NOT NULL CHECK (frame_time_max_ms >= 0),
  long_frames_over_50_ms integer NOT NULL CHECK (long_frames_over_50_ms >= 0),
  long_frames_over_100_ms integer NOT NULL CHECK (long_frames_over_100_ms >= 0),
  rtt_mean_ms double precision NULL CHECK (rtt_mean_ms IS NULL OR rtt_mean_ms >= 0),
  rtt_p95_ms double precision NULL CHECK (rtt_p95_ms IS NULL OR rtt_p95_ms >= 0),
  authoritative_snapshot_age_ms double precision NULL CHECK (
    authoritative_snapshot_age_ms IS NULL OR authoritative_snapshot_age_ms >= 0
  ),
  websocket_reconnect_count integer NOT NULL CHECK (websocket_reconnect_count >= 0),
  websocket_send_failures jsonb NOT NULL DEFAULT '{}'::jsonb,
  stale_socket_events integer NOT NULL CHECK (stale_socket_events >= 0),
  visible_flag_count integer NOT NULL CHECK (visible_flag_count >= 0),
  visible_collectible_count integer NOT NULL CHECK (visible_collectible_count >= 0),
  visible_combat_entity_count integer NOT NULL CHECK (visible_combat_entity_count >= 0),
  retained_display_object_count integer NOT NULL CHECK (retained_display_object_count >= 0),
  collectible_redraw_count integer NOT NULL CHECK (collectible_redraw_count >= 0),
  collectible_redraw_duration_ms double precision NOT NULL CHECK (
    collectible_redraw_duration_ms >= 0
  ),
  static_overlay_redraw_count integer NOT NULL CHECK (static_overlay_redraw_count >= 0),
  static_overlay_redraw_duration_ms double precision NOT NULL CHECK (
    static_overlay_redraw_duration_ms >= 0
  ),
  client_release_identifier text NOT NULL CHECK (
    length(client_release_identifier) BETWEEN 1 AND 160
  ),
  UNIQUE (run_id, session_id, client_sequence)
);

CREATE INDEX telemetry_client_samples_run_time_idx
  ON telemetry.client_samples (run_id, recorded_at);
CREATE INDEX telemetry_client_samples_player_time_idx
  ON telemetry.client_samples (player_id, recorded_at);
CREATE INDEX telemetry_client_samples_retention_idx
  ON telemetry.client_samples (recorded_at);

CREATE TABLE telemetry.session_summaries (
  session_summary_id uuid PRIMARY KEY,
  telemetry_schema_version smallint NOT NULL CHECK (telemetry_schema_version = 1),
  run_id uuid NOT NULL REFERENCES telemetry.test_runs(run_id) ON DELETE RESTRICT,
  release_sha text NOT NULL CHECK (release_sha ~ '^[a-f0-9]{40}$'),
  release_generation text NULL,
  world_release_id text NOT NULL,
  population_plan_version text NOT NULL,
  population_spawn_rules_version text NOT NULL,
  balance_version text NOT NULL,
  server_instance_id text NOT NULL,
  recorded_at timestamptz NOT NULL,
  player_id text NOT NULL,
  session_id uuid NOT NULL,
  session_started_at timestamptz NOT NULL,
  session_ended_at timestamptz NOT NULL,
  duration_seconds bigint NOT NULL CHECK (duration_seconds >= 0),
  device_category text NULL,
  reconnect_count integer NOT NULL DEFAULT 0 CHECK (reconnect_count >= 0),
  disconnect_count integer NOT NULL DEFAULT 0 CHECK (disconnect_count >= 0),
  rtt_mean_ms double precision NULL CHECK (rtt_mean_ms IS NULL OR rtt_mean_ms >= 0),
  rtt_p95_ms double precision NULL CHECK (rtt_p95_ms IS NULL OR rtt_p95_ms >= 0),
  client_frame_time_mean_ms double precision NULL CHECK (
    client_frame_time_mean_ms IS NULL OR client_frame_time_mean_ms >= 0
  ),
  client_frame_time_p95_ms double precision NULL CHECK (
    client_frame_time_p95_ms IS NULL OR client_frame_time_p95_ms >= 0
  ),
  distance_traveled_m double precision NOT NULL DEFAULT 0 CHECK (distance_traveled_m >= 0),
  locations_visited jsonb NOT NULL DEFAULT '{}'::jsonb,
  entities_encountered jsonb NOT NULL DEFAULT '{}'::jsonb,
  pve_encounters integer NOT NULL DEFAULT 0 CHECK (pve_encounters >= 0),
  pvp_encounters integer NOT NULL DEFAULT 0 CHECK (pvp_encounters >= 0),
  kills integer NOT NULL DEFAULT 0 CHECK (kills >= 0),
  deaths integer NOT NULL DEFAULT 0 CHECK (deaths >= 0),
  damage_dealt bigint NOT NULL DEFAULT 0 CHECK (damage_dealt >= 0),
  damage_taken bigint NOT NULL DEFAULT 0 CHECK (damage_taken >= 0),
  items_gathered jsonb NOT NULL DEFAULT '{}'::jsonb,
  gold_earned bigint NOT NULL DEFAULT 0 CHECK (gold_earned >= 0),
  gold_spent bigint NOT NULL DEFAULT 0 CHECK (gold_spent >= 0),
  xp_earned bigint NOT NULL DEFAULT 0 CHECK (xp_earned >= 0),
  profession_xp_earned jsonb NOT NULL DEFAULT '{}'::jsonb,
  market_activity jsonb NOT NULL DEFAULT '{}'::jsonb,
  settlement_activity jsonb NOT NULL DEFAULT '{}'::jsonb,
  social_activity jsonb NOT NULL DEFAULT '{}'::jsonb,
  harvest_rejections jsonb NOT NULL DEFAULT '{}'::jsonb,
  attack_rejections jsonb NOT NULL DEFAULT '{}'::jsonb,
  transition_failures integer NOT NULL DEFAULT 0 CHECK (transition_failures >= 0),
  transition_forced_releases integer NOT NULL DEFAULT 0 CHECK (
    transition_forced_releases >= 0
  ),
  major_features_used text[] NOT NULL DEFAULT '{}',
  error_count integer NOT NULL DEFAULT 0 CHECK (error_count >= 0),
  UNIQUE (run_id, session_id)
);

CREATE INDEX telemetry_session_summaries_run_time_idx
  ON telemetry.session_summaries (run_id, session_ended_at);
CREATE INDEX telemetry_session_summaries_player_time_idx
  ON telemetry.session_summaries (player_id, session_ended_at);

CREATE TABLE telemetry.telemetry_health (
  server_instance_id text PRIMARY KEY,
  telemetry_schema_version smallint NOT NULL CHECK (telemetry_schema_version = 1),
  run_id uuid NULL REFERENCES telemetry.test_runs(run_id) ON DELETE RESTRICT,
  release_sha text NOT NULL CHECK (release_sha ~ '^[a-f0-9]{40}$'),
  release_generation text NULL,
  world_release_id text NOT NULL,
  population_plan_version text NOT NULL,
  population_spawn_rules_version text NOT NULL,
  balance_version text NOT NULL,
  recorded_at timestamptz NOT NULL,
  enabled boolean NOT NULL,
  degraded boolean NOT NULL,
  queue_depth_critical integer NOT NULL CHECK (queue_depth_critical >= 0),
  queue_depth_important integer NOT NULL CHECK (queue_depth_important >= 0),
  queue_depth_routine integer NOT NULL CHECK (queue_depth_routine >= 0),
  last_successful_flush_at timestamptz NULL,
  rows_flushed bigint NOT NULL CHECK (rows_flushed >= 0),
  rows_dropped jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_database_error_at timestamptz NULL,
  last_database_error text NULL CHECK (
    last_database_error IS NULL OR length(last_database_error) <= 1000
  ),
  telemetry_pool_total integer NOT NULL CHECK (telemetry_pool_total >= 0),
  telemetry_pool_idle integer NOT NULL CHECK (telemetry_pool_idle >= 0),
  telemetry_pool_waiting integer NOT NULL CHECK (telemetry_pool_waiting >= 0),
  host_sampler_last_seen_at timestamptz NULL,
  disk_free_bytes bigint NULL CHECK (disk_free_bytes IS NULL OR disk_free_bytes >= 0),
  consecutive_write_failures integer NOT NULL CHECK (consecutive_write_failures >= 0)
);

CREATE TABLE telemetry.export_receipts (
  receipt_id uuid PRIMARY KEY,
  telemetry_schema_version smallint NOT NULL CHECK (telemetry_schema_version = 1),
  run_id uuid NOT NULL REFERENCES telemetry.test_runs(run_id) ON DELETE RESTRICT,
  release_sha text NOT NULL CHECK (release_sha ~ '^[a-f0-9]{40}$'),
  release_generation text NULL,
  world_release_id text NOT NULL,
  population_plan_version text NOT NULL,
  population_spawn_rules_version text NOT NULL,
  balance_version text NOT NULL,
  server_instance_id text NOT NULL,
  recorded_at timestamptz NOT NULL,
  export_path text NOT NULL CHECK (
    export_path LIKE '/var/lib/ash-atlas/telemetry-exports/%'
  ),
  artifact_format text NOT NULL CHECK (artifact_format IN ('duckdb', 'parquet')),
  pseudonymized boolean NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  artifact_bytes bigint NOT NULL CHECK (artifact_bytes > 0),
  table_row_counts jsonb NOT NULL,
  table_time_ranges jsonb NOT NULL,
  verification_status text NOT NULL CHECK (
    verification_status IN ('verified', 'failed')
  ),
  verified_at timestamptz NOT NULL,
  UNIQUE (run_id, sha256)
);

CREATE INDEX telemetry_export_receipts_run_time_idx
  ON telemetry.export_receipts (run_id, recorded_at);

CREATE TABLE telemetry.cleanup_receipts (
  receipt_id uuid PRIMARY KEY,
  telemetry_schema_version smallint NOT NULL CHECK (telemetry_schema_version = 1),
  run_id uuid NULL REFERENCES telemetry.test_runs(run_id) ON DELETE RESTRICT,
  release_sha text NOT NULL CHECK (release_sha ~ '^[a-f0-9]{40}$'),
  release_generation text NULL,
  world_release_id text NOT NULL,
  population_plan_version text NOT NULL,
  population_spawn_rules_version text NOT NULL,
  balance_version text NOT NULL,
  server_instance_id text NOT NULL,
  recorded_at timestamptz NOT NULL,
  retention_policy jsonb NOT NULL,
  deleted_row_counts jsonb NOT NULL,
  protected_runs_skipped uuid[] NOT NULL DEFAULT '{}'
);

CREATE VIEW telemetry.authoritative_progression_events AS
SELECT
  operation_id::text AS operation_id,
  player_id,
  event_type,
  created_at AS event_time,
  xp_delta,
  resulting_xp,
  resulting_level,
  metadata
FROM public.xp_events;

CREATE VIEW telemetry.authoritative_inventory_events AS
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
  metadata
FROM public.inventory_events;

CREATE VIEW telemetry.authoritative_wallet_events AS
SELECT
  event_id::text AS event_id,
  operation_key AS operation_id,
  player_id,
  CASE WHEN delta_gold > 0 THEN 'gold_gained' ELSE 'gold_spent' END AS event_type,
  balance_after - delta_gold AS amount_before,
  delta_gold AS amount_delta,
  balance_after AS amount_after,
  created_at AS event_time,
  metadata
FROM public.wallet_events;

CREATE VIEW telemetry.authoritative_market_trades AS
SELECT
  trade_id,
  item_id,
  variant AS item_variant,
  buyer_player_id,
  seller_player_id,
  quantity,
  unit_price,
  gross_value + buyer_fee AS buyer_total,
  gross_value - seller_fee AS seller_total,
  created_at AS event_time
FROM public.market_trades;

COMMENT ON SCHEMA telemetry IS
  'Private closed-test telemetry. No gameplay or public HTTP role receives USAGE.';
COMMENT ON VIEW telemetry.authoritative_progression_events IS
  'Read-only analytical projection of durable progression authority; replay-safe by operation ID.';
COMMENT ON VIEW telemetry.authoritative_inventory_events IS
  'Read-only analytical projection of durable inventory authority; replay-safe by operation ID.';
COMMENT ON VIEW telemetry.authoritative_wallet_events IS
  'Read-only analytical projection of durable wallet authority; replay-safe by operation ID.';
COMMENT ON VIEW telemetry.authoritative_market_trades IS
  'Read-only analytical projection of committed market trades.';
