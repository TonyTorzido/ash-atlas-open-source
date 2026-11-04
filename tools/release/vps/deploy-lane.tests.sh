#!/usr/bin/env bash
set -euo pipefail

export ASH_ATLAS_CACHE_TEST_SOURCE_ONLY=true
# shellcheck source=deploy-test-update.sh
source "$(dirname "$0")/deploy-test-update.sh"
unset ASH_ATLAS_CACHE_TEST_SOURCE_ONLY

passed=0
assert_equal() {
  local message=$1
  local expected=$2
  local actual=$3
  [[ "$actual" = "$expected" ]] || {
    printf 'ASSERTION FAILED: %s (expected %s, got %s)\n' "$message" "$expected" "$actual" >&2
    exit 1
  }
  passed=$((passed + 1))
}

assert_equal 'client-only lane' client \
  "$(classify_changed_paths apps/client/src/App.tsx apps/client/public/icon.png)"
assert_equal 'server-only lane' application \
  "$(classify_changed_paths apps/server/src/index.ts)"
assert_equal 'shared lane' application \
  "$(classify_changed_paths packages/shared/src/protocol.ts)"
assert_equal 'safe client and server lane' application \
  "$(classify_changed_paths apps/client/src/App.tsx apps/server/src/index.ts)"
assert_equal 'migration lane' migration \
  "$(classify_changed_paths db/migrations/9999_fixture.sql)"
assert_equal 'client plus migration lane' migration \
  "$(classify_changed_paths apps/client/src/App.tsx db/migrations/9999_fixture.sql)"
assert_equal 'lockfile full lane' full \
  "$(classify_changed_paths pnpm-lock.yaml)"
assert_equal 'deployment tooling alone reuses the client-only path' client \
  "$(classify_changed_paths tools/release/vps/deploy-control.sh tools/mobile-release/registry.mjs .github/workflows/ci.yml)"
assert_equal 'patch-note tooling does not widen a client change' client \
  "$(classify_changed_paths apps/client/src/App.tsx tools/release/public-release-metadata.mjs)"
assert_equal 'unknown full lane' full \
  "$(classify_changed_paths unknown/new-system.txt)"
assert_equal 'unsafe mixed full lane' full \
  "$(classify_changed_paths apps/client/src/App.tsx package.json)"
assert_equal 'wolf combat with progression guidance stays application' application \
  "$(classify_changed_paths apps/server/src/game/combat/mobDefinitions.ts docs/progression-foundation.md)"
assert_equal 'Safari zoom with UI guidance stays client' client \
  "$(classify_changed_paths apps/client/src/documentZoom.ts apps/client/src/main.tsx apps/client/src/ui/UiStandardsGallery.tsx docs/build-bible/UI_DESIGN_SYSTEM.md)"
assert_equal 'documentation alone reuses the client-only path' client \
  "$(classify_changed_paths docs/progression-foundation.md docs/build-bible/UI_DESIGN_SYSTEM.md)"
assert_equal 'Markdown does not widen a client change' client \
  "$(classify_changed_paths apps/client/src/App.tsx docs/new-build-input.md)"
assert_equal 'metadata alone is client-only' client \
  "$(classify_changed_paths README.md .editorconfig docs/notes.md)"
assert_equal 'metadata does not widen a server change' application \
  "$(classify_changed_paths apps/server/src/index.ts README.md docs/release/checklist.md)"
assert_equal 'release tooling does not mask a server change' application \
  "$(classify_changed_paths apps/server/src/index.ts tools/release/vps/deploy-test-update.sh)"
assert_equal 'documentation does not mask migration' migration \
  "$(classify_changed_paths docs/progression-foundation.md db/migrations/9999_fixture.sql)"
assert_equal 'documentation does not mask config' full \
  "$(classify_changed_paths docs/build-bible/UI_DESIGN_SYSTEM.md apps/client/src/App.tsx config/runtime.json)"
assert_equal 'documentation does not mask build changes' full \
  "$(classify_changed_paths docs/build-bible/UI_DESIGN_SYSTEM.md apps/client/src/App.tsx apps/client/vite.config.ts)"

assert_equal 'client lane build plan' 'server=false client=true' \
  "$(deployment_plan_for_lane client true false false)"
assert_equal 'metadata-only build plan reuses both artifacts' 'server=false client=false' \
  "$(deployment_plan_for_lane client false false false)"
assert_equal 'server-only build plan' 'server=true client=false' \
  "$(deployment_plan_for_lane application false true false)"
assert_equal 'shared build plan' 'server=true client=true' \
  "$(deployment_plan_for_lane application false false true)"
assert_equal 'full build plan' 'server=true client=true' \
  "$(deployment_plan_for_lane full false false false)"

assert_equal 'client-only release class' client_only \
  "$(release_class_for_lane client false)"
assert_equal 'metadata-only release uses client-only class' client_only \
  "$(release_class_for_lane "$(classify_changed_paths README.md .editorconfig docs/release/checklist.md)" false)"
assert_equal 'metadata-only release skips database preflight' none \
  "$(candidate_database_strategy_for_class "$(release_class_for_lane "$(classify_changed_paths README.md)" false)")"
assert_equal 'server no-migration release class' server_no_migration \
  "$(release_class_for_lane application false)"
assert_equal 'server no-migration keeps fresh-database preflight' fresh_migration_replay \
  "$(candidate_database_strategy_for_class "$(release_class_for_lane application false)")"
assert_equal 'migration decision overrides application lane' database_migration \
  "$(release_class_for_lane application true)"
assert_equal 'release tooling class' release_tooling \
  "$(release_class_for_lane full false)"
assert_equal 'full lane without a migration uses the template replay' fresh_migration_replay \
  "$(candidate_database_strategy_for_class release_tooling)"
assert_equal 'migrations are rehearsed on the template clone, not a populated clone' fresh_migration_replay \
  "$(candidate_database_strategy_for_class database_migration)"
if server_activation_required client_only; then
  printf 'ASSERTION FAILED: client-only class unexpectedly requires server activation\n' >&2
  exit 1
fi
passed=$((passed + 1))
server_activation_required server_no_migration || {
  printf 'ASSERTION FAILED: server class unexpectedly skipped server activation\n' >&2
  exit 1
}
passed=$((passed + 1))
assert_equal 'changed path hash is deterministic' \
  "$(changed_paths_hash apps/client/src/App.tsx apps/client/public/icon.png)" \
  "$(changed_paths_hash apps/client/src/App.tsx apps/client/public/icon.png)"

printf 'deploy-lane.tests.sh: %s assertions passed.\n' "$passed"
