#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
vps_dir="$(cd -- "$script_dir/../release/vps" && pwd -P)"
namespace="$(mktemp -d /tmp/ash-atlas-reset-backup-test.XXXXXXXX)"
telemetry_namespace="$(mktemp -d /tmp/ash-atlas-telemetry-test.XXXXXXXX)"
trap 'rm -rf -- "$namespace" "$telemetry_namespace"' EXIT
mkdir -p "${namespace}/bin" "${telemetry_namespace}/exports" \
  "${telemetry_namespace}/acks" \
  "${namespace}/handoffs" "${namespace}/reset-acks" "${namespace}/mount" \
  "${namespace}/mount/ash-atlas/database-resets"
chmod 0750 "${namespace}/mount/ash-atlas/database-resets"

real_mv="$(command -v mv)"
cat >"${namespace}/bin/findmnt" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "${RESET_TEST_FINDMNT_JSON:?}"
SH
cat >"${namespace}/bin/mountpoint" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [[ -n "${RESET_TEST_MOUNT_LOSS_AFTER:-}" ]]; then
  count=0
  if [[ -f "${RESET_TEST_MOUNT_COUNT_FILE:?}" ]]; then
    count="$(cat "$RESET_TEST_MOUNT_COUNT_FILE")"
  fi
  count=$((count + 1))
  printf '%s\n' "$count" >"$RESET_TEST_MOUNT_COUNT_FILE"
  (( count <= RESET_TEST_MOUNT_LOSS_AFTER )) || exit 1
fi
[[ "${RESET_TEST_MOUNTED:-true}" == "true" ]]
SH
cat >"${namespace}/bin/duckdb" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
arguments=" $* "
if [[ "$arguments" == *" FROM test_runs"* ]]; then
  printf '%s\n' "${RESET_TEST_TELEMETRY_IDENTITY:?}"
elif [[ "$arguments" == *"SELECT count(*)"* ]]; then
  printf '0\n'
fi
SH
cat >"${namespace}/bin/pg_restore" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[[ "${RESET_TEST_RESTORE_FAIL:-false}" != "true" ]]
printf 'restore catalog fixture\n'
SH
cat >"${namespace}/bin/mv" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
destination="${!#}"
if [[ "${RESET_TEST_RENAME_FAIL:-false}" == "true" && "$destination" == *.dump ]]; then
  exit 1
fi
exec "$RESET_TEST_REAL_MV" "$@"
SH
cat >"${namespace}/bin/ssh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
arguments=" $* "
[[ "$arguments" == *" BatchMode=yes "* ]]
[[ "$arguments" == *" IdentitiesOnly=yes "* ]]
[[ "$arguments" == *" StrictHostKeyChecking=yes "* ]]
[[ "$arguments" == *" UserKnownHostsFile="* ]]
[[ "$arguments" == *" IdentityFile="* ]]
original="${!#}"
printf '%s\n' "$original" >>"${RESET_TEST_COMMAND_LOG:?}"
[[ "${RESET_TEST_BAD_HOST_IDENTITY:-false}" != "true" ]] || exit 255
if [[ -n "${RESET_TEST_TRUNCATE_FILE:-}" &&
      "$original" == "reset-fetch ${RESET_TEST_TRUNCATE_FILE}" ]]; then
  file="$(find "$ASH_ATLAS_RESET_BACKUP_HANDOFF_ROOT" -type f \
    -name "$RESET_TEST_TRUNCATE_FILE" -print -quit)"
  head -c 8 "$file"
  exit 42
fi
if [[ "$original" == reset-ack* &&
      "${RESET_TEST_DROP_ACK:-false}" == "true" ]]; then
  cat >/dev/null
  exit 255
fi
if [[ "$original" == reset-ack* &&
      "${RESET_TEST_MALFORM_ACK:-false}" == "true" ]]; then
  temporary="$(mktemp)"
  cat >"$temporary"
  jq '.sha256=("0"*64)' "$temporary" |
    SSH_ORIGINAL_COMMAND="$original" bash "$TELEMETRY_TEST_FORCED_COMMAND"
  code=$?
  rm -f -- "$temporary"
  exit "$code"
