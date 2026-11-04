#!/usr/bin/env bash
set -euo pipefail

[[ ${EUID} -eq 0 ]] || {
  printf 'deploy-cache.tests.sh must run as root\n' >&2
  exit 1
}
for identity in debian ash-atlas nobody; do
  getent passwd "$identity" >/dev/null 2>&1 || getent group "$identity" >/dev/null 2>&1 || {
    printf 'required test identity is absent: %s\n' "$identity" >&2
    exit 1
  }
done

readonly TEST_ROOT=$(mktemp -d /tmp/ash-atlas-cache-tests.XXXXXXXX)
cleanup() {
  rm -rf --one-file-system "$TEST_ROOT"
}
trap cleanup EXIT
chmod 0755 "$TEST_ROOT"

export ASH_ATLAS_CACHE_ROOT="$TEST_ROOT/cache"
export ASH_ATLAS_MIRROR_ROOT="$TEST_ROOT/mirror.git"
export ASH_ATLAS_WORKTREE_ROOT="$TEST_ROOT/worktrees"
export ASH_ATLAS_OPERATION_ROOT="$TEST_ROOT/operations"
export ASH_ATLAS_CACHE_TEST_SOURCE_ONLY=true
# shellcheck source=deploy-test-update.sh
source "$(dirname "$0")/deploy-test-update.sh"
unset ASH_ATLAS_CACHE_TEST_SOURCE_ONLY

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

provision_is_refused() {
  ! ( provision_cache_directories ) >/dev/null 2>&1
}

artifact_restore_is_refused() {
  ! ( restore_artifact "$1" "$2" ) >/dev/null 2>&1
}

dependency_restore_is_refused() {
  ! ( restore_dependencies "$1" ) >/dev/null 2>&1
}

mount_fixture="$TEST_ROOT/mount-fixture"
mkdir "$mount_fixture"
mount_fixture_is_reported() (
  findmnt() { printf '/\n%s\n' "$mount_fixture"; }
  worktree_has_mounts "$mount_fixture"
)
ordinary_directory_has_no_mount() {
  ! worktree_has_mounts "$mount_fixture"
}
assert 'a worktree mountpoint is detected before recursive cleanup' mount_fixture_is_reported
assert 'an ordinary worktree directory remains eligible for cleanup' ordinary_directory_has_no_mount

repository="$TEST_ROOT/repository"
install -d -o debian -g debian -m 0755 "$repository" "$MIRROR_ROOT" "$WORKTREE_ROOT" "$OPERATION_ROOT"
sudo -u debian git -C "$repository" init -b master >/dev/null
sudo -u debian git -C "$repository" config user.email deploy-cache-tests@example.invalid
sudo -u debian git -C "$repository" config user.name DeployCacheTests
sudo -u debian bash -c 'printf fixture > "$1/fixture.txt"' bash "$repository"
sudo -u debian git -C "$repository" add fixture.txt
sudo -u debian git -C "$repository" commit -m fixture >/dev/null
sudo -u debian git clone --mirror "$repository" "$MIRROR_ROOT" >/dev/null

stale_worktree="$WORKTREE_ROOT/ash-atlas-aaaaaaaa-op-stale"
active_worktree="$WORKTREE_ROOT/ash-atlas-bbbbbbbb-op-active"
referenced_worktree="$WORKTREE_ROOT/ash-atlas-cccccccc-op-referenced"
unproven_worktree="$WORKTREE_ROOT/ash-atlas-dddddddd-op-unproven"
sudo -u debian git --git-dir="$MIRROR_ROOT" worktree add --detach "$referenced_worktree" HEAD >/dev/null
for worktree in "$stale_worktree" "$active_worktree" "$unproven_worktree"; do
  install -d -o debian -g debian -m 0755 "$worktree/protected"
  printf 'gitdir: %s/worktrees/%s\n' "$MIRROR_ROOT" "${worktree##*/}" > "$worktree/.git"
  chown debian:debian "$worktree/.git"
  chmod 0550 "$worktree/protected"
done
printf '{"operation_id":"op-stale","requested_target_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","result":"completed"}\n' \
  > "$OPERATION_ROOT/op-stale.json"
printf '{"result":"completed"}\n' > "$OPERATION_ROOT/op-active.json"
printf '{"result":"completed"}\n' > "$OPERATION_ROOT/op-referenced.json"
printf 'op-active\n' > "$OPERATION_ROOT/active-operation"

