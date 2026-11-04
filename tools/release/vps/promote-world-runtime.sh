#!/usr/bin/env bash
set -euo pipefail

readonly TARGET_SHA=${1:-}
readonly EXPECTED_CURRENT_SHA=${2:-}
readonly DEPENDENCY_MANIFEST_SHA256=${3:-}
readonly WORLD_RELEASE=${4:-}
readonly WORLD_MANIFEST_SHA256=${5:-}
readonly RIVER_RELEASE=${6:-}
readonly RIVER_MANIFEST_SHA256=${7:-}
readonly RIVER_POLICY=${8:-}
readonly LAKE_RELEASE=${9:-}
readonly LAKE_MANIFEST_SHA256=${10:-}
readonly LAKE_POLICY=${11:-}
readonly OCEAN_RELEASE=${12:-}
readonly OCEAN_MANIFEST_SHA256=${13:-}
readonly OCEAN_POLICY=${14:-}
readonly WATERBODY_IDENTITY_OVERLAY_RELEASE=${15:-}
readonly WATERBODY_IDENTITY_OVERLAY_MANIFEST_SHA256=${16:-}
readonly WATERBODY_IDENTITY_OVERLAY_SCHEMA=${17:-}
readonly WATERBODY_IDENTITY_OVERLAY_SCHEMA_VERSION=${18:-}
readonly WATERBODY_IDENTITY_OVERLAY_POLICY=${19:-}
readonly WATERBODY_IDENTITY_OVERLAY_POLICY_VERSION=${20:-}
readonly EXPECTED_CURRENT_WORLD_RELEASE=${21:-}
readonly EXPECTED_CURRENT_WORLD_MANIFEST_SHA256=${22:-}
readonly EXPECTED_CURRENT_RIVER_RELEASE=${23:-}
readonly EXPECTED_CURRENT_RIVER_MANIFEST_SHA256=${24:-}
readonly EXPECTED_CURRENT_LAKE_RELEASE=${25:-}
readonly EXPECTED_CURRENT_LAKE_MANIFEST_SHA256=${26:-}
readonly EXPECTED_CURRENT_OCEAN_RELEASE=${27:-}
readonly EXPECTED_CURRENT_OCEAN_MANIFEST_SHA256=${28:-}
readonly OPERATION_ID=${29:-}
readonly CANDIDATE_READINESS_SECONDS=${30:-45}
readonly RIVERBANK_RELEASE=${32:-}
readonly RIVERBANK_MANIFEST_SHA256=${33:-}
readonly RIVERBANK_SCHEMA=${34:-}
readonly RIVERBANK_POLICY=${35:-}
readonly RIVERBANK_PIPELINE_SHA=${36:-}
readonly RIVERBANK_CONTRACT_FINGERPRINT=${37:-}
readonly RIVERBANK_GRID_FINGERPRINT=${38:-}
readonly RIVERBANK_DISTANCE_M=${39:-}
readonly RIVERBANK_CELL_SIZE_M=${40:-}
readonly RIVERBANK_INVENTORY_SHA256=${41:-}
readonly RIVERBANK_SOURCE_PACKAGE_FINGERPRINT=${42:-}
readonly RIVERBANK_SELECTED_PACKAGE_FINGERPRINT=${43:-}
readonly RIVERBANK_DETERMINISTIC_FINGERPRINT=${44:-}
readonly RIVERBANK_PACKAGE_COUNT=${45:-}
readonly RIVERBANK_SELECTED_PACKAGE_COUNT=${46:-}
readonly RIVERBANK_POSITIVE_PACKAGE_COUNT=${47:-}
readonly RIVERBANK_EMPTY_PACKAGE_COUNT=${48:-}
readonly RIVERBANK_SOURCE_PACKAGE_COUNT=${49:-}
readonly RIVERBANK_SPAN_COUNT=${50:-}
readonly RIVERBANK_MEMBERSHIP_CELL_COUNT=${51:-}
readonly WATER_NAME_INDEX_RELEASE=${52:-}
readonly WATER_NAME_INDEX_MANIFEST_SHA256=${53:-}
readonly WATER_NAME_INDEX_SCHEMA=${54:-}
readonly WATER_NAME_INDEX_POLICY=${55:-}
readonly WATER_NAME_INDEX_ENTRIES_FILENAME=${56:-}
readonly WATER_NAME_INDEX_ENTRIES_FORMAT=${57:-}
readonly WATER_NAME_INDEX_ENTRIES_SHA256=${58:-}
readonly WATER_NAME_INDEX_ENTRIES_SIZE_BYTES=${59:-}
readonly WATER_NAME_INDEX_HASH=${60:-}
readonly WATER_NAME_INDEX_DETERMINISTIC_FINGERPRINT=${61:-}
readonly WATER_NAME_INDEX_ENTRY_COUNT=${62:-}
readonly WATER_NAME_INDEX_RIVER_COUNT=${63:-}
readonly WATER_NAME_INDEX_LAKE_COUNT=${64:-}
readonly WATER_NAME_INDEX_OCEAN_COUNT=${65:-}
readonly WATER_NAME_INDEX_RIVER_MAX_DISTANCE_M=${66:-}
readonly WATER_NAME_INDEX_LAKE_MAX_DISTANCE_M=${67:-}
readonly WATER_NAME_INDEX_OCEAN_MAX_DISTANCE_M=${68:-}

readonly REPOSITORY=github.com:example-org/world-data.git
readonly RUNTIME_ROOT=/srv/ash-atlas/world/runtime
readonly RUNTIME_RELEASE_ROOT=$RUNTIME_ROOT/releases
readonly ENVIRONMENT_ROOT=$RUNTIME_ROOT/environments
readonly MIRROR_ROOT=/home/debian/repos/world-data.git
readonly UNIT=/etc/systemd/system/ash-atlas-world.service
readonly OPS_UNIT=/home/debian/ops/ash-atlas-server/ash-atlas-world.service
readonly CANDIDATE_UNIT=/run/systemd/system/ash-atlas-world-candidate.service
readonly ACTIVATION_UNIT=/run/systemd/system/ash-atlas-world-activation.service
readonly LOCK_FILE=/run/lock/ash-atlas-world-promotion.lock
readonly TIMING_ROOT=/var/log/ash-atlas/world-promotions
readonly TIMING_TSV=$TIMING_ROOT/$OPERATION_ID.tsv
readonly CANDIDATE_PORT=8877
readonly TARGET_SHORT=${TARGET_SHA:0:8}
readonly RUNTIME_RELEASE=$RUNTIME_RELEASE_ROOT/$TARGET_SHA
readonly RUNTIME_INCOMING=$RUNTIME_RELEASE.incoming-$OPERATION_ID
readonly RUNTIME_COMPLETE=$RUNTIME_RELEASE/.ash-atlas-runtime-complete
readonly PYTHON_VERSION=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
readonly DEPENDENCY_ID=py$PYTHON_VERSION-$DEPENDENCY_MANIFEST_SHA256
readonly DEPENDENCY_ENV=$ENVIRONMENT_ROOT/$DEPENDENCY_ID
readonly DEPENDENCY_INCOMING=$DEPENDENCY_ENV.incoming-$OPERATION_ID
readonly DEPENDENCY_COMPLETE=$DEPENDENCY_ENV/.ash-atlas-dependency-complete
readonly UNIT_BACKUP=$UNIT.pre-$OPERATION_ID
readonly OPS_UNIT_BACKUP=$OPS_UNIT.pre-$OPERATION_ID
readonly WORLD_RELEASE_ROOT=/srv/ash-atlas/world/releases
readonly SUPPLEMENTAL_STAGING_ROOT=/home/debian/ash-atlas-world-promotion-staging
readonly RIVER_SURFACE_TARGET_ROOT_TOKEN=${31:-}
readonly RIVER_SURFACE_TARGET_ROOT=$WORLD_RELEASE_ROOT/$RIVER_SURFACE_TARGET_ROOT_TOKEN
readonly RIVERBANK_TRANSFER_ROOT=$SUPPLEMENTAL_STAGING_ROOT/$OPERATION_ID-$RIVERBANK_RELEASE
readonly WATER_NAME_INDEX_TRANSFER_ROOT=$SUPPLEMENTAL_STAGING_ROOT/$OPERATION_ID-$WATER_NAME_INDEX_RELEASE
readonly RIVERBANK_TARGET_ROOT_TOKEN=$RIVERBANK_RELEASE
readonly RIVERBANK_TARGET_ROOT=$WORLD_RELEASE_ROOT/$RIVERBANK_TARGET_ROOT_TOKEN
readonly WATER_NAME_INDEX_TARGET_ROOT_TOKEN=$WATER_NAME_INDEX_RELEASE
readonly WATER_NAME_INDEX_TARGET_ROOT=$WORLD_RELEASE_ROOT/$WATER_NAME_INDEX_TARGET_ROOT_TOKEN
readonly RIVERBANK_TARGET_INCOMING=$RIVERBANK_TARGET_ROOT.incoming-$OPERATION_ID
readonly WATER_NAME_INDEX_TARGET_INCOMING=$WATER_NAME_INDEX_TARGET_ROOT.incoming-$OPERATION_ID

