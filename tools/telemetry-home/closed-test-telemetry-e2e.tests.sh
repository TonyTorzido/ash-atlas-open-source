#!/usr/bin/env bash
set -euo pipefail

[[ $EUID -eq 0 ]] || {
  echo "telemetry E2E requires root inside an isolated test container" >&2
  exit 1
}
: "${TELEMETRY_TEST_DATABASE_URL:?disposable migrated database URL is required}"
database_name="$(
  psql "$TELEMETRY_TEST_DATABASE_URL" -XAtq -v ON_ERROR_STOP=1 \
    -c "SELECT current_database()"
)"
[[ "$database_name" == ash_atlas_stability_* ]] || {
  echo "telemetry E2E requires a disposable ash_atlas_stability_* database" >&2
  exit 1
}

home_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
vps_dir="$(cd -- "$home_dir/../release/vps" && pwd -P)"
work="$(mktemp -d /tmp/ash-atlas-telemetry-test.XXXXXXXX)"
index_command=/usr/local/sbin/ash-atlas-bug-report-index
[[ ! -e "$index_command" ]] || {
  echo "isolated test container already has a bug-report index command" >&2
  exit 1
}
mounted=false
cleanup() {
  if [[ "$mounted" == "true" ]]; then umount "$work/seagate"; fi
  rm -f -- "$index_command"
  rm -rf -- "$work"
  rm -rf -- /var/lib/ash-atlas/telemetry-exports
  rm -rf -- /var/lib/ash-atlas/telemetry-acknowledgments
}
trap cleanup EXIT
mkdir -p "$work/seagate" "$work/bin"
mount -t tmpfs -o size=128m ash-atlas-telemetry-e2e "$work/seagate"
mounted=true
install -d -m 0700 /var/lib/ash-atlas/telemetry-exports
install -d -m 0730 /var/lib/ash-atlas/telemetry-acknowledgments

run_id="00000000-0000-4000-8000-000000000301"
segment_id="00000000-0000-4000-8000-000000000311"
campaign_id="00000000-0000-4000-8000-000000000321"
psql "$TELEMETRY_TEST_DATABASE_URL" -Xq -v ON_ERROR_STOP=1 <<SQL
INSERT INTO telemetry.test_runs (
  run_id,telemetry_schema_version,run_name,started_at,ended_at,status,
  release_sha,release_generation,world_release_id,population_plan_version,
  population_spawn_rules_version,population_candidate_layout_version,
  permanent_stone_placement_version,balance_version,server_instance_id,
  ingestion_closed_at,segment_id,campaign_id,segment_sequence,segment_start_at,
  segment_end_at,segment_duration_seconds
) VALUES (
  '${run_id}',1,'private telemetry E2E',now()-interval '1 hour',now(),'frozen',
  repeat('a',40),'test/t182','world-test','population-test','spawn-test',
  'layout-test','stone-test','balance-test','telemetry-e2e',now(),
  '${segment_id}','${campaign_id}',0,now()-interval '1 hour',now(),3600
);
INSERT INTO telemetry.gameplay_events (
  event_id,telemetry_schema_version,run_id,release_sha,release_generation,
  world_release_id,population_plan_version,population_spawn_rules_version,
  balance_version,server_instance_id,event_time,event_family,event_type,
  event_schema_version,priority,player_id,session_id,metadata
) VALUES (
  gen_random_uuid(),1,'${run_id}',repeat('a',40),'test/t182','world-test',
  'population-test','spawn-test','balance-test','telemetry-e2e',now(),
  'session','e2e_probe',1,'important','player-e2e',gen_random_uuid(),'{}'
);
INSERT INTO telemetry.bug_reports (
  report_id,public_report_code,request_id,telemetry_schema_version,
  bug_report_schema_version,run_id,campaign_id,segment_id,release_sha,
  release_generation,world_release_id,population_plan_version,
  population_spawn_rules_version,balance_version,server_instance_id,
  player_id,session_id,connection_generation,report_marker_at,
  available_window_start_at,window_start_at,window_end_at,submitted_at,
  title,category,description,expected_behavior,reproducibility,status
) VALUES (
  '00000000-0000-4000-8000-000000000331','AA-E2E001',
  '00000000-0000-4000-8000-000000000332',1,1,'${run_id}',
  '${campaign_id}','${segment_id}',repeat('a',40),'test/t182','world-test',
  'population-test','spawn-test','balance-test','telemetry-e2e',
  'player-e2e','00000000-0000-4000-8000-000000000333',1,
  now()-interval '5 minutes',now()-interval '9 minutes',
  now()-interval '10 minutes',now()-interval '5 minutes',
  now()-interval '4 minutes','Private E2E bug report','gameplay',
  'Private E2E diagnostic description','Expected E2E behavior',
  'every_time','new'
);
INSERT INTO telemetry.bug_report_context (
  report_id,context_schema_version,client_state,authoritative_player_state,
  nearby_entities,recent_client_actions,recent_client_errors,network_timeline,
  performance_history,related_operation_ids,related_event_ids,
  uncompressed_bytes,compressed_bytes,content_checksum
) VALUES (
  '00000000-0000-4000-8000-000000000331',1,
  '{"playerId":"player-e2e"}','{"playerId":"player-e2e"}',
  '[{"playerId":"player-e2e"}]','[]','[]','[]','[]',
  ARRAY['operation-player-e2e'],ARRAY[]::uuid[],1024,512,repeat('b',64)
);
SQL

