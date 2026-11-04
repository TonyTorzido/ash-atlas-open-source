#!/usr/bin/env bash
set -euo pipefail
umask 077

export_root="${TELEMETRY_EXPORT_ROOT:-/var/lib/ash-atlas/telemetry-exports}"
ack_root="${TELEMETRY_ACK_ROOT:-/var/lib/ash-atlas/telemetry-acknowledgments}"
reset_root="${ASH_ATLAS_RESET_BACKUP_HANDOFF_ROOT:-/var/lib/ash-atlas/reset-backup-handoffs}"
reset_ack_root="${ASH_ATLAS_RESET_BACKUP_ACK_ROOT:-/var/lib/ash-atlas/reset-backup-acknowledgments}"
database_root="${ASH_ATLAS_DATABASE_BACKUP_READY_ROOT:-/mnt/ash-atlas-backups/postgresql/ready}"
database_ack_root="${ASH_ATLAS_DATABASE_BACKUP_ACK_ROOT:-/mnt/ash-atlas-backups/postgresql/acknowledgments}"
database_seagate_ack_root="${ASH_ATLAS_DATABASE_SEAGATE_ACK_ROOT:-/mnt/ash-atlas-backups/postgresql/seagate-acknowledgments}"
database_health_env="${ASH_ATLAS_DATABASE_HEALTH_ENV:-/etc/ash-atlas/database-health.env}"
[[ "$export_root" == "/var/lib/ash-atlas/telemetry-exports" ||
   (
     "${TELEMETRY_TEST_MODE:-false}" == "true"
     && "$export_root" == /tmp/ash-atlas-telemetry-test.*/*
   ) ]] || exit 126
[[ "$ack_root" == "/var/lib/ash-atlas/telemetry-acknowledgments" ||
   (
     "${TELEMETRY_TEST_MODE:-false}" == "true"
     && "$ack_root" == /tmp/ash-atlas-telemetry-test.*/*
   ) ]] || exit 126
[[ "$reset_root" == "/var/lib/ash-atlas/reset-backup-handoffs" ||
   (
     "${TELEMETRY_TEST_MODE:-false}" == "true"
     && "$reset_root" == /tmp/ash-atlas-reset-backup-test.*/*
   ) ]] || exit 126
[[ "$reset_ack_root" == "/var/lib/ash-atlas/reset-backup-acknowledgments" ||
   (
     "${TELEMETRY_TEST_MODE:-false}" == "true"
     && "$reset_ack_root" == /tmp/ash-atlas-reset-backup-test.*/*
   ) ]] || exit 126
[[ "$database_root" == "/mnt/ash-atlas-backups/postgresql/ready" ||
   (
     "${TELEMETRY_TEST_MODE:-false}" == "true"
     && "$database_root" == /tmp/ash-atlas-database-backup-test.*/*
   ) ]] || exit 126
[[ "$database_ack_root" == "/mnt/ash-atlas-backups/postgresql/acknowledgments" ||
   (
     "${TELEMETRY_TEST_MODE:-false}" == "true"
     && "$database_ack_root" == /tmp/ash-atlas-database-backup-test.*/*
   ) ]] || exit 126
[[ "$database_seagate_ack_root" == "/mnt/ash-atlas-backups/postgresql/seagate-acknowledgments" ||
   (
     "${TELEMETRY_TEST_MODE:-false}" == "true"
     && "$database_seagate_ack_root" == /tmp/ash-atlas-database-backup-test.*/*
   ) ]] || exit 126

deny() {
  echo "request denied" >&2
  exit 126
}

safe_name() {
  [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,239}$ ]]
}

safe_file() {
  local name="$1"
  safe_name "$name" || return 1
  local path="${export_root}/${name}"
  [[ -f "$path" && ! -L "$path" ]] || return 1
  [[ "$(readlink -f -- "$path")" == "${export_root}/${name}" ]]
}

manifest_allows_file() {
  local requested="$1"
  local manifest
  shopt -s nullglob
  for manifest in "$export_root"/*.ready.json; do
    [[ -f "$manifest" && ! -L "$manifest" ]] || continue
    if [[ "$(basename "$manifest")" == "$requested" ]] ||
       jq -e --arg name "$requested" \
         '.manifestVersion == 1
          and (.artifact.fileName == $name or .artifact.checksumFileName == $name)' \
         "$manifest" >/dev/null 2>&1; then
      return 0
    fi
  done
  return 1
}

list_ready() {
  local manifest segment_id
  shopt -s nullglob
  for manifest in "$export_root"/*.ready.json; do
    [[ -f "$manifest" && ! -L "$manifest" ]] || continue
    segment_id="$(jq -er \
      'select(.manifestVersion == 1) | .segmentId
       | select(test("^[0-9a-fA-F-]{36}$"))' "$manifest" 2>/dev/null)" || continue
    [[ ! -e "$ack_root/${segment_id}.ack.json" ]] || continue
    basename "$manifest"
  done | LC_ALL=C sort
}

fetch_file() {
  local name="$1"
  safe_file "$name" || deny
  manifest_allows_file "$name" || deny
  exec cat -- "${export_root}/${name}"
}

ack_manifest() {
  local manifest_name="$1"
  local supplied_sha="$2"
  local supplied_version="$3"
  safe_file "$manifest_name" || deny
  [[ "$manifest_name" == *.ready.json ]] || deny
  [[ "$supplied_sha" =~ ^[a-f0-9]{64}$ ]] || deny
  [[ "$supplied_version" == "1" ]] || deny

  local manifest_path="${export_root}/${manifest_name}"
  local segment_id run_id manifest_sha manifest_version artifact_name checksum_name artifact_bytes
  segment_id="$(jq -er '.segmentId' "$manifest_path")" || deny
  run_id="$(jq -er '.runId' "$manifest_path")" || deny
  manifest_sha="$(jq -er '.artifact.sha256' "$manifest_path")" || deny
  manifest_version="$(jq -er '.manifestVersion' "$manifest_path")" || deny
  artifact_name="$(jq -er '.artifact.fileName' "$manifest_path")" || deny
  checksum_name="$(jq -er '.artifact.checksumFileName' "$manifest_path")" || deny
  artifact_bytes="$(jq -er '.artifact.bytes' "$manifest_path")" || deny
  [[ "$segment_id" =~ ^[0-9a-fA-F-]{36}$ ]] || deny
  [[ "$run_id" =~ ^[0-9a-fA-F-]{36}$ ]] || deny
  [[ "$manifest_sha" == "$supplied_sha" ]] || deny
  [[ "$manifest_version" == "$supplied_version" ]] || deny
  safe_file "$artifact_name" || deny
  safe_file "$checksum_name" || deny
  [[ "$artifact_bytes" =~ ^[0-9]+$ ]] || deny
  [[ "$(stat -c '%s' "${export_root}/${artifact_name}")" == "$artifact_bytes" ]] || deny
  [[ "$(awk 'NR==1 {print $1}' "${export_root}/${checksum_name}")" == "$manifest_sha" ]] || deny

  [[ -d "$ack_root" && ! -L "$ack_root" && -w "$ack_root" ]] || deny
  local final="${ack_root}/${segment_id}.ack.json"
  if [[ -f "$final" && ! -L "$final" ]]; then
    jq -e --arg run "$run_id" --arg sha "$supplied_sha" \
      '.runId == $run and .artifactSha256 == $sha and .manifestVersion == 1' \
      "$final" >/dev/null || deny
    exit 0
  fi
  local partial
  partial="$(mktemp "${ack_root}/.${segment_id}.ack.XXXXXX")"
  trap 'rm -f -- "${partial:-}"' EXIT
  jq -cn \
    --arg segmentId "$segment_id" \
    --arg runId "$run_id" \
    --arg artifactSha256 "$supplied_sha" \
    --arg acknowledgedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{manifestVersion:1,segmentId:$segmentId,runId:$runId,
      artifactSha256:$artifactSha256,acknowledgedAt:$acknowledgedAt}' \
    >"$partial"
  chmod 0640 "$partial"
  ln "$partial" "$final" 2>/dev/null || {
    [[ -f "$final" ]] || deny
  }
  rm -f -- "$partial"
  trap - EXIT
}

reset_manifest_path() {
  local name="$1"
  safe_name "$name" || return 1
  [[ "$name" == *.dump.ready.json ]] || return 1
  local matches=()
  mapfile -t matches < <(find "$reset_root" -mindepth 2 -maxdepth 2 \
    -type f -name "$name" -print 2>/dev/null)
  [[ ${#matches[@]} -eq 1 ]] || return 1
  local path="${matches[0]}"
  [[ ! -L "$path" ]] || return 1
  [[ "$(readlink -f -- "$path")" == "$reset_root"/*/"$name" ]] || return 1
  printf '%s\n' "$path"
}

