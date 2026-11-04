#!/usr/bin/env bash
set -euo pipefail

run_id=""
artifact_format="duckdb"
while (($#)); do
  case "$1" in
    --run-id) run_id="${2:-}"; shift 2 ;;
    --format) artifact_format="${2:-}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[[ "$run_id" =~ ^[0-9a-fA-F-]{36}$ ]] || {
  echo "--run-id must be a UUID" >&2
  exit 2
}
[[ "$artifact_format" == "duckdb" || "$artifact_format" == "parquet" ]] || {
  echo "--format must be duckdb or parquet" >&2
  exit 2
}
: "${TELEMETRY_EXPORT_DATABASE_URL:?read-only exporter URL is required}"
: "${TELEMETRY_OPERATOR_DATABASE_URL:?operator URL is required for the receipt}"
: "${TELEMETRY_EXPORT_PSEUDONYM_SALT:?export pseudonym salt is required}"
manifest_version=1
exporter_version="${TELEMETRY_EXPORTER_VERSION:-closed-test-telemetry-export-v2}"
pseudonymization_key_id="${TELEMETRY_EXPORT_PSEUDONYM_KEY_ID:-closed-test-v1}"
pull_user="${TELEMETRY_PULL_USER:-}"
[[ "$exporter_version" =~ ^[A-Za-z0-9._-]{1,80}$ ]] || {
  echo "invalid TELEMETRY_EXPORTER_VERSION" >&2
  exit 2
}
[[ "$pseudonymization_key_id" =~ ^[A-Za-z0-9._-]{1,80}$ ]] || {
  echo "invalid TELEMETRY_EXPORT_PSEUDONYM_KEY_ID" >&2
  exit 2
}
[[ -z "$pull_user" || "$pull_user" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || {
  echo "invalid TELEMETRY_PULL_USER" >&2
  exit 2
}

for command in \
  duckdb psql jq sha256sum flock stat df awk sed install find sort xargs \
  du date mktemp mv rm chmod cat sync basename tar; do
  command -v "$command" >/dev/null || {
    echo "required command is missing: $command" >&2
    exit 1
  }
done
if [[ -n "$pull_user" ]]; then
  command -v setfacl >/dev/null || {
    echo "setfacl is required when TELEMETRY_PULL_USER is configured" >&2
    exit 1
  }
fi

export_root="${TELEMETRY_EXPORT_ROOT:-/var/lib/ash-atlas/telemetry-exports}"
[[ "$export_root" == "/var/lib/ash-atlas/telemetry-exports" ||
   "$export_root" == /var/lib/ash-atlas/telemetry-exports/* ||
   (
     "${TELEMETRY_TEST_MODE:-false}" == "true"
     && "$export_root" == /tmp/ash-atlas-telemetry-test.*/*
   ) ]] || {
  echo "export root must remain under /var/lib/ash-atlas/telemetry-exports" >&2
  exit 2
}
install -d -m 0700 "$export_root"
[[ -z "$pull_user" ]] || setfacl -m "u:${pull_user}:r-x" "$export_root"
exec 9>"/run/lock/ash-atlas-telemetry-export.lock"
flock -n 9 || {
  echo "another telemetry export is running" >&2
  exit 1
}

run_manifest="$(
  psql "$TELEMETRY_EXPORT_DATABASE_URL" -XAtq -v ON_ERROR_STOP=1 \
    -c "SELECT json_build_object(
          'status',status,
          'ingestionClosedAt',ingestion_closed_at,
          'segmentId',segment_id,
          'campaignId',campaign_id,
          'segmentSequence',segment_sequence,
          'segmentStartAt',segment_start_at,
          'segmentEndAt',segment_end_at,
          'releaseSha',release_sha,
          'releaseGeneration',release_generation,
          'worldReleaseId',world_release_id
          ,'populationPlanVersion',population_plan_version
          ,'populationSpawnRulesVersion',population_spawn_rules_version
          ,'balanceVersion',balance_version
        )::text
        FROM telemetry.test_runs WHERE run_id='${run_id}'::uuid"
)"
[[ -n "$run_manifest" ]] || {
  echo "telemetry run was not found" >&2
  exit 1
}
run_status="$(jq -r '.status' <<<"$run_manifest")"
ingestion_closed_at="$(jq -r '.ingestionClosedAt // empty' <<<"$run_manifest")"
segment_id="$(jq -r '.segmentId // empty' <<<"$run_manifest")"
[[ -n "$segment_id" ]] || segment_id="$run_id"
[[ "$run_status" == "frozen" || "$run_status" == "exported" ]] || {
  echo "run must be frozen before export" >&2
  exit 1
}
[[ -n "$ingestion_closed_at" ]] || {
  echo "run ingestion has not closed; wait for the game telemetry drain" >&2
  exit 1
}