cleanup_stale_source_worktrees
first_stale_removal_count=$STALE_WORKTREES_REMOVED
assert 'one terminal unregistered deployment worktree is removed despite protected directory modes' \
  bash -c '[[ "$1" = 1 && ! -e "$2" ]]' bash "$first_stale_removal_count" "$stale_worktree"
assert 'the active deployment worktree is preserved' test -d "$active_worktree"
assert 'a mirror-referenced deployment worktree is preserved' test -d "$referenced_worktree"
assert 'an unproven deployment worktree without a terminal receipt is preserved' test -d "$unproven_worktree"
cleanup_stale_source_worktrees
assert 'repeated stale cleanup is idempotent' test "$STALE_WORKTREES_REMOVED" -eq 0

cleanup_failure_is_nonfatal() (
  SOURCE_ROOT="$TEST_ROOT/cleanup-failure"
  SOURCE_WORKTREE_REGISTERED=true
  STALE_WORKTREES_REMOVED=0
  install -d -m 0550 "$SOURCE_ROOT/protected"
  sudo() { return 1; }
  on_exit
)
assert 'a disposable worktree cleanup failure does not invalidate successful deployment work' \
  cleanup_failure_is_nonfatal

discord_env_fixture="$TEST_ROOT/discord-patch-notes.env"
printf 'ASH_ATLAS_DISCORD_PATCH_NOTES_WEBHOOK_URL=https://discord.com/api/webhooks/123/token\r\n' \
  > "$discord_env_fixture"
assert 'a single Windows CRLF webhook assignment is normalized exactly' \
  test "$(read_discord_patch_notes_assignment "$discord_env_fixture")" = \
    'ASH_ATLAS_DISCORD_PATCH_NOTES_WEBHOOK_URL=https://discord.com/api/webhooks/123/token'
discord_assignment_is_refused() {
  ! read_discord_patch_notes_assignment "$1" >/dev/null
}
for invalid_discord_env in \
  $'ASH_ATLAS_DISCORD_PATCH_NOTES_WEBHOOK_URL=https://discord.com/api/webhooks/123/token\r' \
  $'ASH_ATLAS_DISCORD_PATCH_NOTES_WEBHOOK_URL=https://discord.com/api/webhooks/123/token\r\r\n' \
  $'ASH_ATLAS_DISCORD_PATCH_NOTES_WEBHOOK_URL=https://discord.com/api/webhooks/123/token \n' \
  $'ASH_ATLAS_DISCORD_PATCH_NOTES_WEBHOOK_URL=https://discord.com/api/webhooks/123/token\nSECOND=value\n'; do
  printf '%s' "$invalid_discord_env" > "$discord_env_fixture"
  assert 'non-canonical webhook assignment whitespace/control content is rejected' \
    discord_assignment_is_refused "$discord_env_fixture"
done

mkdir -p "$CACHE_ROOT/dependencies" "$CACHE_ROOT/builds/server" "$CACHE_ROOT/builds/client"
chown -R root:ash-atlas "$CACHE_ROOT"
chmod 0750 "$CACHE_ROOT" "$CACHE_ROOT/dependencies" "$CACHE_ROOT/builds" \
  "$CACHE_ROOT/builds/server" "$CACHE_ROOT/builds/client"
provision_cache_directories

assert 'non-writable traversal parents have root:debian 0750 identity' \
  bash -c 'for p; do [[ $(stat -c "%U:%G:%a" "$p") = root:debian:750 ]] || exit 1; done' bash \
  "$CACHE_ROOT" "$CACHE_ROOT/builds"
assert 'working parents have debian:ash-atlas 0750 identity' \
  bash -c 'for p; do [[ $(stat -c "%U:%G:%a" "$p") = debian:ash-atlas:750 ]] || exit 1; done' bash \
  "$CACHE_ROOT/dependencies" "$CACHE_ROOT/builds/server" "$CACHE_ROOT/builds/client"
assert 'static integrity receipts have a root-only cache parent' \
  test "$(stat -c '%U:%G:%a' "$CACHE_ROOT/static-integrity")" = 'root:root:750'
assert 'build user traverses every cache parent' sudo -u debian \
  test -x "$CACHE_ROOT/builds/client"
