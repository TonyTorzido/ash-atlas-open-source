#!/usr/bin/env bash
set -euo pipefail

readonly TEST_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
export ASH_ATLAS_DEPLOY_UPDATE_SOURCE_ONLY=true
# shellcheck source=deploy-test-update.sh
source "$TEST_ROOT/deploy-test-update.sh"

assert_equal() {
  local message=$1 expected=$2 actual=$3
  [[ "$actual" = "$expected" ]] || {
    printf 'FAIL: %s (expected=%s actual=%s)\n' "$message" "$expected" "$actual" >&2
    exit 1
  }
}

assert_equal 'ordinary server change is server-no-migration' server_no_migration \
  "$(release_class_for_lane application false)"
assert_equal 'pending migration is database-migration' database_migration \
  "$(release_class_for_lane application true)"
assert_equal 'migration lane is database-migration' database_migration \
  "$(release_class_for_lane migration false)"
assert_equal 'release tooling remains release-tooling' release_tooling \
  "$(release_class_for_lane full false)"
prepared_fence_reuse_allowed client_only || {
  printf 'FAIL: client-only release did not allow prepared fence reuse\n' >&2
  exit 1
}
prepared_fence_reuse_allowed server_no_migration || {
  printf 'FAIL: server-no-migration release did not allow prepared fence reuse\n' >&2
  exit 1
}
if prepared_fence_reuse_allowed database_migration; then
  printf 'FAIL: database-migration release allowed prepared fence reuse\n' >&2
  exit 1
fi
if prepared_fence_reuse_allowed release_tooling; then
  printf 'FAIL: release-tooling release allowed prepared fence reuse\n' >&2
  exit 1
fi
assert_equal 'server-no-migration selects fresh replay' fresh_migration_replay \
  "$(candidate_database_strategy_for_class server_no_migration)"
assert_equal 'database-migration rehearses on the template clone, never a populated clone' fresh_migration_replay \
  "$(candidate_database_strategy_for_class database_migration)"
assert_equal 'release-tooling uses fresh replay' fresh_migration_replay \
  "$(candidate_database_strategy_for_class release_tooling)"
if (candidate_database_strategy_for_class unknown >/dev/null 2>&1); then
  printf 'FAIL: unknown release class selected a database strategy\n' >&2
  exit 1
fi

native_fixture=$(mktemp "${TMPDIR:-/tmp}/ash-atlas-native-env.XXXXXX")
native_source_fixture=$(mktemp -d "${TMPDIR:-/tmp}/ash-atlas-native-source.XXXXXX")
mkdir -p "$native_source_fixture/apps/server/src" "$native_source_fixture/packages/shared/src"
cat > "$native_source_fixture/apps/server/src/config.ts" <<'TS'
const schema = {
  NATIVE_IOS_HARD_MIN_VERSION: z.string().default(NATIVE_COMPATIBILITY_DISABLED_MIN_VERSION),
  NATIVE_IOS_HARD_MIN_BUILD: z.number().default(NATIVE_COMPATIBILITY_DISABLED_MIN_BUILD),
  NATIVE_ANDROID_HARD_MIN_VERSION: z.string().default(NATIVE_COMPATIBILITY_DISABLED_MIN_VERSION),
  NATIVE_ANDROID_HARD_MIN_BUILD: z.number().default(NATIVE_COMPATIBILITY_DISABLED_MIN_BUILD),
  NATIVE_WS_MIN: z.number().default(NATIVE_COMPATIBILITY_WS_MIN_VERSION),
  NATIVE_WS_MAX: z.number().default(NATIVE_COMPATIBILITY_WS_MAX_VERSION)
};
TS
cat > "$native_source_fixture/packages/shared/src/nativeCompatibility.ts" <<'TS'
export const NATIVE_COMPATIBILITY_DISABLED_MIN_VERSION = "9.8.7";
export const NATIVE_COMPATIBILITY_DISABLED_MIN_BUILD = 42;
export const NATIVE_COMPATIBILITY_WS_MIN_VERSION = ASH_ATLAS_MIN_PROTOCOL_VERSION;
export const NATIVE_COMPATIBILITY_WS_MAX_VERSION = ASH_ATLAS_MAX_PROTOCOL_VERSION;
TS
cat > "$native_source_fixture/packages/shared/src/protocolCompatibility.ts" <<'TS'
export const ASH_ATLAS_MIN_PROTOCOL_VERSION = 11;
export const ASH_ATLAS_MAX_PROTOCOL_VERSION = 12;
TS
cat > "$native_fixture" <<'ENV'
# Candidate effective compatibility settings may use export and simple quotes.
export NATIVE_WS_MIN='3'
NATIVE_WS_MAX=4
NATIVE_IOS_HARD_MIN_VERSION="1.2.3"
NATIVE_IOS_HARD_MIN_BUILD=7
NATIVE_ANDROID_HARD_MIN_VERSION=2.0.0
NATIVE_ANDROID_HARD_MIN_BUILD='9'
ENV
native_configuration=$(effective_native_configuration "$native_fixture" "$native_source_fixture")
rm -f -- "$native_fixture"
assert_equal 'candidate native protocol is derived from game.env' 3 \
  "$(printf '%s' "$native_configuration" | "$NODE_BIN" -e 'const v=JSON.parse(require("node:fs").readFileSync(0,"utf8"));process.stdout.write(String(v.serverProtocol.min))')"