available_bytes="$(df -PB1 "$export_root" | awk 'NR==2 {print $4}')"
minimum_free_bytes="${TELEMETRY_EXPORT_MINIMUM_FREE_BYTES:-1073741824}"
(( available_bytes >= minimum_free_bytes )) || {
  echo "insufficient export disk headroom" >&2
  exit 1
}

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
base="$export_root/run-${run_id}-${stamp}"
database_partial="${base}.duckdb.partial"
database_final="${base}.duckdb"
parquet_partial="${base}.parquet.partial"
parquet_bundle_partial="${base}.parquet.tar.partial"
parquet_final="${base}.parquet.tar"
sql_file="$(mktemp "$export_root/.export-sql.XXXXXX")"
chmod 0600 "$sql_file"
export_completed=false
published_paths=()
checksum_path=""
ready_manifest_path=""
ready_manifest_partial=""
cleanup() {
  local exit_code=$?
  set +e
  rm -f -- "$sql_file" "$database_partial" "$parquet_bundle_partial"
  if [[ -d "$parquet_partial" ]]; then rm -rf -- "$parquet_partial"; fi
  if ((exit_code != 0)) && [[ "$export_completed" != "true" ]]; then
    for published_path in "${published_paths[@]}"; do
      if [[ -d "$published_path" ]]; then
        rm -rf -- "$published_path"
      else
        rm -f -- "$published_path"
      fi
    done
    [[ -z "$ready_manifest_partial" ]] || rm -f -- "$ready_manifest_partial"
    local failed_path="${base}.failed"
    local failure_receipt_id
    failure_receipt_id="$(cat /proc/sys/kernel/random/uuid)"
    printf 'telemetry export failed: %s\n' "$failure_receipt_id" >"$failed_path"
    chmod 0600 "$failed_path"
    local failed_sha
    local failed_bytes
    failed_sha="$(sha256sum "$failed_path" | awk '{print $1}')"
    failed_bytes="$(stat -c '%s' "$failed_path")"
    if ! psql "$TELEMETRY_OPERATOR_DATABASE_URL" -Xq -v ON_ERROR_STOP=1 \
      -v receipt_id="$failure_receipt_id" \
      -v run_id="$run_id" \
      -v artifact_path="$failed_path" \
      -v artifact_format="$artifact_format" \
      -v artifact_sha="$failed_sha" \
      -v artifact_bytes="$failed_bytes" <<'SQL'
BEGIN;
INSERT INTO telemetry.export_receipts (
  receipt_id, telemetry_schema_version, run_id, release_sha,
  release_generation, world_release_id, population_plan_version,
  population_spawn_rules_version, balance_version, server_instance_id,
  recorded_at, export_path, artifact_format, pseudonymized, sha256,
  artifact_bytes, table_row_counts, table_time_ranges,
  verification_status, verified_at
)
SELECT
  :'receipt_id'::uuid, 1, run_id, release_sha, release_generation,
  world_release_id, population_plan_version, population_spawn_rules_version,
  balance_version, server_instance_id, clock_timestamp(), :'artifact_path',
  :'artifact_format', false, :'artifact_sha', :'artifact_bytes'::bigint,
  '{"failure_marker":1}'::jsonb, '{}'::jsonb, 'failed', clock_timestamp()
FROM telemetry.test_runs
WHERE run_id=:'run_id'::uuid AND status IN ('frozen','exported');
UPDATE telemetry.test_runs
SET export_status='failed', updated_at=clock_timestamp()
WHERE run_id=:'run_id'::uuid
  AND status='frozen'
  AND export_status <> 'verified';
COMMIT;
SQL
    then
      echo "failed to record telemetry export failure receipt" >&2
    fi
  fi
  exit "$exit_code"
}
trap cleanup EXIT

