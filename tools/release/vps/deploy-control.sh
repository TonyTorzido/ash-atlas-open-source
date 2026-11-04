#!/usr/bin/env bash
set -euo pipefail

readonly ACTION=${1:-}
readonly OPERATION_ID=${2:-}
readonly TARGET_SHA=${3:-}
readonly EXPECTED_UPDATER_HASH=${4:-}
readonly REQUEST_ARGUMENT=${5:-}
readonly PREPARE_RELEASE_MODE=${6:-}
readonly RECOVERY_CACHE_POLICY_SHA=${7:-}
readonly RELEASE_PATCH_NOTES_HEX=${8:-none}
readonly ACTIVATION_INTENT_ID=${6:-}
readonly ACTIVATION_REGISTRY_COMMIT_SHA=${7:-}
readonly CONTROLLER_VERSION=7
readonly NODE_BIN=${ASH_ATLAS_NODE_BIN:-$(command -v node 2>/dev/null || command -v node.exe 2>/dev/null || printf /usr/bin/node)}
readonly LOCK_WAIT_INTERVAL=${ASH_ATLAS_DEPLOY_LOCK_WAIT_INTERVAL:-2}

if [[ ${ASH_ATLAS_DEPLOY_CONTROL_TEST_MODE:-false} = true ]]; then
  CONTROL_ROOT=${ASH_ATLAS_DEPLOY_CONTROL_ROOT:?}
  STATUS_ROOT=${ASH_ATLAS_DEPLOY_STATUS_ROOT:?}
  LOG_ROOT=${ASH_ATLAS_DEPLOY_LOG_ROOT:?}
  CONTROL_LOCK=${ASH_ATLAS_DEPLOY_CONTROL_LOCK:?}
  DEPLOY_LOCK=${ASH_ATLAS_DEPLOY_LOCK:?}
  ACTIVE_MARKER=${ASH_ATLAS_DEPLOY_ACTIVE_MARKER:?}
  REMOVED_ROOT=${ASH_ATLAS_DEPLOY_REMOVED_ROOT:-$CONTROL_ROOT/terminally-removed}
  UPDATER=${ASH_ATLAS_DEPLOY_UPDATER:?}
  TIMING_ROOT=${ASH_ATLAS_DEPLOY_TIMING_ROOT:?}
  GAME_CURRENT=${ASH_ATLAS_GAME_CURRENT:-/srv/ash-atlas/game/current}
  PUBLIC_CURRENT=${ASH_ATLAS_PUBLIC_CURRENT:-/srv/www/playashatlas/current}
  GAME_RELEASE_ROOT=${ASH_ATLAS_GAME_RELEASE_ROOT:-/srv/ash-atlas/game/releases}
  PUBLIC_RELEASE_ROOT=${ASH_ATLAS_PUBLIC_RELEASE_ROOT:-/srv/www/playashatlas/game-releases}
  MIRROR_ROOT=${ASH_ATLAS_MIRROR_ROOT:-}
  MOBILE_REGISTRY_REF=${ASH_ATLAS_MOBILE_REGISTRY_REF:-refs/heads/mobile-release-state}
  TEST_MOBILE_REGISTRY_PATH=${ASH_ATLAS_TEST_MOBILE_REGISTRY_PATH:-}
  TEST_MOBILE_REGISTRY_COMMIT_SHA=${ASH_ATLAS_TEST_MOBILE_REGISTRY_COMMIT_SHA:-}
  CADDY_CACHE_POLICY=${ASH_ATLAS_TEST_CACHE_POLICY_PATH:-/etc/caddy/game-cache-policy.caddy}
  REPOSITORY=${ASH_ATLAS_DEPLOY_REPOSITORY:-fixture}
  SYSTEMCTL=${ASH_ATLAS_SYSTEMCTL:-systemctl}
else
  readonly CONTROLLER_CONFIG=${ASH_ATLAS_CONTROLLER_CONFIG:-/etc/ash-atlas/deployment-controller.conf}
  [[ -f "$CONTROLLER_CONFIG" && ! -L "$CONTROLLER_CONFIG" ]] ||
    { printf 'STOP: canonical deployment controller configuration is absent or unsafe\n' >&2; exit 1; }
  # shellcheck disable=SC1090,SC1091
  source "$CONTROLLER_CONFIG"
  readonly CONTROL_ROOT=${ASH_ATLAS_CONTROL_ROOT:?}
  readonly STATUS_ROOT=${ASH_ATLAS_STATUS_ROOT:?}
  readonly LOG_ROOT=${ASH_ATLAS_LOG_ROOT:?}
  readonly CONTROL_LOCK=${ASH_ATLAS_CONTROL_LOCK:?}
  readonly DEPLOY_LOCK=${ASH_ATLAS_DEPLOY_LOCK:?}
  readonly ACTIVE_MARKER=$CONTROL_ROOT/active-operation
  readonly REMOVED_ROOT=$CONTROL_ROOT/terminally-removed
  readonly UPDATER=${ASH_ATLAS_UPDATER:?}
  readonly TIMING_ROOT=${ASH_ATLAS_TIMING_ROOT:?}
  readonly GAME_CURRENT=${ASH_ATLAS_GAME_CURRENT:?}
  readonly PUBLIC_CURRENT=${ASH_ATLAS_PUBLIC_CURRENT:?}
  readonly GAME_RELEASE_ROOT=${ASH_ATLAS_GAME_RELEASE_ROOT:?}
  readonly PUBLIC_RELEASE_ROOT=${ASH_ATLAS_PUBLIC_RELEASE_ROOT:?}
  readonly MIRROR_ROOT=${ASH_ATLAS_MIRROR_ROOT:?}
  readonly MOBILE_REGISTRY_REF=${ASH_ATLAS_MOBILE_REGISTRY_REF:-refs/heads/mobile-release-state}
  readonly TEST_MOBILE_REGISTRY_PATH=
  readonly TEST_MOBILE_REGISTRY_COMMIT_SHA=
  readonly CADDY_CACHE_POLICY=/etc/caddy/game-cache-policy.caddy
  readonly REPOSITORY=github.com:example-org/game.git
  readonly SYSTEMCTL=systemctl
fi

fail() {
  printf 'STOP: %s\n' "$*" >&2
  exit 1
}

now_utc() {
  date -u +%Y-%m-%dT%H:%M:%SZ
}

validate_operation_id() {
  [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$ ]] ||
    fail 'operation ID must contain only 1-96 safe systemd-instance characters'
}

validate_sha() {
  [[ "$1" =~ ^[0-9a-f]{40}$ ]] || fail 'target must be an exact lowercase 40-character SHA'
}

validate_hash() {
  [[ "$1" =~ ^[0-9a-f]{64}$ ]] || fail 'updater hash must be an exact lowercase SHA-256'
}

validate_release_mode() {
  [[ "$1" = active || "$1" = paused ]] ||
    fail 'release mode must be active or paused'
}

validate_status_token() {
  [[ "$1" =~ ^[0-9a-f]{64}$ ]] ||
    fail 'deployment status token must be an exact lowercase 256-bit hex value'
}

receipt_path() {
  printf '%s/%s.json\n' "$CONTROL_ROOT" "$1"
}

removed_path() {
  printf '%s/%s.json\n' "$REMOVED_ROOT" "$1"
}

status_token_path() {
  printf '%s/%s.status-token\n' "$CONTROL_ROOT" "$1"
}

migration_intent_path() {
  printf '%s/%s.migration-intent\n' "$CONTROL_ROOT" "$1"
}

prepare_recovery_audit_path() {
  printf '%s/%s.prepare-recovery.json\n' "$CONTROL_ROOT" "$1"
}

status_document_path() {
  printf '%s/%s.json\n' "$STATUS_ROOT" "$1"
}

log_path() {
  printf '%s/%s.log\n' "$LOG_ROOT" "$1"
}

unit_name() {
  printf 'ash-atlas-deploy@%s.service\n' "$1"
}

provision_roots() {
  if [[ ${ASH_ATLAS_DEPLOY_CONTROL_TEST_MODE:-false} = true ]]; then
    install -d -m 0750 "$CONTROL_ROOT" "$REMOVED_ROOT" "$STATUS_ROOT" "$LOG_ROOT" "$TIMING_ROOT" \
      "$(dirname "$CONTROL_LOCK")" "$(dirname "$DEPLOY_LOCK")"
  else
    install -d -o root -g ash-atlas -m 0750 "$CONTROL_ROOT" "$REMOVED_ROOT" "$LOG_ROOT"
    [[ ! -L "$STATUS_ROOT" ]] || fail 'deployment status root is an unsafe symbolic link'
    install -d -o root -g caddy -m 0750 "$STATUS_ROOT"
    install -d -o root -g root -m 0755 "$(dirname "$CONTROL_LOCK")"
  fi
}

ensure_status_token() {
  local operation=$1
  local token=$2
  local path current
  path=$(status_token_path "$operation")
  if [[ -e "$path" || -L "$path" ]]; then
    [[ -f "$path" && ! -L "$path" ]] || fail 'deployment status token sidecar is unsafe'
    [[ $(stat -c %a "$path") = 600 ]] ||
      fail 'deployment status token sidecar permissions are unsafe'
    if [[ ${ASH_ATLAS_DEPLOY_CONTROL_TEST_MODE:-false} != true ]]; then
      [[ $(stat -c %U:%G "$path") = root:root ]] ||
        fail 'deployment status token sidecar ownership is unsafe'
    fi
    current=$(<"$path")
    [[ "$current" = "$token" ]] ||
      fail 'operation ID already belongs to a different deployment status token'
    return
  fi
  "$NODE_BIN" - "$path" "$token" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [target, token] = process.argv.slice(2);
const temporary = `${target}.${process.pid}.tmp`;
let file;
try {
  file = fs.openSync(temporary, "wx", 0o600);
  fs.writeFileSync(file, `${token}\n`);
  fs.fsyncSync(file);
  fs.closeSync(file);
  file = undefined;
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, target);
  const directory = fs.openSync(path.dirname(target), "r");
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  if (fs.readFileSync(target, "utf8") !== `${token}\n`) {
    throw new Error("persisted status token validation failed");
  }
} catch (error) {
  if (file !== undefined) {
    try { fs.closeSync(file); } catch {}
  }
  try { fs.rmSync(temporary, { force: true }); } catch {}
  throw error;
}
NODE
}

publish_status_for_operation() {
  local operation=$1
  local receipt token_path token status_path observed_game observed_public production_mode
  receipt=$(receipt_path "$operation")
  token_path=$(status_token_path "$operation")
  [[ -f "$receipt" && ! -L "$receipt" ]] || return 1
  [[ -e "$token_path" || -L "$token_path" ]] || return 0
  [[ -f "$token_path" && ! -L "$token_path" ]] || return 1
  [[ $(stat -c %a "$token_path") = 600 ]] || return 1
  if [[ ${ASH_ATLAS_DEPLOY_CONTROL_TEST_MODE:-false} != true ]]; then
    [[ $(stat -c %U:%G "$token_path") = root:root ]] || return 1
  fi
  token=$(<"$token_path")
  [[ "$token" =~ ^[0-9a-f]{64}$ ]] || return 1
  status_path=$(status_document_path "$token")
  observed_game=$(readlink -e "$GAME_CURRENT" 2>/dev/null || true)
  observed_public=$(readlink -e "$PUBLIC_CURRENT" 2>/dev/null || true)
  production_mode=true
  [[ ${ASH_ATLAS_DEPLOY_CONTROL_TEST_MODE:-false} = true ]] && production_mode=false
  "$NODE_BIN" - "$receipt" "$status_path" "${observed_game##*/}" "${observed_public##*/}" \
    "$production_mode" <<'NODE'
const fs = require("node:fs");
let temporary = "";
try {
  const [receiptPath, statusPath, observedGame, observedPublic, productionMode] = process.argv.slice(2);
  const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
  const sha = (value) => typeof value === "string" && /^[0-9a-f]{40}$/.test(value) ? value : "";
  const slug = (value, fallback = "unknown") =>
    typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : fallback;
  const results = new Set(["accepted", "running", "prepared", "completed", "failed"]);
  if (!results.has(receipt.result)) throw new Error("unsupported result");
  if (typeof receipt.operation_id !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(receipt.operation_id)) {
    throw new Error("unsafe operation");
  }
  if (typeof receipt.requested_target_sha !== "string" ||
      !/^[0-9a-f]{40}$/.test(receipt.requested_target_sha)) {
    throw new Error("unsafe target");
  }
  const stageResults = new Set(["pending", "not_required", "running", "completed", "failed"]);
  const simpleStageResults = new Set(["pending", "running", "completed", "failed"]);
  let migration = stageResults.has(receipt.migration_result) ? receipt.migration_result :
    receipt.migration_completed === true ? "completed" :
    receipt.migration_started === true ? "running" :
    receipt.migration_required === false ? "not_required" : "pending";
  let activation = simpleStageResults.has(receipt.activation_result) ? receipt.activation_result :
    receipt.activation_completed === true ? "completed" :
    receipt.activation_started === true ? "running" : "pending";
  let readiness = simpleStageResults.has(receipt.readiness_result) ? receipt.readiness_result :
    receipt.result === "completed" ? "completed" : "pending";
  const failurePhase = receipt.result === "failed" ? slug(receipt.failure_phase) : "";
  const derivedFailureCode = /^[a-z][a-z0-9_]{0,63}$/.test(`${failurePhase}_failed`) ?
    `${failurePhase}_failed` : "deployment_failed";
  const failureCode = receipt.result === "failed" ?
    slug(receipt.failure_code, derivedFailureCode) : "";
  const booleanEvidenceFields = [
    "migration_started", "migration_completed", "migration_outcome_uncertain",
    "activation_started", "activation_completed"
  ];
  const mutationEvidenceComplete = booleanEvidenceFields.every((field) =>
    typeof receipt[field] === "boolean") &&
    typeof receipt.rollback_result === "string";
  if (receipt.result === "failed") {
    if (migration === "running") migration = "failed";
    if (activation === "running") activation = "failed";
    if (readiness === "running") readiness = "failed";
  }
  const activeGame = sha(observedGame);
  const activePublic = sha(observedPublic);
  const expectedGame = receipt.release_class === "client_only" ?
    sha(receipt.prepared_server_component_sha) : receipt.requested_target_sha;
  if (receipt.result === "completed" &&
      (activeGame !== expectedGame ||
       activePublic !== receipt.requested_target_sha ||
       !["completed", "not_required"].includes(migration) ||
       activation !== "completed" ||
       readiness !== "completed" ||
       failurePhase !== "" ||
       failureCode !== "")) {
    throw new Error("completed status invariants failed");
  }
  const status = {
    schema_version: 1,
    operation_id: receipt.operation_id,
    target_sha: receipt.requested_target_sha,
    result: receipt.result,
    current_phase: slug(receipt.current_phase),
    active_game_sha: activeGame,
    active_public_sha: activePublic,
    migration_result: migration,
    activation_result: activation,
    readiness_result: readiness,
    failure_phase: failurePhase,
    failure_code: failureCode,
    mutation_evidence_complete: mutationEvidenceComplete,
    migration_started: typeof receipt.migration_started === "boolean" ? receipt.migration_started : null,
    migration_completed: typeof receipt.migration_completed === "boolean" ? receipt.migration_completed : null,
    migration_outcome_uncertain: typeof receipt.migration_outcome_uncertain === "boolean" ?
      receipt.migration_outcome_uncertain : null,
    activation_started: typeof receipt.activation_started === "boolean" ? receipt.activation_started : null,
    activation_completed: typeof receipt.activation_completed === "boolean" ? receipt.activation_completed : null,
    rollback_result: typeof receipt.rollback_result === "string" ? receipt.rollback_result : null,
    deployment_timings: receipt.deployment_timings ?? null,
    state_transitions: Array.isArray(receipt.state_transitions) ? receipt.state_transitions : [],
    updated_at_utc: new Date().toISOString()
  };
  temporary = `${statusPath}.${process.pid}.tmp`;
  const file = fs.openSync(temporary, "wx", 0o440);
  fs.writeFileSync(file, `${JSON.stringify(status, null, 2)}\n`);
  fs.fsyncSync(file);
  fs.closeSync(file);
  fs.chmodSync(temporary, 0o440);
  if (productionMode === "true") {
    fs.chownSync(temporary, 0, fs.statSync(require("node:path").dirname(statusPath)).gid);
  }
  fs.renameSync(temporary, statusPath);
  const directory = fs.openSync(require("node:path").dirname(statusPath), "r");
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  JSON.parse(fs.readFileSync(statusPath, "utf8"));
} catch {
  if (temporary) {
    try { fs.rmSync(temporary, { force: true }); } catch {}
  }
  process.stderr.write("deployment status projection failed\n");
  process.exit(1);
}
NODE
}

receipt_update_raw() {
  local path=$1
  shift
  "$NODE_BIN" - "$path" "$$" "$@" <<'NODE'
const fs = require("node:fs");
const [path, producerPid] = process.argv.slice(2, 4);
const pairs = process.argv.slice(4);
if (pairs.length % 2) throw new Error("receipt patch requires key/value pairs");
let value = {};
if (fs.existsSync(path)) value = JSON.parse(fs.readFileSync(path, "utf8"));
const previousPhase = typeof value.current_phase === "string" ? value.current_phase : "unknown";
for (let index = 0; index < pairs.length; index += 2) {
  const key = pairs[index];
  const raw = pairs[index + 1];
  if (raw === "__NULL__") value[key] = null;
  else if (raw === "__TRUE__") value[key] = true;
  else if (raw === "__FALSE__") value[key] = false;
  else if (raw.startsWith("__NUMBER__")) value[key] = Number(raw.slice(10));
  else if (raw.startsWith("__JSON__")) value[key] = JSON.parse(raw.slice(8));
  else value[key] = raw;
}
const nextPhase = typeof value.current_phase === "string" ? value.current_phase : "unknown";
if (nextPhase !== previousPhase) {
  const timestamp = new Date();
  const history = Array.isArray(value.state_transitions) ? value.state_transitions : [];
  const previousTimestamp = history.length > 0 ? Date.parse(history[history.length - 1].timestamp_utc) : NaN;
  history.push({
    timestamp_utc: timestamp.toISOString(),
    operation_id: value.operation_id,
    previous_state: previousPhase,
    next_state: nextPhase,
    elapsed_previous_state_ms: Number.isFinite(previousTimestamp) ?
      Math.max(0, timestamp.getTime() - previousTimestamp) : 0,
    reason: "controller_receipt_update",
    process_pid: Number(producerPid),
    scope: "remote_controller"
  });
  value.state_transitions = history.slice(-256);
}
const temporary = `${path}.${process.pid}.tmp`;
let file;
try {
  file = fs.openSync(temporary, "wx", 0o640);
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  fs.fsyncSync(file);
  fs.closeSync(file);
  file = undefined;
  try { fs.chownSync(temporary, 0, Number(process.env.ASH_ATLAS_RECEIPT_GID || 0)); } catch {}
  fs.chmodSync(temporary, 0o640);
  fs.renameSync(temporary, path);
  const directory = fs.openSync(require("node:path").dirname(path), "r");
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  const persisted = JSON.parse(fs.readFileSync(path, "utf8"));
  if (JSON.stringify(persisted) !== JSON.stringify(value)) {
    throw new Error("persisted receipt validation failed");
  }
} catch (error) {
  if (file !== undefined) {
    try { fs.closeSync(file); } catch {}
  }
  try { fs.rmSync(temporary, { force: true }); } catch {}
  throw error;
}
NODE
}

record_status_projection_result() {
  local path=$1
  local result=$2
  local message=${3:-}
  "$NODE_BIN" - "$path" "$result" "$message" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [target, result, message] = process.argv.slice(2);
const value = JSON.parse(fs.readFileSync(target, "utf8"));
value.status_projection_result = result;
value.status_projection_updated_at_utc = new Date().toISOString();
if (result === "failed") {
  value.status_projection_failure_count =
    Number.isSafeInteger(value.status_projection_failure_count) ?
      value.status_projection_failure_count + 1 : 1;
  value.status_projection_last_error = message || "projection_failed";
} else {
  value.status_projection_last_error = "";
}
const temporary = `${target}.${process.pid}.tmp`;
const file = fs.openSync(temporary, "wx", 0o640);
try {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  fs.fsyncSync(file);
} finally {
  fs.closeSync(file);
}
try { fs.chownSync(temporary, 0, Number(process.env.ASH_ATLAS_RECEIPT_GID || 0)); } catch {}
fs.chmodSync(temporary, 0o640);
fs.renameSync(temporary, target);
const directory = fs.openSync(path.dirname(target), "r");
try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
JSON.parse(fs.readFileSync(target, "utf8"));
NODE
}

