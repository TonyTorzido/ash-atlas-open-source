#!/usr/bin/env bash
set -euo pipefail

TEST_ROOT=$(mktemp -d /tmp/ash-atlas-deployment-timing.XXXXXXXX)
cleanup() {
  rm -rf --one-file-system "$TEST_ROOT"
}
trap cleanup EXIT

readonly OPERATION=timing-fixture
readonly SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
readonly TIMING_JSON_PATH=$TEST_ROOT/timing.json
readonly TEST_NODE_BIN=${ASH_ATLAS_NODE_BIN:-node}

write_run() {
  local action=$1
  local phase=$2
  local sha=${3:-$SHA}
  local tsv=$TEST_ROOT/$action.tsv
  printf '%s\t2026-08-09T00:00:00Z\t2026-08-09T00:00:01Z\t1000\tcompleted\n' "$phase" >"$tsv"
  ASH_ATLAS_DEPLOY_UPDATE_SOURCE_ONLY=true \
  ASH_ATLAS_NODE_BIN="$TEST_NODE_BIN" \
  ASH_ATLAS_DEPLOY_MODE="$action" \
  ASH_ATLAS_OPERATION_ID="$OPERATION" \
  ASH_ATLAS_TIMING_ROOT="$TEST_ROOT" \
    bash -c '
      set -euo pipefail
      source "$1" "$2"
      TIMING_TSV=$3
      TIMING_JSON=$4
      DEPLOY_STARTED_NS=$(date +%s%N)
      DEPLOYMENT_LANE=application
      MIGRATION_REQUIRED=false
      write_timing_json completed
    ' bash "$(dirname "$0")/deploy-test-update.sh" "$sha" "$tsv" "$TIMING_JSON_PATH"
}

write_run prepare git_fetch_checkout
write_run activate prepared_candidate_validation

"$TEST_NODE_BIN" - "$TIMING_JSON_PATH" "$OPERATION" "$SHA" <<'NODE'
const fs = require("node:fs");
const [path, operation, sha] = process.argv.slice(2);
const value = JSON.parse(fs.readFileSync(path, "utf8"));
if (value.schema_version !== 2 || value.operation_id !== operation || value.game_sha !== sha) {
  throw new Error("combined timing identity differs");
}
if (value.runs.length !== 2 || value.runs[0].action !== "prepare" ||
    value.runs[1].action !== "activate") {
  throw new Error("PREPARE and ACTIVATE timing runs were not retained in order");
}
if (value.phases.length !== 2 || value.phases[0].action !== "prepare" ||
    value.phases[1].action !== "activate") {
  throw new Error("PREPARE phases were overwritten by ACTIVATE");
}
if (!Number.isSafeInteger(value.active_duration_ms) ||
    !Number.isSafeInteger(value.total_duration_ms) ||
    value.total_duration_ms < value.active_duration_ms) {
  throw new Error("combined timing durations are invalid");
}
NODE

if write_run activate mismatch bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb >/dev/null 2>&1; then
  printf 'mismatched candidate unexpectedly reused deployment timings\n' >&2
  exit 1
fi

printf 'deployment timing checks passed\n'
