#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ $EUID -eq 0 ]] || {
  echo "run as root" >&2
  exit 1
}
[[ $# -eq 1 && -f "$1" ]] || {
  echo "usage: $0 /root/dedicated-home-pull-key.pub" >&2
  exit 2
}

pull_user="${TELEMETRY_PULL_USER:-ash-telemetry-pull}"
pull_group="${TELEMETRY_PULL_GROUP:-ash-telemetry-pull}"
source_script="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/telemetry-pull-command.sh"
install_path="/usr/local/libexec/ash-atlas-telemetry-pull-command"
export_root="/var/lib/ash-atlas/telemetry-exports"
ack_root="/var/lib/ash-atlas/telemetry-acknowledgments"
reset_root="/var/lib/ash-atlas/reset-backup-handoffs"
reset_ack_root="/var/lib/ash-atlas/reset-backup-acknowledgments"

getent group "$pull_group" >/dev/null || groupadd --system "$pull_group"
id "$pull_user" >/dev/null 2>&1 || useradd \
  --system --gid "$pull_group" --home-dir "/var/lib/${pull_user}" \
  --create-home --shell /bin/bash "$pull_user"
install -o root -g root -m 0755 "$source_script" "$install_path"
install -d -o root -g root -m 0700 "$export_root"
install -d -o root -g "$pull_group" -m 0730 "$ack_root"
install -d -o root -g root -m 0700 "$reset_root"
install -d -o root -g "$pull_group" -m 0730 "$reset_ack_root"
setfacl -m "u:${pull_user}:--x" \
  /var/lib/ash-atlas
setfacl -m "u:${pull_user}:r-x" "$export_root"
setfacl -m "u:${pull_user}:r-x" "$reset_root"

ssh_dir="/var/lib/${pull_user}/.ssh"
install -d -o "$pull_user" -g "$pull_group" -m 0700 "$ssh_dir"
key="$(tr -d '\r\n' <"$1")"
[[ "$key" =~ ^(ssh-ed25519|sk-ssh-ed25519@openssh.com)[[:space:]][A-Za-z0-9+/=]+([[:space:]].*)?$ ]] || {
  echo "only a dedicated Ed25519 public key is accepted" >&2
  exit 2
}
printf 'restrict,command="%s" %s\n' "$install_path" "$key" \
  >"${ssh_dir}/authorized_keys"
chown "$pull_user:$pull_group" "${ssh_dir}/authorized_keys"
chmod 0600 "${ssh_dir}/authorized_keys"

echo "Installed restricted pull account ${pull_user}."
echo "Set TELEMETRY_PULL_USER=${pull_user} in /etc/ash-atlas/telemetry-export.env."
