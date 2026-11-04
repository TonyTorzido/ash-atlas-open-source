#!/usr/bin/env bash
set -euo pipefail
umask 077

: "${TELEMETRY_HOME_STORAGE_ROOT:?internal storage root is required}"
: "${TELEMETRY_HOME_STORAGE_MOUNT:?internal storage mount is required}"
: "${TELEMETRY_HOME_STORAGE_UUID:?internal storage UUID is required}"
: "${TELEMETRY_HOME_STORAGE_SERIAL:?internal storage serial is required}"
: "${TELEMETRY_HOME_STORAGE_FSTYPE:?internal storage filesystem type is required}"
: "${TELEMETRY_SEAGATE_MOUNT:?Seagate mount is required}"
: "${TELEMETRY_SEAGATE_UUID:?Seagate UUID is required}"
: "${TELEMETRY_SEAGATE_SERIAL:?Seagate serial is required}"
: "${ASH_ATLAS_DATABASE_BACKUP_REMOTE_DIRECTORY:?database backup root is required}"
: "${ASH_ATLAS_RESET_BACKUP_REMOTE_DIRECTORY:?reset backup root is required}"
: "${TELEMETRY_PORTABLE_BACKUP_ROOT:=$TELEMETRY_SEAGATE_MOUNT/ash-atlas-backup-archive}"
: "${TELEMETRY_PORTABLE_BACKUP_CAP_BYTES:=0}"
: "${TELEMETRY_PORTABLE_BACKUP_MINIMUM_FREE_BYTES:=10737418240}"
: "${TELEMETRY_PORTABLE_BACKUP_ROOT_RESERVE_BYTES:=0}"
: "${TELEMETRY_PORTABLE_TELEMETRY_CAP_BYTES:=10000000000}"
: "${TELEMETRY_PORTABLE_TELEMETRY_WARNING_BYTES:=8000000000}"
: "${TELEMETRY_VPS_HOST:?VPS host is required}"
: "${TELEMETRY_VPS_USER:=ash-telemetry-pull}"
: "${TELEMETRY_SSH_KEY:?dedicated SSH key path is required}"
: "${TELEMETRY_KNOWN_HOSTS:?pinned known_hosts path is required}"

for command in awk chmod cp date df find findmnt flock install jq mktemp mv \
  readlink realpath rm rsync ssh stat sync udevadm; do
  command -v "$command" >/dev/null || {
    echo "required command is missing: $command" >&2
    exit 1
  }
done

common="${ASH_ATLAS_BACKUP_COMMON:-/usr/local/lib/ash-atlas/backup-common.sh}"
[[ -r "$common" ]] || {
  echo "backup common library is missing: $common" >&2
  exit 1
}
# shellcheck source=ash-atlas-backup-common.sh
source "$common"

[[ "$TELEMETRY_PORTABLE_BACKUP_CAP_BYTES" =~ ^[0-9]+$ &&
   "$TELEMETRY_PORTABLE_BACKUP_MINIMUM_FREE_BYTES" =~ ^[1-9][0-9]*$ &&
   "$TELEMETRY_PORTABLE_BACKUP_ROOT_RESERVE_BYTES" =~ ^[0-9]+$ &&
   "$TELEMETRY_PORTABLE_TELEMETRY_CAP_BYTES" =~ ^[1-9][0-9]*$ &&
   "$TELEMETRY_PORTABLE_TELEMETRY_WARNING_BYTES" =~ ^[1-9][0-9]*$ &&
   "$TELEMETRY_PORTABLE_TELEMETRY_WARNING_BYTES" -lt "$TELEMETRY_PORTABLE_TELEMETRY_CAP_BYTES" ]] || exit 2

pull_lock="${TELEMETRY_HOME_PULL_LOCK:-/run/lock/ash-atlas-telemetry-home-pull.lock}"
mirror_lock="${ASH_ATLAS_BACKUP_MIRROR_LOCK:-/run/lock/ash-atlas-backup-mirror.lock}"
if [[ -v TELEMETRY_BACKUP_MIGRATION_LOCK ]]; then
  migration_lock="$TELEMETRY_BACKUP_MIGRATION_LOCK"
