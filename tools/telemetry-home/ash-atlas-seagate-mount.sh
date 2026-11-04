#!/usr/bin/env bash
set -euo pipefail

: "${TELEMETRY_SEAGATE_MOUNT:?Seagate mount is required}"
: "${TELEMETRY_SEAGATE_UUID:?Seagate UUID is required}"
: "${TELEMETRY_SEAGATE_SERIAL:?Seagate serial is required}"

for command in awk blkid findmnt flock jq mountpoint readlink realpath systemctl \
  systemd-escape udevadm; do
  command -v "$command" >/dev/null || {
    echo "required command is missing: $command" >&2
    exit 1
  }
done

common="${ASH_ATLAS_BACKUP_COMMON:-/usr/local/lib/ash-atlas/backup-common.sh}"
[[ -r "$common" ]] || exit 1
# shellcheck source=ash-atlas-backup-common.sh
source "$common"

mount_lock="${ASH_ATLAS_SEAGATE_MOUNT_LOCK:-/run/lock/ash-atlas-seagate-mount.lock}"
[[ "$mount_lock" == /run/lock/* ]] || exit 2
exec 9>"$mount_lock"
flock -n 9 || exit 0

[[ "$TELEMETRY_SEAGATE_MOUNT" =~ ^/[A-Za-z0-9._/-]+$ &&
   "$TELEMETRY_SEAGATE_MOUNT" != "/" &&
   -d "$TELEMETRY_SEAGATE_MOUNT" &&
   ! -L "$TELEMETRY_SEAGATE_MOUNT" ]] || {
  echo "Seagate mount path is absent or unsafe" >&2
  exit 1
}

if ! mountpoint -q -- "$TELEMETRY_SEAGATE_MOUNT"; then
  if [[ "${TELEMETRY_TEST_MODE:-false}" == true ]]; then
    uuid_link="${TELEMETRY_TEST_UUID_LINK:?test UUID link is required}"
    [[ "$uuid_link" == /tmp/ash-atlas-seagate-mount-test.*/* &&
       -L "$uuid_link" &&
       "$(realpath -e -- "$uuid_link")" == /tmp/ash-atlas-seagate-mount-test.*/* ]] || {
      echo "test Seagate UUID link is outside the disposable namespace" >&2
      exit 1
    }
  else
    uuid_link="/dev/disk/by-uuid/$TELEMETRY_SEAGATE_UUID"
  fi
  [[ -e "$uuid_link" ]] || {
    echo "Seagate UUID is not currently attached" >&2
    exit 20
  }
  partition="$(readlink -f -- "$uuid_link")"
  [[ "$(blkid -s UUID -o value "$partition")" == "$TELEMETRY_SEAGATE_UUID" ]] || {
    echo "attached filesystem UUID mismatch" >&2
    exit 21
  }
  serial="$(
    udevadm info --query=property --name="$partition" |
      awk -F= '$1 == "ID_SERIAL_SHORT" {print substr($0, index($0, "=") + 1); exit}'
  )"
  [[ "$serial" == "$TELEMETRY_SEAGATE_SERIAL" ]] || {
    echo "attached Seagate serial mismatch" >&2
    exit 22
  }
  mount_unit="$(systemd-escape --path --suffix=mount -- "$TELEMETRY_SEAGATE_MOUNT")"
  [[ "$mount_unit" =~ ^[A-Za-z0-9_.@\\-]+\.mount$ ]] || {
    echo "generated Seagate mount unit is unsafe" >&2
    exit 1
  }
  echo "Requesting $mount_unit through the system manager."
  systemctl start "$mount_unit"
fi

ash_backup_validate_storage \
  "$TELEMETRY_SEAGATE_MOUNT" "$TELEMETRY_SEAGATE_MOUNT" \
  "$TELEMETRY_SEAGATE_UUID" "$TELEMETRY_SEAGATE_SERIAL" ntfs3 \
  "Seagate mirror"

systemctl start --no-block ash-atlas-backup-mirror.service
systemctl start --no-block ha-stack-health-check.service
echo 'Seagate mount verified; mirror and health refresh requested.'
