#!/usr/bin/env bash
set -euo pipefail

NODE_BIN=${ASH_ATLAS_NODE_BIN:-$(command -v node)}
TEST_ROOT=$(mktemp -d /tmp/ash-atlas-deployment-request-tests.XXXXXXXX)
cleanup() {
  rm -rf --one-file-system "$TEST_ROOT"
}
trap cleanup EXIT

POLLER=$(cd "$(dirname "$0")" && pwd)/poll-deployment-request.sh
TARGET=1111111111111111111111111111111111111111
TOKEN=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
OPERATION=fault-request
mkdir -p "$TEST_ROOT/bin" "$TEST_ROOT/state"

cat > "$TEST_ROOT/updater" <<'SH'
#!/usr/bin/env bash
exit 0
SH
chmod 0755 "$TEST_ROOT/updater"

cat > "$TEST_ROOT/controller" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
action=$1
if [[ "$action" = version ]]; then
  printf '7\n'
  exit
fi
operation=$2
target=$3
updater_hash=$4
IFS= read -r token
exec 8>"$ASH_ATLAS_FIXTURE_LOCK"
flock 8
if [[ ! -f "$ASH_ATLAS_FIXTURE_RECEIPT" ]]; then
  printf '%s\t%s\t%s\t%s\n' "$operation" "$target" "$updater_hash" "$token" \
    > "$ASH_ATLAS_FIXTURE_RECEIPT"
  printf '1\n' >> "$ASH_ATLAS_FIXTURE_WORKER_COUNT"
  printf '1\n' >> "$ASH_ATLAS_FIXTURE_UPDATER_COUNT"
else
  IFS=$'\t' read -r old_operation old_target old_hash old_token < "$ASH_ATLAS_FIXTURE_RECEIPT"
  [[ "$operation" = "$old_operation" && "$target" = "$old_target" &&
     "$updater_hash" = "$old_hash" && "$token" = "$old_token" ]] ||
    { printf 'STOP: immutable tuple mismatch\n' >&2; exit 1; }
fi
flock -u 8
if [[ ${ASH_ATLAS_FIXTURE_LOSE_RESPONSE:-false} = true ]]; then
  sleep 5
fi
printf '{"schema_version":1,"operation_id":"%s","requested_target_sha":"%s","result":"accepted"}\n' \
  "$operation" "$target"
SH
chmod 0755 "$TEST_ROOT/controller"

updater_hash=$(sha256sum "$TEST_ROOT/updater" | cut -d' ' -f1)
controller_hash=$(sha256sum "$TEST_ROOT/controller" | cut -d' ' -f1)

git init --bare -q "$TEST_ROOT/origin.git"
git init -q "$TEST_ROOT/source"
git -C "$TEST_ROOT/source" config user.name fixture
git -C "$TEST_ROOT/source" config user.email fixture@example.invalid
printf 'target\n' > "$TEST_ROOT/source/target.txt"
git -C "$TEST_ROOT/source" add target.txt
git -C "$TEST_ROOT/source" commit -qm target
target_commit=$(git -C "$TEST_ROOT/source" rev-parse HEAD)
git -C "$TEST_ROOT/source" branch -M master
git -C "$TEST_ROOT/source" remote add origin "$TEST_ROOT/origin.git"
git -C "$TEST_ROOT/source" push -q origin master
git -C "$TEST_ROOT/source" tag test/t1000
git -C "$TEST_ROOT/source" push -q origin refs/tags/test/t1000

cat > "$TEST_ROOT/source/deployment-request.json" <<JSON
{"schema_version":1,"operation_id":"$OPERATION","target_sha":"$target_commit","test_tag":"test/t1000","updater_sha256":"$updater_hash","controller_version":7,"controller_sha256":"$controller_hash","status_token":"$TOKEN","requested_at_utc":"2026-07-27T00:00:00Z"}
JSON
git -C "$TEST_ROOT/source" add deployment-request.json
git -C "$TEST_ROOT/source" commit -qm request
git -C "$TEST_ROOT/source" push -q origin HEAD:refs/heads/integration/deployment-requests
git clone --mirror -q "$TEST_ROOT/origin.git" "$TEST_ROOT/mirror.git"

