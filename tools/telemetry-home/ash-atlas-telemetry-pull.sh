#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ "${TELEMETRY_TEST_MODE:-false}" != true && -z "${ASH_ATLAS_BACKUP_DEADLINE:-}" ]]; then
  export ASH_ATLAS_BACKUP_DEADLINE=$(( $(date +%s) + 600 ))
  exec timeout --kill-after=5 600 bash "$0" "$@"
fi

: "${TELEMETRY_VPS_HOST:?VPS host is required}"
: "${TELEMETRY_VPS_USER:=ash-telemetry-pull}"
: "${TELEMETRY_SSH_KEY:?dedicated SSH key path is required}"
: "${TELEMETRY_KNOWN_HOSTS:?pinned known_hosts path is required}"
: "${TELEMETRY_SEAGATE_MOUNT:?Seagate mount path is required}"
: "${TELEMETRY_SEAGATE_UUID:?Seagate filesystem UUID is required}"
: "${TELEMETRY_SEAGATE_SERIAL:?Seagate device serial is required}"
storage_root="${TELEMETRY_HOME_STORAGE_ROOT:-$TELEMETRY_SEAGATE_MOUNT}"
storage_mount="${TELEMETRY_HOME_STORAGE_MOUNT:-$storage_root}"
storage_uuid="${TELEMETRY_HOME_STORAGE_UUID:-$TELEMETRY_SEAGATE_UUID}"
storage_serial="${TELEMETRY_HOME_STORAGE_SERIAL:-$TELEMETRY_SEAGATE_SERIAL}"
storage_fstype="${TELEMETRY_HOME_STORAGE_FSTYPE:-ntfs3}"
archive_owner="${TELEMETRY_ARCHIVE_OWNER:-root:root}"
minimum_free_bytes="${TELEMETRY_HOME_MINIMUM_FREE_BYTES:-1073741824}"
backup_cap_bytes="${TELEMETRY_HOME_BACKUP_CAP_BYTES:-50000000000}"
backup_warning_bytes="${TELEMETRY_HOME_BACKUP_WARNING_BYTES:-40000000000}"
backup_root_reserve_bytes="${TELEMETRY_HOME_BACKUP_ROOT_RESERVE_BYTES:-107374182400}"
backup_root_max_used_percent="${TELEMETRY_HOME_BACKUP_ROOT_MAX_USED_PERCENT:-75}"
backup_max_inflight_bytes="${TELEMETRY_HOME_BACKUP_MAX_INFLIGHT_BYTES:-2147483648}"
backup_max_concurrent="${TELEMETRY_HOME_BACKUP_MAX_CONCURRENT:-1}"
emergency_keep="${TELEMETRY_HOME_EMERGENCY_KEEP:-2}"
telemetry_cap_bytes="${TELEMETRY_HOME_TELEMETRY_CAP_BYTES:-10000000000}"
telemetry_warning_bytes="${TELEMETRY_HOME_TELEMETRY_WARNING_BYTES:-8000000000}"
portable_root="${TELEMETRY_PORTABLE_BACKUP_ROOT:-$TELEMETRY_SEAGATE_MOUNT/ash-atlas-backup-archive}"
portable_cap_bytes="${TELEMETRY_PORTABLE_BACKUP_CAP_BYTES:-0}"
portable_minimum_free_bytes="${TELEMETRY_PORTABLE_BACKUP_MINIMUM_FREE_BYTES:-10737418240}"
portable_root_reserve_bytes="${TELEMETRY_PORTABLE_BACKUP_ROOT_RESERVE_BYTES:-0}"
manifest_max_bytes="${TELEMETRY_BACKUP_MANIFEST_MAX_BYTES:-1048576}"
portable_relative_root=''
[[ "$minimum_free_bytes" =~ ^[0-9]+$ ]] || exit 2
if [[ "${TELEMETRY_TEST_MODE:-false}" == true && -z "${TELEMETRY_HOME_BACKUP_ROOT_RESERVE_BYTES:-}" ]]; then
  backup_root_reserve_bytes=1
fi
[[ "$backup_cap_bytes" =~ ^[1-9][0-9]*$ &&
   "$backup_warning_bytes" =~ ^[1-9][0-9]*$ &&
   "$backup_root_reserve_bytes" =~ ^[0-9]+$ &&
   "$backup_root_max_used_percent" =~ ^[0-9]+$ &&
   "$backup_max_inflight_bytes" =~ ^[1-9][0-9]*$ &&
   "$backup_max_concurrent" =~ ^[1-9][0-9]*$ &&
   "$emergency_keep" =~ ^[0-9]+$ &&
   "$telemetry_cap_bytes" =~ ^[1-9][0-9]*$ &&
   "$telemetry_warning_bytes" =~ ^[1-9][0-9]*$ &&
   "$telemetry_warning_bytes" -lt "$telemetry_cap_bytes" &&
   "$portable_cap_bytes" =~ ^[0-9]+$ &&
   "$portable_minimum_free_bytes" =~ ^[1-9][0-9]*$ &&
   "$portable_root_reserve_bytes" =~ ^[0-9]+$ &&
   "$manifest_max_bytes" =~ ^[1-9][0-9]*$ ]] || exit 2
(( backup_warning_bytes < backup_cap_bytes )) || exit 2
(( backup_max_concurrent == 1 )) || {
  echo 'backup intake supports exactly one concurrent writer' >&2
  exit 2
}
[[ "$storage_root" =~ ^/[A-Za-z0-9._/-]+$ && "$storage_root" != "/" ]] || exit 2
[[ "$storage_mount" == / || "$storage_mount" =~ ^/[A-Za-z0-9._/-]+$ ]] || exit 2
[[ "$storage_uuid" =~ ^[A-Za-z0-9._-]+$ ]] || exit 2
[[ "$storage_serial" =~ ^[A-Za-z0-9._-]+$ ]] || exit 2
[[ "$storage_fstype" =~ ^[A-Za-z0-9._-]+$ ]] || exit 2
if [[ "$portable_root" == "$TELEMETRY_SEAGATE_MOUNT" ]]; then
  portable_relative_root='.'
