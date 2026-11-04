#!/usr/bin/env bash
# shellcheck disable=SC2016
set -euo pipefail

NODE_BIN=${ASH_ATLAS_NODE_BIN:-$(command -v node 2>/dev/null || command -v node.exe 2>/dev/null || printf /usr/bin/node)}
readonly NODE_BIN
export ASH_ATLAS_NODE_BIN=$NODE_BIN
TEST_ROOT=$(mktemp -d /tmp/ash-atlas-deploy-control-tests.XXXXXXXX)
readonly TEST_ROOT
cleanup() {
  if [[ -n ${worker_pid:-} ]]; then kill "$worker_pid" 2>/dev/null || true; fi
  if [[ ${ASH_ATLAS_TEST_PRESERVE_ROOT:-false} = true ]]; then
    printf 'preserved deployment-controller fixture: %s\n' "$TEST_ROOT" >&2
    return
  fi
  rm -rf --one-file-system "$TEST_ROOT"
}
trap cleanup EXIT

CONTROLLER=$(cd "$(dirname "$0")" && pwd)/deploy-control.sh
readonly CONTROLLER
readonly REPOSITORY_ROOT=$(cd "$(dirname "$CONTROLLER")/../../.." && pwd)
readonly TARGET_A=1111111111111111111111111111111111111111
readonly TARGET_B=2222222222222222222222222222222222222222
readonly TARGET_C=3333333333333333333333333333333333333333
readonly TOKEN_A=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
readonly TOKEN_B=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
readonly TOKEN_C=cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
readonly TOKEN_D=dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd
readonly TOKEN_E=eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee
readonly TOKEN_F=ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff
readonly TOKEN_G=1111111111111111111111111111111111111111111111111111111111111111
readonly TOKEN_H=2222222222222222222222222222222222222222222222222222222222222222
readonly TOKEN_I=3333333333333333333333333333333333333333333333333333333333333333
readonly TOKEN_J=4444444444444444444444444444444444444444444444444444444444444444
readonly TOKEN_K=5555555555555555555555555555555555555555555555555555555555555555
readonly TOKEN_L=6666666666666666666666666666666666666666666666666666666666666666
readonly TOKEN_M=7777777777777777777777777777777777777777777777777777777777777777
readonly TOKEN_N=8888888888888888888888888888888888888888888888888888888888888888
readonly TOKEN_O=9999999999999999999999999999999999999999999999999999999999999999
readonly TOKEN_P=abababababababababababababababababababababababababababababababab
readonly TOKEN_Q=cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd
readonly TOKEN_R=efefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefef
mkdir -p "$TEST_ROOT/bin" "$TEST_ROOT/state" "$TEST_ROOT/control" "$TEST_ROOT/log" \
  "$TEST_ROOT/status" "$TEST_ROOT/timing" "$TEST_ROOT/run" "$TEST_ROOT/active" \
  "$TEST_ROOT/releases/game" "$TEST_ROOT/releases/public"

