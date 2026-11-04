#!/usr/bin/env bash
set -euo pipefail

[[ ${EUID} -eq 0 ]] || {
  printf 'release-retention.tests.sh must run as root\n' >&2
  exit 1
}

readonly TEST_ROOT=$(mktemp -d /tmp/ash-atlas-release-retention.XXXXXXXX)
cleanup() {
  rm -rf --one-file-system "$TEST_ROOT"
}
trap cleanup EXIT

export ASH_ATLAS_GAME_RELEASE_ROOT="$TEST_ROOT/game/releases"
export ASH_ATLAS_GAME_CURRENT_LINK="$TEST_ROOT/game/current"
export ASH_ATLAS_CLIENT_RELEASE_ROOT="$TEST_ROOT/public/releases"
export ASH_ATLAS_CLIENT_CURRENT_LINK="$TEST_ROOT/public/current"
export ASH_ATLAS_OPERATION_ROOT="$TEST_ROOT/operations"
export ASH_ATLAS_DEPLOY_LOCK_FILE="$TEST_ROOT/deploy.lock"
export ASH_ATLAS_DEPLOY_LOCK_HELD=true
export ASH_ATLAS_NATIVE_BUNDLE_ROOT="$TEST_ROOT/native/private"
export ASH_ATLAS_NATIVE_PUBLIC_ROOT="$TEST_ROOT/native/public"
export ASH_ATLAS_NODE_BIN=${ASH_ATLAS_NODE_BIN:-$(command -v node)}
export ASH_ATLAS_CACHE_ROOT="$TEST_ROOT/cache"
export ASH_ATLAS_PREFLIGHT_SNAPSHOT_PARENT="$TEST_ROOT/tmp"
export ASH_ATLAS_DEPLOY_UPDATE_SOURCE_ONLY=true
mkdir -p "$ASH_ATLAS_GAME_RELEASE_ROOT" "$ASH_ATLAS_CLIENT_RELEASE_ROOT" \
  "$ASH_ATLAS_OPERATION_ROOT" "$ASH_ATLAS_PREFLIGHT_SNAPSHOT_PARENT"
exec 9>"$ASH_ATLAS_DEPLOY_LOCK_FILE"
flock 9

# shellcheck source=deploy-test-update.sh
source "$(dirname "$0")/deploy-test-update.sh"
unset ASH_ATLAS_DEPLOY_UPDATE_SOURCE_ONLY

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

sha() {
  printf '%040x' "$1"
}

make_release() {
  local root=$1
  local release_sha=$2
  local timestamp=$3
  install -d -o root -g root -m 0550 "$root/$release_sha/protected"
  printf fixture > "$root/$release_sha/protected/file"
  chmod 0440 "$root/$release_sha/protected/file"
  touch -d "@$timestamp" "$root/$release_sha"
}

release_count() {
  find "$1" -mindepth 1 -maxdepth 1 -type d ! -lname '*' -printf '%f\n' |
    grep -Ec '^[0-9a-f]{40}$'
}

active=$(sha 1)
newest_one=$(sha 2)
newest_two=$(sha 3)
newest_three=$(sha 4)
old_one=$(sha 5)
old_two=$(sha 6)
for root in "$GAME_RELEASE_ROOT" "$CLIENT_RELEASE_ROOT"; do
  make_release "$root" "$active" 100
  make_release "$root" "$newest_one" 600
  make_release "$root" "$newest_two" 500
  make_release "$root" "$newest_three" 400
  make_release "$root" "$old_one" 300
  make_release "$root" "$old_two" 200
done
ln -s "$GAME_RELEASE_ROOT/$active" "$GAME_CURRENT_LINK"
ln -s "$CLIENT_RELEASE_ROOT/$active" "$CLIENT_CURRENT_LINK"

