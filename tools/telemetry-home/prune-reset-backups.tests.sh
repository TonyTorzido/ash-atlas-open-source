#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
root="$(mktemp -d /tmp/ash-atlas-reset-backup-test.XXXXXXXX)"
trap 'rm -rf -- "$root"' EXIT
backup_root="${root}/external/database-resets"
receipt_root="${backup_root}/receipts"
mkdir -p "$receipt_root"
release_sha="$(printf 'a%.0s' {1..40})"

create_backup() {
  local sequence="$1"
  local valid="${2:-true}"
  local operation file path sha bytes receipt
  operation="$(printf '00000000-0000-4000-8000-%012d' "$sequence")"
  file="ash_atlas_game-gameplay-reset-20260726T$(printf '%06d' "$sequence")Z-${release_sha}-${operation}.dump"
  path="${backup_root}/${file}"
  printf 'backup %s\n' "$sequence" >"$path"
  touch -d "2026-07-26 02:$(printf '%02d' "$sequence"):00Z" "$path"
  sha="$(sha256sum "$path" | awk '{print $1}')"
  bytes="$(stat -c '%s' "$path")"
  [[ "$valid" == "true" ]] || sha="$(printf '0%.0s' {1..64})"
  receipt="${receipt_root}/${file}.receipt.json"
  jq -cn --arg path "$path" --arg file "$file" --arg sha "$sha" \
    --argjson bytes "$bytes" '{
      acknowledgmentVersion:1,
      event:"ash_atlas_gameplay_reset_backup_verified",
      remotePath:$path,
      backupFileName:$file,
      sha256:$sha,
      bytes:$bytes,
      restoreCatalogVerified:true
    }' >"$receipt"
}

create_backup 1
create_backup 2
create_backup 3
create_backup 4 false
export ASH_ATLAS_RESET_BACKUP_REMOTE_DIRECTORY="$backup_root"
export ASH_ATLAS_RESET_BACKUP_RETENTION_COUNT=2

dry_run="$(bash "${script_dir}/prune-reset-backups.sh" --dry-run)"
[[ "$dry_run" == *"000000000001.dump"* ]]
[[ -n "$(find "$backup_root" -maxdepth 1 -type f -name '*T000001Z*.dump' -print -quit)" ]]

bash "${script_dir}/prune-reset-backups.sh" --apply >/dev/null
[[ -z "$(find "$backup_root" -maxdepth 1 -type f -name '*T000001Z*.dump' -print -quit)" ]]
[[ -n "$(find "$backup_root" -maxdepth 1 -type f -name '*T000002Z*.dump' -print -quit)" ]]
[[ -n "$(find "$backup_root" -maxdepth 1 -type f -name '*T000003Z*.dump' -print -quit)" ]]
[[ -n "$(find "$backup_root" -maxdepth 1 -type f -name '*T000004Z*.dump' -print -quit)" ]]
old_receipt="$(find "$receipt_root" -name '*T000001Z*.receipt.json' -print -quit)"
jq -e '.retentionPrunedAtUtc | fromdateiso8601' "$old_receipt" >/dev/null

export ASH_ATLAS_RESET_BACKUP_RETENTION_COUNT=0
bash "${script_dir}/prune-reset-backups.sh" --apply
[[ "$(find "$backup_root" -maxdepth 1 -type f -name '*.dump' | wc -l)" == "3" ]]
echo "reset backup retention tests passed"
