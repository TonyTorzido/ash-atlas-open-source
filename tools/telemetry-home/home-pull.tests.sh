#!/usr/bin/env bash
set -euo pipefail

[[ $EUID -eq 0 ]] || {
  echo "home pull tests require root for an isolated tmpfs mount" >&2
  exit 1
}
for command in duckdb jq mount umount; do
  command -v "$command" >/dev/null || {
    echo "home pull tests require $command" >&2
    exit 1
  }
done

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
vps_dir="$(cd -- "$script_dir/../release/vps" && pwd -P)"
root="$(mktemp -d /tmp/ash-atlas-telemetry-test.XXXXXXXX)"
real_findmnt="$(command -v findmnt)"
real_mountpoint="$(command -v mountpoint)"
mounted=false
cleanup() {
  if [[ "$mounted" == "true" ]]; then umount "${root}/seagate"; fi
  rm -rf -- "$root"
}
trap cleanup EXIT
mkdir -p "${root}/exports" "${root}/acks" "${root}/seagate" "${root}/bin"
chmod 0730 "${root}/acks"
mount -t tmpfs -o size=64m ash-atlas-telemetry-test "${root}/seagate"
mounted=true

segment_id="00000000-0000-4000-8000-000000000101"
run_id="00000000-0000-4000-8000-000000000102"
campaign_id="00000000-0000-4000-8000-000000000103"
artifact="run-${run_id}.duckdb"
checksum="${artifact}.sha256"
manifest="${artifact}.ready.json"
database="${root}/exports/${artifact}"
duckdb "$database" <<SQL
CREATE TABLE test_runs (
  run_id UUID,
  segment_id UUID,
  campaign_id UUID,
  release_sha VARCHAR,
  release_generation VARCHAR,
  world_release_id VARCHAR,
  population_plan_version VARCHAR,
  population_spawn_rules_version VARCHAR,
  balance_version VARCHAR
);
INSERT INTO test_runs VALUES (
  '${run_id}', '${segment_id}', '${campaign_id}', repeat('a',40),
  'test/t182','world-test','population-test','spawn-test','balance-test'
);
CREATE TABLE server_samples(value INTEGER);
CREATE TABLE world_samples(value INTEGER);
CREATE TABLE gameplay_events(value INTEGER);
CREATE TABLE player_snapshots(value INTEGER);
CREATE TABLE player_inventory_snapshots(value INTEGER);
CREATE TABLE client_samples(value INTEGER);
CREATE TABLE session_summaries(value INTEGER);
CREATE TABLE authoritative_progression_events(value INTEGER);
CREATE TABLE authoritative_inventory_events(value INTEGER);
CREATE TABLE authoritative_wallet_events(value INTEGER);
CREATE TABLE authoritative_market_trades(value INTEGER);
CREATE TABLE authoritative_combat_summaries(value INTEGER);
CREATE TABLE telemetry_health(value INTEGER);
CREATE TABLE export_manifest(value INTEGER);
INSERT INTO export_manifest VALUES (1);
CHECKPOINT;
SQL
sha="$(sha256sum "$database" | awk '{print $1}')"
bytes="$(stat -c '%s' "$database")"
printf '%s  %s\n' "$sha" "$artifact" >"${root}/exports/${checksum}"
jq -cn \
  --arg segment "$segment_id" \
  --arg run "$run_id" \
  --arg campaign "$campaign_id" \
  --arg artifact "$artifact" \
  --arg checksum "$checksum" \
  --arg sha "$sha" \
  --argjson bytes "$bytes" \
  '{
    manifestVersion:1,
    segmentId:$segment,
    runId:$run,
    campaignId:$campaign,
    segmentStartAt:"2026-07-25T00:00:00Z",
    segmentEndAt:"2026-07-25T01:00:00Z",
    releaseSha:("a"*40),
    releaseGeneration:"test/t182",
    worldReleaseId:"world-test",
    populationPlanVersion:"population-test",
    populationSpawnRulesVersion:"spawn-test",
    balanceVersion:"balance-test",
    artifact:{fileName:$artifact,checksumFileName:$checksum,format:"duckdb",
      bytes:$bytes,sha256:$sha},
    tableRowCounts:{
      test_runs:1,server_samples:0,world_samples:0,gameplay_events:0,
      player_snapshots:0,player_inventory_snapshots:0,client_samples:0,
      session_summaries:0,authoritative_progression_events:0,
      authoritative_inventory_events:0,authoritative_wallet_events:0,
      authoritative_market_trades:0,authoritative_combat_summaries:0,
      telemetry_health:0,export_manifest:1
    },
    createdAt:"2026-07-25T01:00:05Z",
    verifiedAt:"2026-07-25T01:00:05Z",
    exporterVersion:"test",
    pseudonymizationKeyId:"test-v1",
    acknowledgmentState:"unacknowledged"
  }' >"${root}/exports/${manifest}"

