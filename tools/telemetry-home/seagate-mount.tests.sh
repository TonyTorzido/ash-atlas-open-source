#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
namespace="$(mktemp -d /tmp/ash-atlas-seagate-mount-test.XXXXXXXX)"
lock="/run/lock/ash-atlas-seagate-mount-test.$$.lock"
trap 'rm -rf -- "$namespace"; rm -f -- "$lock"' EXIT
mkdir -p "$namespace/bin" "$namespace/mount"
TEST_UUID=TEST-UUID
TEST_UUID_LINK="$namespace/by-uuid/$TEST_UUID"
mkdir -p "$(dirname "$TEST_UUID_LINK")"
: >"$namespace/test-seagate-partition"
ln -s "$namespace/test-seagate-partition" "$TEST_UUID_LINK"
export TEST_UUID
export TEST_UUID_LINK

cat >"$namespace/common.sh" <<'SH'
ash_backup_validate_storage() {
  [[ "$1" == "$TEST_MOUNT" && "$2" == "$TEST_MOUNT" &&
     "$3" == "$TEST_UUID" && "$4" == TEST-SERIAL && "$5" == ntfs3 &&
     "$6" == "Seagate mirror" && -e "$TEST_STATE" ]]
}
SH
cat >"$namespace/bin/mountpoint" <<'SH'
#!/usr/bin/env bash
[[ -e "$TEST_STATE" ]]
SH
cat >"$namespace/bin/systemd-escape" <<'SH'
#!/usr/bin/env bash
[[ "$1" == --path && "$2" == --suffix=mount && "$3" == -- && "$4" == "$TEST_MOUNT" ]] || exit 2
printf 'tmp-ash\\x2datlas\\x2dseagate.mount\n'
SH
cat >"$namespace/bin/systemctl" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$TEST_LOG"
if [[ "$1" == start && "$2" == 'tmp-ash\x2datlas\x2dseagate.mount' ]]; then
  : >"$TEST_STATE"
fi
SH
cat >"$namespace/bin/readlink" <<'SH'
#!/usr/bin/env bash
[[ "$1" == -f && "$2" == -- && "$3" == "$TEST_UUID_LINK" ]] || exit 2
printf '/dev/test-seagate-partition\n'
SH
cat >"$namespace/bin/blkid" <<'SH'
#!/usr/bin/env bash
[[ "$1" == -s && "$2" == UUID && "$3" == -o && "$4" == value &&
   "$5" == /dev/test-seagate-partition ]] || exit 2
printf '%s\n' "$TEST_BLKID_UUID"
SH
cat >"$namespace/bin/udevadm" <<'SH'
#!/usr/bin/env bash
[[ "$1" == info && "$2" == --query=property &&
   "$3" == --name=/dev/test-seagate-partition ]] || exit 2
printf 'ID_SERIAL_SHORT=%s\n' "$TEST_DEVICE_SERIAL"
SH
for command in findmnt jq; do
  cat >"$namespace/bin/$command" <<'SH'
#!/usr/bin/env bash
exit 0
SH
done
chmod 0755 "$namespace/bin/"*

export PATH="$namespace/bin:$PATH"
export TEST_MOUNT="$namespace/mount"
export TEST_STATE="$namespace/mounted"
export TEST_LOG="$namespace/systemctl.log"
export TEST_BLKID_UUID="$TEST_UUID"
export TEST_DEVICE_SERIAL=TEST-SERIAL
export TELEMETRY_SEAGATE_MOUNT="$TEST_MOUNT"
export TELEMETRY_SEAGATE_UUID="$TEST_UUID"
export TELEMETRY_SEAGATE_SERIAL=TEST-SERIAL
export TELEMETRY_TEST_MODE=true
export TELEMETRY_TEST_UUID_LINK="$TEST_UUID_LINK"
export ASH_ATLAS_BACKUP_COMMON="$namespace/common.sh"
export ASH_ATLAS_SEAGATE_MOUNT_LOCK="$lock"

bash "$script_dir/ash-atlas-seagate-mount.sh" >/dev/null
mapfile -t requests <"$TEST_LOG"
[[ ${#requests[@]} -eq 3 ]]
[[ "${requests[0]}" == 'start tmp-ash\x2datlas\x2dseagate.mount' ]]
[[ "${requests[1]}" == 'start --no-block ash-atlas-backup-mirror.service' ]]
[[ "${requests[2]}" == 'start --no-block ha-stack-health-check.service' ]]

rm -f "$TEST_STATE" "$TEST_LOG"
export TEST_BLKID_UUID=WRONG-UUID
if bash "$script_dir/ash-atlas-seagate-mount.sh" >/dev/null 2>&1; then
  echo 'attached UUID mismatch unexpectedly permitted a mount request' >&2
  exit 1
fi
[[ ! -e "$TEST_LOG" ]]

export TEST_BLKID_UUID="$TEST_UUID"
export TEST_DEVICE_SERIAL=WRONG-SERIAL
if bash "$script_dir/ash-atlas-seagate-mount.sh" >/dev/null 2>&1; then
  echo 'attached serial mismatch unexpectedly permitted a mount request' >&2
  exit 1
fi
[[ ! -e "$TEST_LOG" ]]

export TEST_DEVICE_SERIAL=TEST-SERIAL
export TELEMETRY_TEST_UUID_LINK=/etc/passwd
if bash "$script_dir/ash-atlas-seagate-mount.sh" >/dev/null 2>&1; then
  echo 'unsafe test UUID-link override unexpectedly accepted' >&2
  exit 1
fi
[[ ! -e "$TEST_LOG" ]]

export TELEMETRY_TEST_UUID_LINK="$TEST_UUID_LINK"
cat >"$namespace/bin/systemd-escape" <<'SH'
#!/usr/bin/env bash
printf '../unsafe.mount\n'
SH
chmod 0755 "$namespace/bin/systemd-escape"
if bash "$script_dir/ash-atlas-seagate-mount.sh" >/dev/null 2>&1; then
  echo 'unsafe generated mount unit unexpectedly accepted' >&2
  exit 1
fi
[[ ! -e "$TEST_LOG" ]]

echo 'Seagate mount tests passed'