assert 'build-user create/write/rename/remove preflight passes' preflight_cache_access
assert 'unrelated user cannot modify cache entries' \
  bash -c '! sudo -u nobody touch "$1/outsider-write" 2>/dev/null' bash "$CACHE_ROOT/dependencies"

printf preserved > "$CACHE_ROOT/dependencies/preserved-entry"
provision_cache_directories
assert 'repeated provisioning preserves existing entries' \
  grep -qx preserved "$CACHE_ROOT/dependencies/preserved-entry"
assert 'legacy root:ash-atlas 0750 working parent is repaired' \
  test "$(stat -c '%U:%G:%a' "$CACHE_ROOT/dependencies")" = 'debian:ash-atlas:750'

static_identity=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
static_fence=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
static_cache_is_miss() {
  ! static_artifact_integrity_cache_hit "$1" "$2"
}
assert 'cold static integrity cache is a miss' \
  static_cache_is_miss "$static_identity" "$static_fence"
write_static_artifact_integrity_cache "$static_identity" "$static_fence"
assert 'verified root-owned static integrity receipt is reused' \
  static_artifact_integrity_cache_hit "$static_identity" "$static_fence"
assert 'changed expected artifact identity invalidates the static cache' \
  static_cache_is_miss \
  cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc "$static_fence"
assert 'changed artifact metadata fence invalidates the static cache' \
  static_cache_is_miss \
  "$static_identity" dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd
chmod 0660 "$CACHE_ROOT/static-integrity/verified-v1"
assert 'writable static integrity receipt is refused' \
  static_cache_is_miss "$static_identity" "$static_fence"
rm "$CACHE_ROOT/static-integrity/verified-v1"
ln -s /dev/null "$CACHE_ROOT/static-integrity/verified-v1"
assert 'symlink static integrity receipt is refused' \
  static_cache_is_miss "$static_identity" "$static_fence"
rm "$CACHE_ROOT/static-integrity/verified-v1"

mv "$CACHE_ROOT/builds/client" "$CACHE_ROOT/builds/client.real"
ln -s client.real "$CACHE_ROOT/builds/client"
assert 'symlink cache parent is refused' provision_is_refused
rm "$CACHE_ROOT/builds/client"
mv "$CACHE_ROOT/builds/client.real" "$CACHE_ROOT/builds/client"
rm -rf "$CACHE_ROOT/builds/server"
printf not-a-directory > "$CACHE_ROOT/builds/server"
assert 'regular file cache path is refused' provision_is_refused
rm "$CACHE_ROOT/builds/server"
provision_cache_directories

SOURCE_ROOT="$TEST_ROOT/source"
install -d -o debian -g debian -m 0755 \
  "$SOURCE_ROOT/apps/server/dist" "$SOURCE_ROOT/apps/client/dist" "$SOURCE_ROOT/node_modules"
printf '{}\n' > "$SOURCE_ROOT/package.json"
printf server > "$SOURCE_ROOT/apps/server/dist/server.js"
printf client > "$SOURCE_ROOT/apps/client/dist/client.js"
printf dependency > "$SOURCE_ROOT/node_modules/dependency.txt"
chown -R debian:debian "$SOURCE_ROOT"

server_cache="$CACHE_ROOT/builds/server/server-key"
client_cache="$CACHE_ROOT/builds/client/client-key"
dependency_cache="$CACHE_ROOT/dependencies/dependency-key"
cache_artifact "$SOURCE_ROOT" "$server_cache" apps/server/dist
assert 'cold server cache publication succeeds' test -f "$server_cache/artifact.tar.gz"
cache_artifact "$SOURCE_ROOT" "$client_cache" apps/client/dist
assert 'cold client cache publication succeeds' test -f "$client_cache/artifact.tar.gz"
cache_dependencies "$dependency_cache"
assert 'cold dependency cache publication succeeds' test -f "$dependency_cache/node-modules.tar.gz"

rm -rf "$SOURCE_ROOT/apps/server/dist" "$SOURCE_ROOT/apps/client/dist" "$SOURCE_ROOT/node_modules"
install -d -o debian -g debian -m 0755 "$SOURCE_ROOT/apps/server/dist" "$SOURCE_ROOT/apps/client/dist"
restore_artifact "$server_cache" "$SOURCE_ROOT"
restore_artifact "$client_cache" "$SOURCE_ROOT"
restore_dependencies "$dependency_cache"
assert 'warm artifact restoration succeeds' bash -c \
  'grep -qx server "$1/apps/server/dist/server.js" &&
      grep -qx client "$1/apps/client/dist/client.js" &&
      grep -qx dependency "$1/node_modules/dependency.txt"' bash "$SOURCE_ROOT"