PHASE_NAME=
PHASE_STARTED_NS=0
ACTIVATED=false
PREVIOUS_CURRENT=
CURRENT_IDENTITY_JSON=
TARGET_IDENTITY_JSON=
TARGET_ACTIVE_RECOVERY=false
TRAP_INSTALLED=false
CLEANUP_DONE=false
ROLLBACK_RUNNING=false

fail() {
  local message=$*
  printf 'STOP: %s\n' "$message" >&2
  if [[ "$TRAP_INSTALLED" = true && "$ROLLBACK_RUNNING" != true && "$BASH_SUBSHELL" -eq 0 ]]; then
    rollback 1
  fi
  exit 1
}

phase_start() { PHASE_NAME=$1; PHASE_STARTED_NS=$(date +%s%N); }

phase_finish() {
  local result=${1:-completed} finished_ns duration_ms
  finished_ns=$(date +%s%N)
  duration_ms=$(( (finished_ns - PHASE_STARTED_NS) / 1000000 ))
  printf '%s\t%s\t%s\n' "$PHASE_NAME" "$duration_ms" "$result" | tee -a "$TIMING_TSV"
}

atomic_link() {
  local target=$1 link=$2 temporary=$2.new-$OPERATION_ID
  [[ ! -e "$temporary" && ! -L "$temporary" ]] || fail "temporary link exists: $temporary"
  ln -s "$target" "$temporary"
  mv -T "$temporary" "$link"
}

wait_ready() {
  local port=$1 expected_sha=$2 require_fast=${3:-false} require_overlay=${4:-false}
  local world_id=${5:-} world_manifest=${6:-}
  local river_id=${7:-} river_manifest=${8:-}
  local lake_id=${9:-} lake_manifest=${10:-}
  local ocean_id=${11:-} ocean_manifest=${12:-}
  local timeout_seconds=${13:-45} require_supplemental=${14:-false}
  local deadline=$((SECONDS + timeout_seconds)) body
  body=$(mktemp "$TIMING_ROOT/$OPERATION_ID.health.XXXXXX.json")
  while (( SECONDS < deadline )); do
    if curl --fail --silent --show-error --max-time 3 \
      "http://127.0.0.1:$port/api/health" >"$body" 2>/dev/null &&
      python3 - "$body" "$expected_sha" \
        "$world_id" "$world_manifest" \
        "$river_id" "$river_manifest" \
        "$lake_id" "$lake_manifest" \
        "$ocean_id" "$ocean_manifest" \
        "$WATERBODY_IDENTITY_OVERLAY_RELEASE" \
        "$WATERBODY_IDENTITY_OVERLAY_MANIFEST_SHA256" \
        "$WATERBODY_IDENTITY_OVERLAY_SCHEMA" \
        "$WATERBODY_IDENTITY_OVERLAY_SCHEMA_VERSION" \
        "$WATERBODY_IDENTITY_OVERLAY_POLICY" \
        "$WATERBODY_IDENTITY_OVERLAY_POLICY_VERSION" \
        "$RIVERBANK_RELEASE" "$RIVERBANK_MANIFEST_SHA256" \
        "$RIVERBANK_SCHEMA" "$RIVERBANK_POLICY" "$RIVERBANK_PIPELINE_SHA" \
        "$RIVERBANK_CONTRACT_FINGERPRINT" "$RIVERBANK_GRID_FINGERPRINT" \
        "$RIVERBANK_DISTANCE_M" "$RIVERBANK_CELL_SIZE_M" \
        "$WATER_NAME_INDEX_RELEASE" "$WATER_NAME_INDEX_MANIFEST_SHA256" \
        "$WATER_NAME_INDEX_SCHEMA" "$WATER_NAME_INDEX_POLICY" \
        "$WATER_NAME_INDEX_HASH" "$WATER_NAME_INDEX_ENTRY_COUNT" \
        "$WATER_NAME_INDEX_RIVER_COUNT" "$WATER_NAME_INDEX_LAKE_COUNT" \
        "$WATER_NAME_INDEX_OCEAN_COUNT" \
        "$require_fast" "$require_overlay" "$require_supplemental" <<'PY'
import json, sys
body = json.load(open(sys.argv[1], encoding="utf-8"))
expected_sha, world_id, world_manifest = sys.argv[2:5]
river_id, river_manifest, lake_id, lake_manifest, ocean_id, ocean_manifest = sys.argv[5:11]
overlay_id, overlay_manifest, overlay_schema, overlay_schema_version, overlay_policy, overlay_policy_version = sys.argv[11:17]
riverbank_id, riverbank_manifest, riverbank_schema, riverbank_policy, riverbank_pipeline = sys.argv[17:22]
riverbank_contract, riverbank_grid, riverbank_distance, riverbank_cell = sys.argv[22:26]
index_id, index_manifest, index_schema, index_policy, index_hash = sys.argv[26:31]
index_entry_count, index_river_count, index_lake_count, index_ocean_count = sys.argv[31:35]
require_fast = sys.argv[35] == "true"
require_overlay = sys.argv[36] == "true"
require_supplemental = sys.argv[37] == "true"
assert body.get("ok") is True and body.get("status") == "ready"
assert body.get("runtime", {}).get("sha") == expected_sha
assert body.get("runtime", {}).get("branch") == "main"
assert body.get("release", {}).get("release_id") == world_id
verification = body.get("release_verification", {})
assert verification.get("verification_mode") == "manifest-only"
if require_fast:
    assert verification.get("supplemental_surface_verification_mode") == "manifest-only"
assert verification.get("release_manifest_sha256") == world_manifest
assert body.get("river_surface", {}).get("identity", {}).get("release_id") == river_id
assert body.get("river_surface", {}).get("identity", {}).get("manifest_sha256") == river_manifest
assert body.get("lake_surface", {}).get("identity", {}).get("release_id") == lake_id
assert body.get("lake_surface", {}).get("identity", {}).get("manifest_sha256") == lake_manifest
assert body.get("ocean_coast_surface", {}).get("identity", {}).get("release_id") == ocean_id
assert body.get("ocean_coast_surface", {}).get("identity", {}).get("manifest_sha256") == ocean_manifest
if require_overlay:
    overlay = body.get("waterbody_identity_overlay")
    assert overlay is not None
    assert overlay.get("release_id") == overlay_id
    assert overlay.get("manifest_sha256") == overlay_manifest
    assert overlay.get("schema") == overlay_schema
    assert overlay.get("schema_version") == overlay_schema_version
    assert overlay.get("policy") == overlay_policy
    assert overlay.get("policy_version") == overlay_policy_version
    assert body.get("capabilities", {}).get("waterbodyIdentityV1") is True
if require_supplemental:
    riverbank = body.get("riverbank_lakeshore")
    assert riverbank is not None
    assert riverbank.get("mode") == riverbank_id
    riverbank_identity = riverbank.get("identity", riverbank)
    assert riverbank_identity.get("release_id") == riverbank_id
    assert riverbank_identity.get("manifest_sha256") == riverbank_manifest
    assert riverbank_identity.get("schema") == riverbank_schema
    assert riverbank_identity.get("policy") == riverbank_policy
    assert riverbank_identity.get("pipeline_sha") == riverbank_pipeline
    assert riverbank_identity.get("contract_fingerprint") == riverbank_contract
    assert riverbank_identity.get("grid_fingerprint") == riverbank_grid
    assert riverbank_identity.get("distance_m") == float(riverbank_distance)
    assert riverbank_identity.get("cell_size_m") == int(riverbank_cell)
    assert riverbank.get("cache", {}).get("max_packages") == 12
    index = body.get("water_name_index")
    assert index is not None
    index_identity = index.get("identity", index)
    assert index_identity.get("release_id") == index_id
    assert index_identity.get("manifest_sha256") == index_manifest
    assert index_identity.get("schema") == index_schema
    assert index_identity.get("policy") == index_policy
    assert index_identity.get("index_hash") == index_hash
    assert index_identity.get("entry_count") == int(index_entry_count)
    index_classes = index_identity.get("classes", index.get("classes", {}))
    assert index_classes.get("river") == int(index_river_count)
    assert index_classes.get("lake") == int(index_lake_count)
    assert index_classes.get("ocean") == int(index_ocean_count)
    assert body.get("capabilities", {}).get("riverbankLakeshoreV1") is True
PY
    then
      rm -f "$body"
      return 0
    fi
    sleep 1
  done
  rm -f "$body"
  return 1
}

validate_compact_endpoint() {
  local port=$1 expected_sha=$2
  curl --fail --silent --show-error --max-time 15 \
    "http://127.0.0.1:$port/api/gameplay-environment?lat=35.0844&lon=-106.6504" |
    python3 -c '
import json, sys
body = json.load(sys.stdin)
assert body.get("ok") is True
assert body.get("contract_version") == "gameplay-environment-v1"
assert body.get("runtime", {}).get("sha") == sys.argv[1]
' "$expected_sha"
}