assert_equal 'candidate native protocol maximum is derived from game.env' 4 \
  "$(printf '%s' "$native_configuration" | "$NODE_BIN" -e 'const v=JSON.parse(require("node:fs").readFileSync(0,"utf8"));process.stdout.write(String(v.serverProtocol.max))')"
assert_equal 'candidate iOS hard minimum is derived from game.env' 1.2.3 \
  "$(printf '%s' "$native_configuration" | "$NODE_BIN" -e 'const v=JSON.parse(require("node:fs").readFileSync(0,"utf8"));process.stdout.write(v.hardMinimum.ios.version)')"
assert_equal 'candidate Android hard build is derived from game.env' 9 \
  "$(printf '%s' "$native_configuration" | "$NODE_BIN" -e 'const v=JSON.parse(require("node:fs").readFileSync(0,"utf8"));process.stdout.write(String(v.hardMinimum.android.build))')"
native_defaults_fixture="$native_source_fixture/defaults.env"
: > "$native_defaults_fixture"
native_defaults=$(effective_native_configuration "$native_defaults_fixture" "$native_source_fixture")
rm -f -- "$native_defaults_fixture"
assert_equal 'candidate native protocol defaults come from the exact candidate source' 11 \
  "$(printf '%s' "$native_defaults" | "$NODE_BIN" -e 'const v=JSON.parse(require("node:fs").readFileSync(0,"utf8"));process.stdout.write(String(v.serverProtocol.min))')"
assert_equal 'candidate native hard minimum defaults come from the exact candidate source' 9.8.7 \
  "$(printf '%s' "$native_defaults" | "$NODE_BIN" -e 'const v=JSON.parse(require("node:fs").readFileSync(0,"utf8"));process.stdout.write(v.hardMinimum.ios.version)')"
assert_equal 'candidate native hard minimum build defaults come from the exact candidate source' 42 \
  "$(printf '%s' "$native_defaults" | "$NODE_BIN" -e 'const v=JSON.parse(require("node:fs").readFileSync(0,"utf8"));process.stdout.write(String(v.hardMinimum.android.build))')"
invalid_native_fixture=$(mktemp "${TMPDIR:-/tmp}/ash-atlas-native-env-invalid.XXXXXX")
printf 'NATIVE_WS_MIN=5\nNATIVE_WS_MAX=4\n' > "$invalid_native_fixture"
if effective_native_configuration "$invalid_native_fixture" "$native_source_fixture" >/dev/null 2>&1; then
  printf 'FAIL: candidate native protocol accepted min greater than max\n' >&2
  exit 1
fi
rm -f -- "$invalid_native_fixture"
rm -rf -- "$native_source_fixture"

if migration_rollback_requires_safe_stop false false true false; then
  printf 'FAIL: rollback stopped when no migration command or intent existed\n' >&2
  exit 1
fi
if ! migration_rollback_requires_safe_stop true false true true; then
  printf 'FAIL: uncertain migration outcome allowed prior binary rollback\n' >&2
  exit 1
fi
if ! migration_rollback_requires_safe_stop true true false true; then
  printf 'FAIL: incompatible prior binary allowed rollback\n' >&2
  exit 1
fi
if migration_rollback_requires_safe_stop true true true true; then
  printf 'FAIL: verified compatible migration was treated as uncertain\n' >&2
  exit 1
fi

migration_fixture=$(mktemp -d "${TMPDIR:-/tmp}/ash-atlas-migration-partial.XXXXXX")
trap 'rm -rf -- "$migration_fixture"' EXIT
MIGRATION_CANDIDATES="$migration_fixture/candidates.tsv"
MIGRATION_POST_APPLIED="$migration_fixture/post-applied.tsv"
export MIGRATION_CANDIDATES MIGRATION_POST_APPLIED
printf '202609200001\t1111111111111111111111111111111111111111111111111111111111111111\n202609200002\t2222222222222222222222222222222222222222222222222222222222222222\n' \
  > "$MIGRATION_CANDIDATES"
printf '202609200001\t1111111111111111111111111111111111111111111111111111111111111111\n' \
  > "$MIGRATION_POST_APPLIED"
