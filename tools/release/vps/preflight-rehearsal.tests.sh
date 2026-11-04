#!/usr/bin/env bash
set -euo pipefail

readonly TEST_ROOT=$(mktemp -d /tmp/ash-atlas-preflight-rehearsal-tests.XXXXXXXX)
cleanup() {
  rm -rf --one-file-system -- "$TEST_ROOT"
}
trap cleanup EXIT
mkdir "$TEST_ROOT/tmp"
export ASH_ATLAS_PREFLIGHT_SNAPSHOT_PARENT="$TEST_ROOT/tmp"
export ASH_ATLAS_DEPLOY_UPDATE_SOURCE_ONLY=true
# shellcheck source=deploy-test-update.sh
source "$(dirname "$0")/deploy-test-update.sh"
unset ASH_ATLAS_DEPLOY_UPDATE_SOURCE_ONLY

passed=0
assert() {
  local message=$1
  shift
  "$@" || {
    printf 'ASSERTION FAILED: %s\n' "$message" >&2
    exit 1
  }
  passed=$((passed + 1))
}

GAME_RELEASE="$TEST_ROOT/release"
MIGRATION_CANDIDATES="$TEST_ROOT/candidates.tsv"
MIGRATION_APPLIED="$TEST_ROOT/applied.tsv"
SHORT_SHA=deadbeef
mkdir -p "$GAME_RELEASE/db/migrations" "$GAME_RELEASE/apps/server/src/db"
printf 'const transaction = process.env.MIGRATION_TRANSACTION;\n' \
  > "$GAME_RELEASE/apps/server/src/db/migrate.ts"
write_migration() {
  printf '%s' "$2" > "$GAME_RELEASE/db/migrations/$1"
  printf '%s\t%s\n' "$1" "$(printf '%s' "$2" | sha256sum | cut -d' ' -f1)" >> "$MIGRATION_CANDIDATES"
}
write_migration 0001_applied.sql $'-- ash-atlas-migration: allow-non-transactional\nBEGIN;\nCOMMIT;\n'
write_migration 0002_pending.sql $'CREATE TABLE a (id integer);\n'
head -n 1 "$MIGRATION_CANDIDATES" > "$MIGRATION_APPLIED"

pending_is_exact() {
  [[ $(pending_migration_versions) = 0002_pending.sql ]]
}

applied_opt_out_does_not_affect_pending_batch() {
  select_migration_transaction_mode >/dev/null
  [[ "$MIGRATION_TRANSACTION_MODE" = batch ]]
}

pending_opt_out_selects_per_file() (
  write_migration 0003_concurrent.sql \
    $'-- ash-atlas-migration: allow-non-transactional\r\nCREATE INDEX CONCURRENTLY i ON a (id);\n'
  select_migration_transaction_mode >/dev/null
  [[ "$MIGRATION_TRANSACTION_MODE" = per_file ]]
)

old_runner_is_refused() (
  printf 'export {};\n' > "$GAME_RELEASE/apps/server/src/db/migrate.ts"
  ! (select_migration_transaction_mode) >/dev/null 2>&1
)

stage_holds_only_applied_ledger() (
  stage_applied_migrations
  [[ "$PREFLIGHT_MIGRATIONS_STAGE" =~ ^"$TEST_ROOT"/tmp/ash-atlas-preflight-deadbeef\.[A-Za-z0-9]{8}$ &&
      $(ls "$PREFLIGHT_MIGRATIONS_STAGE") = 0001_applied.sql ]] &&
    cmp -s "$PREFLIGHT_MIGRATIONS_STAGE/0001_applied.sql" "$GAME_RELEASE/db/migrations/0001_applied.sql" &&
    cleanup_release_preflight &&
    [[ -z "$(ls -A "$TEST_ROOT/tmp")" ]]
)

stage_refuses_changed_applied_file() (
  printf 'changed' > "$GAME_RELEASE/db/migrations/0001_applied.sql"
  ! (stage_applied_migrations) >/dev/null 2>&1
)

unsafe_cleanup_is_refused() (
  PREFLIGHT_DATABASE_CREATED=false
  PREFLIGHT_PROCESS_PID=
  PREFLIGHT_READY_BODY=
  PREFLIGHT_MIGRATIONS_STAGE="$TEST_ROOT/must-remain"
  mkdir "$PREFLIGHT_MIGRATIONS_STAGE"
  ! cleanup_release_preflight 2>/dev/null && [[ -d "$PREFLIGHT_MIGRATIONS_STAGE" ]]
)

assert 'pending migrations are the candidate ledger minus the applied ledger' pending_is_exact
assert 'an already-applied opt-out does not leave the batch' applied_opt_out_does_not_affect_pending_batch
assert 'a pending in-file opt-out selects per-file transactions' pending_opt_out_selects_per_file
assert 'a candidate runner without batch support is refused' old_runner_is_refused
assert 'the template stage holds exactly the applied ledger and is removed' stage_holds_only_applied_ledger
assert 'a candidate file that differs from the applied ledger is refused' stage_refuses_changed_applied_file
assert 'stage cleanup refuses paths outside its exact namespace' unsafe_cleanup_is_refused

printf 'preflight-rehearsal.tests.sh: %s assertions passed\n' "$passed"
