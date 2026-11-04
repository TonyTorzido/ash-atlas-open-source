#!/usr/bin/env bash
set -euo pipefail

home_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
vps_dir="$(cd -- "$home_dir/../release/vps" && pwd -P)"
namespace="$(mktemp -d /tmp/ash-atlas-database-backup-test.XXXXXXXX)"
telemetry_namespace="$(mktemp -d /tmp/ash-atlas-telemetry-test.XXXXXXXX)"
reset_namespace="$(mktemp -d /tmp/ash-atlas-reset-backup-test.XXXXXXXX)"
trap 'rm -rf -- "$namespace" "$telemetry_namespace" "$reset_namespace"' EXIT

mkdir -p "$namespace/bin" "$namespace/ovh" "$namespace/home" "$namespace/seagate" \
  "$namespace/home/ash-atlas-database-backups" \
  "$namespace/home/ash-atlas-reset-backups" \
  "$namespace/ovh/postgresql/seagate-acknowledgments" \
  "$telemetry_namespace/exports" "$telemetry_namespace/acks" \
  "$reset_namespace/handoffs" "$reset_namespace/acks"
chmod 0750 "$namespace/home/ash-atlas-database-backups" \
  "$namespace/home/ash-atlas-reset-backups"

cat >"$namespace/bin/findmnt" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
arguments=" $* "
if [[ "$arguments" == *" -J "* ]]; then
  target_path=""
  previous=""
  for argument in "$@"; do
    [[ "$previous" == -T ]] && target_path="$argument"
    previous="$argument"
  done
  if [[ "$target_path" == "${TELEMETRY_SEAGATE_MOUNT:?}"* ]]; then
    jq -cn --arg target "$TELEMETRY_SEAGATE_MOUNT" --arg uuid "$TELEMETRY_SEAGATE_UUID" \
      '{filesystems:[{target:$target,source:"/dev/test-seagate",fstype:"ntfs3",uuid:$uuid,
        options:"rw,relatime",fsroot:"/"}]}'
  else
    jq -cn --arg target "${TELEMETRY_HOME_STORAGE_MOUNT:?}" \
      --arg uuid "${TELEMETRY_HOME_STORAGE_UUID:?}" \
      --arg fstype "${TELEMETRY_HOME_STORAGE_FSTYPE:?}" \
      '{filesystems:[{target:$target,source:"/dev/test-internal",fstype:$fstype,uuid:$uuid,
        options:"rw,relatime",fsroot:"/"}]}'
  fi
  exit 0
fi
case "${!#}" in
  TARGET) printf '%s\n' "${ASH_ATLAS_BACKUP_MOUNT:?}" ;;
  SOURCE) printf 'tmpfs\n' ;;
  UUID) printf '%s\n' "${DATABASE_TEST_MOUNT_UUID:-$ASH_ATLAS_BACKUP_UUID}" ;;
  OPTIONS) printf 'rw,relatime\n' ;;
  *) exit 2 ;;
esac
SH
cat >"$namespace/bin/mountpoint" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[[ "${DATABASE_TEST_MOUNTED:-true}" == "true" ]]
SH
cat >"$namespace/bin/pg_dump" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [[ -n "${DATABASE_TEST_PG_DUMP_PAYLOAD_BYTES:-}" ]]; then
  [[ "${DATABASE_TEST_PG_DUMP_PAYLOAD_BYTES}" =~ ^[1-9][0-9]*$ ]]
  head -c "${DATABASE_TEST_PG_DUMP_PAYLOAD_BYTES}" /dev/zero
else
  printf 'PostgreSQL custom backup fixture for %s\n' "$*"
fi
SH
cat >"$namespace/bin/pg_restore" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[[ -z "${DATABASE_TEST_PG_RESTORE_LOG:-}" ]] || printf '%s\n' "$*" >>"$DATABASE_TEST_PG_RESTORE_LOG"
if [[ -n "${DATABASE_TEST_FORBID_PAYLOAD_ID:-}" && "$*" == *"$DATABASE_TEST_FORBID_PAYLOAD_ID"* &&
      ( "$*" == *"/home/"* || "$*" == *"/seagate/"* ) ]]; then exit 91; fi
[[ "${DATABASE_TEST_RESTORE_FAIL:-false}" != "true" ]]
printf 'fixture restore catalog\n'
SH
cat >"$namespace/bin/duckdb" <<'SH'
#!/usr/bin/env bash
exit 0
SH
cat >"$namespace/bin/udevadm" <<'SH'
#!/usr/bin/env bash
printf 'ID_SERIAL_SHORT=%s\n' "${DATABASE_TEST_DEVICE_SERIAL:-TEST-SERIAL}"
SH
cat >"$namespace/bin/ssh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
original="${!#}"
if [[ "${TELEMETRY_TEST_SOURCE_ACK_FAIL:-false}" == true && "$original" == database-ack\ * ]]; then
  echo 'simulated source ACK interruption after durable copy commit' >&2
  exit 91
fi
[[ -z "${TELEMETRY_TEST_SSH_LOG:-}" ]] || printf '%s\n' "$original" >>"$TELEMETRY_TEST_SSH_LOG"
if [[ -n "${TELEMETRY_TEST_FETCH_RETRY_MANIFEST:-}" &&
      "$original" == "database-fetch ${TELEMETRY_TEST_FETCH_RETRY_MANIFEST}" &&
      -n "${TELEMETRY_TEST_FETCH_RETRY_MARKER:-}" &&
      ! -e "$TELEMETRY_TEST_FETCH_RETRY_MARKER" ]]; then
  : >"$TELEMETRY_TEST_FETCH_RETRY_MARKER"
  echo 'request denied' >&2
  exit 126
fi
if [[ -n "${TELEMETRY_TEST_FETCH_FAIL_MANIFEST:-}" &&
      "$original" == "database-fetch ${TELEMETRY_TEST_FETCH_FAIL_MANIFEST}" ]]; then
  echo 'request denied' >&2
  exit 126
fi
if [[ -n "${TELEMETRY_TEST_OVERSIZE_DATABASE_FETCH:-}" &&
      "$original" == "database-fetch ${TELEMETRY_TEST_OVERSIZE_DATABASE_FETCH}" ]]; then
  SSH_ORIGINAL_COMMAND="$original" bash "${TELEMETRY_TEST_FORCED_COMMAND:?}"
  printf 'oversize-byte\n'
  exit 0
fi
if [[ -n "${TELEMETRY_TEST_RETENTION_RACE_MANIFEST:-}" &&
      "$original" == "database-fetch ${TELEMETRY_TEST_RETENTION_RACE_MANIFEST}" &&
      -n "${TELEMETRY_TEST_RETENTION_RACE_BACKUP_ID:-}" &&
      -n "${TELEMETRY_TEST_RETENTION_RACE_MARKER:-}" &&
      ! -e "$TELEMETRY_TEST_RETENTION_RACE_MARKER" ]]; then
  mkdir -p "${TELEMETRY_TEST_RETENTION_RACE_PRUNED_ROOT:?}"
  mv -- \
    "${ASH_ATLAS_DATABASE_BACKUP_READY_ROOT:?}/backup-${TELEMETRY_TEST_RETENTION_RACE_BACKUP_ID}" \
    "$TELEMETRY_TEST_RETENTION_RACE_PRUNED_ROOT/"
  : >"$TELEMETRY_TEST_RETENTION_RACE_MARKER"
  echo 'request denied' >&2
  exit 126
fi
if [[ "$original" == database-retained-list &&
      -n "${TELEMETRY_TEST_COHORT_ARRIVAL_DIR:-}" &&
      -n "${TELEMETRY_TEST_COHORT_ARRIVAL_MARKER:-}" &&
      ! -e "$TELEMETRY_TEST_COHORT_ARRIVAL_MARKER" ]]; then
  retained="$(SSH_ORIGINAL_COMMAND="$original" bash "${TELEMETRY_TEST_FORCED_COMMAND:?}")"
  mv -- "$TELEMETRY_TEST_COHORT_ARRIVAL_DIR" \
    "${ASH_ATLAS_DATABASE_BACKUP_READY_ROOT:?}/$(basename "$TELEMETRY_TEST_COHORT_ARRIVAL_DIR")"
  : >"$TELEMETRY_TEST_COHORT_ARRIVAL_MARKER"
  printf '%s\n' "$retained"
elif [[ "$original" == database-retained-list &&
        -n "${TELEMETRY_TEST_HIDE_RETAINED_MANIFEST:-}" ]]; then
  hidden_manifests=",${TELEMETRY_TEST_HIDE_RETAINED_MANIFEST},"
  SSH_ORIGINAL_COMMAND="$original" bash "${TELEMETRY_TEST_FORCED_COMMAND:?}" |
    while IFS= read -r retained_manifest; do
      [[ "$hidden_manifests" != *",${retained_manifest},"* ]] || continue
      printf '%s\n' "$retained_manifest"
    done
else
  SSH_ORIGINAL_COMMAND="$original" bash "${TELEMETRY_TEST_FORCED_COMMAND:?}"
fi
SH
cat >"$namespace/bin/systemctl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[[ -z "${TELEMETRY_TEST_SYSTEMCTL_LOG:-}" ]] || printf '%s\n' "$*" >>"$TELEMETRY_TEST_SYSTEMCTL_LOG"
[[ "$*" == *" show "* || "$1" == show ||
   "$*" == "start --no-block ash-atlas-backup-mirror.service" ||
   "$*" == "start --no-block ash-atlas-backup-prove.service" ]]
printf 'success\n'
SH
real_mv="$(command -v mv)"
cat >"$namespace/bin/mv" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
destination="${!#}"
if [[ "${DATABASE_TEST_PORTABLE_RENAME_FAIL:-false}" == "true" &&
      "$destination" == postgresql/backup-* ]]; then
  exit 1
fi
exec "$DATABASE_TEST_REAL_MV" "$@"
SH
chmod 0755 "$namespace/bin/"*
touch "$namespace/key" "$namespace/known-hosts"

export PATH="$namespace/bin:$PATH"
export ASH_ATLAS_DATABASE_BACKUP_TEST_MODE=true
export ASH_ATLAS_BACKUP_MOUNT="$namespace/ovh"
export ASH_ATLAS_BACKUP_UUID=TEST-OVH-UUID
export ASH_ATLAS_BACKUP_DEVICE_SERIAL=TEST-OVH-SERIAL
export ASH_ATLAS_DATABASE_BACKUP_TEST_DEVICE_SERIAL=TEST-OVH-SERIAL
export ASH_ATLAS_DATABASE_BACKUP_ROOT="$namespace/ovh/postgresql"
export ASH_ATLAS_DATABASE_BACKUP_DATABASE=ash_atlas_game
export ASH_ATLAS_DATABASE_BACKUP_CLASS=hourly
export ASH_ATLAS_DATABASE_BACKUP_MINIMUM_FREE_BYTES=1
export ASH_ATLAS_DATABASE_BACKUP_ESTIMATED_BYTES_FLOOR=1
export ASH_ATLAS_DATABASE_BACKUP_ESTIMATE_PERCENT=125
export ASH_ATLAS_DATABASE_BACKUP_FRESHNESS_MINUTES=180
export ASH_ATLAS_DATABASE_BACKUP_LOCK="$namespace/database-backup.lock"
export ASH_ATLAS_DATABASE_BACKUP_PG_DUMP="$namespace/bin/pg_dump"
export ASH_ATLAS_DATABASE_BACKUP_TEST_RELEASE_SHA="$(printf 'a%.0s' {1..40})"
export DATABASE_TEST_MOUNTED=true

