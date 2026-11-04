#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
namespace="$(mktemp -d /tmp/ash-atlas-database-backup-test.XXXXXXXX)"
trap 'rm -rf -- "$namespace"' EXIT

example_setting() {
  tr -d '\r' <"$script_dir/database-backup.env.example" | grep -qx "$1"
}
example_setting 'ASH_ATLAS_DATABASE_BACKUP_RETENTION_HOURLY=6'
example_setting 'ASH_ATLAS_DATABASE_BACKUP_RETENTION_DAILY=14'
example_setting 'ASH_ATLAS_DATABASE_BACKUP_RETENTION_WEEKLY=8'
example_setting 'ASH_ATLAS_DATABASE_BACKUP_RETENTION_MONTHLY=6'
example_setting 'ASH_ATLAS_DATABASE_BACKUP_RETENTION_PRE_MIGRATION=3'
for setting in 'HOURLY 6' 'DAILY 14' 'WEEKLY 8' 'MONTHLY 6' 'PRE_MIGRATION 3'; do
  grep -Fqx "ensure_default ASH_ATLAS_DATABASE_BACKUP_RETENTION_${setting} /etc/ash-atlas/database-backup.env" \
    "$script_dir/install-database-backup.sh"
done
grep -Fqx '  upsert ASH_ATLAS_DATABASE_BACKUP_RETENTION_HOURLY 6 /etc/ash-atlas/database-backup.env' \
  "$script_dir/install-database-backup.sh"
grep -Fq 'hourly_keep="${ASH_ATLAS_DATABASE_BACKUP_RETENTION_HOURLY:-6}"' \
  "$script_dir/prune-database-backups.sh"
grep -Fq 'daily_keep="${ASH_ATLAS_DATABASE_BACKUP_RETENTION_DAILY:-14}"' \
  "$script_dir/prune-database-backups.sh"
grep -Fq 'weekly_keep="${ASH_ATLAS_DATABASE_BACKUP_RETENTION_WEEKLY:-8}"' \
  "$script_dir/prune-database-backups.sh"
grep -Fq 'monthly_keep="${ASH_ATLAS_DATABASE_BACKUP_RETENTION_MONTHLY:-6}"' \
  "$script_dir/prune-database-backups.sh"
grep -Fq 'pre_migration_keep="${ASH_ATLAS_DATABASE_BACKUP_RETENTION_PRE_MIGRATION:-3}"' \
  "$script_dir/prune-database-backups.sh"

mkdir -p "$namespace/bin" "$namespace/mount/postgresql/"{ready,acknowledgments,seagate-acknowledgments,retention-receipts}
cat >"$namespace/bin/mountpoint" <<'SH'
#!/usr/bin/env bash
exit 0
SH
cat >"$namespace/bin/findmnt" <<'SH'
#!/usr/bin/env bash
case "${!#}" in
  TARGET) printf '%s\n' "${ASH_ATLAS_BACKUP_MOUNT:?}" ;;
  SOURCE) printf 'tmpfs\n' ;;
  UUID) printf '%s\n' "${ASH_ATLAS_BACKUP_UUID:?}" ;;
  OPTIONS) printf 'rw,relatime\n' ;;
  *) exit 2 ;;
esac
SH
chmod 0755 "$namespace/bin/"*

export PATH="$namespace/bin:$PATH"
export ASH_ATLAS_DATABASE_BACKUP_TEST_MODE=true
export ASH_ATLAS_BACKUP_MOUNT="$namespace/mount"
export ASH_ATLAS_BACKUP_UUID=TEST-OVH-UUID
export ASH_ATLAS_BACKUP_DEVICE_SERIAL=TEST-OVH-SERIAL
export ASH_ATLAS_DATABASE_BACKUP_TEST_DEVICE_SERIAL=TEST-OVH-SERIAL
export ASH_ATLAS_DATABASE_BACKUP_ROOT="$namespace/mount/postgresql"
export ASH_ATLAS_DATABASE_BACKUP_LOCK="$namespace/retention.lock"
export ASH_ATLAS_DATABASE_BACKUP_MINIMUM_FREE_BYTES=1
export ASH_ATLAS_DATABASE_BACKUP_RETENTION_HOURLY=2
export ASH_ATLAS_DATABASE_BACKUP_RETENTION_DAILY=1
export ASH_ATLAS_DATABASE_BACKUP_RETENTION_WEEKLY=1
export ASH_ATLAS_DATABASE_BACKUP_RETENTION_MONTHLY=1
export ASH_ATLAS_DATABASE_BACKUP_RETENTION_PRE_MIGRATION=2
export ASH_ATLAS_SEAGATE_PROOF_UUID=TEST-SEAGATE-UUID