printf corrupt >> "$server_cache/artifact.tar.gz"
assert 'artifact hash mismatch remains refused' artifact_restore_is_refused "$server_cache" "$SOURCE_ROOT"
printf corrupt >> "$dependency_cache/node-modules.tar.gz"
assert 'dependency hash mismatch remains refused' dependency_restore_is_refused "$dependency_cache"

lane_is() {
  local expected=$1
  shift
  [[ $(classify_changed_paths "$@") = "$expected" ]]
}

plan_is() {
  local expected=$1
  shift
  [[ $(deployment_plan_for_lane "$@") = "$expected" ]]
}

assert 'client-only changes select lane A/client' lane_is client apps/client/src/App.tsx apps/client/public/icon.png
assert 'server-only changes select lane B/application' lane_is application apps/server/src/index.ts
assert 'shared changes select lane B/application' lane_is application packages/shared/src/protocol.ts
assert 'safe client and server changes select lane B/application' lane_is application apps/client/src/App.tsx apps/server/src/index.ts
assert 'migration changes select lane C/migration' lane_is migration db/migrations/9999_fixture.sql
assert 'client plus migration remains lane C/migration' lane_is migration apps/client/src/App.tsx db/migrations/9999_fixture.sql
assert 'lockfile changes select lane D/full' lane_is full pnpm-lock.yaml
assert 'deployment tooling changes select lane D/full' lane_is full tools/release/vps/deploy-control.sh
assert 'client cache policy and release tests stay lane A/client' lane_is client \
  apps/client/public/sw.js \
  apps/client/src/main.tsx \
  apps/client/src/browserStateMigration.test.ts \
  apps/client/src/browserStateMigration.ts \
  tools/release/release-flow.tests.ps1 \
  tools/release/vps/game-cache-policy.caddy
assert 'unknown paths select lane D/full' lane_is full unexpected/new-system.txt
assert 'mixed unsafe changes select lane D/full' lane_is full apps/client/src/App.tsx package.json

failed_stopped_worker_is_normalized() (
  service_state=failed
  mock_main_pid=0
  reset_count=0
  systemctl() {
    if [[ $1 = show && $* = *ActiveState* ]]; then
      printf '%s\n' "$service_state"
    elif [[ $1 = show && $* = *MainPID* ]]; then
      printf '%s\n' "$mock_main_pid"
    elif [[ $1 = reset-failed ]]; then
      service_state=inactive
      reset_count=$((reset_count + 1))
    else
      return 1
    fi
  }
  confirm_game_worker_stopped
  [[ "$service_state" = inactive && "$reset_count" = 1 ]]
)

live_worker_is_refused() (
  systemctl() {
    if [[ $1 = show && $* = *ActiveState* ]]; then
      printf 'failed\n'
    elif [[ $1 = show && $* = *MainPID* ]]; then
      printf '123\n'
    else
      return 1
    fi
  }
  ! ( confirm_game_worker_stopped ) >/dev/null 2>&1
)

inactive_stopped_worker_is_accepted() (
  systemctl() {
    if [[ $1 = show && $* = *ActiveState* ]]; then
      printf 'inactive\n'
    elif [[ $1 = show && $* = *MainPID* ]]; then
      printf '0\n'
    else
      return 1
    fi
  }
  confirm_game_worker_stopped
)

assert 'failed systemd state with no worker is normalized to inactive' \
  failed_stopped_worker_is_normalized
assert 'a remaining game worker is refused even when systemd reports failed' \
  live_worker_is_refused
assert 'normal inactive state with no worker needs no reset' \
  inactive_stopped_worker_is_accepted

assert 'client lane skips server build' plan_is 'server=false client=true' client true false false
assert 'server-only application lane skips client build' plan_is 'server=true client=false' application false true false
assert 'shared application lane rebuilds both artifacts' plan_is 'server=true client=true' application false false true
assert 'full lane rebuilds both artifacts' plan_is 'server=true client=true' full false false false

