#!/usr/bin/env bash
set -euo pipefail

readonly REQUEST_REF=${ASH_ATLAS_DEPLOY_REQUEST_REF:-refs/heads/integration/deployment-requests}
readonly REQUEST_FILE=deployment-request.json
readonly CONTROLLER_VERSION=7
readonly NODE_BIN=${ASH_ATLAS_NODE_BIN:-$(command -v node 2>/dev/null || printf /usr/bin/node)}

if [[ ${ASH_ATLAS_DEPLOY_REQUEST_TEST_MODE:-false} = true ]]; then
  MIRROR_ROOT=${ASH_ATLAS_MIRROR_ROOT:?}
  CONTROLLER=${ASH_ATLAS_DEPLOY_CONTROLLER:?}
  UPDATER=${ASH_ATLAS_UPDATER:?}
  POLLER_LOCK=${ASH_ATLAS_DEPLOY_REQUEST_LOCK:?}
  REQUEST_STATE_ROOT=${ASH_ATLAS_DEPLOY_REQUEST_STATE_ROOT:?}
  GIT_PREFIX=()
else
  readonly CONTROLLER_CONFIG=${ASH_ATLAS_CONTROLLER_CONFIG:-/etc/ash-atlas/deployment-controller.conf}
  [[ -f "$CONTROLLER_CONFIG" && ! -L "$CONTROLLER_CONFIG" ]] ||
    { printf 'STOP: canonical deployment controller configuration is absent or unsafe\n' >&2; exit 1; }
  # shellcheck disable=SC1090,SC1091
  source "$CONTROLLER_CONFIG"
  readonly MIRROR_ROOT=${ASH_ATLAS_MIRROR_ROOT:?}
  readonly CONTROLLER=${ASH_ATLAS_CONTROLLER:?}
  readonly UPDATER=${ASH_ATLAS_UPDATER:?}
  readonly POLLER_LOCK=${ASH_ATLAS_DEPLOY_REQUEST_LOCK:?}
  readonly REQUEST_STATE_ROOT=${ASH_ATLAS_DEPLOY_REQUEST_STATE_ROOT:?}
  GIT_PREFIX=(sudo -u debian env HOME=/home/debian)
fi

fail() {
  printf 'STOP: %s\n' "$*" >&2
  exit 1
}

git_mirror() {
  "${GIT_PREFIX[@]}" timeout 20 git --git-dir="$MIRROR_ROOT" "$@"
}

reject_request() {
  local code=$1
  printf '%s\n' "$status_token" |
    "$CONTROLLER" reject "$operation_id" "$target_sha" "$updater_hash" "$code" >/dev/null
  fail "deployment request was permanently rejected: $code"
}

persist_request_commit() {
  local target=$REQUEST_STATE_ROOT/last-request-commit
  "$NODE_BIN" - "$target" "$request_commit" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [target, commit] = process.argv.slice(2);
const temporary = `${target}.${process.pid}.tmp`;
const file = fs.openSync(temporary, "wx", 0o600);
try {
  fs.writeFileSync(file, `${commit}\n`);
  fs.fsyncSync(file);
} finally {
  fs.closeSync(file);
}
fs.chmodSync(temporary, 0o600);
fs.renameSync(temporary, target);
const directory = fs.openSync(path.dirname(target), "r");
try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
if (fs.readFileSync(target, "utf8") !== `${commit}\n`) {
  throw new Error("persisted request commit validation failed");
}
NODE
}

[[ -d "$MIRROR_ROOT" && ! -L "$MIRROR_ROOT" ]] || fail 'deployment mirror is absent or unsafe'
[[ -f "$CONTROLLER" && ! -L "$CONTROLLER" ]] || fail 'deployment controller is absent or unsafe'
[[ -f "$UPDATER" && ! -L "$UPDATER" ]] || fail 'deployment updater is absent or unsafe'
install -d -m 0755 "$(dirname "$POLLER_LOCK")"
install -d -m 0700 "$REQUEST_STATE_ROOT"
exec 8>"$POLLER_LOCK"
flock -n 8 || exit 0

