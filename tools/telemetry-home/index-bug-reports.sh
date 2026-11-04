#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ $# -eq 3 ]] || {
  echo "usage: $0 verified-artifact.duckdb segment-uuid index-root" >&2
  exit 2
}
artifact="$1"
segment_id="$2"
index_root="$3"
[[ -f "$artifact" && ! -L "$artifact" && "$artifact" == *.duckdb ]] || exit 2
[[ "$segment_id" =~ ^[0-9a-fA-F-]{36}$ ]] || exit 2
[[ "$index_root" == /* && "$index_root" != "/" ]] || exit 2
command -v duckdb >/dev/null
command -v flock >/dev/null
command -v install >/dev/null
command -v mktemp >/dev/null

install -d -m 0750 "$index_root"
exec 9>"${index_root}/.index.lock"
flock 9

database="${index_root}/reports.duckdb"
staged="$(mktemp "${index_root}/.reports.XXXXXXXX.duckdb")"
csv_staged="$(mktemp "${index_root}/.reports.XXXXXXXX.csv")"
marker_staged="$(mktemp "${index_root}/.last-indexed.XXXXXXXX")"
cleanup() {
  rm -f -- "$staged" "$csv_staged" "$marker_staged"
}
trap cleanup EXIT

if [[ -f "$database" && ! -L "$database" ]]; then
  cp --reflink=auto "$database" "$staged"
else
  rm -f -- "$staged"
fi
escaped_artifact="${artifact//\'/\'\'}"
duckdb "$staged" <<SQL
CREATE TABLE IF NOT EXISTS reports (
  source_segment_id VARCHAR NOT NULL,
  report_id UUID NOT NULL,
  public_report_code VARCHAR NOT NULL,
  submitted_at TIMESTAMPTZ NOT NULL,
  title VARCHAR NOT NULL,
  category VARCHAR NOT NULL,
  release_sha VARCHAR NOT NULL,
  release_generation VARCHAR,
  status VARCHAR NOT NULL,
  PRIMARY KEY (source_segment_id, report_id)
);
CREATE TABLE IF NOT EXISTS indexed_segments (
  source_segment_id VARCHAR PRIMARY KEY,
  indexed_at TIMESTAMPTZ NOT NULL
);
ATTACH '${escaped_artifact}' AS source (READ_ONLY);
INSERT OR IGNORE INTO reports
SELECT
  '${segment_id}', report_id, public_report_code, submitted_at, title,
  category, release_sha, release_generation, status
FROM source.bug_reports;
INSERT OR IGNORE INTO indexed_segments
VALUES ('${segment_id}', current_timestamp);
DETACH source;
CHECKPOINT;
COPY (
  SELECT public_report_code, submitted_at, title, category, release_sha,
         release_generation, status, source_segment_id, report_id
  FROM reports
  ORDER BY submitted_at DESC, public_report_code
) TO '${csv_staged//\'/\'\'}' (HEADER, DELIMITER ',');
SQL
printf '%s\n' "$segment_id" >"$marker_staged"
chmod 0640 "$staged" "$csv_staged" "$marker_staged"
mv -- "$staged" "$database"
mv -- "$csv_staged" "${index_root}/reports.csv"
mv -- "$marker_staged" "${index_root}/last-indexed-segment.txt"
sync -f "$index_root"