validate_river_surface_target_root() {
  local manifest="$RIVER_SURFACE_TARGET_ROOT/manifest.json"
  [[ "$RIVER_SURFACE_TARGET_ROOT_TOKEN" = "$RIVER_RELEASE--sha256-$RIVER_MANIFEST_SHA256" ]] ||
    fail 'river surface target root token does not match its logical release and manifest'
  [[ "$RIVER_SURFACE_TARGET_ROOT" = "$WORLD_RELEASE_ROOT/$RIVER_SURFACE_TARGET_ROOT_TOKEN" ]] ||
    fail 'river surface target root is outside the World release root'
  [[ -d "$RIVER_SURFACE_TARGET_ROOT" && ! -L "$RIVER_SURFACE_TARGET_ROOT" ]] ||
    fail 'target river surface release root is absent or unsafe'
  [[ $(realpath -e -- "$RIVER_SURFACE_TARGET_ROOT") = "$RIVER_SURFACE_TARGET_ROOT" ]] ||
    fail 'target river surface release root cannot be resolved safely'
  [[ -f "$manifest" && ! -L "$manifest" ]] ||
    fail 'target river surface manifest is absent or unsafe'
  [[ $(sha256sum "$manifest" | cut -d' ' -f1) = "$RIVER_MANIFEST_SHA256" ]] ||
    fail 'target river surface manifest hash differs'
  python3 - "$manifest" "$RIVER_RELEASE" "$RIVER_POLICY" <<'PY'
import json, sys
manifest = json.load(open(sys.argv[1], encoding="utf-8"))
assert manifest.get("release_id") == sys.argv[2]
assert manifest.get("policy") == sys.argv[3]
PY
}

assert_safe_supplemental_root() {
  local root=$1 label=$2
  [[ -d "$root" && ! -L "$root" ]] || fail "$label root is absent or unsafe"
  [[ $(realpath -e -- "$root") = "$root" ]] || fail "$label root cannot be resolved safely"
  [[ -z "$(find -H "$root" -type l -print -quit)" ]] || fail "$label root contains a symlink"
}

validate_riverbank_release_root() {
  local root=$1 manifest="$1/manifest.json"
  assert_safe_supplemental_root "$root" 'riverbank/lakeshore'
  [[ -f "$manifest" && ! -L "$manifest" ]] || fail 'riverbank/lakeshore manifest is absent or unsafe'
  python3 - "$root" "$RIVERBANK_MANIFEST_SHA256" "$RIVERBANK_RELEASE" \
    "$RIVERBANK_SCHEMA" "$RIVERBANK_POLICY" "$RIVERBANK_PIPELINE_SHA" \
    "$RIVERBANK_CONTRACT_FINGERPRINT" "$RIVERBANK_GRID_FINGERPRINT" \
    "$RIVERBANK_DISTANCE_M" "$RIVERBANK_CELL_SIZE_M" \
    "$RIVERBANK_INVENTORY_SHA256" "$RIVERBANK_SOURCE_PACKAGE_FINGERPRINT" \
    "$RIVERBANK_SELECTED_PACKAGE_FINGERPRINT" "$RIVERBANK_DETERMINISTIC_FINGERPRINT" \
    "$RIVERBANK_PACKAGE_COUNT" "$RIVERBANK_SELECTED_PACKAGE_COUNT" \
    "$RIVERBANK_POSITIVE_PACKAGE_COUNT" "$RIVERBANK_EMPTY_PACKAGE_COUNT" \
    "$RIVERBANK_SOURCE_PACKAGE_COUNT" "$RIVERBANK_SPAN_COUNT" \
    "$RIVERBANK_MEMBERSHIP_CELL_COUNT" "$RIVER_RELEASE" "$RIVER_MANIFEST_SHA256" \
    "$RIVER_POLICY" "$LAKE_RELEASE" "$LAKE_MANIFEST_SHA256" "$LAKE_POLICY" \
    "$WORLD_RELEASE" "$WORLD_MANIFEST_SHA256" <<'PY'
import hashlib, json, os, pathlib, sys

root = pathlib.Path(sys.argv[1])
expected_manifest_hash, expected_release, expected_schema, expected_policy = sys.argv[2:6]
expected_pipeline, expected_contract, expected_grid = sys.argv[6:9]
expected_distance, expected_cell = float(sys.argv[9]), float(sys.argv[10])
expected_inventory, expected_source_fp, expected_selected_fp, expected_deterministic = sys.argv[11:15]
expected_counts = [int(value) for value in sys.argv[15:22]]
river_id, river_manifest, river_policy = sys.argv[22:25]
lake_id, lake_manifest, lake_policy = sys.argv[25:28]
world_id, world_manifest = sys.argv[28:30]

def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()

def exact(actual, expected, label):
    if str(actual) != str(expected):
        raise AssertionError(f'{label} differs')

manifest_path = root / 'manifest.json'
exact(digest(manifest_path), expected_manifest_hash, 'riverbank manifest hash')
manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
for field, expected in {
    'release_id': expected_release, 'schema': expected_schema, 'policy': expected_policy,
    'pipeline_sha': expected_pipeline, 'contract_fingerprint': expected_contract,
    'grid_fingerprint': expected_grid, 'deterministic_fingerprint': expected_deterministic,
}.items():
    exact(manifest.get(field), expected, f'riverbank manifest {field}')
for field, expected in zip(
    ('distance_m', 'cell_size_m', 'package_count', 'selected_package_count',
     'positive_package_count', 'empty_package_count', 'span_count', 'membership_cell_count'),
    (expected_distance, expected_cell, expected_counts[0], expected_counts[1],
     expected_counts[2], expected_counts[3], expected_counts[5], expected_counts[6]),
):
    if float(manifest.get(field)) != float(expected):
        raise AssertionError(f'riverbank manifest {field} differs')
inventory = manifest.get('inventory')
if not isinstance(inventory, dict):
    raise AssertionError('riverbank inventory is missing')
for field, expected in {
    'inventory_sha256': expected_inventory, 'source_package_fingerprint': expected_source_fp,
    'selected_package_fingerprint': expected_selected_fp, 'source_package_count': expected_counts[4],
}.items():
    exact(inventory.get(field), expected, f'riverbank inventory {field}')
source = manifest.get('source')
if not isinstance(source, dict):
    raise AssertionError('riverbank source authority is missing')
for key, values in {
    'river': (river_id, river_manifest, river_policy),
    'lake': (lake_id, lake_manifest, lake_policy),
    'world': (world_id, world_manifest, None),
}.items():
    entry = source.get(key)
    if not isinstance(entry, dict):
        raise AssertionError(f'riverbank source {key} is missing')
    exact(entry.get('release_id'), values[0], f'riverbank source {key} release')
    exact(entry.get('manifest_sha256'), values[1], f'riverbank source {key} manifest')
    if values[2] is not None:
        exact(entry.get('policy'), values[2], f'riverbank source {key} policy')

expected_files = {'manifest.json': (expected_manifest_hash, manifest_path.stat().st_size)}
packages = manifest.get('packages')
if not isinstance(packages, list):
    raise AssertionError('riverbank package list is missing')
for record in packages:
    if not isinstance(record, dict):
        raise AssertionError('riverbank package record is invalid')
    for kind in ('artifact', 'manifest'):
        artifact = record.get(kind)
        if not isinstance(artifact, dict):
            raise AssertionError(f'riverbank package {record.get("package_id")} lacks {kind}')
        name = artifact.get('path')
        if not isinstance(name, str) or not name or pathlib.PurePosixPath(name).is_absolute() or '..' in pathlib.PurePosixPath(name).parts:
            raise AssertionError('riverbank package path is unsafe')
        if name in expected_files:
            raise AssertionError('riverbank package paths are duplicated')
        expected_files[name] = (str(artifact.get('sha256')), int(artifact.get('size_bytes')))

actual_files = set()
for directory, dirs, files in os.walk(root, followlinks=False):
    for child in dirs:
        if os.path.islink(os.path.join(directory, child)):
            raise AssertionError('riverbank directory symlink found')
    for child in files:
        path = pathlib.Path(directory) / child
        if path.is_symlink():
            raise AssertionError('riverbank file symlink found')
        actual_files.add(path.relative_to(root).as_posix())
if actual_files != set(expected_files):
    raise AssertionError('riverbank file inventory differs')
for name, (expected_hash, expected_size) in expected_files.items():
    path = root / pathlib.PurePosixPath(name)
    if path.stat().st_size != expected_size or digest(path) != expected_hash:
        raise AssertionError(f'riverbank artifact differs: {name}')
PY
}