prune_deployment_releases
basic_game_retention_is_exact() {
  [[ $(release_count "$GAME_RELEASE_ROOT") = 2 &&
      -d "$GAME_RELEASE_ROOT/$active" &&
      -d "$GAME_RELEASE_ROOT/$newest_one" ]]
}
old_game_releases_are_absent() {
  local release_sha
  for release_sha in "$newest_two" "$newest_three" "$old_one" "$old_two"; do
    [[ ! -e "$GAME_RELEASE_ROOT/$release_sha" ]] || return 1
  done
}
public_retention_is_exact() {
  [[ $(release_count "$CLIENT_RELEASE_ROOT") = 2 &&
      -d "$CLIENT_RELEASE_ROOT/$active" &&
      -d "$CLIENT_RELEASE_ROOT/$newest_one" ]]
}
assert 'active plus the newest inactive game release are retained' \
  basic_game_retention_is_exact
assert 'old inactive game releases are deleted' old_game_releases_are_absent
assert 'equivalent bounded retention applies to public releases' \
  public_retention_is_exact

prune_deployment_releases
assert 'repeated cleanup is a no-op' \
  test "$((GAME_RELEASES_DELETED + CLIENT_RELEASES_DELETED))" -eq 0
assert 'root-owned protected release directories remain removable' \
  test "$(stat -c '%U:%G' "$GAME_RELEASE_ROOT/$newest_one")" = root:root

staged=$(sha 7)
in_progress=$(sha 8)
for root in "$GAME_RELEASE_ROOT" "$CLIENT_RELEASE_ROOT"; do
  make_release "$root" "$staged" 50
  make_release "$root" "$in_progress" 40
done
printf 'op-active\n' > "$OPERATION_ROOT/active-operation"
printf '{"requested_target_sha":"%s"}\n' "$in_progress" > "$OPERATION_ROOT/op-active.json"
prune_deployment_releases "$staged"
protected_candidates_exist() {
  local root
  for root in "$GAME_RELEASE_ROOT" "$CLIENT_RELEASE_ROOT"; do
    [[ -d "$root/$staged" && -d "$root/$in_progress" ]] || return 1
  done
}
assert 'staged and active-operation candidates cannot be deleted' \
  protected_candidates_exist
rm "$OPERATION_ROOT/active-operation"

# A failed candidate newer than the previously live release must not displace the rollback target.
rollback_target=$(sha 16)
failed_newer=$(sha 17)
for root in "$GAME_RELEASE_ROOT" "$CLIENT_RELEASE_ROOT"; do
  make_release "$root" "$rollback_target" 30
  make_release "$root" "$failed_newer" 900
done
prune_deployment_releases "$active" "$rollback_target" "$rollback_target"
rollback_target_survives() {
  local root
  for root in "$GAME_RELEASE_ROOT" "$CLIENT_RELEASE_ROOT"; do
    [[ -d "$root/$active" && -d "$root/$rollback_target" && -d "$root/$failed_newer" &&
        ! -e "$root/$staged" && ! -e "$root/$in_progress" &&
        $(release_count "$root") = 3 ]] || return 1
  done
}
assert 'the exact previously live release survives beside a newer failed candidate' \
  rollback_target_survives
prune_deployment_releases "$active"
rollback_target_ages_out() {
  [[ ! -e "$GAME_RELEASE_ROOT/$rollback_target" &&
      $(release_count "$GAME_RELEASE_ROOT") = 2 ]]
}
assert 'an unprotected older release ages out on the next deployment' rollback_target_ages_out

outside="$TEST_ROOT/outside"
mkdir "$outside"
outside_sha=$(sha 9)
ln -s "$outside" "$GAME_RELEASE_ROOT/$outside_sha"
prune_release_root "$GAME_RELEASE_ROOT" "$GAME_CURRENT_LINK"
assert 'a SHA-named symlink outside the release root is never deleted' \
  test -d "$outside"
assert 'the outside-pointing SHA entry remains a symlink' \
  test -L "$GAME_RELEASE_ROOT/$outside_sha"
invalid="$GAME_RELEASE_ROOT/not-a-release"
mkdir "$invalid"
prune_release_root "$GAME_RELEASE_ROOT" "$GAME_CURRENT_LINK"
assert 'non-SHA entries are outside the deletion candidate set' test -d "$invalid"

