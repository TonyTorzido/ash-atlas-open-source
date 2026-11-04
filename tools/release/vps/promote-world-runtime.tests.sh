#!/usr/bin/env bash
set -euo pipefail

readonly SCRIPT_ROOT=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
readonly REPOSITORY_ROOT=$(CDPATH= cd -- "$SCRIPT_ROOT/../../.." && pwd)
readonly WRAPPER=$REPOSITORY_ROOT/tools/release/promote-world-runtime.ps1
readonly REMOTE=$REPOSITORY_ROOT/tools/release/vps/promote-world-runtime.sh

[[ -f "$WRAPPER" && -f "$REMOTE" ]] || { printf 'promotion sources are absent\n' >&2; exit 1; }
bash -n "$REMOTE"

[[ $(grep -F -c 'Invoke-WslOpenSshCommand' "$WRAPPER") -eq 5 ]] ||
  { printf 'wrapper must use the bounded transport for supplemental preflight, SCP, archive finalization, cleanup, and SSH\n' >&2; exit 1; }
for required in \
  'WaterNameIndexRoot' \
  'Assert-WorldLocalRiverbankRoot' \
  'Assert-WorldLocalWaterNameIndexRoot' \
  'Invoke-WorldSupplementalTransfer' \
  'Get-WorldLocalTreeCapacity' \
  'Invoke-WorldSupplementalCapacityPreflight' \
  'requiredFreeBytes' \
  'available_bytes -lt $RequiredBytes' \
  'insufficient World supplemental staging free space' \
  'required_free_bytes' \
  'archiveHeaderReservePerEntryBytes' \
  'expandedSafetyReserveBytesPerRoot' \
  'controllerSafetyReserveBytes' \
  'Remove-WorldSupplementalStaging' \
  'HardDeadlineSeconds 120' \
  'Invoke-WorldSupplementalArchiveFinalize' \
  'ArchiveFinalize' \
  'chown -- debian:debian' \
  'chmod -- 0600' \
  'unsafe supplemental archive path' \
  'supplemental archive is absent or unsafe' \
  'supplemental archive hard-link count is unsafe' \
  'owner_group' \
  'link_count' \
  'supplemental_archive_finalizations' \
  'transferReleaseIds' \
  'transferFailure' \
  'transferCleanup' \
  'owned staging cleanup failed' \
  '-Program scp' \
  '/home/debian/ash-atlas-world-promotion-staging/'; do
  grep -F -q -- "$required" "$WRAPPER" || { printf 'wrapper contract missing: %s\n' "$required" >&2; exit 1; }
done
! grep -F -q -- '/tmp/ash-atlas-world-promotion-' "$WRAPPER" || {
  printf 'wrapper must not use tmpfs for World supplemental staging\n' >&2
  exit 1
}

for required in \
  'validate_riverbank_release_root' \
  'validate_water_name_index_release_root' \
  'extract_transferred_archive' \
  'tarfile.open' \
  'member.isfile' \
  '"$transfer.tar"' \
  'publish_supplemental_root' \
  'SUPPLEMENTAL_STAGING_ROOT=/home/debian/ash-atlas-world-promotion-staging' \
  'RIVERBANK_TRANSFER_ROOT=$SUPPLEMENTAL_STAGING_ROOT/' \
  'WATER_NAME_INDEX_TRANSFER_ROOT=$SUPPLEMENTAL_STAGING_ROOT/' \
  "stat -c '%U:%G:%a'" \
  'validate_transferred_archive' \
  '[[ -f "$archive" && ! -L "$archive" ]]' \
  'archive ownership is unsafe' \
  'archive mode is unsafe' \
  'printf '\''%d'\'' "0$mode"' \
  'mode_value & 0022' \
  'supplemental extraction directory already exists' \
  'validate_transferred_archive "$RIVERBANK_TRANSFER_ROOT.tar"' \
  'validate_transferred_archive "$WATER_NAME_INDEX_TRANSFER_ROOT.tar"' \
  'readonly RIVERBANK_TARGET_ROOT_TOKEN=$RIVERBANK_RELEASE' \
  'readonly WATER_NAME_INDEX_TARGET_ROOT_TOKEN=$WATER_NAME_INDEX_RELEASE' \
  'mv -T -- "$incoming" "$target"' \
  '--riverbank-lakeshore-release-root $RIVERBANK_TARGET_ROOT' \
  '--water-name-index-root $WATER_NAME_INDEX_TARGET_ROOT' \
  'riverbankLakeshoreV1' \
  'unit_has_supplemental_args' \
  'unit_has_canonical_execstart' \
  'if unit_has_supplemental_args && unit_has_canonical_execstart && wait_ready' \
  'unit_supplemental_arg_state' \
  '[[ "$state" = missing ]]' \
  'read_validated_unit_text' \
  '[[ -f "$UNIT" && ! -L "$UNIT" ]] || return 2' \
  'cat -- "$UNIT"' \
  'TARGET_ACTIVE_RECOVERY=true' \
  'target_active_recovery_state_is_safe' \
  'target_active_recovery_state_is_safe "$supplemental_state"' \
  '! unit_has_canonical_execstart' \
  'target-active recovery requires missing supplemental arguments or a complete exact noncanonical repair state' \
  'current World is neither the approved base nor an eligible target-active recovery' \
  '"target_active_recovery":%s' \
  'result":"already-active"' \
  'c3a2823f759271abb77bf23220e33cb1146d9a3ecb2615f79d3e173189a2344f' \
  'bb73ebeac7c48d4adcedf9dd10e9a0a6cf591bd8ef7dfe01dca2a141a9e6317b'; do
  grep -F -q -- "$required" "$REMOTE" || { printf 'remote contract missing: %s\n' "$required" >&2; exit 1; }
done

for required in \
  'TRAP_INSTALLED=false' \
  'CLEANUP_DONE=false' \
  'ROLLBACK_RUNNING=false' \
  'CLEANUP_DONE=true' \
  'rollback 1' \
  'BASH_SUBSHELL" -eq 0' \
  'trap - ERR HUP INT TERM' \
  'if [[ "$ROLLBACK_RUNNING" = true ]]' \
  'cleanup_supplemental_staging'; do
  grep -F -q -- "$required" "$REMOTE" || { printf 'remote cleanup contract missing: %s\n' "$required" >&2; exit 1; }
done

assert_archive_mode() {
  local fixture_mode=$1 expected=$2 mode_value actual
  mode_value=$(printf '%d' "0$fixture_mode")
  if (( (mode_value & 0400) != 0 && (mode_value & 0022) == 0 )); then
    actual=accepted
  else
    actual=rejected
  fi
  [[ "$actual" = "$expected" ]] || {
    printf 'archive mode fixture %s expected %s, got %s\n' "$fixture_mode" "$expected" "$actual" >&2
    exit 1
  }
}

assert_archive_mode 600 accepted
assert_archive_mode 644 accepted
assert_archive_mode 666 rejected
assert_archive_mode 200 rejected

printf 'promote-world-runtime contract tests passed\n'
