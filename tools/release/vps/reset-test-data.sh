#!/usr/bin/env bash
set -euo pipefail

readonly GAME_CURRENT=/srv/ash-atlas/game/current
readonly ENV_FILE=/etc/ash-atlas/game.env
readonly RECEIPT_DIRECTORY=/var/lib/ash-atlas/gameplay-resets
readonly HANDOFF_ROOT=/var/lib/ash-atlas/reset-backup-handoffs
readonly RESET_LOCK=/run/lock/ash-atlas-test-data-reset.lock
readonly DEPLOY_LOCK=/run/lock/ash-atlas-test-update.lock
readonly CONFIRMATION=RESET-ASH-ATLAS-TEST-DATA

fail() {
  printf 'STOP: %s\n' "$*" >&2
  exit 1
}

[[ $EUID -eq 0 ]] || fail 'run this protected operation as root'
[[ -f "$ENV_FILE" && ! -L "$ENV_FILE" ]] || fail "$ENV_FILE is absent or unsafe"
[[ -L "$GAME_CURRENT" ]] || fail "$GAME_CURRENT is not the deployed release symlink"

exec 8>"$DEPLOY_LOCK"
flock -n 8 || fail 'a test-server deployment or maintenance operation is active'
exec 9>"$RESET_LOCK"
flock -n 9 || fail 'another test-data reset is active'