make_backup() {
  local id="$1" class="$2" created="$3" directory file bytes sha manifest source_id
  directory="$ASH_ATLAS_DATABASE_BACKUP_ROOT/ready/backup-$id"
  file="ash_atlas_game-${class}-${id}.dump"
  mkdir "$directory"
  printf 'backup fixture %s %s\n' "$class" "$id" >"$directory/$file"
  bytes="$(stat -c '%s' "$directory/$file")"
  sha="$(sha256sum "$directory/$file" | awk '{print $1}')"
  manifest="$file.ready.json"
  jq -cn --arg id "$id" --arg class "$class" --arg created "$created" \
    --arg file "$file" --arg sha "$sha" --argjson bytes "$bytes" '
      {manifestVersion:1,kind:"ash_atlas_postgresql_backup",backupId:$id,
       backupClass:$class,createdAtUtc:$created,
       artifact:{fileName:$file,bytes:$bytes,sha256:$sha}}' >"$directory/$manifest"
  source_id="source-$id"
  jq -cn --arg id "$id" --arg file "$file" --arg manifest "$manifest" \
    --arg sha "$sha" --arg source "$source_id" --argjson bytes "$bytes" '
      {acknowledgmentVersion:1,event:"ash_atlas_postgresql_backup_verified",
       acknowledgmentId:$source,backupId:$id,manifestFileName:$manifest,
       backupFileName:$file,bytes:$bytes,sha256:$sha,
       remoteVerifiedAtUtc:"2026-08-20T00:00:00Z",restoreCatalogVerified:true}' \
    >"$ASH_ATLAS_DATABASE_BACKUP_ROOT/acknowledgments/$id.ack.json"
  jq -cn --arg id "$id" --arg file "$file" --arg manifest "$manifest" \
    --arg sha "$sha" --arg source "$source_id" \
    --arg seagate "$ASH_ATLAS_SEAGATE_PROOF_UUID" --argjson bytes "$bytes" '
      {seagateAcknowledgmentVersion:1,
       event:"ash_atlas_postgresql_backup_seagate_verified",
       sourceAcknowledgmentId:$source,backupId:$id,manifestFileName:$manifest,
       backupFileName:$file,bytes:$bytes,sha256:$sha,seagateUuid:$seagate,
       seagateVerifiedAtUtc:"2026-08-21T00:00:00Z",verification:"sha256-deep",
       restoreCatalogVerified:true}' \
    >"$ASH_ATLAS_DATABASE_BACKUP_ROOT/seagate-acknowledgments/$id.seagate.ack.json"
}

ids=(
  00000000-0000-0000-0000-000000000001
  00000000-0000-0000-0000-000000000002
  00000000-0000-0000-0000-000000000003
  00000000-0000-0000-0000-000000000004
  00000000-0000-0000-0000-000000000005
  00000000-0000-0000-0000-000000000006
  00000000-0000-0000-0000-000000000007
  00000000-0000-0000-0000-000000000008
  00000000-0000-0000-0000-000000000009
  00000000-0000-0000-0000-000000000010
  00000000-0000-0000-0000-000000000011
)
make_backup "${ids[0]}" hourly 2026-08-20T01:00:00Z
make_backup "${ids[1]}" hourly 2026-08-20T02:00:00Z
make_backup "${ids[2]}" hourly 2026-08-20T03:00:00Z
make_backup "${ids[3]}" hourly 2026-08-20T04:00:00Z
make_backup "${ids[4]}" daily 2026-08-19T03:20:00Z
make_backup "${ids[5]}" daily 2026-08-20T03:20:00Z
make_backup "${ids[6]}" pre-migration 2026-08-18T00:00:00Z
make_backup "${ids[7]}" pre-migration 2026-08-19T00:00:00Z
make_backup "${ids[8]}" pre-migration 2026-08-20T00:00:00Z
make_backup "${ids[9]}" pre-migration 2026-08-21T00:00:00Z
make_backup "${ids[10]}" milestone 2026-08-01T00:00:00Z

pruner="$script_dir/prune-database-backups.sh"
if ASH_ATLAS_DATABASE_BACKUP_RETENTION_PRE_MIGRATION=0 \
    bash "$pruner" --dry-run >/dev/null 2>&1; then
  echo 'zero pre-migration retention unexpectedly accepted' >&2
  exit 1
fi
plan="$(bash "$pruner" --dry-run)"
jq -e '.mode == "dry-run" and .candidateCount == 5 and .appliedCount == 0
  and .retainedCount == 6 and (.candidates | length) == 5
  and ([.candidates[] | select(.backupClass == "pre-migration")] | length) == 2
  and ([.candidates[] | select(.backupClass == "milestone")] | length) == 0' \
  <<<"$plan" >/dev/null
[[ "$(find "$ASH_ATLAS_DATABASE_BACKUP_ROOT/ready" -mindepth 1 -maxdepth 1 -type d | wc -l)" == 11 ]]