fi
SSH_ORIGINAL_COMMAND="$original" bash "$TELEMETRY_TEST_FORCED_COMMAND"
SH
chmod 0755 "${namespace}/bin/"*
touch "${namespace}/key" "${namespace}/known-hosts"

export PATH="${namespace}/bin:${PATH}"
export TELEMETRY_TEST_MODE=true
export TELEMETRY_TEST_FORCED_COMMAND="${vps_dir}/telemetry-pull-command.sh"
export TELEMETRY_EXPORT_ROOT="${telemetry_namespace}/exports"
export TELEMETRY_ACK_ROOT="${telemetry_namespace}/acks"
export ASH_ATLAS_RESET_BACKUP_HANDOFF_ROOT="${namespace}/handoffs"
export ASH_ATLAS_RESET_BACKUP_ACK_ROOT="${namespace}/reset-acks"
export TELEMETRY_VPS_HOST=test.invalid
export TELEMETRY_VPS_USER=ash-telemetry-pull
export TELEMETRY_SSH_KEY="${namespace}/key"
export TELEMETRY_KNOWN_HOSTS="${namespace}/known-hosts"
export TELEMETRY_SEAGATE_MOUNT="${namespace}/mount"
export TELEMETRY_SEAGATE_UUID=TEST-TMPFS
export TELEMETRY_SEAGATE_SERIAL=TEST-SERIAL
export TELEMETRY_SEAGATE_FSTYPE=tmpfs
export TELEMETRY_TEST_DEVICE_SERIAL=TEST-SERIAL
export ASH_ATLAS_BACKUP_TEST_DEVICE_SERIAL=TEST-SERIAL
TELEMETRY_ARCHIVE_OWNER="$(id -un):$(id -gn)"
export TELEMETRY_ARCHIVE_OWNER
export TELEMETRY_HOME_MINIMUM_FREE_BYTES=1
export TELEMETRY_HOME_PULL_LOCK="${namespace}/home.lock"
export ASH_ATLAS_BACKUP_COMMON="${script_dir}/ash-atlas-backup-common.sh"
export ASH_ATLAS_RESET_BACKUP_REMOTE_DIRECTORY="${namespace}/mount/ash-atlas/database-resets"
export ASH_ATLAS_RESET_BACKUP_RETENTION_COUNT=0
export TELEMETRY_BUG_REPORT_INDEX_ENABLED=false
export RESET_TEST_REAL_MV="$real_mv"
export RESET_TEST_COMMAND_LOG="${namespace}/commands.log"
export RESET_TEST_MOUNTED=true
RESET_TEST_FINDMNT_JSON="$(
  jq -cn --arg target "$TELEMETRY_SEAGATE_MOUNT" \
    --arg uuid "$TELEMETRY_SEAGATE_UUID" \
    '{filesystems:[{
      target:$target,source:"/dev/test-seagate",fstype:"tmpfs",uuid:$uuid,
      options:"rw,relatime",fsroot:"/"
    }]}'
)"
export RESET_TEST_FINDMNT_JSON
release_sha="$(printf 'a%.0s' {1..40})"