bad_current="$TEST_ROOT/bad-current"
ln -s "$outside" "$bad_current"
outside_target_is_refused() {
  if ( prune_release_root "$GAME_RELEASE_ROOT" "$bad_current" >/dev/null 2>&1 ); then
    return 1
  fi
}
assert 'an active target outside the canonical release root is refused' \
  outside_target_is_refused

rm -f "$GAME_RELEASE_ROOT/$outside_sha"
rm -rf "$invalid"
for number in 10 11 12 13 14 15; do
  failed_sha=$(sha "$number")
  prune_release_root "$GAME_RELEASE_ROOT" "$GAME_CURRENT_LINK" "$failed_sha"
  make_release "$GAME_RELEASE_ROOT" "$failed_sha" "$((600 + number))"
  assert 'failed deployment accumulation remains bounded' \
    test "$(release_count "$GAME_RELEASE_ROOT")" -le 3
done

# Native OTA bundle retention.
client_sha() {
  printf '%064x' "$1"
}

make_native_bundle() {
  local platform=$1
  local bundle_sha=$2
  local timestamp=$3
  local directory="$NATIVE_PUBLIC_ROOT/$platform/$bundle_sha"
  install -d -o root -g root -m 0755 "$directory/assets"
  printf 'bundle-%s\n' "$bundle_sha" > "$directory/index.html"
  printf 'asset\n' > "$directory/assets/main.js"
  printf '{}\n' > "$directory/headers.json"
  chmod 0444 "$directory/index.html" "$directory/assets/main.js" "$directory/headers.json"
  chmod 0555 "$directory/assets" "$directory"
  touch -d "@$timestamp" "$directory"
}

native_descriptor() {
  printf '{"platform":"%s","bundleId":"%s-%s","clientSha":"%s"}' "$1" "$1" "$2" "$2"
}

write_native_pointer() {
  printf '{"ios":{"current":%s,"previous":%s},"android":{"current":%s,"previous":%s}}\n' \
    "$(native_descriptor ios "$1")" "$(native_descriptor ios "$2")" \
    "$(native_descriptor android "$1")" "$(native_descriptor android "$2")" \
    > "$NATIVE_BUNDLE_ROOT/pointer.json"
}

write_native_candidate() {
  printf '{"descriptors":{"ios":%s,"android":%s},"buildSeconds":1}\n' \
    "$(native_descriptor ios "$2")" "$(native_descriptor android "$2")" \
    > "$NATIVE_BUNDLE_ROOT/candidates/$1.json"
}

native_count() {
  find "$NATIVE_PUBLIC_ROOT/$1" -mindepth 1 -maxdepth 1 -type d ! -lname '*' -printf '%f\n' |
    grep -Ec '^[0-9a-f]{64}$'
}

prune_native_bundles
assert 'an absent native bundle root is a no-op' test "$NATIVE_BUNDLES_DELETED" -eq 0

install -d -m 0750 "$NATIVE_BUNDLE_ROOT/candidates"
install -d -m 0555 "$NATIVE_PUBLIC_ROOT"
for platform in ios android; do
  install -d -m 0555 "$NATIVE_PUBLIC_ROOT/$platform"
  for number in 1 2 3 4 5 6 7 8 9 10; do
    make_native_bundle "$platform" "$(client_sha "$number")" "$((number * 100))"
  done
done
prune_native_bundles
assert 'native retention deletes nothing without an active pointer' \
  test "$(native_count ios)" -eq 10

# The pointer advertises the two oldest bundles (as after a rollback) and a retained release
# references the third oldest; bundles 4 through 9 are unreferenced and older than the newest.
advertised=$(client_sha 1)
write_native_pointer "$advertised" "$(client_sha 2)"
retained_release=$(sha 30)
write_native_candidate "$retained_release" "$(client_sha 3)"
write_native_candidate "$(sha 31)" "$(client_sha 4)"
prune_native_bundles "$retained_release"
native_retention_is_exact() {
  local platform number
  for platform in ios android; do
    [[ $(native_count "$platform") = 4 ]] || return 1
    for number in 4 5 6 7 8 9; do
      [[ ! -e "$NATIVE_PUBLIC_ROOT/$platform/$(client_sha "$number")" ]] || return 1
    done
    for number in 1 2 3 10; do
      [[ -d "$NATIVE_PUBLIC_ROOT/$platform/$(client_sha "$number")" ]] || return 1
    done
  done
}
assert 'advertised, rollback, release-referenced, and the newest bundle are retained' \
  native_retention_is_exact
