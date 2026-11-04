#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
namespace="$(mktemp -d /tmp/ash-atlas-reset-backup-test.XXXXXXXX)"
trap 'rm -rf -- "$namespace"' EXIT
mkdir -p "${namespace}/bin" "${namespace}/handoffs" "${namespace}/acks"

cat >"${namespace}/bin/fake-pg-dump" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf 'PostgreSQL custom dump fixture\n'
SH
cat >"${namespace}/bin/pg_restore" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[[ "${RESET_TEST_RESTORE_FAIL:-false}" != "true" ]]
printf 'restore catalog fixture\n'
SH
chmod 0755 "${namespace}/bin/fake-pg-dump" "${namespace}/bin/pg_restore"

export PATH="${namespace}/bin:${PATH}"
export ASH_ATLAS_RESET_BACKUP_TEST_MODE=true
export ASH_ATLAS_RESET_BACKUP_HANDOFF_ROOT="${namespace}/handoffs"
export ASH_ATLAS_RESET_BACKUP_ACK_ROOT="${namespace}/acks"
export ASH_ATLAS_RESET_BACKUP_ACK_TIMEOUT_SECONDS=3
export ASH_ATLAS_RESET_BACKUP_POLL_SECONDS=1
export ASH_ATLAS_RESET_BACKUP_PG_DUMP="${namespace}/bin/fake-pg-dump"
release_sha="$(printf 'a%.0s' {1..40})"

clear_state() {
  find "$ASH_ATLAS_RESET_BACKUP_HANDOFF_ROOT" -mindepth 1 -maxdepth 2 \
    -type f -delete
  find "$ASH_ATLAS_RESET_BACKUP_HANDOFF_ROOT" -mindepth 1 -maxdepth 1 \
    -type d -empty -delete
  find "$ASH_ATLAS_RESET_BACKUP_ACK_ROOT" -mindepth 1 -maxdepth 1 \
    -type f -delete
}

acknowledge_next() {
  local mode="${1:-valid}" manifest operation file sha bytes created ack
  for _ in {1..50}; do
    manifest="$(find "$ASH_ATLAS_RESET_BACKUP_HANDOFF_ROOT" -mindepth 2 \
      -maxdepth 2 -type f -name '*.ready.json' -print -quit)"
    [[ -n "$manifest" ]] && break
    sleep 0.05
  done
  [[ -n "${manifest:-}" ]] || return 1
  operation="$(jq -r '.operationId' "$manifest")"
  file="$(jq -r '.artifact.fileName' "$manifest")"
  sha="$(jq -r '.artifact.sha256' "$manifest")"
  bytes="$(jq -r '.artifact.bytes' "$manifest")"
  created="$(jq -r '.createdAtUtc' "$manifest")"
  ack="${ASH_ATLAS_RESET_BACKUP_ACK_ROOT}/${operation}.ack.json"
  [[ "$mode" != "checksum" ]] || sha="$(printf '0%.0s' {1..64})"
  remote="/mnt/seagate/ash-atlas/database-resets/${file}"
  [[ "$mode" != "traversal" ]] ||
    remote="/mnt/seagate/ash-atlas/database-resets/../escaped.dump"
  jq -cn \
    --arg operationId "$operation" \
    --arg manifestFileName "$(basename "$manifest")" \
    --arg backupFileName "$file" \
    --arg remotePath "$remote" \
    --arg sha256 "$sha" \
    --arg releaseSha "$release_sha" \
    --arg createdAtUtc "$created" \
    --argjson bytes "$bytes" \
    '{
      acknowledgmentVersion:1,
      event:"ash_atlas_gameplay_reset_backup_verified",
      acknowledgmentId:"00000000-0000-4000-8000-000000000099",
      operationId:$operationId,
      manifestFileName:$manifestFileName,
      backupFileName:$backupFileName,
      remotePath:$remotePath,
      sha256:$sha256,
      bytes:$bytes,
      database:"ash_atlas_game",
      releaseSha:$releaseSha,
      createdAtUtc:$createdAtUtc,
      remoteVerifiedAtUtc:"2026-07-26T02:16:00Z",
      restoreCatalogVerified:true
    }' >"$ack"
}

run_success() {
  acknowledge_next valid &
  ack_pid=$!
  state="$(bash "${script_dir}/prepare-reset-backup.sh" \
    "$release_sha" ash_atlas_game)"
  wait "$ack_pid"
  jq -e '
    (.operationDirectory | type == "string")
    and (.dumpPath | endswith(".dump"))
    and (.manifestPath | endswith(".ready.json"))
    and (.acknowledgmentPath | endswith(".ack.json"))
  ' <<<"$state" >/dev/null
  [[ -s "$(jq -r '.dumpPath' <<<"$state")" ]]
  printf '%s\n' "$state"
}

first_state="$(run_success)"
first_name="$(jq -r '.backupFileName' <<<"$first_state")"
rm -f -- "$(jq -r '.dumpPath' <<<"$first_state")" \
  "$(jq -r '.manifestPath' <<<"$first_state")"
rmdir -- "$(jq -r '.operationDirectory' <<<"$first_state")"
rm -f -- "$(jq -r '.acknowledgmentPath' <<<"$first_state")"

second_state="$(run_success)"
second_name="$(jq -r '.backupFileName' <<<"$second_state")"
[[ "$first_name" != "$second_name" ]]
rm -f -- "$(jq -r '.dumpPath' <<<"$second_state")" \
  "$(jq -r '.manifestPath' <<<"$second_state")"
rmdir -- "$(jq -r '.operationDirectory' <<<"$second_state")"
rm -f -- "$(jq -r '.acknowledgmentPath' <<<"$second_state")"

export ASH_ATLAS_RESET_BACKUP_ACK_TIMEOUT_SECONDS=1
if bash "${script_dir}/prepare-reset-backup.sh" "$release_sha" ash_atlas_game \
    >/dev/null 2>"${namespace}/offline.log"; then
  echo "missing home acknowledgment permitted backup preparation" >&2
  exit 1
fi
[[ -z "$(find "$ASH_ATLAS_RESET_BACKUP_HANDOFF_ROOT" -mindepth 1 -print -quit)" ]]

export ASH_ATLAS_RESET_BACKUP_ACK_TIMEOUT_SECONDS=3
for mode in checksum traversal; do
  clear_state
  acknowledge_next "$mode" &
  ack_pid=$!
  if bash "${script_dir}/prepare-reset-backup.sh" "$release_sha" ash_atlas_game \
      >/dev/null 2>"${namespace}/${mode}.log"; then
    echo "malformed ${mode} acknowledgment was accepted" >&2
    exit 1
  fi
  wait "$ack_pid"
  [[ -z "$(find "$ASH_ATLAS_RESET_BACKUP_HANDOFF_ROOT" -mindepth 1 -print -quit)" ]]
done

clear_state
export RESET_TEST_RESTORE_FAIL=true
if bash "${script_dir}/prepare-reset-backup.sh" "$release_sha" ash_atlas_game \
    >/dev/null 2>"${namespace}/restore.log"; then
  echo "invalid local restore catalog was accepted" >&2
  exit 1
fi
unset RESET_TEST_RESTORE_FAIL
[[ -z "$(find "$ASH_ATLAS_RESET_BACKUP_HANDOFF_ROOT" -mindepth 1 -print -quit)" ]]

if grep -R -F 'postgresql://' "$namespace" >/dev/null; then
  echo "database URL leaked into reset backup logs" >&2
  exit 1
fi
echo "reset backup handoff tests passed"