# A daily beyond its limit still waits for both home acknowledgments.
missing_daily_ack="$ASH_ATLAS_DATABASE_BACKUP_ROOT/seagate-acknowledgments/${ids[4]}.seagate.ack.json"
mv "$missing_daily_ack" "$namespace/missing-daily-ack.json"
plan="$(bash "$pruner" --dry-run)"
jq -e --arg daily "${ids[4]}" '.candidateCount == 4 and .retainedCount == 7
  and ([.candidates[] | select(.backupId == $daily)] | length) == 0' <<<"$plan" >/dev/null
mv "$namespace/missing-daily-ack.json" "$missing_daily_ack"

# An hourly beyond its limit retires without either home acknowledgment.
missing_ack="$ASH_ATLAS_DATABASE_BACKUP_ROOT/seagate-acknowledgments/${ids[0]}.seagate.ack.json"
missing_source_ack="$ASH_ATLAS_DATABASE_BACKUP_ROOT/acknowledgments/${ids[0]}.ack.json"
mv "$missing_ack" "$namespace/missing-ack.json"
mv "$missing_source_ack" "$namespace/missing-source-ack.json"
plan="$(bash "$pruner" --dry-run)"
jq -e --arg hourly "${ids[0]}" '.candidateCount == 5 and .retainedCount == 6
  and ([.candidates[] | select(.backupId == $hourly and .homeAcknowledged == false
        and .reason == "beyond_hourly_limit_without_home_ack")] | length) == 1' \
  <<<"$plan" >/dev/null
mv "$namespace/missing-ack.json" "$missing_ack"
mv "$namespace/missing-source-ack.json" "$missing_source_ack"

cp "$missing_ack" "$namespace/good-ack.json"
jq '.seagateUuid="WRONG"' "$missing_ack" >"$namespace/bad-ack.json"
mv "$namespace/bad-ack.json" "$missing_ack"
if bash "$pruner" --dry-run >/dev/null 2>&1; then
  echo 'malformed Seagate proof unexpectedly permitted retention' >&2
  exit 1
fi
mv "$namespace/good-ack.json" "$missing_ack"

ln -s /etc/passwd "$ASH_ATLAS_DATABASE_BACKUP_ROOT/ready/backup-${ids[3]}/unsafe"
if bash "$pruner" --dry-run >/dev/null 2>&1; then
  echo 'unsafe ready entry unexpectedly permitted retention' >&2
  exit 1
fi
rm "$ASH_ATLAS_DATABASE_BACKUP_ROOT/ready/backup-${ids[3]}/unsafe"

# Apply with home acknowledgments missing for an hourly beyond the limit
# (ids[0]), an hourly within the limit (ids[3]) and a daily beyond the limit
# (ids[4]): only the over-limit hourly retires without proof.
for unacked in "${ids[0]}" "${ids[3]}" "${ids[4]}"; do
  rm "$ASH_ATLAS_DATABASE_BACKUP_ROOT/acknowledgments/$unacked.ack.json" \
    "$ASH_ATLAS_DATABASE_BACKUP_ROOT/seagate-acknowledgments/$unacked.seagate.ack.json"
done
plan="$(bash "$pruner" --apply)"
jq -e '.mode == "apply" and .candidateCount == 4 and .appliedCount == 4
  and .retainedCount == 7' <<<"$plan" >/dev/null
[[ -d "$ASH_ATLAS_DATABASE_BACKUP_ROOT/ready/backup-${ids[10]}" ]]
[[ ! -e "$ASH_ATLAS_DATABASE_BACKUP_ROOT/ready/backup-${ids[0]}" ]]
[[ ! -e "$ASH_ATLAS_DATABASE_BACKUP_ROOT/ready/backup-${ids[1]}" ]]
[[ -d "$ASH_ATLAS_DATABASE_BACKUP_ROOT/ready/backup-${ids[3]}" ]]
[[ -d "$ASH_ATLAS_DATABASE_BACKUP_ROOT/ready/backup-${ids[4]}" ]]
[[ "$(find "$ASH_ATLAS_DATABASE_BACKUP_ROOT/ready" -mindepth 1 -maxdepth 1 -type d | wc -l)" == 7 ]]
[[ "$(find "$ASH_ATLAS_DATABASE_BACKUP_ROOT/retention-receipts" -type f -name '*.retention.json' | wc -l)" == 4 ]]
jq -e '.retentionReceiptVersion == 1 and .backupClass == "hourly"
  and .homeAcknowledged == false and .reason == "beyond_hourly_limit_without_home_ack"
  and .sourceAcknowledgmentId == null and (.deletedAtUtc | fromdateiso8601)' \
  "$ASH_ATLAS_DATABASE_BACKUP_ROOT/retention-receipts/${ids[0]}.retention.json" >/dev/null
jq -e '.homeAcknowledged == true and .reason == "beyond_tier_limit"' \
  "$ASH_ATLAS_DATABASE_BACKUP_ROOT/retention-receipts/${ids[1]}.retention.json" >/dev/null
plan="$(bash "$pruner" --apply)"
jq -e '.candidateCount == 0 and .appliedCount == 0 and .retainedCount == 7' \
  <<<"$plan" >/dev/null

echo 'database backup retention tests passed'
