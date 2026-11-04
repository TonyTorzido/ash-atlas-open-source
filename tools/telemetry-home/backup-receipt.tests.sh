#!/usr/bin/env bash
set -euo pipefail
[[ $EUID == 0 ]] || { echo 'root fixture required' >&2; exit 1; }
source "$(dirname "${BASH_SOURCE[0]}")/ash-atlas-backup-common.sh"
test_root="$(mktemp -d /tmp/ash-atlas-database-backup-test.XXXXXXXX)"
trap 'rm -rf -- "$test_root"' EXIT
mkdir -p "$test_root/home" "$test_root/portable" "$test_root/bin"
export TELEMETRY_TEST_MODE=true TELEMETRY_HOME_STORAGE_ROOT="$test_root/home"
export TELEMETRY_HOME_STORAGE_MOUNT="$test_root/home" TELEMETRY_HOME_STORAGE_UUID=HOME
export TELEMETRY_HOME_STORAGE_SERIAL=HOME TELEMETRY_HOME_STORAGE_FSTYPE=ext4
export TELEMETRY_SEAGATE_MOUNT="$test_root/portable" TELEMETRY_SEAGATE_UUID=PORTABLE
export TELEMETRY_SEAGATE_SERIAL=PORTABLE TELEMETRY_SEAGATE_FSTYPE=ntfs3
ash_backup_validate_storage() { [[ "${WRONG_DRIVE:-false}" != true ]]; }
cat >"$test_root/bin/sha256sum" <<'SH'
#!/usr/bin/env bash
if [[ "${!#}" == *.dump ]]; then
  [[ -z "${RESTORE_READ_PATH_LOG:-}" ]] || printf '%s\n' "${!#}" >>"$RESTORE_READ_PATH_LOG"
  printf 'hash\n' >>"$READ_LOG"
  [[ "${FAIL_PAYLOAD_READ:-false}" != true ]] || exit 99
  [[ -z "${CHECK_LOCK_FILE:-}" ]] || flock -n "$CHECK_LOCK_FILE" true || exit 98
  [[ "${SLOW_READ:-false}" != true ]] || sleep 10
  [[ "${REPLACE_DURING_READ:-false}" != true ]] || printf replacement >"${!#}"
fi
exec /usr/bin/sha256sum "$@"
SH
cat >"$test_root/bin/pg_restore" <<'SH'
#!/usr/bin/env bash
printf 'catalog\n' >>"$READ_LOG"
[[ "${FAIL_PAYLOAD_READ:-false}" != true ]]
SH
chmod 0755 "$test_root/bin/"*
export PATH="$test_root/bin:$PATH" READ_LOG="$test_root/reads"
id=11111111-1111-4111-8111-111111111111
ack=22222222-2222-4222-8222-222222222222
dump="$test_root/portable/fixture.dump"
manifest="$test_root/manifest.json"
source_receipt="$test_root/source.json"
printf original >"$dump"
sha="$(/usr/bin/sha256sum "$dump" | cut -d' ' -f1)"
printf '{}\n' >"$manifest"
jq -n --arg ack "$ack" '{acknowledgmentId:$ack,remoteVerifiedAtUtc:"2026-09-26T00:00:00Z"}' >"$source_receipt"
verify() { ash_backup_verify_copy "$1" postgresql "$id" "$dump" 8 "$sha" "$manifest" "$source_receipt" ''; }
if verify fast >/dev/null; then exit 1; fi
verify deep >"$test_root/earned.json"
[[ "$(wc -l <"$READ_LOG")" == 2 ]]
export FAIL_PAYLOAD_READ=true
verify fast >"$test_root/replay.json"
cmp "$test_root/earned.json" "$test_root/replay.json"
[[ "$(wc -l <"$READ_LOG")" == 2 ]]
export WRONG_DRIVE=true
if verify fast >/dev/null; then exit 1; fi
unset WRONG_DRIVE
printf '{"changed":true}\n' >"$manifest"
if verify fast >/dev/null; then exit 1; fi
printf '{}\n' >"$manifest"
touch "$dump"
if verify fast >/dev/null; then exit 1; fi
unset FAIL_PAYLOAD_READ
verify deep >/dev/null
printf replaced >"$test_root/new.dump"
mv "$test_root/new.dump" "$dump"
if verify fast >/dev/null; then exit 1; fi
if verify deep >/dev/null; then exit 1; fi
[[ "$(find "$test_root/home/.copy-verifications" -name '*.json' | wc -l)" == 0 ]]
printf original >"$dump"
export REPLACE_DURING_READ=true
if verify deep >/dev/null; then exit 1; fi
unset REPLACE_DURING_READ
[[ "$(find "$test_root/home/.copy-verifications" -name '*.json' | wc -l)" == 0 ]]