reset_manifest_allows_file() {
  local requested="$1"
  safe_name "$requested" || return 1
  local manifest manifest_path
  while IFS= read -r manifest_path; do
    [[ -n "$manifest_path" ]] || continue
    manifest="$(basename "$manifest_path")"
    if [[ "$manifest" == "$requested" ]] ||
       jq -e --arg name "$requested" \
         '.manifestVersion == 1
          and .kind == "ash_atlas_gameplay_reset_backup"
          and .artifact.fileName == $name' \
         "$manifest_path" >/dev/null 2>&1; then
      printf '%s\n' "$manifest_path"
      return 0
    fi
  done < <(find "$reset_root" -mindepth 2 -maxdepth 2 \
    -type f -name '*.dump.ready.json' -print 2>/dev/null)
  return 1
}

list_reset_ready() {
  local manifest operation
  while IFS= read -r manifest; do
    [[ -f "$manifest" && ! -L "$manifest" ]] || continue
    operation="$(jq -er \
      'select(.manifestVersion == 1)
       | select(.kind == "ash_atlas_gameplay_reset_backup")
       | .operationId
       | select(test("^[a-f0-9-]{36}$"))' "$manifest" 2>/dev/null)" || continue
    [[ ! -e "$reset_ack_root/${operation}.ack.json" ]] || continue
    basename "$manifest"
  done < <(find "$reset_root" -mindepth 2 -maxdepth 2 \
    -type f -name '*.dump.ready.json' -print 2>/dev/null)
}

fetch_reset_file() {
  local name="$1"
  safe_name "$name" || deny
  local manifest_path
  manifest_path="$(reset_manifest_allows_file "$name")" || deny
  local path
  if [[ "$(basename "$manifest_path")" == "$name" ]]; then
    path="$manifest_path"
  else
    path="$(dirname "$manifest_path")/$name"
  fi
  [[ -f "$path" && ! -L "$path" ]] || deny
  [[ "$(readlink -f -- "$path")" == "$(dirname "$manifest_path")/$name" ]] || deny
  exec cat -- "$path"
}