cat >"${root}/bin/ssh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
original="${!#}"
: "${TELEMETRY_TEST_FORCED_COMMAND:?}"
if [[ "${TELEMETRY_TEST_OFFLINE:-false}" == "true" ]]; then exit 255; fi
if [[ "${TELEMETRY_TEST_EMPTY_LIST:-false}" == "true" &&
      "$original" == "list" ]]; then
  exit 0
fi
if [[ -n "${TELEMETRY_TEST_INTERRUPT_NAME:-}" &&
      "$original" == "fetch ${TELEMETRY_TEST_INTERRUPT_NAME}" ]]; then
  head -c 8 "${TELEMETRY_EXPORT_ROOT}/${TELEMETRY_TEST_INTERRUPT_NAME}"
  exit 42
fi
SSH_ORIGINAL_COMMAND="$original" bash "$TELEMETRY_TEST_FORCED_COMMAND"
SH
chmod 0755 "${root}/bin/ssh"
cat >"${root}/bin/findmnt" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [[ -n "${TELEMETRY_TEST_FINDMNT_JSON:-}" ]]; then
  printf '%s\n' "$TELEMETRY_TEST_FINDMNT_JSON"
  exit 0
fi
exec "$TELEMETRY_TEST_REAL_FINDMNT" "$@"
SH
cat >"${root}/bin/mountpoint" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${TELEMETRY_TEST_MOUNTPOINT_OK:-false}" == "true" ]]; then exit 0; fi
exec "$TELEMETRY_TEST_REAL_MOUNTPOINT" "$@"
SH
chmod 0755 "${root}/bin/findmnt" "${root}/bin/mountpoint"
touch "${root}/key" "${root}/known-hosts"

export PATH="${root}/bin:${PATH}"
export TELEMETRY_TEST_MODE=true
export TELEMETRY_TEST_FORCED_COMMAND="${vps_dir}/telemetry-pull-command.sh"
export TELEMETRY_EXPORT_ROOT="${root}/exports"
export TELEMETRY_ACK_ROOT="${root}/acks"
export TELEMETRY_VPS_HOST="test.invalid"
export TELEMETRY_VPS_USER="ash-telemetry-pull"
export TELEMETRY_SSH_KEY="${root}/key"
export TELEMETRY_KNOWN_HOSTS="${root}/known-hosts"
export TELEMETRY_SEAGATE_MOUNT="${root}/seagate"
export TELEMETRY_SEAGATE_UUID="TEST-TMPFS"
export TELEMETRY_SEAGATE_SERIAL="TEST-SERIAL"
export TELEMETRY_TEST_DEVICE_SERIAL="TEST-SERIAL"
export TELEMETRY_ARCHIVE_OWNER="root:root"
export TELEMETRY_HOME_MINIMUM_FREE_BYTES=1
export TELEMETRY_BUG_REPORT_INDEX_ENABLED=false
export TELEMETRY_TEST_REAL_FINDMNT="$real_findmnt"
export TELEMETRY_TEST_REAL_MOUNTPOINT="$real_mountpoint"