validate_water_name_index_release_root() {
  local root=$1 manifest="$1/manifest.json" entries="$1/$WATER_NAME_INDEX_ENTRIES_FILENAME"
  assert_safe_supplemental_root "$root" 'water-name index'
  [[ -f "$manifest" && ! -L "$manifest" && -f "$entries" && ! -L "$entries" ]] ||
    fail 'water-name index manifest or entries artifact is absent or unsafe'
  python3 - "$root" "$WATER_NAME_INDEX_MANIFEST_SHA256" "$WATER_NAME_INDEX_RELEASE" \
    "$WATER_NAME_INDEX_SCHEMA" "$WATER_NAME_INDEX_POLICY" "$WATER_NAME_INDEX_ENTRIES_FILENAME" \
    "$WATER_NAME_INDEX_ENTRIES_FORMAT" "$WATER_NAME_INDEX_ENTRIES_SHA256" \
    "$WATER_NAME_INDEX_ENTRIES_SIZE_BYTES" "$WATER_NAME_INDEX_HASH" \
    "$WATER_NAME_INDEX_DETERMINISTIC_FINGERPRINT" "$WATER_NAME_INDEX_ENTRY_COUNT" \
    "$WATER_NAME_INDEX_RIVER_COUNT" "$WATER_NAME_INDEX_LAKE_COUNT" "$WATER_NAME_INDEX_OCEAN_COUNT" \
    "$WATER_NAME_INDEX_RIVER_MAX_DISTANCE_M" "$WATER_NAME_INDEX_LAKE_MAX_DISTANCE_M" \
    "$WATER_NAME_INDEX_OCEAN_MAX_DISTANCE_M" <<'PY'
import hashlib, json, os, pathlib, sys
root = pathlib.Path(sys.argv[1])
(
    expected_manifest_hash, expected_release, expected_schema, expected_policy,
    entries_name, entries_format, expected_entries_hash, expected_entries_size,
    expected_index_hash, expected_deterministic, expected_entry_count,
    expected_river_count, expected_lake_count, expected_ocean_count,
    expected_river_distance, expected_lake_distance, expected_ocean_distance,
) = sys.argv[2:19]

def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()

manifest_path = root / 'manifest.json'
entries_path = root / pathlib.PurePosixPath(entries_name)
if entries_path.parent != root or pathlib.PurePosixPath(entries_name).is_absolute() or '..' in pathlib.PurePosixPath(entries_name).parts:
    raise AssertionError('water-name entries path is unsafe')
if digest(manifest_path) != expected_manifest_hash:
    raise AssertionError('water-name manifest hash differs')
if digest(entries_path) != expected_entries_hash or entries_path.stat().st_size != int(expected_entries_size):
    raise AssertionError('water-name entries artifact differs')
manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
for field, expected in {
    'release_id': expected_release, 'schema': expected_schema, 'policy': expected_policy,
    'entries_filename': entries_name, 'entries_format': entries_format,
    'entries_sha256': expected_entries_hash, 'index_hash': expected_index_hash,
    'deterministic_fingerprint': expected_deterministic, 'entry_count': int(expected_entry_count),
}.items():
    if manifest.get(field) != expected:
        raise AssertionError(f'water-name manifest {field} differs')
for key, expected in {'river': int(expected_river_count), 'lake': int(expected_lake_count), 'ocean': int(expected_ocean_count)}.items():
    if manifest.get('classes', {}).get(key) != expected:
        raise AssertionError(f'water-name class {key} differs')
for key, expected in {'river': float(expected_river_distance), 'lake': float(expected_lake_distance), 'ocean': float(expected_ocean_distance)}.items():
    if float(manifest.get('max_distance_m', {}).get(key)) != expected:
        raise AssertionError(f'water-name max distance {key} differs')
actual_files = set()
for directory, dirs, files in os.walk(root, followlinks=False):
    for child in dirs:
        if os.path.islink(os.path.join(directory, child)):
            raise AssertionError('water-name directory symlink found')
    for child in files:
        path = pathlib.Path(directory) / child
        if path.is_symlink():
            raise AssertionError('water-name file symlink found')
        actual_files.add(path.relative_to(root).as_posix())
if actual_files != {'manifest.json', entries_name}:
    raise AssertionError('water-name file inventory differs')
PY
}

extract_transferred_archive() {
  local transfer=$1 label=$2
  local archive="$transfer.tar"
  [[ -f "$archive" && ! -L "$archive" ]] || fail "transferred $label archive is absent or unsafe"
  [[ ! -e "$transfer" && ! -L "$transfer" ]] || fail "transferred $label root already exists"
  install -d -o root -g ash-atlas -m 0750 "$transfer"
  python3 - "$archive" "$transfer" "$label" <<'PY'
import pathlib, tarfile, sys

archive_path = pathlib.Path(sys.argv[1])
root = pathlib.Path(sys.argv[2])
label = sys.argv[3]
root_resolved = root.resolve()
names = set()

with tarfile.open(archive_path, 'r:*') as stream:
    members = stream.getmembers()
    if not members:
        raise AssertionError(f'{label} archive is empty')
    for member in members:
        name = member.name
        clean_name = name[:-1] if member.isdir() and name.endswith('/') else name
        path = pathlib.PurePosixPath(clean_name)
        if (not clean_name or str(path) != clean_name or path.is_absolute() or
                '..' in path.parts or clean_name in names):
            raise AssertionError(f'{label} archive contains an unsafe or duplicate path')
        if not (member.isdir() or member.isfile()):
            raise AssertionError(f'{label} archive contains a non-regular member')
        destination = (root / pathlib.Path(*path.parts)).resolve()
        if destination != root_resolved and root_resolved not in destination.parents:
            raise AssertionError(f'{label} archive escapes its extraction root')
        names.add(clean_name)
    stream.extractall(root, members=members)
PY
  rm -f -- "$archive"
}

resolve_transferred_root() {
  local root=$1 release=$2
  if [[ -f "$root/manifest.json" ]]; then
    printf '%s\n' "$root"
    return
  fi
  [[ -d "$root/$release" && ! -L "$root/$release" ]] || fail "transferred $release root is absent"
  printf '%s\n' "$root/$release"
}

publish_supplemental_root() {
  local transfer=$1 target=$2 validator=$3 label=$4 release=$5
  if [[ -e "$target" || -L "$target" ]]; then
    "$validator" "$target"
    rm -rf -- "$transfer" "$transfer.tar"
    printf 'reused'
    return
  fi
  extract_transferred_archive "$transfer" "$label"
  local source
  source=$(resolve_transferred_root "$transfer" "$release")
  "$validator" "$source"
  [[ ! -e "$target" && ! -L "$target" && ! -e "$RIVERBANK_TARGET_INCOMING" && ! -L "$RIVERBANK_TARGET_INCOMING" && ! -e "$WATER_NAME_INDEX_TARGET_INCOMING" && ! -L "$WATER_NAME_INDEX_TARGET_INCOMING" ]] ||
    fail "$label immutable publication path already exists"
  [[ -d "$WORLD_RELEASE_ROOT" && ! -L "$WORLD_RELEASE_ROOT" ]] || fail 'World supplemental release root is absent or unsafe'
  install -d -o root -g ash-atlas -m 0750 "$WORLD_RELEASE_ROOT"
  local incoming="$target.incoming-$OPERATION_ID"
  [[ "$incoming" = "$target".incoming-* ]] || fail "$label incoming path is unsafe"
  install -d -o root -g ash-atlas -m 0750 "$incoming"
  cp -a -- "$source/." "$incoming/"
  chown -R root:ash-atlas "$incoming"
  chmod -R u=rwX,g=rX,o= "$incoming"
  "$validator" "$incoming"
  mv -T -- "$incoming" "$target"
  "$validator" "$target"
  rm -rf -- "$transfer"
  printf 'published'
}

cleanup_supplemental_staging() {
  [[ "$CLEANUP_DONE" = false ]] || return 0
  CLEANUP_DONE=true
  rm -rf -- "$RIVERBANK_TRANSFER_ROOT" "$RIVERBANK_TRANSFER_ROOT.tar" \
    "$WATER_NAME_INDEX_TRANSFER_ROOT" "$WATER_NAME_INDEX_TRANSFER_ROOT.tar" \
    "$RIVERBANK_TARGET_INCOMING" "$WATER_NAME_INDEX_TARGET_INCOMING"
}

