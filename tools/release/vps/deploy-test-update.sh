#!/usr/bin/env bash
set -euo pipefail

readonly GAME_SHA=${1:-}
readonly DEPLOY_MODE=${ASH_ATLAS_DEPLOY_MODE:-deploy}
readonly RELEASE_PATCH_NOTES_HEX=${ASH_ATLAS_RELEASE_PATCH_NOTES_HEX:-none}
readonly EXPECTED_GENERATION=${ASH_ATLAS_EXPECTED_GENERATION:-}
readonly CANDIDATE_REF=${ASH_ATLAS_CANDIDATE_REF:-}
readonly OPERATION_ID=${ASH_ATLAS_OPERATION_ID:-legacy-${GAME_SHA:-unknown}}
readonly OPERATION_RECEIPT=${ASH_ATLAS_OPERATION_RECEIPT:-}
readonly OPERATION_STATUS_PUBLISHER=${ASH_ATLAS_OPERATION_STATUS_PUBLISHER:-}
readonly ACTIVATION_INTENT_ID=${ASH_ATLAS_ACTIVATION_INTENT_ID:-}
readonly ACTIVATION_REGISTRY_COMMIT_SHA=${ASH_ATLAS_ACTIVATION_REGISTRY_COMMIT_SHA:-}
RELEASE_MODE=${ASH_ATLAS_RELEASE_MODE:-}
readonly NODE_BIN=${ASH_ATLAS_NODE_BIN:-/usr/bin/node}
readonly RELEASE_CLASSIFICATION_VERSION=1
readonly PREPARED_DESCRIPTOR_VERSION=4
readonly MOBILE_REGISTRY_REF=${ASH_ATLAS_MOBILE_REGISTRY_REF:-refs/heads/mobile-release-state}
readonly TEST_MOBILE_REGISTRY_PATH=${ASH_ATLAS_TEST_MOBILE_REGISTRY_PATH:-}
readonly TEST_MOBILE_REGISTRY_COMMIT_SHA=${ASH_ATLAS_TEST_MOBILE_REGISTRY_COMMIT_SHA:-}
WORLD_RUNTIME_BRANCH=
WORLD_SHA=
WORLD_RELEASE=
WORLD_MANIFEST_SHA256=
WATER_NAME_INDEX_RELEASE=
WATER_NAME_INDEX_MANIFEST_SHA256=
WATER_NAME_INDEX_SCHEMA=
WATER_NAME_INDEX_POLICY=
WATER_NAME_INDEX_ENTRIES_FILENAME=
WATER_NAME_INDEX_ENTRIES_FORMAT=
WATER_NAME_INDEX_ENTRIES_SHA256=
WATER_NAME_INDEX_ENTRIES_SIZE=
WATER_NAME_INDEX_HASH=
WATER_NAME_INDEX_DETERMINISTIC_FINGERPRINT=
WATER_NAME_INDEX_ENTRY_COUNT=
WATER_NAME_INDEX_RIVER_COUNT=
WATER_NAME_INDEX_LAKE_COUNT=
WATER_NAME_INDEX_OCEAN_COUNT=
WATER_NAME_INDEX_RIVER_MAX_DISTANCE_M=
WATER_NAME_INDEX_LAKE_MAX_DISTANCE_M=
WATER_NAME_INDEX_OCEAN_MAX_DISTANCE_M=
WATER_NAME_INDEX_ROOT=
WATER_NAME_INDEX_MANIFEST=
WATER_NAME_INDEX_ENTRIES=
readonly WATERBODY_IDENTITY_OVERLAY_RELEASE=waterbody-identity-overlay-v4
readonly WATERBODY_IDENTITY_OVERLAY_MANIFEST_SHA256=f81deb9fb441ec5644095b1d4ea8f430c652948f5e7a64e9beac5a6ea005020c
readonly WATERBODY_IDENTITY_OVERLAY_SCHEMA=waterbody-identity-overlay-v1
readonly WATERBODY_IDENTITY_OVERLAY_SCHEMA_VERSION=waterbody-identity-overlay-v1
readonly WATERBODY_IDENTITY_OVERLAY_POLICY=existing-cell-candidate-precedence-v1
readonly WATERBODY_IDENTITY_OVERLAY_POLICY_VERSION=existing-cell-candidate-precedence-v1
readonly RIVER_SURFACE_RELEASE=river-surface-v1
readonly RIVER_SURFACE_MANIFEST_SHA256=c605631193ff786e33182fb8b6d7cfa3ab868b35d0a47fec5e1aa717ace447d5
readonly RIVER_SURFACE_POLICY=osm-medium-plus-v1
readonly RIVER_SURFACE_RELEASE_ROOT=/srv/ash-atlas/world/releases/$RIVER_SURFACE_RELEASE
readonly RIVER_SURFACE_TARGET_ROOT_TOKEN=$RIVER_SURFACE_RELEASE--sha256-$RIVER_SURFACE_MANIFEST_SHA256
readonly RIVER_SURFACE_TARGET_ROOT=/srv/ash-atlas/world/releases/$RIVER_SURFACE_TARGET_ROOT_TOKEN
readonly LAKE_SURFACE_RELEASE=lake-surface-v1
readonly LAKE_SURFACE_MANIFEST_SHA256=d0c25c2b6a4e9349091a5f483a294fac7988cd098a1f77e354343cb2f27f42b9
readonly LAKE_SURFACE_POLICY=hydrolakes-center-membership-v1
readonly LAKE_SURFACE_ROOT=/srv/ash-atlas/world/releases/$LAKE_SURFACE_RELEASE
readonly OCEAN_COAST_SURFACE_RELEASE=ocean-coast-surface-v1
readonly OCEAN_COAST_SURFACE_MANIFEST_SHA256=b8319476532112ef6076d56819a89a9551ea88c4b55f52a06c80b8bae8fa3954
readonly OCEAN_COAST_SURFACE_POLICY=three-cell-canonical-ocean-coast-v1
readonly OCEAN_COAST_SURFACE_ROOT=/srv/ash-atlas/world/releases/$OCEAN_COAST_SURFACE_RELEASE
readonly WATER_VISUAL_TILES_RELEASE=water-visual-tiles-v1
readonly WATER_VISUAL_TILES_MANIFEST_SHA256=6eece70668d929850944b44ccd134a426972080aeed18865f7c360618daeb229
readonly WATER_VISUAL_TILES_ARTIFACT=water-visual-7e4a0ddc7821bfb554d34896bb83d2e35a3304a3e7d75ace73c57f73adfa974a.pmtiles
readonly WATER_VISUAL_TILES_ARTIFACT_SHA256=7e4a0ddc7821bfb554d34896bb83d2e35a3304a3e7d75ace73c57f73adfa974a
readonly WATER_VISUAL_TILES_ARTIFACT_SIZE=1639576487
readonly WATER_VISUAL_TILES_ROOT=/srv/ash-atlas/world/releases/$WATER_VISUAL_TILES_RELEASE
readonly WATER_VISUAL_TILES_PATH=$WATER_VISUAL_TILES_ROOT/$WATER_VISUAL_TILES_ARTIFACT
readonly WATER_VISUAL_TILES_URL=/world-data/$WATER_VISUAL_TILES_RELEASE/$WATER_VISUAL_TILES_ARTIFACT
readonly REPOSITORY=github.com:example-org/game.git
readonly CONTROLLER_CONFIG=${ASH_ATLAS_CONTROLLER_CONFIG:-/etc/ash-atlas/deployment-controller.conf}
if [[ ${ASH_ATLAS_DEPLOY_CONTROL_TEST_MODE:-false} != true &&
      ${ASH_ATLAS_DEPLOY_SOURCE_ONLY:-false} != true &&
      ${ASH_ATLAS_CACHE_TEST_SOURCE_ONLY:-false} != true &&
      ${ASH_ATLAS_DEPLOY_UPDATE_SOURCE_ONLY:-false} != true ]]; then
  [[ -f "$CONTROLLER_CONFIG" && ! -L "$CONTROLLER_CONFIG" ]] ||
    { printf 'STOP: canonical deployment controller configuration is absent or unsafe\n' >&2; exit 1; }
  # shellcheck disable=SC1090,SC1091
  source "$CONTROLLER_CONFIG"
fi
readonly ENV_FILE=/etc/ash-atlas/game.env
readonly CADDY_FILE=/etc/caddy/Caddyfile
readonly CADDY_CACHE_POLICY=/etc/caddy/game-cache-policy.caddy
readonly CADDY_CACHE_IMPORT='import /etc/caddy/game-cache-policy.caddy'
readonly LOCK_FILE=${ASH_ATLAS_DEPLOY_LOCK_FILE:-${ASH_ATLAS_DEPLOY_LOCK:-/run/lock/ash-atlas-test-update.lock}}
readonly CACHE_ROOT=${ASH_ATLAS_CACHE_ROOT:-/var/cache/ash-atlas}
readonly PREFLIGHT_TEMPLATE_DATABASE=ash_atlas_preflight_template
# Parent of preflight migration stage directories (overridable only so tests avoid the real /tmp).
readonly PREFLIGHT_SNAPSHOT_PARENT=${ASH_ATLAS_PREFLIGHT_SNAPSHOT_PARENT:-/tmp}
readonly TIMING_ROOT=${ASH_ATLAS_TIMING_ROOT:-/var/log/ash-atlas/deployments}
readonly MIRROR_ROOT=${ASH_ATLAS_MIRROR_ROOT:-/home/debian/repos/game.git}
readonly WORKTREE_ROOT=${ASH_ATLAS_WORKTREE_ROOT:-/home/debian/worktrees}
readonly OPERATION_ROOT=${ASH_ATLAS_OPERATION_ROOT:-${ASH_ATLAS_CONTROL_ROOT:-/var/lib/ash-atlas/deploy-operations}}
readonly MIGRATION_INTENT_MARKER=${OPERATION_ROOT}/${OPERATION_ID}.migration-intent
readonly GAME_RELEASE_ROOT=${ASH_ATLAS_GAME_RELEASE_ROOT:-/srv/ash-atlas/game/releases}
readonly GAME_CURRENT_LINK=${ASH_ATLAS_GAME_CURRENT_LINK:-${ASH_ATLAS_GAME_CURRENT:-/srv/ash-atlas/game/current}}
readonly CLIENT_RELEASE_ROOT=${ASH_ATLAS_CLIENT_RELEASE_ROOT:-${ASH_ATLAS_PUBLIC_RELEASE_ROOT:-/srv/www/playashatlas/game-releases}}
readonly CLIENT_CURRENT_LINK=${ASH_ATLAS_CLIENT_CURRENT_LINK:-${ASH_ATLAS_PUBLIC_CURRENT:-/srv/www/playashatlas/current}}
readonly NATIVE_BUNDLE_ROOT=${ASH_ATLAS_NATIVE_BUNDLE_ROOT:-/srv/ash-atlas/native-bundles}
readonly NATIVE_PUBLIC_ROOT=${ASH_ATLAS_NATIVE_PUBLIC_ROOT:-/srv/www/playashatlas/native-bundles}
readonly WORLD_RUNTIME_RELEASE_ROOT=/srv/ash-atlas/world/runtime/releases
readonly WORLD_RUNTIME_CURRENT_LINK=/srv/ash-atlas/world/runtime/current
readonly WATERBODY_IDENTITY_OVERLAY_ROOT=/srv/ash-atlas/world/releases/$WATERBODY_IDENTITY_OVERLAY_RELEASE
readonly WORLD_UNIT=/etc/systemd/system/ash-atlas-world.service
readonly WORLD_OPS_UNIT=/home/debian/ops/ash-atlas-server/ash-atlas-world.service
# One inactive release (the newest) beside the active one; ACTIVATE also protects the exact
# previously live game/public releases, so the rollback target survives even when a newer
# failed candidate exists.
readonly INACTIVE_RELEASE_RETENTION=1
# Newest signed OTA bundles kept per platform in addition to every bundle the live pointer
# advertises (current + rollback previous) and every bundle a retained release references.
# One extra covers a prepared-but-not-yet-activated candidate; normally it is the current one.
readonly NATIVE_BUNDLE_RETENTION=1
# Newest content-addressed build/dependency cache entries kept per cache directory only when a
# retained release's build manifest cannot be mapped to its cache keys.
readonly BUILD_CACHE_UNMAPPED_RETENTION=2
# The migration rehearsal never copies Main's data: it clones the small migration-replayed
# template. Peak use is a template rebuild beside the clone plus replay WAL.
readonly CANDIDATE_REHEARSAL_SPACE_PERCENT=300
readonly CANDIDATE_REHEARSAL_SPACE_MARGIN_BYTES=$((1024 * 1024 * 1024))
# A pending migration with this exact line opts its release out of the all-or-nothing batch.
readonly MIGRATION_NON_TRANSACTIONAL_DIRECTIVE_PATTERN='--[[:space:]]*ash-atlas-migration:[[:space:]]*allow-non-transactional[[:space:]]*'
readonly CANDIDATE_PREFLIGHT_PORT=${ASH_ATLAS_CANDIDATE_PREFLIGHT_PORT:-30101}
readonly PREVIOUS_PREFLIGHT_PORT=${ASH_ATLAS_PREVIOUS_PREFLIGHT_PORT:-30102}
readonly -a PREFLIGHT_REQUIRED_EXTENSIONS=(postgis)
readonly DISCORD_PATCH_NOTES_ENV=/etc/ash-atlas/discord-patch-notes.env
readonly DISCORD_PATCH_NOTES_OUTBOX=/var/lib/ash-atlas/discord-patch-notes
declare -Ag CLIENT_ASSET_RETENTION=()

fail() {
  printf 'STOP: %s\n' "$*" >&2
  exit 1
}

activate_native_bundle_candidate() {
  [[ -f "$NATIVE_BUNDLE_ROOT/candidates/$GAME_SHA.json" ]] || return 0
  phase_start native_bundle_activation
  "$NODE_BIN" "$NATIVE_BUNDLE_ROOT/candidates/$GAME_SHA.mjs" activate \
    --game-sha "$GAME_SHA" --generation "$GAME_GENERATION" ||
    fail 'native bundle pointer activation failed'
  # Installed apps must be able to read the pointer: 200 (update offered) or 204 (OTA disabled).
  local platform status
  for platform in ios android; do
    status=$(curl --silent --max-time 20 --output /dev/null --write-out '%{http_code}' \
      "https://playashatlas.com/api/native/bundle?platform=$platform&shellBuild=8&bundle=deploy-probe")
    [[ "$status" = 200 || "$status" = 204 ]] ||
      fail "native bundle endpoint returned HTTP $status for $platform after pointer activation"
  done
  phase_finish
}

validate_release_mode() {
  [[ "$1" = active || "$1" = paused ]] ||
    fail 'release mode must be active or paused'
}

resolve_release_mode() {
  local source_root=$1
  local mode_path="$source_root/config/release-mode.json"
  local configured_mode=active mode_file_present=false
  if [[ -f "$mode_path" && ! -L "$mode_path" ]]; then
    mode_file_present=true
    configured_mode=$(
      "$NODE_BIN" - "$mode_path" <<'NODE'
const fs = require("node:fs");
const path = process.argv[2];
const config = JSON.parse(fs.readFileSync(path, "utf8"));
process.stdout.write(typeof config.mobile === "string" ? config.mobile : "");
NODE
    ) || fail 'release mode configuration could not be read'
    validate_release_mode "$configured_mode"
  fi
  if [[ -n "$RELEASE_MODE" ]]; then
    validate_release_mode "$RELEASE_MODE"
    [[ "$mode_file_present" = false || "$RELEASE_MODE" = "$configured_mode" ]] ||
      fail 'durable release mode differs from the exact candidate release configuration'
  else
    RELEASE_MODE=$configured_mode
  fi
  if [[ "$RELEASE_MODE" = paused ]]; then
    printf 'WARNING: web-only release mode is paused; mobile compatibility gates and activation intent are skipped; the mobile registry will not be read.\n' >&2
  fi
}