escaped_export_url="$(printf '%s' "$TELEMETRY_EXPORT_DATABASE_URL" | sed "s/'/''/g")"
escaped_salt="$(printf '%s' "$TELEMETRY_EXPORT_PSEUDONYM_SALT" | sed "s/'/''/g")"
cat >"$sql_file" <<SQL
INSTALL postgres;
LOAD postgres;
ATTACH '${escaped_export_url}' AS source (TYPE POSTGRES, READ_ONLY);
CREATE TEMP MACRO pseudonym(value) AS
  CASE WHEN value IS NULL THEN NULL
       ELSE sha256('${escaped_salt}' || ':' || CAST(value AS VARCHAR))
  END;
CREATE TABLE test_runs AS
  SELECT * FROM source.telemetry.test_runs WHERE run_id='${run_id}'::UUID;
CREATE TABLE server_samples AS
  SELECT * FROM source.telemetry.server_samples WHERE run_id='${run_id}'::UUID;
CREATE TABLE world_samples AS
  SELECT * FROM source.telemetry.world_samples WHERE run_id='${run_id}'::UUID;
CREATE TABLE gameplay_events AS
  SELECT * EXCLUDE (
           player_id, other_actor_id, target_id, session_id, operation_id
         ),
         pseudonym(player_id) AS player_id,
         pseudonym(other_actor_id) AS other_actor_id,
         pseudonym(target_id) AS target_id,
         pseudonym(session_id) AS session_id,
         pseudonym(operation_id) AS operation_id
  FROM source.telemetry.gameplay_events WHERE run_id='${run_id}'::UUID;
CREATE TABLE player_snapshots AS
  SELECT * EXCLUDE (player_id, session_id),
         pseudonym(player_id) AS player_id,
         pseudonym(session_id) AS session_id
  FROM source.telemetry.player_snapshots WHERE run_id='${run_id}'::UUID;
CREATE TABLE player_inventory_snapshots AS
  SELECT * EXCLUDE (player_id, session_id),
         pseudonym(player_id) AS player_id,
         pseudonym(session_id) AS session_id
  FROM source.telemetry.player_inventory_snapshots WHERE run_id='${run_id}'::UUID;
CREATE TABLE client_samples AS
  SELECT * EXCLUDE (player_id, session_id),
         pseudonym(player_id) AS player_id,
         pseudonym(session_id) AS session_id
  FROM source.telemetry.client_samples WHERE run_id='${run_id}'::UUID;
CREATE TABLE session_summaries AS
  SELECT * EXCLUDE (player_id, session_id),
         pseudonym(player_id) AS player_id,
         pseudonym(session_id) AS session_id
  FROM source.telemetry.session_summaries WHERE run_id='${run_id}'::UUID;
CREATE TABLE bug_reports AS
  SELECT * EXCLUDE (player_id, session_id),
         pseudonym(player_id) AS player_id,
         pseudonym(session_id) AS session_id
  FROM source.telemetry.bug_reports WHERE run_id='${run_id}'::UUID;
CREATE TABLE bug_report_context AS
  SELECT context.* EXCLUDE (
           client_state, authoritative_player_state, nearby_entities,
           related_operation_ids
         ),
         CAST(
           replace(
             CAST(context.client_state AS VARCHAR),
             CAST(report.player_id AS VARCHAR),
             pseudonym(report.player_id)
           ) AS JSON
         ) AS client_state,
         CAST(
           replace(
             CAST(context.authoritative_player_state AS VARCHAR),
             CAST(report.player_id AS VARCHAR),
             pseudonym(report.player_id)
           ) AS JSON
         ) AS authoritative_player_state,
         CAST(
           replace(
             CAST(context.nearby_entities AS VARCHAR),
             CAST(report.player_id AS VARCHAR),
             pseudonym(report.player_id)
           ) AS JSON
         ) AS nearby_entities,
         list_transform(
           context.related_operation_ids,
           operation_id -> pseudonym(operation_id)
         ) AS related_operation_ids
  FROM source.telemetry.bug_report_context AS context
  INNER JOIN source.telemetry.bug_reports AS report
    ON report.report_id=context.report_id
  WHERE report.run_id='${run_id}'::UUID;