elif [[ "${TELEMETRY_TEST_MODE:-false}" == true ]]; then
  migration_lock="${pull_lock}.migration"
else
  migration_lock=/run/lock/ash-atlas-backup-migration.lock
fi
for lock in "$pull_lock" "$mirror_lock" "$migration_lock"; do
  if [[ "${TELEMETRY_TEST_MODE:-false}" == true ]]; then
    [[ "$lock" == /tmp/ash-atlas-database-backup-test.*/* ]] || exit 2
  else
    [[ "$lock" == /run/lock/* ]] || exit 2
  fi
done
exec 9>"$pull_lock"
flock -n 9 || exit 0
exec 8>"$mirror_lock"
flock -n 8 || exit 0
exec 7>"$migration_lock"
flock -n 7 || exit 0

ssh_options=(
  -T -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes
  -o "UserKnownHostsFile=${TELEMETRY_KNOWN_HOSTS}"
  -o "IdentityFile=${TELEMETRY_SSH_KEY}"
  -o ClearAllForwardings=yes -o ConnectTimeout=15
)
ssh_destination="${TELEMETRY_VPS_USER}@${TELEMETRY_VPS_HOST}"
ssh_control_dir="$(mktemp -d "$(dirname "$mirror_lock")/ash-atlas-mirror-ssh.XXXXXXXX")"
chmod 0700 "$ssh_control_dir"
ssh_options+=(
  -o ControlMaster=auto -o ControlPersist=60
  -o "ControlPath=${ssh_control_dir}/control"
)
cleanup_ssh_control() {
  ssh "${ssh_options[@]}" -O exit "$ssh_destination" >/dev/null 2>&1 || true
  rm -rf -- "$ssh_control_dir" || true
  if [[ -n "${portable_cwd:-}" ]]; then
    cd -- "$portable_cwd" >/dev/null 2>&1 || true
  fi
}
trap cleanup_ssh_control EXIT
remote() {
  # shellcheck disable=SC2029
  ssh "${ssh_options[@]}" "$ssh_destination" "$1"
}

ash_backup_validate_storage \
  "$TELEMETRY_HOME_STORAGE_ROOT" "$TELEMETRY_HOME_STORAGE_MOUNT" \
  "$TELEMETRY_HOME_STORAGE_UUID" "$TELEMETRY_HOME_STORAGE_SERIAL" \
  "$TELEMETRY_HOME_STORAGE_FSTYPE" "internal backup intake"
ash_backup_validate_storage \
  "$TELEMETRY_SEAGATE_MOUNT" "$TELEMETRY_SEAGATE_MOUNT" \
  "$TELEMETRY_SEAGATE_UUID" "$TELEMETRY_SEAGATE_SERIAL" \
  "${TELEMETRY_SEAGATE_FSTYPE:-ntfs3}" \
  "Seagate mirror"
ash_backup_require_portable_mount "$TELEMETRY_SEAGATE_MOUNT" || {
  echo 'portable backup mount disappeared before archive preparation' >&2
  exit 1
}
portable_cwd="$PWD"
cd -- "$TELEMETRY_SEAGATE_MOUNT" || {
  echo 'portable backup mount could not be pinned for archive preparation' >&2
  exit 1
}
if [[ "$TELEMETRY_PORTABLE_BACKUP_ROOT" == "$TELEMETRY_SEAGATE_MOUNT" ]]; then
  portable_relative='.'
else
  portable_relative="${TELEMETRY_PORTABLE_BACKUP_ROOT#"$TELEMETRY_SEAGATE_MOUNT/"}"
fi
[[ -n "$portable_relative" && "$portable_relative" != /* &&
   "$portable_relative" != *'..'* ]] || {
  echo 'portable backup archive relative path is unsafe' >&2
  exit 1
}
# Keep the mount pinned by the process cwd and revalidate immediately before
# creating the archive root.  If the device vanished after the first
# preflight, do not recreate the path on the underlying root filesystem.
ash_backup_require_portable_mount "$TELEMETRY_SEAGATE_MOUNT" || {
  echo 'portable backup mount disappeared before archive-root creation' >&2
  exit 1
}
install -d -m 0750 -- "$portable_relative"
ash_backup_require_portable_root "$TELEMETRY_PORTABLE_BACKUP_ROOT" \
  "$TELEMETRY_SEAGATE_MOUNT" || {
  echo 'portable backup archive is outside the configured Seagate mount' >&2
  exit 1
}

minimum_free_bytes="${TELEMETRY_SEAGATE_MINIMUM_FREE_BYTES:-10737418240}"
[[ "$minimum_free_bytes" =~ ^[0-9]+$ ]] || exit 2
read -r available_bytes total_bytes < <(
  df -PB1 "$TELEMETRY_SEAGATE_MOUNT" | awk 'NR == 2 {print $4, $2}'
) || exit 1
[[ "$available_bytes" =~ ^[0-9]+$ && "$total_bytes" =~ ^[1-9][0-9]*$ ]] || exit 1
portable_reserved_bytes=$((total_bytes / 10))
(( portable_reserved_bytes >= minimum_free_bytes )) || {
  portable_reserved_bytes="$minimum_free_bytes"
}
(( available_bytes >= portable_reserved_bytes )) || {
  echo "insufficient Seagate free space" >&2
  exit 1
}

archive_owner="${TELEMETRY_ARCHIVE_OWNER:-root:root}"
database_spool_root="$ASH_ATLAS_DATABASE_BACKUP_REMOTE_DIRECTORY/.spool"
database_receipt_root="$ASH_ATLAS_DATABASE_BACKUP_REMOTE_DIRECTORY/receipts"
[[ -d "$database_spool_root" && ! -L "$database_spool_root" &&
   -d "$database_receipt_root" && ! -L "$database_receipt_root" ]] || {
  echo 'database spool or receipt root is absent or unsafe' >&2
  exit 1
}

portable_database_count=0
while IFS= read -r -d '' stage_dir; do
  stage_name="$(basename -- "$stage_dir")"
  [[ "$stage_name" =~ ^backup-([a-f0-9-]{36})$ ]] || {
    echo "invalid staged backup directory: $stage_name" >&2
    exit 1
  }
  backup_id="${BASH_REMATCH[1]}"
  manifest="$(find "$stage_dir" -maxdepth 1 -type f -name '*.dump.ready.json' -print -quit)"
  [[ -n "$manifest" ]] || { echo "staged backup manifest is missing: $backup_id" >&2; exit 1; }
  file_name="$(jq -er '.artifact.fileName' "$manifest")" || exit 1
  source_receipt="$database_receipt_root/$file_name.receipt.json"
  [[ -f "$source_receipt" && ! -L "$source_receipt" ]] || {
    echo "staged backup source receipt is missing: $backup_id" >&2
    exit 1
  }
  if ! portable_artifact="$(ash_backup_commit_portable_database \
      "$stage_dir" "$TELEMETRY_PORTABLE_BACKUP_ROOT" "$backup_id" "$file_name" \
      "$manifest" "$source_receipt" "$archive_owner" \
      "$TELEMETRY_PORTABLE_BACKUP_MINIMUM_FREE_BYTES" \
      "$TELEMETRY_PORTABLE_BACKUP_CAP_BYTES" \
      "$TELEMETRY_PORTABLE_BACKUP_ROOT_RESERVE_BYTES")"; then
    echo "portable archive commit failed for staged backup: $backup_id" >&2
    exit 1
  fi
  ash_backup_record_portable_mapping \
    "$source_receipt" "$ASH_ATLAS_DATABASE_BACKUP_REMOTE_DIRECTORY" \
    "$TELEMETRY_HOME_STORAGE_ROOT" "$TELEMETRY_SEAGATE_MOUNT" \
    "$backup_id" "$file_name" \
    "$(jq -er '.artifact.bytes' "$manifest")" \
    "$(jq -er '.artifact.sha256' "$manifest")" "$portable_artifact" || {
    echo "portable archive placement mapping failed: $backup_id" >&2
    exit 1
  }
  manifest_name="$(basename -- "$manifest")"
  if ! remote "database-ack ${manifest_name}" <"$source_receipt"; then
    echo "portable archive committed but VPS acknowledgment failed: $backup_id" >&2
    exit 1
  fi
  rm -rf -- "$stage_dir"
  ((portable_database_count += 1))
done < <(find "$database_spool_root" -mindepth 1 -maxdepth 1 -type d -print0 | LC_ALL=C sort -z)

source_roots=(
  "$ASH_ATLAS_DATABASE_BACKUP_REMOTE_DIRECTORY"
  "$ASH_ATLAS_RESET_BACKUP_REMOTE_DIRECTORY"
  "$TELEMETRY_HOME_STORAGE_ROOT/ash-atlas-telemetry/archive"
)
telemetry_source_root="$TELEMETRY_HOME_STORAGE_ROOT/ash-atlas-telemetry/archive"
legacy_source_root="$TELEMETRY_HOME_STORAGE_ROOT/ash-atlas/deployment-pre-migration-archive"
if [[ -d "$legacy_source_root" && ! -L "$legacy_source_root" ]]; then
  # Mirror only the classified historical archive.  Walking the whole
  # ash-atlas tree would duplicate database/reset spools and emergency dumps
  # into an unrelated legacy namespace, bypassing their bounded transaction.
  source_roots+=("$legacy_source_root")
fi
declare -A seen=()
relative_roots=()
for source_root in "${source_roots[@]}"; do
  ash_backup_require_child "$TELEMETRY_HOME_STORAGE_ROOT" "$source_root" || {
    echo "backup source is absent or outside internal storage: $source_root" >&2
    exit 1
  }
  [[ -z "${seen[$source_root]:-}" ]] || continue
  seen[$source_root]=1
  relative_roots+=("${source_root#"$TELEMETRY_HOME_STORAGE_ROOT/"}")
  unsafe_source="$(
    find "$source_root" \( -type l -o \( ! -type f ! -type d \) \) -print -quit
  )"
  if [[ -n "$unsafe_source" ]]; then
    echo "backup source contains a symlink or special file: $source_root" >&2
    exit 1
  fi
done

rsync_options=(
  --recursive
  --times
  --omit-dir-times
  --ignore-existing
  --partial-dir=.ash-atlas-mirror-partial
  --fsync
  --protect-args
  --safe-links
  --no-devices
  --no-specials
  --modify-window=1
  --exclude=/partial/
  --exclude=/.partial/
  --exclude=/.spool/
  --exclude=/emergency/
  --exclude=/.ash-atlas-mirror-partial/
  --exclude='*.part'
  --exclude='*.partial'
  --exclude='*.tmp'
  --exclude='*.incomplete'
)
dump_excludes=(--exclude='*.dump' --exclude='*.dump.ready.json')
parity_options=(
  --recursive
  --times
  --omit-dir-times
  --dry-run
  --itemize-changes
  --protect-args
  --safe-links
  --no-devices
  --no-specials
  --modify-window=1
  --exclude=/partial/
  --exclude=/.partial/
  --exclude=/.spool/
  --exclude=/emergency/
  --exclude=/.ash-atlas-mirror-partial/
  --exclude='*.part'
  --exclude='*.partial'
  --exclude='*.tmp'
  --exclude='*.incomplete'
)
parity_dump_excludes=(--exclude='*.dump' --exclude='*.dump.ready.json')

telemetry_skipped_reason=''
mirrored_roots=()
mirrored_source_roots=()
for relative_root in "${relative_roots[@]}"; do
  source_root="$TELEMETRY_HOME_STORAGE_ROOT/$relative_root"
  destination_root="$relative_root"
  ash_backup_require_portable_mount "$TELEMETRY_SEAGATE_MOUNT" || {
    echo 'portable backup mount disappeared during mirror' >&2
    exit 1
  }
  install -d -m 0750 -- "$destination_root"
  if [[ "$source_root" == "$ASH_ATLAS_DATABASE_BACKUP_REMOTE_DIRECTORY" ||
        "$source_root" == "$ASH_ATLAS_RESET_BACKUP_REMOTE_DIRECTORY" ]]; then
    mirror_transfer_options=("${rsync_options[@]}" "${dump_excludes[@]}")
  else
    mirror_transfer_options=("${rsync_options[@]}")
  fi
  mirror_dry_run="$(LC_ALL=C rsync "${mirror_transfer_options[@]}" \
    "$source_root/" "$destination_root/" --dry-run --stats)" || {
    echo "portable mirror capacity preflight failed for $relative_root" >&2
    exit 1
  }
  incoming_bytes="$(awk -F: '/Total transferred file size:/ {
    value=$2; gsub(/[^0-9]/, "", value); print value; exit
  }' <<<"$mirror_dry_run")"
  [[ "$incoming_bytes" =~ ^[0-9]+$ ]] || {
    echo "portable mirror transfer size is unreadable for $relative_root" >&2
    exit 1
  }
  ash_backup_require_portable_mount "$TELEMETRY_SEAGATE_MOUNT" || {
    echo 'portable backup mount disappeared during mirror capacity preflight' >&2
    exit 1
  }
  read -r available_bytes total_bytes < <(
    df -PB1 "$TELEMETRY_SEAGATE_MOUNT" | awk 'NR == 2 {print $4, $2}'
  ) || exit 1
  [[ "$available_bytes" =~ ^[0-9]+$ && "$total_bytes" =~ ^[1-9][0-9]*$ ]] || exit 1
  portable_reserved_bytes=$((total_bytes / 10))
  (( portable_reserved_bytes >= minimum_free_bytes )) || {
    portable_reserved_bytes="$minimum_free_bytes"
  }
  (( available_bytes >= portable_reserved_bytes + incoming_bytes )) || {
    echo "portable mirror would consume its reserved free space for $relative_root" >&2
    exit 1
  }
  if [[ "$source_root" == "$telemetry_source_root" ]]; then
    telemetry_destination_root="$TELEMETRY_SEAGATE_MOUNT/$relative_root"
    telemetry_incoming_bytes="$incoming_bytes"
    telemetry_current_bytes="$(ash_backup_path_bytes "$telemetry_destination_root")" || {
      echo 'portable telemetry archive inventory failed' >&2
      exit 1
    }
    if (( telemetry_current_bytes + telemetry_incoming_bytes > TELEMETRY_PORTABLE_TELEMETRY_CAP_BYTES )); then
      # Telemetry is analytics; a full telemetry archive must not stop database
      # verification. Skip it, record the skip, and finish the pass normally.
      echo 'portable telemetry archive cap would be exceeded; telemetry mirror skipped' >&2
      telemetry_skipped_reason='portable telemetry archive cap would be exceeded'
      continue
    fi
  fi
  if [[ "$source_root" == "$ASH_ATLAS_DATABASE_BACKUP_REMOTE_DIRECTORY" ||
        "$source_root" == "$ASH_ATLAS_RESET_BACKUP_REMOTE_DIRECTORY" ]]; then
    rsync "${rsync_options[@]}" "${dump_excludes[@]}" "$source_root/" "$destination_root/"
    parity="$(rsync "${parity_options[@]}" "${parity_dump_excludes[@]}" \
      "$source_root/" "$destination_root/")"
  else
    rsync "${rsync_options[@]}" "$source_root/" "$destination_root/"
    parity="$(rsync "${parity_options[@]}" "$source_root/" "$destination_root/")"
  fi
  [[ -z "$parity" ]] || {
    echo "portable archive source has not yet converged for $relative_root" >&2
    printf '%s\n' "$parity" >&2
    exit 1
  }
  if [[ "$source_root" == "$telemetry_source_root" ]]; then
    telemetry_current_bytes="$(ash_backup_path_bytes "$telemetry_destination_root")" || exit 1
    (( telemetry_current_bytes <= TELEMETRY_PORTABLE_TELEMETRY_CAP_BYTES )) || {
      echo 'portable telemetry archive exceeded its cap after mirror' >&2
      exit 1
    }
  fi
  mirrored_roots+=("$relative_root")
  mirrored_source_roots+=("$source_root")
done

# The state records only what this pass actually mirrored.
read -r file_count total_bytes < <(ash_backup_file_totals "${mirrored_source_roots[@]}")
verified_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
state_name='.ash-atlas-seagate-mirror-state.json'
source_state="$(mktemp "$TELEMETRY_HOME_STORAGE_ROOT/.mirror-state.XXXXXXXX")"
ash_backup_require_portable_mount "$TELEMETRY_SEAGATE_MOUNT" || {
  echo 'portable backup mount disappeared before mirror state publication' >&2
  exit 1
}
seagate_state="$(mktemp "./.mirror-state.XXXXXXXX")"
printf '%s\0' "${mirrored_roots[@]}" |
  jq -Rs 'split("\u0000") | map(select(length > 0))' |
  jq --arg verifiedAtUtc "$verified_at" \
    --arg telemetrySkipped "$telemetry_skipped_reason" \
    --arg sourceRoot "$TELEMETRY_HOME_STORAGE_ROOT" \
    --arg sourceUuid "$TELEMETRY_HOME_STORAGE_UUID" \
    --arg seagateMount "$TELEMETRY_SEAGATE_MOUNT" \
    --arg seagateUuid "$TELEMETRY_SEAGATE_UUID" \
    --argjson fileCount "$file_count" \
    --argjson bytes "$total_bytes" '
      {
        version:1,
        status:"ok",
        verification:"rsync-size-mtime",
        verifiedAtUtc:$verifiedAtUtc,
        sourceRoot:$sourceRoot,
        sourceUuid:$sourceUuid,
        seagateMount:$seagateMount,
        seagateUuid:$seagateUuid,
        fileCount:$fileCount,
        bytes:$bytes,
        portableTelemetryCapBytes:'"$TELEMETRY_PORTABLE_TELEMETRY_CAP_BYTES"',
        portableTelemetryWarningBytes:'"$TELEMETRY_PORTABLE_TELEMETRY_WARNING_BYTES"',
        relativeRoots:.
      } + (if $telemetrySkipped == "" then {} else {telemetrySkipped:$telemetrySkipped} end)
    ' >"$source_state"
cp -- "$source_state" "$seagate_state"
chmod 0640 "$source_state" "$seagate_state"
sync -f "$source_state" "$seagate_state"
mv -f -- "$source_state" "$TELEMETRY_HOME_STORAGE_ROOT/$state_name"
mv -f -- "$seagate_state" "./$state_name"
sync -f "$TELEMETRY_HOME_STORAGE_ROOT" .

printf 'Seagate mirror verified: files=%s bytes=%s at=%s\n' \
  "$file_count" "$total_bytes" "$verified_at"

# Fast mirror success is the liveness edge for bounded PostgreSQL proof.  The
# proof unit is ordered after this service, so a request made while this
# process still owns the pull/mirror locks is queued until the locks are
# released.  If the unit is condition-blocked (for example while the Seagate
# is absent), the normal mount/mirror timers retry it later.  The independent
# daily deep scrub remains a defense-in-depth check and is not part of this
# routine path.
if ! systemctl start --no-block ash-atlas-backup-prove.service; then
  echo 'PostgreSQL proof re-evaluation could not be scheduled' >&2
fi