# Exact 81-ID baseline plus three new IDs: selection admits two new IDs,
# then one beyond-policy baseline ID. No local payload/receipt is required.
inventory="$test_root/inventory.jsonl"
: >"$inventory"
for index in $(seq 1 84); do
  candidate="$(printf '00000000-0000-4000-8000-%012d' "$index")"
  jq -cn --arg id "$candidate" --arg created "$(printf '2026-09-26T%02d:%02d:00Z' "$((index / 60))" "$((index % 60))")" \
    '{backupId:$id,backupClass:"hourly",createdAtUtc:$created,artifact:{sha256:("a"*64)},green:false}' >>"$inventory"
done
jq -s '{baselineVersion:1,backups:.[0:81]}' "$inventory" >"$test_root/baseline.json"
chmod 0600 "$test_root/baseline.json"
printf '{"version":1,"retentionLimits":{"hourly":48,"daily":14,"weekly":8,"monthly":6,"preMigration":3}}\n' >"$test_root/health.json"
ash_backup_select_database_work "$inventory" "$test_root/baseline.json" "$test_root/health.json" >"$test_root/selected"
[[ "$(wc -l <"$test_root/selected")" == 3 ]]
mapfile -t selected <"$test_root/selected"
[[ "${selected[0]}" == *000000000082 && "${selected[1]}" == *000000000083 && "${selected[2]}" == *000000000001 ]]
ash_backup_select_database_work "$inventory" "$test_root/baseline.json" "$test_root/health.json" "${selected[0]}" >"$test_root/explicit"
[[ "$(wc -l <"$test_root/explicit")" == 1 ]]
sed '1s/"green":false/"green":true/' "$inventory" >"$test_root/green-inventory.jsonl"
ash_backup_select_database_work "$test_root/green-inventory.jsonl" "$test_root/baseline.json" "$test_root/health.json" >"$test_root/green-selection"
[[ "$(head -n1 "$test_root/green-selection")" == *000000000001 ]]
[[ "$(wc -l <"$test_root/green-selection")" == 4 ]]
echo 'receipt replay, mutation, corruption, interleaving and bounded 81-ID selection passed'

# Publication after an unlocked read is rejected on replacement/retirement.
printf original >"$dump"
ASH_ATLAS_BACKUP_DEFER_PUBLICATION=true verify deep >"$test_root/result.json"
printf original >"$test_root/other.dump"; mv "$test_root/other.dump" "$dump"
export TELEMETRY_PORTABLE_BACKUP_ROOT="$test_root/portable"
ash_backup_require_portable_mount() { return 0; }
if ash_backup_publish_copy_receipt "$test_root/result.json"; then exit 1; fi
verify deep >/dev/null
receipt_file="$(find "$test_root/home/.copy-verifications" -name '*.json' -print -quit)"
jq '.verifiedAtUtc="2026-09-25T00:00:00Z"' "$receipt_file" >"$receipt_file.partial"
chmod 0600 "$receipt_file.partial"; mv "$receipt_file.partial" "$receipt_file"
export ASH_ATLAS_BACKUP_DEADLINE=$(( $(date +%s) + 21 )) SLOW_READ=true
if verify deep >/dev/null; then exit 1; else [[ $? == 124 ]]; fi
unset SLOW_READ ASH_ATLAS_BACKUP_DEADLINE

