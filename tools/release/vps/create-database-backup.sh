#!/usr/bin/env bash
set -euo pipefail
umask 077

fail() {
  printf 'STOP: %s\n' "$*" >&2
  exit 1
}

test_mode="${ASH_ATLAS_DATABASE_BACKUP_TEST_MODE:-false}"
backup_mount="${ASH_ATLAS_BACKUP_MOUNT:-/mnt/ash-atlas-backups}"
backup_uuid="${ASH_ATLAS_BACKUP_UUID:?backup filesystem UUID is required}"
backup_serial="${ASH_ATLAS_BACKUP_DEVICE_SERIAL:?backup device serial is required}"
backup_root="${ASH_ATLAS_DATABASE_BACKUP_ROOT:-${backup_mount}/postgresql}"
database="${ASH_ATLAS_DATABASE_BACKUP_DATABASE:-ash_atlas_game}"
backup_class="${ASH_ATLAS_DATABASE_BACKUP_CLASS:-hourly}"
minimum_free_bytes="${ASH_ATLAS_DATABASE_BACKUP_MINIMUM_FREE_BYTES:-10737418240}"
estimated_bytes_floor="${ASH_ATLAS_DATABASE_BACKUP_ESTIMATED_BYTES_FLOOR:-1073741824}"
estimate_percent="${ASH_ATLAS_DATABASE_BACKUP_ESTIMATE_PERCENT:-125}"
pull_user="${TELEMETRY_PULL_USER:-ash-telemetry-pull}"
release_link="${ASH_ATLAS_CURRENT_RELEASE_LINK:-/srv/ash-atlas/game/current}"
lock="${ASH_ATLAS_DATABASE_BACKUP_LOCK:-/run/lock/ash-atlas-database-backup.lock}"

[[ "$backup_mount" =~ ^/[A-Za-z0-9._/-]+$ && "$backup_mount" != "/" ]] ||
  fail 'backup mount is unsafe'