export TELEMETRY_TEST_MODE=true
export TELEMETRY_TEST_FORCED_COMMAND="$vps_dir/telemetry-pull-command.sh"
export TELEMETRY_TEST_SSH_LOG="$namespace/ssh-commands.log"
export TELEMETRY_TEST_SYSTEMCTL_LOG="$namespace/systemctl.log"
export DATABASE_TEST_PG_RESTORE_LOG="$namespace/pg-restore.log"
export DATABASE_TEST_REAL_MV="$real_mv"
export TELEMETRY_EXPORT_ROOT="$telemetry_namespace/exports"
export TELEMETRY_ACK_ROOT="$telemetry_namespace/acks"
export ASH_ATLAS_RESET_BACKUP_HANDOFF_ROOT="$reset_namespace/handoffs"
export ASH_ATLAS_RESET_BACKUP_ACK_ROOT="$reset_namespace/acks"
export ASH_ATLAS_DATABASE_BACKUP_READY_ROOT="$namespace/ovh/postgresql/ready"
export ASH_ATLAS_DATABASE_BACKUP_ACK_ROOT="$namespace/ovh/postgresql/acknowledgments"
export ASH_ATLAS_DATABASE_SEAGATE_ACK_ROOT="$namespace/ovh/postgresql/seagate-acknowledgments"
export ASH_ATLAS_SEAGATE_PROOF_UUID=TEST-SEAGATE-UUID
export ASH_ATLAS_DATABASE_BACKUP_RETENTION_HOURLY=1
export TELEMETRY_VPS_HOST=test.invalid
export TELEMETRY_VPS_USER=ash-telemetry-pull
export TELEMETRY_SSH_KEY="$namespace/key"
export TELEMETRY_KNOWN_HOSTS="$namespace/known-hosts"
export TELEMETRY_HOME_STORAGE_ROOT="$namespace/home"
export TELEMETRY_HOME_STORAGE_MOUNT="$namespace/home"
export TELEMETRY_HOME_STORAGE_UUID=TEST-INTERNAL-UUID
export TELEMETRY_HOME_STORAGE_SERIAL=TEST-SERIAL
export TELEMETRY_HOME_STORAGE_FSTYPE=tmpfs
export TELEMETRY_SEAGATE_MOUNT="$namespace/seagate"
export TELEMETRY_SEAGATE_UUID=TEST-SEAGATE-UUID
export TELEMETRY_SEAGATE_SERIAL=TEST-SERIAL
export TELEMETRY_TEST_DEVICE_SERIAL=TEST-SERIAL
export ASH_ATLAS_BACKUP_TEST_DEVICE_SERIAL=TEST-SERIAL
export TELEMETRY_ARCHIVE_OWNER="$(id -un):$(id -gn)"
export TELEMETRY_HOME_MINIMUM_FREE_BYTES=1
export TELEMETRY_HOME_BACKUP_CAP_BYTES=500000
export TELEMETRY_HOME_BACKUP_WARNING_BYTES=400000
export TELEMETRY_SEAGATE_MINIMUM_FREE_BYTES=1
export TELEMETRY_HOME_PULL_LOCK="$namespace/home-pull.lock"
export ASH_ATLAS_BACKUP_MIRROR_LOCK="$namespace/mirror.lock"
export ASH_ATLAS_BACKUP_SCRUB_LOCK="$namespace/scrub.lock"
export ASH_ATLAS_BACKUP_COMMON="$home_dir/ash-atlas-backup-common.sh"
export ASH_ATLAS_DATABASE_BACKUP_REMOTE_DIRECTORY="$namespace/home/ash-atlas-database-backups"
export ASH_ATLAS_RESET_BACKUP_REMOTE_DIRECTORY="$namespace/home/ash-atlas-reset-backups"
export TELEMETRY_BUG_REPORT_INDEX_ENABLED=false

expect_failure() {
  local label="$1"
  shift
  if "$@" >"$namespace/${label}.out" 2>"$namespace/${label}.err"; then
    echo "failure scenario succeeded: $label" >&2
    exit 1
  fi
}

producer="$vps_dir/create-database-backup.sh"
home_pull="$home_dir/ash-atlas-telemetry-pull.sh"
prover="$home_dir/ash-atlas-backup-prove.sh"
mirror="$home_dir/ash-atlas-backup-mirror.sh"
grep -Fq 'source /etc/ash-atlas/telemetry-home.env' "$prover"
grep -Fq 'systemctl start --no-block ash-atlas-backup-prove.service' "$mirror"
if grep -Fq 'ash-atlas-backup-scrub.service' "$home_pull" ||
   grep -Fq 'ash-atlas-backup-scrub.service' "$mirror" ||
   grep -Fq 'ash-atlas-backup-scrub.service' "$home_dir/ash-atlas-seagate-mount.sh"; then
  echo 'routine home path must not launch the general scrub' >&2
  exit 1
fi
grep -Fq 'ExecStart=/usr/local/sbin/ash-atlas-backup-prove --unproved 1' \
  "$home_dir/ash-atlas-backup-prove.service.in"
grep -Fq 'Persistent=false' "$home_dir/ash-atlas-backup-scrub.timer"
bash "$producer" >/dev/null
sleep 1
bash "$producer" >/dev/null
mapfile -t manifests < <(find "$ASH_ATLAS_DATABASE_BACKUP_READY_ROOT" \
  -mindepth 2 -maxdepth 2 -type f -name '*.dump.ready.json')
