#!/usr/bin/env bash
set -euo pipefail
umask 077

fail() {
  printf 'STOP: %s\n' "$*" >&2
  exit 1
}

[[ $EUID -eq 0 ]] || fail 'run as root'
[[ $# -eq 4 ]] || fail 'usage: install-database-backup.sh /mnt/ash-atlas-backups filesystem-uuid device-serial seagate-uuid'
mount_path="$1"
filesystem_uuid="$2"
device_serial="$3"
seagate_uuid="$4"
[[ "$mount_path" == "/mnt/ash-atlas-backups" ]] || fail 'backup mount must use the canonical path'
[[ "$filesystem_uuid" =~ ^[A-Za-z0-9._-]+$ ]] || fail 'filesystem UUID is invalid'
[[ "$device_serial" =~ ^[A-Za-z0-9._-]+$ ]] || fail 'device serial is invalid'
[[ "$seagate_uuid" =~ ^[A-Za-z0-9._-]+$ ]] || fail 'Seagate UUID is invalid'
for command in awk chmod chown findmnt grep install jq mktemp mountpoint mv pg_dump \
  pg_restore readlink runuser sed setfacl systemctl udevadm; do
  command -v "$command" >/dev/null || fail "required command is missing: $command"
done
mountpoint -q -- "$mount_path" || fail 'backup filesystem is not mounted'
mounted_target="$(findmnt -n -T "$mount_path" -o TARGET)"
mounted_source="$(findmnt -n -T "$mount_path" -o SOURCE)"
mounted_uuid="$(findmnt -n -T "$mount_path" -o UUID)"
mounted_options="$(findmnt -n -T "$mount_path" -o OPTIONS)"
[[ "$mounted_target" == "$mount_path" && "$mounted_uuid" == "$filesystem_uuid" &&
   ",$mounted_options," == *,rw,* && "$mounted_source" == /dev/* ]] ||
  fail 'backup filesystem identity is invalid'
mounted_device="$(readlink -f -- "$mounted_source")"
mounted_serial="$(
  udevadm info --query=property --name="$mounted_device" |
    awk -F= '$1 == "ID_SERIAL_SHORT" {print substr($0, index($0, "=") + 1); exit}'
)"
[[ -n "$mounted_serial" && "$mounted_serial" == "$device_serial" ]] ||
  fail 'backup device serial does not match'

source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
pull_user="${TELEMETRY_PULL_USER:-ash-telemetry-pull}"
id "$pull_user" >/dev/null 2>&1 || fail 'restricted home pull account is absent'
pull_group="$(id -gn "$pull_user")"
backup_root="${mount_path}/postgresql"
ready_root="${backup_root}/ready"
ack_root="${backup_root}/acknowledgments"
seagate_ack_root="${backup_root}/seagate-acknowledgments"
retention_receipt_root="${backup_root}/retention-receipts"
install -d -o root -g root -m 0700 \
  "$backup_root" "${backup_root}/.partial" "$ready_root" "${backup_root}/rejected" \
  "$retention_receipt_root"
install -d -o root -g "$pull_group" -m 0730 "$ack_root" "$seagate_ack_root"
setfacl -m "u:${pull_user}:--x" "$mount_path" "$backup_root"
setfacl -m "u:${pull_user}:r-x" "$ready_root"

install -d -o root -g root -m 0755 /etc/ash-atlas
if [[ ! -e /etc/ash-atlas/database-backup.env ]]; then
  sed \
    -e "s|^ASH_ATLAS_BACKUP_MOUNT=.*|ASH_ATLAS_BACKUP_MOUNT=${mount_path}|" \
    -e "s|^ASH_ATLAS_BACKUP_UUID=.*|ASH_ATLAS_BACKUP_UUID=${filesystem_uuid}|" \
    -e "s|^ASH_ATLAS_BACKUP_DEVICE_SERIAL=.*|ASH_ATLAS_BACKUP_DEVICE_SERIAL=${device_serial}|" \
    -e "s|^ASH_ATLAS_SEAGATE_PROOF_UUID=.*|ASH_ATLAS_SEAGATE_PROOF_UUID=${seagate_uuid}|" \
    "$source_dir/database-backup.env.example" >/etc/ash-atlas/database-backup.env
  chmod 0600 /etc/ash-atlas/database-backup.env
else
  grep -qx "ASH_ATLAS_BACKUP_MOUNT=${mount_path}" /etc/ash-atlas/database-backup.env ||
    fail 'existing database backup environment uses another mount'
  grep -qx "ASH_ATLAS_BACKUP_UUID=${filesystem_uuid}" /etc/ash-atlas/database-backup.env ||
    fail 'existing database backup environment uses another UUID'
  grep -qx "ASH_ATLAS_BACKUP_DEVICE_SERIAL=${device_serial}" /etc/ash-atlas/database-backup.env ||
    fail 'existing database backup environment uses another serial'
fi

upsert() {
  local key="$1" value="$2" target="$3" temporary
  temporary="$(mktemp "${target}.XXXXXXXX")"
  awk -v key="$key" -v value="$value" '
    BEGIN { done = 0 }
    index($0, key "=") == 1 { if (!done) print key "=" value; done = 1; next }
    { print }
    END { if (!done) print key "=" value }
  ' "$target" >"$temporary"
  chmod --reference="$target" "$temporary"
  chown --reference="$target" "$temporary"
  mv -f -- "$temporary" "$target"
}
ensure_default() {
  local key="$1" value="$2" target="$3"
  grep -q "^${key}=" "$target" || upsert "$key" "$value" "$target"
}
upsert ASH_ATLAS_SEAGATE_PROOF_UUID "$seagate_uuid" /etc/ash-atlas/database-backup.env
ensure_default ASH_ATLAS_DATABASE_BACKUP_ESTIMATED_BYTES_FLOOR 1073741824 /etc/ash-atlas/database-backup.env
ensure_default ASH_ATLAS_DATABASE_BACKUP_ESTIMATE_PERCENT 125 /etc/ash-atlas/database-backup.env
ensure_default ASH_ATLAS_DATABASE_BACKUP_FRESHNESS_MINUTES 180 /etc/ash-atlas/database-backup.env
# Hourly retention dropped to 6 so unacknowledged full dumps cannot fill the
# backup disk. Replace only the earlier stock values (24, 48); keep a custom one.
if grep -Eqx 'ASH_ATLAS_DATABASE_BACKUP_RETENTION_HOURLY=(24|48)' /etc/ash-atlas/database-backup.env; then
  upsert ASH_ATLAS_DATABASE_BACKUP_RETENTION_HOURLY 6 /etc/ash-atlas/database-backup.env
fi
ensure_default ASH_ATLAS_DATABASE_BACKUP_RETENTION_HOURLY 6 /etc/ash-atlas/database-backup.env
ensure_default ASH_ATLAS_DATABASE_BACKUP_RETENTION_DAILY 14 /etc/ash-atlas/database-backup.env
ensure_default ASH_ATLAS_DATABASE_BACKUP_RETENTION_WEEKLY 8 /etc/ash-atlas/database-backup.env
ensure_default ASH_ATLAS_DATABASE_BACKUP_RETENTION_MONTHLY 6 /etc/ash-atlas/database-backup.env
ensure_default ASH_ATLAS_DATABASE_BACKUP_RETENTION_PRE_MIGRATION 3 /etc/ash-atlas/database-backup.env

health_env=/etc/ash-atlas/database-health.env
health_temporary="$(mktemp "${health_env}.XXXXXXXX")"
awk '
  /^(ASH_ATLAS_BACKUP_MOUNT|ASH_ATLAS_BACKUP_UUID|ASH_ATLAS_BACKUP_DEVICE_SERIAL|ASH_ATLAS_DATABASE_BACKUP_ROOT|ASH_ATLAS_DATABASE_BACKUP_MINIMUM_FREE_BYTES|ASH_ATLAS_DATABASE_BACKUP_ESTIMATED_BYTES_FLOOR|ASH_ATLAS_DATABASE_BACKUP_ESTIMATE_PERCENT|ASH_ATLAS_DATABASE_BACKUP_FRESHNESS_MINUTES|ASH_ATLAS_DATABASE_BACKUP_RETENTION_HOURLY|ASH_ATLAS_DATABASE_BACKUP_RETENTION_DAILY|ASH_ATLAS_DATABASE_BACKUP_RETENTION_WEEKLY|ASH_ATLAS_DATABASE_BACKUP_RETENTION_MONTHLY|ASH_ATLAS_DATABASE_BACKUP_RETENTION_PRE_MIGRATION|ASH_ATLAS_SEAGATE_PROOF_UUID)=/ { print }
' /etc/ash-atlas/database-backup.env >"$health_temporary"
chown root:root "$health_temporary"
chmod 0644 "$health_temporary"
mv -f -- "$health_temporary" "$health_env"

install -o root -g root -m 0755 "$source_dir/telemetry-pull-command.sh" \
  /usr/local/libexec/ash-atlas-telemetry-pull-command
install -o root -g root -m 0644 \
  "$source_dir/ash-atlas-database-backup@.service" \
  "$source_dir/ash-atlas-database-backup-hourly.timer" \
  "$source_dir/ash-atlas-database-backup-daily.timer" \
  "$source_dir/ash-atlas-database-backup-weekly.timer" \
  "$source_dir/ash-atlas-database-backup-monthly.timer" \
  "$source_dir/ash-atlas-database-retention.service" \
  "$source_dir/ash-atlas-database-retention.timer" \
  "$source_dir/ash-atlas-backup-health-alert.service" \
  "$source_dir/ash-atlas-backup-health-alert.timer" \
  /etc/systemd/system/
systemctl daemon-reload
echo 'Installed the database backup service and protocol but did not enable or start the timer.'