assert 'native retention reports deleted and retained counts' \
  test "$NATIVE_BUNDLES_DELETED:$NATIVE_BUNDLES_RETAINED" = 12:8
assert 'native retention reports freed bytes' test "$NATIVE_BUNDLES_FREED_BYTES" -gt 0

prune_native_bundles "$retained_release"
assert 'repeated native retention is a no-op' test "$NATIVE_BUNDLES_DELETED" -eq 0

make_native_bundle ios "$(client_sha 11)" 1
make_native_bundle ios "$(client_sha 12)" 1100
write_native_pointer "$(client_sha 12)" "$advertised"
prune_native_bundles
assert 'the previously advertised bundle survives pointer advancement' \
  test -d "$NATIVE_PUBLIC_ROOT/ios/$advertised"
assert 'an unreferenced old bundle is deleted' test ! -e "$NATIVE_PUBLIC_ROOT/ios/$(client_sha 11)"
assert 'native retention stays bounded to the advertised pair per platform' \
  test "$(native_count ios)" -eq 2

native_outside="$TEST_ROOT/native-outside"
mkdir "$native_outside"
ln -s "$native_outside" "$NATIVE_PUBLIC_ROOT/android/$(client_sha 40)"
mkdir "$NATIVE_PUBLIC_ROOT/android/staging.new.1"
touch -d @1 "$NATIVE_PUBLIC_ROOT/android/staging.new.1"
prune_native_bundles
assert 'a SHA-named native symlink target is never deleted' test -d "$native_outside"
assert 'non-SHA native entries are outside the deletion set' \
  test -d "$NATIVE_PUBLIC_ROOT/android/staging.new.1"

printf '{"ios":{"current":{"clientSha":"not-a-sha"},"previous":null}}\n' \
  > "$NATIVE_BUNDLE_ROOT/pointer.json"
make_native_bundle android "$(client_sha 13)" 2
malformed_pointer_is_refused() {
  if ( prune_native_bundles >/dev/null 2>&1 ); then
    return 1
  fi
  [[ -d "$NATIVE_PUBLIC_ROOT/android/$(client_sha 13)" ]]
}
assert 'a malformed native pointer refuses retention without deleting' \
  malformed_pointer_is_refused

write_native_pointer "$(client_sha 12)" "$advertised"
deployment_release=$(sha 32)
make_native_bundle android "$(client_sha 14)" 3
write_native_candidate "$deployment_release" "$(client_sha 14)"
prune_deployment_releases "$deployment_release"
assert 'deployment retention protects the staged release native bundle' \
  test -d "$NATIVE_PUBLIC_ROOT/android/$(client_sha 14)"
assert 'deployment retention prunes unreferenced native bundles' \
  test ! -e "$NATIVE_PUBLIC_ROOT/android/$(client_sha 13)"

# Build and dependency cache retention.
cache_key() {
  printf '%064x' "$((0x$1))"
}

make_cache_entry() {
  local directory=$1
  local timestamp=$2
  install -d -o nobody -m 0750 "$directory"
  printf artifact > "$directory/artifact.tar.gz"
  chmod 0440 "$directory/artifact.tar.gz"
  touch -d "@$timestamp" "$directory"
}

write_game_manifest() {
  printf '{"cache_keys":{"dependencies":"%s","server":"%s","client":"%s"}}\n' "$2" "$3" "$4" \
    > "$GAME_RELEASE_ROOT/$1/build-manifest.json"
}