mount_validation_count=0
expect_mount_success() {
  local name="$1"
  local snapshot="$2"
  export TELEMETRY_TEST_FINDMNT_JSON="$snapshot"
  if ! bash "${script_dir}/ash-atlas-telemetry-pull.sh" >/dev/null 2>&1; then
    echo "valid mount scenario failed: $name" >&2
    exit 1
  fi
  ((mount_validation_count += 1))
}
expect_mount_failure() {
  local name="$1"
  local snapshot="$2"
  export TELEMETRY_TEST_FINDMNT_JSON="$snapshot"
  if bash "${script_dir}/ash-atlas-telemetry-pull.sh" >/dev/null 2>&1; then
    echo "invalid mount scenario succeeded: $name" >&2
    exit 1
  fi
  ((mount_validation_count += 1))
}
mount_row() {
  local target="$1"
  local fstype="$2"
  local uuid="$3"
  local options="$4"
  local fsroot="${5:-/}"
  jq -cn --arg target "$target" --arg fstype "$fstype" --arg uuid "$uuid" \
    --arg options "$options" --arg fsroot "$fsroot" \
    '{target:$target,fstype:$fstype,uuid:$uuid,options:$options,fsroot:$fsroot}'
}
mount_snapshot() {
  jq -cn --args '$ARGS.positional | map(fromjson) | {filesystems:.}' -- "$@"
}

export TELEMETRY_TEST_MOUNTPOINT_OK=true
export TELEMETRY_TEST_EMPTY_LIST=true
export TELEMETRY_SEAGATE_UUID="0000AAAA1111BBBB"
autofs_row="$(mount_row "$TELEMETRY_SEAGATE_MOUNT" autofs "" "rw,relatime")"
ntfs_row="$(mount_row "$TELEMETRY_SEAGATE_MOUNT" ntfs3 \
  "$TELEMETRY_SEAGATE_UUID" "rw,relatime")"
expect_mount_success "Debian 13 autofs plus ntfs3" \
  "$(mount_snapshot "$autofs_row" "$ntfs_row")"
expect_mount_success "ntfs3 only" "$(mount_snapshot "$ntfs_row")"

# The internal intake may be a directory below its filesystem mount. The
# Seagate identity is intentionally nonsense here: the pull must not inspect
# or depend on the removable mirror once staging is configured.
mkdir -p "${root}/seagate/intake"
export TELEMETRY_HOME_STORAGE_ROOT="${root}/seagate/intake"
export TELEMETRY_HOME_STORAGE_MOUNT="$TELEMETRY_SEAGATE_MOUNT"
export TELEMETRY_HOME_STORAGE_UUID="$TELEMETRY_SEAGATE_UUID"
export TELEMETRY_HOME_STORAGE_SERIAL="$TELEMETRY_SEAGATE_SERIAL"
export TELEMETRY_HOME_STORAGE_FSTYPE=ntfs3
export TELEMETRY_SEAGATE_UUID=DO-NOT-INSPECT
expect_mount_success "staged intake is independent of Seagate mirror identity" \
  "$(mount_snapshot "$ntfs_row")"
unset TELEMETRY_HOME_STORAGE_ROOT TELEMETRY_HOME_STORAGE_MOUNT \
  TELEMETRY_HOME_STORAGE_UUID TELEMETRY_HOME_STORAGE_SERIAL \
  TELEMETRY_HOME_STORAGE_FSTYPE
export TELEMETRY_SEAGATE_UUID=0000AAAA1111BBBB

expect_mount_failure "autofs without backing mount" "$(mount_snapshot "$autofs_row")"
expect_mount_failure "wrong UUID" \
  "$(mount_snapshot "$(mount_row "$TELEMETRY_SEAGATE_MOUNT" ntfs3 WRONG rw)")"
export TELEMETRY_TEST_DEVICE_SERIAL="WRONG-SERIAL"
expect_mount_failure "wrong device serial" "$(mount_snapshot "$ntfs_row")"
export TELEMETRY_TEST_DEVICE_SERIAL="$TELEMETRY_SEAGATE_SERIAL"
expect_mount_failure "multiple real backing mounts" \
  "$(mount_snapshot "$ntfs_row" "$ntfs_row")"
expect_mount_failure "read-only backing mount" \
  "$(mount_snapshot "$(mount_row "$TELEMETRY_SEAGATE_MOUNT" ntfs3 \
    "$TELEMETRY_SEAGATE_UUID" "ro,relatime")")"
