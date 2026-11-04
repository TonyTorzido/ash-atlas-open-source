#!/usr/bin/env bash
set -euo pipefail
umask 077

fail() {
  printf 'STOP: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat >&2 <<'USAGE'
usage:
  ash-atlas-backup-migration.sh --audit --plan PATH
  ash-atlas-backup-migration.sh --apply --plan PATH --restore-proof PATH \
    --legacy-behavior-adapted
  ash-atlas-backup-migration.sh --cutover-plan --plan PATH --keep-list PATH
  ash-atlas-backup-migration.sh --cutover-apply --plan PATH --keep-list PATH

Audit writes only the exact plan artifact. Apply removes only the hash-verified
source dump paths listed in that plan. It never follows a wildcard, deletes a
directory, or deletes an unclassified legacy file.
Cutover modes are the independently authorized discard of old test-server
HOME copies. They use an exact stat plan/journal, preserve the keep-list and
unknown files, and do not claim a surviving verified twin or require a restore.
USAGE
  exit 2
}

mode=''
plan=''
restore_proof=''
legacy_adapted=false
keep_list=''
while (($#)); do
  case "$1" in
    --audit) [[ -z "$mode" ]] || usage; mode=audit ;;
    --apply) [[ -z "$mode" ]] || usage; mode=apply ;;
    --cutover-plan) [[ -z "$mode" ]] || usage; mode=cutover-plan ;;
    --cutover-apply) [[ -z "$mode" ]] || usage; mode=cutover-apply ;;
    --keep-list) shift; [[ $# -gt 0 ]] || usage; keep_list="$1" ;;
    --plan) shift; [[ $# -gt 0 ]] || usage; plan="$1" ;;
    --restore-proof) shift; [[ $# -gt 0 ]] || usage; restore_proof="$1" ;;
    --legacy-behavior-adapted) legacy_adapted=true ;;
    *) usage ;;
  esac
  shift
done
[[ -n "$mode" && -n "$plan" ]] || usage
if [[ "$mode" == apply ]]; then
  [[ -n "$restore_proof" && "$legacy_adapted" == true ]] ||
    fail 'apply requires --restore-proof and --legacy-behavior-adapted'
fi
[[ $EUID -eq 0 ]] || fail 'migration audit/apply must run as root'

env_file=/etc/ash-atlas/telemetry-home.env
if [[ -v TELEMETRY_HOME_ENV_FILE ]]; then env_file="$TELEMETRY_HOME_ENV_FILE"; fi
[[ -r "$env_file" && ! -L "$env_file" ]] || fail 'telemetry-home environment is absent'
# shellcheck disable=SC1090
source "$env_file"

: "$TELEMETRY_HOME_STORAGE_ROOT"
: "$TELEMETRY_HOME_STORAGE_MOUNT"
: "$TELEMETRY_HOME_STORAGE_UUID"
: "$TELEMETRY_HOME_STORAGE_SERIAL"
: "$TELEMETRY_HOME_STORAGE_FSTYPE"
: "$TELEMETRY_SEAGATE_MOUNT"
: "$TELEMETRY_SEAGATE_UUID"
: "$TELEMETRY_SEAGATE_SERIAL"
: "$ASH_ATLAS_DATABASE_BACKUP_REMOTE_DIRECTORY"
: "$ASH_ATLAS_RESET_BACKUP_REMOTE_DIRECTORY"
if [[ -v TELEMETRY_BACKUP_MIGRATION_LOCK ]]; then
  migration_lock="$TELEMETRY_BACKUP_MIGRATION_LOCK"
else
  migration_lock=/run/lock/ash-atlas-backup-migration.lock
fi
storage_root="$TELEMETRY_HOME_STORAGE_ROOT"
storage_mount="$TELEMETRY_HOME_STORAGE_MOUNT"
storage_uuid="$TELEMETRY_HOME_STORAGE_UUID"
storage_serial="$TELEMETRY_HOME_STORAGE_SERIAL"
storage_fstype="$TELEMETRY_HOME_STORAGE_FSTYPE"
seagate_mount="$TELEMETRY_SEAGATE_MOUNT"
seagate_uuid="$TELEMETRY_SEAGATE_UUID"
seagate_serial="$TELEMETRY_SEAGATE_SERIAL"
seagate_fstype=ntfs3
if [[ -v TELEMETRY_SEAGATE_FSTYPE ]]; then seagate_fstype="$TELEMETRY_SEAGATE_FSTYPE"; fi
database_root="$ASH_ATLAS_DATABASE_BACKUP_REMOTE_DIRECTORY"
reset_root="$ASH_ATLAS_RESET_BACKUP_REMOTE_DIRECTORY"
portable_root="$seagate_mount/ash-atlas-backup-archive"
if [[ -v TELEMETRY_PORTABLE_BACKUP_ROOT ]]; then portable_root="$TELEMETRY_PORTABLE_BACKUP_ROOT"; fi
aggregate_cap_bytes="${TELEMETRY_HOME_BACKUP_CAP_BYTES:-50000000000}"
[[ "$aggregate_cap_bytes" =~ ^[1-9][0-9]*$ ]] || fail 'home intake cap is invalid'
plan_state="$plan.apply-state.json"

[[ "$plan" =~ ^/[A-Za-z0-9._/-]+$ && "$plan" != / &&
   "$plan" != *'//' && "$plan" != *'/../'* && "$plan" != *'/./'* ]] ||
  fail 'plan path is unsafe'
[[ "$storage_root" =~ ^/[A-Za-z0-9._/-]+$ && "$storage_root" != / ]] ||
  fail 'home intake path is unsafe'
[[ "$database_root" == "$storage_root/"* && "$reset_root" == "$storage_root/"* ]] ||
  fail 'intake roots must remain under the configured home root'
[[ "$portable_root" == "$seagate_mount/"* ]] ||
  fail 'portable archive must remain under the configured portable mount'
[[ "$migration_lock" == /* && "$migration_lock" != / &&
   "$migration_lock" != *'//' && "$migration_lock" != *'/../'* &&
   "$migration_lock" != *'/./'* ]] || fail 'migration lock path is unsafe'

script_dir="$(cd -- "$(dirname -- "$0")" && pwd -P)"
if [[ -v ASH_ATLAS_BACKUP_COMMON ]]; then
  common="$ASH_ATLAS_BACKUP_COMMON"
else
  common="$script_dir/ash-atlas-backup-common.sh"
fi
if [[ ! -r "$common" ]]; then common=/usr/local/lib/ash-atlas/backup-common.sh; fi
[[ -r "$common" && ! -L "$common" ]] || fail 'backup common library is absent'
# shellcheck disable=SC1090
source "$common"

for command in awk basename chmod date dirname find flock head install jq mktemp \
  mountpoint mv pg_restore realpath rm sha256sum sort stat sync; do
  command -v "$command" >/dev/null || fail "required command is missing: $command"
done

exec 8>"$migration_lock" || fail 'migration lock cannot be opened'
flock -n 8 || fail 'another backup migration or writer holds the migration lock'

validate_intake() {
  ash_backup_validate_storage "$storage_root" "$storage_mount" "$storage_uuid" \
    "$storage_serial" "$storage_fstype" 'home intake' ||
    fail 'home intake identity is unsafe'
}

validate_portable() {
  ash_backup_validate_storage "$seagate_mount" "$seagate_mount" "$seagate_uuid" \
    "$seagate_serial" "$seagate_fstype" 'portable archive' ||
    fail 'portable identity is unsafe'
  [[ "$portable_root" == "$seagate_mount/"* &&
     "$portable_root" != *'..'* && "$portable_root" != *'//' &&
     "$portable_root" != *'/./'* ]] ||
    fail 'portable archive root is outside the validated portable mount'
  if [[ -d "$portable_root" && ! -L "$portable_root" ]]; then
    ash_backup_require_portable_root "$portable_root" "$seagate_mount" ||
      fail 'portable archive root is unsafe or mount identity changed'
    return
  fi
  [[ ! -e "$portable_root" && ! -L "$portable_root" ]] ||
    fail 'portable archive root is not a directory'
  portable_relative_root="${portable_root#"$seagate_mount/"}"
  [[ -n "$portable_relative_root" &&
     "$portable_relative_root" != */* &&
     "$portable_relative_root" != /* &&
     "$portable_relative_root" != *'..'* &&
     "$portable_relative_root" != *'//' &&
     "$portable_relative_root" != *'/./'* ]] ||
    fail 'portable archive root must be a direct child for safe bootstrap'
  if [[ "$mode" == audit || "$mode" == cutover-plan || "$mode" == cutover-apply ]]; then
    # The first audit may inspect the pre-cutover flat mirror without creating
    # a new namespace.  A missing canonical root is expected before install;
    # legacy candidates remain hash/catalog verified and independently pinned.
    printf 'portable canonical archive root is absent; auditing legacy mirror layout without creating it\n' >&2
    return
  fi
}

validate_intake
validate_portable
install -d -m 0700 "$(dirname -- "$plan")" || fail 'plan directory cannot be prepared'
inventory_work="$(mktemp -d /tmp/ash-atlas-backup-migration.XXXXXXXX)"
trap 'rm -rf -- "$inventory_work"' EXIT
for required_root in "$database_root" "$reset_root"; do
  [[ -d "$required_root" && ! -L "$required_root" ]] ||
    fail "required intake root is absent or unsafe: $required_root"
done
unsafe_inventory="$(find "$storage_root" -xdev \( -type l -o \( ! -type f ! -type d \) \) \
  -print -quit)" || fail 'complete intake inventory traversal failed'
[[ -z "$unsafe_inventory" ]] ||
  fail "intake contains a symlink or special file: $unsafe_inventory"

path_under() {
  local path="$1" root="$2" parent
  [[ "$path" == "$root/"* && "$path" != *'..'* &&
     "$path" != *'//' && "$path" != *'/./'* ]] || return 1
  if [[ -e "$path" || -L "$path" ]]; then
    [[ ! -L "$path" && "$(realpath -e -- "$path")" == "$path" ]]
    return
  fi
  # A completed DELETE_INTENT may legitimately leave the source absent on a
  # retry.  Validate the exact parent instead of requiring realpath -e on the
  # missing leaf; no missing or symlinked ancestor may be treated as safe.
  parent="$(dirname -- "$path")"
  [[ -d "$parent" && ! -L "$parent" &&
     "$(realpath -e -- "$parent")" == "$parent" ]]
}

# Explicitly authorized discard of old test-server HOME copies. This does
# not claim a verified surviving twin and never invokes a payload reader.
if [[ "$mode" == cutover-plan || "$mode" == cutover-apply ]]; then
  [[ -n "$keep_list" && -f "$keep_list" && ! -L "$keep_list" ]] || fail 'cutover requires exact keep-list'
  command -v systemctl >/dev/null || fail 'systemctl required to establish paused cutover'
  for unit in ash-atlas-telemetry-pull.timer ash-atlas-backup-mirror.timer ash-atlas-backup-scrub.timer \
    ash-atlas-seagate-mount.timer ash-atlas-backup-watchdog.timer ash-atlas-backup-restore-check.timer \
    ash-atlas-backup-prove.service ash-atlas-telemetry-pull.service ash-atlas-backup-mirror.service \
    ash-atlas-backup-scrub.service ash-atlas-backup-watchdog.service ash-atlas-seagate-mount.service \
    ash-atlas-backup-restore-check.service; do
    active="$(systemctl show "$unit" -p ActiveState --value)" || fail 'cannot establish cutover unit state'
    [[ "$active" == inactive || "$active" == failed ]] || fail "cutover requires paused unit: $unit"
    job="$(systemctl show "$unit" -p Job --value)" || fail 'cannot establish cutover queued jobs'
    [[ -z "$job" || "$job" == 0 ]] || fail "cutover requires no queued job: $unit"
  done
  command -v python3 >/dev/null || fail 'python3 is required for bounded metadata cutover'
  timeout --kill-after=5 300 python3 - "$mode" "$storage_root" "$plan" "$keep_list" "$aggregate_cap_bytes" <<'PY'
import datetime, json, os, re, stat, sys, time
mode, root, plan, keepfile, cap = sys.argv[1:]
cap = int(cap)
database = root + '/ash-atlas-database-backups'
reset = root + '/ash-atlas-reset-backups'
legacy = root + '/ash-atlas/deployment-pre-migration-archive/'
pattern = re.compile(r'ash_atlas_game-(?:hourly|daily|weekly|monthly|pre-migration|milestone|gameplay-reset)-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{40}-[a-f0-9-]{36}\.dump\Z')
telemetry = root + '/ash-atlas-telemetry/'
telemetry_limit = 8000000000
archive_pattern = re.compile(r'run-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}-([0-9]{8}T[0-9]{6}Z)\.duckdb\Z')
with open(keepfile) as stream:
    keep = {line.strip() for line in stream if line.strip()}
assert len([p for p in keep if p.startswith(database + '/') and p.endswith('.dump')]) >= 2, 'two recovery dumps required'
def identity(path):
    assert path.startswith(root + '/') and os.path.realpath(path) == path, 'unsafe path'
    value = os.lstat(path)
    assert stat.S_ISREG(value.st_mode) and value.st_dev == os.stat(root).st_dev, 'nonregular or different filesystem'
    return dict(path=path,bytes=value.st_size,inode=value.st_ino,mtimeNs=value.st_mtime_ns,ctimeNs=value.st_ctime_ns)
def discard_kind(path):
    directory,name=os.path.split(path)
    if directory in (database,reset,database+'/emergency',reset+'/emergency') and pattern.fullmatch(name):return 'old-dump'
    if path.startswith(legacy) and re.fullmatch(r'[A-Za-z0-9._/-]+',path[len(legacy):]) and name.endswith(('.dump','.json','.duckdb','.sha256','.sql','.gz','.csv','.log','.txt')):return 'old-legacy'
    partial=database+'/.partial/'
    if path.startswith(partial):
        relative=path[len(partial):].split('/')
        if len(relative)==2 and re.fullmatch(r'database\.[A-Za-z0-9]{8}',relative[0]) and relative[1].endswith('.partial') and pattern.fullmatch(relative[1][:-8]):return 'abandoned-database-partial'
    return None
def archive_date(path):
    if not path.startswith(telemetry+'archive/') or not re.fullmatch(r'[A-Za-z0-9._/-]+',path[len(telemetry+'archive/'):]):return None
    match=archive_pattern.fullmatch(os.path.basename(path))
    if not match:return None
    try:datetime.datetime.strptime(match[1],'%Y%m%dT%H%M%SZ')
    except ValueError:return None
    return match[1]
def publish(path, value):
    assert not os.path.islink(path) and not os.path.islink(os.path.dirname(path))
    temporary = path + '.partial'
    flags = os.O_CREAT | os.O_WRONLY | os.O_TRUNC | os.O_NOFOLLOW
    with os.fdopen(os.open(temporary, flags, 0o600), 'w') as stream:
        json.dump(value, stream); stream.flush(); os.fsync(stream.fileno())
    os.replace(temporary,path)
    fd=os.open(os.path.dirname(path),os.O_DIRECTORY); os.fsync(fd); os.close(fd)
if mode == 'cutover-plan':
    assert not os.path.exists(plan), 'existing immutable cutover plan requires resume/apply'
    records=[]; total=0; retained=0; unknown=[]; telemetry_bytes=0; archives=[]
    for directory, directories, files in os.walk(root, followlinks=False):
        assert os.path.realpath(directory)==directory and os.stat(directory).st_dev==os.stat(root).st_dev
        assert all(not os.path.islink(directory+'/'+name) for name in directories), 'linked directory'
        for name in files:
            path=directory+'/'+name; record=identity(path); total+=record['bytes']
            kind=discard_kind(path)
            if path not in keep and kind:
                record['removalKind']=kind
                records.append(record)
            else:
                retained+=record['bytes']
                if path.startswith(legacy) and not kind: unknown.append(path)
                if path.startswith(telemetry):
                    telemetry_bytes+=record['bytes']
                    date=archive_date(path)
                    if date and path not in keep:archives.append((date,path,record))
    telemetry_before=telemetry_bytes
    for date,path,record in sorted(archives):
        if telemetry_bytes<=telemetry_limit:break
        record['removalKind']='oldest-telemetry-archive';records.append(record)
        telemetry_bytes-=record['bytes'];retained-=record['bytes']
    assert telemetry_bytes<=telemetry_limit, f'protected/nonarchive telemetry {telemetry_bytes} cannot fit {telemetry_limit}'
    for path in keep: identity(path)
    reserve=34359738368; inflight=4294967296
    assert retained+reserve+inflight<=cap, f'mandatory HOME bytes {retained} + restore {reserve} + in-flight {inflight} exceed {cap}'
    publish(plan, dict(cutoverPlanVersion=1,storageRoot=root,keepPaths=sorted(keep),removals=records,
        beforeBytes=total,retainedBytes=retained,restoreReserveBytes=reserve,inflightReserveBytes=inflight,
        telemetryBeforeBytes=telemetry_before,telemetryRetainedBytes=telemetry_bytes,telemetryTargetBytes=telemetry_limit,
        unknownPinnedPaths=unknown,authorization='user authorized discarding old test-server Ash Atlas backups'))
    print(f'cutover plan beforeBytes={total} retainedBytes={retained} removals={len(records)} unknownPinned={len(unknown)}',flush=True)
else:
    with open(plan) as stream: data=json.load(stream)
    assert data['cutoverPlanVersion']==1 and data['storageRoot']==root and data['keepPaths']==sorted(keep)
    journal=plan+'.journal.jsonl'; intents={}; completed=set()
    if os.path.exists(journal):
        assert not os.path.islink(journal)
        with open(journal) as stream:
            for line in stream:
                event=json.loads(line); intents[event['path']]=event['identity']
                if event['stage']=='complete': completed.add(event['path'])
    with os.fdopen(os.open(journal,os.O_APPEND|os.O_CREAT|os.O_WRONLY|os.O_NOFOLLOW,0o600),'a') as stream:
        def event(record, stage):
            stream.write(json.dumps(dict(path=record['path'],identity=record,stage=stage))+'\n');stream.flush();os.fsync(stream.fileno())
        reclaimed=0
        for record in data['removals']:
            path=record['path']; assert path not in keep
            if path in completed:
                assert not os.path.lexists(path), 'retired path reappeared'; continue
            if not os.path.lexists(path):
                assert intents.get(path)==record, 'missing path has no exact deletion intent'
                event(record,'complete');continue
            assert identity(path)=={key:value for key,value in record.items() if key!='removalKind'}, 'planned file changed: '+path
            kind=record.get('removalKind')
            assert (kind==discard_kind(path) and kind is not None) or (kind=='oldest-telemetry-archive' and archive_date(path)), 'planned path is no longer allowlisted'
            assert os.path.realpath(root)==root, 'intake changed'
            event(record,'delete-intent');os.unlink(path)
            fd=os.open(os.path.dirname(path),os.O_DIRECTORY);os.fsync(fd);os.close(fd)
            event(record,'complete');reclaimed+=record['bytes']
            print(f'cutover removed path={path} bytes={record["bytes"]} reclaimedThisRun={reclaimed}',flush=True)
        total=sum(os.stat(directory+'/'+name).st_size for directory,_,files in os.walk(root) for name in files)
        telemetry_after=sum(os.stat(directory+'/'+name).st_size for directory,_,files in os.walk(telemetry) for name in files)
        assert telemetry_after<=telemetry_limit, f'telemetry remains above target: {telemetry_after}'
        assert total+34359738368+4294967296<=cap, f'HOME still exceeds reserved peak: {total}'
        print(f'cutover cleanup complete afterBytes={total} reclaimedThisRun={reclaimed} cap={cap}',flush=True)
PY
  exit 0
fi

file_record() {
  local path="$1" class="$2" removal="$3" candidate="$4" receipt="$5"
  local trusted_sha='' trusted_bytes='' bytes sha
  if [[ $# -ge 6 ]]; then trusted_sha="$6"; fi
  if [[ $# -ge 7 ]]; then trusted_bytes="$7"; fi
  [[ -f "$path" && ! -L "$path" ]] || fail "inventory path is not a regular file: $path"
  bytes="$(stat -c '%s' "$path")"
  if [[ -n "$trusted_sha" && -n "$trusted_bytes" ]]; then
    [[ "$bytes" == "$trusted_bytes" ]] || fail "trusted receipt byte count differs: $path"
    sha="$trusted_sha"
  else
    sha="$(sha256sum "$path" | awk '{print $1}')"
  fi
  jq -cn --arg path "$path" --arg class "$class" --arg removal "$removal" \
    --arg candidate "$candidate" --arg receipt "$receipt" --arg sha256 "$sha" \
    --argjson bytes "$bytes" '
      {path:$path,class:$class,bytes:$bytes,sha256:$sha256,
       removalEligible:($removal == "true"),
       portableKeeper:(if $candidate == "" then null else $candidate end),
       sourceReceipt:(if $receipt == "" then null else $receipt end)}
    '
}

portable_candidate() {
  local source="$1" file_name="$2" receipt="$3" expected_sha="$4" expected_bytes="$5"
  local candidate id source_root source_size source_sha possible legacy_root legacy_list
  candidate=''
  if [[ -f "$receipt" && ! -L "$receipt" ]]; then
    id="$(jq -er '.backupId // .operationId // empty' "$receipt" || true)"
    if [[ "$id" =~ ^[a-f0-9-]{36}$ ]]; then
      if [[ "$source" == "$database_root/"* ]]; then
        # Legacy receipts keep their original intake remotePath.  Resolve the
        # validated mirror path without mutating that receipt; the apply phase
        # persists the earned mapping before removing the source.
        candidate="$(ash_backup_resolve_portable_database_path \
          "$receipt" "$database_root" "$storage_root" "$seagate_mount" \
          "$id" "$file_name" "$expected_bytes" "$expected_sha" || true)"
      else
        candidate="$portable_root/reset/operation-$id/$file_name"
      fi
    fi
  fi
  if [[ -z "$candidate" || ! -f "$candidate" || -L "$candidate" ]]; then
    source_root="$(dirname -- "$source")"
    [[ "$source_root" == "$storage_root/"* ]] || return 1
    # The legacy mirror preserves the intake path relative to its source
    # root.  Using only a basename would search the wrong directory for files
    # nested under deployment archives and could falsely classify them as
    # unportable.
    legacy_root="$seagate_mount/${source_root#"$storage_root/"}"
    source_size="$expected_bytes"
    source_sha="$expected_sha"
    candidate=''
    if [[ -d "$legacy_root" && ! -L "$legacy_root" ]]; then
      legacy_list="$inventory_work/legacy-$(basename "$source").list"
      find "$legacy_root" -type f -name "$file_name" -print >"$legacy_list" ||
        return 1
      while IFS= read -r possible; do
        [[ -f "$possible" && ! -L "$possible" ]] || continue
        if [[ "$(stat -c '%s' "$possible")" == "$source_size" &&
              "$(sha256sum "$possible" | awk '{print $1}')" == "$source_sha" ]]; then
          [[ -z "$candidate" ]] || return 1
          candidate="$possible"
        fi
      done <"$legacy_list"
    fi
  fi
  [[ -n "$candidate" && -f "$candidate" && ! -L "$candidate" ]] || return 1
  [[ "$candidate" == "$portable_root/"* || "$candidate" == "$seagate_mount/"* ]] || return 1
  [[ "$(stat -c '%s' "$candidate")" == "$expected_bytes" ]] || return 1
  [[ "$(sha256sum "$candidate" | awk '{print $1}')" == "$expected_sha" ]] || return 1
  pg_restore --list "$candidate" >/dev/null || return 1
  printf '%s\n' "$candidate"
}

portable_mirror_candidate() {
  local source="$1" expected_sha="$2" expected_bytes="$3" relative candidate
  [[ "$source" == "$storage_root/"* ]] || return 1
  relative="${source#"$storage_root/"}"
  [[ -n "$relative" && "$relative" != /* && "$relative" != *'..'* ]] || return 1
  candidate="$seagate_mount/$relative"
  [[ "$candidate" == "$seagate_mount/"* &&
     -f "$candidate" && ! -L "$candidate" &&
     "$(realpath -e -- "$candidate")" == "$candidate" ]] || return 1
  [[ "$(stat -c '%s' "$candidate")" == "$expected_bytes" &&
     "$(sha256sum "$candidate" | awk '{print $1}')" == "$expected_sha" ]] || return 1
  printf '%s\n' "$candidate"
}

source_record() {
  local source="$1" class="$2" file_name receipt candidate removal
  local trusted_bytes trusted_sha source_bytes source_sha
  file_name="$(basename -- "$source")"
  receipt=''
  if [[ "$class" == database ]]; then receipt="$database_root/receipts/$file_name.receipt.json"
  else receipt="$reset_root/receipts/$file_name.receipt.json"; fi
  source_bytes="$(stat -c '%s' "$source")"
  source_sha="$(sha256sum "$source" | awk '{print $1}')"
  candidate=''
  removal=false
  if [[ -f "$receipt" && ! -L "$receipt" ]]; then
    trusted_bytes="$(jq -er '.bytes' "$receipt" || true)"
    trusted_sha="$(jq -er '.sha256' "$receipt" || true)"
    if [[ "$trusted_bytes" =~ ^[1-9][0-9]*$ &&
          "$trusted_sha" =~ ^[a-f0-9]{64}$ &&
          "$source_bytes" == "$trusted_bytes" &&
          "$source_sha" == "$trusted_sha" ]]; then
      if [[ "$class" == database ]]; then
        jq -e --arg file "$file_name" --argjson bytes "$trusted_bytes" \
          --arg sha "$trusted_sha" '
            .acknowledgmentVersion == 1
            and .event == "ash_atlas_postgresql_backup_verified"
            and .backupFileName == $file and .bytes == $bytes and .sha256 == $sha
            and (.backupId | test("^[a-f0-9-]{36}$"))
            and (.acknowledgmentId | test("^[a-f0-9-]{36}$"))
            and .restoreCatalogVerified == true
          ' "$receipt" >/dev/null || {
            file_record "$source" "$class" false '' "$receipt" "$source_sha" "$source_bytes"
            return 0
          }
      else
        jq -e --arg file "$file_name" --argjson bytes "$trusted_bytes" \
          --arg sha "$trusted_sha" '
            .acknowledgmentVersion == 1
            and .event == "ash_atlas_gameplay_reset_backup_verified"
            and .backupFileName == $file and .bytes == $bytes and .sha256 == $sha
            and (.operationId | test("^[a-f0-9-]{36}$"))
            and (.acknowledgmentId | test("^[a-f0-9-]{36}$"))
            and .restoreCatalogVerified == true
          ' "$receipt" >/dev/null || {
            file_record "$source" "$class" false '' "$receipt" "$source_sha" "$source_bytes"
            return 0
          }
      fi
      candidate="$(portable_candidate "$source" "$file_name" "$receipt" \
        "$trusted_sha" "$trusted_bytes" || true)"
      [[ -n "$candidate" ]] && removal=true
    fi
  fi
  file_record "$source" "$class" "$removal" "$candidate" "$receipt" \
    "$source_sha" "$source_bytes"
}

source_list="$inventory_work/sources.list"
find "$database_root" "$reset_root" -mindepth 1 -maxdepth 1 \
  -type f -name '*.dump' -print >"$source_list" ||
  fail 'database/reset inventory traversal failed'
inventory_records="$inventory_work/inventory.jsonl"
: >"$inventory_records"
while IFS= read -r source; do
  [[ -n "$source" ]] || continue
  if [[ "$source" == "$database_root/"* ]]; then record="$(source_record "$source" database)"
  else record="$(source_record "$source" reset)"; fi
  printf '%s\n' "$record" >>"$inventory_records"
done <"$source_list"

telemetry_root="$storage_root/ash-atlas-telemetry/archive"
if [[ -d "$telemetry_root" && ! -L "$telemetry_root" ]]; then
  telemetry_list="$inventory_work/telemetry.list"
  find "$telemetry_root" -type f -print >"$telemetry_list" ||
    fail 'telemetry archive inventory traversal failed'
  while IFS= read -r path; do
    [[ -n "$path" ]] || continue
    telemetry_bytes_for_file="$(stat -c '%s' "$path")" || fail "telemetry file stat failed: $path"
    telemetry_sha_for_file="$(sha256sum "$path" | awk '{print $1}')" ||
      fail "telemetry file checksum failed: $path"
    candidate="$(portable_mirror_candidate "$path" "$telemetry_sha_for_file" \
      "$telemetry_bytes_for_file" || true)"
    removal=false
    [[ -n "$candidate" ]] && removal=true
    file_record "$path" telemetry-archive "$removal" "$candidate" '' \
      "$telemetry_sha_for_file" "$telemetry_bytes_for_file" >>"$inventory_records"
  done <"$telemetry_list"
fi

legacy_root="$storage_root/ash-atlas/deployment-pre-migration-archive"
if [[ -d "$legacy_root" && ! -L "$legacy_root" ]]; then
  legacy_list="$inventory_work/deployment.list"
  find "$legacy_root" -type f -print >"$legacy_list" ||
    fail 'deployment archive inventory traversal failed'
  while IFS= read -r path; do
    [[ -n "$path" ]] || continue
    legacy_bytes_for_file="$(stat -c '%s' "$path")" || fail "legacy file stat failed: $path"
    legacy_sha_for_file="$(sha256sum "$path" | awk '{print $1}')" ||
      fail "legacy file checksum failed: $path"
    candidate="$(portable_mirror_candidate "$path" "$legacy_sha_for_file" \
      "$legacy_bytes_for_file" || true)"
    removal=false
    [[ -n "$candidate" ]] && removal=true
    file_record "$path" legacy-archive "$removal" "$candidate" '' \
      "$legacy_sha_for_file" "$legacy_bytes_for_file" >>"$inventory_records"
  done <"$legacy_list"
fi

inflight_list="$inventory_work/inflight.list"
: >"$inflight_list"
for optional_root in "$database_root/.partial" "$database_root/.spool" \
  "$database_root/emergency" "$reset_root/.partial" "$reset_root/.spool" \
  "$reset_root/emergency"; do
  if [[ -d "$optional_root" && ! -L "$optional_root" ]]; then
    find "$optional_root" -type f -print >>"$inflight_list" ||
      fail "in-flight inventory traversal failed: $optional_root"
  fi
done
while IFS= read -r path; do
  [[ -n "$path" ]] || continue
  file_record "$path" in-flight false '' '' >>"$inventory_records"
done < <(sort "$inflight_list")

# Complete the inventory with every other regular file under the dedicated
# intake root (receipts, manifests, state, and unknown legacy material).  The
# source/telemetry/deployment loops above already account for their selected
# paths, so this pass skips those exact roots/files instead of hashing the
# large source trees again.  Unknown metadata is pinned by default.
all_files="$inventory_work/all-files.list"
find "$storage_root" -xdev -type f -print >"$all_files" ||
  fail 'complete intake inventory traversal failed'
while IFS= read -r path; do
  [[ -n "$path" ]] || continue
  if [[ "$path" == "$database_root/"*.dump ||
        "$path" == "$reset_root/"*.dump ||
        "$path" == "$telemetry_root/"* ||
        ( -n "${legacy_root:-}" && "$path" == "$legacy_root/"* ) ||
        "$path" == "$database_root/.partial/"* ||
        "$path" == "$database_root/.spool/"* ||
        "$path" == "$database_root/emergency/"* ||
        "$path" == "$reset_root/.partial/"* ||
        "$path" == "$reset_root/.spool/"* ||
        "$path" == "$reset_root/emergency/"* ]]; then
    continue
  fi
  file_record "$path" metadata false '' '' >>"$inventory_records"
done <"$all_files"

inventory_file="$inventory_work/inventory.json"
removal_file="$inventory_work/removals.json"
# Inventories exceed Linux's per-argument limit well before the whole process
# argv limit. Keep the payload in files; only small scalar counts use argv.
jq -s '.' "$inventory_records" >"$inventory_file" || fail 'inventory serialization failed'
jq '[.[] | select(.removalEligible)]' "$inventory_file" >"$removal_file" ||
  fail 'removal serialization failed'
inventory_array="$(<"$inventory_file")"
removal_array="$(<"$removal_file")"
keeper_count="$(jq 'map(select(.removalEligible | not)) | length' <<<"$inventory_array")"
keeper_bytes="$(jq '[.[] | select(.removalEligible | not) | .bytes] | add // 0' <<<"$inventory_array")"
removal_count="$(jq 'length' <<<"$removal_array")"
removal_bytes="$(jq '[.[].bytes] | add // 0' <<<"$removal_array")"
aggregate_bytes="$(jq '[.[].bytes] | add // 0' <<<"$inventory_array")"
projected_bytes="$(jq --argjson removed "$removal_bytes" \
  '([.[].bytes] | add // 0) - $removed' <<<"$inventory_array")"
generated_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
legacy_archive_count="$(jq '[.[] | select(.class == "legacy-archive")] | length' <<<"$inventory_array")"
legacy_archive_bytes="$(jq '[.[] | select(.class == "legacy-archive") | .bytes] | add // 0' <<<"$inventory_array")"
telemetry_archive_count="$(jq '[.[] | select(.class == "telemetry-archive")] | length' <<<"$inventory_array")"
telemetry_archive_bytes="$(jq '[.[] | select(.class == "telemetry-archive") | .bytes] | add // 0' <<<"$inventory_array")"
legacy_unknown_count="$(jq '[.[] | select((.class == "telemetry-archive" or .class == "legacy-archive") and (.removalEligible | not))] | length' <<<"$inventory_array")"
unclassified_count="$(jq '[.[] | select(.class == "metadata")] | length' <<<"$inventory_array")"

if [[ "$mode" == audit ]]; then
  temporary="$plan.partial"
  jq -cn --arg generatedAtUtc "$generated_at" --arg storageRoot "$storage_root" \
    --arg databaseRoot "$database_root" --arg resetRoot "$reset_root" \
    --arg portableRoot "$portable_root" --slurpfile inventory "$inventory_file" \
    --slurpfile removals "$removal_file" --argjson keeperCount "$keeper_count" \
    --argjson removalCount "$removal_count" --argjson removalBytes "$removal_bytes" \
    --argjson legacyUnknownCount "$legacy_unknown_count" \
    --argjson legacyArchiveCount "$legacy_archive_count" \
    --argjson legacyArchiveBytes "$legacy_archive_bytes" \
    --argjson telemetryArchiveCount "$telemetry_archive_count" \
    --argjson telemetryArchiveBytes "$telemetry_archive_bytes" \
    --argjson unclassifiedCount "$unclassified_count" \
    --argjson aggregateBytes "$aggregate_bytes" \
    --argjson aggregateCapBytes "$aggregate_cap_bytes" \
    --argjson keeperBytes "$keeper_bytes" \
    --argjson projectedBytesAfterRemoval "$projected_bytes" '
      {migrationPlanVersion:1,mode:"dry-run",generatedAtUtc:$generatedAtUtc,
       storageRoot:$storageRoot,databaseRoot:$databaseRoot,resetRoot:$resetRoot,
       portableRoot:$portableRoot,legacyBehaviorAdapted:false,
       inventory:$inventory[0],removals:$removals[0],keeperCount:$keeperCount,
       removalCount:$removalCount,removalBytes:$removalBytes,
       legacyUnknownCount:$legacyUnknownCount,
       legacyArchiveCount:$legacyArchiveCount,legacyArchiveBytes:$legacyArchiveBytes,
       telemetryArchiveCount:$telemetryArchiveCount,telemetryArchiveBytes:$telemetryArchiveBytes,
       unclassifiedCount:$unclassifiedCount,
       aggregateBytes:$aggregateBytes,aggregateCapBytes:$aggregateCapBytes,
       keeperBytes:$keeperBytes,projectedBytesAfterRemoval:$projectedBytesAfterRemoval,
       capAchieved:($projectedBytesAfterRemoval <= $aggregateCapBytes),
       applyRequires:["portableKeeperChecksum","sourceChecksum","restoreProof",
                      "legacyBehaviorAdapted"]}
    ' >"$temporary" || fail 'plan write failed'
  chmod 0600 "$temporary" || fail 'plan permissions could not be set'
  sync -f "$temporary" || fail 'plan flush failed'
  mv -f -- "$temporary" "$plan" || fail 'plan publication failed'
  sync -f "$(dirname -- "$plan")" || fail 'plan directory flush failed'
  jq '.' "$plan"
  exit 0
fi

[[ -f "$plan" && ! -L "$plan" ]] || fail 'dry-run plan is absent or unsafe'
[[ -f "$restore_proof" && ! -L "$restore_proof" ]] ||
  fail 'disposable restore proof is absent or unsafe'
jq -e --arg storageRoot "$storage_root" --arg databaseRoot "$database_root" \
  --arg resetRoot "$reset_root" --arg portableRoot "$portable_root" '
  .migrationPlanVersion == 1 and .mode == "dry-run"
  and .storageRoot == $storageRoot and .databaseRoot == $databaseRoot
  and .resetRoot == $resetRoot and .portableRoot == $portableRoot
  and (.removals | type == "array")
' \
  "$plan" >/dev/null || fail 'migration plan is malformed'
jq -e '.aggregateCapBytes | type == "number" and . > 0' "$plan" >/dev/null ||
  fail 'migration plan has no fixed aggregate cap'
jq -e '.projectedBytesAfterRemoval <= .aggregateCapBytes and .capAchieved == true' \
  "$plan" >/dev/null ||
  fail 'migration plan remains above the fixed intake cap; classify and verify pinned legacy material first'
plan_sha="$(sha256sum "$plan" | awk '{print $1}')"
jq -e --arg planSha "$plan_sha" '
  .migrationRestoreProofVersion == 1
  and .restoreCheckVersion == 1
  and (.evidenceRoles | type == "array" and index("newest") != null and index("older") != null)
  and (.databaseNames | type == "array" and length >= 2)
  and (.restoredBackups | type == "array" and length >= 2)
  and .checksumsVerified == true
  and .portableSupersetVerified == true
  and .planSha256 == $planSha
  and (.verifiedAtUtc | fromdateiso8601)
' "$restore_proof" >/dev/null || fail 'restore proof does not match this plan'

proof_newest=false
proof_older=false
proof_newest_path=''
proof_older_path=''
while IFS=$'\t' read -r proof_role proof_path proof_sha proof_bytes; do
  [[ "$proof_role" == newest || "$proof_role" == older ]] ||
    fail 'restore proof evidence role is invalid'
  if [[ "$proof_role" == newest ]]; then
    [[ "$proof_newest" == false ]] || fail 'restore proof repeats newest evidence'
    proof_newest=true
    proof_newest_path="$proof_path"
  else
    [[ "$proof_older" == false ]] || fail 'restore proof repeats older evidence'
    proof_older=true
    proof_older_path="$proof_path"
  fi
  [[ "$proof_path" == /* && -f "$proof_path" && ! -L "$proof_path" &&
     "$(realpath -e -- "$proof_path")" == "$proof_path" &&
     "$proof_sha" =~ ^[a-f0-9]{64}$ && "$proof_bytes" =~ ^[1-9][0-9]*$ ]] ||
    fail 'restore proof portable evidence path or digest is invalid'
  [[ "$proof_path" == "$portable_root/"* ||
     "$proof_path" == "$seagate_mount/"* ]] ||
    fail 'restore proof path is outside the portable mount'
  [[ "$(stat -c '%s' "$proof_path")" == "$proof_bytes" &&
     "$(sha256sum "$proof_path" | awk '{print $1}')" == "$proof_sha" ]] ||
    fail "restore proof portable evidence changed: $proof_path"
  pg_restore --list "$proof_path" >/dev/null ||
    fail "restore proof portable evidence has an invalid catalog: $proof_path"
  jq -e --arg role "$proof_role" --arg path "$proof_path" --arg sha "$proof_sha" \
    --argjson bytes "$proof_bytes" '
      any(.restoredBackups[];
        .role == $role and .dumpPath == $path and .sha256 == $sha
        and .bytes == $bytes and .restoreCatalogVerified == true
        and .privateWal == true and .privateTablespaces == true
        and (.schemaCount | type == "number" and . > 0)
        and .postgisExtensionCount == 1
        and (.tableCount | type == "number" and . > 0)
        and (.representativeRowCount | type == "number" and . > 0))
    ' "$restore_proof" >/dev/null ||
    fail "restore proof entry is not an earned plan-bound evidence record: $proof_path"
  jq -e --arg path "$proof_path" --arg sha "$proof_sha" --argjson bytes "$proof_bytes" '
    any(.removals[];
      .removalEligible == true and .portableKeeper == $path
      and .sha256 == $sha and .bytes == $bytes)
  ' "$plan" >/dev/null || fail "restore proof keeper is absent from this plan: $proof_path"
done < <(jq -r '.restoredBackups[] | [.role,.dumpPath,.sha256,.bytes] | @tsv' "$restore_proof")
[[ "$proof_newest" == true && "$proof_older" == true &&
   "$proof_newest_path" != "$proof_older_path" ]] ||
  fail 'restore proof must contain distinct newest and older evidence'

if [[ ! -d "$portable_root" ]]; then
  portable_relative_root="${portable_root#"$seagate_mount/"}"
  [[ -n "$portable_relative_root" &&
     "$portable_relative_root" != */* &&
     "$portable_relative_root" != /* &&
     "$portable_relative_root" != *'..'* &&
     "$portable_relative_root" != *'//' &&
     "$portable_relative_root" != *'/./'* ]] ||
    fail 'portable archive root must be a direct child for safe bootstrap'
  # Apply is the reviewed mutation phase.  Create only the configured child
  # while the validated mount is the process cwd; never mkdir an absent mount
  # point on the root filesystem.  The post-create identity check closes the
  # unplug/replug window before keeper verification begins.
  (
    cd -- "$seagate_mount" || exit 1
    ash_backup_require_portable_mount "$seagate_mount" || exit 1
    install -d -m 0750 -- "$portable_relative_root" || exit 1
    ash_backup_require_portable_mount "$seagate_mount" || exit 1
    ash_backup_require_portable_root "$portable_root" "$seagate_mount"
  ) || fail 'portable archive root could not be safely bootstrapped on the validated mount'
fi
ash_backup_require_portable_root "$portable_root" "$seagate_mount" ||
  fail 'portable archive root is unsafe or mount identity changed before apply'

state_entries='[]'
if [[ -f "$plan_state" && ! -L "$plan_state" ]]; then
  state_entries="$(jq -e '
    if type == "array" then
      map(if type == "string" then
            {path:.,stage:"complete"}
          else . end)
    elif .applyStateVersion == 1 and (.entries | type == "array") then
      .entries
    else error("invalid apply state") end
  ' "$plan_state")" ||
    fail 'apply state is malformed'
fi

write_apply_state() {
  local entries="$1" temporary
  temporary="$plan_state.partial"
  jq -c '{applyStateVersion:1,entries:.}' <<<"$entries" >"$temporary" ||
    fail 'apply state write failed'
  chmod 0600 "$temporary" || fail 'apply state permissions failed'
  sync -f "$temporary" || fail 'apply state flush failed'
  mv -f -- "$temporary" "$plan_state" || fail 'apply state publication failed'
  sync -f "$(dirname -- "$plan_state")" || fail 'apply state directory flush failed'
}

verify_keeper() {
  local candidate="$1" expected_sha="$2" expected_bytes="$3" class="$4"
  [[ -n "$candidate" &&
     ( "$candidate" == "$portable_root/"* || "$candidate" == "$seagate_mount/"* ) ]] ||
    fail "planned portable keeper path is unsafe: $candidate"
  ash_backup_require_portable_root "$portable_root" "$seagate_mount" ||
    fail 'portable mount identity changed before keeper verification'
  [[ -f "$candidate" && ! -L "$candidate" &&
     "$(realpath -e -- "$candidate")" == "$candidate" ]] ||
    fail "portable keeper disappeared: $candidate"
  [[ "$(stat -c '%s' "$candidate")" == "$expected_bytes" &&
     "$(sha256sum "$candidate" | awk '{print $1}')" == "$expected_sha" ]] ||
    fail "portable keeper no longer matches: $candidate"
  if [[ "$class" == database || "$class" == reset ]]; then
    pg_restore --list "$candidate" >/dev/null ||
      fail "portable keeper restore catalog failed: $candidate"
  fi
  ash_backup_require_portable_root "$portable_root" "$seagate_mount" ||
    fail 'portable mount identity changed before retirement'
}

complete_state_entry() {
  local entries="$1" path="$2"
  jq -c --arg path "$path" '
    map(if .path == $path then .stage = "complete" else . end)
  ' <<<"$entries"
}

while IFS=$'\t' read -r path entry_class expected_sha expected_bytes candidate source_receipt; do
  [[ -n "$path" ]] || continue
  case "$entry_class" in
    database) path_under "$path" "$database_root" || fail "removal path is outside the database intake: $path" ;;
    reset) path_under "$path" "$reset_root" || fail "removal path is outside the reset intake: $path" ;;
    telemetry-archive) path_under "$path" "$telemetry_root" || fail "removal path is outside telemetry archive: $path" ;;
    legacy-archive) path_under "$path" "$legacy_root" || fail "removal path is outside legacy archive: $path" ;;
    *) fail "removal class is unsupported: $entry_class" ;;
  esac
  existing_state="$(jq -c --arg path "$path" '.[] | select(.path == $path)' \
    <<<"$state_entries" | head -n 1)"
  if [[ -n "$existing_state" ]]; then
    state_stage="$(jq -er '.stage' <<<"$existing_state")" ||
      fail "apply state entry is malformed: $path"
    state_sha="$(jq -er '.sha256 // empty' <<<"$existing_state")" || true
    state_bytes="$(jq -er '.bytes // empty' <<<"$existing_state")" || true
    state_candidate="$(jq -er '.portableKeeper // empty' <<<"$existing_state")" || true
    [[ "$state_stage" == delete-intent || "$state_stage" == complete ]] ||
      fail "apply state stage is invalid: $path"
    # Older development builds recorded completed paths as a bare string (or
    # {path,stage}) before immutable identity fields were added. Such state
    # is accepted only for a source that is already absent and only after the
    # current plan proves the exact portable keeper. Normalize it to the
    # current identity-bearing format before continuing so a later retry is
    # still crash-safe and cannot treat an unrelated missing source as done.
    if [[ "$state_stage" == complete &&
          ( -z "$state_sha" || -z "$state_bytes" || -z "$state_candidate" ) ]]; then
      [[ ! -e "$path" ]] || fail "legacy completed state source reappeared: $path"
      verify_keeper "$candidate" "$expected_sha" "$expected_bytes" "$entry_class"
      state_entries="$(jq -c --arg path "$path" --arg class "$entry_class" \
        --arg sha "$expected_sha" --argjson bytes "$expected_bytes" \
        --arg candidate "$candidate" \
        'map(if .path == $path then
               . + {class:$class,sha256:$sha,bytes:$bytes,portableKeeper:$candidate}
             else . end)' <<<"$state_entries")" ||
        fail "legacy apply state normalization failed: $path"
      write_apply_state "$state_entries"
      continue
    fi
    [[ "$state_sha" == "$expected_sha" && "$state_bytes" == "$expected_bytes" &&
       "$state_candidate" == "$candidate" ]] ||
      fail "apply state conflicts with the immutable plan: $path"
    verify_keeper "$candidate" "$expected_sha" "$expected_bytes" "$entry_class"
    if [[ "$state_stage" == complete ]]; then
      [[ ! -e "$path" ]] || fail "retired source reappeared after completion: $path"
      continue
    fi
    # A crash after DELETE_INTENT was flushed but before completion may have
    # left either the source or the exact keeper.  Reconcile only this
    # recorded identity; an unrelated missing source still fails closed.
    if [[ -e "$path" ]]; then
      [[ -f "$path" && ! -L "$path" &&
         "$(stat -c '%s' "$path")" == "$expected_bytes" &&
         "$(sha256sum "$path" | awk '{print $1}')" == "$expected_sha" ]] ||
        fail "recorded deletion intent source changed: $path"
      rm -f -- "$path" || fail "recorded source deletion failed: $path"
    fi
    [[ ! -e "$path" ]] || fail "recorded source deletion did not complete: $path"
    state_entries="$(complete_state_entry "$state_entries" "$path")" ||
      fail "apply state completion failed: $path"
    write_apply_state "$state_entries"
    continue
  fi

  [[ -f "$path" && ! -L "$path" ]] || fail "planned source changed or disappeared: $path"
  [[ "$(stat -c '%s' "$path")" == "$expected_bytes" ]] ||
    fail "planned source byte count changed: $path"
  [[ "$(sha256sum "$path" | awk '{print $1}')" == "$expected_sha" ]] ||
    fail "planned source checksum changed: $path"
  verify_keeper "$candidate" "$expected_sha" "$expected_bytes" "$entry_class"
  if [[ "$entry_class" == database && -n "$source_receipt" &&
        -f "$source_receipt" && ! -L "$source_receipt" ]]; then
    backup_id="$(jq -er '.backupId' "$source_receipt")" ||
      fail "database source receipt has no immutable backup ID: $path"
    file_name="$(basename -- "$path")"
    ash_backup_record_portable_mapping \
      "$source_receipt" "$database_root" "$storage_root" "$seagate_mount" \
      "$backup_id" "$file_name" "$expected_bytes" "$expected_sha" \
      "$candidate" || fail "legacy portable mapping could not be persisted: $path"
  fi
  # The intent is the durable transaction boundary.  It is flushed before
  # unlink so a crash cannot make the next run mistake an unknown missing
  # source for a completed retirement.
  state_entries="$(jq -c --arg path "$path" --arg class "$entry_class" --arg sha "$expected_sha" \
    --argjson bytes "$expected_bytes" --arg candidate "$candidate" \
    '. + [{path:$path,class:$class,sha256:$sha,bytes:$bytes,portableKeeper:$candidate,stage:"delete-intent"}]' \
    <<<"$state_entries")" || fail "apply state intent failed: $path"
  write_apply_state "$state_entries"
  rm -f -- "$path" || fail "planned source deletion failed: $path"
  [[ ! -e "$path" ]] || fail "planned source could not be retired: $path"
  state_entries="$(complete_state_entry "$state_entries" "$path")" ||
    fail "apply state completion failed: $path"
  write_apply_state "$state_entries"
done < <(jq -r '.removals[] |
  [.path,.class,.sha256,.bytes,.portableKeeper,(.sourceReceipt // "")] | @tsv' "$plan")

temporary="$plan.applied"
jq --arg appliedAtUtc "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --argjson removedCount "$(jq 'length' <<<"$state_entries")" \
  '. + {mode:"applied",appliedAtUtc:$appliedAtUtc,removedCount:$removedCount}' \
  "$plan" >"$temporary" || fail 'applied plan serialization failed'
chmod 0600 "$temporary" || fail 'applied plan permissions could not be set'
sync -f "$temporary" || fail 'applied plan flush failed'
mv -f -- "$temporary" "$plan" || fail 'applied plan publication failed'
sync -f "$(dirname -- "$plan")" || fail 'applied plan directory flush failed'
jq '.' "$plan"
