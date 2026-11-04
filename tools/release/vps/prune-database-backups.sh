#!/usr/bin/env bash
set -euo pipefail
umask 077

fail() {
  printf 'STOP: %s\n' "$*" >&2
  exit 1
}

mode="${1:---dry-run}"
[[ $# -le 1 && ( "$mode" == --dry-run || "$mode" == --apply ) ]] ||
  fail 'usage: prune-database-backups.sh [--dry-run|--apply]'

test_mode="${ASH_ATLAS_DATABASE_BACKUP_TEST_MODE:-false}"
if [[ "$test_mode" != true ]]; then
  [[ $EUID -eq 0 ]] || fail 'database backup retention must run as root'
  [[ -r /etc/ash-atlas/database-backup.env ]] || fail 'database backup environment is absent'
  # shellcheck disable=SC1091
  source /etc/ash-atlas/database-backup.env
fi

backup_mount="${ASH_ATLAS_BACKUP_MOUNT:-/mnt/ash-atlas-backups}"
backup_uuid="${ASH_ATLAS_BACKUP_UUID:?backup filesystem UUID is required}"
backup_serial="${ASH_ATLAS_BACKUP_DEVICE_SERIAL:?backup device serial is required}"
backup_root="${ASH_ATLAS_DATABASE_BACKUP_ROOT:-${backup_mount}/postgresql}"
minimum_free_bytes="${ASH_ATLAS_DATABASE_BACKUP_MINIMUM_FREE_BYTES:-10737418240}"
hourly_keep="${ASH_ATLAS_DATABASE_BACKUP_RETENTION_HOURLY:-6}"
daily_keep="${ASH_ATLAS_DATABASE_BACKUP_RETENTION_DAILY:-14}"
weekly_keep="${ASH_ATLAS_DATABASE_BACKUP_RETENTION_WEEKLY:-8}"
monthly_keep="${ASH_ATLAS_DATABASE_BACKUP_RETENTION_MONTHLY:-6}"
pre_migration_keep="${ASH_ATLAS_DATABASE_BACKUP_RETENTION_PRE_MIGRATION:-3}"
seagate_uuid="${ASH_ATLAS_SEAGATE_PROOF_UUID:?Seagate proof UUID is required}"
lock="${ASH_ATLAS_DATABASE_BACKUP_LOCK:-/run/lock/ash-atlas-database-backup.lock}"

[[ "$backup_mount" =~ ^/[A-Za-z0-9._/-]+$ && "$backup_mount" != / ]] ||
  fail 'backup mount is unsafe'
[[ "$backup_root" == "$backup_mount"/* && "$backup_root" != *'//'*
   && "$backup_root" != *'/../'* && "$backup_root" != *'/./'* ]] ||
  fail 'database backup root is outside the backup mount'
[[ "$backup_uuid" =~ ^[A-Za-z0-9._-]+$ && "$backup_serial" =~ ^[A-Za-z0-9._-]+$
   && "$seagate_uuid" =~ ^[A-Za-z0-9._-]+$ ]] || fail 'storage identity is invalid'
for value in "$minimum_free_bytes" "$hourly_keep" "$daily_keep" "$weekly_keep" \
  "$monthly_keep" "$pre_migration_keep"; do
  [[ "$value" =~ ^[0-9]+$ ]] || fail 'retention settings must be non-negative integers'
done
(( hourly_keep > 0 && daily_keep > 0 && weekly_keep > 0 && monthly_keep > 0 &&
   pre_migration_keep > 0 )) ||
  fail 'every bounded backup class must retain at least one recovery point'

if [[ "$test_mode" == true ]]; then
  [[ "$backup_mount" == /tmp/ash-atlas-database-backup-test.*/*
     && "$lock" == /tmp/ash-atlas-database-backup-test.*/* ]] ||
    fail 'test retention paths are outside the disposable namespace'
else
  [[ "$backup_mount" == /mnt/ash-atlas-backups
     && "$backup_root" == /mnt/ash-atlas-backups/postgresql
     && "$lock" == /run/lock/ash-atlas-database-backup.lock ]] ||
    fail 'production retention paths are not canonical'
fi

for command in awk basename chmod date df find findmnt flock jq mktemp mountpoint \
  mv readlink realpath sha256sum sort stat sync udevadm wc; do
  command -v "$command" >/dev/null || fail "required command is missing: $command"
done

exec 9>"$lock"
flock -n 9 || exit 0
mountpoint -q -- "$backup_mount" || fail 'backup filesystem is not mounted'
mounted_target="$(findmnt -n -T "$backup_mount" -o TARGET)"
mounted_source="$(findmnt -n -T "$backup_mount" -o SOURCE)"
mounted_uuid="$(findmnt -n -T "$backup_mount" -o UUID)"
mounted_options="$(findmnt -n -T "$backup_mount" -o OPTIONS)"
[[ "$mounted_target" == "$backup_mount" && "$mounted_uuid" == "$backup_uuid"
   && ",$mounted_options," == *,rw,* ]] || fail 'backup mount identity is invalid'
if [[ "$test_mode" == true ]]; then
  mounted_serial="${ASH_ATLAS_DATABASE_BACKUP_TEST_DEVICE_SERIAL:-TEST-SERIAL}"
else
  [[ "$mounted_source" == /dev/* ]] || fail 'backup mount source is not a block device'
  mounted_serial="$(udevadm info --query=property --name="$(readlink -f -- "$mounted_source")" |
    awk -F= '$1 == "ID_SERIAL_SHORT" {print substr($0,index($0,"=")+1); exit}')"
fi
[[ "$mounted_serial" == "$backup_serial" ]] || fail 'backup device serial does not match'

ready_root="$backup_root/ready"
ack_root="$backup_root/acknowledgments"
seagate_ack_root="$backup_root/seagate-acknowledgments"
receipt_root="$backup_root/retention-receipts"
for directory in "$backup_root" "$ready_root" "$ack_root" "$seagate_ack_root" "$receipt_root"; do
  [[ -d "$directory" && ! -L "$directory" && "$(realpath -e -- "$directory")" == "$directory" ]] ||
    fail "retention directory is absent or unsafe: $directory"
done

work="$(mktemp -d /tmp/ash-atlas-database-retention.XXXXXXXX)"
trap 'rm -rf -- "$work"' EXIT
inventory="$work/inventory.tsv"
sorted="$work/sorted.tsv"
candidates="$work/candidates.ndjson"
candidate_paths="$work/candidate-paths.tsv"
: >"$inventory"
: >"$candidates"
: >"$candidate_paths"

while IFS= read -r -d '' directory; do
  [[ -d "$directory" && ! -L "$directory" ]] || fail "ready entry is not a directory: $directory"
  directory_name="$(basename "$directory")"
  [[ "$directory_name" =~ ^backup-([a-f0-9-]{36})$ ]] ||
    fail "ready directory name is invalid: $directory_name"
  directory_id="${BASH_REMATCH[1]}"
  [[ "$(realpath -e -- "$directory")" == "$ready_root/$directory_name" ]] ||
    fail "ready directory escapes its root: $directory"
  unsafe="$(find "$directory" -mindepth 1 -maxdepth 1 ! -type f -print -quit)"
  [[ -z "$unsafe" ]] || fail "ready directory contains an unsafe entry: $unsafe"
  mapfile -d '' -t manifests < <(find "$directory" -mindepth 1 -maxdepth 1 \
    -type f -name '*.dump.ready.json' -print0)
  mapfile -d '' -t dumps < <(find "$directory" -mindepth 1 -maxdepth 1 \
    -type f -name '*.dump' -print0)
  [[ ${#manifests[@]} -eq 1 && ${#dumps[@]} -eq 1 ]] ||
    fail "ready directory does not contain exactly one manifest and dump: $directory_name"
  [[ "$(find "$directory" -mindepth 1 -maxdepth 1 -type f | wc -l)" == 2 ]] ||
    fail "ready directory contains unexpected files: $directory_name"
  manifest="${manifests[0]}"
  dump="${dumps[0]}"
  jq -e --arg id "$directory_id" --arg file "$(basename "$dump")" '
    .manifestVersion == 1
    and .kind == "ash_atlas_postgresql_backup"
    and .backupId == $id
    and (.backupClass | IN("hourly","daily","weekly","monthly","pre-migration","milestone"))
    and (.createdAtUtc | fromdateiso8601)
    and .artifact.fileName == $file
    and (.artifact.bytes | type == "number" and . > 0)
    and (.artifact.sha256 | test("^[a-f0-9]{64}$"))
  ' "$manifest" >/dev/null || fail "ready manifest is invalid: $(basename "$manifest")"
  bytes="$(jq -r '.artifact.bytes' "$manifest")"
  [[ "$(stat -c '%s' "$dump")" == "$bytes" ]] ||
    fail "ready dump size differs from its manifest: $(basename "$dump")"
  backup_class="$(jq -r '.backupClass' "$manifest")"
  created_at="$(jq -r '.createdAtUtc' "$manifest")"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$backup_class" "$created_at" "$directory_id" "$directory" "$manifest" "$bytes" \
    "$(jq -r '.artifact.sha256' "$manifest")" >>"$inventory"
done < <(find "$ready_root" -mindepth 1 -maxdepth 1 -print0)

LC_ALL=C sort -t $'\t' -k1,1 -k2,2r "$inventory" >"$sorted"
declare -A seen=( [hourly]=0 [daily]=0 [weekly]=0 [monthly]=0 [pre-migration]=0 )
retained_count=0
retained_bytes=0
candidate_count=0
candidate_bytes=0
beyond_limit_count=0
beyond_limit_bytes=0

while IFS=$'\t' read -r backup_class created_at backup_id directory manifest bytes sha; do
  [[ -n "$backup_class" ]] || continue
  case "$backup_class" in
    hourly) limit="$hourly_keep" ;;
    daily) limit="$daily_keep" ;;
    weekly) limit="$weekly_keep" ;;
    monthly) limit="$monthly_keep" ;;
    pre-migration) limit="$pre_migration_keep" ;;
    milestone)
      ((retained_count += 1)); ((retained_bytes += bytes)); continue ;;
    *) fail "unsupported backup class in inventory: $backup_class" ;;
  esac
  seen[$backup_class]=$(( seen[$backup_class] + 1 ))
  if (( seen[$backup_class] <= limit )); then
    ((retained_count += 1)); ((retained_bytes += bytes)); continue
  fi
  ((beyond_limit_count += 1))
  ((beyond_limit_bytes += bytes))

  source_ack="$ack_root/$backup_id.ack.json"
  seagate_ack="$seagate_ack_root/$backup_id.seagate.ack.json"
  if [[ ! -e "$source_ack" || ! -e "$seagate_ack" ]]; then
    # Hourly recovery points are short-lived full dumps. If the home copy stops
    # acknowledging, waiting for its proof fills the backup disk and stops every
    # later backup, so hourlies beyond their tier limit retire without home
    # proof. Every other class still requires both acknowledgments.
    if [[ "$backup_class" != hourly ]]; then
      ((retained_count += 1)); ((retained_bytes += bytes)); continue
    fi
    jq -cn --arg backupId "$backup_id" --arg backupClass "$backup_class" \
      --arg createdAtUtc "$created_at" --arg directory "$directory" \
      --arg manifestFileName "$(basename "$manifest")" --arg sha256 "$sha" \
      --argjson bytes "$bytes" '
        {backupId:$backupId,backupClass:$backupClass,createdAtUtc:$createdAtUtc,
         directory:$directory,manifestFileName:$manifestFileName,bytes:$bytes,
         sha256:$sha256,sourceAcknowledgmentId:null,
         seagateAcknowledgmentSha256:null,homeAcknowledged:false,
         reason:"beyond_hourly_limit_without_home_ack"}' >>"$candidates"
    printf '%s\t%s\t%s\n' "$backup_id" "$directory" unacknowledged-hourly >>"$candidate_paths"
    ((candidate_count += 1))
    ((candidate_bytes += bytes))
    continue
  fi
  [[ -f "$source_ack" && ! -L "$source_ack" && -f "$seagate_ack" && ! -L "$seagate_ack" ]] ||
    fail "backup acknowledgment path is unsafe: $backup_id"
  manifest_name="$(basename "$manifest")"
  jq -e --arg id "$backup_id" --arg file "$(jq -r '.artifact.fileName' "$manifest")" \
    --arg manifest "$manifest_name" --arg sha "$sha" --argjson bytes "$bytes" '
      .acknowledgmentVersion == 1
      and .event == "ash_atlas_postgresql_backup_verified"
      and .backupId == $id
      and .manifestFileName == $manifest
      and .backupFileName == $file
      and .sha256 == $sha
      and .bytes == $bytes
      and .restoreCatalogVerified == true
    ' "$source_ack" >/dev/null || fail "source acknowledgment is invalid: $backup_id"
  source_ack_id="$(jq -r '.acknowledgmentId' "$source_ack")"
  jq -e --arg id "$backup_id" --arg file "$(jq -r '.artifact.fileName' "$manifest")" \
    --arg manifest "$manifest_name" --arg sha "$sha" --arg source "$source_ack_id" \
    --arg seagate "$seagate_uuid" --argjson bytes "$bytes" '
      .seagateAcknowledgmentVersion == 1
      and .event == "ash_atlas_postgresql_backup_seagate_verified"
      and .backupId == $id
      and .manifestFileName == $manifest
      and .backupFileName == $file
      and .sha256 == $sha
      and .bytes == $bytes
      and .sourceAcknowledgmentId == $source
      and .seagateUuid == $seagate
      and .verification == "sha256-deep"
      and .restoreCatalogVerified == true
      and (.seagateVerifiedAtUtc | fromdateiso8601)
    ' "$seagate_ack" >/dev/null || fail "Seagate acknowledgment is invalid: $backup_id"

  jq -cn --arg backupId "$backup_id" --arg backupClass "$backup_class" \
    --arg createdAtUtc "$created_at" --arg directory "$directory" \
    --arg manifestFileName "$manifest_name" --arg sha256 "$sha" \
    --arg sourceAcknowledgmentId "$source_ack_id" \
    --arg seagateAcknowledgmentId "$(sha256sum "$seagate_ack" | awk '{print $1}')" \
    --argjson bytes "$bytes" '
      {backupId:$backupId,backupClass:$backupClass,createdAtUtc:$createdAtUtc,
       directory:$directory,manifestFileName:$manifestFileName,bytes:$bytes,
       sha256:$sha256,sourceAcknowledgmentId:$sourceAcknowledgmentId,
       seagateAcknowledgmentSha256:$seagateAcknowledgmentId,homeAcknowledged:true,
       reason:"beyond_tier_limit"}' >>"$candidates"
  printf '%s\t%s\t%s\n' "$backup_id" "$directory" acknowledged >>"$candidate_paths"
  ((candidate_count += 1))
  ((candidate_bytes += bytes))
done <"$sorted"

available_before="$(df -PB1 "$backup_mount" | awk 'NR==2 {print $4}')"
[[ "$available_before" =~ ^[0-9]+$ ]] || fail 'backup free space is unreadable'
projected_available=$(( available_before + candidate_bytes ))
generated_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
applied_count=0

if [[ "$mode" == --apply ]]; then
  while IFS=$'\t' read -r backup_id directory proof_mode; do
    [[ "$backup_id" =~ ^[a-f0-9-]{36}$ && "$directory" == "$ready_root/backup-$backup_id" ]] ||
      fail 'retention candidate changed before apply'
    [[ -d "$directory" && ! -L "$directory" && "$(realpath -e -- "$directory")" == "$directory" ]] ||
      fail "retention candidate disappeared or became unsafe: $backup_id"
    entry="$(jq -c --arg id "$backup_id" 'select(.backupId==$id)' "$candidates")"
    [[ -n "$entry" ]] || fail "retention plan entry disappeared: $backup_id"
    case "$proof_mode" in
      acknowledged)
        [[ -f "$ack_root/$backup_id.ack.json" &&
           -f "$seagate_ack_root/$backup_id.seagate.ack.json" ]] ||
          fail "retention proof disappeared before apply: $backup_id" ;;
      unacknowledged-hourly)
        unacked_manifest="$directory/$(jq -r '.manifestFileName' <<<"$entry")"
        [[ -f "$unacked_manifest" && ! -L "$unacked_manifest" ]] &&
          jq -e '.backupClass == "hourly" and .homeAcknowledged == false' \
            <<<"$entry" >/dev/null &&
          jq -e '.backupClass == "hourly"' "$unacked_manifest" >/dev/null ||
          fail "unacknowledged retention candidate is not hourly: $backup_id" ;;
      *) fail "retention candidate proof mode is invalid: $backup_id" ;;
    esac
    find "$directory" -xdev -depth -delete
    [[ ! -e "$directory" ]] || fail "retention candidate could not be deleted: $backup_id"
    deleted_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    temporary="$(mktemp "$receipt_root/.${backup_id}.retention.XXXXXXXX")"
    jq -c --arg deletedAtUtc "$deleted_at" --arg planGeneratedAtUtc "$generated_at" '
      . + {retentionReceiptVersion:1,deletedAtUtc:$deletedAtUtc,
           planGeneratedAtUtc:$planGeneratedAtUtc}' <<<"$entry" >"$temporary"
    chmod 0600 "$temporary"
    sync -f "$temporary"
    mv -f -- "$temporary" "$receipt_root/$backup_id.retention.json"
    sync -f "$receipt_root"
    ((applied_count += 1))
  done <"$candidate_paths"
  sync -f "$ready_root"
fi

jq -s \
  --arg mode "${mode#--}" \
  --arg generatedAtUtc "$generated_at" \
  --argjson retainedCount "$retained_count" \
  --argjson retainedBytes "$retained_bytes" \
  --argjson candidateCount "$candidate_count" \
  --argjson candidateBytes "$candidate_bytes" \
  --argjson beyondLimitCount "$beyond_limit_count" \
  --argjson beyondLimitBytes "$beyond_limit_bytes" \
  --argjson currentlyEligibleCount "$candidate_count" \
  --argjson appliedCount "$applied_count" \
  --argjson availableBeforeBytes "$available_before" \
  --argjson freeBytes "$available_before" \
  --argjson requiredHeadroomBytes "$minimum_free_bytes" \
  --argjson headroomMarginBytes "$((available_before - minimum_free_bytes))" \
  --argjson projectedAvailableBytes "$projected_available" '
    {retentionPlanVersion:1,mode:$mode,generatedAtUtc:$generatedAtUtc,
     retainedCount:$retainedCount,retainedBytes:$retainedBytes,
     candidateCount:$candidateCount,candidateBytes:$candidateBytes,
     beyondLimitCount:$beyondLimitCount,beyondLimitBytes:$beyondLimitBytes,
     currentlyEligibleCount:$currentlyEligibleCount,
     appliedCount:$appliedCount,availableBeforeBytes:$availableBeforeBytes,
     freeBytes:$freeBytes,
     requiredHeadroomBytes:$requiredHeadroomBytes,
     headroomMarginBytes:$headroomMarginBytes,
     projectedAvailableBytes:$projectedAvailableBytes,candidates:.}
  ' "$candidates"