expect_mount_failure "configured path below mount root" \
  "$(mount_snapshot "$(mount_row "$(dirname "$TELEMETRY_SEAGATE_MOUNT")" ntfs3 \
    "$TELEMETRY_SEAGATE_UUID" "rw,relatime")")"
expect_mount_failure "malformed findmnt JSON" '{not-json'
expect_mount_failure "multiline mount value" \
  "$(mount_snapshot "$(mount_row "${TELEMETRY_SEAGATE_MOUNT}"$'\nchild' ntfs3 \
    "$TELEMETRY_SEAGATE_UUID" "rw,relatime")")"
expect_mount_failure "overlay masquerade" \
  "$(mount_snapshot "$(mount_row "$TELEMETRY_SEAGATE_MOUNT" overlay \
    "$TELEMETRY_SEAGATE_UUID" "rw,relatime")")"
expect_mount_failure "bind mount" \
  "$(mount_snapshot "$(mount_row "$TELEMETRY_SEAGATE_MOUNT" ntfs3 \
    "$TELEMETRY_SEAGATE_UUID" "rw,relatime,bind" "/telemetry")")"
expect_mount_failure "unrelated filesystem" \
  "$(mount_snapshot "$(mount_row "$TELEMETRY_SEAGATE_MOUNT" ext4 \
    "$TELEMETRY_SEAGATE_UUID" "rw,relatime")")"
expect_mount_failure "zero rows" '{"filesystems":[]}'
unset TELEMETRY_TEST_FINDMNT_JSON TELEMETRY_TEST_MOUNTPOINT_OK \
  TELEMETRY_TEST_EMPTY_LIST
export TELEMETRY_SEAGATE_UUID="TEST-TMPFS"

# Fail before connecting when the local archive cannot satisfy its space
# reservation, and surface an offline VPS list attempt as a retryable failure.
export TELEMETRY_HOME_MINIMUM_FREE_BYTES=999999999999999
if bash "${script_dir}/ash-atlas-telemetry-pull.sh" >/dev/null 2>&1; then
  echo "pull ignored insufficient local space" >&2
  exit 1
fi
export TELEMETRY_HOME_MINIMUM_FREE_BYTES=1
export TELEMETRY_TEST_OFFLINE=true
if bash "${script_dir}/ash-atlas-telemetry-pull.sh" >/dev/null 2>&1; then
  echo "pull treated an offline VPS as success" >&2
  exit 1
fi
unset TELEMETRY_TEST_OFFLINE

# Publish failure variants beside the valid artifact. None may be
# acknowledged: malformed JSON, checksum/byte mismatch, unreadable DuckDB,
# row-count mismatch, and interrupted SSH transfer.
printf '{not-json\n' >"${root}/exports/malformed.duckdb.ready.json"
variant_manifest() {
  local suffix="$1"
  local variant_segment="$2"
  local variant_run="$3"
  local variant_artifact="${suffix}.duckdb"
  local variant_checksum="${variant_artifact}.sha256"
  jq \
    --arg segment "$variant_segment" \
    --arg run "$variant_run" \
    --arg artifact "$variant_artifact" \
    --arg checksum "$variant_checksum" \
    '.segmentId=$segment | .runId=$run
     | .artifact.fileName=$artifact
     | .artifact.checksumFileName=$checksum' \
    "${root}/exports/${manifest}" \
    >"${root}/exports/${variant_artifact}.ready.json"
}

cp "$database" "${root}/exports/checksum-bad.duckdb"
variant_manifest checksum-bad \
  00000000-0000-4000-8000-000000000111 \
  00000000-0000-4000-8000-000000000112
printf '%064d  checksum-bad.duckdb\n' 0 \
  >"${root}/exports/checksum-bad.duckdb.sha256"

cp "$database" "${root}/exports/size-bad.duckdb"
variant_manifest size-bad \
  00000000-0000-4000-8000-000000000121 \
  00000000-0000-4000-8000-000000000122
cp "${root}/exports/${checksum}" "${root}/exports/size-bad.duckdb.sha256"
jq '.artifact.bytes += 1' \
  "${root}/exports/size-bad.duckdb.ready.json" \
  >"${root}/size-bad.json"