mkdir -p "$SOURCE_ROOT/db/migrations"
printf 'SELECT 1;\n' > "$SOURCE_ROOT/db/migrations/0001_fixture.sql"
MIGRATION_CANDIDATES="$TEST_ROOT/migration-candidates.tsv"
MIGRATION_APPLIED="$TEST_ROOT/migration-applied.tsv"
MOCK_MIGRATION_LEDGER="$TEST_ROOT/mock-ledger.tsv"
MOCK_PSQL_FAILURE=false
sudo() {
  if [[ ${1:-} = -u && ${2:-} = postgres ]]; then
    shift 2
    if [[ "$MOCK_PSQL_FAILURE" = true ]]; then return 1; fi
    cat "$MOCK_MIGRATION_LEDGER"
    return
  fi
  if [[ ${1:-} = -u && ${2:-} = debian && ${3:-} = git ]]; then
    return 0
  fi
  command sudo "$@"
}
migration_hash=$(sha256sum "$SOURCE_ROOT/db/migrations/0001_fixture.sql" | cut -d' ' -f1)
printf '0001_fixture.sql\t%s\n' "$migration_hash" > "$MOCK_MIGRATION_LEDGER"
assert 'matching retained migration ledger reports no pending migration' \
  test "$(probe_migration_requirement aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb)" = $'false\tnone'
: > "$MOCK_MIGRATION_LEDGER"
assert 'candidate migration absent from the retained ledger requires migration' \
  test "$(probe_migration_requirement aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb)" = $'true\tpending:0001_fixture.sql'
printf '0001_fixture.sql\t%s\n' "$(printf wrong | sha256sum | cut -d' ' -f1)" > "$MOCK_MIGRATION_LEDGER"
migration_probe_is_refused() {
  ! ( probe_migration_requirement aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb ) >/dev/null 2>&1
}
assert 'retained migration hash mismatch is refused' migration_probe_is_refused
MOCK_PSQL_FAILURE=true
assert 'ledger probe uncertainty conservatively requires migration' \
  test "$(probe_migration_requirement aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb)" = $'true\tledger_probe_failed'
MOCK_PSQL_FAILURE=false

updater=$(<"$(dirname "$0")/deploy-test-update.sh")
updater_contains() {
  grep -Fq -- "$1" <<<"$updater"
}
updater_excludes() {
  ! grep -Fq -- "$1" <<<"$updater"
}
assert 'migration execution is gated by an actual ledger probe' updater_contains 'probe_migration_requirement'
assert 'migration requirement remains explicit' updater_contains 'MIGRATION_REQUIRED'
assert 'migrations are never cached' updater_excludes 'MIGRATION_CACHE'
assert 'no-pending-migration deployments skip backup' updater_contains 'skipped:no_pending_migrations'
assert 'backup and migration are conditionally gated' updater_contains 'if [[ "$MIGRATION_REQUIRED" = true ]]'
assert 'persistent mirror replaces per-SHA clones' updater_contains 'git clone --mirror'
assert 'disposable worktree is created' updater_contains 'worktree add --detach'
assert 'disposable worktree is removed' updater_contains 'worktree remove --force'
assert 'stale cleanup preserves mirror-referenced worktrees' updater_contains 'worktree list --porcelain'
assert 'cleanup failures are reported without changing deployment exit status' \
  updater_excludes 'worktree remove --force "$SOURCE_ROOT" >/dev/null 2>&1 || code=1'
assert 'build manifest is generated outside the source checkout' updater_contains 'BUILD_MANIFEST=$(mktemp'
assert 'build manifest is never generated inside the source checkout' updater_excludes '$SOURCE_ROOT/build-manifest.json'
assert 'client cache identity is stable across server-only target SHAs and embedded in the bundle' \
  bash -c 'grep -Fq client-artifact-v3 <<<"$1" && grep -Fq "VITE_CLIENT_BUILD_SHA=\"\$CLIENT_BUILD_SHA\"" <<<"$1" && grep -Fq "public-release-metadata.mjs" <<<"$1" && grep -Fq "--previous-sha" <<<"$1"' bash "$updater"
assert 'test uses only an isolated cache root and no protected refs or retained database' bash -c \
  '[[ "$1" == /tmp/ash-atlas-cache-tests.*/cache ]]' bash "$CACHE_ROOT"

printf 'deploy-cache.tests.sh: %s assertions passed.\n' "$passed"
