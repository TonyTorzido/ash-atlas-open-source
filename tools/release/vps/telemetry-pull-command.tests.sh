#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
root="$(mktemp -d /tmp/ash-atlas-telemetry-test.XXXXXXXX)"
reset_namespace="$(mktemp -d /tmp/ash-atlas-reset-backup-test.XXXXXXXX)"
trap 'rm -rf -- "$root" "$reset_namespace"' EXIT
export TELEMETRY_TEST_MODE=true
export TELEMETRY_EXPORT_ROOT="${root}/exports"
export TELEMETRY_ACK_ROOT="${root}/acks"
export ASH_ATLAS_RESET_BACKUP_HANDOFF_ROOT="${reset_namespace}/handoffs"
export ASH_ATLAS_RESET_BACKUP_ACK_ROOT="${reset_namespace}/acks"
mkdir -p "$TELEMETRY_EXPORT_ROOT" "$TELEMETRY_ACK_ROOT" \
  "$ASH_ATLAS_RESET_BACKUP_HANDOFF_ROOT" "$ASH_ATLAS_RESET_BACKUP_ACK_ROOT"
chmod 0730 "$TELEMETRY_ACK_ROOT"

segment_id="00000000-0000-4000-8000-000000000001"
run_id="00000000-0000-4000-8000-000000000002"
artifact="run-${run_id}.duckdb"
checksum="${artifact}.sha256"
manifest="${artifact}.ready.json"
printf 'verified artifact\n' >"${TELEMETRY_EXPORT_ROOT}/${artifact}"
sha="$(sha256sum "${TELEMETRY_EXPORT_ROOT}/${artifact}" | awk '{print $1}')"
bytes="$(stat -c '%s' "${TELEMETRY_EXPORT_ROOT}/${artifact}")"
printf '%s  %s\n' "$sha" "$artifact" >"${TELEMETRY_EXPORT_ROOT}/${checksum}"
jq -cn \
  --arg segment "$segment_id" \
  --arg run "$run_id" \
  --arg artifact "$artifact" \
  --arg checksum "$checksum" \
  --arg sha "$sha" \
  --argjson bytes "$bytes" \
  '{
    manifestVersion:1,segmentId:$segment,runId:$run,
    artifact:{fileName:$artifact,checksumFileName:$checksum,bytes:$bytes,sha256:$sha}
  }' >"${TELEMETRY_EXPORT_ROOT}/${manifest}"

invoke() {
  SSH_ORIGINAL_COMMAND="$1" bash "$script_dir/telemetry-pull-command.sh"
}

[[ "$(invoke list)" == "$manifest" ]]
cmp <(invoke "fetch ${artifact}") "${TELEMETRY_EXPORT_ROOT}/${artifact}"
cmp <(invoke "fetch ${checksum}") "${TELEMETRY_EXPORT_ROOT}/${checksum}"
cmp <(invoke "fetch ${manifest}") "${TELEMETRY_EXPORT_ROOT}/${manifest}"

printf 'not ready\n' >"${TELEMETRY_EXPORT_ROOT}/private.partial"
if invoke "fetch private.partial" >/dev/null 2>&1; then
  echo "unready fetch was accepted" >&2
  exit 1
fi
if invoke "fetch ../etc/passwd" >/dev/null 2>&1; then
  echo "path traversal was accepted" >&2
  exit 1
fi
ln -s /etc/passwd "${TELEMETRY_EXPORT_ROOT}/linked.ready.json"
if invoke "fetch linked.ready.json" >/dev/null 2>&1; then
  echo "symlink fetch was accepted" >&2
  exit 1
fi

invoke "ack ${manifest} ${sha} 1"
invoke "ack ${manifest} ${sha} 1"
[[ -f "${TELEMETRY_ACK_ROOT}/${segment_id}.ack.json" ]]
[[ -z "$(invoke list)" ]]
if invoke "ack ${manifest} $(printf '0%.0s' {1..64}) 1" >/dev/null 2>&1; then
  echo "mismatched acknowledgment was accepted" >&2
  exit 1
