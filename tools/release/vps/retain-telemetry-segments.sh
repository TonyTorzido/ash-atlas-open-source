#!/usr/bin/env bash
set -euo pipefail
umask 077

: "${TELEMETRY_OPERATOR_DATABASE_URL:?operator URL is required}"
export_root="${TELEMETRY_EXPORT_ROOT:-/var/lib/ash-atlas/telemetry-exports}"
ack_root="${TELEMETRY_ACK_ROOT:-/var/lib/ash-atlas/telemetry-acknowledgments}"
completed_limit="${TELEMETRY_COMPLETED_SEGMENT_LIMIT:-5}"
hard_age_seconds="${TELEMETRY_HARD_MAX_AGE_SECONDS:-604800}"
ack_grace_seconds="${TELEMETRY_ACK_GRACE_SECONDS:-600}"
emergency_byte_cap="${TELEMETRY_EMERGENCY_BYTE_CAP:-0}"

[[ "$export_root" == "/var/lib/ash-atlas/telemetry-exports" ||
   (
     "${TELEMETRY_TEST_MODE:-false}" == "true"
     && "$export_root" == /tmp/ash-atlas-telemetry-test.*/*
   ) ]] || exit 2
[[ "$ack_root" == "/var/lib/ash-atlas/telemetry-acknowledgments" ||
   (
     "${TELEMETRY_TEST_MODE:-false}" == "true"
     && "$ack_root" == /tmp/ash-atlas-telemetry-test.*/*
   ) ]] || exit 2
for value in "$completed_limit" "$hard_age_seconds" "$ack_grace_seconds" "$emergency_byte_cap"; do
  [[ "$value" =~ ^[0-9]+$ ]] || {
    echo "retention settings must be non-negative integers" >&2
    exit 2
  }
done
(( completed_limit <= 48 )) || exit 2
(( hard_age_seconds >= 3600 && hard_age_seconds <= 604800 )) || exit 2

exec 9>"/run/lock/ash-atlas-telemetry-retention.lock"
flock -n 9 || exit 0

