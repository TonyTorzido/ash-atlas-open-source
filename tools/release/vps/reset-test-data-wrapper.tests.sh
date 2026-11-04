#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
wrapper="${script_dir}/reset-test-data.sh"
prepare_line="$(grep -n 'prepare-reset-backup.sh' "$wrapper" | tail -n1 | cut -d: -f1)"
reset_line="$(grep -n 'run_reset --confirm' "$wrapper" | cut -d: -f1)"
cleanup_line="$(grep -n 'cleanup_local_backup ||' "$wrapper" | cut -d: -f1)"
[[ "$prepare_line" =~ ^[0-9]+$ && "$reset_line" =~ ^[0-9]+$ &&
   "$cleanup_line" =~ ^[0-9]+$ ]]
(( prepare_line < reset_line && reset_line < cleanup_line ))

grep -q 'remote_backup_verified_reset_pending' "$wrapper"
grep -q 'temporaryVpsCopyDeleted = true' "$wrapper"
grep -q 'reset did not complete; verified remote backup preserved' "$wrapper"
grep -q 'World service identity changed during the game reset' "$wrapper"
grep -q 'post-reset migration verification was not a no-op' "$wrapper"
grep -q 'the reset dump exists in the former permanent VPS backup directory' "$wrapper"
if grep -q 'TEST_DATA_RESET_BACKUP_DIR=' "$wrapper"; then
  echo "wrapper still configures permanent VPS reset backup storage" >&2
  exit 1
fi
echo "reset wrapper ordering tests passed"
