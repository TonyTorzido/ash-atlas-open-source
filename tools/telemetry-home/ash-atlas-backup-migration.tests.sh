#!/usr/bin/env bash
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo 'backup migration tests skipped: root-only audit entrypoint' >&2
  exit 0
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
namespace="$(mktemp -d /tmp/ash-atlas-backup-migration-test.XXXXXXXX)"
trap 'rm -rf -- "$namespace"' EXIT
mkdir -p "$namespace/bin" "$namespace/home/ash-atlas-database-backups" \
  "$namespace/home/ash-atlas-reset-backups" "$namespace/portable"
printf 'unclassified fixture\n' \
  >"$namespace/home/ash-atlas-database-backups/unclassified.dump"

cat >"$namespace/env" <<EOF
TELEMETRY_HOME_STORAGE_ROOT=$namespace/home
TELEMETRY_HOME_STORAGE_MOUNT=$namespace/home
TELEMETRY_HOME_STORAGE_UUID=HOME-UUID
TELEMETRY_HOME_STORAGE_SERIAL=HOME-SERIAL
TELEMETRY_HOME_STORAGE_FSTYPE=tmpfs
TELEMETRY_SEAGATE_MOUNT=$namespace/portable
TELEMETRY_SEAGATE_UUID=PORTABLE-UUID
TELEMETRY_SEAGATE_SERIAL=PORTABLE-SERIAL
TELEMETRY_SEAGATE_FSTYPE=ntfs3
ASH_ATLAS_DATABASE_BACKUP_REMOTE_DIRECTORY=$namespace/home/ash-atlas-database-backups
ASH_ATLAS_RESET_BACKUP_REMOTE_DIRECTORY=$namespace/home/ash-atlas-reset-backups
TELEMETRY_HOME_BACKUP_CAP_BYTES=50000000000
EOF
cat >"$namespace/common.sh" <<'SH'
ash_backup_validate_storage() {
  [[ "$1" == "$TEST_HOME" && "$3" == HOME-UUID && "$4" == HOME-SERIAL &&
     "$5" == tmpfs ]] ||
    [[ "$1" == "$TEST_PORTABLE" && "$3" == PORTABLE-UUID &&
      "$4" == PORTABLE-SERIAL && "$5" == ntfs3 ]]
}
ash_backup_require_portable_mount() {
  [[ "$1" == "$TEST_PORTABLE" ]]
}
ash_backup_require_portable_root() {
  [[ "$1" == "$TEST_PORTABLE/"* && "$2" == "$TEST_PORTABLE" ]]
}
SH
cat >"$namespace/bin/mountpoint" <<'SH'
#!/usr/bin/env bash
exit 0
SH
cat >"$namespace/bin/pg_restore" <<'SH'
#!/usr/bin/env bash
exit 0
SH
cat >"$namespace/bin/systemctl" <<'SH'
#!/usr/bin/env bash
if [[ "$*" == *'-p ActiveState'* ]]; then printf '%s\n' "${TEST_CUTOVER_ACTIVE:-inactive}"; else printf '0\n'; fi
SH
chmod 0755 "$namespace/bin/systemctl"
chmod 0755 "$namespace/bin/mountpoint" "$namespace/bin/pg_restore"

export PATH="$namespace/bin:$PATH"
export TEST_HOME="$namespace/home"
export TEST_PORTABLE="$namespace/portable"
export TELEMETRY_HOME_ENV_FILE="$namespace/env"
export ASH_ATLAS_BACKUP_COMMON="$namespace/common.sh"
export TELEMETRY_BACKUP_MIGRATION_LOCK="$namespace/migration.lock"

plan="$namespace/first-run-plan.json"
bash "$script_dir/ash-atlas-backup-migration.sh" --audit --plan "$plan" >/dev/null
[[ -f "$plan" && ! -e "$TEST_PORTABLE/ash-atlas-backup-archive" ]]
jq -e --arg root "$TEST_PORTABLE/ash-atlas-backup-archive" \
  '.portableRoot == $root and (.inventory | any(.[]; .path | endswith("unclassified.dump")))' \
  "$plan" >/dev/null

ln -s "$TEST_HOME" "$TEST_PORTABLE/ash-atlas-backup-archive"
unsafe_plan="$namespace/unsafe-plan.json"
if bash "$script_dir/ash-atlas-backup-migration.sh" --audit --plan "$unsafe_plan" \
  >/dev/null 2>&1; then
  echo 'symlinked canonical archive root was unexpectedly accepted' >&2
  exit 1
fi
[[ ! -e "$unsafe_plan" ]]

rm -- "$TEST_PORTABLE/ash-atlas-backup-archive"
ln -s "$TEST_HOME" "$TEST_PORTABLE/legacy-parent"
export TELEMETRY_PORTABLE_BACKUP_ROOT="$TEST_PORTABLE/legacy-parent/missing"
nested_plan="$namespace/nested-plan.json"
if bash "$script_dir/ash-atlas-backup-migration.sh" --audit --plan "$nested_plan" \
  >/dev/null 2>&1; then
  echo 'absent canonical root below a symlinked parent was unexpectedly accepted' >&2
  exit 1
fi
[[ ! -e "$nested_plan" ]]
echo 'backup migration first-run tests passed'
unset TELEMETRY_PORTABLE_BACKUP_ROOT
# Inventory and apply state must never cross Linux's single-argument limit.
padding="$(printf '%0120d' 0)"
for index in $(seq 1 1000); do
  printf '{}' >"$TEST_HOME/metadata-$index-$padding.json"