# Run the real rotating entrypoint with a hash callback that proves its
# lifecycle lock is free, then a deadline that must retain partial state.
common_file="$(realpath "$(dirname "${BASH_SOURCE[0]}")/ash-atlas-backup-common.sh")"
cat >"$test_root/common.sh" <<SH
source '$common_file'
ash_backup_validate_storage() { return 0; }
ash_backup_require_portable_mount() { return 0; }
ash_backup_require_portable_root() { return 0; }
SH
cat >"$test_root/bin/ssh" <<SH
#!/usr/bin/env bash
printf 'fixture-$id.dump.ready.json\n'
SH
chmod 0755 "$test_root/bin/ssh"
export ASH_ATLAS_BACKUP_COMMON="$test_root/common.sh"
export TELEMETRY_HOME_PULL_LOCK="$test_root/pull.lock" ASH_ATLAS_BACKUP_MIRROR_LOCK="$test_root/mirror.lock"
export ASH_ATLAS_BACKUP_SCRUB_LOCK="$test_root/scrub.lock" TELEMETRY_BACKUP_MIGRATION_LOCK="$test_root/migration.lock"
export TELEMETRY_VPS_HOST=fixture TELEMETRY_VPS_USER=fixture TELEMETRY_KNOWN_HOSTS="$manifest" TELEMETRY_SSH_KEY="$manifest"
export ASH_ATLAS_DATABASE_BACKUP_REMOTE_DIRECTORY="$test_root/home/database" CHECK_LOCK_FILE="$test_root/pull.lock"
mkdir -p "$ASH_ATLAS_DATABASE_BACKUP_REMOTE_DIRECTORY/receipts"
scrubber="$(dirname "${BASH_SOURCE[0]}")/ash-atlas-backup-scrub.sh"
bash "$scrubber" >"$test_root/scrub.out"
sleep 1
export SLOW_READ=true ASH_ATLAS_BACKUP_DEADLINE=$(( $(date +%s) + 21 ))
bash "$scrubber" >"$test_root/scrub-timeout.out"
jq -e '.status == "partial" and .lastCompleteCycleAtUtc != null and
  any(.attempts[]; .timeoutCount == 1)' "$test_root/home/.ash-atlas-seagate-scrub-state.json" >/dev/null
flock -n "$test_root/pull.lock" true
unset SLOW_READ ASH_ATLAS_BACKUP_DEADLINE CHECK_LOCK_FILE
echo 'scrub publication race, deadline, partial cursor and lifecycle lock release passed'

# Periodic restore admission: latest only, production rejected, no workspace
# allocated when aggregate admission fails, and an active writer blocks reads.
jq '.createdAtUtc="2026-09-26T01:00:00Z"' "$source_receipt" >"$source_receipt.partial"
mv "$source_receipt.partial" "$source_receipt"
verify deep >/dev/null
latest_dump="$dump"
dump="$test_root/portable/older.dump"
printf original >"$dump"
older_source="$test_root/older-source.json"
jq '.createdAtUtc="2026-09-25T01:00:00Z"' "$source_receipt" >"$older_source"
ash_backup_verify_copy deep postgresql "$id" "$dump" 8 "$sha" "$manifest" "$older_source" '' >/dev/null
cat >>"$test_root/common.sh" <<'SH'
ash_backup_require_bounded_capacity() { return 1; }
SH
for binary in initdb pg_ctl psql createdb dropdb; do
  ln -s /bin/true "$test_root/bin/$binary"