export TELEMETRY_EXPORT_ENABLED=true
export TELEMETRY_EXPORT_DATABASE_URL="$TELEMETRY_TEST_DATABASE_URL"
export TELEMETRY_OPERATOR_DATABASE_URL="$TELEMETRY_TEST_DATABASE_URL"
export TELEMETRY_EXPORT_PSEUDONYM_SALT="e2e-only-secret"
export TELEMETRY_EXPORT_PSEUDONYM_KEY_ID="e2e-v1"
export TELEMETRY_EXPORT_ROOT=/var/lib/ash-atlas/telemetry-exports
export TELEMETRY_ACK_ROOT=/var/lib/ash-atlas/telemetry-acknowledgments
export TELEMETRY_EXPORT_MINIMUM_FREE_BYTES=1
export TELEMETRY_PULL_USER=nobody
bash "$vps_dir/export-closed-test-telemetry.sh" --run-id "$run_id" --format duckdb

mapfile -t ready < <(find "$TELEMETRY_EXPORT_ROOT" -maxdepth 1 -type f -name '*.ready.json')
[[ ${#ready[@]} -eq 1 ]]
manifest_path="${ready[0]}"
artifact_name="$(jq -r '.artifact.fileName' "$manifest_path")"
grep -qx 'user:nobody:r-x' <(getfacl -cp "$TELEMETRY_EXPORT_ROOT")
grep -qx 'user:nobody:r--' <(getfacl -cp "$TELEMETRY_EXPORT_ROOT/$artifact_name")
[[ -f "$TELEMETRY_EXPORT_ROOT/$artifact_name" ]]
[[ "$(jq -r '.segmentId' "$manifest_path")" == "$segment_id" ]]
[[ "$(jq -r '.tableRowCounts.gameplay_events' "$manifest_path")" == "1" ]]
[[ "$(jq -r '.tableRowCounts.bug_reports' "$manifest_path")" == "1" ]]
[[ "$(jq -r '.tableRowCounts.bug_report_context' "$manifest_path")" == "1" ]]
[[ "$(
  psql "$TELEMETRY_TEST_DATABASE_URL" -XAtq -v ON_ERROR_STOP=1 \
    -c "SELECT count(*) FROM telemetry.export_receipts
        WHERE run_id='${run_id}' AND verification_status='verified'
          AND ready_manifest_path IS NOT NULL"
)" == "1" ]]

cat >"$work/bin/ssh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
SSH_ORIGINAL_COMMAND="${!#}" bash "${TELEMETRY_TEST_FORCED_COMMAND:?}"
SH
chmod 0755 "$work/bin/ssh"
touch "$work/key" "$work/known-hosts"
export PATH="$work/bin:$PATH"
export TELEMETRY_TEST_MODE=true
export TELEMETRY_TEST_FORCED_COMMAND="$vps_dir/telemetry-pull-command.sh"
export TELEMETRY_VPS_HOST=test.invalid
export TELEMETRY_VPS_USER=ash-telemetry-pull
export TELEMETRY_SSH_KEY="$work/key"
export TELEMETRY_KNOWN_HOSTS="$work/known-hosts"
export TELEMETRY_SEAGATE_MOUNT="$work/seagate"
export TELEMETRY_SEAGATE_UUID=TEST-TMPFS
export TELEMETRY_SEAGATE_SERIAL=TEST-SERIAL
export TELEMETRY_TEST_DEVICE_SERIAL=TEST-SERIAL
export TELEMETRY_ARCHIVE_OWNER=root:root
export TELEMETRY_HOME_MINIMUM_FREE_BYTES=1
export TELEMETRY_BUG_REPORT_INDEX_ROOT="$work/seagate/bug-report-index"
install -o root -g root -m 0755 "$home_dir/index-bug-reports.sh" "$index_command"
# Production pulls occur well after export. Keep the synthetic acknowledgment's
# whole-second timestamp from preceding the receipt's subsecond verified_at.
sleep 1
bash "$home_dir/ash-atlas-telemetry-pull.sh"

archived="$work/seagate/ash-atlas-telemetry/archive"
local_artifact="$(find "$archived" -type f -name "$artifact_name")"
[[ -n "$local_artifact" ]]
duckdb "$local_artifact" \
  "SELECT error('missing E2E row') WHERE
   (SELECT count(*) FROM gameplay_events WHERE event_type='e2e_probe') <> 1" \
  >/dev/null
duckdb "$local_artifact" \
  "SELECT error('missing private bug report export') WHERE
   (SELECT count(*) FROM bug_reports WHERE public_report_code='AA-E2E001') <> 1
   OR (SELECT count(*) FROM bug_report_context) <> 1
   OR (SELECT player_id FROM bug_reports WHERE public_report_code='AA-E2E001')
      = 'player-e2e'" \
  >/dev/null
duckdb "$TELEMETRY_BUG_REPORT_INDEX_ROOT/reports.duckdb" \
  "SELECT error('bug report was not indexed') WHERE
   (SELECT count(*) FROM reports
    WHERE public_report_code='AA-E2E001'
      AND title='Private E2E bug report'
      AND source_segment_id='${segment_id}') <> 1" \
  >/dev/null
[[ "$(cat "$TELEMETRY_BUG_REPORT_INDEX_ROOT/last-indexed-segment.txt")" == "$segment_id" ]]
[[ -f "$TELEMETRY_ACK_ROOT/${segment_id}.ack.json" ]]

export TELEMETRY_COMPLETED_SEGMENT_LIMIT=5
export TELEMETRY_HARD_MAX_AGE_SECONDS=21600
export TELEMETRY_ACK_GRACE_SECONDS=0
export TELEMETRY_EMERGENCY_BYTE_CAP=0
bash "$vps_dir/retain-telemetry-segments.sh"
[[ ! -e "$TELEMETRY_EXPORT_ROOT/$artifact_name" ]]
[[ "$(
  psql "$TELEMETRY_TEST_DATABASE_URL" -XAtq -v ON_ERROR_STOP=1 \
    -c "SELECT retention_status||'|'||
               (SELECT deletion_reason||'|'||archival_data_lost
                FROM telemetry.segment_retention_receipts
                WHERE run_id='${run_id}')
        FROM telemetry.test_runs WHERE run_id='${run_id}'"
)" == "deleted|acknowledged|false" ]]
[[ "$(
  psql "$TELEMETRY_TEST_DATABASE_URL" -XAtq -v ON_ERROR_STOP=1 \
    -c "SELECT count(*) FROM telemetry.gameplay_events WHERE run_id='${run_id}'"
)" == "0" ]]
[[ "$(
  psql "$TELEMETRY_TEST_DATABASE_URL" -XAtq -v ON_ERROR_STOP=1 \
    -c "SELECT export_status||'|'||
               (SELECT count(*) FROM telemetry.bug_report_context
                WHERE report_id='00000000-0000-4000-8000-000000000331')
        FROM telemetry.bug_reports
        WHERE report_id='00000000-0000-4000-8000-000000000331'"
)" == "acknowledged|1" ]]

# Force the receipt write to fail after artifact verification/publication.
# Cleanup must remove the final artifact/checksum and never expose a ready
# manifest; only an explicit failure marker may remain.
failed_run="00000000-0000-4000-8000-000000000302"
failed_segment="00000000-0000-4000-8000-000000000312"
psql "$TELEMETRY_TEST_DATABASE_URL" -Xq -v ON_ERROR_STOP=1 <<SQL
INSERT INTO telemetry.test_runs (
  run_id,telemetry_schema_version,run_name,started_at,ended_at,status,
  release_sha,release_generation,world_release_id,population_plan_version,
  population_spawn_rules_version,population_candidate_layout_version,
  permanent_stone_placement_version,balance_version,server_instance_id,
  ingestion_closed_at,segment_id,campaign_id,segment_sequence,segment_start_at,
  segment_end_at,segment_duration_seconds
) VALUES (
  '${failed_run}',1,'failed export E2E',now()-interval '1 hour',now(),'frozen',
  repeat('a',40),'test/t182','world-test','population-test','spawn-test',
  'layout-test','stone-test','balance-test','telemetry-e2e',now(),
  '${failed_segment}','${campaign_id}',1,now()-interval '1 hour',now(),3600
);
SQL
if TELEMETRY_OPERATOR_DATABASE_URL='postgresql://invalid@127.0.0.1:1/invalid' \
   bash "$vps_dir/export-closed-test-telemetry.sh" \
     --run-id "$failed_run" --format duckdb >/dev/null 2>&1; then
  echo "export unexpectedly succeeded with an unavailable receipt database" >&2
  exit 1
fi
[[ -z "$(find "$TELEMETRY_EXPORT_ROOT" -maxdepth 1 -type f -name '*.ready.json' -print -quit)" ]]
[[ -z "$(find "$TELEMETRY_EXPORT_ROOT" -maxdepth 1 -type f -name '*.duckdb' -print -quit)" ]]
[[ -n "$(find "$TELEMETRY_EXPORT_ROOT" -maxdepth 1 -type f -name '*.failed' -print -quit)" ]]

echo "closed-test telemetry export/pull/ack/retention E2E passed"