create_telemetry_fixture() {
  telemetry_run_id="00000000-0000-4000-8000-000000000801"
  telemetry_segment_id="00000000-0000-4000-8000-000000000802"
  telemetry_campaign_id="00000000-0000-4000-8000-000000000803"
  telemetry_artifact="combined-queue.duckdb"
  telemetry_checksum="${telemetry_artifact}.sha256"
  telemetry_manifest="${telemetry_artifact}.ready.json"
  printf 'DuckDB combined telemetry fixture\n' \
    >"${TELEMETRY_EXPORT_ROOT}/${telemetry_artifact}"
  telemetry_sha="$(
    sha256sum "${TELEMETRY_EXPORT_ROOT}/${telemetry_artifact}" | awk '{print $1}'
  )"
  telemetry_bytes="$(stat -c '%s' "${TELEMETRY_EXPORT_ROOT}/${telemetry_artifact}")"
  printf '%s  %s\n' "$telemetry_sha" "$telemetry_artifact" \
    >"${TELEMETRY_EXPORT_ROOT}/${telemetry_checksum}"
  jq -cn \
    --arg segmentId "$telemetry_segment_id" \
    --arg runId "$telemetry_run_id" \
    --arg campaignId "$telemetry_campaign_id" \
    --arg artifact "$telemetry_artifact" \
    --arg checksum "$telemetry_checksum" \
    --arg sha256 "$telemetry_sha" \
    --arg releaseSha "$release_sha" \
    --argjson bytes "$telemetry_bytes" \
    '{
      manifestVersion:1,
      segmentId:$segmentId,
      runId:$runId,
      campaignId:$campaignId,
      segmentStartAt:"2026-07-25T00:00:00Z",
      segmentEndAt:"2026-07-25T01:00:00Z",
      releaseSha:$releaseSha,
      releaseGeneration:"test/t214",
      worldReleaseId:"world-combined-test",
      populationPlanVersion:"population-combined-test",
      populationSpawnRulesVersion:"spawn-combined-test",
      balanceVersion:"balance-combined-test",
      artifact:{
        fileName:$artifact,
        checksumFileName:$checksum,
        format:"duckdb",
        bytes:$bytes,
        sha256:$sha256
      },
      tableRowCounts:{
        test_runs:0,
        bug_reports:0,
        bug_report_context:0
      },
      acknowledgmentState:"unacknowledged"
    }' >"${TELEMETRY_EXPORT_ROOT}/${telemetry_manifest}"
  RESET_TEST_TELEMETRY_IDENTITY="$(
    printf '%s|%s|%s|%s|test/t214|world-combined-test|population-combined-test|spawn-combined-test|balance-combined-test' \
      "$telemetry_run_id" "$telemetry_segment_id" "$telemetry_campaign_id" "$release_sha"
  )"
  export RESET_TEST_TELEMETRY_IDENTITY
}

clear_pending() {
  find "$ASH_ATLAS_RESET_BACKUP_HANDOFF_ROOT" -mindepth 1 -delete
  find "$ASH_ATLAS_RESET_BACKUP_ACK_ROOT" -mindepth 1 -delete
  unset RESET_TEST_TRUNCATE_FILE RESET_TEST_RESTORE_FAIL RESET_TEST_RENAME_FAIL \
    RESET_TEST_BAD_HOST_IDENTITY RESET_TEST_DROP_ACK RESET_TEST_MALFORM_ACK
}

create_fixture() {
  local sequence="$1"
  local checksum_mode="${2:-valid}"
  operation_id="$(printf '00000000-0000-4000-8000-%012d' "$sequence")"
  fixture_directory="${ASH_ATLAS_RESET_BACKUP_HANDOFF_ROOT}/reset-${operation_id}"
  mkdir -p "$fixture_directory"
  fixture_file="ash_atlas_game-gameplay-reset-20260726T$(printf '%06d' "$sequence")Z-${release_sha}-${operation_id}.dump"
  fixture_manifest="${fixture_file}.ready.json"
  printf 'PostgreSQL custom dump fixture %s\n' "$sequence" \
    >"${fixture_directory}/${fixture_file}"
  fixture_sha="$(sha256sum "${fixture_directory}/${fixture_file}" | awk '{print $1}')"
  fixture_bytes="$(stat -c '%s' "${fixture_directory}/${fixture_file}")"
  [[ "$checksum_mode" == "valid" ]] || fixture_sha="$(printf '0%.0s' {1..64})"
  jq -cn \
    --arg operationId "$operation_id" \
    --arg fileName "$fixture_file" \
    --arg sha256 "$fixture_sha" \
    --arg releaseSha "$release_sha" \
    --argjson bytes "$fixture_bytes" \
    '{
      manifestVersion:1,
      kind:"ash_atlas_gameplay_reset_backup",
      operationId:$operationId,
      database:"ash_atlas_game",
      releaseSha:$releaseSha,
      createdAtUtc:"2026-07-26T02:15:00Z",
      artifact:{fileName:$fileName,format:"postgresql-custom",bytes:$bytes,sha256:$sha256},
      acknowledgmentState:"pending"
    }' >"${fixture_directory}/${fixture_manifest}"
}

expect_failure() {
  local name="$1"
  if bash "${script_dir}/ash-atlas-telemetry-pull.sh" \
      >"${namespace}/${name}.out" 2>"${namespace}/${name}.err"; then
    echo "reset home-pull failure scenario succeeded: $name" >&2
    exit 1
  fi
}