ingest_acknowledgments() {
  local marker
  shopt -s nullglob
  for marker in "$ack_root"/*.ack.json; do
    [[ -f "$marker" && ! -L "$marker" ]] || continue
    jq -e '
      .manifestVersion == 1
      and (.segmentId | test("^[0-9a-fA-F-]{36}$"))
      and (.runId | test("^[0-9a-fA-F-]{36}$"))
      and (.artifactSha256 | test("^[a-f0-9]{64}$"))
      and (.acknowledgedAt | type == "string")
    ' "$marker" >/dev/null || continue
    segment_id="$(jq -r '.segmentId' "$marker")"
    run_id="$(jq -r '.runId' "$marker")"
    artifact_sha="$(jq -r '.artifactSha256' "$marker")"
    acknowledged_at="$(jq -r '.acknowledgedAt' "$marker")"
    psql "$TELEMETRY_OPERATOR_DATABASE_URL" -Xq -v ON_ERROR_STOP=1 \
      -v acknowledgment_id="$(cat /proc/sys/kernel/random/uuid)" \
      -v segment_id="$segment_id" \
      -v run_id="$run_id" \
      -v artifact_sha="$artifact_sha" \
      -v acknowledged_at="$acknowledged_at" <<'SQL'
WITH acknowledgment AS (
  INSERT INTO telemetry.segment_acknowledgments (
    acknowledgment_id, telemetry_schema_version, manifest_version, segment_id,
    run_id, artifact_sha256, acknowledged_at
  )
  SELECT
    :'acknowledgment_id'::uuid, 1, 1, run.segment_id, run.run_id,
    receipt.sha256, :'acknowledged_at'::timestamptz
  FROM telemetry.test_runs AS run
  JOIN LATERAL (
    SELECT sha256, verified_at
    FROM telemetry.export_receipts
    WHERE run_id=run.run_id
      AND verification_status='verified'
      AND manifest_version=1
    ORDER BY recorded_at DESC
    LIMIT 1
  ) AS receipt ON true
  WHERE run.segment_id=:'segment_id'::uuid
    AND run.run_id=:'run_id'::uuid
    AND receipt.sha256=:'artifact_sha'
    AND :'acknowledged_at'::timestamptz >= receipt.verified_at
    AND :'acknowledged_at'::timestamptz <= clock_timestamp()+interval '5 minutes'
  ON CONFLICT (segment_id) DO UPDATE
    SET acknowledged_at=EXCLUDED.acknowledged_at
  RETURNING run_id
)
UPDATE telemetry.bug_reports
SET export_status='acknowledged',
    acknowledged_at=COALESCE(acknowledged_at,:'acknowledged_at'::timestamptz),
    updated_at=clock_timestamp()
WHERE run_id IN (SELECT run_id FROM acknowledgment)
  AND export_status='exported';
SQL
  done
}

safe_unlink() {
  local path="$1"
  [[ -n "$path" && "$path" == "$export_root/"* ]] || return 1
  [[ "$(dirname -- "$path")" == "$export_root" ]] || return 1
  [[ ! -L "$path" ]] || {
    echo "refusing telemetry spool symlink: $path" >&2
    return 1
  }
  [[ ! -e "$path" ]] || rm -f -- "$path"
}

cleanup_spool_for_run() {
  local run_id="$1"
  local segment_id="$2"
  local export_path ready_path
  while IFS=$'\t' read -r export_path ready_path; do
    [[ -n "$export_path" ]] || continue
    safe_unlink "$ready_path" || true
    safe_unlink "${export_path}.sha256" || true
    safe_unlink "$export_path" || true
  done < <(
    psql "$TELEMETRY_OPERATOR_DATABASE_URL" -XAtq -F $'\t' -v ON_ERROR_STOP=1 \
      -c "SELECT export_path, COALESCE(ready_manifest_path,'')
          FROM telemetry.export_receipts
          WHERE run_id='${run_id}'::uuid"
  )
  local ack_marker="${ack_root}/${segment_id}.ack.json"
  if [[ -f "$ack_marker" && ! -L "$ack_marker" ]]; then
    rm -f -- "$ack_marker"
  fi
}

spool_bytes_for_run() {
  local run_id="$1"
  local total=0
  local export_path ready_path path
  while IFS=$'\t' read -r export_path ready_path; do
    for path in "$export_path" "${export_path}.sha256" "$ready_path"; do
      [[ -n "$path" && "$path" == "$export_root/"* ]] || continue
      [[ "$(dirname -- "$path")" == "$export_root" ]] || continue
      [[ -f "$path" && ! -L "$path" ]] || continue
      total=$((total + $(stat -c '%s' "$path")))
    done
  done < <(
    psql "$TELEMETRY_OPERATOR_DATABASE_URL" -XAtq -F $'\t' -v ON_ERROR_STOP=1 \
      -c "SELECT export_path, COALESCE(ready_manifest_path,'')
          FROM telemetry.export_receipts
          WHERE run_id='${run_id}'::uuid"
  )
  printf '%s\n' "$total"
}

ingest_acknowledgments

# Finish filesystem cleanup if an earlier process stopped after the database commit.
while IFS=$'\t' read -r run_id segment_id; do
  cleanup_spool_for_run "$run_id" "$segment_id"
done < <(
  psql "$TELEMETRY_OPERATOR_DATABASE_URL" -XAtq -F $'\t' -v ON_ERROR_STOP=1 \
    -c "SELECT run_id, segment_id
        FROM telemetry.test_runs
        WHERE segment_id IS NOT NULL AND retention_status='deleted'"
)

mapfile -t candidates < <(
  psql "$TELEMETRY_OPERATOR_DATABASE_URL" -XAtq -F $'\t' -v ON_ERROR_STOP=1 \
    -v completed_limit="$completed_limit" \
    -v hard_age_seconds="$hard_age_seconds" \
    -v ack_grace_seconds="$ack_grace_seconds" \
    -v emergency_byte_cap="$emergency_byte_cap" <<'SQL'
WITH completed AS (
  SELECT
    run.run_id,
    run.segment_id,
    run.segment_start_at,
    run.segment_end_at,
    run.protected_from_retention,
    row_number() OVER (ORDER BY run.segment_end_at DESC, run.run_id DESC) AS completed_rank,
    acknowledgment.received_at AS acknowledged_at,
    receipt.artifact_bytes,
    receipt.verification_status,
    sum(COALESCE(receipt.artifact_bytes,0)) OVER (
      ORDER BY run.segment_end_at DESC, run.run_id DESC
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS newer_spool_bytes
  FROM telemetry.test_runs AS run
  LEFT JOIN telemetry.segment_acknowledgments AS acknowledgment
    ON acknowledgment.run_id=run.run_id
  LEFT JOIN LATERAL (
    SELECT artifact_bytes, verification_status
    FROM telemetry.export_receipts
    WHERE run_id=run.run_id
    ORDER BY recorded_at DESC
    LIMIT 1
  ) AS receipt ON true
  WHERE run.segment_id IS NOT NULL
    AND run.status <> 'active'
    AND run.retention_status='retained'
)
SELECT
  run_id,
  segment_id,
  CASE
    WHEN segment_start_at <= clock_timestamp()-(:'hard_age_seconds'||' seconds')::interval
      THEN 'hard_age_limit'
    WHEN NOT protected_from_retention
         AND acknowledged_at <= clock_timestamp()-(:'ack_grace_seconds'||' seconds')::interval
      THEN 'acknowledged'
    WHEN NOT protected_from_retention
         AND completed_rank > :'completed_limit'::integer
         AND acknowledged_at IS NOT NULL
         AND verification_status='verified'
      THEN 'completed_segment_limit'
    WHEN NOT protected_from_retention
         AND :'emergency_byte_cap'::bigint > 0
         AND newer_spool_bytes > :'emergency_byte_cap'::bigint
         AND verification_status='verified'
      THEN 'emergency_byte_cap'
  END
FROM completed
WHERE
  segment_start_at <= clock_timestamp()-(:'hard_age_seconds'||' seconds')::interval
  OR (
    NOT protected_from_retention
    AND acknowledged_at <= clock_timestamp()-(:'ack_grace_seconds'||' seconds')::interval
  )
  OR (
    NOT protected_from_retention
    AND completed_rank > :'completed_limit'::integer
    AND acknowledged_at IS NOT NULL
    AND verification_status='verified'
  )
  OR (
    NOT protected_from_retention
    AND
    :'emergency_byte_cap'::bigint > 0
    AND newer_spool_bytes > :'emergency_byte_cap'::bigint
    AND verification_status='verified'
  )
ORDER BY segment_end_at;
SQL
)

for candidate in "${candidates[@]}"; do
  IFS=$'\t' read -r run_id segment_id reason <<<"$candidate"
  [[ "$run_id" =~ ^[0-9a-fA-F-]{36}$ ]] || exit 1
  [[ "$segment_id" =~ ^[0-9a-fA-F-]{36}$ ]] || exit 1
  case "$reason" in
    acknowledged|completed_segment_limit|hard_age_limit|emergency_byte_cap) ;;
    *) exit 1 ;;
  esac
  artifact_bytes="$(spool_bytes_for_run "$run_id")"
  psql "$TELEMETRY_OPERATOR_DATABASE_URL" -Xq -v ON_ERROR_STOP=1 \
    -v receipt_id="$(cat /proc/sys/kernel/random/uuid)" \
    -v run_id="$run_id" \
    -v segment_id="$segment_id" \
    -v reason="$reason" \
    -v artifact_bytes="$artifact_bytes" <<'SQL'
BEGIN;
WITH locked AS (
  SELECT run.run_id
  FROM telemetry.test_runs AS run
  WHERE run.run_id=:'run_id'::uuid
    AND run.segment_id=:'segment_id'::uuid
    AND run.status <> 'active'
    AND run.retention_status='retained'
    AND (
      NOT run.protected_from_retention
      OR :'reason' = 'hard_age_limit'
    )
  FOR UPDATE
),
d_server AS (
  DELETE FROM telemetry.server_samples WHERE run_id IN (SELECT run_id FROM locked) RETURNING 1
),
d_world AS (
  DELETE FROM telemetry.world_samples WHERE run_id IN (SELECT run_id FROM locked) RETURNING 1
),
d_events AS (
  DELETE FROM telemetry.gameplay_events WHERE run_id IN (SELECT run_id FROM locked) RETURNING 1
),
d_players AS (
  DELETE FROM telemetry.player_snapshots WHERE run_id IN (SELECT run_id FROM locked) RETURNING 1
),
d_inventory AS (
  DELETE FROM telemetry.player_inventory_snapshots WHERE run_id IN (SELECT run_id FROM locked) RETURNING 1
),
d_client AS (
  DELETE FROM telemetry.client_samples WHERE run_id IN (SELECT run_id FROM locked) RETURNING 1
),
d_sessions AS (
  DELETE FROM telemetry.session_summaries WHERE run_id IN (SELECT run_id FROM locked) RETURNING 1
),
counts AS (
  SELECT jsonb_build_object(
    'server_samples',(SELECT count(*) FROM d_server),
    'world_samples',(SELECT count(*) FROM d_world),
    'gameplay_events',(SELECT count(*) FROM d_events),
    'player_snapshots',(SELECT count(*) FROM d_players),
    'player_inventory_snapshots',(SELECT count(*) FROM d_inventory),
    'client_samples',(SELECT count(*) FROM d_client),
    'session_summaries',(SELECT count(*) FROM d_sessions)
  ) AS value
),
receipt AS (
  INSERT INTO telemetry.segment_retention_receipts (
    receipt_id, telemetry_schema_version, segment_id, run_id, acknowledged,
    deleted_row_counts, deleted_artifact_bytes, deletion_reason,
    archival_data_lost
  )
  SELECT
    :'receipt_id'::uuid, 1, :'segment_id'::uuid, :'run_id'::uuid,
    EXISTS (
      SELECT 1 FROM telemetry.segment_acknowledgments
      WHERE run_id=:'run_id'::uuid
    ),
    counts.value, :'artifact_bytes'::bigint, :'reason',
    NOT EXISTS (
      SELECT 1 FROM telemetry.segment_acknowledgments
      WHERE run_id=:'run_id'::uuid
    )
  FROM locked CROSS JOIN counts
  ON CONFLICT (run_id) DO NOTHING
  RETURNING run_id
)
UPDATE telemetry.test_runs
SET retention_status='deleted',
    retention_deleted_at=clock_timestamp(),
    updated_at=clock_timestamp()
WHERE run_id IN (SELECT run_id FROM receipt);
COMMIT;
SQL
  cleanup_spool_for_run "$run_id" "$segment_id"
done