receipt_update() {
  local path=$1
  shift
  receipt_update_raw "$path" "$@"
  local operation=${path##*/}
  operation=${operation%.json}
  if ! publish_status_for_operation "$operation"; then
    record_status_projection_result "$path" failed projection_failed
    printf 'WARNING: deployment HTTPS status could not be published for %s\n' "$operation" >&2
  else
    record_status_projection_result "$path" published
  fi
}

prepared_receipt_sha() {
  local path=$1
  "$NODE_BIN" - "$path" <<'NODE'
const fs = require("node:fs");
const { createHash } = require("node:crypto");
const path = process.argv[2];
const ignored = new Set([
  "prepared_remote_receipt_sha256",
  "status_projection_result",
  "status_projection_updated_at_utc",
  "status_projection_failure_count",
  "status_projection_last_error"
]);
const canonical = (value, key = "") => {
  if (Array.isArray(value)) return value.map((entry) => canonical(entry));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).filter((name) => !ignored.has(name)).sort()
      .map((name) => [name, canonical(value[name], name)]));
  }
  return value;
};
const receipt = JSON.parse(fs.readFileSync(path, "utf8"));
process.stdout.write(createHash("sha256").update(JSON.stringify(canonical(receipt))).digest("hex"));
NODE
}

validate_status_projection() {
  local operation=$1
  local receipt token status_path
  receipt=$(receipt_path "$operation")
  token=$(<"$(status_token_path "$operation")")
  status_path=$(status_document_path "$token")
  "$NODE_BIN" - "$receipt" "$status_path" "$operation" <<'NODE'
const fs = require("node:fs");
const [receiptPath, statusPath, operation] = process.argv.slice(2);
const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
const status = JSON.parse(fs.readFileSync(statusPath, "utf8"));
if (status.schema_version !== 1 ||
    status.operation_id !== operation ||
    status.target_sha !== receipt.requested_target_sha ||
    status.result !== receipt.result ||
    status.current_phase !== receipt.current_phase ||
    JSON.stringify(status.deployment_timings) !==
      JSON.stringify(receipt.deployment_timings ?? null) ||
    JSON.stringify(status.state_transitions) !==
      JSON.stringify(receipt.state_transitions ?? [])) {
  throw new Error("persisted HTTPS projection failed authoritative validation");
}
NODE
}

publish_status_required() {
  local operation=$1
  local receipt
  receipt=$(receipt_path "$operation")
  if ! publish_status_for_operation "$operation"; then
    record_status_projection_result "$receipt" failed projection_failed
    fail 'deployment HTTPS status could not be durably projected'
  fi
  validate_status_projection "$operation" ||
    {
      record_status_projection_result "$receipt" failed projection_validation_failed
      fail 'deployment HTTPS status failed its durable reread'
    }
  record_status_projection_result "$receipt" published
}

read_receipt_field() {
  local path=$1
  local field=$2
  "$NODE_BIN" - "$path" "$field" "${3:-}" <<'NODE'
const fs = require("node:fs");
const value = JSON.parse(fs.readFileSync(process.argv[2], "utf8"))[process.argv[3]];
process.stdout.write(value === undefined || value === null ? process.argv[4] : String(value));
NODE
}

validate_persisted_acceptance() {
  local path=$1 operation=$2 target=$3 updater_hash=$4
  "$NODE_BIN" - "$path" "$operation" "$target" "$updater_hash" <<'NODE'
const fs = require("node:fs");
const [path, operation, target, updaterHash] = process.argv.slice(2);
const receipt = JSON.parse(fs.readFileSync(path, "utf8"));
if (receipt.schema_version !== 1 ||
    receipt.operation_id !== operation ||
    receipt.requested_target_sha !== target ||
    receipt.updater_hash !== updaterHash ||
    receipt.result !== "accepted" ||
    receipt.current_phase !== "accepted") {
  throw new Error("persisted acceptance receipt failed validation");
}
NODE
}

emit_receipt() {
  local path=$1
  local unit_state=$2
  local controller_state=$3
  local observed_game observed_public lock_diagnostics
  observed_game=$(readlink -e "$GAME_CURRENT" 2>/dev/null || true)
  observed_public=$(readlink -e "$PUBLIC_CURRENT" 2>/dev/null || true)
  lock_diagnostics=${RECON_LOCK_DIAGNOSTICS:-'{}'}
  "$NODE_BIN" - "$path" "$unit_state" "$controller_state" \
    "${observed_game##*/}" "${observed_public##*/}" \
    "${RECON_LOCK_CLASSIFICATION:-unknown}" "$lock_diagnostics" <<'NODE'
const fs = require("node:fs");
const receipt = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
receipt.unit_state = process.argv[3];
receipt.controller_state = process.argv[4];
receipt.observed_game_sha = process.argv[5];
receipt.observed_public_sha = process.argv[6];
receipt.execution_lock_classification = process.argv[7];
try { receipt.observed_execution_lock = JSON.parse(process.argv[8]); } catch {}
process.stdout.write(`${JSON.stringify(receipt)}\n`);
NODE
}

emit_absent() {
  local unit_state=$1
  local controller_state=$2
  local observed_game observed_public lock_diagnostics
  observed_game=$(readlink -e "$GAME_CURRENT" 2>/dev/null || true)
  observed_public=$(readlink -e "$PUBLIC_CURRENT" 2>/dev/null || true)
  lock_diagnostics=${RECON_LOCK_DIAGNOSTICS:-'{}'}
  "$NODE_BIN" - "$OPERATION_ID" "$unit_state" "$controller_state" \
    "${observed_game##*/}" "${observed_public##*/}" \
    "${RECON_LOCK_CLASSIFICATION:-unknown}" "$lock_diagnostics" <<'NODE'
process.stdout.write(`${JSON.stringify({
  schema_version: 1,
  operation_id: process.argv[2],
  result: "absent",
  current_phase: "not-submitted",
  unit_state: process.argv[3],
  controller_state: process.argv[4],
  observed_game_sha: process.argv[5],
  observed_public_sha: process.argv[6],
  execution_lock_classification: process.argv[7],
  observed_execution_lock: (() => { try { return JSON.parse(process.argv[8]); } catch { return null; } })()
})}\n`);
NODE
}

classify_receipt_state() {
  local receipt token removed
  receipt=$(receipt_path "$OPERATION_ID")
  token=$(status_token_path "$OPERATION_ID")
  removed=$(removed_path "$OPERATION_ID")
  "$NODE_BIN" - "$receipt" "$token" "$removed" <<'NODE'
const fs = require("node:fs");
const [receipt, token, removed] = process.argv.slice(2);
function exists(path) {
  try { fs.lstatSync(path); return true; }
  catch (error) {
    if (error.code === "ENOENT") return false;
    process.stdout.write("permission_failure");
    process.exit(0);
  }
}
if (!exists(receipt)) {
  if (exists(removed)) process.stdout.write("terminally_removed");
  else if (exists(token)) process.stdout.write("incomplete_acceptance");
  else process.stdout.write("genuinely_unknown");
  process.exit(0);
}
let stat;
try { stat = fs.lstatSync(receipt); }
catch { process.stdout.write("permission_failure"); process.exit(0); }
if (!stat.isFile() || stat.isSymbolicLink()) {
  process.stdout.write("unreadable_receipt");
  process.exit(0);
}
let value;
try { value = JSON.parse(fs.readFileSync(receipt, "utf8")); }
catch (error) {
  process.stdout.write(error instanceof SyntaxError ? "malformed_receipt" : "permission_failure");
  process.exit(0);
}
if (value.schema_version !== 1) {
  process.stdout.write("controller_version_mismatch");
  process.exit(0);
}
process.stdout.write("readable");
NODE
}

emit_operation_state() {
  local operation_state=$1 unit_state=$2 controller_state=$3
  "$NODE_BIN" - "$OPERATION_ID" "$operation_state" "$unit_state" "$controller_state" <<'NODE'
const [operation, operationState, unitState, controllerState] = process.argv.slice(2);
const results = {
  genuinely_unknown: "absent",
  terminally_removed: "removed",
  incomplete_acceptance: "incomplete",
  unreadable_receipt: "unreadable",
  malformed_receipt: "malformed",
  permission_failure: "permission_failure",
  controller_version_mismatch: "version_mismatch"
};
process.stdout.write(`${JSON.stringify({
  schema_version: 1,
  operation_id: operation,
  result: results[operationState] || "unknown",
  current_phase: operationState,
  operation_state: operationState,
  unit_state: unitState,
  controller_state: controllerState
})}\n`);
NODE
}

unit_state() {
  local unit
  unit=$(unit_name "$1")
  "$SYSTEMCTL" show "$unit" --property=ActiveState --value 2>/dev/null || printf 'inactive\n'
}