[[ ${#manifests[@]} -eq 2 ]]
manifest=''
oldest_created=''
for candidate_manifest in "${manifests[@]}"; do
  candidate_created="$(jq -r '.createdAtUtc' "$candidate_manifest")"
  if [[ -z "$manifest" || "$candidate_created" < "$oldest_created" ]]; then
    manifest="$candidate_manifest"
    oldest_created="$candidate_created"
  fi
done
[[ -n "$manifest" ]]
newest_manifest=''
for candidate_manifest in "${manifests[@]}"; do
  [[ "$candidate_manifest" != "$manifest" ]] || continue
  newest_manifest="$candidate_manifest"
done
[[ -n "$newest_manifest" ]]
file_name="$(jq -r '.artifact.fileName' "$manifest")"
backup_id="$(jq -r '.backupId' "$manifest")"
mapfile -t listed_manifests < <(
  SSH_ORIGINAL_COMMAND=database-list bash "$TELEMETRY_TEST_FORCED_COMMAND"
)
[[ ${#listed_manifests[@]} -eq 2 ]]
printf '%s\n' "${listed_manifests[@]}" | LC_ALL=C sort >"$namespace/listed-database.txt"
printf '%s\n' "$(basename "${manifests[0]}")" "$(basename "${manifests[1]}")" |
  LC_ALL=C sort >"$namespace/expected-database.txt"
cmp -s "$namespace/listed-database.txt" "$namespace/expected-database.txt"
mapfile -t retained_manifests < <(
  SSH_ORIGINAL_COMMAND=database-retained-list bash "$TELEMETRY_TEST_FORCED_COMMAND"
)
[[ ${#retained_manifests[@]} -eq 2 ]]
expect_failure arbitrary-command env SSH_ORIGINAL_COMMAND='database-fetch ../../etc/shadow' \
  bash "$TELEMETRY_TEST_FORCED_COMMAND"
expect_failure retained-list-arguments env SSH_ORIGINAL_COMMAND='database-retained-list extra' \
  bash "$TELEMETRY_TEST_FORCED_COMMAND"

# Initial cutover compatibility: a source receipt may already point at a
# verified legacy flat Seagate copy.  The first home pull must adopt that
# exact copy, preserve its immutable acknowledgment identity, and avoid
# redownloading the dump merely because the new archive namespace is different.
legacy_file_name="$(jq -r '.artifact.fileName' "$newest_manifest")"
legacy_backup_id="$(jq -r '.backupId' "$newest_manifest")"
legacy_dump="$namespace/seagate/ash-atlas-database-backups/$legacy_file_name"
mkdir -p "$(dirname "$legacy_dump")"
mkdir -p "$ASH_ATLAS_DATABASE_BACKUP_REMOTE_DIRECTORY/receipts"
cp -- "$namespace/ovh/postgresql/ready/backup-$legacy_backup_id/$legacy_file_name" \
  "$legacy_dump"
legacy_ack_id="$(cat /proc/sys/kernel/random/uuid)"
jq -cn \
  --arg acknowledgmentId "$legacy_ack_id" \
  --arg backupId "$legacy_backup_id" \
  --arg backupClass "$(jq -r '.backupClass' "$newest_manifest")" \
  --arg manifestFileName "$(basename "$newest_manifest")" \
  --arg backupFileName "$legacy_file_name" \
  --arg remotePath "$namespace/home/ash-atlas-database-backups/$legacy_file_name" \
  --arg sha256 "$(jq -r '.artifact.sha256' "$newest_manifest")" \
  --arg database "$(jq -r '.database' "$newest_manifest")" \
  --arg releaseSha "$(jq -r '.releaseSha' "$newest_manifest")" \
  --arg createdAtUtc "$(jq -r '.createdAtUtc' "$newest_manifest")" \
  --arg remoteVerifiedAtUtc "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --argjson bytes "$(jq -r '.artifact.bytes' "$newest_manifest")" '
    {acknowledgmentVersion:1,event:"ash_atlas_postgresql_backup_verified",
     acknowledgmentId:$acknowledgmentId,backupId:$backupId,
     backupClass:$backupClass,manifestFileName:$manifestFileName,
     backupFileName:$backupFileName,remotePath:$remotePath,
     sha256:$sha256,bytes:$bytes,
     database:$database,releaseSha:$releaseSha,createdAtUtc:$createdAtUtc,
     remoteVerifiedAtUtc:$remoteVerifiedAtUtc,restoreCatalogVerified:true}' \
  >"$ASH_ATLAS_DATABASE_BACKUP_REMOTE_DIRECTORY/receipts/$legacy_file_name.receipt.json"

if ! bash "$home_pull" >"$namespace/home-pull.out" 2>"$namespace/home-pull.err"; then
  cat "$namespace/home-pull.err" >&2
  exit 1
fi
local_dump="$ASH_ATLAS_DATABASE_BACKUP_REMOTE_DIRECTORY/$file_name"
emergency_dump="$ASH_ATLAS_DATABASE_BACKUP_REMOTE_DIRECTORY/emergency/$file_name"
receipt="$ASH_ATLAS_DATABASE_BACKUP_REMOTE_DIRECTORY/receipts/$file_name.receipt.json"
ack="$ASH_ATLAS_DATABASE_BACKUP_ACK_ROOT/$backup_id.ack.json"
legacy_receipt="$ASH_ATLAS_DATABASE_BACKUP_REMOTE_DIRECTORY/receipts/$legacy_file_name.receipt.json"
legacy_ack="$ASH_ATLAS_DATABASE_BACKUP_ACK_ROOT/$legacy_backup_id.ack.json"
portable_dump="$namespace/seagate/ash-atlas-backup-archive/postgresql/backup-$backup_id/$file_name"
[[ ! -e "$local_dump" && -f "$emergency_dump" && -f "$receipt" && -f "$ack" ]]
[[ -f "$legacy_dump" ]]
! grep -Fq "database-fetch $legacy_file_name" "$TELEMETRY_TEST_SSH_LOG"
[[ "$(jq -r '.portablePath // "absent"' "$legacy_receipt")" == absent ]]
legacy_mapping="$ASH_ATLAS_DATABASE_BACKUP_REMOTE_DIRECTORY/.portable-mappings/backup-$legacy_backup_id.json"
[[ -f "$legacy_mapping" ]]
jq -e --arg source "$namespace/home/ash-atlas-database-backups/$legacy_file_name" \
  --arg portable "$legacy_dump" --arg id "$legacy_backup_id" \
  '.portableMappingVersion == 1 and .backupId == $id
   and .sourcePath == $source and .portablePath == $portable' \
  "$legacy_mapping" >/dev/null
[[ "$(jq -r 'has("portablePath")' "$legacy_receipt")" == false ]]
[[ "$(jq -r 'has("portableReceiptVersion")' "$legacy_receipt")" == false ]]
[[ "$(jq -r 'has("portablePath")' "$legacy_ack")" == false ]]
grep -Fq "adopted verified existing portable copy without redownload: $legacy_backup_id" \
  "$namespace/home-pull.err"
health="$namespace/home/.ash-atlas-ovh-database-health.json"
[[ -f "$health" ]]
jq -e '.version == 1 and .mountStatus == "ok" and .readWriteStatus == "ok"
  and .capacityStatus == "ok" and .backupFreshnessStatus == "ok"
  and .catalogStatus == "ok" and .hourlyServiceResult == "success"
  and .status == "ok"
  and (.freeBytes | type == "number")
  and (.requiredHeadroomBytes | type == "number")
  and (.headroomMarginBytes | type == "number")
  and (.beyondLimitCount | type == "number")
  and (.beyondLimitBytes | type == "number")
  and (.currentlyEligibleCount | type == "number")
  and (.proofAgeMinutes | type == "number")
  and (.latestScrubResult | IN("ok","problem","unknown"))
  and (.offsiteReachability | IN("reachable","unreachable","unknown"))
  and (.projectedBackupsUntilExhaustion | type == "number")
  and (.projectedHoursUntilExhaustion | type == "number")
  and (.capacityAlert | IN("ok","warning","critical"))
  and (.retentionLimits.hourly == 1)
  and (.retentionLimits.daily | type == "number")
  and (.retentionLimits.weekly | type == "number")
  and (.retentionLimits.monthly | type == "number")
  and (.retentionLimits.preMigration | type == "number")' "$health" >/dev/null || {
  cat "$health" >&2
  exit 1
}
[[ "$(stat -c '%s' "$emergency_dump")" == "$(jq -r '.artifact.bytes' "$manifest")" ]]
[[ "$(sha256sum "$emergency_dump" | awk '{print $1}')" == "$(jq -r '.artifact.sha256' "$manifest")" ]]
pg_restore --list "$emergency_dump" >/dev/null
jq -e '.event == "ash_atlas_postgresql_backup_verified"
  and .backupClass == "hourly" and .restoreCatalogVerified == true' \
  "$receipt" >/dev/null
[[ "$(jq -r 'has("portablePath")' "$receipt")" == false ]]
[[ "$(jq -r 'has("portableReceiptVersion")' "$receipt")" == false ]]
new_mapping="$ASH_ATLAS_DATABASE_BACKUP_REMOTE_DIRECTORY/.portable-mappings/backup-$backup_id.json"
jq -e --arg source "$local_dump" --arg portable "$portable_dump" --arg id "$backup_id" \
  --arg sha "$(jq -r '.artifact.sha256' "$manifest")" \
  --argjson bytes "$(jq -r '.artifact.bytes' "$manifest")" \
  '.portableMappingVersion == 1 and .backupId == $id and .sourcePath == $source
   and .portablePath == $portable and .sha256 == $sha and .bytes == $bytes' \
  "$new_mapping" >/dev/null
# The old-format receipt remains unmodified. Proof must use the earned HOME
# mapping and retain the deployed legacy-minimal Seagate proof shape.
legacy_source="$namespace/home/ash-atlas-database-backups/$legacy_file_name"
bash "$prover" --backup-id "$legacy_backup_id" >"$namespace/legacy-prover.out"
grep -Fq "backupId=$legacy_backup_id result=proved" "$namespace/legacy-prover.out"
legacy_seagate_ack="$ASH_ATLAS_DATABASE_SEAGATE_ACK_ROOT/$legacy_backup_id.seagate.ack.json"
[[ -f "$legacy_seagate_ack" ]]
jq -e '(has("portablePath") | not) and (has("portableReceiptSha256") | not)' \
  "$legacy_seagate_ack" >/dev/null
[[ "$(jq -r '.remotePath' "$legacy_receipt")" == "$legacy_source" ]]
[[ "$(jq -r 'has("portablePath")' "$legacy_receipt")" == false ]]
# The deployed VPS accepts an old proof replay with only its observation time
# changed.  This is the wire-compatibility guard for the home-first cutover.
legacy_replay="$namespace/legacy-seagate-replay.json"
jq --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '.seagateVerifiedAtUtc=$now' \
  "$legacy_seagate_ack" >"$legacy_replay"
mv -- "$legacy_replay" "$legacy_seagate_ack"
SSH_ORIGINAL_COMMAND="database-seagate-ack $(basename "$newest_manifest")" \
  bash "$TELEMETRY_TEST_FORCED_COMMAND" <"$legacy_seagate_ack" >/dev/null
bash "$prover" --backup-id "$legacy_backup_id" >"$namespace/legacy-prover-skip.out"
grep -Fq "backupId=$legacy_backup_id result=skipped bytesRead=0" \
  "$namespace/legacy-prover-skip.out"
legacy_proof_evidence="$namespace/home/.ash-atlas-seagate-proof-evidence/backup-$legacy_backup_id.accepted.json"
legacy_proof_template="$namespace/home/.ash-atlas-seagate-proof-evidence/backup-$legacy_backup_id.request.json"
jq -e --arg id "$legacy_backup_id" --arg sha "$(jq -r '.artifact.sha256' "$newest_manifest")" \
  --arg templateSha "$(sha256sum "$legacy_proof_template" | awk '{print $1}')" \
  '.proofEvidenceVersion == 1 and .backupId == $id and .sha256 == $sha
   and .requestTemplateSha256 == $templateSha
   and .acceptedProof.seagateUuid == "TEST-SEAGATE-UUID"' \
  "$legacy_proof_evidence" >/dev/null
# A reused immutable backup ID with a different manifest hash is rejected even
# when a valid portable copy and source receipt already exist.
conflicting_manifest="$namespace/original-database.manifest.json"
cp -- "$manifest" "$conflicting_manifest"
jq '.artifact.sha256 = ("0" * 64)' "$manifest" >"$namespace/conflicting.manifest.json"
mv -- "$namespace/conflicting.manifest.json" "$manifest"
rm -- "$ack"
expect_failure same-id-conflict bash "$home_pull"
mv -- "$conflicting_manifest" "$manifest"
bash "$home_pull" >/dev/null
[[ -f "$ack" ]]

[[ -z "$(SSH_ORIGINAL_COMMAND=database-list bash "$TELEMETRY_TEST_FORCED_COMMAND")" ]]
mapfile -t retained_after_pull < <(
  SSH_ORIGINAL_COMMAND=database-retained-list bash "$TELEMETRY_TEST_FORCED_COMMAND"
)
[[ ${#retained_after_pull[@]} -eq 2 ]]

# Build the other immutable source roots, mirror the complete intake, and prove
# that the production scrub emits the per-backup Seagate acknowledgment.
mkdir -p "$namespace/home/ash-atlas-telemetry/archive/fixture" \
  "$namespace/home/ash-atlas-telemetry/bug-report-index" \
  "$namespace/home/ash-atlas-reset-backups/receipts"
printf 'telemetry fixture\n' >"$namespace/home/ash-atlas-telemetry/archive/fixture/test.duckdb"
telemetry_bytes="$(stat -c '%s' "$namespace/home/ash-atlas-telemetry/archive/fixture/test.duckdb")"
telemetry_sha="$(sha256sum "$namespace/home/ash-atlas-telemetry/archive/fixture/test.duckdb" | awk '{print $1}')"
jq -cn --arg sha "$telemetry_sha" --argjson bytes "$telemetry_bytes" '
  {artifact:{fileName:"test.duckdb",bytes:$bytes,sha256:$sha}}' \
  >"$namespace/home/ash-atlas-telemetry/archive/fixture/test.duckdb.ready.json"
printf 'mutable source index\n' \
  >"$namespace/home/ash-atlas-telemetry/bug-report-index/different.json"
reset_dump="$namespace/home/ash-atlas-reset-backups/reset.dump"
printf 'reset fixture\n' >"$reset_dump"
reset_bytes="$(stat -c '%s' "$reset_dump")"
reset_sha="$(sha256sum "$reset_dump" | awk '{print $1}')"
jq -cn --arg sha "$reset_sha" --argjson bytes "$reset_bytes" '
  {acknowledgmentVersion:1,event:"ash_atlas_gameplay_reset_backup_verified",
   backupFileName:"reset.dump",bytes:$bytes,sha256:$sha,
   restoreCatalogVerified:true}' \
  >"$namespace/home/ash-atlas-reset-backups/receipts/reset.dump.receipt.json"

# A validated home receipt can outlive its already-pruned VPS manifest. It
# remains part of mirror/scrub parity but must not be sent back for acknowledgment.
stale_file_name=ash_atlas_game-pruned-fixture.dump
stale_manifest_name="$stale_file_name.ready.json"
stale_backup_id="$(cat /proc/sys/kernel/random/uuid)"
stale_ack_id="$(cat /proc/sys/kernel/random/uuid)"
stale_dump="$ASH_ATLAS_DATABASE_BACKUP_REMOTE_DIRECTORY/$stale_file_name"
stale_receipt="$ASH_ATLAS_DATABASE_BACKUP_REMOTE_DIRECTORY/receipts/$stale_file_name.receipt.json"
cp -- "$portable_dump" "$stale_dump"
jq --arg id "$stale_backup_id" --arg ack "$stale_ack_id" \
  --arg file "$stale_file_name" --arg manifest "$stale_manifest_name" \
  --arg path "$stale_dump" '
    .backupId=$id | .acknowledgmentId=$ack
    | .backupFileName=$file | .manifestFileName=$manifest | .remotePath=$path
  ' "$receipt" >"$stale_receipt"
for relative in ash-atlas-telemetry ash-atlas-database-backups ash-atlas-reset-backups; do
  mkdir -p "$namespace/seagate/$relative"
  rsync -a "$namespace/home/$relative/" "$namespace/seagate/$relative/"
done
printf 'independently rebuilt Seagate index\n' \
  >"$namespace/seagate/ash-atlas-telemetry/bug-report-index/different.json"
printf 'new mutable home-only index\n' \
  >"$namespace/home/ash-atlas-telemetry/bug-report-index/home-only.json"
touch -d '2001-01-01T00:00:00Z' "$namespace/seagate/ash-atlas-database-backups"
destination_root_mtime="$(stat -c '%Y' "$namespace/seagate/ash-atlas-database-backups")"
if ! bash "$mirror" >"$namespace/mirror.out" 2>"$namespace/mirror.err"; then
  cat "$namespace/mirror.err" >&2
  exit 1
fi
grep -q 'Seagate mirror verified' "$namespace/mirror.out"
[[ "$(stat -c '%Y' "$namespace/seagate/ash-atlas-database-backups")" == \
   "$destination_root_mtime" ]]
grep -Fxq 'independently rebuilt Seagate index' \
  "$namespace/seagate/ash-atlas-telemetry/bug-report-index/different.json"
[[ ! -e "$namespace/seagate/ash-atlas-telemetry/bug-report-index/home-only.json" ]]
grep -Fxq 'start --no-block ash-atlas-backup-mirror.service' \
  "$TELEMETRY_TEST_SYSTEMCTL_LOG"
grep -Fxq 'start --no-block ash-atlas-backup-prove.service' \
  "$TELEMETRY_TEST_SYSTEMCTL_LOG"
if grep -Fq 'ash-atlas-backup-scrub.service' "$TELEMETRY_TEST_SYSTEMCTL_LOG"; then
  echo 'routine pull/mirror path launched the general scrub' >&2
  exit 1
fi

# A full bounded portable telemetry archive must not stop the independent
# database/reset mirror pass.  The new telemetry segment is refused before
# its destination write, while exact progress files in both backup roots are
# already mirrored and then cleaned from this fixture.
database_progress_probe="$ASH_ATLAS_DATABASE_BACKUP_REMOTE_DIRECTORY/telemetry-cap-progress.txt"
reset_progress_probe="$ASH_ATLAS_RESET_BACKUP_REMOTE_DIRECTORY/telemetry-cap-progress.txt"
telemetry_cap_probe="$namespace/home/ash-atlas-telemetry/archive/fixture/telemetry-cap-incoming.duckdb"
printf 'database progress\n' >"$database_progress_probe"
printf 'reset progress\n' >"$reset_progress_probe"
printf 'telemetry that must wait\n' >"$telemetry_cap_probe"
export TELEMETRY_PORTABLE_TELEMETRY_CAP_BYTES="$telemetry_bytes"
export TELEMETRY_PORTABLE_TELEMETRY_WARNING_BYTES="$((telemetry_bytes - 1))"
: >"$TELEMETRY_TEST_SYSTEMCTL_LOG"
bash "$mirror" >"$namespace/telemetry-cap-database-progress.out" 2>"$namespace/telemetry-cap-database-progress.err"
grep -Fq 'telemetry mirror skipped' "$namespace/telemetry-cap-database-progress.err"
# The pass still finishes, records the skip truthfully, and schedules proof.
jq -e '.status == "ok" and (.telemetrySkipped | length > 0)
  and (.relativeRoots | index("ash-atlas-telemetry/archive") == null)' \
  "$namespace/home/.ash-atlas-seagate-mirror-state.json" >/dev/null
grep -Fq 'ash-atlas-backup-prove.service' "$TELEMETRY_TEST_SYSTEMCTL_LOG"
if [[ ! -f "$namespace/seagate/ash-atlas-database-backups/telemetry-cap-progress.txt" ]]; then
  cat "$namespace/telemetry-cap-database-progress.err" >&2
  find "$namespace/seagate" -name 'telemetry-cap-progress.txt' -print >&2
  bash -x "$mirror" >"$namespace/telemetry-cap-rerun.out" \
    2>"$namespace/telemetry-cap-rerun.trace" || true
  tail -n 180 "$namespace/telemetry-cap-rerun.trace" >&2 || true
  exit 1
fi
[[ -f "$namespace/seagate/ash-atlas-reset-backups/telemetry-cap-progress.txt" ]]
[[ ! -e "$namespace/seagate/ash-atlas-telemetry/archive/fixture/telemetry-cap-incoming.duckdb" ]]
rm -f -- "$database_progress_probe" "$reset_progress_probe" "$telemetry_cap_probe" \
  "$namespace/seagate/ash-atlas-database-backups/telemetry-cap-progress.txt" \
  "$namespace/seagate/ash-atlas-reset-backups/telemetry-cap-progress.txt"
unset TELEMETRY_PORTABLE_TELEMETRY_CAP_BYTES
unset TELEMETRY_PORTABLE_TELEMETRY_WARNING_BYTES

# Home telemetry has its own hard cap as well as the portable cap.  A new
# remote segment is rejected before its artifact stream is fetched, while the
# database/reset phases above have already completed.
# The aggregate cap must also leave room for the bounded one-megabyte remote
# manifest probe; the telemetry-specific cap below remains the assertion.
export TELEMETRY_HOME_BACKUP_CAP_BYTES=5000000
export TELEMETRY_HOME_BACKUP_WARNING_BYTES=4000000
home_telemetry_segment_id="$(cat /proc/sys/kernel/random/uuid)"
home_telemetry_run_id="$(cat /proc/sys/kernel/random/uuid)"
home_telemetry_artifact_name=home-cap-incoming.duckdb
home_telemetry_checksum_name=home-cap-incoming.sha256
home_telemetry_artifact="$telemetry_namespace/exports/$home_telemetry_artifact_name"
printf 'telemetry home cap fixture\n' >"$home_telemetry_artifact"
home_telemetry_bytes="$(stat -c '%s' "$home_telemetry_artifact")"
home_telemetry_sha="$(sha256sum "$home_telemetry_artifact" | awk '{print $1}')"
printf '%s  %s\n' "$home_telemetry_sha" "$home_telemetry_artifact_name" \
  >"$telemetry_namespace/exports/$home_telemetry_checksum_name"
jq -cn --arg segmentId "$home_telemetry_segment_id" --arg runId "$home_telemetry_run_id" \
  --arg artifact "$home_telemetry_artifact_name" \
  --arg checksum "$home_telemetry_checksum_name" --arg sha "$home_telemetry_sha" \
  --argjson bytes "$home_telemetry_bytes" '
    {manifestVersion:1,segmentId:$segmentId,runId:$runId,
     segmentStartAt:"2026-09-23T00:00:00Z",segmentEndAt:"2026-09-23T00:05:00Z",
     releaseSha:("a" * 40),releaseGeneration:"test/t1252",
     worldReleaseId:"test-world",populationPlanVersion:"1",
     populationSpawnRulesVersion:"1",balanceVersion:"1",
     artifact:{fileName:$artifact,checksumFileName:$checksum,format:"duckdb",
               bytes:$bytes,sha256:$sha},tableRowCounts:{},
     acknowledgmentState:"unacknowledged"}' \
  >"$telemetry_namespace/exports/home-cap-incoming.ready.json"
home_telemetry_archive_bytes="$(find "$namespace/home/ash-atlas-telemetry/archive" \
  -type f -printf '%s\n' | awk '{total += $1} END {print total + 0}')"
export TELEMETRY_HOME_TELEMETRY_CAP_BYTES="$home_telemetry_archive_bytes"
export TELEMETRY_HOME_TELEMETRY_WARNING_BYTES="$((home_telemetry_archive_bytes - 1))"
expect_failure telemetry-home-cap bash "$home_pull"
grep -Fq 'home telemetry archive cap would be exceeded' \
  "$namespace/telemetry-home-cap.err"
[[ ! -e "$namespace/home/ash-atlas-telemetry/archive/2026/09/23/$home_telemetry_segment_id" ]]
[[ ! -e "$telemetry_namespace/acks/$home_telemetry_segment_id.ack.json" ]]
! grep -Fq "fetch $home_telemetry_artifact_name" "$TELEMETRY_TEST_SSH_LOG"
rm -f -- "$telemetry_namespace/exports/$home_telemetry_artifact_name" \
  "$telemetry_namespace/exports/$home_telemetry_checksum_name" \
  "$telemetry_namespace/exports/home-cap-incoming.ready.json"
unset TELEMETRY_HOME_TELEMETRY_CAP_BYTES TELEMETRY_HOME_TELEMETRY_WARNING_BYTES

# Both telemetry fetch streams are byte-bounded before verification.  An
# artifact that emits one byte over its declared size and a valid manifest
# padded beyond the manifest limit are rejected without acknowledgment.
# Leave enough aggregate room for these fixtures so each assertion reaches
# the corresponding stream-size guard instead of failing at the home cap.
export TELEMETRY_HOME_BACKUP_CAP_BYTES=5000000
export TELEMETRY_HOME_BACKUP_WARNING_BYTES=4000000
bounded_segment_id="$(cat /proc/sys/kernel/random/uuid)"
bounded_run_id="$(cat /proc/sys/kernel/random/uuid)"
bounded_artifact_name=bounded-artifact.duckdb
bounded_checksum_name=bounded-artifact.sha256
bounded_artifact="$telemetry_namespace/exports/$bounded_artifact_name"
printf 'AB' >"$bounded_artifact"
bounded_expected='A'
bounded_expected_bytes="${#bounded_expected}"
bounded_expected_sha="$(printf '%s' "$bounded_expected" | sha256sum | awk '{print $1}')"
printf '%s  %s\n' "$bounded_expected_sha" "$bounded_artifact_name" \
  >"$telemetry_namespace/exports/$bounded_checksum_name"
jq -cn --arg segmentId "$bounded_segment_id" --arg runId "$bounded_run_id" \
  --arg artifact "$bounded_artifact_name" --arg checksum "$bounded_checksum_name" \
  --arg sha "$bounded_expected_sha" --argjson bytes "$bounded_expected_bytes" '
    {manifestVersion:1,segmentId:$segmentId,runId:$runId,
     segmentStartAt:"2026-09-23T00:10:00Z",segmentEndAt:"2026-09-23T00:15:00Z",
     releaseSha:("b" * 40),releaseGeneration:"test/t1252",
     worldReleaseId:"test-world",populationPlanVersion:"1",
     populationSpawnRulesVersion:"1",balanceVersion:"1",
     artifact:{fileName:$artifact,checksumFileName:$checksum,format:"duckdb",
               bytes:$bytes,sha256:$sha},tableRowCounts:{},
     acknowledgmentState:"unacknowledged"}' \
  >"$telemetry_namespace/exports/bounded-artifact.ready.json"
expect_failure telemetry-artifact-overflow bash "$home_pull"
[[ ! -e "$telemetry_namespace/acks/$bounded_segment_id.ack.json" ]]
! grep -Fq "ack bounded-artifact.ready.json" "$TELEMETRY_TEST_SSH_LOG"
rm -f -- "$telemetry_namespace/exports/$bounded_artifact_name" \
  "$telemetry_namespace/exports/$bounded_checksum_name" \
  "$telemetry_namespace/exports/bounded-artifact.ready.json"

manifest_segment_id="$(cat /proc/sys/kernel/random/uuid)"
manifest_run_id="$(cat /proc/sys/kernel/random/uuid)"
manifest_artifact_name=bounded-manifest.duckdb
manifest_checksum_name=bounded-manifest.sha256
manifest_artifact="$telemetry_namespace/exports/$manifest_artifact_name"
printf 'A' >"$manifest_artifact"
manifest_sha="$(sha256sum "$manifest_artifact" | awk '{print $1}')"
printf '%s  %s\n' "$manifest_sha" "$manifest_artifact_name" \
  >"$telemetry_namespace/exports/$manifest_checksum_name"
jq -cn --arg segmentId "$manifest_segment_id" --arg runId "$manifest_run_id" \
  --arg artifact "$manifest_artifact_name" --arg checksum "$manifest_checksum_name" \
  --arg sha "$manifest_sha" '
    {manifestVersion:1,segmentId:$segmentId,runId:$runId,
     segmentStartAt:"2026-09-23T00:20:00Z",segmentEndAt:"2026-09-23T00:25:00Z",
     releaseSha:("c" * 40),releaseGeneration:"test/t1252",
     worldReleaseId:"test-world",populationPlanVersion:"1",
     populationSpawnRulesVersion:"1",balanceVersion:"1",
     artifact:{fileName:$artifact,checksumFileName:$checksum,format:"duckdb",
               bytes:1,sha256:$sha},tableRowCounts:{},
     acknowledgmentState:"unacknowledged"}' \
  >"$telemetry_namespace/exports/bounded-manifest.ready.json"
python3 - "$telemetry_namespace/exports/bounded-manifest.ready.json" <<'PY'
import json
import os
import sys

path = sys.argv[1]
with open(path, "r", encoding="utf-8") as handle:
    value = json.load(handle)
value["padding"] = "x" * 1_050_000
with open(path, "w", encoding="utf-8") as handle:
    json.dump(value, handle, separators=(",", ":"))
PY
expect_failure telemetry-manifest-overflow bash "$home_pull"
[[ ! -e "$telemetry_namespace/acks/$manifest_segment_id.ack.json" ]]
! grep -Fq "ack bounded-manifest.ready.json" "$TELEMETRY_TEST_SSH_LOG"
rm -f -- "$telemetry_namespace/exports/$manifest_artifact_name" \
  "$telemetry_namespace/exports/$manifest_checksum_name" \
  "$telemetry_namespace/exports/bounded-manifest.ready.json"
export TELEMETRY_HOME_BACKUP_CAP_BYTES=500000
export TELEMETRY_HOME_BACKUP_WARNING_BYTES=400000

# The bounded proof command selects the oldest unproved retained backup,
# reads only its Seagate dump, and publishes the same accepted proof consumed
# by retention. A second run skips the immutable proof without rereading it.
before_prove_restore_count="$(wc -l <"$DATABASE_TEST_PG_RESTORE_LOG")"
before_prove_seagate_restore_count="$(grep -Fc "$portable_dump" \
  "$DATABASE_TEST_PG_RESTORE_LOG" || true)"
prover_output="$namespace/prover-oldest.out"
bash "$prover" --unproved 1 >"$prover_output"
grep -Fq "backupId=$backup_id result=proved" "$prover_output"
grep -Fq 'bytesRead=' "$prover_output"
[[ -f "$ASH_ATLAS_DATABASE_SEAGATE_ACK_ROOT/$backup_id.seagate.ack.json" ]]
after_prove_restore_count="$(wc -l <"$DATABASE_TEST_PG_RESTORE_LOG")"
(( after_prove_restore_count == before_prove_restore_count ))
after_prove_seagate_restore_count="$(grep -Fc "$portable_dump" \
  "$DATABASE_TEST_PG_RESTORE_LOG" || true)"
(( after_prove_seagate_restore_count == before_prove_seagate_restore_count ))
# A durable proof with a changed immutable checksum is not an idempotent skip;
# it must fail closed before selection can treat the backup as proved.
seagate_ack="$ASH_ATLAS_DATABASE_SEAGATE_ACK_ROOT/$backup_id.seagate.ack.json"
cp -- "$seagate_ack" "$namespace/seagate-ack.backup.json"
jq '.sha256 = ("0" * 64)' "$seagate_ack" >"$namespace/seagate-ack.tampered.json"
mv -- "$namespace/seagate-ack.tampered.json" "$seagate_ack"
expect_failure targeted-proof-mismatch bash "$prover" --unproved 1
mv -- "$namespace/seagate-ack.backup.json" "$seagate_ack"
health_after_proof="$(SSH_ORIGINAL_COMMAND=database-health \
  bash "$TELEMETRY_TEST_FORCED_COMMAND")"
jq -e --argjson expected 1 '.currentlyEligibleCount == $expected' \
  <<<"$health_after_proof" >/dev/null
bash "$prover" --unproved 1 >"$namespace/prover-skip.out"
grep -Fq "No unproved selected PostgreSQL backups" "$namespace/prover-skip.out"
[[ "$(grep -Fc "$portable_dump" \
  "$DATABASE_TEST_PG_RESTORE_LOG")" == "$after_prove_seagate_restore_count" ]]

# Retention can win after the prover's cohort snapshot. A manifest fetch that
# disappears from a refreshed canonical retained list is deferred safely;
# this race is not reported as source corruption and is retried next cycle.
newest_backup_id="$(jq -r '.backupId' "$newest_manifest")"
race_pruned_root="$namespace/retention-race-pruned"
mkdir -p "$race_pruned_root"
export TELEMETRY_TEST_RETENTION_RACE_MANIFEST="$(basename "$newest_manifest")"
export TELEMETRY_TEST_RETENTION_RACE_BACKUP_ID="$newest_backup_id"
export TELEMETRY_TEST_RETENTION_RACE_PRUNED_ROOT="$race_pruned_root"
export TELEMETRY_TEST_RETENTION_RACE_MARKER="$namespace/retention-race-fired"
bash "$prover" --unproved 1 >"$namespace/prover-retention-race.out"
grep -Fq "manifest=$(basename "$newest_manifest") result=deferred reason=no-longer-retained" \
  "$namespace/prover-retention-race.out"
[[ ! -d "$ASH_ATLAS_DATABASE_BACKUP_READY_ROOT/backup-$newest_backup_id" ]]
mv -- "$race_pruned_root/backup-$newest_backup_id" \
  "$ASH_ATLAS_DATABASE_BACKUP_READY_ROOT/"
unset TELEMETRY_TEST_RETENTION_RACE_MANIFEST TELEMETRY_TEST_RETENTION_RACE_BACKUP_ID \
  TELEMETRY_TEST_RETENTION_RACE_PRUNED_ROOT TELEMETRY_TEST_RETENTION_RACE_MARKER
# A transient fetch failure for a still-retained manifest is retried once;
# an accepted proof then remains an idempotent skip without a dump reread.
export TELEMETRY_TEST_FETCH_RETRY_MANIFEST="$(basename "$manifest")"
export TELEMETRY_TEST_FETCH_RETRY_MARKER="$namespace/retained-fetch-retry-fired"
bash "$prover" --backup-id "$backup_id" >"$namespace/prover-retention-retry.out"
grep -Fq "backupId=$backup_id result=skipped bytesRead=0" \
  "$namespace/prover-retention-retry.out"
[[ "$(grep -Fc "$portable_dump" \
  "$DATABASE_TEST_PG_RESTORE_LOG")" == "$after_prove_seagate_restore_count" ]]
unset TELEMETRY_TEST_FETCH_RETRY_MANIFEST TELEMETRY_TEST_FETCH_RETRY_MARKER
# A fetch failure while the refreshed retained list still contains the item
# remains a hard failure; only canonical disappearance is safely deferred.
export TELEMETRY_TEST_FETCH_FAIL_MANIFEST="$(basename "$manifest")"
expect_failure retained-fetch-failure bash "$prover" --backup-id "$backup_id"
unset TELEMETRY_TEST_FETCH_FAIL_MANIFEST

# Directory mtimes and mutable index files are outside parity, but canonical
# archive file mtimes remain protected and must still fail closed.
home_archive="$namespace/home/ash-atlas-telemetry/archive/fixture/test.duckdb"
seagate_archive="$namespace/seagate/ash-atlas-telemetry/archive/fixture/test.duckdb"
touch -d '2001-01-01T00:00:00Z' "$seagate_archive"
expect_failure mirror-file-mtime bash "$mirror"
touch -r "$home_archive" "$seagate_archive"

# A backup published after the scrub's retained-list snapshot is deferred
# until the next pull/mirror/scrub cycle rather than treated as a missing
# receipt in the captured cohort.
ASH_ATLAS_DATABASE_BACKUP_CLASS=daily bash "$producer" >/dev/null
mapfile -t cohort_arrival_manifests < <(find "$ASH_ATLAS_DATABASE_BACKUP_READY_ROOT" \
  -mindepth 2 -maxdepth 2 -type f -name '*.dump.ready.json' \
  ! -name "$(basename "$manifest")" \
  ! -name "$(basename "$newest_manifest")")
[[ ${#cohort_arrival_manifests[@]} -eq 1 ]]
cohort_arrival_manifest="${cohort_arrival_manifests[0]}"
cohort_arrival_backup_id="$(jq -r '.backupId' "$cohort_arrival_manifest")"
cohort_arrival_dir="$(dirname "$cohort_arrival_manifest")"
cohort_arrival_staging_root="$namespace/cohort-arrival-ready"
mkdir -p "$cohort_arrival_staging_root"
mv -- "$cohort_arrival_dir" "$cohort_arrival_staging_root/"
export TELEMETRY_TEST_COHORT_ARRIVAL_DIR="$cohort_arrival_staging_root/$(basename "$cohort_arrival_dir")"
export TELEMETRY_TEST_COHORT_ARRIVAL_MARKER="$namespace/cohort-arrival-fired"

# After the accepted proof is captured, make the source genuinely absent from
# the VPS cohort and remove only the old intake copy.  The scrub below must
# retain and verify the mapped portable mirror without attempting an impossible
# status lookup or mutating the old receipt.
legacy_expired_vps_root="$namespace/legacy-expired-vps"
mkdir -p "$legacy_expired_vps_root"
mv -- "$ASH_ATLAS_DATABASE_BACKUP_READY_ROOT/backup-$legacy_backup_id" \
  "$legacy_expired_vps_root/"
rm -f -- "$legacy_source"

bash "$home_dir/ash-atlas-backup-scrub.sh" >"$namespace/scrub.out"
grep -q 'Rotating Seagate scrub:' "$namespace/scrub.out"
grep -Fxq 'independently rebuilt Seagate index' \
  "$namespace/seagate/ash-atlas-telemetry/bug-report-index/different.json"
[[ ! -e "$namespace/seagate/ash-atlas-telemetry/bug-report-index/home-only.json" ]]
[[ ! -f "$ASH_ATLAS_DATABASE_SEAGATE_ACK_ROOT/$cohort_arrival_backup_id.seagate.ack.json" ]]
grep -Fxq database-retained-list "$TELEMETRY_TEST_SSH_LOG"
grep -Fxq "database-seagate-ack $(basename "$manifest")" "$TELEMETRY_TEST_SSH_LOG"
if grep -Fxq "database-seagate-ack $stale_manifest_name" "$TELEMETRY_TEST_SSH_LOG"; then
  echo 'pruned PostgreSQL manifest unexpectedly received a Seagate acknowledgment' >&2
  exit 1
fi
# Restore the already-accepted manifest for the remaining VPS-retention
# assertions.  The preceding scrub covered the source-absent legacy case;
# restoring only this immutable ready directory does not restore its intake
# dump or alter the old receipt.
mv -- "$legacy_expired_vps_root/backup-$legacy_backup_id" \
  "$ASH_ATLAS_DATABASE_BACKUP_READY_ROOT/"

unset TELEMETRY_TEST_COHORT_ARRIVAL_DIR TELEMETRY_TEST_COHORT_ARRIVAL_MARKER
cohort_arrival_file="$(jq -r '.artifact.fileName' "$cohort_arrival_manifest")"
export TELEMETRY_TEST_OVERSIZE_DATABASE_FETCH="$cohort_arrival_file"
expect_failure oversize-database-fetch bash "$home_pull"
unset TELEMETRY_TEST_OVERSIZE_DATABASE_FETCH
bash "$home_pull" >"$namespace/cohort-arrival-pull.out"
bash "$mirror" >"$namespace/cohort-arrival-mirror.out"

# Targeted proof rejects a tampered Seagate dump, a manifest/receipt identity
# mismatch, a missing artifact or receipt, and a failed restore catalog before
# it can publish any proof. Each failure is repaired before the next case.
cohort_arrival_receipt="$ASH_ATLAS_DATABASE_BACKUP_REMOTE_DIRECTORY/receipts/$cohort_arrival_file.receipt.json"
cohort_arrival_seagate_dump="$namespace/seagate/ash-atlas-backup-archive/postgresql/backup-$cohort_arrival_backup_id/$(jq -er '.backupFileName' "$cohort_arrival_receipt")"
cp -- "$cohort_arrival_seagate_dump" "$namespace/cohort-arrival-original.dump"
sed 's/PostgreSQL/Tampered!!/' "$cohort_arrival_seagate_dump" >"$namespace/tampered-arrival.dump"
mv -- "$namespace/tampered-arrival.dump" "$cohort_arrival_seagate_dump"
expect_failure targeted-tamper bash "$prover" --backup-id "$cohort_arrival_backup_id"
[[ ! -f "$ASH_ATLAS_DATABASE_SEAGATE_ACK_ROOT/$cohort_arrival_backup_id.seagate.ack.json" ]]
cp -- "$namespace/cohort-arrival-original.dump" "$cohort_arrival_seagate_dump"

mv -- "$cohort_arrival_seagate_dump" "$namespace/missing-arrival.dump"
expect_failure targeted-missing-seagate bash "$prover" --backup-id "$cohort_arrival_backup_id"
mv -- "$namespace/missing-arrival.dump" "$cohort_arrival_seagate_dump"

mv -- "$cohort_arrival_receipt" "$namespace/missing-arrival.receipt.json"
expect_failure targeted-missing-receipt bash "$prover" --backup-id "$cohort_arrival_backup_id"
mv -- "$namespace/missing-arrival.receipt.json" "$cohort_arrival_receipt"

export DATABASE_TEST_RESTORE_FAIL=true
expect_failure targeted-restore-catalog bash -c '
  source "$1"
  ash_backup_verify_copy deep postgresql "$2" "$3" "$4" "$5" "$6" "$7" "$8"
' bash "$home_dir/ash-atlas-backup-common.sh" "$cohort_arrival_backup_id" "$cohort_arrival_seagate_dump" \
  "$(jq -r '.artifact.bytes' "$cohort_arrival_manifest")" "$(jq -r '.artifact.sha256' "$cohort_arrival_manifest")" \
  "$cohort_arrival_manifest" "$cohort_arrival_receipt" "$(dirname "$cohort_arrival_seagate_dump")/portable-receipt.json"
unset DATABASE_TEST_RESTORE_FAIL
# Moving/replacing the test payload invalidates its physical-copy record.
# Re-earn once; normal prove must never hide that mutation by doing a read.
bash -c '
  source "$1"
  ash_backup_verify_copy deep postgresql "$2" "$3" "$4" "$5" "$6" "$7" "$8" >/dev/null
' bash "$home_dir/ash-atlas-backup-common.sh" "$cohort_arrival_backup_id" "$cohort_arrival_seagate_dump" \
  "$(jq -r '.artifact.bytes' "$cohort_arrival_manifest")" "$(jq -r '.artifact.sha256' "$cohort_arrival_manifest")" \
  "$cohort_arrival_manifest" "$cohort_arrival_receipt" "$(dirname "$cohort_arrival_seagate_dump")/portable-receipt.json"

cp -- "$cohort_arrival_manifest" "$namespace/cohort-arrival-manifest.json"
jq '.artifact.sha256 = ("0" * 64)' "$cohort_arrival_manifest" \
  >"$namespace/cohort-arrival-manifest.mismatch.json"
mv -- "$namespace/cohort-arrival-manifest.mismatch.json" "$cohort_arrival_manifest"
expect_failure targeted-manifest-mismatch bash "$prover" --backup-id "$cohort_arrival_backup_id"
mv -- "$namespace/cohort-arrival-manifest.json" "$cohort_arrival_manifest"

# The already-over-limit hourly proof remains immediately visible as
# retention-eligible through the canonical health path after the arrival proof.
bash "$prover" --backup-id "$cohort_arrival_backup_id" >"$namespace/prover-arrival.out"
grep -Fq "backupId=$cohort_arrival_backup_id result=proved" "$namespace/prover-arrival.out"
health_after_arrival="$(SSH_ORIGINAL_COMMAND=database-health \
  bash "$TELEMETRY_TEST_FORCED_COMMAND")"
jq -e --argjson expected 1 '.currentlyEligibleCount == $expected' \
  <<<"$health_after_arrival" >/dev/null
bash "$home_dir/ash-atlas-backup-scrub.sh" >"$namespace/cohort-arrival-scrub.out"
grep -q 'Rotating Seagate scrub:' "$namespace/cohort-arrival-scrub.out"
[[ -f "$ASH_ATLAS_DATABASE_SEAGATE_ACK_ROOT/$cohort_arrival_backup_id.seagate.ack.json" ]]
mv -- "$ASH_ATLAS_DATABASE_BACKUP_READY_ROOT/backup-$cohort_arrival_backup_id" \
  "$namespace/cohort-arrival-complete"

# Retained inventory is fail-closed before acknowledgment when the home copy
# and its one receipt have not arrived yet.
ASH_ATLAS_DATABASE_BACKUP_CLASS=daily bash "$producer" >/dev/null
mapfile -t missing_manifests < <(find "$ASH_ATLAS_DATABASE_BACKUP_READY_ROOT" \
  -mindepth 2 -maxdepth 2 -type f -name '*.dump.ready.json' \
  ! -name "$(basename "$manifest")" \
  ! -name "$(basename "$newest_manifest")" \
  ! -name "$(basename "$cohort_arrival_manifest")")
[[ ${#missing_manifests[@]} -eq 1 ]]
bash "$home_dir/ash-atlas-backup-scrub.sh" >"$namespace/scrub-missing-retained.out"
missing_id="$(jq -r '.backupId' "${missing_manifests[0]}")"
[[ ! -e "$ASH_ATLAS_DATABASE_SEAGATE_ACK_ROOT/$missing_id.seagate.ack.json" ]]
mv -- "$(dirname "${missing_manifests[0]}")" "$namespace/missing-retained-ready"

verified_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
seagate_proof="$namespace/seagate-proof.json"
jq -cn \
  --arg sourceAcknowledgmentId "$(jq -r '.acknowledgmentId' "$receipt")" \
  --arg backupId "$backup_id" --arg backupClass hourly \
  --arg manifestFileName "$(basename "$manifest")" --arg backupFileName "$file_name" \
  --arg sha256 "$(jq -r '.artifact.sha256' "$manifest")" \
  --arg seagateUuid "$ASH_ATLAS_SEAGATE_PROOF_UUID" \
  --arg seagateVerifiedAtUtc "$verified_at" \
  --argjson bytes "$(jq -r '.artifact.bytes' "$manifest")" '
    {seagateAcknowledgmentVersion:1,
     event:"ash_atlas_postgresql_backup_seagate_verified",
     sourceAcknowledgmentId:$sourceAcknowledgmentId,backupId:$backupId,
     backupClass:$backupClass,manifestFileName:$manifestFileName,
     backupFileName:$backupFileName,bytes:$bytes,sha256:$sha256,
     seagateUuid:$seagateUuid,seagateVerifiedAtUtc:$seagateVerifiedAtUtc,
     verification:"sha256-deep",restoreCatalogVerified:true}' >"$seagate_proof"
seagate_ack="$ASH_ATLAS_DATABASE_SEAGATE_ACK_ROOT/$backup_id.seagate.ack.json"
[[ -f "$seagate_ack" ]]
jq -e --arg source "$(jq -r '.acknowledgmentId' "$receipt")" \
  --arg seagate "$TELEMETRY_SEAGATE_UUID" '
    .sourceAcknowledgmentId == $source and .seagateUuid == $seagate
    and .verification == "sha256-deep" and .restoreCatalogVerified == true' \
  "$seagate_ack" >/dev/null
# Re-proving on another scrub timestamp is idempotent, but changing identity is denied.
jq --arg time "$(date -u -d '+1 second' +%Y-%m-%dT%H:%M:%SZ)" \
  '.seagateVerifiedAtUtc=$time' "$seagate_proof" >"$namespace/seagate-reproof.json"
SSH_ORIGINAL_COMMAND="database-seagate-ack $(basename "$manifest")" \
  bash "$TELEMETRY_TEST_FORCED_COMMAND" <"$namespace/seagate-reproof.json"
jq '.seagateUuid="WRONG"' "$seagate_proof" >"$namespace/seagate-wrong.json"
expect_failure seagate-identity env \
  SSH_ORIGINAL_COMMAND="database-seagate-ack $(basename "$manifest")" \
  bash "$TELEMETRY_TEST_FORCED_COMMAND" <"$namespace/seagate-wrong.json"

# Re-running after acknowledgment is idempotent and does not redownload the
# released intake source; the canonical portable copy remains unchanged.
before_sha="$(sha256sum "$portable_dump")"
bash "$home_pull"
[[ "$(sha256sum "$portable_dump")" == "$before_sha" ]]
! grep -Fq "database-fetch $file_name" "$TELEMETRY_TEST_SSH_LOG"

# A producer-side catalog failure never publishes a ready backup.
export DATABASE_TEST_RESTORE_FAIL=true
expect_failure producer-catalog bash "$producer"
unset DATABASE_TEST_RESTORE_FAIL
[[ "$(find "$ASH_ATLAS_DATABASE_BACKUP_READY_ROOT" -mindepth 1 -maxdepth 1 -type d | wc -l)" == "2" ]]
[[ "$(find "$ASH_ATLAS_DATABASE_BACKUP_ROOT/rejected" -mindepth 1 -maxdepth 1 -type d | wc -l)" -ge 1 ]]

# Capacity includes both the safety floor and a conservative next-dump estimate.
export ASH_ATLAS_DATABASE_BACKUP_ESTIMATED_BYTES_FLOOR=999999999999999
expect_failure producer-capacity bash "$producer"
export ASH_ATLAS_DATABASE_BACKUP_ESTIMATED_BYTES_FLOOR=1

export ASH_ATLAS_DATABASE_BACKUP_TEST_DEVICE_SERIAL=WRONG-SERIAL
expect_failure producer-serial bash "$producer"
export ASH_ATLAS_DATABASE_BACKUP_TEST_DEVICE_SERIAL="$ASH_ATLAS_BACKUP_DEVICE_SERIAL"
export DATABASE_TEST_MOUNT_UUID=WRONG-UUID
expect_failure producer-uuid bash "$producer"
unset DATABASE_TEST_MOUNT_UUID

export TELEMETRY_TEST_DEVICE_SERIAL=WRONG-SEAGATE
expect_failure home-serial bash "$home_pull"
export TELEMETRY_TEST_DEVICE_SERIAL="$TELEMETRY_SEAGATE_SERIAL"

# Add canonical hourly entries before exercising local retirement.  The
# initial fixture intentionally keeps one current VPS item in the legacy flat
# layout.  We hide one additional canonical item from the captured VPS cohort
# during this test so the target has an unpinned peer beyond the tier keeper
# after newest-two safety pins, without weakening the normal positive rule.
ASH_ATLAS_DATABASE_BACKUP_CLASS=hourly bash "$producer" >/dev/null
bash "$home_pull" >/dev/null
bash "$mirror" >/dev/null
sleep 1
ASH_ATLAS_DATABASE_BACKUP_CLASS=hourly bash "$producer" >/dev/null
bash "$home_pull" >/dev/null
bash "$mirror" >/dev/null
sleep 1
ASH_ATLAS_DATABASE_BACKUP_CLASS=hourly bash "$producer" >/dev/null
bash "$home_pull" >/dev/null
bash "$mirror" >/dev/null

# Hide every hourly ID while leaving the daily cohort entry visible.  The
# first complete listing clears the prior live pins; on the second listing the
# two newest portable IDs remain safety pins and the oldest unpinned hourly
# ID is an actually eligible tier-retention removal.
retention_visible_manifest=''
retention_visible_created=''
while IFS= read -r candidate_manifest; do
  [[ "$(jq -r '.backupClass' "$candidate_manifest")" == hourly ]] || continue
  candidate_created="$(jq -r '.createdAtUtc' "$candidate_manifest")"
  if [[ -z "$retention_visible_manifest" ||
        "$candidate_created" > "$retention_visible_created" ]]; then
    retention_visible_manifest="$(basename "$candidate_manifest")"
    retention_visible_created="$candidate_created"
  fi
done < <(find "$ASH_ATLAS_DATABASE_BACKUP_READY_ROOT" -mindepth 2 -maxdepth 2 \
  -type f -name '*.dump.ready.json' | LC_ALL=C sort)
[[ -n "$retention_visible_manifest" ]]
retention_hidden_manifests=''
while IFS= read -r candidate_manifest; do
  [[ "$(jq -r '.backupClass' "$candidate_manifest")" == hourly ]] || continue
  candidate_name="$(basename "$candidate_manifest")"
  [[ "$candidate_name" != "$retention_visible_manifest" ]] || continue
  if [[ -n "$retention_hidden_manifests" ]]; then
    retention_hidden_manifests+=",$candidate_name"
  else
    retention_hidden_manifests="$candidate_name"
  fi
done < <(find "$ASH_ATLAS_DATABASE_BACKUP_READY_ROOT" -mindepth 2 -maxdepth 2 \
  -type f -name '*.dump.ready.json' | LC_ALL=C sort)
[[ -n "$retention_hidden_manifests" ]]

# A proof-qualified canonical backup outside the current VPS cohort is
# retained for one changed-listing cycle, then retired by exact ID with a
# durable tombstone.  This exercises the tier count, live-ID pin union, and
# crash-safe retirement path rather than only keeper preservation.  Remove its
# cached remote-acceptance evidence to exercise the explicit archive-only,
# locally-verified, remote-acceptance-unknown path.
rm -f -- "$namespace/home/.ash-atlas-seagate-proof-evidence/backup-$backup_id.accepted.json"
export TELEMETRY_PORTABLE_BACKUP_RETENTION_HOURLY=1
export TELEMETRY_TEST_HIDE_RETAINED_MANIFEST="$retention_hidden_manifests"
bash "$home_dir/ash-atlas-backup-scrub.sh" >"$namespace/retention-first.out"
[[ -d "$namespace/seagate/ash-atlas-backup-archive/postgresql/backup-$backup_id" ]]
bash "$home_dir/ash-atlas-backup-scrub.sh" >"$namespace/retention-second.out"
grep -Fq "portable retention removed backupId=$backup_id" \
  "$namespace/retention-second.out"
[[ ! -d "$namespace/seagate/ash-atlas-backup-archive/postgresql/backup-$backup_id" ]]
[[ -f "$namespace/seagate/ash-atlas-backup-archive/.retired/backup-$backup_id.json" ]]
[[ ! -e "$namespace/seagate/ash-atlas-backup-archive/.retirement/backup-$backup_id.intent.json" ]]
[[ ! -e "$local_dump" ]]
emergency_dump_count="$(find "$ASH_ATLAS_DATABASE_BACKUP_REMOTE_DIRECTORY/emergency" \
  -maxdepth 1 -type f -name '*.dump' -printf '.' | wc -c)"
[[ "$emergency_dump_count" == 2 ]]
bash "$home_dir/ash-atlas-backup-scrub.sh" >"$namespace/retention-third.out"
grep -q 'Rotating Seagate scrub:' "$namespace/retention-third.out"
# The source VPS cohort must also expire before a retired source receipt may
# be treated as a non-live tombstone on later scrubs.
expired_vps_root="$namespace/expired-vps-ready"
mkdir -p "$expired_vps_root"
mv -- "$ASH_ATLAS_DATABASE_BACKUP_READY_ROOT/backup-$backup_id" "$expired_vps_root/"
unset TELEMETRY_TEST_HIDE_RETAINED_MANIFEST TELEMETRY_PORTABLE_BACKUP_RETENTION_HOURLY

# Simulate a crash after the exact dump unlink but before retirement
# completion.  The next scrub must reconcile the durable intent before its
# normal archive verification and leave a tombstone; a subsequent scrub must
# still accept the source receipt as a validated non-live retirement, never as
# fresh portable proof.
sleep 1
ASH_ATLAS_DATABASE_BACKUP_CLASS=hourly bash "$producer" >/dev/null
mapfile -t interrupted_retention_manifests < <(
  find "$ASH_ATLAS_DATABASE_BACKUP_READY_ROOT" -mindepth 2 -maxdepth 2 \
    -type f -name '*.dump.ready.json'
)
[[ ${#interrupted_retention_manifests[@]} -ge 1 ]]
interrupted_retention_manifest=''
interrupted_retention_created=''
for candidate_manifest in "${interrupted_retention_manifests[@]}"; do
  candidate_created="$(jq -r '.createdAtUtc' "$candidate_manifest")"
  if [[ -z "$interrupted_retention_manifest" ||
        "$candidate_created" > "$interrupted_retention_created" ]]; then
    interrupted_retention_manifest="$candidate_manifest"
    interrupted_retention_created="$candidate_created"
  fi
done
interrupted_retention_id="$(jq -r '.backupId' "$interrupted_retention_manifest")"
interrupted_retention_file="$(jq -r '.artifact.fileName' "$interrupted_retention_manifest")"
bash "$home_pull" >/dev/null
bash "$mirror" >/dev/null
interrupted_retention_dir="$namespace/seagate/ash-atlas-backup-archive/postgresql/backup-$interrupted_retention_id"
interrupted_retention_manifest_copy="$interrupted_retention_dir/$(basename "$interrupted_retention_manifest")"
interrupted_retention_dump="$interrupted_retention_dir/$interrupted_retention_file"
interrupted_retention_source_receipt="$interrupted_retention_dir/source-receipt.json"
interrupted_retention_portable_receipt="$interrupted_retention_dir/portable-receipt.json"
mkdir -p "$namespace/seagate/ash-atlas-backup-archive/.retirement"
jq -cn \
  --arg id "$interrupted_retention_id" --arg class hourly \
  --arg directory "$interrupted_retention_dir" \
  --arg manifest "$interrupted_retention_manifest_copy" \
  --arg dump "$interrupted_retention_dump" \
  --arg file "$interrupted_retention_file" \
  --arg sha "$(jq -r '.artifact.sha256' "$interrupted_retention_manifest")" \
  --argjson bytes "$(jq -r '.artifact.bytes' "$interrupted_retention_manifest")" \
  --arg manifestSha "$(sha256sum "$interrupted_retention_manifest_copy" | awk '{print $1}')" \
  --arg sourceReceiptSha "$(sha256sum "$interrupted_retention_source_receipt" | awk '{print $1}')" \
  --arg portableReceiptSha "$(sha256sum "$interrupted_retention_portable_receipt" | awk '{print $1}')" \
  --arg startedAtUtc "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '
    {retirementIntentVersion:1,backupId:$id,backupClass:$class,
     directory:$directory,manifestPath:$manifest,dumpPath:$dump,
     backupFileName:$file,sha256:$sha,bytes:$bytes,
     manifestSha256:$manifestSha,sourceReceiptSha256:$sourceReceiptSha,
     portableReceiptSha256:$portableReceiptSha,startedAtUtc:$startedAtUtc}' \
  >"$namespace/seagate/ash-atlas-backup-archive/.retirement/backup-$interrupted_retention_id.intent.json"
# A durable intent must not override a current VPS-live pin.  The scrub
# rejects this anomaly before any archive entry is unlinked.
expect_failure live-retirement-intent bash "$home_dir/ash-atlas-backup-scrub.sh"
[[ -f "$interrupted_retention_dump" ]]
rm -- "$interrupted_retention_dump"
export TELEMETRY_PORTABLE_BACKUP_RETENTION_HOURLY=1
export TELEMETRY_TEST_HIDE_RETAINED_MANIFEST="$(basename "$interrupted_retention_manifest")"
bash "$home_dir/ash-atlas-backup-scrub.sh" >"$namespace/interrupted-retention-first.out"
bash "$home_dir/ash-atlas-backup-scrub.sh" >"$namespace/interrupted-retention-second.out"
[[ -f "$namespace/seagate/ash-atlas-backup-archive/.retired/backup-$interrupted_retention_id.json" ]]
[[ ! -e "$namespace/seagate/ash-atlas-backup-archive/.retirement/backup-$interrupted_retention_id.intent.json" ]]
bash "$home_dir/ash-atlas-backup-scrub.sh" >"$namespace/interrupted-retention-third.out"
grep -q 'Rotating Seagate scrub:' "$namespace/interrupted-retention-third.out"
unset TELEMETRY_TEST_HIDE_RETAINED_MANIFEST TELEMETRY_PORTABLE_BACKUP_RETENTION_HOURLY

# A portable final-rename interruption leaves a retryable spool and withholds
# the VPS acknowledgment; the next run commits that exact staged identity.
ASH_ATLAS_DATABASE_BACKUP_CLASS=daily bash "$producer" >/dev/null
mapfile -t interrupted_manifests < <(
  while IFS= read -r candidate_manifest; do
    candidate_id="$(jq -r '.backupId' "$candidate_manifest")"
    [[ ! -f "$ASH_ATLAS_DATABASE_BACKUP_ACK_ROOT/$candidate_id.ack.json" ]] || continue
    printf '%s\n' "$candidate_manifest"
  done < <(find "$ASH_ATLAS_DATABASE_BACKUP_READY_ROOT" \
    -mindepth 2 -maxdepth 2 -type f -name '*.dump.ready.json')
)
[[ ${#interrupted_manifests[@]} -eq 1 ]]
interrupted_manifest="${interrupted_manifests[0]}"
interrupted_id="$(jq -r '.backupId' "$interrupted_manifest")"
export DATABASE_TEST_PORTABLE_RENAME_FAIL=true
expect_failure portable-rename-interrupted bash "$home_pull"
unset DATABASE_TEST_PORTABLE_RENAME_FAIL
[[ ! -e "$ASH_ATLAS_DATABASE_BACKUP_ACK_ROOT/$interrupted_id.ack.json" ]]
[[ -d "$ASH_ATLAS_DATABASE_BACKUP_REMOTE_DIRECTORY/.spool/backup-$interrupted_id" ]]
bash "$home_pull" >/dev/null
[[ -f "$ASH_ATLAS_DATABASE_BACKUP_ACK_ROOT/$interrupted_id.ack.json" ]]
interrupted_file_name="$(jq -r '.artifact.fileName' "$interrupted_manifest")"
[[ -f "$ASH_ATLAS_DATABASE_BACKUP_REMOTE_DIRECTORY/emergency/$interrupted_file_name" ]]

# A bounded intake must continue rotating newly managed sources even after
# more sequential dump bytes have been produced than the aggregate cap.  Each
# source is released only after its portable commit and source acknowledgment;
# the emergency set and receipt metadata remain within the cap, and a retry
# does not redownload already released sources.
rotation_payload_bytes=40000
rotation_count=20
rotation_total_bytes=0
export DATABASE_TEST_PG_DUMP_PAYLOAD_BYTES="$rotation_payload_bytes"
for rotation_index in $(seq 1 "$rotation_count"); do
  ASH_ATLAS_DATABASE_BACKUP_CLASS=hourly bash "$producer" >/dev/null
  rotation_manifest=''
  while IFS= read -r candidate_manifest; do
    candidate_id="$(jq -r '.backupId' "$candidate_manifest")"
    [[ ! -f "$ASH_ATLAS_DATABASE_BACKUP_ACK_ROOT/$candidate_id.ack.json" ]] || continue
    rotation_manifest="$candidate_manifest"
    break
  done < <(find "$ASH_ATLAS_DATABASE_BACKUP_READY_ROOT" -mindepth 2 -maxdepth 2 \
    -type f -name '*.dump.ready.json' | LC_ALL=C sort)
  [[ -n "$rotation_manifest" ]]
  rotation_dump="$(dirname "$rotation_manifest")/$(jq -r '.artifact.fileName' "$rotation_manifest")"
  rotation_total_bytes=$((rotation_total_bytes + $(stat -c '%s' "$rotation_dump")))
  bash "$home_pull" >/dev/null
  bash "$mirror" >/dev/null
  home_usage_bytes="$(du -sb "$TELEMETRY_HOME_STORAGE_ROOT" | awk '{print $1}')"
  (( home_usage_bytes <= TELEMETRY_HOME_BACKUP_CAP_BYTES ))
done
[[ "$rotation_total_bytes" -gt "$TELEMETRY_HOME_BACKUP_CAP_BYTES" ]]
rotation_fetch_count="$(grep -c '^database-fetch .*\.dump$' "$TELEMETRY_TEST_SSH_LOG" || true)"
bash "$home_pull" >/dev/null
[[ "$(grep -c '^database-fetch .*\.dump$' "$TELEMETRY_TEST_SSH_LOG" || true)" == "$rotation_fetch_count" ]]
unset DATABASE_TEST_PG_DUMP_PAYLOAD_BYTES

# Already source-ACKed baseline history is still selectable for destination
# verification. Remove only this fixture's earned record, not its immutable copy.
# Restore normal policy after the earlier deliberate hourly=1 retirement cases;
# unverified baseline history inside the tier is expected to remain deferred.
export ASH_ATLAS_DATABASE_BACKUP_RETENTION_HOURLY=48
find "$ASH_ATLAS_DATABASE_BACKUP_READY_ROOT" -mindepth 2 -maxdepth 2 -type f -name '*.dump.ready.json' \
  -exec jq -c '.' '{}' \; >"$namespace/ack-baseline.jsonl"
jq -s '{baselineVersion:1,backups:.}' "$namespace/ack-baseline.jsonl" >"$namespace/ack-baseline.json"
chmod 0600 "$namespace/ack-baseline.json"
export TELEMETRY_BACKUP_CUTOVER_BASELINE="$namespace/ack-baseline.json"
while IFS= read -r acknowledged_manifest; do
  acknowledged_id="$(jq -r '.backupId' "$acknowledged_manifest")"
  acknowledged_file="$(jq -r '.artifact.fileName' "$acknowledged_manifest")"
  acknowledged_copy="$namespace/seagate/ash-atlas-backup-archive/postgresql/backup-$acknowledged_id/$acknowledged_file"
  acknowledged_record="$TELEMETRY_HOME_STORAGE_ROOT/.copy-verifications/$(printf '%s' "$acknowledged_copy" | sha256sum | awk '{print $1}').json"
  [[ -f "$ASH_ATLAS_DATABASE_BACKUP_ACK_ROOT/$acknowledged_id.ack.json" && -f "$acknowledged_copy" && -f "$acknowledged_record" ]] || continue
  break
done < <(find "$ASH_ATLAS_DATABASE_BACKUP_READY_ROOT" -mindepth 2 -maxdepth 2 -type f -name '*.dump.ready.json')
[[ -f "$acknowledged_copy" && -f "$acknowledged_record" ]]
rm "$acknowledged_record"
acknowledged_fetches="$(grep -Fxc "database-fetch $acknowledged_file" "$TELEMETRY_TEST_SSH_LOG" || true)"
ASH_ATLAS_DATABASE_BACKUP_ID="$acknowledged_id" bash "$home_pull" >/dev/null
[[ -f "$acknowledged_record" ]]
[[ "$(grep -Fxc "database-fetch $acknowledged_file" "$TELEMETRY_TEST_SSH_LOG" || true)" == "$acknowledged_fetches" ]]

# The VPS keeps the first source ACK and denies a different one. History ACKed
# by an older home system whose local receipt and copy are gone (for example
# after the cutover's NVMe cleanup) is downloaded again with a new receipt. It
# earns destination verification but must not re-send a conflicting source ACK.
acknowledged_manifest_name="$acknowledged_file.ready.json"
acknowledged_receipt="$ASH_ATLAS_DATABASE_BACKUP_REMOTE_DIRECTORY/receipts/$acknowledged_file.receipt.json"
[[ -f "$acknowledged_receipt" && -f "$ASH_ATLAS_DATABASE_BACKUP_ACK_ROOT/$acknowledged_id.ack.json" ]]
rm -f -- "$acknowledged_receipt" "$acknowledged_record" \
  "$ASH_ATLAS_DATABASE_BACKUP_REMOTE_DIRECTORY/$acknowledged_file" \
  "$TELEMETRY_HOME_STORAGE_ROOT/postgresql-emergency/$acknowledged_file"
rm -rf -- "$(dirname "$acknowledged_copy")" \
  "$ASH_ATLAS_DATABASE_BACKUP_REMOTE_DIRECTORY/.portable-mappings/backup-$acknowledged_id.json"
acknowledged_acks="$(grep -Fxc "database-ack $acknowledged_manifest_name" "$TELEMETRY_TEST_SSH_LOG" || true)"
acknowledged_fetches="$(grep -Fxc "database-fetch $acknowledged_file" "$TELEMETRY_TEST_SSH_LOG" || true)"
ASH_ATLAS_DATABASE_BACKUP_ID="$acknowledged_id" bash "$home_pull" >/dev/null
[[ -f "$acknowledged_copy" ]]
(( $(grep -Fxc "database-fetch $acknowledged_file" "$TELEMETRY_TEST_SSH_LOG" || true) > acknowledged_fetches ))
[[ "$(grep -Fxc "database-ack $acknowledged_manifest_name" "$TELEMETRY_TEST_SSH_LOG" || true)" == "$acknowledged_acks" ]]
unset TELEMETRY_BACKUP_CUTOVER_BASELINE

# A durable green commit followed by a lost source ACK is replayed by normal
# baseline selection. No payload slot/read or catalog recheck is needed.
ASH_ATLAS_DATABASE_BACKUP_CLASS=daily bash "$producer" >/dev/null
lost_ack_manifest=''
while IFS= read -r candidate; do
  candidate_id="$(jq -r '.backupId' "$candidate")"
  [[ ! -f "$ASH_ATLAS_DATABASE_BACKUP_ACK_ROOT/$candidate_id.ack.json" ]] || continue
  lost_ack_manifest="$candidate"; break
done < <(find "$ASH_ATLAS_DATABASE_BACKUP_READY_ROOT" -mindepth 2 -maxdepth 2 -type f -name '*.dump.ready.json')
[[ -n "$lost_ack_manifest" ]]
lost_ack_id="$(jq -r '.backupId' "$lost_ack_manifest")"
find "$ASH_ATLAS_DATABASE_BACKUP_READY_ROOT" -mindepth 2 -maxdepth 2 -type f -name '*.dump.ready.json' \
  -exec jq -c '.' '{}' \; >"$namespace/ack-baseline.jsonl"
jq -s '{baselineVersion:1,backups:.}' "$namespace/ack-baseline.jsonl" >"$namespace/ack-baseline.json"
chmod 0600 "$namespace/ack-baseline.json"
export TELEMETRY_BACKUP_CUTOVER_BASELINE="$namespace/ack-baseline.json"
export ASH_ATLAS_DATABASE_BACKUP_ID="$lost_ack_id" TELEMETRY_TEST_SOURCE_ACK_FAIL=true
expect_failure source-ack-interrupted bash "$home_pull"
unset TELEMETRY_TEST_SOURCE_ACK_FAIL ASH_ATLAS_DATABASE_BACKUP_ID
[[ ! -e "$ASH_ATLAS_DATABASE_BACKUP_ACK_ROOT/$lost_ack_id.ack.json" ]]
# Other admitted expiry IDs may read bytes; this already-green physical ID may not.
cat >"$namespace/bin/sha256sum" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
for argument in "$@"; do
  if [[ "$argument" == *.dump && "$argument" == *"${DATABASE_TEST_FORBID_PAYLOAD_ID:?}"* &&
        ( "$argument" == *"/home/"* || "$argument" == *"/seagate/"* ) ]]; then
    echo 'unexpected green payload checksum read' >&2; exit 91
  fi
done
exec /usr/bin/sha256sum "$@"
SH
chmod +x "$namespace/bin/sha256sum"
export DATABASE_TEST_FORBID_PAYLOAD_ID="$lost_ack_id"
before_ack_retry_catalog_count="$(grep -F "$lost_ack_id" "$DATABASE_TEST_PG_RESTORE_LOG" | grep -Ec '/(home|seagate)/' || true)"
bash "$home_pull" >"$namespace/ack-retry.out"
[[ -f "$ASH_ATLAS_DATABASE_BACKUP_ACK_ROOT/$lost_ack_id.ack.json" ]]
[[ "$(grep -F "$lost_ack_id" "$DATABASE_TEST_PG_RESTORE_LOG" | grep -Ec '/(home|seagate)/' || true)" == "$before_ack_retry_catalog_count" ]]
lost_ack_receipt="$ASH_ATLAS_DATABASE_BACKUP_REMOTE_DIRECTORY/receipts/$(jq -r '.artifact.fileName' "$lost_ack_manifest").receipt.json"
lost_ack_copy="$namespace/seagate/ash-atlas-backup-archive/postgresql/backup-$lost_ack_id/$(jq -r '.artifact.fileName' "$lost_ack_manifest")"
lost_ack_record="$TELEMETRY_HOME_STORAGE_ROOT/.copy-verifications/$(printf '%s' "$lost_ack_copy" | sha256sum | awk '{print $1}').json"
jq -e --slurpfile source "$lost_ack_receipt" '(.verifiedAtUtc|fromdateiso8601) >= ($source[0].remoteVerifiedAtUtc|fromdateiso8601)' \
  "$lost_ack_record" >/dev/null
unset TELEMETRY_BACKUP_CUTOVER_BASELINE
unset DATABASE_TEST_FORBID_PAYLOAD_ID

echo 'database backup pipeline tests passed'