[[ "$backup_root" == "$backup_mount"/* && "$backup_root" != *"//"* &&
   "$backup_root" != *"/../"* && "$backup_root" != *"/./"* ]] ||
  fail 'database backup root is outside the backup mount'
[[ "$backup_uuid" =~ ^[A-Za-z0-9._-]+$ ]] || fail 'backup UUID is invalid'
[[ "$backup_serial" =~ ^[A-Za-z0-9._-]+$ ]] || fail 'backup serial is invalid'
[[ "$database" =~ ^[a-z][a-z0-9_]{0,62}$ ]] || fail 'database name is invalid'
case "$backup_class" in hourly|daily|weekly|monthly|pre-migration|milestone) ;;
  *) fail 'database backup class is invalid' ;;
esac
[[ "$minimum_free_bytes" =~ ^[1-9][0-9]*$ ]] || fail 'minimum free bytes is invalid'
[[ "$estimated_bytes_floor" =~ ^[1-9][0-9]*$ ]] || fail 'estimated backup floor is invalid'
[[ "$estimate_percent" =~ ^[1-9][0-9]*$ ]] || fail 'backup estimate percentage is invalid'

for command in cut find findmnt mountpoint jq readlink udevadm awk flock install \
  mktemp pg_restore sha256sum sort stat sync mv date df basename cat id sed; do
  command -v "$command" >/dev/null || fail "required command is missing: $command"
done
if [[ "$test_mode" != "true" ]]; then
  [[ $EUID -eq 0 ]] || fail 'database backup creation must run as root'
  for command in pg_dump runuser; do
    command -v "$command" >/dev/null || fail "required command is missing: $command"
  done
fi

exec 9>"$lock"
flock -n 9 || exit 0
mountpoint -q -- "$backup_mount" || fail 'backup filesystem is not mounted'
mounted_target="$(findmnt -n -T "$backup_mount" -o TARGET)"
mounted_source="$(findmnt -n -T "$backup_mount" -o SOURCE)"
mounted_uuid="$(findmnt -n -T "$backup_mount" -o UUID)"
mounted_options="$(findmnt -n -T "$backup_mount" -o OPTIONS)"
[[ "$mounted_target" == "$backup_mount" && "$mounted_uuid" == "$backup_uuid" &&
   ",$mounted_options," == *,rw,* ]] || fail 'backup mount identity is invalid'
if [[ "$test_mode" == "true" ]]; then
  mounted_serial="${ASH_ATLAS_DATABASE_BACKUP_TEST_DEVICE_SERIAL:-TEST-SERIAL}"
else
  [[ "$mounted_source" == /dev/* ]] || fail 'backup mount source is not a block device'
  mounted_device="$(readlink -f -- "$mounted_source")"
  [[ "$mounted_device" == /dev/* ]] || fail 'backup block device cannot be resolved'
  mounted_serial="$(
    udevadm info --query=property --name="$mounted_device" |
      awk -F= '$1 == "ID_SERIAL_SHORT" {print substr($0, index($0, "=") + 1); exit}'
  )"
fi
[[ -n "$mounted_serial" && "$mounted_serial" == "$backup_serial" ]] ||
  fail 'backup device serial does not match configuration'

partial_root="${backup_root}/.partial"
ready_root="${backup_root}/ready"
rejected_root="${backup_root}/rejected"
ack_root="${backup_root}/acknowledgments"
if [[ "$test_mode" == "true" ]]; then
  install -d -m 0700 "$backup_root" "$partial_root" "$ready_root" "$rejected_root"
  install -d -m 0730 "$ack_root"
else
  install -d -o root -g root -m 0700 \
    "$backup_root" "$partial_root" "$ready_root" "$rejected_root"
  id "$pull_user" >/dev/null 2>&1 || fail 'restricted pull account is absent'
  install -d -o root -g "$(id -gn "$pull_user")" -m 0730 "$ack_root"
  # install -d -m updates the owning-mode bits on existing directories, which
  # also narrows an ACL mask. Restore the restricted account's effective
  # traversal/read mask on every run before anything can be published.
  command -v setfacl >/dev/null || fail 'setfacl is required for restricted pull access'
  setfacl -m "u:${pull_user}:--x,m::--x" "$backup_root"
  setfacl -m "u:${pull_user}:r-x,m::r-x" "$ready_root"
fi

available_bytes="$(df -PB1 "$backup_root" | awk 'NR == 2 {print $4}')"
[[ "$available_bytes" =~ ^[0-9]+$ ]] || fail 'backup free space is unreadable'
latest_manifest="$(find "$ready_root" -mindepth 2 -maxdepth 2 -type f \
  -name '*.dump.ready.json' -printf '%T@|%p\n' 2>/dev/null |
  sort -nr | sed -n '1p' | cut -d'|' -f2- || true)"
estimated_bytes="$estimated_bytes_floor"
if [[ -n "$latest_manifest" ]]; then
  latest_bytes="$(jq -er '.artifact.bytes | select(type == "number" and . > 0)' \
    "$latest_manifest")" || fail 'latest backup size estimate is invalid'
  scaled_bytes=$(( (latest_bytes * estimate_percent + 99) / 100 ))
  (( scaled_bytes > estimated_bytes )) && estimated_bytes="$scaled_bytes"
fi
required_free_bytes=$(( minimum_free_bytes + estimated_bytes ))
(( available_bytes >= required_free_bytes )) ||
  fail "insufficient backup free space: available=${available_bytes} required=${required_free_bytes}"

if [[ "$test_mode" == "true" ]]; then
  release_sha="${ASH_ATLAS_DATABASE_BACKUP_TEST_RELEASE_SHA:-$(printf 'a%.0s' {1..40})}"
else
  release_target="$(readlink -f -- "$release_link")"
  release_sha="$(basename "$release_target")"
fi
[[ "$release_sha" =~ ^[a-f0-9]{40}$ ]] || fail 'active release identity is invalid'

backup_id="$(cat /proc/sys/kernel/random/uuid)"
[[ "$backup_id" =~ ^[a-f0-9-]{36}$ ]] || fail 'could not create backup identifier'
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
created_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
file_name="${database}-${backup_class}-${timestamp}-${release_sha}-${backup_id}.dump"
manifest_name="${file_name}.ready.json"
work="$(mktemp -d "${partial_root}/backup-${backup_id}.XXXXXXXX")"
final="${ready_root}/backup-${backup_id}"
dump_path="${work}/${file_name}"
manifest_path="${work}/${manifest_name}"

published=false
cleanup() {
  local code=$?
  if [[ "$published" != "true" && -d "$work" && ! -L "$work" ]]; then
    mv -- "$work" "${rejected_root}/failed-${backup_id}-$(date -u +%Y%m%dT%H%M%SZ)" \
      2>/dev/null || true
  fi
  exit "$code"
}
trap cleanup EXIT

printf 'Creating %s PostgreSQL backup for %s\n' "$backup_class" "$database" >&2
if [[ "$test_mode" == "true" ]]; then
  dump_command="${ASH_ATLAS_DATABASE_BACKUP_PG_DUMP:?test pg_dump command is required}"
  "$dump_command" --format=custom --compress=6 --dbname="$database" >"$dump_path"
else
  # The root shell owns the destination; pg_dump itself drops to postgres.
  runuser -u postgres -- pg_dump --format=custom --compress=6 --dbname="$database" \
    >"$dump_path"
fi
chmod 0600 "$dump_path"
bytes="$(stat -c '%s' "$dump_path")"
[[ "$bytes" =~ ^[1-9][0-9]*$ ]] || fail 'PostgreSQL backup is empty'
pg_restore --list "$dump_path" >/dev/null || fail 'PostgreSQL restore catalog is invalid'
sha256="$(sha256sum "$dump_path" | awk '{print $1}')"
[[ "$sha256" =~ ^[a-f0-9]{64}$ ]] || fail 'backup checksum is invalid'

jq -cn \
  --arg backupId "$backup_id" \
  --arg backupClass "$backup_class" \
  --arg database "$database" \
  --arg releaseSha "$release_sha" \
  --arg createdAtUtc "$created_at" \
  --arg fileName "$file_name" \
  --arg sha256 "$sha256" \
  --argjson bytes "$bytes" '
    {
      manifestVersion:1,
      kind:"ash_atlas_postgresql_backup",
      backupId:$backupId,
      backupClass:$backupClass,
      database:$database,
      releaseSha:$releaseSha,
      createdAtUtc:$createdAtUtc,
      artifact:{
        fileName:$fileName,
        format:"postgresql-custom",
        bytes:$bytes,
        sha256:$sha256
      },
      acknowledgmentState:"pending"
    }
  ' >"$manifest_path"
chmod 0600 "$manifest_path"
sync -f "$dump_path"
sync -f "$manifest_path"
sync -f "$work"
if [[ "$test_mode" != "true" ]]; then
  command -v setfacl >/dev/null || fail 'setfacl is required for restricted pull access'
  setfacl -m "u:${pull_user}:r-x" "$work"
  setfacl -m "u:${pull_user}:r--" "$dump_path" "$manifest_path"
fi
mv -- "$work" "$final"
sync -f "$ready_root"
published=true
trap - EXIT
printf '%s\n' "${final}/${manifest_name}"
