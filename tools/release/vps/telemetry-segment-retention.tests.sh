#!/usr/bin/env bash
set -euo pipefail

: "${TELEMETRY_TEST_DATABASE_URL:?disposable migrated database URL is required}"
database_name="$(
  psql "$TELEMETRY_TEST_DATABASE_URL" -XAtq -v ON_ERROR_STOP=1 \
    -c "SELECT current_database()"
)"
[[ "$database_name" == ash_atlas_stability_* ]] || {
  echo "retention tests require a disposable ash_atlas_stability_* database" >&2
  exit 1
}

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
export TELEMETRY_OPERATOR_DATABASE_URL="$TELEMETRY_TEST_DATABASE_URL"
export TELEMETRY_EXPORT_ROOT=/var/lib/ash-atlas/telemetry-exports
export TELEMETRY_ACK_ROOT=/var/lib/ash-atlas/telemetry-acknowledgments
export TELEMETRY_COMPLETED_SEGMENT_LIMIT=48
export TELEMETRY_HARD_MAX_AGE_SECONDS=21600
export TELEMETRY_ACK_GRACE_SECONDS=0
export TELEMETRY_EMERGENCY_BYTE_CAP=0
install -d -m 0700 "$TELEMETRY_EXPORT_ROOT"
install -d -m 0730 "$TELEMETRY_ACK_ROOT"

campaign_id="00000000-0000-4000-8000-000000000200"
ack_run="00000000-0000-4000-8000-000000000201"
ack_segment="00000000-0000-4000-8000-000000000211"
hard_run="00000000-0000-4000-8000-000000000202"
hard_segment="00000000-0000-4000-8000-000000000212"
recent_run="00000000-0000-4000-8000-000000000203"
recent_segment="00000000-0000-4000-8000-000000000213"
active_run="00000000-0000-4000-8000-000000000204"
active_segment="00000000-0000-4000-8000-000000000214"
sha="$(printf 'a%.0s' {1..64})"

psql "$TELEMETRY_TEST_DATABASE_URL" -Xq -v ON_ERROR_STOP=1 <<SQL
INSERT INTO telemetry.test_runs (
  run_id,telemetry_schema_version,run_name,started_at,ended_at,status,
  release_sha,release_generation,world_release_id,population_plan_version,
  population_spawn_rules_version,population_candidate_layout_version,
  permanent_stone_placement_version,balance_version,server_instance_id,
  export_status,segment_id,campaign_id,segment_sequence,segment_start_at,
  segment_end_at,segment_duration_seconds
) VALUES
('${ack_run}',1,'ack',now()-interval '1 hour',now()-interval '30 minutes','exported',
 repeat('a',40),'test/t182','world','population','spawn','layout','stone','balance','test',
 'verified','${ack_segment}','${campaign_id}',0,now()-interval '1 hour',now()-interval '30 minutes',3600),
('${hard_run}',1,'hard',now()-interval '7 hours',now()-interval '6 hours','frozen',
 repeat('a',40),'test/t182','world','population','spawn','layout','stone','balance','test',
 'not_exported','${hard_segment}','${campaign_id}',1,now()-interval '7 hours',now()-interval '6 hours',3600),
('${recent_run}',1,'recent',now()-interval '2 hours',now()-interval '1 hour','exported',
 repeat('a',40),'test/t182','world','population','spawn','layout','stone','balance','test',
 'verified','${recent_segment}','${campaign_id}',2,now()-interval '2 hours',now()-interval '1 hour',3600),
('${active_run}',1,'active',now(),NULL,'active',
 repeat('a',40),'test/t182','world','population','spawn','layout','stone','balance','test',
 'not_exported','${active_segment}','${campaign_id}',3,now(),now()+interval '1 hour',3600);

INSERT INTO telemetry.gameplay_events (
  event_id,telemetry_schema_version,run_id,release_sha,release_generation,
  world_release_id,population_plan_version,population_spawn_rules_version,
  balance_version,server_instance_id,event_time,event_family,event_type,
  event_schema_version,priority,metadata
)
SELECT gen_random_uuid(),1,run_id,repeat('a',40),'test/t182','world',
       'population','spawn','balance','test',now(),'session','retention_probe',
       1,'important','{}'::jsonb