CREATE TABLE authoritative_progression_events AS
  SELECT * EXCLUDE (player_id, operation_id),
         pseudonym(player_id) AS player_id,
         pseudonym(operation_id) AS operation_id
  FROM source.telemetry.authoritative_progression_events
  WHERE event_time >= (
    SELECT started_at FROM source.telemetry.test_runs WHERE run_id='${run_id}'::UUID
  ) AND event_time <= (
    SELECT COALESCE(ended_at,now()) FROM source.telemetry.test_runs
    WHERE run_id='${run_id}'::UUID
  );
CREATE TABLE authoritative_inventory_events AS
  SELECT * EXCLUDE (player_id, operation_id),
         pseudonym(player_id) AS player_id,
         pseudonym(operation_id) AS operation_id
  FROM source.telemetry.authoritative_inventory_events
  WHERE event_time >= (
    SELECT started_at FROM source.telemetry.test_runs WHERE run_id='${run_id}'::UUID
  ) AND event_time <= (
    SELECT COALESCE(ended_at,now()) FROM source.telemetry.test_runs
    WHERE run_id='${run_id}'::UUID
  );
CREATE TABLE authoritative_wallet_events AS
  SELECT * EXCLUDE (player_id, operation_id),
         pseudonym(player_id) AS player_id,
         pseudonym(operation_id) AS operation_id
  FROM source.telemetry.authoritative_wallet_events
  WHERE event_time >= (
    SELECT started_at FROM source.telemetry.test_runs WHERE run_id='${run_id}'::UUID
  ) AND event_time <= (
    SELECT COALESCE(ended_at,now()) FROM source.telemetry.test_runs
    WHERE run_id='${run_id}'::UUID
  );
CREATE TABLE authoritative_market_trades AS
  SELECT * EXCLUDE (buyer_player_id, seller_player_id),
         pseudonym(buyer_player_id) AS buyer_player_id,
         pseudonym(seller_player_id) AS seller_player_id
  FROM source.telemetry.authoritative_market_trades
  WHERE event_time >= (
    SELECT started_at FROM source.telemetry.test_runs WHERE run_id='${run_id}'::UUID
  ) AND event_time <= (
    SELECT COALESCE(ended_at,now()) FROM source.telemetry.test_runs
    WHERE run_id='${run_id}'::UUID
  );
CREATE TABLE authoritative_combat_summaries AS
  SELECT * EXCLUDE (player_id, combat_session_id),
         pseudonym(player_id) AS player_id,
         pseudonym(combat_session_id) AS combat_session_id
  FROM source.telemetry.authoritative_combat_summaries
  WHERE ended_at >= (
    SELECT started_at FROM source.telemetry.test_runs WHERE run_id='${run_id}'::UUID
  ) AND ended_at <= (
    SELECT COALESCE(ended_at,now()) FROM source.telemetry.test_runs
    WHERE run_id='${run_id}'::UUID
  );
CREATE TABLE telemetry_health AS
  SELECT * FROM source.telemetry.telemetry_health WHERE run_id='${run_id}'::UUID;
CHECKPOINT;
DETACH source;
SQL

duckdb "$database_partial" <"$sql_file" >/dev/null
chmod 0600 "$database_partial"

tables=(
  test_runs server_samples world_samples gameplay_events player_snapshots
  player_inventory_snapshots client_samples session_summaries
  bug_reports bug_report_context
  authoritative_progression_events authoritative_inventory_events
  authoritative_wallet_events authoritative_market_trades
  authoritative_combat_summaries telemetry_health
)
row_counts='{}'
time_ranges='{}'
for table in "${tables[@]}"; do
  count="$(duckdb -noheader -csv "$database_partial" "SELECT count(*) FROM \"$table\"")"
  row_counts="$(jq -c --arg table "$table" --argjson count "$count" \
    '. + {($table): $count}' <<<"$row_counts")"
done
[[ "$(jq -r '.test_runs' <<<"$row_counts")" == "1" ]] || {
  echo "test-run manifest row-count verification failed" >&2
  exit 1
}
for table in \
  server_samples world_samples gameplay_events player_snapshots \
  player_inventory_snapshots client_samples session_summaries; do
  artifact_count="$(jq -r --arg table "$table" '.[$table]' <<<"$row_counts")"
  source_count="$(
    psql "$TELEMETRY_EXPORT_DATABASE_URL" -XAtq -v ON_ERROR_STOP=1 \
      -c "SELECT count(*) FROM telemetry.${table} WHERE run_id='${run_id}'::uuid"
  )"
  [[ "$artifact_count" == "$source_count" ]] || {
    echo "row-count verification failed for $table" >&2
    exit 1
  }