lock_owner_diagnostics() {
  "$NODE_BIN" - "$DEPLOY_LOCK" "$OPERATION_ID" "$$" <<'NODE'
const fs = require("node:fs");
const lockPath = process.argv[2];
const currentOperation = process.argv[3];
const currentPid = Number(process.argv[4]);
const safeRead = (path, fallback = "") => {
  try { return fs.readFileSync(path, "utf8"); } catch { return fallback; }
};
let lockStat;
try {
  lockStat = fs.statSync(lockPath);
} catch (error) {
  if (error.code === "ENOENT") {
    process.stdout.write(`${JSON.stringify({ state: "free", classification: "free", owners: [] })}\n`);
    process.exit(0);
  }
  process.stdout.write(`${JSON.stringify({
    state: "unknown",
    classification: "unknown_inconsistent_holder",
    diagnostic_error: `lock_stat_${error.code || "failed"}`,
    owners: []
  })}\n`);
  process.exit(0);
}
const inode = String(lockStat.ino);
const device = BigInt(lockStat.dev);
const deviceMajor = Number(((device >> 8n) & 0xfffn) | ((device >> 32n) & 0xfffff000n));
const deviceMinor = Number((device & 0xffn) | ((device >> 12n) & 0xffffff00n));
const lockPids = new Set();
let procLocks;
try {
  procLocks = fs.readFileSync("/proc/locks", "utf8");
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    state: "unknown",
    classification: "unknown_inconsistent_holder",
    diagnostic_error: `proc_locks_${error.code || "failed"}`,
    owners: []
  })}\n`);
  process.exit(0);
}
for (const line of procLocks.split("\n")) {
  const fields = line.trim().split(/\s+/);
  if (fields.length < 6) continue;
  const lockIdentity = fields[5].split(":");
  if (lockIdentity.length < 3) continue;
  const lockMajor = Number.parseInt(lockIdentity[0], 16);
  const lockMinor = Number.parseInt(lockIdentity[1], 16);
  const lockInode = lockIdentity.at(-1);
  if (lockMajor === deviceMajor && lockMinor === deviceMinor && lockInode === inode &&
      /^-?\d+$/.test(fields[4])) {
    lockPids.add(Number(fields[4]));
  }
}
const fdHolders = new Set();
if (lockPids.size > 0) {
  for (const name of (() => { try { return fs.readdirSync("/proc"); } catch { return []; } })()) {
    if (!/^\d+$/.test(name)) continue;
    let fds;
    try { fds = fs.readdirSync(`/proc/${name}/fd`); } catch { continue; }
    for (const fd of fds) {
      try {
        const stat = fs.statSync(`/proc/${name}/fd/${fd}`);
        if (String(stat.ino) === inode && stat.dev === lockStat.dev) {
          fdHolders.add(Number(name));
          break;
        }
      } catch {}
    }
  }
}
const pidInfo = (pid) => {
  const command = safeRead(`/proc/${pid}/cmdline`).replace(/\0/g, " ").trim().slice(0, 500);
  const cgroup = safeRead(`/proc/${pid}/cgroup`).trim().slice(0, 1000);
  const status = safeRead(`/proc/${pid}/status`);
  const ppid = Number(status.match(/^PPid:\s+(\d+)/m)?.[1] || 0);
  const environment = safeRead(`/proc/${pid}/environ`).split("\0");
  let operationId = environment.find((entry) => entry.startsWith("ASH_ATLAS_OPERATION_ID="))?.slice(23) || "";
  const unitMatch = cgroup.match(/ash-atlas-deploy@([^/\s]+)[.]service/);
  const commandMatch = command.match(/deploy-control[.]sh\s+(?:run|execute)\s+([A-Za-z0-9._-]+)/);
  if (!operationId && unitMatch) operationId = unitMatch[1].replace(/\\x2d/g, "-");
  if (!operationId && commandMatch) operationId = commandMatch[1];
  const unit = unitMatch ? `ash-atlas-deploy@${unitMatch[1]}.service` : "";
  return { pid, ppid, command, cgroup, unit, operation_id: operationId };
};
const isDescendant = (pid, ancestor) => {
  const seen = new Set();
  let candidate = pid;
  while (candidate > 1 && !seen.has(candidate)) {
    if (candidate === ancestor) return true;
    seen.add(candidate);
    const status = safeRead(`/proc/${candidate}/status`);
    candidate = Number(status.match(/^PPid:\s+(\d+)/m)?.[1] || 0);
  }
  return false;
};
const ancestorCommandMatches = (pid, pattern) => {
  const seen = new Set();
  let candidate = pid;
  while (candidate > 1 && !seen.has(candidate)) {
    seen.add(candidate);
    if (pattern.test(safeRead(`/proc/${candidate}/cmdline`).replace(/\0/g, " "))) return true;
    const status = safeRead(`/proc/${candidate}/status`);
    candidate = Number(status.match(/^PPid:\s+(\d+)/m)?.[1] || 0);
  }
  return false;
};
let candidatePids = [...new Set([...lockPids].filter((pid) =>
  pid > 0 && fs.existsSync(`/proc/${pid}`) && safeRead(`/proc/${pid}/cmdline`) !== ""))];
if (lockPids.size > 0 && candidatePids.length === 0) {
  candidatePids = [...fdHolders].filter((pid) =>
    pid !== currentPid && fs.existsSync(`/proc/${pid}`) && safeRead(`/proc/${pid}/cmdline`) !== "");
}
const owners = candidatePids.map(pidInfo).map((owner) => {
  let relationship = "unknown_inconsistent_holder";
  if (owner.pid === currentPid) relationship = "current_operation";
  else if (isDescendant(owner.pid, currentPid)) relationship = "inherited_descendant";
  else if (owner.operation_id && owner.operation_id === currentOperation) relationship = "current_operation";
  else if (owner.operation_id) relationship = "another_accepted_deployment";
  else if (/install-(release-controller|vps-updater)/.test(owner.command) ||
           ancestorCommandMatches(owner.pid, /install-(release-controller|vps-updater)/)) {
    relationship = "controller_installer";
  }
  return { ...owner, relationship };
});
let state = lockPids.size > 0 ? "held" : "free";
let classification = "free";
if (state === "held") {
  const relationships = new Set(owners.map((owner) => owner.relationship));
  if (owners.length === 0 || relationships.has("unknown_inconsistent_holder")) {
    classification = "unknown_inconsistent_holder";
  } else if (relationships.size === 1) {
    classification = [...relationships][0];
  } else if (relationships.has("inherited_descendant")) {
    classification = "inherited_descendant";
  } else if (relationships.has("another_accepted_deployment")) {
    classification = "another_accepted_deployment";
  } else {
    classification = [...relationships][0];
  }
}
process.stdout.write(`${JSON.stringify({
  state,
  classification,
  lock_path: lockPath,
  lock_inode: inode,
  observed_at_utc: new Date().toISOString(),
  owners
})}\n`);
NODE
}

diagnostic_field() {
  "$NODE_BIN" -e 'const v=JSON.parse(process.argv[1]);process.stdout.write(String(v[process.argv[2]]??""));' "$1" "$2"
}

collect_lock_diagnostics() {
  RECON_LOCK_DIAGNOSTICS=$(lock_owner_diagnostics)
  RECON_LOCK_STATE=$(diagnostic_field "$RECON_LOCK_DIAGNOSTICS" state)
  RECON_LOCK_CLASSIFICATION=$(diagnostic_field "$RECON_LOCK_DIAGNOSTICS" classification)
}

active_receipt_operation() {
  "$NODE_BIN" - "$CONTROL_ROOT" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const root = process.argv[2];
const active = [];
try {
  for (const name of fs.readdirSync(root)) {
    if (!name.endsWith(".json")) continue;
    const receipt = JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
    if (receipt.result === "running") active.push(receipt.operation_id);
  }
} catch {
  process.exit(3);
}
if (active.length > 1) process.exit(3);
if (active.length === 1) process.stdout.write(active[0]);
NODE
}

reconcile_operation() {
  RECON_RECEIPT=$(receipt_path "$OPERATION_ID")
  RECON_UNIT_STATE=$(unit_state "$OPERATION_ID")
  RECON_MARKER=''
  [[ -f "$ACTIVE_MARKER" ]] && RECON_MARKER=$(<"$ACTIVE_MARKER")
  collect_lock_diagnostics
  RECON_CONTROLLER_STATE=consistent
  RECON_RESULT=absent
  RECON_OPERATION_STATE=$(classify_receipt_state)
  RECON_ACTIVE_OPERATION=''

  if ! RECON_ACTIVE_OPERATION=$(active_receipt_operation); then
    RECON_CONTROLLER_STATE=ambiguous
  fi
  if [[ "$RECON_OPERATION_STATE" = readable ]]; then
    if ! RECON_RESULT=$(read_receipt_field "$RECON_RECEIPT" result); then
      RECON_CONTROLLER_STATE=ambiguous
      RECON_RESULT=unknown
    fi
  elif [[ "$RECON_OPERATION_STATE" = terminally_removed ]]; then
    RECON_RESULT=removed
  elif [[ "$RECON_OPERATION_STATE" != genuinely_unknown ]]; then
    RECON_RESULT=unknown
    RECON_CONTROLLER_STATE=ambiguous
  elif [[ "$RECON_UNIT_STATE" != inactive || "$RECON_MARKER" = "$OPERATION_ID" ]]; then
    RECON_CONTROLLER_STATE=ambiguous
  fi

  if [[ -n "$RECON_ACTIVE_OPERATION" ]]; then
    local active_receipt active_result active_unit
    active_receipt=$(receipt_path "$RECON_ACTIVE_OPERATION")
    active_result=$(read_receipt_field "$active_receipt" result)
    active_unit=$(unit_state "$RECON_ACTIVE_OPERATION")
    case "$active_result" in
      running)
        [[ "$RECON_MARKER" = "$RECON_ACTIVE_OPERATION" ]] ||
          RECON_CONTROLLER_STATE=ambiguous
        [[ "$active_unit" = active || "$active_unit" = activating ]] ||
          RECON_CONTROLLER_STATE=ambiguous
        [[ "$RECON_LOCK_STATE" = held ]] || RECON_CONTROLLER_STATE=ambiguous
        [[ "$RECON_LOCK_CLASSIFICATION" = current_operation ||
           "$RECON_LOCK_CLASSIFICATION" = another_accepted_deployment ||
           "$RECON_LOCK_CLASSIFICATION" = inherited_descendant ]] ||
          RECON_CONTROLLER_STATE=ambiguous
        ;;
      *) RECON_CONTROLLER_STATE=ambiguous ;;
    esac
  elif [[ -n "$RECON_MARKER" ]]; then
    local marker_receipt marker_result marker_unit
    marker_receipt=$(receipt_path "$RECON_MARKER")
    if [[ ! -f "$marker_receipt" ]]; then
      RECON_CONTROLLER_STATE=ambiguous
    else
      marker_result=$(read_receipt_field "$marker_receipt" result 2>/dev/null || true)
      marker_unit=$(unit_state "$RECON_MARKER")
      [[ "$marker_result" = accepted ]] || RECON_CONTROLLER_STATE=ambiguous
      [[ "$marker_unit" = active || "$marker_unit" = activating ||
         "$marker_unit" = inactive || "$marker_unit" = failed ]] ||
        RECON_CONTROLLER_STATE=ambiguous
    fi
  elif [[ "$RECON_LOCK_STATE" = held &&
          "$RECON_LOCK_CLASSIFICATION" != controller_installer ]]; then
    RECON_CONTROLLER_STATE=ambiguous
  elif [[ "$RECON_LOCK_STATE" = unknown ]]; then
    RECON_CONTROLLER_STATE=ambiguous
  fi

  case "$RECON_RESULT" in
    absent|removed)
      ;;
    accepted|running)
      if [[ "$RECON_RESULT" = accepted ]]; then
        if [[ "$RECON_UNIT_STATE" = active || "$RECON_UNIT_STATE" = activating ]]; then
          [[ "$RECON_MARKER" = "$OPERATION_ID" ]] || RECON_CONTROLLER_STATE=ambiguous
        elif [[ "$RECON_UNIT_STATE" != inactive && "$RECON_UNIT_STATE" != failed ]]; then
          RECON_CONTROLLER_STATE=ambiguous
        fi
      else
        [[ "$RECON_ACTIVE_OPERATION" = "$OPERATION_ID" ]] ||
          RECON_CONTROLLER_STATE=ambiguous
      fi
      ;;
    prepared|completed|failed)
      if [[ "$RECON_RESULT" = prepared && "$RECON_UNIT_STATE" != inactive ]]; then
        RECON_CONTROLLER_STATE=ambiguous
      elif [[ "$RECON_RESULT" = prepared && "$RECON_MARKER" = "$OPERATION_ID" ]]; then
        RECON_CONTROLLER_STATE=ambiguous
      elif [[ "$RECON_RESULT" = completed && "$RECON_UNIT_STATE" != inactive ]]; then
        RECON_CONTROLLER_STATE=ambiguous
      elif [[ "$RECON_RESULT" = failed &&
              "$RECON_UNIT_STATE" != inactive && "$RECON_UNIT_STATE" != failed ]]; then
        RECON_CONTROLLER_STATE=ambiguous
      elif [[ "$RECON_MARKER" = "$OPERATION_ID" ]]; then
        RECON_CONTROLLER_STATE=ambiguous
      fi
      ;;
    *)
      RECON_CONTROLLER_STATE=ambiguous
      ;;
  esac
}

reconcile_with_terminal_wait() {
  reconcile_operation
  local attempts=0
  while [[ "$RECON_RESULT" = prepared || "$RECON_RESULT" = completed ||
           "$RECON_RESULT" = failed ]] &&
        [[ "$RECON_UNIT_STATE" = active || "$RECON_UNIT_STATE" = activating ||
           "$RECON_UNIT_STATE" = deactivating ]] &&
        (( attempts < 10 )); do
    flock -u 8
    sleep 0.1
    flock -w 4 8 || fail 'deployment controller is busy'
    reconcile_operation
    attempts=$((attempts + 1))
  done
}

remote_master_sha() {
  if [[ ${ASH_ATLAS_DEPLOY_CONTROL_TEST_MODE:-false} = true ]]; then
    printf '%s\n' "${ASH_ATLAS_TEST_REMOTE_MASTER_SHA:?}"
    return
  fi
  timeout 3 sudo -u debian env HOME=/home/debian \
    git ls-remote "$REPOSITORY" refs/heads/master 2>/dev/null |
    awk 'NR == 1 { print $1 }'
}

remote_ref_sha() {
  local ref=$1
  if [[ ${ASH_ATLAS_DEPLOY_CONTROL_TEST_MODE:-false} = true ]]; then
    case "$ref" in
      refs/heads/master) printf '%s\n' "${ASH_ATLAS_TEST_REMOTE_MASTER_SHA:?}" ;;
      refs/heads/integration/test) printf '%s\n' "${ASH_ATLAS_TEST_REMOTE_INTEGRATION_SHA:-${ASH_ATLAS_TEST_REMOTE_MASTER_SHA:?}}" ;;
      refs/tags/test/t[0-9][0-9][0-9]|refs/tags/test/t[0-9][0-9][0-9][0-9]) printf '%s\n' "${ASH_ATLAS_TEST_REMOTE_GENERATION_SHA:-${ASH_ATLAS_TEST_REMOTE_MASTER_SHA:?}}" ;;
      refs/heads/integration/release-candidates/*) printf '%s\n' "${ASH_ATLAS_TEST_REMOTE_CANDIDATE_SHA:-${ASH_ATLAS_TEST_REMOTE_MASTER_SHA:?}}" ;;
      *) return 1 ;;
    esac
    return
  fi
  if [[ "$ref" = refs/tags/* ]]; then
    timeout 3 sudo -u debian env HOME=/home/debian \
      git ls-remote "$REPOSITORY" "$ref" "${ref}^{}" 2>/dev/null |
      awk '$2 ~ /\^\{\}$/ { peeled=$1 } NR == 1 { direct=$1 } END { print peeled ? peeled : direct }'
  else
    timeout 3 sudo -u debian env HOME=/home/debian \
      git ls-remote "$REPOSITORY" "$ref" 2>/dev/null |
      awk 'NR == 1 { print $1 }'
  fi
}

candidate_ref() {
  printf 'refs/heads/integration/release-candidates/%s\n' "$1"
}

installed_updater_hash() {
  sha256sum "$UPDATER" | cut -d' ' -f1
}

remote_integration_contains_target() {
  local target=$1
  local integration_sha mirror_integration tag_sha tags
  integration_sha=$(remote_ref_sha refs/heads/integration/test)
  [[ "$integration_sha" =~ ^[0-9a-f]{40}$ ]] || return 1
  [[ "$integration_sha" = "$target" ]] && return 0
  if [[ ${ASH_ATLAS_DEPLOY_CONTROL_TEST_MODE:-false} = true ]]; then
    [[ ${ASH_ATLAS_TEST_REMOTE_INTEGRATION_DESCENDANT_OF:-} = "$target" ]]
    return
  fi
  [[ -d "$MIRROR_ROOT" && ! -L "$MIRROR_ROOT" ]] || return 1
  timeout 15 sudo -u debian env HOME=/home/debian \
    git --git-dir="$MIRROR_ROOT" fetch origin \
    refs/heads/integration/test:refs/heads/integration/test >/dev/null 2>&1 || return 1
  mirror_integration=$(sudo -u debian git --git-dir="$MIRROR_ROOT" \
    rev-parse refs/heads/integration/test)
  [[ "$mirror_integration" = "$integration_sha" ]] || return 1
  sudo -u debian git --git-dir="$MIRROR_ROOT" merge-base --is-ancestor \
    "$target" "$integration_sha" || return 1
  mapfile -t tags < <(sudo -u debian git --git-dir="$MIRROR_ROOT" \
    tag --points-at "$integration_sha" --list 'test/t[0-9][0-9][0-9]' 'test/t[0-9][0-9][0-9][0-9]')
  [[ ${#tags[@]} -eq 1 ]] || return 1
  tag_sha=$(sudo -u debian git --git-dir="$MIRROR_ROOT" \
    rev-list -n 1 "refs/tags/${tags[0]}")
  [[ "$tag_sha" = "$integration_sha" ]]
}

frozen_integration_tooling_only() {
  local target=$1 integration_sha changed_path changed_paths
  integration_sha=$(remote_ref_sha refs/heads/integration/test)
  [[ "$integration_sha" = "$target" ]] && return 0
  [[ "$target" = 4811473f91d3b209ddd3da7f47f4a41de97ca121 ]] || return 1
  remote_integration_contains_target "$target" || return 1
  changed_paths=$(sudo -u debian git --git-dir="$MIRROR_ROOT" diff --name-only \
    "$target" "$integration_sha") || return 1
  [[ -n "$changed_paths" ]] || return 1
  while IFS= read -r changed_path; do
    case "$changed_path" in
      tools/release/*|tools/mobile-release/*|docs/architecture/IN_APP_UPDATES_PLAN.md) ;;
      *) return 1 ;;
    esac
  done <<< "$changed_paths"
}

load_mobile_registry() {
  local expected_commit=$1
  validate_sha "$expected_commit"
  MOBILE_REGISTRY_PATH=
  LOADED_MOBILE_REGISTRY_COMMIT_SHA=
  if [[ ${ASH_ATLAS_DEPLOY_CONTROL_TEST_MODE:-false} = true ]]; then
    [[ -n "$TEST_MOBILE_REGISTRY_PATH" && -f "$TEST_MOBILE_REGISTRY_PATH" &&
       ! -L "$TEST_MOBILE_REGISTRY_PATH" ]] ||
      fail 'test mobile registry fixture is absent or unsafe'
    [[ -n "$TEST_MOBILE_REGISTRY_COMMIT_SHA" &&
       "$TEST_MOBILE_REGISTRY_COMMIT_SHA" = "$expected_commit" ]] ||
      fail 'test mobile registry commit identity differs from the activation request'
    MOBILE_REGISTRY_PATH=$TEST_MOBILE_REGISTRY_PATH
    LOADED_MOBILE_REGISTRY_COMMIT_SHA=$TEST_MOBILE_REGISTRY_COMMIT_SHA
    return
  fi
  [[ "$MOBILE_REGISTRY_REF" =~ ^refs/heads/[A-Za-z0-9._/-]+$ ]] ||
    fail 'mobile registry ref is unsafe'
  [[ -d "$MIRROR_ROOT" && ! -L "$MIRROR_ROOT" ]] ||
    fail 'deployment mirror is absent or unsafe for mobile registry validation'
  timeout 15 sudo -u debian env HOME=/home/debian git --git-dir="$MIRROR_ROOT" \
    fetch origin "$MOBILE_REGISTRY_REF:$MOBILE_REGISTRY_REF" >/dev/null 2>&1 ||
    fail 'authoritative mobile registry could not be fetched'
  LOADED_MOBILE_REGISTRY_COMMIT_SHA=$(sudo -u debian git --git-dir="$MIRROR_ROOT" \
    rev-parse "$MOBILE_REGISTRY_REF")
  [[ "$LOADED_MOBILE_REGISTRY_COMMIT_SHA" = "$expected_commit" ]] ||
    fail 'authoritative mobile registry commit changed after activation intent admission'
  MOBILE_REGISTRY_PATH=$(mktemp /tmp/ash-atlas-mobile-registry.XXXXXX)
  if ! sudo -u debian git --git-dir="$MIRROR_ROOT" show \
      "$MOBILE_REGISTRY_REF:mobile-release-registry.json" >"$MOBILE_REGISTRY_PATH"; then
    rm -f -- "$MOBILE_REGISTRY_PATH"
    MOBILE_REGISTRY_PATH=
    fail 'authoritative mobile registry file is absent'
  fi
}

assert_activation_registry() {
  local receipt=$1
  local target=$2
  local intent_id=$3
  local registry_commit=$4
  local prepared_receipt prepared_env component
  [[ -f "$receipt" && ! -L "$receipt" ]] || fail 'activation receipt is absent or unsafe'
  prepared_receipt=$(read_receipt_field "$receipt" prepared_remote_receipt_sha256 2>/dev/null || true)
  prepared_env=$(read_receipt_field "$receipt" prepared_env_sha256 2>/dev/null || true)
  component=$(read_receipt_field "$receipt" prepared_server_component_sha 2>/dev/null || true)
  [[ "$prepared_receipt" =~ ^[0-9a-f]{64}$ ]] ||
    fail 'prepared remote receipt identity is absent or unsafe'
  [[ "$prepared_env" =~ ^[0-9a-f]{64}$ ]] ||
    fail 'prepared environment identity is absent or unsafe'
  [[ "$component" =~ ^[0-9a-f]{40}$ ]] ||
    fail 'prepared server component identity is absent or unsafe'
  [[ "$intent_id" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$ ]] ||
    fail 'activation intent ID is unsafe'
  validate_sha "$registry_commit"
  load_mobile_registry "$registry_commit"
  local registry_path=$MOBILE_REGISTRY_PATH
  local code
  if "$NODE_BIN" - "$registry_path" "$intent_id" "$target" "$prepared_receipt" \
      "$prepared_env" "$component" <<'NODE'
const fs = require("node:fs");
const [path, intentId, target, preparedReceipt, preparedEnv, component] = process.argv.slice(2);
const registry = JSON.parse(fs.readFileSync(path, "utf8"));
const fail = (message) => { throw new Error(message); };
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const sha = (value, length) => typeof value === "string" &&
  new RegExp(`^[0-9a-f]{${length}}$`, "u").test(value);
const positive = (value) => Number.isInteger(value) && value > 0;
const compareRelease = (leftVersion, leftBuild, rightVersion, rightBuild) => {
  const left = String(leftVersion).split(/[.-]/u).slice(0, 3).map(Number);
  const right = String(rightVersion).split(/[.-]/u).slice(0, 3).map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return leftBuild - rightBuild;
};
if (!object(registry) || registry.schemaVersion !== 1 || !Array.isArray(registry.releases)) {
  fail("mobile registry identity is invalid");
}
const intent = registry.activationIntent;
if (!object(intent) || intent.schemaVersion !== 1 || intent.intentId !== intentId ||
    intent.serverSha !== target || intent.preparedReceiptSha !== preparedReceipt ||
    intent.preSwitchEnvSha !== preparedEnv ||
    intent.candidateComponentSha !== component ||
    !sha(intent.serverSha, 40) || !sha(intent.preparedReceiptSha, 64) ||
    !sha(intent.candidateComponentSha, 40) || !sha(intent.preSwitchEnvSha, 64) ||
    !object(intent.serverProtocol) ||
    !positive(intent.serverProtocol.min) || !positive(intent.serverProtocol.max) ||
    intent.serverProtocol.min > intent.serverProtocol.max || !object(intent.hardMinimum) ||
    !Number.isFinite(Date.parse(intent.createdAt))) {
  fail("authoritative activation intent does not match the prepared release");
}
for (const platform of ["ios", "android"]) {
  const minimum = intent.hardMinimum[platform];
  if (!object(minimum) || typeof minimum.version !== "string" ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(minimum.version) ||
      !Number.isInteger(minimum.build) || minimum.build < 0) {
    fail(`activation intent ${platform} hard minimum is invalid`);
  }
}
// Keep this audit validator aligned with tools/mobile-release/registry.mjs.
const RETIREMENT_NOTE = "retired; replaced by web install; build 8 is beta/internal";
const RETIREABLE_BUILDS = { ios: [1, 2, 3, 5, 6, 7], android: [1, 2, 3, 4, 6, 7] };
const RETIREMENT_IDENTITY = ["reservationId", "releaseId", "platform", "marketingVersion", "build",
  "generation", "sourceSha", "artifactSha256", "storeBuildId"];

const failUnless = (condition, message) => { if (!condition) fail(message); };
function retirementState(registry) {
  const audit = registry.retirementAudit === undefined ? [] : registry.retirementAudit;
  failUnless(Array.isArray(audit), "retirement audit must be an array");
  const retired = new Set();
  const ids = new Set();
  let previousTime = -Infinity;
  for (const entry of audit) {
    failUnless(object(entry) && entry.schemaVersion === 1 &&
      typeof entry.actionId === "string" && /^[A-Za-z0-9._:-]{3,128}$/u.test(entry.actionId) &&
      !ids.has(entry.actionId) && ["retire", "unretire"].includes(entry.action) &&
      typeof entry.actor === "string" && entry.actor.trim().length > 0 &&
      typeof entry.recordedAt === "string" && Number.isFinite(Date.parse(entry.recordedAt)) &&
      Date.parse(entry.recordedAt) >= previousTime && typeof entry.note === "string" &&
      entry.note.trim().length > 0 && (entry.action !== "retire" || entry.note === RETIREMENT_NOTE) &&
      object(entry.identity), "retirement audit evidence is invalid");
    const release = registry.releases.find((r) => r.reservationId === entry.identity.reservationId);
    failUnless(release && RETIREABLE_BUILDS[release.platform]?.includes(release.build) &&
      release.uploadAttempted === true &&
      registry.releases.filter((r) => r.reservationId === release.reservationId).length === 1 &&
      registry.releases.filter((r) => r.platform === release.platform && r.build === release.build).length === 1 &&
      typeof release.reservationId === "string" && release.reservationId.length > 0 &&
      typeof release.releaseId === "string" && release.releaseId.length > 0 &&
      /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(release.marketingVersion) &&
      /^t\d{3,4}$/u.test(release.generation) && /^[0-9a-f]{40}$/u.test(release.sourceSha) &&
      (release.artifactSha256 == null || /^[0-9a-f]{64}$/u.test(release.artifactSha256)) &&
      (release.storeBuildId == null || (typeof release.storeBuildId === "string" && release.storeBuildId.length > 0)) &&
      Object.keys(entry.identity).length === RETIREMENT_IDENTITY.length &&
      RETIREMENT_IDENTITY.every((key) => entry.identity[key] === (release[key] ?? null)),
    "retirement audit release identity is invalid or outside the legacy allowlist");
    const wasRetired = retired.has(release.reservationId);
    failUnless(entry.action === "retire" ? !wasRetired : wasRetired,
      "retirement audit must alternate retire and unretire");
    if (entry.action === "retire") retired.add(release.reservationId);
    else retired.delete(release.reservationId);
    ids.add(entry.actionId);
    previousTime = Date.parse(entry.recordedAt);
  }
  return retired;
}

const retired = retirementState(registry);
const relevant = registry.releases.filter((release) => !retired.has(release.reservationId) && (
  release.supported === true || release.compatibilityProtected === true ||
  (release.availabilityPending !== undefined && release.availabilityPending !== null) ||
  (release.uploadAttempted === true && release.supported !== true && release.compatibilityProtected !== true)));
if (relevant.length === 0) fail("mobile registry has no protected or supported release");
for (const release of relevant) {
  if (!object(release) || !["ios", "android"].includes(release.platform) ||
      !object(release.protocol) || !positive(release.protocol.min) ||
      !positive(release.protocol.max) || release.protocol.min > release.protocol.max ||
      release.protocol.max < intent.serverProtocol.min ||
      release.protocol.min > intent.serverProtocol.max ||
      typeof release.marketingVersion !== "string" ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(release.marketingVersion) ||
      !Number.isInteger(release.build) ||
      compareRelease(release.marketingVersion, release.build,
        intent.hardMinimum[release.platform].version,
        intent.hardMinimum[release.platform].build) < 0) {
    fail(`protected mobile release is incompatible: ${release.platform || "unknown"}`);
  }
}
process.stdout.write(JSON.stringify({ checked: relevant.length, status: "compatible" }));
NODE
  then
    code=0
  else
    code=$?
  fi
  if [[ ${ASH_ATLAS_DEPLOY_CONTROL_TEST_MODE:-false} != true && -n "$MOBILE_REGISTRY_PATH" ]]; then
    rm -f -- "$MOBILE_REGISTRY_PATH"
  fi
  MOBILE_REGISTRY_PATH=
  (( code == 0 )) || fail 'authoritative mobile registry activation fence failed'
}

identity_operation() {
  [[ -f "$UPDATER" && ! -L "$UPDATER" ]] || fail 'installed updater is absent or unsafe'
  local controller_path=${CONTROLLER:-$0}
  [[ -f "$controller_path" && ! -L "$controller_path" ]] || fail 'installed controller is absent or unsafe'
  local updater_hash controller_hash
  updater_hash=$(installed_updater_hash)
  controller_hash=$(sha256sum "$controller_path" | cut -d' ' -f1)
  validate_hash "$updater_hash"
  validate_hash "$controller_hash"
  printf '{"schema_version":1,"controller_version":%s,"updater_sha256":"%s","controller_sha256":"%s"}\n' \
    "$CONTROLLER_VERSION" "$updater_hash" "$controller_hash"
}

integrity_operation() {
  if [[ ${ASH_ATLAS_DEPLOY_CONTROL_TEST_MODE:-false} = true ]]; then
    [[ ${ASH_ATLAS_TEST_LIVE_INTEGRITY_RESULT:-pass} = pass ]] ||
      fail 'live production integrity gate detected an existing readiness blocker'
  else
    timeout 8 /usr/local/libexec/ash-atlas-wait-ready game >/dev/null 2>&1 ||
      fail 'live production integrity gate detected an existing readiness blocker'
  fi
  printf '{"schema_version":1,"result":"pass","authoritative":false}\n'
}

validate_world_handoff_authority() {
  local target_game_sha=$1
  local release_path=$2
  local current_lock_path=$3
  local target_lock_path=$4
  local health_path=$5
  "$NODE_BIN" - "$target_game_sha" "$release_path" \
    "$current_lock_path" "$target_lock_path" "$health_path" <<'NODE'
const fs = require("node:fs");
const [targetGameSha, releasePath, currentLockPath, targetLockPath, healthPath] = process.argv.slice(2);
const read = (path) => JSON.parse(fs.readFileSync(path, "utf8"));
const object = (value, field) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} is absent or not an object`);
  }
  return value;
};
const string = (value, field) => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} is absent or not a non-empty string`);
  }
  return value;
};
const sha = (value, field, length) => {
  const result = string(value, field);
  const pattern = length === 40 ? /^[0-9a-f]{40}$/ : /^[0-9a-f]{64}$/;
  if (!pattern.test(result)) throw new Error(`${field} is not a lowercase SHA`);
  return result;
};
const positiveInteger = (value, field) => {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${field} is not a positive integer`);
  return value;
};
const positiveNumber = (value, field) => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${field} is not a positive number`);
  }
  return value;
};
const waterNameIndexAuthority = (value, label) => {
  const identity = object(value, `target lock ${label}`);
  const releaseId = string(identity.release_id, `target lock ${label}.release_id`);
  const manifestSha256 = sha(identity.manifest_sha256, `target lock ${label}.manifest_sha256`, 64);
  const schema = string(identity.schema, `target lock ${label}.schema`);
  const policy = string(identity.policy, `target lock ${label}.policy`);
  if (releaseId !== "water-names-v1" || schema !== "water-names-v1" ||
      policy !== "same-class-nearest-authoritative-name-v1") process.exit(5);
  if (string(identity.entries_filename, `target lock ${label}.entries_filename`) !== "entries.sqlite3" ||
      string(identity.entries_format, `target lock ${label}.entries_format`) !== "sqlite-wkb-rtree-v1") process.exit(5);
  sha(identity.entries_sha256, `target lock ${label}.entries_sha256`, 64);
  positiveInteger(identity.entries_size_bytes, `target lock ${label}.entries_size_bytes`);
  const indexHash = sha(identity.index_hash, `target lock ${label}.index_hash`, 64);
  sha(identity.deterministic_fingerprint, `target lock ${label}.deterministic_fingerprint`, 64);
  const entryCount = positiveInteger(identity.entry_count, `target lock ${label}.entry_count`);
  const classes = object(identity.classes, `target lock ${label}.classes`);
  const river = positiveInteger(classes.river, `target lock ${label}.classes.river`);
  const lake = positiveInteger(classes.lake, `target lock ${label}.classes.lake`);
  const ocean = positiveInteger(classes.ocean, `target lock ${label}.classes.ocean`);
  if (river + lake + ocean !== entryCount) process.exit(5);
  const maxDistance = object(identity.max_distance_m, `target lock ${label}.max_distance_m`);
  positiveNumber(maxDistance.river, `target lock ${label}.max_distance_m.river`);
  positiveNumber(maxDistance.lake, `target lock ${label}.max_distance_m.lake`);
  positiveNumber(maxDistance.ocean, `target lock ${label}.max_distance_m.ocean`);
  return {
    release_id: releaseId,
    manifest_sha256: manifestSha256,
    schema,
    policy,
    index_hash: indexHash,
    entry_count: entryCount,
    classes: { river, lake, ocean }
  };
};
const activeWaterNameIndexAuthority = (value, label) => {
  const identity = object(value, `active ${label}`);
  const releaseId = string(identity.release_id, `active ${label}.release_id`);
  const manifestSha256 = sha(identity.manifest_sha256, `active ${label}.manifest_sha256`, 64);
  const schema = string(identity.schema, `active ${label}.schema`);
  const policy = string(identity.policy, `active ${label}.policy`);
  const indexHash = sha(identity.index_hash, `active ${label}.index_hash`, 64);
  const entryCount = positiveInteger(identity.entry_count, `active ${label}.entry_count`);
  const classes = object(identity.classes, `active ${label}.classes`);
  const river = positiveInteger(classes.river, `active ${label}.classes.river`);
  const lake = positiveInteger(classes.lake, `active ${label}.classes.lake`);
  const ocean = positiveInteger(classes.ocean, `active ${label}.classes.ocean`);
  if (river + lake + ocean !== entryCount) process.exit(5);
  return {
    release_id: releaseId,
    manifest_sha256: manifestSha256,
    schema,
    policy,
    index_hash: indexHash,
    entry_count: entryCount,
    classes: { river, lake, ocean }
  };
};
const releaseAuthority = (lock, key, label) => {
  const identity = object(lock[key], `target lock ${label}`);
  return {
    mode: string(identity.release_id, `target lock ${label}.release_id`),
    release_id: string(identity.release_id, `target lock ${label}.release_id`),
    manifest_sha256: sha(identity.manifest_sha256, `target lock ${label}.manifest_sha256`, 64),
    policy: string(identity.policy, `target lock ${label}.policy`)
  };
};
const targetLock = read(targetLockPath);
const currentLock = read(currentLockPath);
const health = read(healthPath);
const release = read(releasePath);
if (targetLock.schema_version !== 1) throw new Error("target World lock schema is unsupported");
const targetPipeline = object(targetLock.pipeline, "target lock pipeline");
const currentPipeline = object(currentLock.pipeline, "current lock pipeline");
if (targetPipeline.repository !== "example-org/world-data" || targetPipeline.protected_branch !== "main") {
  process.exit(5);
}
const targetWorldSha = sha(targetPipeline.sha, "target lock pipeline.sha", 40);
const currentWorldSha = sha(currentPipeline.sha, "current lock pipeline.sha", 40);
const currentGameSha = sha(release.game_sha, "current public game_sha", 40);
const activeRuntime = object(health.runtime, "active World runtime");
const activeWorldSha = sha(activeRuntime.sha, "active World runtime.sha", 40);
if (health.ok !== true || health.status !== "ready" || activeRuntime.branch !== "main") process.exit(3);
if (currentGameSha === targetGameSha || currentWorldSha === activeWorldSha ||
    targetWorldSha !== activeWorldSha) process.exit(4);

const targetRelease = object(targetLock.release, "target lock release");
const targetAuthority = {
  world: {
    release_id: string(targetRelease.release_id, "target lock release.release_id"),
    manifest_sha256: sha(targetRelease.manifest_sha256, "target lock release.manifest_sha256", 64)
  },
  river: releaseAuthority(targetLock, "river_surface", "river surface"),
  lake: releaseAuthority(targetLock, "lake_surface", "lake surface"),
  ocean: releaseAuthority(targetLock, "ocean_coast_surface", "ocean coast surface"),
  water_name_index: waterNameIndexAuthority(targetLock.water_name_index, "water-name index"),
  overlay: (() => {
    const identity = object(targetLock.waterbody_identity_overlay, "target lock waterbody identity overlay");
    return {
      release_id: string(identity.release_id, "target lock waterbody identity overlay.release_id"),
      manifest_sha256: sha(identity.manifest_sha256, "target lock waterbody identity overlay.manifest_sha256", 64),
      schema: string(identity.schema, "target lock waterbody identity overlay.schema"),
      schema_version: string(identity.schema_version, "target lock waterbody identity overlay.schema_version"),
      policy: string(identity.policy, "target lock waterbody identity overlay.policy"),
      policy_version: string(identity.policy_version, "target lock waterbody identity overlay.policy_version")
    };
  })()
};
if (targetAuthority.overlay.release_id !== "waterbody-identity-overlay-v4" ||
    targetAuthority.overlay.schema !== "waterbody-identity-overlay-v1" ||
    targetAuthority.overlay.schema_version !== "waterbody-identity-overlay-v1" ||
    targetAuthority.overlay.policy !== "existing-cell-candidate-precedence-v1" ||
    targetAuthority.overlay.policy_version !== "existing-cell-candidate-precedence-v1") process.exit(5);

const activeRelease = object(health.release, "active World release");
const releaseVerification = object(health.release_verification, "active World release verification");
if (releaseVerification.verification_mode !== "manifest-only") process.exit(5);
const activeRiver = object(health.river_surface, "active river surface");
const activeLake = object(health.lake_surface, "active lake surface");
const activeOcean = object(health.ocean_coast_surface, "active ocean coast surface");
const activeOverlay = object(health.waterbody_identity_overlay, "active waterbody identity overlay");
const activeWaterNameIndex = activeWaterNameIndexAuthority(health.water_name_index, "water-name index");
const activeCapabilities = object(health.capabilities, "active World capabilities");
const surfaceAuthority = (surface, label) => {
  const identity = object(surface.identity, `active ${label} identity`);
  return {
    mode: string(surface.mode, `active ${label}.mode`),
    release_id: string(identity.release_id, `active ${label}.identity.release_id`),
    manifest_sha256: sha(identity.manifest_sha256, `active ${label}.identity.manifest_sha256`, 64),
    policy: string(identity.policy, `active ${label}.identity.policy`)
  };
};
const activeAuthority = {
  world: {
    release_id: string(activeRelease.release_id, "active World release.release_id"),
    manifest_sha256: sha(
      releaseVerification.release_manifest_sha256,
      "active World release verification.release_manifest_sha256",
      64
    )
  },
  river: surfaceAuthority(activeRiver, "river surface"),
  lake: surfaceAuthority(activeLake, "lake surface"),
  ocean: surfaceAuthority(activeOcean, "ocean coast surface"),
  water_name_index: activeWaterNameIndex,
  overlay: {
    release_id: string(activeOverlay.release_id, "active waterbody identity overlay.release_id"),
    manifest_sha256: sha(activeOverlay.manifest_sha256, "active waterbody identity overlay.manifest_sha256", 64),
    schema: string(activeOverlay.schema, "active waterbody identity overlay.schema"),
    schema_version: string(activeOverlay.schema_version, "active waterbody identity overlay.schema_version"),
    policy: string(activeOverlay.policy, "active waterbody identity overlay.policy"),
    policy_version: string(activeOverlay.policy_version, "active waterbody identity overlay.policy_version")
  },
  waterbodyIdentityV1: activeCapabilities.waterbodyIdentityV1,
  waterNameFallbackV1: activeCapabilities.waterNameFallbackV1
};
if (activeAuthority.waterbodyIdentityV1 !== true || activeAuthority.waterNameFallbackV1 !== true ||
    JSON.stringify({ ...activeAuthority, waterbodyIdentityV1: undefined, waterNameFallbackV1: undefined }) !==
      JSON.stringify({ ...targetAuthority, waterbodyIdentityV1: undefined, waterNameFallbackV1: undefined })) process.exit(5);
process.stdout.write(JSON.stringify({
  schema_version: 1,
  result: "recoverable-world-handoff",
  authoritative: false,
  target_game_sha: targetGameSha,
  current_public_game_sha: currentGameSha,
  current_world_sha: currentWorldSha,
  target_world_sha: targetWorldSha,
  active_world_sha: activeWorldSha
}));
NODE
}

integrity_handoff_operation() {
  validate_sha "$TARGET_SHA"
  if [[ ${ASH_ATLAS_DEPLOY_CONTROL_TEST_MODE:-false} = true ]]; then
    [[ ${ASH_ATLAS_TEST_HANDOFF_RESULT:-pass} = pass ]] ||
      fail 'World handoff recovery evidence was rejected'
    [[ ${ASH_ATLAS_TEST_GAME_SERVICE_ACTIVE:-false} = true ]] ||
      fail 'World handoff recovery requires the current game service to remain active'
    [[ ${ASH_ATLAS_TEST_WORLD_SERVICE_ACTIVE:-false} = true ]] ||
      fail 'World handoff recovery requires the World service to remain active'
    [[ $(remote_ref_sha refs/heads/master) != "$TARGET_SHA" &&
       $(remote_ref_sha refs/heads/integration/test) = "$TARGET_SHA" &&
       $(remote_ref_sha refs/tags/test/t000) = "$TARGET_SHA" ]] ||
      fail 'World handoff target is not one exact protected generation'
    local fixture_release=${ASH_ATLAS_TEST_CURRENT_PUBLIC_RELEASE_PATH:?}
    local fixture_current_lock=${ASH_ATLAS_TEST_CURRENT_LOCK_PATH:?}
    local fixture_target_lock=${ASH_ATLAS_TEST_TARGET_LOCK_PATH:?}
    local fixture_world_health=${ASH_ATLAS_TEST_WORLD_HEALTH_PATH:?}
    [[ -f "$fixture_release" && ! -L "$fixture_release" &&
       -f "$fixture_current_lock" && ! -L "$fixture_current_lock" &&
       -f "$fixture_target_lock" && ! -L "$fixture_target_lock" &&
       -f "$fixture_world_health" && ! -L "$fixture_world_health" ]] ||
      fail 'World handoff test authority fixture is absent or unsafe'
    local output
    output=$(validate_world_handoff_authority "$TARGET_SHA" \
      "$fixture_release" "$fixture_current_lock" "$fixture_target_lock" "$fixture_world_health") ||
      fail 'World handoff lock or runtime identities are inconsistent'
    printf '%s\n' "$output"
    return
  fi

  timeout 8 /usr/local/libexec/ash-atlas-wait-ready game >/dev/null 2>&1 &&
    fail 'ordinary production readiness passes; World handoff recovery is not applicable'
  systemctl is-active --quiet ash-atlas.service ||
    fail 'World handoff recovery requires the current game service to remain active'
  systemctl is-active --quiet ash-atlas-world.service ||
    fail 'World handoff recovery requires the World service to remain active'
  local remote_master_sha
  remote_master_sha=$(remote_ref_sha refs/heads/master)
  validate_sha "$remote_master_sha"
  [[ "$remote_master_sha" != "$TARGET_SHA" &&
     $(remote_ref_sha refs/heads/integration/test) = "$TARGET_SHA" ]] ||
    fail 'World handoff target is not the exact pending protected integration SHA'
  [[ -d "$MIRROR_ROOT" && ! -L "$MIRROR_ROOT" ]] ||
    fail 'protected repository mirror is absent or unsafe'
  timeout 20 sudo -u debian env HOME=/home/debian \
    git --git-dir="$MIRROR_ROOT" fetch origin \
    refs/heads/master:refs/heads/master \
    refs/heads/integration/test:refs/heads/integration/test \
    'refs/tags/test/t*:refs/tags/test/t*' >/dev/null 2>&1 ||
    fail 'protected refs could not be refreshed for World handoff recovery'
  [[ $(sudo -u debian git --git-dir="$MIRROR_ROOT" rev-parse refs/heads/master) = "$remote_master_sha" &&
     $(sudo -u debian git --git-dir="$MIRROR_ROOT" rev-parse refs/heads/integration/test) = "$TARGET_SHA" ]] ||
    fail 'protected mirror differs from the World handoff target'
  sudo -u debian git --git-dir="$MIRROR_ROOT" merge-base --is-ancestor \
    "$remote_master_sha" "$TARGET_SHA" ||
    fail 'pending World handoff target does not descend from protected master'
  local tags
  mapfile -t tags < <(sudo -u debian git --git-dir="$MIRROR_ROOT" \
    tag --points-at "$TARGET_SHA" --list 'test/t[0-9][0-9][0-9]' 'test/t[0-9][0-9][0-9][0-9]')
  [[ ${#tags[@]} -eq 1 ]] ||
    fail 'World handoff target must have exactly one immutable generation tag'

  local current_game current_game_sha current_public_release current_release_identity
  local current_public_game_sha current_server_component_sha current_lock target_lock world_health output
  current_game=$(readlink -e "$GAME_CURRENT" 2>/dev/null || true)
  [[ "$current_game" == "$GAME_RELEASE_ROOT"/* &&
     -f "$current_game/config/world-runtime.lock.json" &&
     ! -L "$current_game/config/world-runtime.lock.json" ]] ||
    fail 'current game World lock is absent or unsafe'
  current_public_release=$(readlink -e "$PUBLIC_CURRENT/release.json" 2>/dev/null || true)
  [[ "$current_public_release" == "$PUBLIC_RELEASE_ROOT"/*/release.json &&
     -f "$current_public_release" && ! -L "$current_public_release" ]] ||
    fail 'current public release identity is absent or unsafe'
  current_release_identity=$("$NODE_BIN" -e '
const release = require(process.argv[1]);
const game = release?.game_sha;
const server = release?.server_component_sha;
if (![game, server].every((value) => typeof value === "string" && /^[0-9a-f]{40}$/.test(value))) process.exit(1);
process.stdout.write(`${game}\t${server}`);
' "$current_public_release") || fail 'current public game identity is invalid'
  IFS=$'\t' read -r current_public_game_sha current_server_component_sha <<<"$current_release_identity"
  validate_sha "$current_public_game_sha"
  validate_sha "$current_server_component_sha"
  current_game_sha=${current_game##*/}
  validate_sha "$current_game_sha"
  [[ "$current_game_sha" = "$current_server_component_sha" ]] ||
    fail 'current game link and public server component identity differ'
  sudo -u debian git --git-dir="$MIRROR_ROOT" merge-base --is-ancestor \
    "$current_public_game_sha" "$remote_master_sha" ||
    fail 'protected master does not descend from the current public game'
  current_lock="$current_game/config/world-runtime.lock.json"
  target_lock=$(mktemp "$CONTROL_ROOT/handoff-target.XXXXXXXX.json")
  world_health=$(mktemp "$CONTROL_ROOT/handoff-world.XXXXXXXX.json")
  sudo -u debian git --git-dir="$MIRROR_ROOT" show \
    "$TARGET_SHA:config/world-runtime.lock.json" >"$target_lock" || {
      rm -f "$target_lock" "$world_health"
      fail 'target World lock could not be read from the protected commit'
    }
  curl --fail --silent --show-error --max-time 8 \
    http://127.0.0.1:8765/api/health >"$world_health" || {
      rm -f "$target_lock" "$world_health"
      fail 'active World health could not be read'
    }
  output=$(validate_world_handoff_authority "$TARGET_SHA" \
    "$current_public_release" "$current_lock" "$target_lock" "$world_health") || {
    rm -f "$target_lock" "$world_health"
    fail 'World handoff lock or runtime identities are inconsistent'
  }
  rm -f "$target_lock" "$world_health"
  printf '%s\n' "$output"
}

write_active_marker() {
  local operation=$1
  "$NODE_BIN" - "$ACTIVE_MARKER" "$operation" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [target, operation] = process.argv.slice(2);
const temporary = `${target}.${process.pid}.tmp`;
let file;
try {
  file = fs.openSync(temporary, "wx", 0o640);
  fs.writeFileSync(file, `${operation}\n`);
  fs.fsyncSync(file);
  fs.closeSync(file);
  file = undefined;
  fs.chmodSync(temporary, 0o640);
  fs.renameSync(temporary, target);
  const directory = fs.openSync(path.dirname(target), "r");
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  if (fs.readFileSync(target, "utf8") !== `${operation}\n`) {
    throw new Error("persisted active marker validation failed");
  }
} catch (error) {
  if (file !== undefined) {
    try { fs.closeSync(file); } catch {}
  }
  try { fs.rmSync(temporary, { force: true }); } catch {}
  throw error;
}
NODE
}

clear_active_marker() {
  local operation=$1
  if [[ -f "$ACTIVE_MARKER" && "$(<"$ACTIVE_MARKER")" = "$operation" ]]; then
    rm -f "$ACTIVE_MARKER"
  fi
}

start_accepted_worker() {
  local operation=$1
  local receipt unit current_unit_state attempts marker
  receipt=$(receipt_path "$operation")
  unit=$(unit_name "$operation")
  publish_status_required "$operation"
  marker=''
  [[ -f "$ACTIVE_MARKER" ]] && marker=$(<"$ACTIVE_MARKER")
  if [[ -n "$marker" && "$marker" != "$operation" ]]; then
    receipt_update "$receipt" result accepted current_phase waiting_for_execution_lane \
      queued_behind_operation "$marker"
    return 0
  fi
  current_unit_state=$(unit_state "$operation")
  if [[ "$current_unit_state" = active || "$current_unit_state" = activating ]]; then
    [[ "$marker" = "$operation" ]] ||
      fail 'active deployment unit does not own the canonical execution lane'
    return 0
  fi
  if [[ "$current_unit_state" = failed ]]; then
    "$SYSTEMCTL" reset-failed "$unit" >/dev/null
    current_unit_state=$(unit_state "$operation")
  fi
  [[ "$current_unit_state" = inactive ]] ||
    fail 'accepted deployment unit is not safely restartable'
  write_active_marker "$operation"
  receipt_update "$receipt" result accepted current_phase waiting_for_execution_lock \
    queued_behind_operation ''
  if ! "$SYSTEMCTL" start --no-block "$unit" >/dev/null; then
    receipt_update "$receipt" result failed current_phase acceptance failure_phase systemd_start \
      failure_code systemd_start_failed \
      failure_message 'systemd did not accept the durable deployment unit' finished_at_utc "$(now_utc)"
    clear_active_marker "$operation"
    fail 'systemd did not accept the durable deployment unit'
  fi
  attempts=0
  while (( attempts < 20 )); do
    current_unit_state=$(unit_state "$operation")
    [[ "$current_unit_state" = active || "$current_unit_state" = activating ]] && return 0
    sleep 0.05
    attempts=$((attempts + 1))
  done
  "$SYSTEMCTL" stop "$unit" >/dev/null 2>&1 || true
  receipt_update "$receipt" result failed current_phase acceptance failure_phase systemd_start \
    failure_code systemd_start_failed \
    failure_message 'durable deployment unit did not become active after acceptance' finished_at_utc "$(now_utc)"
  clear_active_marker "$operation"
  return 3
}

finalize_failed_post_activation_transaction() {
  local receipt=$1
  local action result failure_phase target updater_hash generation prepare_hash
  local retry_count current_game current_public release_class expected_game_sha
  action=$(read_receipt_field "$receipt" requested_action 2>/dev/null || true)
  result=$(read_receipt_field "$receipt" result 2>/dev/null || true)
  failure_phase=$(read_receipt_field "$receipt" failure_phase 2>/dev/null || true)
  [[ "$action" = activate && "$result" = failed &&
     "$failure_phase" = release_retention_post_activation &&
     $(read_receipt_field "$receipt" prepare_result 2>/dev/null || true) = completed &&
     $(read_receipt_field "$receipt" activation_started 2>/dev/null || true) = true &&
     $(read_receipt_field "$receipt" activation_completed 2>/dev/null || true) = true &&
     $(read_receipt_field "$receipt" activation_result 2>/dev/null || true) = completed &&
     $(read_receipt_field "$receipt" readiness_result 2>/dev/null || true) = completed &&
     ( "$RECON_UNIT_STATE" = inactive || "$RECON_UNIT_STATE" = failed ) &&
     -z "$RECON_MARKER" ]] || return 1
  target=$(read_receipt_field "$receipt" requested_target_sha)
  updater_hash=$(read_receipt_field "$receipt" updater_hash)
  generation=$(read_receipt_field "$receipt" requested_generation)
  prepare_hash=$(read_receipt_field "$receipt" prepare_receipt_sha256)
  validate_sha "$target"
  validate_hash "$updater_hash"
  validate_hash "$prepare_hash"
  [[ "$generation" =~ ^test/t[0-9]{3,4}$ ]] || fail 'failed post-activation generation identity is unsafe'
  [[ $(remote_ref_sha "$(candidate_ref "$OPERATION_ID")") = "$target" &&
     $(remote_ref_sha refs/heads/master) = "$target" &&
     $(remote_ref_sha "refs/tags/$generation") = "$target" ]] ||
    fail 'failed post-activation transaction protected identity changed before finalization'
  remote_integration_contains_target "$target" ||
    fail 'failed post-activation transaction integration identity is not an immutable descendant'
  [[ -f "$UPDATER" && ! -L "$UPDATER" && $(installed_updater_hash) = "$updater_hash" ]] ||
    fail 'failed post-activation transaction updater identity changed before finalization'
  current_game=$(readlink -e "$GAME_CURRENT" 2>/dev/null || true)
  current_public=$(readlink -e "$PUBLIC_CURRENT" 2>/dev/null || true)
  release_class=$(read_receipt_field "$receipt" release_class 2>/dev/null || true)
  expected_game_sha=$target
  if [[ "$release_class" = client_only ]]; then
    expected_game_sha=$(read_receipt_field "$receipt" prepared_server_component_sha)
    validate_sha "$expected_game_sha"
  fi
  [[ "$current_game" = "$GAME_RELEASE_ROOT/$expected_game_sha" &&
     "$current_public" = "$PUBLIC_RELEASE_ROOT/$target" ]] ||
    fail 'failed post-activation transaction live identity changed before finalization'
  "$SYSTEMCTL" is-active --quiet ash-atlas.service ||
    fail 'failed post-activation transaction game service is not active'
  "$SYSTEMCTL" is-active --quiet ash-atlas-world.service ||
    fail 'failed post-activation transaction World service is not active'
  retry_count=$(read_receipt_field "$receipt" transaction_retry_count 2>/dev/null || true)
  [[ "$retry_count" =~ ^[0-9]+$ ]] || retry_count=0
  receipt_update "$receipt" result completed current_phase completed \
    failure_phase '' failure_code '' failure_message '' finished_at_utc "$(now_utc)" \
    transaction_retry_count "__NUMBER__$((retry_count + 1))" \
    transaction_retried_at_utc "$(now_utc)" \
    post_activation_reconciliation_result completed \
    post_activation_reconciled_at_utc "$(now_utc)"
  publish_status_required "$OPERATION_ID"
  emit_receipt "$receipt" "$RECON_UNIT_STATE" consistent
}

retry_failed_transaction() {
  local receipt=$1
  local action operation_id target updater_hash generation initial_game initial_public
  local current_game current_public retry_count
  if finalize_failed_post_activation_transaction "$receipt"; then return 0; fi
  action=$(read_receipt_field "$receipt" requested_action 2>/dev/null || true)
  operation_id=$(read_receipt_field "$receipt" operation_id 2>/dev/null || true)
  [[ "$action" = prepare || "$action" = activate ]] || return 1
  [[ $(read_receipt_field "$receipt" result 2>/dev/null || true) = failed &&
     $(read_receipt_field "$receipt" activation_started 2>/dev/null || true) = false &&
     $(read_receipt_field "$receipt" migration_started 2>/dev/null || true) = false &&
     ! -e "$(migration_intent_path "$operation_id")" &&
     ! -L "$(migration_intent_path "$operation_id")" &&
     ( "$RECON_UNIT_STATE" = inactive || "$RECON_UNIT_STATE" = failed ) &&
     -z "$RECON_MARKER" ]] || return 1
  target=$(read_receipt_field "$receipt" requested_target_sha)
  updater_hash=$(read_receipt_field "$receipt" updater_hash)
  generation=$(read_receipt_field "$receipt" requested_generation)
  initial_game=$(read_receipt_field "$receipt" preparation_live_game_sha)
  initial_public=$(read_receipt_field "$receipt" preparation_live_public_sha)
  current_game=$(readlink -e "$GAME_CURRENT" 2>/dev/null || true)
  current_public=$(readlink -e "$PUBLIC_CURRENT" 2>/dev/null || true)
  [[ "$initial_game" =~ ^[0-9a-f]{40}$ && "$initial_public" =~ ^[0-9a-f]{40}$ &&
     "${current_game##*/}" = "$initial_game" && "${current_public##*/}" = "$initial_public" ]] ||
    fail 'failed transaction cannot resume because live identity changed'
  [[ $(remote_ref_sha "$(candidate_ref "$OPERATION_ID")") = "$target" ]] ||
    fail 'failed transaction candidate ref changed before resume'
  [[ -f "$UPDATER" && ! -L "$UPDATER" && $(installed_updater_hash) = "$updater_hash" ]] ||
    fail 'failed transaction updater identity changed before resume'
  if [[ "$action" = activate ]]; then
    [[ $(read_receipt_field "$receipt" prepare_result) = completed &&
       $(remote_ref_sha refs/heads/master) = "$target" &&
       $(remote_ref_sha refs/heads/integration/test) = "$target" &&
       $(remote_ref_sha "refs/tags/$generation") = "$target" ]] ||
      fail 'failed ACTIVATE cannot resume because its prepared protected identity changed'
  fi
  retry_count=$(read_receipt_field "$receipt" transaction_retry_count 2>/dev/null || true)
  [[ "$retry_count" =~ ^[0-9]+$ ]] || retry_count=0
  receipt_update "$receipt" result accepted current_phase transaction_retry_accepted \
    failure_phase '' failure_code '' failure_message '' finished_at_utc '' started_at_utc '' \
    transaction_retry_count "__NUMBER__$((retry_count + 1))" \
    transaction_retried_at_utc "$(now_utc)"
  start_accepted_worker "$OPERATION_ID"
  emit_receipt "$receipt" "$(unit_state "$OPERATION_ID")" consistent
}

normalized_artifact_hash() {
  local root=$1
  [[ -d "$root" && ! -L "$root" ]] || fail 'live artifact root is absent or unsafe'
  tar --sort=name --mtime='UTC 1970-01-01' --owner=0 --group=0 --numeric-owner \
    --mode='u=rwX,go=rX' -C "$root" -cf - . | sha256sum | cut -d' ' -f1
}

recover_failed_prepare_with_new_updater() {
  local receipt=$1 new_hash=$2
  local old_hash initial_game initial_public current_game current_public
  local game_root public_root manifest server_hash client_hash actual_server actual_client
  local audit audit_hash retry_count cache_policy_hash
  validate_hash "$RECOVERY_CACHE_POLICY_SHA"
  [[ -f "$CADDY_CACHE_POLICY" && ! -L "$CADDY_CACHE_POLICY" ]] ||
    fail 'installed cache policy is absent or unsafe for PREPARE recovery'
  cache_policy_hash=$(sha256sum "$CADDY_CACHE_POLICY" | cut -d' ' -f1)
  [[ "$cache_policy_hash" = "$RECOVERY_CACHE_POLICY_SHA" ]] ||
    fail 'installed cache policy differs from trusted PREPARE recovery policy'
  [[ "$RECON_RESULT" = failed &&
     ( "$RECON_UNIT_STATE" = inactive || "$RECON_UNIT_STATE" = failed ) &&
     -z "$RECON_MARKER" && "$RECON_LOCK_STATE" = free ]] ||
    fail 'changed-updater PREPARE recovery requires a quiescent failed operation'
  [[ $(read_receipt_field "$receipt" requested_action) = prepare &&
     $(read_receipt_field "$receipt" current_phase) = artifact_hashing &&
     $(read_receipt_field "$receipt" failure_phase) = artifact_hashing &&
     $(read_receipt_field "$receipt" prepare_result) = pending &&
     $(read_receipt_field "$receipt" migration_started) = false &&
     $(read_receipt_field "$receipt" migration_completed) = false &&
     $(read_receipt_field "$receipt" migration_outcome_uncertain) = false &&
     $(read_receipt_field "$receipt" activation_started) = false &&
     $(read_receipt_field "$receipt" activation_completed) = false &&
     $(read_receipt_field "$receipt" activation_result) = pending &&
     -z $(read_receipt_field "$receipt" migration_intent_marker 2>/dev/null || true) &&
     ! -e $(migration_intent_path "$OPERATION_ID") &&
     ! -L $(migration_intent_path "$OPERATION_ID") ]] ||
    fail 'changed-updater PREPARE recovery lacks pre-mutation phase proof'
  old_hash=$(read_receipt_field "$receipt" updater_hash)
  validate_hash "$old_hash"
  [[ "$old_hash" != "$new_hash" ]] || fail 'changed-updater recovery requires a new updater hash'
  [[ -f "$UPDATER" && ! -L "$UPDATER" && $(installed_updater_hash) = "$new_hash" ]] ||
    fail 'installed updater differs from changed-updater recovery request'
  [[ $(remote_ref_sha "$(candidate_ref "$OPERATION_ID")") = "$TARGET_SHA" ]] ||
    fail 'candidate ref changed before PREPARE recovery'

  initial_game=$(read_receipt_field "$receipt" preparation_live_game_sha)
  initial_public=$(read_receipt_field "$receipt" preparation_live_public_sha)
  validate_sha "$initial_game"
  validate_sha "$initial_public"
  game_root=$(readlink -e "$GAME_RELEASE_ROOT") || fail 'game release root is absent'
  public_root=$(readlink -e "$PUBLIC_RELEASE_ROOT") || fail 'public release root is absent'
  current_game=$(readlink -e "$GAME_CURRENT" 2>/dev/null || true)
  current_public=$(readlink -e "$PUBLIC_CURRENT" 2>/dev/null || true)
  [[ "$initial_game" = "$initial_public" &&
     "$current_game" = "$game_root/$initial_game" &&
     "$current_public" = "$public_root/$initial_public" &&
     -d "$current_game" && ! -L "$current_game" &&
     -d "$current_public" && ! -L "$current_public" ]] ||
    fail 'live game or public pointer changed before PREPARE recovery'
  manifest="$current_game/build-manifest.json"
  [[ -f "$manifest" && ! -L "$manifest" && -d "$current_game/apps/server/dist" ]] ||
    fail 'live release manifest or server artifact is unsafe'
  read -r server_hash client_hash < <("$NODE_BIN" - "$manifest" "$initial_game" <<'NODE'
const fs = require('node:fs');
const [path, expectedSha] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(path, 'utf8'));
const server = manifest.artifact_hashes?.server;
const client = manifest.artifact_hashes?.client;
if (manifest.source_commit_sha !== expectedSha ||
    !/^[0-9a-f]{64}$/.test(server || '') ||
    !/^[0-9a-f]{64}$/.test(client || '')) process.exit(1);
process.stdout.write(`${server} ${client}\n`);
NODE
  ) || fail 'live build manifest does not bind both artifact hashes to the initial release'
  actual_server=$(normalized_artifact_hash "$current_game/apps/server/dist")
  actual_client=$(normalized_artifact_hash "$current_public")
  [[ "$actual_server" = "$server_hash" && "$actual_client" = "$client_hash" ]] ||
    fail 'live release file bytes differ from the initial build manifest'

  audit=$(prepare_recovery_audit_path "$OPERATION_ID")
  "$NODE_BIN" - "$receipt" "$audit" "$OPERATION_ID" "$TARGET_SHA" \
    "$old_hash" "$new_hash" "$current_game" "$current_public" \
    "$server_hash" "$client_hash" "$cache_policy_hash" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const [receiptPath, auditPath, operation, target, oldHash, newHash,
  gamePath, publicPath, serverHash, clientHash, cachePolicyHash] = process.argv.slice(2);
const raw = fs.readFileSync(receiptPath);
const failed = JSON.parse(raw);
const sha = (value) => createHash('sha256').update(value).digest('hex');
const stable = (value) => {
  const copy = { ...value };
  for (const key of Object.keys(copy)) if (key.startsWith('status_projection_')) delete copy[key];
  return sha(JSON.stringify(copy));
};
if (failed.result !== 'failed' || failed.operation_id !== operation ||
    failed.requested_target_sha !== target || failed.updater_hash !== oldHash ||
    failed.requested_action !== 'prepare' || failed.current_phase !== 'artifact_hashing') {
  throw new Error('failed PREPARE receipt changed during recovery proof');
}
const audit = {
  schema_version: 1, operation_id: operation, target_sha: target,
  generation: failed.requested_generation, release_mode: failed.release_mode || 'active',
  failed_updater_sha256: oldHash, recovery_updater_sha256: newHash,
  failed_receipt_sha256: sha(raw), failed_receipt_stable_sha256: stable(failed),
  failed_receipt: failed,
  proof: {
    failure_phase: 'artifact_hashing', migration_intent_absent: true,
    migration_started: false, activation_started: false,
    native_pointer_untouched_by_pre_activation_phase: true,
    initial_live_game_sha: failed.preparation_live_game_sha,
    initial_live_public_sha: failed.preparation_live_public_sha,
    verified_live_game_path: gamePath, verified_live_public_path: publicPath,
    build_manifest_source_commit_sha: failed.preparation_live_game_sha,
    live_server_artifact_sha256: serverHash, live_client_artifact_sha256: clientHash,
    installed_cache_policy_sha256: cachePolicyHash
  },
  recorded_at_utc: new Date().toISOString()
};
if (fs.existsSync(auditPath)) {
  if (fs.lstatSync(auditPath).isSymbolicLink()) throw new Error('recovery audit is unsafe');
  const existing = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
  if (existing.operation_id !== operation || existing.target_sha !== target ||
      existing.failed_updater_sha256 !== oldHash ||
      existing.recovery_updater_sha256 !== newHash ||
      existing.failed_receipt_stable_sha256 !== stable(failed) ||
      stable(existing.failed_receipt) !== stable(failed) ||
      JSON.stringify(existing.proof) !== JSON.stringify(audit.proof)) {
    throw new Error('existing recovery audit differs from failed receipt or proof');
  }
} else {
  const temporary = `${auditPath}.${process.pid}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o640);
    fs.writeFileSync(fd, `${JSON.stringify(audit, null, 2)}\n`);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    try { fs.chownSync(temporary, 0, Number(process.env.ASH_ATLAS_RECEIPT_GID || 0)); } catch {}
    fs.linkSync(temporary, auditPath);
    const dir = fs.openSync(path.dirname(auditPath), 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.rmSync(temporary, { force: true }); } catch {}
  }
}
NODE
  [[ -f "$audit" && ! -L "$audit" ]] || fail 'recovery audit was not persisted safely'
  audit_hash=$(sha256sum "$audit" | cut -d' ' -f1)
  validate_hash "$audit_hash"
  retry_count=$(read_receipt_field "$receipt" transaction_retry_count 2>/dev/null || true)
  [[ "$retry_count" =~ ^[0-9]+$ ]] || retry_count=0
  receipt_update "$receipt" updater_hash "$new_hash" result accepted \
    current_phase prepare_recovery_accepted failure_phase '' failure_code '' failure_message '' \
    finished_at_utc '' started_at_utc '' prepare_result pending \
    migration_required __NULL__ migration_result pending \
    activation_result pending readiness_result pending rollback_result not_required \
    recovery_audit_sha256 "$audit_hash" recovery_audit_path "$audit" \
    recovery_failed_updater_sha256 "$old_hash" \
    recovery_cache_policy_sha256 "$cache_policy_hash" \
    recovery_accepted_at_utc "$(now_utc)" \
    transaction_retry_count "__NUMBER__$((retry_count + 1))"
  start_accepted_worker "$OPERATION_ID"
  emit_receipt "$receipt" "$(unit_state "$OPERATION_ID")" consistent
}