done
cat >"$test_root/bin/pg_config" <<SH
#!/usr/bin/env bash
printf '%s\n' '$test_root/bin'
SH
chmod 0755 "$test_root/bin/pg_config"
touch "$test_root/restore.env"
export TELEMETRY_HOME_ENV_FILE="$test_root/restore.env"
export TELEMETRY_RESTORE_DATABASE_ESTIMATE_BYTES=1 TELEMETRY_RESTORE_WORKSPACE_CAP_BYTES=2147483648
export TELEMETRY_RESTORE_MINIMUM_FREE_BYTES=1 TELEMETRY_RESTORE_ROOT_RESERVE_BYTES=1
export RESTORE_READ_PATH_LOG="$test_root/restore-reads"
restorer="$(dirname "${BASH_SOURCE[0]}")/ash-atlas-backup-restore-check.sh"
if bash "$restorer" --latest --database ash_atlas_game >"$test_root/restore-denied.out" 2>&1; then exit 1; fi
grep -Fq 'disposable ash_atlas_stability_' "$test_root/restore-denied.out"
[[ ! -e "$RESTORE_READ_PATH_LOG" ]]
if bash "$restorer" --latest --database ash_atlas_stability_fixture >"$test_root/restore-admission.out" 2>&1; then exit 1; fi
grep -Fq 'restore allocation exceeds aggregate backup limit' "$test_root/restore-admission.out"
[[ "$(cat "$RESTORE_READ_PATH_LOG")" == "$latest_dump" ]]
[[ ! -e "$test_root/home/.restore-workspaces/ash-atlas-stability-restore" ]]
exec 4>"$test_root/pull.lock"; flock -n 4
if TELEMETRY_RESTORE_WRITER_WAIT_SECONDS=1 bash "$restorer" --latest >"$test_root/restore-busy.out" 2>&1; then exit 1; fi
grep -Fq 'backup writer is active' "$test_root/restore-busy.out"
[[ "$(wc -l <"$RESTORE_READ_PATH_LOG")" == 1 ]]
# A writer that finishes within the wait no longer defers the weekly check.
( sleep 1; flock -u 4 ) &
TELEMETRY_RESTORE_WRITER_WAIT_SECONDS=20 bash "$restorer" --latest >"$test_root/restore-waited.out" 2>&1 || true
wait
if grep -Fq 'backup writer is active' "$test_root/restore-waited.out"; then exit 1; fi
flock -u 4
echo 'latest-only restore, production rejection, aggregate admission and writer exclusion passed'
# Actual unprivileged traversal, not the mocked runuser/PG path: private intake
# stays inaccessible while the exact /run mountpoint is accessible to its owner.
chmod 0700 "$test_root/home"
if runuser -u nobody -- test -x "$test_root/home/.restore-workspaces"; then exit 1; fi
runtime_mount="$(mktemp -d /run/ash-atlas-stability-restore.XXXXXXXX)"
chown nobody:"$(id -gn nobody)" "$runtime_mount"; chmod 0700 "$runtime_mount"
runuser -u nobody -- test -x "$runtime_mount"
rmdir "$runtime_mount"
echo 'unprivileged runtime mount traversal preserves private intake permissions'

# Real SSH does consume inherited stdin even for read-only commands. Exercise
# the actual source helpers with a draining stub, retaining JSON ACK stdin.
cat >"$test_root/bin/ssh" <<'SH'
#!/usr/bin/env bash
readonly_call=false
for argument in "$@"; do [[ "$argument" != -n ]] || readonly_call=true; done
[[ "$readonly_call" == true ]] || cat >>"$SSH_STDIN_LOG"
SH
chmod 0755 "$test_root/bin/ssh"
export SSH_STDIN_LOG="$test_root/ssh-stdin"
ssh_options=();ssh_destination=fixture
for script in ash-atlas-telemetry-pull.sh ash-atlas-backup-prove.sh; do
  eval "$(awk '/^remote\(\) \{/{capture=1} capture{print} capture && /^\}/{exit}' "$(dirname "${BASH_SOURCE[0]}")/$script")"
  printf 'one\ntwo\nthree\n' | while IFS= read -r item; do remote "database-fetch $item"; printf '%s\n' "$item"; done >"$test_root/processed"
  [[ "$(wc -l <"$test_root/processed")" == 3 ]]
  if [[ "$script" == ash-atlas-telemetry-pull.sh ]]; then request='database-ack fixture'; else request='database-seagate-ack fixture'; fi
  printf 'fixture-ack\n' | remote "$request"
done
[[ "$(grep -Fc fixture-ack "$SSH_STDIN_LOG")" == 2 ]]
# Operator queue FD stays private even if a subprocess drains its stdin.
printf 'one\ntwo\nthree\n' >"$test_root/queue"
processed=0
while IFS= read -r -u 4 item; do cat >/dev/null; ((processed+=1)); done 4<"$test_root/queue" </dev/null
[[ "$processed" == 3 ]]
echo 'multi-ID read-only SSH/queue isolation and explicit JSON ACK stdin passed'