done
for table in bug_reports bug_report_context; do
  artifact_count="$(jq -r --arg table "$table" '.[$table]' <<<"$row_counts")"
  if [[ "$table" == "bug_reports" ]]; then
    source_predicate="run_id='${run_id}'::uuid"
  else
    source_predicate="report_id IN (SELECT report_id FROM telemetry.bug_reports WHERE run_id='${run_id}'::uuid)"
  fi
  source_count="$(
    psql "$TELEMETRY_EXPORT_DATABASE_URL" -XAtq -v ON_ERROR_STOP=1 \
      -c "SELECT count(*) FROM telemetry.${table} WHERE ${source_predicate}"
  )"
  [[ "$artifact_count" == "$source_count" ]] || {
    echo "row-count verification failed for $table" >&2
    exit 1
  }
done
for table_and_time in \
  "authoritative_progression_events event_time" \
  "authoritative_inventory_events event_time" \
  "authoritative_wallet_events event_time" \
  "authoritative_market_trades event_time" \
  "authoritative_combat_summaries ended_at"; do
  read -r table timestamp_column <<<"$table_and_time"
  artifact_count="$(jq -r --arg table "$table" '.[$table]' <<<"$row_counts")"
  source_count="$(
    psql "$TELEMETRY_EXPORT_DATABASE_URL" -XAtq -v ON_ERROR_STOP=1 \
      -c "SELECT count(*) FROM telemetry.${table} WHERE ${timestamp_column} >= (SELECT started_at FROM telemetry.test_runs WHERE run_id='${run_id}'::uuid) AND ${timestamp_column} <= (SELECT COALESCE(ended_at,now()) FROM telemetry.test_runs WHERE run_id='${run_id}'::uuid)"
  )"
  [[ "$artifact_count" == "$source_count" ]] || {
    echo "row-count verification failed for $table" >&2
    exit 1
  }