create_telemetry_fixture
create_fixture 1
bash "${script_dir}/ash-atlas-telemetry-pull.sh"
first_file="$fixture_file"
[[ ! -e "${ASH_ATLAS_RESET_BACKUP_REMOTE_DIRECTORY}/${first_file}" ]]
[[ -f "${ASH_ATLAS_RESET_BACKUP_REMOTE_DIRECTORY}/emergency/${first_file}" ]]
[[ -f "${ASH_ATLAS_RESET_BACKUP_REMOTE_DIRECTORY}/receipts/${first_file}.receipt.json" ]]
[[ -f "${ASH_ATLAS_RESET_BACKUP_ACK_ROOT}/${operation_id}.ack.json" ]]
[[ -f "${TELEMETRY_ACK_ROOT}/${telemetry_segment_id}.ack.json" ]]
[[ -f "${TELEMETRY_SEAGATE_MOUNT}/ash-atlas-telemetry/archive/2026/07/25/${telemetry_segment_id}/${telemetry_artifact}" ]]
[[ "$(find "$ASH_ATLAS_RESET_BACKUP_ACK_ROOT" -maxdepth 1 -name '*.ack.json' | wc -l)" == "1" ]]
[[ "$(find "$TELEMETRY_ACK_ROOT" -maxdepth 1 -name '*.ack.json' | wc -l)" == "1" ]]
reset_ack_line="$(grep -n "^reset-ack " "$RESET_TEST_COMMAND_LOG" | head -n1 | cut -d: -f1)"
telemetry_ack_line="$(grep -n "^ack " "$RESET_TEST_COMMAND_LOG" | head -n1 | cut -d: -f1)"
(( reset_ack_line < telemetry_ack_line ))
pg_restore --list "${ASH_ATLAS_RESET_BACKUP_REMOTE_DIRECTORY}/emergency/${first_file}" >/dev/null

clear_pending
create_fixture 2
bash "${script_dir}/ash-atlas-telemetry-pull.sh"
[[ "$first_file" != "$fixture_file" ]]
[[ ! -e "${ASH_ATLAS_RESET_BACKUP_REMOTE_DIRECTORY}/${first_file}" ]]
[[ -f "${ASH_ATLAS_RESET_BACKUP_REMOTE_DIRECTORY}/emergency/${first_file}" ]]
[[ ! -e "${ASH_ATLAS_RESET_BACKUP_REMOTE_DIRECTORY}/${fixture_file}" ]]
[[ -f "${ASH_ATLAS_RESET_BACKUP_REMOTE_DIRECTORY}/emergency/${fixture_file}" ]]

clear_pending
create_fixture 3 bad-checksum
expect_failure checksum
[[ ! -e "${ASH_ATLAS_RESET_BACKUP_ACK_ROOT}/${operation_id}.ack.json" ]]

clear_pending
create_fixture 4
export RESET_TEST_TRUNCATE_FILE="$fixture_file"
expect_failure truncated
[[ ! -e "${ASH_ATLAS_RESET_BACKUP_ACK_ROOT}/${operation_id}.ack.json" ]]

clear_pending
create_fixture 5
export RESET_TEST_RESTORE_FAIL=true
expect_failure restore-catalog
[[ ! -e "${ASH_ATLAS_RESET_BACKUP_ACK_ROOT}/${operation_id}.ack.json" ]]

clear_pending
create_fixture 6
export RESET_TEST_RENAME_FAIL=true
expect_failure atomic-rename
[[ ! -e "${ASH_ATLAS_RESET_BACKUP_ACK_ROOT}/${operation_id}.ack.json" ]]