FROM telemetry.test_runs WHERE campaign_id='${campaign_id}';

INSERT INTO telemetry.export_receipts (
  receipt_id,telemetry_schema_version,run_id,release_sha,release_generation,
  world_release_id,population_plan_version,population_spawn_rules_version,
  balance_version,server_instance_id,recorded_at,export_path,artifact_format,
  pseudonymized,sha256,artifact_bytes,table_row_counts,table_time_ranges,
  verification_status,verified_at,manifest_version,ready_manifest_path,
  exporter_version,pseudonymization_key_id
)
SELECT
  gen_random_uuid(),1,run_id,repeat('a',40),'test/t182','world','population',
  'spawn','balance','test',now(),
  '/var/lib/ash-atlas/telemetry-exports/'||run_id||'.duckdb','duckdb',true,
  '${sha}',16,'{"gameplay_events":1}','{}','verified',now(),1,
  '/var/lib/ash-atlas/telemetry-exports/'||run_id||'.duckdb.ready.json',
  'retention-test','test-v1'
FROM telemetry.test_runs
WHERE run_id IN ('${ack_run}','${recent_run}');
SQL

for run_id in "$ack_run" "$recent_run"; do
  printf 'artifact-%s\n' "$run_id" >"${TELEMETRY_EXPORT_ROOT}/${run_id}.duckdb"
  printf '%s  %s.duckdb\n' "$sha" "$run_id" \
    >"${TELEMETRY_EXPORT_ROOT}/${run_id}.duckdb.sha256"
  printf '{}\n' >"${TELEMETRY_EXPORT_ROOT}/${run_id}.duckdb.ready.json"
done
printf 'unrelated\n' >"${TELEMETRY_EXPORT_ROOT}/unrelated.keep"
jq -cn \
  --arg segmentId "$ack_segment" \
  --arg runId "$ack_run" \
  --arg artifactSha256 "$sha" \
  --arg acknowledgedAt "$(date -u -d '+1 minute' +%Y-%m-%dT%H:%M:%SZ)" \
  '{manifestVersion:1,segmentId:$segmentId,runId:$runId,
    artifactSha256:$artifactSha256,acknowledgedAt:$acknowledgedAt}' \
  >"${TELEMETRY_ACK_ROOT}/${ack_segment}.ack.json"

bash "$script_dir/retain-telemetry-segments.sh"

result="$(
  psql "$TELEMETRY_TEST_DATABASE_URL" -XAtq -v ON_ERROR_STOP=1 -F '|' \
    -c "SELECT run.run_name,run.retention_status,
               COALESCE(receipt.deletion_reason,''),
               COALESCE(receipt.archival_data_lost::text,'')
        FROM telemetry.test_runs AS run
        LEFT JOIN telemetry.segment_retention_receipts AS receipt
          ON receipt.run_id=run.run_id
        WHERE run.campaign_id='${campaign_id}'
        ORDER BY run.segment_sequence"
)"
grep -qx 'ack|deleted|acknowledged|false' <<<"$result"
grep -qx 'hard|deleted|hard_age_limit|true' <<<"$result"
grep -qx 'recent|retained||' <<<"$result"
grep -qx 'active|retained||' <<<"$result"
[[ "$(
  psql "$TELEMETRY_TEST_DATABASE_URL" -XAtq -v ON_ERROR_STOP=1 \
    -c "SELECT count(*) FROM telemetry.gameplay_events
        WHERE run_id IN ('${recent_run}','${active_run}')"
)" == "2" ]]
[[ ! -e "${TELEMETRY_EXPORT_ROOT}/${ack_run}.duckdb" ]]
[[ -e "${TELEMETRY_EXPORT_ROOT}/${recent_run}.duckdb" ]]
[[ -e "${TELEMETRY_EXPORT_ROOT}/unrelated.keep" ]]

echo "telemetry segment retention tests passed"