find "$GAME_RELEASE_ROOT" "$CLIENT_RELEASE_ROOT" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
release_a=$(sha 50)
release_b=$(sha 51)
client_only_release=$(sha 52)
make_release "$GAME_RELEASE_ROOT" "$release_a" 100
make_release "$GAME_RELEASE_ROOT" "$release_b" 200
make_release "$CLIENT_RELEASE_ROOT" "$release_a" 100
make_release "$CLIENT_RELEASE_ROOT" "$client_only_release" 300
write_game_manifest "$release_a" "$(cache_key a1)" "$(cache_key a2)" "$(cache_key a3)"
write_game_manifest "$release_b" "$(cache_key b1)" "$(cache_key b2)" "$(cache_key b3)"
printf '{"game_sha":"%s","client_sha":"%s"}\n' "$release_a" "$(cache_key a3)" \
  > "$CLIENT_RELEASE_ROOT/$release_a/release.json"
printf '{"game_sha":"%s","client_sha":"%s"}\n' "$client_only_release" "$(cache_key c3)" \
  > "$CLIENT_RELEASE_ROOT/$client_only_release/release.json"

dependency_cache="$CACHE_ROOT/dependencies"
server_cache="$CACHE_ROOT/builds/server"
client_cache="$CACHE_ROOT/builds/client"
mkdir -p "$dependency_cache" "$server_cache" "$client_cache"
for key in a1 b1 d1 e1; do make_cache_entry "$dependency_cache/$(cache_key "$key")" 100; done
for key in a2 b2 d2 e2; do make_cache_entry "$server_cache/$(cache_key "$key")" 100; done
for key in a3 b3 c3 d3 e3; do make_cache_entry "$client_cache/$(cache_key "$key")" 100; done
make_cache_entry "$client_cache/$(cache_key d3).incoming.4242" 100
cache_outside="$TEST_ROOT/cache-outside"
mkdir "$cache_outside"
ln -s "$cache_outside" "$client_cache/$(cache_key f3)"
mkdir "$client_cache/.permission-preflight.Ab12Cd34"

prune_build_caches "dependencies=$(cache_key e1)" "server=$(cache_key e2)" "client=$(cache_key e3)"
build_cache_retention_is_exact() {
  local key
  for key in a1 b1 e1; do [[ -d "$dependency_cache/$(cache_key "$key")" ]] || return 1; done
  for key in a2 b2 e2; do [[ -d "$server_cache/$(cache_key "$key")" ]] || return 1; done
  for key in a3 b3 c3 e3; do [[ -d "$client_cache/$(cache_key "$key")" ]] || return 1; done
  [[ ! -e "$dependency_cache/$(cache_key d1)" && ! -e "$server_cache/$(cache_key d2)" &&
      ! -e "$client_cache/$(cache_key d3)" &&
      ! -e "$client_cache/$(cache_key d3).incoming.4242" ]]
}
assert 'release-referenced and running-candidate cache entries are the only ones retained' \
  build_cache_retention_is_exact
assert 'build cache retention reports deleted and retained counts' \
  test "$BUILD_CACHE_DELETED:$BUILD_CACHE_RETAINED" = 4:10
assert 'build cache retention reports freed bytes' test "$BUILD_CACHE_FREED_BYTES" -gt 0
assert 'a SHA-named cache symlink target is never deleted' test -d "$cache_outside"
assert 'non-key cache entries are outside the deletion set' \
  test -d "$client_cache/.permission-preflight.Ab12Cd34"

prune_build_caches "dependencies=$(cache_key e1)" "server=$(cache_key e2)" "client=$(cache_key e3)"
assert 'repeated build cache retention is a no-op' test "$BUILD_CACHE_DELETED" -eq 0

# A release whose manifest cannot be mapped keeps the newest entries as a fallback.
make_release "$GAME_RELEASE_ROOT" "$(sha 53)" 400
make_cache_entry "$server_cache/$(cache_key f2)" 500
make_cache_entry "$server_cache/$(cache_key 02)" 50
touch -d @300 "$server_cache/$(cache_key e2)"
prune_build_caches
unmapped_fallback_is_bounded() {
  [[ -d "$server_cache/$(cache_key f2)" && -d "$server_cache/$(cache_key e2)" &&
      -d "$server_cache/$(cache_key a2)" && -d "$server_cache/$(cache_key b2)" &&
      ! -e "$server_cache/$(cache_key 02)" ]]
}
assert 'an unmapped release keeps the two newest cache entries plus mapped ones' \
  unmapped_fallback_is_bounded

