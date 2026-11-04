#!/usr/bin/env bash
set -euo pipefail

readonly TEST_ROOT=$(mktemp -d /tmp/ash-atlas-web-only-release.XXXXXXXX)
cleanup() {
  rm -rf --one-file-system "$TEST_ROOT"
}
trap cleanup EXIT

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

readonly SCRIPT_ROOT=$(cd "$(dirname "$0")/.." && pwd)
readonly COORDINATOR="$SCRIPT_ROOT/accept-and-publish-test-server.ps1"
readonly CONTROLLER="$SCRIPT_ROOT/vps/deploy-control.sh"
readonly UPDATER="$SCRIPT_ROOT/vps/deploy-test-update.sh"
readonly MODE_FILE="$SCRIPT_ROOT/../../config/release-mode.json"

assert 'release mode is exactly the paused web-only configuration' \
  test "$(tr -d '\r\n' < "$MODE_FILE")" = '{"mobile":"paused"}'
assert 'the coordinator has one canonical mobile gate phase' \
  test "$(grep -F 'Invoke-Phase $State' "$COORDINATOR" | \
    grep -F 'mobile_backward_compatibility_gate' | wc -l)" -eq 1
assert 'the coordinator routes mobile gate calls through the paused-mode helper' \
  grep -Fq 'Invoke-MobileBackwardCompatibilityGate' "$COORDINATOR"
assert 'the coordinator does not directly run the deployment mobile gate' \
  test "$(grep -F 'Assert-MobileBackwardCompatibility $mobileCandidateRoot' "$COORDINATOR" | wc -l)" -eq 0
assert 'activation intent is guarded by paused mode' \
  grep -Fq -- '-not (Test-MobileReleasePaused $State)' "$COORDINATOR"
assert 'coordinated releases fail closed while mobile mode is paused' \
  grep -Fq 'coordinated and mobile releases are paused in web-only release mode' "$COORDINATOR"
assert 'the controller persists the release mode from PREPARE' \
  grep -Fq 'PREPARE_RELEASE_MODE' "$CONTROLLER"
assert 'the controller exports the durable release mode to the updater' \
  grep -Fq 'ASH_ATLAS_RELEASE_MODE="$release_mode"' "$CONTROLLER"
assert 'the updater skips its registry fence before reading mobile state' \
  grep -Fq 'if [[ "$RELEASE_MODE" = paused ]]' "$UPDATER"
assert 'asset carry-forward is bounded to three public releases' \
  grep -Fq 'source_shas+=("$name")' "$UPDATER"
assert 'release pruning remains bounded to one inactive release' \
  grep -Fq 'readonly INACTIVE_RELEASE_RETENTION=1' "$UPDATER"

export ASH_ATLAS_DEPLOY_MODE=activate
export ASH_ATLAS_DEPLOY_UPDATE_SOURCE_ONLY=true
if [[ -z ${ASH_ATLAS_NODE_BIN:-} ]]; then
  ASH_ATLAS_NODE_BIN=$(command -v node || command -v node.exe || true)
