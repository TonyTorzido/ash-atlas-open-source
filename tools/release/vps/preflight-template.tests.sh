#!/usr/bin/env bash
set -euo pipefail

test_root=$(mktemp -d /tmp/ash-atlas-preflight-template-tests.XXXXXXXX)
trap 'rm -rf --one-file-system -- "$test_root"' EXIT
mkdir "$test_root/tmp"
export ASH_ATLAS_PREFLIGHT_SNAPSHOT_PARENT="$test_root/tmp"
export ASH_ATLAS_DEPLOY_UPDATE_SOURCE_ONLY=true
source "$(dirname "$0")/deploy-test-update.sh"
unset ASH_ATLAS_DEPLOY_UPDATE_SOURCE_ONLY

MIGRATION_APPLIED="$test_root/applied.tsv"
PREFLIGHT_MIGRATION_LEDGER="$test_root/template.tsv"
PREFLIGHT_DATABASE_USER=ash_atlas_test
SHORT_SHA=deadbeef
GAME_RELEASE="$test_root/release"
mkdir -p "$GAME_RELEASE/db/migrations"
printf migration > "$GAME_RELEASE/db/migrations/001.sql"
printf pending > "$GAME_RELEASE/db/migrations/002.sql"
printf '001.sql\t%s\n' "$(printf migration | sha256sum | cut -d' ' -f1)" > "$MIGRATION_APPLIED"
ledger_hash=$(sha256sum "$MIGRATION_APPLIED" | cut -d' ' -f1)
command_log="$test_root/commands.log"
cache_marker="ash-atlas-preflight-ledger-sha256:$ledger_hash"
template_ledger=valid
rebuild_ledger=valid

database_url_for() { printf 'postgres://ash_atlas_test@localhost/%s\n' "$1"; }
provision_fresh_preflight_extensions() { printf 'extensions %s\n' "$1" >> "$command_log"; }
sudo() {
  printf '%s\n' "$*" >> "$command_log"
  case "$*" in
    *MIGRATIONS_DIRECTORY=*)
      ls "$PREFLIGHT_MIGRATIONS_STAGE" > "$test_root/staged.txt"
      template_ledger=$rebuild_ledger ;;
    *"SELECT COALESCE(shobj_description"*) printf '%s\n' "$cache_marker" ;;
    *"SELECT version, content_sha256 FROM schema_migrations"*)
      if [[ "$template_ledger" = valid ]]; then cat "$MIGRATION_APPLIED"
      else printf 'stale.sql\t%s\n' "${ledger_hash}"; fi ;;
    *"SELECT extname FROM pg_extension"*) printf 'postgis\n' ;;
  esac
}

ensure_fresh_preflight_template "$ledger_hash"
[[ "$PREFLIGHT_TEMPLATE_RESULT" = hit ]] || { printf 'valid template missed cache\n' >&2; exit 1; }
! grep -q 'dropdb\|createdb' "$command_log" || { printf 'cache hit rebuilt template\n' >&2; exit 1; }

: > "$command_log"
template_ledger=stale
ensure_fresh_preflight_template "$ledger_hash"
[[ "$PREFLIGHT_TEMPLATE_RESULT" = rebuilt ]] || { printf 'stale template was reused\n' >&2; exit 1; }
grep -q 'dropdb --if-exists --force ash_atlas_preflight_template' "$command_log"
grep -q 'createdb --owner=ash_atlas_test ash_atlas_preflight_template' "$command_log"
grep -q 'COMMENT ON DATABASE' "$command_log"
# Only Main's applied migrations reach the template; the pending one waits for the rehearsal.
[[ $(cat "$test_root/staged.txt") = 001.sql ]] ||
  { printf 'template rebuild staged more than the applied ledger\n' >&2; exit 1; }
cleanup_release_preflight
[[ -z "$(ls -A "$test_root/tmp")" ]] || { printf 'migration stage was not removed\n' >&2; exit 1; }

template_ledger=stale
rebuild_ledger=stale
if (ensure_fresh_preflight_template "$ledger_hash") 2>/dev/null; then
  printf 'a rebuilt template whose ledger differs from Main was accepted\n' >&2
  exit 1
fi

printf 'preflight-template.tests.sh: cache hit, applied-only rebuild, and rebuild ledger check passed\n'
