#!/usr/bin/env bash

ash_backup_require_safe_path() {
  local path="$1"
  [[ "$path" =~ ^/[A-Za-z0-9._/-]+$ && "$path" != "/" &&
     -d "$path" && ! -L "$path" && "$(realpath -e -- "$path")" == "$path" ]]
}

ash_backup_validate_storage() {
  local path="$1"
  local expected_mount="$2"
  local expected_uuid="$3"
  local expected_serial="$4"
  local expected_fstype="$5"
  local label="$6"
  local snapshot source mounted_serial

  ash_backup_require_safe_path "$path" || {
    echo "$label path is absent or unsafe: $path" >&2
    return 1
  }
  [[ "$expected_mount" == / || "$expected_mount" =~ ^/[A-Za-z0-9._/-]+$ ]] || return 1
  [[ "$expected_uuid" =~ ^[A-Za-z0-9._-]+$ ]] || return 1
  [[ "$expected_serial" =~ ^[A-Za-z0-9._-]+$ ]] || return 1
  [[ "$expected_fstype" =~ ^[A-Za-z0-9._-]+$ ]] || return 1

  if [[ "$expected_mount" == "/" ]]; then
    [[ "$path" == /* ]] || return 1
  elif [[ "$path" != "$expected_mount" && "$path" != "$expected_mount/"* ]]; then
    echo "$label path is outside its configured mount" >&2
    return 1
  fi

  snapshot="$(findmnt -J -l -T "$path" -o TARGET,SOURCE,FSTYPE,UUID,OPTIONS,FSROOT)" || {
    echo "failed to inspect $label filesystem" >&2
    return 1
  }
  if ! jq -e \
    --arg target "$expected_mount" \
    --arg uuid "$expected_uuid" \
    --arg fstype "$expected_fstype" '
      def clean:
        type == "string" and (test("[\u0000-\u001f\u007f]") | not);
      (.filesystems | type == "array")
      and ([.filesystems[] | select((.fstype // "") != "autofs")] as $real
      | ($real | length) == 1
      and ($real[0] as $mount
        | ($mount.target | clean)
        and (($mount.source // "") | clean)
        and ($mount.fstype | clean)
        and (($mount.uuid // "") | clean)
        and ($mount.options | clean)
        and ($mount.fsroot | clean)
        and $mount.target == $target
        and $mount.fstype == $fstype
        and $mount.uuid == $uuid
        and $mount.fsroot == "/"
        and (($mount.options | split(",")) | index("rw")) != null
        and (($mount.options | split(",")) | index("bind")) == null
        and (($mount.options | split(",")) | index("rbind")) == null
      ))
    ' <<<"$snapshot" >/dev/null; then
    echo "$label filesystem identity is invalid or ambiguous" >&2
    return 1
  fi

  source="$(jq -r '.filesystems[] | select((.fstype // "") != "autofs") | .source // ""' \
    <<<"$snapshot")"
  [[ "$source" == /dev/* ]] || {
    echo "$label filesystem source is not a block device" >&2
    return 1
  }
  source="$(readlink -f -- "$source")"
  mounted_serial="${ASH_ATLAS_BACKUP_TEST_DEVICE_SERIAL:-$(
    udevadm info --query=property --name="$source" |
      awk -F= '$1 == "ID_SERIAL_SHORT" {print substr($0, index($0, "=") + 1); exit}'
  )}"
  [[ -n "$mounted_serial" && "$mounted_serial" == "$expected_serial" ]] || {
    echo "$label device serial does not match" >&2
    return 1
  }
}

ash_backup_require_child() {
  local parent="$1"
  local child="$2"
  ash_backup_require_safe_path "$child" || return 1
  [[ "$child" == "$parent/"* ]]
}

ash_backup_file_totals() {
  find "$@" -type f -printf '%s\n' |
    awk '{count += 1; bytes += $1} END {printf "%d %d\n", count, bytes}'
}

# Backup bytes are deliberately measured as decimal bytes.  These helpers are
# shared by the pull, mirror, proof, and scrub jobs so every writer uses the
# same bounded-intake rules.  A missing or unreadable path is an error rather
# than an empty inventory: silently treating a failed find/df as zero would
# make the cap meaningless.
ash_backup_positive_integer() {
  [[ "${1:-}" =~ ^[1-9][0-9]*$ ]]
}

ash_backup_nonnegative_integer() {
  [[ "${1:-}" =~ ^[0-9]+$ ]]
}

ash_backup_path_bytes() {
  local path="$1" bytes
  ash_backup_require_safe_path "$path" || return 1
  bytes="$(find "$path" -xdev -type f -printf '%s\n' | awk '{total += $1} END {printf "%d\n", total + 0}')" ||
    return 1
  ash_backup_nonnegative_integer "$bytes" || return 1
  printf '%s\n' "$bytes"
}

ash_backup_paths_bytes() {
  local path total=0 bytes
  for path in "$@"; do
    bytes="$(ash_backup_path_bytes "$path")" || return 1
    total=$((total + bytes))
  done
  printf '%s\n' "$total"
}

ash_backup_filesystem_snapshot() {
  local path="$1" available used_percent total_bytes
  available="$(df -PB1 -- "$path" | awk 'NR == 2 {print $4}')" || return 1
  total_bytes="$(df -PB1 -- "$path" | awk 'NR == 2 {print $2}')" || return 1
  used_percent="$(df -P -- "$path" | awk 'NR == 2 {gsub(/%/,"",$5); print $5}')" || return 1
  ash_backup_nonnegative_integer "$available" || return 1
  ash_backup_positive_integer "$total_bytes" || return 1
  ash_backup_nonnegative_integer "$used_percent" || return 1
  printf '%s %s %s\n' "$available" "$used_percent" "$total_bytes"
}

# Require the backing filesystem to remain below the configured guard (the
# installed home default is 75%, strictly below the 80% HA guard) and
# leave its configured root reserve after the complete peak write.  The check
# is intentionally independent of the backup aggregate cap: the intake may be
# under 50 GB while an unrelated root filesystem is already exhausted.
ash_backup_require_root_headroom() {
  local path="$1" peak_bytes="$2" reserve_bytes="$3" max_used_percent="${4:-80}"
  local available used_percent total_bytes used_bytes projected_used
  ash_backup_nonnegative_integer "$peak_bytes" || return 1
  ash_backup_nonnegative_integer "$reserve_bytes" || return 1
  ash_backup_positive_integer "$max_used_percent" || return 1
  (( max_used_percent <= 100 )) || return 1
  read -r available used_percent total_bytes < <(ash_backup_filesystem_snapshot "$path") || return 1
  used_bytes=$((total_bytes - available))
  projected_used=$((used_bytes + peak_bytes))
  (( available >= reserve_bytes + peak_bytes )) || return 1
  # Compare in integers so a write cannot pass the guard and then push the
  # filesystem to the configured threshold.  Strictly below is intentional.
  (( projected_used * 100 < total_bytes * max_used_percent ))
}

ash_backup_require_bounded_capacity() {
  local aggregate_root="$1" cap_bytes="$2" warning_bytes="$3"
  local peak_bytes="$4" root_reserve_bytes="$5" max_used_percent="${6:-75}"
  local current projected warning
  ash_backup_positive_integer "$cap_bytes" || return 1
  ash_backup_positive_integer "$warning_bytes" || return 1
  ash_backup_nonnegative_integer "$peak_bytes" || return 1
  ash_backup_nonnegative_integer "$root_reserve_bytes" || return 1
  (( warning_bytes < cap_bytes )) || return 1
  current="$(ash_backup_path_bytes "$aggregate_root")" || return 1
  local restore_reserve="${TELEMETRY_RESTORE_WORKSPACE_CAP_BYTES:-34359738368}"
  [[ "${TELEMETRY_TEST_MODE:-false}" != true ]] || restore_reserve="${TELEMETRY_RESTORE_WORKSPACE_CAP_BYTES:-0}"
  [[ "${ASH_ATLAS_RESTORE_ADMISSION:-false}" != true ]] || restore_reserve=0
  ash_backup_nonnegative_integer "$restore_reserve" || return 1
  projected=$((current + peak_bytes + restore_reserve))
  (( current <= cap_bytes && projected <= cap_bytes )) || {
    echo "backup intake cap exhausted: current=${current} projected=${projected} cap=${cap_bytes}" >&2
    return 1
  }
  ash_backup_require_root_headroom "$aggregate_root" "$peak_bytes" \
    "$root_reserve_bytes" "$max_used_percent" || {
    echo "backup root headroom is below the configured guard" >&2
    return 1
  }
  if (( current >= warning_bytes || projected >= warning_bytes )); then
    warning=warning
  else
    warning=ok
  fi
  printf '%s %s %s\n' "$current" "$projected" "$warning"
}

ash_backup_require_bounded_paths() {
  local cap_bytes="$1" warning_bytes="$2" peak_bytes="$3"
  local root_reserve_bytes="$4" max_used_percent="$5" current projected warning path
  ash_backup_positive_integer "$cap_bytes" || return 1
  ash_backup_positive_integer "$warning_bytes" || return 1
  ash_backup_nonnegative_integer "$peak_bytes" || return 1
  ash_backup_nonnegative_integer "$root_reserve_bytes" || return 1
  ash_backup_positive_integer "$max_used_percent" || return 1
  (( warning_bytes < cap_bytes )) || return 1
  shift 5
  (($# > 0)) || return 1
  current="$(ash_backup_paths_bytes "$@")" || return 1
  local restore_reserve="${TELEMETRY_RESTORE_WORKSPACE_CAP_BYTES:-34359738368}"
  [[ "${TELEMETRY_TEST_MODE:-false}" != true ]] || restore_reserve="${TELEMETRY_RESTORE_WORKSPACE_CAP_BYTES:-0}"
  [[ "${ASH_ATLAS_RESTORE_ADMISSION:-false}" != true ]] || restore_reserve=0
  ash_backup_nonnegative_integer "$restore_reserve" || return 1
  projected=$((current + peak_bytes + restore_reserve))
  (( current <= cap_bytes && projected <= cap_bytes )) || {
    echo "backup intake cap exhausted: current=${current} projected=${projected} cap=${cap_bytes}" >&2
    return 1
  }
  ash_backup_require_root_headroom "${1}" "$peak_bytes" \
    "$root_reserve_bytes" "$max_used_percent" || {
    echo "backup root headroom is below the configured guard" >&2
    return 1
  }
  if (( current >= warning_bytes || projected >= warning_bytes )); then
    warning=warning
  else
    warning=ok
  fi
  printf '%s %s %s\n' "$current" "$projected" "$warning"
}

ash_backup_require_portable_root() {
  local path="$1" mount="$2"
  ash_backup_require_portable_mount "$mount" || return 1
  ash_backup_require_safe_path "$path" || return 1
  [[ "$mount" == / || "$mount" =~ ^/[A-Za-z0-9._/-]+$ ]] || return 1
  if [[ "$mount" != / ]]; then
    [[ "$path" == "$mount" || "$path" == "$mount/"* ]] || return 1
  fi
}

# Re-check the mount immediately before any archive directory creation or
# rename.  A portable disk disappearing after the pull preflight must not
# turn its mountpoint directory on the home/root filesystem into an archive.
ash_backup_require_portable_mount() {
  local mount="$1"
  ash_backup_require_safe_path "$mount" || return 1
  command -v mountpoint >/dev/null || return 1
  mountpoint -q -- "$mount" || return 1
  if [[ -n "${TELEMETRY_SEAGATE_UUID:-}" &&
        -n "${TELEMETRY_SEAGATE_SERIAL:-}" ]]; then
    ash_backup_validate_storage "$mount" "$mount" \
      "$TELEMETRY_SEAGATE_UUID" "$TELEMETRY_SEAGATE_SERIAL" \
      "${TELEMETRY_SEAGATE_FSTYPE:-ntfs3}" 'portable backup archive' || return 1
  fi
}

ash_backup_validate_immutable_receipt() {
  local receipt="$1" expected_id="$2" expected_file="$3"
  local expected_bytes="$4" expected_sha="$5" event="${6:-ash_atlas_postgresql_backup_portable_verified}"
  [[ -f "$receipt" && ! -L "$receipt" ]] || return 1
  jq -e --arg id "$expected_id" --arg file "$expected_file" --arg sha "$expected_sha" \
    --arg event "$event" --argjson bytes "$expected_bytes" '
      .backupId == $id
      and .backupFileName == $file
      and .bytes == $bytes
      and .sha256 == $sha
      and .event == $event
      and (.portableReceiptVersion == 1 or .seagateAcknowledgmentVersion == 1)
      and .restoreCatalogVerified == true
    ' "$receipt" >/dev/null
}

# Legacy database receipts used remotePath for the home intake path and had no
# portablePath.  The old receipt is also the byte-for-byte source ACK replay
# sent to the VPS, so do not rewrite it merely to record the portable copy.
# Derive the old additive mirror path from the intake-relative path instead;
# callers still verify the candidate against the immutable receipt and
# pg_restore before using it.
ash_backup_copy_fingerprint() {
  [[ -f "$1" && ! -L "$1" && "$(realpath -e -- "$1")" == "$1" ]] || return 1
  stat -c '%i:%s:%y:%z' -- "$1"
}

# The same tier ordering used by prove --oldest. Baseline membership is an
# immutable cutover snapshot, never inferred from a clock or a filename.
ash_backup_select_database_work() {
  local inventory="$1" baseline="$2" health="$3" override="${4:-}"
  [[ -f "$baseline" && ! -L "$baseline" && "$(stat -c '%u:%a' "$baseline")" == 0:600 ]] || return 1
  jq -e '.baselineVersion == 1 and (.backups | type == "array") and
    all(.backups[]; (.backupId | test("^[a-f0-9-]{36}$")) and
      (.artifact.sha256 | test("^[a-f0-9]{64}$"))) and
    ([.backups[].backupId]|length) == ([.backups[].backupId]|unique|length)' "$baseline" >/dev/null || return 1
  jq -e '.version == 1 and
    ([.retentionLimits.hourly,.retentionLimits.daily,.retentionLimits.weekly,
      .retentionLimits.monthly,.retentionLimits.preMigration] | all(.[]; type == "number" and . >= 0))' "$health" >/dev/null || return 1
  jq -se --slurpfile baseline "$baseline" '
    all(.[]; . as $current | [$baseline[0].backups[] | select(.backupId == $current.backupId)] |
      if length==0 then true else .[0].artifact == $current.artifact and .[0].createdAtUtc == $current.createdAtUtc
        and .[0].backupClass == $current.backupClass end)' "$inventory" >/dev/null || return 1
  jq -sr --slurpfile baseline "$baseline" --slurpfile health "$health" --arg override "$override" '
    def limit($class): $health[0].retentionLimits[
      if $class == "pre-migration" then "preMigration" else $class end];
    . as $all | ($baseline[0].backups | map(.backupId)) as $old |
    if $override != "" then
      if ([.[] | select(.backupId == $override)] | length) != 1 then error("unknown explicit ID")
      else .[] | select(.backupId == $override) | .backupId end
    else
      # Replay durable green source ACKs before any fallible payload slot;
      # an unrelated deferred/corrupt historical ID must not orphan them.
      ($all[] | select(.green == true) | .backupId),
      ([.[] | select(.green != true) | select(.backupId as $id | ($old | index($id)) == null)]
        | sort_by(.createdAtUtc,.backupId) | .[:2] | .[].backupId),
      ([ $all | group_by(.backupClass)[] | sort_by(.createdAtUtc,.backupId) | reverse |
         if .[0].backupClass == "milestone" then empty else .[limit(.[0].backupClass):][] end |
         select(.green != true) | select(.backupId as $id | $old | index($id)) ]
        | sort_by(.createdAtUtc,.backupId) | .[:1] | .[].backupId)
    end' "$inventory"
}

# HOME's protected record is authority for this physical copy, not the JSON
# on removable media. Fast mode never reads the payload or earns authority.
# Deep mode is explicit and bounded by the caller's timeout.
ash_backup_verify_copy() {
  local mode="$1" kind="$2" id="$3" path="$4" bytes="$5" sha="$6"
  local manifest="$7" source_receipt="$8" portable_receipt="${9:-}"
  local root="${TELEMETRY_HOME_STORAGE_ROOT:?}/.copy-verifications"
  local uuid serial mount fstype before after manifest_sha source_sha portable_sha ack record temporary actual
  [[ "$mode" == fast || "$mode" == deep ]] || return 1
  [[ "$kind" == postgresql || "$kind" == reset ]] || return 1
  [[ "$id" =~ ^[a-f0-9-]{36}$ && "$bytes" =~ ^[1-9][0-9]*$ && "$sha" =~ ^[a-f0-9]{64}$ ]] || return 1
  if [[ "$path" == "${TELEMETRY_SEAGATE_MOUNT:?}/"* ]]; then
    uuid="$TELEMETRY_SEAGATE_UUID"; serial="$TELEMETRY_SEAGATE_SERIAL"
    mount="$TELEMETRY_SEAGATE_MOUNT"; fstype="${TELEMETRY_SEAGATE_FSTYPE:-ntfs3}"
  elif [[ "$path" == "$TELEMETRY_HOME_STORAGE_ROOT/"* ]]; then
    uuid="$TELEMETRY_HOME_STORAGE_UUID"; serial="$TELEMETRY_HOME_STORAGE_SERIAL"
    mount="$TELEMETRY_HOME_STORAGE_MOUNT"; fstype="$TELEMETRY_HOME_STORAGE_FSTYPE"
  else return 1; fi
  ash_backup_validate_storage "$(dirname -- "$path")" "$mount" "$uuid" "$serial" "$fstype" 'verified copy' || return 1
  before="$(ash_backup_copy_fingerprint "$path")" || return 1
  [[ "$(stat -c '%s' -- "$path")" == "$bytes" ]] || return 1
  for record in "$manifest" "$source_receipt"; do
    [[ -f "$record" && ! -L "$record" && "$(realpath -e -- "$record")" == "$record" ]] || return 1
  done
  manifest_sha="$(sha256sum -- "$manifest" | awk '{print $1}')" || return 1
  local persistent_manifest="${ASH_ATLAS_DATABASE_BACKUP_REMOTE_DIRECTORY:-}/.verification-manifests/$(basename "$manifest")"
  if [[ -f "$persistent_manifest" && ! -L "$persistent_manifest" &&
        "$(sha256sum "$persistent_manifest" | awk '{print $1}')" == "$manifest_sha" ]]; then
    manifest="$persistent_manifest"
  fi
  source_sha="$(sha256sum -- "$source_receipt" | awk '{print $1}')" || return 1
  ack="$(jq -er '.acknowledgmentId' "$source_receipt")" || return 1
  [[ "$ack" =~ ^[a-f0-9-]{36}$ ]] || return 1
  portable_sha=''
  if [[ -n "$portable_receipt" ]]; then
    [[ -f "$portable_receipt" && ! -L "$portable_receipt" ]] || return 1
    portable_sha="$(sha256sum -- "$portable_receipt" | awk '{print $1}')" || return 1
  fi
  record="$root/$(printf '%s' "$path" | sha256sum | awk '{print $1}').json"
  if [[ "$mode" == fast && -d "$root" && ! -L "$root" && "$(stat -c '%u:%a' "$root")" == 0:700 &&
        -f "$record" && ! -L "$record" && "$(stat -c '%u:%a' "$record")" == 0:600 ]]; then
    if jq -e --arg path "$path" --arg kind "$kind" --arg id "$id" --arg uuid "$uuid" --arg serial "$serial" \
      --arg sha "$sha" --arg fingerprint "$before" --arg manifest "$manifest_sha" \
      --arg source "$source_sha" --arg portable "$portable_sha" --arg ack "$ack" --argjson bytes "$bytes" '
      .copyVerificationVersion == 1 and .kind == $kind and .id == $id
      and .path == $path and .filesystemUuid == $uuid and .serial == $serial
      and .sha256 == $sha and .bytes == $bytes and .fingerprint == $fingerprint
      and .manifestSha256 == $manifest and .sourceReceiptSha256 == $source
      and .portableReceiptSha256 == $portable and .sourceAcknowledgmentId == $ack
      and .restoreCatalogVerified == true and (.verifiedAtUtc | fromdateiso8601)
      ' "$record" >/dev/null; then
      cat -- "$record"
      return 0
    fi
  fi
  [[ "$mode" == deep ]] || return 1
  # Refuse unsafe protected state rather than repairing an untrusted catalog.
  if [[ -e "$root" || -L "$root" ]]; then
    [[ -d "$root" && ! -L "$root" && "$(realpath -e -- "$root")" == "$root" &&
       "$(stat -c '%u:%a' "$root")" == 0:700 ]] || return 1
  else install -d -o root -g root -m 0700 -- "$root" || return 1; fi
  local read_budget=580
  if [[ -n "${ASH_ATLAS_BACKUP_DEADLINE:-}" ]]; then
    read_budget=$(( ASH_ATLAS_BACKUP_DEADLINE - $(date +%s) - 20 ))
    (( read_budget > 0 )) || return 124
  fi
  actual="$(timeout --kill-after=2 "$read_budget" sha256sum -- "$path" | awk '{print $1}')" || return 124
  after="$(ash_backup_copy_fingerprint "$path")" || return 2
  [[ "$before" == "$after" ]] || return 2
  if [[ -n "${ASH_ATLAS_BACKUP_DEADLINE:-}" ]]; then
    read_budget=$(( ASH_ATLAS_BACKUP_DEADLINE - $(date +%s) - 20 ))
    (( read_budget > 0 )) || return 124
  fi
  local catalog_status=0
  [[ "$actual" != "$sha" ]] || timeout --kill-after=2 "$read_budget" pg_restore --list "$path" >/dev/null || catalog_status=$?
  (( catalog_status != 124 && catalog_status != 137 )) || return 124
  if [[ "$actual" != "$sha" ]] || (( catalog_status != 0 )); then
    [[ "$(ash_backup_copy_fingerprint "$path" || true)" == "$before" ]] || return 2
    [[ "${ASH_ATLAS_BACKUP_DEFER_PUBLICATION:-false}" == true ]] || rm -f -- "$record"
    echo "corrupt backup copy: $path" >&2
    return 1
  fi
  [[ "$(ash_backup_copy_fingerprint "$path")" == "$before" &&
     "$(sha256sum -- "$manifest" | awk '{print $1}')" == "$manifest_sha" &&
     "$(sha256sum -- "$source_receipt" | awk '{print $1}')" == "$source_sha" ]] || return 2
  if [[ -n "$portable_receipt" ]]; then
    [[ "$(sha256sum -- "$portable_receipt" | awk '{print $1}')" == "$portable_sha" ]] || return 2
  fi
  ash_backup_validate_storage "$(dirname -- "$path")" "$mount" "$uuid" "$serial" "$fstype" 'verified copy' || return 2
  temporary="$(mktemp "$root/.verification.XXXXXXXX")" || return 1
  jq -cn --arg path "$path" --arg kind "$kind" --arg id "$id" --arg uuid "$uuid" --arg serial "$serial" \
    --arg sha "$sha" --arg fingerprint "$before" --arg manifest "$manifest_sha" --arg source "$source_sha" \
    --arg portable "$portable_sha" --arg ack "$ack" --arg time "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg manifestPath "$manifest" --arg sourcePath "$source_receipt" --arg portablePath "$portable_receipt" \
    --argjson bytes "$bytes" '{copyVerificationVersion:1,kind:$kind,id:$id,path:$path,
      filesystemUuid:$uuid,serial:$serial,sha256:$sha,bytes:$bytes,fingerprint:$fingerprint,
      manifestSha256:$manifest,sourceReceiptSha256:$source,portableReceiptSha256:$portable,
      manifestPath:$manifestPath,sourceReceiptPath:$sourcePath,portableReceiptPath:$portablePath,
      sourceAcknowledgmentId:$ack,verifiedAtUtc:$time,restoreCatalogVerified:true}' >"$temporary" || return 1
  if [[ "${ASH_ATLAS_BACKUP_DEFER_PUBLICATION:-false}" == true ]]; then
    cat -- "$temporary"
    rm -f -- "$temporary"
    return 0
  fi
  chmod 0600 "$temporary" && sync -f "$temporary" && mv -f -- "$temporary" "$record" && sync -f "$root" || return 1
  cat -- "$record"
}

# Scrub publishes only after reacquiring lifecycle locks. Its read result is
# rejected if a writer retired/replaced the path or changed any small metadata.
ash_backup_publish_copy_receipt() {
  local candidate="$1" path fingerprint manifest source portable expected uuid serial root target temporary
  path="$(jq -er '.path' "$candidate")" || return 1
  fingerprint="$(jq -er '.fingerprint' "$candidate")" || return 1
  [[ "$(ash_backup_copy_fingerprint "$path")" == "$fingerprint" ]] || return 2
  uuid="$(jq -er '.filesystemUuid' "$candidate")"; serial="$(jq -er '.serial' "$candidate")"
  if [[ "$path" == "$TELEMETRY_SEAGATE_MOUNT/"* ]]; then
    [[ "$uuid" == "$TELEMETRY_SEAGATE_UUID" && "$serial" == "$TELEMETRY_SEAGATE_SERIAL" ]] || return 2
    ash_backup_require_portable_mount "$TELEMETRY_SEAGATE_MOUNT" || return 2
    local id="$(jq -er '.id' "$candidate")"
    [[ ! -e "$TELEMETRY_PORTABLE_BACKUP_ROOT/.retired/backup-$id.json" &&
       ! -e "$TELEMETRY_PORTABLE_BACKUP_ROOT/.retirement/backup-$id.intent.json" ]] || return 2
  elif [[ "$path" == "$TELEMETRY_HOME_STORAGE_ROOT/"* ]]; then
    ash_backup_validate_storage "$TELEMETRY_HOME_STORAGE_ROOT" "$TELEMETRY_HOME_STORAGE_MOUNT" \
      "$uuid" "$serial" "$TELEMETRY_HOME_STORAGE_FSTYPE" 'copy publication' || return 2
  else return 2; fi
  for expected in manifest sourceReceipt portableReceipt; do
    local key="$expected"
    [[ "$key" != manifest ]] || key=manifest
    local metadata="$(jq -er --arg key "${key}Path" '.[$key] // empty' "$candidate" || true)"
    [[ -n "$metadata" ]] || { [[ "$expected" == portableReceipt ]] && continue; return 2; }
    [[ -f "$metadata" && ! -L "$metadata" && "$(realpath -e "$metadata")" == "$metadata" ]] || return 2
    [[ "$(sha256sum "$metadata" | awk '{print $1}')" == "$(jq -er --arg key "${key}Sha256" '.[$key]' "$candidate")" ]] || return 2
  done
  root="$TELEMETRY_HOME_STORAGE_ROOT/.copy-verifications"
  [[ -d "$root" && ! -L "$root" && "$(stat -c '%u:%a' "$root")" == 0:700 ]] || return 2
  target="$root/$(printf '%s' "$path" | sha256sum | awk '{print $1}').json"
  temporary="$(mktemp "$root/.verification.XXXXXXXX")" || return 1
  install -o root -g root -m 0600 "$candidate" "$temporary" && sync -f "$temporary" &&
    mv -f -- "$temporary" "$target" && sync -f "$root"
}

ash_backup_legacy_portable_path() {
  local source_path="$1" storage_root="$2" seagate_mount="$3" file_name="$4"
  local relative candidate
  [[ "$source_path" == "$storage_root/"* ]] || return 1
  relative="${source_path#"$storage_root/"}"
  [[ -n "$relative" && "$relative" != /* && "$relative" != *'..'* &&
     "$relative" != *'//' && "$(basename -- "$source_path")" == "$file_name" ]] ||
    return 1
  candidate="$seagate_mount/$relative"
  [[ "$candidate" == "$seagate_mount/"* && "$candidate" != *'..'* &&
     "$candidate" != *'//' ]] || return 1
  printf '%s\n' "$candidate"
}

# Resolve a verified PostgreSQL artifact from either the new canonical archive
# namespace or the pre-cutover flat mirror.  A mapping sidecar, when present,
# is authoritative and is bound to the exact source receipt hash, source ACK,
# backup ID, file name, bytes, and digest.  A stale/conflicting sidecar fails
# closed rather than being replaced by a newly guessed path.
ash_backup_resolve_portable_database_path() {
  local source_receipt="$1" database_root="$2" storage_root="$3"
  local seagate_mount="$4" backup_id="$5" file_name="$6" expected_bytes="$7"
  local expected_sha="$8" verify_mode="${9:-fast}"
  local mapping_root mapping_path source_path source_ack receipt_sha candidate declared_portable
  local portable_root canonical_candidate portable_receipt
  [[ -f "$source_receipt" && ! -L "$source_receipt" ]] || return 1
  ash_backup_require_portable_mount "$seagate_mount" || return 1
  [[ "$backup_id" =~ ^[a-f0-9-]{36}$ &&
     "$file_name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,239}$ &&
     "$expected_bytes" =~ ^[1-9][0-9]*$ &&
     "$expected_sha" =~ ^[a-f0-9]{64}$ ]] || return 1
  portable_root="${TELEMETRY_PORTABLE_BACKUP_ROOT:-$seagate_mount/ash-atlas-backup-archive}"
  mapping_root="$database_root/.portable-mappings"
  mapping_path="$mapping_root/backup-$backup_id.json"
  source_path="$(jq -er '.remotePath // empty' "$source_receipt" 2>/dev/null || true)"
  declared_portable="$(jq -er '.portablePath // empty' "$source_receipt" 2>/dev/null || true)"
  source_ack="$(jq -er '.acknowledgmentId // empty' "$source_receipt" 2>/dev/null || true)"
  receipt_sha="$(sha256sum "$source_receipt" | awk '{print $1}')" || return 1
  [[ "$source_ack" =~ ^[a-f0-9-]{36}$ && "$receipt_sha" =~ ^[a-f0-9]{64}$ ]] || return 1

  if [[ -e "$mapping_path" || -L "$mapping_path" ]]; then
    [[ -f "$mapping_path" && ! -L "$mapping_path" ]] || return 1
    jq -e --arg id "$backup_id" --arg file "$file_name" \
      --arg source "$source_path" --arg ack "$source_ack" \
      --arg receiptSha "$receipt_sha" --arg sha "$expected_sha" \
      --argjson bytes "$expected_bytes" '
        .portableMappingVersion == 1
        and .backupId == $id
        and .backupFileName == $file
        and .sourcePath == $source
        and .sourceAcknowledgmentId == $ack
        and .sourceReceiptSha256 == $receiptSha
        and .bytes == $bytes and .sha256 == $sha
        and (.portablePath | type == "string")
      ' "$mapping_path" >/dev/null || return 1
    candidate="$(jq -er '.portablePath' "$mapping_path")" || return 1
  else
    candidate="$(jq -er '.portablePath // empty' "$source_receipt" 2>/dev/null || true)"
    if [[ -z "$candidate" ]]; then
      if [[ "$source_path" == "$seagate_mount/"* ]]; then
        candidate="$source_path"
      else
        # A newly committed archive keeps the source receipt's immutable
        # intake remotePath. Recover its deterministic canonical placement
        # after a crash between portable commit and mapping publication; the
        # caller persists this earned location before acknowledging the VPS.
        if [[ "$portable_root" == "$seagate_mount/"* &&
              "$portable_root" != *'//' && "$portable_root" != *'/../'* &&
              "$portable_root" != *'/./'* ]]; then
          canonical_candidate="$portable_root/postgresql/backup-$backup_id/$file_name"
          if [[ -f "$canonical_candidate" && ! -L "$canonical_candidate" ]]; then
            candidate="$canonical_candidate"
          fi
        fi
        if [[ -z "$candidate" ]]; then
          candidate="$(ash_backup_legacy_portable_path "$source_path" \
            "$storage_root" "$seagate_mount" "$file_name" || true)"
        fi
      fi
    fi
  fi
  [[ "$candidate" == "$seagate_mount/"* && "$candidate" != *'..'* &&
     "$candidate" != *'//' && -f "$candidate" && ! -L "$candidate" &&
     "$(realpath -e -- "$candidate")" == "$candidate" ]] || return 1
  [[ "$(stat -c '%s' "$candidate")" == "$expected_bytes" ]] || return 1
  # A canonical portable receipt is the durable catalog proof produced by the
  # commit helper. Legacy flat mappings, intake-relative remotePaths, and old
  # receipts without placement metadata still require an independent
  # pg_restore catalog read. The source receipt intentionally never carries
  # placement fields: it remains byte-identical for the deployed VPS protocol.
  if [[ "$candidate" == "$portable_root/postgresql/backup-$backup_id/$file_name" ]]; then
    portable_receipt="$portable_root/postgresql/backup-$backup_id/portable-receipt.json"
    ash_backup_validate_immutable_receipt "$portable_receipt" "$backup_id" \
      "$file_name" "$expected_bytes" "$expected_sha" || return 1
  else
    portable_receipt=''
  fi
  local verification_manifest="${ASH_ATLAS_BACKUP_VERIFICATION_MANIFEST:-}"
  if [[ -z "$verification_manifest" ]]; then
    verification_manifest="$(dirname -- "$candidate")/$file_name.ready.json"
    [[ -f "$verification_manifest" ]] || verification_manifest="$database_root/.verification-manifests/$file_name.ready.json"
  fi
  ash_backup_verify_copy fast postgresql "$backup_id" "$candidate" "$expected_bytes" "$expected_sha" \
    "$verification_manifest" "$source_receipt" "$portable_receipt" >/dev/null || {
    [[ "$verify_mode" == deep ]] || return 1
    ash_backup_verify_copy deep postgresql "$backup_id" "$candidate" "$expected_bytes" "$expected_sha" \
      "$verification_manifest" "$source_receipt" "$portable_receipt" >/dev/null || return 1
  }
  printf '%s\n' "$candidate"
}

# Persist the earned mapping for a source receipt. This is intentionally a
# HOME-only sidecar: changing the receipt would make the deployed VPS source-
# ACK replay fail its exact-byte comparison. A pre-existing map is validated
# by the resolver and never overwritten.
ash_backup_record_portable_mapping() {
  local source_receipt="$1" database_root="$2" storage_root="$3"
  local seagate_mount="$4" backup_id="$5" file_name="$6" expected_bytes="$7"
  local expected_sha="$8" portable_path="$9"
  local mapping_root mapping_path temporary source_path source_ack receipt_sha
  source_path="$(jq -er '.remotePath // empty' "$source_receipt" 2>/dev/null || true)"
  [[ "$source_path" == "$storage_root/"* ]] || return 0
  [[ "$portable_path" == "$seagate_mount/"* &&
     "$portable_path" != *'..'* && "$portable_path" != *'//' &&
     -f "$portable_path" && ! -L "$portable_path" &&
     "$(realpath -e -- "$portable_path")" == "$portable_path" &&
     "$(stat -c '%s' "$portable_path")" == "$expected_bytes" ]] ||
    return 1
  [[ "$(ash_backup_resolve_portable_database_path "$source_receipt" "$database_root" "$storage_root" \
    "$seagate_mount" "$backup_id" "$file_name" "$expected_bytes" "$expected_sha")" == "$portable_path" ]] || return 1
  mapping_root="$database_root/.portable-mappings"
  mapping_path="$mapping_root/backup-$backup_id.json"
  source_ack="$(jq -er '.acknowledgmentId' "$source_receipt")" || return 1
  receipt_sha="$(sha256sum "$source_receipt" | awk '{print $1}')" || return 1
  if [[ -e "$mapping_path" || -L "$mapping_path" ]]; then
    jq -e --arg id "$backup_id" --arg file "$file_name" \
      --arg source "$source_path" --arg ack "$source_ack" \
      --arg receiptSha "$receipt_sha" --arg portable "$portable_path" \
      --arg sha "$expected_sha" --argjson bytes "$expected_bytes" '
        .portableMappingVersion == 1 and .backupId == $id
        and .backupFileName == $file and .sourcePath == $source
        and .sourceAcknowledgmentId == $ack and .sourceReceiptSha256 == $receiptSha
        and .portablePath == $portable and .bytes == $bytes and .sha256 == $sha
      ' "$mapping_path" >/dev/null || return 1
    return 0
  fi
  install -d -m 0700 "$mapping_root" || return 1
  temporary="$(mktemp "$mapping_root/.backup-$backup_id.XXXXXXXX")" || return 1
  if ! jq -cn --arg id "$backup_id" --arg file "$file_name" \
    --arg source "$source_path" --arg ack "$source_ack" \
    --arg receiptSha "$receipt_sha" --arg portable "$portable_path" \
    --arg sha "$expected_sha" --argjson bytes "$expected_bytes" '
      {portableMappingVersion:1,backupId:$id,backupFileName:$file,
       sourcePath:$source,sourceAcknowledgmentId:$ack,
       sourceReceiptSha256:$receiptSha,portablePath:$portable,
       bytes:$bytes,sha256:$sha}
    ' >"$temporary"; then
    rm -f -- "$temporary"
    return 1
  fi
  chmod 0600 "$temporary" || { rm -f -- "$temporary"; return 1; }
  sync -f "$temporary" || { rm -f -- "$temporary"; return 1; }
  mv -- "$temporary" "$mapping_path" || { rm -f -- "$temporary"; return 1; }
  sync -f "$mapping_root" || return 1
}

# Mark a newly managed source receipt as eligible for post-ACK intake release.
# This is HOME-only metadata: the source receipt itself is replayed byte-for-
# byte to the deployed VPS and therefore must not gain a retention field.  A
# legacy flat-copy adoption never calls this helper, so an operator can still
# perform the explicit legacy migration without a routine pull deleting its
# source.
ash_backup_mark_source_release_eligible() {
  local database_root="$1" backup_id="$2" file_name="$3" source_receipt="$4"
  local mapping_root mapping_path temporary receipt_sha
  [[ -d "$database_root" && ! -L "$database_root" ]] || return 1
  [[ "$backup_id" =~ ^[a-f0-9-]{36}$ &&
     "$file_name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,239}\.dump$ ]] || return 1
  [[ -f "$source_receipt" && ! -L "$source_receipt" ]] || return 1
  mapping_root="$database_root/.portable-mappings"
  mapping_path="$mapping_root/backup-$backup_id.json"
  [[ -f "$mapping_path" && ! -L "$mapping_path" ]] || return 1
  receipt_sha="$(sha256sum "$source_receipt" | awk '{print $1}')" || return 1
  jq -e --arg id "$backup_id" --arg file "$file_name" \
    --arg receiptSha "$receipt_sha" '
      .portableMappingVersion == 1 and .backupId == $id
      and .backupFileName == $file
      and .sourceReceiptSha256 == $receiptSha
      and (.portablePath | type == "string")
    ' "$mapping_path" >/dev/null || return 1
  if jq -e '.sourceRetentionPolicy == "emergency-only"' \
    "$mapping_path" >/dev/null; then
    return 0
  fi
  temporary="$(mktemp "$mapping_root/.backup-$backup_id.managed.XXXXXXXX")" || return 1
  if ! jq --arg markedAtUtc "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '.sourceRetentionPolicy = "emergency-only"
     | .sourceRetentionMarkedAtUtc = $markedAtUtc' \
    "$mapping_path" >"$temporary"; then
    rm -f -- "$temporary"
    return 1
  fi
  chmod 0600 "$temporary" || { rm -f -- "$temporary"; return 1; }
  sync -f "$temporary" || { rm -f -- "$temporary"; return 1; }
  mv -- "$temporary" "$mapping_path" || { rm -f -- "$temporary"; return 1; }
  sync -f "$mapping_root" || return 1
}

# Release exactly one managed intake dump after its VPS acknowledgment has
# succeeded.  Receipts and the portable mapping remain; the emergency tree is
# the bounded local recovery set.  A missing target is already-released state,
# while any mismatch or symlink fails closed rather than deleting an unknown
# file.
ash_backup_release_managed_source() {
  local database_root="$1" file_name="$2" expected_bytes="$3" expected_sha="$4"
  local source_path
  [[ -d "$database_root" && ! -L "$database_root" ]] || return 1
  [[ "$file_name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,239}\.dump$ &&
     "$expected_bytes" =~ ^[1-9][0-9]*$ &&
     "$expected_sha" =~ ^[a-f0-9]{64}$ ]] || return 1
  source_path="$database_root/$file_name"
  if [[ ! -e "$source_path" && ! -L "$source_path" ]]; then
    return 0
  fi
  [[ -f "$source_path" && ! -L "$source_path" &&
     "$(realpath -e -- "$source_path")" == "$source_path" &&
     "$(stat -c '%s' "$source_path")" == "$expected_bytes" ]] || return 1
  local source_receipt="$database_root/receipts/$file_name.receipt.json" backup_id manifest
  backup_id="$(jq -er '.backupId' "$source_receipt")" || return 1
  manifest="${ASH_ATLAS_BACKUP_VERIFICATION_MANIFEST:-$database_root/.verification-manifests/$file_name.ready.json}"
  ash_backup_verify_copy fast postgresql "$backup_id" "$source_path" "$expected_bytes" "$expected_sha" \
    "$manifest" "$source_receipt" '' >/dev/null || return 1
  rm -f -- "$source_path" || return 1
  rm -f -- "${TELEMETRY_HOME_STORAGE_ROOT}/.copy-verifications/$(printf '%s' "$source_path" | sha256sum | awk '{print $1}').json" || return 1
  sync -f "$database_root" || return 1
}

# Legacy callers use this stricter wrapper so an intake-relative receipt can
# only adopt its deterministic additive mirror path, never an arbitrary
# same-hash candidate.
ash_backup_record_legacy_portable_mapping() {
  local source_receipt="$1" database_root="$2" storage_root="$3"
  local seagate_mount="$4" backup_id="$5" file_name="$6" expected_bytes="$7"
  local expected_sha="$8" portable_path="$9" source_path
  source_path="$(jq -er '.remotePath // empty' "$source_receipt" 2>/dev/null || true)"
  [[ "$source_path" == "$storage_root/"* ]] || return 0
  [[ "$(ash_backup_legacy_portable_path "$source_path" "$storage_root" \
      "$seagate_mount" "$file_name")" == "$portable_path" ]] || return 1
  ash_backup_record_portable_mapping "$@"
}

# Commit one verified PostgreSQL handoff to the portable archive.  The final
# directory is an immutable backup-ID namespace; a same-ID/different-hash
# retry is an error.  The caller sends the VPS acknowledgment only after this
# function returns successfully.  Output is the committed artifact path.
ash_backup_commit_portable_database() {
  local stage_dir="$1" portable_root="$2" backup_id="$3" file_name="$4"
  local manifest_path="$5" source_receipt="$6" archive_owner="$7"
  local minimum_free_bytes="$8" cap_bytes="$9" root_reserve_bytes="${10:-0}"
  local portable_database_root final work dump manifest portable_receipt portable_cwd portable_display_root
  local expected_bytes expected_sha source_ack_id backup_class committed_sha current_bytes
  [[ -d "$stage_dir" && ! -L "$stage_dir" ]] || return 1
  ash_backup_require_portable_root "$portable_root" "${TELEMETRY_SEAGATE_MOUNT:-/}" || return 1
  [[ "$backup_id" =~ ^[a-f0-9-]{36}$ ]] || return 1
  [[ "$file_name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,239}$ ]] || return 1
  [[ -f "$manifest_path" && ! -L "$manifest_path" ]] || return 1
  [[ -f "$source_receipt" && ! -L "$source_receipt" ]] || return 1
  ash_backup_positive_integer "$minimum_free_bytes" || return 1
  ash_backup_nonnegative_integer "$cap_bytes" || return 1
  ash_backup_nonnegative_integer "$root_reserve_bytes" || return 1
  portable_display_root="$portable_root"
  portable_cwd="$PWD"
  cd "$portable_root" || return 1
  # All archive directory creation and rename operations below are relative
  # to the already-opened mount directory.  If the mount disappears now, a
  # path-based mkdir cannot recreate the archive on the underlying root.
  ash_backup_require_portable_mount "${TELEMETRY_SEAGATE_MOUNT:-/}" || return 1
  portable_pin_cleanup() {
    cd "$portable_cwd" >/dev/null 2>&1 || return 1
  }
  trap portable_pin_cleanup RETURN

  expected_bytes="$(jq -er --arg id "$backup_id" --arg file "$file_name" \
    'select(.backupId == $id and .artifact.fileName == $file) | .artifact.bytes' \
    "$manifest_path")" || return 1
  expected_sha="$(jq -er --arg id "$backup_id" --arg file "$file_name" \
    'select(.backupId == $id and .artifact.fileName == $file) | .artifact.sha256' \
    "$manifest_path")" || return 1
  ash_backup_positive_integer "$expected_bytes" || return 1
  [[ "$expected_sha" =~ ^[a-f0-9]{64}$ ]] || return 1
  source_ack_id="$(jq -er '.acknowledgmentId' "$source_receipt")" || return 1
  [[ "$source_ack_id" =~ ^[a-f0-9-]{36}$ ]] || return 1
  backup_class="$(jq -er '.backupClass' "$manifest_path")" || return 1
  [[ "$backup_class" =~ ^(hourly|daily|weekly|monthly|pre-migration|milestone)$ ]] || return 1

  dump="$stage_dir/$file_name"
  [[ -f "$dump" && ! -L "$dump" && "$(stat -c '%s' "$dump")" == "$expected_bytes" ]] || return 1

  portable_database_root='postgresql'
  final="$portable_database_root/backup-$backup_id"
  portable_receipt="$final/portable-receipt.json"
  # Keep every destination operation relative to the pinned mount cwd.  An
  # absolute mkdir here could recreate the mountpoint on the root filesystem
  # after an unplug between validation and directory creation.
  install -d -m 0750 "$portable_database_root" || return 1
  ash_backup_require_portable_mount "${TELEMETRY_SEAGATE_MOUNT:-/}" || return 1

  if [[ -e "$final" ]]; then
    [[ -d "$final" && ! -L "$final" &&
       "$(realpath -e -- "$final")" == "$portable_display_root/$final" ]] || return 1
    [[ -f "$final/$file_name" && ! -L "$final/$file_name" &&
       -f "$final/$(basename -- "$manifest_path")" &&
       -f "$final/source-receipt.json" && -f "$portable_receipt" ]] || return 1
    [[ "$(stat -c '%s' "$final/$file_name")" == "$expected_bytes" ]] || return 1
    ash_backup_validate_immutable_receipt "$portable_receipt" "$backup_id" \
      "$file_name" "$expected_bytes" "$expected_sha" || return 1
    ash_backup_verify_copy fast postgresql "$backup_id" "$portable_display_root/$final/$file_name" \
      "$expected_bytes" "$expected_sha" "$portable_display_root/$final/$(basename -- "$manifest_path")" \
      "$source_receipt" "$portable_display_root/$portable_receipt" >/dev/null || return 1
    printf '%s\n' "$portable_display_root/postgresql/backup-$backup_id/$file_name"
    return 0
  fi

  current_bytes="$(ash_backup_path_bytes "$portable_root")" || return 1
  if (( cap_bytes > 0 )); then
    (( current_bytes <= cap_bytes )) || return 1
    (( current_bytes + expected_bytes <= cap_bytes )) || {
      echo "portable archive cap exhausted: current=${current_bytes} incoming=${expected_bytes} cap=${cap_bytes}" >&2
      return 1
    }
  fi
  ash_backup_require_root_headroom "$portable_root" "$expected_bytes" \
    "$root_reserve_bytes" 95 || return 1
  local available total_bytes dynamic_minimum_free
  read -r available total_bytes < <(df -PB1 -- "$portable_root" | awk 'NR == 2 {print $4, $2}') || return 1
  ash_backup_nonnegative_integer "$available" || return 1
  ash_backup_positive_integer "$total_bytes" || return 1
  dynamic_minimum_free=$((total_bytes / 10))
  (( dynamic_minimum_free > minimum_free_bytes )) || dynamic_minimum_free=$minimum_free_bytes
  (( available >= dynamic_minimum_free + expected_bytes )) || {
    echo 'portable archive lacks required free space' >&2
    return 1
  }

  work="$(mktemp -d "$portable_database_root/.backup-${backup_id}.XXXXXXXX")" || return 1
  cleanup_portable_work() {
    local status="$?"
    rm -rf -- "$work" || return 1
    cd "$portable_cwd" >/dev/null 2>&1 || return 1
    return "$status"
  }
  trap cleanup_portable_work RETURN
  cp -- "$dump" "$work/$file_name" || return 1
  cp -- "$manifest_path" "$work/$(basename -- "$manifest_path")" || return 1
  cp -- "$source_receipt" "$work/source-receipt.json" || return 1
  [[ "$(stat -c '%s' "$work/$file_name")" == "$expected_bytes" ]] || return 1
  jq -cn \
    --arg backupId "$backup_id" \
    --arg backupClass "$backup_class" \
    --arg manifestFileName "$(basename -- "$manifest_path")" \
    --arg backupFileName "$file_name" \
    --arg sourceAcknowledgmentId "$source_ack_id" \
    --arg portablePath "$portable_display_root/postgresql/backup-$backup_id/$file_name" \
    --arg sha256 "$expected_sha" \
    --argjson bytes "$expected_bytes" \
    --arg committedAtUtc "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '
      {
        portableReceiptVersion:1,
        event:"ash_atlas_postgresql_backup_portable_verified",
        backupId:$backupId,
        backupClass:$backupClass,
        manifestFileName:$manifestFileName,
        backupFileName:$backupFileName,
        bytes:$bytes,
        sha256:$sha256,
        sourceAcknowledgmentId:$sourceAcknowledgmentId,
        portablePath:$portablePath,
        portableCommittedAtUtc:$committedAtUtc,
        verification:"sha256-deep",
        restoreCatalogVerified:true
      }
    ' >"$work/portable-receipt.json" || return 1
  chmod 0600 "$work"/* || return 1
  if [[ "$archive_owner" =~ ^[A-Za-z_][A-Za-z0-9_.-]*:[A-Za-z_][A-Za-z0-9_.-]*$ ]]; then
    chown "$archive_owner" "$work"/* || return 1
  else
    return 1
  fi
  sync -f "$work/$file_name" || return 1
  sync -f "$work/$(basename -- "$manifest_path")" || return 1
  sync -f "$work/source-receipt.json" || return 1
  sync -f "$work/portable-receipt.json" || return 1
  sync -f "$work" || return 1
  ash_backup_require_portable_mount "${TELEMETRY_SEAGATE_MOUNT:-/}" || return 1
  mv -- "$work" "$final" || return 1
  ash_backup_require_portable_mount "${TELEMETRY_SEAGATE_MOUNT:-/}" || return 1
  sync -f "$portable_database_root" || return 1
  ash_backup_validate_immutable_receipt "$portable_receipt" "$backup_id" \
    "$file_name" "$expected_bytes" "$expected_sha" || return 1
  ash_backup_verify_copy deep postgresql "$backup_id" "$portable_display_root/$final/$file_name" \
    "$expected_bytes" "$expected_sha" "$portable_display_root/$final/$(basename -- "$manifest_path")" \
    "$source_receipt" "$portable_display_root/$portable_receipt" >/dev/null || return 1
  trap - RETURN
  cd "$portable_cwd" || return 1
  printf '%s\n' "$portable_display_root/postgresql/backup-$backup_id/$file_name"
}

ash_backup_commit_portable_reset() {
  local stage_dir="$1" portable_root="$2" operation_id="$3" file_name="$4"
  local manifest_path="$5" source_receipt="$6" archive_owner="$7"
  local minimum_free_bytes="$8" cap_bytes="$9" root_reserve_bytes="${10:-0}"
  local portable_reset_root final work dump portable_receipt expected_bytes expected_sha portable_cwd portable_display_root
  local source_ack_id committed_sha current_bytes available
  [[ -d "$stage_dir" && ! -L "$stage_dir" ]] || return 1
  ash_backup_require_portable_root "$portable_root" "${TELEMETRY_SEAGATE_MOUNT:-/}" || return 1
  [[ "$operation_id" =~ ^[a-f0-9-]{36}$ ]] || return 1
  [[ "$file_name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,239}$ ]] || return 1
  [[ -f "$manifest_path" && ! -L "$manifest_path" &&
     -f "$source_receipt" && ! -L "$source_receipt" ]] || return 1
  ash_backup_positive_integer "$minimum_free_bytes" || return 1
  ash_backup_nonnegative_integer "$cap_bytes" || return 1
  ash_backup_nonnegative_integer "$root_reserve_bytes" || return 1
  portable_cwd="$PWD"
  portable_display_root="$portable_root"
  cd "$portable_root" || return 1
  ash_backup_require_portable_mount "${TELEMETRY_SEAGATE_MOUNT:-/}" || return 1
  portable_pin_cleanup() {
    cd "$portable_cwd" >/dev/null 2>&1 || return 1
  }
  trap portable_pin_cleanup RETURN
  expected_bytes="$(jq -er --arg id "$operation_id" --arg file "$file_name" \
    'select(.operationId == $id and .artifact.fileName == $file) | .artifact.bytes' \
    "$manifest_path")" || return 1
  expected_sha="$(jq -er --arg id "$operation_id" --arg file "$file_name" \
    'select(.operationId == $id and .artifact.fileName == $file) | .artifact.sha256' \
    "$manifest_path")" || return 1
  ash_backup_positive_integer "$expected_bytes" || return 1
  [[ "$expected_sha" =~ ^[a-f0-9]{64}$ ]] || return 1
  source_ack_id="$(jq -er '.acknowledgmentId' "$source_receipt")" || return 1
  [[ "$source_ack_id" =~ ^[a-f0-9-]{36}$ ]] || return 1
  dump="$stage_dir/$file_name"
  [[ -f "$dump" && ! -L "$dump" && "$(stat -c '%s' "$dump")" == "$expected_bytes" ]] || return 1

  portable_reset_root='reset'
  final="$portable_reset_root/operation-$operation_id"
  portable_receipt="$final/portable-receipt.json"
  # See the database commit above: never recursively create archive paths via
  # an absolute mountpoint after the mount has been pinned.
  install -d -m 0750 "$portable_reset_root" || return 1
  ash_backup_require_portable_mount "${TELEMETRY_SEAGATE_MOUNT:-/}" || return 1
  if [[ -e "$final" ]]; then
    [[ -d "$final" && ! -L "$final" && -f "$final/$file_name" &&
       -f "$final/$(basename -- "$manifest_path")" &&
       -f "$final/source-receipt.json" && -f "$portable_receipt" ]] || return 1
    [[ "$(stat -c '%s' "$final/$file_name")" == "$expected_bytes" ]] || return 1
    ash_backup_verify_copy fast reset "$operation_id" "$portable_display_root/$final/$file_name" \
      "$expected_bytes" "$expected_sha" "$portable_display_root/$final/$(basename "$manifest_path")" \
      "$source_receipt" "$portable_display_root/$portable_receipt" >/dev/null || return 1
    jq -e --arg id "$operation_id" --arg file "$file_name" --arg sha "$expected_sha" \
      --argjson bytes "$expected_bytes" '
        .operationId == $id and .backupFileName == $file
        and .sha256 == $sha and .bytes == $bytes
        and .event == "ash_atlas_gameplay_reset_backup_portable_verified"
        and .portableReceiptVersion == 1 and .restoreCatalogVerified == true
      ' "$portable_receipt" >/dev/null || return 1
    printf '%s\n' "$portable_display_root/reset/operation-$operation_id/$file_name"
    return 0
  fi
  current_bytes="$(ash_backup_path_bytes "$portable_root")" || return 1
  if (( cap_bytes > 0 )); then
    (( current_bytes + expected_bytes <= cap_bytes )) || return 1
  fi
  ash_backup_require_root_headroom "$portable_root" "$expected_bytes" \
    "$root_reserve_bytes" 95 || return 1
  read -r available total_bytes < <(df -PB1 -- "$portable_root" | awk 'NR == 2 {print $4, $2}') || return 1
  ash_backup_nonnegative_integer "$available" || return 1
  ash_backup_positive_integer "$total_bytes" || return 1
  local dynamic_minimum_free=$((total_bytes / 10))
  (( dynamic_minimum_free > minimum_free_bytes )) || dynamic_minimum_free=$minimum_free_bytes
  (( available >= dynamic_minimum_free + expected_bytes )) || return 1
  work="$(mktemp -d "$portable_reset_root/.operation-${operation_id}.XXXXXXXX")" || return 1
  cleanup_portable_reset_work() {
    local status="$?"
    rm -rf -- "$work" || return 1
    cd "$portable_cwd" >/dev/null 2>&1 || return 1
    return "$status"
  }
  trap cleanup_portable_reset_work RETURN
  cp -- "$dump" "$work/$file_name" || return 1
  cp -- "$manifest_path" "$work/$(basename -- "$manifest_path")" || return 1
  cp -- "$source_receipt" "$work/source-receipt.json" || return 1
  [[ "$(stat -c '%s' "$work/$file_name")" == "$expected_bytes" ]] || return 1
  jq -cn \
    --arg operationId "$operation_id" \
    --arg manifestFileName "$(basename -- "$manifest_path")" \
    --arg backupFileName "$file_name" \
    --arg sourceAcknowledgmentId "$source_ack_id" \
    --arg portablePath "$portable_display_root/reset/operation-$operation_id/$file_name" \
    --arg sha256 "$expected_sha" --argjson bytes "$expected_bytes" \
    --arg portableCommittedAtUtc "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '
      {
        portableReceiptVersion:1,
        event:"ash_atlas_gameplay_reset_backup_portable_verified",
        operationId:$operationId,
        manifestFileName:$manifestFileName,
        backupFileName:$backupFileName,
        bytes:$bytes,
        sha256:$sha256,
        sourceAcknowledgmentId:$sourceAcknowledgmentId,
        portablePath:$portablePath,
        portableCommittedAtUtc:$portableCommittedAtUtc,
        verification:"sha256-deep",
        restoreCatalogVerified:true
      }
    ' >"$work/portable-receipt.json" || return 1
  chmod 0600 "$work"/* || return 1
  [[ "$archive_owner" =~ ^[A-Za-z_][A-Za-z0-9_.-]*:[A-Za-z_][A-Za-z0-9_.-]*$ ]] || return 1
  chown "$archive_owner" "$work"/* || return 1
  sync -f "$work/$file_name" || return 1
  sync -f "$work/$(basename -- "$manifest_path")" || return 1
  sync -f "$work/source-receipt.json" || return 1
  sync -f "$work/portable-receipt.json" || return 1
  sync -f "$work" || return 1
  ash_backup_require_portable_mount "${TELEMETRY_SEAGATE_MOUNT:-/}" || return 1
  mv -- "$work" "$final" || return 1
  ash_backup_require_portable_mount "${TELEMETRY_SEAGATE_MOUNT:-/}" || return 1
  sync -f "$portable_reset_root" || return 1
  ash_backup_verify_copy deep reset "$operation_id" "$portable_display_root/$final/$file_name" \
    "$expected_bytes" "$expected_sha" "$portable_display_root/$final/$(basename "$manifest_path")" \
    "$source_receipt" "$portable_display_root/$portable_receipt" >/dev/null || return 1
  jq -e --arg id "$operation_id" --arg file "$file_name" --arg sha "$expected_sha" \
    --argjson bytes "$expected_bytes" '
      .operationId == $id and .backupFileName == $file
      and .sha256 == $sha and .bytes == $bytes
      and .event == "ash_atlas_gameplay_reset_backup_portable_verified"
      and .portableReceiptVersion == 1 and .restoreCatalogVerified == true
    ' "$portable_receipt" >/dev/null || return 1
  trap - RETURN
  cd "$portable_cwd" || return 1
  printf '%s\n' "$portable_display_root/reset/operation-$operation_id/$file_name"
}

ash_backup_prune_emergency_dumps() {
  local root="$1" keep="${2:-2}" dump
  ash_backup_nonnegative_integer "$keep" || return 1
  [[ -d "$root" && ! -L "$root" ]] || return 1
  mapfile -t dumps < <(find "$root" -maxdepth 1 -type f -name '*.dump' \
    -printf '%T@|%p\n' | LC_ALL=C sort -nr | cut -d'|' -f2-)
  ((${#dumps[@]} <= keep)) && return 0
  for dump in "${dumps[@]:keep}"; do
    [[ "$dump" == "$root/"* && "$dump" != *'..'* ]] || return 1
    rm -f -- "$dump" || return 1
    rm -f -- "${TELEMETRY_HOME_STORAGE_ROOT}/.copy-verifications/$(printf '%s' "$dump" | sha256sum | awk '{print $1}').json" || return 1
  done
}