fi
if [[ -z ${ASH_ATLAS_NODE_BIN:-} || ! -x ${ASH_ATLAS_NODE_BIN:-} ||
      ${ASH_ATLAS_NODE_BIN##*.} = exe ]]; then
  ASH_ATLAS_NODE_BIN="$TEST_ROOT/node-stub"
  cat > "$ASH_ATLAS_NODE_BIN" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
script=$(cat)
if [[ "$script" = *'config.mobile'* ]]; then
  /usr/bin/jq -r '.mobile // empty' "$2"
elif [[ "$script" = *'client asset manifest is invalid'* ]]; then
  /usr/bin/jq -r '.assets[]? | [.path, .retention] | @tsv' "$2"
else
  exit 1
fi
STUB
  chmod +x "$ASH_ATLAS_NODE_BIN"
fi
export ASH_ATLAS_NODE_BIN
export ASH_ATLAS_CLIENT_RELEASE_ROOT="$TEST_ROOT/public/releases"
export ASH_ATLAS_CLIENT_CURRENT_LINK="$TEST_ROOT/public/current"
export ASH_ATLAS_OPERATION_ROOT="$TEST_ROOT/operations"
export ASH_ATLAS_DEPLOY_LOCK_FILE="$TEST_ROOT/deploy.lock"
export ASH_ATLAS_DEPLOY_LOCK_HELD=true
mkdir -p "$ASH_ATLAS_CLIENT_RELEASE_ROOT" "$ASH_ATLAS_OPERATION_ROOT"
exec 9>"$ASH_ATLAS_DEPLOY_LOCK_FILE"
flock 9

# shellcheck source=deploy-test-update.sh
source "$UPDATER"
unset ASH_ATLAS_DEPLOY_UPDATE_SOURCE_ONLY

if [[ "$ASH_ATLAS_NODE_BIN" != "$TEST_ROOT/node-stub" ]]; then
  : > "$TEST_ROOT/native.env"
  native_policy=$(effective_native_configuration "$TEST_ROOT/native.env" "$SCRIPT_ROOT/../..")
  assert 'the web-only candidate can derive its native identity from the shared protocol policy' \
    test -n "$native_policy"
fi

candidate_root="$TEST_ROOT/candidate"
mkdir -p "$candidate_root/config"
printf '%s\n' '{"mobile":"paused"}' > "$candidate_root/config/release-mode.json"
RELEASE_MODE=
warning_file="$TEST_ROOT/release-mode-warning.log"
if ! resolve_release_mode "$candidate_root" 2>"$warning_file"; then
  cat "$warning_file" >&2
  exit 1
fi
assert 'the exact candidate release config selects paused mode' test "$RELEASE_MODE" = paused
assert 'paused mode emits an explicit warning' grep -Fq 'mobile registry will not be read' "$warning_file"

RELEASE_MODE=
resolve_release_mode "$TEST_ROOT/no-config-candidate"
assert 'missing release mode config preserves the active default' test "$RELEASE_MODE" = active

RELEASE_MODE=paused
unset MOBILE_REGISTRY_PATH
verify_activation_registry_fence
assert 'paused activation returns before a mobile registry read' test -z "${MOBILE_REGISTRY_PATH:-}"

current=1111111111111111111111111111111111111111
previous_one=2222222222222222222222222222222222222222
previous_two=3333333333333333333333333333333333333333
previous_three=4444444444444444444444444444444444444444
make_public_release() {
  local sha=$1 timestamp=$2 asset=$3 manifest=${4:-manifest}
  install -d "$ASH_ATLAS_CLIENT_RELEASE_ROOT/$sha/assets"
  printf '%s\n' "$asset" > "$ASH_ATLAS_CLIENT_RELEASE_ROOT/$sha/assets/$asset.js"
  if [[ "$manifest" = manifest ]]; then
    printf '%s\n' carried-forward > "$ASH_ATLAS_CLIENT_RELEASE_ROOT/$sha/assets/carried-forward-ABCDEFGH.js"
    printf '{"schema_version":1,"assets":[{"path":"assets/%s.js","retention":3}]}\n' "$asset" \
      > "$ASH_ATLAS_CLIENT_RELEASE_ROOT/$sha/.ash-atlas-client-assets.json"
    printf 'stale-$sha\n' > "$ASH_ATLAS_CLIENT_RELEASE_ROOT/$sha/index.html"
  else
    printf '%s\n' historical-unreferenced > \
      "$ASH_ATLAS_CLIENT_RELEASE_ROOT/$sha/assets/historical-unreferenced-IJKLMNOP.js"
    printf '<script type="module" src="/play/assets/%s.js"></script>\n' "$asset" > \
      "$ASH_ATLAS_CLIENT_RELEASE_ROOT/$sha/index.html"
  fi
  touch -d "@$timestamp" "$ASH_ATLAS_CLIENT_RELEASE_ROOT/$sha"
}
make_public_release "$current" 1000 'web-current-ABCDEFGH'
make_public_release "$previous_one" 900 'web-previous-one-IJKLMNOP'
make_public_release "$previous_two" 800 'web-previous-two-QRSTUVWX' no-manifest
make_public_release "$previous_three" 700 'web-previous-three-YZabcdef'
ln -s "$ASH_ATLAS_CLIENT_RELEASE_ROOT/$current" "$ASH_ATLAS_CLIENT_CURRENT_LINK"

mkdir -p "$candidate_root/apps/client/dist/assets"
printf 'candidate\n' > "$candidate_root/apps/client/dist/assets/web-candidate-ZZZZZZZZ.js"
printf 'candidate-unreferenced\n' > \
  "$candidate_root/apps/client/dist/assets/web-candidate-unreferenced-ABCDEFGH.js"
printf '<script type="module" src="/play/assets/web-candidate-ZZZZZZZZ.js"></script>\n' > \
  "$candidate_root/apps/client/dist/index.html"
seed_client_asset_retention_from_destination "$candidate_root/apps/client/dist"
copy_previous_hashed_client_assets "$candidate_root/apps/client/dist" >/dev/null
write_client_asset_manifest "$candidate_root/apps/client/dist"
prune_client_assets_to_manifest "$candidate_root/apps/client/dist"
assert 'the candidate build asset remains present' \
  test -f "$candidate_root/apps/client/dist/assets/web-candidate-ZZZZZZZZ.js"
assert 'an unreferenced candidate hash remains present' \
  test -f "$candidate_root/apps/client/dist/assets/web-candidate-unreferenced-ABCDEFGH.js"
assert 'the active previous release asset is carried forward' \
  test -f "$candidate_root/apps/client/dist/assets/web-current-ABCDEFGH.js"
assert 'the second previous release asset is carried forward' \
  test -f "$candidate_root/apps/client/dist/assets/web-previous-one-IJKLMNOP.js"
assert 'the third previous release asset is carried forward' \
  test -f "$candidate_root/apps/client/dist/assets/web-previous-two-QRSTUVWX.js"
assert 'an unreferenced historical hash remains present' \
  test -f "$candidate_root/apps/client/dist/assets/historical-unreferenced-IJKLMNOP.js"
assert 'assets older than the previous three releases are not copied' \
  test ! -e "$candidate_root/apps/client/dist/assets/web-previous-three-YZabcdef.js"
assert 'unlisted carried assets from a retained release are not copied' \
  test ! -e "$candidate_root/apps/client/dist/assets/carried-forward-ABCDEFGH.js"
assert 'previous app HTML is never copied into the candidate' \
  grep -Fq 'web-candidate-ZZZZZZZZ.js' "$candidate_root/apps/client/dist/index.html"

server_one=5555555555555555555555555555555555555555
server_two=6666666666666666666666666666666666666666
server_three=7777777777777777777777777777777777777777
server_only_switch() {
  local previous_sha=$1 next_sha=$2 timestamp=$3
  local destination="$TEST_ROOT/server-only-$next_sha"
  mkdir -p "$destination"
  cp -a "$ASH_ATLAS_CLIENT_RELEASE_ROOT/$previous_sha/." "$destination/"
  CLIENT_SOURCE=previous_release
  CLIENT_ASSET_RETENTION=()
  copy_previous_hashed_client_assets "$destination" >/dev/null
  write_client_asset_manifest "$destination"
  prune_client_assets_to_manifest "$destination"
  install -d "$ASH_ATLAS_CLIENT_RELEASE_ROOT/$next_sha"
  cp -a "$destination/." "$ASH_ATLAS_CLIENT_RELEASE_ROOT/$next_sha/"
  touch -d "@$timestamp" "$ASH_ATLAS_CLIENT_RELEASE_ROOT/$next_sha"
  ln -sfn "$ASH_ATLAS_CLIENT_RELEASE_ROOT/$next_sha" "$ASH_ATLAS_CLIENT_CURRENT_LINK"
}
server_only_switch "$current" "$server_one" 2000
server_only_switch "$server_one" "$server_two" 2100
server_only_switch "$server_two" "$server_three" 2200
assert 'unchanged client hash survives repeated server-only switches' \
  test -f "$ASH_ATLAS_CLIENT_RELEASE_ROOT/$server_three/assets/web-current-ABCDEFGH.js"
assert 'server-only reuse preserves the current asset retention' \
  grep -Fq '{"path":"assets/web-current-ABCDEFGH.js","retention":3}' \
    "$ASH_ATLAS_CLIENT_RELEASE_ROOT/$server_three/.ash-atlas-client-assets.json"

new_client_root="$TEST_ROOT/new-client"
mkdir -p "$new_client_root/assets"
printf 'new-client\n' > "$new_client_root/assets/web-new-client-MNOPQRST.js"
CLIENT_SOURCE=build
CLIENT_ASSET_RETENTION=()
seed_client_asset_retention_from_destination "$new_client_root"
copy_previous_hashed_client_assets "$new_client_root" >/dev/null
write_client_asset_manifest "$new_client_root"
prune_client_assets_to_manifest "$new_client_root"
assert 'a new client build keeps its own hashed asset' \
  test -f "$new_client_root/assets/web-new-client-MNOPQRST.js"
assert 'a new client build retains the current prior asset' \
  test -f "$new_client_root/assets/web-current-ABCDEFGH.js"
assert 'a new client build drops hashes outside the bounded window' \
  test ! -e "$new_client_root/assets/historical-unreferenced-IJKLMNOP.js"

collision_root="$TEST_ROOT/collision"
mkdir -p "$collision_root/assets"
printf 'different-bytes\n' > "$collision_root/assets/web-current-ABCDEFGH.js"
if (CLIENT_ASSET_RETENTION=(); copy_previous_hashed_client_assets "$collision_root" >/dev/null 2>&1); then
  printf 'ASSERTION FAILED: same-name hashed asset collisions must fail\n' >&2
  exit 1
fi
passed=$((passed + 1))

printf 'web-only-release.tests.sh: %s assertions passed\n' "$passed"
