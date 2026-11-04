#!/usr/bin/env bash
set -euo pipefail
umask 077

fail() {
  printf 'STOP: %s\n' "$*" >&2
  exit 1
}

[[ $# -eq 2 ]] || fail "usage: $0 <release-sha> <database-name>"
release_sha=$1
database=$2
[[ "$release_sha" =~ ^[a-f0-9]{40}$ ]] || fail 'release SHA is invalid'
[[ "$database" =~ ^[a-z][a-z0-9_]{0,62}$ ]] || fail 'database name is invalid'

test_mode="${ASH_ATLAS_RESET_BACKUP_TEST_MODE:-false}"
handoff_root="${ASH_ATLAS_RESET_BACKUP_HANDOFF_ROOT:-/var/lib/ash-atlas/reset-backup-handoffs}"
ack_root="${ASH_ATLAS_RESET_BACKUP_ACK_ROOT:-/var/lib/ash-atlas/reset-backup-acknowledgments}"
ack_timeout="${ASH_ATLAS_RESET_BACKUP_ACK_TIMEOUT_SECONDS:-600}"
poll_seconds="${ASH_ATLAS_RESET_BACKUP_POLL_SECONDS:-5}"
pull_user="${TELEMETRY_PULL_USER:-ash-telemetry-pull}"

if [[ "$test_mode" == "true" ]]; then
  [[ "$handoff_root" == /tmp/ash-atlas-reset-backup-test.*/* ]] ||
    fail 'test handoff root is outside its isolated namespace'
  [[ "$ack_root" == /tmp/ash-atlas-reset-backup-test.*/* ]] ||
    fail 'test acknowledgment root is outside its isolated namespace'
else
  [[ "$handoff_root" == /var/lib/ash-atlas/reset-backup-handoffs ]] ||
    fail 'handoff root differs from the protected production path'
  [[ "$ack_root" == /var/lib/ash-atlas/reset-backup-acknowledgments ]] ||
    fail 'acknowledgment root differs from the protected production path'
  [[ $EUID -eq 0 ]] || fail 'backup preparation must run as root'
fi
[[ "$ack_timeout" =~ ^[1-9][0-9]{0,3}$ ]] || fail 'acknowledgment timeout is invalid'
[[ "$poll_seconds" =~ ^[1-9][0-9]{0,2}$ ]] || fail 'acknowledgment poll interval is invalid'

for command in jq sha256sum stat pg_restore mktemp date install readlink find; do
  command -v "$command" >/dev/null || fail "required command is missing: $command"
done

if [[ "$test_mode" == "true" ]]; then
  install -d -m 0700 "$handoff_root" "$ack_root"
else
  install -d -o root -g root -m 0700 "$handoff_root" "$ack_root"
fi
[[ -d "$handoff_root" && ! -L "$handoff_root" ]] || fail 'handoff root is unsafe'
[[ -d "$ack_root" && ! -L "$ack_root" ]] || fail 'acknowledgment root is unsafe'

operation_id="$(cat /proc/sys/kernel/random/uuid)"
[[ "$operation_id" =~ ^[a-f0-9-]{36}$ ]] || fail 'could not create an operation identifier'
operation_directory="$(mktemp -d "${handoff_root}/reset-${operation_id}.XXXXXXXX")"
cleanup_required=true
cleanup() {
  local code=$?
  if [[ "$cleanup_required" == "true" ]]; then
    rm -f -- "$operation_directory"/* 2>/dev/null || code=1
    rmdir -- "$operation_directory" 2>/dev/null || code=1
  fi
  exit "$code"
}
trap cleanup EXIT

[[ "$(stat -c '%a' "$operation_directory")" == "700" ]] ||
  fail 'temporary backup directory permissions are unsafe'
if [[ "$test_mode" != "true" ]]; then
  [[ "$(stat -c '%U:%G' "$operation_directory")" == "root:root" ]] ||
    fail 'temporary backup directory ownership is unsafe'
fi
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
created_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
file_name="${database}-gameplay-reset-${timestamp}-${release_sha}-${operation_id}.dump"
[[ "$file_name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,239}$ ]] ||
  fail 'generated backup filename is unsafe'
dump_path="${operation_directory}/${file_name}"
manifest_name="${file_name}.ready.json"
manifest_path="${operation_directory}/${manifest_name}"
ack_path="${ack_root}/${operation_id}.ack.json"

printf 'Creating protected PostgreSQL dump\n' >&2
if [[ "$test_mode" == "true" ]]; then
  dump_command="${ASH_ATLAS_RESET_BACKUP_PG_DUMP:?test pg_dump command is required}"
  "$dump_command" --format=custom --compress=6 --dbname="$database" >"$dump_path"
else
  # The root shell deliberately creates the 0600 destination; only pg_dump
  # drops to the local postgres account.
  # shellcheck disable=SC2024
  sudo -u postgres pg_dump \
    --format=custom --compress=6 --dbname="$database" >"$dump_path"
fi
chmod 0600 "$dump_path"
bytes="$(stat -c '%s' "$dump_path")"
[[ "$bytes" =~ ^[1-9][0-9]*$ ]] || fail 'PostgreSQL dump is empty'
pg_restore --list "$dump_path" >/dev/null ||
  fail 'local PostgreSQL restore catalog verification failed'
sha256="$(sha256sum "$dump_path" | awk '{print $1}')"
[[ "$sha256" =~ ^[a-f0-9]{64}$ ]] || fail 'could not calculate backup checksum'

jq -cn \
  --arg operationId "$operation_id" \
  --arg database "$database" \
  --arg releaseSha "$release_sha" \
  --arg createdAtUtc "$created_at" \
  --arg fileName "$file_name" \
  --arg sha256 "$sha256" \
  --argjson bytes "$bytes" \
  '{
    manifestVersion:1,
    kind:"ash_atlas_gameplay_reset_backup",
    operationId:$operationId,
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
  }' >"$manifest_path"
chmod 0600 "$manifest_path"

if [[ "$test_mode" != "true" ]]; then
  command -v setfacl >/dev/null || fail 'setfacl is required for the restricted pull handoff'
  id "$pull_user" >/dev/null 2>&1 || fail 'restricted telemetry pull account is absent'
  setfacl -m "u:${pull_user}:r-x" "$operation_directory"
  setfacl -m "u:${pull_user}:r--" "$dump_path" "$manifest_path"
fi

printf 'Transferring backup to external drive\n' >&2
deadline=$((SECONDS + ack_timeout))
while [[ ! -e "$ack_path" && $SECONDS -lt $deadline ]]; do
  sleep "$poll_seconds"
done
[[ -f "$ack_path" && ! -L "$ack_path" ]] ||
  fail 'home backup acknowledgment was not received before the timeout'

jq -e \
  --arg operation "$operation_id" \
  --arg manifest "$manifest_name" \
  --arg file "$file_name" \
  --arg database "$database" \
  --arg release "$release_sha" \
  --arg created "$created_at" \
  --arg sha "$sha256" \
  --argjson bytes "$bytes" '
    .acknowledgmentVersion == 1
    and .event == "ash_atlas_gameplay_reset_backup_verified"
    and .operationId == $operation
    and .manifestFileName == $manifest
    and .backupFileName == $file
    and .database == $database
    and .releaseSha == $release
    and .createdAtUtc == $created
    and .sha256 == $sha
    and .bytes == $bytes
    and .restoreCatalogVerified == true
    and (.acknowledgmentId | test("^[a-f0-9-]{36}$"))
    and (.remoteVerifiedAtUtc | fromdateiso8601)
    and (.remotePath | type == "string")
    and (.remotePath | startswith("/"))
    and (.remotePath | test("[[:space:][:cntrl:]]") | not)
    and (.remotePath | contains("/../") | not)
    and (.remotePath | endswith("/" + $file))
  ' "$ack_path" >/dev/null ||
  fail 'home backup acknowledgment is missing or malformed'

printf 'Verifying remote checksum and restore catalog\n' >&2
printf 'Remote backup confirmed\n' >&2
cleanup_required=false
jq -cn \
  --arg operationDirectory "$operation_directory" \
  --arg dumpPath "$dump_path" \
  --arg manifestPath "$manifest_path" \
  --arg acknowledgmentPath "$ack_path" \
  --arg backupFileName "$file_name" \
  '{
    operationDirectory:$operationDirectory,
    dumpPath:$dumpPath,
    manifestPath:$manifestPath,
    acknowledgmentPath:$acknowledgmentPath,
    backupFileName:$backupFileName
  }'