git_mirror fetch --no-tags origin "+$REQUEST_REF:$REQUEST_REF" >/dev/null ||
  fail 'deployment request ref could not be fetched'
request_commit=$(git_mirror rev-parse "$REQUEST_REF^{commit}") ||
  fail 'deployment request ref does not resolve to a commit'
last_request_file=$REQUEST_STATE_ROOT/last-request-commit
if [[ -e "$last_request_file" || -L "$last_request_file" ]]; then
  [[ -f "$last_request_file" && ! -L "$last_request_file" &&
      $(stat -c %a "$last_request_file") = 600 ]] ||
    fail 'persisted deployment request identity is unsafe'
  last_request_commit=$(<"$last_request_file")
  [[ "$last_request_commit" =~ ^[0-9a-f]{40}$ ]] ||
    fail 'persisted deployment request identity is invalid'
  git_mirror merge-base --is-ancestor "$last_request_commit" "$request_commit" ||
    fail 'deployment request ref was rewritten or moved non-fast-forward'
fi
manifest=$(git_mirror show "$request_commit:$REQUEST_FILE") ||
  fail 'deployment request manifest is absent'

fields=$(ASH_ATLAS_REQUEST_MANIFEST="$manifest" "$NODE_BIN" - "$request_commit" <<'NODE'
const requestCommit = process.argv[2];
const value = JSON.parse(process.env.ASH_ATLAS_REQUEST_MANIFEST);
const exact = (name, pattern) => {
  if (typeof value[name] !== "string" || !pattern.test(value[name])) {
    throw new Error(`invalid ${name}`);
  }
  return value[name];
};
if (value.schema_version !== 1) throw new Error("unsupported schema_version");
if (value.controller_version !== 7) throw new Error("unsupported controller_version");
if (value.request_commit && value.request_commit !== requestCommit) {
  throw new Error("request_commit mismatch");
}
const timestamp = exact("requested_at_utc", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/);
if (!Number.isFinite(Date.parse(timestamp))) throw new Error("invalid requested_at_utc");
process.stdout.write([
  exact("operation_id", /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/),
  exact("target_sha", /^[0-9a-f]{40}$/),
  exact("test_tag", /^test\/t\d{3,4}$/),
  exact("updater_sha256", /^[0-9a-f]{64}$/),
  exact("controller_sha256", /^[0-9a-f]{64}$/),
  exact("status_token", /^[0-9a-f]{64}$/),
  timestamp,
  value.release_patch_notes_hex === undefined ? "none" :
    exact("release_patch_notes_hex", /^(?:none|(?:[0-9a-f]{2}){1,64000})$/)
].join("\t"));
NODE
) || fail 'deployment request manifest failed schema validation'
IFS=$'\t' read -r operation_id target_sha test_tag updater_hash controller_hash status_token requested_at release_patch_notes_hex <<<"$fields"
: "$requested_at"

git_mirror fetch --no-tags origin \
  "+refs/heads/master:refs/heads/master" \
  "+refs/tags/$test_tag:refs/tags/$test_tag" >/dev/null ||
  fail 'deployment target refs could not be fetched'
master_sha=$(git_mirror rev-parse refs/heads/master^{commit})
tag_sha=$(git_mirror rev-list -n 1 "refs/tags/$test_tag")
[[ "$master_sha" = "$target_sha" && "$tag_sha" = "$target_sha" ]] ||
  fail 'master and immutable test tag do not yet equal the requested target'

installed_updater_hash=$(sha256sum "$UPDATER" | cut -d' ' -f1)
installed_controller_hash=$(sha256sum "$CONTROLLER" | cut -d' ' -f1)
[[ "$installed_updater_hash" = "$updater_hash" ]] ||
  reject_request updater_hash_mismatch
[[ "$installed_controller_hash" = "$controller_hash" ]] ||
  reject_request controller_hash_mismatch
[[ "$("$CONTROLLER" version)" = "$CONTROLLER_VERSION" ]] ||
  reject_request controller_version_mismatch

printf '%s\n' "$status_token" |
  "$CONTROLLER" start "$operation_id" "$target_sha" "$updater_hash" "" "" "" "$release_patch_notes_hex"
persist_request_commit