if verify_live_migration_ledger; then
  printf 'FAIL: a partially committed migration ledger was accepted as complete\n' >&2
  exit 1
fi
printf '202609200001\t1111111111111111111111111111111111111111111111111111111111111111\n202609200002\t2222222222222222222222222222222222222222222222222222222222222222\n' \
  > "$MIGRATION_POST_APPLIED"
verify_live_migration_ledger || {
  printf 'FAIL: a complete migration ledger was rejected\n' >&2
  exit 1
}
partial_runner="$migration_fixture/partial-runner.sh"
cat > "$partial_runner" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '202609200001\t1111111111111111111111111111111111111111111111111111111111111111\n' > "$MIGRATION_POST_APPLIED"
exit 1
EOF
chmod +x "$partial_runner"
if "$partial_runner"; then
  printf 'FAIL: partial migration fixture unexpectedly completed\n' >&2
  exit 1
fi
if ! migration_rollback_requires_safe_stop true false true true; then
  printf 'FAIL: interruption after a partial migration commit did not require a safe stop\n' >&2
  exit 1
fi

trap_fixture_root=$(mktemp -d "${TMPDIR:-/tmp}/ash-atlas-updater-trap.XXXXXX")
trap_fixture="$trap_fixture_root/run.sh"
trap_fixture_runner="$trap_fixture_root/failing-migration.sh"
trap_fixture_updates="$trap_fixture_root/receipt-updates.log"
trap_fixture_partial="$trap_fixture_root/partial-ledger.tsv"
trap_fixture_receipt="$trap_fixture_root/receipt.json"
trap_fixture_marker_root="$trap_fixture_root/operations"
mkdir -p "$trap_fixture_marker_root"
printf '{"operation_id":"migration-trap-fixture","current_phase":"migration"}\n' \
  > "$trap_fixture_receipt"
cat > "$trap_fixture_runner" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '202609200001\tpartial\n' > "$ASH_ATLAS_TEST_PARTIAL_LEDGER"
exit 1
EOF
chmod +x "$trap_fixture_runner"
cat > "$trap_fixture" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
export ASH_ATLAS_DEPLOY_UPDATE_SOURCE_ONLY=true
source "$ASH_ATLAS_TEST_UPDATER"

# Keep the fixture focused on the updater trap's decision and receipt fields;
# the production receipt writer is already exercised by the controller tests.
cleanup_release_preflight() { return 0; }
operation_receipt_update() {
  printf '%s\n' "$*" >> "$ASH_ATLAS_TEST_RECEIPT_UPDATES"
}

trap on_exit EXIT
ACTIVATION_STARTED=true
MIGRATION_COMMAND_STARTED=true
MIGRATION_COMMAND_COMPLETED=false
MIGRATION_RECEIPT_COMPLETED=false
PRIOR_BINARY_RESTART_SAFE=true
touch "$MIGRATION_INTENT_MARKER"

# This runner has committed one migration row and then exits before the ledger
# is complete, which is the updater failure boundary under test.
"$ASH_ATLAS_TEST_PARTIAL_RUNNER"
EOF
chmod +x "$trap_fixture"
if ASH_ATLAS_TEST_UPDATER="$TEST_ROOT/deploy-test-update.sh" \
    ASH_ATLAS_OPERATION_ID=migration-trap-fixture \
    ASH_ATLAS_OPERATION_RECEIPT="$trap_fixture_receipt" \
    ASH_ATLAS_OPERATION_ROOT="$trap_fixture_marker_root" \
    ASH_ATLAS_TEST_RECEIPT_UPDATES="$trap_fixture_updates" \
    ASH_ATLAS_TEST_PARTIAL_LEDGER="$trap_fixture_partial" \
    ASH_ATLAS_TEST_PARTIAL_RUNNER="$trap_fixture_runner" \
    ASH_ATLAS_NODE_BIN="$NODE_BIN" \
    "$trap_fixture"; then
  printf 'FAIL: updater trap fixture unexpectedly completed after a partial migration\n' >&2
  exit 1
fi
[[ -s "$trap_fixture_partial" ]] || {
  printf 'FAIL: failing migration runner did not leave its partial ledger evidence\n' >&2
  exit 1
}
grep -Fq 'rollback_result blocked_migration_compatibility_uncertain' "$trap_fixture_updates" || {
  printf 'FAIL: updater trap did not record a compatibility-uncertain safe stop\n' >&2
  exit 1
}
grep -Fq 'migration_outcome_uncertain __TRUE__' "$trap_fixture_updates" || {
  printf 'FAIL: updater trap did not mark migration outcome uncertain\n' >&2
  exit 1
}
rm -rf -- "$trap_fixture_root"

printf 'Stage 4/5 updater classification and migration safety checks passed: 30\n'
