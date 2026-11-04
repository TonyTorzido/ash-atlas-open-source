#!/usr/bin/env bash
set -euo pipefail
umask 077

: "${TELEMETRY_EXPORT_DATABASE_URL:?read-only exporter URL is required}"
: "${TELEMETRY_EXPORT_ENABLED:?TELEMETRY_EXPORT_ENABLED is required}"
[[ "$TELEMETRY_EXPORT_ENABLED" == "true" ]] || exit 0

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
mapfile -t run_ids < <(
  psql "$TELEMETRY_EXPORT_DATABASE_URL" -XAtq -v ON_ERROR_STOP=1 \
    -c "SELECT run_id
        FROM telemetry.test_runs
        WHERE segment_id IS NOT NULL
          AND status IN ('frozen','exported')
          AND ingestion_closed_at IS NOT NULL
          AND export_status <> 'verified'
          AND retention_status = 'retained'
        ORDER BY segment_end_at
        LIMIT 5"
)
for run_id in "${run_ids[@]}"; do
  [[ "$run_id" =~ ^[0-9a-fA-F-]{36}$ ]] || exit 1
  "$script_dir/export-closed-test-telemetry.sh" \
    --run-id "$run_id" \
    --format "${TELEMETRY_EXPORT_FORMAT:-duckdb}"
done