validate_transferred_archive() {
  local archive=$1 label=$2 identity owner_group mode mode_value
  [[ -f "$archive" && ! -L "$archive" ]] || fail "$label archive is absent or unsafe"
  identity=$(stat -c '%U:%G:%a' -- "$archive") || fail "$label archive metadata is unreadable"
  owner_group=${identity%:*}
  mode=${identity##*:}
  [[ "$owner_group" = debian:debian ]] || fail "$label archive ownership is unsafe"
  [[ "$mode" =~ ^[0-7]{3}$ ]] || fail "$label archive mode is unsafe"
  mode_value=$(printf '%d' "0$mode") || fail "$label archive mode is unreadable"
  (( (mode_value & 0400) != 0 && (mode_value & 0022) == 0 )) || fail "$label archive mode is unsafe"
}

read_validated_unit_text() {
  [[ -f "$UNIT" && ! -L "$UNIT" ]] || return 2
  cat -- "$UNIT" 2>/dev/null
}

unit_supplemental_arg_state() {
  local unit_text has_riverbank=false has_water_name=false
  unit_text=$(read_validated_unit_text) || return 2
  [[ "$unit_text" = *"--riverbank-lakeshore-"* ]] && has_riverbank=true
  [[ "$unit_text" = *"--water-name-index-"* ]] && has_water_name=true
  if [[ "$has_riverbank" = true && "$has_water_name" = true ]]; then
    printf 'complete'
  elif [[ "$has_riverbank" = false && "$has_water_name" = false ]]; then
    printf 'missing'
  else
    printf 'partial'
  fi
}

unit_has_supplemental_args() {
  local unit_text state
  state=$(unit_supplemental_arg_state) || return 1
  unit_text=$(read_validated_unit_text) || return 1
  [[ "$state" = complete &&
     "$unit_text" = *"--riverbank-lakeshore-release-root $RIVERBANK_TARGET_ROOT"* &&
     "$unit_text" = *"--riverbank-lakeshore-manifest-sha256 $RIVERBANK_MANIFEST_SHA256"* &&
     "$unit_text" = *"--riverbank-lakeshore-policy $RIVERBANK_POLICY"* &&
     "$unit_text" = *"--water-name-index-root $WATER_NAME_INDEX_TARGET_ROOT"* &&
     "$unit_text" = *"--water-name-index-manifest-sha256 $WATER_NAME_INDEX_MANIFEST_SHA256"* ]]
}

unit_has_canonical_execstart() {
  local unit_text
  unit_text=$(read_validated_unit_text) || return 1
  grep -q '^ExecStart=' <<<"$unit_text" &&
    ! grep -Eq '^[[:space:]]+ExecStart=' <<<"$unit_text"
}

target_active_recovery_state_is_safe() {
  local state=$1
  if [[ "$state" = missing ]]; then
    return 0
  fi
  [[ "$state" = complete ]] &&
    unit_has_supplemental_args &&
    ! unit_has_canonical_execstart
}

render_unit() {
  local path=$1 port=$2 candidate=$3
  local report=/var/lib/ash-atlas/verification/world-runtime/$WORLD_RELEASE-$TARGET_SHORT-manifest-only.json
  cat >"$path" <<EOF
[Unit]
Description=Ash Atlas authoritative World API${candidate}
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=3600
StartLimitBurst=3

[Service]
Type=exec
User=ash-atlas
Group=ash-atlas
WorkingDirectory=$RUNTIME_RELEASE
Environment=PYTHONUNBUFFERED=1
Environment=PYTHONDONTWRITEBYTECODE=1
Environment=PYTHONPATH=$RUNTIME_RELEASE/src
EnvironmentFile=/etc/ash-atlas/world.env
ExecStart=$DEPENDENCY_ENV/bin/python -m map_world_pipeline serve-world-release --release-root /srv/ash-atlas/world/releases/$WORLD_RELEASE --host 127.0.0.1 --port $port --runtime-branch main --runtime-sha $TARGET_SHA --verification-workers 8 --artifact-verification-mode manifest-only --verification-report $report --expected-manifest-sha256 $WORLD_MANIFEST_SHA256 --expected-release-root /srv/ash-atlas/world/releases/$WORLD_RELEASE --river-surface-mode $RIVER_RELEASE --river-surface-release-root $RIVER_SURFACE_TARGET_ROOT --river-surface-manifest-sha256 $RIVER_MANIFEST_SHA256 --river-surface-policy $RIVER_POLICY --river-surface-cache-packages 12 --lake-surface-release-root /srv/ash-atlas/world/releases/$LAKE_RELEASE --lake-surface-manifest-sha256 $LAKE_MANIFEST_SHA256 --lake-surface-policy $LAKE_POLICY --lake-surface-cache-packages 12 --ocean-coast-surface-release-root /srv/ash-atlas/world/releases/$OCEAN_RELEASE --ocean-coast-surface-manifest-sha256 $OCEAN_MANIFEST_SHA256 --ocean-coast-surface-policy $OCEAN_POLICY --ocean-coast-surface-cache-packages 12 --waterbody-identity-overlay-release-root /srv/ash-atlas/world/releases/$WATERBODY_IDENTITY_OVERLAY_RELEASE --waterbody-identity-overlay-manifest-sha256 $WATERBODY_IDENTITY_OVERLAY_MANIFEST_SHA256 --waterbody-identity-overlay-cache-packages 12 --riverbank-lakeshore-release-root $RIVERBANK_TARGET_ROOT --riverbank-lakeshore-manifest-sha256 $RIVERBANK_MANIFEST_SHA256 --riverbank-lakeshore-policy $RIVERBANK_POLICY --riverbank-lakeshore-cache-packages 12 --water-name-index-root $WATER_NAME_INDEX_TARGET_ROOT --water-name-index-manifest-sha256 $WATER_NAME_INDEX_MANIFEST_SHA256
Restart=on-failure
RestartPreventExitStatus=2
RestartSec=15s
TimeoutStartSec=60s
TimeoutStopSec=45s
KillSignal=SIGTERM
UMask=0027
NoNewPrivileges=true
PrivateDevices=true
PrivateTmp=true
ProtectClock=true
ProtectControlGroups=true
ProtectHome=true
ProtectHostname=true
ProtectKernelLogs=true
ProtectKernelModules=true
ProtectKernelTunables=true
ProtectSystem=strict
ReadWritePaths=/var/lib/ash-atlas/verification/world-runtime
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
RestrictNamespaces=true
RestrictRealtime=true
RestrictSUIDSGID=true
LockPersonality=true
CapabilityBoundingSet=
AmbientCapabilities=
SystemCallArchitectures=native

[Install]
WantedBy=multi-user.target
EOF
  if [[ -z "$candidate" ]]; then
    sed -i '/^ExecStart=/a ExecStartPost=/usr/local/libexec/ash-atlas-wait-ready-river-surface-v1 world' "$path"
  fi
}

cleanup_candidate() {
  systemctl stop ash-atlas-world-candidate.service 2>/dev/null || true
  rm -f "$CANDIDATE_UNIT" "$ACTIVATION_UNIT"
  systemctl daemon-reload 2>/dev/null || true
}

rollback() {
  local exit_code=$?
  [[ $# -eq 0 ]] || exit_code=$1
  (( exit_code != 0 )) || exit_code=1
  if [[ "$ROLLBACK_RUNNING" = true ]]; then
    exit "$exit_code"
  fi
  ROLLBACK_RUNNING=true
  TRAP_INSTALLED=false
  trap - ERR HUP INT TERM
  set +e
  cleanup_candidate
  rm -rf --one-file-system "$RUNTIME_INCOMING" "$DEPENDENCY_INCOMING"
  cleanup_supplemental_staging
  if [[ "$ACTIVATED" = true && -f "$UNIT_BACKUP" && -f "$OPS_UNIT_BACKUP" ]]; then
    install -o root -g root -m 0644 "$UNIT_BACKUP" "$UNIT"
    install -o root -g root -m 0644 "$OPS_UNIT_BACKUP" "$OPS_UNIT"
    systemctl daemon-reload
    systemctl restart ash-atlas-world.service
wait_ready 8765 "$EXPECTED_CURRENT_SHA" false false \
      "$EXPECTED_CURRENT_WORLD_RELEASE" "$EXPECTED_CURRENT_WORLD_MANIFEST_SHA256" \
      "$EXPECTED_CURRENT_RIVER_RELEASE" "$EXPECTED_CURRENT_RIVER_MANIFEST_SHA256" \
      "$EXPECTED_CURRENT_LAKE_RELEASE" "$EXPECTED_CURRENT_LAKE_MANIFEST_SHA256" \
      "$EXPECTED_CURRENT_OCEAN_RELEASE" "$EXPECTED_CURRENT_OCEAN_MANIFEST_SHA256" || true
    if [[ -n "$PREVIOUS_CURRENT" ]]; then atomic_link "$PREVIOUS_CURRENT" "$RUNTIME_ROOT/current"; fi
  fi
  printf 'World promotion failed; prior service restoration attempted.\n' >&2
  exit "$exit_code"
}

[[ ${EUID} -eq 0 ]] || fail 'run as root'
[[ "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]] || fail 'target SHA is invalid'
[[ "$EXPECTED_CURRENT_SHA" =~ ^[0-9a-f]{40}$ ]] || fail 'expected current SHA is invalid'
[[ "$DEPENDENCY_MANIFEST_SHA256" =~ ^[0-9a-f]{64}$ ]] || fail 'dependency identity is invalid'
[[ "$WORLD_RELEASE" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || fail 'World release identity is invalid'
[[ "$WORLD_MANIFEST_SHA256" =~ ^[0-9a-f]{64}$ ]] || fail 'World manifest identity is invalid'
[[ "$RIVER_RELEASE" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || fail 'river release identity is invalid'
[[ "$RIVER_MANIFEST_SHA256" =~ ^[0-9a-f]{64}$ ]] || fail 'river manifest identity is invalid'
[[ "$LAKE_RELEASE" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || fail 'lake release identity is invalid'
[[ "$LAKE_MANIFEST_SHA256" =~ ^[0-9a-f]{64}$ ]] || fail 'lake manifest identity is invalid'
[[ "$OCEAN_RELEASE" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || fail 'ocean release identity is invalid'
[[ "$OCEAN_MANIFEST_SHA256" =~ ^[0-9a-f]{64}$ ]] || fail 'ocean manifest identity is invalid'
[[ "$EXPECTED_CURRENT_WORLD_RELEASE" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || fail 'expected current World release identity is invalid'
[[ "$EXPECTED_CURRENT_WORLD_MANIFEST_SHA256" =~ ^[0-9a-f]{64}$ ]] || fail 'expected current World manifest identity is invalid'
[[ "$EXPECTED_CURRENT_RIVER_RELEASE" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || fail 'expected current river release identity is invalid'
[[ "$EXPECTED_CURRENT_RIVER_MANIFEST_SHA256" =~ ^[0-9a-f]{64}$ ]] || fail 'expected current river manifest identity is invalid'
[[ "$EXPECTED_CURRENT_LAKE_RELEASE" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || fail 'expected current lake release identity is invalid'
[[ "$EXPECTED_CURRENT_LAKE_MANIFEST_SHA256" =~ ^[0-9a-f]{64}$ ]] || fail 'expected current lake manifest identity is invalid'
[[ "$EXPECTED_CURRENT_OCEAN_RELEASE" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || fail 'expected current ocean release identity is invalid'
[[ "$EXPECTED_CURRENT_OCEAN_MANIFEST_SHA256" =~ ^[0-9a-f]{64}$ ]] || fail 'expected current ocean manifest identity is invalid'
[[ "$CANDIDATE_READINESS_SECONDS" =~ ^[0-9]+$ ]] || fail 'candidate readiness allowance is invalid'
(( CANDIDATE_READINESS_SECONDS >= 45 && CANDIDATE_READINESS_SECONDS <= 1800 )) ||
  fail 'candidate readiness allowance is outside the permitted range'
[[ "$WATERBODY_IDENTITY_OVERLAY_RELEASE" =~ ^[A-Za-z0-9._-]+$ ]] || fail 'waterbody identity overlay release is invalid'
[[ "$WATERBODY_IDENTITY_OVERLAY_MANIFEST_SHA256" =~ ^[0-9a-f]{64}$ ]] || fail 'waterbody identity overlay manifest identity is invalid'
[[ -n "$WATERBODY_IDENTITY_OVERLAY_SCHEMA" &&
   -n "$WATERBODY_IDENTITY_OVERLAY_SCHEMA_VERSION" &&
   -n "$WATERBODY_IDENTITY_OVERLAY_POLICY" &&
   -n "$WATERBODY_IDENTITY_OVERLAY_POLICY_VERSION" ]] ||
  fail 'waterbody identity overlay schema and policy are incomplete'
[[ "$RIVERBANK_RELEASE" = 'riverbank-lakeshore-v1' &&
   "$RIVERBANK_SCHEMA" = 'riverbank-lakeshore-row-spans-v1' &&
   "$RIVERBANK_POLICY" = 'canonical-water-surface-land-within-500m-v1' &&
   "$RIVERBANK_PIPELINE_SHA" = '4d3448ae3f719e678d864e04679008294f72df8c' &&
   "$RIVERBANK_CONTRACT_FINGERPRINT" = '32572021050b078ba856469a705631902e8036c8bf4512334d056732b35000ce' &&
   "$RIVERBANK_GRID_FINGERPRINT" = '44e1b2d53f5b3d38b6f5370d30c94403d6d4f90a6207f12ccdee799713a6229b' &&
   "$RIVERBANK_MANIFEST_SHA256" = 'c3a2823f759271abb77bf23220e33cb1146d9a3ecb2615f79d3e173189a2344f' &&
   "$RIVERBANK_INVENTORY_SHA256" = '2f6048b8cee3c73031ec0e58b01f870e6318d7d8cdc902aae7cf5289b9aa74a0' &&
   "$RIVERBANK_SOURCE_PACKAGE_FINGERPRINT" = 'f92da45fcd830d2191cd015db54193b72ff0307f5ce3125e4406de0681792680' &&
   "$RIVERBANK_SELECTED_PACKAGE_FINGERPRINT" = 'aab9bbdf505dda7fe1037fcb31d36e8260422307cc88edb66ed184e40f4c968e' &&
   "$RIVERBANK_DETERMINISTIC_FINGERPRINT" = '63b63551b99514f4db818ce324005f0476663133651f6b9bba040154180422e6' ]] ||
  fail 'riverbank/lakeshore authority is incomplete or invalid'
[[ "$RIVERBANK_DISTANCE_M" = '500' && "$RIVERBANK_CELL_SIZE_M" = '125' &&
   "$RIVERBANK_PACKAGE_COUNT" = '14627' && "$RIVERBANK_SELECTED_PACKAGE_COUNT" = '20542' &&
   "$RIVERBANK_POSITIVE_PACKAGE_COUNT" = '14627' && "$RIVERBANK_EMPTY_PACKAGE_COUNT" = '5915' &&
   "$RIVERBANK_SOURCE_PACKAGE_COUNT" = '14598' && "$RIVERBANK_SPAN_COUNT" = '59122237' &&
   "$RIVERBANK_MEMBERSHIP_CELL_COUNT" = '391536663' ]] ||
  fail 'riverbank/lakeshore authority counts differ from the approved lock'
[[ "$WATER_NAME_INDEX_RELEASE" = 'water-names-v1' &&
   "$WATER_NAME_INDEX_SCHEMA" = 'water-names-v1' &&
   "$WATER_NAME_INDEX_POLICY" = 'same-class-nearest-authoritative-name-v1' &&
   "$WATER_NAME_INDEX_ENTRIES_FILENAME" = 'entries.sqlite3' &&
   "$WATER_NAME_INDEX_ENTRIES_FORMAT" = 'sqlite-wkb-rtree-v1' &&
   "$WATER_NAME_INDEX_MANIFEST_SHA256" = 'bb73ebeac7c48d4adcedf9dd10e9a0a6cf591bd8ef7dfe01dca2a141a9e6317b' &&
   "$WATER_NAME_INDEX_ENTRIES_SHA256" = '40dd4b1427c0fc98cdd437ea6dcdb2b2e4d8d5412af636159624e144b337fee9' &&
   "$WATER_NAME_INDEX_HASH" = '90482d2633df3cc869e1c1162aa7b1da0503f051740122eeeb65612cd33c3bd2' &&
   "$WATER_NAME_INDEX_DETERMINISTIC_FINGERPRINT" = '41d3431fc3f87eb52b1219bccebc32228c6dd49e610f0194ea55c76c8c370661' ]] ||
  fail 'water-name index authority is incomplete or invalid'
[[ "$WATER_NAME_INDEX_ENTRIES_SIZE_BYTES" = '2295668736' &&
   "$WATER_NAME_INDEX_ENTRY_COUNT" = '526218' &&
   "$WATER_NAME_INDEX_RIVER_COUNT" = '523086' &&
   "$WATER_NAME_INDEX_LAKE_COUNT" = '3021' &&
   "$WATER_NAME_INDEX_OCEAN_COUNT" = '111' &&
   "$WATER_NAME_INDEX_RIVER_MAX_DISTANCE_M" = '25000' &&
   "$WATER_NAME_INDEX_LAKE_MAX_DISTANCE_M" = '100000' &&
   "$WATER_NAME_INDEX_OCEAN_MAX_DISTANCE_M" = '500000' ]] ||
  fail 'water-name index counts or bounds differ from the approved lock'
[[ "$OPERATION_ID" =~ ^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$ ]] || fail 'operation identity is invalid'

CURRENT_IDENTITY_JSON=$(printf '{"world_sha":"%s","release":{"release_id":"%s","manifest_sha256":"%s"},"river_surface":{"release_id":"%s","manifest_sha256":"%s","release_root_token":"%s"},"lake_surface":{"release_id":"%s","manifest_sha256":"%s"},"ocean_coast_surface":{"release_id":"%s","manifest_sha256":"%s"}}' \
  "$EXPECTED_CURRENT_SHA" \
  "$EXPECTED_CURRENT_WORLD_RELEASE" "$EXPECTED_CURRENT_WORLD_MANIFEST_SHA256" \
  "$EXPECTED_CURRENT_RIVER_RELEASE" "$EXPECTED_CURRENT_RIVER_MANIFEST_SHA256" "$EXPECTED_CURRENT_RIVER_RELEASE" \
  "$EXPECTED_CURRENT_LAKE_RELEASE" "$EXPECTED_CURRENT_LAKE_MANIFEST_SHA256" \
  "$EXPECTED_CURRENT_OCEAN_RELEASE" "$EXPECTED_CURRENT_OCEAN_MANIFEST_SHA256")
TARGET_IDENTITY_JSON=$(printf '{"world_sha":"%s","release":{"release_id":"%s","manifest_sha256":"%s"},"river_surface":{"release_id":"%s","manifest_sha256":"%s","release_root_token":"%s"},"lake_surface":{"release_id":"%s","manifest_sha256":"%s"},"ocean_coast_surface":{"release_id":"%s","manifest_sha256":"%s"},"riverbank_lakeshore":{"release_id":"%s","manifest_sha256":"%s","schema":"%s","policy":"%s","pipeline_sha":"%s","contract_fingerprint":"%s","grid_fingerprint":"%s","release_root_token":"%s"},"water_name_index":{"release_id":"%s","manifest_sha256":"%s","schema":"%s","policy":"%s","entries_filename":"%s","entries_format":"%s","entries_sha256":"%s","index_hash":"%s","deterministic_fingerprint":"%s","entry_count":%s,"release_root_token":"%s"},"waterbody_identity_overlay":{"release_id":"%s","manifest_sha256":"%s","schema":"%s","schema_version":"%s","policy":"%s","policy_version":"%s"}}' \
  "$TARGET_SHA" \
  "$WORLD_RELEASE" "$WORLD_MANIFEST_SHA256" \
  "$RIVER_RELEASE" "$RIVER_MANIFEST_SHA256" "$RIVER_SURFACE_TARGET_ROOT_TOKEN" \
  "$LAKE_RELEASE" "$LAKE_MANIFEST_SHA256" \
  "$OCEAN_RELEASE" "$OCEAN_MANIFEST_SHA256" \
  "$RIVERBANK_RELEASE" "$RIVERBANK_MANIFEST_SHA256" "$RIVERBANK_SCHEMA" "$RIVERBANK_POLICY" \
  "$RIVERBANK_PIPELINE_SHA" "$RIVERBANK_CONTRACT_FINGERPRINT" "$RIVERBANK_GRID_FINGERPRINT" "$RIVERBANK_TARGET_ROOT_TOKEN" \
  "$WATER_NAME_INDEX_RELEASE" "$WATER_NAME_INDEX_MANIFEST_SHA256" "$WATER_NAME_INDEX_SCHEMA" "$WATER_NAME_INDEX_POLICY" \
  "$WATER_NAME_INDEX_ENTRIES_FILENAME" "$WATER_NAME_INDEX_ENTRIES_FORMAT" "$WATER_NAME_INDEX_ENTRIES_SHA256" \
  "$WATER_NAME_INDEX_HASH" "$WATER_NAME_INDEX_DETERMINISTIC_FINGERPRINT" "$WATER_NAME_INDEX_ENTRY_COUNT" "$WATER_NAME_INDEX_TARGET_ROOT_TOKEN" \
  "$WATERBODY_IDENTITY_OVERLAY_RELEASE" "$WATERBODY_IDENTITY_OVERLAY_MANIFEST_SHA256" \
  "$WATERBODY_IDENTITY_OVERLAY_SCHEMA" "$WATERBODY_IDENTITY_OVERLAY_SCHEMA_VERSION" \
  "$WATERBODY_IDENTITY_OVERLAY_POLICY" "$WATERBODY_IDENTITY_OVERLAY_POLICY_VERSION")

install -d -o root -g ash-atlas -m 0750 "$RUNTIME_RELEASE_ROOT" "$ENVIRONMENT_ROOT" "$TIMING_ROOT"
exec 9>"$LOCK_FILE"
flock -n 9 || fail 'another World promotion is running'
trap rollback ERR HUP INT TERM
TRAP_INSTALLED=true

phase_start preflight
[[ -f "$UNIT" && ! -L "$UNIT" && -f "$OPS_UNIT" && ! -L "$OPS_UNIT" ]] || fail 'canonical World units are absent or unsafe'
[[ -d "$SUPPLEMENTAL_STAGING_ROOT" && ! -L "$SUPPLEMENTAL_STAGING_ROOT" ]] || fail 'World supplemental staging root is absent or unsafe'
[[ "$(stat -c '%U:%G:%a' -- "$SUPPLEMENTAL_STAGING_ROOT")" = debian:debian:700 ]] ||
  fail 'World supplemental staging root ownership or mode is unsafe'
[[ "$RIVERBANK_TRANSFER_ROOT" = "$SUPPLEMENTAL_STAGING_ROOT/$OPERATION_ID-$RIVERBANK_RELEASE" &&
   "$WATER_NAME_INDEX_TRANSFER_ROOT" = "$SUPPLEMENTAL_STAGING_ROOT/$OPERATION_ID-$WATER_NAME_INDEX_RELEASE" ]] ||
  fail 'World supplemental staging paths are unsafe'
[[ ! -e "$RIVERBANK_TRANSFER_ROOT" && ! -L "$RIVERBANK_TRANSFER_ROOT" &&
   ! -e "$WATER_NAME_INDEX_TRANSFER_ROOT" && ! -L "$WATER_NAME_INDEX_TRANSFER_ROOT" ]] ||
  fail 'World supplemental extraction directory already exists'
validate_transferred_archive "$RIVERBANK_TRANSFER_ROOT.tar" 'riverbank/lakeshore'
validate_transferred_archive "$WATER_NAME_INDEX_TRANSFER_ROOT.tar" 'water-name index'
systemctl is-active --quiet ash-atlas-world.service || fail 'current World service is not active'
if wait_ready 8765 "$EXPECTED_CURRENT_SHA" false false \
    "$EXPECTED_CURRENT_WORLD_RELEASE" "$EXPECTED_CURRENT_WORLD_MANIFEST_SHA256" \
    "$EXPECTED_CURRENT_RIVER_RELEASE" "$EXPECTED_CURRENT_RIVER_MANIFEST_SHA256" \
    "$EXPECTED_CURRENT_LAKE_RELEASE" "$EXPECTED_CURRENT_LAKE_MANIFEST_SHA256" \
    "$EXPECTED_CURRENT_OCEAN_RELEASE" "$EXPECTED_CURRENT_OCEAN_MANIFEST_SHA256"; then
  PREVIOUS_CURRENT=$(readlink -e "$RUNTIME_ROOT/current")
  [[ "$PREVIOUS_CURRENT" == "$RUNTIME_RELEASE_ROOT"/* ]] || fail 'current World runtime link is unsafe'
  phase_finish
else
  # A prior World-only promotion may leave the target core active while the old
  # protected lock remains the rollback authority and supplemental flags are absent,
  # or a complete exact supplemental identity is attached to a malformed unit.
  [[ "$TARGET_SHA" != "$EXPECTED_CURRENT_SHA" ]] || fail 'current World identity differs from the approved base'
  supplemental_state=$(unit_supplemental_arg_state) || fail 'could not inspect current World supplemental arguments'
  target_active_recovery_state_is_safe "$supplemental_state" ||
    fail 'target-active recovery requires missing supplemental arguments or a complete exact noncanonical repair state'
  wait_ready 8765 "$TARGET_SHA" true true \
    "$WORLD_RELEASE" "$WORLD_MANIFEST_SHA256" \
    "$RIVER_RELEASE" "$RIVER_MANIFEST_SHA256" \
    "$LAKE_RELEASE" "$LAKE_MANIFEST_SHA256" \
    "$OCEAN_RELEASE" "$OCEAN_MANIFEST_SHA256" "$CANDIDATE_READINESS_SECONDS" false ||
    fail 'current World is neither the approved base nor an eligible target-active recovery'
  TARGET_ACTIVE_RECOVERY=true
  PREVIOUS_CURRENT=$(readlink -e "$RUNTIME_ROOT/current")
  [[ "$PREVIOUS_CURRENT" == "$RUNTIME_RELEASE_ROOT"/* ]] || fail 'current World runtime link is unsafe'
  [[ "$PREVIOUS_CURRENT" = "$RUNTIME_RELEASE" ]] || fail 'target-active recovery runtime link differs from the target SHA'
  phase_finish target_active_recovery
fi

phase_start supplemental_authorities
riverbank_publication_result=$(publish_supplemental_root \
  "$RIVERBANK_TRANSFER_ROOT" "$RIVERBANK_TARGET_ROOT" validate_riverbank_release_root \
  'riverbank/lakeshore' "$RIVERBANK_RELEASE")
water_name_index_publication_result=$(publish_supplemental_root \
  "$WATER_NAME_INDEX_TRANSFER_ROOT" "$WATER_NAME_INDEX_TARGET_ROOT" validate_water_name_index_release_root \
  'water-name index' "$WATER_NAME_INDEX_RELEASE")
phase_finish "riverbank=$riverbank_publication_result,water_name_index=$water_name_index_publication_result"

if [[ "$TARGET_SHA" = "$EXPECTED_CURRENT_SHA" || "$TARGET_ACTIVE_RECOVERY" = true ]]; then
  phase_start same_sha_recovery
  supplemental_state=$(unit_supplemental_arg_state) || fail 'could not inspect current World supplemental arguments'
  [[ "$supplemental_state" != partial ]] || fail 'same-SHA recovery refuses partially configured supplemental arguments'
  if unit_has_supplemental_args && unit_has_canonical_execstart && wait_ready 8765 "$TARGET_SHA" true true \
      "$WORLD_RELEASE" "$WORLD_MANIFEST_SHA256" \
      "$RIVER_RELEASE" "$RIVER_MANIFEST_SHA256" \
      "$LAKE_RELEASE" "$LAKE_MANIFEST_SHA256" \
      "$OCEAN_RELEASE" "$OCEAN_MANIFEST_SHA256" "$CANDIDATE_READINESS_SECONDS" true; then
    phase_finish already-active
    validate_compact_endpoint 8765 "$TARGET_SHA"
    trap - ERR HUP INT TERM
    TRAP_INSTALLED=false
    printf '{"ok":true,"result":"already-active","world_sha":"%s","target_active_recovery":%s,"current_identity":%s,"target_identity":%s,"target_river_surface_root_token":"%s","target_riverbank_lakeshore_root_token":"%s","target_water_name_index_root_token":"%s","dependency_id":"%s","candidate_readiness_seconds":%s,"timing_receipt":"%s"}\n' \
      "$TARGET_SHA" "$TARGET_ACTIVE_RECOVERY" "$CURRENT_IDENTITY_JSON" "$TARGET_IDENTITY_JSON" "$RIVER_SURFACE_TARGET_ROOT_TOKEN" "$RIVERBANK_TARGET_ROOT_TOKEN" "$WATER_NAME_INDEX_TARGET_ROOT_TOKEN" "$DEPENDENCY_ID" "$CANDIDATE_READINESS_SECONDS" "$TIMING_TSV"
    exit 0
  fi
  phase_finish recovery-required
fi

phase_start source_materialization
if [[ ! -d "$MIRROR_ROOT" ]]; then
  install -d -o debian -g debian -m 0750 "$(dirname "$MIRROR_ROOT")"
  sudo -u debian env HOME=/home/debian git clone --mirror "$REPOSITORY" "$MIRROR_ROOT"
fi
sudo -u debian env HOME=/home/debian git -C "$MIRROR_ROOT" fetch --prune origin '+refs/heads/main:refs/heads/main'
[[ $(sudo -u debian git -C "$MIRROR_ROOT" rev-parse refs/heads/main) = "$TARGET_SHA" ]] || fail 'protected World main differs from the approved target'
actual_dependency_sha=$(sudo -u debian git -C "$MIRROR_ROOT" show "$TARGET_SHA:pyproject.toml" | sha256sum | cut -d' ' -f1)
[[ "$actual_dependency_sha" = "$DEPENDENCY_MANIFEST_SHA256" ]] || fail 'dependency manifest identity differs'
if [[ ! -f "$RUNTIME_COMPLETE" ]]; then
  [[ ! -e "$RUNTIME_RELEASE" && ! -e "$RUNTIME_INCOMING" ]] || fail 'incomplete target runtime already exists'
  install -d -o root -g ash-atlas -m 0750 "$RUNTIME_INCOMING"
  sudo -u debian git -C "$MIRROR_ROOT" archive "$TARGET_SHA" | tar --no-same-owner -xf - -C "$RUNTIME_INCOMING"
  printf '%s\n' "$TARGET_SHA" >"$RUNTIME_INCOMING/.ash-atlas-runtime-complete"
  chown -R root:ash-atlas "$RUNTIME_INCOMING"
  chmod -R u=rwX,g=rX,o= "$RUNTIME_INCOMING"
  mv "$RUNTIME_INCOMING" "$RUNTIME_RELEASE"
fi
[[ -d "$RUNTIME_RELEASE" && ! -L "$RUNTIME_RELEASE" && $(cat "$RUNTIME_COMPLETE") = "$TARGET_SHA" ]] || fail 'immutable target runtime is absent or invalid'
phase_finish

phase_start dependency_environment
dependency_result=reused
if [[ ! -f "$DEPENDENCY_COMPLETE" ]]; then
  dependency_result=created
  [[ ! -e "$DEPENDENCY_ENV" && ! -e "$DEPENDENCY_INCOMING" ]] || fail 'incomplete dependency environment exists'
  python3 -m venv "$DEPENDENCY_INCOMING"
  "$DEPENDENCY_INCOMING/bin/pip" install --disable-pip-version-check "$RUNTIME_RELEASE[global,preprocessing]"
  "$DEPENDENCY_INCOMING/bin/pip" freeze --all >"$DEPENDENCY_INCOMING/pip-freeze.txt"
  printf '%s\n%s\n' "$DEPENDENCY_MANIFEST_SHA256" "$(sha256sum "$DEPENDENCY_INCOMING/pip-freeze.txt" | cut -d' ' -f1)" >"$DEPENDENCY_INCOMING/.ash-atlas-dependency-complete"
  chown -R root:ash-atlas "$DEPENDENCY_INCOMING"
  chmod -R u=rwX,g=rX,o= "$DEPENDENCY_INCOMING"
  mv "$DEPENDENCY_INCOMING" "$DEPENDENCY_ENV"
fi
[[ -d "$DEPENDENCY_ENV" && ! -L "$DEPENDENCY_ENV" && -f "$DEPENDENCY_COMPLETE" ]] || fail 'dependency environment is absent or invalid'
[[ $(head -n 1 "$DEPENDENCY_COMPLETE") = "$DEPENDENCY_MANIFEST_SHA256" ]] || fail 'dependency receipt differs'
phase_finish "$dependency_result"

phase_start target_surface_validation
validate_river_surface_target_root
phase_finish

phase_start candidate_readiness
if ss -H -ltn "( sport = :$CANDIDATE_PORT )" | grep -q .; then fail 'candidate port is already in use'; fi
render_unit "$CANDIDATE_UNIT" "$CANDIDATE_PORT" ' candidate'
systemd-analyze verify "$CANDIDATE_UNIT"
systemctl daemon-reload
systemctl start ash-atlas-world-candidate.service
wait_ready "$CANDIDATE_PORT" "$TARGET_SHA" true true \
  "$WORLD_RELEASE" "$WORLD_MANIFEST_SHA256" \
  "$RIVER_RELEASE" "$RIVER_MANIFEST_SHA256" \
  "$LAKE_RELEASE" "$LAKE_MANIFEST_SHA256" \
  "$OCEAN_RELEASE" "$OCEAN_MANIFEST_SHA256" "$CANDIDATE_READINESS_SECONDS" true || fail 'candidate World did not become ready'
validate_compact_endpoint "$CANDIDATE_PORT" "$TARGET_SHA"
cleanup_candidate
phase_finish

phase_start activation
[[ ! -e "$UNIT_BACKUP" && ! -e "$OPS_UNIT_BACKUP" ]] || fail 'operation backup already exists'
install -o root -g root -m 0644 "$UNIT" "$UNIT_BACKUP"
install -o root -g root -m 0644 "$OPS_UNIT" "$OPS_UNIT_BACKUP"
unit_incoming=$ACTIVATION_UNIT
[[ ! -e "$unit_incoming" ]] || fail 'activation unit staging path already exists'
render_unit "$unit_incoming" 8765 ''
systemd-analyze verify "$unit_incoming"
install -o root -g root -m 0644 "$unit_incoming" "$UNIT"
install -o root -g root -m 0644 "$unit_incoming" "$OPS_UNIT"
rm -f "$unit_incoming"
ACTIVATED=true
systemctl daemon-reload
systemctl restart ash-atlas-world.service
wait_ready 8765 "$TARGET_SHA" true true \
  "$WORLD_RELEASE" "$WORLD_MANIFEST_SHA256" \
  "$RIVER_RELEASE" "$RIVER_MANIFEST_SHA256" \
  "$LAKE_RELEASE" "$LAKE_MANIFEST_SHA256" \
  "$OCEAN_RELEASE" "$OCEAN_MANIFEST_SHA256" "$CANDIDATE_READINESS_SECONDS" true || fail 'activated World did not become ready'
validate_compact_endpoint 8765 "$TARGET_SHA"
if [[ $(readlink -e "$RUNTIME_ROOT/current") != "$RUNTIME_RELEASE" ]]; then atomic_link "$RUNTIME_RELEASE" "$RUNTIME_ROOT/current"; fi
phase_finish

trap - ERR HUP INT TERM
TRAP_INSTALLED=false
printf '{"ok":true,"result":"activated","world_sha":"%s","target_active_recovery":%s,"current_identity":%s,"target_identity":%s,"target_river_surface_root_token":"%s","target_riverbank_lakeshore_root_token":"%s","target_water_name_index_root_token":"%s","dependency_id":"%s","candidate_readiness_seconds":%s,"dependency_result":"%s","previous_runtime":"%s","timing_receipt":"%s"}\n' \
  "$TARGET_SHA" "$TARGET_ACTIVE_RECOVERY" "$CURRENT_IDENTITY_JSON" "$TARGET_IDENTITY_JSON" "$RIVER_SURFACE_TARGET_ROOT_TOKEN" "$RIVERBANK_TARGET_ROOT_TOKEN" "$WATER_NAME_INDEX_TARGET_ROOT_TOKEN" "$DEPENDENCY_ID" "$CANDIDATE_READINESS_SECONDS" "$dependency_result" "$PREVIOUS_CURRENT" "$TIMING_TSV"