ack_reset_backup() {
  local manifest_name="$1"
  local manifest_path
  manifest_path="$(reset_manifest_path "$manifest_name")" || deny
  [[ -d "$reset_ack_root" && ! -L "$reset_ack_root" && -w "$reset_ack_root" ]] || deny
  local operation final partial
  operation="$(jq -er '.operationId' "$manifest_path")" || deny
  [[ "$operation" =~ ^[a-f0-9-]{36}$ ]] || deny
  final="${reset_ack_root}/${operation}.ack.json"
  partial="$(mktemp "${reset_ack_root}/.${operation}.ack.XXXXXX")"
  trap 'rm -f -- "${partial:-}"' EXIT
  cat >"$partial"
  [[ "$(stat -c '%s' "$partial")" -le 16384 ]] || deny
  jq -e \
    --arg manifestName "$manifest_name" \
    --slurpfile source "$manifest_path" '
      ($source[0]) as $sourceManifest
      | .acknowledgmentVersion == 1
      and .event == "ash_atlas_gameplay_reset_backup_verified"
      and .manifestFileName == $manifestName
      and .operationId == $sourceManifest.operationId
      and .database == $sourceManifest.database
      and .releaseSha == $sourceManifest.releaseSha
      and .createdAtUtc == $sourceManifest.createdAtUtc
      and .backupFileName == $sourceManifest.artifact.fileName
      and .bytes == $sourceManifest.artifact.bytes
      and .sha256 == $sourceManifest.artifact.sha256
      and .restoreCatalogVerified == true
      and (.acknowledgmentId | test("^[a-f0-9-]{36}$"))
      and (.remoteVerifiedAtUtc | fromdateiso8601)
      and (.remotePath | type == "string")
      and (.remotePath | startswith("/"))
      and (.remotePath | test("[[:space:][:cntrl:]]") | not)
      and (.remotePath | contains("/../") | not)
      and (.remotePath | endswith("/" + $sourceManifest.artifact.fileName))
    ' "$partial" >/dev/null || deny
  chmod 0640 "$partial"
  if [[ -f "$final" && ! -L "$final" ]]; then
    cmp -s "$partial" "$final" || deny
    rm -f -- "$partial"
    trap - EXIT
    return
  fi
  ln "$partial" "$final" 2>/dev/null || deny
  rm -f -- "$partial"
  trap - EXIT
}

