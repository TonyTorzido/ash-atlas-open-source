#!/usr/bin/env bash
set -euo pipefail
umask 077
if [[ -z "${ASH_ATLAS_RESTORE_TIMEOUT_ACTIVE:-}" ]]; then
  export ASH_ATLAS_RESTORE_TIMEOUT_ACTIVE=true
  exec timeout --kill-after=30 3600 bash "$0" "$@"
fi

fail() {
  printf 'STOP: %s\n' "$*" >&2
  exit 1
}

newest_dump=''
older_dump=''
proof=''
plan=''
database_name=''
latest=false
while (($#)); do
  case "$1" in
    --latest) latest=true ;;
    --dump)
      shift
      [[ $# -gt 0 ]] || fail 'missing --dump path'
      if [[ -z "$newest_dump" ]]; then
        newest_dump="$1"
      elif [[ -z "$older_dump" ]]; then
        older_dump="$1"
      else
        fail 'restore proof accepts exactly newest and older --dump evidence'
      fi
      ;;
    --newest-dump)
      shift
      [[ $# -gt 0 && -z "$newest_dump" ]] || fail 'invalid --newest-dump'
      newest_dump="$1"
      ;;
    --older-dump)
      shift
      [[ $# -gt 0 && -z "$older_dump" ]] || fail 'invalid --older-dump'
      older_dump="$1"
      ;;
    --proof)
      shift
      [[ $# -gt 0 ]] || fail 'missing --proof path'
      proof="$1"
      ;;
    --plan)
      shift
      [[ $# -gt 0 ]] || fail 'missing --plan path'
      plan="$1"
      ;;
    --database)
      shift
      [[ $# -gt 0 ]] || fail 'missing --database name'
      database_name="$1"
      ;;
    *) fail "unknown argument: $1" ;;
  esac
  shift
done
[[ "$latest" == true || ( -n "$newest_dump" && -n "$older_dump" && -n "$proof" && -n "$plan" ) ]] || {
  echo 'usage: ash-atlas-backup-restore-check.sh --newest-dump DUMP --older-dump DUMP --proof PROOF --plan PLAN [--database ash_atlas_stability_NAME]' >&2
  exit 2
}
[[ "$latest" == true || "$newest_dump" != "$older_dump" ]] || fail 'newest and older restore evidence must be distinct files'
[[ $EUID -eq 0 ]] || fail 'restore prerequisite must run as root or through sudo'

env_file=/etc/ash-atlas/telemetry-home.env
if [[ -v TELEMETRY_HOME_ENV_FILE ]]; then env_file="$TELEMETRY_HOME_ENV_FILE"; fi
[[ -r "$env_file" && ! -L "$env_file" ]] || fail 'telemetry-home environment is absent'
# shellcheck disable=SC1090
source "$env_file"
: "$TELEMETRY_SEAGATE_MOUNT"
: "${TELEMETRY_SEAGATE_UUID:?portable restore requires TELEMETRY_SEAGATE_UUID}"
: "${TELEMETRY_SEAGATE_SERIAL:?portable restore requires TELEMETRY_SEAGATE_SERIAL}"
portable_root="${TELEMETRY_PORTABLE_BACKUP_ROOT:-$TELEMETRY_SEAGATE_MOUNT/ash-atlas-backup-archive}"
if [[ "$latest" == true ]]; then
  [[ -z "$newest_dump" && -z "$older_dump" && -z "$plan" ]] || fail '--latest cannot accept migration dump/plan arguments'
  source "${ASH_ATLAS_BACKUP_COMMON:-/usr/local/lib/ash-atlas/backup-common.sh}"
  exec 9>"${TELEMETRY_HOME_PULL_LOCK:-/run/lock/ash-atlas-telemetry-home-pull.lock}"
  exec 8>"${ASH_ATLAS_BACKUP_MIRROR_LOCK:-/run/lock/ash-atlas-backup-mirror.lock}"
  exec 6>"${TELEMETRY_BACKUP_MIGRATION_LOCK:-/run/lock/ash-atlas-backup-migration.lock}"
  # The pull and mirror run every few minutes; wait for them to finish instead
  # of failing the weekly check whenever it happens to overlap one.
  writer_wait="${TELEMETRY_RESTORE_WRITER_WAIT_SECONDS:-1200}"
  [[ "$writer_wait" =~ ^[0-9]+$ ]] || fail 'restore writer wait is invalid'
  flock -w "$writer_wait" 9 && flock -w "$writer_wait" 8 && flock -w "$writer_wait" 6 ||
    fail 'backup writer is active; periodic restore deferred'
  catalog="$TELEMETRY_HOME_STORAGE_ROOT/.copy-verifications"
  [[ -d "$catalog" && ! -L "$catalog" && "$(stat -c '%u:%a' "$catalog")" == 0:700 ]] || fail 'protected copy catalog absent'
  latest_created=''
  while IFS= read -r -d '' entry; do
    [[ ! -L "$entry" && "$(stat -c '%u:%a' "$entry")" == 0:600 ]] || continue
    [[ "$(jq -r '.kind' "$entry")" == postgresql ]] || continue
    candidate="$(jq -r '.path' "$entry")"
    [[ "$candidate" == "$TELEMETRY_SEAGATE_MOUNT/"* ]] || continue
    candidate_source="$(jq -r '.sourceReceiptPath' "$entry")"
    candidate_manifest="$(jq -r '.manifestPath' "$entry")"
    candidate_created="$(jq -er '.createdAtUtc' "$candidate_source" 2>/dev/null || true)"
    [[ -n "$candidate_created" && "$candidate_created" > "$latest_created" ]] || continue
    ash_backup_verify_copy fast postgresql "$(jq -r '.id' "$entry")" "$candidate" \
      "$(jq -r '.bytes' "$entry")" "$(jq -r '.sha256' "$entry")" "$candidate_manifest" \
      "$candidate_source" "$(jq -r '.portableReceiptPath' "$entry")" >/dev/null || continue
    newest_dump="$candidate"; latest_created="$candidate_created"
    newest_sha="$(jq -r '.sha256' "$entry")"; newest_bytes="$(jq -r '.bytes' "$entry")"
    newest_class=database; latest_id="$(jq -r '.id' "$entry")"
  done < <(find "$catalog" -maxdepth 1 -type f -name '*.json' -print0)
  [[ -n "$newest_dump" ]] || fail 'no green portable copy is eligible for periodic restore'
  proof="${proof:-/var/lib/ash-atlas/backup-restore/latest.json}"
  plan_sha=''; older_bytes=0
fi

safe_absolute_path() {
  local value="$1"
  [[ "$value" == /* && "$value" != / && "$value" != *'//'*
     && "$value" != *'/../'* && "$value" != *'/./'* ]]
}

safe_absolute_path "$proof" || fail 'restore proof path is unsafe'
if [[ "$latest" != true ]]; then
  safe_absolute_path "$plan" || fail 'migration plan path is unsafe'
  [[ -f "$plan" && ! -L "$plan" ]] || fail 'migration plan is absent or unsafe'
fi

portable_path_allowed() {
  local path="$1"
  [[ "$path" == "$portable_root/"* ||
     "$path" == "$TELEMETRY_SEAGATE_MOUNT/"* ]]
}

for dump_path in "$newest_dump" "$older_dump"; do
  [[ -n "$dump_path" ]] || continue
  safe_absolute_path "$dump_path" || fail "portable dump path is unsafe: $dump_path"
  [[ -f "$dump_path" && ! -L "$dump_path" ]] ||
    fail "portable dump is absent or unsafe: $dump_path"
  canonical_dump="$(realpath -e -- "$dump_path")"
  portable_path_allowed "$canonical_dump" ||
    fail "portable dump is outside the configured portable mount: $canonical_dump"
  if [[ "$dump_path" == "$newest_dump" ]]; then
    newest_dump="$canonical_dump"
  else
    older_dump="$canonical_dump"
  fi
done
[[ "$newest_dump" != "$older_dump" ]] ||
  fail 'newest and older restore evidence resolve to the same portable file'

if [[ -n "$database_name" ]]; then
  [[ "$database_name" =~ ^ash_atlas_stability_[a-z0-9_]{1,50}$ ]] ||
    fail 'restore database must use the disposable ash_atlas_stability_ prefix'
fi

script_dir="$(cd -- "$(dirname -- "$0")" && pwd -P)"
common="$script_dir/ash-atlas-backup-common.sh"
if [[ -v ASH_ATLAS_BACKUP_COMMON ]]; then common="$ASH_ATLAS_BACKUP_COMMON"; fi
if [[ ! -r "$common" ]]; then common=/usr/local/lib/ash-atlas/backup-common.sh; fi
[[ -r "$common" && ! -L "$common" ]] || fail 'backup common library is absent'
# shellcheck disable=SC1090
source "$common"

for command in cat date df du fallocate find install jq losetup mkfs.ext4 \
  mount mountpoint pg_config runuser sha256sum stat sync chown chmod mktemp \
  realpath id awk cut grep readlink umount rmdir; do
  command -v "$command" >/dev/null || fail "required command is missing: $command"
done

seagate_fstype=ntfs3
if [[ -v TELEMETRY_SEAGATE_FSTYPE ]]; then seagate_fstype="$TELEMETRY_SEAGATE_FSTYPE"; fi
if [[ -v TELEMETRY_SEAGATE_UUID && -v TELEMETRY_SEAGATE_SERIAL &&
      -n "$TELEMETRY_SEAGATE_UUID" && -n "$TELEMETRY_SEAGATE_SERIAL" ]]; then
  ash_backup_validate_storage "$TELEMETRY_SEAGATE_MOUNT" "$TELEMETRY_SEAGATE_MOUNT" \
    "$TELEMETRY_SEAGATE_UUID" "$TELEMETRY_SEAGATE_SERIAL" "$seagate_fstype" \
    'portable restore source' || fail 'portable restore source identity is unsafe'
else
  mountpoint -q -- "$TELEMETRY_SEAGATE_MOUNT" ||
    fail 'portable restore source is not mounted'
fi

if [[ "$latest" != true ]]; then
jq -e '.migrationPlanVersion == 1 and .mode == "dry-run" and (.removals | type == "array")' \
  "$plan" >/dev/null || fail 'migration plan is malformed'
plan_sha="$(sha256sum "$plan" | awk '{print $1}')"

verify_keeper() {
  local path="$1" entry
  entry="$(jq -ce --arg path "$path" '
    [.removals[] | select(.removalEligible == true and .portableKeeper == $path)]
    | if length == 1 then .[0] else error("portable dump is not a unique verified plan keeper") end
  ' "$plan")" || fail "portable dump is not a unique verified plan keeper: $path"
  keeper_sha="$(jq -er '.sha256 | select(test("^[a-f0-9]{64}$"))' <<<"$entry")" ||
    fail "plan keeper checksum is invalid: $path"
  keeper_bytes="$(jq -er '.bytes | select(type == "number" and . > 0)' <<<"$entry")" ||
    fail "plan keeper byte count is invalid: $path"
  keeper_class="$(jq -er '.class | select(. == "database" or . == "reset")' <<<"$entry")" ||
    fail "plan keeper class is invalid: $path"
}

verify_keeper "$newest_dump"
newest_sha="$keeper_sha"
newest_bytes="$keeper_bytes"
newest_class="$keeper_class"
verify_keeper "$older_dump"
older_sha="$keeper_sha"
older_bytes="$keeper_bytes"
older_class="$keeper_class"
fi

restore_temp_root="$TELEMETRY_HOME_STORAGE_ROOT/.restore-workspaces"
if [[ -v TELEMETRY_RESTORE_TEMP_ROOT ]]; then restore_temp_root="$TELEMETRY_RESTORE_TEMP_ROOT"; fi
[[ "$restore_temp_root" == "$TELEMETRY_HOME_STORAGE_ROOT/"* ]] || fail 'restore workspace must be inside capped backup intake'
[[ -e "$restore_temp_root" || -L "$restore_temp_root" ]] || install -d -o root -g root -m 0700 "$restore_temp_root"
safe_absolute_path "$restore_temp_root" || fail 'restore temporary root is unsafe'
[[ -d "$restore_temp_root" && ! -L "$restore_temp_root" ]] ||
  fail 'restore temporary root is absent or unsafe'

positive_integer() {
  [[ "$1" =~ ^[1-9][0-9]*$ ]]
}

restore_database_estimate=''
if [[ -v TELEMETRY_RESTORE_DATABASE_ESTIMATE_BYTES ]]; then
  restore_database_estimate="$TELEMETRY_RESTORE_DATABASE_ESTIMATE_BYTES"
fi
[[ -n "$restore_database_estimate" ]] ||
  fail 'TELEMETRY_RESTORE_DATABASE_ESTIMATE_BYTES must be set to a conservative source database estimate'
positive_integer "$restore_database_estimate" || fail 'restore database estimate is invalid'
workspace_cap=''
if [[ -v TELEMETRY_RESTORE_WORKSPACE_CAP_BYTES ]]; then
  workspace_cap="$TELEMETRY_RESTORE_WORKSPACE_CAP_BYTES"
fi
[[ -n "$workspace_cap" ]] || fail 'TELEMETRY_RESTORE_WORKSPACE_CAP_BYTES must be set'
positive_integer "$workspace_cap" || fail 'restore workspace cap is invalid'
minimum_free=21474836480
if [[ -v TELEMETRY_RESTORE_MINIMUM_FREE_BYTES ]]; then minimum_free="$TELEMETRY_RESTORE_MINIMUM_FREE_BYTES"; fi
root_reserve=107374182400
if [[ -v TELEMETRY_RESTORE_ROOT_RESERVE_BYTES ]]; then
  root_reserve="$TELEMETRY_RESTORE_ROOT_RESERVE_BYTES"
elif [[ -v TELEMETRY_HOME_BACKUP_ROOT_RESERVE_BYTES ]]; then
  root_reserve="$TELEMETRY_HOME_BACKUP_ROOT_RESERVE_BYTES"
fi
positive_integer "$minimum_free" || fail 'restore free-space reserve is invalid'
positive_integer "$root_reserve" || fail 'restore root reserve is invalid'

pg_config_bin="$(command -v pg_config)"
pg_bindir="$("$pg_config_bin" --bindir 2>/dev/null || true)"
if [[ ! -x "$pg_bindir/pg_restore" || ! -x "$pg_bindir/initdb" ||
      ! -x "$pg_bindir/pg_ctl" || ! -x "$pg_bindir/psql" ||
      ! -x "$pg_bindir/createdb" || ! -x "$pg_bindir/dropdb" ]]; then
  if [[ -d /usr/lib/postgresql/17/bin ]]; then pg_bindir=/usr/lib/postgresql/17/bin; fi
fi
for binary in initdb pg_ctl pg_restore psql createdb dropdb; do
  [[ -x "$pg_bindir/$binary" ]] || fail "PostgreSQL 17 binary is unavailable: $binary"
done

verify_dump() {
  local path="$1" expected_sha="$2" expected_bytes="$3" bytes sha
  bytes="$(stat -c '%s' "$path")"
  sha="$(sha256sum "$path" | awk '{print $1}')"
  [[ "$bytes" == "$expected_bytes" && "$sha" == "$expected_sha" ]] ||
    fail "portable dump no longer matches its verified plan keeper: $path"
  "$pg_bindir/pg_restore" --list "$path" >/dev/null ||
    fail "portable dump restore catalog is invalid: $path"
  printf '%s\n' "$bytes"
}

newest_bytes="$(verify_dump "$newest_dump" "$newest_sha" "$newest_bytes")"
[[ "$latest" == true ]] || older_bytes="$(verify_dump "$older_dump" "$older_sha" "$older_bytes")"
total_dump_bytes=$((newest_bytes + older_bytes))

# This estimate is independent of dump compression. It bounds native
# PostgreSQL data growth and is checked before and during the restore.
workspace_overhead=1073741824
required_workspace=$((total_dump_bytes + restore_database_estimate + workspace_overhead))
(( required_workspace <= workspace_cap )) ||
  fail "restore estimate requires $required_workspace bytes, above workspace cap $workspace_cap"
available="$(df -PB1 "$restore_temp_root" | awk 'NR == 2 {print $4}')"
[[ "$available" =~ ^[0-9]+$ ]] || fail 'restore free space is unreadable'
restore_workspace_bytes="$workspace_cap"
if [[ -v TELEMETRY_RESTORE_WORKSPACE_BYTES ]]; then
  restore_workspace_bytes="$TELEMETRY_RESTORE_WORKSPACE_BYTES"
fi
positive_integer "$restore_workspace_bytes" || fail 'restore workspace allocation is invalid'
(( restore_workspace_bytes == workspace_cap )) ||
  fail 'restore workspace allocation must equal its hard cap'
ASH_ATLAS_RESTORE_ADMISSION=true ash_backup_require_bounded_capacity "$TELEMETRY_HOME_STORAGE_ROOT" \
  "${TELEMETRY_HOME_BACKUP_CAP_BYTES:-50000000000}" "${TELEMETRY_HOME_BACKUP_WARNING_BYTES:-40000000000}" \
  "$restore_workspace_bytes" "$root_reserve" "${TELEMETRY_HOME_BACKUP_ROOT_MAX_USED_PERCENT:-75}" >/dev/null ||
  fail 'restore allocation exceeds aggregate backup limit'
required_reserve="$root_reserve"
(( minimum_free > required_reserve )) && required_reserve="$minimum_free"
required_free=$((restore_workspace_bytes + required_reserve))
(( available >= required_free )) ||
  fail "restore preallocation requires $required_free bytes including root reserve; only $available available"

restore_user=postgres
if [[ -v TELEMETRY_RESTORE_USER ]]; then restore_user="$TELEMETRY_RESTORE_USER"; fi
id "$restore_user" >/dev/null 2>&1 || fail "restore user is absent: $restore_user"
restore_group="$(id -gn "$restore_user")"
representative_relation="${TELEMETRY_RESTORE_REPRESENTATIVE_RELATION:-public.players}"
[[ "$representative_relation" =~ ^[a-z_][a-z0-9_]{0,62}\.[a-z_][a-z0-9_]{0,62}$ ]] ||
  fail 'restore representative relation is invalid'
representative_schema="${representative_relation%%.*}"
representative_table="${representative_relation#*.}"
work="$(mktemp -d "$restore_temp_root/ash-atlas-stability-restore.XXXXXXXX")"
chmod 0700 "$work" || fail 'restore workspace permissions could not be set'
operation_id="$(basename -- "$work")"
image="$work/restore-workspace.ext4"
image_mount=''
state="$work/state.json"
loop_device=''
cluster=''
socket=''
work_fs=''
tmpdir=''
cluster_started=false
write_state() {
  local stage="$1" temporary
  temporary="$state.partial"
  jq -cn --arg stage "$stage" --arg image "$image" --arg mount "$image_mount" \
    --arg loop "$loop_device" --arg cluster "$cluster" \
    --arg operation "$operation_id" --arg updatedAtUtc "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{restoreStateVersion:1,operationId:$operation,stage:$stage,image:$image,
      mount:$mount,loopDevice:$loop,cluster:$cluster,updatedAtUtc:$updatedAtUtc}' \
    >"$temporary" || return 1
  chmod 0600 "$temporary" || return 1
  sync -f "$temporary" || return 1
  mv -f -- "$temporary" "$state" || return 1
  sync -f "$work" || return 1
}
cleanup() {
  # Capture the exit status first: a preceding `local` would reset $? to 0 and
  # report every failed restore as a pass.
  local status="$?"
  local cleanup_failed=false associated
  trap - EXIT
  if [[ "$cluster_started" == true && -n "$cluster" ]]; then
    runuser -u "$restore_user" -- "$pg_bindir/pg_ctl" -D "$cluster" -m fast stop \
      >/dev/null 2>&1 || cleanup_failed=true
  fi
  if [[ -n "$image_mount" ]] && mountpoint -q -- "$image_mount"; then
    umount -- "$image_mount" >/dev/null 2>&1 || cleanup_failed=true
  fi
  if [[ -n "$loop_device" ]]; then
    associated="$(losetup -j "$image" | cut -d: -f1 || true)"
    if [[ "$associated" != "$loop_device" ]]; then
      cleanup_failed=true
    else
      losetup -d "$loop_device" >/dev/null 2>&1 || cleanup_failed=true
    fi
  fi
  if [[ "$cleanup_failed" == true ]]; then
    printf 'STOP: restore cleanup failed; quarantine exact workspace: %s\n' "$work" >&2
    exit 1
  fi
  if [[ -n "$image_mount" ]]; then
    [[ "$image_mount" == /run/ash-atlas-stability-restore.* && ! -L "$image_mount" &&
       "$(realpath -e "$image_mount")" == "$image_mount" ]] || exit 1
    rmdir -- "$image_mount" || { echo 'STOP: private runtime mount removal failed' >&2; exit 1; }
  fi
  rm -rf -- "$work" || {
    printf 'STOP: restore workspace removal failed; quarantine exact workspace: %s\n' "$work" >&2
    exit 1
  }
  exit "$status"
}
trap cleanup EXIT
trap 'exit 124' TERM INT

fallocate -l "$restore_workspace_bytes" "$image" ||
  fail 'restore workspace preallocation failed'
allocated_blocks="$(stat -c '%b' "$image")"
block_size="$(stat -c '%B' "$image")"
allocated_bytes=$((allocated_blocks * block_size))
(( allocated_bytes >= restore_workspace_bytes )) ||
  fail 'restore workspace backing file is not fully allocated'
sync -f "$image" || fail 'restore workspace backing file flush failed'
post_allocation_available="$(df -PB1 "$restore_temp_root" | awk 'NR == 2 {print $4}')"
[[ "$post_allocation_available" =~ ^[0-9]+$ ]] ||
  fail 'restore post-allocation free space is unreadable'
(( post_allocation_available >= root_reserve )) ||
  fail "restore preallocation would consume the root reserve; only $post_allocation_available bytes remain"
# Backing bytes stay inside capped intake; postgres traverses only /run.
image_mount="$(mktemp -d /run/ash-atlas-stability-restore.XXXXXXXX)" ||
  fail 'restore private runtime mount directory failed'
loop_device="$(losetup --find --show -- "$image")" ||
  fail 'restore workspace loop attachment failed'
[[ "$loop_device" == /dev/loop* ]] || fail 'restore workspace loop identity is unsafe'
write_state loop-attached || fail 'restore workspace state write failed'
mkfs.ext4 -F "$loop_device" >/dev/null || fail 'restore workspace filesystem creation failed'
mount -o nodev,nosuid,noexec "$loop_device" "$image_mount" ||
  fail 'restore workspace filesystem mount failed'
mountpoint -q -- "$image_mount" || fail 'restore workspace mount was not established'
chown "$restore_user:$restore_group" "$image_mount" ||
  fail 'restore filesystem ownership could not be set'
chmod 0700 "$image_mount" || fail 'restore filesystem permissions could not be set'
runuser -u "$restore_user" -- test -x "$image_mount" || fail 'restore user cannot traverse private runtime mount'
write_state mounted || fail 'restore workspace state write failed'
work_fs="$image_mount"
cluster="$work_fs/pgdata"
socket="$work_fs/socket"
tmpdir="$work_fs/tmp"
install -d -o "$restore_user" -g "$restore_group" -m 0700 "$socket" "$tmpdir" ||
  fail 'restore private directories could not be prepared'
install -o "$restore_user" -g "$restore_group" -m 0600 /dev/null "$work_fs/postgres.log" ||
  fail 'restore PostgreSQL log could not be prepared'
write_state prepared || fail 'restore workspace state write failed'

runuser -u "$restore_user" -- env TMPDIR="$tmpdir" "$pg_bindir/initdb" -D "$cluster" \
  --no-locale --encoding=UTF8 >/dev/null || fail 'isolated PostgreSQL initdb failed'
[[ -d "$cluster/pg_wal" && ! -L "$cluster/pg_wal" ]] ||
  fail 'isolated PostgreSQL WAL is not a private directory'
[[ -d "$cluster/pg_tblspc" && -z "$(find "$cluster/pg_tblspc" -mindepth 1 -maxdepth 1 -print -quit)" ]] ||
  fail 'isolated PostgreSQL cluster contains an external tablespace link'
runuser -u "$restore_user" -- env TMPDIR="$tmpdir" "$pg_bindir/pg_ctl" -D "$cluster" \
  -l "$work_fs/postgres.log" \
  -o "-k $socket -c listen_addresses='' -c archive_mode=off -c temp_tablespaces=''" \
  -w start >/dev/null || fail 'isolated PostgreSQL server did not start'
cluster_started=true
write_state running || fail 'restore workspace state write failed'

restored_json='[]'
restore_one() {
  local role="$1" dump="$2" expected_sha="$3" expected_bytes="$4" backup_class="$5"
  local db_name identity short_digest schema_count postgis_count table_count representative_row_count
  mountpoint -q -- "$image_mount" || fail 'restore workspace mount disappeared'
  [[ "$(readlink -f -- "$image_mount")" == "$image_mount" ]] ||
    fail 'restore workspace mount path changed'
  [[ "$(df -P -B1 "$image_mount" | awk 'NR == 2 {print $6}')" == "$image_mount" ]] ||
    fail 'restore workspace mount identity changed'
  ash_backup_require_portable_mount "$TELEMETRY_SEAGATE_MOUNT" ||
    fail 'portable restore source mount disappeared or changed'
  if [[ "$role" == newest && -n "$database_name" ]]; then
    db_name="$database_name"
  else
    short_digest="$(printf '%s' "$expected_sha" | cut -c1-12)"
    db_name="ash_atlas_stability_restore_$short_digest"
  fi
  [[ "$db_name" =~ ^ash_atlas_stability_[a-z0-9_]{1,50}$ ]] ||
    fail 'generated restore database name is unsafe'
  runuser -u "$restore_user" -- env TMPDIR="$tmpdir" "$pg_bindir/createdb" -h "$socket" "$db_name" ||
    fail "could not create disposable database: $db_name"
  # Root opens the dump and hands pg_restore a seekable stdin. A `cat |` pipe
  # failed the check with "Broken pipe" whenever pg_restore finished without
  # reading trailing archive bytes, even though the restore itself succeeded.
  runuser -u "$restore_user" -- env TMPDIR="$tmpdir" "$pg_bindir/pg_restore" \
    --exit-on-error \
    --no-owner --no-privileges --no-tablespaces --dbname="$db_name" \
    --host="$socket" <"$dump" || fail "disposable restore failed: $dump"
  identity="$(runuser -u "$restore_user" -- env TMPDIR="$tmpdir" "$pg_bindir/psql" --no-psqlrc \
    --quiet --no-align --tuples-only --host="$socket" --dbname="$db_name" \
    -c 'SELECT current_database()')"
  [[ "$identity" == "$db_name" ]] || fail "disposable restore identity check failed: $db_name"
  schema_count="$(runuser -u "$restore_user" -- env TMPDIR="$tmpdir" "$pg_bindir/psql" \
    --no-psqlrc --quiet --no-align --tuples-only --host="$socket" --dbname="$db_name" \
    -c "SELECT count(*) FROM pg_namespace WHERE nspname IN ('public','telemetry')")"
  postgis_count="$(runuser -u "$restore_user" -- env TMPDIR="$tmpdir" "$pg_bindir/psql" \
    --no-psqlrc --quiet --no-align --tuples-only --host="$socket" --dbname="$db_name" \
    -c "SELECT count(*) FROM pg_extension WHERE extname='postgis'")"
  table_count="$(runuser -u "$restore_user" -- env TMPDIR="$tmpdir" "$pg_bindir/psql" \
    --no-psqlrc --quiet --no-align --tuples-only --host="$socket" --dbname="$db_name" \
    -c "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p','v','m','f') AND n.nspname NOT IN ('pg_catalog','information_schema')")"
  representative_row_count="$(runuser -u "$restore_user" -- env TMPDIR="$tmpdir" "$pg_bindir/psql" \
    --no-psqlrc --quiet --no-align --tuples-only --host="$socket" --dbname="$db_name" \
    -c "SELECT count(*) FROM (SELECT 1 FROM \"$representative_schema\".\"$representative_table\" LIMIT 1) AS representative")"
  [[ "$schema_count" =~ ^[1-9][0-9]*$ && "$postgis_count" == 1 &&
     "$table_count" =~ ^[1-9][0-9]*$ &&
     "$representative_row_count" =~ ^[1-9][0-9]*$ ]] ||
    fail "restore schema/PostGIS/table checks failed: $db_name"
  runuser -u "$restore_user" -- env TMPDIR="$tmpdir" "$pg_bindir/dropdb" -h "$socket" "$db_name" ||
    fail "could not remove disposable database: $db_name"
  restored_json="$(jq -cn --argjson prior "$restored_json" --arg role "$role" \
    --arg dumpPath "$dump" --arg sha256 "$expected_sha" --arg class "$backup_class" \
    --arg databaseName "$db_name" --argjson bytes "$expected_bytes" \
    --argjson schemaCount "$schema_count" --argjson postgisCount "$postgis_count" \
    --argjson tableCount "$table_count" --arg representativeRelation "$representative_relation" \
    --argjson representativeRowCount "$representative_row_count" \
    '$prior + [{role:$role,dumpPath:$dumpPath,bytes:$bytes,sha256:$sha256,
                class:$class,databaseName:$databaseName,
                restoreCatalogVerified:true,privateWal:true,privateTablespaces:true,
                schemaCount:$schemaCount,postgisExtensionCount:$postgisCount,
                tableCount:$tableCount,representativeRelation:$representativeRelation,
                representativeRowCount:$representativeRowCount}]')" ||
    fail 'restore proof entry could not be serialized'
  write_state "restored-$role" || fail 'restore workspace state write failed'
}
restore_one newest "$newest_dump" "$newest_sha" "$newest_bytes" "$newest_class"
[[ "$latest" == true ]] || restore_one older "$older_dump" "$older_sha" "$older_bytes" "$older_class"

temporary="$proof.partial"
proof_parent="$(dirname -- "$proof")"
install -d -m 0700 "$proof_parent" || fail 'restore proof directory could not be prepared'
database_json="$(jq -c '[.[] | .databaseName]' <<<"$restored_json")" ||
  fail 'restore database names could not be serialized'
jq -cn --arg planSha256 "$plan_sha" --arg verifiedAtUtc "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg restoreUser "$restore_user" --arg bindir "$pg_bindir" \
  --argjson databaseNames "$database_json" --argjson restoredBackups "$restored_json" '
    {migrationRestoreProofVersion:1,restoreCheckVersion:1,
     evidenceRoles:["newest","older"],databaseNames:$databaseNames,
     restoredBackups:$restoredBackups,checksumsVerified:true,
     portableSupersetVerified:true,planSha256:$planSha256,
     restoreUser:$restoreUser,postgresBindir:$bindir,
     verifiedAtUtc:$verifiedAtUtc}
  ' >"$temporary" || fail 'restore proof serialization failed'
if [[ "$latest" == true ]]; then
  jq --arg id "$latest_id" '. + {periodicRestoreVersion:1,backupId:$id,evidenceRoles:["newest"]}
    | del(.migrationRestoreProofVersion,.portableSupersetVerified,.planSha256)' "$temporary" >"$temporary.latest"
  mv -f "$temporary.latest" "$temporary"
fi
chmod 0600 "$temporary" || fail 'restore proof permissions failed'
sync -f "$temporary" || fail 'restore proof flush failed'
mv -f -- "$temporary" "$proof" || fail 'restore proof publication failed'
sync -f "$proof_parent" || fail 'restore proof directory flush failed'
if [[ "$latest" == true ]]; then
  keyed="$proof_parent/$latest_id-$newest_sha.json"
  [[ ! -L "$keyed" ]] || fail 'keyed restore result is unsafe'
  cp -- "$proof" "$keyed.partial" || fail 'keyed restore result copy failed'
  chmod 0600 "$keyed.partial"
  sync -f "$keyed.partial"
  mv -f -- "$keyed.partial" "$keyed"
  sync -f "$proof_parent"
fi
printf 'restore proof: %s\n' "$proof"
