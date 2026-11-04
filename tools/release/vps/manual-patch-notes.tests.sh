#!/usr/bin/env bash
set -euo pipefail
ROOT=$(mktemp -d /tmp/ash-atlas-patch-notes-tests.XXXXXXXX)
trap 'rm -rf --one-file-system "$ROOT"' EXIT
SCRIPT_ROOT=$(cd "$(dirname "$0")" && pwd)
export ASH_ATLAS_DEPLOY_CONTROL_TEST_MODE=true ASH_ATLAS_DEPLOY_CONTROL_SOURCE_ONLY=true
export ASH_ATLAS_DEPLOY_CONTROL_ROOT="$ROOT" ASH_ATLAS_DEPLOY_STATUS_ROOT="$ROOT/status"
export ASH_ATLAS_DEPLOY_LOG_ROOT="$ROOT/log" ASH_ATLAS_DEPLOY_CONTROL_LOCK="$ROOT/control.lock"
export ASH_ATLAS_DEPLOY_LOCK="$ROOT/deploy.lock" ASH_ATLAS_DEPLOY_ACTIVE_MARKER="$ROOT/active"
export ASH_ATLAS_DEPLOY_UPDATER="$ROOT/updater" ASH_ATLAS_DEPLOY_TIMING_ROOT="$ROOT/timing"
TARGET=1111111111111111111111111111111111111111
HASH=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
printf '{"requested_target_sha":"%s","requested_generation":"test/t1284","release_mode":"paused","updater_hash":"%s","result":"prepared"}\n' "$TARGET" "$HASH" > "$ROOT/fixture.json"
prepare_fixture() (
  set -- prepare fixture "$TARGET" "$HASH" test/t1284 paused "$HASH" "$1"
  source "$SCRIPT_ROOT/deploy-control.sh"
  provision_roots() { :; }
  flock() { :; }
  reconcile_with_terminal_wait() { RECON_CONTROLLER_STATE=consistent; RECON_UNIT_STATE=inactive; }
  ensure_status_token() { :; }
  publish_status_required() { :; }
  emit_receipt() { :; }
  prepare_operation <<< "$HASH"
)
prepare_fixture none
printf 'PASS: legacy receipt defaults to no publication on prepare/resume\n'
if prepare_fixture 5b225573657220737570706c69656420776f7264696e672e225d >"$ROOT/refusal" 2>&1; then
  printf 'FAIL: changed publication consent accepted\n' >&2; exit 1
fi
grep -q 'different immutable prepare inputs' "$ROOT/refusal" || { cat "$ROOT/refusal" >&2; exit 1; }
printf 'PASS: changed publication consent rejected for existing operation\n'
NOTES=5b225573657220737570706c69656420776f7264696e672e225d
"${ASH_ATLAS_NODE_BIN:-node}" - "$ROOT/fixture.json" "$NOTES" <<'NODE'
const fs = require("node:fs");
const file = process.argv[2];
const receipt = JSON.parse(fs.readFileSync(file, "utf8"));
receipt.release_patch_notes_hex = process.argv[3];
fs.writeFileSync(file, JSON.stringify(receipt));
NODE
prepare_fixture "$NOTES"
printf 'PASS: opted-in operation resumes with its frozen wording\n'
if prepare_fixture invalid >"$ROOT/refusal" 2>&1; then
  printf 'FAIL: invalid note transport accepted\n' >&2; exit 1
fi
grep -q 'release patch-note input is unsafe' "$ROOT/refusal"
printf 'PASS: invalid note transport rejected\n'
(
  export ASH_ATLAS_DEPLOY_UPDATE_SOURCE_ONLY=true
  source "$SCRIPT_ROOT/deploy-test-update.sh"
  prepare_discord_patch_notes_outbox() { printf 'FAIL: default touched outbox\n' >&2; exit 1; }
  deliver_discord_patch_notes
  [[ "$DISCORD_PATCH_NOTES_RESULT" = disabled ]]
)
printf 'PASS: default deployment skips Discord delivery and outbox\n'