start_operation() {
  [[ "$RELEASE_PATCH_NOTES_HEX" = none || "$RELEASE_PATCH_NOTES_HEX" =~ ^([0-9a-f]{2})+$ && ${#RELEASE_PATCH_NOTES_HEX} -le 128000 ]] ||
    fail 'release patch-note input is unsafe'
  fail 'legacy deploy action is disabled; use PREPARE then ACTIVATE with a durable activation intent'
  validate_operation_id "$OPERATION_ID"
  validate_sha "$TARGET_SHA"
  validate_hash "$EXPECTED_UPDATER_HASH"
  local status_token extra_status_input
  IFS= read -r status_token || fail 'deployment status token was not supplied on standard input'
  if IFS= read -r extra_status_input; then
    : "$extra_status_input"
    fail 'deployment status token input contained more than one line'
  fi
  validate_status_token "$status_token"
  provision_roots
  exec 8>"$CONTROL_LOCK"
  flock -w 4 8 || fail 'deployment controller is busy'

  local receipt unit current_result current_target current_hash current_unit_state
  receipt=$(receipt_path "$OPERATION_ID")
  unit=$(unit_name "$OPERATION_ID")
  reconcile_with_terminal_wait
  if [[ "$RECON_CONTROLLER_STATE" != consistent ]]; then
    if [[ -f "$receipt" ]]; then
      emit_receipt "$receipt" "$RECON_UNIT_STATE" ambiguous
    else
      emit_absent "$RECON_UNIT_STATE" ambiguous
    fi
    return 4
  fi
  if [[ -f "$receipt" ]]; then
    current_target=$(read_receipt_field "$receipt" requested_target_sha)
    current_hash=$(read_receipt_field "$receipt" updater_hash)
    [[ "$current_target" = "$TARGET_SHA" && "$current_hash" = "$EXPECTED_UPDATER_HASH" &&
       "$(read_receipt_field "$receipt" release_patch_notes_hex none)" = "$RELEASE_PATCH_NOTES_HEX" ]] ||
      fail 'operation ID already belongs to different immutable inputs'
    ensure_status_token "$OPERATION_ID" "$status_token"
    current_result=$(read_receipt_field "$receipt" result)
    case "$current_result" in
      completed)
        publish_status_required "$OPERATION_ID"
        emit_receipt "$receipt" "$RECON_UNIT_STATE" consistent
        return
        ;;
      accepted|running)
        if [[ "$current_result" = accepted ]]; then
          start_accepted_worker "$OPERATION_ID"
          current_unit_state=$(unit_state "$OPERATION_ID")
        else
          publish_status_required "$OPERATION_ID"
          current_unit_state=$RECON_UNIT_STATE
        fi
        emit_receipt "$receipt" "$current_unit_state" consistent
        return
        ;;
      failed)
        publish_status_required "$OPERATION_ID"
        emit_receipt "$receipt" "$RECON_UNIT_STATE" consistent
        return 3
        ;;
      *) fail 'existing operation receipt has an unsupported result' ;;
    esac
  fi

  [[ "$(remote_master_sha)" = "$TARGET_SHA" ]] || fail 'origin/master does not equal the requested target'
  [[ -f "$UPDATER" && ! -L "$UPDATER" ]] || fail 'installed updater is absent or unsafe'
  [[ "$(installed_updater_hash)" = "$EXPECTED_UPDATER_HASH" ]] ||
    fail 'installed updater hash differs from the requested hash'

  ensure_status_token "$OPERATION_ID" "$status_token"
  receipt_update "$receipt" \
    schema_version __NUMBER__1 \
    operation_id "$OPERATION_ID" \
    requested_action deploy release_patch_notes_hex "$RELEASE_PATCH_NOTES_HEX" \
    requested_target_sha "$TARGET_SHA" \
    requested_generation '' \
    candidate_ref '' \
    updater_hash "$EXPECTED_UPDATER_HASH" \
    accepted_at_utc "$(now_utc)" \
    started_at_utc '' \
    current_phase accepted \
    queued_behind_operation '' \
    lock_wait_started_at_utc '' \
    lock_wait_elapsed_ms __NUMBER__0 \
    lock_wait_attempts __NUMBER__0 \
    lock_wait_completed_at_utc '' \
    execution_lock_diagnostics __JSON__'{}' \
    previous_live_sha '' \
    deployment_lane unknown \
    cache_results __JSON__'{}' \
    prepare_result not_required \
    prepared_env_sha256 '' prepared_remote_receipt_sha256 '' \
    migration_required __NULL__ \
    migration_started __FALSE__ \
    migration_completed __FALSE__ \
    migration_intent_marker '' migration_outcome_uncertain __FALSE__ \
    migration_ledger_verified __FALSE__ migration_command_completed __FALSE__ \
    migration_ledger_before_sha256 '' migration_ledger_after_sha256 '' \
    migration_result pending \
    activation_started __FALSE__ \
    activation_completed __FALSE__ \
    activation_result pending \
    readiness_result pending \
    active_game_sha '' \
    active_public_sha '' \
    result accepted \
    failure_phase '' \
    failure_code '' \
    failure_message '' \
    finished_at_utc ''
  validate_persisted_acceptance "$receipt" "$OPERATION_ID" "$TARGET_SHA" "$EXPECTED_UPDATER_HASH"
  start_accepted_worker "$OPERATION_ID" || return $?
  current_unit_state=$(unit_state "$OPERATION_ID")
  emit_receipt "$receipt" "$current_unit_state" consistent
}

