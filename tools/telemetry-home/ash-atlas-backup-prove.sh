#!/usr/bin/env bash
set -euo pipefail
umask 077

fail() {
  echo "STOP: $*" >&2
  exit 1
}

usage() {
  cat >&2 <<'EOF'
Usage:
  ash-atlas-backup-prove --oldest COUNT
  ash-atlas-backup-prove --unproved COUNT
  ash-atlas-backup-prove --backup-id UUID [--backup-id UUID ...]

The oldest form selects unproved PostgreSQL backups beyond their configured
tier limits. The unproved form selects the oldest unproved retained backups,
which keeps the routine post-mirror proof bounded. Explicit IDs prove the
named retained backups. An already accepted immutable proof is safely skipped
after its path and size are checked.
EOF
  exit 2
}

selection_mode=''
oldest_count=''
unproved_count=''
requested_ids=()
declare -A requested_seen=()
while (($# > 0)); do
  case "$1" in
    --oldest)
      [[ -z "$selection_mode" && $# -ge 2 ]] || usage
      selection_mode=oldest
      oldest_count="$2"
      shift 2
      [[ "$oldest_count" =~ ^[1-9][0-9]*$ ]] || usage
      ;;
    --unproved)
      [[ -z "$selection_mode" && $# -ge 2 ]] || usage
      selection_mode=unproved
      unproved_count="$2"
      shift 2
      [[ "$unproved_count" =~ ^[1-9][0-9]*$ ]] || usage
      ;;
    --backup-id)
      [[ "$selection_mode" != oldest && "$selection_mode" != unproved && $# -ge 2 ]] || usage
      selection_mode=ids
      backup_id="$2"
      shift 2
      [[ "$backup_id" =~ ^[a-f0-9-]{36}$ ]] || usage
      [[ -z "${requested_seen[$backup_id]+present}" ]] || usage
      requested_seen[$backup_id]=1
      requested_ids+=("$backup_id")
      ;;
    --help|-h)
      usage
      ;;
    *)
      usage
      ;;
  esac
done
[[ -n "$selection_mode" ]] || usage
[[ "$selection_mode" == oldest || "$selection_mode" == unproved ||
   ${#requested_ids[@]} -gt 0 ]] || usage

test_mode="${TELEMETRY_TEST_MODE:-false}"
if [[ "$test_mode" != true ]]; then
  [[ $EUID -eq 0 ]] || fail 'ash-atlas-backup-prove must run as root'
  [[ -r /etc/ash-atlas/telemetry-home.env ]] ||
    fail 'telemetry-home environment is absent: /etc/ash-atlas/telemetry-home.env'
  # shellcheck disable=SC1091
  source /etc/ash-atlas/telemetry-home.env
fi

: "${TELEMETRY_HOME_STORAGE_ROOT:?internal storage root is required}"
: "${TELEMETRY_HOME_STORAGE_MOUNT:?internal storage mount is required}"
: "${TELEMETRY_HOME_STORAGE_UUID:?internal storage UUID is required}"
: "${TELEMETRY_HOME_STORAGE_SERIAL:?internal storage serial is required}"
: "${TELEMETRY_HOME_STORAGE_FSTYPE:?internal storage filesystem type is required}"
: "${TELEMETRY_SEAGATE_MOUNT:?Seagate mount is required}"
: "${TELEMETRY_SEAGATE_UUID:?Seagate UUID is required}"
: "${TELEMETRY_SEAGATE_SERIAL:?Seagate serial is required}"
: "${ASH_ATLAS_DATABASE_BACKUP_REMOTE_DIRECTORY:?database backup root is required}"
: "${TELEMETRY_PORTABLE_BACKUP_ROOT:=$TELEMETRY_SEAGATE_MOUNT/ash-atlas-backup-archive}"
: "${TELEMETRY_PORTABLE_BACKUP_CAP_BYTES:=0}"
: "${TELEMETRY_PORTABLE_BACKUP_MINIMUM_FREE_BYTES:=10737418240}"
: "${TELEMETRY_VPS_HOST:?VPS host is required}"
: "${TELEMETRY_VPS_USER:=ash-telemetry-pull}"
: "${TELEMETRY_SSH_KEY:?dedicated SSH key path is required}"
: "${TELEMETRY_KNOWN_HOSTS:?pinned known_hosts path is required}"

for command in awk chmod cmp cp date dirname find findmnt flock install jq mktemp pg_restore \
  readlink realpath rm sha256sum sort ssh stat sync; do
  command -v "$command" >/dev/null || {
    echo "required command is missing: $command" >&2
    exit 1
  }
done

common="${ASH_ATLAS_BACKUP_COMMON:-/usr/local/lib/ash-atlas/backup-common.sh}"
[[ -r "$common" ]] || fail "backup common library is missing: $common"
# shellcheck source=ash-atlas-backup-common.sh
source "$common"

pull_lock="${TELEMETRY_HOME_PULL_LOCK:-/run/lock/ash-atlas-telemetry-home-pull.lock}"
mirror_lock="${ASH_ATLAS_BACKUP_MIRROR_LOCK:-/run/lock/ash-atlas-backup-mirror.lock}"
scrub_lock="${ASH_ATLAS_BACKUP_SCRUB_LOCK:-/run/lock/ash-atlas-backup-scrub.lock}"
if [[ -v TELEMETRY_BACKUP_MIGRATION_LOCK ]]; then
  migration_lock="$TELEMETRY_BACKUP_MIGRATION_LOCK"
elif [[ "${TELEMETRY_TEST_MODE:-false}" == true ]]; then
  migration_lock="${pull_lock}.migration"
else
  migration_lock=/run/lock/ash-atlas-backup-migration.lock
fi
for lock in "$pull_lock" "$mirror_lock" "$scrub_lock" "$migration_lock"; do
  if [[ "${TELEMETRY_TEST_MODE:-false}" == true ]]; then
    [[ "$lock" == /tmp/ash-atlas-database-backup-test.*/* ]] || exit 2
  else
    [[ "$lock" == /run/lock/* ]] || exit 2
  fi
done
exec 9>"$pull_lock"
flock -n 9 || exit 0
exec 8>"$mirror_lock"
flock -n 8 || exit 0
exec 7>"$scrub_lock"
flock -n 7 || exit 0
exec 6>"$migration_lock"
flock -n 6 || exit 0

ash_backup_validate_storage \
  "$TELEMETRY_HOME_STORAGE_ROOT" "$TELEMETRY_HOME_STORAGE_MOUNT" \
  "$TELEMETRY_HOME_STORAGE_UUID" "$TELEMETRY_HOME_STORAGE_SERIAL" \
  "$TELEMETRY_HOME_STORAGE_FSTYPE" "internal backup intake"
ash_backup_validate_storage \
  "$TELEMETRY_SEAGATE_MOUNT" "$TELEMETRY_SEAGATE_MOUNT" \
  "$TELEMETRY_SEAGATE_UUID" "$TELEMETRY_SEAGATE_SERIAL" \
  "${TELEMETRY_SEAGATE_FSTYPE:-ntfs3}" \
  "Seagate mirror"
ash_backup_require_portable_root "$TELEMETRY_PORTABLE_BACKUP_ROOT" \
  "$TELEMETRY_SEAGATE_MOUNT" || fail 'portable backup archive is outside the Seagate mount'
[[ -d "$TELEMETRY_PORTABLE_BACKUP_ROOT" && ! -L "$TELEMETRY_PORTABLE_BACKUP_ROOT" ]] ||
  fail 'portable backup archive is absent or unsafe'

database_root="$ASH_ATLAS_DATABASE_BACKUP_REMOTE_DIRECTORY"
ash_backup_require_child "$TELEMETRY_HOME_STORAGE_ROOT" "$database_root" || \
  fail 'database backup root is outside internal storage'
[[ -d "$database_root" && ! -L "$database_root" &&
   "$(realpath -e -- "$database_root")" == "$database_root" ]] ||
  fail 'database backup root is absent or unsafe'

archive_owner="${TELEMETRY_ARCHIVE_OWNER:-root:root}"
[[ "$archive_owner" =~ ^[A-Za-z_][A-Za-z0-9_.-]*:[A-Za-z_][A-Za-z0-9_.-]*$ ]] ||
  fail 'archive owner is invalid'
[[ "$(stat -c '%U:%G' "$database_root")" == "$archive_owner" ]] ||
  fail 'database backup root ownership mismatch'
database_mode="$(stat -c '%a' "$database_root")"
(( (8#$database_mode & 8#022) == 0 )) ||
  fail 'database backup root is group/world writable'

database_receipt_root="$database_root/receipts"
[[ -d "$database_receipt_root" && ! -L "$database_receipt_root" &&
   "$(realpath -e -- "$database_receipt_root")" == "$database_receipt_root" ]] ||
  fail 'database receipt root is absent or unsafe'

relative_database_root="${database_root#"$TELEMETRY_HOME_STORAGE_ROOT/"}"
[[ "$relative_database_root" != "$database_root" &&
   "$relative_database_root" != *'..'* && "$relative_database_root" != /* ]] ||
  fail 'database backup relative path is invalid'
seagate_database_root="$TELEMETRY_SEAGATE_MOUNT/$relative_database_root"
ash_backup_require_child "$TELEMETRY_SEAGATE_MOUNT" "$seagate_database_root" ||
  fail 'Seagate database root is outside the mirror'
[[ -d "$seagate_database_root" && ! -L "$seagate_database_root" &&
   "$(realpath -e -- "$seagate_database_root")" == "$seagate_database_root" ]] ||
  fail 'Seagate database root is absent or unsafe'
portable_database_root="$TELEMETRY_PORTABLE_BACKUP_ROOT/postgresql"
[[ -d "$portable_database_root" && ! -L "$portable_database_root" &&
   "$(realpath -e -- "$portable_database_root")" == "$portable_database_root" ]] ||
  fail 'portable PostgreSQL archive root is absent or unsafe'
proof_evidence_root="$TELEMETRY_HOME_STORAGE_ROOT/.ash-atlas-seagate-proof-evidence"
install -d -m 0700 "$proof_evidence_root" || fail 'proof evidence root is unavailable'

ssh_options=(
  -T -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes
  -o "UserKnownHostsFile=${TELEMETRY_KNOWN_HOSTS}"
  -o "IdentityFile=${TELEMETRY_SSH_KEY}"
  -o ClearAllForwardings=yes -o ConnectTimeout=15
)
ssh_destination="${TELEMETRY_VPS_USER}@${TELEMETRY_VPS_HOST}"
ssh_control_dir="$(mktemp -d "$(dirname "$pull_lock")/ash-atlas-prove-ssh.XXXXXXXX")"
chmod 0700 "$ssh_control_dir"
ssh_options+=(
  -o ControlMaster=auto -o ControlPersist=60
  -o "ControlPath=${ssh_control_dir}/control"
)
cleanup() {
  ssh "${ssh_options[@]}" -O exit "$ssh_destination" >/dev/null 2>&1 || true
  rm -rf -- "$ssh_control_dir"
}
trap cleanup EXIT
remote() {
  # The argument is a complete, validated forced-command protocol request.
  # shellcheck disable=SC2029
  if [[ "$1" == database-seagate-ack\ * ]]; then
    ssh "${ssh_options[@]}" "$ssh_destination" "$1"
  else
    ssh -n "${ssh_options[@]}" "$ssh_destination" "$1"
  fi
}

work="$(mktemp -d "$(dirname "$pull_lock")/ash-atlas-prove.XXXXXXXX")"
trap 'rm -rf -- "${work:-}"; cleanup' EXIT
mkdir -p "$work/manifests"

safe_name() {
  [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,239}$ ]]
}

manifest_is_valid() {
  local path="$1" name="$2"
  jq -e --arg name "$name" '
    .manifestVersion == 1
    and .kind == "ash_atlas_postgresql_backup"
    and (.backupId | test("^[a-f0-9-]{36}$"))
    and (.backupClass | IN("hourly","daily","weekly","monthly","pre-migration","milestone"))
    and (.database | test("^[a-z][a-z0-9_]{0,62}$"))
    and (.releaseSha | test("^[a-f0-9]{40}$"))
    and (.createdAtUtc | fromdateiso8601)
    and (.artifact.fileName | test("^[A-Za-z0-9][A-Za-z0-9._-]{0,239}$"))
    and (.artifact.fileName + ".ready.json" == $name)
    and .artifact.format == "postgresql-custom"
    and (.artifact.bytes | type == "number" and . > 0)
    and (.artifact.sha256 | test("^[a-f0-9]{64}$"))
    and .acknowledgmentState == "pending"
  ' "$path" >/dev/null
}

retained_inventory_status() {
  local target="$1" inventory="$2" candidate
  : >"$inventory"
  remote database-retained-list >"$inventory" || return 2
  declare -A fresh_seen=()
  local found=1
  while IFS= read -r candidate; do
    [[ -n "$candidate" ]] || continue
    safe_name "$candidate" && [[ "$candidate" == *.dump.ready.json ]] || return 2
    [[ -z "${fresh_seen[$candidate]+present}" ]] || return 2
    fresh_seen[$candidate]=1
    [[ "$candidate" == "$target" ]] && found=0
  done <"$inventory"
  return "$found"
}

fetch_retained_manifest() {
  local manifest_name="$1" manifest_path="$2" attempt refresh_status
  for attempt in 1 2; do
    if remote "database-fetch $manifest_name" >"$manifest_path"; then
      return 0
    fi
    if retained_inventory_status "$manifest_name" \
      "$work/retained-refresh-$attempt.list"; then
      (( attempt == 2 )) && return 1
      continue
    else
      refresh_status=$?
      # A fresh canonical list that no longer contains this manifest means
      # retention won the race after the initial cohort snapshot. Defer it;
      # any retained item that cannot be fetched still fails closed.
      (( refresh_status == 1 )) && return 2
      return 1
    fi
  done
  return 1
}

validate_proof() {
  local proof_path="$1" backup_id="$2" source_ack_id="$3"
  local manifest_name expected_file expected_sha expected_bytes
  manifest_name="${manifest_name_by_id[$backup_id]}"
  expected_file="${file_by_id[$backup_id]}"
  expected_sha="${sha_by_id[$backup_id]}"
  expected_bytes="${bytes_by_id[$backup_id]}"
  jq -e \
    --arg id "$backup_id" --arg source "$source_ack_id" \
    --arg manifest "$manifest_name" --arg file "$expected_file" \
    --arg sha "$expected_sha" --arg seagate "$TELEMETRY_SEAGATE_UUID" \
    --argjson bytes "$expected_bytes" '
      .seagateAcknowledgmentVersion == 1
      and .event == "ash_atlas_postgresql_backup_seagate_verified"
      and .backupId == $id
      and .manifestFileName == $manifest
      and .backupFileName == $file
      and .bytes == $bytes
      and .sha256 == $sha
      and .sourceAcknowledgmentId == $source
      and .seagateUuid == $seagate
      and .verification == "sha256-deep"
      and .restoreCatalogVerified == true
      and (.seagateVerifiedAtUtc | fromdateiso8601)
    ' "$proof_path" >/dev/null
}

persist_proof_evidence() {
  local backup_id="$1" file_name="$2" source_ack_id="$3" portable_path="$4"
  local expected_sha="$5" expected_bytes="$6" receipt="$7" proof_path="$8"
  local proof_template="${9:-}" evidence_path evidence_tmp receipt_sha template_sha
  [[ -f "$proof_path" && ! -L "$proof_path" ]] || return 1
  receipt_sha="$(sha256sum "$receipt" | awk '{print $1}')" || return 1
  template_sha='null'
  if [[ -n "$proof_template" && -f "$proof_template" && ! -L "$proof_template" ]]; then
    template_sha="$(sha256sum "$proof_template" | awk '{print "\"" $1 "\""}')" || return 1
  fi
  evidence_path="$proof_evidence_root/backup-$backup_id.accepted.json"
  evidence_tmp="$(mktemp "$proof_evidence_root/.backup-$backup_id.accepted.XXXXXXXX")" || return 1
  if ! jq -cn --arg id "$backup_id" --arg file "$file_name" \
    --arg sourceAck "$source_ack_id" --arg path "$portable_path" \
    --arg sha "$expected_sha" --arg receiptSha "$receipt_sha" \
    --argjson bytes "$expected_bytes" --argjson templateSha "$template_sha" \
    --slurpfile proof "$proof_path" \
    '{proofEvidenceVersion:1,backupId:$id,backupFileName:$file,
      sourceAcknowledgmentId:$sourceAck,portablePath:$path,sha256:$sha,
      bytes:$bytes,sourceReceiptSha256:$receiptSha,
      requestTemplateSha256:$templateSha,acceptedProof:$proof[0]}' >"$evidence_tmp"; then
    rm -f -- "$evidence_tmp"
    return 1
  fi
  chmod 0600 "$evidence_tmp" || { rm -f -- "$evidence_tmp"; return 1; }
  sync -f "$evidence_tmp" || { rm -f -- "$evidence_tmp"; return 1; }
  mv -- "$evidence_tmp" "$evidence_path" || { rm -f -- "$evidence_tmp"; return 1; }
  sync -f "$proof_evidence_root" || return 1
}

# Capture the exact retained cohort before any manifest or proof work. Pull and
# mirror are locked for this whole invocation, so an arrival after this point
# cannot be mistaken for a missing local artifact; it is deferred to a later
# invocation.
retained_inventory="$work/retained.list"
remote database-retained-list >"$retained_inventory" ||
  fail 'VPS retained PostgreSQL manifest inventory failed'
retained_order=()
declare -A retained_seen=()
while IFS= read -r manifest_name; do
  [[ -n "$manifest_name" ]] || continue
  safe_name "$manifest_name" && [[ "$manifest_name" == *.dump.ready.json ]] ||
    fail 'VPS retained PostgreSQL manifest inventory is invalid'
  [[ -z "${retained_seen[$manifest_name]+present}" ]] ||
    fail "VPS retained PostgreSQL manifest inventory is duplicated: $manifest_name"
  retained_seen[$manifest_name]=1
  retained_order+=("$manifest_name")
done <"$retained_inventory"

declare -A manifest_by_id=()
declare -A manifest_name_by_id=()
declare -A class_by_id=()
declare -A created_by_id=()
declare -A file_by_id=()
declare -A bytes_by_id=()
declare -A sha_by_id=()
declare -A proof_by_id=()
deferred_manifests=()

for manifest_name in "${retained_order[@]}"; do
  manifest_path="$work/manifests/$manifest_name"
  if fetch_retained_manifest "$manifest_name" "$manifest_path"; then
    :
  else
    fetch_status=$?
    if (( fetch_status == 2 )); then
      deferred_manifests+=("$manifest_name")
      printf 'manifest=%s result=deferred reason=no-longer-retained\n' \
        "$manifest_name"
      continue
    fi
    fail "PostgreSQL manifest transfer failed: $manifest_name"
  fi
  manifest_is_valid "$manifest_path" "$manifest_name" ||
    fail "PostgreSQL manifest is malformed: $manifest_name"

  backup_id="$(jq -er '.backupId' "$manifest_path")" ||
    fail "PostgreSQL manifest has no backup ID: $manifest_name"
  [[ -z "${manifest_by_id[$backup_id]+present}" ]] ||
    fail "VPS retained cohort contains duplicate backup ID: $backup_id"
  file_name="$(jq -er '.artifact.fileName' "$manifest_path")"
  backup_class="$(jq -er '.backupClass' "$manifest_path")"
  created_at="$(jq -er '.createdAtUtc' "$manifest_path")"
  bytes="$(jq -er '.artifact.bytes' "$manifest_path")"
  sha256="$(jq -er '.artifact.sha256' "$manifest_path")"
  manifest_by_id[$backup_id]="$manifest_path"
  manifest_name_by_id[$backup_id]="$manifest_name"
  class_by_id[$backup_id]="$backup_class"
  created_by_id[$backup_id]="$created_at"
  file_by_id[$backup_id]="$file_name"
  bytes_by_id[$backup_id]="$bytes"
  sha_by_id[$backup_id]="$sha256"

  proof_path="$work/proof-$backup_id.json"
  : >"$proof_path"
  remote "database-seagate-status $manifest_name" >"$proof_path" ||
    fail "VPS Seagate proof status failed: $manifest_name"
  if [[ -s "$proof_path" ]]; then
    # The source receipt ID is checked again against the local canonical
    # receipt below. This first validation rejects any proof that does not
    # match the immutable VPS manifest before it can affect selection.
    source_ack_id="$(jq -er '.sourceAcknowledgmentId' "$proof_path")" ||
      fail "VPS Seagate proof is malformed: $manifest_name"
    jq -e --arg id "$backup_id" \
      '.sourceAcknowledgmentId | type == "string" and test("^[a-f0-9-]{36}$")' \
      "$proof_path" >/dev/null || fail "VPS Seagate proof source ID is invalid: $manifest_name"
    validate_proof "$proof_path" "$backup_id" "$source_ack_id" ||
      fail "VPS Seagate proof mismatches manifest: $manifest_name"
    proof_by_id[$backup_id]="$proof_path"
  fi
done

selected_ids=()
if [[ "$selection_mode" == ids ]]; then
  for backup_id in "${requested_ids[@]}"; do
    [[ -n "${manifest_by_id[$backup_id]+present}" ]] ||
      fail "requested backup is not in the captured retained cohort: $backup_id"
    selected_ids+=("$backup_id")
  done
elif [[ "$selection_mode" == unproved ]]; then
  : "${unproved_count:?}"
  ordered_unproved_rows=()
  for backup_id in "${!manifest_by_id[@]}"; do
    [[ -z "${proof_by_id[$backup_id]:-}" ]] || continue
    candidate_receipt="$database_receipt_root/${file_by_id[$backup_id]}.receipt.json"
    [[ -f "$candidate_receipt" && ! -L "$candidate_receipt" ]] || continue
    ASH_ATLAS_BACKUP_VERIFICATION_MANIFEST="${manifest_by_id[$backup_id]}" \
      ash_backup_resolve_portable_database_path "$candidate_receipt" "$database_root" \
      "$TELEMETRY_HOME_STORAGE_ROOT" "$TELEMETRY_SEAGATE_MOUNT" "$backup_id" \
      "${file_by_id[$backup_id]}" "${bytes_by_id[$backup_id]}" "${sha_by_id[$backup_id]}" >/dev/null || continue
    ordered_unproved_rows+=("${created_by_id[$backup_id]}"$'\t'"$backup_id")
  done
  sorted_unproved="$work/unproved.tsv"
  if ((${#ordered_unproved_rows[@]} > 0)); then
    printf '%s\n' "${ordered_unproved_rows[@]}" |
      LC_ALL=C sort -t $'\t' -k1,1 -k2,2 >"$sorted_unproved"
    while IFS=$'\t' read -r created_at backup_id; do
      [[ -n "$backup_id" ]] || continue
      selected_ids+=("$backup_id")
      ((${#selected_ids[@]} >= unproved_count)) && break
    done <"$sorted_unproved"
  fi
else
  : "${oldest_count:?}"
  health="$work/health.json"
  remote database-health >"$health" || fail 'VPS PostgreSQL health query failed'
  jq -e '
    .version == 1
    and (.retentionLimits.hourly | type == "number" and . >= 0)
    and (.retentionLimits.daily | type == "number" and . >= 0)
    and (.retentionLimits.weekly | type == "number" and . >= 0)
    and (.retentionLimits.monthly | type == "number" and . >= 0)
    and (.retentionLimits.preMigration | type == "number" and . >= 0)
  ' "$health" >/dev/null || fail 'VPS PostgreSQL health lacks retention limits'
  hourly_keep="$(jq -er '.retentionLimits.hourly' "$health")"
  daily_keep="$(jq -er '.retentionLimits.daily' "$health")"
  weekly_keep="$(jq -er '.retentionLimits.weekly' "$health")"
  monthly_keep="$(jq -er '.retentionLimits.monthly' "$health")"
  pre_migration_keep="$(jq -er '.retentionLimits.preMigration' "$health")"

  ordered_rows=()
  for backup_id in "${!manifest_by_id[@]}"; do
    ordered_rows+=("${class_by_id[$backup_id]}"$'\t'"${created_by_id[$backup_id]}"$'\t'"$backup_id")
  done
  sorted_rows="$work/sorted.tsv"
  printf '%s\n' "${ordered_rows[@]}" |
    LC_ALL=C sort -t $'\t' -k1,1 -k2,2r -k3,3 >"$sorted_rows"
  declare -A class_seen=( [hourly]=0 [daily]=0 [weekly]=0 [monthly]=0 [pre-migration]=0 )
  candidate_rows=()
  while IFS=$'\t' read -r backup_class created_at backup_id; do
    [[ -n "$backup_id" ]] || continue
    [[ "$backup_class" == milestone ]] && continue
    case "$backup_class" in
      hourly) retention_limit="$hourly_keep" ;;
      daily) retention_limit="$daily_keep" ;;
      weekly) retention_limit="$weekly_keep" ;;
      monthly) retention_limit="$monthly_keep" ;;
      pre-migration) retention_limit="$pre_migration_keep" ;;
      *) fail "unsupported backup class in retained cohort: $backup_class" ;;
    esac
    class_seen[$backup_class]=$((class_seen[$backup_class] + 1))
    (( class_seen[$backup_class] > retention_limit )) || continue
    [[ -z "${proof_by_id[$backup_id]:-}" ]] || continue
    candidate_rows+=("$created_at"$'\t'"$backup_id")
  done <"$sorted_rows"
  sorted_candidates="$work/candidates.tsv"
  if ((${#candidate_rows[@]} > 0)); then
    printf '%s\n' "${candidate_rows[@]}" |
      LC_ALL=C sort -t $'\t' -k1,1 -k2,2 >"$sorted_candidates"
    while IFS=$'\t' read -r created_at backup_id; do
      [[ -n "$backup_id" ]] || continue
      selected_ids+=("$backup_id")
      ((${#selected_ids[@]} >= oldest_count)) && break
    done <"$sorted_candidates"
  fi
fi

selected_count=${#selected_ids[@]}
if (( selected_count == 0 )); then
  printf 'No unproved selected PostgreSQL backups; cohort=%s deferred=%s\n' \
    "${#retained_order[@]}" "${#deferred_manifests[@]}"
  exit 0
fi

proved_count=0
skipped_count=0
bytes_read=0
for backup_id in "${selected_ids[@]}"; do
  manifest_path="${manifest_by_id[$backup_id]}"
  manifest_name="${manifest_name_by_id[$backup_id]}"
  file_name="${file_by_id[$backup_id]}"
  expected_bytes="${bytes_by_id[$backup_id]}"
  expected_sha="${sha_by_id[$backup_id]}"
  backup_class="${class_by_id[$backup_id]}"
  created_at="${created_by_id[$backup_id]}"
  database="$(jq -er '.database' "$manifest_path")"
  release_sha="$(jq -er '.releaseSha' "$manifest_path")"
  receipt="$database_receipt_root/$file_name.receipt.json"

  [[ -f "$receipt" && ! -L "$receipt" &&
     "$(realpath -e -- "$receipt")" == "$receipt" ]] ||
    fail "canonical local PostgreSQL receipt is absent or unsafe: $backup_id"

  source_ack_id="$(jq -er '.acknowledgmentId' "$receipt")" ||
    fail "canonical local PostgreSQL receipt is malformed: $backup_id"
  export ASH_ATLAS_BACKUP_VERIFICATION_MANIFEST="$manifest_path"
  portable_path="$(ash_backup_resolve_portable_database_path \
    "$receipt" "$database_root" "$TELEMETRY_HOME_STORAGE_ROOT" \
    "$TELEMETRY_SEAGATE_MOUNT" "$backup_id" "$file_name" \
    "$expected_bytes" "$expected_sha" || true)"
  [[ -n "$portable_path" ]] ||
    fail "canonical local PostgreSQL receipt has no verified portable mapping: $backup_id"
  legacy_remote_path="$(jq -er '.remotePath // empty' "$receipt" 2>/dev/null || true)"
  if [[ "$legacy_remote_path" == "$TELEMETRY_HOME_STORAGE_ROOT/"* ]]; then
    ash_backup_record_portable_mapping \
      "$receipt" "$database_root" "$TELEMETRY_HOME_STORAGE_ROOT" \
      "$TELEMETRY_SEAGATE_MOUNT" "$backup_id" "$file_name" \
      "$expected_bytes" "$expected_sha" "$portable_path" ||
      fail "legacy portable mapping could not be persisted: $backup_id"
  fi
  jq -e \
    --arg id "$backup_id" --arg source "$source_ack_id" \
    --arg manifest "$manifest_name" --arg class "$backup_class" \
    --arg database "$database" --arg release "$release_sha" \
    --arg created "$created_at" --arg file "$file_name" \
    --arg portable "$portable_path" --arg sha "$expected_sha" \
    --argjson bytes "$expected_bytes" '
      .acknowledgmentVersion == 1
      and .event == "ash_atlas_postgresql_backup_verified"
      and .acknowledgmentId == $source
      and (.acknowledgmentId | test("^[a-f0-9-]{36}$"))
      and .backupId == $id
      and .backupClass == $class
       and .manifestFileName == $manifest
       and .backupFileName == $file
       and (.remotePath | endswith("/" + $file))
      and .sha256 == $sha
      and .bytes == $bytes
      and .database == $database
      and .releaseSha == $release
      and .createdAtUtc == $created
      and (.remoteVerifiedAtUtc | fromdateiso8601)
      and .restoreCatalogVerified == true
    ' "$receipt" >/dev/null || fail "canonical local PostgreSQL receipt mismatches manifest: $backup_id"

  portable_receipt="$portable_database_root/backup-$backup_id/portable-receipt.json"
  canonical_dump="$portable_database_root/backup-$backup_id/$file_name"
  if [[ "$portable_path" == "$canonical_dump" ]]; then
    [[ -f "$canonical_dump" && ! -L "$canonical_dump" &&
       "$(realpath -e -- "$canonical_dump")" == "$canonical_dump" ]] ||
      fail "canonical portable PostgreSQL dump is absent or unsafe: $backup_id"
    [[ -f "$portable_receipt" && ! -L "$portable_receipt" ]] ||
      fail "portable PostgreSQL receipt is absent or unsafe: $backup_id"
    ash_backup_validate_immutable_receipt "$portable_receipt" "$backup_id" \
      "$file_name" "$expected_bytes" "$expected_sha" ||
      fail "portable PostgreSQL receipt mismatches manifest: $backup_id"
  else
    # Initial cutover adopts an already verified flat Seagate copy without
    # duplicating the cohort into a second namespace.  Its placement is HOME
    # metadata; the VPS proof remains the deployed legacy-minimal shape.
    :
  fi
  seagate_dump="$portable_path"
  [[ "$(stat -c '%s' "$seagate_dump")" == "$expected_bytes" ]] ||
    fail "canonical portable PostgreSQL dump size differs from manifest: $backup_id"

  proof_path="${proof_by_id[$backup_id]:-}"
  if [[ -n "$proof_path" ]]; then
    validate_proof "$proof_path" "$backup_id" "$source_ack_id" ||
      fail "accepted VPS Seagate proof mismatches canonical receipt: $backup_id"
    persist_proof_evidence "$backup_id" "$file_name" "$source_ack_id" \
      "$portable_path" "$expected_sha" "$expected_bytes" "$receipt" \
      "$proof_path" "$proof_evidence_root/backup-$backup_id.request.json" ||
      fail "accepted VPS proof evidence could not be persisted: $backup_id"
    printf 'backupId=%s result=skipped bytesRead=0 manifest=%s\n' \
      "$backup_id" "$manifest_name"
    ((skipped_count += 1))
    continue
  fi

  verification_portable_receipt=''
  [[ "$portable_path" != "$canonical_dump" ]] || verification_portable_receipt="$portable_receipt"
  verification_record="$(ash_backup_verify_copy fast postgresql "$backup_id" "$portable_path" \
    "$expected_bytes" "$expected_sha" "$manifest_path" "$receipt" "$verification_portable_receipt")" ||
    fail "portable copy needs bounded verification: $backup_id"
  verified_at="$(jq -er '.verifiedAtUtc' <<<"$verification_record")"
  jq -e --arg verified "$verified_at" '
    (.remoteVerifiedAtUtc | fromdateiso8601) <= ($verified | fromdateiso8601)
  ' "$receipt" >/dev/null || fail 'physical-copy verification predates source verification'
  proof_payload="$work/$backup_id.proof.json"
  jq -cn \
    --arg sourceAcknowledgmentId "$source_ack_id" \
    --arg backupId "$backup_id" --arg backupClass "$backup_class" \
    --arg manifestFileName "$manifest_name" --arg backupFileName "$file_name" \
    --arg sha256 "$expected_sha" --arg seagateUuid "$TELEMETRY_SEAGATE_UUID" \
    --arg seagateVerifiedAtUtc "$verified_at" --argjson bytes "$expected_bytes" '
      {
        seagateAcknowledgmentVersion:1,
        event:"ash_atlas_postgresql_backup_seagate_verified",
        sourceAcknowledgmentId:$sourceAcknowledgmentId,
        backupId:$backupId,
        backupClass:$backupClass,
        manifestFileName:$manifestFileName,
        backupFileName:$backupFileName,
        bytes:$bytes,
        sha256:$sha256,
        seagateUuid:$seagateUuid,
        seagateVerifiedAtUtc:$seagateVerifiedAtUtc,
        verification:"sha256-deep",
        restoreCatalogVerified:true
      }
    ' >"$proof_payload" || fail "Seagate proof request construction failed: $backup_id"
  proof_template="$proof_evidence_root/backup-$backup_id.request.json"
  if [[ -e "$proof_template" || -L "$proof_template" ]]; then
    [[ -f "$proof_template" && ! -L "$proof_template" ]] ||
      fail "Seagate proof request template is unsafe: $backup_id"
    cmp -s \
      <(jq -S 'del(.seagateVerifiedAtUtc)' "$proof_payload") \
      <(jq -S 'del(.seagateVerifiedAtUtc)' "$proof_template") ||
      fail "Seagate proof request template conflicts with prior identity: $backup_id"
  else
    proof_template_tmp="$(mktemp "$proof_evidence_root/.backup-$backup_id.request.XXXXXXXX")" ||
      fail "Seagate proof request template cannot be staged: $backup_id"
    cp -- "$proof_payload" "$proof_template_tmp" || {
      rm -f -- "$proof_template_tmp"
      fail "Seagate proof request template copy failed: $backup_id"
    }
    chmod 0600 "$proof_template_tmp" || { rm -f -- "$proof_template_tmp"; fail 'proof template permissions failed'; }
    sync -f "$proof_template_tmp" || { rm -f -- "$proof_template_tmp"; fail 'proof template flush failed'; }
    mv -- "$proof_template_tmp" "$proof_template" || { rm -f -- "$proof_template_tmp"; fail 'proof template publication failed'; }
    sync -f "$proof_evidence_root" || fail 'proof template directory flush failed'
  fi
  request_payload="$work/$backup_id.request.json"
  jq --arg verifiedAtUtc "$verified_at" \
    '.seagateVerifiedAtUtc=$verifiedAtUtc' "$proof_template" >"$request_payload" ||
    fail "Seagate proof request replay construction failed: $backup_id"
  remote "database-seagate-ack $manifest_name" <"$request_payload" ||
    fail "VPS Seagate proof acknowledgment failed: $backup_id"
  proof_path="$work/$backup_id.accepted.json"
  : >"$proof_path"
  remote "database-seagate-status $manifest_name" >"$proof_path" ||
    fail "VPS Seagate proof status failed after acknowledgment: $backup_id"
  [[ -s "$proof_path" ]] || fail "VPS did not accept Seagate proof: $backup_id"
  validate_proof "$proof_path" "$backup_id" "$source_ack_id" ||
    fail "VPS accepted Seagate proof does not match backup: $backup_id"
  persist_proof_evidence "$backup_id" "$file_name" "$source_ack_id" \
    "$portable_path" "$expected_sha" "$expected_bytes" "$receipt" \
    "$proof_path" "$proof_template" ||
    fail "Seagate proof evidence could not be persisted: $backup_id"
  ((proved_count += 1))
  printf 'backupId=%s result=proved bytesRead=%s manifest=%s\n' \
    "$backup_id" "$expected_bytes" "$manifest_name"
done

printf 'PostgreSQL Seagate proof complete: selected=%s proved=%s skipped=%s bytesRead=%s cohort=%s deferred=%s\n' \
  "$selected_count" "$proved_count" "$skipped_count" "$bytes_read" "${#retained_order[@]}" \
  "${#deferred_manifests[@]}"