operation_receipt_update() {
  [[ -n "$OPERATION_RECEIPT" ]] || return 0
  /usr/bin/node - "$OPERATION_RECEIPT" "$$" "$@" <<'NODE'
const fs = require("node:fs");
const [path, producerPid] = process.argv.slice(2, 4);
const pairs = process.argv.slice(4);
const receipt = JSON.parse(fs.readFileSync(path, "utf8"));
const previousPhase = typeof receipt.current_phase === "string" ? receipt.current_phase : "unknown";
for (let index = 0; index < pairs.length; index += 2) {
  const key = pairs[index];
  const raw = pairs[index + 1];
  if (raw === "__NULL__") receipt[key] = null;
  else if (raw === "__TRUE__") receipt[key] = true;
  else if (raw === "__FALSE__") receipt[key] = false;
  else if (raw.startsWith("__NUMBER__")) receipt[key] = Number(raw.slice(10));
  else if (raw.startsWith("__JSON__")) receipt[key] = JSON.parse(raw.slice(8));
  else receipt[key] = raw;
}
const nextPhase = typeof receipt.current_phase === "string" ? receipt.current_phase : "unknown";
if (nextPhase !== previousPhase) {
  const timestamp = new Date();
  const history = Array.isArray(receipt.state_transitions) ? receipt.state_transitions : [];
  const previousTimestamp = history.length > 0 ? Date.parse(history[history.length - 1].timestamp_utc) : NaN;
  history.push({
    timestamp_utc: timestamp.toISOString(),
    operation_id: receipt.operation_id,
    previous_state: previousPhase,
    next_state: nextPhase,
    elapsed_previous_state_ms: Number.isFinite(previousTimestamp) ?
      Math.max(0, timestamp.getTime() - previousTimestamp) : 0,
    reason: "updater_phase_started",
    process_pid: Number(producerPid),
    scope: "remote_updater"
  });
  receipt.state_transitions = history.slice(-256);
}
const temporary = `${path}.${process.pid}.tmp`;
let file;
try {
  file = fs.openSync(temporary, "wx", 0o640);
  fs.writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`);
  fs.fsyncSync(file);
  fs.closeSync(file);
  file = undefined;
  fs.chmodSync(temporary, 0o640);
  fs.renameSync(temporary, path);
  const directory = fs.openSync(require("node:path").dirname(path), "r");
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  JSON.parse(fs.readFileSync(path, "utf8"));
} catch (error) {
  if (file !== undefined) {
    try { fs.closeSync(file); } catch {}
  }
  try { fs.rmSync(temporary, { force: true }); } catch {}
  throw error;
}
NODE
  if [[ -n "$OPERATION_STATUS_PUBLISHER" ]] &&
      ! "$OPERATION_STATUS_PUBLISHER" publish "$OPERATION_ID"; then
    printf 'WARNING: deployment HTTPS status could not be published for %s\n' "$OPERATION_ID" >&2
  fi
}

operation_receipt_field() {
  local field=$1
  [[ -n "$OPERATION_RECEIPT" && -f "$OPERATION_RECEIPT" && ! -L "$OPERATION_RECEIPT" ]] ||
    fail 'authoritative operation receipt is absent or unsafe'
  /usr/bin/node - "$OPERATION_RECEIPT" "$field" <<'NODE'
const fs = require("node:fs");
const [path, field] = process.argv.slice(2);
const value = JSON.parse(fs.readFileSync(path, "utf8"))[field];
if (!["string", "boolean", "number"].includes(typeof value)) process.exit(2);
process.stdout.write(String(value));
NODE
}

recovery_cache_policy_matches_audit() {
  local receipt=$1 audit=$2 installed_policy=$3 operation=$4 target=$5
  [[ -f "$receipt" && ! -L "$receipt" && -f "$audit" && ! -L "$audit" &&
     -f "$installed_policy" && ! -L "$installed_policy" ]] || return 1
  "$NODE_BIN" - "$receipt" "$audit" "$installed_policy" "$operation" "$target" <<'NODE'
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const [receiptPath, auditPath, policyPath, operation, target] = process.argv.slice(2);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
const auditBytes = fs.readFileSync(auditPath);
const audit = JSON.parse(auditBytes);
const policyHash = sha(fs.readFileSync(policyPath));
if (receipt.operation_id !== operation || receipt.requested_action !== 'prepare' ||
    receipt.requested_target_sha !== target || receipt.recovery_audit_path !== auditPath ||
    receipt.recovery_audit_sha256 !== sha(auditBytes) ||
    receipt.recovery_cache_policy_sha256 !== policyHash ||
    audit.operation_id !== operation || audit.target_sha !== target ||
    audit.recovery_updater_sha256 !== receipt.updater_hash ||
    audit.proof?.installed_cache_policy_sha256 !== policyHash ||
    audit.failed_receipt?.operation_id !== operation ||
    audit.failed_receipt?.result !== 'failed' ||
    audit.failed_receipt?.current_phase !== 'artifact_hashing') process.exit(1);
NODE
}

migration_rollback_requires_safe_stop() {
  local command_started=$1
  local receipt_completed=$2
  local prior_binary_safe=$3
  local marker_present=$4
  if [[ "$command_started" != true && "$marker_present" != true ]]; then
    return 1
  fi
  [[ "$receipt_completed" != true || "$prior_binary_safe" != true ]]
}

prepared_receipt_hash() {
  printf '%s\n' "$@" | sha256sum | cut -d' ' -f1
}

immutable_release_hash() {
  local root=$1
  [[ -d "$root" && ! -L "$root" ]] || fail 'immutable release hash target is unsafe'
  tar --sort=name --mtime='UTC 1970-01-01' --owner=0 --group=0 --numeric-owner \
    -C "$root" -cf - . | sha256sum | cut -d' ' -f1
}

artifact_content_hash() {
  local root=$1
  [[ -d "$root" && ! -L "$root" ]] || fail 'artifact content hash target is unsafe'
  tar --sort=name --mtime='UTC 1970-01-01' --owner=0 --group=0 --numeric-owner \
    --mode='u=rwX,go=rX' -C "$root" -cf - . | sha256sum | cut -d' ' -f1
}

prepared_fence_reuse_allowed() {
  [[ "$1" = client_only || "$1" = server_no_migration ]]
}

assert_root_owned_nonwritable_path() {
  local path=$1 mode
  [[ -e "$path" && ! -L "$path" ]] || fail 'prepared fence path is absent or unsafe'
  [[ $(stat -c '%u' "$path") = 0 ]] || fail 'prepared fence path is not root-owned'
  mode=$(stat -c '%a' "$path")
  [[ "$mode" =~ ^[0-7]{3,4}$ ]] || fail 'prepared fence path mode is unsafe'
  (( (8#$mode & 0022) == 0 )) || fail 'prepared fence path is group- or other-writable'
}

metadata_fence_for_paths() {
  (( $# > 0 )) || fail 'prepared metadata fence has no paths'
  local path
  {
    for path in "$@"; do
      assert_root_owned_nonwritable_path "$path"
      stat -c '%d:%i:%s:%u:%g:%a:%y:%z:%n' "$path"
    done
  } | LC_ALL=C sort | sha256sum | cut -d' ' -f1
}

static_artifact_metadata_fence() {
  metadata_fence_for_paths \
    "$(dirname "$WATER_VISUAL_TILES_ROOT")" \
    "$WATER_VISUAL_TILES_ROOT" "$WATER_VISUAL_TILES_PATH"
}

validate_river_surface_target_root() {
  local manifest="$RIVER_SURFACE_TARGET_ROOT/manifest.json"
  [[ "$RIVER_SURFACE_TARGET_ROOT_TOKEN" = "$RIVER_SURFACE_RELEASE--sha256-$RIVER_SURFACE_MANIFEST_SHA256" ]] ||
    fail 'river surface target root token does not match its logical release and manifest'
  [[ "$RIVER_SURFACE_TARGET_ROOT" = "/srv/ash-atlas/world/releases/$RIVER_SURFACE_TARGET_ROOT_TOKEN" ]] ||
    fail 'river surface target root is outside the World release root'
  [[ -d "$RIVER_SURFACE_TARGET_ROOT" && ! -L "$RIVER_SURFACE_TARGET_ROOT" ]] ||
    fail 'target river surface release root is absent or unsafe'
  [[ $(realpath -e -- "$RIVER_SURFACE_TARGET_ROOT") = "$RIVER_SURFACE_TARGET_ROOT" ]] ||
    fail 'target river surface release root cannot be resolved safely'
  [[ -f "$manifest" && ! -L "$manifest" ]] ||
    fail 'target river surface manifest is absent or unsafe'
  [[ $(sha256sum "$manifest" | cut -d' ' -f1) = "$RIVER_SURFACE_MANIFEST_SHA256" ]] ||
    fail 'target river surface manifest hash differs'
  "$NODE_BIN" - "$manifest" "$RIVER_SURFACE_RELEASE" "$RIVER_SURFACE_POLICY" <<'NODE'
const fs = require("node:fs");
const [path, releaseId, policy] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(path, "utf8"));
if (manifest?.release_id !== releaseId || manifest?.policy !== policy) process.exit(1);
NODE
}

static_artifact_integrity_identity() {
  printf '%s\n' \
    static-integrity-cache-v1 \
    "$WATER_VISUAL_TILES_RELEASE" "$WATER_VISUAL_TILES_ARTIFACT_SIZE" "$WATER_VISUAL_TILES_ARTIFACT_SHA256" |
    sha256sum | cut -d' ' -f1
}

static_artifact_integrity_cache_hit() {
  local expected_identity=$1
  local metadata_fence=$2
  local receipt="$CACHE_ROOT/static-integrity/verified-v1"
  local mode owner cached_identity cached_fence extra
  [[ -f "$receipt" && ! -L "$receipt" ]] || return 1
  owner=$(stat -c '%u:%g' "$receipt")
  mode=$(stat -c '%a' "$receipt")
  [[ "$owner" = 0:0 && "$mode" =~ ^[0-7]{3,4}$ ]] || return 1
  (( (8#$mode & 0022) == 0 )) || return 1
  IFS=$'\t' read -r cached_identity cached_fence extra < "$receipt" || return 1
  [[ -z "$extra" && "$cached_identity" =~ ^[0-9a-f]{64}$ &&
     "$cached_fence" =~ ^[0-9a-f]{64}$ &&
     "$cached_identity" = "$expected_identity" && "$cached_fence" = "$metadata_fence" ]]
}

write_static_artifact_integrity_cache() {
  local expected_identity=$1
  local metadata_fence=$2
  local receipt="$CACHE_ROOT/static-integrity/verified-v1"
  local temporary
  temporary=$(mktemp "$CACHE_ROOT/static-integrity/.verified-v1.XXXXXXXX")
  printf '%s\t%s\n' "$expected_identity" "$metadata_fence" > "$temporary"
  chown root:root "$temporary"
  chmod 0440 "$temporary"
  sync -f "$temporary"
  mv -fT -- "$temporary" "$receipt"
  sync -f "$CACHE_ROOT/static-integrity"
  static_artifact_integrity_cache_hit "$expected_identity" "$metadata_fence" ||
    fail 'static artifact integrity cache receipt could not be verified'
}

immutable_release_metadata_fence() {
  (( $# > 0 )) || fail 'prepared release metadata fence has no roots'
  local root unsafe
  {
    for root in "$@"; do
      assert_root_owned_nonwritable_path "$root"
      unsafe=$(find -P "$root" -xdev ! -uid 0 -print -quit)
      [[ -z "$unsafe" ]] || fail 'prepared release tree contains a non-root-owned entry'
      unsafe=$(find -P "$root" -xdev \( -type d -o -type f \) -perm /022 -print -quit)
      [[ -z "$unsafe" ]] || fail 'prepared release tree contains a writable entry'
      find -P "$root" -xdev -printf '%D:%i:%s:%U:%G:%m:%y:%T@:%C@:%p:%l\0'
    done
  } | LC_ALL=C sort -z | sha256sum | cut -d' ' -f1
}

phase_start() {
  PHASE_NAME=$1
  PHASE_STARTED_NS=$(date +%s%N)
  PHASE_STARTED_UTC=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  operation_receipt_update current_phase "$PHASE_NAME"
}

phase_finish() {
  local result=${1:-completed}
  local finished_ns duration_ms finished_utc
  finished_ns=$(date +%s%N)
  finished_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  duration_ms=$(( (finished_ns - PHASE_STARTED_NS) / 1000000 ))
  printf '%s\t%s\t%s\t%s\t%s\n' \
    "$PHASE_NAME" "$PHASE_STARTED_UTC" "$finished_utc" "$duration_ms" "$result" >> "$TIMING_TSV"
  printf 'PHASE %s: %s ms (%s)\n' "$PHASE_NAME" "$duration_ms" "$result"
}

confirm_game_worker_stopped() {
  local state main_pid
  state=$(systemctl show ash-atlas.service --property=ActiveState --value)
  main_pid=$(systemctl show ash-atlas.service --property=MainPID --value)
  [[ "$main_pid" = 0 ]] || fail 'old game worker still has a MainPID before activation'
  if [[ "$state" = failed ]]; then
    systemctl reset-failed ash-atlas.service ||
      fail 'old game worker failed state could not be reset before activation'
    state=$(systemctl show ash-atlas.service --property=ActiveState --value)
  fi
  [[ "$state" = inactive ]] ||
    fail "old game worker is not fully stopped before activation (state=$state)"
  [[ $(systemctl show ash-atlas.service --property=MainPID --value) = 0 ]] ||
    fail 'old game worker regained a MainPID before activation'
}

stop_preflight_process() {
  local process_pid attempt
  if [[ -n ${PREFLIGHT_PROCESS_PID:-} ]]; then
    process_pid=$PREFLIGHT_PROCESS_PID
    kill "$process_pid" 2>/dev/null || true
    for attempt in $(seq 1 20); do
      kill -0 "$process_pid" 2>/dev/null || break
      sleep 0.1
    done
    kill -9 "$process_pid" 2>/dev/null || true
    wait "$process_pid" 2>/dev/null || true
    ! kill -0 "$process_pid" 2>/dev/null || return 1
    PREFLIGHT_PROCESS_PID=
  fi
}

assert_preflight_database_absent() {
  local present
  present=$(sudo -u postgres psql --dbname=postgres --no-align --tuples-only \
    --command="SELECT 1 FROM pg_database WHERE datname = '$PREFLIGHT_DATABASE'") || return 1
  [[ -z "$present" ]]
}

cleanup_release_preflight() {
  local result=0
  stop_preflight_process
  [[ -n ${PREFLIGHT_READY_BODY:-} ]] && rm -f "$PREFLIGHT_READY_BODY"
  if [[ ${PREFLIGHT_DATABASE_CREATED:-false} = true ]]; then
    sudo -u postgres dropdb --if-exists --force "$PREFLIGHT_DATABASE" || result=1
    assert_preflight_database_absent || result=1
    PREFLIGHT_DATABASE_CREATED=false
  fi
  if [[ -n ${PREFLIGHT_MIGRATIONS_STAGE:-} ]]; then
    if [[ "$PREFLIGHT_MIGRATIONS_STAGE" =~ ^"$PREFLIGHT_SNAPSHOT_PARENT"/ash-atlas-preflight-[0-9a-f]{8}\.[A-Za-z0-9]{8}$ &&
          -d "$PREFLIGHT_MIGRATIONS_STAGE" && ! -L "$PREFLIGHT_MIGRATIONS_STAGE" ]]; then
      rm -rf --one-file-system -- "$PREFLIGHT_MIGRATIONS_STAGE" || result=1
      PREFLIGHT_MIGRATIONS_STAGE=
    else
      printf 'WARNING: refusing unsafe preflight migration stage cleanup: %s\n' \
        "$PREFLIGHT_MIGRATIONS_STAGE" >&2
      result=1
    fi
  fi
  return "$result"
}

candidate_rehearsal_source_bytes() {
  sudo -u postgres psql --dbname=postgres --no-align --tuples-only \
    --command="SELECT COALESCE(sum(pg_database_size(datname)), 0) FROM pg_database WHERE datname = '$PREFLIGHT_TEMPLATE_DATABASE'"
}

candidate_rehearsal_data_directory() {
  sudo -u postgres psql --dbname=postgres --no-align --tuples-only \
    --command='SHOW data_directory'
}

filesystem_available_bytes() {
  df -B1 --output=avail -- "$1" | tail -n 1 | tr -d '[:space:]'
}

# Sized from the schema-only rehearsal template, never from Main's data.
assert_candidate_rehearsal_disk_space() {
  local source_bytes data_directory available required
  source_bytes=$(candidate_rehearsal_source_bytes) ||
    fail 'candidate rehearsal disk preflight could not measure the rehearsal template'
  [[ "$source_bytes" =~ ^[0-9]+$ ]] ||
    fail 'candidate rehearsal disk preflight measured an invalid rehearsal template size'
  data_directory=$(candidate_rehearsal_data_directory) ||
    fail 'candidate rehearsal disk preflight could not locate the PostgreSQL data directory'
  [[ "$data_directory" = /* && -d "$data_directory" ]] ||
    fail "candidate rehearsal disk preflight found an invalid PostgreSQL data directory: $data_directory"
  available=$(filesystem_available_bytes "$data_directory") ||
    fail "candidate rehearsal disk preflight could not read free space for $data_directory"
  [[ "$available" =~ ^[0-9]+$ ]] ||
    fail 'candidate rehearsal disk preflight read an invalid free-space value'
  required=$((source_bytes * CANDIDATE_REHEARSAL_SPACE_PERCENT / 100 + CANDIDATE_REHEARSAL_SPACE_MARGIN_BYTES))
  printf 'Candidate rehearsal disk preflight: required=%s available=%s data_directory=%s\n' \
    "$required" "$available" "$data_directory"
  (( available >= required )) ||
    fail "insufficient disk for the candidate schema rehearsal: need $((required / 1048576)) MiB free on the PostgreSQL filesystem ($data_directory), only $((available / 1048576)) MiB available; free disk space before retrying"
}

pending_migration_versions() {
  LC_ALL=C comm -23 <(cut -f1 "$MIGRATION_CANDIDATES" | LC_ALL=C sort) \
    <(cut -f1 "$MIGRATION_APPLIED" | LC_ALL=C sort)
}

# Pending migrations run in one all-or-nothing transaction unless one of them opts out in-file.
select_migration_transaction_mode() {
  local version file
  [[ -f "$GAME_RELEASE/apps/server/src/db/migrate.ts" ]] &&
    grep -Fq 'MIGRATION_TRANSACTION' "$GAME_RELEASE/apps/server/src/db/migrate.ts" ||
    fail 'candidate migration runner lacks all-or-nothing batch support'
  MIGRATION_TRANSACTION_MODE=batch
  while IFS= read -r version; do
    [[ -n "$version" ]] || continue
    [[ "$version" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*\.sql$ ]] || fail 'pending migration name is unsafe'
    file="$GAME_RELEASE/db/migrations/$version"
    [[ -f "$file" && ! -L "$file" ]] || fail "pending migration is absent from the candidate: $version"
    if grep -Eqx -- "$MIGRATION_NON_TRANSACTIONAL_DIRECTIVE_PATTERN" "$file"; then
      printf 'Pending migration %s opts out of the all-or-nothing batch\n' "$version"
      MIGRATION_TRANSACTION_MODE=per_file
    fi
  done < <(pending_migration_versions)
}

# The rehearsal template must hold exactly Main's applied ledger, so it is replayed from a copy of
# only those candidate files; pending migrations are then rehearsed on a clone of it.
stage_applied_migrations() {
  local version hash source
  PREFLIGHT_MIGRATIONS_STAGE=$(mktemp -d "$PREFLIGHT_SNAPSHOT_PARENT/ash-atlas-preflight-${SHORT_SHA}.XXXXXXXX")
  chmod 0755 "$PREFLIGHT_MIGRATIONS_STAGE"
  while IFS=$'\t' read -r version hash; do
    [[ -n "$version" ]] || continue
    [[ "$version" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*\.sql$ && "$hash" =~ ^[0-9a-f]{64}$ ]] ||
      fail 'applied migration ledger entry is unsafe'
    source="$GAME_RELEASE/db/migrations/$version"
    [[ -f "$source" && ! -L "$source" && $(sha256sum "$source" | cut -d' ' -f1) = "$hash" ]] ||
      fail "candidate migration differs from the applied ledger: $version"
    install -m 0644 -- "$source" "$PREFLIGHT_MIGRATIONS_STAGE/$version"
  done < "$MIGRATION_APPLIED"
}

database_url_for() {
  local database=$1
  sudo -u ash-atlas env PREFLIGHT_DATABASE="$database" bash -c '
    set -a
    # shellcheck disable=SC1090
    source "$1"
    set +a
    /usr/bin/node -e "
      const url = new URL(process.env.DATABASE_URL);
      url.pathname = \`/\${process.env.PREFLIGHT_DATABASE}\`;
      process.stdout.write(url.toString());
    "
  ' -- "$ENV_FILE"
}

candidate_database_strategy_for_class() {
  case "$1" in
    # A migration is rehearsed on a clone of the migration-replayed template (schema plus
    # migration-seeded rows, no player data); Main's data is never copied for a rehearsal.
    server_no_migration|release_tooling|database_migration) printf 'fresh_migration_replay\n' ;;
    client_only) printf 'none\n' ;;
    *) fail 'release class cannot select a candidate database strategy' ;;
  esac
}

provision_fresh_preflight_extensions() {
  local database=${1:-$PREFLIGHT_DATABASE}
  local extension installed expected
  for extension in "${PREFLIGHT_REQUIRED_EXTENSIONS[@]}"; do
    [[ "$extension" =~ ^[a-z][a-z0-9_]*$ ]] || fail 'required extension identity is unsafe'
    sudo -u postgres psql --dbname="$database" --set=ON_ERROR_STOP=1 \
      --command="CREATE EXTENSION IF NOT EXISTS \"$extension\""
  done
  installed=$(sudo -u postgres psql --dbname="$database" --no-align --tuples-only \
    --command="SELECT extname FROM pg_extension WHERE extname <> 'plpgsql' ORDER BY extname")
  expected=$(printf '%s\n' "${PREFLIGHT_REQUIRED_EXTENSIONS[@]}")
  [[ "$installed" = "$expected" ]] || fail 'candidate database extension set differs'
}

verify_preflight_service_role() {
  local role_flags
  role_flags=$(sudo -u postgres psql --dbname=postgres --no-align --tuples-only \
    --field-separator='|' \
    --command="SELECT rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = '$PREFLIGHT_DATABASE_USER'")
  [[ "$role_flags" = 'f|f|f' ]] ||
    fail 'candidate database service role has elevated PostgreSQL privileges'
}

replay_fresh_preflight_migrations() {
  sudo -u ash-atlas env HOME=/var/lib/ash-atlas DATABASE_URL="$PREFLIGHT_DATABASE_URL" \
    MIGRATION_TRANSACTION="${MIGRATION_TRANSACTION_MODE:-per_file}" \
    bash -c "cd '$GAME_RELEASE'; /usr/bin/node node_modules/tsx/dist/cli.mjs apps/server/src/db/migrate.ts"
}

preflight_template_matches_ledger() {
  local ledger_hash=$1 marker actual_marker installed expected
  marker="ash-atlas-preflight-ledger-sha256:$ledger_hash"
  actual_marker=$(sudo -u postgres psql --dbname=postgres --no-align --tuples-only \
    --command="SELECT COALESCE(shobj_description(oid, 'pg_database'), '') FROM pg_database WHERE datname = '$PREFLIGHT_TEMPLATE_DATABASE'" 2>/dev/null) || return 1
  [[ "$actual_marker" = "$marker" ]] || return 1
  sudo -u postgres psql --dbname="$PREFLIGHT_TEMPLATE_DATABASE" --no-align --tuples-only \
    --field-separator=$'\t' \
    --command='SELECT version, content_sha256 FROM schema_migrations ORDER BY version' \
    > "$PREFLIGHT_MIGRATION_LEDGER" 2>/dev/null || return 1
  cmp -s "$MIGRATION_APPLIED" "$PREFLIGHT_MIGRATION_LEDGER" || return 1
  installed=$(sudo -u postgres psql --dbname="$PREFLIGHT_TEMPLATE_DATABASE" --no-align --tuples-only \
    --command="SELECT extname FROM pg_extension WHERE extname <> 'plpgsql' ORDER BY extname" 2>/dev/null) || return 1
  expected=$(printf '%s\n' "${PREFLIGHT_REQUIRED_EXTENSIONS[@]}")
  [[ "$installed" = "$expected" ]]
}

ensure_fresh_preflight_template() {
  local ledger_hash=$1 template_url
  if preflight_template_matches_ledger "$ledger_hash"; then
    PREFLIGHT_TEMPLATE_RESULT=hit
    return
  fi
  PREFLIGHT_TEMPLATE_RESULT=rebuilt
  sudo -u postgres dropdb --if-exists --force "$PREFLIGHT_TEMPLATE_DATABASE"
  sudo -u postgres createdb --owner="$PREFLIGHT_DATABASE_USER" "$PREFLIGHT_TEMPLATE_DATABASE"
  provision_fresh_preflight_extensions "$PREFLIGHT_TEMPLATE_DATABASE"
  template_url=$(database_url_for "$PREFLIGHT_TEMPLATE_DATABASE")
  stage_applied_migrations
  sudo -u ash-atlas env HOME=/var/lib/ash-atlas DATABASE_URL="$template_url" \
    MIGRATIONS_DIRECTORY="$PREFLIGHT_MIGRATIONS_STAGE" \
    bash -c "cd '$GAME_RELEASE'; /usr/bin/node node_modules/tsx/dist/cli.mjs apps/server/src/db/migrate.ts"
  sudo -u postgres psql --dbname=postgres --set=ON_ERROR_STOP=1 \
    --command="COMMENT ON DATABASE \"$PREFLIGHT_TEMPLATE_DATABASE\" IS 'ash-atlas-preflight-ledger-sha256:$ledger_hash'"
  # Pending migrations must reach the template only through the rehearsal, never the rebuild.
  preflight_template_matches_ledger "$ledger_hash" ||
    fail 'rebuilt preflight template ledger differs from Main'
}

run_population_repair_admission() {
  local database_url=${1:-}
  local result affected_plan_count
  if [[ -n "$database_url" ]]; then
    result=$(sudo -u ash-atlas env HOME=/var/lib/ash-atlas \
      DATABASE_URL="$database_url" TELEMETRY_ENABLED=false BUG_REPORTS_ENABLED=false \
      bash -c "cd '$GAME_RELEASE'; /usr/bin/node node_modules/tsx/dist/cli.mjs apps/server/src/game/populationStoneConflictRepair.ts") ||
      fail 'candidate population repair admission could not inspect the disposable database'
  else
    result=$(sudo -u ash-atlas env HOME=/var/lib/ash-atlas bash -c \
      "set -a; . '$ENV_FILE'; set +a; export TELEMETRY_ENABLED=false BUG_REPORTS_ENABLED=false; cd '$GAME_RELEASE'; /usr/bin/node node_modules/tsx/dist/cli.mjs apps/server/src/game/populationStoneConflictRepair.ts") ||
      fail 'candidate population repair admission could not inspect Main'
  fi
  affected_plan_count=$(printf '%s' "$result" | /usr/bin/node -e '
    const fs = require("node:fs");
    const result = JSON.parse(fs.readFileSync(0, "utf8"));
    const plans = result?.receipt?.affectedPlans;
    if (result?.mode !== "dry-run" || !Array.isArray(plans)) process.exit(2);
    process.stdout.write(String(plans.length));
  ') || fail 'candidate population repair admission returned an invalid receipt'
  [[ "$affected_plan_count" =~ ^[0-9]+$ ]] ||
    fail 'candidate population repair admission returned an unsafe count'
  (( affected_plan_count == 0 )) ||
    fail "candidate found $affected_plan_count safely repairable terminal population plans; apply the guarded population repair before deployment"
  POPULATION_REPAIR_ADMISSION_COUNT=$affected_plan_count
}

verify_fresh_preflight_migration_ledger() {
  sudo -u ash-atlas env DATABASE_URL="$PREFLIGHT_DATABASE_URL" bash -c '
    psql "$DATABASE_URL" --no-align --tuples-only --field-separator=$'"'"'\t'"'"' \
      --command="SELECT version, content_sha256 FROM schema_migrations ORDER BY version"
  ' > "$PREFLIGHT_MIGRATION_LEDGER"
  /usr/bin/node - "$MIGRATION_CANDIDATES" "$PREFLIGHT_MIGRATION_LEDGER" <<'NODE'
const fs = require("node:fs");
const parse = (path) => new Map(fs.readFileSync(path, "utf8").trim().split(/\n/)
  .filter(Boolean).map((line) => line.split("\t")));
const expected = parse(process.argv[2]);
const actual = parse(process.argv[3]);
if (expected.size !== actual.size) process.exit(2);
for (const [version, hash] of expected) {
  if (!hash || actual.get(version) !== hash) process.exit(2);
}
NODE
}

start_release_preflight() {
  local release=$1
  local sha=$2
  local port=$3
  local log=$4
  local label=$5
  local attempt
  if ss -H -ltn "( sport = :$port )" | grep -q .; then
    printf '%s preflight port %s is already in use\n' "$label" "$port" >> "$log"
    return 1
  fi
  PREFLIGHT_READY_BODY=$(mktemp "$TIMING_ROOT/${OPERATION_ID}.${label}.ready.XXXXXX.json")
  sudo -u ash-atlas env HOME=/var/lib/ash-atlas \
    PREFLIGHT_DATABASE_URL="$PREFLIGHT_DATABASE_URL" \
    PREFLIGHT_PORT="$port" PREFLIGHT_SHA="$sha" \
    bash -c '
      set -a
      # shellcheck disable=SC1090
      source "$1"
      set +a
      export DATABASE_URL="$PREFLIGHT_DATABASE_URL"
      export PORT="$PREFLIGHT_PORT"
      export RUNTIME_SHA="$PREFLIGHT_SHA"
      export TELEMETRY_ENABLED=false
      export BUG_REPORTS_ENABLED=false
      cd "$2"
      exec /usr/bin/node apps/server/dist/index.js
    ' -- "$ENV_FILE" "$release" >"$log" 2>&1 &
  PREFLIGHT_PROCESS_PID=$!
  for attempt in $(seq 1 60); do
    if ! kill -0 "$PREFLIGHT_PROCESS_PID" 2>/dev/null; then
      stop_preflight_process
      rm -f "$PREFLIGHT_READY_BODY"
      PREFLIGHT_READY_BODY=
      return 1
    fi
    if curl --fail --silent --show-error --max-time 2 \
        "http://127.0.0.1:$port/ready" > "$PREFLIGHT_READY_BODY" 2>/dev/null &&
        /usr/bin/node -e '
          const fs = require("node:fs");
          const [path, sha] = process.argv.slice(1);
          const ready = JSON.parse(fs.readFileSync(path, "utf8"));
          if (ready.status !== "ready" ||
              ready.checks?.database?.ok !== true ||
              ready.checks?.runtimeIdentity?.identity?.sha !== sha) process.exit(1);
    ' "$PREFLIGHT_READY_BODY" "$sha"; then
      stop_preflight_process
      rm -f "$PREFLIGHT_READY_BODY"
      PREFLIGHT_READY_BODY=
      return 0
    fi
    sleep 1
  done
  stop_preflight_process
  rm -f "$PREFLIGHT_READY_BODY"
  PREFLIGHT_READY_BODY=
  return 1
}

record_phase() {
  local name=$1
  local started_ns=$2
  local result=${3:-completed}
  local finished_ns duration_ms
  finished_ns=$(date +%s%N)
  duration_ms=$(( (finished_ns - started_ns) / 1000000 ))
  printf '%s\t%s\t%s\t%s\t%s\n' \
    "$name" "$(date -u -d "@$((started_ns / 1000000000))" +%Y-%m-%dT%H:%M:%SZ)" \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$duration_ms" "$result" >> "$TIMING_TSV"
  printf 'PHASE %s: %s ms (%s)\n' "$name" "$duration_ms" "$result"
}

write_timing_json() {
  local status=$1
  "$NODE_BIN" - "$TIMING_TSV" "$TIMING_JSON" "$GAME_SHA" "$status" "$DEPLOY_STARTED_NS" \
    "${DEPLOYMENT_LANE:-unknown}" "${MIGRATION_REQUIRED:-unknown}" "$DEPLOY_MODE" \
    "$OPERATION_ID" <<'NODE'
const fs = require("node:fs");
const [tsv, target, sha, status, startedNs, lane, migrationRequired, action, operationId] =
  process.argv.slice(2);
const startedAt = new Date(Number(BigInt(startedNs) / 1000000n));
const finishedAt = new Date();
const phases = fs.readFileSync(tsv, "utf8").trim().split(/\n/).filter(Boolean).map((line) => {
  const [phase, started_at_utc, finished_at_utc, duration_ms, result] = line.split("\t");
  return { action, phase, started_at_utc, finished_at_utc, duration_ms: Number(duration_ms), result };
});
let previous = null;
if (fs.existsSync(target)) {
  previous = JSON.parse(fs.readFileSync(target, "utf8"));
  if (![1, 2].includes(previous.schema_version) ||
      previous.game_sha !== sha ||
      (previous.operation_id && previous.operation_id !== operationId)) {
    throw new Error("existing deployment timings belong to a different immutable operation");
  }
}
const previousPhases = previous?.phases ?? [];
const previousRuns = previous?.runs ?? [];
const firstStartedAt = previous?.started_at_utc ?? startedAt.toISOString();
const runs = previousRuns.concat({
  action,
  status,
  started_at_utc: startedAt.toISOString(),
  finished_at_utc: finishedAt.toISOString(),
  duration_ms: finishedAt.getTime() - startedAt.getTime()
});
const value = {
  schema_version: 2,
  operation_id: operationId,
  game_sha: sha,
  status,
  deployment_lane: lane,
  migration_required: migrationRequired === "true",
  phases: previousPhases.concat(phases),
  runs,
  started_at_utc: firstStartedAt,
  active_duration_ms: runs.reduce((sum, run) => sum + run.duration_ms, 0),
  total_duration_ms: finishedAt.getTime() - new Date(firstStartedAt).getTime(),
  finished_at_utc: finishedAt.toISOString()
};
const temporary = `${target}.${process.pid}.tmp`;
fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o640 });
fs.renameSync(temporary, target);
NODE
}

classify_changed_paths() {
  local saw_client=false
  local saw_application=false
  local saw_migration=false
  local saw_full=false
  local saw_metadata=false
  local path
  (( $# > 0 )) || {
    printf 'full\n'
    return
  }
  for path in "$@"; do
    case "$path" in
      # Markdown documentation are not deployed runtime inputs.
      # A metadata-only commit uses the client-only release path and reuses exact artifacts.
      *.md|docs/*)
        saw_metadata=true
        ;;
      tools/release/release-flow.tests.ps1|tools/release/vps/*.tests.sh)
        ;;
      tools/release/vps/game-cache-policy.caddy)
        saw_client=true
        ;;
      # Release tooling runs from the trusted installed copy, not the candidate build, so it
      # is not a deployed runtime input and never triggers the database rehearsal.
      tools/release/*|tools/mobile-release/*|tools/dev/*|.github/*)
        saw_metadata=true
        ;;
      apps/client/src/*|apps/client/public/*|apps/client/index.html)
        saw_client=true
        ;;
      apps/server/src/db/migrate.ts|db/migrations/*)
        saw_migration=true
        ;;
      apps/server/src/*|packages/shared/src/*)
        saw_application=true
        ;;
      package.json|pnpm-lock.yaml|pnpm-workspace.yaml|*/package.json|*/tsconfig*.json|tsconfig*.json|\
      vite.config.*|*/vite.config.*|*esbuild*|tools/release/*|.github/workflows/*|config/*|\
      Dockerfile|docker-compose*.yml|docker-compose*.yaml|*.env|*.service)
        saw_full=true
        ;;
      *)
        saw_full=true
        ;;
    esac
  done
  if [[ "$saw_full" = true ]]; then printf 'full\n'
  elif [[ "$saw_migration" = true ]]; then printf 'migration\n'
  elif [[ "$saw_application" = true ]]; then printf 'application\n'
  elif [[ "$saw_client" = true || "$saw_metadata" = true ]]; then printf 'client\n'
  else printf 'full\n'
  fi
}

release_class_for_lane() {
  local lane=$1
  local migration_required=$2
  if [[ "$migration_required" = true ]]; then printf 'database_migration\n'
  else
    case "$lane" in
      client) printf 'client_only\n' ;;
      application) printf 'server_no_migration\n' ;;
      migration) printf 'database_migration\n' ;;
      full) printf 'release_tooling\n' ;;
      *) fail 'release lane cannot be mapped to a release class' ;;
    esac
  fi
}

server_activation_required() {
  [[ "$1" != client_only ]]
}

capture_game_process_identity() {
  CAPTURED_GAME_MAIN_PID=$(systemctl show ash-atlas.service --property MainPID --value)
  CAPTURED_GAME_START_TIMESTAMP_MONOTONIC=$(systemctl show ash-atlas.service \
    --property ExecMainStartTimestampMonotonic --value)
  [[ "$CAPTURED_GAME_MAIN_PID" =~ ^[1-9][0-9]*$ &&
      "$CAPTURED_GAME_START_TIMESTAMP_MONOTONIC" =~ ^[1-9][0-9]*$ ]] ||
    fail 'game service process identity is unavailable or unsafe'
}

changed_paths_hash() {
  if (( $# == 0 )); then printf '' | sha256sum | cut -d' ' -f1
  else printf '%s\0' "$@" | sha256sum | cut -d' ' -f1
  fi
}

deployment_plan_for_lane() {
  local lane=$1
  local client_changed=${2:-false}
  local server_changed=${3:-false}
  local shared_changed=${4:-false}
  case "$lane" in
    client)
      printf 'server=false client=%s\n' "$client_changed"
      ;;
    application|migration)
      if [[ "$shared_changed" = true ]]; then
        printf 'server=true client=true\n'
      else
        printf 'server=%s client=%s\n' "$server_changed" "$client_changed"
      fi
      ;;
    full)
      printf 'server=true client=true\n'
      ;;
    *)
      return 1
      ;;
  esac
}

probe_migration_requirement() {
  local previous_sha=$1
  local target_sha=$2
  : > "$MIGRATION_CANDIDATES"
  : > "$MIGRATION_APPLIED"
  local file version hash
  for file in "$SOURCE_ROOT"/db/migrations/*.sql; do
    [[ -f "$file" ]] || continue
    version=$(basename "$file")
    hash=$(sha256sum "$file" | cut -d' ' -f1)
    printf '%s\t%s\n' "$version" "$hash" >> "$MIGRATION_CANDIDATES"
  done
  # The root controller shell intentionally owns this root-created probe file.
  # shellcheck disable=SC2024
  if ! sudo -u postgres psql --dbname=ash_atlas_game --no-align --tuples-only --field-separator=$'\t' \
      --command='SELECT version, content_sha256 FROM schema_migrations ORDER BY version' \
      > "$MIGRATION_APPLIED" 2>/dev/null; then
    printf 'true\tledger_probe_failed\n'
    return
  fi
  local comparison
  if ! comparison=$(/usr/bin/node - "$MIGRATION_CANDIDATES" "$MIGRATION_APPLIED" <<'NODE'
const fs = require("node:fs");
const parse = (path) => new Map(fs.readFileSync(path, "utf8").trim().split(/\n/).filter(Boolean).map((line) => line.split("\t")));
const candidate = parse(process.argv[2]);
const applied = parse(process.argv[3]);
for (const [version, hash] of applied) {
  if (!candidate.has(version)) {
    process.stderr.write(`applied migration is absent from candidate: ${version}\n`);
    process.exit(2);
  }
  if (!hash || candidate.get(version) !== hash) {
    process.stderr.write(`applied migration hash differs: ${version}\n`);
    process.exit(2);
  }
}
const pending = [...candidate.keys()].filter((version) => !applied.has(version));
process.stdout.write(pending.length ? `true\tpending:${pending.join(",")}` : "false\tnone");
NODE
  ); then
    fail 'candidate migration ledger differs from retained database history'
  fi
  if ! sudo -u debian git --git-dir="$MIRROR_ROOT" diff --quiet \
      "$previous_sha" "$target_sha" -- apps/server/src/db/migrate.ts; then
    printf 'true\tmigration_runner_changed\n'
  else
    printf '%s\n' "$comparison"
  fi
}

write_migration_intent_marker() {
  [[ -d "$OPERATION_ROOT" && ! -L "$OPERATION_ROOT" ]] ||
    fail 'migration intent root is absent or unsafe'
  if [[ -e "$MIGRATION_INTENT_MARKER" || -L "$MIGRATION_INTENT_MARKER" ]]; then
    [[ -f "$MIGRATION_INTENT_MARKER" && ! -L "$MIGRATION_INTENT_MARKER" ]] ||
      fail 'migration intent marker is unsafe'
    fail 'migration intent marker already exists; migration outcome requires reconciliation'
  fi
  local temporary="${MIGRATION_INTENT_MARKER}.$$"
  [[ ! -e "$temporary" && ! -L "$temporary" ]] ||
    fail 'migration intent marker temporary path already exists'
  if ! (umask 077; printf 'operation_id=%s\ntarget_sha=%s\nledger_before_sha256=%s\ncreated_at_utc=%s\n' \
    "$OPERATION_ID" "$GAME_SHA" \
    "$(sha256sum "$MIGRATION_APPLIED" | cut -d' ' -f1)" \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$temporary"); then
      rm -f -- "$temporary"
      fail 'migration intent marker could not be written'
  fi
  chmod 0600 "$temporary"
  mv -T -- "$temporary" "$MIGRATION_INTENT_MARKER" || {
    rm -f -- "$temporary"
    fail 'migration intent marker could not be committed'
  }
  sync -f "$OPERATION_ROOT" 2>/dev/null || true
}

capture_live_migration_ledger() {
  : > "$MIGRATION_POST_APPLIED"
  # The root updater intentionally owns this root-created probe file.
  # shellcheck disable=SC2024
  sudo -u postgres psql --dbname=ash_atlas_game --no-align --tuples-only --field-separator=$'\t' \
    --command='SELECT version, content_sha256 FROM schema_migrations ORDER BY version' \
    > "$MIGRATION_POST_APPLIED" 2>/dev/null
}

verify_live_migration_ledger() {
  local ledger
  for ledger in "$MIGRATION_CANDIDATES" "$MIGRATION_POST_APPLIED"; do
    [[ -f "$ledger" && ! -L "$ledger" ]] || return 1
    awk -F '\t' '
      NF != 2 || $1 == "" || $2 !~ /^[0-9a-f]{64}$/ || seen[$1]++ { invalid = 1 }
      END { exit invalid ? 1 : 0 }
    ' "$ledger" || return 1
  done
  diff -q \
    <(LC_ALL=C sort -- "$MIGRATION_CANDIDATES") \
    <(LC_ALL=C sort -- "$MIGRATION_POST_APPLIED") >/dev/null
}

atomic_link() {
  local target=$1
  local link=$2
  local temporary="${link}.new.${OPERATION_ID}"
  [[ ! -e "$temporary" && ! -L "$temporary" ]] || fail "temporary link already exists: $temporary"
  ln -s "$target" "$temporary"
  mv -T "$temporary" "$link"
}

restore_link() {
  local target=$1
  local link=$2
  local temporary="${link}.restore.${OPERATION_ID}"
  rm -f "$temporary"
  ln -s "$target" "$temporary"
  mv -T "$temporary" "$link"
}

resolve_game_generation() {
  local sha=$1
  local tags=()
  mapfile -t tags < <(sudo -u debian git --git-dir="$MIRROR_ROOT" \
    tag --points-at "$sha" --list 'test/t[0-9][0-9][0-9]' 'test/t[0-9][0-9][0-9][0-9]')
  (( ${#tags[@]} == 1 )) || fail "game SHA $sha does not have exactly one immutable generation tag"
  [[ $(sudo -u debian git --git-dir="$MIRROR_ROOT" rev-list -n 1 "refs/tags/${tags[0]}") = "$sha" ]] ||
    fail "immutable generation ${tags[0]} does not resolve to game SHA $sha"
  printf '%s\n' "${tags[0]}"
}

update_runtime_identity() {
  local sha=$1
  local generation=$2
  local temporary="${ENV_FILE}.new.${OPERATION_ID}"
  [[ ! -e "$temporary" ]] || fail "temporary environment file already exists: $temporary"
  umask 0077
  render_runtime_identity "$sha" "$generation" > "$temporary" || {
    rm -f -- "$temporary"
    fail 'could not update runtime release identity in the protected environment'
  }
  chown root:ash-atlas "$temporary"
  chmod 0640 "$temporary"
  mv -T "$temporary" "$ENV_FILE"
}

render_runtime_identity() {
  local sha=$1
  local generation=$2
  [[ -f "$ENV_FILE" && ! -L "$ENV_FILE" ]] ||
    fail 'runtime environment file is absent or unsafe'
  awk -v sha="$sha" -v generation="$generation" '
    BEGIN { sha_updated = 0; runtime_generation_updated = 0; telemetry_generation_updated = 0 }
    /^RUNTIME_SHA=/ { print "RUNTIME_SHA=" sha; sha_updated += 1; next }
    /^RUNTIME_GENERATION=/ {
      print "RUNTIME_GENERATION=" generation; runtime_generation_updated += 1; next
    }
    /^TELEMETRY_RELEASE_GENERATION=/ {
      print "TELEMETRY_RELEASE_GENERATION=" generation; telemetry_generation_updated += 1; next
    }
    { print }
    END {
      if (sha_updated != 1 || runtime_generation_updated > 1 || telemetry_generation_updated > 1) exit 1
      if (runtime_generation_updated == 0) print "RUNTIME_GENERATION=" generation
      if (telemetry_generation_updated == 0) print "TELEMETRY_RELEASE_GENERATION=" generation
    }
  ' "$ENV_FILE"
}

frozen_integration_tooling_only() {
  local target=$1 integration_sha changed_path changed_paths
  integration_sha=$(sudo -u debian git --git-dir="$MIRROR_ROOT" rev-parse refs/heads/integration/test) || return 1
  [[ "$integration_sha" = "$target" ]] && return 0
  [[ "$target" = 4811473f91d3b209ddd3da7f47f4a41de97ca121 ]] || return 1
  sudo -u debian git --git-dir="$MIRROR_ROOT" merge-base --is-ancestor \
    "$target" "$integration_sha" || return 1
  local tags
  mapfile -t tags < <(sudo -u debian git --git-dir="$MIRROR_ROOT" \
    tag --points-at "$integration_sha" --list 'test/t[0-9][0-9][0-9]' 'test/t[0-9][0-9][0-9][0-9]')
  [[ ${#tags[@]} -eq 1 ]] || return 1
  changed_paths=$(sudo -u debian git --git-dir="$MIRROR_ROOT" diff --name-only \
    "$target" "$integration_sha") || return 1
  [[ -n "$changed_paths" ]] || return 1
  while IFS= read -r changed_path; do
    case "$changed_path" in
      tools/release/*|tools/mobile-release/*|docs/architecture/IN_APP_UPDATES_PLAN.md) ;;
      *) return 1 ;;
    esac
  done <<< "$changed_paths"
}

runtime_environment_sha256() {
  [[ -f "$ENV_FILE" && ! -L "$ENV_FILE" ]] ||
    fail 'runtime environment file is absent or unsafe'
  sha256sum "$ENV_FILE" | cut -d' ' -f1
}

runtime_environment_sha256_for_identity() {
  render_runtime_identity "$1" "$2" | sha256sum | cut -d' ' -f1
}

effective_native_configuration() {
  local path=${1:-$ENV_FILE}
  local source_root=${2:-${SOURCE_ROOT:-}}
  [[ -f "$path" && ! -L "$path" ]] || fail 'candidate environment file is absent or unsafe'
  [[ -n "$source_root" && -d "$source_root" && ! -L "$source_root" ]] ||
    fail 'candidate source root is absent or unsafe'
  "$NODE_BIN" - "$path" "$source_root" <<'NODE'
const fs = require("node:fs");
const path = process.argv[2];
const sourceRoot = process.argv[3];
const values = Object.create(null);
const fail = (message) => { throw new Error(message); };
for (const raw of fs.readFileSync(path, "utf8").split(/\r?\n/u)) {
  let line = raw.trim();
  if (!line || line.startsWith("#")) continue;
  line = line.replace(/^export\s+/u, "");
  const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u);
  if (!match) continue;
  let value = match[2].trim();
  if ((value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  values[match[1]] = value;
}
const configPath = `${sourceRoot}/apps/server/src/config.ts`;
const nativePath = `${sourceRoot}/packages/shared/src/nativeCompatibility.ts`;
const protocolPath = `${sourceRoot}/packages/shared/src/protocolCompatibility.ts`;
const versionPath = `${sourceRoot}/packages/shared/src/version.ts`;
const policyPath = `${sourceRoot}/config/protocol-versions.json`;
if (fs.existsSync(versionPath) !== fs.existsSync(policyPath)) {
  fail("candidate protocol version source and policy must be present together");
}
const versionPolicy = fs.existsSync(policyPath) ? (() => {
  if (fs.lstatSync(policyPath).isSymbolicLink()) fail("candidate protocol policy is unsafe");
  return JSON.parse(fs.readFileSync(policyPath, "utf8"));
})() : null;
const sourcePaths = [configPath, nativePath, protocolPath];
if (versionPolicy) sourcePaths.push(versionPath);
const sources = sourcePaths.map((candidate) => {
  if (!fs.existsSync(candidate) || fs.lstatSync(candidate).isSymbolicLink()) {
    fail(`candidate source file is absent or unsafe: ${candidate}`);
  }
  return fs.readFileSync(candidate, "utf8");
});
const constants = new Map();
for (const source of sources) {
  const pattern = /export\s+const\s+([A-Z][A-Z0-9_]*)\s*=\s*([^;\n]+)\s*;/gu;
  let match;
  while ((match = pattern.exec(source)) !== null) constants.set(match[1], match[2].trim());
}
const resolveExpression = (expression, stack = []) => {
  const value = expression.trim();
  if (/^"(?:[^"\\]|\\.)*"$/u.test(value) || /^'(?:[^'\\]|\\.)*'$/u.test(value)) {
    return value.slice(1, -1);
  }
  if (/^\d+$/u.test(value)) return Number(value);
  const policyField = value.match(/^protocolVersions\.(min_protocol|max_protocol)$/u)?.[1];
  if (policyField) {
    const protocol = versionPolicy?.[policyField];
    if (!Number.isSafeInteger(protocol) || protocol <= 0) {
      fail(`candidate protocol policy ${policyField} is invalid`);
    }
    return protocol;
  }
  if (/^[A-Z][A-Z0-9_]*$/u.test(value)) {
    if (!constants.has(value) || stack.includes(value)) fail(`candidate constant ${value} cannot be resolved`);
    return resolveExpression(constants.get(value), [...stack, value]);
  }
  fail(`candidate constant expression is unsupported: ${value}`);
};
const configSource = sources[0];
const configuredDefault = (name) => {
  const match = configSource.match(new RegExp(`${name}\\s*:[\\s\\S]{0,320}?\\.default\\(([^)]+)\\)`, "u"));
  if (!match) fail(`candidate config does not define ${name} with a default`);
  return resolveExpression(match[1]);
};
const configured = (name) => {
  const raw = values[name];
  return raw === undefined || raw === "" ? configuredDefault(name) : raw;
};
const positive = (name) => {
  const raw = String(configured(name));
  if (!/^\d+$/u.test(raw) || Number(raw) <= 0) fail(`${name} must be a positive integer`);
  return Number(raw);
};
const nonnegative = (name) => {
  const raw = String(configured(name));
  if (!/^\d+$/u.test(raw)) fail(`${name} must be a nonnegative integer`);
  return Number(raw);
};
const version = (name) => {
  const value = String(configured(name));
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(value)) fail(`${name} is invalid`);
  return value;
};
const result = {
  serverProtocol: {
    min: positive("NATIVE_WS_MIN"),
    max: positive("NATIVE_WS_MAX")
  },
  hardMinimum: {
    ios: {
      version: version("NATIVE_IOS_HARD_MIN_VERSION"),
      build: nonnegative("NATIVE_IOS_HARD_MIN_BUILD")
    },
    android: {
      version: version("NATIVE_ANDROID_HARD_MIN_VERSION"),
      build: nonnegative("NATIVE_ANDROID_HARD_MIN_BUILD")
    }
  }
};
if (result.serverProtocol.min > result.serverProtocol.max) fail("NATIVE_WS_MIN exceeds NATIVE_WS_MAX");
process.stdout.write(JSON.stringify(result));
NODE
}

load_authoritative_mobile_registry() {
  local expected_commit=$1
  [[ "$expected_commit" =~ ^[0-9a-f]{40}$ ]] ||
    fail 'activation registry commit identity is unsafe'
  MOBILE_REGISTRY_PATH=
  if [[ -n "$TEST_MOBILE_REGISTRY_PATH" ]]; then
    [[ -f "$TEST_MOBILE_REGISTRY_PATH" && ! -L "$TEST_MOBILE_REGISTRY_PATH" ]] ||
      fail 'test mobile registry fixture is absent or unsafe'
    [[ "$TEST_MOBILE_REGISTRY_COMMIT_SHA" = "$expected_commit" ]] ||
      fail 'test mobile registry commit identity differs from the activation intent'
    MOBILE_REGISTRY_PATH=$TEST_MOBILE_REGISTRY_PATH
    return
  fi
  [[ "$MOBILE_REGISTRY_REF" =~ ^refs/heads/[A-Za-z0-9._/-]+$ ]] ||
    fail 'mobile registry ref is unsafe'
  [[ -d "$MIRROR_ROOT" && ! -L "$MIRROR_ROOT" ]] ||
    fail 'deployment mirror is absent or unsafe for mobile registry validation'
  sudo -u debian env HOME=/home/debian git --git-dir="$MIRROR_ROOT" fetch origin \
    "$MOBILE_REGISTRY_REF:$MOBILE_REGISTRY_REF" >/dev/null 2>&1 ||
    fail 'authoritative mobile registry could not be fetched'
  local actual_commit
  actual_commit=$(sudo -u debian git --git-dir="$MIRROR_ROOT" rev-parse "$MOBILE_REGISTRY_REF")
  [[ "$actual_commit" = "$expected_commit" ]] ||
    fail 'authoritative mobile registry commit changed after activation intent admission'
  MOBILE_REGISTRY_PATH=$(mktemp /tmp/ash-atlas-mobile-registry.XXXXXX)
  if ! sudo -u debian git --git-dir="$MIRROR_ROOT" show \
      "$MOBILE_REGISTRY_REF:mobile-release-registry.json" >"$MOBILE_REGISTRY_PATH"; then
    rm -f -- "$MOBILE_REGISTRY_PATH"
    MOBILE_REGISTRY_PATH=
    fail 'authoritative mobile registry file is absent'
  fi
}

verify_activation_registry_fence() {
  local prepared_receipt prepared_env component effective_native prepared_native_json prepared_native_sha
  [[ "$DEPLOY_MODE" = activate ]] || return 0
  if [[ "$RELEASE_MODE" = paused ]]; then
    printf 'WARNING: web-only release mode is paused; activation intent and mobile registry fence skipped.\n' >&2
    return 0
  fi
  [[ "$ACTIVATION_INTENT_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$ ]] ||
    fail 'ACTIVATE requires a durable activation intent ID'
  [[ "$ACTIVATION_REGISTRY_COMMIT_SHA" =~ ^[0-9a-f]{40}$ ]] ||
    fail 'ACTIVATE requires a durable mobile registry commit identity'
  prepared_receipt=$(operation_receipt_field prepared_remote_receipt_sha256)
  prepared_env=$(operation_receipt_field prepared_env_sha256)
  component=$(operation_receipt_field prepared_server_component_sha)
  [[ "$prepared_receipt" =~ ^[0-9a-f]{64}$ ]] ||
    fail 'ACTIVATE prepared remote receipt identity is unsafe'
  [[ "$prepared_env" =~ ^[0-9a-f]{64}$ ]] ||
    fail 'ACTIVATE prepared environment identity is unsafe'
  [[ "$component" =~ ^[0-9a-f]{40}$ ]] ||
    fail 'ACTIVATE prepared server component identity is unsafe'
  effective_native=$(effective_native_configuration "$ENV_FILE" "$SOURCE_ROOT") ||
    fail 'candidate native compatibility configuration could not be derived'
  prepared_native_json=$(operation_receipt_field prepared_native_compatibility_json)
  prepared_native_sha=$(operation_receipt_field prepared_native_compatibility_sha256)
  [[ "$prepared_native_sha" =~ ^[0-9a-f]{64}$ ]] ||
    fail 'PREPARED native compatibility policy identity is unsafe'
  [[ $(printf '%s' "$prepared_native_json" | sha256sum | cut -d' ' -f1) = "$prepared_native_sha" ]] ||
    fail 'PREPARED native compatibility policy is not self-consistent'
  [[ "$prepared_native_json" = "$effective_native" ]] ||
    fail 'candidate native compatibility policy changed between PREPARE and ACTIVATE'
  load_authoritative_mobile_registry "$ACTIVATION_REGISTRY_COMMIT_SHA"
  "$NODE_BIN" - "$MOBILE_REGISTRY_PATH" "$ACTIVATION_INTENT_ID" "$GAME_SHA" \
    "$prepared_receipt" "$prepared_env" "$component" "$effective_native" \
    "$prepared_native_sha" <<'NODE' || {
const fs = require("node:fs");
const [path, intentId, target, preparedReceipt, preparedEnv, component, effectiveNativeJson,
  preparedNativeSha] = process.argv.slice(2);
const registry = JSON.parse(fs.readFileSync(path, "utf8"));
const fail = (message) => { throw new Error(message); };
const crypto = require("node:crypto");
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const positive = (value) => Number.isInteger(value) && value > 0;
let effectiveNative;
try { effectiveNative = JSON.parse(effectiveNativeJson); } catch { fail("candidate native compatibility configuration is invalid"); }
if (crypto.createHash("sha256").update(effectiveNativeJson).digest("hex") !== preparedNativeSha) {
  fail("candidate native compatibility policy hash differs from PREPARED identity");
}
const compareRelease = (leftVersion, leftBuild, rightVersion, rightBuild) => {
  const left = String(leftVersion).split(/[.-]/u).slice(0, 3).map(Number);
  const right = String(rightVersion).split(/[.-]/u).slice(0, 3).map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return leftBuild - rightBuild;
};
if (!object(registry) || registry.schemaVersion !== 1 || !Array.isArray(registry.releases)) {
  fail("mobile registry identity is invalid");
}
const intent = registry.activationIntent;
if (!object(intent) || intent.schemaVersion !== 1 || intent.intentId !== intentId ||
    intent.serverSha !== target || intent.candidateComponentSha !== component ||
    intent.preparedReceiptSha !== preparedReceipt || intent.preSwitchEnvSha !== preparedEnv ||
    !object(intent.serverProtocol) || !positive(intent.serverProtocol.min) ||
    !positive(intent.serverProtocol.max) || intent.serverProtocol.min > intent.serverProtocol.max ||
    !object(intent.hardMinimum) || !Number.isFinite(Date.parse(intent.createdAt)) ||
    !/^[0-9a-f]{40}$/u.test(intent.serverSha) ||
    !/^[0-9a-f]{64}$/u.test(intent.preparedReceiptSha) ||
    !/^[0-9a-f]{64}$/u.test(intent.preSwitchEnvSha)) {
  fail("authoritative activation intent does not match the prepared release");
}
if (!object(effectiveNative) || !object(effectiveNative.serverProtocol) ||
    !object(effectiveNative.hardMinimum) ||
    intent.serverProtocol.min !== effectiveNative.serverProtocol.min ||
    intent.serverProtocol.max !== effectiveNative.serverProtocol.max) {
  fail("candidate native protocol does not match the activation intent");
}
for (const platform of ["ios", "android"]) {
  const minimum = intent.hardMinimum[platform];
  const effectiveMinimum = effectiveNative.hardMinimum[platform];
  if (!object(minimum) || typeof minimum.version !== "string" ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(minimum.version) ||
      !Number.isInteger(minimum.build) || minimum.build < 0 ||
      !object(effectiveMinimum) || minimum.version !== effectiveMinimum.version ||
      minimum.build !== effectiveMinimum.build) {
    fail(`activation intent ${platform} hard minimum is invalid`);
  }
}
// Keep this audit validator aligned with tools/mobile-release/registry.mjs.
const RETIREMENT_NOTE = "retired; replaced by web install; build 8 is beta/internal";
const RETIREABLE_BUILDS = { ios: [1, 2, 3, 5, 6, 7], android: [1, 2, 3, 4, 6, 7] };
const RETIREMENT_IDENTITY = ["reservationId", "releaseId", "platform", "marketingVersion", "build",
  "generation", "sourceSha", "artifactSha256", "storeBuildId"];

const failUnless = (condition, message) => { if (!condition) fail(message); };
function retirementState(registry) {
  const audit = registry.retirementAudit === undefined ? [] : registry.retirementAudit;
  failUnless(Array.isArray(audit), "retirement audit must be an array");
  const retired = new Set();
  const ids = new Set();
  let previousTime = -Infinity;
  for (const entry of audit) {
    failUnless(object(entry) && entry.schemaVersion === 1 &&
      typeof entry.actionId === "string" && /^[A-Za-z0-9._:-]{3,128}$/u.test(entry.actionId) &&
      !ids.has(entry.actionId) && ["retire", "unretire"].includes(entry.action) &&
      typeof entry.actor === "string" && entry.actor.trim().length > 0 &&
      typeof entry.recordedAt === "string" && Number.isFinite(Date.parse(entry.recordedAt)) &&
      Date.parse(entry.recordedAt) >= previousTime && typeof entry.note === "string" &&
      entry.note.trim().length > 0 && (entry.action !== "retire" || entry.note === RETIREMENT_NOTE) &&
      object(entry.identity), "retirement audit evidence is invalid");
    const release = registry.releases.find((r) => r.reservationId === entry.identity.reservationId);
    failUnless(release && RETIREABLE_BUILDS[release.platform]?.includes(release.build) &&
      release.uploadAttempted === true &&
      registry.releases.filter((r) => r.reservationId === release.reservationId).length === 1 &&
      registry.releases.filter((r) => r.platform === release.platform && r.build === release.build).length === 1 &&
      typeof release.reservationId === "string" && release.reservationId.length > 0 &&
      typeof release.releaseId === "string" && release.releaseId.length > 0 &&
      /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(release.marketingVersion) &&
      /^t\d{3,4}$/u.test(release.generation) && /^[0-9a-f]{40}$/u.test(release.sourceSha) &&
      (release.artifactSha256 == null || /^[0-9a-f]{64}$/u.test(release.artifactSha256)) &&
      (release.storeBuildId == null || (typeof release.storeBuildId === "string" && release.storeBuildId.length > 0)) &&
      Object.keys(entry.identity).length === RETIREMENT_IDENTITY.length &&
      RETIREMENT_IDENTITY.every((key) => entry.identity[key] === (release[key] ?? null)),
    "retirement audit release identity is invalid or outside the legacy allowlist");
    const wasRetired = retired.has(release.reservationId);
    failUnless(entry.action === "retire" ? !wasRetired : wasRetired,
      "retirement audit must alternate retire and unretire");
    if (entry.action === "retire") retired.add(release.reservationId);
    else retired.delete(release.reservationId);
    ids.add(entry.actionId);
    previousTime = Date.parse(entry.recordedAt);
  }
  return retired;
}

const retired = retirementState(registry);
const relevant = registry.releases.filter((release) => !retired.has(release.reservationId) && (
  release.supported === true || release.compatibilityProtected === true ||
  (release.availabilityPending !== undefined && release.availabilityPending !== null) ||
  (release.uploadAttempted === true && release.supported !== true && release.compatibilityProtected !== true)));
if (relevant.length === 0) fail("mobile registry has no protected or supported release");
for (const release of relevant) {
  if (!object(release) || !["ios", "android"].includes(release.platform) ||
      !object(release.protocol) || !positive(release.protocol.min) ||
      !positive(release.protocol.max) || release.protocol.min > release.protocol.max ||
      release.protocol.max < intent.serverProtocol.min ||
      release.protocol.min > intent.serverProtocol.max ||
      typeof release.marketingVersion !== "string" ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(release.marketingVersion) ||
      !Number.isInteger(release.build) ||
      compareRelease(release.marketingVersion, release.build,
        intent.hardMinimum[release.platform].version,
        intent.hardMinimum[release.platform].build) < 0) {
    fail(`protected mobile release is incompatible: ${release.platform || "unknown"}`);
  }
}
process.stdout.write(JSON.stringify({ checked: relevant.length, status: "compatible" }));
NODE
    local code=$?
    [[ -z "$MOBILE_REGISTRY_PATH" || -n "$TEST_MOBILE_REGISTRY_PATH" ]] || rm -f -- "$MOBILE_REGISTRY_PATH"
    MOBILE_REGISTRY_PATH=
    fail 'authoritative mobile activation registry fence failed'
  }
  [[ -z "$MOBILE_REGISTRY_PATH" || -n "$TEST_MOBILE_REGISTRY_PATH" ]] || rm -f -- "$MOBILE_REGISTRY_PATH"
  MOBILE_REGISTRY_PATH=
}

assert_post_switch_environment() {
  [[ "$DEPLOY_MODE" = activate ]] || return 0
  local actual
  actual=$(runtime_environment_sha256)
  [[ "$actual" = "$EXPECTED_POST_SWITCH_ENV_SHA256" ]] ||
    fail 'runtime environment differs from the activation intent effective identity'
  operation_receipt_update post_switch_env_sha256 "$actual"
}

assert_source_clean() {
  [[ -z ${SOURCE_ROOT:-} || ! -d ${SOURCE_ROOT:-} ]] && return 0
  local status
  status=$(sudo -u debian git -C "$SOURCE_ROOT" status --porcelain --untracked-files=all)
  if [[ -n "$status" ]]; then
    printf 'STOP: source checkout is dirty during %s\n' "${1:-verification}" >&2
    return 1
  fi
}

prepare_discord_patch_notes_outbox() {
  local owner mode
  if [[ -e "$DISCORD_PATCH_NOTES_OUTBOX" || -L "$DISCORD_PATCH_NOTES_OUTBOX" ]]; then
    [[ -d "$DISCORD_PATCH_NOTES_OUTBOX" && ! -L "$DISCORD_PATCH_NOTES_OUTBOX" ]] || return 1
  elif ! install -d -o root -g root -m 0700 -- "$DISCORD_PATCH_NOTES_OUTBOX"; then
    return 1
  fi
  chown -h root:root -- "$DISCORD_PATCH_NOTES_OUTBOX" || return 1
  [[ -d "$DISCORD_PATCH_NOTES_OUTBOX" && ! -L "$DISCORD_PATCH_NOTES_OUTBOX" ]] || return 1
  chmod 0700 -- "$DISCORD_PATCH_NOTES_OUTBOX" || return 1
  owner=$(stat -c '%u:%g' "$DISCORD_PATCH_NOTES_OUTBOX") || return 1
  mode=$(stat -c '%a' "$DISCORD_PATCH_NOTES_OUTBOX") || return 1
  [[ "$owner" = 0:0 && "$mode" = 700 ]]
}

read_discord_patch_notes_assignment() {
  local file=$1 ending final_byte line byte_count expected_count
  local had_crlf=false
  local -a lines=()
  mapfile -t lines < "$file" || return 1
  [[ ${#lines[@]} -eq 1 ]] || return 1
  if [[ "${lines[0]}" == *$'\r' ]]; then
    ending=$(tail -c 2 "$file" | od -An -tx1 | tr -d ' \n') || return 1
    [[ "$ending" = 0d0a ]] || return 1
    lines[0]=${lines[0]%$'\r'}
    had_crlf=true
  fi
  line=${lines[0]}
  [[ ! "$line" =~ [[:space:][:cntrl:]] ]] || return 1
  [[ "$line" = ASH_ATLAS_DISCORD_PATCH_NOTES_WEBHOOK_URL=* ]] || return 1
  byte_count=$(wc -c < "$file") || return 1
  expected_count=${#line}
  if [[ "$had_crlf" = true ]]; then
    expected_count=$((expected_count + 2))
  else
    final_byte=$(tail -c 1 "$file" | od -An -tx1 | tr -d ' \n') || return 1
    if [[ "$final_byte" = 0a ]]; then expected_count=$((expected_count + 1)); fi
  fi
  [[ "$byte_count" -eq "$expected_count" ]] || return 1
  printf '%s' "$line"
}

deliver_discord_patch_notes() {
  local owner mode line webhook output
  DISCORD_PATCH_NOTES_RESULT=disabled
  [[ "$RELEASE_PATCH_NOTES_HEX" != none ]] || return 0
  if [[ ! -e "$DISCORD_PATCH_NOTES_ENV" && ! -L "$DISCORD_PATCH_NOTES_ENV" ]]; then return 0; fi
  if [[ ! -f "$DISCORD_PATCH_NOTES_ENV" || -L "$DISCORD_PATCH_NOTES_ENV" ]]; then
    printf 'WARNING: Discord patch-notes configuration is unsafe; delivery disabled\n' >&2
    return 0
  fi
  if ! owner=$(stat -c '%u' "$DISCORD_PATCH_NOTES_ENV") ||
      ! mode=$(stat -c '%a' "$DISCORD_PATCH_NOTES_ENV"); then
    printf 'WARNING: Discord patch-notes configuration could not be inspected; delivery disabled\n' >&2
    return 0
  fi
  if [[ "$owner" != 0 || ! "$mode" =~ ^[0-7]{3,4}$ || $((8#$mode & 0077)) -ne 0 ]]; then
    printf 'WARNING: Discord patch-notes configuration is not root-only; delivery disabled\n' >&2
    return 0
  fi
  if ! line=$(read_discord_patch_notes_assignment "$DISCORD_PATCH_NOTES_ENV"); then
    printf 'WARNING: Discord patch-notes configuration must contain one exact safe assignment; delivery disabled\n' >&2
    return 0
  fi
  webhook=${line#ASH_ATLAS_DISCORD_PATCH_NOTES_WEBHOOK_URL=}
  DISCORD_PATCH_NOTES_RESULT=queued
  if ! prepare_discord_patch_notes_outbox; then
    printf 'WARNING: Discord patch-notes outbox is unsafe or unavailable; delivery remains queued\n' >&2
    unset webhook line
    return 0
  fi
  if output=$(ASH_ATLAS_DISCORD_PATCH_NOTES_WEBHOOK_URL="$webhook" \
      "$NODE_BIN" "$SOURCE_ROOT/tools/release/send-discord-patch-notes.mjs" \
      --release "$CLIENT_RELEASE/release.json" \
      --outbox "$DISCORD_PATCH_NOTES_OUTBOX" 2>/dev/null); then
    output=${output//$'\r'/}
    output=${output//$'\n'/}
    if [[ "$output" = sent || "$output" = already-sent ]]; then
      DISCORD_PATCH_NOTES_RESULT=$output
    fi
  else
    printf 'WARNING: Discord patch notes remain queued for an explicit retry of this release\n' >&2
  fi
  unset webhook line
  return 0
}

run_discord_patch_notes_phase() {
  DISCORD_PATCH_NOTES_RESULT=disabled
  if ! phase_start discord_patch_notes; then
    printf 'WARNING: Discord patch-notes phase start could not be recorded\n' >&2
  fi
  if ! deliver_discord_patch_notes; then
    DISCORD_PATCH_NOTES_RESULT=queued
    printf 'WARNING: Discord patch-notes delivery failed safely\n' >&2
  fi
  if ! operation_receipt_update discord_patch_notes_result "$DISCORD_PATCH_NOTES_RESULT"; then
    printf 'WARNING: Discord patch-notes result could not be recorded\n' >&2
  fi
  if ! phase_finish "$DISCORD_PATCH_NOTES_RESULT"; then
    printf 'WARNING: Discord patch-notes phase timing could not be recorded\n' >&2
  fi
  return 0
}

worktree_has_mounts() {
  local root mounts target
  root=$(readlink -f -- "$1") || return 0
  if ! mounts=$(findmnt -rn -o TARGET 2>/dev/null) || [[ -z "$mounts" ]]; then
    return 0
  fi
  while IFS= read -r target; do
    if [[ "$target" = "$root" || "$target" = "$root/"* ]]; then
      return 0
    fi
  done <<<"$mounts"
  return 1
}

active_operation_release_sha() {
  local marker="$OPERATION_ROOT/active-operation"
  [[ -e "$marker" || -L "$marker" ]] || return 0
  [[ -f "$marker" && ! -L "$marker" ]] ||
    fail 'active deployment marker is unsafe during release retention'
  local operation receipt
  operation=$(<"$marker")
  [[ "$operation" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$ ]] ||
    fail 'active deployment marker is invalid during release retention'
  receipt="$OPERATION_ROOT/$operation.json"
  [[ -f "$receipt" && ! -L "$receipt" ]] ||
    fail 'active deployment receipt is unsafe during release retention'
  /usr/bin/node - "$receipt" <<'NODE'
const fs = require("node:fs");
const receipt = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (!/^[0-9a-f]{40}$/.test(receipt.requested_target_sha || "")) process.exit(1);
process.stdout.write(receipt.requested_target_sha);
NODE
}

prune_release_root() {
  local requested_root=$1
  local current_link=$2
  shift 2
  [[ ${ASH_ATLAS_DEPLOY_LOCK_HELD:-false} = true ]] ||
    fail 'release retention requires the deployment lock'
  if flock -n "$LOCK_FILE" -c true; then
    fail 'release retention requires an actually held deployment lock'
  fi
  [[ -d "$requested_root" && ! -L "$requested_root" ]] ||
    fail "release root is absent or unsafe: $requested_root"

  local root current_target active_sha
  root=$(realpath -e -- "$requested_root") ||
    fail "release root cannot be resolved: $requested_root"
  current_target=$(readlink -e -- "$current_link") ||
    fail "active release target cannot be resolved: $current_link"
  [[ "$current_target" == "$root/"* ]] ||
    fail "active release target is outside its canonical root: $current_link"
  active_sha=${current_target##*/}
  [[ "$active_sha" =~ ^[0-9a-f]{40}$ &&
      "$current_target" = "$root/$active_sha" &&
      -d "$current_target" && ! -L "$current_target" ]] ||
    fail "active release target is not an immutable physical release: $current_link"

  local -a ordered=()
  mapfile -t ordered < <(
    find "$root" -mindepth 1 -maxdepth 1 -type d ! -lname '*' \
      -printf '%T@\t%f\n' |
      awk -F '\t' '$2 ~ /^[0-9a-f]{40}$/ { print }' |
      sort -t $'\t' -k1,1nr -k2,2r
  )

  local -A retained=(["$active_sha"]=1)
  local entry name inactive_kept=0 protected
  for entry in "${ordered[@]}"; do
    name=${entry#*$'\t'}
    [[ "$name" = "$active_sha" ]] && continue
    if (( inactive_kept < INACTIVE_RELEASE_RETENTION )); then
      retained["$name"]=1
      inactive_kept=$((inactive_kept + 1))
    fi
  done
  for protected in "$@"; do
    [[ -z "$protected" ]] && continue
    [[ "$protected" =~ ^[0-9a-f]{40}$ ]] ||
      fail "protected release identity is invalid: $protected"
    retained["$protected"]=1
  done

  PRUNE_DELETED_COUNT=0
  PRUNE_RETAINED_SHAS=
  local candidate resolved live_target
  for entry in "${ordered[@]}"; do
    name=${entry#*$'\t'}
    candidate="$root/$name"
    if [[ -n ${retained[$name]:-} ]]; then
      PRUNE_RETAINED_SHAS+="${PRUNE_RETAINED_SHAS:+,}$name"
      continue
    fi
    [[ -d "$candidate" && ! -L "$candidate" ]] ||
      fail "release candidate changed type during retention: $candidate"
    resolved=$(realpath -e -- "$candidate") ||
      fail "release candidate cannot be resolved: $candidate"
    [[ "$resolved" = "$candidate" && "${resolved%/*}" = "$root" ]] ||
      fail "release candidate escaped its canonical root: $candidate"
    live_target=$(readlink -e -- "$current_link") ||
      fail "active release target disappeared during retention: $current_link"
    if [[ "$live_target" = "$resolved" ]]; then
      PRUNE_RETAINED_SHAS+="${PRUNE_RETAINED_SHAS:+,}$name"
      continue
    fi
    find "$candidate" -xdev -type d -exec chmod u+rwx {} + ||
      fail "release ownership could not be made removable: $candidate"
    rm -rf --one-file-system "$candidate"
    [[ ! -e "$candidate" && ! -L "$candidate" ]] ||
      fail "release candidate was not fully removed: $candidate"
    PRUNE_DELETED_COUNT=$((PRUNE_DELETED_COUNT + 1))
  done
}

native_bundle_protected_entries() {
  local pointer=$1
  shift
  "$NODE_BIN" - "$pointer" "$NATIVE_BUNDLE_ROOT/candidates" "$@" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [pointerPath, candidateRoot, ...gameShas] = process.argv.slice(2);
const platforms = ["ios", "android"];
const protectedEntries = new Set();
function add(platform, entry, source) {
  if (entry === null || entry === undefined) return;
  if (typeof entry !== "object" || !/^[a-f0-9]{64}$/u.test(entry.clientSha ?? "") ||
      (entry.platform !== undefined && entry.platform !== platform)) {
    throw new Error(`native bundle reference is malformed: ${source}`);
  }
  protectedEntries.add(`${platform}\t${entry.clientSha}`);
}
const pointer = JSON.parse(fs.readFileSync(pointerPath, "utf8"));
if (pointer === null || typeof pointer !== "object") throw new Error("native bundle pointer is malformed");
for (const platform of platforms) {
  add(platform, pointer[platform]?.current, `pointer ${platform} current`);
  add(platform, pointer[platform]?.previous, `pointer ${platform} previous`);
}
for (const gameSha of gameShas) {
  if (!/^[0-9a-f]{40}$/u.test(gameSha)) throw new Error(`protected release identity is invalid: ${gameSha}`);
  const file = path.join(candidateRoot, `${gameSha}.json`);
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (error.code === "ENOENT") continue;
    throw error;
  }
  if (!stat.isFile()) throw new Error(`native bundle candidate is unsafe: ${file}`);
  const { descriptors } = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const platform of platforms) add(platform, descriptors?.[platform], file);
}
for (const entry of protectedEntries) process.stdout.write(`${entry}\n`);
NODE
}

# Signed OTA bundles are immutable per client SHA. Installed apps only download the bundle the
# pointer currently advertises; `previous` is the native-bundle-rollback.sh target and retained
# releases may be re-activated, so all of those stay regardless of age.
prune_native_bundles() {
  [[ ${ASH_ATLAS_DEPLOY_LOCK_HELD:-false} = true ]] ||
    fail 'native bundle retention requires the deployment lock'
  if flock -n "$LOCK_FILE" -c true; then
    fail 'native bundle retention requires an actually held deployment lock'
  fi
  NATIVE_BUNDLES_DELETED=0
  NATIVE_BUNDLES_RETAINED=0
  NATIVE_BUNDLES_FREED_BYTES=0
  [[ -e "$NATIVE_PUBLIC_ROOT" || -L "$NATIVE_PUBLIC_ROOT" ]] || return 0
  [[ -d "$NATIVE_PUBLIC_ROOT" && ! -L "$NATIVE_PUBLIC_ROOT" ]] ||
    fail "native bundle root is unsafe: $NATIVE_PUBLIC_ROOT"
  local pointer="$NATIVE_BUNDLE_ROOT/pointer.json"
  if [[ ! -e "$pointer" && ! -L "$pointer" ]]; then
    printf 'Native bundle retention: skipped (no active pointer)\n'
    return 0
  fi
  [[ -f "$pointer" && ! -L "$pointer" ]] ||
    fail "native bundle pointer is unsafe: $pointer"

  local root protected_output
  root=$(realpath -e -- "$NATIVE_PUBLIC_ROOT") ||
    fail "native bundle root cannot be resolved: $NATIVE_PUBLIC_ROOT"
  protected_output=$(native_bundle_protected_entries "$pointer" "$@") ||
    fail 'native bundle retention could not establish advertised and release-referenced bundles'
  local -A retained=()
  local line
  while IFS= read -r line; do
    if [[ -n "$line" ]]; then retained["$line"]=1; fi
  done <<<"$protected_output"

  local platform entry name kept candidate resolved size
  local -a ordered=()
  for platform in ios android; do
    [[ -e "$root/$platform" || -L "$root/$platform" ]] || continue
    [[ -d "$root/$platform" && ! -L "$root/$platform" ]] ||
      fail "native bundle platform root is unsafe: $root/$platform"
    mapfile -t ordered < <(
      find "$root/$platform" -mindepth 1 -maxdepth 1 -type d ! -lname '*' \
        -printf '%T@\t%f\n' |
        awk -F '\t' '$2 ~ /^[0-9a-f]{64}$/ { print }' |
        sort -t $'\t' -k1,1nr -k2,2r
    )
    kept=0
    for entry in "${ordered[@]}"; do
      name=${entry#*$'\t'}
      if (( kept < NATIVE_BUNDLE_RETENTION )); then
        retained["$platform"$'\t'"$name"]=1
        kept=$((kept + 1))
      fi
    done
    for entry in "${ordered[@]}"; do
      name=${entry#*$'\t'}
      candidate="$root/$platform/$name"
      # Re-read the live pointer so a concurrent rollback swap can never lose its target.
      if [[ -n ${retained["$platform"$'\t'"$name"]:-} ]] || grep -Fq -- "$name" "$pointer"; then
        NATIVE_BUNDLES_RETAINED=$((NATIVE_BUNDLES_RETAINED + 1))
        continue
      fi
      [[ -d "$candidate" && ! -L "$candidate" ]] ||
        fail "native bundle changed type during retention: $candidate"
      resolved=$(realpath -e -- "$candidate") ||
        fail "native bundle cannot be resolved: $candidate"
      [[ "$resolved" = "$candidate" ]] ||
        fail "native bundle escaped its canonical root: $candidate"
      size=$(du -sb --one-file-system -- "$candidate" | cut -f1)
      [[ "$size" =~ ^[0-9]+$ ]] || size=0
      find "$candidate" -xdev -type d -exec chmod u+rwx {} + ||
        fail "native bundle could not be made removable: $candidate"
      rm -rf --one-file-system "$candidate"
      [[ ! -e "$candidate" && ! -L "$candidate" ]] ||
        fail "native bundle was not fully removed: $candidate"
      NATIVE_BUNDLES_DELETED=$((NATIVE_BUNDLES_DELETED + 1))
      NATIVE_BUNDLES_FREED_BYTES=$((NATIVE_BUNDLES_FREED_BYTES + size))
    done
  done
  printf 'Native bundle retention: deleted=%s retained=%s freed_bytes=%s\n' \
    "$NATIVE_BUNDLES_DELETED" "$NATIVE_BUNDLES_RETAINED" "$NATIVE_BUNDLES_FREED_BYTES"
}

# Usage: prune_deployment_releases [STAGED_SHA [ROLLBACK_SHA...]]
# ROLLBACK_SHA values are the exact previously live releases of the activating operation.
prune_deployment_releases() {
  local staged_sha=${1:-}
  local -a rollback_shas=("${@:2}")
  local active_operation_sha
  active_operation_sha=$(active_operation_release_sha) ||
    fail 'active deployment release identity could not be established'
  prune_release_root "$GAME_RELEASE_ROOT" "$GAME_CURRENT_LINK" \
    "$staged_sha" "$active_operation_sha" "${rollback_shas[@]}"
  GAME_RELEASES_DELETED=$PRUNE_DELETED_COUNT
  GAME_RELEASES_RETAINED=$PRUNE_RETAINED_SHAS
  prune_release_root "$CLIENT_RELEASE_ROOT" "$CLIENT_CURRENT_LINK" \
    "$staged_sha" "$active_operation_sha" "${rollback_shas[@]}"
  CLIENT_RELEASES_DELETED=$PRUNE_DELETED_COUNT
  CLIENT_RELEASES_RETAINED=$PRUNE_RETAINED_SHAS
  printf 'Release retention: game deleted=%s retained=%s; public deleted=%s retained=%s\n' \
    "$GAME_RELEASES_DELETED" "$GAME_RELEASES_RETAINED" \
    "$CLIENT_RELEASES_DELETED" "$CLIENT_RELEASES_RETAINED"
  local -a retained_releases=() native_protected=()
  local release_sha
  IFS=, read -r -a retained_releases <<<"$GAME_RELEASES_RETAINED,$CLIENT_RELEASES_RETAINED"
  for release_sha in "${retained_releases[@]}" "$staged_sha" "$active_operation_sha"; do
    if [[ -n "$release_sha" ]]; then native_protected+=("$release_sha"); fi
  done
  prune_native_bundles "${native_protected[@]}"
}

# Prints "kind<TAB>key" for every cache entry a release still on disk was built from: game
# releases name their keys in build-manifest.json and public releases name their client build
# (client cache key) in release.json. Prints "unmapped" when any release cannot be mapped.
build_cache_release_keys() {
  "$NODE_BIN" - "$GAME_RELEASE_ROOT" "$CLIENT_RELEASE_ROOT" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [gameRoot, publicRoot] = process.argv.slice(2);
const key = /^[0-9a-f]{64}$/u;
let unmapped = false;
function releases(root) {
  let names;
  try {
    names = fs.readdirSync(root);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return names.filter(name => /^[0-9a-f]{40}$/u.test(name))
    .map(name => path.join(root, name))
    .filter(directory => fs.lstatSync(directory).isDirectory());
}
function read(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    unmapped = true;
    return null;
  }
}
for (const directory of releases(gameRoot)) {
  const keys = read(path.join(directory, "build-manifest.json"))?.cache_keys;
  for (const kind of ["dependencies", "server", "client"]) {
    if (key.test(keys?.[kind] ?? "")) process.stdout.write(`${kind}\t${keys[kind]}\n`);
    else unmapped = true;
  }
}
for (const directory of releases(publicRoot)) {
  const release = read(path.join(directory, "release.json"));
  if (release === null) continue;
  if (key.test(release?.client_sha ?? "")) process.stdout.write(`client\t${release.client_sha}\n`);
  else unmapped = true;
}
if (unmapped) process.stdout.write("unmapped\n");
NODE
}

# Content-addressed build and dependency caches only speed up rebuilds; rollback re-activates
# immutable release directories and never reads them. Keep the entries that releases still on
# disk were built from plus the keys passed by the running PREPARE, and remove crashed
# publications. Usage: prune_build_caches [dependencies=KEY] [server=KEY] [client=KEY]...
prune_build_caches() {
  [[ ${ASH_ATLAS_DEPLOY_LOCK_HELD:-false} = true ]] ||
    fail 'build cache retention requires the deployment lock'
  if flock -n "$LOCK_FILE" -c true; then
    fail 'build cache retention requires an actually held deployment lock'
  fi
  BUILD_CACHE_DELETED=0
  BUILD_CACHE_RETAINED=0
  BUILD_CACHE_FREED_BYTES=0
  local -A retained=()
  local line kind cache_key unmapped=false keys_output
  for line in "$@"; do
    [[ -z "${line#*=}" ]] && continue
    [[ "$line" =~ ^(dependencies|server|client)=[0-9a-f]{64}$ ]] ||
      fail "protected build cache key is invalid: $line"
    retained["${line%%=*}"$'\t'"${line#*=}"]=1
  done
  keys_output=$(build_cache_release_keys) ||
    fail 'build cache retention could not map retained releases to cache keys'
  while IFS= read -r line; do
    if [[ "$line" = unmapped ]]; then
      unmapped=true
    elif [[ "$line" =~ ^(dependencies|server|client)$'\t'[0-9a-f]{64}$ ]]; then
      retained["$line"]=1
    elif [[ -n "$line" ]]; then
      fail "build cache key mapping is malformed: $line"
    fi
  done <<<"$keys_output"

  local requested root entry name candidate resolved size kept
  local -a ordered=()
  for kind in dependencies server client; do
    requested="$CACHE_ROOT/builds/$kind"
    [[ "$kind" = dependencies ]] && requested="$CACHE_ROOT/dependencies"
    [[ -e "$requested" || -L "$requested" ]] || continue
    [[ -d "$requested" && ! -L "$requested" ]] ||
      fail "build cache root is unsafe: $requested"
    root=$(realpath -e -- "$requested") ||
      fail "build cache root cannot be resolved: $requested"
    mapfile -t ordered < <(
      find "$root" -mindepth 1 -maxdepth 1 -type d ! -lname '*' -printf '%T@\t%f\n' |
        awk -F '\t' '$2 ~ /^[0-9a-f]{64}(\.incoming\.[0-9]+)?$/ { print }' |
        sort -t $'\t' -k1,1nr -k2,2r
    )
    kept=0
    for entry in "${ordered[@]}"; do
      name=${entry#*$'\t'}
      [[ "$name" = *.incoming.* ]] && continue
      if [[ "$unmapped" = true ]] && (( kept < BUILD_CACHE_UNMAPPED_RETENTION )); then
        retained["$kind"$'\t'"$name"]=1
        kept=$((kept + 1))
      fi
    done
    for entry in "${ordered[@]}"; do
      name=${entry#*$'\t'}
      candidate="$root/$name"
      cache_key=${name%%.incoming.*}
      if [[ "$name" = "$cache_key" && -n ${retained["$kind"$'\t'"$cache_key"]:-} ]]; then
        BUILD_CACHE_RETAINED=$((BUILD_CACHE_RETAINED + 1))
        continue
      fi
      [[ -d "$candidate" && ! -L "$candidate" ]] ||
        fail "build cache entry changed type during retention: $candidate"
      resolved=$(realpath -e -- "$candidate") ||
        fail "build cache entry cannot be resolved: $candidate"
      [[ "$resolved" = "$candidate" ]] ||
        fail "build cache entry escaped its canonical root: $candidate"
      size=$(du -sb --one-file-system -- "$candidate" | cut -f1)
      [[ "$size" =~ ^[0-9]+$ ]] || size=0
      rm -rf --one-file-system "$candidate"
      [[ ! -e "$candidate" && ! -L "$candidate" ]] ||
        fail "build cache entry was not fully removed: $candidate"
      BUILD_CACHE_DELETED=$((BUILD_CACHE_DELETED + 1))
      BUILD_CACHE_FREED_BYTES=$((BUILD_CACHE_FREED_BYTES + size))
    done
  done
  printf 'Build cache retention: deleted=%s retained=%s freed_bytes=%s unmapped=%s\n' \
    "$BUILD_CACHE_DELETED" "$BUILD_CACHE_RETAINED" "$BUILD_CACHE_FREED_BYTES" "$unmapped"
}

# A candidate preflight database or /tmp snapshot never outlives its run (on_exit removes it),
# so under the deployment lock any remaining one was orphaned by a killed run.
cleanup_stale_preflight_leftovers() {
  [[ ${ASH_ATLAS_DEPLOY_LOCK_HELD:-false} = true ]] ||
    fail 'stale preflight cleanup requires the deployment lock'
  if flock -n "$LOCK_FILE" -c true; then
    fail 'stale preflight cleanup requires an actually held deployment lock'
  fi
  STALE_PREFLIGHT_DATABASES_DROPPED=0
  STALE_PREFLIGHT_SNAPSHOTS_REMOVED=0
  local databases database snapshot
  databases=$(sudo -u postgres psql --dbname=postgres --no-align --tuples-only \
    --command="SELECT datname FROM pg_database WHERE left(datname, 20) = 'ash_atlas_preflight_' ORDER BY 1") ||
    fail 'stale preflight databases could not be listed'
  while IFS= read -r database; do
    [[ -z "$database" || "$database" = "$PREFLIGHT_TEMPLATE_DATABASE" ||
        "$database" = "${PREFLIGHT_DATABASE:-}" ]] && continue
    [[ "$database" =~ ^ash_atlas_preflight_[a-z0-9_]{1,45}$ ]] || continue
    sudo -u postgres dropdb --if-exists --force "$database" ||
      fail "stale preflight database could not be dropped: $database"
    STALE_PREFLIGHT_DATABASES_DROPPED=$((STALE_PREFLIGHT_DATABASES_DROPPED + 1))
  done <<<"$databases"
  while IFS= read -r -d '' snapshot; do
    [[ "$snapshot" = "${PREFLIGHT_MIGRATIONS_STAGE:-}" ]] && continue
    [[ "$snapshot" =~ ^"$PREFLIGHT_SNAPSHOT_PARENT"/ash-atlas-preflight-[0-9a-f]{8}\.[A-Za-z0-9]{8}$ &&
        -d "$snapshot" && ! -L "$snapshot" ]] || continue
    rm -rf --one-file-system -- "$snapshot" ||
      fail "stale preflight snapshot could not be removed: $snapshot"
    STALE_PREFLIGHT_SNAPSHOTS_REMOVED=$((STALE_PREFLIGHT_SNAPSHOTS_REMOVED + 1))
  done < <(find "$PREFLIGHT_SNAPSHOT_PARENT" -mindepth 1 -maxdepth 1 -type d \
    -name 'ash-atlas-preflight-*' -print0)
  printf 'Stale preflight cleanup: databases_dropped=%s snapshots_removed=%s\n' \
    "$STALE_PREFLIGHT_DATABASES_DROPPED" "$STALE_PREFLIGHT_SNAPSHOTS_REMOVED"
}

client_asset_manifest_entries() {
  local release_root=$1
  local ignore_manifest=${2:-false}
  local manifest="$release_root/.ash-atlas-client-assets.json"
  if [[ "$ignore_manifest" != true && -f "$manifest" && ! -L "$manifest" ]]; then
    "$NODE_BIN" - "$manifest" <<'NODE'
const fs = require("node:fs");
const manifest = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const assetName = /^.+-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/u;
if (manifest?.schema_version !== 1 || !Array.isArray(manifest.assets)) {
  throw new Error("client asset manifest is invalid");
}
for (const entry of manifest.assets) {
  if (entry === null || typeof entry !== "object" ||
      typeof entry.path !== "string" || !/^assets\/[A-Za-z0-9._/-]+$/u.test(entry.path) ||
      entry.path.includes("..") || !assetName.test(entry.path.split("/").pop()) ||
      !Number.isInteger(entry.retention) || entry.retention < 0) {
    throw new Error("client asset manifest entry is unsafe");
  }
  // Older manifests included literal public/ assets whose descriptive suffix
  // looked like a hash. Only flat Vite outputs have content-derived names.
  if (entry.path.split("/").length !== 2) continue;
  process.stdout.write(`${entry.path}\t${entry.retention}\n`);
}
NODE
    return
  fi
  [[ -d "$release_root/assets" && ! -L "$release_root/assets" ]] || return 0
  find -P "$release_root/assets" -mindepth 1 -maxdepth 1 -xdev -type f -printf '%f\n' |
    awk '$0 ~ /^.+-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/ { print "assets/" $0 "\t3" }'
}

record_client_asset_retention() {
  local path=$1 retention=$2 previous
  [[ "$path" =~ ^assets/[A-Za-z0-9._-]+$ && "$path" != *..* &&
      "${path##*/}" =~ ^.+-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$ &&
      "$retention" =~ ^[0-9]+$ ]] ||
    fail 'client asset retention identity is unsafe'
  previous=${CLIENT_ASSET_RETENTION[$path]:-}
  if [[ -z "$previous" || "$retention" -gt "$previous" ]]; then
    CLIENT_ASSET_RETENTION["$path"]=$retention
  fi
}

seed_client_asset_retention_from_destination() {
  local destination=$1 manifest_entries relative _
  manifest_entries=$(client_asset_manifest_entries "$destination" true) ||
    fail 'candidate public asset manifest could not be derived'
  while IFS=$'\t' read -r relative _; do
    [[ -n "$relative" ]] || continue
    [[ -f "$destination/$relative" && ! -L "$destination/$relative" ]] ||
      fail 'candidate public asset is absent or symbolic while seeding retention'
    record_client_asset_retention "$relative" 3
  done <<< "$manifest_entries"
}

write_client_asset_manifest() {
  local destination=$1
  local manifest="$destination/.ash-atlas-client-assets.json"
  local path first=true
  local -a paths=()
  if (( ${#CLIENT_ASSET_RETENTION[@]} > 0 )); then
    mapfile -t paths < <(printf '%s\n' "${!CLIENT_ASSET_RETENTION[@]}" | LC_ALL=C sort)
  fi
  {
    printf '{"schema_version":1,"assets":['
    for path in "${paths[@]}"; do
      if [[ "$first" = true ]]; then first=false; else printf ','; fi
      printf '{"path":"%s","retention":%s}' "$path" "${CLIENT_ASSET_RETENTION[$path]}"
    done
    printf ']}\n'
  } > "$manifest"
}

prune_client_assets_to_manifest() {
  local destination=$1 relative asset_root asset_file manifest_entries
  local -A retained=()
  manifest_entries=$(client_asset_manifest_entries "$destination") ||
    fail 'client asset manifest could not be read while pruning assets'
  while IFS=$'\t' read -r relative _; do
    [[ -n "$relative" ]] || continue
    retained["$relative"]=1
  done <<< "$manifest_entries"
  asset_root="$destination/assets"
  [[ -d "$asset_root" && ! -L "$asset_root" ]] || return 0
  while IFS= read -r -d '' asset_file; do
    [[ -f "$asset_file" && ! -L "$asset_file" ]] ||
      fail 'candidate public asset is absent or symbolic while pruning hashed assets'
    relative="assets/${asset_file#"$asset_root/"}"
    if [[ -z ${retained[$relative]:-} ]]; then
      rm -f -- "$asset_file"
    fi
  done < <(find -P "$asset_root" -mindepth 1 -maxdepth 1 -xdev -type f -print0 | while IFS= read -r -d '' asset_file; do
    name=${asset_file##*/}
    [[ "$name" =~ ^.+-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$ ]] && printf '%s\0' "$asset_file"
  done)
}

copy_previous_hashed_client_assets() {
  local destination=$1 current_target current_sha root entry name source_root source_file
  local relative source_retention adjusted_retention destination_file copied=0 manifest_entries
  local preserve_current_client=false
  if [[ ${CLIENT_SOURCE:-} = previous_release ]]; then
    preserve_current_client=true
  fi
  [[ -d "$destination" && ! -L "$destination" ]] ||
    fail 'client artifact destination is absent or unsafe while preserving prior assets'
  current_target=$(readlink -e -- "$CLIENT_CURRENT_LINK" 2>/dev/null || true)
  root=$(realpath -e -- "$CLIENT_RELEASE_ROOT") ||
    fail 'client release root cannot be resolved while preserving prior assets'
  [[ "$current_target" = "$root/"* ]] ||
    fail 'active public release is outside its canonical root while preserving prior assets'
  current_sha=${current_target##*/}
  [[ "$current_sha" =~ ^[0-9a-f]{40}$ && "$current_target" = "$root/$current_sha" &&
      -d "$current_target" && ! -L "$current_target" ]] ||
    fail 'active public release is not an immutable physical release while preserving prior assets'

  local -a ordered=()
  mapfile -t ordered < <(
    find -P "$root" -mindepth 1 -maxdepth 1 -type d ! -lname '*' \
      -printf '%T@\t%f\n' |
      awk -F '\t' '$2 ~ /^[0-9a-f]{40}$/ { print }' |
      sort -t $'\t' -k1,1nr -k2,2r
  )
  local -a source_shas=("$current_sha")
  for entry in "${ordered[@]}"; do
    name=${entry#*$'\t'}
    [[ "$name" = "$current_sha" || "$name" = "$GAME_SHA" ]] && continue
    source_shas+=("$name")
    (( ${#source_shas[@]} >= 3 )) && break
  done

  local source_index=0
  for name in "${source_shas[@]}"; do
    source_root="$root/$name"
    [[ -d "$source_root" && ! -L "$source_root" ]] || continue
    manifest_entries=$(client_asset_manifest_entries "$source_root") ||
      fail "prior public asset manifest is invalid: $source_root"
    while IFS=$'\t' read -r relative source_retention; do
      [[ -n "$relative" ]] || continue
      if [[ "$preserve_current_client" = true && "$source_index" -eq 0 ]]; then
        adjusted_retention=$source_retention
      else
        adjusted_retention=$((source_retention - source_index - 1))
      fi
      (( adjusted_retention >= 0 )) || continue
      record_client_asset_retention "$relative" "$adjusted_retention"
      source_file="$source_root/$relative"
      [[ -f "$source_file" && ! -L "$source_file" ]] ||
        fail 'prior public asset is absent or symbolic while preserving hashed assets'
      destination_file="$destination/$relative"
      [[ "$destination_file" = "$destination/assets/"* ]] ||
        fail 'prior public asset escaped the candidate asset directory'
      if [[ -e "$destination_file" || -L "$destination_file" ]]; then
        [[ -f "$destination_file" && ! -L "$destination_file" ]] ||
          fail 'candidate public asset collision is not a regular file'
        cmp -s "$source_file" "$destination_file" ||
          fail "hashed public asset collision differs: $relative"
        continue
      fi
      install -d -m 0755 "$(dirname "$destination_file")"
      install -m 0644 "$source_file" "$destination_file"
      copied=$((copied + 1))
    done <<< "$manifest_entries"
    source_index=$((source_index + 1))
  done
  printf 'Prior hashed public assets preserved: %s files from up to three releases\n' "$copied"
}

cleanup_stale_source_worktrees() {
  STALE_WORKTREES_REMOVED=0
  if [[ ! -d "$WORKTREE_ROOT" || -L "$WORKTREE_ROOT" ||
        ! -d "$MIRROR_ROOT" || -L "$MIRROR_ROOT" ||
        ! -d "$OPERATION_ROOT" || -L "$OPERATION_ROOT" ]]; then
    printf 'WARNING: stale deployment worktree cleanup skipped because a root is absent or unsafe\n' >&2
    return 0
  fi

  local active_operation=''
  local active_marker="$OPERATION_ROOT/active-operation"
  if [[ -e "$active_marker" || -L "$active_marker" ]]; then
    if [[ ! -f "$active_marker" || -L "$active_marker" ]]; then
      printf 'WARNING: stale deployment worktree cleanup skipped because the active marker is unsafe\n' >&2
      return 0
    fi
    active_operation=$(<"$active_marker")
    if [[ ! "$active_operation" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$ ]]; then
      printf 'WARNING: stale deployment worktree cleanup skipped because the active marker is invalid\n' >&2
      return 0
    fi
  fi

  local registered_worktrees
  if ! registered_worktrees=$(sudo -u debian git --git-dir="$MIRROR_ROOT" worktree list --porcelain 2>/dev/null); then
    printf 'WARNING: stale deployment worktree cleanup skipped because registered worktrees are unreadable\n' >&2
    return 0
  fi

  local candidate name short_sha operation git_pointer gitdir metadata receipt terminal_result
  for candidate in "$WORKTREE_ROOT"/ash-atlas-????????-*; do
    [[ -e "$candidate" || -L "$candidate" ]] || continue
    [[ -d "$candidate" && ! -L "$candidate" ]] || continue
    [[ "$candidate" != "${SOURCE_ROOT:-}" ]] || continue
    name=${candidate##*/}
    [[ "$name" =~ ^ash-atlas-([0-9a-f]{8})-([A-Za-z0-9][A-Za-z0-9._-]{0,95})$ ]] || continue
    short_sha=${BASH_REMATCH[1]}
    operation=${BASH_REMATCH[2]}
    [[ -z "$active_operation" || "$operation" != "$active_operation" ]] || continue
    [[ -f "$candidate/.git" && ! -L "$candidate/.git" ]] || continue
    git_pointer=$(<"$candidate/.git")
    [[ "$git_pointer" == 'gitdir: '* ]] || continue
    gitdir=${git_pointer#gitdir: }
    [[ "$gitdir" == "$MIRROR_ROOT"/worktrees/* ]] || continue
    metadata=${gitdir#"$MIRROR_ROOT/worktrees/"}
    [[ "$metadata" =~ ^[A-Za-z0-9._-]+$ ]] || continue
    [[ ! -e "$gitdir" && ! -L "$gitdir" ]] || continue
    if grep -Fqx "worktree $candidate" <<<"$registered_worktrees"; then
      continue
    fi
    receipt="$OPERATION_ROOT/$operation.json"
    [[ -f "$receipt" && ! -L "$receipt" ]] || continue
    if ! terminal_result=$(/usr/bin/node - "$receipt" "$operation" "$short_sha" <<'NODE'
const fs = require("node:fs");
const receipt = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (receipt.operation_id !== process.argv[3]) process.exit(1);
if (!/^[0-9a-f]{40}$/.test(receipt.requested_target_sha) ||
    !receipt.requested_target_sha.startsWith(process.argv[4])) process.exit(1);
if (receipt.result !== "completed" && receipt.result !== "failed") process.exit(1);
process.stdout.write(receipt.result);
NODE
    ); then
      continue
    fi
    if worktree_has_mounts "$candidate"; then
      printf 'WARNING: proven stale deployment worktree contains or is a mount and was retained: %s\n' "$candidate" >&2
      continue
    fi
    if find "$candidate" -xdev -type d -exec chmod u+rwx {} + 2>/dev/null &&
        rm -rf --one-file-system "$candidate" &&
        [[ ! -e "$candidate" && ! -L "$candidate" ]]; then
      STALE_WORKTREES_REMOVED=$((STALE_WORKTREES_REMOVED + 1))
      printf 'Removed proven stale deployment worktree: %s (%s)\n' "$candidate" "$terminal_result"
    else
      printf 'WARNING: proven stale deployment worktree could not be removed: %s\n' "$candidate" >&2
    fi
  done
  return 0
}

hash_files() {
  local root=$1
  shift
  (
    cd "$root"
    for pattern in "$@"; do
      find . -path "$pattern" -type f -print0 2>/dev/null || true
    done | sort -zu | xargs -0r sha256sum
  ) | sha256sum | cut -d' ' -f1
}

provision_cache_directory() {
  local path=$1
  local owner=$2
  local group=$3
  local mode=$4
  if [[ -L "$path" || ( -e "$path" && ! -d "$path" ) ]]; then
    fail "cache path is not a physical directory: $path"
  fi
  install -d -o "$owner" -g "$group" -m "$mode" "$path"
}

provision_cache_directories() {
  # Root owns the non-writable traversal parents. The build user directly owns
  # only the three working parents where content-addressed entries are created.
  provision_cache_directory "$CACHE_ROOT" root debian 0750
  provision_cache_directory "$CACHE_ROOT/dependencies" debian ash-atlas 0750
  provision_cache_directory "$CACHE_ROOT/builds" root debian 0750
  provision_cache_directory "$CACHE_ROOT/builds/server" debian ash-atlas 0750
  provision_cache_directory "$CACHE_ROOT/builds/client" debian ash-atlas 0750
  provision_cache_directory "$CACHE_ROOT/static-integrity" root root 0750
}

preflight_cache_access() {
  local path
  sudo -u debian test -x "$CACHE_ROOT"
  sudo -u debian test -x "$CACHE_ROOT/dependencies"
  sudo -u debian test -x "$CACHE_ROOT/builds"
  sudo -u debian test -x "$CACHE_ROOT/builds/server"
  sudo -u debian test -x "$CACHE_ROOT/builds/client"
  for path in "$CACHE_ROOT/dependencies" "$CACHE_ROOT/builds/server" "$CACHE_ROOT/builds/client"; do
    sudo -u debian bash -c '
      set -euo pipefail
      umask 0027
      temporary=$(mktemp -d "$1/.permission-preflight.XXXXXXXX")
      cleanup() { rm -rf -- "$temporary"; }
      trap cleanup EXIT
      printf preflight > "$temporary/write"
      mv "$temporary/write" "$temporary/renamed"
      rm "$temporary/renamed"
      rmdir "$temporary"
      trap - EXIT
    ' bash "$path"
  done
}

load_world_runtime_authority() {
  local lock_path=$1 authority
  [[ -f "$lock_path" && ! -L "$lock_path" ]] ||
    fail 'candidate World runtime lock is absent or unsafe'
  authority=$(
    "$NODE_BIN" - "$lock_path" <<'NODE'
const fs = require("node:fs");
const [path] = process.argv.slice(2);
const lock = JSON.parse(fs.readFileSync(path, "utf8"));
const object = (value, field) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} is absent or not an object`);
  }
  return value;
};
const string = (value, field) => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} is absent or not a non-empty string`);
  }
  return value;
};
const exact = (value, expected, field) => {
  if (value !== expected) throw new Error(`${field} differs`);
  return value;
};
const sha = (value, field, length) => {
  const result = string(value, field);
  const pattern = length === 40 ? /^[0-9a-f]{40}$/ : /^[0-9a-f]{64}$/;
  if (!pattern.test(result)) throw new Error(`${field} is not a lowercase SHA`);
  return result;
};
const positiveInteger = (value, field) => {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${field} is not a positive integer`);
  return value;
};
const positiveNumber = (value, field) => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${field} is not a positive number`);
  }
  return value;
};
if (lock.schema_version !== 1) throw new Error("World lock schema is unsupported");
const pipeline = object(lock.pipeline, "World lock pipeline");
const branch = exact(pipeline.protected_branch, "main", "World lock pipeline.protected_branch");
exact(pipeline.repository, "example-org/world-data", "World lock pipeline.repository");
const worldSha = sha(pipeline.sha, "World lock pipeline.sha", 40);
const release = object(lock.release, "World lock release");
const worldRelease = exact(release.release_id, "world-packages-v1", "World lock release.release_id");
const worldManifest = sha(release.manifest_sha256, "World lock release.manifest_sha256", 64);
const index = object(lock.water_name_index, "World lock water_name_index");
const indexRelease = exact(index.release_id, "water-names-v1", "World lock water_name_index.release_id");
const indexManifest = sha(index.manifest_sha256, "World lock water_name_index.manifest_sha256", 64);
const indexSchema = exact(index.schema, "water-names-v1", "World lock water_name_index.schema");
const indexPolicy = exact(index.policy, "same-class-nearest-authoritative-name-v1", "World lock water_name_index.policy");
const entriesFilename = exact(index.entries_filename, "entries.sqlite3", "World lock water_name_index.entries_filename");
const entriesFormat = exact(index.entries_format, "sqlite-wkb-rtree-v1", "World lock water_name_index.entries_format");
const entriesSha = sha(index.entries_sha256, "World lock water_name_index.entries_sha256", 64);
const entriesSize = positiveInteger(index.entries_size_bytes, "World lock water_name_index.entries_size_bytes");
const indexHash = sha(index.index_hash, "World lock water_name_index.index_hash", 64);
const deterministicFingerprint = sha(
  index.deterministic_fingerprint,
  "World lock water_name_index.deterministic_fingerprint",
  64
);
const entryCount = positiveInteger(index.entry_count, "World lock water_name_index.entry_count");
const classes = object(index.classes, "World lock water_name_index.classes");
const riverCount = positiveInteger(classes.river, "World lock water_name_index.classes.river");
const lakeCount = positiveInteger(classes.lake, "World lock water_name_index.classes.lake");
const oceanCount = positiveInteger(classes.ocean, "World lock water_name_index.classes.ocean");
if (riverCount + lakeCount + oceanCount !== entryCount) {
  throw new Error("World lock water_name_index class counts do not sum to entry_count");
}
const maxDistance = object(index.max_distance_m, "World lock water_name_index.max_distance_m");
const riverMaxDistance = positiveNumber(maxDistance.river, "World lock water_name_index.max_distance_m.river");
const lakeMaxDistance = positiveNumber(maxDistance.lake, "World lock water_name_index.max_distance_m.lake");
const oceanMaxDistance = positiveNumber(maxDistance.ocean, "World lock water_name_index.max_distance_m.ocean");
process.stdout.write([
  branch, worldSha, worldRelease, worldManifest,
  indexRelease, indexManifest, indexSchema, indexPolicy, entriesFilename, entriesFormat,
  entriesSha, entriesSize, indexHash, deterministicFingerprint, entryCount,
  riverCount, lakeCount, oceanCount, riverMaxDistance, lakeMaxDistance, oceanMaxDistance
].join("\t"));
NODE
  ) || fail 'World runtime lock authority is invalid'
  local -a fields=()
  IFS=$'\t' read -r -a fields <<<"$authority"
  [[ ${#fields[@]} -eq 21 ]] || fail 'World runtime lock authority has an unexpected shape'
  WORLD_RUNTIME_BRANCH=${fields[0]}
  WORLD_SHA=${fields[1]}
  WORLD_RELEASE=${fields[2]}
  WORLD_MANIFEST_SHA256=${fields[3]}
  WATER_NAME_INDEX_RELEASE=${fields[4]}
  WATER_NAME_INDEX_MANIFEST_SHA256=${fields[5]}
  WATER_NAME_INDEX_SCHEMA=${fields[6]}
  WATER_NAME_INDEX_POLICY=${fields[7]}
  WATER_NAME_INDEX_ENTRIES_FILENAME=${fields[8]}
  WATER_NAME_INDEX_ENTRIES_FORMAT=${fields[9]}
  WATER_NAME_INDEX_ENTRIES_SHA256=${fields[10]}
  WATER_NAME_INDEX_ENTRIES_SIZE=${fields[11]}
  WATER_NAME_INDEX_HASH=${fields[12]}
  WATER_NAME_INDEX_DETERMINISTIC_FINGERPRINT=${fields[13]}
  WATER_NAME_INDEX_ENTRY_COUNT=${fields[14]}
  WATER_NAME_INDEX_RIVER_COUNT=${fields[15]}
  WATER_NAME_INDEX_LAKE_COUNT=${fields[16]}
  WATER_NAME_INDEX_OCEAN_COUNT=${fields[17]}
  WATER_NAME_INDEX_RIVER_MAX_DISTANCE_M=${fields[18]}
  WATER_NAME_INDEX_LAKE_MAX_DISTANCE_M=${fields[19]}
  WATER_NAME_INDEX_OCEAN_MAX_DISTANCE_M=${fields[20]}
  WATER_NAME_INDEX_ROOT=/srv/ash-atlas/world/releases/$WATER_NAME_INDEX_RELEASE
  WATER_NAME_INDEX_MANIFEST=$WATER_NAME_INDEX_ROOT/manifest.json
  WATER_NAME_INDEX_ENTRIES=$WATER_NAME_INDEX_ROOT/$WATER_NAME_INDEX_ENTRIES_FILENAME
}

validate_world_runtime_invariants() {
  local world_health
  [[ -n "$WORLD_RUNTIME_BRANCH" && "$WORLD_RUNTIME_BRANCH" = main &&
     "$WORLD_SHA" =~ ^[0-9a-f]{40}$ && "$WORLD_RELEASE" = world-packages-v1 &&
     "$WORLD_MANIFEST_SHA256" =~ ^[0-9a-f]{64}$ ]] ||
    fail 'loaded World runtime authority is unsafe'
  systemctl is-active --quiet ash-atlas-world.service || fail 'World service is not active'
  /usr/local/libexec/ash-atlas-wait-ready world
  systemctl cat ash-atlas-world.service | grep -Fq -- "--runtime-branch $WORLD_RUNTIME_BRANCH" || fail 'World runtime branch differs'
  systemctl cat ash-atlas-world.service | grep -Fq -- "--runtime-sha $WORLD_SHA" || fail 'World runtime SHA differs'
  systemctl cat ash-atlas-world.service | grep -Fq -- "--release-root /srv/ash-atlas/world/releases/$WORLD_RELEASE" || fail 'World data release differs'
  systemctl cat ash-atlas-world.service | grep -Fq -- '--artifact-verification-mode manifest-only' || fail 'World startup is not manifest-only'
  systemctl cat ash-atlas-world.service | grep -Fq -- "--expected-manifest-sha256 $WORLD_MANIFEST_SHA256" || fail 'World release manifest differs'
  systemctl cat ash-atlas-world.service | grep -Fq -- "--expected-release-root /srv/ash-atlas/world/releases/$WORLD_RELEASE" || fail 'World expected release root differs'
  systemctl cat ash-atlas-world.service | grep -Fq -- "--water-name-index-root $WATER_NAME_INDEX_ROOT" || fail 'World water-name index release differs'
  systemctl cat ash-atlas-world.service | grep -Fq -- "--water-name-index-manifest-sha256 $WATER_NAME_INDEX_MANIFEST_SHA256" || fail 'World water-name index manifest differs'
  [[ -d "$WATER_NAME_INDEX_ROOT" && ! -L "$WATER_NAME_INDEX_ROOT" &&
     -f "$WATER_NAME_INDEX_MANIFEST" && ! -L "$WATER_NAME_INDEX_MANIFEST" &&
     -f "$WATER_NAME_INDEX_ENTRIES" && ! -L "$WATER_NAME_INDEX_ENTRIES" ]] ||
    fail 'immutable water-name index release is absent or unsafe'
  [[ $(sha256sum "$WATER_NAME_INDEX_MANIFEST" | cut -d' ' -f1) = "$WATER_NAME_INDEX_MANIFEST_SHA256" ]] ||
    fail 'water-name index manifest hash differs'
  [[ $(stat -c '%s' "$WATER_NAME_INDEX_ENTRIES") = "$WATER_NAME_INDEX_ENTRIES_SIZE" ]] ||
    fail 'water-name index entries size differs'
  "$NODE_BIN" - "$WATER_NAME_INDEX_MANIFEST" "$WATER_NAME_INDEX_RELEASE" \
    "$WATER_NAME_INDEX_SCHEMA" "$WATER_NAME_INDEX_POLICY" "$WATER_NAME_INDEX_ENTRIES_FILENAME" \
    "$WATER_NAME_INDEX_ENTRIES_FORMAT" "$WATER_NAME_INDEX_ENTRIES_SHA256" "$WATER_NAME_INDEX_HASH" \
    "$WATER_NAME_INDEX_DETERMINISTIC_FINGERPRINT" "$WATER_NAME_INDEX_ENTRY_COUNT" \
    "$WATER_NAME_INDEX_RIVER_COUNT" "$WATER_NAME_INDEX_LAKE_COUNT" "$WATER_NAME_INDEX_OCEAN_COUNT" \
    "$WATER_NAME_INDEX_RIVER_MAX_DISTANCE_M" "$WATER_NAME_INDEX_LAKE_MAX_DISTANCE_M" \
    "$WATER_NAME_INDEX_OCEAN_MAX_DISTANCE_M" <<'NODE'
const fs = require("node:fs");
const [path, releaseId, schema, policy, entriesFilename, entriesFormat, entriesSha256, indexHash,
  deterministicFingerprint, entryCount, riverCount, lakeCount, oceanCount, riverMaxDistanceM,
  lakeMaxDistanceM, oceanMaxDistanceM] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(path, "utf8"));
if (manifest?.ok !== true || manifest?.status !== "published" || manifest?.release_id !== releaseId ||
    manifest?.schema !== schema || manifest?.policy !== policy ||
    manifest?.entries_filename !== entriesFilename || manifest?.entries_format !== entriesFormat ||
    manifest?.entries_sha256 !== entriesSha256 || manifest?.index_hash !== indexHash ||
    manifest?.deterministic_fingerprint !== deterministicFingerprint ||
    manifest?.entry_count !== Number(entryCount) || manifest?.classes?.river !== Number(riverCount) ||
    manifest?.classes?.lake !== Number(lakeCount) || manifest?.classes?.ocean !== Number(oceanCount) ||
    manifest?.max_distance_m?.river !== Number(riverMaxDistanceM) ||
    manifest?.max_distance_m?.lake !== Number(lakeMaxDistanceM) ||
    manifest?.max_distance_m?.ocean !== Number(oceanMaxDistanceM)) process.exit(1);
NODE
  world_health=$(curl --fail --silent --show-error --max-time 20 'http://127.0.0.1:8765/api/health') || fail 'World health endpoint could not be read'
  "$NODE_BIN" - "$world_health" "$WORLD_RUNTIME_BRANCH" "$WORLD_SHA" "$WORLD_RELEASE" \
    "$WORLD_MANIFEST_SHA256" "$WATER_NAME_INDEX_RELEASE" "$WATER_NAME_INDEX_MANIFEST_SHA256" \
    "$WATER_NAME_INDEX_SCHEMA" "$WATER_NAME_INDEX_POLICY" "$WATER_NAME_INDEX_HASH" \
    "$WATER_NAME_INDEX_ENTRY_COUNT" "$WATER_NAME_INDEX_RIVER_COUNT" "$WATER_NAME_INDEX_LAKE_COUNT" \
    "$WATER_NAME_INDEX_OCEAN_COUNT" "$WATERBODY_IDENTITY_OVERLAY_RELEASE" \
    "$WATERBODY_IDENTITY_OVERLAY_MANIFEST_SHA256" "$WATERBODY_IDENTITY_OVERLAY_SCHEMA" \
    "$WATERBODY_IDENTITY_OVERLAY_SCHEMA_VERSION" "$WATERBODY_IDENTITY_OVERLAY_POLICY" \
    "$WATERBODY_IDENTITY_OVERLAY_POLICY_VERSION" <<'NODE'
const [raw, branch, worldSha, worldRelease, worldManifest, indexRelease, indexManifest, indexSchema,
  indexPolicy, indexHash, indexEntryCount, indexRiverCount, indexLakeCount, indexOceanCount,
  overlayRelease, overlayManifest, overlaySchema, overlaySchemaVersion, overlayPolicy,
  overlayPolicyVersion] = process.argv.slice(2);
const body = JSON.parse(raw);
if (body?.ok !== true || body?.status !== "ready" || body?.runtime?.branch !== branch ||
    body?.runtime?.sha !== worldSha || body?.release?.release_id !== worldRelease ||
    body?.release_verification?.verification_mode !== "manifest-only" ||
    body?.release_verification?.release_manifest_sha256 !== worldManifest ||
    body?.release_verification?.release_root !== `/srv/ash-atlas/world/releases/${worldRelease}`) process.exit(1);
const overlay = body?.waterbody_identity_overlay;
if (overlay?.release_id !== overlayRelease || overlay?.manifest_sha256 !== overlayManifest ||
    overlay?.schema !== overlaySchema || overlay?.schema_version !== overlaySchemaVersion ||
    overlay?.policy !== overlayPolicy || overlay?.policy_version !== overlayPolicyVersion ||
    body?.capabilities?.waterbodyIdentityV1 !== true) process.exit(1);
const index = body?.water_name_index;
if (index?.release_id !== indexRelease || index?.manifest_sha256 !== indexManifest ||
    index?.schema !== indexSchema || index?.policy !== indexPolicy || index?.index_hash !== indexHash ||
    index?.entry_count !== Number(indexEntryCount) || index?.classes?.river !== Number(indexRiverCount) ||
    index?.classes?.lake !== Number(indexLakeCount) || index?.classes?.ocean !== Number(indexOceanCount) ||
    body?.capabilities?.waterNameFallbackV1 !== true) process.exit(1);
NODE
}

cache_artifact() {
  local source=$1
  local cache_dir=$2
  local relative=$3
  local incoming="${cache_dir}.incoming.$$"
  [[ ! -e "$incoming" ]] || fail "cache incoming path exists: $incoming"
  install -d -o debian -g debian -m 0750 "$incoming"
  sudo -u debian tar -C "$source" -czf "$incoming/artifact.tar.gz" "$relative"
  sha256sum "$incoming/artifact.tar.gz" | cut -d' ' -f1 > "$incoming/artifact.sha256"
  chmod 0440 "$incoming/artifact.tar.gz" "$incoming/artifact.sha256"
  if ! mv -T "$incoming" "$cache_dir" 2>/dev/null; then
    rm -rf --one-file-system "$incoming"
    [[ -f "$cache_dir/artifact.tar.gz" ]] || fail "concurrent cache publication did not produce $cache_dir"
  fi
}

restore_artifact() {
  local cache_dir=$1
  local target=$2
  local expected actual
  [[ -f "$cache_dir/artifact.tar.gz" && -f "$cache_dir/artifact.sha256" ]] || return 1
  expected=$(cat "$cache_dir/artifact.sha256")
  actual=$(sha256sum "$cache_dir/artifact.tar.gz" | cut -d' ' -f1)
  [[ "$actual" = "$expected" ]] || fail "cached artifact hash differs: $cache_dir"
  sudo -u debian tar -C "$target" -xzf "$cache_dir/artifact.tar.gz"
}

restore_dependencies() {
  local cache_dir=$1
  [[ -f "$cache_dir/node-modules.tar.gz" && -f "$cache_dir/node-modules.sha256" ]] || return 1
  local expected actual
  expected=$(cat "$cache_dir/node-modules.sha256")
  actual=$(sha256sum "$cache_dir/node-modules.tar.gz" | cut -d' ' -f1)
  [[ "$actual" = "$expected" ]] || fail "dependency cache hash differs: $cache_dir"
  sudo -u debian tar -C "$SOURCE_ROOT" -xzf "$cache_dir/node-modules.tar.gz"
  sudo -u debian env HOME=/home/debian pnpm --dir "$SOURCE_ROOT" list --depth=-1 >/dev/null
}

cache_dependencies() {
  local cache_dir=$1
  local incoming="${cache_dir}.incoming.$$"
  install -d -o debian -g debian -m 0750 "$incoming"
  (
    cd "$SOURCE_ROOT"
    find . -type d -name node_modules -prune -print0 |
      sudo -u debian tar --null -T - -czf "$incoming/node-modules.tar.gz"
  )
  sha256sum "$incoming/node-modules.tar.gz" | cut -d' ' -f1 > "$incoming/node-modules.sha256"
  chmod 0440 "$incoming/node-modules.tar.gz" "$incoming/node-modules.sha256"
  if ! mv -T "$incoming" "$cache_dir" 2>/dev/null; then
    rm -rf --one-file-system "$incoming"
    [[ -f "$cache_dir/node-modules.tar.gz" ]] || fail 'concurrent dependency cache publication failed'
  fi
}

prepare_world_handoff_rollback() {
  local previous_lock="$previous_game/config/world-runtime.lock.json"
  [[ -f "$previous_lock" && ! -L "$previous_lock" ]] ||
    fail 'previous game World lock is absent or unsafe'
  PREVIOUS_WORLD_SHA=$("$NODE_BIN" -e '
const lock = require(process.argv[1]);
const sha = lock?.pipeline?.sha;
if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha)) process.exit(1);
process.stdout.write(sha);
' "$previous_lock") || fail 'previous game World lock identity is invalid'
  if [[ "$PREVIOUS_WORLD_SHA" = "$WORLD_SHA" ]]; then
    return
  fi
  local candidate suffix
  local -a candidates=()
  while IFS= read -r candidate; do
    grep -Fq -- "--runtime-sha $PREVIOUS_WORLD_SHA" "$candidate" && candidates+=("$candidate")
  done < <(find /etc/systemd/system -maxdepth 1 -type f \
    -name 'ash-atlas-world.service.pre-*' -print)
  [[ ${#candidates[@]} -eq 1 ]] ||
    fail 'World handoff rollback requires exactly one prior World unit backup'
  WORLD_UNIT_BACKUP=${candidates[0]}
  suffix=${WORLD_UNIT_BACKUP#${WORLD_UNIT}.pre-}
  [[ "$suffix" =~ ^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$ ]] ||
    fail 'prior World unit backup operation identity is unsafe'
  WORLD_OPS_UNIT_BACKUP="$WORLD_OPS_UNIT.pre-$suffix"
  [[ -f "$WORLD_OPS_UNIT_BACKUP" && ! -L "$WORLD_OPS_UNIT_BACKUP" ]] ||
    fail 'paired prior World operations-unit backup is absent or unsafe'
  grep -Fq -- "--runtime-sha $PREVIOUS_WORLD_SHA" "$WORLD_OPS_UNIT_BACKUP" ||
    fail 'paired prior World operations-unit backup has a different identity'
  [[ -d "$WORLD_RUNTIME_RELEASE_ROOT/$PREVIOUS_WORLD_SHA" &&
     ! -L "$WORLD_RUNTIME_RELEASE_ROOT/$PREVIOUS_WORLD_SHA" ]] ||
    fail 'prior immutable World runtime release is absent or unsafe'
  WORLD_HANDOFF_ROLLBACK_REQUIRED=true
  operation_receipt_update world_handoff_rollback_required __TRUE__ \
    previous_world_sha "$PREVIOUS_WORLD_SHA" active_world_sha "$WORLD_SHA" \
    world_handoff_rollback_result prepared
}

restore_previous_world_for_rollback() {
  [[ ${WORLD_HANDOFF_ROLLBACK_REQUIRED:-false} = true ]] || return 0
  [[ ${WORLD_HANDOFF_ROLLBACK_COMPLETED:-false} != true ]] || return 0
  operation_receipt_update world_handoff_rollback_result running || true
  install -o root -g root -m 0644 "$WORLD_UNIT_BACKUP" "$WORLD_UNIT"
  install -o root -g root -m 0644 "$WORLD_OPS_UNIT_BACKUP" "$WORLD_OPS_UNIT"
  systemctl daemon-reload
  atomic_link "$WORLD_RUNTIME_RELEASE_ROOT/$PREVIOUS_WORLD_SHA" "$WORLD_RUNTIME_CURRENT_LINK"
  systemctl restart ash-atlas-world.service
  /usr/local/libexec/ash-atlas-wait-ready world
  systemctl cat ash-atlas-world.service | grep -Fq -- "--runtime-sha $PREVIOUS_WORLD_SHA"
  WORLD_HANDOFF_ROLLBACK_COMPLETED=true
  operation_receipt_update world_handoff_rollback_result completed || true
}

on_exit() {
  local code=$?
  local cleanup_started_ns source_cleanup_result migration_marker_present=false
  cleanup_started_ns=$(date +%s%N)
  source_cleanup_result=not_created
  if [[ -n ${PREVIOUS_RELEASE_COPY:-} ]]; then
    rm -f -- "$PREVIOUS_RELEASE_COPY" || true
    PREVIOUS_RELEASE_COPY=
  fi
  if cleanup_release_preflight; then
    operation_receipt_update candidate_cleanup_result completed 2>/dev/null || true
  else
    operation_receipt_update candidate_cleanup_result failed 2>/dev/null || true
    printf 'WARNING: release preflight cleanup failed\n' >&2
    code=1
  fi
  if [[ $code -ne 0 && ${ACTIVATION_STARTED:-false} = true ]]; then
    if [[ -e "$MIGRATION_INTENT_MARKER" || -L "$MIGRATION_INTENT_MARKER" ]]; then
      migration_marker_present=true
    fi
    if migration_rollback_requires_safe_stop \
        "${MIGRATION_COMMAND_STARTED:-false}" \
        "${MIGRATION_RECEIPT_COMPLETED:-false}" \
        "${PRIOR_BINARY_RESTART_SAFE:-true}" \
        "$migration_marker_present"; then
      operation_receipt_update rollback_result blocked_migration_compatibility_uncertain \
        migration_outcome_uncertain __TRUE__ || true
    elif [[ -n ${previous_game:-} && -n ${previous_public:-} ]]; then
      local rollback_ok=true
      operation_receipt_update rollback_result running || rollback_ok=false
      if [[ ${RELEASE_CLASS:-} = client_only ]]; then
        if [[ $(readlink -e "$CLIENT_CURRENT_LINK" 2>/dev/null || true) != "$previous_public" ]]; then
          restore_link "$previous_public" "$CLIENT_CURRENT_LINK" || rollback_ok=false
        fi
        if [[ $(readlink -e "$GAME_CURRENT_LINK" 2>/dev/null || true) = "$previous_game" ]]; then
          systemctl restart ash-atlas.service || rollback_ok=false
          /usr/local/libexec/ash-atlas-wait-ready game || rollback_ok=false
        else
          rollback_ok=false
        fi
      else
        systemctl stop ash-atlas.service || true
        restore_previous_world_for_rollback || rollback_ok=false
        if [[ $(readlink -e "$GAME_CURRENT_LINK" 2>/dev/null || true) != "$previous_game" ]]; then
          restore_link "$previous_game" "$GAME_CURRENT_LINK" || rollback_ok=false
        fi
        if [[ $(readlink -e "$CLIENT_CURRENT_LINK" 2>/dev/null || true) != "$previous_public" ]]; then
          restore_link "$previous_public" "$CLIENT_CURRENT_LINK" || rollback_ok=false
        fi
        update_runtime_identity "$previous_game_sha" "$previous_game_generation" || rollback_ok=false
        systemctl start ash-atlas.service || rollback_ok=false
        /usr/local/libexec/ash-atlas-wait-ready game || rollback_ok=false
      fi
      rm -f "${ENV_FILE}.new.${OPERATION_ID}" \
        "${GAME_CURRENT_LINK}.new.${OPERATION_ID}" \
        "${CLIENT_CURRENT_LINK}.new.${OPERATION_ID}" \
        "${GAME_CURRENT_LINK}.restore.${OPERATION_ID}" \
        "${CLIENT_CURRENT_LINK}.restore.${OPERATION_ID}"
      [[ $(readlink -e "$GAME_CURRENT_LINK" 2>/dev/null || true) = "$previous_game" &&
         $(readlink -e "$CLIENT_CURRENT_LINK" 2>/dev/null || true) = "$previous_public" ]] ||
        rollback_ok=false
      if [[ "$DEPLOY_MODE" = activate && -n ${PRE_SWITCH_ENV_SHA256:-} ]]; then
        [[ $(runtime_environment_sha256) = "$PRE_SWITCH_ENV_SHA256" ]] || rollback_ok=false
      fi
      operation_receipt_update rollback_result \
        "$(if [[ "$rollback_ok" = true ]]; then printf completed; else printf failed; fi)" || true
    else
      operation_receipt_update rollback_result failed || true
    fi
  fi
  if [[ $code -ne 0 ]]; then
    [[ -n ${GAME_INCOMING:-} ]] && rm -rf --one-file-system "$GAME_INCOMING"
    [[ -n ${CLIENT_INCOMING:-} ]] && rm -rf --one-file-system "$CLIENT_INCOMING"
    [[ -n ${SERVER_CACHE:-} ]] && rm -rf --one-file-system "${SERVER_CACHE}.incoming.$$"
    [[ -n ${CLIENT_CACHE:-} ]] && rm -rf --one-file-system "${CLIENT_CACHE}.incoming.$$"
    [[ -n ${DEPENDENCY_CACHE:-} ]] && rm -rf --one-file-system "${DEPENDENCY_CACHE}.incoming.$$"
  fi
  if [[ ${SOURCE_WORKTREE_REGISTERED:-false} = true &&
        -n ${SOURCE_ROOT:-} && -d ${SOURCE_ROOT:-} ]]; then
    source_cleanup_result=retained
    assert_source_clean exit ||
      printf 'WARNING: disposable source cleanliness could not be confirmed during cleanup\n' >&2
    if [[ -d ${MIRROR_ROOT:-} ]]; then
      if ! worktree_has_mounts "$SOURCE_ROOT" &&
          find "$SOURCE_ROOT" -xdev -type d -exec chmod u+rwx {} + 2>/dev/null &&
          sudo -u debian git --git-dir="$MIRROR_ROOT" worktree remove --force "$SOURCE_ROOT" >/dev/null 2>&1 &&
          [[ ! -e "$SOURCE_ROOT" && ! -L "$SOURCE_ROOT" ]]; then
        source_cleanup_result=removed
      else
        printf 'WARNING: disposable source worktree cleanup failed and was retained: %s\n' "$SOURCE_ROOT" >&2
      fi
      sudo -u debian git --git-dir="$MIRROR_ROOT" worktree prune >/dev/null 2>&1 ||
        printf 'WARNING: disposable worktree metadata prune failed\n' >&2
    fi
  elif [[ "$DEPLOY_MODE" = activate ]]; then
    source_cleanup_result=not_required
  fi
  operation_receipt_update worktree_cleanup "$source_cleanup_result" \
    stale_worktrees_removed "${STALE_WORKTREES_REMOVED:-0}" ||
    printf 'WARNING: worktree cleanup result could not be recorded in the operation receipt\n' >&2
  [[ -n ${BUILD_MANIFEST:-} ]] && rm -f "$BUILD_MANIFEST"
  [[ -n ${MIGRATION_CANDIDATES:-} ]] && rm -f "$MIGRATION_CANDIDATES"
  [[ -n ${MIGRATION_APPLIED:-} ]] && rm -f "$MIGRATION_APPLIED"
  [[ -n ${MIGRATION_POST_APPLIED:-} ]] && rm -f "$MIGRATION_POST_APPLIED"
  [[ -n ${PREFLIGHT_MIGRATION_LEDGER:-} ]] && rm -f "$PREFLIGHT_MIGRATION_LEDGER"
  if [[ -n ${TIMING_JSON:-} && -n ${TIMING_TSV:-} && -f ${TIMING_TSV:-} ]]; then
    record_phase worktree_cleanup "$cleanup_started_ns" \
      "$source_cleanup_result,stale_removed=${STALE_WORKTREES_REMOVED:-0}" ||
      printf 'WARNING: worktree cleanup timing could not be recorded\n' >&2
    write_timing_json "$(if [[ $code -eq 0 ]]; then printf completed; else printf failed; fi)" || code=1
  fi
  exit "$code"
}

if [[ ${ASH_ATLAS_CACHE_TEST_SOURCE_ONLY:-false} = true ||
      ${ASH_ATLAS_DEPLOY_UPDATE_SOURCE_ONLY:-false} = true ]]; then
  return 0
fi

[[ ${EUID} -eq 0 ]] || fail 'run as root'
[[ "$GAME_SHA" =~ ^[0-9a-f]{40}$ ]] || fail 'usage: deploy-test-update.sh APPROVED_40_CHARACTER_MASTER_SHA'
[[ "$DEPLOY_MODE" =~ ^(deploy|prepare|activate)$ ]] || fail 'deployment mode is unsafe'
[[ "$DEPLOY_MODE" != deploy ]] ||
  fail 'legacy deploy mode is disabled; use PREPARE then ACTIVATE with a durable activation intent'
if [[ "$DEPLOY_MODE" = prepare || "$DEPLOY_MODE" = activate ]]; then
  [[ "$EXPECTED_GENERATION" =~ ^test/t[0-9]{3,4}$ ]] || fail 'expected generation is unsafe'
fi
if [[ "$DEPLOY_MODE" = prepare ]]; then
  [[ "$CANDIDATE_REF" =~ ^refs/heads/integration/release-candidates/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$ ]] ||
    fail 'candidate ref is unsafe'
fi
for preflight_port in "$CANDIDATE_PREFLIGHT_PORT" "$PREVIOUS_PREFLIGHT_PORT"; do
  [[ "$preflight_port" =~ ^[0-9]+$ && "$preflight_port" -ge 1024 &&
      "$preflight_port" -le 65535 && "$preflight_port" -ne 3001 ]] ||
    fail 'release preflight ports must be distinct non-service TCP ports'
done
[[ "$CANDIDATE_PREFLIGHT_PORT" -ne "$PREVIOUS_PREFLIGHT_PORT" ]] ||
  fail 'candidate and previous-binary preflight ports must differ'
[[ ${ASH_ATLAS_DEPLOY_LOCK_HELD:-false} = true ]] ||
  fail 'deploy-test-update.sh must run through the durable deployment controller'
for inherited_descriptor in /proc/$$/fd/*; do
  if [[ "$inherited_descriptor" -ef "$LOCK_FILE" ]]; then
    fail 'deploy-test-update.sh inherited the supervisor deployment-lock descriptor'
  fi
done

readonly SHORT_SHA=${GAME_SHA:0:8}
readonly GAME_RELEASE=$GAME_RELEASE_ROOT/$GAME_SHA
readonly GAME_INCOMING=${GAME_RELEASE}.incoming
readonly CLIENT_RELEASE=$CLIENT_RELEASE_ROOT/$GAME_SHA
readonly CLIENT_INCOMING=${CLIENT_RELEASE}.incoming
ACTIVATE_RELEASE_CLASS=
ACTIVATE_PREPARED_STATIC_ARTIFACT_FENCE_SHA256=
ACTIVATE_PREPARED_RELEASE_METADATA_FENCE_SHA256=
ACTIVATE_REUSE_PREPARED_FENCES=false
if [[ "$DEPLOY_MODE" = activate ]]; then
  ACTIVATE_RELEASE_CLASS=$(operation_receipt_field release_class)
  ACTIVATE_PREPARED_STATIC_ARTIFACT_FENCE_SHA256=$(operation_receipt_field prepared_static_artifact_fence_sha256)
  ACTIVATE_PREPARED_RELEASE_METADATA_FENCE_SHA256=$(operation_receipt_field prepared_release_metadata_fence_sha256)
  if prepared_fence_reuse_allowed "$ACTIVATE_RELEASE_CLASS"; then
    ACTIVATE_REUSE_PREPARED_FENCES=true
  fi
  if server_activation_required "$ACTIVATE_RELEASE_CLASS"; then
    SOURCE_ROOT=$GAME_RELEASE
  else
    SOURCE_ROOT=$(readlink -e "$GAME_CURRENT_LINK" 2>/dev/null || true)
    [[ "$SOURCE_ROOT" = "$GAME_RELEASE_ROOT/"* && -d "$SOURCE_ROOT" && ! -L "$SOURCE_ROOT" ]] ||
      fail 'client-only ACTIVATE cannot resolve the unchanged live server component'
  fi
else
  SOURCE_ROOT=$WORKTREE_ROOT/ash-atlas-${SHORT_SHA}-${OPERATION_ID}
fi
readonly SOURCE_ROOT
resolve_release_mode "$SOURCE_ROOT"
operation_receipt_update release_mode "$RELEASE_MODE"
DEPLOY_STARTED_NS=$(date +%s%N)
install -d -o root -g ash-atlas -m 0750 "$TIMING_ROOT"
TIMING_TSV=$(mktemp "$TIMING_ROOT/${OPERATION_ID}.XXXXXX.tsv")
TIMING_JSON="$TIMING_ROOT/${OPERATION_ID}.json"
BUILD_MANIFEST=$(mktemp "$TIMING_ROOT/${OPERATION_ID}.build-manifest.XXXXXX.json")
MIGRATION_CANDIDATES=$(mktemp "$TIMING_ROOT/${OPERATION_ID}.migration-candidates.XXXXXX.tsv")
MIGRATION_APPLIED=$(mktemp "$TIMING_ROOT/${OPERATION_ID}.migration-applied.XXXXXX.tsv")
MIGRATION_POST_APPLIED=$(mktemp "$TIMING_ROOT/${OPERATION_ID}.migration-post-applied.XXXXXX.tsv")
PREFLIGHT_MIGRATION_LEDGER=$(mktemp "$TIMING_ROOT/${OPERATION_ID}.preflight-migration-ledger.XXXXXX.tsv")
trap on_exit EXIT
PREVIOUS_RELEASE_COPY=
ACTIVATION_STARTED=false
LIVE_MIGRATION_COMPLETED=false
MIGRATION_PHASE_STARTED=false
MIGRATION_COMMAND_STARTED=false
MIGRATION_COMMAND_COMPLETED=false
MIGRATION_RECEIPT_COMPLETED=false
MIGRATION_LEDGER_VERIFIED=false
PREFLIGHT_DATABASE_CREATED=false
PREFLIGHT_PROCESS_PID=
PREFLIGHT_READY_BODY=
PREFLIGHT_MIGRATIONS_STAGE=
MIGRATION_TRANSACTION_MODE=
SOURCE_WORKTREE_REGISTERED=false
STALE_WORKTREES_REMOVED=0
WORLD_HANDOFF_ROLLBACK_REQUIRED=false
WORLD_HANDOFF_ROLLBACK_COMPLETED=false
PREVIOUS_WORLD_SHA=
WORLD_UNIT_BACKUP=
WORLD_OPS_UNIT_BACKUP=

phase_start static_runtime_invariants
provision_cache_directories
preflight_cache_access
STATIC_ARTIFACT_VERIFICATION=full_sha256
PREPARED_STATIC_ARTIFACT_FENCE_SHA256=
STATIC_ARTIFACT_INTEGRITY_IDENTITY=$(static_artifact_integrity_identity)
if [[ "$DEPLOY_MODE" = activate ]]; then
  [[ "$ACTIVATE_PREPARED_STATIC_ARTIFACT_FENCE_SHA256" =~ ^[0-9a-f]{64}$ ]] ||
    fail 'prepared static artifact metadata fence is unsafe'
  PREPARED_STATIC_ARTIFACT_FENCE_SHA256=$(static_artifact_metadata_fence)
  [[ "$PREPARED_STATIC_ARTIFACT_FENCE_SHA256" = "$ACTIVATE_PREPARED_STATIC_ARTIFACT_FENCE_SHA256" ]] ||
    fail 'prepared static artifact metadata fence changed before ACTIVATE'
  if [[ "$ACTIVATE_REUSE_PREPARED_FENCES" = true ]]; then
    STATIC_ARTIFACT_VERIFICATION=prepared_metadata_fence
  fi
elif [[ "$DEPLOY_MODE" = prepare ]]; then
  PREPARED_STATIC_ARTIFACT_FENCE_SHA256=$(static_artifact_metadata_fence)
  if static_artifact_integrity_cache_hit "$STATIC_ARTIFACT_INTEGRITY_IDENTITY" \
      "$PREPARED_STATIC_ARTIFACT_FENCE_SHA256"; then
    STATIC_ARTIFACT_VERIFICATION=cached_metadata_fence
  fi
fi

[[ -f "$ENV_FILE" ]] || fail "$ENV_FILE is absent"
[[ -f "$CADDY_FILE" ]] || fail "$CADDY_FILE is absent"
PRE_SWITCH_ENV_SHA256=
EXPECTED_POST_SWITCH_ENV_SHA256=
if [[ "$DEPLOY_MODE" = activate ]]; then
  verify_activation_registry_fence
  prepared_env_sha256=$(operation_receipt_field prepared_env_sha256)
  PRE_SWITCH_ENV_SHA256=$(runtime_environment_sha256)
  [[ "$PRE_SWITCH_ENV_SHA256" = "$prepared_env_sha256" ]] ||
    fail 'runtime environment changed after PREPARE and before ACTIVATE'
  if server_activation_required "$ACTIVATE_RELEASE_CLASS"; then
    EXPECTED_POST_SWITCH_ENV_SHA256=$(runtime_environment_sha256_for_identity \
      "$GAME_SHA" "$EXPECTED_GENERATION")
  else
    EXPECTED_POST_SWITCH_ENV_SHA256=$PRE_SWITCH_ENV_SHA256
  fi
  [[ "$EXPECTED_POST_SWITCH_ENV_SHA256" =~ ^[0-9a-f]{64}$ ]] ||
    fail 'expected post-switch environment identity is unsafe'
  operation_receipt_update pre_switch_env_sha256 "$PRE_SWITCH_ENV_SHA256" \
    expected_post_switch_env_sha256 "$EXPECTED_POST_SWITCH_ENV_SHA256" \
    release_mode "$RELEASE_MODE" \
    activation_intent_id "$ACTIVATION_INTENT_ID" \
    activation_registry_commit_sha "$ACTIVATION_REGISTRY_COMMIT_SHA"
fi
grep -qx 'AUTH_RUNTIME_MODE=public' "$ENV_FILE" || fail 'public authentication mode is not configured'
grep -qx 'AUTH_DEV_LOGIN_ENABLED=false' "$ENV_FILE" || fail 'development login must remain disabled'
grep -Fq '@world path /api/lookup /api/overlays.geojson' "$CADDY_FILE" || fail 'the exact restricted World route matcher is absent'
caddy validate --config "$CADDY_FILE"
if [[ "$DEPLOY_MODE" = activate ]]; then
  load_world_runtime_authority "$SOURCE_ROOT/config/world-runtime.lock.json"
  validate_world_runtime_invariants
fi
validate_river_surface_target_root
systemctl cat ash-atlas-world.service | grep -Fq -- "--river-surface-mode $RIVER_SURFACE_RELEASE" || fail 'World river surface mode differs'
systemctl cat ash-atlas-world.service | grep -Fq -- "--river-surface-release-root $RIVER_SURFACE_TARGET_ROOT" || fail 'World river surface target release root differs'
systemctl cat ash-atlas-world.service | grep -Fq -- "--river-surface-manifest-sha256 $RIVER_SURFACE_MANIFEST_SHA256" || fail 'World river surface manifest differs'
systemctl cat ash-atlas-world.service | grep -Fq -- "--river-surface-policy $RIVER_SURFACE_POLICY" || fail 'World river surface policy differs'
systemctl cat ash-atlas-world.service | grep -Fq -- '--river-surface-cache-packages 12' || fail 'World river surface cache is not bounded to 12 packages'
operation_receipt_update world_river_surface_target_root_token "$RIVER_SURFACE_TARGET_ROOT_TOKEN" \
  world_river_surface_target_root "$RIVER_SURFACE_TARGET_ROOT"
systemctl cat ash-atlas-world.service | grep -Fq -- "--lake-surface-release-root $LAKE_SURFACE_ROOT" || fail 'World lake surface release differs'
systemctl cat ash-atlas-world.service | grep -Fq -- "--lake-surface-manifest-sha256 $LAKE_SURFACE_MANIFEST_SHA256" || fail 'World lake surface manifest differs'
systemctl cat ash-atlas-world.service | grep -Fq -- "--lake-surface-policy $LAKE_SURFACE_POLICY" || fail 'World lake surface policy differs'
systemctl cat ash-atlas-world.service | grep -Fq -- '--lake-surface-cache-packages 12' || fail 'World lake surface cache is not bounded to 12 packages'
systemctl cat ash-atlas-world.service | grep -Fq -- "--ocean-coast-surface-release-root $OCEAN_COAST_SURFACE_ROOT" || fail 'World ocean coast surface release differs'
systemctl cat ash-atlas-world.service | grep -Fq -- "--ocean-coast-surface-manifest-sha256 $OCEAN_COAST_SURFACE_MANIFEST_SHA256" || fail 'World ocean coast surface manifest differs'
systemctl cat ash-atlas-world.service | grep -Fq -- "--ocean-coast-surface-policy $OCEAN_COAST_SURFACE_POLICY" || fail 'World ocean coast surface policy differs'
systemctl cat ash-atlas-world.service | grep -Fq -- '--ocean-coast-surface-cache-packages 12' || fail 'World ocean coast surface cache is not bounded to 12 packages'
systemctl cat ash-atlas-world.service | grep -Fq -- "--waterbody-identity-overlay-release-root $WATERBODY_IDENTITY_OVERLAY_ROOT" || fail 'World waterbody identity overlay release differs'
systemctl cat ash-atlas-world.service | grep -Fq -- "--waterbody-identity-overlay-manifest-sha256 $WATERBODY_IDENTITY_OVERLAY_MANIFEST_SHA256" || fail 'World waterbody identity overlay manifest differs'
systemctl cat ash-atlas-world.service | grep -Fq -- '--waterbody-identity-overlay-cache-packages 12' || fail 'World waterbody identity overlay cache is not bounded to 12 packages'
[[ -d "$LAKE_SURFACE_ROOT" && ! -L "$LAKE_SURFACE_ROOT" &&
   -f "$LAKE_SURFACE_ROOT/manifest.json" && ! -L "$LAKE_SURFACE_ROOT/manifest.json" ]] ||
  fail 'immutable lake surface release is absent or unsafe'
[[ $(sha256sum "$LAKE_SURFACE_ROOT/manifest.json" | cut -d' ' -f1) = "$LAKE_SURFACE_MANIFEST_SHA256" ]] ||
  fail 'lake surface manifest hash differs'
/usr/bin/node - "$LAKE_SURFACE_ROOT/manifest.json" "$LAKE_SURFACE_RELEASE" \
  "$LAKE_SURFACE_POLICY" <<'NODE'
const fs = require("node:fs");
const [path, releaseId, policy] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(path, "utf8"));
if (manifest?.release_id !== releaseId || manifest?.policy !== policy ||
    manifest?.membership_policy !== "reconstructed-lake-covers-canonical-cell-center" ||
    manifest?.overlap_policy !== "independent-river-and-lake-memberships" ||
    manifest?.grid_fingerprint !== "44e1b2d53f5b3d38b6f5370d30c94403d6d4f90a6207f12ccdee799713a6229b" ||
    manifest?.membership_cell_count !== 477463775 || manifest?.span_count !== 18044558)
  process.exit(1);
NODE
[[ -d "$OCEAN_COAST_SURFACE_ROOT" && ! -L "$OCEAN_COAST_SURFACE_ROOT" &&
   -f "$OCEAN_COAST_SURFACE_ROOT/manifest.json" && ! -L "$OCEAN_COAST_SURFACE_ROOT/manifest.json" ]] ||
  fail 'immutable ocean coast surface release is absent or unsafe'
[[ $(sha256sum "$OCEAN_COAST_SURFACE_ROOT/manifest.json" | cut -d' ' -f1) = "$OCEAN_COAST_SURFACE_MANIFEST_SHA256" ]] ||
  fail 'ocean coast surface manifest hash differs'
/usr/bin/node - "$OCEAN_COAST_SURFACE_ROOT/manifest.json" "$OCEAN_COAST_SURFACE_RELEASE" "$OCEAN_COAST_SURFACE_POLICY" <<'NODE'
const fs = require("node:fs");
const [path, releaseId, policy] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(path, "utf8"));
if (manifest?.release_id !== releaseId || manifest?.policy !== policy ||
    manifest?.pipeline_sha !== "ef27c0518d34255f40fe67531b1a9316fe4597ba" ||
    manifest?.grid_fingerprint !== "44e1b2d53f5b3d38b6f5370d30c94403d6d4f90a6207f12ccdee799713a6229b" ||
    manifest?.band_cells !== 3 || manifest?.membership_cell_count !== 99447307 ||
    manifest?.span_count !== 14326950 || manifest?.precedence_policy !== "river>lake>ocean>land") process.exit(1);
NODE
[[ -d "$WATER_VISUAL_TILES_ROOT" && ! -L "$WATER_VISUAL_TILES_ROOT" &&
   -f "$WATER_VISUAL_TILES_PATH" && ! -L "$WATER_VISUAL_TILES_PATH" ]] ||
  fail 'immutable water visual tile release is absent or unsafe'
[[ $(stat -c '%s' "$WATER_VISUAL_TILES_PATH") = "$WATER_VISUAL_TILES_ARTIFACT_SIZE" ]] || fail 'water visual tile artifact size differs'
if [[ "$STATIC_ARTIFACT_VERIFICATION" = full_sha256 ]]; then
  [[ $(sha256sum "$WATER_VISUAL_TILES_PATH" | cut -d' ' -f1) = "$WATER_VISUAL_TILES_ARTIFACT_SHA256" ]] || fail 'water visual tile artifact hash differs'
fi
[[ -f "$WATER_VISUAL_TILES_ROOT/manifest.json" && ! -L "$WATER_VISUAL_TILES_ROOT/manifest.json" ]] || fail 'water visual tile manifest is absent or unsafe'
[[ $(sha256sum "$WATER_VISUAL_TILES_ROOT/manifest.json" | cut -d' ' -f1) = "$WATER_VISUAL_TILES_MANIFEST_SHA256" ]] || fail 'water visual tile manifest hash differs'
/usr/bin/node - "$WATER_VISUAL_TILES_ROOT/manifest.json" <<'NODE'
const fs = require("node:fs");
const [path] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(path, "utf8"));
if (manifest?.pipeline_sha !== "f95c19a0b59eb06293ca3d19e5e9f41e859b92b1" ||
    manifest?.release_id !== "water-visual-tiles-v1" ||
    manifest?.policy !== "precedence-resolved-canonical-water-visual-v1" ||
    manifest?.precedence !== "river>lake>ocean>land" ||
    manifest?.surface_policy !== "canonical-membership-geometric-difference" ||
    manifest?.freshwater_perimeter_policy !== "boundary-of-expanded-dissolved-visible-cell-mask" ||
    manifest?.ocean_coastline_policy !== "visible-ocean-grid-edges-adjacent-to-authoritative-land" ||
    manifest?.sources?.river?.manifest_sha256 !== "c02a4f04f91c285270c5f6f2bc667cad2988344c9b6200ba9ee64fda488976fc" ||
    manifest?.sources?.lake?.manifest_sha256 !== "d0c25c2b6a4e9349091a5f483a294fac7988cd098a1f77e354343cb2f27f42b9" ||
    manifest?.sources?.ocean?.manifest_sha256 !== "b8319476532112ef6076d56819a89a9551ea88c4b55f52a06c80b8bae8fa3954" ||
    manifest?.sources?.world?.manifest_sha256 !== "80bfe7152f2b4f16cc182cc38a86a72950634d5799fbb31b6bad4ef686bb5578" ||
    JSON.stringify(manifest?.layers) !== JSON.stringify([
      "water_ocean_surface", "water_ocean_coastline", "water_lake_surface",
      "water_lake_perimeter", "water_river_surface", "water_river_perimeter"
    ])) process.exit(1);
NODE
water_omit_response=$(curl --fail --silent --show-error --max-time 20 \
  'http://127.0.0.1:8765/api/overlays.geojson?bbox=-106.7,35.0,-106.6,35.1&zoom=15&layers=water-no-build&river_visuals=omit&lake_visuals=omit&ocean_coast_visuals=omit')
/usr/bin/node - "$water_omit_response" <<'NODE'
const payload = JSON.parse(process.argv[2]);
const diagnostics = payload?.metadata?.diagnostics;
if (diagnostics?.river_visuals !== "omit" || diagnostics?.river_visuals_omitted !== true ||
    diagnostics?.lake_visuals !== "omit" || diagnostics?.lake_visuals_omitted !== true ||
    diagnostics?.ocean_coast_visuals !== "omit" || diagnostics?.ocean_coast_visuals_omitted !== true ||
    diagnostics?.effective_river_surface_mode !== "omitted-static-tiles") process.exit(1);
if (payload.features?.some(feature => ["river", "freshwater"].includes(feature?.properties?.water_kind))) process.exit(1);
NODE

if [[ "$DEPLOY_MODE" = prepare ]]; then
  final_static_artifact_fence=$(static_artifact_metadata_fence)
  [[ "$final_static_artifact_fence" = "$PREPARED_STATIC_ARTIFACT_FENCE_SHA256" ]] ||
    fail 'static artifact metadata changed during PREPARE verification'
  PREPARED_STATIC_ARTIFACT_FENCE_SHA256=$final_static_artifact_fence
  if [[ "$STATIC_ARTIFACT_VERIFICATION" = full_sha256 ]]; then
    write_static_artifact_integrity_cache "$STATIC_ARTIFACT_INTEGRITY_IDENTITY" \
      "$PREPARED_STATIC_ARTIFACT_FENCE_SHA256"
  fi
fi
phase_finish "static_artifacts=$STATIC_ARTIFACT_VERIFICATION"

if [[ "$DEPLOY_MODE" = activate ]]; then
  phase_start prepared_candidate_validation
  [[ -d "$MIRROR_ROOT" && ! -L "$MIRROR_ROOT" ]] || fail 'deployment mirror is absent or unsafe'
  sudo -u debian env HOME=/home/debian git --git-dir="$MIRROR_ROOT" fetch origin \
    refs/heads/master:refs/heads/master \
    refs/heads/integration/test:refs/heads/integration/test \
    "refs/tags/${EXPECTED_GENERATION}:refs/tags/${EXPECTED_GENERATION}"
  [[ $(sudo -u debian git --git-dir="$MIRROR_ROOT" rev-parse refs/heads/master) = "$GAME_SHA" ]] ||
    fail 'published master differs from the prepared target'
  frozen_integration_tooling_only "$GAME_SHA" ||
    fail 'published integration differs from prepared target outside reviewed release tooling'
  [[ $(sudo -u debian git --git-dir="$MIRROR_ROOT" rev-list -n 1 "$EXPECTED_GENERATION") = "$GAME_SHA" ]] ||
    fail 'published generation differs from the prepared target'
  GAME_GENERATION=$(resolve_game_generation "$GAME_SHA")
  [[ "$GAME_GENERATION" = "$EXPECTED_GENERATION" ]] || fail 'prepared generation identity changed'

  prepared_result=$(operation_receipt_field prepare_result)
  prepared_generation=$(operation_receipt_field prepared_generation)
  previous_game_sha=$(operation_receipt_field prepared_previous_game_sha)
  previous_public_sha=$(operation_receipt_field prepared_previous_public_sha)
  DEPLOYMENT_LANE=$(operation_receipt_field deployment_lane)
  MIGRATION_REQUIRED=$(operation_receipt_field migration_required)
  MIGRATION_REASON=$(operation_receipt_field prepared_migration_reason)
  recorded_release_classification_version=$(operation_receipt_field release_classification_version)
  RELEASE_CLASS=$(operation_receipt_field release_class)
  CANDIDATE_DATABASE_STRATEGY=$(operation_receipt_field candidate_database_strategy)
  RELEASE_CLASSIFICATION_EVIDENCE_SHA256=$(operation_receipt_field release_classification_evidence_sha256)
  RELEASE_CHANGED_PATHS_SHA256=$(operation_receipt_field release_changed_paths_sha256)
  recorded_prepared_descriptor_version=$(operation_receipt_field prepared_descriptor_version)
  prepared_descriptor_hash=$(operation_receipt_field prepared_descriptor_sha256)
  prepared_server_component_sha=$(operation_receipt_field prepared_server_component_sha)
  prepared_server_artifact_hash=$(operation_receipt_field prepared_server_artifact_sha256)
  prepared_client_component_sha=$(operation_receipt_field prepared_client_component_sha)
  prepared_client_artifact_hash=$(operation_receipt_field prepared_client_artifact_sha256)
  prepared_static_artifact_fence_hash=$(operation_receipt_field prepared_static_artifact_fence_sha256)
  prepared_release_metadata_fence_hash=$(operation_receipt_field prepared_release_metadata_fence_sha256)
  prepared_game_main_pid=$(operation_receipt_field prepared_game_main_pid)
  prepared_game_start_timestamp_monotonic=$(operation_receipt_field prepared_game_start_timestamp_monotonic)
  activated_game_main_pid=$(operation_receipt_field activated_game_main_pid)
  activated_game_start_timestamp_monotonic=$(operation_receipt_field activated_game_start_timestamp_monotonic)
  PRIOR_BINARY_RESTART_SAFE=$(operation_receipt_field prior_binary_restart_safe)
  prepared_build_manifest_hash=$(operation_receipt_field prepared_build_manifest_sha256)
  prepared_release_json_hash=$(operation_receipt_field prepared_release_json_sha256)
  prepared_game_release_hash=$(operation_receipt_field prepared_game_release_sha256)
  prepared_public_release_hash=$(operation_receipt_field prepared_public_release_sha256)
  prepared_migration_ledger_hash=$(operation_receipt_field prepared_migration_ledger_sha256)
  prepared_env_sha256=$(operation_receipt_field prepared_env_sha256)
  prepared_native_compatibility_json=$(operation_receipt_field prepared_native_compatibility_json)
  prepared_native_compatibility_sha=$(operation_receipt_field prepared_native_compatibility_sha256)
  recorded_prepare_hash=$(operation_receipt_field prepare_receipt_sha256)
  [[ "$prepared_result" = completed && "$prepared_generation" = "$EXPECTED_GENERATION" ]] ||
    fail 'operation does not contain an exact completed PREPARED receipt'
  [[ "$previous_game_sha" =~ ^[0-9a-f]{40}$ && "$previous_public_sha" =~ ^[0-9a-f]{40}$ ]] ||
    fail 'prepared rollback identity is unsafe'
  [[ "$MIGRATION_REQUIRED" =~ ^(true|false)$ && "$PRIOR_BINARY_RESTART_SAFE" =~ ^(true|false)$ ]] ||
    fail 'prepared migration safety identity is unsafe'
  [[ "$DEPLOYMENT_LANE" =~ ^(client|application|migration|full)$ ]] ||
    fail 'prepared deployment lane identity is unsafe'
  [[ "$ACTIVATE_RELEASE_CLASS" = "$RELEASE_CLASS" &&
      "$recorded_release_classification_version" = "$RELEASE_CLASSIFICATION_VERSION" &&
      "$recorded_prepared_descriptor_version" = "$PREPARED_DESCRIPTOR_VERSION" &&
      "$RELEASE_CLASS" =~ ^(client_only|server_no_migration|database_migration|release_tooling)$ ]] ||
    fail 'prepared release classification or descriptor version is unsafe'
  for prepared_hash in "$prepared_build_manifest_hash" "$prepared_release_json_hash" \
      "$prepared_public_release_hash" \
      "$prepared_migration_ledger_hash" "$prepared_env_sha256" \
      "$prepared_native_compatibility_sha" \
      "$RELEASE_CLASSIFICATION_EVIDENCE_SHA256" \
      "$RELEASE_CHANGED_PATHS_SHA256" "$prepared_descriptor_hash" "$recorded_prepare_hash" \
      "$prepared_server_artifact_hash" "$prepared_client_artifact_hash" \
      "$prepared_static_artifact_fence_hash" "$prepared_release_metadata_fence_hash"; do
    [[ "$prepared_hash" =~ ^[0-9a-f]{64}$ ]] || fail 'prepared receipt hash is unsafe'
  done
  [[ $(printf '%s' "$prepared_native_compatibility_json" | sha256sum | cut -d' ' -f1) = \
      "$prepared_native_compatibility_sha" ]] ||
    fail 'prepared native compatibility policy changed before ACTIVATE'
  [[ "$prepared_server_component_sha" =~ ^[0-9a-f]{40}$ &&
      "$prepared_client_component_sha" = "$GAME_SHA" ]] ||
    fail 'prepared component SHA identity is unsafe'
  [[ "$prepared_game_main_pid" =~ ^[1-9][0-9]*$ &&
      "$prepared_game_start_timestamp_monotonic" =~ ^[1-9][0-9]*$ ]] ||
    fail 'prepared game process identity is unsafe'
  [[ "$activated_game_main_pid" =~ ^[0-9]+$ &&
      "$activated_game_start_timestamp_monotonic" =~ ^[0-9]+$ ]] ||
    fail 'activated game process identity is unsafe'
  if server_activation_required "$RELEASE_CLASS"; then
    [[ "$prepared_server_component_sha" = "$GAME_SHA" &&
        "$prepared_game_release_hash" =~ ^[0-9a-f]{64}$ ]] ||
      fail 'prepared server release identity differs'
  else
    [[ "$prepared_server_component_sha" = "$previous_game_sha" &&
        -z "$prepared_game_release_hash" ]] ||
      fail 'client-only descriptor does not preserve the live server component'
  fi
  previous_game="$GAME_RELEASE_ROOT/$previous_game_sha"
  previous_public="$CLIENT_RELEASE_ROOT/$previous_public_sha"
  [[ $(readlink -e "$GAME_CURRENT_LINK" 2>/dev/null || true) = "$previous_game" ]] ||
    fail 'live game changed after PREPARE'
  current_public_link=$(readlink -e "$CLIENT_CURRENT_LINK" 2>/dev/null || true)
  if server_activation_required "$RELEASE_CLASS"; then
    [[ "$current_public_link" = "$previous_public" ]] || fail 'live public release changed after PREPARE'
  else
    [[ "$current_public_link" = "$previous_public" || "$current_public_link" = "$CLIENT_RELEASE" ]] ||
      fail 'client-only public release changed outside its prepared transition'
  fi
  prepared_server_release="$GAME_RELEASE"
  if ! server_activation_required "$RELEASE_CLASS"; then prepared_server_release="$previous_game"; fi
  [[ -d "$prepared_server_release" && ! -L "$prepared_server_release" &&
      -d "$CLIENT_RELEASE" && ! -L "$CLIENT_RELEASE" ]] ||
    fail 'prepared immutable component release is absent or unsafe'
  [[ $(sha256sum "$prepared_server_release/build-manifest.json" | cut -d' ' -f1) = "$prepared_build_manifest_hash" ]] ||
    fail 'prepared build manifest changed before ACTIVATE'
  [[ $(sha256sum "$CLIENT_RELEASE/release.json" | cut -d' ' -f1) = "$prepared_release_json_hash" ]] ||
    fail 'prepared public release identity changed before ACTIVATE'
  current_release_metadata_fence=$(immutable_release_metadata_fence \
    "$prepared_server_release" "$CLIENT_RELEASE")
  [[ "$current_release_metadata_fence" = "$prepared_release_metadata_fence_hash" ]] ||
    fail 'prepared release metadata fence changed before ACTIVATE'
  if [[ "$ACTIVATE_REUSE_PREPARED_FENCES" != true ]]; then
    if server_activation_required "$RELEASE_CLASS"; then
      [[ $(immutable_release_hash "$GAME_RELEASE") = "$prepared_game_release_hash" ]] ||
        fail 'prepared game release content changed before ACTIVATE'
    fi
    [[ $(artifact_content_hash "$prepared_server_release/apps/server/dist") = "$prepared_server_artifact_hash" ]] ||
      fail 'prepared server component content changed before ACTIVATE'
    [[ $(immutable_release_hash "$CLIENT_RELEASE") = "$prepared_public_release_hash" ]] ||
      fail 'prepared public release content changed before ACTIVATE'
    [[ $(artifact_content_hash "$CLIENT_RELEASE") = "$prepared_client_artifact_hash" ]] ||
      fail 'prepared client component content changed before ACTIVATE'
  fi
  read -r current_migration_required current_migration_reason < <(
    probe_migration_requirement "$previous_game_sha" "$GAME_SHA"
  )
  current_migration_ledger_hash=$(sha256sum "$MIGRATION_APPLIED" | cut -d' ' -f1)
  [[ "$current_migration_required" = "$MIGRATION_REQUIRED" &&
      "$current_migration_reason" = "$MIGRATION_REASON" &&
      "$current_migration_ledger_hash" = "$prepared_migration_ledger_hash" ]] ||
    fail 'Main migration ledger or prepared migration decision changed after PREPARE'
  if sudo -u debian git --git-dir="$MIRROR_ROOT" cat-file -e "${previous_game_sha}^{commit}" 2>/dev/null; then
    mapfile -d '' current_changed_paths < <(sudo -u debian git --git-dir="$MIRROR_ROOT" \
      diff --name-only -z "$previous_game_sha" "$GAME_SHA")
  else
    current_changed_paths=(__unknown_previous_commit__)
  fi
  current_changed_paths_hash=$(changed_paths_hash "${current_changed_paths[@]}")
  current_release_class=$(release_class_for_lane "$DEPLOYMENT_LANE" "$current_migration_required")
  current_candidate_database_strategy=$(candidate_database_strategy_for_class "$current_release_class")
  current_classification_evidence_hash=$(printf '%s\n' \
    "$recorded_release_classification_version" "$previous_game_sha" "$GAME_SHA" \
    "$DEPLOYMENT_LANE" "$current_migration_required" "$current_migration_reason" \
    "$current_changed_paths_hash" | sha256sum | cut -d' ' -f1)
  [[ "$current_release_class" = "$RELEASE_CLASS" &&
      "$current_candidate_database_strategy" = "$CANDIDATE_DATABASE_STRATEGY" &&
      "$current_changed_paths_hash" = "$RELEASE_CHANGED_PATHS_SHA256" &&
      "$current_classification_evidence_hash" = "$RELEASE_CLASSIFICATION_EVIDENCE_SHA256" ]] ||
    fail 'release classification evidence changed after PREPARE'
  expected_prepare_hash=$(prepared_receipt_hash "$GAME_SHA" "$EXPECTED_GENERATION" \
    "$previous_game_sha" "$previous_public_sha" "$prepared_build_manifest_hash" \
    "$prepared_release_json_hash" "$prepared_game_release_hash" "$prepared_public_release_hash" \
     "$prepared_migration_ledger_hash" "$prepared_env_sha256" \
     "$(operation_receipt_field prepared_native_compatibility_sha256)" \
     "$MIGRATION_REQUIRED" \
      "$MIGRATION_REASON" "$PRIOR_BINARY_RESTART_SAFE" \
    "$prepared_static_artifact_fence_hash" "$prepared_release_metadata_fence_hash" \
    "$recorded_release_classification_version" "$RELEASE_CLASS" \
    "$RELEASE_CLASSIFICATION_EVIDENCE_SHA256" "$RELEASE_CHANGED_PATHS_SHA256" \
    "$recorded_prepared_descriptor_version" "$prepared_server_component_sha" \
    "$prepared_server_artifact_hash" "$prepared_client_component_sha" \
    "$prepared_client_artifact_hash" "$prepared_game_main_pid" \
    "$prepared_game_start_timestamp_monotonic")
  [[ "$expected_prepare_hash" = "$recorded_prepare_hash" &&
      "$recorded_prepare_hash" = "$prepared_descriptor_hash" ]] ||
    fail 'PREPARED receipt identity hash differs'
  previous_game_generation=$(resolve_game_generation "$previous_game_sha")
  phase_finish "prepared_receipt=$recorded_prepare_hash"

  if ! server_activation_required "$RELEASE_CLASS" &&
      [[ "$current_public_link" = "$CLIENT_RELEASE" ]] &&
      systemctl is-active --quiet ash-atlas.service &&
      /usr/local/libexec/ash-atlas-wait-ready game &&
      grep -Fqx "  \"game_sha\": \"$GAME_SHA\"," "$CLIENT_RELEASE/release.json" &&
      grep -Fqx "  \"game_generation\": \"$GAME_GENERATION\"," "$CLIENT_RELEASE/release.json"; then
    ACTIVATION_STARTED=true
    capture_game_process_identity
    if [[ "$CAPTURED_GAME_MAIN_PID" != "$activated_game_main_pid" ||
          "$CAPTURED_GAME_START_TIMESTAMP_MONOTONIC" != "$activated_game_start_timestamp_monotonic" ||
          ( "$activated_game_main_pid" = 0 && "$activated_game_start_timestamp_monotonic" = 0 ) ]]; then
      systemctl restart ash-atlas.service
      /usr/local/libexec/ash-atlas-wait-ready game
      capture_game_process_identity
    fi
    [[ "$CAPTURED_GAME_MAIN_PID" != "$prepared_game_main_pid" ||
        "$CAPTURED_GAME_START_TIMESTAMP_MONOTONIC" != "$prepared_game_start_timestamp_monotonic" ]] ||
      fail 'resumed client-only activation did not restart the unchanged game service'
    [[ $(readlink -e "$GAME_CURRENT_LINK") = "$previous_game" ]] ||
      fail 'resumed client-only activation changed the server link'
    assert_post_switch_environment
    operation_receipt_update migration_result not_required \
      activation_started __TRUE__ activation_completed __TRUE__ activation_result completed \
      readiness_result completed active_game_sha "$previous_game_sha" active_public_sha "$GAME_SHA" \
      activated_game_main_pid "__NUMBER__$CAPTURED_GAME_MAIN_PID" \
      activated_game_start_timestamp_monotonic "__NUMBER__$CAPTURED_GAME_START_TIMESTAMP_MONOTONIC" \
      activated_game_link_sha "$previous_game_sha" activated_public_link_sha "$GAME_SHA"
    activate_native_bundle_candidate
    printf 'Ash Atlas client-only update already active and ready: %s\n' "$GAME_SHA"
    exit 0
  fi

  phase_start database_backup
  if [[ "$MIGRATION_REQUIRED" = true ]]; then
    database_backup_env=/etc/ash-atlas/database-backup.env
    [[ -f "$database_backup_env" && ! -L "$database_backup_env" &&
       $(stat -c '%u' "$database_backup_env") = 0 ]] ||
      fail 'trusted database backup environment is absent or unsafe'
    database_backup_env_mode=$(stat -c '%a' "$database_backup_env")
    (( (8#$database_backup_env_mode & 8#022) == 0 )) ||
      fail 'trusted database backup environment is writable outside root'
    set -a
    # shellcheck disable=SC1091
    source "$database_backup_env"
    set +a
    database_backup_mount="${ASH_ATLAS_BACKUP_MOUNT:-/mnt/ash-atlas-backups}"
    database_backup_root="${ASH_ATLAS_DATABASE_BACKUP_ROOT:-${database_backup_mount}/postgresql}"
    database_backup_database="${ASH_ATLAS_DATABASE_BACKUP_DATABASE:-ash_atlas_game}"
    [[ "$database_backup_mount" = /mnt/ash-atlas-backups &&
       "$database_backup_root" = /mnt/ash-atlas-backups/postgresql ]] ||
      fail 'deployment database backup storage is not the canonical OVH mount'
    database_backup_producer=/opt/ash-atlas/current/tools/release/vps/create-database-backup.sh
    [[ -f "$database_backup_producer" && ! -L "$database_backup_producer" ]] ||
      fail 'canonical database backup producer is absent or unsafe'
    database_backup_retention=/opt/ash-atlas/current/tools/release/vps/prune-database-backups.sh
    [[ -f "$database_backup_retention" && ! -L "$database_backup_retention" ]] ||
      fail 'canonical database backup retention tool is absent or unsafe'
    "$database_backup_retention" --apply ||
      fail 'verified database backup retention failed before deployment backup'
    backup_manifest="$(ASH_ATLAS_DATABASE_BACKUP_CLASS=pre-migration \
      "$database_backup_producer")" || fail 'pre-migration database backup failed'
    [[ -n "$backup_manifest" && "$backup_manifest" != *$'\n'* &&
       "$backup_manifest" == "$database_backup_root"/ready/backup-*/*.dump.ready.json &&
       -f "$backup_manifest" && ! -L "$backup_manifest" &&
       $(realpath -e -- "$backup_manifest") = "$backup_manifest" ]] ||
      fail 'pre-migration database backup did not publish one safe manifest'
    backup_directory=$(dirname "$backup_manifest")
    backup_id=${backup_directory##*/backup-}
    [[ "$backup_id" =~ ^[a-f0-9-]{36}$ &&
       "$backup_directory" = "$database_backup_root/ready/backup-$backup_id" ]] ||
      fail 'pre-migration database backup manifest directory is invalid'
    backup_file_name=$(jq -er '.artifact.fileName' "$backup_manifest") ||
      fail 'pre-migration database backup manifest has no artifact'
    [[ "$backup_file_name" = "$(basename -- "$backup_file_name")" &&
       "$backup_file_name" == *.dump &&
       "$(basename -- "$backup_manifest")" = "$backup_file_name.ready.json" ]] ||
      fail 'pre-migration database backup artifact name is unsafe'
    backup_file="$backup_directory/$backup_file_name"
    jq -e --arg id "$backup_id" --arg database "$database_backup_database" \
      --arg release "$previous_game_sha" --arg file "$backup_file_name" '
        .manifestVersion == 1
        and .kind == "ash_atlas_postgresql_backup"
        and .backupId == $id
        and .backupClass == "pre-migration"
        and .database == $database
        and .releaseSha == $release
        and (.createdAtUtc | fromdateiso8601)
        and .artifact.fileName == $file
        and .artifact.format == "postgresql-custom"
        and (.artifact.bytes | type == "number" and . > 0)
        and (.artifact.sha256 | test("^[a-f0-9]{64}$"))
        and .acknowledgmentState == "pending"
      ' "$backup_manifest" >/dev/null ||
      fail 'pre-migration database backup manifest is invalid'
    [[ -f "$backup_file" && ! -L "$backup_file" &&
       $(realpath -e -- "$backup_file") = "$backup_file" &&
       $(stat -c '%s' "$backup_file") = "$(jq -r '.artifact.bytes' "$backup_manifest")" &&
       $(sha256sum "$backup_file" | awk '{print $1}') = \
         "$(jq -r '.artifact.sha256' "$backup_manifest")" ]] ||
      fail 'pre-migration database backup artifact differs from its manifest'
    pg_restore --list "$backup_file" >/dev/null ||
      fail 'pre-migration database backup restore catalog is invalid'
    phase_finish "completed:manifest=$backup_manifest"
  else
    phase_finish skipped
  fi
else
if [[ "$DEPLOY_MODE" = deploy ]]; then
  phase_start release_retention_preflight
  prune_deployment_releases "$GAME_SHA"
  phase_finish "game_deleted=$GAME_RELEASES_DELETED,public_deleted=$CLIENT_RELEASES_DELETED,native_deleted=$NATIVE_BUNDLES_DELETED"
fi

[[ -d "$MIRROR_ROOT" && ! -L "$MIRROR_ROOT" ]] || fail 'deployment mirror is absent or unsafe'
if [[ "$DEPLOY_MODE" = prepare ]]; then
  GAME_GENERATION=$EXPECTED_GENERATION
else
  GAME_GENERATION=$(resolve_game_generation "$GAME_SHA")
fi

if [[ "$DEPLOY_MODE" != prepare &&
      $(readlink -e "$GAME_CURRENT_LINK" 2>/dev/null || true) = "$GAME_RELEASE" &&
      $(readlink -e "$CLIENT_CURRENT_LINK" 2>/dev/null || true) = "$CLIENT_RELEASE" ]] &&
    systemctl is-active --quiet ash-atlas.service &&
    /usr/local/libexec/ash-atlas-wait-ready game &&
    grep -Fqx "  \"game_sha\": \"$GAME_SHA\"," "$CLIENT_RELEASE/release.json" &&
    grep -Fqx "  \"game_generation\": \"$GAME_GENERATION\"," "$CLIENT_RELEASE/release.json"; then
  operation_receipt_update migration_result completed \
    activation_started __TRUE__ activation_completed __TRUE__ activation_result completed \
    readiness_result completed active_game_sha "$GAME_SHA" active_public_sha "$GAME_SHA"
  activate_native_bundle_candidate
  printf 'Ash Atlas test update already active and ready: %s\n' "$GAME_SHA"
  exit 0
fi

phase_start git_fetch_checkout
install -d -o debian -g debian -m 0750 "$(dirname "$MIRROR_ROOT")" "$WORKTREE_ROOT"
[[ ! -L "$MIRROR_ROOT" && ( ! -e "$MIRROR_ROOT" || -d "$MIRROR_ROOT" ) ]] ||
  fail 'persistent repository mirror path is unsafe'
if [[ ! -d "$MIRROR_ROOT" ]]; then
  sudo -u debian env HOME=/home/debian git clone --mirror "$REPOSITORY" "$MIRROR_ROOT"
else
  [[ $(sudo -u debian git --git-dir="$MIRROR_ROOT" rev-parse --is-bare-repository) = true ]] ||
    fail 'persistent repository mirror is not bare'
  [[ $(sudo -u debian git --git-dir="$MIRROR_ROOT" remote get-url origin) = "$REPOSITORY" ]] ||
    fail 'persistent repository mirror origin differs'
fi
if [[ "$DEPLOY_MODE" = prepare ]]; then
  sudo -u debian env HOME=/home/debian git --git-dir="$MIRROR_ROOT" fetch origin \
    "$CANDIDATE_REF:refs/heads/release-candidate-$OPERATION_ID"
  fetched_target=$(sudo -u debian git --git-dir="$MIRROR_ROOT" \
    rev-parse "refs/heads/release-candidate-$OPERATION_ID")
  [[ "$fetched_target" = "$GAME_SHA" ]] || fail 'candidate ref is not the requested target'
else
  sudo -u debian env HOME=/home/debian git --git-dir="$MIRROR_ROOT" fetch origin \
    refs/heads/master:refs/heads/master
  fetched_target=$(sudo -u debian git --git-dir="$MIRROR_ROOT" rev-parse refs/heads/master)
  [[ "$fetched_target" = "$GAME_SHA" ]] || fail 'approved SHA is not the fetched master tip'
fi
sudo -u debian git --git-dir="$MIRROR_ROOT" worktree prune
cleanup_stale_source_worktrees
[[ ! -e "$SOURCE_ROOT" ]] || fail 'disposable source worktree path already exists'
sudo -u debian git --git-dir="$MIRROR_ROOT" worktree add --detach "$SOURCE_ROOT" "$GAME_SHA"
SOURCE_WORKTREE_REGISTERED=true
[[ $(sudo -u debian git -C "$SOURCE_ROOT" rev-parse HEAD) = "$GAME_SHA" ]] || fail 'source checkout identity differs'
assert_source_clean checkout || fail 'source checkout is dirty'
if [[ "$DEPLOY_MODE" = prepare ]]; then
  PREPARED_NATIVE_COMPATIBILITY_JSON=$(effective_native_configuration "$ENV_FILE" "$SOURCE_ROOT") ||
    fail 'candidate native compatibility configuration could not be derived during PREPARE'
  PREPARED_NATIVE_COMPATIBILITY_SHA256=$(printf '%s' "$PREPARED_NATIVE_COMPATIBILITY_JSON" |
    sha256sum | cut -d' ' -f1)
  [[ "$PREPARED_NATIVE_COMPATIBILITY_SHA256" =~ ^[0-9a-f]{64}$ ]] ||
    fail 'candidate native compatibility policy hash is unsafe'
  operation_receipt_update prepared_native_compatibility_json "$PREPARED_NATIVE_COMPATIBILITY_JSON" \
    prepared_native_compatibility_sha256 "$PREPARED_NATIVE_COMPATIBILITY_SHA256"
fi
[[ -f "$CADDY_CACHE_POLICY" && ! -L "$CADDY_CACHE_POLICY" ]] ||
  fail 'installed game cache policy is absent or unsafe'
grep -Fq "$CADDY_CACHE_IMPORT" "$CADDY_FILE" ||
  fail 'Caddyfile does not import the source-controlled game cache policy'
if ! cmp -s "$SOURCE_ROOT/tools/release/vps/game-cache-policy.caddy" "$CADDY_CACHE_POLICY"; then
  [[ "$DEPLOY_MODE" = prepare && -n "$OPERATION_RECEIPT" ]] ||
    fail 'installed game cache policy differs from the approved source'
  recovery_cache_policy_matches_audit "$OPERATION_RECEIPT" \
    "$OPERATION_ROOT/$OPERATION_ID.prepare-recovery.json" \
    "$CADDY_CACHE_POLICY" "$OPERATION_ID" "$GAME_SHA" ||
    fail 'installed game cache policy differs from the approved source and audited recovery policy'
fi
SOURCE_TREE=$(sudo -u debian git -C "$SOURCE_ROOT" rev-parse "$GAME_SHA^{tree}")
SERVER_TREE=$(sudo -u debian git -C "$SOURCE_ROOT" rev-parse "$GAME_SHA:apps/server")
CLIENT_TREE=$(sudo -u debian git -C "$SOURCE_ROOT" rev-parse "$GAME_SHA:apps/client")
SHARED_TREE=$(sudo -u debian git -C "$SOURCE_ROOT" rev-parse "$GAME_SHA:packages/shared")
phase_finish

if [[ "$DEPLOY_MODE" != activate ]]; then
  phase_start candidate_world_runtime_invariants
  load_world_runtime_authority "$SOURCE_ROOT/config/world-runtime.lock.json"
  validate_world_runtime_invariants
  phase_finish "world_sha=$WORLD_SHA,water_name_index=$WATER_NAME_INDEX_RELEASE"
fi

previous_game=$(readlink -e "$GAME_CURRENT_LINK")
previous_public=$(readlink -e "$CLIENT_CURRENT_LINK")
[[ -n "$previous_game" && -n "$previous_public" ]] || fail 'could not record current rollback targets'
previous_game_sha=${previous_game##*/}
[[ "$previous_game_sha" =~ ^[0-9a-f]{40}$ ]] || fail 'previous game target is not an immutable SHA release'
previous_game_generation=$(resolve_game_generation "$previous_game_sha")
prepare_world_handoff_rollback

phase_start change_classification
CLIENT_CHANGED=false
SERVER_CHANGED=false
SHARED_CHANGED=false
if sudo -u debian git --git-dir="$MIRROR_ROOT" cat-file -e "${previous_game_sha}^{commit}" 2>/dev/null; then
  mapfile -d '' CHANGED_PATHS < <(sudo -u debian git --git-dir="$MIRROR_ROOT" \
    diff --name-only -z "$previous_game_sha" "$GAME_SHA")
else
  CHANGED_PATHS=(__unknown_previous_commit__)
fi
for changed_path in "${CHANGED_PATHS[@]}"; do
  case "$changed_path" in
    apps/client/*) CLIENT_CHANGED=true ;;
    apps/server/*|db/migrations/*) SERVER_CHANGED=true ;;
    packages/shared/*) SHARED_CHANGED=true ;;
  esac
done
DEPLOYMENT_LANE=$(classify_changed_paths "${CHANGED_PATHS[@]}")
read -r server_plan client_plan < <(
  deployment_plan_for_lane "$DEPLOYMENT_LANE" "$CLIENT_CHANGED" "$SERVER_CHANGED" "$SHARED_CHANGED"
)
BUILD_SERVER=${server_plan#server=}
BUILD_CLIENT=${client_plan#client=}
read -r MIGRATION_REQUIRED MIGRATION_REASON < <(
  probe_migration_requirement "$previous_game_sha" "$GAME_SHA"
)
[[ "$MIGRATION_REASON" != ledger_probe_failed ]] || fail 'Main migration ledger could not be proven during PREPARE'
RELEASE_CLASS=$(release_class_for_lane "$DEPLOYMENT_LANE" "$MIGRATION_REQUIRED")
CANDIDATE_DATABASE_STRATEGY=$(candidate_database_strategy_for_class "$RELEASE_CLASS")
RELEASE_CHANGED_PATHS_SHA256=$(changed_paths_hash "${CHANGED_PATHS[@]}")
RELEASE_CLASSIFICATION_EVIDENCE_SHA256=$(printf '%s\n' \
  "$RELEASE_CLASSIFICATION_VERSION" "$previous_game_sha" "$GAME_SHA" \
  "$DEPLOYMENT_LANE" "$MIGRATION_REQUIRED" "$MIGRATION_REASON" \
  "$RELEASE_CHANGED_PATHS_SHA256" | sha256sum | cut -d' ' -f1)
operation_receipt_update deployment_lane "$DEPLOYMENT_LANE" \
  release_classification_version "__NUMBER__$RELEASE_CLASSIFICATION_VERSION" \
  release_class "$RELEASE_CLASS" \
  candidate_database_strategy "$CANDIDATE_DATABASE_STRATEGY" \
  release_changed_paths_sha256 "$RELEASE_CHANGED_PATHS_SHA256" \
  release_classification_evidence_sha256 "$RELEASE_CLASSIFICATION_EVIDENCE_SHA256" \
  migration_required "$(if [[ "$MIGRATION_REQUIRED" = true ]]; then printf __TRUE__; else printf __FALSE__; fi)" \
  migration_result "$(if [[ "$MIGRATION_REQUIRED" = true ]]; then printf pending; else printf not_required; fi)"
phase_finish "lane=$DEPLOYMENT_LANE,migration_required=$MIGRATION_REQUIRED,reason=$MIGRATION_REASON"

NODE_VERSION=$(node --version)
PNPM_VERSION=$(pnpm --version)
LOCK_HASH=$(sha256sum "$SOURCE_ROOT/pnpm-lock.yaml" | cut -d' ' -f1)
MANIFEST_HASH=$(hash_files "$SOURCE_ROOT" './package.json' './apps/*/package.json' './packages/*/package.json' './pnpm-workspace.yaml')
TSCONFIG_HASH=$(hash_files "$SOURCE_ROOT" './tsconfig*.json' './apps/*/tsconfig*.json' './packages/*/tsconfig*.json')
BUILD_CONFIG_HASH=$(hash_files "$SOURCE_ROOT" './vite.config.*' './apps/*/vite.config.*' './*esbuild*.js' './*esbuild*.mjs' './*esbuild*.cjs' './*esbuild*.ts' './apps/*/*esbuild*.js' './apps/*/*esbuild*.mjs' './package.json')
SERVER_GENERATED_INPUT_HASH=$(hash_files "$SOURCE_ROOT" './packages/shared/src/generated/*')
WORLD_RUNTIME_LOCK_HASH=$(sha256sum "$SOURCE_ROOT/config/world-runtime.lock.json" | cut -d' ' -f1)
CLIENT_GENERATED_INPUT_HASH=$(hash_files "$SOURCE_ROOT" './apps/client/public/*' './apps/client/src/assets/*' './packages/shared/src/generated/*')
VITE_GOOGLE_CLIENT_ID=$(sed -n 's/^VITE_GOOGLE_CLIENT_ID=//p' "$ENV_FILE")
[[ -n "$VITE_GOOGLE_CLIENT_ID" ]] || fail 'VITE Google client ID is absent'
VITE_POPULATION_FRAME_BATCHING_ENABLED=$(sed -n 's/^VITE_POPULATION_FRAME_BATCHING_ENABLED=//p' "$ENV_FILE")
VITE_POPULATION_FRAME_BATCHING_ENABLED=${VITE_POPULATION_FRAME_BATCHING_ENABLED:-false}
[[ "$VITE_POPULATION_FRAME_BATCHING_ENABLED" =~ ^(true|false)$ ]] ||
  fail 'VITE population frame batching setting must be true or false'
BUNDLE_ENV_HASH=$(printf 'VITE_GOOGLE_CLIENT_ID=%s\nVITE_CLOSED_TEST_TELEMETRY_ENABLED=true\nVITE_POPULATION_FRAME_BATCHING_ENABLED=%s\nBASE=/play/\n' "$VITE_GOOGLE_CLIENT_ID" "$VITE_POPULATION_FRAME_BATCHING_ENABLED" | sha256sum | cut -d' ' -f1)
DEPENDENCY_KEY=$(printf '%s\n' "$LOCK_HASH" "$MANIFEST_HASH" "$NODE_VERSION" "$PNPM_VERSION" | sha256sum | cut -d' ' -f1)
SERVER_CACHE_KEY=$(printf '%s\n' "$SERVER_TREE" "$SHARED_TREE" "$LOCK_HASH" "$MANIFEST_HASH" "$NODE_VERSION" "$PNPM_VERSION" "$TSCONFIG_HASH" "$BUILD_CONFIG_HASH" "$SERVER_GENERATED_INPUT_HASH" "$WORLD_RUNTIME_LOCK_HASH" | sha256sum | cut -d' ' -f1)
CLIENT_CACHE_KEY=$(printf '%s\n' client-artifact-v3 "$CLIENT_TREE" "$SHARED_TREE" "$LOCK_HASH" "$MANIFEST_HASH" "$NODE_VERSION" "$PNPM_VERSION" "$TSCONFIG_HASH" "$BUILD_CONFIG_HASH" "$CLIENT_GENERATED_INPUT_HASH" "$BUNDLE_ENV_HASH" | sha256sum | cut -d' ' -f1)
CLIENT_BUILD_SHA=$CLIENT_CACHE_KEY
readonly DEPENDENCY_CACHE="$CACHE_ROOT/dependencies/$DEPENDENCY_KEY"
readonly SERVER_CACHE="$CACHE_ROOT/builds/server/$SERVER_CACHE_KEY"
readonly CLIENT_CACHE="$CACHE_ROOT/builds/client/$CLIENT_CACHE_KEY"

# Pure-cache and orphan cleanup runs before this run builds anything or measures restore space.
phase_start build_cache_retention_preflight
cleanup_stale_preflight_leftovers
prune_build_caches "dependencies=$DEPENDENCY_KEY" "server=$SERVER_CACHE_KEY" "client=$CLIENT_CACHE_KEY"
phase_finish "cache_deleted=$BUILD_CACHE_DELETED,freed_bytes=$BUILD_CACHE_FREED_BYTES,stale_databases=$STALE_PREFLIGHT_DATABASES_DROPPED,stale_snapshots=$STALE_PREFLIGHT_SNAPSHOTS_REMOVED"

if [[ "$BUILD_SERVER" = true && "$MIGRATION_REQUIRED" = true ]]; then
  assert_candidate_rehearsal_disk_space
fi

phase_start build_cache_lookup
SERVER_SOURCE=build
CLIENT_SOURCE=build
previous_manifest="$previous_game/build-manifest.json"
if [[ "$BUILD_SERVER" = false && -f "$previous_manifest" ]] &&
    /usr/bin/node -e 'const m=require(process.argv[1]);process.exit(m.cache_keys?.server===process.argv[2]?0:1)' \
      "$previous_manifest" "$SERVER_CACHE_KEY"; then
  SERVER_SOURCE=previous_release
elif [[ -f "$SERVER_CACHE/artifact.tar.gz" ]]; then
  SERVER_SOURCE=cache
fi
if [[ "$BUILD_CLIENT" = false && -f "$previous_manifest" ]] &&
    /usr/bin/node -e 'const m=require(process.argv[1]);process.exit(m.cache_keys?.client===process.argv[2]?0:1)' \
      "$previous_manifest" "$CLIENT_CACHE_KEY"; then
  CLIENT_SOURCE=previous_release
elif [[ -f "$CLIENT_CACHE/artifact.tar.gz" ]]; then
  CLIENT_SOURCE=cache
fi
operation_receipt_update cache_results \
  "__JSON__{\"dependencies\":\"pending\",\"server\":\"$SERVER_SOURCE\",\"client\":\"$CLIENT_SOURCE\"}"
if [[ "$RELEASE_CLASS" = client_only && "$SERVER_SOURCE" != previous_release ]]; then
  fail 'client-only release could not reuse the exact live server artifact'
fi
phase_finish "server=$SERVER_SOURCE,client=$CLIENT_SOURCE"

phase_start dependency_preparation
if restore_dependencies "$DEPENDENCY_CACHE"; then
  DEPENDENCY_RESULT=cache_hit
  phase_finish cache_hit
else
  sudo -u debian env HOME=/home/debian PNPM_STORE_DIR=/home/debian/.local/share/pnpm/store \
    pnpm --dir "$SOURCE_ROOT" install --frozen-lockfile
  cache_dependencies "$DEPENDENCY_CACHE"
  DEPENDENCY_RESULT=cache_miss
  phase_finish cache_miss
fi
operation_receipt_update cache_results \
  "__JSON__{\"dependencies\":\"$DEPENDENCY_RESULT\",\"server\":\"$SERVER_SOURCE\",\"client\":\"$CLIENT_SOURCE\"}"

SERVER_LOG="$TIMING_ROOT/${GAME_SHA}.server-build.log"
CLIENT_LOG="$TIMING_ROOT/${GAME_SHA}.client-build.log"
NATIVE_LOG="$TIMING_ROOT/${GAME_SHA}.native-bundle-build.log"
server_pid=
client_pid=
native_pid=
NATIVE_BUILD_ROOT=
NATIVE_BUILD_PLATFORMS=
if [[ "$BUILD_CLIENT" = true ]]; then
NATIVE_BUILD_PLATFORMS=$($NODE_BIN - "$previous_public/release.json" "$CLIENT_BUILD_SHA" <<'NODE'
const fs = require("node:fs");
const [file, sha] = process.argv.slice(2);
const release = JSON.parse(fs.readFileSync(file, "utf8"));
process.stdout.write(["ios", "android"]
  .filter(platform => release.clients?.[platform]?.client_sha !== sha).join(","));
NODE
) || fail 'previous native client identity could not be read'
fi
if [[ "$SERVER_SOURCE" = build ]]; then
  server_started_ns=$(date +%s%N)
  (
    # The root controller shell intentionally owns the deployment timing log.
    # shellcheck disable=SC2024
    if sudo -u debian env HOME=/home/debian pnpm --dir "$SOURCE_ROOT" --filter @ash-atlas/server build >"$SERVER_LOG" 2>&1; then
      cache_artifact "$SOURCE_ROOT" "$SERVER_CACHE" apps/server/dist
    else
      exit 1
    fi
  ) &
  server_pid=$!
else
  server_started_ns=$(date +%s%N)
fi
if [[ "$CLIENT_SOURCE" = build ]]; then
  client_started_ns=$(date +%s%N)
  (
    # The root controller shell intentionally owns the deployment timing log.
    # shellcheck disable=SC2024
    if sudo -u debian env HOME=/home/debian VITE_GOOGLE_CLIENT_ID="$VITE_GOOGLE_CLIENT_ID" \
      VITE_CLOSED_TEST_TELEMETRY_ENABLED=true \
      VITE_POPULATION_FRAME_BATCHING_ENABLED="$VITE_POPULATION_FRAME_BATCHING_ENABLED" \
      VITE_CLIENT_BUILD_SHA="$CLIENT_BUILD_SHA" \
      pnpm --dir "$SOURCE_ROOT/apps/client" exec vite build --base=/play/ >"$CLIENT_LOG" 2>&1; then
      cache_artifact "$SOURCE_ROOT" "$CLIENT_CACHE" apps/client/dist
    else
      exit 1
    fi
  ) &
  client_pid=$!
else
  client_started_ns=$(date +%s%N)
fi

if [[ -n "$NATIVE_BUILD_PLATFORMS" ]]; then
  native_started_ns=$(date +%s%N)
  NATIVE_BUILD_ROOT=$(sudo -u debian mktemp -d /tmp/ash-atlas-native.XXXXXXXX) ||
    fail 'native bundle build directory could not be allocated'
  native_server_sha=$GAME_SHA
  if [[ "$RELEASE_CLASS" = client_only ]]; then native_server_sha=$previous_game_sha; fi
  "$NODE_BIN" "$SOURCE_ROOT/tools/release/build-native-bundles.mjs" build \
    --source "$SOURCE_ROOT" --build-root "$NATIVE_BUILD_ROOT" \
    --game-sha "$GAME_SHA" --client-sha "$CLIENT_BUILD_SHA" \
    --server-sha "$native_server_sha" --generation "$GAME_GENERATION" \
    --platforms "$NATIVE_BUILD_PLATFORMS" \
    --google-client-id "$VITE_GOOGLE_CLIENT_ID" \
    --population-frame-batching "$VITE_POPULATION_FRAME_BATCHING_ENABLED" \
    >"$NATIVE_LOG" 2>&1 &
  native_pid=$!
fi

build_failures=()
if [[ -n "$server_pid" ]]; then
  if wait "$server_pid"; then
    record_phase server_build "$server_started_ns" cache_miss
  else
    record_phase server_build "$server_started_ns" failed
    build_failures+=("server build failed; see $SERVER_LOG")
  fi
else
  record_phase server_build "$server_started_ns" "$SERVER_SOURCE"
fi
if [[ -n "$client_pid" ]]; then
  if wait "$client_pid"; then
    record_phase client_build "$client_started_ns" cache_miss
  else
    record_phase client_build "$client_started_ns" failed
    build_failures+=("client build failed; see $CLIENT_LOG")
  fi
else
  record_phase client_build "$client_started_ns" "$CLIENT_SOURCE"
fi
if [[ -n "$native_pid" ]]; then
  native_wait_started_ns=$(date +%s%N)
  if wait "$native_pid"; then
    native_added_seconds=$(( ($(date +%s%N) - native_wait_started_ns) / 1000000000 ))
    record_phase native_bundle_build "$native_started_ns" \
      "platforms=$NATIVE_BUILD_PLATFORMS,added_seconds=$native_added_seconds"
    printf 'Native bundle build added %s seconds after web/server builds.\n' "$native_added_seconds"
  else
    record_phase native_bundle_build "$native_started_ns" failed
    build_failures+=("native bundle build failed; see $NATIVE_LOG")
  fi
  rm -rf -- "$NATIVE_BUILD_ROOT"
fi
[[ ${#build_failures[@]} -eq 0 ]] || fail "${build_failures[*]}"
if [[ "$RELEASE_CLASS" = client_only ]]; then
  [[ -d "$previous_game/apps/server/dist" ]] || fail 'live server component is absent'
elif [[ "$SERVER_SOURCE" = previous_release ]]; then
  [[ -d "$previous_game/apps/server/dist" ]] || fail 'previous server artifact is absent'
  install -d -o debian -g debian -m 0755 "$SOURCE_ROOT/apps/server/dist"
  cp -a "$previous_game/apps/server/dist/." "$SOURCE_ROOT/apps/server/dist/"
  chown -R debian:debian "$SOURCE_ROOT/apps/server/dist"
  find "$SOURCE_ROOT/apps/server/dist" -type d -exec chmod u+rwx {} +
else
  restore_artifact "$SERVER_CACHE" "$SOURCE_ROOT" || fail 'server cache restore failed'
fi
if [[ "$CLIENT_SOURCE" = previous_release ]]; then
  [[ -d "$previous_public" ]] || fail 'previous client artifact is absent'
  install -d -o debian -g debian -m 0755 "$SOURCE_ROOT/apps/client/dist"
  cp -a "$previous_public/." "$SOURCE_ROOT/apps/client/dist/"
  chown -R debian:debian "$SOURCE_ROOT/apps/client/dist"
  find "$SOURCE_ROOT/apps/client/dist" -type d -exec chmod u+rwx {} +
else
  restore_artifact "$CLIENT_CACHE" "$SOURCE_ROOT" || fail 'client cache restore failed'
fi
assert_source_clean cache_restore || fail 'cache restore dirtied the source checkout'

phase_start artifact_hashing
SERVER_COMPONENT_SHA=$GAME_SHA
SERVER_ARTIFACT_ROOT="$SOURCE_ROOT/apps/server/dist"
if [[ "$RELEASE_CLASS" = client_only ]]; then
  SERVER_COMPONENT_SHA=$previous_game_sha
  SERVER_ARTIFACT_ROOT="$previous_game/apps/server/dist"
fi
SERVER_ARTIFACT_HASH=$(artifact_content_hash "$SERVER_ARTIFACT_ROOT")
if [[ "$RELEASE_CLASS" = client_only ]]; then
  recorded_live_server_hash=$(/usr/bin/node -e \
    'const m=require(process.argv[1]);process.stdout.write(m.artifact_hashes?.server||"")' \
    "$previous_manifest")
  [[ "$recorded_live_server_hash" = "$SERVER_ARTIFACT_HASH" ]] ||
    fail 'live server component differs from its immutable build manifest'
fi
CLIENT_COMPONENT_SHA=$GAME_SHA
[[ -f "$previous_public/release.json" && ! -L "$previous_public/release.json" ]] ||
  fail 'previous public release metadata is absent or unsafe'
PREVIOUS_RELEASE_COPY=$(mktemp \
  "$SOURCE_ROOT/apps/client/dist/.previous-release.XXXXXXXX.json") ||
  fail 'could not allocate prior public release metadata copy'
[[ -f "$PREVIOUS_RELEASE_COPY" && ! -L "$PREVIOUS_RELEASE_COPY" ]] ||
  fail 'prior public release metadata copy allocation is unsafe'
install -o debian -g debian -m 0600 "$previous_public/release.json" \
  "$PREVIOUS_RELEASE_COPY" || fail 'prior public release metadata could not be staged'
[[ $(stat -c '%U:%G:%a' "$PREVIOUS_RELEASE_COPY") = debian:debian:600 ]] ||
  fail 'staged prior public release metadata permissions are unsafe'
cmp -s "$previous_public/release.json" "$PREVIOUS_RELEASE_COPY" ||
  fail 'staged prior public release metadata differs from the immutable source'
previous_public_game_sha=$(sudo -u debian "$NODE_BIN" -e \
  'const r=require(process.argv[1]);process.stdout.write(r.game_sha||"")' \
  "$PREVIOUS_RELEASE_COPY") || fail 'staged prior public game SHA could not be read'
[[ "$previous_public_game_sha" =~ ^[0-9a-f]{40}$ ]] || fail 'previous public game SHA is malformed'
release_json_candidate="$SOURCE_ROOT/apps/client/dist/release.json.candidate"
rm -f -- "$release_json_candidate"
native_client_sha_args=()
if [[ ",$NATIVE_BUILD_PLATFORMS," = *,ios,* ]]; then
  native_client_sha_args+=(--ios-client-sha "$CLIENT_BUILD_SHA")
fi
if [[ ",$NATIVE_BUILD_PLATFORMS," = *,android,* ]]; then
  native_client_sha_args+=(--android-client-sha "$CLIENT_BUILD_SHA")
fi
patch_note_args=()
if [[ "$RELEASE_PATCH_NOTES_HEX" != none ]]; then
  [[ "$RELEASE_PATCH_NOTES_HEX" =~ ^([0-9a-f]{2})+$ && ${#RELEASE_PATCH_NOTES_HEX} -le 128000 ]] || fail 'release patch-note input is unsafe'
  patch_note_args=(--publish-patch-notes true --release-patch-notes-hex "$RELEASE_PATCH_NOTES_HEX")
fi
sudo -u debian "$NODE_BIN" "$SOURCE_ROOT/tools/release/public-release-metadata.mjs" \
  --repository "$SOURCE_ROOT" \
  --policy "$SOURCE_ROOT/config/public-version-series.json" \
  --previous-release "$PREVIOUS_RELEASE_COPY" \
  --previous-sha "$previous_public_game_sha" \
  --game-sha "$GAME_SHA" \
  --game-generation "$GAME_GENERATION" \
  --client-sha "$CLIENT_BUILD_SHA" \
  "${native_client_sha_args[@]}" \
  "${patch_note_args[@]}" \
  --release-class "$RELEASE_CLASS" \
  --server-component-sha "$SERVER_COMPONENT_SHA" \
  --server-artifact-sha256 "$SERVER_ARTIFACT_HASH" \
  --client-component-sha "$CLIENT_COMPONENT_SHA" \
  --output "$release_json_candidate" || fail 'public release metadata generation failed'
if [[ "$previous_public_game_sha" = "$GAME_SHA" ]]; then
  # Re-preparing an already published candidate must retain its immutable metadata.
  "$NODE_BIN" - "$PREVIOUS_RELEASE_COPY" "$release_json_candidate" <<'NODE' ||
const fs = require("node:fs");
const [previousPath, candidatePath] = process.argv.slice(2);
const previous = JSON.parse(fs.readFileSync(previousPath, "utf8"));
const candidate = JSON.parse(fs.readFileSync(candidatePath, "utf8"));
if (candidate.publish_patch_notes && (previous.publish_patch_notes !== true ||
    JSON.stringify(previous.patch_notes) !== JSON.stringify(candidate.patch_notes))) {
  throw new Error("existing candidate patch-note consent or wording differs");
}
for (const key of ["game_sha", "game_generation", "client_sha", "release_class",
  "server_component_sha", "server_artifact_sha256", "client_component_sha"]) {
  if (previous[key] !== candidate[key]) throw new Error(`existing candidate ${key} differs`);
}
NODE
    fail 'existing candidate release metadata identity differs'
  install -o debian -g debian -m 0644 "$PREVIOUS_RELEASE_COPY" "$release_json_candidate"
fi
rm -f -- "$PREVIOUS_RELEASE_COPY" || fail 'staged prior public release metadata cleanup failed'
PREVIOUS_RELEASE_COPY=
install -o debian -g debian -m 0644 "$release_json_candidate" \
  "$SOURCE_ROOT/apps/client/dist/release.json"
rm -f -- "$release_json_candidate"
CLIENT_ASSET_RETENTION=()
if [[ "$CLIENT_SOURCE" != previous_release ]]; then
  seed_client_asset_retention_from_destination "$SOURCE_ROOT/apps/client/dist"
fi
copy_previous_hashed_client_assets "$SOURCE_ROOT/apps/client/dist"
write_client_asset_manifest "$SOURCE_ROOT/apps/client/dist"
prune_client_assets_to_manifest "$SOURCE_ROOT/apps/client/dist"
CLIENT_ARTIFACT_HASH=$(artifact_content_hash "$SOURCE_ROOT/apps/client/dist")
phase_finish "server=$SERVER_ARTIFACT_HASH,client=$CLIENT_ARTIFACT_HASH"

export GAME_SHA SOURCE_TREE SERVER_TREE CLIENT_TREE SHARED_TREE LOCK_HASH MANIFEST_HASH NODE_VERSION PNPM_VERSION
export TSCONFIG_HASH BUILD_CONFIG_HASH SERVER_GENERATED_INPUT_HASH WORLD_RUNTIME_LOCK_HASH CLIENT_GENERATED_INPUT_HASH
export BUNDLE_ENV_HASH DEPENDENCY_KEY SERVER_CACHE_KEY CLIENT_CACHE_KEY
export CLIENT_BUILD_SHA
export VITE_POPULATION_FRAME_BATCHING_ENABLED
export SERVER_ARTIFACT_HASH CLIENT_ARTIFACT_HASH DEPLOYMENT_LANE SERVER_SOURCE CLIENT_SOURCE
export RELEASE_CLASS SERVER_COMPONENT_SHA CLIENT_COMPONENT_SHA
/usr/bin/node - "$BUILD_MANIFEST" <<'NODE'
const fs = require("node:fs");
const e = process.env;
const manifest = {
  schema_version: 2,
  source_commit_sha: e.GAME_SHA,
  source_tree_sha: e.SOURCE_TREE,
  deployment_lane: e.DEPLOYMENT_LANE,
  release_class: e.RELEASE_CLASS,
  components: { server_sha: e.SERVER_COMPONENT_SHA, client_sha: e.CLIENT_COMPONENT_SHA },
  cache_keys: { dependencies: e.DEPENDENCY_KEY, server: e.SERVER_CACHE_KEY, client: e.CLIENT_CACHE_KEY },
  client_build_sha: e.CLIENT_BUILD_SHA,
  artifact_sources: { server: e.SERVER_SOURCE, client: e.CLIENT_SOURCE },
  toolchain: { node: e.NODE_VERSION, pnpm: e.PNPM_VERSION },
  artifact_hashes: { server: e.SERVER_ARTIFACT_HASH, client: e.CLIENT_ARTIFACT_HASH },
  built_at_utc: new Date().toISOString(),
  build_commands: {
    server: "pnpm --filter @ash-atlas/server build",
    client: "vite build --base=/play/"
  },
  inputs: {
    server_tree: e.SERVER_TREE, client_tree: e.CLIENT_TREE, shared_tree: e.SHARED_TREE,
    lockfile: e.LOCK_HASH, manifests: e.MANIFEST_HASH, tsconfig: e.TSCONFIG_HASH,
    build_config: e.BUILD_CONFIG_HASH,
    server_generated_assets: e.SERVER_GENERATED_INPUT_HASH,
    world_runtime_lock: e.WORLD_RUNTIME_LOCK_HASH,
    client_generated_assets: e.CLIENT_GENERATED_INPUT_HASH,
    bundling_environment: e.BUNDLE_ENV_HASH,
    population_frame_batching_enabled:
      e.VITE_POPULATION_FRAME_BATCHING_ENABLED === "true"
  }
};
fs.writeFileSync(process.argv[2], JSON.stringify(manifest, null, 2) + "\n");
NODE

phase_start release_assembly
if server_activation_required "$RELEASE_CLASS" && [[ ! -d "$GAME_RELEASE" ]]; then
  [[ ! -e "$GAME_INCOMING" ]] || fail 'game incoming release path already exists'
  install -d -o root -g ash-atlas -m 0750 "$GAME_INCOMING"
  tar -C "$SOURCE_ROOT" --exclude=.git -cf - . | tar --no-same-owner -xf - -C "$GAME_INCOMING"
  install -o root -g ash-atlas -m 0440 "$BUILD_MANIFEST" "$GAME_INCOMING/build-manifest.json"
  chown -R root:ash-atlas "$GAME_INCOMING"
  chmod -R u=rwX,g=rX,o= "$GAME_INCOMING"
  mv "$GAME_INCOMING" "$GAME_RELEASE"
fi
if [[ ! -d "$CLIENT_RELEASE" ]]; then
  [[ ! -e "$CLIENT_INCOMING" ]] || fail 'client incoming release path already exists'
  install -d -o root -g caddy -m 0550 "$CLIENT_INCOMING"
  tar -C "$SOURCE_ROOT/apps/client/dist" -cf - . | tar --no-same-owner -xf - -C "$CLIENT_INCOMING"
  chown -R root:caddy "$CLIENT_INCOMING"
  find "$CLIENT_INCOMING" -type d -exec chmod 0550 {} +
  find "$CLIENT_INCOMING" -type f -exec chmod 0440 {} +
  mv "$CLIENT_INCOMING" "$CLIENT_RELEASE"
fi
if server_activation_required "$RELEASE_CLASS"; then
  [[ -d "$GAME_RELEASE" && ! -L "$GAME_RELEASE" ]] || fail 'immutable game release is absent or unsafe'
else
  [[ ! -e "$GAME_RELEASE" ]] || fail 'client-only release unexpectedly assembled a server payload'
  [[ $(readlink -e "$GAME_CURRENT_LINK") = "$previous_game" ]] ||
    fail 'client-only release changed the live server component during PREPARE'
fi
[[ -d "$CLIENT_RELEASE" && ! -L "$CLIENT_RELEASE" ]] || fail 'immutable client release is absent or unsafe'
server_manifest="$GAME_RELEASE/build-manifest.json"
if ! server_activation_required "$RELEASE_CLASS"; then server_manifest="$previous_manifest"; fi
/usr/bin/node -e '
const fs=require("node:fs");
const [path,sha,tree]=process.argv.slice(1);
const m=JSON.parse(fs.readFileSync(path,"utf8"));
if(m.source_commit_sha!==sha||m.source_tree_sha!==tree)process.exit(1);
' "$server_manifest" "$SERVER_COMPONENT_SHA" \
  "$(sudo -u debian git --git-dir="$MIRROR_ROOT" rev-parse "$SERVER_COMPONENT_SHA^{tree}")" ||
  fail 'server component build manifest identity differs'
grep -Fqx "  \"game_sha\": \"$GAME_SHA\"," "$CLIENT_RELEASE/release.json" || fail 'immutable client release identity differs'
grep -Fqx "  \"game_generation\": \"$GAME_GENERATION\"," "$CLIENT_RELEASE/release.json" || fail 'immutable client generation identity differs'
assembled_server_root="$GAME_RELEASE/apps/server/dist"
if ! server_activation_required "$RELEASE_CLASS"; then assembled_server_root="$previous_game/apps/server/dist"; fi
[[ $(artifact_content_hash "$assembled_server_root") = "$SERVER_ARTIFACT_HASH" ]] ||
  fail 'assembled server artifact content differs from the exact candidate build'
[[ $(artifact_content_hash "$CLIENT_RELEASE") = "$CLIENT_ARTIFACT_HASH" ]] ||
  fail 'assembled client artifact content differs from the exact candidate build'
phase_finish
assert_source_clean release_assembly || fail 'release assembly dirtied the source checkout'

phase_start database_snapshot_wait
if [[ "$CANDIDATE_DATABASE_STRATEGY" = fresh_migration_replay && "$MIGRATION_REQUIRED" = true ]]; then
  # Main's data is never copied for the rehearsal; the pre-migration backup covers live data.
  operation_receipt_update production_snapshot_result skipped:schema_rehearsal
  phase_finish "skipped:schema_rehearsal"
elif [[ "$CANDIDATE_DATABASE_STRATEGY" = fresh_migration_replay ]]; then
  operation_receipt_update production_snapshot_result skipped:server_no_migration
  phase_finish "skipped:server_no_migration_fresh_replay"
else
  operation_receipt_update production_snapshot_result skipped:server_artifact_unchanged
  phase_finish "skipped:server_artifact_unchanged"
fi

candidate_preflight_started_ns=$(date +%s%N)
if [[ "$BUILD_SERVER" = true ]]; then
  preflight_operation=${OPERATION_ID,,}
  PREFLIGHT_DATABASE="ash_atlas_preflight_${SHORT_SHA}_${preflight_operation//-/_}"
  [[ "$PREFLIGHT_DATABASE" =~ ^ash_atlas_preflight_[a-z0-9_]{1,45}$ ]] ||
    fail 'candidate preflight database identity is unsafe'
  PREFLIGHT_DATABASE_URL=$(database_url_for "$PREFLIGHT_DATABASE")
  PREFLIGHT_DATABASE_USER=$(PREFLIGHT_DATABASE_URL="$PREFLIGHT_DATABASE_URL" /usr/bin/node -e \
    'process.stdout.write(new URL(process.env.PREFLIGHT_DATABASE_URL).username)')
  [[ "$PREFLIGHT_DATABASE_USER" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] ||
    fail 'candidate preflight database role is unsafe'
  [[ "$CANDIDATE_DATABASE_STRATEGY" = fresh_migration_replay ]] ||
    fail 'server candidate has no safe database preflight strategy'
  if [[ "$MIGRATION_REQUIRED" = true ]]; then
    select_migration_transaction_mode
  fi
  phase_start candidate_extension_provisioning
  verify_preflight_service_role
  preflight_ledger_hash=$(sha256sum "$MIGRATION_APPLIED" | cut -d' ' -f1)
  ensure_fresh_preflight_template "$preflight_ledger_hash"
  operation_receipt_update candidate_extension_provisioning_result completed
  phase_finish "template=$PREFLIGHT_TEMPLATE_RESULT,admin:$(IFS=,; printf '%s' "${PREFLIGHT_REQUIRED_EXTENSIONS[*]}")"
  phase_start candidate_database_create
  if [[ "$MIGRATION_REQUIRED" = true ]]; then
    assert_candidate_rehearsal_disk_space
  fi
  # Set first so a partly created rehearsal database is still dropped on failure.
  PREFLIGHT_DATABASE_CREATED=true
  sudo -u postgres createdb --template="$PREFLIGHT_TEMPLATE_DATABASE" \
    --owner="$PREFLIGHT_DATABASE_USER" "$PREFLIGHT_DATABASE"
  operation_receipt_update candidate_database_create_result completed
  phase_finish "owner=$PREFLIGHT_DATABASE_USER,strategy=$CANDIDATE_DATABASE_STRATEGY"
  phase_start candidate_migration_replay
  replay_fresh_preflight_migrations
  operation_receipt_update candidate_migration_replay_result completed
  if [[ "$MIGRATION_REQUIRED" = true ]]; then
    phase_finish "schema_rehearsal:$MIGRATION_REASON,transaction=$MIGRATION_TRANSACTION_MODE,template=$PREFLIGHT_TEMPLATE_RESULT"
  else
    phase_finish "restricted_service_role,template=$PREFLIGHT_TEMPLATE_RESULT"
  fi
  phase_start candidate_migration_ledger
  verify_fresh_preflight_migration_ledger
  operation_receipt_update candidate_migration_ledger_result completed
  phase_finish exact
  CANDIDATE_PREFLIGHT_LOG="$TIMING_ROOT/${GAME_SHA}.candidate-preflight.log"
  phase_start candidate_readiness
  if ! start_release_preflight "$GAME_RELEASE" "$GAME_SHA" \
      "$CANDIDATE_PREFLIGHT_PORT" "$CANDIDATE_PREFLIGHT_LOG" candidate; then
    phase_finish failed
    operation_receipt_update candidate_preflight_result failed
    fail "production candidate failed isolated readiness; see $CANDIDATE_PREFLIGHT_LOG"
  fi
  phase_finish ready
  operation_receipt_update candidate_preflight_result completed candidate_readiness_result completed
  phase_start previous_binary_readiness
  if [[ "$MIGRATION_REQUIRED" = true ]]; then
    PREVIOUS_PREFLIGHT_LOG="$TIMING_ROOT/${GAME_SHA}.previous-binary-preflight.log"
    if start_release_preflight "$previous_game" "$previous_game_sha" \
        "$PREVIOUS_PREFLIGHT_PORT" "$PREVIOUS_PREFLIGHT_LOG" previous; then
      PRIOR_BINARY_RESTART_SAFE=true
      operation_receipt_update prior_binary_restart_safe __TRUE__
    else
      PRIOR_BINARY_RESTART_SAFE=false
      operation_receipt_update prior_binary_restart_safe __FALSE__
      printf 'WARNING: prior binary cannot restart after candidate migrations; see %s\n' \
        "$PREVIOUS_PREFLIGHT_LOG" >&2
    fi
    phase_finish "restart_safe=$PRIOR_BINARY_RESTART_SAFE"
  else
    PRIOR_BINARY_RESTART_SAFE=true
    operation_receipt_update prior_binary_restart_safe __TRUE__
    phase_finish skipped:no_candidate_migration
  fi
  phase_start population_repair_admission
  if [[ "$MIGRATION_REQUIRED" = true ]]; then
    # Proves the candidate check runs on the migrated schema; Main's data is rechecked after
    # the live migration, before activation.
    run_population_repair_admission "$PREFLIGHT_DATABASE_URL"
    population_repair_database=disposable_schema_rehearsal
  else
    run_population_repair_admission
    population_repair_database=main
  fi
  operation_receipt_update population_repair_admission_count \
    "__NUMBER__$POPULATION_REPAIR_ADMISSION_COUNT" \
    population_repair_admission_database "$population_repair_database"
  phase_finish "clean:$population_repair_database"
  phase_start candidate_preflight_cleanup
  cleanup_release_preflight || fail 'candidate preflight resources could not be removed'
  assert_preflight_database_absent || fail 'candidate preflight database remains after cleanup'
  operation_receipt_update candidate_cleanup_result completed candidate_process_cleanup_result completed
  phase_finish database_absent,process_reaped
  record_phase candidate_preflight "$candidate_preflight_started_ns" \
    "strategy=$CANDIDATE_DATABASE_STRATEGY,candidate=ready,prior_restart_safe=$PRIOR_BINARY_RESTART_SAFE"
else
  operation_receipt_update candidate_preflight_result not_required \
    prior_binary_restart_safe __TRUE__
  PRIOR_BINARY_RESTART_SAFE=true
  record_phase candidate_preflight "$candidate_preflight_started_ns" \
    "skipped:server_artifact_unchanged"
fi

if [[ "$DEPLOY_MODE" = prepare ]]; then
  phase_start prepared_receipt_creation
  capture_game_process_identity
  prepared_game_link_sha=${previous_game##*/}
  prepared_public_link_sha=${previous_public##*/}
  prepared_public_release_sha=$(/usr/bin/node -e \
    'const r=require(process.argv[1]);process.stdout.write(r.game_sha||"")' \
    "$previous_public/release.json")
  [[ "$prepared_game_link_sha" = "$previous_game_sha" &&
      "$prepared_public_link_sha" = "$prepared_public_release_sha" ]] ||
    fail 'prepared live component links and public release identity disagree'
  prepared_server_release="$GAME_RELEASE"
  if ! server_activation_required "$RELEASE_CLASS"; then prepared_server_release="$previous_game"; fi
  prepared_build_manifest_hash=$(sha256sum "$prepared_server_release/build-manifest.json" | cut -d' ' -f1)
  prepared_release_json_hash=$(sha256sum "$CLIENT_RELEASE/release.json" | cut -d' ' -f1)
  prepared_game_release_hash=
  if server_activation_required "$RELEASE_CLASS"; then
    prepared_game_release_hash=$(immutable_release_hash "$GAME_RELEASE")
  fi
  prepared_public_release_hash=$(immutable_release_hash "$CLIENT_RELEASE")
  PREPARED_RELEASE_METADATA_FENCE_SHA256=$(immutable_release_metadata_fence \
    "$prepared_server_release" "$CLIENT_RELEASE")
  prepared_migration_ledger_hash=$(sha256sum "$MIGRATION_APPLIED" | cut -d' ' -f1)
  prepared_env_sha256=$(runtime_environment_sha256)
  prepare_hash=$(prepared_receipt_hash "$GAME_SHA" "$GAME_GENERATION" \
    "$previous_game_sha" "${previous_public##*/}" "$prepared_build_manifest_hash" \
    "$prepared_release_json_hash" "$prepared_game_release_hash" "$prepared_public_release_hash" \
    "$prepared_migration_ledger_hash" "$prepared_env_sha256" \
    "$PREPARED_NATIVE_COMPATIBILITY_SHA256" "$MIGRATION_REQUIRED" \
    "$MIGRATION_REASON" "$PRIOR_BINARY_RESTART_SAFE" \
    "$PREPARED_STATIC_ARTIFACT_FENCE_SHA256" "$PREPARED_RELEASE_METADATA_FENCE_SHA256" \
    "$RELEASE_CLASSIFICATION_VERSION" "$RELEASE_CLASS" \
    "$RELEASE_CLASSIFICATION_EVIDENCE_SHA256" "$RELEASE_CHANGED_PATHS_SHA256" \
    "$PREPARED_DESCRIPTOR_VERSION" "$SERVER_COMPONENT_SHA" "$SERVER_ARTIFACT_HASH" \
    "$CLIENT_COMPONENT_SHA" "$CLIENT_ARTIFACT_HASH" "$CAPTURED_GAME_MAIN_PID" \
    "$CAPTURED_GAME_START_TIMESTAMP_MONOTONIC")
  operation_receipt_update prepare_result completed prepared_at_utc "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    prepared_generation "$GAME_GENERATION" prepared_previous_game_sha "$previous_game_sha" \
    prepared_previous_public_sha "${previous_public##*/}" \
    prepared_migration_reason "$MIGRATION_REASON" \
    prepared_build_manifest_sha256 "$prepared_build_manifest_hash" \
    prepared_release_json_sha256 "$prepared_release_json_hash" \
    prepared_game_release_sha256 "$prepared_game_release_hash" \
    prepared_public_release_sha256 "$prepared_public_release_hash" \
    prepared_static_artifact_fence_sha256 "$PREPARED_STATIC_ARTIFACT_FENCE_SHA256" \
    prepared_release_metadata_fence_sha256 "$PREPARED_RELEASE_METADATA_FENCE_SHA256" \
    prepared_migration_ledger_sha256 "$prepared_migration_ledger_hash" \
    prepared_env_sha256 "$prepared_env_sha256" \
    prepared_server_component_sha "$SERVER_COMPONENT_SHA" \
    prepared_server_artifact_sha256 "$SERVER_ARTIFACT_HASH" \
    prepared_client_component_sha "$CLIENT_COMPONENT_SHA" \
    prepared_client_artifact_sha256 "$CLIENT_ARTIFACT_HASH" \
    prepared_game_main_pid "__NUMBER__$CAPTURED_GAME_MAIN_PID" \
    prepared_game_start_timestamp_monotonic "__NUMBER__$CAPTURED_GAME_START_TIMESTAMP_MONOTONIC" \
    prepared_live_game_link_sha "$prepared_game_link_sha" \
    prepared_live_public_link_sha "$prepared_public_link_sha" \
    prepared_live_public_release_sha "$prepared_public_release_sha" \
    prepared_descriptor_version "__NUMBER__$PREPARED_DESCRIPTOR_VERSION" \
    prepared_descriptor_sha256 "$prepare_hash" \
    prepare_receipt_sha256 "$prepare_hash" result prepared current_phase prepared
  phase_finish "prepared_receipt=$prepare_hash"
  printf 'Ash Atlas candidate PREPARED: %s (%s)\n' "$GAME_SHA" "$prepare_hash"
  exit 0
fi
fi

printf '%s\n' "$previous_game" > /var/lib/ash-atlas/previous-game-target
printf '%s\n' "$previous_public" > /var/lib/ash-atlas/previous-public-target
chmod 0600 /var/lib/ash-atlas/previous-game-target /var/lib/ash-atlas/previous-public-target

if server_activation_required "$RELEASE_CLASS" && [[ "$MIGRATION_REQUIRED" != true ]]; then
  phase_start population_repair_admission_recheck
  run_population_repair_admission
  phase_finish clean:main
fi

phase_start service_stop
operation_receipt_update activation_result running
if server_activation_required "$RELEASE_CLASS"; then
  ACTIVATION_STARTED=true
  if ! systemctl stop ash-atlas.service; then
    printf 'systemctl stop returned nonzero; verifying the stopped worker state\n' >&2
  fi
  confirm_game_worker_stopped
  phase_finish
else
  phase_finish skipped:client_only
fi

phase_start migration
if [[ "$MIGRATION_REQUIRED" = true ]]; then
  MIGRATION_PHASE_STARTED=true
  select_migration_transaction_mode
  write_migration_intent_marker
  MIGRATION_COMMAND_STARTED=true
  operation_receipt_update migration_intent_marker "$MIGRATION_INTENT_MARKER" \
    migration_outcome_uncertain __TRUE__ migration_started __TRUE__ migration_result running
  if ! sudo -u ash-atlas env HOME=/var/lib/ash-atlas MIGRATION_TRANSACTION="$MIGRATION_TRANSACTION_MODE" bash -c \
    "set -a; . '$ENV_FILE'; set +a; cd '$GAME_RELEASE'; /usr/bin/node node_modules/tsx/dist/cli.mjs apps/server/src/db/migrate.ts"; then
    # In batch mode every pending migration and its ledger row share one transaction, so an
    # unchanged ledger proves nothing committed and the previous release can safely restart.
    if [[ "$MIGRATION_TRANSACTION_MODE" = batch ]] && capture_live_migration_ledger &&
        cmp -s -- "$MIGRATION_APPLIED" "$MIGRATION_POST_APPLIED"; then
      rm -f -- "$MIGRATION_INTENT_MARKER"
      MIGRATION_COMMAND_STARTED=false
      operation_receipt_update migration_intent_marker '' migration_outcome_uncertain __FALSE__ \
        migration_result failed || true
      phase_finish rolled_back:transaction=batch
      fail 'candidate database migration failed and rolled back as one transaction; Main is unchanged'
    fi
    fail 'candidate database migration failed'
  fi
  MIGRATION_COMMAND_COMPLETED=true
  capture_live_migration_ledger || fail 'live migration ledger could not be captured after migration'
  verify_live_migration_ledger || fail 'live migration ledger is incomplete or differs from the candidate'
  MIGRATION_LEDGER_VERIFIED=true
  migration_ledger_before_sha256=$(sha256sum "$MIGRATION_APPLIED" | cut -d' ' -f1)
  migration_ledger_after_sha256=$(sha256sum "$MIGRATION_POST_APPLIED" | cut -d' ' -f1)
  operation_receipt_update migration_ledger_before_sha256 "$migration_ledger_before_sha256" \
    migration_ledger_after_sha256 "$migration_ledger_after_sha256" \
    migration_ledger_verified __TRUE__ migration_command_completed __TRUE__
  operation_receipt_update migration_completed __TRUE__ migration_result completed \
    migration_outcome_uncertain __FALSE__
  MIGRATION_RECEIPT_COMPLETED=true
  LIVE_MIGRATION_COMPLETED=true
  phase_finish performed
else
  phase_finish skipped
fi

if server_activation_required "$RELEASE_CLASS" && [[ "$MIGRATION_REQUIRED" = true ]]; then
  phase_start population_repair_admission_recheck
  run_population_repair_admission
  phase_finish clean:main_after_migration
fi

phase_start symlink_activation
operation_receipt_update activation_started __TRUE__
if server_activation_required "$RELEASE_CLASS"; then
  atomic_link "$GAME_RELEASE" "$GAME_CURRENT_LINK"
  update_runtime_identity "$GAME_SHA" "$GAME_GENERATION"
  assert_post_switch_environment
  phase_finish
else
  [[ $(readlink -e "$GAME_CURRENT_LINK") = "$previous_game" ]] ||
    fail 'client-only activation cannot change the server component'
  phase_finish skipped:client_only
fi

phase_start service_restart
if ! server_activation_required "$RELEASE_CLASS"; then
  systemctl is-active --quiet ash-atlas.service || fail 'unchanged game service is not active'
  /usr/local/libexec/ash-atlas-wait-ready game || fail 'unchanged game service is not ready'
  phase_finish skipped:client_only
elif ! systemctl start ash-atlas.service || ! /usr/local/libexec/ash-atlas-wait-ready game; then
  systemctl stop ash-atlas.service || true
  if [[ "$LIVE_MIGRATION_COMPLETED" = true && "$PRIOR_BINARY_RESTART_SAFE" = false ]]; then
    ACTIVATION_STARTED=false
    fail 'candidate failed readiness after live migration; prior binary was proven incompatible and was not restarted'
  fi
  restore_previous_world_for_rollback || fail 'candidate failed and prior World runtime did not recover'
  atomic_link "$previous_game" "$GAME_CURRENT_LINK"
  update_runtime_identity "$previous_game_sha" "$previous_game_generation"
  systemctl start ash-atlas.service || fail 'candidate failed and previous worker could not restart'
  /usr/local/libexec/ash-atlas-wait-ready game || fail 'candidate failed and previous worker did not recover'
  ACTIVATION_STARTED=false
  fail 'candidate game worker failed readiness; previous immutable release restored'
else
  phase_finish
fi

phase_start public_activation
expected_active_game="$GAME_RELEASE"
expected_active_game_sha="$GAME_SHA"
if ! server_activation_required "$RELEASE_CLASS"; then
  capture_game_process_identity
  [[ "$CAPTURED_GAME_MAIN_PID" = "$prepared_game_main_pid" &&
      "$CAPTURED_GAME_START_TIMESTAMP_MONOTONIC" = "$prepared_game_start_timestamp_monotonic" ]] ||
    fail 'client-only activation observed a changed game service process before public activation'
  expected_active_game="$previous_game"
  expected_active_game_sha="$previous_game_sha"
  ACTIVATION_STARTED=true
fi
[[ $(readlink -e "$GAME_CURRENT_LINK") = "$expected_active_game" ]] || fail 'active server component differs'
atomic_link "$CLIENT_RELEASE" "$CLIENT_CURRENT_LINK"
caddy validate --config "$CADDY_FILE"
if ! server_activation_required "$RELEASE_CLASS"; then
  systemctl restart ash-atlas.service
  /usr/local/libexec/ash-atlas-wait-ready game
  capture_game_process_identity
  [[ "$CAPTURED_GAME_MAIN_PID" != "$prepared_game_main_pid" ||
      "$CAPTURED_GAME_START_TIMESTAMP_MONOTONIC" != "$prepared_game_start_timestamp_monotonic" ]] ||
    fail 'client-only activation did not restart the unchanged game service'
  [[ $(readlink -e "$GAME_CURRENT_LINK") = "$previous_game" ]] ||
    fail 'client-only activation changed the server link'
  operation_receipt_update activated_game_main_pid "__NUMBER__$CAPTURED_GAME_MAIN_PID" \
    activated_game_start_timestamp_monotonic "__NUMBER__$CAPTURED_GAME_START_TIMESTAMP_MONOTONIC" \
    activated_game_link_sha "$previous_game_sha" activated_public_link_sha "$GAME_SHA"
fi
assert_post_switch_environment
operation_receipt_update activation_completed __TRUE__ \
  activation_result completed active_game_sha "$expected_active_game_sha" active_public_sha "$GAME_SHA"
phase_finish

phase_start host_readiness
operation_receipt_update readiness_result running
systemctl is-active --quiet ash-atlas.service
/usr/local/libexec/ash-atlas-wait-ready game
operation_receipt_update readiness_result completed
phase_finish

public_origin=$(sed -n 's/^APP_PUBLIC_ORIGIN=//p' "$ENV_FILE")
[[ "$public_origin" = 'https://playashatlas.com' ]] || fail 'public Origin is not exact'
anonymous_ws_status=$(curl --http1.1 --silent --show-error --max-time 20 \
  --output /dev/null --write-out '%{http_code}' \
  --header "Origin: $public_origin" \
  --header 'Connection: Upgrade' --header 'Upgrade: websocket' \
  --header 'Sec-WebSocket-Version: 13' --header 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  "$public_origin/ws")
[[ "$anonymous_ws_status" = 401 ]] || fail "anonymous WebSocket returned HTTP $anonymous_ws_status"
anonymous_player_packages_status=$(curl --silent --show-error --max-time 20 \
  --output /dev/null --write-out '%{http_code}' \
  "$public_origin/api/admin/player-packages/catalog")
[[ "$anonymous_player_packages_status" = 401 ||
    "$anonymous_player_packages_status" = 403 ]] ||
  fail "anonymous Player Packages catalog returned HTTP $anonymous_player_packages_status"
water_visual_headers=$(mktemp)
water_visual_sample=$(mktemp)
curl --fail --silent --show-error --max-time 20 --range 0-126 \
  --dump-header "$water_visual_headers" --output "$water_visual_sample" \
  "$public_origin$WATER_VISUAL_TILES_URL"
[[ $(wc -c < "$water_visual_sample") = 127 ]] || fail 'public water visual range body differs'
grep -Eiq '^HTTP/[0-9.]+ 206([[:space:]]|$)' "$water_visual_headers" || fail 'public water visual request was not partial content'
grep -Eiq "^content-range:[[:space:]]*bytes 0-126/$WATER_VISUAL_TILES_ARTIFACT_SIZE" "$water_visual_headers" || fail 'public water visual Content-Range differs'
grep -Eiq '^cache-control:.*max-age=31536000.*immutable' "$water_visual_headers" || fail 'public water visual artifact is not immutable for one year'
rm -f "$water_visual_headers" "$water_visual_sample"
systemctl enable ash-atlas-world.service ash-atlas.service

assert_source_clean success || fail 'successful deployment dirtied the source checkout'
activate_native_bundle_candidate
ACTIVATION_STARTED=false

run_discord_patch_notes_phase || true

phase_start release_retention_post_activation
prune_deployment_releases "$GAME_SHA" "$previous_game_sha" "$previous_public_sha"
prune_build_caches
phase_finish "game_deleted=$GAME_RELEASES_DELETED,public_deleted=$CLIENT_RELEASES_DELETED,native_deleted=$NATIVE_BUNDLES_DELETED,cache_deleted=$BUILD_CACHE_DELETED"

printf 'Ash Atlas test update activated: %s\n' "$GAME_SHA"
printf 'Deployment lane: %s; migration required: %s; World remained running.\n' \
  "$DEPLOYMENT_LANE" "$MIGRATION_REQUIRED"