elif [[ "$portable_root" == "$TELEMETRY_SEAGATE_MOUNT/"* ]]; then
  portable_relative_root="${portable_root#"$TELEMETRY_SEAGATE_MOUNT/"}"
  [[ -n "$portable_relative_root" &&
     "$portable_relative_root" != /* &&
     "$portable_relative_root" != *'..'* &&
     "$portable_relative_root" != *'//' &&
     "$portable_relative_root" != *'/./'* &&
     "$portable_relative_root" =~ ^[A-Za-z0-9._/-]+$ ]] || exit 2
else
  echo 'portable archive root is outside the configured portable mount' >&2
  exit 2
fi

for command in ssh jq sha256sum stat findmnt mountpoint df duckdb flock head \
  install mktemp mv cp sync date basename dirname realpath readlink udevadm tar awk grep chown; do
  command -v "$command" >/dev/null || {
    echo "required command is missing: $command" >&2
    exit 1
  }
done

common="${ASH_ATLAS_BACKUP_COMMON:-/usr/local/lib/ash-atlas/backup-common.sh}"
[[ -r "$common" ]] || { echo "backup common library is missing: $common" >&2; exit 1; }
# shellcheck source=ash-atlas-backup-common.sh
source "$common"

home_lock="${TELEMETRY_HOME_PULL_LOCK:-/run/lock/ash-atlas-telemetry-home-pull.lock}"
if [[ "${TELEMETRY_TEST_MODE:-false}" == "true" ]]; then
  [[ "$home_lock" == "/run/lock/ash-atlas-telemetry-home-pull.lock" ||
     "$home_lock" == /tmp/ash-atlas-reset-backup-test.*/* ||
     "$home_lock" == /tmp/ash-atlas-database-backup-test.*/* ]] || exit 2
else
  [[ "$home_lock" == "/run/lock/ash-atlas-telemetry-home-pull.lock" ]] || exit 2
fi
exec 9>"$home_lock"
flock -n 9 || exit 0
if [[ -v TELEMETRY_BACKUP_MIGRATION_LOCK ]]; then
  migration_lock="$TELEMETRY_BACKUP_MIGRATION_LOCK"
elif [[ "${TELEMETRY_TEST_MODE:-false}" == true ]]; then
  migration_lock="${home_lock}.migration"
else
  migration_lock=/run/lock/ash-atlas-backup-migration.lock
fi
if [[ "${TELEMETRY_TEST_MODE:-false}" == true ]]; then
  [[ "$migration_lock" == /tmp/ash-atlas-reset-backup-test.*/* ||
     "$migration_lock" == /tmp/ash-atlas-database-backup-test.*/* ]] || exit 2
else
  [[ "$migration_lock" == /run/lock/* ]] || exit 2
fi
exec 10>"$migration_lock"
flock -n 10 || exit 0

[[ -d "$storage_root" && ! -L "$storage_root" &&
   "$(realpath -e -- "$storage_root")" == "$storage_root" ]] || {
  echo "home storage root is absent or unsafe" >&2
  exit 1
}
if [[ "$storage_root" == "$storage_mount" ]]; then
  mountpoint -q -- "$storage_root" || {
    echo "home storage root is not a mounted filesystem" >&2
    exit 1
  }
elif [[ "$storage_mount" == "/" ]]; then
  [[ "$storage_root" == /* ]] || exit 1
else
  [[ "$storage_root" == "$storage_mount/"* ]] || {
    echo "home storage root is outside its configured filesystem" >&2
    exit 1
  }
fi
mount_snapshot="$(findmnt -J -l -T "$storage_root" \
  -o TARGET,SOURCE,FSTYPE,UUID,OPTIONS,FSROOT)" || {
  echo "failed to inspect the home storage filesystem" >&2
  exit 1
}
if ! jq -e \
  --arg target "$storage_mount" \
  --arg uuid "$storage_uuid" \
  --arg fstype "$storage_fstype" \
  --arg test_mode "${TELEMETRY_TEST_MODE:-false}" '
    def clean:
      type == "string"
      and (test("[\u0000-\u001f\u007f]") | not);
    (.filesystems | type == "array")
    and ([.filesystems[] |
      select((.fstype // "") != "autofs")] as $real
    | ($real | length) == 1
    and ($real[0] as $mount
      | ($mount.target | clean)
      and (($mount.source // "") | clean)
      and ($mount.fstype | clean)
      and (($mount.uuid // "") | clean)
      and ($mount.options | clean)
      and ($mount.fsroot | clean)
      and $mount.target == $target
      and ($mount.fstype == $fstype
        or ($test_mode == "true" and $mount.fstype == "tmpfs"))
      and (
        $mount.uuid == $uuid
        or (
          $test_mode == "true"
          and $uuid == "TEST-TMPFS"
          and ($mount.uuid // "") == ""
        )
      )
      and $mount.fsroot == "/"
      and (($mount.options | split(",")) | index("rw")) != null
      and (($mount.options | split(",")) | index("bind")) == null
      and (($mount.options | split(",")) | index("rbind")) == null
    ))
  ' <<<"$mount_snapshot" >/dev/null; then
  echo "home storage backing filesystem identity is invalid or ambiguous" >&2
  exit 1
fi
mounted_target="$(jq -r '.filesystems[] | select((.fstype // "") != "autofs") | .target' \
  <<<"$mount_snapshot")"
mounted_source="$(jq -r '.filesystems[] | select((.fstype // "") != "autofs") | .source // ""' \
  <<<"$mount_snapshot")"
mounted_uuid="$(jq -r '.filesystems[] | select((.fstype // "") != "autofs") | .uuid // ""' \
  <<<"$mount_snapshot")"
mounted_options="$(jq -r '.filesystems[] | select((.fstype // "") != "autofs") | .options' \
  <<<"$mount_snapshot")"
[[ "$mounted_target" == "$storage_mount" ]] || {
  echo "configured home storage mount does not match the backing filesystem" >&2
  exit 1
}
[[ "$mounted_uuid" == "$storage_uuid" ||
   (
     "${TELEMETRY_TEST_MODE:-false}" == "true"
     && "$storage_uuid" == "TEST-TMPFS"
     && -z "$mounted_uuid"
   ) ]] || {
  echo "mounted filesystem UUID does not match the configured home storage UUID" >&2
  exit 1
}
[[ ",$mounted_options," == *,rw,* ]] || {
  echo "home storage filesystem is mounted read-only" >&2
  exit 1
}
if [[ "${TELEMETRY_TEST_MODE:-false}" == "true" ]]; then
  mounted_serial="${TELEMETRY_TEST_DEVICE_SERIAL:-TEST-SERIAL}"
else
  [[ "$mounted_source" == /dev/* ]] || {
    echo "home storage mount source is not a block device" >&2
    exit 1
  }
  mounted_device="$(readlink -f -- "$mounted_source")"
  [[ "$mounted_device" == /dev/* ]] || {
    echo "home storage block-device source cannot be resolved" >&2
    exit 1
  }
  mounted_serial="$(
    udevadm info --query=property --name="$mounted_device" |
      awk -F= '$1 == "ID_SERIAL_SHORT" {print substr($0, index($0, "=") + 1); exit}'
  )"
fi
[[ -n "$mounted_serial" && "$mounted_serial" == "$storage_serial" ]] || {
  echo "mounted device serial does not match the configured home storage serial" >&2
  exit 1
}

# The portable disk is an independent commit target.  Never substitute the
# root filesystem or the internal intake when it is absent, read-only, or has
# the wrong UUID/serial.  Database handoffs remain staged locally for a later
# retry, but no VPS acknowledgment is sent until this target is valid.
portable_available=false
  if [[ -d "$TELEMETRY_SEAGATE_MOUNT" ]] && ash_backup_validate_storage \
    "$TELEMETRY_SEAGATE_MOUNT" "$TELEMETRY_SEAGATE_MOUNT" \
    "$TELEMETRY_SEAGATE_UUID" "$TELEMETRY_SEAGATE_SERIAL" \
    "${TELEMETRY_SEAGATE_FSTYPE:-ntfs3}" \
    'portable backup archive' &&
    ash_backup_require_portable_mount "$TELEMETRY_SEAGATE_MOUNT"; then
  # Pin the current mount as the working directory before creating the
  # archive root.  An absolute mkdir could recreate the mountpoint on the
  # root filesystem if the portable disk disappears between the checks.
  if ! (
    cd -- "$TELEMETRY_SEAGATE_MOUNT" &&
    ash_backup_require_portable_mount "$TELEMETRY_SEAGATE_MOUNT" &&
    install -d -m 0750 -- "$portable_relative_root" &&
    ash_backup_require_portable_mount "$TELEMETRY_SEAGATE_MOUNT"
  ); then
    echo 'portable backup archive directory creation failed' >&2
    exit 1
  fi
  if ash_backup_require_portable_root "$portable_root" "$TELEMETRY_SEAGATE_MOUNT"; then
    portable_available=true
  fi
fi
if [[ "$portable_available" != true ]]; then
  echo 'portable backup archive is unavailable; no HOME payload download is admitted' >&2
  exit 1
fi

root="${storage_root}/ash-atlas-telemetry"
archive_root="${root}/archive"
partial_root="${root}/partial"
rejected_root="${root}/rejected"
logs_root="${root}/logs"
install -d -m 0750 -o "${archive_owner%%:*}" -g "${archive_owner#*:}" \
  "$root" "$archive_root" "$partial_root" "$rejected_root" "$logs_root"
[[ "$(stat -c '%U:%G' "$root")" == "$archive_owner" ]] || {
  echo "telemetry archive ownership mismatch" >&2
  exit 1
}
available_bytes="$(df -PB1 "$root" | awk 'NR==2 {print $4}')"
(( available_bytes >= minimum_free_bytes )) || {
  echo "insufficient home storage free space" >&2
  exit 1
}

ssh_options=(
  -T
  -o BatchMode=yes
  -o IdentitiesOnly=yes
  -o StrictHostKeyChecking=yes
  -o "UserKnownHostsFile=${TELEMETRY_KNOWN_HOSTS}"
  -o "IdentityFile=${TELEMETRY_SSH_KEY}"
  -o ClearAllForwardings=yes
  -o ConnectTimeout=15
)
ssh_destination="${TELEMETRY_VPS_USER}@${TELEMETRY_VPS_HOST}"

# A pull can fetch several artifacts and receipts. Reuse one authenticated
# transport so the restricted protocol cannot trip SSH connection-rate limits.
ssh_control_dir="$(mktemp -d "$(dirname "$home_lock")/ash-atlas-telemetry-ssh.XXXXXXXX")"
chmod 0700 "$ssh_control_dir"
ssh_options+=(
  -o ControlMaster=auto
  -o ControlPersist=60
  -o "ControlPath=${ssh_control_dir}/control"
)
cleanup_ssh_control() {
  ssh "${ssh_options[@]}" -O exit "$ssh_destination" >/dev/null 2>&1 || true
  rm -rf -- "$ssh_control_dir"
}
trap cleanup_ssh_control EXIT

remote() {
  # The argument is deliberately the complete, validated forced-command
  # protocol request; no local shell evaluates it.
  # shellcheck disable=SC2029
  local budget=580
  if [[ -n "${ASH_ATLAS_BACKUP_DEADLINE:-}" ]]; then
    budget=$(( ASH_ATLAS_BACKUP_DEADLINE - $(date +%s) - 20 ))
    (( budget > 0 )) || return 124
  fi
  case "$1" in
    database-ack\ *|reset-ack\ *)
      timeout --kill-after=5 "$budget" ssh "${ssh_options[@]}" "$ssh_destination" "$1" ;;
    *) timeout --kill-after=5 "$budget" ssh -n "${ssh_options[@]}" "$ssh_destination" "$1" ;;
  esac
}

safe_name() {
  [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,239}$ ]]
}

# Bound every remote response before it reaches the intake filesystem.  A
# producer that emits even one byte beyond the declared limit is rejected;
# this keeps a malformed fetch from bypassing the aggregate cap before the
# post-transfer byte/checksum checks run.
receive_remote_bounded() {
  local request="$1" target="$2" maximum="$3" actual
  [[ "$maximum" =~ ^[1-9][0-9]*$ ]] || return 1
  if ! remote "$request" | head -c "$((maximum + 1))" >"$target"; then
    return 1
  fi
  actual="$(stat -c '%s' "$target")" || return 1
  [[ "$actual" =~ ^[0-9]+$ ]] && (( actual <= maximum ))
}

reject_telemetry() {
  local reason="$1"
  rm -rf -- "$work" || return 1
  ((rejected_manifests += 1))
  echo "telemetry manifest rejected: ${reason}: ${manifest_name}" >&2
}

pull_database_backups() {
  local database_root="${ASH_ATLAS_DATABASE_BACKUP_REMOTE_DIRECTORY:-}"
  [[ -n "$database_root" ]] || return 0
  command -v pg_restore >/dev/null || {
    echo "required database-backup command is missing: pg_restore" >&2
    return 1
  }
  [[ "$database_root" =~ ^/[A-Za-z0-9._/-]+$ &&
     "$database_root" == "${storage_root}/"* &&
     "$database_root" != "$storage_root" &&
     "$database_root" != *"//"* && "$database_root" != *"/../"* &&
     "$database_root" != *"/./"* ]] || {
    echo "database backup destination is unsafe" >&2
    return 1
  }
  [[ -d "$database_root" && ! -L "$database_root" &&
     "$(realpath -e -- "$database_root")" == "$database_root" ]] || {
    echo "database backup destination is absent or unsafe" >&2
    return 1
  }
  [[ "$(stat -c '%U:%G' "$database_root")" == "$archive_owner" ]] || {
    echo "database backup destination ownership mismatch" >&2
    return 1
  }
  local database_mode
  database_mode="$(stat -c '%a' "$database_root")"
  (( (8#$database_mode & 8#022) == 0 )) || {
    echo "database backup destination is group/world writable" >&2
    return 1
  }

  local database_partial_root="${database_root}/.partial"
  local database_spool_root="${database_root}/.spool"
  # Emergency copies are deliberately isolated from the source intake.  The
  # source dump remains available for recovery/retry; pruning this directory
  # must never delete a retained intake artifact merely because both names end
  # in .dump.
  local database_emergency_root="${database_root}/emergency"
  local database_receipt_root="${database_root}/receipts"
  install -d -m 0700 -o "${archive_owner%%:*}" -g "${archive_owner#*:}" \
    "$database_partial_root" "$database_spool_root" "$database_emergency_root"
  install -d -m 0750 -o "${archive_owner%%:*}" -g "${archive_owner#*:}" \
    "$database_receipt_root"

  local reset_budget_root="${ASH_ATLAS_RESET_BACKUP_REMOTE_DIRECTORY:-}"
  [[ -n "$reset_budget_root" && "$reset_budget_root" != "$storage_root" ]] || {
    echo 'reset backup budget root is missing or unsafe' >&2
    return 1
  }
  [[ -d "$reset_budget_root" && ! -L "$reset_budget_root" ]] || {
    echo 'reset backup budget root is absent or unsafe' >&2
    return 1
  }
  local backup_deferred=0

  local ready_output
  local database_listing=database-retained-list
  # Old disposable fixtures without a cutover baseline exercise pending-only
  # compatibility. Production and baseline/explicit cutover always see ACKed
  # retained history as well, so missing Portable proof can be earned once.
  if [[ "${TELEMETRY_TEST_MODE:-false}" == true && -z "${TELEMETRY_BACKUP_CUTOVER_BASELINE:-}" ]]; then
    database_listing=database-list
  fi
  if ! ready_output="$(remote "$database_listing")"; then
    echo "failed to list ready PostgreSQL backups" >&2
    return 1
  fi
  local manifests=()
  if [[ -n "$ready_output" ]]; then
    mapfile -t manifests <<<"$ready_output"
  fi
  # Retained history includes backups the VPS already source-ACKed (possibly by
  # an older home system). The VPS keeps that first ACK and denies a different
  # one, so only manifests still pending there are source-ACKed again.
  declare -A source_ack_pending=()
  local pending_output pending_manifest
  if [[ "$database_listing" == database-retained-list ]]; then
    if ! pending_output="$(remote database-list)"; then
      echo "failed to list pending PostgreSQL backups" >&2
      return 1
    fi
    while IFS= read -r pending_manifest; do
      [[ -z "$pending_manifest" ]] || source_ack_pending[$pending_manifest]=1
    done <<<"$pending_output"
  fi
  source_ack_needed() {
    [[ "$database_listing" != database-retained-list || -n "${source_ack_pending[$1]:-}" ]]
  }
  local manifest_name
  local selection_inventory="$database_partial_root/selection.jsonl"
  local selection_health="$database_partial_root/selection-health.json"
  local verification_manifest_root="$database_root/.verification-manifests"
  install -d -o root -g root -m 0700 "$verification_manifest_root"
  : >"$selection_inventory"
  declare -A work_by_manifest=()
  local catalog_index="$database_partial_root/copy-catalog.jsonl"
  : >"$catalog_index"
  if [[ -d "$storage_root/.copy-verifications" && ! -L "$storage_root/.copy-verifications" &&
        "$(stat -c '%u:%a' "$storage_root/.copy-verifications")" == 0:700 ]]; then
    while IFS= read -r -d '' catalog_record; do
      [[ ! -L "$catalog_record" && "$(stat -c '%u:%a' "$catalog_record")" == 0:600 ]] || return 1
      jq -c --arg record "$catalog_record" '. + {recordPath:$record}' "$catalog_record" >>"$catalog_index"
    done < <(find "$storage_root/.copy-verifications" -maxdepth 1 -type f -name '*.json' -print0)
  fi
  for manifest_name in "${manifests[@]}"; do
    if ! safe_name "$manifest_name" || [[ "$manifest_name" != *.dump.ready.json ]]; then
      echo "VPS returned an unsafe PostgreSQL backup manifest name" >&2
      return 1
    fi

    local work manifest
    work="$(mktemp -d "${database_partial_root}/database.XXXXXXXX")"
    manifest="${work}/${manifest_name}"
    receive_remote_bounded "database-fetch ${manifest_name}" "$manifest" "$manifest_max_bytes" || return 1
    jq -e '.manifestVersion == 1 and .kind == "ash_atlas_postgresql_backup"
      and (.backupId | test("^[a-f0-9-]{36}$"))
      and (.backupClass | IN("hourly","daily","weekly","monthly","pre-migration","milestone"))
      and (.database | test("^[a-z][a-z0-9_]{0,62}$")) and (.releaseSha | test("^[a-f0-9]{40}$"))
      and (.createdAtUtc | fromdateiso8601)
      and (.artifact.fileName | test("^[A-Za-z0-9][A-Za-z0-9._-]{0,239}$"))
      and .artifact.format == "postgresql-custom" and (.artifact.bytes | type == "number" and . > 0)
      and (.artifact.sha256 | test("^[a-f0-9]{64}$")) and .acknowledgmentState == "pending"' "$manifest" >/dev/null || return 1
    work_by_manifest[$manifest_name]="$work"
    local metadata_id metadata_file metadata_receipt metadata_green=false catalog_record catalog_path
    metadata_id="$(jq -er '.backupId' "$manifest")"
    metadata_file="$(jq -er '.artifact.fileName' "$manifest")"
    [[ "$metadata_file.ready.json" == "$manifest_name" ]] || return 1
    metadata_receipt="$database_receipt_root/$metadata_file.receipt.json"
    if [[ -d "$storage_root/.copy-verifications" &&
          "$(stat -c '%u:%a' "$storage_root/.copy-verifications")" == 0:700 && -f "$metadata_receipt" ]]; then
      while IFS= read -r -d '' catalog_record; do
        [[ ! -L "$catalog_record" && "$(stat -c '%u:%a' "$catalog_record")" == 0:600 ]] || continue
        catalog_path="$(jq -er --arg id "$metadata_id" 'select(.id == $id) | .path' "$catalog_record" 2>/dev/null || true)"
        [[ "$catalog_path" == "$TELEMETRY_SEAGATE_MOUNT/"* ]] || continue
        local catalog_portable_receipt=''
        [[ "$catalog_path" != "$portable_root/postgresql/"* ]] || catalog_portable_receipt="$(dirname "$catalog_path")/portable-receipt.json"
        if ash_backup_verify_copy fast postgresql "$metadata_id" "$catalog_path" \
          "$(jq -r '.artifact.bytes' "$manifest")" "$(jq -r '.artifact.sha256' "$manifest")" \
          "$manifest" "$metadata_receipt" "$catalog_portable_receipt" >/dev/null; then
          metadata_green=true
          break
        fi
      done < <(jq -sr --arg id "$metadata_id" '.[] | select(.id == $id) | .recordPath' "$catalog_index" | while IFS= read -r record; do printf '%s\0' "$record"; done)
    fi
    jq -c --argjson green "$metadata_green" '. + {green:$green}' "$manifest" >>"$selection_inventory"
    if [[ -f "$verification_manifest_root/$manifest_name" ]]; then
      cmp -s "$manifest" "$verification_manifest_root/$manifest_name" || {
        echo "immutable manifest changed: $metadata_id" >&2; return 1;
      }
    else
      install -o root -g root -m 0600 "$manifest" "$verification_manifest_root/$manifest_name"
      sync -f "$verification_manifest_root/$manifest_name"
    fi
  done
  local selected_ids=''
  if [[ "${TELEMETRY_TEST_MODE:-false}" == true && ! -e "${TELEMETRY_BACKUP_CUTOVER_BASELINE:-/var/lib/ash-atlas/backup-cutover-baseline.json}" ]]; then
    selected_ids="$(jq -sr '.[].backupId' "$selection_inventory")"
  else
    remote database-health >"$selection_health" || return 1
    selected_ids="$(ash_backup_select_database_work "$selection_inventory" \
      "${TELEMETRY_BACKUP_CUTOVER_BASELINE:-/var/lib/ash-atlas/backup-cutover-baseline.json}" \
      "$selection_health" "${ASH_ATLAS_DATABASE_BACKUP_ID:-}")" || {
      echo 'missing/malformed fixed cutover baseline; payload selection stopped' >&2; return 1;
    }
  fi
  declare -A admitted=()
  while IFS= read -r metadata_id; do [[ -z "$metadata_id" ]] || admitted[$metadata_id]=1; done <<<"$selected_ids"
  if [[ -f "${TELEMETRY_BACKUP_CUTOVER_BASELINE:-/var/lib/ash-atlas/backup-cutover-baseline.json}" ]]; then
    jq -s --slurpfile baseline "${TELEMETRY_BACKUP_CUTOVER_BASELINE:-/var/lib/ash-atlas/backup-cutover-baseline.json}" \
      --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '
      ($baseline[0].backups|map(.backupId)) as $old |
      [.[] | select(.green!=true) | select(.backupId as $id | ($old|index($id))==null)] as $new |
      {selectionStateVersion:1,catalogCheckedAtUtc:$now,newPendingCount:($new|length),
       newestPendingCreatedAtUtc:($new|map(.createdAtUtc)|max // null),
       oldestPendingCreatedAtUtc:($new|map(.createdAtUtc)|min // null)}' "$selection_inventory" \
      >"$storage_root/.backup-selection-state.json.partial"
    chmod 0600 "$storage_root/.backup-selection-state.json.partial"
    sync -f "$storage_root/.backup-selection-state.json.partial"
    mv -f "$storage_root/.backup-selection-state.json.partial" "$storage_root/.backup-selection-state.json"
  fi
  # Preserve selector order: new work first, then one historical expiry slot.
  local selected_manifests=()
  while IFS= read -r metadata_id; do
    [[ -n "$metadata_id" ]] || continue
    selected_manifests+=("$(jq -rs --arg id "$metadata_id" '.[] | select(.backupId == $id) | .artifact.fileName + ".ready.json"' "$selection_inventory")")
  done <<<"$selected_ids"
  for manifest_name in "${manifests[@]}"; do
    work="${work_by_manifest[$manifest_name]}"
    metadata_id="$(jq -er '.backupId' "$work/$manifest_name")"
    if [[ -z "${admitted[$metadata_id]+present}" ]]; then
      printf 'backupId=%s result=legacy-deferred payloadBytesRead=0\n' "$metadata_id"
      rm -rf -- "$work"
    fi
  done
  for manifest_name in "${selected_manifests[@]}"; do
    if [[ -n "${ASH_ATLAS_BACKUP_DEADLINE:-}" ]] && (( $(date +%s) >= ASH_ATLAS_BACKUP_DEADLINE - 20 )); then
      echo 'backup pull partial: payload deadline reached' >&2
      return 1
    fi
    work="${work_by_manifest[$manifest_name]}"
    manifest="$work/$manifest_name"
    export ASH_ATLAS_BACKUP_VERIFICATION_MANIFEST="$verification_manifest_root/$manifest_name"
    local file_name expected_bytes expected_sha backup_id staged available_bytes final
    local stage_dir spool_dir spool_manifest spool_dump receipt source_ack_id
    local receipt_temporary acknowledgment_id verified_at portable_artifact existing_portable candidate_portable
    local existing_receipt_identity legacy_remote_path mapping_path
    local source_release_eligible
    file_name="$(jq -r '.artifact.fileName' "$manifest")"
    safe_name "$file_name" || {
      rm -rf -- "$work"
      return 1
    }
    expected_bytes="$(jq -r '.artifact.bytes' "$manifest")"
    expected_sha="$(jq -r '.artifact.sha256' "$manifest")"
    backup_id="$(jq -r '.backupId' "$manifest")"
    final="${database_root}/${file_name}"
    receipt="$database_receipt_root/$file_name.receipt.json"
    spool_dir="${database_spool_root}/backup-${backup_id}"
    existing_portable=''
    source_release_eligible=false
    mapping_path="$database_root/.portable-mappings/backup-$backup_id.json"
    if [[ -f "$receipt" && ! -L "$receipt" ]]; then
      existing_receipt_identity=false
      if jq -e --arg id "$backup_id" --arg file "$file_name" \
        --arg sha "$expected_sha" --argjson bytes "$expected_bytes" '
          .acknowledgmentVersion == 1
          and .event == "ash_atlas_postgresql_backup_verified"
          and .backupId == $id and .backupFileName == $file
          and .sha256 == $sha and .bytes == $bytes
          and (.acknowledgmentId | test("^[a-f0-9-]{36}$"))
          and .restoreCatalogVerified == true
        ' "$receipt" >/dev/null; then
        existing_receipt_identity=true
      fi
      if [[ "$existing_receipt_identity" == true ]]; then
        # A receipt can already be durable while its first canonical portable
        # rename is interrupted.  Let the verified spool retry that handoff;
        # an old intake-relative receipt, however, has no safe source to
        # redownload from and must fail closed if its mapped mirror is absent.
        legacy_remote_path="$(jq -er '.remotePath // empty' "$receipt" 2>/dev/null || true)"
        candidate_portable="$(ash_backup_resolve_portable_database_path \
          "$receipt" "$database_root" "$storage_root" \
          "$TELEMETRY_SEAGATE_MOUNT" "$backup_id" "$file_name" \
          "$expected_bytes" "$expected_sha" deep || true)"
        if [[ -z "$candidate_portable" && \
              "$legacy_remote_path" == "$storage_root/"* &&
              ! -d "$spool_dir" ]]; then
          rm -rf -- "$work"
          echo "existing PostgreSQL receipt has no verified portable mapping: $backup_id" >&2
          return 1
        fi
        # For a new receipt, a missing canonical path is recoverable only when
        # the matching verified spool is still available below.  Do not mark
        # it as an existing portable copy until the resolver found a file.
        existing_portable="$candidate_portable"
        if [[ -f "$mapping_path" && ! -L "$mapping_path" ]] &&
           jq -e '.sourceRetentionPolicy == "emergency-only"' \
             "$mapping_path" >/dev/null; then
          source_release_eligible=true
        fi
      fi
    fi
    staged="${work}/${file_name}.partial"
    if [[ -z "$existing_portable" ]]; then
      local portable_free portable_total portable_minimum
      read -r portable_free portable_total < <(df -PB1 "$TELEMETRY_SEAGATE_MOUNT" | awk 'NR==2{print $4,$2}')
      [[ "$portable_free" =~ ^[0-9]+$ && "$portable_total" =~ ^[1-9][0-9]*$ ]] || return 1
      portable_minimum=$(( portable_total / 10 ))
      (( portable_minimum >= portable_minimum_free_bytes )) || portable_minimum="$portable_minimum_free_bytes"
      (( portable_free >= portable_minimum + expected_bytes )) || { echo 'portable capacity refuses incoming payload' >&2; return 1; }
    fi
    if (( expected_bytes > backup_max_inflight_bytes )); then
      rm -rf -- "$work"
      echo "PostgreSQL backup exceeds the configured inflight peak" >&2
      return 1
    fi
    if ! ash_backup_require_bounded_capacity \
      "$storage_root" "$backup_cap_bytes" "$backup_warning_bytes" \
      "$((expected_bytes * 2))" "$backup_root_reserve_bytes" \
      "$backup_root_max_used_percent" \
      >"${work}/capacity.txt"; then
      rm -rf -- "$work"
      echo "insufficient bounded home-storage capacity for PostgreSQL backup" >&2
      return 1
    fi

    if [[ -n "$existing_portable" ]]; then
      if [[ "$portable_available" != true ]]; then
        rm -rf -- "$work"
        ((backup_deferred += 1))
        echo "verified existing portable copy is unavailable; backup remains pending: $backup_id" >&2
        continue
      fi
      [[ -f "$existing_portable" && ! -L "$existing_portable" &&
         "$(realpath -e -- "$existing_portable")" == "$existing_portable" &&
         "$(stat -c '%s' "$existing_portable")" == "$expected_bytes" ]] ||
        {
          rm -rf -- "$work"
          echo "existing portable copy failed its manifest checksum: $backup_id" >&2
          return 1
        }
      if [[ -f "$final" && ! -L "$final" ]]; then
        ash_backup_verify_copy fast postgresql "$backup_id" "$final" "$expected_bytes" "$expected_sha" \
          "$manifest" "$receipt" '' >/dev/null ||
          ash_backup_verify_copy deep postgresql "$backup_id" "$final" "$expected_bytes" "$expected_sha" \
            "$manifest" "$receipt" '' >/dev/null || return 1
      fi
      if ! jq -e --arg id "$backup_id" --arg file "$file_name" --arg sha "$expected_sha" \
        --argjson bytes "$expected_bytes" '
          .acknowledgmentVersion == 1
          and .event == "ash_atlas_postgresql_backup_verified"
          and .backupId == $id and .backupFileName == $file
          and .sha256 == $sha and .bytes == $bytes
          and (.acknowledgmentId | test("^[a-f0-9-]{36}$"))
          and .restoreCatalogVerified == true
        ' "$receipt" >/dev/null; then
        rm -rf -- "$work"
        echo "existing portable copy has no immutable source receipt: $backup_id" >&2
        return 1
      fi
      legacy_remote_path="$(jq -er '.remotePath // empty' "$receipt" 2>/dev/null || true)"
      if [[ "$legacy_remote_path" == "$storage_root/"* ]]; then
        ash_backup_record_portable_mapping \
          "$receipt" "$database_root" "$storage_root" \
          "$TELEMETRY_SEAGATE_MOUNT" "$backup_id" "$file_name" \
          "$expected_bytes" "$expected_sha" "$existing_portable" || {
          rm -rf -- "$work"
          echo "portable placement mapping could not be persisted: $backup_id" >&2
          return 1
        }
      fi
      source_ack_id="$(jq -r '.acknowledgmentId' "$receipt")"
      if ! source_ack_needed "$manifest_name"; then
        echo "already source-acknowledged on VPS; not re-sending: $backup_id" >&2
      elif ! remote "database-ack $manifest_name" <"$receipt"; then
        rm -rf -- "$work"
        echo "existing portable copy was verified but VPS acknowledgment failed: $backup_id" >&2
        return 1
      fi
      if [[ "$source_release_eligible" == true ]]; then
        ash_backup_release_managed_source \
          "$database_root" "$file_name" "$expected_bytes" "$expected_sha" || {
          rm -rf -- "$work"
          echo "managed PostgreSQL source release failed: $backup_id" >&2
          return 1
        }
      fi
      rm -rf -- "$work"
      echo "adopted verified existing portable copy without redownload: $backup_id" >&2
      continue
    fi

    stage_dir="$work"
    if [[ -e "$spool_dir" ]]; then
      spool_manifest="$spool_dir/$manifest_name"
      spool_dump="$spool_dir/$file_name"
      if [[ ! -d "$spool_dir" || -L "$spool_dir" ||
            ! -f "$spool_manifest" || -L "$spool_manifest" ||
            ! -f "$spool_dump" || -L "$spool_dump" ||
            "$(stat -c '%s' "$spool_dump")" != "$expected_bytes" ||
            "$(sha256sum "$spool_dump" | awk '{print $1}')" != "$expected_sha" ]] ||
         ! jq -e --arg id "$backup_id" --arg sha "$expected_sha" \
           --argjson bytes "$expected_bytes" \
           '.backupId == $id and .artifact.sha256 == $sha and .artifact.bytes == $bytes' \
           "$spool_manifest" >/dev/null; then
        rm -rf -- "$work"
        echo "existing staged PostgreSQL backup does not match the pending handoff" >&2
        return 1
      fi
      rm -rf -- "$work"
      stage_dir="$spool_dir"
      manifest="$spool_manifest"
    else
      if ! receive_remote_bounded "database-fetch ${file_name}" \
        "$staged" "$expected_bytes"; then
        rm -rf -- "$work"
        echo "PostgreSQL backup transfer was interrupted" >&2
        return 1
      fi
      [[ "$(stat -c '%s' "$staged")" == "$expected_bytes" ]] || {
        rm -rf -- "$work"
        echo "PostgreSQL backup byte count differs" >&2
        return 1
      }
      [[ "$(sha256sum "$staged" | awk '{print $1}')" == "$expected_sha" ]] || {
        rm -rf -- "$work"
        echo "PostgreSQL backup checksum differs" >&2
        return 1
      }
      pg_restore --list "$staged" >/dev/null || {
        rm -rf -- "$work"
        echo "PostgreSQL backup restore catalog is invalid" >&2
        return 1
      }
      chmod 0600 "$staged" || {
        rm -rf -- "$work"
        return 1
      }
      chown "$archive_owner" "$staged" || {
        rm -rf -- "$work"
        return 1
      }
      sync -f "$staged" || {
        rm -rf -- "$work"
        return 1
      }
      mv -- "$staged" "$work/$file_name" || {
        rm -rf -- "$work"
        echo "PostgreSQL backup staging publication failed" >&2
        return 1
      }
    fi

    receipt="${database_receipt_root}/${file_name}.receipt.json"
    verified_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    if [[ -f "$receipt" && ! -L "$receipt" ]]; then
      jq -e --arg id "$backup_id" --arg class "$(jq -r '.backupClass' "$manifest")" \
        --arg manifest "$manifest_name" --arg file "$file_name" --arg sha "$expected_sha" \
        --arg database "$(jq -r '.database' "$manifest")" \
        --arg release "$(jq -r '.releaseSha' "$manifest")" \
        --arg created "$(jq -r '.createdAtUtc' "$manifest")" --argjson bytes "$expected_bytes" '
          .acknowledgmentVersion == 1
          and .event == "ash_atlas_postgresql_backup_verified"
          and .backupId == $id and .backupClass == $class
          and .manifestFileName == $manifest and .backupFileName == $file
          and .sha256 == $sha and .bytes == $bytes
          and .database == $database and .releaseSha == $release
          and .createdAtUtc == $created and (.acknowledgmentId | test("^[a-f0-9-]{36}$"))
          and .restoreCatalogVerified == true
        ' "$receipt" >/dev/null || {
          rm -rf -- "$work"
          echo "source receipt conflicts with the pending backup ID/hash" >&2
          return 1
        }
    else
      acknowledgment_id="$(cat /proc/sys/kernel/random/uuid)"
      receipt_temporary="$(mktemp "${database_receipt_root}/.${file_name}.receipt.XXXXXXXX")"
      jq -cn \
        --arg acknowledgmentId "$acknowledgment_id" \
        --arg backupId "$backup_id" \
        --arg backupClass "$(jq -r '.backupClass' "$manifest")" \
        --arg manifestFileName "$manifest_name" \
        --arg backupFileName "$file_name" \
          --arg remotePath "$final" \
        --arg sha256 "$expected_sha" \
        --arg database "$(jq -r '.database' "$manifest")" \
        --arg releaseSha "$(jq -r '.releaseSha' "$manifest")" \
        --arg createdAtUtc "$(jq -r '.createdAtUtc' "$manifest")" \
        --arg remoteVerifiedAtUtc "$verified_at" \
        --argjson bytes "$expected_bytes" '
          {
            acknowledgmentVersion:1,
            event:"ash_atlas_postgresql_backup_verified",
            acknowledgmentId:$acknowledgmentId,
            backupId:$backupId,
            backupClass:$backupClass,
            manifestFileName:$manifestFileName,
            backupFileName:$backupFileName,
            remotePath:$remotePath,
             sha256:$sha256,
            bytes:$bytes,
            database:$database,
            releaseSha:$releaseSha,
            createdAtUtc:$createdAtUtc,
            remoteVerifiedAtUtc:$remoteVerifiedAtUtc,
            restoreCatalogVerified:true
          }
        ' >"$receipt_temporary"
      chmod 0640 "$receipt_temporary"
      chown "$archive_owner" "$receipt_temporary"
      sync -f "$receipt_temporary"
      mv -- "$receipt_temporary" "$receipt"
      sync -f "$database_receipt_root"
      source_release_eligible=true
    fi
    source_ack_id="$(jq -r '.acknowledgmentId' "$receipt")"

    if [[ "$portable_available" != true ]]; then
      if [[ "$stage_dir" != "$spool_dir" ]]; then
        mv -- "$stage_dir" "$spool_dir"
      fi
      ((backup_deferred += 1))
      echo "PostgreSQL backup staged pending portable archive: $backup_id" >&2
      continue
    fi

    manifest_path="$stage_dir/$manifest_name"
    portable_artifact="$(ash_backup_commit_portable_database \
      "$stage_dir" "$portable_root" "$backup_id" "$file_name" \
      "$manifest_path" "$receipt" "$archive_owner" \
      "$portable_minimum_free_bytes" "$portable_cap_bytes" \
      "$portable_root_reserve_bytes")" || {
      if [[ "$stage_dir" != "$spool_dir" ]]; then
        mv -- "$stage_dir" "$spool_dir"
      fi
      echo "portable PostgreSQL archive commit failed: $backup_id" >&2
      return 1
    }
    ash_backup_record_portable_mapping \
      "$receipt" "$database_root" "$storage_root" "$TELEMETRY_SEAGATE_MOUNT" \
      "$backup_id" "$file_name" "$expected_bytes" "$expected_sha" \
      "$portable_artifact" || {
      echo "portable PostgreSQL placement mapping failed: $backup_id" >&2
      return 1
    }
    if [[ "$source_release_eligible" == true ]]; then
      ash_backup_mark_source_release_eligible \
        "$database_root" "$backup_id" "$file_name" "$receipt" || {
        echo "portable PostgreSQL source-retention marker failed: $backup_id" >&2
        return 1
      }
    fi

    # Publish the verified source intake copy before the VPS acknowledgment.
    # Newly managed copies are released after that acknowledgment; the
    # emergency directory remains the bounded local recovery set. Legacy
    # receipts without the HOME-only marker remain untouched for migration.
    if [[ -e "$final" ]]; then
      [[ -f "$final" && ! -L "$final" &&
         "$(realpath -e -- "$final")" == "$final" &&
         "$(stat -c '%s' "$final")" == "$expected_bytes" &&
         "$(sha256sum "$final" | awk '{print $1}')" == "$expected_sha" ]] || {
        echo "existing PostgreSQL source copy conflicts with the portable handoff: $backup_id" >&2
        return 1
      }
    else
      mv -- "$stage_dir/$file_name" "$final" || return 1
      sync -f "$final" || return 1
      sync -f "$database_root" || return 1
    fi
    ash_backup_verify_copy fast postgresql "$backup_id" "$final" "$expected_bytes" "$expected_sha" \
      "$manifest_path" "$receipt" '' >/dev/null ||
      ash_backup_verify_copy deep postgresql "$backup_id" "$final" "$expected_bytes" "$expected_sha" \
        "$manifest_path" "$receipt" '' >/dev/null || return 1

    # Keep only the newest two verified emergency dumps on NVMe.  This copy is
    # intentionally before the VPS acknowledgment; a failed acknowledgment
    # leaves both the portable commit and the retryable source receipt intact.
    # A retry may be completing a dump that was left in .spool while the
    # portable disk was unavailable.  It still earns an emergency copy only
    # after this verified source publication, regardless of which staging
    # directory supplied the bytes.
    cp -- "$final" "$database_emergency_root/$file_name" || return 1
    chmod 0600 "$database_emergency_root/$file_name" || return 1
    chown "$archive_owner" "$database_emergency_root/$file_name" || return 1
    sync -f "$database_emergency_root/$file_name" || return 1
    ash_backup_verify_copy deep postgresql "$backup_id" "$database_emergency_root/$file_name" \
      "$expected_bytes" "$expected_sha" "$manifest_path" "$receipt" '' >/dev/null || return 1
    ash_backup_prune_emergency_dumps "$database_emergency_root" "$emergency_keep" || return 1

    if ! source_ack_needed "$manifest_name"; then
      echo "already source-acknowledged on VPS; not re-sending: $backup_id" >&2
    elif ! remote "database-ack ${manifest_name}" <"$receipt"; then
      # The portable commit, source receipt, and source intake copy are
      # already durable.  Do not strand a partial spool that no longer owns
      # the dump after a transient acknowledgment failure.
      rm -rf -- "$stage_dir" || return 1
      echo "portable commit exists but VPS acknowledgment failed: $backup_id" >&2
      return 1
    fi
    if [[ "$source_release_eligible" == true ]]; then
      ash_backup_release_managed_source \
        "$database_root" "$file_name" "$expected_bytes" "$expected_sha" || {
        echo "managed PostgreSQL source release failed: $backup_id" >&2
        return 1
      }
    fi
    if [[ "$stage_dir" == "$spool_dir" ]]; then
      rm -rf -- "$spool_dir"
    else
      rm -rf -- "$stage_dir"
    fi
  done

  (( backup_deferred == 0 )) || {
    echo "${backup_deferred} PostgreSQL backup(s) remain staged pending portable archive" >&2
    return 1
  }

  local health health_file health_temporary
  if ! health="$(remote database-health)" || ! jq -e '
      .version == 1
      and (.checkedAtUtc | fromdateiso8601)
      and (.status | IN("ok","problem"))
      and (.mountStatus | IN("ok","problem"))
      and (.readWriteStatus | IN("ok","problem"))
      and (.capacityStatus | IN("ok","problem"))
      and (.backupFreshnessStatus | IN("ok","problem"))
      and (.catalogStatus | IN("ok","problem","unknown"))
      and (.availableBytes | type == "number" and . >= 0)
      and (.requiredFreeBytes | type == "number" and . > 0)
      and (.latestBackupAgeMinutes | type == "number" and . >= -1)
      and ((.freeBytes // .availableBytes) | type == "number" and . >= 0)
      and ((.requiredHeadroomBytes // .requiredFreeBytes) |
        type == "number" and . > 0)
      and ((.headroomMarginBytes // 0) | type == "number")
      and ((.beyondLimitCount // 0) | type == "number" and . >= 0)
      and ((.beyondLimitBytes // 0) | type == "number" and . >= 0)
      and ((.currentlyEligibleCount // 0) | type == "number" and . >= 0)
      and ((.proofAgeMinutes // -1) | type == "number" and . >= -1)
      and ((.latestScrubResult // "unknown") | IN("ok","problem","unknown"))
      and ((.offsiteReachability // "unknown") | IN("reachable","unreachable","unknown"))
      and ((.projectedBackupsUntilExhaustion // -1) | type == "number" and . >= -1)
      and ((.projectedHoursUntilExhaustion // -1) | type == "number" and . >= -1)
      and ((.capacityAlert // "critical") | IN("ok","warning","critical"))
    ' <<<"$health" >/dev/null; then
    echo 'VPS PostgreSQL health response is absent or malformed' >&2
    return 1
  fi
  health_file="${storage_root}/.ash-atlas-ovh-database-health.json"
  health_temporary="$(mktemp "${storage_root}/.database-health.XXXXXXXX")"
  printf '%s\n' "$health" >"$health_temporary"
  chmod 0640 "$health_temporary"
  chown "$archive_owner" "$health_temporary"
  sync -f "$health_temporary"
  mv -f -- "$health_temporary" "$health_file"
  sync -f "$storage_root"
}

pull_reset_backups() {
  local reset_root="${ASH_ATLAS_RESET_BACKUP_REMOTE_DIRECTORY:-}"
  [[ -n "$reset_root" ]] || return 0
  command -v pg_restore >/dev/null || {
    echo "required reset-backup command is missing: pg_restore" >&2
    return 1
  }
  [[ "$reset_root" =~ ^/[A-Za-z0-9._/-]+$ ]] || {
    echo "reset backup destination contains unsafe characters" >&2
    return 1
  }
  [[ "$reset_root" != "/" && "$reset_root" != "$storage_root" ]] || {
    echo "reset backup destination cannot be the filesystem root or mount root" >&2
    return 1
  }
  [[ "$reset_root" == "${storage_root}/"* ]] || {
    echo "reset backup destination is outside the external drive" >&2
    return 1
  }
  [[ "$reset_root" != *"//"* && "$reset_root" != *"/../"* &&
     "$reset_root" != *"/./"* ]] || {
    echo "reset backup destination contains path traversal" >&2
    return 1
  }
  [[ -d "$reset_root" && ! -L "$reset_root" ]] || {
    echo "reset backup destination is absent or unsafe" >&2
    return 1
  }
  [[ "$(realpath -e -- "$reset_root")" == "$reset_root" ]] || {
    echo "reset backup destination resolves through an unsafe path" >&2
    return 1
  }
  local reset_owner reset_mode
  reset_owner="$(stat -c '%U:%G' "$reset_root")"
  reset_mode="$(stat -c '%a' "$reset_root")"
  [[ "$reset_owner" == "$archive_owner" ]] || {
    echo "reset backup destination ownership mismatch" >&2
    return 1
  }
  (( (8#$reset_mode & 8#022) == 0 )) || {
    echo "reset backup destination is group/world writable" >&2
    return 1
  }

  local partial_root="${reset_root}/.partial"
  local spool_root="${reset_root}/.spool"
  local reset_emergency_root="${reset_root}/emergency"
  local receipt_root="${reset_root}/receipts"
  local database_budget_root="$reset_root"
  if [[ -v ASH_ATLAS_DATABASE_BACKUP_REMOTE_DIRECTORY &&
        -d "$ASH_ATLAS_DATABASE_BACKUP_REMOTE_DIRECTORY" ]]; then
    database_budget_root="$ASH_ATLAS_DATABASE_BACKUP_REMOTE_DIRECTORY"
  fi
  install -d -m 0700 -o "${archive_owner%%:*}" -g "${archive_owner#*:}" \
    "$partial_root" "$spool_root" "$reset_emergency_root"
  install -d -m 0750 -o "${archive_owner%%:*}" -g "${archive_owner#*:}" \
    "$receipt_root"

  local ready_output
  if ! ready_output="$(remote reset-list)"; then
    echo "failed to list ready reset backups" >&2
    return 1
  fi
  local manifests=()
  if [[ -n "$ready_output" ]]; then
    mapfile -t manifests <<<"$ready_output"
  fi
  local reset_deferred=0
  local manifest_name
  for manifest_name in "${manifests[@]}"; do
    if ! safe_name "$manifest_name" ||
       [[ "$manifest_name" != *.dump.ready.json ]]; then
      echo "VPS returned an unsafe reset manifest name" >&2
      return 1
    fi
    local work manifest
    work="$(mktemp -d "${partial_root}/reset.XXXXXXXX")" || return 1
    manifest="${work}/${manifest_name}"
    if ! receive_remote_bounded "reset-fetch ${manifest_name}" \
      "$manifest" "$manifest_max_bytes"; then
      rm -rf -- "$work"
      echo "reset backup manifest transfer failed" >&2
      return 1
    fi
    if ! jq -e '
      .manifestVersion == 1
      and .kind == "ash_atlas_gameplay_reset_backup"
      and (.operationId | test("^[a-f0-9-]{36}$"))
      and (.database | test("^[a-z][a-z0-9_]{0,62}$"))
      and (.releaseSha | test("^[a-f0-9]{40}$"))
      and (.createdAtUtc | fromdateiso8601)
      and (.artifact.fileName | test("^[A-Za-z0-9][A-Za-z0-9._-]{0,239}$"))
      and (.artifact.fileName | contains("gameplay-reset"))
      and .artifact.format == "postgresql-custom"
      and (.artifact.bytes | type == "number" and . > 0)
      and (.artifact.sha256 | test("^[a-f0-9]{64}$"))
      and .acknowledgmentState == "pending"
    ' "$manifest" >/dev/null; then
      rm -rf -- "$work"
      echo "reset backup manifest is malformed" >&2
      return 1
    fi

    local file_name expected_bytes expected_sha operation_id final
    local stage_dir spool_dir spool_manifest spool_dump
    local receipt receipt_temporary acknowledgment_id verified_at portable_artifact
    local source_release_eligible mapping_path
    file_name="$(jq -r '.artifact.fileName' "$manifest")"
    safe_name "$file_name" || {
      rm -rf -- "$work"
      return 1
    }
    expected_bytes="$(jq -r '.artifact.bytes' "$manifest")"
    expected_sha="$(jq -r '.artifact.sha256' "$manifest")"
    operation_id="$(jq -r '.operationId' "$manifest")"
    final="${reset_root}/${file_name}"
    spool_dir="$spool_root/operation-$operation_id"
    mapping_path="$reset_root/.portable-mappings/backup-$operation_id.json"
    # Reset handoffs have no legacy portable-adoption path: once this
    # transaction is committed and acknowledged, retain only the bounded
    # emergency copy on intake.  A pre-existing marker makes a retry
    # idempotent after the source was already released.
    source_release_eligible=true
    if [[ -f "$mapping_path" && ! -L "$mapping_path" ]] &&
       jq -e '.sourceRetentionPolicy == "emergency-only"' \
         "$mapping_path" >/dev/null; then
      source_release_eligible=true
    fi
    if (( expected_bytes > backup_max_inflight_bytes )); then
      rm -rf -- "$work"
      echo "reset backup exceeds the configured inflight peak" >&2
      return 1
    fi
    if ! ash_backup_require_bounded_capacity \
      "$storage_root" "$backup_cap_bytes" "$backup_warning_bytes" \
      "$((expected_bytes * 2))" "$backup_root_reserve_bytes" \
      "$backup_root_max_used_percent" \
      >"$work/capacity.txt"; then
      rm -rf -- "$work"
      echo "insufficient bounded home-storage capacity for reset backup" >&2
      return 1
    fi

    stage_dir="$work"
    if [[ -e "$spool_dir" ]]; then
      spool_manifest="$spool_dir/$manifest_name"
      spool_dump="$spool_dir/$file_name"
      if [[ ! -d "$spool_dir" || -L "$spool_dir" ||
            ! -f "$spool_manifest" || -L "$spool_manifest" ||
            ! -f "$spool_dump" || -L "$spool_dump" ||
            "$(stat -c '%s' "$spool_dump")" != "$expected_bytes" ||
            "$(sha256sum "$spool_dump" | awk '{print $1}')" != "$expected_sha" ]] ||
         ! jq -e --arg id "$operation_id" --arg sha "$expected_sha" \
           --argjson bytes "$expected_bytes" \
           '.operationId == $id and .artifact.sha256 == $sha and .artifact.bytes == $bytes' \
           "$spool_manifest" >/dev/null; then
        rm -rf -- "$work"
        echo "existing staged reset backup does not match the pending handoff" >&2
        return 1
      fi
      rm -rf -- "$work"
      stage_dir="$spool_dir"
      manifest="$spool_manifest"
    else
      local staged="$work/$file_name.partial"
      if ! receive_remote_bounded "reset-fetch ${file_name}" \
        "$staged" "$expected_bytes"; then
        rm -rf -- "$work"
        echo "reset backup transfer was interrupted" >&2
        return 1
      fi
      [[ "$(stat -c '%s' "$staged")" == "$expected_bytes" ]] || {
        rm -rf -- "$work"
        echo "reset backup byte count differs" >&2
        return 1
      }
      [[ "$(sha256sum "$staged" | awk '{print $1}')" == "$expected_sha" ]] || {
        rm -rf -- "$work"
        echo "reset backup checksum differs" >&2
        return 1
      }
      pg_restore --list "$staged" >/dev/null || {
        rm -rf -- "$work"
        echo "reset backup restore catalog is invalid" >&2
        return 1
      }
      chmod 0600 "$staged" || {
        rm -rf -- "$work"
        return 1
      }
      chown "$archive_owner" "$staged" || {
        rm -rf -- "$work"
        return 1
      }
      sync -f "$staged" || {
        rm -rf -- "$work"
        return 1
      }
      mv -- "$staged" "$work/$file_name" || {
        rm -rf -- "$work"
        echo "reset backup staging publication failed" >&2
        return 1
      }
    fi

    receipt="$receipt_root/$file_name.receipt.json"
    verified_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)" || {
      rm -rf -- "$work"
      return 1
    }
    if [[ -f "$receipt" && ! -L "$receipt" ]]; then
      jq -e --arg id "$operation_id" --arg file "$file_name" --arg sha "$expected_sha" \
        --arg manifest "$manifest_name" --arg database "$(jq -r '.database' "$manifest")" \
        --arg release "$(jq -r '.releaseSha' "$manifest")" \
        --arg created "$(jq -r '.createdAtUtc' "$manifest")" \
        --argjson bytes "$expected_bytes" '
          .acknowledgmentVersion == 1
          and .event == "ash_atlas_gameplay_reset_backup_verified"
          and .operationId == $id and .manifestFileName == $manifest
          and .backupFileName == $file and .sha256 == $sha and .bytes == $bytes
          and .database == $database and .releaseSha == $release
          and .createdAtUtc == $created
          and (.acknowledgmentId | test("^[a-f0-9-]{36}$"))
          and .restoreCatalogVerified == true
        ' "$receipt" >/dev/null || {
          rm -rf -- "$work"
          echo "reset source receipt conflicts with the pending handoff" >&2
          return 1
        }
    else
      acknowledgment_id="$(cat /proc/sys/kernel/random/uuid)" || {
        rm -rf -- "$work"
        return 1
      }
      receipt_temporary="$(mktemp "$receipt_root/.$file_name.receipt.XXXXXXXX")" || {
        rm -rf -- "$work"
        return 1
      }
      jq -cn \
        --arg acknowledgmentId "$acknowledgment_id" \
        --arg operationId "$operation_id" \
        --arg manifestFileName "$manifest_name" \
        --arg backupFileName "$file_name" \
         --arg remotePath "$final" \
        --arg sha256 "$expected_sha" \
        --arg database "$(jq -r '.database' "$manifest")" \
        --arg releaseSha "$(jq -r '.releaseSha' "$manifest")" \
        --arg createdAtUtc "$(jq -r '.createdAtUtc' "$manifest")" \
        --arg remoteVerifiedAtUtc "$verified_at" \
        --argjson bytes "$expected_bytes" \
        '{
          acknowledgmentVersion:1,
          event:"ash_atlas_gameplay_reset_backup_verified",
          acknowledgmentId:$acknowledgmentId,
          operationId:$operationId,
          manifestFileName:$manifestFileName,
          backupFileName:$backupFileName,
          remotePath:$remotePath,
           sha256:$sha256,
          bytes:$bytes,
          database:$database,
          releaseSha:$releaseSha,
          createdAtUtc:$createdAtUtc,
          remoteVerifiedAtUtc:$remoteVerifiedAtUtc,
          restoreCatalogVerified:true
        }' >"$receipt_temporary" || {
          rm -f -- "$receipt_temporary"
          rm -rf -- "$work"
          return 1
        }
      chmod 0640 "$receipt_temporary" || {
        rm -f -- "$receipt_temporary"
        rm -rf -- "$work"
        return 1
      }
      chown "$archive_owner" "$receipt_temporary" || {
        rm -f -- "$receipt_temporary"
        rm -rf -- "$work"
        return 1
      }
      sync -f "$receipt_temporary" || {
        rm -f -- "$receipt_temporary"
        rm -rf -- "$work"
        return 1
      }
      mv -- "$receipt_temporary" "$receipt" || {
        rm -f -- "$receipt_temporary"
        rm -rf -- "$work"
        return 1
      }
      sync -f "$receipt_root" || {
        rm -rf -- "$work"
        return 1
      }
    fi

    if [[ "$portable_available" != true ]]; then
      if [[ "$stage_dir" != "$spool_dir" ]]; then
        mv -- "$stage_dir" "$spool_dir" || return 1
      fi
      ((reset_deferred += 1))
      echo "reset backup staged pending portable archive: $operation_id" >&2
      continue
    fi

    portable_artifact="$(ash_backup_commit_portable_reset \
      "$stage_dir" "$portable_root" "$operation_id" "$file_name" \
      "$stage_dir/$manifest_name" "$receipt" "$archive_owner" \
      "$portable_minimum_free_bytes" "$portable_cap_bytes" \
      "$portable_root_reserve_bytes")" || {
      if [[ "$stage_dir" != "$spool_dir" ]]; then
        mv -- "$stage_dir" "$spool_dir" || true
      fi
      echo "portable reset archive commit failed: $operation_id" >&2
      return 1
    }
    ash_backup_record_portable_mapping \
      "$receipt" "$reset_root" "$storage_root" "$TELEMETRY_SEAGATE_MOUNT" \
      "$operation_id" "$file_name" "$expected_bytes" "$expected_sha" \
      "$portable_artifact" || {
      echo "portable reset placement mapping failed: $operation_id" >&2
      return 1
    }
    ash_backup_mark_source_release_eligible \
      "$reset_root" "$operation_id" "$file_name" "$receipt" || {
      echo "portable reset source-retention marker failed: $operation_id" >&2
      return 1
    }

    # Keep the exact source until the portable commit and VPS acknowledgment;
    # the separate emergency directory is the bounded local recovery set.
    if [[ -e "$final" ]]; then
      [[ -f "$final" && ! -L "$final" &&
         "$(stat -c '%s' "$final")" == "$expected_bytes" &&
         "$(sha256sum "$final" | awk '{print $1}')" == "$expected_sha" ]] || {
        echo "existing reset emergency copy conflicts with the portable handoff" >&2
        return 1
      }
    else
      mv -- "$stage_dir/$file_name" "$final" || return 1
      sync -f "$final" || return 1
      sync -f "$reset_root" || return 1
    fi
    cp -- "$final" "$reset_emergency_root/$file_name" || return 1
    chmod 0600 "$reset_emergency_root/$file_name" || return 1
    chown "$archive_owner" "$reset_emergency_root/$file_name" || return 1
    sync -f "$reset_emergency_root/$file_name" || return 1
    ash_backup_prune_emergency_dumps "$reset_emergency_root" "$emergency_keep" || return 1

    if ! remote "reset-ack ${manifest_name}" <"$receipt"; then
      rm -rf -- "$stage_dir" || return 1
      echo "portable reset commit exists but VPS acknowledgment failed: $operation_id" >&2
      return 1
    fi
    if [[ "$source_release_eligible" == true ]]; then
      ash_backup_release_managed_source \
        "$reset_root" "$file_name" "$expected_bytes" "$expected_sha" || {
        echo "portable reset source release failed after acknowledgment: $operation_id" >&2
        return 1
      }
    fi
    if [[ "$stage_dir" == "$spool_dir" ]]; then
      rm -rf -- "$spool_dir"
    else
      rm -rf -- "$stage_dir"
    fi
  done
  (( reset_deferred == 0 )) || {
    echo "$reset_deferred reset backup(s) remain staged pending portable archive" >&2
    return 1
  }
  local retention="${ASH_ATLAS_RESET_BACKUP_RETENTION_COUNT:-0}"
  [[ "$retention" =~ ^[0-9]+$ ]] || {
    echo "reset backup retention count is invalid" >&2
    return 1
  }
  if (( retention > 0 )); then
    local prune_script
    prune_script="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/prune-reset-backups.sh"
    [[ -x "$prune_script" ]] || {
      echo "reset backup pruning tool is absent" >&2
      return 1
    }
    "$prune_script" --apply
  fi
}

verify_duckdb() {
  local database="$1"
  local manifest="$2"
  local expected_identity observed_identity
  expected_identity="$(
    jq -r '[
      .runId,.segmentId,(.campaignId // ""),.releaseSha,
      (.releaseGeneration // ""),.worldReleaseId,.populationPlanVersion,
      .populationSpawnRulesVersion,.balanceVersion
    ] | join("|")' "$manifest"
  )"
  duckdb "$database" "PRAGMA database_size" >/dev/null
  observed_identity="$(
    duckdb -noheader -csv "$database" \
      "SELECT concat_ws('|',
         CAST(run_id AS VARCHAR),CAST(COALESCE(segment_id,run_id) AS VARCHAR),
         COALESCE(CAST(campaign_id AS VARCHAR),''),release_sha,
         COALESCE(release_generation,''),world_release_id,
         population_plan_version,population_spawn_rules_version,balance_version)
       FROM test_runs"
  )"
  [[ "$observed_identity" == "$expected_identity" ]] || return 1

  local table expected observed
  while IFS= read -r table; do
    case "$table" in
      test_runs|server_samples|world_samples|gameplay_events|player_snapshots|\
      player_inventory_snapshots|client_samples|session_summaries|\
      bug_reports|bug_report_context|\
      authoritative_progression_events|authoritative_inventory_events|\
      authoritative_wallet_events|authoritative_market_trades|\
      authoritative_combat_summaries|telemetry_health|export_manifest) ;;
      *) return 1 ;;
    esac
    expected="$(jq -r --arg table "$table" '.tableRowCounts[$table]' "$manifest")"
    [[ "$expected" =~ ^[0-9]+$ ]] || return 1
    observed="$(duckdb -noheader -csv "$database" "SELECT count(*) FROM \"$table\"")"
    [[ "$observed" == "$expected" ]] || return 1
  done < <(jq -r '.tableRowCounts | keys[]' "$manifest")
}

verify_parquet_bundle() {
  local bundle="$1"
  local manifest="$2"
  local extraction="$3"
  tar -tf "$bundle" | grep -Eq '(^/|(^|/)\.\.(/|$))' && return 1
  tar -tvf "$bundle" | awk 'substr($1,1,1) != "-" && substr($1,1,1) != "d" {exit 1}' ||
    return 1
  install -d -m 0700 "$extraction"
  tar -xf "$bundle" -C "$extraction"
  local table expected observed file
  while IFS= read -r table; do
    case "$table" in
      test_runs|server_samples|world_samples|gameplay_events|player_snapshots|\
      player_inventory_snapshots|client_samples|session_summaries|\
      bug_reports|bug_report_context|\
      authoritative_progression_events|authoritative_inventory_events|\
      authoritative_wallet_events|authoritative_market_trades|\
      authoritative_combat_summaries|telemetry_health|export_manifest) ;;
      *) return 1 ;;
    esac
    file="${extraction}/${table}.parquet"
    [[ -f "$file" && ! -L "$file" ]] || return 1
    expected="$(jq -r --arg table "$table" '.tableRowCounts[$table]' "$manifest")"
    observed="$(duckdb -noheader -csv :memory: \
      "SELECT count(*) FROM read_parquet('${file//\'/\'\'}')")"
    [[ "$observed" == "$expected" ]] || return 1
  done < <(jq -r '.tableRowCounts | keys[]' "$manifest")
  local expected_identity observed_identity
  expected_identity="$(
    jq -r '[
      .runId,.segmentId,(.campaignId // ""),.releaseSha,
      (.releaseGeneration // ""),.worldReleaseId,.populationPlanVersion,
      .populationSpawnRulesVersion,.balanceVersion
    ] | join("|")' "$manifest"
  )"
  observed_identity="$(
    duckdb -noheader -csv :memory: \
      "SELECT concat_ws('|',
         CAST(run_id AS VARCHAR),CAST(COALESCE(segment_id,run_id) AS VARCHAR),
         COALESCE(CAST(campaign_id AS VARCHAR),''),release_sha,
         COALESCE(release_generation,''),world_release_id,
         population_plan_version,population_spawn_rules_version,balance_version)
       FROM read_parquet('${extraction}/test_runs.parquet')"
  )"
  [[ "$observed_identity" == "$expected_identity" ]]
}

verify_staged() {
  local artifact="$1"
  local manifest="$2"
  local work="$3"
  local format expected_size expected_sha actual_size actual_sha
  format="$(jq -r '.artifact.format' "$manifest")"
  expected_size="$(jq -r '.artifact.bytes' "$manifest")"
  expected_sha="$(jq -r '.artifact.sha256' "$manifest")"
  actual_size="$(stat -c '%s' "$artifact")"
  actual_sha="$(sha256sum "$artifact" | awk '{print $1}')"
  [[ "$actual_size" == "$expected_size" && "$actual_sha" == "$expected_sha" ]] || return 1
  if [[ "$format" == "duckdb" ]]; then
    verify_duckdb "$artifact" "$manifest"
  elif [[ "$format" == "parquet" ]]; then
    verify_parquet_bundle "$artifact" "$manifest" "${work}/parquet-verify"
  else
    return 1
  fi
}

pull_database_backups
pull_reset_backups

if ! ready_output="$(remote list)"; then
  echo "failed to list ready telemetry manifests" >&2
  exit 1
fi
manifests=()
rejected_manifests=0
if [[ -n "$ready_output" ]]; then
  mapfile -t manifests <<<"$ready_output"
fi
for manifest_name in "${manifests[@]}"; do
  if ! safe_name "$manifest_name" || [[ "$manifest_name" != *.ready.json ]]; then
    echo "VPS returned an unsafe manifest name" >&2
    exit 1
  fi
  work="$(mktemp -d "${partial_root}/pull.XXXXXXXX")"
  if ! ash_backup_require_bounded_capacity \
    "$storage_root" "$backup_cap_bytes" "$backup_warning_bytes" \
    "$manifest_max_bytes" "$backup_root_reserve_bytes" \
    "$backup_root_max_used_percent" >/dev/null; then
    reject_telemetry 'bounded home intake capacity is exhausted before manifest fetch'
    continue
  fi
  manifest="${work}/${manifest_name}"
  if ! receive_remote_bounded "fetch ${manifest_name}" "$manifest" "$manifest_max_bytes"; then
    reject_telemetry transfer
    continue
  fi
  if ! jq -e '
    .manifestVersion == 1
    and (.segmentId | test("^[0-9a-fA-F-]{36}$"))
    and (.runId | test("^[0-9a-fA-F-]{36}$"))
    and (.segmentStartAt | type == "string")
    and (.segmentEndAt | type == "string")
    and (.releaseSha | test("^[a-f0-9]{40}$"))
    and ((.releaseGeneration == null) or (.releaseGeneration | test("^test/t[0-9]+$")))
    and (.worldReleaseId | type == "string" and length > 0)
    and (.populationPlanVersion | type == "string" and length > 0)
    and (.populationSpawnRulesVersion | type == "string" and length > 0)
    and (.balanceVersion | type == "string" and length > 0)
    and (.artifact.fileName | test("^[A-Za-z0-9][A-Za-z0-9._-]{0,239}$"))
    and (.artifact.checksumFileName | test("^[A-Za-z0-9][A-Za-z0-9._-]{0,239}$"))
    and (.artifact.format == "duckdb" or .artifact.format == "parquet")
    and (.artifact.bytes | type == "number" and . > 0)
    and (.artifact.sha256 | test("^[a-f0-9]{64}$"))
    and (.tableRowCounts | type == "object")
    and .acknowledgmentState == "unacknowledged"
  ' "$manifest" >/dev/null; then
    reject_telemetry manifest
    continue
  fi

  artifact_name="$(jq -r '.artifact.fileName' "$manifest")"
  checksum_name="$(jq -r '.artifact.checksumFileName' "$manifest")"
  safe_name "$artifact_name" && safe_name "$checksum_name" || exit 1
  expected_bytes="$(jq -er '.artifact.bytes | select(type == "number" and . > 0)' "$manifest")" || {
    reject_telemetry manifest
    continue
  }
  [[ "$expected_bytes" =~ ^[1-9][0-9]*$ ]] || {
    reject_telemetry manifest
    continue
  }
  if (( expected_bytes > backup_max_inflight_bytes )); then
    reject_telemetry 'artifact exceeds the configured in-flight peak'
    continue
  fi
  manifest_bytes="$(stat -c '%s' "$manifest")" || {
    reject_telemetry 'telemetry manifest size is unreadable'
    continue
  }
  telemetry_current_bytes="$(ash_backup_path_bytes "$archive_root")" || {
    reject_telemetry 'telemetry archive inventory is unreadable'
    continue
  }
  telemetry_incoming_bytes=$((expected_bytes + manifest_bytes + manifest_max_bytes))
  if (( telemetry_current_bytes + telemetry_incoming_bytes > telemetry_cap_bytes )); then
    reject_telemetry \
      "home telemetry archive cap would be exceeded (current=${telemetry_current_bytes} incoming=${telemetry_incoming_bytes} cap=${telemetry_cap_bytes})"
    continue
  fi
  if ! ash_backup_require_bounded_capacity \
    "$storage_root" "$backup_cap_bytes" "$backup_warning_bytes" \
    "$((expected_bytes + manifest_max_bytes))" "$backup_root_reserve_bytes" \
    "$backup_root_max_used_percent" >/dev/null; then
    reject_telemetry 'bounded home intake capacity is exhausted'
    continue
  fi
  artifact="${work}/${artifact_name}"
  checksum="${work}/${checksum_name}"
  if ! receive_remote_bounded "fetch ${checksum_name}" "$checksum" "$manifest_max_bytes" ||
     ! receive_remote_bounded "fetch ${artifact_name}" "$artifact" "$expected_bytes"; then
    reject_telemetry transfer
    continue
  fi
  expected_sha="$(jq -r '.artifact.sha256' "$manifest")"
  [[ "$(awk 'NR==1 {print $1}' "$checksum")" == "$expected_sha" ]] || {
    reject_telemetry checksum
    continue
  }
  if ! verify_staged "$artifact" "$manifest" "$work"; then
    reject_telemetry verification
    continue
  fi

  if ! archive_date="$(date -u -d "$(jq -r '.segmentEndAt' "$manifest")" +%Y/%m/%d)"; then
    reject_telemetry timestamp
    continue
  fi
  final_parent="${archive_root}/${archive_date}"
  segment_id="$(jq -r '.segmentId' "$manifest")"
  final="${final_parent}/${segment_id}"
  install -d -m 0750 -o "${archive_owner%%:*}" -g "${archive_owner#*:}" "$final_parent"
  if [[ -d "$final" ]]; then
    existing_manifest="${final}/${manifest_name}"
    existing_artifact="${final}/${artifact_name}"
    if [[ -f "$existing_manifest" && ! -L "$existing_manifest" &&
          -f "$existing_artifact" && ! -L "$existing_artifact" ]] &&
       verify_staged "$existing_artifact" "$existing_manifest" "$final"; then
      rm -rf -- "${final}/parquet-verify"
      rm -rf -- "$work"
      remote "ack ${manifest_name} ${expected_sha} 1"
      continue
    fi
    reject_telemetry duplicate
    continue
  fi
  rm -rf -- "${work}/parquet-verify"
  sync -f "$artifact"
  sync -f "$checksum"
  sync -f "$manifest"
  chown -R "$archive_owner" "$work"
  mv -- "$work" "$final"
  sync -f "$final_parent"
  if [[ "${TELEMETRY_BUG_REPORT_INDEX_ENABLED:-true}" == "true" &&
        "$artifact_name" == *.duckdb ]]; then
    /usr/local/sbin/ash-atlas-bug-report-index \
      "${final}/${artifact_name}" "$segment_id" \
      "${TELEMETRY_BUG_REPORT_INDEX_ROOT:-${storage_root}/ash-atlas-telemetry/bug-report-index}" \
      || echo "bug report index update failed; canonical artifact remains verified" >&2
  fi
  remote "ack ${manifest_name} ${expected_sha} 1"
done
(( rejected_manifests == 0 )) || {
  echo "telemetry pull rejected ${rejected_manifests} manifest(s)" >&2
  exit 1
}

# A successful pull may have repaired a receipt that made the previous proof
# attempt fail closed.  Queue the existing mirror unit after this pull
# completes; its ordering relationship then queues bounded per-backup proof
# after the mirror.  A missing/unmounted Seagate is expected here and remains
# retryable through the existing mount and mirror timers.
if ! systemctl start --no-block ash-atlas-backup-mirror.service; then
  echo 'backup mirror re-evaluation could not be scheduled' >&2
fi