invalid_cache_key_is_refused() {
  ! ( prune_build_caches server=not-a-key >/dev/null 2>&1 )
}
assert 'an invalid protected cache key refuses retention' invalid_cache_key_is_refused
unlocked_cache_retention_is_refused() {
  ! ( ASH_ATLAS_DEPLOY_LOCK_HELD=false prune_build_caches >/dev/null 2>&1 )
}
assert 'build cache retention requires the deployment lock' unlocked_cache_retention_is_refused

# Orphaned candidate preflight databases and snapshots.
preflight_command_log="$TEST_ROOT/preflight-commands.log"
: > "$preflight_command_log"
sudo() {
  [[ "$1" = -u && "$2" = postgres ]] || return 97
  shift 2
  case "$1" in
    psql)
      printf '%s\n' ash_atlas_preflight_template ash_atlas_preflight_deadbeef_op_1 \
        ash_atlas_preflight_cafebabe_current 'ash_atlas_preflight_Bad-Name' ;;
    dropdb) printf 'dropdb %s\n' "$*" >> "$preflight_command_log" ;;
    *) return 98 ;;
  esac
}
PREFLIGHT_DATABASE=ash_atlas_preflight_cafebabe_current
stale_snapshot="$PREFLIGHT_SNAPSHOT_PARENT/ash-atlas-preflight-deadbeef.AbCd1234"
current_snapshot="$PREFLIGHT_SNAPSHOT_PARENT/ash-atlas-preflight-cafebabe.Zz9Yy8Xx"
unrelated_snapshot="$PREFLIGHT_SNAPSHOT_PARENT/ash-atlas-preflight-unrelated"
install -d -m 0700 "$stale_snapshot/protected" "$current_snapshot" "$unrelated_snapshot"
chmod 0500 "$stale_snapshot/protected"
PREFLIGHT_MIGRATIONS_STAGE=$current_snapshot
cleanup_stale_preflight_leftovers
unset -f sudo
stale_preflight_cleanup_is_exact() {
  [[ $(cat "$preflight_command_log") = \
      'dropdb dropdb --if-exists --force ash_atlas_preflight_deadbeef_op_1' &&
      "$STALE_PREFLIGHT_DATABASES_DROPPED:$STALE_PREFLIGHT_SNAPSHOTS_REMOVED" = 1:1 &&
      ! -e "$stale_snapshot" && -d "$current_snapshot" && -d "$unrelated_snapshot" ]]
}
assert 'only orphaned preflight databases and snapshots are removed; template and current stay' \
  stale_preflight_cleanup_is_exact
unset PREFLIGHT_DATABASE PREFLIGHT_MIGRATIONS_STAGE

# Candidate schema-rehearsal disk preflight: sized from the ~49 MB template, not Main's data.
candidate_rehearsal_source_bytes() { printf '%s\n' "$((49 * 1024 * 1024))"; }
candidate_rehearsal_data_directory() { printf '%s\n' "$TEST_ROOT"; }
filesystem_available_bytes() { printf '%s\n' "$TEST_AVAILABLE_BYTES"; }
TEST_AVAILABLE_BYTES=$((2 * 1024 * 1024 * 1024))
assert 'free space far below Main size passes the schema rehearsal preflight' \
  assert_candidate_rehearsal_disk_space
insufficient_space_is_refused() {
  local output
  TEST_AVAILABLE_BYTES=$((1024 * 1024 * 1024))
  if output=$( (assert_candidate_rehearsal_disk_space) 2>&1 ); then
    return 1
  fi
  [[ "$output" == *'insufficient disk for the candidate schema rehearsal'* ]]
}
assert 'insufficient free space fails before the schema rehearsal' \
  insufficient_space_is_refused
invalid_free_space_is_refused() {
  TEST_AVAILABLE_BYTES=unknown
  ! ( assert_candidate_rehearsal_disk_space >/dev/null 2>&1 )
}
assert 'an unreadable free-space value fails closed' invalid_free_space_is_refused

printf 'release-retention.tests.sh: %s assertions passed\n' "$passed"