fi

operation_id="00000000-0000-4000-8000-000000000010"
reset_directory="${ASH_ATLAS_RESET_BACKUP_HANDOFF_ROOT}/reset-${operation_id}"
mkdir -p "$reset_directory"
reset_file="ash_atlas_game-gameplay-reset-20260726T021500Z-$(printf 'a%.0s' {1..40})-${operation_id}.dump"
reset_manifest="${reset_file}.ready.json"
printf 'custom PostgreSQL dump fixture\n' >"${reset_directory}/${reset_file}"
reset_sha="$(sha256sum "${reset_directory}/${reset_file}" | awk '{print $1}')"
reset_bytes="$(stat -c '%s' "${reset_directory}/${reset_file}")"
jq -cn \
  --arg operationId "$operation_id" \
  --arg fileName "$reset_file" \
  --arg sha256 "$reset_sha" \
  --arg releaseSha "$(printf 'a%.0s' {1..40})" \
  --argjson bytes "$reset_bytes" \
  '{
    manifestVersion:1,
    kind:"ash_atlas_gameplay_reset_backup",
    operationId:$operationId,
    database:"ash_atlas_game",
    releaseSha:$releaseSha,
    createdAtUtc:"2026-07-26T02:15:00Z",
    artifact:{fileName:$fileName,format:"postgresql-custom",bytes:$bytes,sha256:$sha256},
    acknowledgmentState:"pending"
  }' >"${reset_directory}/${reset_manifest}"
[[ "$(invoke reset-list)" == "$reset_manifest" ]]
cmp <(invoke "reset-fetch ${reset_file}") "${reset_directory}/${reset_file}"
if invoke "reset-fetch ../etc/passwd" >/dev/null 2>&1; then
  echo "reset path traversal was accepted" >&2
  exit 1
fi
reset_ack="${reset_namespace}/reset-ack.json"
jq -cn \
  --arg operationId "$operation_id" \
  --arg manifestFileName "$reset_manifest" \
  --arg backupFileName "$reset_file" \
  --arg sha256 "$reset_sha" \
  --arg releaseSha "$(printf 'a%.0s' {1..40})" \
  --arg remotePath "/mnt/seagate/ash-atlas/database-resets/${reset_file}" \
  --argjson bytes "$reset_bytes" \
  '{
    acknowledgmentVersion:1,
    event:"ash_atlas_gameplay_reset_backup_verified",
    acknowledgmentId:"00000000-0000-4000-8000-000000000011",
    operationId:$operationId,
    manifestFileName:$manifestFileName,
    backupFileName:$backupFileName,
    remotePath:$remotePath,
    sha256:$sha256,
    bytes:$bytes,
    database:"ash_atlas_game",
    releaseSha:$releaseSha,
    createdAtUtc:"2026-07-26T02:15:00Z",
    remoteVerifiedAtUtc:"2026-07-26T02:16:00Z",
    restoreCatalogVerified:true
  }' >"$reset_ack"
invoke "reset-ack ${reset_manifest}" <"$reset_ack"
[[ -f "${ASH_ATLAS_RESET_BACKUP_ACK_ROOT}/${operation_id}.ack.json" ]]
[[ -z "$(invoke reset-list)" ]]
jq '.remotePath="/mnt/seagate/ash-atlas/database-resets/../escaped.dump"' \
  "$reset_ack" >"${reset_namespace}/bad-ack.json"
rm -f "${ASH_ATLAS_RESET_BACKUP_ACK_ROOT}/${operation_id}.ack.json"
if invoke "reset-ack ${reset_manifest}" <"${reset_namespace}/bad-ack.json" \
    >/dev/null 2>&1; then
  echo "unsafe reset acknowledgment was accepted" >&2
  exit 1
fi

echo "telemetry pull forced-command tests passed"
