#!/usr/bin/env bash
set -euo pipefail
umask 077
if [[ "${TELEMETRY_TEST_MODE:-false}" != true && -z "${ASH_ATLAS_BACKUP_DEADLINE:-}" ]]; then
  export ASH_ATLAS_BACKUP_DEADLINE=$(( $(date +%s) + 600 ))
  exec timeout --kill-after=5 600 bash "$0" "$@"
fi
: "${TELEMETRY_HOME_STORAGE_ROOT:?}"
: "${TELEMETRY_SEAGATE_MOUNT:?}"
: "${TELEMETRY_PORTABLE_BACKUP_ROOT:=$TELEMETRY_SEAGATE_MOUNT/ash-atlas-backup-archive}"
source "${ASH_ATLAS_BACKUP_COMMON:-/usr/local/lib/ash-atlas/backup-common.sh}"
portable_hourly_keep="${TELEMETRY_PORTABLE_BACKUP_RETENTION_HOURLY:-24}"
portable_daily_keep="${TELEMETRY_PORTABLE_BACKUP_RETENTION_DAILY:-14}"
portable_weekly_keep="${TELEMETRY_PORTABLE_BACKUP_RETENTION_WEEKLY:-8}"
portable_monthly_keep="${TELEMETRY_PORTABLE_BACKUP_RETENTION_MONTHLY:-12}"
pull_lock="${TELEMETRY_HOME_PULL_LOCK:-/run/lock/ash-atlas-telemetry-home-pull.lock}"
mirror_lock="${ASH_ATLAS_BACKUP_MIRROR_LOCK:-/run/lock/ash-atlas-backup-mirror.lock}"
scrub_lock="${ASH_ATLAS_BACKUP_SCRUB_LOCK:-/run/lock/ash-atlas-backup-scrub.lock}"
migration_lock="${TELEMETRY_BACKUP_MIGRATION_LOCK:-/run/lock/ash-atlas-backup-migration.lock}"
[[ "${TELEMETRY_TEST_MODE:-false}" != true || -v TELEMETRY_BACKUP_MIGRATION_LOCK ]] || migration_lock="${pull_lock}.migration"
for lock in "$pull_lock" "$mirror_lock" "$scrub_lock" "$migration_lock"; do
  if [[ "${TELEMETRY_TEST_MODE:-false}" == true ]]; then
    [[ "$lock" == /tmp/ash-atlas-database-backup-test.*/* ]] || exit 2
  else [[ "$lock" == /run/lock/* ]] || exit 2; fi
done
exec 9>"$pull_lock"; exec 8>"$mirror_lock"; exec 7>"$scrub_lock"; exec 6>"$migration_lock"
flock -n 7 || exit 0
lock_lifecycle() {
  flock -n 9 || return 1
  flock -n 8 || { flock -u 9; return 1; }
  flock -n 6 || { flock -u 8; flock -u 9; return 1; }
}
unlock_lifecycle() { flock -u 6; flock -u 8; flock -u 9; }
lock_lifecycle || exit 0
ash_backup_validate_storage "$TELEMETRY_HOME_STORAGE_ROOT" "$TELEMETRY_HOME_STORAGE_MOUNT" \
  "$TELEMETRY_HOME_STORAGE_UUID" "$TELEMETRY_HOME_STORAGE_SERIAL" "$TELEMETRY_HOME_STORAGE_FSTYPE" 'home intake'
ash_backup_require_portable_root "$TELEMETRY_PORTABLE_BACKUP_ROOT" "$TELEMETRY_SEAGATE_MOUNT"
catalog="$TELEMETRY_HOME_STORAGE_ROOT/.copy-verifications"
[[ -d "$catalog" && ! -L "$catalog" && "$(stat -c '%u:%a' "$catalog")" == 0:700 ]] || exit 1
state="$TELEMETRY_HOME_STORAGE_ROOT/.ash-atlas-seagate-scrub-state.json"
ssh_control_dir="$(mktemp -d "$(dirname "$scrub_lock")/ash-atlas-scrub.XXXXXXXX")"
trap 'rm -rf -- "$ssh_control_dir"' EXIT
remote() {
  ssh -T -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes \
    -o "UserKnownHostsFile=$TELEMETRY_KNOWN_HOSTS" -o "IdentityFile=$TELEMETRY_SSH_KEY" \
    -o ClearAllForwardings=yes -o ConnectTimeout=15 \
    "$TELEMETRY_VPS_USER@$TELEMETRY_VPS_HOST" "$1"
}
retained_inventory="$ssh_control_dir/retained"
remote database-retained-list >"$retained_inventory"
declare -A retained_manifests=() current_retained_ids=() previous_retained_ids=()
retained_inventory_complete=true
while IFS= read -r name; do
  [[ -n "$name" ]] || continue
  [[ "$name" =~ -([a-f0-9-]{36})\.dump\.ready\.json$ ]] || exit 1
  retained_manifests[$name]=1; current_retained_ids[${BASH_REMATCH[1]}]=1
done <"$retained_inventory"
(( ${#current_retained_ids[@]} > 0 )) || retained_inventory_complete=false
if [[ -f "$state" && ! -L "$state" ]]; then
  while IFS= read -r id; do [[ -z "$id" ]] || previous_retained_ids[$id]=1; done \
    < <(jq -r '.retainedCohortIds[]? // empty' "$state")
fi
portable_database_root="$TELEMETRY_PORTABLE_BACKUP_ROOT/postgresql"
database_receipt_root="$ASH_ATLAS_DATABASE_BACKUP_REMOTE_DIRECTORY/receipts"
proof_evidence_root="$TELEMETRY_HOME_STORAGE_ROOT/.ash-atlas-seagate-proof-evidence"
retirement_root="$TELEMETRY_PORTABLE_BACKUP_ROOT/.retirement"
retired_root="$TELEMETRY_PORTABLE_BACKUP_ROOT/.retired"
# Existing retention/pins run under lifecycle locks using trusted metadata.
retire_portable_database_directory() {
  local backup_id="$1" backup_class="$2" directory="$3" manifest="$4" dump="$5"
  local manifest_name file_name portable_receipt source_receipt expected_sha expected_bytes
  local intent_path tombstone_path intent_tmp tombstone_tmp manifest_sha source_receipt_sha portable_receipt_sha
  local entry target entries entry_name
  [[ "$backup_id" =~ ^[a-f0-9-]{36}$ ]] || return 1
  [[ "$directory" == "$portable_database_root/backup-$backup_id" ]] || return 1
  [[ "$manifest" == "$directory/"* && "$dump" == "$directory/"* ]] || return 1
  manifest_name="$(basename -- "$manifest")"
  intent_path="$retirement_root/backup-$backup_id.intent.json"
  tombstone_path="$retired_root/backup-$backup_id.json"
  if [[ -f "$intent_path" && ! -L "$intent_path" ]]; then
    file_name="$(jq -er '.backupFileName' "$intent_path")" || return 1
    expected_bytes="$(jq -er '.bytes' "$intent_path")" || return 1
    expected_sha="$(jq -er '.sha256' "$intent_path")" || return 1
  else
    file_name="$(jq -er '.artifact.fileName' "$manifest")" || return 1
    expected_bytes="$(jq -er '.artifact.bytes' "$manifest")" || return 1
    expected_sha="$(jq -er '.artifact.sha256' "$manifest")" || return 1
  fi
  [[ "$file_name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,239}$ &&
     "$file_name" != source-receipt.json && "$file_name" != portable-receipt.json ]] || return 1
  [[ "$dump" == "$directory/$file_name" ]] || return 1
  portable_receipt="$directory/portable-receipt.json"
  source_receipt="$directory/source-receipt.json"
  [[ "$expected_bytes" =~ ^[1-9][0-9]*$ && "$expected_sha" =~ ^[a-f0-9]{64}$ ]] || return 1

  if [[ -f "$tombstone_path" && ! -L "$tombstone_path" ]]; then
    [[ ! -e "$directory" && ! -L "$directory" ]] || return 1
    if [[ -e "$intent_path" || -L "$intent_path" ]]; then
      ( cd -- "$TELEMETRY_PORTABLE_BACKUP_ROOT" &&
        ash_backup_require_portable_root "$TELEMETRY_PORTABLE_BACKUP_ROOT" \
          "$TELEMETRY_SEAGATE_MOUNT" &&
        rm -f -- "./.retirement/backup-$backup_id.intent.json" &&
        sync -f .retirement ) || return 1
    fi
    return 0
  fi

  if [[ -f "$intent_path" && ! -L "$intent_path" ]]; then
    jq -e --arg id "$backup_id" --arg class "$backup_class" \
      --arg directory "$directory" --arg manifest "$manifest" --arg dump "$dump" \
      --arg file "$file_name" --arg sha "$expected_sha" --argjson bytes "$expected_bytes" '
        .retirementIntentVersion == 1 and .backupId == $id and .backupClass == $class
        and .directory == $directory and .manifestPath == $manifest and .dumpPath == $dump
        and .backupFileName == $file and .sha256 == $sha and .bytes == $bytes
      ' "$intent_path" >/dev/null || return 1
    manifest_sha="$(jq -er '.manifestSha256' "$intent_path")" || return 1
    source_receipt_sha="$(jq -er '.sourceReceiptSha256' "$intent_path")" || return 1
    portable_receipt_sha="$(jq -er '.portableReceiptSha256' "$intent_path")" || return 1
  else
    [[ -d "$directory" && ! -L "$directory" &&
       "$(realpath -e -- "$directory")" == "$directory" ]] || return 1
    [[ -f "$manifest" && ! -L "$manifest" && -f "$dump" && ! -L "$dump" &&
       -f "$source_receipt" && ! -L "$source_receipt" &&
       -f "$portable_receipt" && ! -L "$portable_receipt" ]] || return 1
    ash_backup_verify_copy fast postgresql "$backup_id" "$dump" "$expected_bytes" "$expected_sha" \
      "$manifest" "$source_receipt" "$portable_receipt" >/dev/null || return 1
    manifest_sha="$(sha256sum "$manifest" | awk '{print $1}')" || return 1
    source_receipt_sha="$(sha256sum "$source_receipt" | awk '{print $1}')" || return 1
    portable_receipt_sha="$(sha256sum "$portable_receipt" | awk '{print $1}')" || return 1
    jq -e --arg id "$backup_id" --arg file "$file_name" --arg sha "$expected_sha" \
      --argjson bytes "$expected_bytes" \
      '.backupId == $id and .backupFileName == $file and .sha256 == $sha and .bytes == $bytes' \
      "$portable_receipt" >/dev/null || return 1
  fi

  if [[ -e "$directory" || -L "$directory" ]]; then
    [[ -d "$directory" && ! -L "$directory" &&
       "$(realpath -e -- "$directory")" == "$directory" ]] || return 1
    mapfile -t entries < <(find "$directory" -mindepth 1 -maxdepth 1 -printf '%f\n' | LC_ALL=C sort)
    for entry_name in "${entries[@]}"; do
      case "$entry_name" in
        "$file_name"|"$manifest_name"|source-receipt.json|portable-receipt.json) ;;
        *) return 1 ;;
      esac
    done
    for target in "$dump" "$manifest" "$source_receipt" "$portable_receipt"; do
      if [[ -e "$target" || -L "$target" ]]; then
        [[ -f "$target" && ! -L "$target" &&
           "$(realpath -e -- "$target")" == "$target" ]] || return 1
        case "$target" in
          "$dump")
            ash_backup_verify_copy fast postgresql "$backup_id" "$target" "$expected_bytes" "$expected_sha" \
              "$manifest" "$source_receipt" "$portable_receipt" >/dev/null || return 1
            ;;
          "$manifest")
            [[ "$(sha256sum "$target" | awk '{print $1}')" == "$manifest_sha" ]] || return 1
            ;;
          "$source_receipt")
            [[ "$(sha256sum "$target" | awk '{print $1}')" == "$source_receipt_sha" ]] || return 1
            ;;
          "$portable_receipt")
            [[ "$(sha256sum "$target" | awk '{print $1}')" == "$portable_receipt_sha" ]] || return 1
            ;;
        esac
      fi
    done
  fi

  ash_backup_require_portable_root "$TELEMETRY_PORTABLE_BACKUP_ROOT" \
    "$TELEMETRY_SEAGATE_MOUNT" || return 1
  cd -- "$TELEMETRY_PORTABLE_BACKUP_ROOT" || return 1
  ash_backup_require_portable_root "$TELEMETRY_PORTABLE_BACKUP_ROOT" \
    "$TELEMETRY_SEAGATE_MOUNT" || return 1
  if [[ ! -f "$intent_path" ]]; then
    intent_tmp="$(mktemp "./.retirement/.backup-$backup_id.intent.XXXXXXXX")" || return 1
    jq -cn --arg id "$backup_id" --arg class "$backup_class" \
      --arg directory "$directory" --arg manifest "$manifest" --arg dump "$dump" \
      --arg file "$file_name" --arg sha "$expected_sha" --argjson bytes "$expected_bytes" \
      --arg manifestSha "$manifest_sha" --arg sourceReceiptSha "$source_receipt_sha" \
      --arg portableReceiptSha "$portable_receipt_sha" \
      --arg startedAtUtc "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '
        {retirementIntentVersion:1,backupId:$id,backupClass:$class,
         directory:$directory,manifestPath:$manifest,dumpPath:$dump,
         backupFileName:$file,sha256:$sha,bytes:$bytes,
         manifestSha256:$manifestSha,sourceReceiptSha256:$sourceReceiptSha,
         portableReceiptSha256:$portableReceiptSha,startedAtUtc:$startedAtUtc}
      ' >"$intent_tmp" || return 1
    chmod 0600 "$intent_tmp" || return 1
    sync -f "$intent_tmp" || return 1
    mv -f -- "$intent_tmp" "./.retirement/backup-$backup_id.intent.json" || return 1
    sync -f .retirement || return 1
  fi

  ash_backup_require_portable_root "$TELEMETRY_PORTABLE_BACKUP_ROOT" \
    "$TELEMETRY_SEAGATE_MOUNT" || return 1
  for target in "$dump" "$manifest" "$source_receipt" "$portable_receipt"; do
    if [[ -e "$target" || -L "$target" ]]; then
      [[ -f "$target" && ! -L "$target" &&
         "$(realpath -e -- "$target")" == "$target" ]] || return 1
      [[ "$target" == "$TELEMETRY_PORTABLE_BACKUP_ROOT/"* ]] || return 1
      rm -f -- ".${target#"$TELEMETRY_PORTABLE_BACKUP_ROOT"}" || return 1
    fi
  done
  if [[ -e "$directory" || -L "$directory" ]]; then
    [[ -d "$directory" && ! -L "$directory" &&
       "$(realpath -e -- "$directory")" == "$directory" ]] || return 1
    [[ "$directory" == "$TELEMETRY_PORTABLE_BACKUP_ROOT/"* ]] || return 1
    rmdir -- ".${directory#"$TELEMETRY_PORTABLE_BACKUP_ROOT"}" || return 1
  fi
  sync -f ./postgresql || return 1

  ash_backup_require_portable_root "$TELEMETRY_PORTABLE_BACKUP_ROOT" \
    "$TELEMETRY_SEAGATE_MOUNT" || return 1
  tombstone_tmp="$(mktemp "./.retired/.backup-$backup_id.XXXXXXXX")" || return 1
  jq -cn --arg id "$backup_id" --arg class "$backup_class" \
    --arg directory "$directory" --arg file "$file_name" \
    --arg sha "$expected_sha" --argjson bytes "$expected_bytes" \
    --arg retiredAtUtc "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '
      {retirementTombstoneVersion:1,status:"retired",backupId:$id,
       backupClass:$class,directory:$directory,backupFileName:$file,
       sha256:$sha,bytes:$bytes,retiredAtUtc:$retiredAtUtc}
    ' >"$tombstone_tmp" || return 1
  chmod 0600 "$tombstone_tmp" || return 1
  sync -f "$tombstone_tmp" || return 1
  mv -f -- "$tombstone_tmp" "./.retired/backup-$backup_id.json" || return 1
  sync -f .retired || return 1
  rm -f -- "./.retirement/backup-$backup_id.intent.json" || return 1
  sync -f .retirement || return 1
}

prune_portable_database_archive() {
  local rows="$ssh_control_dir/portable-retention.tsv"
  local directory manifest dump receipt file_name backup_id backup_class created_at
  local limit directory_name tombstone_path evidence_path receipt_sha source_ack_id source_path
  [[ -d "$portable_database_root" && ! -L "$portable_database_root" ]] || return 1
  if [[ "$retained_inventory_complete" != true ]]; then
    echo 'portable retention deferred because VPS inventory is empty without a complete-list marker' >&2
    return 0
  fi

  : >"$rows"
  while IFS= read -r -d '' directory; do
    directory_name="$(basename "$directory")"
    [[ "$directory_name" =~ ^backup-([a-f0-9-]{36})$ ]] || return 1
    backup_id="${BASH_REMATCH[1]}"
    manifest="$(find "$directory" -maxdepth 1 -type f -name '*.dump.ready.json' -print -quit)"
    dump="$(find "$directory" -maxdepth 1 -type f -name '*.dump' -print -quit)"
    [[ -n "$manifest" && -n "$dump" ]] || return 1
    backup_class="$(jq -er '.backupClass' "$manifest")" || return 1
    created_at="$(jq -er '.createdAtUtc' "$manifest")" || return 1
    tombstone_path="$retired_root/backup-$backup_id.json"
    if [[ -f "$tombstone_path" && ! -L "$tombstone_path" ]]; then
      echo "retired portable backup ID reappeared: $backup_id" >&2
      return 1
    fi
    printf '%s\t%s\t%s\t%s\t%s\n' "$backup_class" "$created_at" "$backup_id" \
      "$directory" "$(basename "$manifest")" >>"$rows"
  done < <(find "$portable_database_root" -mindepth 1 -maxdepth 1 \
    -type d -name 'backup-*' -print0 | LC_ALL=C sort -z)
  declare -A class_seen=( [hourly]=0 [daily]=0 [weekly]=0 [monthly]=0 )
  declare -A safety_pins=()
  while IFS=$'\t' read -r backup_class created_at backup_id directory manifest_name; do
    [[ -n "$backup_id" ]] || continue
    ((${#safety_pins[@]} < 2)) || break
    safety_pins[$backup_id]=1
  done < <(LC_ALL=C sort -t $'\t' -k2,2r "$rows")
  while IFS=$'\t' read -r backup_class created_at backup_id directory manifest_name; do
    [[ -n "$backup_id" ]] || continue
    manifest="$directory/$manifest_name"
    case "$backup_class" in
      hourly) limit="$portable_hourly_keep" ;;
      daily) limit="$portable_daily_keep" ;;
      weekly) limit="$portable_weekly_keep" ;;
      monthly) limit="$portable_monthly_keep" ;;
      milestone|pre-migration)
        continue
        ;;
      *)
        echo "portable retention preserves unknown backup class: $backup_id" >&2
        continue
        ;;
    esac
    [[ "$limit" =~ ^[1-9][0-9]*$ ]] || return 1
    if [[ -v "retained_manifests[$manifest_name]" ||
          -v "previous_retained_ids[$backup_id]" ||
          -v "safety_pins[$backup_id]" ]]; then
      continue
    fi
    class_seen[$backup_class]=$((class_seen[$backup_class] + 1))
    (( class_seen[$backup_class] <= limit )) && continue
    file_name="$(jq -er '.artifact.fileName' "$manifest")" || return 1
    receipt="$database_receipt_root/$file_name.receipt.json"
    [[ -f "$receipt" && ! -L "$receipt" ]] || continue
    jq -e --arg id "$backup_id" --arg file "$file_name" \
      --arg sha "$(jq -r '.sha256' "$receipt")" \
      --argjson bytes "$(jq -r '.bytes' "$receipt")" '
        .backupId == $id and .backupFileName == $file
        and (.sha256 | test("^[a-f0-9]{64}$")) and (.bytes | type == "number" and . > 0)
      ' "$receipt" >/dev/null || continue
    dump="$directory/$file_name"
    evidence_path="$proof_evidence_root/backup-$backup_id.accepted.json"
    receipt_sha="$(sha256sum "$receipt" | awk '{print $1}')" || return 1
    source_ack_id="$(jq -er '.acknowledgmentId' "$receipt")" || return 1
    proof_evidence_valid=false
    if [[ -f "$evidence_path" && ! -L "$evidence_path" ]] && jq -e \
      --arg id "$backup_id" --arg file "$file_name" \
      --arg manifest "$manifest_name" --arg source "$source_ack_id" \
      --arg sha "$(jq -r '.sha256' "$receipt")" \
      --arg receiptSha "$receipt_sha" --arg path "$dump" \
      --arg seagate "$TELEMETRY_SEAGATE_UUID" \
      --argjson bytes "$(jq -r '.bytes' "$receipt")" '
        .proofEvidenceVersion == 1 and .backupId == $id
        and .backupFileName == $file and .portablePath == $path
        and .sourceAcknowledgmentId == $source
        and .sourceReceiptSha256 == $receiptSha
        and .sha256 == $sha and .bytes == $bytes
        and .acceptedProof.seagateAcknowledgmentVersion == 1
        and .acceptedProof.event == "ash_atlas_postgresql_backup_seagate_verified"
        and .acceptedProof.backupId == $id
        and .acceptedProof.backupFileName == $file
        and .acceptedProof.manifestFileName == $manifest
        and .acceptedProof.sourceAcknowledgmentId == $source
        and .acceptedProof.sha256 == $sha and .acceptedProof.bytes == $bytes
        and .acceptedProof.seagateUuid == $seagate
        and .acceptedProof.verification == "sha256-deep"
        and .acceptedProof.restoreCatalogVerified == true
        and (.acceptedProof.seagateVerifiedAtUtc | fromdateiso8601)
      ' "$evidence_path" >/dev/null; then
      proof_evidence_valid=true
    fi
    if [[ "$proof_evidence_valid" != true ]]; then
      [[ -e "$evidence_path" || -L "$evidence_path" ]] && continue
      # A source receipt with a trusted locally verified portable artifact can
      # be archive-only after the VPS has forgotten it.  Do not fabricate an
      # accepted Seagate proof for that state; after current/previous VPS pins
      # and safety/tier keepers are excluded, the exact retirement journal is
      # the only authority needed to remove the local portable copy.
      source_path="$(jq -er '.remotePath // empty' "$receipt" 2>/dev/null || true)"
      [[ -n "$source_path" ]] || continue
      printf 'portable retention archive-only backupId=%s remoteAcceptance=unknown\n' \
        "$backup_id" >&2
    fi
    retire_portable_database_directory "$backup_id" "$backup_class" \
      "$directory" "$manifest" "$dump" || return 1
    printf 'portable retention removed backupId=%s class=%s createdAt=%s\n' \
      "$backup_id" "$backup_class" "$created_at"
  done < <(LC_ALL=C sort -t $'\t' -k1,1 -k2,2r "$rows")
}

if [[ "$retained_inventory_complete" == true && -d "$portable_database_root" ]]; then
  ( cd "$TELEMETRY_PORTABLE_BACKUP_ROOT"
    ash_backup_require_portable_mount "$TELEMETRY_SEAGATE_MOUNT"
    install -d -m 0750 .retirement .retired )
  while IFS= read -r -d '' intent; do
    id="$(jq -er '.backupId' "$intent")"
    [[ -z "${current_retained_ids[$id]+present}" && -z "${previous_retained_ids[$id]+present}" ]] || exit 1
    retire_portable_database_directory "$id" "$(jq -r '.backupClass' "$intent")" \
      "$portable_database_root/backup-$id" "$(jq -r '.manifestPath' "$intent")" "$(jq -r '.dumpPath' "$intent")"
  done < <(find "$retirement_root" -maxdepth 1 -type f -name 'backup-*.intent.json' -print0)
  prune_portable_database_archive
fi
cycle_start="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
last_complete=''; cursor=''; errors=0; checked=0; bytes_read=0; partial=false
if [[ -f "$state" ]]; then
  cycle_start="$(jq -r '.cycleStartedAtUtc // empty' "$state")"
  [[ -n "$cycle_start" ]] || cycle_start="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  last_complete="$(jq -r '.lastCompleteCycleAtUtc // empty' "$state")"
  [[ "$cycle_start" != "$last_complete" ]] || cycle_start="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
fi
attempts="$ssh_control_dir/attempts.json"
if [[ -f "$state" ]]; then jq '.attempts // {}' "$state" >"$attempts"; else printf '{}\n' >"$attempts"; fi
listing="$ssh_control_dir/listing.jsonl"
: >"$listing"
while IFS= read -r -d '' receipt; do
  [[ ! -L "$receipt" && "$(stat -c '%u:%a' "$receipt")" == 0:600 ]] || exit 1
  known_path="$(jq -er '.path' "$receipt")"
  if [[ ! -e "$known_path" && ! -L "$known_path" ]]; then
    known_id="$(jq -er '.id' "$receipt")"
    if [[ "$known_path" == "$TELEMETRY_HOME_STORAGE_ROOT/"* ||
          -f "$retired_root/backup-$known_id.json" ]]; then
      rm -f -- "$receipt"
      continue
    fi
  fi
  jq -c --arg record "$receipt" '. + {recordPath:$record}' "$receipt" >>"$listing"
done < <(find "$catalog" -maxdepth 1 -type f -name '*.json' -print0)
jq -sr --slurpfile attempts "$attempts" --arg cycle "$cycle_start" '
  map(select(.verifiedAtUtc < $cycle)) | sort_by($attempts[0][.path].lastAttemptAtUtc // "", .verifiedAtUtc,.path)
  | .[].recordPath' "$listing" >"$ssh_control_dir/ordered"
publish_state() {
  local now="$(date -u +%Y-%m-%dT%H:%M:%SZ)" temporary
  local cohort="$ssh_control_dir/cohort.json"
  printf '%s\n' "${!current_retained_ids[@]}" | jq -R -s 'split("\n") | map(select(length>0))' >"$cohort"
  temporary="$(mktemp "$TELEMETRY_HOME_STORAGE_ROOT/.scrub-state.XXXXXXXX")"
  jq -n --arg cycle "$cycle_start" --arg complete "$last_complete" --arg cursor "$cursor" --arg now "$now" \
    --arg sourceUuid "$TELEMETRY_HOME_STORAGE_UUID" --arg seagateUuid "$TELEMETRY_SEAGATE_UUID" \
    --argjson checked "$checked" --argjson bytes "$bytes_read" --argjson errors "$errors" --argjson partial "$partial" \
    --slurpfile attempts "$attempts" --slurpfile cohort "$cohort" --slurpfile catalog "$listing" '
    {version:1,status:(if $partial then "partial" elif $errors>0 then "error" else "ok" end),
     sourceUuid:$sourceUuid,seagateUuid:$seagateUuid,
     verification:"rotating-sha256-deep",catalogCheckedAtUtc:$now,
     cycleStartedAtUtc:$cycle,lastCompleteCycleAtUtc:$complete,cursor:$cursor,
     checkedCount:$checked,bytesRead:$bytes,errors:$errors,attempts:$attempts[0],
     retainedCohortIds:$cohort[0],
     lastDeepVerifiedAtUtc:([$catalog[].verifiedAtUtc] | max // null),
     oldestDeepVerifiedAtUtc:([$catalog[].verifiedAtUtc] | min // null),
     pendingVerificationCount:([$catalog[] | select(.verifiedAtUtc<$cycle)] | length)}' >"$temporary"
  chmod 0600 "$temporary"; sync -f "$temporary"; mv -f "$temporary" "$state"; sync -f "$TELEMETRY_HOME_STORAGE_ROOT"
}
trap 'partial=true; publish_state || true; exit 124' TERM INT
publish_state
unlock_lifecycle
while IFS= read -r record; do
  [[ -n "$record" ]] || continue
  remaining=$(( ${ASH_ATLAS_BACKUP_DEADLINE:-$(( $(date +%s)+600 ))} - $(date +%s) - 20 ))
  if (( remaining <= 0 )); then partial=true; break; fi
  if ! lock_lifecycle; then partial=true; break; fi
  candidate="$ssh_control_dir/selected.json"; cp "$record" "$candidate"
  path="$(jq -er '.path' "$candidate")"; cursor="$path"
  fingerprint="$(ash_backup_copy_fingerprint "$path" || true)"
  [[ "$fingerprint" == "$(jq -r '.fingerprint' "$candidate")" ]] || { unlock_lifecycle; ((errors+=1)); continue; }
  manifest="$(jq -r '.manifestPath' "$candidate")"
  source_receipt="$(jq -r '.sourceReceiptPath' "$candidate")"
  portable_receipt="$(jq -r '.portableReceiptPath' "$candidate")"
  kind="$(jq -r '.kind' "$candidate")"; id="$(jq -r '.id' "$candidate")"
  bytes="$(jq -r '.bytes' "$candidate")"; sha="$(jq -r '.sha256' "$candidate")"
  unlock_lifecycle
  result="$ssh_control_dir/read-result.json"; outcome=0
  export ASH_ATLAS_BACKUP_DEFER_PUBLICATION=true
  ash_backup_verify_copy deep "$kind" "$id" "$path" "$bytes" "$sha" \
    "$manifest" "$source_receipt" "$portable_receipt" >"$result" || outcome=$?
  unset ASH_ATLAS_BACKUP_DEFER_PUBLICATION
  # The helper rechecks the read; now recheck selection under lifecycle locks.
  if lock_lifecycle; then
    if (( outcome == 0 )) && [[ "$(jq -r '.fingerprint' "$result")" == "$fingerprint" ]] &&
       ash_backup_publish_copy_receipt "$result"; then
      ((checked+=1)); ((bytes_read+=bytes))
    elif (( outcome == 1 )) && [[ "$(ash_backup_copy_fingerprint "$path" || true)" == "$fingerprint" ]]; then
      rm -f -- "$record"; ((errors+=1))
    else partial=true; fi
    unlock_lifecycle
  else partial=true; fi
  jq --arg path "$path" --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --argjson outcome "$outcome" '
    .[$path] = {lastAttemptAtUtc:$now,timeoutCount:((.[$path].timeoutCount // 0) + (if $outcome==124 then 1 else 0 end))}
    ' "$attempts" >"$attempts.partial"
  mv "$attempts.partial" "$attempts"
  publish_state
  printf 'scrub copy=%s outcome=%s checked=%s bytesRead=%s\n' "$id" "$outcome" "$checked" "$bytes_read"
done <"$ssh_control_dir/ordered"
# Refresh protected small records; completion means every current catalog copy
# has an earned deep check in this cycle, never merely a successful exit.
: >"$listing"
while IFS= read -r -d '' receipt; do jq -c '.' "$receipt" >>"$listing"; done \
  < <(find "$catalog" -maxdepth 1 -type f -name '*.json' -print0)
if [[ "$partial" == false && "$errors" == 0 ]] &&
   jq -se --arg cycle "$cycle_start" 'all(.[]; .verifiedAtUtc >= $cycle)' "$listing" >/dev/null; then
  last_complete="$(date -u +%Y-%m-%dT%H:%M:%SZ)"; cycle_start="$last_complete"
fi
publish_state
jq -e 'any(.[]; .timeoutCount>=2)' "$attempts" >/dev/null && echo 'WARNING: copy timed out twice' >&2 || true
if (( $(date +%s) - $(date -d "$cycle_start" +%s) > 604800 )); then
  echo 'WARNING: deep scrub rotation exceeds seven days' >&2
fi
printf 'Rotating Seagate scrub: checked=%s bytesRead=%s partial=%s errors=%s\n' "$checked" "$bytes_read" "$partial" "$errors"
(( errors == 0 ))