mv "${root}/size-bad.json" "${root}/exports/size-bad.duckdb.ready.json"

printf 'not a DuckDB database\n' >"${root}/exports/open-bad.duckdb"
open_bad_sha="$(sha256sum "${root}/exports/open-bad.duckdb" | awk '{print $1}')"
open_bad_bytes="$(stat -c '%s' "${root}/exports/open-bad.duckdb")"
variant_manifest open-bad \
  00000000-0000-4000-8000-000000000131 \
  00000000-0000-4000-8000-000000000132
printf '%s  open-bad.duckdb\n' "$open_bad_sha" \
  >"${root}/exports/open-bad.duckdb.sha256"
jq --arg sha "$open_bad_sha" --argjson bytes "$open_bad_bytes" \
  '.artifact.sha256=$sha | .artifact.bytes=$bytes' \
  "${root}/exports/open-bad.duckdb.ready.json" \
  >"${root}/open-bad.json"
mv "${root}/open-bad.json" "${root}/exports/open-bad.duckdb.ready.json"

cp "$database" "${root}/exports/count-bad.duckdb"
variant_manifest count-bad "$segment_id" "$run_id"
cp "${root}/exports/${checksum}" "${root}/exports/count-bad.duckdb.sha256"
jq '.tableRowCounts.test_runs=2' \
  "${root}/exports/count-bad.duckdb.ready.json" \
  >"${root}/count-bad.json"
mv "${root}/count-bad.json" "${root}/exports/count-bad.duckdb.ready.json"

cp "$database" "${root}/exports/interrupted.duckdb"
variant_manifest interrupted \
  00000000-0000-4000-8000-000000000141 \
  00000000-0000-4000-8000-000000000142
cp "${root}/exports/${checksum}" "${root}/exports/interrupted.duckdb.sha256"
export TELEMETRY_TEST_INTERRUPT_NAME=interrupted.duckdb

if bash "${script_dir}/ash-atlas-telemetry-pull.sh"; then
  echo "pull hid rejected telemetry manifests behind a successful result" >&2
  exit 1
fi
unset TELEMETRY_TEST_INTERRUPT_NAME
final="${root}/seagate/ash-atlas-telemetry/archive/2026/07/25/${segment_id}"
[[ -f "${final}/${artifact}" ]]
duckdb "${final}/${artifact}" \
  "SELECT error('wrong identity') FROM test_runs
   WHERE run_id <> '${run_id}'::UUID OR segment_id <> '${segment_id}'::UUID" \
  >/dev/null
[[ -f "${root}/acks/${segment_id}.ack.json" ]]
[[ "$(find "${root}/seagate/ash-atlas-telemetry/rejected" -mindepth 1 -maxdepth 1 -type d | wc -l)" -ge 5 ]]
[[ "$(find "${root}/acks" -maxdepth 1 -name '*.ack.json' | wc -l)" == "1" ]]

# Simulate an acknowledgment lost after durable local storage. The duplicate
# path must re-open/reverify the local DuckDB and recreate the acknowledgment.
rm -f -- "${root}/acks/${segment_id}.ack.json"
if bash "${script_dir}/ash-atlas-telemetry-pull.sh"; then
  echo "duplicate recovery hid other rejected telemetry manifests" >&2
  exit 1
fi
[[ -f "${root}/acks/${segment_id}.ack.json" ]]

# A read-only mounted filesystem is distinct from an absent filesystem and
# must also fail before transfer.
if mount -o remount,ro "${root}/seagate"; then
  if bash "${script_dir}/ash-atlas-telemetry-pull.sh" >/dev/null 2>&1; then
    echo "pull succeeded on a read-only external filesystem" >&2
    exit 1
  fi
  mount -o remount,rw "${root}/seagate"
fi

# An existing bare mountpoint is not sufficient after the drive disappears,
# and the script must fail before invoking SSH.
umount "${root}/seagate"
mounted=false
if bash "${script_dir}/ash-atlas-telemetry-pull.sh" >/dev/null 2>&1; then
  echo "pull succeeded without the external filesystem mounted" >&2
  exit 1
fi

echo "home telemetry pull tests passed (${mount_validation_count} mount regressions)"