clear_pending
create_fixture 7
export RESET_TEST_DROP_ACK=true
expect_failure missing-ack
[[ ! -e "${ASH_ATLAS_RESET_BACKUP_ACK_ROOT}/${operation_id}.ack.json" ]]
unset RESET_TEST_DROP_ACK
# Retry the same immutable operation after its portable commit already exists.
# The commit helper must return the absolute archive path so the existing
# mapping is accepted, then release only the exact source intake copy after
# the retry acknowledgment.
bash "${script_dir}/ash-atlas-telemetry-pull.sh"
[[ -f "${ASH_ATLAS_RESET_BACKUP_ACK_ROOT}/${operation_id}.ack.json" ]]
[[ ! -e "${ASH_ATLAS_RESET_BACKUP_REMOTE_DIRECTORY}/${fixture_file}" ]]
[[ -f "${ASH_ATLAS_RESET_BACKUP_REMOTE_DIRECTORY}/emergency/${fixture_file}" ]]
retry_portable_path="$(jq -er '.portablePath' \
  "${ASH_ATLAS_RESET_BACKUP_REMOTE_DIRECTORY}/.portable-mappings/backup-${operation_id}.json")"
[[ "$retry_portable_path" == \
  "${TELEMETRY_SEAGATE_MOUNT}/ash-atlas-backup-archive/reset/operation-${operation_id}/${fixture_file}" ]]

clear_pending
create_fixture 8
export RESET_TEST_MALFORM_ACK=true
expect_failure malformed-ack
[[ ! -e "${ASH_ATLAS_RESET_BACKUP_ACK_ROOT}/${operation_id}.ack.json" ]]
rm -f -- "${ASH_ATLAS_RESET_BACKUP_REMOTE_DIRECTORY}/${fixture_file}" \
  "${ASH_ATLAS_RESET_BACKUP_REMOTE_DIRECTORY}/receipts/${fixture_file}.receipt.json"

clear_pending
create_fixture 9
export RESET_TEST_BAD_HOST_IDENTITY=true
expect_failure host-identity
[[ ! -e "${ASH_ATLAS_RESET_BACKUP_ACK_ROOT}/${operation_id}.ack.json" ]]

clear_pending
create_fixture 10
export RESET_TEST_MOUNTED=false
expect_failure unmounted
export RESET_TEST_MOUNTED=true

clear_pending
create_fixture 11
# Let preflight complete, then make the portable identity disappear during
# the commit helper's post-cd recheck.  The staged dump must remain unacked and
# retry successfully once the mount is restored.
export RESET_TEST_MOUNT_LOSS_AFTER=6
export RESET_TEST_MOUNT_COUNT_FILE="$namespace/mountpoint-count"
expect_failure mount-lost-after-preflight
[[ ! -e "${ASH_ATLAS_RESET_BACKUP_ACK_ROOT}/${operation_id}.ack.json" ]]
unset RESET_TEST_MOUNT_LOSS_AFTER RESET_TEST_MOUNT_COUNT_FILE
bash "${script_dir}/ash-atlas-telemetry-pull.sh"
[[ -f "${ASH_ATLAS_RESET_BACKUP_ACK_ROOT}/${operation_id}.ack.json" ]]

original_destination="$ASH_ATLAS_RESET_BACKUP_REMOTE_DIRECTORY"
export ASH_ATLAS_RESET_BACKUP_REMOTE_DIRECTORY="${namespace}/root-filesystem-destination"
mkdir -p "$ASH_ATLAS_RESET_BACKUP_REMOTE_DIRECTORY"
expect_failure root-filesystem-destination
export ASH_ATLAS_RESET_BACKUP_REMOTE_DIRECTORY="$original_destination"

export TELEMETRY_HOME_MINIMUM_FREE_BYTES=999999999999999
expect_failure insufficient-space
export TELEMETRY_HOME_MINIMUM_FREE_BYTES=1

export ASH_ATLAS_RESET_BACKUP_REMOTE_DIRECTORY="${original_destination}/../escaped"
expect_failure traversal
export ASH_ATLAS_RESET_BACKUP_REMOTE_DIRECTORY="${original_destination} bad"
expect_failure whitespace
export ASH_ATLAS_RESET_BACKUP_REMOTE_DIRECTORY="${original_destination}/absent"
expect_failure absent
export ASH_ATLAS_RESET_BACKUP_REMOTE_DIRECTORY="$original_destination"

if grep -R -E 'postgresql://|password=' "$namespace" >/dev/null; then
  echo "secret-like database credentials leaked into reset transfer logs" >&2
  exit 1
fi
echo "home reset-backup pull tests passed"
