#!/usr/bin/env bash
set -euo pipefail
umask 077

mode="${1:---dry-run}"
[[ "$mode" == "--dry-run" || "$mode" == "--apply" ]] || {
  echo "usage: $0 [--dry-run|--apply]" >&2
  exit 2
}
root="${ASH_ATLAS_RESET_BACKUP_REMOTE_DIRECTORY:?reset backup directory is required}"
retention="${ASH_ATLAS_RESET_BACKUP_RETENTION_COUNT:-0}"
[[ "$retention" =~ ^[0-9]+$ ]] || {
  echo "reset backup retention count is invalid" >&2
  exit 2
}
(( retention > 0 )) || exit 0
[[ "$root" =~ ^/[A-Za-z0-9._/-]+$ && "$root" != "/" &&
   "$root" != *"//"* && "$root" != *"/../"* && "$root" != *"/./"* ]] || {
  echo "reset backup directory is unsafe" >&2
  exit 1
}
[[ -d "$root" && ! -L "$root" && "$(realpath -e -- "$root")" == "$root" ]] || {
  echo "reset backup directory is absent or unsafe" >&2
  exit 1
}
receipt_root="${root}/receipts"
[[ -d "$receipt_root" && ! -L "$receipt_root" ]] || {
  echo "reset backup receipt directory is absent or unsafe" >&2
  exit 1
}

valid=()
while IFS= read -r entry; do
  file="${entry#* }"
  name="$(basename "$file")"
  [[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,239}$ &&
     "$name" == *-gameplay-reset-*.dump ]] || continue
  [[ -f "$file" && ! -L "$file" ]] || continue
  receipt="${receipt_root}/${name}.receipt.json"
  [[ -f "$receipt" && ! -L "$receipt" ]] || continue
  sha="$(sha256sum "$file" | awk '{print $1}')"
  bytes="$(stat -c '%s' "$file")"
  jq -e --arg path "$file" --arg file "$name" --arg sha "$sha" \
    --argjson bytes "$bytes" '
      .acknowledgmentVersion == 1
      and .event == "ash_atlas_gameplay_reset_backup_verified"
      and .remotePath == $path
      and .backupFileName == $file
      and .sha256 == $sha
      and .bytes == $bytes
      and .restoreCatalogVerified == true
    ' "$receipt" >/dev/null || continue
  valid+=("$file")
done < <(find "$root" -mindepth 1 -maxdepth 1 -type f \
  -name '*-gameplay-reset-*.dump' -printf '%T@ %p\n' | LC_ALL=C sort -n)

prune_count=$((${#valid[@]} - retention))
(( prune_count > 0 )) || exit 0
for ((index = 0; index < prune_count; index += 1)); do
  file="${valid[$index]}"
  name="$(basename "$file")"
  receipt="${receipt_root}/${name}.receipt.json"
  if [[ "$mode" == "--dry-run" ]]; then
    printf 'Would prune %s\n' "$file"
    continue
  fi
  temporary="${receipt}.$$"
  jq --arg prunedAtUtc "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '.retentionPrunedAtUtc = $prunedAtUtc' "$receipt" >"$temporary"
  chmod --reference="$receipt" "$temporary"
  chown --reference="$receipt" "$temporary"
  mv -- "$temporary" "$receipt"
  rm -f -- "$file"
  printf 'Pruned %s\n' "$file"
done