cat > "$TEST_ROOT/updater" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
for descriptor in /proc/$$/fd/*; do
  if [[ "$descriptor" -ef "$ASH_ATLAS_DEPLOY_LOCK" ]]; then
    touch "$ASH_ATLAS_TEST_SYSTEMD_STATE/lock-descriptor-leaked"
    exit 90
  fi
done
if ! mkdir "$ASH_ATLAS_TEST_SYSTEMD_STATE/updater-active"; then
  touch "$ASH_ATLAS_TEST_SYSTEMD_STATE/concurrent-updater"
  exit 91
fi
trap 'rmdir "$ASH_ATLAS_TEST_SYSTEMD_STATE/updater-active"' EXIT
printf '%s %s\n' "$ASH_ATLAS_OPERATION_ID" "$1" >> "$ASH_ATLAS_TEST_SYSTEMD_STATE/updater-starts.log"
if [[ ${1:-} = 2222222222222222222222222222222222222222 ]]; then
  sleep 1
else
  sleep 0.3
fi
[[ ${ASH_ATLAS_TEST_UPDATER_FAIL:-false} != true ]]
target=$1
receipt=${ASH_ATLAS_OPERATION_RECEIPT:?}
mkdir -p "$ASH_ATLAS_TEST_RELEASE_ROOT/game/$target" "$ASH_ATLAS_TEST_RELEASE_ROOT/public/$target"
if [[ ${ASH_ATLAS_DEPLOY_MODE:-deploy} = prepare ]]; then
  "$ASH_ATLAS_NODE_BIN" - "$receipt" "$target" "${ASH_ATLAS_EXPECTED_GENERATION:?}" <<'NODE'
const fs = require("node:fs");
const [path, target, generation] = process.argv.slice(2);
const receipt = JSON.parse(fs.readFileSync(path, "utf8"));
Object.assign(receipt, {
  result: "prepared",
  current_phase: "prepared",
  prepare_result: "completed",
  prepared_generation: generation,
  prepared_previous_game_sha: "3333333333333333333333333333333333333333",
  prepared_previous_public_sha: "3333333333333333333333333333333333333333",
  prepared_migration_reason: "no_migrations_changed",
  prepared_build_manifest_sha256: "1".repeat(64),
  prepared_release_json_sha256: "2".repeat(64),
  prepared_game_release_sha256: "5".repeat(64),
  prepared_public_release_sha256: "6".repeat(64),
  prepared_migration_ledger_sha256: "3".repeat(64),
  release_classification_version: 1,
  release_class: "server_no_migration",
  release_classification_evidence_sha256: "7".repeat(64),
  release_changed_paths_sha256: "8".repeat(64),
  prepared_descriptor_version: 3,
  prepared_descriptor_sha256: "4".repeat(64),
  prepared_env_sha256: "b".repeat(64),
  prepared_server_component_sha: target,
  prepared_server_artifact_sha256: "9".repeat(64),
  prepared_client_component_sha: target,
  prepared_client_artifact_sha256: "a".repeat(64),
  prepared_game_main_pid: 1234,
  prepared_game_start_timestamp_monotonic: 5678,
  prepared_live_game_link_sha: "3333333333333333333333333333333333333333",
  prepared_live_public_link_sha: "3333333333333333333333333333333333333333",
  prepared_live_public_release_sha: "3333333333333333333333333333333333333333",
  prepare_receipt_sha256: "4".repeat(64),
  migration_required: false,
  prior_binary_restart_safe: true,
  activation_started: false,
  activation_result: "pending"
});
const temporary = `${path}.${process.pid}.tmp`;
fs.writeFileSync(temporary, `${JSON.stringify(receipt)}\n`);
fs.renameSync(temporary, path);
NODE
  exit 0
fi
ln -sfn "$ASH_ATLAS_TEST_RELEASE_ROOT/game/$target" "$ASH_ATLAS_GAME_CURRENT"
ln -sfn "$ASH_ATLAS_TEST_RELEASE_ROOT/public/$target" "$ASH_ATLAS_PUBLIC_CURRENT"
"$ASH_ATLAS_NODE_BIN" - "$receipt" "$target" <<'NODE'
const fs = require("node:fs");
const [path, target] = process.argv.slice(2);
const receipt = JSON.parse(fs.readFileSync(path, "utf8"));
Object.assign(receipt, {
  migration_result: "completed",
  migration_started: true,
  migration_completed: true,
  activation_result: "completed",
  activation_started: true,
  activation_completed: true,
  readiness_result: "completed",
  active_game_sha: target,
  active_public_sha: target
});
const temporary = `${path}.${process.pid}.tmp`;
fs.writeFileSync(temporary, `${JSON.stringify(receipt)}\n`);
fs.renameSync(temporary, path);
NODE
if [[ -n ${ASH_ATLAS_OPERATION_STATUS_PUBLISHER:-} ]]; then
  "$ASH_ATLAS_OPERATION_STATUS_PUBLISHER" publish "$ASH_ATLAS_OPERATION_ID"
fi
SH
chmod 0755 "$TEST_ROOT/updater"
cp "$TEST_ROOT/updater" "$TEST_ROOT/updater-prepare-capable"

cat > "$TEST_ROOT/bin/systemctl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
state_root=${ASH_ATLAS_TEST_SYSTEMD_STATE:?}
controller=${ASH_ATLAS_TEST_CONTROLLER:?}
command=$1
shift
case "$command" in
  start)
    [[ ${1:-} = --no-block ]] && shift
    unit=$1
    operation=${unit#ash-atlas-deploy@}
    operation=${operation%.service}
    printf '%s\n' "$operation" >> "${ASH_ATLAS_TEST_SYSTEMD_START_LOG:?}"
    printf activating > "$state_root/$operation.state"
    nohup bash -c '
      controller=$1
      state_root=$2
      operation=$3
      sleep "${ASH_ATLAS_TEST_WORKER_DELAY:-0}"
      if "$controller" run "$operation"; then
        printf inactive > "$state_root/$operation.state"
      else
        printf failed > "$state_root/$operation.state"
      fi
    ' bash "$controller" "$state_root" "$operation" >/dev/null 2>&1 </dev/null 8>&- 9>&- &
    printf '%s\n' "$!" > "$state_root/$operation.pid"
    ;;
  stop)
    unit=$1
    operation=${unit#ash-atlas-deploy@}
    operation=${operation%.service}
    if [[ -f "$state_root/$operation.pid" ]]; then
      kill "$(<"$state_root/$operation.pid")" 2>/dev/null || true
    fi
    printf inactive > "$state_root/$operation.state"
    ;;
  reset-failed)
    unit=$1
    operation=${unit#ash-atlas-deploy@}
    operation=${operation%.service}
    printf inactive > "$state_root/$operation.state"
    ;;
  show)
    unit=$1
    operation=${unit#ash-atlas-deploy@}
    operation=${operation%.service}
    if [[ -f "$state_root/$operation.pid" ]] &&
        kill -0 "$(<"$state_root/$operation.pid")" 2>/dev/null; then
      printf 'activating\n'
    elif [[ -f "$state_root/$operation.state" ]]; then
      cat "$state_root/$operation.state"
      printf '\n'
    else
      printf 'inactive\n'
    fi
    ;;
  is-active)
    printf 'active\n'
    ;;
  *)
    exit 1
    ;;
esac
SH
chmod 0755 "$TEST_ROOT/bin/systemctl"

export ASH_ATLAS_DEPLOY_CONTROL_TEST_MODE=true
export ASH_ATLAS_DEPLOY_CONTROL_ROOT="$TEST_ROOT/control"
export ASH_ATLAS_DEPLOY_STATUS_ROOT="$TEST_ROOT/status"
export ASH_ATLAS_DEPLOY_LOG_ROOT="$TEST_ROOT/log"
export ASH_ATLAS_DEPLOY_TIMING_ROOT="$TEST_ROOT/timing"
export ASH_ATLAS_DEPLOY_CONTROL_LOCK="$TEST_ROOT/run/control.lock"
export ASH_ATLAS_DEPLOY_LOCK="$TEST_ROOT/run/deploy.lock"
export ASH_ATLAS_DEPLOY_ACTIVE_MARKER="$TEST_ROOT/control/active-operation"
export ASH_ATLAS_DEPLOY_UPDATER="$TEST_ROOT/updater"
export ASH_ATLAS_TEST_CACHE_POLICY_PATH="$TEST_ROOT/game-cache-policy.caddy"
printf 'trusted cache policy fixture\n' > "$ASH_ATLAS_TEST_CACHE_POLICY_PATH"
export ASH_ATLAS_SYSTEMCTL="$TEST_ROOT/bin/systemctl"
export ASH_ATLAS_TEST_SYSTEMD_STATE="$TEST_ROOT/state"
export ASH_ATLAS_TEST_CONTROLLER="$CONTROLLER"
export ASH_ATLAS_TEST_SYSTEMD_START_LOG="$TEST_ROOT/state/systemd-starts.log"
touch "$ASH_ATLAS_TEST_SYSTEMD_START_LOG"
touch "$ASH_ATLAS_DEPLOY_LOCK" "$TEST_ROOT/state/updater-starts.log"
deploy_lock_inode=$(stat -c %i "$ASH_ATLAS_DEPLOY_LOCK")
export ASH_ATLAS_TEST_REMOTE_MASTER_SHA="$TARGET_A"
export ASH_ATLAS_GAME_CURRENT="$TEST_ROOT/active/game-current"
export ASH_ATLAS_PUBLIC_CURRENT="$TEST_ROOT/active/public-current"
export ASH_ATLAS_TEST_RELEASE_ROOT="$TEST_ROOT/releases"
export ASH_ATLAS_GAME_RELEASE_ROOT="$TEST_ROOT/releases/game"
export ASH_ATLAS_PUBLIC_RELEASE_ROOT="$TEST_ROOT/releases/public"
MOBILE_REGISTRY_FIXTURE="$TEST_ROOT/mobile-release-registry.json"
export ASH_ATLAS_TEST_MOBILE_REGISTRY_PATH="$MOBILE_REGISTRY_FIXTURE"
export ASH_ATLAS_TEST_MOBILE_REGISTRY_COMMIT_SHA="$TARGET_C"

HANDOFF_FIXTURE_ROOT="$TEST_ROOT/handoff"
HANDOFF_CURRENT_PUBLIC_RELEASE="$HANDOFF_FIXTURE_ROOT/current-release.json"
HANDOFF_CURRENT_LOCK="$HANDOFF_FIXTURE_ROOT/current-lock.json"
HANDOFF_TARGET_LOCK="$HANDOFF_FIXTURE_ROOT/target-lock.json"
HANDOFF_WORLD_HEALTH="$HANDOFF_FIXTURE_ROOT/world-health.json"
mkdir -p "$HANDOFF_FIXTURE_ROOT"
"$NODE_BIN" - "$REPOSITORY_ROOT/config/world-runtime.lock.json" \
  "$HANDOFF_CURRENT_PUBLIC_RELEASE" "$HANDOFF_CURRENT_LOCK" "$HANDOFF_TARGET_LOCK" \
  "$HANDOFF_WORLD_HEALTH" "$TARGET_A" "$TARGET_B" "$TARGET_C" <<'NODE'
const fs = require("node:fs");
const [sourcePath, releasePath, currentLockPath, targetLockPath, healthPath,
  targetSha, currentWorldSha, currentGameSha] = process.argv.slice(2);
const write = (path, value) => fs.writeFileSync(path, `${JSON.stringify(value)}\n`);
const targetLock = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
targetLock.pipeline.sha = targetSha;
const currentLock = JSON.parse(JSON.stringify(targetLock));
currentLock.pipeline.sha = currentWorldSha;
currentLock.river_surface.manifest_sha256 = "a".repeat(64);
delete currentLock.waterbody_identity_overlay;
write(targetLockPath, targetLock);
write(currentLockPath, currentLock);
write(releasePath, { game_sha: currentGameSha, server_component_sha: currentGameSha });
const surface = (lock, key) => ({
  mode: lock[key].release_id,
  identity: {
    release_id: lock[key].release_id,
    manifest_sha256: lock[key].manifest_sha256,
    policy: lock[key].policy
  }
});
write(healthPath, {
  ok: true,
  status: "ready",
  runtime: { sha: targetSha, branch: "main" },
  release: { release_id: targetLock.release.release_id },
  release_verification: {
    verification_mode: "manifest-only",
    release_manifest_sha256: targetLock.release.manifest_sha256
  },
  river_surface: surface(targetLock, "river_surface"),
  lake_surface: surface(targetLock, "lake_surface"),
  ocean_coast_surface: surface(targetLock, "ocean_coast_surface"),
  waterbody_identity_overlay: {
    release_id: targetLock.waterbody_identity_overlay.release_id,
    manifest_sha256: targetLock.waterbody_identity_overlay.manifest_sha256,
    schema: targetLock.waterbody_identity_overlay.schema,
    schema_version: targetLock.waterbody_identity_overlay.schema_version,
    policy: targetLock.waterbody_identity_overlay.policy,
    policy_version: targetLock.waterbody_identity_overlay.policy_version
  },
  water_name_index: {
    release_id: targetLock.water_name_index.release_id,
    manifest_sha256: targetLock.water_name_index.manifest_sha256,
    schema: targetLock.water_name_index.schema,
    policy: targetLock.water_name_index.policy,
    index_hash: targetLock.water_name_index.index_hash,
    entry_count: targetLock.water_name_index.entry_count,
    classes: targetLock.water_name_index.classes
  },
  capabilities: { waterbodyIdentityV1: true, waterNameFallbackV1: true }
});
NODE
export ASH_ATLAS_TEST_GAME_SERVICE_ACTIVE=true
export ASH_ATLAS_TEST_WORLD_SERVICE_ACTIVE=true
export ASH_ATLAS_TEST_CURRENT_PUBLIC_RELEASE_PATH="$HANDOFF_CURRENT_PUBLIC_RELEASE"
export ASH_ATLAS_TEST_CURRENT_LOCK_PATH="$HANDOFF_CURRENT_LOCK"
export ASH_ATLAS_TEST_TARGET_LOCK_PATH="$HANDOFF_TARGET_LOCK"
export ASH_ATLAS_TEST_WORLD_HEALTH_PATH="$HANDOFF_WORLD_HEALTH"

passed=0
assert() {
  local message=$1
  shift
  "$@" || {
    printf 'ASSERTION FAILED: %s\n' "$message" >&2
    exit 1
  }
  passed=$((passed + 1))
}

json_field() {
  "$NODE_BIN" -e 'const fs=require("node:fs");const v=JSON.parse(fs.readFileSync(0,"utf8"));process.stdout.write(String(v[process.argv[1]]??""));' "$1"
}

kill_process_tree() {
  local pid=$1 child
  while IFS= read -r child; do
    [[ -n "$child" ]] && kill_process_tree "$child"
  done < <(pgrep -P "$pid" 2>/dev/null || true)
  kill -9 "$pid" 2>/dev/null || true
}

controller_start() {
  local operation=$1
  local target=$2
  local hash=$3
  local token=$4
  printf '%s\n' "$token" | "$CONTROLLER" start "$operation" "$target" "$hash"
}

controller_prepare() {
  local operation=$1 target=$2 hash=$3 token=$4 generation=$5
  printf '%s\n' "$token" | "$CONTROLLER" prepare "$operation" "$target" "$hash" \
    "$generation" active "${6:-}"
}

write_activation_registry() {
  local operation=$1 target=$2 receipt="$TEST_ROOT/control/$1.json"
  "$NODE_BIN" - "$receipt" "$MOBILE_REGISTRY_FIXTURE" "$operation" "$target" <<'NODE'
const fs = require("node:fs");
const [receiptPath, registryPath, intentId, target] = process.argv.slice(2);
const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
for (const [name, length] of [["prepared_remote_receipt_sha256", 64], ["prepared_env_sha256", 64], ["prepared_server_component_sha", 40]]) {
  if (typeof receipt[name] !== "string" || !new RegExp(`^[0-9a-f]{${length}}$`, "u").test(receipt[name])) {
    throw new Error(`prepared receipt field ${name} is invalid`);
  }
}
const releases = ["ios", "android"].map((platform) => ({
  reservationId: `fixture:${platform}`,
  releaseId: `fixture-${platform}`,
  platform,
  marketingVersion: "1.0.0",
  build: 1,
  generation: "t1000",
  sourceSha: target,
  protocol: { min: 1, max: 3 },
  reservedAt: "2026-01-01T00:00:00.000Z",
  uploadAttempted: true,
  uploaded: true,
  processed: true,
  internal: true,
  externalApproved: true,
  open: true,
  downloadTested: true,
  supported: true,
  compatibilityProtected: true,
  availabilityPending: null,
  artifactSha256: "a".repeat(64),
  storeBuildId: `fixture-${platform}`,
  receiptUrl: `https://example.invalid/${platform}`,
  releaseMode: "internal",
  milestones: { reserved: true }
}));
const registry = {
  schemaVersion: 1,
  buildFloor: { ios: 1, android: 1 },
  nextBuild: { ios: 2, android: 2 },
  releases,
  activationIntent: {
    schemaVersion: 1,
    intentId,
    serverSha: target,
    candidateComponentSha: receipt.prepared_server_component_sha,
    preparedReceiptSha: receipt.prepared_remote_receipt_sha256,
    preSwitchEnvSha: receipt.prepared_env_sha256,
    serverProtocol: { min: 1, max: 3 },
    hardMinimum: {
      ios: { version: "1.0.0", build: 1 },
      android: { version: "1.0.0", build: 1 }
    },
    createdAt: "2026-01-01T00:00:00.000Z"
  }
};
fs.writeFileSync(registryPath, `${JSON.stringify(registry)}\n`);
NODE
}

updater_hash=$(sha256sum "$TEST_ROOT/updater" | cut -d' ' -f1)
controller_hash=$(sha256sum "$CONTROLLER" | cut -d' ' -f1)
identity_output=$("$CONTROLLER" identity)
assert 'identity reports the exact installed updater hash before publication' \
  test "$(printf '%s' "$identity_output" | json_field updater_sha256)" = "$updater_hash"
assert 'identity reports the exact installed controller hash before publication' \
  test "$(printf '%s' "$identity_output" | json_field controller_sha256)" = "$controller_hash"
assert 'identity reports the compatible controller protocol version' \
  test "$(printf '%s' "$identity_output" | json_field controller_version)" = 7

export ASH_ATLAS_TEST_REMOTE_MASTER_SHA="$TARGET_B"
export ASH_ATLAS_TEST_REMOTE_INTEGRATION_SHA="$TARGET_A"
export ASH_ATLAS_TEST_REMOTE_GENERATION_SHA="$TARGET_A"
handoff_output=$("$CONTROLLER" integrity-handoff unused "$TARGET_A")
assert 'World handoff recovery admits only the exact protected target matching active World' \
  test "$(printf '%s' "$handoff_output" | json_field result)" = recoverable-world-handoff
HANDOFF_WRONG_POLICY_HEALTH="$HANDOFF_FIXTURE_ROOT/wrong-policy-health.json"
"$NODE_BIN" - "$HANDOFF_WORLD_HEALTH" "$HANDOFF_WRONG_POLICY_HEALTH" <<'NODE'
const fs = require("node:fs");
const [sourcePath, targetPath] = process.argv.slice(2);
const health = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
health.river_surface.identity.policy = "wrong-policy";
fs.writeFileSync(targetPath, `${JSON.stringify(health)}\n`);
NODE
if ASH_ATLAS_TEST_WORLD_HEALTH_PATH="$HANDOFF_WRONG_POLICY_HEALTH" \
    "$CONTROLLER" integrity-handoff unused "$TARGET_A" >/dev/null 2>&1; then
  printf 'ASSERTION FAILED: World handoff recovery admitted a wrong target authority field\n' >&2
  exit 1
fi
passed=$((passed + 1))
HANDOFF_WRONG_INDEX_HEALTH="$HANDOFF_FIXTURE_ROOT/wrong-index-health.json"
"$NODE_BIN" - "$HANDOFF_WORLD_HEALTH" "$HANDOFF_WRONG_INDEX_HEALTH" <<'NODE'
const fs = require("node:fs");
const [sourcePath, targetPath] = process.argv.slice(2);
const health = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
health.water_name_index.index_hash = "0".repeat(64);
fs.writeFileSync(targetPath, `${JSON.stringify(health)}\n`);
NODE
if ASH_ATLAS_TEST_WORLD_HEALTH_PATH="$HANDOFF_WRONG_INDEX_HEALTH" \
    "$CONTROLLER" integrity-handoff unused "$TARGET_A" >/dev/null 2>&1; then
printf 'ASSERTION FAILED: World handoff recovery admitted a wrong water-name index authority field\n' >&2
  exit 1
fi
passed=$((passed + 1))
HANDOFF_MISSING_INDEX_CAPABILITY_HEALTH="$HANDOFF_FIXTURE_ROOT/missing-index-capability-health.json"
"$NODE_BIN" - "$HANDOFF_WORLD_HEALTH" "$HANDOFF_MISSING_INDEX_CAPABILITY_HEALTH" <<'NODE'
const fs = require("node:fs");
const [sourcePath, targetPath] = process.argv.slice(2);
const health = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
health.capabilities.waterNameFallbackV1 = false;
fs.writeFileSync(targetPath, `${JSON.stringify(health)}\n`);
NODE
if ASH_ATLAS_TEST_WORLD_HEALTH_PATH="$HANDOFF_MISSING_INDEX_CAPABILITY_HEALTH" \
    "$CONTROLLER" integrity-handoff unused "$TARGET_A" >/dev/null 2>&1; then
  printf 'ASSERTION FAILED: World handoff recovery admitted a missing water-name fallback capability\n' >&2
  exit 1
fi
passed=$((passed + 1))
HANDOFF_ACTIVE_MISMATCH_HEALTH="$HANDOFF_FIXTURE_ROOT/active-mismatch-health.json"
"$NODE_BIN" - "$HANDOFF_WORLD_HEALTH" "$HANDOFF_ACTIVE_MISMATCH_HEALTH" "$TARGET_B" <<'NODE'
const fs = require("node:fs");
const [sourcePath, targetPath, activeSha] = process.argv.slice(2);
const health = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
health.runtime.sha = activeSha;
fs.writeFileSync(targetPath, `${JSON.stringify(health)}\n`);
NODE
if ASH_ATLAS_TEST_WORLD_HEALTH_PATH="$HANDOFF_ACTIVE_MISMATCH_HEALTH" \
    "$CONTROLLER" integrity-handoff unused "$TARGET_A" >/dev/null 2>&1; then
  printf 'ASSERTION FAILED: World handoff recovery admitted a target/active World mismatch\n' >&2
  exit 1
fi
passed=$((passed + 1))
HANDOFF_CURRENT_MATCHING_LOCK="$HANDOFF_FIXTURE_ROOT/current-matching-lock.json"
"$NODE_BIN" - "$HANDOFF_CURRENT_LOCK" "$HANDOFF_CURRENT_MATCHING_LOCK" "$TARGET_A" <<'NODE'
const fs = require("node:fs");
const [sourcePath, targetPath, activeSha] = process.argv.slice(2);
const lock = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
lock.pipeline.sha = activeSha;
fs.writeFileSync(targetPath, `${JSON.stringify(lock)}\n`);
NODE
if ASH_ATLAS_TEST_CURRENT_LOCK_PATH="$HANDOFF_CURRENT_MATCHING_LOCK" \
    "$CONTROLLER" integrity-handoff unused "$TARGET_A" >/dev/null 2>&1; then
  printf 'ASSERTION FAILED: World handoff recovery admitted an already-compatible current game\n' >&2
  exit 1
fi
passed=$((passed + 1))
if ASH_ATLAS_TEST_REMOTE_INTEGRATION_SHA="$TARGET_B" \
    "$CONTROLLER" integrity-handoff unused "$TARGET_A" >/dev/null 2>&1; then
  printf 'ASSERTION FAILED: World handoff recovery admitted a non-protected target\n' >&2
  exit 1
fi
passed=$((passed + 1))
export ASH_ATLAS_TEST_REMOTE_MASTER_SHA="$TARGET_A"
if printf '%s\n' "$TOKEN_A" | "$CONTROLLER" start op-legacy-deploy "$TARGET_A" "$updater_hash" >/dev/null 2>&1; then
  printf 'ASSERTION FAILED: legacy deploy start was accepted without the PREPARE/ACTIVATE contract\n' >&2
  exit 1
fi
assert 'legacy deploy start fails closed before creating a receipt' \
  test ! -e "$TEST_ROOT/control/op-legacy-deploy.json"
legacy_receipt="$TEST_ROOT/control/op-legacy-receipt.json"
"$NODE_BIN" - "$legacy_receipt" "$TARGET_A" "$updater_hash" <<'NODE'
const fs = require("node:fs");
const [path, target, updaterHash] = process.argv.slice(2);
fs.writeFileSync(path, `${JSON.stringify({
  schema_version: 1,
  operation_id: "op-legacy-receipt",
  requested_action: "deploy",
  requested_target_sha: target,
  requested_generation: "",
  updater_hash: updaterHash,
  result: "accepted",
  current_phase: "accepted",
  failure_phase: "",
  failure_code: "",
  failure_message: ""
})}\n`);
NODE
set +e
legacy_execute_output=$("$CONTROLLER" execute op-legacy-receipt 2>&1)
legacy_execute_code=$?
set -e
assert 'a preexisting legacy deploy receipt fails closed before updater execution' \
  bash -c '[[ "$1" -ne 0 && "$2" = failed && "$3" = legacy_deploy_disabled ]]' bash \
    "$legacy_execute_code" \
    "$(json_field result < "$legacy_receipt")" \
    "$(json_field failure_code < "$legacy_receipt")"
# The historical direct-deploy acceptance cases below remain as reference text;
# the production command now fails closed and the executable PREPARE/ACTIVATE
# cases that follow cover the supported worker and recovery contract.
if false; then
started=$(date +%s%N)
start_output=$(controller_start op-a "$TARGET_A" "$updater_hash" "$TOKEN_A")
accepted_ms=$(( ($(date +%s%N) - started) / 1000000 ))
assert 'start returns within five seconds after durable acceptance' test "$accepted_ms" -lt 5000
start_result=$(printf '%s' "$start_output" | json_field result)
assert 'start returns an accepted or running receipt' \
  bash -c '[[ "$1" = accepted || "$1" = running || "$1" = completed ]]' bash "$start_result"

for _ in {1..50}; do
  status_output=$("$CONTROLLER" status op-a 2>/dev/null || true)
  [[ $(printf '%s' "$status_output" | json_field result) = completed ]] && break
  sleep 0.1
done
assert 'deployment survives the start client and reaches completed' \
  test "$(printf '%s' "$status_output" | json_field result)" = completed
assert 'completed HTTPS status is published for the exact bearer token' \
  test "$(json_field result < "$TEST_ROOT/status/$TOKEN_A.json")" = completed
assert 'completed HTTPS status carries the exact active identities' \
  "$NODE_BIN" - "$TEST_ROOT/status/$TOKEN_A.json" "$TARGET_A" <<'NODE'
const fs = require("node:fs");
const [path, target] = process.argv.slice(2);
const status = JSON.parse(fs.readFileSync(path, "utf8"));
if (status.active_game_sha !== target || status.active_public_sha !== target) process.exit(1);
NODE
assert 'completed HTTPS status has exact terminal stage results' \
  "$NODE_BIN" - "$TEST_ROOT/status/$TOKEN_A.json" <<'NODE'
const fs = require("node:fs");
const status = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (status.migration_result !== "completed" ||
    status.activation_result !== "completed" ||
    status.readiness_result !== "completed") process.exit(1);
NODE
assert 'HTTPS status contains only the minimal public allowlist' \
  "$NODE_BIN" - "$TEST_ROOT/status/$TOKEN_A.json" <<'NODE'
const fs = require("node:fs");
const status = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const expected = [
  "schema_version", "operation_id", "target_sha", "result", "current_phase",
  "active_game_sha", "active_public_sha", "migration_result", "activation_result",
  "readiness_result", "failure_phase", "failure_code", "mutation_evidence_complete",
  "migration_started", "migration_completed", "migration_outcome_uncertain",
  "activation_started", "activation_completed", "rollback_result",
  "deployment_timings", "state_transitions",
  "updated_at_utc"
].sort();
if (JSON.stringify(Object.keys(status).sort()) !== JSON.stringify(expected)) process.exit(1);
for (const forbidden of [
  "failure_message", "updater_hash", "cache_results",
  "previous_live_sha", "environment", "database", "stack"
]) {
  if (Object.hasOwn(status, forbidden)) process.exit(1);
}
NODE
assert 'controller records and projects durable state transitions' \
  "$NODE_BIN" - "$TEST_ROOT/control/op-a.json" "$TEST_ROOT/status/$TOKEN_A.json" <<'NODE'
const fs = require("node:fs");
const [receiptPath, statusPath] = process.argv.slice(2);
const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
const status = JSON.parse(fs.readFileSync(statusPath, "utf8"));
const transitions = receipt.state_transitions;
if (!Array.isArray(transitions) || transitions.length < 2 || transitions.length > 256) process.exit(1);
for (const transition of transitions) {
  for (const field of ["timestamp_utc", "operation_id", "previous_state", "next_state", "reason", "scope"]) {
    if (typeof transition[field] !== "string" || !transition[field]) process.exit(1);
  }
  if (!Number.isInteger(transition.elapsed_previous_state_ms) || transition.elapsed_previous_state_ms < 0) process.exit(1);
  if (!Number.isInteger(transition.process_pid) || transition.process_pid < 1) process.exit(1);
}
if (JSON.stringify(status.state_transitions) !== JSON.stringify(transitions)) process.exit(1);
NODE
assert 'status token remains a private sidecar and is absent from the receipt' \
  "$NODE_BIN" - "$TEST_ROOT/control/op-a.json" "$TOKEN_A" <<'NODE'
const fs = require("node:fs");
const [path, token] = process.argv.slice(2);
const receipt = fs.readFileSync(path, "utf8");
if (receipt.includes(token) || JSON.parse(receipt).status_token !== undefined) process.exit(1);
NODE
assert 'status token sidecar has private permissions' \
  test "$(stat -c %a "$TEST_ROOT/control/op-a.status-token")" = 600
assert 'HTTPS status document is read-only for its serving group' \
  test "$(stat -c %a "$TEST_ROOT/status/$TOKEN_A.json")" = 440
duplicate_output=$(controller_start op-a "$TARGET_A" "$updater_hash" "$TOKEN_A")
assert 'duplicate exact start is idempotently completed' \
  test "$(printf '%s' "$duplicate_output" | json_field result)" = completed
assert 'duplicate operation refuses a different status token' \
  bash -c '! printf "%s\n" "$4" | "$1" start "$2" "$3" "$5" >/dev/null 2>&1' \
    bash "$CONTROLLER" op-a "$TARGET_A" "$TOKEN_B" "$updater_hash"
assert 'receipt publication leaves no partial JSON temp file' \
  bash -c '[[ $(find "$1" -maxdepth 1 -name "*.tmp" | wc -l) -eq 0 ]]' bash "$TEST_ROOT/control"
assert 'status publication leaves no partial JSON temp file' \
  bash -c '[[ $(find "$1" -maxdepth 1 -name "*.tmp" | wc -l) -eq 0 ]]' bash "$TEST_ROOT/status"
assert 'accepted implies a durable rereadable receipt after the start client exits' \
  "$NODE_BIN" - "$TEST_ROOT/control/op-a.json" <<'NODE'
const fs = require("node:fs");
const receipt = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (receipt.operation_id !== "op-a" || receipt.result !== "completed") process.exit(1);
NODE
missing_output=$("$CONTROLLER" status op-genuinely-missing)
assert 'a truly missing operation is explicitly distinguishable' \
  test "$(printf '%s' "$missing_output" | json_field operation_state)" = genuinely_unknown
printf '%s\n' "$TOKEN_C" > "$TEST_ROOT/control/op-incomplete.status-token"
set +e
incomplete_output=$("$CONTROLLER" status op-incomplete)
incomplete_code=$?
set -e
assert 'a token without a receipt is an incomplete acceptance, not permanent absence' \
  bash -c '[[ "$1" -eq 4 && "$2" = incomplete_acceptance ]]' bash "$incomplete_code" \
    "$(printf '%s' "$incomplete_output" | json_field operation_state)"
printf '{malformed\n' > "$TEST_ROOT/control/op-malformed.json"
set +e
malformed_output=$("$CONTROLLER" status op-malformed)
malformed_code=$?
set -e
assert 'malformed receipt state is distinguished from missing' \
  bash -c '[[ "$1" -eq 4 && "$2" = malformed_receipt ]]' bash "$malformed_code" \
    "$(printf '%s' "$malformed_output" | json_field operation_state)"
rm -f "$TEST_ROOT/control/op-malformed.json"
printf '{"schema_version":99}\n' > "$TEST_ROOT/control/op-version.json"
set +e
version_output=$("$CONTROLLER" status op-version)
version_code=$?
set -e
assert 'controller-version mismatch is distinguished from missing' \
  bash -c '[[ "$1" -eq 4 && "$2" = controller_version_mismatch ]]' bash "$version_code" \
    "$(printf '%s' "$version_output" | json_field operation_state)"
rm -f "$TEST_ROOT/control/op-version.json"
reconcile_output=$("$CONTROLLER" reconcile op-a "$TARGET_A")
assert 'reconciliation reports receipt, lock, log, release, and active identities' \
  "$NODE_BIN" -e '
    const v=JSON.parse(process.argv[1]);
    if(v.operation_state!=="readable" || v.controller_state!=="consistent" ||
       typeof v.log_present!=="boolean" || typeof v.deployment_lock!=="string" ||
       typeof v.active_game_path!=="string") process.exit(1);
  ' "$reconcile_output"
node - "$TEST_ROOT/control/op-a.json" <<'NODE'
const fs = require("node:fs");
const path = process.argv[2];
const receipt = JSON.parse(fs.readFileSync(path, "utf8"));
receipt.result = "running";
fs.writeFileSync(path, `${JSON.stringify(receipt)}\n`);
NODE
printf 'op-a\n' > "$TEST_ROOT/control/active-operation"
printf activating > "$TEST_ROOT/state/op-a.state"
set +e
mismatch_output=$("$CONTROLLER" status op-a)
mismatch_code=$?
set -e
assert 'running receipt with a free execution lock fails closed' test "$mismatch_code" -eq 4
assert 'mismatch status is explicitly ambiguous' \
  test "$(printf '%s' "$mismatch_output" | json_field controller_state)" = ambiguous
node - "$TEST_ROOT/control/op-a.json" <<'NODE'
const fs = require("node:fs");
const path = process.argv[2];
const receipt = JSON.parse(fs.readFileSync(path, "utf8"));
receipt.result = "completed";
fs.writeFileSync(path, `${JSON.stringify(receipt)}\n`);
NODE
rm -f "$TEST_ROOT/control/active-operation"
printf inactive > "$TEST_ROOT/state/op-a.state"

printf deactivating > "$TEST_ROOT/state/op-a.state"
set +e
terminal_unit_output=$("$CONTROLLER" status op-a)
terminal_unit_code=$?
set -e
assert 'terminal receipt with its own deactivating unit fails closed' test "$terminal_unit_code" -eq 4
assert 'terminal unit mismatch is explicitly ambiguous' \
  test "$(printf '%s' "$terminal_unit_output" | json_field controller_state)" = ambiguous
printf inactive > "$TEST_ROOT/state/op-a.state"

printf failed > "$TEST_ROOT/state/op-a.state"
set +e
completed_failed_output=$("$CONTROLLER" status op-a)
completed_failed_code=$?
set -e
assert 'completed receipt with a failed systemd unit fails closed' test "$completed_failed_code" -eq 4
assert 'completed/failed mismatch is explicitly ambiguous' \
  test "$(printf '%s' "$completed_failed_output" | json_field controller_state)" = ambiguous
printf inactive > "$TEST_ROOT/state/op-a.state"

printf failed > "$TEST_ROOT/state/op-absent.state"
set +e
absent_failed_output=$("$CONTROLLER" status op-absent)
absent_failed_code=$?
set -e
assert 'absent receipt with a failed systemd unit fails closed' test "$absent_failed_code" -eq 4
assert 'absent/failed mismatch is explicitly ambiguous' \
  test "$(printf '%s' "$absent_failed_output" | json_field controller_state)" = ambiguous

cat > "$TEST_ROOT/control/op-transition.json" <<JSON
{"schema_version":1,"operation_id":"op-transition","requested_target_sha":"$TARGET_A","updater_hash":"$updater_hash","result":"completed","current_phase":"completed","migration_result":"not_required","activation_result":"completed","readiness_result":"completed","active_game_sha":"$TARGET_A","active_public_sha":"$TARGET_A","failure_phase":"","failure_code":""}
JSON
printf '%s\n' "$TOKEN_E" > "$TEST_ROOT/control/op-transition.status-token"
chmod 0600 "$TEST_ROOT/control/op-transition.status-token"
printf deactivating > "$TEST_ROOT/state/op-transition.state"
(
  "$CONTROLLER" finalize op-transition
  printf inactive > "$TEST_ROOT/state/op-transition.state"
) &
transition_pid=$!
transition_output=$("$CONTROLLER" status op-transition)
wait "$transition_pid"
assert 'terminal status releases the controller lock for systemd finalization' \
  test "$(printf '%s' "$transition_output" | json_field controller_state)" = consistent
assert 'completed reconciliation waits for the finalized inactive unit' \
  test "$(printf '%s' "$transition_output" | json_field unit_state)" = inactive
assert 'legacy tokenless receipt remains available through SSH status' \
  test "$(printf '%s' "$transition_output" | json_field result)" = completed

export ASH_ATLAS_TEST_REMOTE_MASTER_SHA="$TARGET_B"
controller_start op-b "$TARGET_B" "$updater_hash" "$TOKEN_B" >/dev/null
export ASH_ATLAS_TEST_REMOTE_MASTER_SHA="$TARGET_C"
assert 'cleanup preserves accepted and running operations' \
  bash -c '! "$1" cleanup op-b >/dev/null 2>&1' bash "$CONTROLLER"
op_c_output=$(controller_start op-c "$TARGET_C" "$updater_hash" "$TOKEN_C")
assert 'a second request is durably queued instead of refused' \
  test "$(printf '%s' "$op_c_output" | json_field result)" = accepted
assert 'the queued request publishes its execution-lane wait phase' \
  test "$(printf '%s' "$op_c_output" | json_field current_phase)" = waiting_for_execution_lane
assert 'only the lane owner receives a worker while the previous deployment runs' \
  bash -c '[[ $(grep -c "^op-b$" "$1") -eq 1 && $(grep -c "^op-c$" "$1") -eq 0 ]]' \
    bash "$ASH_ATLAS_TEST_SYSTEMD_START_LOG"
for _ in {1..30}; do
  status_output=$("$CONTROLLER" status op-b)
  [[ $(printf '%s' "$status_output" | json_field result) = completed ]] && break
  sleep 0.1
done
assert 'the previous lane owner completes exactly once' \
  test "$(printf '%s' "$status_output" | json_field result)" = completed
"$CONTROLLER" reconcile-all
"$CONTROLLER" reconcile-all
for _ in {1..30}; do
  status_output=$("$CONTROLLER" status op-c)
  [[ $(printf '%s' "$status_output" | json_field result) = completed ]] && break
  sleep 0.1
done
assert 'the queued request starts after the previous deployment completes' \
  test "$(printf '%s' "$status_output" | json_field result)" = completed
assert 'repeated reconciliation never duplicates either execution' \
  bash -c '[[ $(grep -c "^op-b$" "$1") -eq 1 && $(grep -c "^op-c$" "$1") -eq 1 ]]' \
    bash "$ASH_ATLAS_TEST_SYSTEMD_START_LOG"
assert 'no second updater executes concurrently' test ! -e "$TEST_ROOT/state/concurrent-updater"
assert 'the updater and its descendants never inherit the supervisor lock descriptor' \
  test ! -e "$TEST_ROOT/state/lock-descriptor-leaked"

export ASH_ATLAS_DEPLOY_LOCK_WAIT_INTERVAL=0.05
cat > "$TEST_ROOT/install-release-controller.sh" <<'SH'
#!/usr/bin/env bash
flock "$ASH_ATLAS_DEPLOY_LOCK" bash -c 'sleep 5'
SH
chmod 0755 "$TEST_ROOT/install-release-controller.sh"
"$TEST_ROOT/install-release-controller.sh" &
brief_holder_pid=$!
sleep 0.05
brief_output=$(controller_start op-brief-lock "$TARGET_C" "$updater_hash" "$TOKEN_G")
assert 'brief legitimate lock contention remains accepted' \
  test "$(printf '%s' "$brief_output" | json_field result)" = accepted
wait "$brief_holder_pid"
for _ in {1..30}; do
  status_output=$("$CONTROLLER" status op-brief-lock)
  [[ $(printf '%s' "$status_output" | json_field result) = completed ]] && break
  sleep 0.1
done
assert 'brief lock contention waits and then completes exactly once' \
  test "$(printf '%s' "$status_output" | json_field result)" = completed
assert 'lock wait timing and retry evidence are durable' \
  "$NODE_BIN" - "$TEST_ROOT/control/op-brief-lock.json" <<'NODE'
const fs = require("node:fs");
const receipt = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (!(receipt.lock_wait_attempts > 0) ||
    !(receipt.lock_wait_elapsed_ms >= 0) ||
    !receipt.lock_wait_started_at_utc ||
    !receipt.lock_wait_completed_at_utc ||
    !receipt.execution_lock_diagnostics) process.exit(1);
NODE
assert 'the exact target SHA survives lock-wait recovery unchanged' \
  test "$(json_field requested_target_sha < "$TEST_ROOT/control/op-brief-lock.json")" = "$TARGET_C"
assert 'the recovered operation executes only once' \
  test "$(grep -c '^op-brief-lock ' "$TEST_ROOT/state/updater-starts.log")" -eq 1

export ASH_ATLAS_TEST_PAUSE_AFTER_LOCK_FILE="$TEST_ROOT/state/op-worker-dies.locked"
export ASH_ATLAS_TEST_PAUSE_AFTER_LOCK_SECONDS=5
controller_start op-worker-dies "$TARGET_C" "$updater_hash" "$TOKEN_H" >/dev/null
for _ in {1..30}; do
  [[ -f "$ASH_ATLAS_TEST_PAUSE_AFTER_LOCK_FILE" ]] && break
  sleep 0.1
done
assert 'worker reaches the acquired-lock handoff fixture' \
  test -f "$ASH_ATLAS_TEST_PAUSE_AFTER_LOCK_FILE"
worker_wrapper_pid=$(<"$TEST_ROOT/state/op-worker-dies.pid")
kill_process_tree "$worker_wrapper_pid"
wait "$worker_wrapper_pid" 2>/dev/null || true
printf failed > "$TEST_ROOT/state/op-worker-dies.state"
"$CONTROLLER" finalize op-worker-dies
assert 'a worker death before running remains accepted and recoverable' \
  test "$(json_field result < "$TEST_ROOT/control/op-worker-dies.json")" = accepted
assert 'the kernel releases the dead worker execution lock' \
  flock -n "$ASH_ATLAS_DEPLOY_LOCK" -c true
unset ASH_ATLAS_TEST_PAUSE_AFTER_LOCK_FILE ASH_ATLAS_TEST_PAUSE_AFTER_LOCK_SECONDS
"$CONTROLLER" reconcile-all
for _ in {1..30}; do
  status_output=$("$CONTROLLER" status op-worker-dies)
  [[ $(printf '%s' "$status_output" | json_field result) = completed ]] && break
  sleep 0.1
done
assert 'reconciliation safely resumes the exact operation after worker death' \
  test "$(printf '%s' "$status_output" | json_field result)" = completed
assert 'worker-death recovery does not run the updater twice' \
  test "$(grep -c '^op-worker-dies ' "$TEST_ROOT/state/updater-starts.log")" -eq 1

cat > "$TEST_ROOT/control/op-wait-finalize.json" <<JSON
{"schema_version":1,"operation_id":"op-wait-finalize","requested_target_sha":"$TARGET_C","updater_hash":"$updater_hash","result":"accepted","current_phase":"waiting_for_execution_lock","lock_wait_attempts":3}
JSON
printf 'op-wait-finalize\n' > "$TEST_ROOT/control/active-operation"
printf failed > "$TEST_ROOT/state/op-wait-finalize.state"
"$CONTROLLER" finalize op-wait-finalize
assert 'ExecStopPost preserves an intentional waiting exit as accepted' \
  test "$(json_field result < "$TEST_ROOT/control/op-wait-finalize.json")" = accepted
assert 'ExecStopPost releases the canonical lane after a waiting exit' \
  test ! -e "$TEST_ROOT/control/active-operation"
rm "$TEST_ROOT/control/op-wait-finalize.json"

export ASH_ATLAS_TEST_REMOTE_MASTER_SHA="$TARGET_A"
export ASH_ATLAS_TEST_WORKER_DELAY=0.5
controller_start op-unknown-owner "$TARGET_A" "$updater_hash" "$TOKEN_I" >/dev/null
flock "$ASH_ATLAS_DEPLOY_LOCK" bash -c 'sleep 2' &
unknown_holder_pid=$!
unset ASH_ATLAS_TEST_WORKER_DELAY
for _ in {1..30}; do
  status_output=$("$CONTROLLER" status op-unknown-owner 2>/dev/null || true)
  [[ $(printf '%s' "$status_output" | json_field result) = failed ]] && break
  sleep 0.1
done
wait "$unknown_holder_pid"
assert 'an unknown lock owner fails closed with an infrastructure diagnosis' \
  bash -c '[[ "$1" = failed && "$2" = execution_lock_owner && "$3" = unknown_execution_lock_owner ]]' \
    bash "$(printf '%s' "$status_output" | json_field result)" \
    "$(printf '%s' "$status_output" | json_field failure_phase)" \
    "$(printf '%s' "$status_output" | json_field failure_code)"
assert 'unknown lock ownership never invokes the production updater' \
  test "$(grep -c '^op-unknown-owner ' "$TEST_ROOT/state/updater-starts.log")" -eq 0
assert 'unknown lock ownership cannot activate its requested target' \
  test "$(readlink -e "$ASH_ATLAS_GAME_CURRENT")" != "$TEST_ROOT/releases/game/$TARGET_A"
export ASH_ATLAS_TEST_REMOTE_MASTER_SHA="$TARGET_C"

cat > "$TEST_ROOT/control/op-legacy-lock.json" <<JSON
{"schema_version":1,"operation_id":"op-legacy-lock","requested_target_sha":"$TARGET_C","updater_hash":"$updater_hash","accepted_at_utc":"2026-07-27T00:00:00Z","started_at_utc":"","result":"failed","current_phase":"lock_acquisition","failure_phase":"lock_acquisition","failure_code":"lock_acquisition_failed","failure_message":"deployment lock was held after durable acceptance","finished_at_utc":"2026-07-27T00:00:01Z","migration_result":"pending","activation_result":"pending","readiness_result":"pending","active_game_sha":"","active_public_sha":""}
JSON
printf '%s\n' "$TOKEN_J" > "$TEST_ROOT/control/op-legacy-lock.status-token"
chmod 0600 "$TEST_ROOT/control/op-legacy-lock.status-token"
printf failed > "$TEST_ROOT/state/op-legacy-lock.state"
"$CONTROLLER" resume op-legacy-lock >/dev/null
for _ in {1..30}; do
  status_output=$("$CONTROLLER" status op-legacy-lock 2>/dev/null || true)
  [[ $(printf '%s' "$status_output" | json_field result) = completed ]] && break
  sleep 0.1
done
assert 'resume repairs a legacy terminal lock-contention receipt in place' \
  test "$(printf '%s' "$status_output" | json_field result)" = completed
assert 'legacy lock recovery preserves the immutable target SHA' \
  test "$(json_field requested_target_sha < "$TEST_ROOT/control/op-legacy-lock.json")" = "$TARGET_C"
assert 'legacy lock recovery executes the original operation exactly once' \
  test "$(grep -c '^op-legacy-lock ' "$TEST_ROOT/state/updater-starts.log")" -eq 1

cat > "$TEST_ROOT/control/op-resume.json" <<JSON
{"schema_version":1,"operation_id":"op-resume","requested_target_sha":"$TARGET_C","updater_hash":"$updater_hash","result":"accepted","current_phase":"accepted"}
JSON
printf '%s\n' "$TOKEN_C" > "$TEST_ROOT/control/op-resume.status-token"
chmod 0600 "$TEST_ROOT/control/op-resume.status-token"
printf 'op-resume\n' > "$TEST_ROOT/control/active-operation"
printf inactive > "$TEST_ROOT/state/op-resume.state"
resume_output=$("$CONTROLLER" resume op-resume)
assert 'canonical resume launches one accepted inactive durable worker' \
  bash -c '[[ "$1" = activating || "$1" = active ]]' bash \
    "$(printf '%s' "$resume_output" | json_field unit_state)"
for _ in {1..50}; do
  status_output=$("$CONTROLLER" status op-resume)
  [[ $(printf '%s' "$status_output" | json_field result) = completed ]] && break
  sleep 0.1
done
assert 'canonical resume reaches completion after acceptance disconnect' \
  test "$(printf '%s' "$status_output" | json_field result)" = completed

cat > "$TEST_ROOT/control/op-finalize.json" <<JSON
{"schema_version":1,"operation_id":"op-finalize","requested_target_sha":"$TARGET_C","updater_hash":"$updater_hash","result":"running","current_phase":"fixture_phase"}
JSON
printf '%s\n' "$TOKEN_D" > "$TEST_ROOT/control/op-finalize.status-token"
chmod 0600 "$TEST_ROOT/control/op-finalize.status-token"
printf 'op-finalize\n' > "$TEST_ROOT/control/active-operation"
printf failed > "$TEST_ROOT/state/op-finalize.state"
"$CONTROLLER" finalize op-finalize
assert 'systemd finalizer converts a stranded nonterminal receipt to failed' \
  test "$(json_field result < "$TEST_ROOT/control/op-finalize.json")" = failed
assert 'systemd finalizer preserves the exact stranded phase' \
  test "$(json_field failure_phase < "$TEST_ROOT/control/op-finalize.json")" = fixture_phase

export ASH_ATLAS_TEST_WORKER_DELAY=0.3
cp "$TEST_ROOT/updater" "$TEST_ROOT/updater.saved"
export ASH_ATLAS_TEST_REMOTE_MASTER_SHA="$TARGET_C"
controller_start op-missing-updater "$TARGET_C" "$updater_hash" "$TOKEN_D" >/dev/null
rm "$TEST_ROOT/updater"
for _ in {1..50}; do
  status_output=$("$CONTROLLER" status op-missing-updater)
  [[ $(printf '%s' "$status_output" | json_field result) = failed ]] && break
  sleep 0.1
done
mv "$TEST_ROOT/updater.saved" "$TEST_ROOT/updater"
unset ASH_ATLAS_TEST_WORKER_DELAY
assert 'worker identity failure reaches a terminal failed receipt' \
  test "$(printf '%s' "$status_output" | json_field result)" = failed
assert 'worker identity failure records its exact phase' \
  test "$(printf '%s' "$status_output" | json_field failure_phase)" = updater_identity

cat > "$TEST_ROOT/updater" <<'SH'
#!/usr/bin/env bash
printf 'STOP: old game worker is not fully stopped before activation (state=failed)\n' >&2
printf 'game readiness: PASS\n'
exit 7
SH
chmod 0755 "$TEST_ROOT/updater"
failed_hash=$(sha256sum "$TEST_ROOT/updater" | cut -d' ' -f1)
export ASH_ATLAS_TEST_REMOTE_MASTER_SHA="$TARGET_C"
controller_start op-fail "$TARGET_C" "$failed_hash" "$TOKEN_E" >/dev/null || true
for _ in {1..50}; do
  status_output=$("$CONTROLLER" status op-fail)
  [[ $(printf '%s' "$status_output" | json_field result) = failed ]] && break
  sleep 0.1
done
assert 'failed deployment records a terminal failed result' \
  test "$(printf '%s' "$status_output" | json_field result)" = failed
assert 'failed deployment records its exact current phase' \
  test -n "$(printf '%s' "$status_output" | json_field failure_phase)"
assert 'failed deployment receipt preserves the updater root error across cleanup output' \
  test "$(printf '%s' "$status_output" | json_field failure_message)" = \
    'old game worker is not fully stopped before activation (state=failed)'
assert 'failed HTTPS status exposes only a sanitized phase and code' \
  "$NODE_BIN" - "$TEST_ROOT/status/$TOKEN_E.json" <<'NODE'
const fs = require("node:fs");
const status = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (status.result !== "failed" ||
    !/^[a-z][a-z0-9_]{0,63}$/.test(status.failure_phase) ||
    !/^[a-z][a-z0-9_]{0,63}$/.test(status.failure_code) ||
    Object.hasOwn(status, "failure_message") ||
    JSON.stringify(status).includes("old game worker")) process.exit(1);
NODE
rm "$TEST_ROOT/status/$TOKEN_E.json"
"$CONTROLLER" status op-fail >/dev/null || true
assert 'status inspection automatically regenerates a deleted HTTPS projection' \
  test -f "$TEST_ROOT/status/$TOKEN_E.json"
assert 'unsafe operation IDs are refused' \
  bash -c '! "$1" status "../unsafe" >/dev/null 2>&1' bash "$CONTROLLER"
assert 'a new deployment without a status token is refused before receipt creation' \
  bash -c '! "$1" start op-no-token "$2" "$3" </dev/null >/dev/null 2>&1 &&
           [[ ! -e "$4/op-no-token.json" ]]' \
    bash "$CONTROLLER" "$TARGET_C" "$failed_hash" "$TEST_ROOT/control"
assert 'operation-root permission or creation failure cannot produce false acceptance' \
  bash -c '
    ! printf "%s\n" "$5" |
      env ASH_ATLAS_DEPLOY_CONTROL_ROOT=/proc/ash-atlas-controller-test \
          ASH_ATLAS_DEPLOY_ACTIVE_MARKER=/proc/ash-atlas-controller-test/active-operation \
          "$1" start op-permission "$2" "$3" >/dev/null 2>&1 &&
      [[ ! -e "$4/op-permission.json" ]]
  ' bash "$CONTROLLER" "$TARGET_C" "$failed_hash" "$TEST_ROOT/control" "$TOKEN_A"
mkdir "$TEST_ROOT/status/$TOKEN_F.json"
set +e
projection_start_output=$(controller_start op-projection-gate "$TARGET_C" "$failed_hash" "$TOKEN_F" 2>&1)
projection_start_code=$?
set -e
assert 'initial HTTPS projection failure blocks worker acceptance' \
  bash -c '[[ "$1" -ne 0 && ! -e "$2/op-projection-gate.state" ]]' \
    bash "$projection_start_code" "$TEST_ROOT/state"
assert 'projection failure leaves one authoritative recoverable receipt' \
  test "$(json_field result < "$TEST_ROOT/control/op-projection-gate.json")" = accepted
rmdir "$TEST_ROOT/status/$TOKEN_F.json"
controller_start op-projection-gate "$TARGET_C" "$failed_hash" "$TOKEN_F" >/dev/null || true
for _ in {1..50}; do
  projection_result=$("$CONTROLLER" status op-projection-gate 2>/dev/null || true)
  [[ $(printf '%s' "$projection_result" | json_field result) = failed ]] && break
  sleep 0.1
done
assert 'exact retransmission repairs projection and starts the existing operation' \
  test "$(printf '%s' "$projection_result" | json_field result)" = failed
assert 'projection recovery starts exactly one systemd worker' \
  test "$(grep -c '^op-projection-gate$' "$ASH_ATLAS_TEST_SYSTEMD_START_LOG")" -eq 1
touch "$TEST_ROOT/status-blocker"
assert 'missing HTTPS status publication cannot remove the authoritative receipt' \
  bash -c '
    ! env ASH_ATLAS_DEPLOY_STATUS_ROOT="$2" "$1" publish op-a >/dev/null 2>&1 &&
      "$4" -e "JSON.parse(require(\"node:fs\").readFileSync(process.argv[1],\"utf8\"))" "$3"
  ' bash "$CONTROLLER" "$TEST_ROOT/status-blocker" "$TEST_ROOT/control/op-a.json" "$NODE_BIN"
rm -f "$TEST_ROOT/status-blocker"
fi
mkdir -p "$TEST_ROOT/releases/game/$TARGET_C" "$TEST_ROOT/releases/public/$TARGET_C"
ln -s "$TEST_ROOT/releases/game/$TARGET_C" "$ASH_ATLAS_GAME_CURRENT"
ln -s "$TEST_ROOT/releases/public/$TARGET_C" "$ASH_ATLAS_PUBLIC_CURRENT"
cp "$TEST_ROOT/updater-prepare-capable" "$TEST_ROOT/updater"
chmod 0755 "$TEST_ROOT/updater"
prepare_updater_hash=$(sha256sum "$TEST_ROOT/updater" | cut -d' ' -f1)
export ASH_ATLAS_TEST_REMOTE_CANDIDATE_SHA="$TARGET_A"
export ASH_ATLAS_TEST_REMOTE_MASTER_SHA="$TARGET_C"
export ASH_ATLAS_TEST_REMOTE_INTEGRATION_SHA="$TARGET_C"
export ASH_ATLAS_TEST_REMOTE_GENERATION_SHA="$TARGET_C"
prepared_previous_game=$(readlink -e "$ASH_ATLAS_GAME_CURRENT")
prepared_previous_public=$(readlink -e "$ASH_ATLAS_PUBLIC_CURRENT")
export ASH_ATLAS_TEST_UPDATER_FAIL=true
controller_prepare op-prepare-retry "$TARGET_A" "$prepare_updater_hash" "$TOKEN_L" test/t484 >/dev/null || true
for _ in {1..50}; do
  failed_prepare_output=$("$CONTROLLER" status op-prepare-retry 2>/dev/null || true)
  [[ $(printf '%s' "$failed_prepare_output" | json_field result) = failed ]] && break
  sleep 0.1
done
unset ASH_ATLAS_TEST_UPDATER_FAIL
assert 'a worker-level PREPARE failure leaves live identity untouched' \
  bash -c '[[ "$1" = failed && "$(readlink -e "$2")" = "$3" && "$(readlink -e "$4")" = "$5" ]]' \
    bash "$(printf '%s' "$failed_prepare_output" | json_field result)" \
    "$ASH_ATLAS_GAME_CURRENT" "$prepared_previous_game" \
    "$ASH_ATLAS_PUBLIC_CURRENT" "$prepared_previous_public"

# An older updater can fail while hashing a candidate, before PREPARE creates
# any live changes. Its already-published server and client bytes must still
# match the previous release's independently persisted build manifest.
mkdir -p "$prepared_previous_game/apps/server/dist" "$prepared_previous_public/assets"
printf 'old server artifact\n' > "$prepared_previous_game/apps/server/dist/index.js"
printf 'old public artifact\n' > "$prepared_previous_public/assets/index.js"
live_server_hash=$(tar --sort=name --mtime='UTC 1970-01-01' --owner=0 --group=0 \
  --numeric-owner --mode='u=rwX,go=rX' -C "$prepared_previous_game/apps/server/dist" \
  -cf - . | sha256sum | cut -d' ' -f1)
live_client_hash=$(tar --sort=name --mtime='UTC 1970-01-01' --owner=0 --group=0 \
  --numeric-owner --mode='u=rwX,go=rX' -C "$prepared_previous_public" \
  -cf - . | sha256sum | cut -d' ' -f1)
"$NODE_BIN" - "$prepared_previous_game/build-manifest.json" "$TARGET_C" \
  "$live_server_hash" "$live_client_hash" <<'NODE'
const fs = require('node:fs');
const [path, source, server, client] = process.argv.slice(2);
fs.writeFileSync(path, JSON.stringify({
  source_commit_sha: source, artifact_hashes: { server, client }
}));
NODE
mark_hashing_failure() {
  "$NODE_BIN" - "$TEST_ROOT/control/$1.json" <<'NODE'
const fs = require('node:fs');
const path = process.argv[2];
const receipt = JSON.parse(fs.readFileSync(path, 'utf8'));
if (receipt.result !== 'failed') throw new Error('fixture requires failed PREPARE');
receipt.current_phase = 'artifact_hashing';
receipt.failure_phase = 'artifact_hashing';
fs.writeFileSync(path, `${JSON.stringify(receipt)}\n`);
NODE
}
export ASH_ATLAS_TEST_UPDATER_FAIL=true
prepare_failed_hash_fixture() {
  local operation=$1 token=$2 generation=$3 result
  controller_prepare "$operation" "$TARGET_A" "$prepare_updater_hash" "$token" "$generation" >/dev/null || true
  for _ in {1..100}; do
    result=$($CONTROLLER status "$operation" 2>/dev/null || true)
    [[ $(printf '%s' "$result" | json_field result) = failed ]] && return 0
    sleep 0.1
  done
  printf 'fixture PREPARE did not fail: %s\n' "$operation" >&2
  return 1
}
prepare_failed_hash_fixture op-hash-recovery "$TOKEN_N" test/t487
prepare_failed_hash_fixture op-hash-activation "$TOKEN_O" test/t488
prepare_failed_hash_fixture op-hash-migration "$TOKEN_P" test/t489
prepare_failed_hash_fixture op-hash-live-file "$TOKEN_Q" test/t490
prepare_failed_hash_fixture op-hash-pointer "$TOKEN_R" test/t491
unset ASH_ATLAS_TEST_UPDATER_FAIL
for operation in op-hash-recovery op-hash-activation op-hash-migration \
    op-hash-live-file op-hash-pointer; do
  mark_hashing_failure "$operation"
done
"$NODE_BIN" - "$TEST_ROOT/control/op-hash-activation.json" \
  "$TEST_ROOT/control/op-hash-migration.json" <<'NODE'
const fs = require('node:fs');
const [activationPath, migrationPath] = process.argv.slice(2);
for (const [path, key] of [[activationPath, 'activation_started'],
  [migrationPath, 'migration_started']]) {
  const receipt = JSON.parse(fs.readFileSync(path, 'utf8'));
  receipt[key] = true;
  fs.writeFileSync(path, `${JSON.stringify(receipt)}\n`);
}
NODE
printf '\n# fixed updater fixture\n' >> "$TEST_ROOT/updater"
fixed_prepare_updater_hash=$(sha256sum "$TEST_ROOT/updater" | cut -d' ' -f1)
trusted_cache_policy_hash=$(sha256sum "$ASH_ATLAS_TEST_CACHE_POLICY_PATH" | cut -d' ' -f1)
before_recovery_starts=$(wc -l < "$TEST_ROOT/state/updater-starts.log")
assert 'changed updater is refused when cache policy hash differs' \
  bash -c '! printf "%s\n" "$5" | "$1" prepare "$2" "$3" "$4" test/t487 active "$6" >/dev/null 2>&1' \
    bash "$CONTROLLER" op-hash-recovery "$TARGET_A" "$fixed_prepare_updater_hash" \
    "$TOKEN_N" "$live_server_hash"
assert 'changed updater is refused after activation started' \
  bash -c '! printf "%s\n" "$5" | "$1" prepare "$2" "$3" "$4" test/t488 active "$6" >/dev/null 2>&1' \
    bash "$CONTROLLER" op-hash-activation "$TARGET_A" "$fixed_prepare_updater_hash" "$TOKEN_O" "$trusted_cache_policy_hash"
assert 'changed updater is refused after migration started' \
  bash -c '! printf "%s\n" "$5" | "$1" prepare "$2" "$3" "$4" test/t489 active "$6" >/dev/null 2>&1' \
    bash "$CONTROLLER" op-hash-migration "$TARGET_A" "$fixed_prepare_updater_hash" "$TOKEN_P" "$trusted_cache_policy_hash"
printf 'modified public artifact\n' > "$prepared_previous_public/assets/index.js"
assert 'changed updater is refused when published file bytes differ' \
  bash -c '! printf "%s\n" "$5" | "$1" prepare "$2" "$3" "$4" test/t490 active "$6" >/dev/null 2>&1' \
    bash "$CONTROLLER" op-hash-live-file "$TARGET_A" "$fixed_prepare_updater_hash" "$TOKEN_Q" "$trusted_cache_policy_hash"
printf 'old public artifact\n' > "$prepared_previous_public/assets/index.js"
ln -sfn "$TEST_ROOT/releases/public/$TARGET_A" "$ASH_ATLAS_PUBLIC_CURRENT"
assert 'changed updater is refused when public pointer moved' \
  bash -c '! printf "%s\n" "$5" | "$1" prepare "$2" "$3" "$4" test/t491 active "$6" >/dev/null 2>&1' \
    bash "$CONTROLLER" op-hash-pointer "$TARGET_A" "$fixed_prepare_updater_hash" "$TOKEN_R" "$trusted_cache_policy_hash"
ln -sfn "$prepared_previous_public" "$ASH_ATLAS_PUBLIC_CURRENT"
assert 'refused recovery preserves failed evidence and starts no worker' \
  bash -c '[[ "$1" = "$2" && "$3" = failed && ! -e "$4" ]]' bash \
    "$before_recovery_starts" "$(wc -l < "$TEST_ROOT/state/updater-starts.log")" \
    "$(json_field result < "$TEST_ROOT/control/op-hash-activation.json")" \
    "$TEST_ROOT/control/op-hash-activation.prepare-recovery.json"
controller_prepare op-hash-recovery "$TARGET_A" "$fixed_prepare_updater_hash" \
  "$TOKEN_N" test/t487 "$trusted_cache_policy_hash" >/dev/null
for _ in {1..50}; do
  recovered_prepare_output=$($CONTROLLER status op-hash-recovery 2>/dev/null || true)
  [[ $(printf '%s' "$recovered_prepare_output" | json_field result) = prepared ]] && break
  sleep 0.1
done
assert 'clean pre-mutation PREPARE failure accepts a changed updater' \
  bash -c '[[ "$1" = prepared && "$2" = "$3" && "$4" = 1 ]]' bash \
    "$(printf '%s' "$recovered_prepare_output" | json_field result)" \
    "$(printf '%s' "$recovered_prepare_output" | json_field updater_hash)" \
    "$fixed_prepare_updater_hash" \
    "$(printf '%s' "$recovered_prepare_output" | json_field transaction_retry_count)"
assert 'recovery audit retains old receipt, proof, and both updater hashes' \
  "$NODE_BIN" - "$TEST_ROOT/control/op-hash-recovery.prepare-recovery.json" \
    "$TEST_ROOT/control/op-hash-recovery.json" "$prepare_updater_hash" \
    "$fixed_prepare_updater_hash" "$live_server_hash" "$trusted_cache_policy_hash" <<'NODE'
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const [auditPath, receiptPath, oldHash, newHash, liveServerHash, cachePolicyHash] = process.argv.slice(2);
const bytes = fs.readFileSync(auditPath);
const audit = JSON.parse(bytes);
const receipt = JSON.parse(fs.readFileSync(receiptPath));
const digest = createHash('sha256').update(bytes).digest('hex');
if (audit.failed_receipt.result !== 'failed' ||
    audit.failed_receipt.updater_hash !== oldHash ||
    audit.failed_updater_sha256 !== oldHash ||
    audit.recovery_updater_sha256 !== newHash ||
    audit.proof.failure_phase !== 'artifact_hashing' ||
    audit.proof.live_server_artifact_sha256 !== liveServerHash ||
    audit.proof.installed_cache_policy_sha256 !== cachePolicyHash ||
    receipt.recovery_audit_sha256 !== digest ||
    receipt.recovery_cache_policy_sha256 !== cachePolicyHash ||
    receipt.updater_hash !== newHash) process.exit(1);
NODE
audit_before=$(sha256sum "$TEST_ROOT/control/op-hash-recovery.prepare-recovery.json" | cut -d' ' -f1)
controller_prepare op-hash-recovery "$TARGET_A" "$fixed_prepare_updater_hash" \
  "$TOKEN_N" test/t487 "$trusted_cache_policy_hash" >/dev/null
assert 'exact PREPARE retransmission does not replace the recovery audit' \
  test "$(sha256sum "$TEST_ROOT/control/op-hash-recovery.prepare-recovery.json" | cut -d' ' -f1)" = \
    "$audit_before"
cp "$TEST_ROOT/updater-prepare-capable" "$TEST_ROOT/updater"
chmod 0755 "$TEST_ROOT/updater"

export ASH_ATLAS_TEST_UPDATER_FAIL=true
controller_prepare op-migration-intent "$TARGET_A" "$prepare_updater_hash" "$TOKEN_G" test/t486 >/dev/null || true
for _ in {1..50}; do
  migration_intent_failed_output=$("$CONTROLLER" status op-migration-intent 2>/dev/null || true)
  [[ $(printf '%s' "$migration_intent_failed_output" | json_field result) = failed ]] && break
  sleep 0.1
done
unset ASH_ATLAS_TEST_UPDATER_FAIL
touch "$TEST_ROOT/control/op-migration-intent.migration-intent"
migration_intent_starts_before=$(wc -l < "$TEST_ROOT/state/updater-starts.log")
set +e
migration_intent_resume_output=$("$CONTROLLER" resume op-migration-intent 2>&1)
migration_intent_resume_code=$?
set -e
migration_intent_starts_after=$(wc -l < "$TEST_ROOT/state/updater-starts.log")
assert 'failed migration intent marker prevents controller retry' \
  bash -c '[[ "$1" = 3 && "$2" = "$3" && "$4" = failed ]]' bash \
    "$migration_intent_resume_code" "$migration_intent_starts_before" \
    "$migration_intent_starts_after" \
    "$(printf '%s' "$migration_intent_resume_output" | json_field result)"

"$CONTROLLER" resume op-prepare-retry >/dev/null
for _ in {1..50}; do
  retried_prepare_output=$("$CONTROLLER" status op-prepare-retry 2>/dev/null || true)
  [[ $(printf '%s' "$retried_prepare_output" | json_field result) = prepared ]] && break
  sleep 0.1
done
assert 'the same failed PREPARE operation resumes to PREPARED after its cause is fixed' \
  bash -c '[[ "$1" = prepared && "$2" = 1 ]]' bash \
    "$(printf '%s' "$retried_prepare_output" | json_field result)" \
    "$(printf '%s' "$retried_prepare_output" | json_field transaction_retry_count)"
controller_prepare op-prepare "$TARGET_A" "$prepare_updater_hash" "$TOKEN_K" test/t1000 >/dev/null
prepared_ready=0
for _ in {1..50}; do
  if prepared_output=$("$CONTROLLER" status op-prepare 2>/dev/null); then
    if [[ $(printf '%s' "$prepared_output" | json_field result) = prepared &&
          $(printf '%s' "$prepared_output" | json_field prepare_result) = completed &&
          $(printf '%s' "$prepared_output" | json_field controller_state) = consistent &&
          $(printf '%s' "$prepared_output" | json_field unit_state) = inactive &&
          $(printf '%s' "$prepared_output" | json_field prepared_remote_receipt_sha256) =~ ^[0-9a-f]{64}$ ]]; then
      prepared_ready=1
      break
    fi
  fi
  sleep 0.1
done
assert 'PREPARE status reaches a consistent inactive receipt with its remote hash' \
  test "$prepared_ready" -eq 1
assert 'PREPARE reaches one durable prepared receipt' \
  bash -c '[[ "$1" = prepared && "$2" = completed && "$3" = test/t1000 ]]' bash \
    "$(printf '%s' "$prepared_output" | json_field result)" \
    "$(printf '%s' "$prepared_output" | json_field prepare_result)" \
    "$(printf '%s' "$prepared_output" | json_field prepared_generation)"
assert 'PREPARE persists the versioned component descriptor' \
  bash -c '[[ "$1" = 3 && "$2" = server_no_migration && "$3" = "$4" ]]' bash \
    "$(printf '%s' "$prepared_output" | json_field prepared_descriptor_version)" \
    "$(printf '%s' "$prepared_output" | json_field release_class)" \
    "$(printf '%s' "$prepared_output" | json_field prepared_server_component_sha)" "$TARGET_A"
assert 'PREPARE leaves both live release symlinks unchanged' \
  bash -c '[[ "$(readlink -e "$1")" = "$3" && "$(readlink -e "$2")" = "$4" ]]' bash \
    "$ASH_ATLAS_GAME_CURRENT" "$ASH_ATLAS_PUBLIC_CURRENT" \
    "$prepared_previous_game" "$prepared_previous_public"
write_activation_registry op-prepare "$TARGET_A"
"$CONTROLLER" resume op-prepare >/dev/null
assert 'resume preserves PREPARED without implicitly activating it' \
  test "$(json_field result < "$TEST_ROOT/control/op-prepare.json")" = prepared
set +e
"$CONTROLLER" activate op-prepare "$TARGET_A" "$prepare_updater_hash" test/t1000 op-prepare "$TARGET_C" >/dev/null 2>&1
premature_activate_code=$?
set -e
assert 'ACTIVATE fails closed until all protected refs equal the prepared target' \
  bash -c '[[ "$1" -ne 0 && "$("$2" -e "process.stdout.write(JSON.parse(require(\"node:fs\").readFileSync(process.argv[1],\"utf8\")).result)" "$3")" = prepared ]]' \
    bash "$premature_activate_code" "$NODE_BIN" "$TEST_ROOT/control/op-prepare.json"
export ASH_ATLAS_TEST_REMOTE_MASTER_SHA="$TARGET_A"
export ASH_ATLAS_TEST_REMOTE_INTEGRATION_SHA="$TARGET_A"
export ASH_ATLAS_TEST_REMOTE_GENERATION_SHA="$TARGET_A"
"$CONTROLLER" activate op-prepare "$TARGET_A" "$prepare_updater_hash" test/t1000 op-prepare "$TARGET_C" >/dev/null
for _ in {1..50}; do
  activated_output=$("$CONTROLLER" status op-prepare 2>/dev/null || true)
  [[ $(printf '%s' "$activated_output" | json_field result) = completed ]] && break
  sleep 0.1
done
assert 'ACTIVATE completes only the exact protected and prepared target' \
  bash -c '[[ "$1" = completed && "$2" = "$3" ]]' bash \
    "$(printf '%s' "$activated_output" | json_field result)" \
    "$(readlink -e "$ASH_ATLAS_GAME_CURRENT")" "$TEST_ROOT/releases/game/$TARGET_A"
"$NODE_BIN" - "$TEST_ROOT/control/op-prepare.json" <<'NODE'
const fs = require("node:fs");
const path = process.argv[2];
const receipt = JSON.parse(fs.readFileSync(path, "utf8"));
Object.assign(receipt, {
  result: "failed",
  current_phase: "release_retention_post_activation",
  failure_phase: "release_retention_post_activation",
  failure_code: "release_retention_post_activation_failed",
  failure_message: "post-activation diagnostic failed",
  activation_started: true,
  activation_completed: true,
  activation_result: "completed",
  readiness_result: "completed"
});
fs.writeFileSync(path, `${JSON.stringify(receipt)}\n`);
NODE
"$CONTROLLER" activate op-prepare "$TARGET_A" "$prepare_updater_hash" test/t1000 op-prepare "$TARGET_C" >/dev/null
post_activation_reconciled=$($CONTROLLER status op-prepare)
assert 'a post-activation failure finalizes through the same operation without another activation' \
  bash -c '[[ "$1" = completed && "$2" = completed && "$3" = 1 && "$4" = 2 ]]' bash \
    "$(printf '%s' "$post_activation_reconciled" | json_field result)" \
    "$(printf '%s' "$post_activation_reconciled" | json_field post_activation_reconciliation_result)" \
    "$(printf '%s' "$post_activation_reconciled" | json_field transaction_retry_count)" \
    "$(grep -c '^op-prepare ' "$TEST_ROOT/state/updater-starts.log")"
"$NODE_BIN" - "$TEST_ROOT/control/op-prepare.json" <<'NODE'
const fs = require("node:fs");
const path = process.argv[2];
const receipt = JSON.parse(fs.readFileSync(path, "utf8"));
Object.assign(receipt, {
  result: "failed",
  current_phase: "release_retention_post_activation",
  failure_phase: "release_retention_post_activation",
  failure_code: "release_retention_post_activation_failed",
  failure_message: "post-activation diagnostic failed"
});
fs.writeFileSync(path, `${JSON.stringify(receipt)}\n`);
NODE
export ASH_ATLAS_TEST_REMOTE_INTEGRATION_SHA="$TARGET_C"
export ASH_ATLAS_TEST_REMOTE_INTEGRATION_DESCENDANT_OF="$TARGET_A"
"$CONTROLLER" activate op-prepare "$TARGET_A" "$prepare_updater_hash" test/t1000 op-prepare "$TARGET_C" >/dev/null
descendant_reconciled=$($CONTROLLER status op-prepare)
assert 'post-activation finalization permits only an explicitly proven immutable integration descendant' \
  bash -c '[[ "$1" = completed && "$2" = 2 && "$3" = 2 ]]' bash \
    "$(printf '%s' "$descendant_reconciled" | json_field result)" \
    "$(printf '%s' "$descendant_reconciled" | json_field transaction_retry_count)" \
    "$(grep -c '^op-prepare ' "$TEST_ROOT/state/updater-starts.log")"
unset ASH_ATLAS_TEST_REMOTE_INTEGRATION_DESCENDANT_OF
export ASH_ATLAS_TEST_REMOTE_CANDIDATE_SHA="$TARGET_B"
controller_prepare op-activate-retry "$TARGET_B" "$prepare_updater_hash" "$TOKEN_M" test/t485 >/dev/null
for _ in {1..50}; do
  retry_activation_prepare=$("$CONTROLLER" status op-activate-retry 2>/dev/null || true)
  [[ $(printf '%s' "$retry_activation_prepare" | json_field result) = prepared &&
     $(printf '%s' "$retry_activation_prepare" | json_field prepare_result) = completed &&
     $(printf '%s' "$retry_activation_prepare" | json_field controller_state) = consistent &&
     $(printf '%s' "$retry_activation_prepare" | json_field unit_state) = inactive &&
     $(printf '%s' "$retry_activation_prepare" | json_field prepared_remote_receipt_sha256) =~ ^[0-9a-f]{64}$ ]] && break
  sleep 0.1
done
write_activation_registry op-activate-retry "$TARGET_B"
export ASH_ATLAS_TEST_REMOTE_MASTER_SHA="$TARGET_B"
export ASH_ATLAS_TEST_REMOTE_INTEGRATION_SHA="$TARGET_B"
export ASH_ATLAS_TEST_REMOTE_GENERATION_SHA="$TARGET_B"
export ASH_ATLAS_TEST_UPDATER_FAIL=true
"$CONTROLLER" activate op-activate-retry "$TARGET_B" "$prepare_updater_hash" test/t485 op-activate-retry "$TARGET_C" >/dev/null || true
for _ in {1..50}; do
  failed_activation_output=$("$CONTROLLER" status op-activate-retry 2>/dev/null || true)
  [[ $(printf '%s' "$failed_activation_output" | json_field result) = failed ]] && break
  sleep 0.1
done
unset ASH_ATLAS_TEST_UPDATER_FAIL
retry_activation_registry_commit_sha=$(printf '%s' "$failed_activation_output" | json_field activation_registry_commit_sha)
assert 'failed ACTIVATE preserves the original registry commit identity for retry' \
  test "$retry_activation_registry_commit_sha" = "$(json_field activation_registry_commit_sha < "$TEST_ROOT/control/op-activate-retry.json")"
"$CONTROLLER" resume op-activate-retry >/dev/null
for _ in {1..50}; do
  retried_activation_output=$("$CONTROLLER" status op-activate-retry 2>/dev/null || true)
  [[ $(printf '%s' "$retried_activation_output" | json_field result) = completed ]] && break
  sleep 0.1
done
assert 'a pre-activation post-publication failure resumes through the same durable operation' \
  bash -c '[[ "$1" = failed && "$2" = completed && "$3" = 1 ]]' bash \
    "$(printf '%s' "$failed_activation_output" | json_field result)" \
    "$(printf '%s' "$retried_activation_output" | json_field result)" \
    "$(printf '%s' "$retried_activation_output" | json_field transaction_retry_count)"
assert 'failed ACTIVATE retry keeps the original registry commit identity' \
  test "$(printf '%s' "$retried_activation_output" | json_field activation_registry_commit_sha)" = \
    "$retry_activation_registry_commit_sha"
export ASH_ATLAS_TEST_REMOTE_MASTER_SHA="$TARGET_A"
export ASH_ATLAS_TEST_REMOTE_INTEGRATION_SHA="$TARGET_A"
export ASH_ATLAS_TEST_REMOTE_GENERATION_SHA="$TARGET_A"
cleanup_output=$("$CONTROLLER" cleanup op-prepare)
assert 'terminal cleanup leaves a durable distinguishable removal record' \
  test "$(printf '%s' "$cleanup_output" | json_field operation_state)" = terminally_removed
removed_output=$("$CONTROLLER" status op-prepare)
assert 'status reports a terminally removed operation truthfully' \
  test "$(printf '%s' "$removed_output" | json_field operation_state)" = terminally_removed
assert 'the deployment lock file inode is never deleted or replaced' \
  test "$(stat -c %i "$ASH_ATLAS_DEPLOY_LOCK")" = "$deploy_lock_inode"

printf 'deploy-control.tests.sh: %s assertions passed.\n' "$passed"
