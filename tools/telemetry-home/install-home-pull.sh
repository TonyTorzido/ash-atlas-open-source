#!/usr/bin/env bash
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo 'run as root' >&2; exit 1; }
[[ $# -eq 6 ]] || {
  echo "usage: $0 /internal/intake internal-uuid internal-serial /seagate/mount seagate-uuid seagate-serial" >&2
  exit 2
}

storage_root="$1"; storage_uuid="$2"; storage_serial="$3"
seagate_mount="$4"; seagate_uuid="$5"; seagate_serial="$6"
for path in "$storage_root" "$seagate_mount"; do
  [[ -d "$path" && ! -L "$path" ]] || {
    echo "configured storage path is absent or unsafe: $path" >&2
    exit 1
  }
done
storage_mount="$(findmnt -n -T "$(dirname -- "$storage_root")" -o TARGET)"
storage_fstype="$(findmnt -n -T "$(dirname -- "$storage_root")" -o FSTYPE)"

for path in "$storage_root" "$seagate_mount"; do
  [[ "$path" =~ ^/[A-Za-z0-9._/-]+$ && "$path" != / ]] || exit 2
done
for identity in "$storage_uuid" "$storage_serial" "$seagate_uuid" "$seagate_serial"; do
  [[ "$identity" =~ ^[A-Za-z0-9._-]+$ ]] || exit 2
done
for command in awk findmnt getent id install jq mountpoint pg_restore python3 readlink \
  realpath rsync sed smartctl ntfs-3g.probe journalctl systemctl udevadm; do
  command -v "$command" >/dev/null || { echo "required command is missing: $command" >&2; exit 1; }
done

source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=ash-atlas-backup-common.sh
source "$source_dir/ash-atlas-backup-common.sh"

ash_backup_validate_storage "$storage_root" "$storage_mount" "$storage_uuid" \
  "$storage_serial" "$storage_fstype" 'internal backup intake'
ash_backup_validate_storage "$seagate_mount" "$seagate_mount" "$seagate_uuid" \
  "$seagate_serial" ntfs3 'Seagate mirror'

env_file=/etc/ash-atlas/telemetry-home.env
env_preexisted=false
if [[ -e "$env_file" || -L "$env_file" ]]; then
  env_preexisted=true
  [[ -f "$env_file" && ! -L "$env_file" ]] || {
    echo "existing environment is not a regular file: $env_file" >&2
    exit 1
  }
  preflight_existing() {
    local key expected current
    key="$1"
    expected="$2"
    current="$(awk -F= -v key="$key" '$1 == key {print substr($0,index($0,"=")+1); exit}' "$env_file")"
    if [[ -n "$current" && "$current" != "$expected" ]]; then
      echo "$key differs from the existing environment; refusing to publish an unmatching install" >&2
      exit 1
    fi
  }
  preflight_existing TELEMETRY_HOME_STORAGE_ROOT "$storage_root"
  preflight_existing TELEMETRY_HOME_STORAGE_MOUNT "$storage_mount"
  preflight_existing TELEMETRY_HOME_STORAGE_UUID "$storage_uuid"
  preflight_existing TELEMETRY_HOME_STORAGE_SERIAL "$storage_serial"
  preflight_existing TELEMETRY_HOME_STORAGE_FSTYPE "$storage_fstype"
  preflight_existing TELEMETRY_SEAGATE_MOUNT "$seagate_mount"
  preflight_existing TELEMETRY_SEAGATE_UUID "$seagate_uuid"
  preflight_existing TELEMETRY_SEAGATE_SERIAL "$seagate_serial"
  preflight_existing TELEMETRY_HOME_BACKUP_CAP_BYTES 50000000000
  preflight_existing TELEMETRY_HOME_BACKUP_WARNING_BYTES 40000000000
fi

install -d -m 0750 /etc/ash-atlas /usr/local/lib/ash-atlas
install -o root -g root -m 0644 "$source_dir/ash-atlas-backup-common.sh" \
  /usr/local/lib/ash-atlas/backup-common.sh
for script in ash-atlas-telemetry-pull ash-atlas-backup-mirror \
  ash-atlas-backup-scrub ash-atlas-backup-prove ash-atlas-seagate-mount \
  ash-atlas-backup-recover ash-atlas-backup-migration \
  ash-atlas-backup-restore-check; do
  install -o root -g root -m 0755 "$source_dir/$script.sh" "/usr/local/sbin/$script"
done
install -o root -g root -m 0755 "$source_dir/ash-atlas-backup-watchdog.py" \
  /usr/local/sbin/ash-atlas-backup-watchdog
install -o root -g root -m 0755 "$source_dir/index-bug-reports.sh" \
  /usr/local/sbin/ash-atlas-bug-report-index

render_unit() {
  sed -e "s|__STORAGE_ROOT__|$storage_root|g" \
      -e "s|__SEAGATE_MOUNT__|$seagate_mount|g" "$1" >"$2"
  chmod 0644 "$2"
}
render_unit "$source_dir/ash-atlas-telemetry-pull.service.in" \
  /etc/systemd/system/ash-atlas-telemetry-pull.service
render_unit "$source_dir/ash-atlas-backup-mirror.service.in" \
  /etc/systemd/system/ash-atlas-backup-mirror.service
render_unit "$source_dir/ash-atlas-backup-prove.service.in" \
  /etc/systemd/system/ash-atlas-backup-prove.service
render_unit "$source_dir/ash-atlas-backup-scrub.service.in" \
  /etc/systemd/system/ash-atlas-backup-scrub.service
render_unit "$source_dir/ash-atlas-backup-restore-check.service.in" \
  /etc/systemd/system/ash-atlas-backup-restore-check.service
for unit in ash-atlas-telemetry-pull.timer ash-atlas-backup-mirror.timer \
  ash-atlas-backup-scrub.timer ash-atlas-seagate-mount.service \
  ash-atlas-seagate-mount.timer ash-atlas-backup-watchdog.service \
  ash-atlas-backup-watchdog.timer ash-atlas-backup-restore-check.timer; do
  install -o root -g root -m 0644 "$source_dir/$unit" "/etc/systemd/system/$unit"
done
sed "s|__SEAGATE_UUID__|$seagate_uuid|g" "$source_dir/99-ash-atlas-seagate.rules.in" \
  >/etc/udev/rules.d/99-ash-atlas-seagate.rules
chmod 0644 /etc/udev/rules.d/99-ash-atlas-seagate.rules

if [[ "$env_preexisted" == false ]]; then
  install -o root -g root -m 0600 \
    "$source_dir/telemetry-home.env.example" "$env_file"
fi
upsert() {
  local key="$1" value="$2" temporary
  temporary="$(mktemp "${env_file}.XXXXXXXX")"
  awk -v key="$key" -v value="$value" '
    BEGIN { done = 0 }
    index($0, key "=") == 1 { if (!done) print key "=" value; done = 1; next }
    { print }
    END { if (!done) print key "=" value }
  ' "$env_file" >"$temporary"
  chmod 0600 "$temporary"
  mv -f -- "$temporary" "$env_file"
}
ensure_default() {
  local key="$1" value="$2"
  grep -q "^${key}=" "$env_file" || upsert "$key" "$value"
}
ensure_fixed() {
  local key="$1" value="$2" current
  current="$(awk -F= -v key="$key" '$1 == key {print substr($0,index($0,"=")+1); exit}' "$env_file")"
  if [[ -n "$current" && "$current" != "$value" ]]; then
    echo "$key is fixed at $value decimal bytes; refusing to change an existing value" >&2
    exit 1
  fi
  [[ -n "$current" ]] || upsert "$key" "$value"
}
ensure_identity() {
  local key="$1" value="$2" current
  current="$(awk -F= -v key="$key" '$1 == key {print substr($0,index($0,"=")+1); exit}' "$env_file")"
  if [[ "$env_preexisted" == true && -n "$current" && "$current" != "$value" ]]; then
    echo "$key differs from the existing environment; refusing to replace storage identity" >&2
    exit 1
  fi
  [[ -n "$current" && "$env_preexisted" == true ]] || upsert "$key" "$value"
}
ensure_identity TELEMETRY_HOME_STORAGE_ROOT "$storage_root"
ensure_identity TELEMETRY_HOME_STORAGE_MOUNT "$storage_mount"
ensure_identity TELEMETRY_HOME_STORAGE_UUID "$storage_uuid"
ensure_identity TELEMETRY_HOME_STORAGE_SERIAL "$storage_serial"
ensure_identity TELEMETRY_HOME_STORAGE_FSTYPE "$storage_fstype"
ensure_default TELEMETRY_HOME_MINIMUM_FREE_BYTES 107374182400
ensure_fixed TELEMETRY_HOME_BACKUP_CAP_BYTES 50000000000
ensure_fixed TELEMETRY_HOME_BACKUP_WARNING_BYTES 40000000000
ensure_default TELEMETRY_HOME_BACKUP_ROOT_RESERVE_BYTES 107374182400
ensure_default TELEMETRY_HOME_BACKUP_ROOT_MAX_USED_PERCENT 75
ensure_default TELEMETRY_HOME_BACKUP_MAX_INFLIGHT_BYTES 2147483648
ensure_default TELEMETRY_HOME_BACKUP_MAX_CONCURRENT 1
ensure_default TELEMETRY_HOME_EMERGENCY_KEEP 2
ensure_default TELEMETRY_HOME_TELEMETRY_CAP_BYTES 10000000000
ensure_default TELEMETRY_HOME_TELEMETRY_WARNING_BYTES 8000000000
ensure_default TELEMETRY_BACKUP_MANIFEST_MAX_BYTES 1048576
ensure_identity TELEMETRY_SEAGATE_MOUNT "$seagate_mount"
ensure_identity TELEMETRY_SEAGATE_UUID "$seagate_uuid"
ensure_identity TELEMETRY_SEAGATE_SERIAL "$seagate_serial"
ensure_default TELEMETRY_SEAGATE_FSTYPE ntfs3
ensure_default TELEMETRY_SEAGATE_MINIMUM_FREE_BYTES 10737418240
ensure_default TELEMETRY_PORTABLE_BACKUP_ROOT "$seagate_mount/ash-atlas-backup-archive"
ensure_default TELEMETRY_PORTABLE_BACKUP_CAP_BYTES 0
ensure_default TELEMETRY_PORTABLE_BACKUP_MINIMUM_FREE_BYTES 10737418240
ensure_default TELEMETRY_PORTABLE_BACKUP_ROOT_RESERVE_BYTES 0
ensure_default TELEMETRY_PORTABLE_BACKUP_RETENTION_HOURLY 24
ensure_default TELEMETRY_PORTABLE_BACKUP_RETENTION_DAILY 14
ensure_default TELEMETRY_PORTABLE_BACKUP_RETENTION_WEEKLY 8
ensure_default TELEMETRY_PORTABLE_BACKUP_RETENTION_MONTHLY 12
ensure_default TELEMETRY_PORTABLE_TELEMETRY_CAP_BYTES 10000000000
ensure_default TELEMETRY_PORTABLE_TELEMETRY_WARNING_BYTES 8000000000
ensure_default TELEMETRY_RESTORE_WORKSPACE_CAP_BYTES 34359738368
ensure_default TELEMETRY_RESTORE_WORKSPACE_BYTES 34359738368
ensure_default TELEMETRY_RESTORE_DATABASE_ESTIMATE_BYTES 21474836480
ensure_default TELEMETRY_RESTORE_MINIMUM_FREE_BYTES 21474836480
ensure_default TELEMETRY_RESTORE_ROOT_RESERVE_BYTES 107374182400
ensure_default TELEMETRY_RESTORE_TEMP_ROOT "$storage_root/.restore-workspaces"
# Migrate only the shipped old default; custom out-of-intake paths fail closed
# in the restore checker rather than being silently repurposed.
if grep -Fxq 'TELEMETRY_RESTORE_TEMP_ROOT=/var/tmp' "$env_file"; then
  upsert TELEMETRY_RESTORE_TEMP_ROOT "$storage_root/.restore-workspaces"
fi
ensure_default TELEMETRY_BACKUP_CUTOVER_BASELINE /var/lib/ash-atlas/backup-cutover-baseline.json
upsert ASH_ATLAS_DATABASE_BACKUP_REMOTE_DIRECTORY "$storage_root/ash-atlas-database-backups"
upsert ASH_ATLAS_RESET_BACKUP_REMOTE_DIRECTORY "$storage_root/ash-atlas-reset-backups"
upsert TELEMETRY_BUG_REPORT_INDEX_ROOT "$storage_root/ash-atlas-telemetry/bug-report-index"
upsert ASH_ATLAS_RESET_BACKUP_RETENTION_COUNT 0

archive_owner="$(awk -F= '$1 == "TELEMETRY_ARCHIVE_OWNER" {print substr($0,index($0,"=")+1); exit}' "$env_file")"
[[ "$archive_owner" =~ ^[A-Za-z_][A-Za-z0-9_.-]*:[A-Za-z_][A-Za-z0-9_.-]*$ ]] || exit 1
archive_user="${archive_owner%%:*}"; archive_group="${archive_owner#*:}"
id -u -- "$archive_user" >/dev/null; getent group "$archive_group" >/dev/null
for directory in ash-atlas-telemetry ash-atlas-database-backups ash-atlas-reset-backups; do
  install -d -o "$archive_user" -g "$archive_group" -m 0750 "$storage_root/$directory"
done

systemctl daemon-reload
udevadm control --reload-rules
echo 'Installed staged intake, Seagate mirror, bounded proof, normal-mount retry, deep scrub, watchdog, and recovery command.'
echo 'Services were not enabled or started. Seed and verify the internal intake before activation.'