done
large_plan="$namespace/large-plan.json"
bash "$script_dir/ash-atlas-backup-migration.sh" --audit --plan "$large_plan" >/dev/null
[[ "$(stat -c '%s' "$large_plan")" -gt 131072 ]]
jq -e '.inventory|length>=1001' "$large_plan" >/dev/null

database="$TEST_HOME/ash-atlas-database-backups"
stamp=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
old="$database/ash_atlas_game-hourly-20260901T000000Z-$stamp-00000000-0000-4000-8000-000000000001.dump"
newest="$database/ash_atlas_game-hourly-20260926T000000Z-$stamp-00000000-0000-4000-8000-000000000002.dump"
older="$database/ash_atlas_game-hourly-20260925T000000Z-$stamp-00000000-0000-4000-8000-000000000003.dump"
printf stale >"$old"; printf newest >"$newest"; printf older >"$older"
legacy="$TEST_HOME/ash-atlas/deployment-pre-migration-archive"
mkdir -p "$legacy"
printf obsolete >"$legacy/old-deployment.dump"
printf unknown >"$legacy/unknown.credential"
printf '%s\n' "$newest" "$older" >"$namespace/keep.txt"
cat >"$namespace/bin/sha256sum" <<'SH'
#!/usr/bin/env bash
echo 'cutover must not call any payload hash' >&2
exit 99
SH
chmod 0755 "$namespace/bin/sha256sum"
cutover_plan="$namespace/cutover-plan.json"
partial="$database/.partial/database.Abc12345/$(basename "$old").partial"
mkdir -p "$(dirname "$partial")" "$database/.partial/database.BAD"
printf abandoned >"$partial"
printf unknown >"$database/.partial/database.BAD/unknown.dump.partial"
telemetry="$TEST_HOME/ash-atlas-telemetry"
mkdir -p "$telemetry/archive/fixture" "$telemetry/bug-report-index"
archive_oldest="$telemetry/archive/fixture/run-00000000-0000-4000-8000-000000000001-20260901T000000Z.duckdb"
archive_middle="$telemetry/archive/fixture/run-00000000-0000-4000-8000-000000000002-20260902T000000Z.duckdb"
archive_newest="$telemetry/archive/fixture/run-00000000-0000-4000-8000-000000000003-20260903T000000Z.duckdb"
truncate -s 4000000000 "$archive_oldest" "$archive_middle" "$archive_newest"
printf current >"$telemetry/current.duckdb"
printf index >"$telemetry/bug-report-index/current.json"
printf unknown >"$telemetry/archive/fixture/run-unknown-20260901T000000Z.duckdb"
if TEST_CUTOVER_ACTIVE=active bash "$script_dir/ash-atlas-backup-migration.sh" --cutover-plan --plan "$cutover_plan" --keep-list "$namespace/keep.txt" >/dev/null 2>&1; then exit 1; fi
[[ ! -e "$cutover_plan" ]]
bash "$script_dir/ash-atlas-backup-migration.sh" --cutover-plan --plan "$cutover_plan" --keep-list "$namespace/keep.txt" >/dev/null
jq -e --arg oldest "$archive_oldest" --arg middle "$archive_middle" --arg newest "$archive_newest" --arg partial "$partial" '
  .telemetryTargetBytes==8000000000 and .telemetryRetainedBytes<=8000000000
  and ([.removals[]|select(.removalKind=="oldest-telemetry-archive")|.path]==[$oldest,$middle])
  and any(.removals[];.path==$partial and .removalKind=="abandoned-database-partial")
  and all(.removals[];.path!=$newest)' "$cutover_plan" >/dev/null
# An exact plan refuses a changed partial before deleting that candidate.
touch "$partial"
if bash "$script_dir/ash-atlas-backup-migration.sh" --cutover-apply --plan "$cutover_plan" --keep-list "$namespace/keep.txt" >/dev/null 2>&1; then exit 1; fi
[[ -f "$partial" && -f "$archive_oldest" ]]
# Preserve the denied immutable plan/journal and re-inventory remaining files;
# never rewrite a stat identity to make an existing deletion plan pass.
mv "$cutover_plan" "$namespace/denied-cutover-plan.json"
[[ ! -f "$cutover_plan.journal.jsonl" ]] || mv "$cutover_plan.journal.jsonl" "$namespace/denied-cutover-plan.json.journal.jsonl"
bash "$script_dir/ash-atlas-backup-migration.sh" --cutover-plan --plan "$cutover_plan" --keep-list "$namespace/keep.txt" >/dev/null
bash "$script_dir/ash-atlas-backup-migration.sh" --cutover-apply --plan "$cutover_plan" --keep-list "$namespace/keep.txt" >/dev/null
bash "$script_dir/ash-atlas-backup-migration.sh" --cutover-apply --plan "$cutover_plan" --keep-list "$namespace/keep.txt" >/dev/null
[[ -f "$newest" && -f "$older" && -f "$legacy/unknown.credential" && ! -e "$old" && ! -e "$legacy/old-deployment.dump" ]]
[[ ! -e "$partial" && -f "$database/.partial/database.BAD/unknown.dump.partial" ]]
[[ ! -e "$archive_oldest" && ! -e "$archive_middle" && -f "$archive_newest" ]]
[[ -f "$telemetry/current.duckdb" && -f "$telemetry/bug-report-index/current.json" && -f "$telemetry/archive/fixture/run-unknown-20260901T000000Z.duckdb" ]]
echo 'large file-input inventory and exact idempotent metadata-only cutover passed'