handoff_retirement_prepared_updater() {
  local receipt=$1 new_hash=$2 old_hash audit audit_hash environment registry_commit receipt_hash
  old_hash=$(read_receipt_field "$receipt" updater_hash)
  # This reviewed bridge is only for the frozen build-8 operation; other prepared
  # operations retain the existing immutable updater rule.
  [[ "$OPERATION_ID" = coordinated-20260101T000000-00000000 &&
     "$TARGET_SHA" = 4811473f91d3b209ddd3da7f47f4a41de97ca121 &&
     "$old_hash" = a48707a2eb3ec28bd0b4281f22073fa26345570adb55ce40681d4cea23832d67 &&
     "$new_hash" = 7a2bed570178b337613d9ec308230ac62e72c2ccc1341f19692902dd3ce83d62 &&
     $(installed_updater_hash) = "$new_hash" &&
     "$RECON_RESULT" = prepared && "$RECON_CONTROLLER_STATE" = consistent &&
     ( "$RECON_UNIT_STATE" = inactive || "$RECON_UNIT_STATE" = failed ) &&
     -z "$RECON_MARKER" && "$RECON_LOCK_STATE" = free &&
     ! -e $(migration_intent_path "$OPERATION_ID") &&
     ! -L $(migration_intent_path "$OPERATION_ID") ]] ||
    fail 'retirement updater handoff lacks exact quiescent frozen-operation proof'
  environment=/etc/ash-atlas/game.env
  if [[ ${ASH_ATLAS_DEPLOY_CONTROL_TEST_MODE:-false} = true ]]; then
    environment=${ASH_ATLAS_TEST_ENV_FILE:?}
  fi
  [[ -f "$environment" && ! -L "$environment" &&
     $(sha256sum "$environment" | cut -d' ' -f1) = \
       "$(read_receipt_field "$receipt" prepared_env_sha256)" ]] ||
    fail 'retirement updater handoff cannot change the prepared environment'
  [[ $(prepared_receipt_sha "$receipt") = \
       "$(read_receipt_field "$receipt" prepared_remote_receipt_sha256)" ]] ||
    fail 'retirement updater handoff prepared receipt checksum differs'
  [[ $(readlink -e "$GAME_CURRENT") = \
       "$GAME_RELEASE_ROOT/$(read_receipt_field "$receipt" prepared_previous_game_sha)" &&
     $(readlink -e "$PUBLIC_CURRENT") = \
       "$PUBLIC_RELEASE_ROOT/$(read_receipt_field "$receipt" prepared_previous_public_sha)" ]] ||
    fail 'retirement updater handoff cannot change live release identities'
  registry_commit=$(remote_ref_sha "$MOBILE_REGISTRY_REF")
  load_mobile_registry "$registry_commit"
  audit="$CONTROL_ROOT/$OPERATION_ID.retirement-updater-handoff.json"
  "$NODE_BIN" - "$receipt" "$audit" "$old_hash" "$new_hash" "$MOBILE_REGISTRY_PATH" "$registry_commit" <<'NODE'
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const [receiptPath, auditPath, oldHash, newHash, registryPath, registryCommit] = process.argv.slice(2);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const raw = fs.readFileSync(receiptPath);
const r = JSON.parse(raw);
const registryBytes = fs.readFileSync(registryPath);
const registry = JSON.parse(registryBytes);
if (r.operation_id !== 'coordinated-20260101T000000-00000000' ||
    r.requested_target_sha !== '4811473f91d3b209ddd3da7f47f4a41de97ca121' ||
    r.requested_generation !== 'test/t1278' || r.release_mode !== 'active' ||
    r.requested_action !== 'prepare' || r.result !== 'prepared' ||
    r.prepare_result !== 'completed' || r.updater_hash !== oldHash ||
    r.activation_started !== false || r.activation_completed !== false ||
    r.migration_started !== false || r.migration_completed !== false ||
    r.migration_outcome_uncertain !== false || r.activation_result !== 'pending' ||
    r.activation_intent_id || r.activation_registry_commit_sha ||
    r.prepared_descriptor_version !== 4 ||
    !/^[0-9a-f]{64}$/.test(r.prepared_descriptor_sha256) ||
    r.prepare_receipt_sha256 !== r.prepared_descriptor_sha256) {
  throw new Error('retirement updater handoff prepared evidence differs');
}
const expected = { ios: ['1111111111111111111111111111111111111111111111111111111111111111',
  '00000000-0000-4000-8000-000000000000'], android: [
  '2222222222222222222222222222222222222222222222222222222222222222', '8'] };
const identities = [];
for (const [platform, [artifact, store]] of Object.entries(expected)) {
  const matches = registry.releases.filter(v => v.platform === platform && v.build === 8);
  const v = matches[0];
  if (matches.length !== 1 || v.marketingVersion !== '1.1.0' || v.generation !== 't1278' ||
      v.sourceSha !== r.requested_target_sha || v.artifactSha256 !== artifact ||
      v.storeBuildId !== store || v.releaseId !== 'coord-coordinated-20260101T000000-00000000-000000000000' ||
      v.compatibilityProtected !== true || registry.activationIntent) {
    throw new Error('retirement updater handoff build 8 submission identity differs');
  }
  identities.push({ platform, build: 8, artifactSha256: artifact, storeBuildId: store,
    releaseId: v.releaseId, sourceSha: v.sourceSha });
}
const audit = { schema_version: 1, kind: 'retirement-prepared-updater-handoff',
  operation_id: r.operation_id, prior_updater_sha256: oldHash, updater_sha256: newHash,
  prior_receipt_sha256: sha(raw), prior_receipt: r,
  prepared_descriptor_sha256: r.prepared_descriptor_sha256,
  prepared_env_sha256: r.prepared_env_sha256,
  registry_commit_sha: registryCommit, registry_sha256: sha(registryBytes),
  build8_submissions: identities, recorded_at_utc: new Date().toISOString() };
if (fs.existsSync(auditPath)) {
  if (fs.lstatSync(auditPath).isSymbolicLink()) throw new Error('unsafe retirement handoff audit');
  const prior = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
  const volatile = new Set(['status_projection_result', 'status_projection_updated_at_utc',
    'status_projection_failure_count', 'status_projection_last_error']);
  const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).filter(k => !volatile.has(k)).sort().map(k => [k, stable(value[k])])) : value;
  if (JSON.stringify(stable(prior.prior_receipt)) !== JSON.stringify(stable(r))) {
    throw new Error('retirement handoff original preparation differs');
  }
  for (const key of Object.keys(audit).filter(k => !['recorded_at_utc', 'prior_receipt', 'prior_receipt_sha256'].includes(k))) {
    if (JSON.stringify(prior[key]) !== JSON.stringify(audit[key])) throw new Error('retirement handoff audit differs');
  }
} else {
  const temporary = `${auditPath}.${process.pid}.tmp`;
  const fd = fs.openSync(temporary, 'wx', 0o640);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(audit, null, 2)}\n`); fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  try {
    fs.linkSync(temporary, auditPath);
    const dir = fs.openSync(require('node:path').dirname(auditPath), 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  } finally { fs.rmSync(temporary, { force: true }); }
}
NODE
  [[ -z "$MOBILE_REGISTRY_PATH" || -n "$TEST_MOBILE_REGISTRY_PATH" ]] || rm -f -- "$MOBILE_REGISTRY_PATH"
  MOBILE_REGISTRY_PATH=
  audit_hash=$(sha256sum "$audit" | cut -d' ' -f1)
  validate_hash "$audit_hash"
  receipt_hash=$("$NODE_BIN" - "$receipt" "$new_hash" "$audit" "$audit_hash" <<'NODE'
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const [receiptPath, updaterHash, auditPath, auditHash] = process.argv.slice(2);
const next = { ...JSON.parse(fs.readFileSync(receiptPath, 'utf8')), updater_hash: updaterHash,
  retirement_updater_handoff_path: auditPath, retirement_updater_handoff_sha256: auditHash };
const ignored = new Set(['prepared_remote_receipt_sha256', 'status_projection_result',
  'status_projection_updated_at_utc', 'status_projection_failure_count', 'status_projection_last_error']);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).filter(k => !ignored.has(k)).sort().map(k => [k, canonical(value[k])])) : value;
process.stdout.write(createHash('sha256').update(JSON.stringify(canonical(next))).digest('hex'));
NODE
  )
  validate_hash "$receipt_hash"
  receipt_update "$receipt" updater_hash "$new_hash" \
    retirement_updater_handoff_path "$audit" retirement_updater_handoff_sha256 "$audit_hash" \
    prepared_remote_receipt_sha256 "$receipt_hash"
  publish_status_required "$OPERATION_ID"
  emit_receipt "$receipt" "$RECON_UNIT_STATE" consistent
}

prepare_operation() {
  validate_operation_id "$OPERATION_ID"
  validate_sha "$TARGET_SHA"
  validate_hash "$EXPECTED_UPDATER_HASH"
  local generation=$REQUEST_ARGUMENT
  [[ "$generation" =~ ^test/t[0-9]{3,4}$ ]] || fail 'prepared generation is unsafe'
  local release_mode=${PREPARE_RELEASE_MODE:-active}
  validate_release_mode "$release_mode"
  [[ "$RELEASE_PATCH_NOTES_HEX" = none || "$RELEASE_PATCH_NOTES_HEX" =~ ^([0-9a-f]{2})+$ && ${#RELEASE_PATCH_NOTES_HEX} -le 128000 ]] ||
    fail 'release patch-note input is unsafe'
  local status_token extra_status_input receipt current_result current_unit_state existing_release_mode
  local preparation_game preparation_public
  IFS= read -r status_token || fail 'deployment status token was not supplied on standard input'
  if IFS= read -r extra_status_input; then
    : "$extra_status_input"
    fail 'deployment status token input contained more than one line'
  fi
  validate_status_token "$status_token"
  provision_roots
  exec 8>"$CONTROL_LOCK"
  flock -w 4 8 || fail 'deployment controller is busy'
  receipt=$(receipt_path "$OPERATION_ID")
  reconcile_with_terminal_wait
  [[ "$RECON_CONTROLLER_STATE" = consistent ]] || fail 'prepare operation controller state is ambiguous'
  if [[ -f "$receipt" ]]; then
    existing_release_mode=$(read_receipt_field "$receipt" release_mode 2>/dev/null || true)
    existing_release_mode=${existing_release_mode:-active}
    validate_release_mode "$existing_release_mode"
    [[ $(read_receipt_field "$receipt" requested_target_sha) = "$TARGET_SHA" &&
       $(read_receipt_field "$receipt" requested_generation) = "$generation" &&
       "$existing_release_mode" = "$release_mode" &&
       "$(read_receipt_field "$receipt" release_patch_notes_hex none)" = "$RELEASE_PATCH_NOTES_HEX" ]] ||
      fail 'operation ID already belongs to different immutable prepare inputs'
    ensure_status_token "$OPERATION_ID" "$status_token"
    current_result=$(read_receipt_field "$receipt" result)
    if [[ $(read_receipt_field "$receipt" updater_hash) != "$EXPECTED_UPDATER_HASH" ]]; then
      if [[ "$current_result" = prepared ]]; then
        handoff_retirement_prepared_updater "$receipt" "$EXPECTED_UPDATER_HASH"
        return
      fi
      [[ "$current_result" = failed ]] ||
        fail 'operation ID already belongs to different immutable prepare inputs'
      recover_failed_prepare_with_new_updater "$receipt" "$EXPECTED_UPDATER_HASH"
      return
    fi
    case "$current_result" in
      prepared|completed)
        publish_status_required "$OPERATION_ID"
        emit_receipt "$receipt" "$RECON_UNIT_STATE" consistent
        return
        ;;
      accepted|running)
        if [[ "$current_result" = accepted ]]; then start_accepted_worker "$OPERATION_ID"; fi
        emit_receipt "$receipt" "$(unit_state "$OPERATION_ID")" consistent
        return
        ;;
      failed)
        retry_failed_transaction "$receipt" || {
          publish_status_required "$OPERATION_ID"
          emit_receipt "$receipt" "$RECON_UNIT_STATE" consistent
          return 3
        }
        return
        ;;
      *) fail 'existing prepare receipt has an unsupported result' ;;
    esac
  fi
  [[ $(remote_ref_sha "$(candidate_ref "$OPERATION_ID")") = "$TARGET_SHA" ]] ||
    fail 'remote candidate ref does not equal the requested PREPARE target'
  [[ -f "$UPDATER" && ! -L "$UPDATER" ]] || fail 'installed updater is absent or unsafe'
  [[ $(installed_updater_hash) = "$EXPECTED_UPDATER_HASH" ]] ||
    fail 'installed updater hash differs from the requested prepare hash'
  preparation_game=$(readlink -e "$GAME_CURRENT" 2>/dev/null || true)
  preparation_public=$(readlink -e "$PUBLIC_CURRENT" 2>/dev/null || true)
  [[ "${preparation_game##*/}" =~ ^[0-9a-f]{40}$ &&
     "${preparation_public##*/}" =~ ^[0-9a-f]{40}$ ]] ||
    fail 'live release identity is unsafe before PREPARE acceptance'
  ensure_status_token "$OPERATION_ID" "$status_token"
  receipt_update "$receipt" \
    schema_version __NUMBER__1 operation_id "$OPERATION_ID" \
    requested_action prepare requested_target_sha "$TARGET_SHA" \
    requested_generation "$generation" candidate_ref "$(candidate_ref "$OPERATION_ID")" \
    preparation_live_game_sha "${preparation_game##*/}" \
    preparation_live_public_sha "${preparation_public##*/}" \
    updater_hash "$EXPECTED_UPDATER_HASH" accepted_at_utc "$(now_utc)" started_at_utc '' \
    current_phase accepted queued_behind_operation '' \
    lock_wait_started_at_utc '' lock_wait_elapsed_ms __NUMBER__0 lock_wait_attempts __NUMBER__0 \
    lock_wait_completed_at_utc '' execution_lock_diagnostics __JSON__'{}' \
    previous_live_sha '' deployment_lane unknown cache_results __JSON__'{}' \
    prepare_result pending prepared_at_utc '' prepare_receipt_sha256 '' \
    prepared_env_sha256 '' prepared_remote_receipt_sha256 '' \
    release_mode "$release_mode" release_patch_notes_hex "$RELEASE_PATCH_NOTES_HEX" \
    prepared_descriptor_version __NUMBER__0 prepared_descriptor_sha256 '' \
    release_classification_version __NUMBER__0 release_class '' \
    release_classification_evidence_sha256 '' release_changed_paths_sha256 '' \
    prepared_server_component_sha '' prepared_server_artifact_sha256 '' \
    prepared_client_component_sha '' prepared_client_artifact_sha256 '' \
    prepared_game_main_pid __NUMBER__0 prepared_game_start_timestamp_monotonic __NUMBER__0 \
    prepared_live_game_link_sha '' prepared_live_public_link_sha '' \
    prepared_live_public_release_sha '' activated_game_main_pid __NUMBER__0 \
    activated_game_start_timestamp_monotonic __NUMBER__0 activated_game_link_sha '' \
    activated_public_link_sha '' \
    transaction_retry_count __NUMBER__0 rollback_result not_required \
    migration_required __NULL__ migration_started __FALSE__ migration_completed __FALSE__ \
    migration_intent_marker '' migration_outcome_uncertain __FALSE__ \
    migration_ledger_verified __FALSE__ migration_command_completed __FALSE__ \
    migration_ledger_before_sha256 '' migration_ledger_after_sha256 '' \
    migration_result pending activation_started __FALSE__ activation_completed __FALSE__ \
    activation_result pending readiness_result pending active_game_sha '' active_public_sha '' \
    result accepted failure_phase '' failure_code '' failure_message '' finished_at_utc ''
  validate_persisted_acceptance "$receipt" "$OPERATION_ID" "$TARGET_SHA" "$EXPECTED_UPDATER_HASH"
  start_accepted_worker "$OPERATION_ID" || return $?
  current_unit_state=$(unit_state "$OPERATION_ID")
  emit_receipt "$receipt" "$current_unit_state" consistent
}

activate_operation() {
  validate_operation_id "$OPERATION_ID"
  validate_sha "$TARGET_SHA"
  validate_hash "$EXPECTED_UPDATER_HASH"
  local generation=$REQUEST_ARGUMENT
  [[ "$generation" =~ ^test/t[0-9]{3,4}$ ]] || fail 'activation generation is unsafe'
  provision_roots
  exec 8>"$CONTROL_LOCK"
  flock -w 4 8 || fail 'deployment controller is busy'
  local receipt current_result requested_action prepare_wait_started prepare_wait_completed release_mode
  local prepare_wait_elapsed prepare_wait_attempts
  receipt=$(receipt_path "$OPERATION_ID")
  reconcile_with_terminal_wait
  [[ "$RECON_OPERATION_STATE" = readable && "$RECON_CONTROLLER_STATE" = consistent ]] ||
    fail 'ACTIVATE requires one consistent durable PREPARED receipt'
  release_mode=$(read_receipt_field "$receipt" release_mode 2>/dev/null || true)
  release_mode=${release_mode:-active}
  validate_release_mode "$release_mode"
  if [[ "$release_mode" = active ]]; then
    [[ "$ACTIVATION_INTENT_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$ ]] ||
      fail 'activation intent ID is required and unsafe'
    validate_sha "$ACTIVATION_REGISTRY_COMMIT_SHA"
  else
    [[ -z "$ACTIVATION_INTENT_ID" && -z "$ACTIVATION_REGISTRY_COMMIT_SHA" ]] ||
      fail 'paused web-only activation must not receive a mobile activation identity'
  fi
  [[ $(read_receipt_field "$receipt" requested_target_sha) = "$TARGET_SHA" &&
     $(read_receipt_field "$receipt" updater_hash) = "$EXPECTED_UPDATER_HASH" &&
     $(read_receipt_field "$receipt" requested_generation) = "$generation" &&
     $(read_receipt_field "$receipt" prepare_result) = completed ]] ||
    fail 'ACTIVATE inputs differ from the durable PREPARED receipt'
  current_result=$(read_receipt_field "$receipt" result)
  requested_action=$(read_receipt_field "$receipt" requested_action)
  if [[ "$current_result" != prepared ]]; then
    [[ $(read_receipt_field "$receipt" activation_intent_id 2>/dev/null || true) = "$ACTIVATION_INTENT_ID" &&
       $(read_receipt_field "$receipt" activation_registry_commit_sha 2>/dev/null || true) = "$ACTIVATION_REGISTRY_COMMIT_SHA" ]] ||
      fail 'ACTIVATE retry identity differs from the durable activation intent'
  fi
  case "$current_result" in
    completed)
      publish_status_required "$OPERATION_ID"
      emit_receipt "$receipt" "$RECON_UNIT_STATE" consistent
      return
      ;;
    failed)
      retry_failed_transaction "$receipt" || {
        publish_status_required "$OPERATION_ID"
        emit_receipt "$receipt" "$RECON_UNIT_STATE" consistent
        return 3
      }
      return
      ;;
    accepted|running)
      [[ "$requested_action" = activate ]] || fail 'operation is not an accepted ACTIVATE request'
      if [[ "$current_result" = accepted ]]; then start_accepted_worker "$OPERATION_ID"; fi
      emit_receipt "$receipt" "$(unit_state "$OPERATION_ID")" consistent
      return
      ;;
    prepared) ;;
    *) fail 'operation is not PREPARED for activation' ;;
  esac
  [[ $(remote_ref_sha refs/heads/master) = "$TARGET_SHA" ]] ||
    fail 'origin/master does not equal the PREPARED target'
  frozen_integration_tooling_only "$TARGET_SHA" ||
    fail 'origin/integration/test differs from PREPARED target outside reviewed release tooling'
  [[ $(remote_ref_sha "refs/tags/$generation") = "$TARGET_SHA" ]] ||
    fail 'immutable generation does not equal the PREPARED target'
  [[ -f "$UPDATER" && ! -L "$UPDATER" &&
     $(installed_updater_hash) = "$EXPECTED_UPDATER_HASH" ]] ||
    fail 'installed updater differs from the PREPARED updater identity'
  prepare_wait_started=$(read_receipt_field "$receipt" lock_wait_started_at_utc 2>/dev/null || true)
  prepare_wait_completed=$(read_receipt_field "$receipt" lock_wait_completed_at_utc 2>/dev/null || true)
  prepare_wait_elapsed=$(read_receipt_field "$receipt" lock_wait_elapsed_ms 2>/dev/null || true)
  prepare_wait_attempts=$(read_receipt_field "$receipt" lock_wait_attempts 2>/dev/null || true)
  [[ "$prepare_wait_elapsed" =~ ^[0-9]+$ ]] || prepare_wait_elapsed=0
  [[ "$prepare_wait_attempts" =~ ^[0-9]+$ ]] || prepare_wait_attempts=0
  receipt_update "$receipt" requested_action activate result accepted current_phase activation_accepted \
    release_mode "$release_mode" \
    activation_intent_id "$ACTIVATION_INTENT_ID" \
    activation_registry_commit_sha "$ACTIVATION_REGISTRY_COMMIT_SHA" \
    activation_requested_at_utc "$(now_utc)" started_at_utc '' finished_at_utc '' \
    prepare_lock_wait_started_at_utc "$prepare_wait_started" \
    prepare_lock_wait_completed_at_utc "$prepare_wait_completed" \
    prepare_lock_wait_elapsed_ms "__NUMBER__$prepare_wait_elapsed" \
    prepare_lock_wait_attempts "__NUMBER__$prepare_wait_attempts" \
    lock_wait_started_at_utc '' lock_wait_completed_at_utc '' \
    lock_wait_elapsed_ms __NUMBER__0 lock_wait_attempts __NUMBER__0
  start_accepted_worker "$OPERATION_ID" || return $?
  emit_receipt "$receipt" "$(unit_state "$OPERATION_ID")" consistent
}

terminalize_failed_operation() {
  local receipt=$1
  local phase=$2
  local message=$3
  exec 8>"$CONTROL_LOCK"
  flock -w 4 8 || return 1
  local result timing timing_json failure_code
  result=$(read_receipt_field "$receipt" result 2>/dev/null || true)
  if [[ "$result" != completed && "$result" != failed ]]; then
    timing="$TIMING_ROOT/$OPERATION_ID.json"
    if [[ -f "$timing" ]]; then
      timing_json=$(<"$timing")
      receipt_update "$receipt" deployment_timings "__JSON__$timing_json"
    fi
    failure_code=${4:-${phase}_failed}
    [[ "$failure_code" =~ ^[a-z][a-z0-9_]{0,63}$ ]] || failure_code=deployment_failed
    receipt_update "$receipt" result failed current_phase "$phase" failure_phase "$phase" \
      failure_code "$failure_code" \
      failure_message "$message" finished_at_utc "$(now_utc)"
  fi
  clear_active_marker "$OPERATION_ID"
  if [[ -e /proc/$$/fd/9 ]]; then flock -u 9 || true; fi
  flock -u 8
}

terminalize_completed_operation() {
  local receipt=$1
  local game_sha=$2
  local public_sha=$3
  exec 8>"$CONTROL_LOCK"
  flock -w 4 8 || return 1
  local timing timing_json
  timing="$TIMING_ROOT/$OPERATION_ID.json"
  if [[ -f "$timing" ]]; then
    timing_json=$(<"$timing")
    receipt_update "$receipt" deployment_timings "__JSON__$timing_json"
  fi
  receipt_update "$receipt" result completed current_phase completed \
    active_game_sha "$game_sha" active_public_sha "$public_sha" \
    failure_phase '' failure_code '' \
    finished_at_utc "$(now_utc)"
  local migration_marker
  migration_marker=$(migration_intent_path "$OPERATION_ID")
  if [[ -e "$migration_marker" || -L "$migration_marker" ]]; then
    [[ -f "$migration_marker" && ! -L "$migration_marker" ]] ||
      fail 'completed operation has an unsafe migration intent marker'
    rm -f -- "$migration_marker" ||
      fail 'completed operation migration intent marker could not be cleared'
  fi
  clear_active_marker "$OPERATION_ID"
  if [[ -e /proc/$$/fd/9 ]]; then flock -u 9 || true; fi
  flock -u 8
}

terminalize_prepared_operation() {
  local receipt=$1
  exec 8>"$CONTROL_LOCK"
  flock -w 4 8 || return 1
  local result timing timing_json receipt_hash
  result=$(read_receipt_field "$receipt" result 2>/dev/null || true)
  [[ "$result" = prepared &&
     $(read_receipt_field "$receipt" prepare_result 2>/dev/null || true) = completed ]] || {
    flock -u 8
    return 1
  }
  timing="$TIMING_ROOT/$OPERATION_ID.json"
  if [[ -f "$timing" ]]; then
    timing_json=$(<"$timing")
    receipt_update "$receipt" deployment_timings "__JSON__$timing_json"
  fi
  receipt_hash=$(prepared_receipt_sha "$receipt")
  validate_hash "$receipt_hash"
  receipt_update "$receipt" prepared_remote_receipt_sha256 "$receipt_hash"
  clear_active_marker "$OPERATION_ID"
  if [[ -e /proc/$$/fd/9 ]]; then flock -u 9 || true; fi
  flock -u 8
}

run_exit_handler() {
  local code=$?
  trap - EXIT
  if [[ ${RUN_FINALIZER_ARMED:-false} = true && -n ${RUN_RECEIPT:-} && -f ${RUN_RECEIPT:-} ]]; then
    local result phase
    result=$(read_receipt_field "$RUN_RECEIPT" result 2>/dev/null || true)
    if [[ "$result" != prepared && "$result" != completed && "$result" != failed ]]; then
      phase=$(read_receipt_field "$RUN_RECEIPT" current_phase 2>/dev/null || true)
      if [[ "$result" = accepted ]]; then
        preserve_recoverable_wait "$RUN_RECEIPT" waiting_for_execution_lock "$code" || true
      else
        terminalize_failed_operation "$RUN_RECEIPT" "${phase:-worker_exit}" \
          "systemd worker exited with code $code before a terminal receipt" || true
      fi
    fi
  fi
  exit "$code"
}

preserve_recoverable_wait() {
  local receipt=$1
  local phase=$2
  local code=${3:-0}
  exec 8>"$CONTROL_LOCK"
  flock -w 4 8 || return 1
  local result
  result=$(read_receipt_field "$receipt" result 2>/dev/null || true)
  if [[ "$result" = accepted ]]; then
    receipt_update "$receipt" result accepted current_phase "$phase" \
      last_waiting_worker_exit_code "__NUMBER__$code" \
      last_waiting_worker_exit_at_utc "$(now_utc)"
  fi
  clear_active_marker "$OPERATION_ID"
  if [[ -e /proc/$$/fd/9 ]]; then flock -u 9 || true; fi
  flock -u 8
}

record_execution_lock_wait() {
  local receipt=$1
  local wait_started attempts diagnostics classification state now_epoch start_epoch elapsed_ms
  wait_started=$(read_receipt_field "$receipt" lock_wait_started_at_utc 2>/dev/null || true)
  if [[ -z "$wait_started" ]]; then wait_started=$(now_utc); fi
  attempts=$(read_receipt_field "$receipt" lock_wait_attempts 2>/dev/null || true)
  [[ "$attempts" =~ ^[0-9]+$ ]] || attempts=0
  start_epoch=$(date -u -d "$wait_started" +%s)
  attempts=$((attempts + 1))
  diagnostics=$(lock_owner_diagnostics)
  state=$(diagnostic_field "$diagnostics" state)
  classification=$(diagnostic_field "$diagnostics" classification)
  now_epoch=$(date -u +%s)
  elapsed_ms=$(( (now_epoch - start_epoch) * 1000 ))
  exec 8>"$CONTROL_LOCK"
  flock -w 4 8 || return 1
  receipt_update "$receipt" result accepted current_phase waiting_for_execution_lock \
    lock_wait_started_at_utc "$wait_started" \
    lock_wait_elapsed_ms "__NUMBER__$elapsed_ms" \
    lock_wait_attempts "__NUMBER__$attempts" \
    execution_lock_diagnostics "__JSON__$diagnostics"
  flock -u 8
  if [[ "$state" = unknown || "$classification" = unknown_inconsistent_holder ]]; then
    terminalize_failed_operation "$receipt" execution_lock_owner \
      'deployment lock has an unknown or inconsistent owner; activation was not attempted' \
      unknown_execution_lock_owner
    return 1
  fi
}

run_operation() {
  validate_operation_id "$OPERATION_ID"
  provision_roots
  local receipt code
  receipt=$(receipt_path "$OPERATION_ID")
  [[ -f "$receipt" ]] || fail 'systemd worker has no authoritative operation receipt'
  [[ "$(read_receipt_field "$receipt" result)" = accepted ]] ||
    fail 'systemd worker requires an accepted operation receipt'
  [[ -f "$ACTIVE_MARKER" && "$(<"$ACTIVE_MARKER")" = "$OPERATION_ID" ]] ||
    fail 'systemd worker does not own the active-operation marker'
  while true; do
    set +e
    flock -n -E 75 -o "$DEPLOY_LOCK" "$0" execute "$OPERATION_ID"
    code=$?
    set -e
    if (( code != 75 )); then return "$code"; fi
    record_execution_lock_wait "$receipt" || return $?
    sleep "$LOCK_WAIT_INTERVAL"
  done
}

execute_operation() {
  validate_operation_id "$OPERATION_ID"
  provision_roots
  local receipt target expected_hash requested_action requested_generation requested_candidate release_mode
  local activation_intent_id activation_registry_commit_sha
  local log current_hash code message phase game_path public_path
  receipt=$(receipt_path "$OPERATION_ID")
  log=$(log_path "$OPERATION_ID")
  [[ -f "$receipt" ]] || fail 'systemd worker has no authoritative operation receipt'
  RUN_RECEIPT=$receipt
  RUN_FINALIZER_ARMED=true
  trap run_exit_handler EXIT
  target=$(read_receipt_field "$receipt" requested_target_sha)
  expected_hash=$(read_receipt_field "$receipt" updater_hash)
  requested_action=$(read_receipt_field "$receipt" requested_action 2>/dev/null || true)
  requested_action=${requested_action:-deploy}
  requested_generation=$(read_receipt_field "$receipt" requested_generation 2>/dev/null || true)
  requested_candidate=$(read_receipt_field "$receipt" candidate_ref 2>/dev/null || true)
  release_mode=$(read_receipt_field "$receipt" release_mode 2>/dev/null || true)
  release_mode=${release_mode:-active}
  validate_release_mode "$release_mode"
  activation_intent_id=$(read_receipt_field "$receipt" activation_intent_id 2>/dev/null || true)
  activation_registry_commit_sha=$(read_receipt_field "$receipt" activation_registry_commit_sha 2>/dev/null || true)
  if [[ "$requested_action" = deploy ]]; then
    terminalize_failed_operation "$receipt" legacy_deploy \
      'legacy deploy receipts are disabled; use PREPARE then ACTIVATE with a durable activation intent' \
      legacy_deploy_disabled
    return 1
  fi
  [[ "$requested_action" =~ ^(prepare|activate)$ ]] || fail 'receipt action is unsafe'
  validate_sha "$target"
  validate_hash "$expected_hash"
  [[ -f "$ACTIVE_MARKER" && "$(<"$ACTIVE_MARKER")" = "$OPERATION_ID" ]] ||
    fail 'systemd worker does not own the active-operation marker'

  exec 8>"$CONTROL_LOCK"
  flock -w 4 8 || {
    terminalize_failed_operation "$receipt" controller_lock \
      'controller lock remained held during worker handoff'
    return 1
  }
  local wait_started attempts start_epoch now_epoch elapsed_ms diagnostics
  wait_started=$(read_receipt_field "$receipt" lock_wait_started_at_utc 2>/dev/null || true)
  if [[ -z "$wait_started" ]]; then wait_started=$(now_utc); fi
  attempts=$(read_receipt_field "$receipt" lock_wait_attempts 2>/dev/null || true)
  [[ "$attempts" =~ ^[0-9]+$ ]] || attempts=0
  start_epoch=$(date -u -d "$wait_started" +%s)
  now_epoch=$(date -u +%s)
  elapsed_ms=$(( (now_epoch - start_epoch) * 1000 ))
  diagnostics=$(lock_owner_diagnostics)
  receipt_update "$receipt" result accepted current_phase starting \
    lock_wait_started_at_utc "$wait_started" \
    lock_wait_elapsed_ms "__NUMBER__$elapsed_ms" \
    lock_wait_attempts "__NUMBER__$attempts" \
    lock_wait_completed_at_utc "$(now_utc)" \
    execution_lock_diagnostics "__JSON__$diagnostics"
  if [[ ${ASH_ATLAS_DEPLOY_CONTROL_TEST_MODE:-false} = true &&
        -n ${ASH_ATLAS_TEST_PAUSE_AFTER_LOCK_FILE:-} ]]; then
    : >"$ASH_ATLAS_TEST_PAUSE_AFTER_LOCK_FILE"
    sleep "${ASH_ATLAS_TEST_PAUSE_AFTER_LOCK_SECONDS:-5}"
  fi
  reconcile_operation
  if [[ "$RECON_CONTROLLER_STATE" != consistent || "$RECON_RESULT" != accepted ||
        "$RECON_MARKER" != "$OPERATION_ID" ||
        "$RECON_LOCK_CLASSIFICATION" != current_operation ]]; then
    flock -u 8
    terminalize_failed_operation "$receipt" worker_handoff \
      'accepted receipt, marker, unit, and deployment lock disagreed during worker handoff'
    return 1
  fi
  receipt_update "$receipt" result running current_phase starting started_at_utc "$(now_utc)"
  flock -u 8

  if [[ ! -f "$UPDATER" || -L "$UPDATER" ]]; then
    terminalize_failed_operation "$receipt" updater_identity \
      'installed updater became absent or unsafe after durable acceptance'
    return 1
  fi
  if ! current_hash=$(installed_updater_hash); then
    terminalize_failed_operation "$receipt" updater_identity \
      'installed updater could not be hashed after durable acceptance'
    return 1
  fi
  if [[ "$current_hash" != "$expected_hash" ]]; then
    terminalize_failed_operation "$receipt" updater_identity \
      'installed updater changed after durable acceptance'
    return 1
  fi

  if [[ "$requested_action" = activate && "$release_mode" = active ]]; then
    if [[ ! "$activation_intent_id" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$ ]]; then
      terminalize_failed_operation "$receipt" activation_intent \
        'ACTIVATE has no durable activation intent identity' activation_intent_missing
      return 1
    fi
    if [[ ! "$activation_registry_commit_sha" =~ ^[0-9a-f]{40}$ ]]; then
      terminalize_failed_operation "$receipt" activation_intent \
        'ACTIVATE has no durable activation registry identity' activation_registry_missing
      return 1
    fi
    assert_activation_registry "$receipt" "$target" "$activation_intent_id" \
      "$activation_registry_commit_sha" || {
        terminalize_failed_operation "$receipt" activation_intent \
          'authoritative mobile activation intent or registry compatibility fence failed' \
          activation_intent_mismatch
        return 1
      }
    receipt_update "$receipt" activation_intent_verified __TRUE__ \
      activation_registry_commit_sha "$activation_registry_commit_sha"
  elif [[ "$requested_action" = activate ]]; then
    printf 'WARNING: web-only release mode is paused; deployment controller will not read the mobile registry.\n' >&2
    receipt_update "$receipt" activation_intent_id '' activation_registry_commit_sha ''
  fi

  set +e
  ASH_ATLAS_OPERATION_ID="$OPERATION_ID" \
    ASH_ATLAS_OPERATION_RECEIPT="$receipt" \
    ASH_ATLAS_OPERATION_STATUS_PUBLISHER="$0" \
    ASH_ATLAS_OPERATION_ROOT="$CONTROL_ROOT" \
    ASH_ATLAS_CONTROLLER_CONFIG="${CONTROLLER_CONFIG:-}" \
    ASH_ATLAS_DEPLOY_LOCK_HELD=true \
    ASH_ATLAS_DEPLOY_MODE="$requested_action" \
    ASH_ATLAS_RELEASE_MODE="$release_mode" \
    ASH_ATLAS_RELEASE_PATCH_NOTES_HEX="$(read_receipt_field "$receipt" release_patch_notes_hex none)" \
    ASH_ATLAS_EXPECTED_GENERATION="$requested_generation" \
    ASH_ATLAS_CANDIDATE_REF="$requested_candidate" \
    ASH_ATLAS_ACTIVATION_INTENT_ID="$activation_intent_id" \
    ASH_ATLAS_ACTIVATION_REGISTRY_COMMIT_SHA="$activation_registry_commit_sha" \
    "$UPDATER" "$target" >"$log" 2>&1 9>&-
  code=$?
  set -e
  if (( code != 0 )); then
    phase=$(read_receipt_field "$receipt" current_phase)
    message=$(sed -n 's/^STOP: //p' "$log" | tail -n 1 | tr -d '\r' | cut -c1-500)
    if [[ -z "$message" ]]; then
      message=$(tail -n 1 "$log" | tr -d '\r' | cut -c1-500)
    fi
    terminalize_failed_operation "$receipt" "${phase:-deployment}" \
      "${message:-updater exited with code $code}"
    return "$code"
  fi

  if [[ "$requested_action" = prepare ]]; then
    terminalize_prepared_operation "$receipt" || {
      terminalize_failed_operation "$receipt" prepare_receipt \
        'updater exited successfully without one durable PREPARED receipt'
      return 1
    }
  else
    game_path=$(readlink -e "$GAME_CURRENT" 2>/dev/null || true)
    public_path=$(readlink -e "$PUBLIC_CURRENT" 2>/dev/null || true)
    terminalize_completed_operation "$receipt" "${game_path##*/}" "${public_path##*/}"
  fi
}

status_operation() {
  validate_operation_id "$OPERATION_ID"
  provision_roots
  exec 8>"$CONTROL_LOCK"
  flock -w 4 8 || fail 'deployment controller is busy'
  reconcile_with_terminal_wait
  if [[ "$RECON_OPERATION_STATE" = readable ]]; then
    publish_status_required "$OPERATION_ID"
    emit_receipt "$RECON_RECEIPT" "$RECON_UNIT_STATE" "$RECON_CONTROLLER_STATE"
  else
    emit_operation_state "$RECON_OPERATION_STATE" "$RECON_UNIT_STATE" "$RECON_CONTROLLER_STATE"
  fi
  [[ "$RECON_CONTROLLER_STATE" = consistent ]] || return 4
}

reconcile_operation_command() {
  validate_operation_id "$OPERATION_ID"
  provision_roots
  exec 8>"$CONTROL_LOCK"
  flock -w 4 8 || fail 'deployment controller is busy'
  reconcile_with_terminal_wait
  local log game_release public_release
  log=$(log_path "$OPERATION_ID")
  game_release=${TARGET_SHA:+$GAME_RELEASE_ROOT/$TARGET_SHA}
  public_release=${TARGET_SHA:+$PUBLIC_RELEASE_ROOT/$TARGET_SHA}
  "$NODE_BIN" - "$OPERATION_ID" "$RECON_OPERATION_STATE" "$RECON_RESULT" \
    "$RECON_UNIT_STATE" "$RECON_CONTROLLER_STATE" "$RECON_MARKER" "$RECON_LOCK_STATE" \
    "$RECON_LOCK_CLASSIFICATION" "$RECON_LOCK_DIAGNOSTICS" \
    "$log" "$game_release" "$public_release" "${GAME_CURRENT}" "${PUBLIC_CURRENT}" <<'NODE'
const fs = require("node:fs");
const values = process.argv.slice(2);
const [operationId, operationState, result, unitState, controllerState, marker, lockState,
  lockClassification, lockDiagnostics, log, gameRelease, publicRelease, gameCurrent, publicCurrent] = values;
const present = (path) => path !== "" && fs.existsSync(path);
const resolved = (path) => {
  try { return fs.realpathSync(path); } catch { return ""; }
};
process.stdout.write(`${JSON.stringify({
  schema_version: 1,
  operation_id: operationId,
  operation_state: operationState,
  result,
  unit_state: unitState,
  controller_state: controllerState,
  active_marker: marker,
  deployment_lock: lockState,
  execution_lock_classification: lockClassification,
  execution_lock_diagnostics: JSON.parse(lockDiagnostics),
  log_present: present(log),
  target_game_release_present: present(gameRelease),
  target_public_release_present: present(publicRelease),
  active_game_path: resolved(gameCurrent),
  active_public_path: resolved(publicCurrent)
})}\n`);
NODE
  [[ "$RECON_CONTROLLER_STATE" = consistent ]] || return 4
}

resume_operation() {
  validate_operation_id "$OPERATION_ID"
  provision_roots
  exec 8>"$CONTROL_LOCK"
  flock -w 4 8 || fail 'deployment controller is busy'
  reconcile_with_terminal_wait
  [[ "$RECON_OPERATION_STATE" = readable ]] ||
    fail "operation cannot resume ($RECON_OPERATION_STATE)"
  [[ "$RECON_CONTROLLER_STATE" = consistent ]] ||
    fail 'operation cannot resume from ambiguous controller state'
  case "$RECON_RESULT" in
    prepared|completed|running)
      publish_status_required "$OPERATION_ID"
      emit_receipt "$RECON_RECEIPT" "$RECON_UNIT_STATE" consistent
      return
      ;;
    failed)
      local failed_phase failed_target
      failed_phase=$(read_receipt_field "$RECON_RECEIPT" failure_phase 2>/dev/null || true)
      failed_target=$(read_receipt_field "$RECON_RECEIPT" requested_target_sha 2>/dev/null || true)
      if [[ "$failed_phase" = lock_acquisition && "$failed_target" =~ ^[0-9a-f]{40}$ &&
            ( "$RECON_UNIT_STATE" = inactive || "$RECON_UNIT_STATE" = failed ) &&
            -z "$RECON_MARKER" ]]; then
        receipt_update "$RECON_RECEIPT" result accepted current_phase waiting_for_execution_lock \
          failure_phase '' failure_code '' failure_message '' finished_at_utc '' \
          recovered_from_legacy_lock_failure_at_utc "$(now_utc)"
        start_accepted_worker "$OPERATION_ID"
        emit_receipt "$RECON_RECEIPT" "$(unit_state "$OPERATION_ID")" consistent
        return
      fi
      if retry_failed_transaction "$RECON_RECEIPT"; then return; fi
      publish_status_required "$OPERATION_ID"
      emit_receipt "$RECON_RECEIPT" "$RECON_UNIT_STATE" consistent
      if [[ -e "$(migration_intent_path "$OPERATION_ID")" ||
            -L "$(migration_intent_path "$OPERATION_ID")" ]]; then
        return 3
      fi
      return
      ;;
    accepted)
      start_accepted_worker "$OPERATION_ID"
      emit_receipt "$RECON_RECEIPT" "$(unit_state "$OPERATION_ID")" consistent
      ;;
    *) fail "operation has unsupported resume result $RECON_RESULT" ;;
  esac
}

abandon_operation() {
  validate_operation_id "$OPERATION_ID"
  validate_sha "$TARGET_SHA"
  local reason=${EXPECTED_UPDATER_HASH:-never_submitted}
  [[ "$reason" =~ ^[a-z][a-z0-9_]{0,63}$ ]] || fail 'abandon reason is unsafe'
  provision_roots
  exec 8>"$CONTROL_LOCK"
  flock -w 4 8 || fail 'deployment controller is busy'
  reconcile_operation
  [[ "$RECON_OPERATION_STATE" = genuinely_unknown &&
        "$RECON_CONTROLLER_STATE" = consistent &&
        -z "$RECON_MARKER" && "$RECON_LOCK_STATE" = free &&
        "$RECON_UNIT_STATE" = inactive ]] ||
    fail 'operation is not conclusively absent and quiescent'
  [[ ! -e "$(log_path "$OPERATION_ID")" &&
        ! -e "$GAME_RELEASE_ROOT/$TARGET_SHA" &&
        ! -e "$PUBLIC_RELEASE_ROOT/$TARGET_SHA" ]] ||
    fail 'operation has worker, log, or release evidence and cannot be abandoned'
  [[ "$(remote_master_sha)" = "$TARGET_SHA" ]] ||
    fail 'origin/master does not equal the abandoned operation target'
  local receipt
  receipt=$(receipt_path "$OPERATION_ID")
  receipt_update "$receipt" \
    schema_version __NUMBER__1 operation_id "$OPERATION_ID" \
    requested_target_sha "$TARGET_SHA" updater_hash '' \
    accepted_at_utc '' started_at_utc '' current_phase submission \
    migration_result pending activation_result pending readiness_result pending \
    active_game_sha '' active_public_sha '' result failed \
    failure_phase submission failure_code "$reason" \
    failure_message 'deployment submission never reached the authoritative controller' \
    finished_at_utc "$(now_utc)"
  emit_receipt "$receipt" inactive consistent
}

reject_operation() {
  validate_operation_id "$OPERATION_ID"
  validate_sha "$TARGET_SHA"
  validate_hash "$EXPECTED_UPDATER_HASH"
  local rejection_code=${REQUEST_ARGUMENT:-request_rejected}
  [[ "$rejection_code" =~ ^[a-z][a-z0-9_]{0,63}$ ]] ||
    fail 'request rejection code is unsafe'
  local status_token extra_status_input receipt current_target current_hash
  IFS= read -r status_token || fail 'deployment status token was not supplied on standard input'
  if IFS= read -r extra_status_input; then
    : "$extra_status_input"
    fail 'deployment status token input contained more than one line'
  fi
  validate_status_token "$status_token"
  provision_roots
  exec 8>"$CONTROL_LOCK"
  flock -w 4 8 || fail 'deployment controller is busy'
  receipt=$(receipt_path "$OPERATION_ID")
  if [[ -f "$receipt" ]]; then
    current_target=$(read_receipt_field "$receipt" requested_target_sha)
    current_hash=$(read_receipt_field "$receipt" updater_hash)
    [[ "$current_target" = "$TARGET_SHA" && "$current_hash" = "$EXPECTED_UPDATER_HASH" ]] ||
      fail 'operation ID already belongs to different immutable inputs'
    ensure_status_token "$OPERATION_ID" "$status_token"
    publish_status_required "$OPERATION_ID"
    emit_receipt "$receipt" "$(unit_state "$OPERATION_ID")" consistent
    return
  fi
  ensure_status_token "$OPERATION_ID" "$status_token"
  receipt_update "$receipt" \
    schema_version __NUMBER__1 operation_id "$OPERATION_ID" \
    requested_target_sha "$TARGET_SHA" updater_hash "$EXPECTED_UPDATER_HASH" \
    accepted_at_utc '' started_at_utc '' current_phase request_validation \
    migration_result pending activation_result pending readiness_result pending \
    active_game_sha '' active_public_sha '' result failed \
    failure_phase request_validation failure_code "$rejection_code" \
    failure_message 'deployment request was permanently rejected before worker acceptance' \
    finished_at_utc "$(now_utc)"
  publish_status_required "$OPERATION_ID"
  emit_receipt "$receipt" inactive consistent
}

cleanup_operation() {
  validate_operation_id "$OPERATION_ID"
  provision_roots
  exec 8>"$CONTROL_LOCK"
  flock -w 4 8 || fail 'deployment controller is busy'
  reconcile_with_terminal_wait
  [[ "$RECON_OPERATION_STATE" = readable &&
        "$RECON_CONTROLLER_STATE" = consistent &&
        ( "$RECON_RESULT" = completed || "$RECON_RESULT" = failed ) ]] ||
    fail 'cleanup preserves every nonterminal or ambiguous operation'
  local removed migration_marker
  removed=$(removed_path "$OPERATION_ID")
  [[ ! -e "$removed" ]] || fail 'terminal removal record already exists'
  migration_marker=$(migration_intent_path "$OPERATION_ID")
  if [[ -e "$migration_marker" || -L "$migration_marker" ]]; then
    [[ "$RECON_RESULT" = completed ]] ||
      fail 'cleanup preserves an unresolved migration intent marker'
    [[ -f "$migration_marker" && ! -L "$migration_marker" ]] ||
      fail 'terminal operation has an unsafe migration intent marker'
    rm -f -- "$migration_marker" ||
      fail 'terminal migration intent marker could not be cleared'
  fi
  "$NODE_BIN" - "$RECON_RECEIPT" "$removed" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [receiptPath, removedPath] = process.argv.slice(2);
const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
if (!["completed", "failed"].includes(receipt.result)) throw new Error("receipt is nonterminal");
const record = {
  schema_version: 1,
  operation_id: receipt.operation_id,
  requested_target_sha: receipt.requested_target_sha,
  terminal_result: receipt.result,
  removed_at_utc: new Date().toISOString()
};
const temporary = `${removedPath}.${process.pid}.tmp`;
const file = fs.openSync(temporary, "wx", 0o640);
fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
fs.fsyncSync(file);
fs.closeSync(file);
fs.renameSync(temporary, removedPath);
let directory = fs.openSync(path.dirname(removedPath), "r");
try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
JSON.parse(fs.readFileSync(removedPath, "utf8"));
fs.rmSync(receiptPath);
directory = fs.openSync(path.dirname(receiptPath), "r");
try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
NODE
  emit_operation_state terminally_removed inactive consistent
}

result_operation() {
  validate_operation_id "$OPERATION_ID"
  provision_roots
  exec 8>"$CONTROL_LOCK"
  flock -w 4 8 || fail 'deployment controller is busy'
  reconcile_with_terminal_wait
  if [[ "$RECON_CONTROLLER_STATE" != consistent ]]; then
    if [[ -f "$RECON_RECEIPT" ]]; then
      emit_receipt "$RECON_RECEIPT" "$RECON_UNIT_STATE" ambiguous
    else
      emit_operation_state "$RECON_OPERATION_STATE" "$RECON_UNIT_STATE" ambiguous
    fi
    return 4
  fi
  local receipt result game_path public_path service_state main_pid readiness world_json
  local world_service_state game_requires_world probe_root readiness_path world_path
  local readiness_pid world_pid
  receipt=$RECON_RECEIPT
  [[ "$RECON_OPERATION_STATE" = readable ]] ||
    fail "operation receipt is unavailable ($RECON_OPERATION_STATE)"
  result=$RECON_RESULT
  [[ "$result" = completed || "$result" = failed ]] ||
    fail 'operation is not terminal'
  game_path=$(readlink -e "$GAME_CURRENT" 2>/dev/null || true)
  public_path=$(readlink -e "$PUBLIC_CURRENT" 2>/dev/null || true)
  service_state=$("$SYSTEMCTL" is-active ash-atlas.service 2>/dev/null || true)
  world_service_state=$("$SYSTEMCTL" is-active ash-atlas-world.service 2>/dev/null || true)
  main_pid=$("$SYSTEMCTL" show ash-atlas.service --property=MainPID --value 2>/dev/null || true)
  if "$SYSTEMCTL" show ash-atlas.service --property=Requires --value 2>/dev/null |
      tr ' ' '\n' | grep -qx ash-atlas-world.service; then
    game_requires_world=true
  else
    game_requires_world=false
  fi
  probe_root=$(mktemp -d /tmp/ash-atlas-result.XXXXXXXX)
  readiness_path="$probe_root/readiness"
  world_path="$probe_root/world.json"
  (
    if timeout 5 /usr/local/libexec/ash-atlas-wait-ready game >/dev/null 2>&1; then
      printf 'true'
    else
      printf 'false'
    fi
  ) > "$readiness_path" &
  readiness_pid=$!
  (
    if ! curl --fail --silent --show-error --max-time 5 \
        'http://127.0.0.1:8765/api/lookup?lat=35.0844&lon=-106.6504' > "$world_path" 2>/dev/null; then
      printf 'null' > "$world_path"
    fi
  ) &
  world_pid=$!
  wait "$readiness_pid"
  wait "$world_pid"
  readiness=$(<"$readiness_path")
  world_json=$(<"$world_path")
  rm -f "$readiness_path" "$world_path"
  rmdir "$probe_root"
  export ASH_ATLAS_RESULT_RECEIPT="$receipt"
  export ASH_ATLAS_RESULT_GAME_SHA="${game_path##*/}"
  export ASH_ATLAS_RESULT_PUBLIC_SHA="${public_path##*/}"
  export ASH_ATLAS_RESULT_SERVICE_STATE="$service_state"
  export ASH_ATLAS_RESULT_WORLD_SERVICE_STATE="$world_service_state"
  export ASH_ATLAS_RESULT_GAME_REQUIRES_WORLD="$game_requires_world"
  export ASH_ATLAS_RESULT_MAIN_PID="$main_pid"
  export ASH_ATLAS_RESULT_READINESS="$readiness"
  export ASH_ATLAS_RESULT_WORLD="$world_json"
  export ASH_ATLAS_RESULT_UNIT_STATE="$RECON_UNIT_STATE"
  "$NODE_BIN" <<'NODE'
const fs = require("node:fs");
const e = process.env;
const receipt = JSON.parse(fs.readFileSync(e.ASH_ATLAS_RESULT_RECEIPT, "utf8"));
receipt.controller_state = "consistent";
receipt.unit_state = e.ASH_ATLAS_RESULT_UNIT_STATE;
let world = null;
try { world = JSON.parse(e.ASH_ATLAS_RESULT_WORLD); } catch {}
process.stdout.write(`${JSON.stringify({
  receipt,
  verification: {
    game_sha: e.ASH_ATLAS_RESULT_GAME_SHA,
    public_sha: e.ASH_ATLAS_RESULT_PUBLIC_SHA,
    service_state: e.ASH_ATLAS_RESULT_SERVICE_STATE,
    world_service_state: e.ASH_ATLAS_RESULT_WORLD_SERVICE_STATE,
    game_requires_world: e.ASH_ATLAS_RESULT_GAME_REQUIRES_WORLD === "true",
    main_pid: Number(e.ASH_ATLAS_RESULT_MAIN_PID || 0),
    readiness: e.ASH_ATLAS_RESULT_READINESS === "true",
    world
  }
})}\n`);
NODE
}

finalize_operation() {
  validate_operation_id "$OPERATION_ID"
  provision_roots
  local receipt result phase
  receipt=$(receipt_path "$OPERATION_ID")
  [[ -f "$receipt" ]] || return 0
  exec 8>"$CONTROL_LOCK"
  flock -w 4 8 || return 1
  result=$(read_receipt_field "$receipt" result 2>/dev/null || true)
  if [[ "$result" != prepared && "$result" != completed && "$result" != failed ]]; then
    phase=$(read_receipt_field "$receipt" current_phase 2>/dev/null || true)
    if [[ "$result" = accepted ]]; then
      receipt_update "$receipt" result accepted current_phase waiting_for_execution_lock \
        last_waiting_worker_exit_at_utc "$(now_utc)"
    else
      receipt_update "$receipt" result failed current_phase "${phase:-systemd_finalize}" \
        failure_phase "${phase:-systemd_finalize}" \
        failure_code "${phase:-systemd_finalize}_failed" \
        failure_message 'systemd worker stopped before writing a terminal receipt' \
        finished_at_utc "$(now_utc)"
    fi
  fi
  clear_active_marker "$OPERATION_ID"
}

logs_operation() {
  validate_operation_id "$OPERATION_ID"
  local log
  log=$(log_path "$OPERATION_ID")
  [[ -f "$log" ]] || fail 'operation log is absent'
  cat "$log"
}

publish_operation() {
  validate_operation_id "$OPERATION_ID"
  provision_roots
  publish_status_for_operation "$OPERATION_ID" ||
    fail 'deployment HTTPS status could not be published'
}

reconcile_all_operations() {
  provision_roots
  local operation
  while IFS= read -r operation; do
    [[ -n "$operation" ]] || continue
    timeout 20 "$0" resume "$operation" >/dev/null ||
      printf 'WARNING: deployment reconciliation failed for %s\n' "$operation" >&2
  done < <("$NODE_BIN" - "$CONTROL_ROOT" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const root = process.argv[2];
const operations = [];
for (const name of fs.readdirSync(root)) {
  if (!name.endsWith(".json")) continue;
  try {
    const receipt = JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
    if (receipt.result === "accepted" || receipt.result === "running") {
      operations.push(receipt);
    }
  } catch {}
}
operations.sort((left, right) =>
  String(left.accepted_at_utc || "").localeCompare(String(right.accepted_at_utc || "")) ||
  String(left.operation_id).localeCompare(String(right.operation_id)));
for (const receipt of operations) process.stdout.write(`${receipt.operation_id}\n`);
NODE
)
}

if [[ ${ASH_ATLAS_DEPLOY_CONTROL_SOURCE_ONLY:-false} = true ]]; then
  return 0
fi

case "$ACTION" in
  start) start_operation ;;
  prepare) prepare_operation ;;
  activate) activate_operation ;;
  status) status_operation ;;
  reconcile) reconcile_operation_command ;;
  resume) resume_operation ;;
  abandon) abandon_operation ;;
  reject) reject_operation ;;
  cleanup) cleanup_operation ;;
  result) result_operation ;;
  publish) publish_operation ;;
  reconcile-all) reconcile_all_operations ;;
  identity) identity_operation ;;
  integrity) integrity_operation ;;
  integrity-handoff) integrity_handoff_operation ;;
  version) printf '%s\n' "$CONTROLLER_VERSION" ;;
  logs) logs_operation ;;
  run) run_operation ;;
  execute) execute_operation ;;
  finalize) finalize_operation ;;
  *) fail 'usage: deploy-control.sh start|prepare OPERATION_ID TARGET_SHA EXPECTED_UPDATER_HASH [test/tNNN[N]] [active|paused] < STATUS_TOKEN | activate OPERATION_ID TARGET_SHA EXPECTED_UPDATER_HASH test/tNNN[N] [ACTIVATION_INTENT_ID ACTIVATION_REGISTRY_COMMIT_SHA] | reject OPERATION_ID TARGET_SHA EXPECTED_UPDATER_HASH [REJECTION_CODE] < STATUS_TOKEN | status|resume|result|reconcile OPERATION_ID [TARGET_SHA] | reconcile-all | identity | integrity | integrity-handoff TARGET_SHA | version | abandon OPERATION_ID TARGET_SHA REASON | cleanup|logs|run|execute OPERATION_ID' ;;
esac