done
for table_and_time in \
  "server_samples recorded_at" \
  "world_samples recorded_at" \
  "gameplay_events event_time" \
  "player_snapshots recorded_at" \
  "player_inventory_snapshots recorded_at" \
  "client_samples recorded_at" \
  "session_summaries session_ended_at" \
  "bug_reports submitted_at" \
  "bug_report_context created_at"; do
  read -r table timestamp_column <<<"$table_and_time"
  minimum="$(duckdb -noheader -csv "$database_partial" \
    "SELECT coalesce(cast(min(\"$timestamp_column\") AS varchar),'') FROM \"$table\"")"
  maximum="$(duckdb -noheader -csv "$database_partial" \
    "SELECT coalesce(cast(max(\"$timestamp_column\") AS varchar),'') FROM \"$table\"")"
  range="$(jq -cn --arg minimum "$minimum" --arg maximum "$maximum" \
    '{minimum:(if $minimum=="" then null else $minimum end),maximum:(if $maximum=="" then null else $maximum end)}')"
  time_ranges="$(jq -c --arg table "$table" --argjson range "$range" \
    '. + {($table): $range}' <<<"$time_ranges")"
done
for table_and_time in \
  "authoritative_progression_events event_time" \
  "authoritative_inventory_events event_time" \
  "authoritative_wallet_events event_time" \
  "authoritative_market_trades event_time" \
  "authoritative_combat_summaries ended_at"; do
  read -r table timestamp_column <<<"$table_and_time"
  minimum="$(duckdb -noheader -csv "$database_partial" \
    "SELECT coalesce(cast(min(\"$timestamp_column\") AS varchar),'') FROM \"$table\"")"
  maximum="$(duckdb -noheader -csv "$database_partial" \
    "SELECT coalesce(cast(max(\"$timestamp_column\") AS varchar),'') FROM \"$table\"")"
  range="$(jq -cn --arg minimum "$minimum" --arg maximum "$maximum" \
    '{minimum:(if $minimum=="" then null else $minimum end),maximum:(if $maximum=="" then null else $maximum end)}')"
  time_ranges="$(jq -c --arg table "$table" --argjson range "$range" \
    '. + {($table): $range}' <<<"$time_ranges")"
done

row_counts="$(jq -c '. + {export_manifest:1}' <<<"$row_counts")"
escaped_row_counts="$(printf '%s' "$row_counts" | sed "s/'/''/g")"
escaped_time_ranges="$(printf '%s' "$time_ranges" | sed "s/'/''/g")"
duckdb "$database_partial" <<SQL
CREATE TABLE export_manifest AS
SELECT
  run_id,
  telemetry_schema_version,
  release_sha,
  release_generation,
  world_release_id,
  population_plan_version,
  population_spawn_rules_version,
  balance_version,
  current_timestamp AS exported_at,
  true AS pseudonymized,
  '${escaped_row_counts}'::JSON AS table_row_counts,
  '${escaped_time_ranges}'::JSON AS table_time_ranges
FROM test_runs;
CHECKPOINT;
SQL
tables+=(export_manifest)

artifact_path="$database_final"
artifact_partial="$database_partial"
if [[ "$artifact_format" == "parquet" ]]; then
  install -d -m 0700 "$parquet_partial"
  for table in "${tables[@]}"; do
    duckdb "$database_partial" \
      "COPY \"$table\" TO '${parquet_partial}/${table}.parquet' (FORMAT PARQUET, COMPRESSION ZSTD)"
  done
  chmod 0600 "$parquet_partial"/*.parquet
  tar --sort=name --owner=0 --group=0 --numeric-owner \
    --mtime='UTC 1970-01-01' -cf "$parquet_bundle_partial" \
    -C "$parquet_partial" .
  chmod 0600 "$parquet_bundle_partial"
  rm -rf -- "$parquet_partial"
  artifact_path="$parquet_final"
  artifact_partial="$parquet_bundle_partial"
fi

artifact_sha="$(sha256sum "$artifact_partial" | awk '{print $1}')"
artifact_bytes="$(stat -c '%s' "$artifact_partial")"
mv -- "$artifact_partial" "$artifact_path"
published_paths+=("$artifact_path")
sync -f "$artifact_path"
[[ -z "$pull_user" ]] || setfacl -m "u:${pull_user}:r" "$artifact_path"

checksum_path="${artifact_path}.sha256"
checksum_partial="${checksum_path}.partial"
printf '%s  %s\n' "$artifact_sha" "$(basename "$artifact_path")" >"$checksum_partial"
chmod 0600 "$checksum_partial"
sync -f "$checksum_partial"
mv -- "$checksum_partial" "$checksum_path"
published_paths+=("$checksum_path")
[[ -z "$pull_user" ]] || setfacl -m "u:${pull_user}:r" "$checksum_path"

ready_manifest_path="${artifact_path}.ready.json"
ready_manifest_partial="${ready_manifest_path}.partial"
created_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
jq -cn \
  --argjson manifestVersion "$manifest_version" \
  --arg segmentId "$segment_id" \
  --arg runId "$run_id" \
  --arg artifact "$(basename "$artifact_path")" \
  --arg checksum "$(basename "$checksum_path")" \
  --arg format "$artifact_format" \
  --arg sha256 "$artifact_sha" \
  --argjson bytes "$artifact_bytes" \
  --argjson rowCounts "$row_counts" \
  --argjson run "$run_manifest" \
  --arg createdAt "$created_at" \
  --arg exporterVersion "$exporter_version" \
  --arg pseudonymizationKeyId "$pseudonymization_key_id" \
  '{
    manifestVersion:$manifestVersion,
    segmentId:$segmentId,
    runId:$runId,
    campaignId:$run.campaignId,
    segmentSequence:$run.segmentSequence,
    segmentStartAt:$run.segmentStartAt,
    segmentEndAt:$run.segmentEndAt,
    releaseSha:$run.releaseSha,
    releaseGeneration:$run.releaseGeneration,
    worldReleaseId:$run.worldReleaseId,
    populationPlanVersion:$run.populationPlanVersion,
    populationSpawnRulesVersion:$run.populationSpawnRulesVersion,
    balanceVersion:$run.balanceVersion,
    artifact:{fileName:$artifact,checksumFileName:$checksum,format:$format,bytes:$bytes,sha256:$sha256},
    tableRowCounts:$rowCounts,
    createdAt:$createdAt,
    verifiedAt:$createdAt,
    exporterVersion:$exporterVersion,
    pseudonymizationKeyId:$pseudonymizationKeyId,
    acknowledgmentState:"unacknowledged"
  }' >"$ready_manifest_partial"
chmod 0600 "$ready_manifest_partial"
[[ -z "$pull_user" ]] || setfacl -m "u:${pull_user}:r" "$ready_manifest_partial"
sync -f "$ready_manifest_partial"

receipt_id="$(cat /proc/sys/kernel/random/uuid)"
psql "$TELEMETRY_OPERATOR_DATABASE_URL" -Xq -v ON_ERROR_STOP=1 \
  -v receipt_id="$receipt_id" \
  -v run_id="$run_id" \
  -v artifact_path="$artifact_path" \
  -v artifact_format="$artifact_format" \
  -v artifact_sha="$artifact_sha" \
  -v artifact_bytes="$artifact_bytes" \
  -v row_counts="$row_counts" \
  -v time_ranges="$time_ranges" \
  -v manifest_version="$manifest_version" \
  -v ready_manifest_path="$ready_manifest_path" \
  -v exporter_version="$exporter_version" \
  -v pseudonymization_key_id="$pseudonymization_key_id" <<'SQL'
BEGIN;
INSERT INTO telemetry.export_receipts (
  receipt_id, telemetry_schema_version, run_id, release_sha,
  release_generation, world_release_id, population_plan_version,
  population_spawn_rules_version, balance_version, server_instance_id,
  recorded_at, export_path, artifact_format, pseudonymized, sha256,
  artifact_bytes, table_row_counts, table_time_ranges,
  verification_status, verified_at, manifest_version, ready_manifest_path,
  exporter_version, pseudonymization_key_id
)
SELECT
  :'receipt_id'::uuid, 1, run_id, release_sha, release_generation,
  world_release_id, population_plan_version, population_spawn_rules_version,
  balance_version, server_instance_id, clock_timestamp(), :'artifact_path',
  :'artifact_format', true, :'artifact_sha', :'artifact_bytes'::bigint,
  :'row_counts'::jsonb, :'time_ranges'::jsonb, 'verified', clock_timestamp(),
  :'manifest_version'::integer, :'ready_manifest_path', :'exporter_version',
  :'pseudonymization_key_id'
FROM telemetry.test_runs
WHERE run_id=:'run_id'::uuid AND status IN ('frozen','exported');
UPDATE telemetry.test_runs
SET status='exported', export_status='verified', updated_at=clock_timestamp()
WHERE run_id=:'run_id'::uuid AND status IN ('frozen','exported');
UPDATE telemetry.bug_reports
SET export_status='exported',
    exported_at=COALESCE(exported_at,clock_timestamp()),
    updated_at=clock_timestamp()
WHERE run_id=:'run_id'::uuid
  AND export_status IN ('pending','failed');
COMMIT;
SQL
receipt_recorded="$(
  psql "$TELEMETRY_OPERATOR_DATABASE_URL" -XAtq -v ON_ERROR_STOP=1 \
    -c "SELECT count(*) FROM telemetry.export_receipts
        WHERE receipt_id='${receipt_id}'::uuid
          AND run_id='${run_id}'::uuid
          AND verification_status='verified'"
)"
[[ "$receipt_recorded" == "1" ]] || {
  echo "verified telemetry export receipt was not persisted" >&2
  exit 1
}
mv -- "$ready_manifest_partial" "$ready_manifest_path"
published_paths+=("$ready_manifest_path")
sync -f "$ready_manifest_path"
export_completed=true

jq -n \
  --arg runId "$run_id" \
  --arg format "$artifact_format" \
  --arg path "$artifact_path" \
  --arg readyManifestPath "$ready_manifest_path" \
  --arg sha256 "$artifact_sha" \
  --argjson bytes "$artifact_bytes" \
  --argjson rowCounts "$row_counts" \
  --argjson timeRanges "$time_ranges" \
  '{runId:$runId,format:$format,path:$path,readyManifestPath:$readyManifestPath,sha256:$sha256,bytes:$bytes,rowCounts:$rowCounts,timeRanges:$timeRanges}'