database_manifest_path() {
  local name="$1"
  safe_name "$name" || return 1
  [[ "$name" == *.dump.ready.json ]] || return 1
  local matches=()
  mapfile -t matches < <(find "$database_root" -mindepth 2 -maxdepth 2 \
    -type f -name "$name" -print 2>/dev/null)
  [[ ${#matches[@]} -eq 1 ]] || return 1
  local path="${matches[0]}"
  [[ ! -L "$path" ]] || return 1
  [[ "$(readlink -f -- "$path")" == "$database_root"/*/"$name" ]] || return 1
  printf '%s\n' "$path"
}

database_manifest_allows_file() {
  local requested="$1"
  safe_name "$requested" || return 1
  local manifest_path matches=()
  while IFS= read -r manifest_path; do
    [[ -n "$manifest_path" ]] || continue
    if [[ "$(basename "$manifest_path")" == "$requested" ]] ||
       jq -e --arg name "$requested" '
         .manifestVersion == 1
         and .kind == "ash_atlas_postgresql_backup"
         and .artifact.fileName == $name
       ' "$manifest_path" >/dev/null 2>&1; then
      matches+=("$manifest_path")
    fi
  done < <(find "$database_root" -mindepth 2 -maxdepth 2 \
    -type f -name '*.dump.ready.json' -print 2>/dev/null)
  [[ ${#matches[@]} -eq 1 ]] || return 1
  printf '%s\n' "${matches[0]}"
}

list_database_ready() {
  local manifest backup_id
  while IFS= read -r manifest; do
    [[ -f "$manifest" && ! -L "$manifest" ]] || continue
    backup_id="$(jq -er '
      select(.manifestVersion == 1)
      | select(.kind == "ash_atlas_postgresql_backup")
      | .backupId
      | select(test("^[a-f0-9-]{36}$"))
    ' "$manifest" 2>/dev/null)" || continue
    [[ ! -e "$database_ack_root/${backup_id}.ack.json" ]] || continue
    basename "$manifest"
  done < <(find "$database_root" -mindepth 2 -maxdepth 2 \
    -type f -name '*.dump.ready.json' -print 2>/dev/null | LC_ALL=C sort)
}

list_database_retained() {
  local manifest manifest_name backup_id artifact_name
  while IFS= read -r manifest; do
    [[ -f "$manifest" && ! -L "$manifest" ]] || continue
    manifest_name="$(basename "$manifest")"
    safe_name "$manifest_name" || continue
    backup_id="$(jq -er '
      select(.manifestVersion == 1)
      | select(.kind == "ash_atlas_postgresql_backup")
      | select(.backupClass | IN("hourly","daily","weekly","monthly","pre-migration","milestone"))
      | select(.database | test("^[a-z][a-z0-9_]{0,62}$"))
      | select(.releaseSha | test("^[a-f0-9]{40}$"))
      | select(.createdAtUtc | fromdateiso8601)
      | select(.artifact.format == "postgresql-custom")
      | select(.artifact.bytes | type == "number" and . > 0)
      | select(.artifact.sha256 | test("^[a-f0-9]{64}$"))
      | .backupId
      | select(test("^[a-f0-9-]{36}$"))
    ' "$manifest" 2>/dev/null)" || continue
    artifact_name="$(jq -er '.artifact.fileName
      | select(test("^[A-Za-z0-9][A-Za-z0-9._-]{0,239}$"))' \
      "$manifest" 2>/dev/null)" || continue
    [[ "$manifest_name" == "$artifact_name.ready.json" &&
       "$(basename "$(dirname "$manifest")")" == "backup-$backup_id" ]] || continue
    printf '%s\n' "$manifest_name"
  done < <(find "$database_root" -mindepth 2 -maxdepth 2 \
    -type f -name '*.dump.ready.json' -print 2>/dev/null | LC_ALL=C sort)
}

database_seagate_status() {
  local manifest_name="$1" manifest_path backup_id proof
  manifest_path="$(database_manifest_path "$manifest_name")" || deny
  backup_id="$(jq -er '.backupId' "$manifest_path")" || deny
  [[ "$backup_id" =~ ^[a-f0-9-]{36}$ ]] || deny
  proof="${database_seagate_ack_root}/${backup_id}.seagate.ack.json"
  if [[ -e "$proof" ]]; then
    [[ -f "$proof" && ! -L "$proof" &&
       "$(readlink -f -- "$proof")" == "$database_seagate_ack_root/$backup_id.seagate.ack.json" ]] || deny
    exec cat -- "$proof"
  fi
  return 0
}

fetch_database_file() {
  local name="$1"
  safe_name "$name" || deny
  local manifest_path
  manifest_path="$(database_manifest_allows_file "$name")" || deny
  local path
  if [[ "$(basename "$manifest_path")" == "$name" ]]; then
    path="$manifest_path"
  else
    path="$(dirname "$manifest_path")/$name"
  fi
  [[ -f "$path" && ! -L "$path" ]] || deny
  [[ "$(readlink -f -- "$path")" == "$(dirname "$manifest_path")/$name" ]] || deny
  exec cat -- "$path"
}

ack_database_backup() {
  local manifest_name="$1"
  local manifest_path
  manifest_path="$(database_manifest_path "$manifest_name")" || deny
  [[ -d "$database_ack_root" && ! -L "$database_ack_root" &&
     -w "$database_ack_root" ]] || deny
  local backup_id final partial
  backup_id="$(jq -er '.backupId' "$manifest_path")" || deny
  [[ "$backup_id" =~ ^[a-f0-9-]{36}$ ]] || deny
  final="${database_ack_root}/${backup_id}.ack.json"
  partial="$(mktemp "${database_ack_root}/.${backup_id}.ack.XXXXXX")"
  trap 'rm -f -- "${partial:-}"' EXIT
  cat >"$partial"
  [[ "$(stat -c '%s' "$partial")" -le 16384 ]] || deny
  jq -e \
    --arg manifestName "$manifest_name" \
    --slurpfile source "$manifest_path" '
      ($source[0]) as $sourceManifest
      | .acknowledgmentVersion == 1
      and .event == "ash_atlas_postgresql_backup_verified"
      and .manifestFileName == $manifestName
      and .backupId == $sourceManifest.backupId
      and .backupClass == $sourceManifest.backupClass
      and .database == $sourceManifest.database
      and .releaseSha == $sourceManifest.releaseSha
      and .createdAtUtc == $sourceManifest.createdAtUtc
      and .backupFileName == $sourceManifest.artifact.fileName
      and .bytes == $sourceManifest.artifact.bytes
      and .sha256 == $sourceManifest.artifact.sha256
      and .restoreCatalogVerified == true
      and (.acknowledgmentId | test("^[a-f0-9-]{36}$"))
      and (.remoteVerifiedAtUtc | fromdateiso8601)
      and (.remotePath | type == "string")
      and (.remotePath | startswith("/"))
      and (.remotePath | test("[[:space:][:cntrl:]]") | not)
      and (.remotePath | contains("/../") | not)
      and (.remotePath | endswith("/" + $sourceManifest.artifact.fileName))
    ' "$partial" >/dev/null || deny
  chmod 0640 "$partial"
  if [[ -f "$final" && ! -L "$final" ]]; then
    cmp -s "$partial" "$final" || deny
    rm -f -- "$partial"
    trap - EXIT
    return
  fi
  ln "$partial" "$final" 2>/dev/null || deny
  rm -f -- "$partial"
  trap - EXIT
}

ack_database_seagate_backup() {
  local manifest_name="$1"
  local manifest_path
  manifest_path="$(database_manifest_path "$manifest_name")" || deny
  [[ -d "$database_seagate_ack_root" && ! -L "$database_seagate_ack_root" &&
     -w "$database_seagate_ack_root" ]] || deny

  local backup_id source_ack final partial
  backup_id="$(jq -er '.backupId' "$manifest_path")" || deny
  [[ "$backup_id" =~ ^[a-f0-9-]{36}$ ]] || deny
  source_ack="${database_ack_root}/${backup_id}.ack.json"
  [[ -f "$source_ack" && ! -L "$source_ack" ]] || deny

  partial="$(mktemp "${database_seagate_ack_root}/.${backup_id}.seagate.XXXXXX")"
  trap 'rm -f -- "${partial:-}"' EXIT
  cat >"$partial"
  [[ "$(stat -c '%s' "$partial")" -le 16384 ]] || deny

  local expected_seagate_uuid
  if [[ "${TELEMETRY_TEST_MODE:-false}" == "true" ]]; then
    expected_seagate_uuid="${ASH_ATLAS_SEAGATE_PROOF_UUID:?}"
  else
    [[ "$database_health_env" == /etc/ash-atlas/database-health.env &&
       -r "$database_health_env" ]] || deny
    # shellcheck disable=SC1090
    source "$database_health_env"
    expected_seagate_uuid="${ASH_ATLAS_SEAGATE_PROOF_UUID:?}"
  fi
  [[ "$expected_seagate_uuid" =~ ^[A-Za-z0-9._-]+$ ]] || deny

  jq -e \
    --arg manifestName "$manifest_name" \
    --arg seagateUuid "$expected_seagate_uuid" \
    --slurpfile manifest "$manifest_path" \
    --slurpfile source "$source_ack" '
      ($manifest[0]) as $manifest
      | ($source[0]) as $source
      | .seagateAcknowledgmentVersion == 1
      and .event == "ash_atlas_postgresql_backup_seagate_verified"
      and .manifestFileName == $manifestName
      and .backupId == $manifest.backupId
      and .backupClass == $manifest.backupClass
      and .backupFileName == $manifest.artifact.fileName
      and .bytes == $manifest.artifact.bytes
      and .sha256 == $manifest.artifact.sha256
      and .sourceAcknowledgmentId == $source.acknowledgmentId
      and .seagateUuid == $seagateUuid
      and .verification == "sha256-deep"
      and .restoreCatalogVerified == true
      and (.seagateVerifiedAtUtc | fromdateiso8601)
      and $source.acknowledgmentVersion == 1
      and $source.event == "ash_atlas_postgresql_backup_verified"
      and $source.backupId == $manifest.backupId
      and $source.manifestFileName == $manifestName
      and $source.backupFileName == $manifest.artifact.fileName
      and $source.bytes == $manifest.artifact.bytes
      and $source.sha256 == $manifest.artifact.sha256
      and $source.restoreCatalogVerified == true
    ' "$partial" >/dev/null || deny

  local verified_epoch source_epoch now_epoch
  verified_epoch="$(jq -er '.seagateVerifiedAtUtc | fromdateiso8601' "$partial")" || deny
  source_epoch="$(jq -er '.remoteVerifiedAtUtc | fromdateiso8601' "$source_ack")" || deny
  now_epoch="$(date -u +%s)"
  (( verified_epoch >= source_epoch && verified_epoch <= now_epoch + 300 )) || deny

  chmod 0640 "$partial"
  final="${database_seagate_ack_root}/${backup_id}.seagate.ack.json"
  if [[ -f "$final" && ! -L "$final" ]]; then
    # A later deep scrub may re-prove the same immutable backup at another
    # timestamp. Treat that as an idempotent replay when every proof field is
    # identical except the observation time.
    cmp -s <(jq -S 'del(.seagateVerifiedAtUtc)' "$partial") \
      <(jq -S 'del(.seagateVerifiedAtUtc)' "$final") || deny
    rm -f -- "$partial"
    trap - EXIT
    return
  fi
  ln "$partial" "$final" 2>/dev/null || deny
  rm -f -- "$partial"
  trap - EXIT
}

database_health() {
  local backup_mount backup_uuid backup_serial backup_root minimum_free estimate_floor
  local estimate_percent freshness_minutes hourly_keep daily_keep weekly_keep
  local monthly_keep pre_migration_keep seagate_uuid
  if [[ "${TELEMETRY_TEST_MODE:-false}" == "true" ]]; then
    backup_mount="${ASH_ATLAS_BACKUP_MOUNT:?}"
    backup_uuid="${ASH_ATLAS_BACKUP_UUID:?}"
    backup_serial="${ASH_ATLAS_BACKUP_DEVICE_SERIAL:?}"
    backup_root="${ASH_ATLAS_DATABASE_BACKUP_ROOT:?}"
    minimum_free="${ASH_ATLAS_DATABASE_BACKUP_MINIMUM_FREE_BYTES:-10737418240}"
    estimate_floor="${ASH_ATLAS_DATABASE_BACKUP_ESTIMATED_BYTES_FLOOR:-1073741824}"
    estimate_percent="${ASH_ATLAS_DATABASE_BACKUP_ESTIMATE_PERCENT:-125}"
    freshness_minutes="${ASH_ATLAS_DATABASE_BACKUP_FRESHNESS_MINUTES:-180}"
    hourly_keep="${ASH_ATLAS_DATABASE_BACKUP_RETENTION_HOURLY:-6}"
    daily_keep="${ASH_ATLAS_DATABASE_BACKUP_RETENTION_DAILY:-14}"
    weekly_keep="${ASH_ATLAS_DATABASE_BACKUP_RETENTION_WEEKLY:-8}"
    monthly_keep="${ASH_ATLAS_DATABASE_BACKUP_RETENTION_MONTHLY:-6}"
    pre_migration_keep="${ASH_ATLAS_DATABASE_BACKUP_RETENTION_PRE_MIGRATION:-3}"
  else
    [[ "$database_health_env" == /etc/ash-atlas/database-health.env &&
       -r "$database_health_env" ]] || deny
    # shellcheck disable=SC1090
    source "$database_health_env"
    backup_mount="${ASH_ATLAS_BACKUP_MOUNT:?}"
    backup_uuid="${ASH_ATLAS_BACKUP_UUID:?}"
    backup_serial="${ASH_ATLAS_BACKUP_DEVICE_SERIAL:?}"
    backup_root="${ASH_ATLAS_DATABASE_BACKUP_ROOT:?}"
    minimum_free="${ASH_ATLAS_DATABASE_BACKUP_MINIMUM_FREE_BYTES:?}"
    estimate_floor="${ASH_ATLAS_DATABASE_BACKUP_ESTIMATED_BYTES_FLOOR:?}"
    estimate_percent="${ASH_ATLAS_DATABASE_BACKUP_ESTIMATE_PERCENT:?}"
    freshness_minutes="${ASH_ATLAS_DATABASE_BACKUP_FRESHNESS_MINUTES:?}"
    hourly_keep="${ASH_ATLAS_DATABASE_BACKUP_RETENTION_HOURLY:-6}"
    daily_keep="${ASH_ATLAS_DATABASE_BACKUP_RETENTION_DAILY:-14}"
    weekly_keep="${ASH_ATLAS_DATABASE_BACKUP_RETENTION_WEEKLY:-8}"
    monthly_keep="${ASH_ATLAS_DATABASE_BACKUP_RETENTION_MONTHLY:-6}"
    pre_migration_keep="${ASH_ATLAS_DATABASE_BACKUP_RETENTION_PRE_MIGRATION:-3}"
  fi
  # Older health environment files may predate the Seagate proof UUID. Keep
  # the health endpoint compatible and report proof state as unknown until
  # the installer propagates the configured identity.
  seagate_uuid="${ASH_ATLAS_SEAGATE_PROOF_UUID:-}"
  [[ -z "$seagate_uuid" || "$seagate_uuid" =~ ^[A-Za-z0-9._-]+$ ]] || deny
  [[ "$backup_mount" == /mnt/ash-atlas-backups ||
     "${TELEMETRY_TEST_MODE:-false}" == "true" ]] || deny
  [[ "$backup_root" == "$backup_mount"/* && "$backup_uuid" =~ ^[A-Za-z0-9._-]+$ &&
     "$backup_serial" =~ ^[A-Za-z0-9._-]+$ ]] || deny
  for value in "$minimum_free" "$estimate_floor" "$estimate_percent" "$freshness_minutes" \
    "$hourly_keep" "$daily_keep" "$weekly_keep" "$monthly_keep" "$pre_migration_keep"; do
    [[ "$value" =~ ^[1-9][0-9]*$ ]] || deny
  done

  local target source uuid options mounted_serial mount_status=problem read_write_status=problem
  target="$(findmnt -n -T "$backup_mount" -o TARGET 2>/dev/null || true)"
  source="$(findmnt -n -T "$backup_mount" -o SOURCE 2>/dev/null || true)"
  uuid="$(findmnt -n -T "$backup_mount" -o UUID 2>/dev/null || true)"
  options="$(findmnt -n -T "$backup_mount" -o OPTIONS 2>/dev/null || true)"
  if [[ "${TELEMETRY_TEST_MODE:-false}" == "true" ]]; then
    mounted_serial="${ASH_ATLAS_DATABASE_BACKUP_TEST_DEVICE_SERIAL:-TEST-SERIAL}"
  elif [[ "$source" == /dev/* ]]; then
    mounted_serial="$(udevadm info --query=property --name="$(readlink -f -- "$source")" 2>/dev/null |
      awk -F= '$1 == "ID_SERIAL_SHORT" {print substr($0,index($0,"=")+1); exit}')"
  else
    mounted_serial=""
  fi
  [[ "$target" == "$backup_mount" && "$uuid" == "$backup_uuid" &&
     "$mounted_serial" == "$backup_serial" ]] && mount_status=ok
  [[ ",$options," == *,rw,* ]] && read_write_status=ok

  local available_bytes=0 latest_manifest="" latest_created="" latest_bytes=0
  local latest_class="" latest_age=-1 catalog_status=unknown
  if [[ "$mount_status" == ok ]]; then
    available_bytes="$(df -PB1 "$backup_mount" 2>/dev/null | awk 'NR==2 {print $4}')"
    [[ "$available_bytes" =~ ^[0-9]+$ ]] || available_bytes=0
  fi
  latest_manifest="$(find "$backup_root/ready" -mindepth 2 -maxdepth 2 -type f \
    -name '*.dump.ready.json' -printf '%T@|%p\n' 2>/dev/null |
    sort -nr | sed -n '1p' | cut -d'|' -f2- || true)"
  if [[ -n "$latest_manifest" ]] && jq -e '
      .manifestVersion == 1
      and .kind == "ash_atlas_postgresql_backup"
      and (.backupId | test("^[a-f0-9-]{36}$"))
      and (.createdAtUtc | fromdateiso8601)
      and (.artifact.bytes | type == "number" and . > 0)
      and (.artifact.fileName | test("^[A-Za-z0-9][A-Za-z0-9._-]{0,239}$"))
    ' "$latest_manifest" >/dev/null 2>&1; then
    latest_created="$(jq -r '.createdAtUtc' "$latest_manifest")"
    latest_bytes="$(jq -r '.artifact.bytes' "$latest_manifest")"
    latest_class="$(jq -r '.backupClass' "$latest_manifest")"
    latest_age=$(( ($(date -u +%s) - $(date -u -d "$latest_created" +%s)) / 60 ))
    local latest_artifact
    latest_artifact="$(dirname "$latest_manifest")/$(jq -r '.artifact.fileName' "$latest_manifest")"
    if [[ -f "$latest_artifact" && ! -L "$latest_artifact" ]] &&
       pg_restore --list "$latest_artifact" >/dev/null 2>&1; then
      catalog_status=ok
    else
      catalog_status=problem
    fi
  fi

  # Reconcile the bounded retention view from the same immutable ready
  # manifests and proof files used by the root retention job.  The pull
  # account can inspect these paths without being able to delete anything;
  # an entry is counted as eligible only when both exact acknowledgments are
  # present and validate against its manifest.
  local retention_entries=()
  mapfile -t retention_entries < <(
    while IFS= read -r manifest; do
      jq -er --arg path "$manifest" '
        select(.manifestVersion == 1)
        | select(.kind == "ash_atlas_postgresql_backup")
        | select(.backupClass | IN("hourly","daily","weekly","monthly","pre-migration"))
        | select(.backupId | test("^[a-f0-9-]{36}$"))
        | select(.createdAtUtc | fromdateiso8601)
        | select(.artifact.fileName | test("^[A-Za-z0-9][A-Za-z0-9._-]{0,239}$"))
        | select(.artifact.bytes | type == "number" and . > 0)
        | select(.artifact.sha256 | test("^[a-f0-9]{64}$"))
        | [.backupClass,.createdAtUtc,.backupId,.database,.releaseSha,
           .artifact.fileName,.artifact.bytes,.artifact.sha256,$path]
        | @tsv
      ' "$manifest" 2>/dev/null || true
    done < <(find "$backup_root/ready" -mindepth 2 -maxdepth 2 -type f \
      -name '*.dump.ready.json' -print 2>/dev/null) |
      LC_ALL=C sort -t $'\t' -k1,1 -k2,2r
  )
  local beyond_limit_count=0 beyond_limit_bytes=0 currently_eligible_count=0
  local latest_proof_epoch=-1
  declare -A retention_seen=( [hourly]=0 [daily]=0 [weekly]=0 [monthly]=0 [pre-migration]=0 )
  local retention_entry backup_class backup_created backup_id backup_database backup_release
  local backup_file backup_bytes backup_sha manifest
  local retention_limit source_ack seagate_ack source_ack_id seagate_epoch
  for retention_entry in "${retention_entries[@]}"; do
    IFS=$'\t' read -r backup_class backup_created backup_id backup_database backup_release \
      backup_file backup_bytes backup_sha manifest \
      <<<"$retention_entry"
    case "$backup_class" in
      hourly) retention_limit="$hourly_keep" ;;
      daily) retention_limit="$daily_keep" ;;
      weekly) retention_limit="$weekly_keep" ;;
      monthly) retention_limit="$monthly_keep" ;;
      pre-migration) retention_limit="$pre_migration_keep" ;;
      *) continue ;;
    esac
    (( retention_seen[$backup_class] += 1 ))
    source_ack="$database_ack_root/${backup_id}.ack.json"
    seagate_ack="$database_seagate_ack_root/${backup_id}.seagate.ack.json"
    if [[ -f "$seagate_ack" && ! -L "$seagate_ack" ]] &&
       jq -e --arg id "$backup_id" --arg manifest "$(basename "$manifest")" \
         --arg sha "$backup_sha" --arg class "$backup_class" --arg file "$backup_file" \
         --arg seagate "$seagate_uuid" \
         --argjson bytes "$backup_bytes" '
           .seagateAcknowledgmentVersion == 1
           and .event == "ash_atlas_postgresql_backup_seagate_verified"
           and .backupId == $id
           and .manifestFileName == $manifest
           and .backupClass == $class
           and .backupFileName == $file
           and .sha256 == $sha
           and .bytes == $bytes
           and .seagateUuid == $seagate
           and .verification == "sha256-deep"
           and .restoreCatalogVerified == true
           and (.seagateVerifiedAtUtc | fromdateiso8601)
         ' "$seagate_ack" >/dev/null 2>&1; then
      seagate_epoch="$(jq -er '.seagateVerifiedAtUtc | fromdateiso8601' "$seagate_ack")"
      (( seagate_epoch > latest_proof_epoch )) && latest_proof_epoch="$seagate_epoch"
    fi

    (( retention_seen[$backup_class] <= retention_limit )) && continue
    (( beyond_limit_count += 1 ))
    (( beyond_limit_bytes += backup_bytes ))
    [[ -f "$source_ack" && ! -L "$source_ack" &&
       -f "$seagate_ack" && ! -L "$seagate_ack" ]] || continue
    source_ack_id="$(jq -er '.acknowledgmentId' "$source_ack" 2>/dev/null || true)"
    [[ -n "$source_ack_id" ]] || continue
    if ! jq -e --arg id "$backup_id" --arg manifest "$(basename "$manifest")" \
         --arg sha "$backup_sha" --arg class "$backup_class" --arg database "$backup_database" \
         --arg release "$backup_release" --arg created "$backup_created" --arg file "$backup_file" \
         --argjson bytes "$backup_bytes" '
           .acknowledgmentVersion == 1
           and .event == "ash_atlas_postgresql_backup_verified"
           and .backupId == $id
           and .manifestFileName == $manifest
           and .backupClass == $class
           and .database == $database
           and .releaseSha == $release
           and .createdAtUtc == $created
           and .backupFileName == $file
           and .sha256 == $sha
           and .bytes == $bytes
           and .restoreCatalogVerified == true
           and (.remoteVerifiedAtUtc | fromdateiso8601)
         ' "$source_ack" >/dev/null 2>&1; then
      continue
    fi
    if ! jq -e --arg id "$backup_id" --arg manifest "$(basename "$manifest")" \
        --arg sha "$backup_sha" --arg class "$backup_class" --arg file "$backup_file" \
        --arg source "$source_ack_id" \
        --arg seagate "$seagate_uuid" --argjson bytes "$backup_bytes" '
          .seagateAcknowledgmentVersion == 1
          and .event == "ash_atlas_postgresql_backup_seagate_verified"
          and .backupId == $id
          and .manifestFileName == $manifest
          and .backupClass == $class
          and .backupFileName == $file
          and .sha256 == $sha
          and .bytes == $bytes
          and .sourceAcknowledgmentId == $source
          and .seagateUuid == $seagate
          and .verification == "sha256-deep"
          and .restoreCatalogVerified == true
          and (.seagateVerifiedAtUtc | fromdateiso8601)
        ' "$seagate_ack" >/dev/null 2>&1; then
      continue
    fi
    (( currently_eligible_count += 1 ))
  done

  local proof_age_minutes=-1 latest_scrub_result=unknown offsite_reachability=unknown
  if (( latest_proof_epoch >= 0 )); then
    proof_age_minutes=$(( ($(date -u +%s) - latest_proof_epoch) / 60 ))
    (( proof_age_minutes < 0 )) && proof_age_minutes=0
    latest_scrub_result=ok
    offsite_reachability=reachable
  fi

  local estimated_bytes="$estimate_floor" scaled required_bytes capacity_status=problem
  if (( latest_bytes > 0 )); then
    scaled=$(( (latest_bytes * estimate_percent + 99) / 100 ))
    (( scaled > estimated_bytes )) && estimated_bytes="$scaled"
  fi
  required_bytes=$(( minimum_free + estimated_bytes ))
  (( available_bytes >= required_bytes )) && capacity_status=ok

  local headroom_margin_bytes=$(( available_bytes - required_bytes ))
  local projected_backups_until_exhaustion=-1 projected_hours_until_exhaustion=-1
  if [[ "$mount_status" == ok && "$estimated_bytes" =~ ^[1-9][0-9]*$ ]] &&
     (( available_bytes > minimum_free )); then
    projected_backups_until_exhaustion=$(( (available_bytes - minimum_free) / estimated_bytes ))
    projected_hours_until_exhaustion="$projected_backups_until_exhaustion"
  fi
  local capacity_alert=ok
  if [[ "$mount_status" != ok || "$headroom_margin_bytes" -lt 0 ]]; then
    capacity_alert=critical
  elif (( projected_hours_until_exhaustion >= 0 && projected_hours_until_exhaustion <= 6 )); then
    capacity_alert=critical
  elif (( projected_hours_until_exhaustion >= 0 && projected_hours_until_exhaustion <= 24 )); then
    capacity_alert=warning
  fi

  local freshness_status=problem service_result
  (( latest_age >= 0 && latest_age <= freshness_minutes )) && freshness_status=ok
  service_result="$(systemctl show ash-atlas-database-backup@hourly.service \
    -p Result --value 2>/dev/null || true)"
  local overall_status=problem failure_reason=unknown
  if [[ "$mount_status" == ok && "$read_write_status" == ok &&
        "$capacity_status" == ok && "$freshness_status" == ok &&
        "$catalog_status" == ok && "$service_result" == success ]]; then
    overall_status=ok
    failure_reason=none
  elif [[ "$mount_status" != ok ]]; then
    failure_reason=mount_identity
  elif [[ "$read_write_status" != ok ]]; then
    failure_reason=read_write
  elif [[ "$capacity_status" != ok ]]; then
    failure_reason=capacity
  elif [[ "$freshness_status" != ok ]]; then
    failure_reason=freshness
  elif [[ "$catalog_status" != ok ]]; then
    failure_reason=restore_catalog
  else
    failure_reason=service
  fi

  jq -cn \
    --arg checkedAtUtc "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg status "$overall_status" \
    --arg mountStatus "$mount_status" \
    --arg readWriteStatus "$read_write_status" \
    --arg capacityStatus "$capacity_status" \
    --arg backupFreshnessStatus "$freshness_status" \
    --arg catalogStatus "$catalog_status" \
    --arg hourlyServiceResult "${service_result:-unknown}" \
    --arg failureReason "$failure_reason" \
    --arg latestBackupCreatedAtUtc "${latest_created:-unknown}" \
    --arg latestBackupClass "${latest_class:-unknown}" \
    --arg capacityAlert "$capacity_alert" \
    --arg latestScrubResult "$latest_scrub_result" \
    --arg offsiteReachability "$offsite_reachability" \
    --argjson retentionHourly "$hourly_keep" \
    --argjson retentionDaily "$daily_keep" \
    --argjson retentionWeekly "$weekly_keep" \
    --argjson retentionMonthly "$monthly_keep" \
    --argjson retentionPreMigration "$pre_migration_keep" \
    --argjson availableBytes "$available_bytes" \
    --argjson freeBytes "$available_bytes" \
    --argjson minimumFreeBytes "$minimum_free" \
    --argjson estimatedNextBackupBytes "$estimated_bytes" \
    --argjson requiredFreeBytes "$required_bytes" \
    --argjson requiredHeadroomBytes "$required_bytes" \
    --argjson headroomMarginBytes "$headroom_margin_bytes" \
    --argjson beyondLimitCount "$beyond_limit_count" \
    --argjson beyondLimitBytes "$beyond_limit_bytes" \
    --argjson currentlyEligibleCount "$currently_eligible_count" \
    --argjson proofAgeMinutes "$proof_age_minutes" \
    --argjson projectedBackupsUntilExhaustion "$projected_backups_until_exhaustion" \
    --argjson projectedHoursUntilExhaustion "$projected_hours_until_exhaustion" \
    --argjson latestBackupBytes "$latest_bytes" \
    --argjson latestBackupAgeMinutes "$latest_age" '
      {
        version:1,checkedAtUtc:$checkedAtUtc,status:$status,
        mountStatus:$mountStatus,readWriteStatus:$readWriteStatus,
        capacityStatus:$capacityStatus,backupFreshnessStatus:$backupFreshnessStatus,
        catalogStatus:$catalogStatus,hourlyServiceResult:$hourlyServiceResult,
        failureReason:$failureReason,availableBytes:$availableBytes,
        freeBytes:$freeBytes,
        minimumFreeBytes:$minimumFreeBytes,
        estimatedNextBackupBytes:$estimatedNextBackupBytes,
        requiredFreeBytes:$requiredFreeBytes,
        requiredHeadroomBytes:$requiredHeadroomBytes,
        headroomMarginBytes:$headroomMarginBytes,
        beyondLimitCount:$beyondLimitCount,
        beyondLimitBytes:$beyondLimitBytes,
        currentlyEligibleCount:$currentlyEligibleCount,
        proofAgeMinutes:$proofAgeMinutes,
        latestScrubResult:$latestScrubResult,
        offsiteReachability:$offsiteReachability,
        projectedBackupsUntilExhaustion:$projectedBackupsUntilExhaustion,
        projectedHoursUntilExhaustion:$projectedHoursUntilExhaustion,
        capacityAlert:$capacityAlert,
        retentionLimits:{hourly:$retentionHourly,daily:$retentionDaily,
          weekly:$retentionWeekly,monthly:$retentionMonthly,
          preMigration:$retentionPreMigration},
        latestBackupCreatedAtUtc:$latestBackupCreatedAtUtc,
        latestBackupClass:$latestBackupClass,
        latestBackupBytes:$latestBackupBytes,
        latestBackupAgeMinutes:$latestBackupAgeMinutes
      }'
}

original="${SSH_ORIGINAL_COMMAND:-}"
if [[ "$original" == "list" ]]; then
  list_ready
elif [[ "$original" == "reset-list" ]]; then
  list_reset_ready
elif [[ "$original" == "database-list" ]]; then
  list_database_ready
elif [[ "$original" == "database-retained-list" ]]; then
  list_database_retained
elif [[ "$original" =~ ^database-seagate-status[[:space:]]([A-Za-z0-9][A-Za-z0-9._-]{0,239})$ ]]; then
  database_seagate_status "${BASH_REMATCH[1]}"
elif [[ "$original" =~ ^fetch[[:space:]]([A-Za-z0-9][A-Za-z0-9._-]{0,239})$ ]]; then
  fetch_file "${BASH_REMATCH[1]}"
elif [[ "$original" =~ ^reset-fetch[[:space:]]([A-Za-z0-9][A-Za-z0-9._-]{0,239})$ ]]; then
  fetch_reset_file "${BASH_REMATCH[1]}"
elif [[ "$original" =~ ^database-fetch[[:space:]]([A-Za-z0-9][A-Za-z0-9._-]{0,239})$ ]]; then
  fetch_database_file "${BASH_REMATCH[1]}"
elif [[ "$original" =~ ^ack[[:space:]]([A-Za-z0-9][A-Za-z0-9._-]{0,239})[[:space:]]([a-f0-9]{64})[[:space:]](1)$ ]]; then
  ack_manifest "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}"
elif [[ "$original" =~ ^reset-ack[[:space:]]([A-Za-z0-9][A-Za-z0-9._-]{0,239})$ ]]; then
  ack_reset_backup "${BASH_REMATCH[1]}"
elif [[ "$original" =~ ^database-ack[[:space:]]([A-Za-z0-9][A-Za-z0-9._-]{0,239})$ ]]; then
  ack_database_backup "${BASH_REMATCH[1]}"
elif [[ "$original" =~ ^database-seagate-ack[[:space:]]([A-Za-z0-9][A-Za-z0-9._-]{0,239})$ ]]; then
  ack_database_seagate_backup "${BASH_REMATCH[1]}"
elif [[ "$original" == "database-health" ]]; then
  database_health
else
  deny
fi