release_root=$(readlink -e "$GAME_CURRENT")
release_sha=${release_root##*/}
[[ "$release_sha" =~ ^[a-f0-9]{40}$ ]] || fail 'active release path does not end in an immutable SHA'
[[ -f "$release_root/apps/server/src/db/resetTestData.ts" ]] ||
  fail 'active release does not contain the reset command'
[[ -x "$release_root/tools/release/vps/prepare-reset-backup.sh" ]] ||
  fail 'active release does not contain the reset backup handoff'
[[ -f "$release_root/node_modules/tsx/dist/cli.mjs" ]] ||
  fail 'active release dependencies are incomplete'
for command in jq shred stat find; do
  command -v "$command" >/dev/null || fail "required command is missing: $command"
done

world_before=$(systemctl show ash-atlas-world.service \
  --property=ActiveState \
  --property=SubState \
  --property=MainPID \
  --property=ExecMainStartTimestampMonotonic)
systemctl is-active --quiet ash-atlas-world.service || fail 'World service is not active'
/usr/local/libexec/ash-atlas-wait-ready world

game_was_stopped=false
backup_operation_directory=
backup_dump_path=
backup_manifest_path=
verified_remote_path=
receipt_path=
backup_ack_path=
reset_transaction_completed=false
temporary_vps_copy_deleted=false
cleanup_local_backup() {
  local failed=false
  if [[ -n "$backup_dump_path" && -e "$backup_dump_path" ]]; then
    shred --remove=unlink --zero -- "$backup_dump_path" || failed=true
  fi
  if [[ -n "$backup_manifest_path" && -e "$backup_manifest_path" ]]; then
    rm -f -- "$backup_manifest_path" || failed=true
  fi
  if [[ -n "$backup_operation_directory" && -e "$backup_operation_directory" ]]; then
    rmdir -- "$backup_operation_directory" || failed=true
  fi
  if [[ "$failed" == "false" ]]; then
    temporary_vps_copy_deleted=true
    return 0
  fi
  return 1
}
on_exit() {
  local code=$?
  local failure_receipt
  if [[ -n "$backup_operation_directory" ]]; then
    if ! cleanup_local_backup; then
      printf 'STOP: temporary VPS backup cleanup is incomplete\n' >&2
      code=1
    fi
  fi
  if [[ $code -ne 0 && -n "$verified_remote_path" ]]; then
    printf 'STOP: reset did not complete; verified remote backup preserved at %s\n' \
      "$verified_remote_path" >&2
    if [[ -n "$receipt_path" && -f "$receipt_path" &&
          -n "$backup_ack_path" && -f "$backup_ack_path" ]]; then
      failure_receipt="${receipt_path}.$$"
      if jq --slurpfile acknowledgment "$backup_ack_path" \
        --argjson resetCompleted "$reset_transaction_completed" \
        --argjson temporaryDeleted "$temporary_vps_copy_deleted" '
        ($acknowledgment[0]) as $ack
        | .schemaVersion = 2
        | .result = "failed"
        | .resetCompleted = $resetCompleted
        | .remoteBackupVerificationSucceeded = true
        | .remoteDestinationPath = $ack.remotePath
        | .backupFileName = $ack.backupFileName
        | .backupSha256 = $ack.sha256
        | .backupBytes = $ack.bytes
        | .remoteVerificationTimestamp = $ack.remoteVerifiedAtUtc
        | .homeAcknowledgmentIdentifier = $ack.acknowledgmentId
        | .temporaryVpsCopyDeleted = $temporaryDeleted
        | .deployedReleaseSha = (.releaseSha // $ack.releaseSha)
      ' "$receipt_path" >"$failure_receipt" &&
        chmod 0600 "$failure_receipt"; then
        mv -- "$failure_receipt" "$receipt_path" || true
      fi
    fi
  fi
  if [[ "$game_was_stopped" = true ]] &&
      ! systemctl is-active --quiet ash-atlas.service; then
    systemctl start ash-atlas.service || true
    /usr/local/libexec/ash-atlas-wait-ready game || true
  fi
  local world_after
  world_after=$(systemctl show ash-atlas-world.service \
    --property=ActiveState \
    --property=SubState \
    --property=MainPID \
    --property=ExecMainStartTimestampMonotonic 2>/dev/null || true)
  if [[ "$world_after" != "$world_before" ]]; then
    printf 'STOP: World service identity changed during the game reset\n' >&2
    code=1
  fi
  exit "$code"
}
trap on_exit EXIT

systemctl stop ash-atlas.service
game_was_stopped=true
[[ $(systemctl show ash-atlas.service --property=ActiveState --value) = inactive ]] ||
  fail 'game service did not become inactive'
[[ $(systemctl show ash-atlas.service --property=MainPID --value) = 0 ]] ||
  fail 'game service still has a MainPID'
systemctl is-active --quiet ash-atlas-world.service || fail 'World service stopped unexpectedly'

install -d -o root -g root -m 0700 "$RECEIPT_DIRECTORY"

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
export ASH_ATLAS_DEPLOYMENT_ROLE=test-server
export TEST_DATA_RESET_RECEIPT_DIR="$RECEIPT_DIRECTORY"

cd "$release_root"
run_reset() {
  /usr/bin/node node_modules/tsx/dist/cli.mjs apps/server/src/db/resetTestData.ts "$@"
}

printf 'Reset dry-run for release %s\n' "$release_sha"
run_reset --dry-run

printf 'Checking home backup destination\n'
mapfile -t handoffs_before < <(
  find "$HANDOFF_ROOT" -mindepth 1 -maxdepth 1 -type d -print 2>/dev/null
)
backup_state="$(
  "$release_root/tools/release/vps/prepare-reset-backup.sh" \
    "$release_sha" ash_atlas_game
)"
mapfile -t handoffs_after < <(
  find "$HANDOFF_ROOT" -mindepth 1 -maxdepth 1 -type d -print
)
new_handoffs=()
for candidate in "${handoffs_after[@]}"; do
  seen=false
  for previous in "${handoffs_before[@]}"; do
    if [[ "$candidate" == "$previous" ]]; then
      seen=true
      break
    fi
  done
  [[ "$seen" == "true" ]] || new_handoffs+=("$candidate")
done
[[ ${#new_handoffs[@]} -eq 1 ]] ||
  fail 'backup handoff did not create exactly one owned temporary directory'
backup_operation_directory="${new_handoffs[0]}"
jq -e '
  (.operationDirectory | type == "string")
  and (.dumpPath | type == "string")
  and (.manifestPath | type == "string")
  and (.acknowledgmentPath | type == "string")
  and (.backupFileName | test("^[A-Za-z0-9][A-Za-z0-9._-]{0,239}$"))
' <<<"$backup_state" >/dev/null ||
  fail 'backup handoff returned malformed local state'
[[ "$(jq -r '.operationDirectory' <<<"$backup_state")" == "$backup_operation_directory" ]] ||
  fail 'backup handoff reported a different temporary directory'
backup_dump_path="$(jq -r '.dumpPath' <<<"$backup_state")"
backup_manifest_path="$(jq -r '.manifestPath' <<<"$backup_state")"
backup_ack_path="$(jq -r '.acknowledgmentPath' <<<"$backup_state")"
backup_file_name="$(jq -r '.backupFileName' <<<"$backup_state")"
[[ "$backup_operation_directory" == "$HANDOFF_ROOT"/reset-* ]] ||
  fail 'backup handoff directory is outside the protected root'
[[ "$backup_dump_path" == "$backup_operation_directory/$backup_file_name" ]] ||
  fail 'backup handoff dump path is inconsistent'
[[ -f "$backup_ack_path" && ! -L "$backup_ack_path" ]] ||
  fail 'verified home acknowledgment disappeared'
verified_remote_path="$(jq -r '.remotePath' "$backup_ack_path")"
backup_acknowledgment_id="$(jq -r '.acknowledgmentId' "$backup_ack_path")"
[[ "$backup_acknowledgment_id" =~ ^[a-f0-9-]{36}$ ]] ||
  fail 'verified home acknowledgment identifier is invalid'

receipt_path="${RECEIPT_DIRECTORY}/$(date -u +%Y-%m-%dT%H-%M-%SZ)-${release_sha}-${backup_acknowledgment_id}.json"
receipt_temporary="${receipt_path}.$$"
jq -n --slurpfile acknowledgment "$backup_ack_path" \
  --arg releaseSha "$release_sha" \
  --arg receiptStatus "remote_backup_verified_reset_pending" '
  ($acknowledgment[0]) as $ack
  | {
      schemaVersion:2,
      event:"ash_atlas_test_data_reset",
      result:$receiptStatus,
      resetCompleted:false,
      remoteBackupVerificationSucceeded:true,
      remoteDestinationPath:$ack.remotePath,
      backupFileName:$ack.backupFileName,
      backupSha256:$ack.sha256,
      backupBytes:$ack.bytes,
      remoteVerificationTimestamp:$ack.remoteVerifiedAtUtc,
      homeAcknowledgmentIdentifier:$ack.acknowledgmentId,
      temporaryVpsCopyDeleted:false,
      deployedReleaseSha:$releaseSha,
      database:{database:$ack.database}
    }
' >"$receipt_temporary"
chmod 0600 "$receipt_temporary"
mv -- "$receipt_temporary" "$receipt_path"

export TEST_DATA_RESET_BACKUP_ACK_PATH="$backup_ack_path"
export TEST_DATA_RESET_RECEIPT_PATH="$receipt_path"
printf 'Resetting gameplay data\n'
ALLOW_TEST_DATA_RESET=1 run_reset --confirm "$CONFIRMATION"
reset_transaction_completed=true

cleanup_local_backup ||
  fail 'temporary VPS backup cleanup failed after the database reset'
backup_operation_directory=
backup_dump_path=
backup_manifest_path=
[[ -z "$(find "$HANDOFF_ROOT" -mindepth 2 -maxdepth 2 \
  -type f -name "$backup_file_name" -print -quit)" ]] ||
  fail 'the reset dump still exists in the VPS handoff root'
[[ ! -e "/var/backups/ash-atlas/${backup_file_name}" ]] ||
  fail 'the reset dump exists in the former permanent VPS backup directory'

receipt_temporary="${receipt_path}.$$"
jq --slurpfile acknowledgment "$backup_ack_path" '
  ($acknowledgment[0]) as $ack
  | .schemaVersion = 2
  | .result = "reset_transaction_completed_postchecks_pending"
  | .resetCompleted = true
  | .remoteBackupVerificationSucceeded = true
  | .remoteDestinationPath = $ack.remotePath
  | .backupFileName = $ack.backupFileName
  | .backupSha256 = $ack.sha256
  | .backupBytes = $ack.bytes
  | .remoteVerificationTimestamp = $ack.remoteVerifiedAtUtc
  | .homeAcknowledgmentIdentifier = $ack.acknowledgmentId
  | .temporaryVpsCopyDeleted = true
  | .deployedReleaseSha = .releaseSha
' "$receipt_path" >"$receipt_temporary"
chmod 0600 "$receipt_temporary"
mv -- "$receipt_temporary" "$receipt_path"

printf 'Verifying migrations are a no-op\n'
migration_output=$(
  /usr/bin/node node_modules/tsx/dist/cli.mjs apps/server/src/db/migrate.ts
)
printf '%s\n' "$migration_output"
/usr/bin/node -e '
  const result = JSON.parse(process.argv[1]);
  if (result.ok !== true || !Array.isArray(result.applied) || result.applied.length !== 0) {
    process.exit(1);
  }
' "$migration_output" || fail 'post-reset migration verification was not a no-op'

printf 'Restarting game service\n'
systemctl start ash-atlas.service
/usr/local/libexec/ash-atlas-wait-ready game
systemctl is-active --quiet ash-atlas.service || fail 'game service is not active'
[[ $(readlink -e "$GAME_CURRENT") = "$release_root" ]] ||
  fail 'active immutable release changed during reset'

health=$(
  curl --fail --silent --show-error --max-time 5 \
    "http://127.0.0.1:${PORT:-3000}/health"
)
/usr/bin/node -e '
  const health = JSON.parse(process.argv[1]);
  if (health.ok !== true || health.runtime?.sha !== process.argv[2]) process.exit(1);
' "$health" "$release_sha" || fail 'game health or release identity probe failed'

systemctl is-active --quiet ash-atlas-world.service || fail 'World service is not active'
/usr/local/libexec/ash-atlas-wait-ready world
[[ $(systemctl show ash-atlas-world.service \
  --property=ActiveState \
  --property=SubState \
  --property=MainPID \
  --property=ExecMainStartTimestampMonotonic) = "$world_before" ]] ||
  fail 'World service restarted or changed identity during reset'

receipt_temporary="${receipt_path}.$$"
jq '.result = "completed"' "$receipt_path" >"$receipt_temporary"
chmod 0600 "$receipt_temporary"
mv -- "$receipt_temporary" "$receipt_path"
game_was_stopped=false
printf 'Reset complete\n'
printf 'Ash Atlas test gameplay reset completed for release %s\n' "$release_sha"
printf 'Future command: sudo %s/tools/release/vps/reset-test-data.sh\n' "$GAME_CURRENT"