export ASH_ATLAS_NODE_BIN="$NODE_BIN"
export ASH_ATLAS_DEPLOY_REQUEST_TEST_MODE=true
export ASH_ATLAS_MIRROR_ROOT="$TEST_ROOT/mirror.git"
export ASH_ATLAS_DEPLOY_CONTROLLER="$TEST_ROOT/controller"
export ASH_ATLAS_UPDATER="$TEST_ROOT/updater"
export ASH_ATLAS_DEPLOY_REQUEST_LOCK="$TEST_ROOT/state/poller.lock"
export ASH_ATLAS_DEPLOY_REQUEST_STATE_ROOT="$TEST_ROOT/request-state"
export ASH_ATLAS_FIXTURE_LOCK="$TEST_ROOT/state/controller.lock"
export ASH_ATLAS_FIXTURE_RECEIPT="$TEST_ROOT/state/receipt"
export ASH_ATLAS_FIXTURE_WORKER_COUNT="$TEST_ROOT/state/workers"
export ASH_ATLAS_FIXTURE_UPDATER_COUNT="$TEST_ROOT/state/updaters"
touch "$ASH_ATLAS_FIXTURE_WORKER_COUNT" "$ASH_ATLAS_FIXTURE_UPDATER_COUNT"

assert() {
  local message=$1
  shift
  "$@" || {
    printf 'ASSERTION FAILED: %s\n' "$message" >&2
    exit 1
  }
}

git --git-dir="$TEST_ROOT/mirror.git" remote set-url origin "$TEST_ROOT/unreachable.git"
assert 'GitHub connectivity interruption cannot create an operation' \
  bash -c '! "$1" >/dev/null 2>&1 && [[ ! -e "$2" ]]' \
    bash "$POLLER" "$ASH_ATLAS_FIXTURE_RECEIPT"
git --git-dir="$TEST_ROOT/mirror.git" remote set-url origin "$TEST_ROOT/origin.git"

ASH_ATLAS_FIXTURE_LOSE_RESPONSE=true "$POLLER" >/dev/null 2>&1 &
lost_response_pid=$!
for _ in $(seq 1 50); do
  [[ -f "$ASH_ATLAS_FIXTURE_RECEIPT" ]] && break
  sleep 0.1
done
kill "$lost_response_pid" 2>/dev/null || true
set +e
wait "$lost_response_pid"
lost_response_code=$?
set -e
assert 'client disconnect after controller acceptance loses only the response' \
  bash -c '[[ "$1" -ne 0 && -f "$2" ]]' bash "$lost_response_code" "$ASH_ATLAS_FIXTURE_RECEIPT"

for _ in $(seq 1 25); do
  "$POLLER" >/dev/null
done
assert 'twenty-five transport replays retain one authoritative operation' \
  test "$(wc -l < "$ASH_ATLAS_FIXTURE_RECEIPT")" -eq 1
assert 'twenty-five transport replays start one worker' \
  test "$(wc -l < "$ASH_ATLAS_FIXTURE_WORKER_COUNT")" -eq 1
assert 'twenty-five transport replays execute one updater' \
  test "$(wc -l < "$ASH_ATLAS_FIXTURE_UPDATER_COUNT")" -eq 1
assert 'the persisted immutable tuple survives every watcher restart' \
  grep -q "^$OPERATION"$'\t'"$target_commit"$'\t'"$updater_hash"$'\t'"$TOKEN$" \
    "$ASH_ATLAS_FIXTURE_RECEIPT"
assert 'the watcher persists the exact monotonic request commit' \
  test "$(<"$ASH_ATLAS_DEPLOY_REQUEST_STATE_ROOT/last-request-commit")" = \
    "$(git --git-dir="$TEST_ROOT/mirror.git" rev-parse refs/heads/integration/deployment-requests)"
rewrite_commit=$(printf 'rewrite\n' |
  git -C "$TEST_ROOT/source" commit-tree "$(git -C "$TEST_ROOT/source" write-tree)")
git -C "$TEST_ROOT/source" push -q --force origin \
  "$rewrite_commit:refs/heads/integration/deployment-requests"
assert 'VPS monotonic state rejects a non-fast-forward request-ref rewrite' \
  bash -c '! "$1" >/dev/null 2>&1 &&
           [[ $(wc -l < "$2") -eq 1 && $(wc -l < "$3") -eq 1 ]]' \
    bash "$POLLER" "$ASH_ATLAS_FIXTURE_WORKER_COUNT" "$ASH_ATLAS_FIXTURE_UPDATER_COUNT"

printf 'deployment-request.tests.sh: 9 assertions passed (25 replay iterations).\n'
