#!/usr/bin/env bash
set -euo pipefail

readonly STAGING=${1:-}
readonly EXPECTED_UPDATER_HASH=${2:-}
readonly EXPECTED_CONTROLLER_HASH=${3:-}
readonly EXPECTED_UNIT_HASH=${4:-}
readonly EXPECTED_STATUS_ROUTE_HASH=${5:-}
readonly EXPECTED_CONFIG_HASH=${6:-}
readonly EXPECTED_CACHE_POLICY_HASH=${7:-}
readonly EXPECTED_POLLER_HASH=${8:-}
readonly EXPECTED_REQUEST_SERVICE_HASH=${9:-}
readonly EXPECTED_REQUEST_TIMER_HASH=${10:-}
readonly EXPECTED_RECONCILE_SERVICE_HASH=${11:-}
readonly EXPECTED_RECONCILE_TIMER_HASH=${12:-}
readonly CADDY_FILE=/etc/caddy/Caddyfile
readonly CADDY_STATUS_ROUTE=/etc/caddy/deployment-status.caddy
readonly CADDY_CACHE_POLICY=/etc/caddy/game-cache-policy.caddy
readonly CADDY_STATUS_IMPORT='import /etc/caddy/deployment-status.caddy'
readonly CADDY_CACHE_IMPORT='import /etc/caddy/game-cache-policy.caddy'
readonly STATUS_ROOT=/var/lib/ash-atlas-deployment-status
readonly UPDATER_FILE=/home/debian/ops/ash-atlas-server/deploy-test-update.sh
readonly CONTROLLER_FILE=/home/debian/ops/ash-atlas-server/deploy-control.sh
readonly POLLER_FILE=/home/debian/ops/ash-atlas-server/poll-deployment-request.sh
readonly UNIT_FILE=/etc/systemd/system/ash-atlas-deploy@.service
readonly REQUEST_SERVICE_FILE=/etc/systemd/system/ash-atlas-deployment-request.service
readonly REQUEST_TIMER_FILE=/etc/systemd/system/ash-atlas-deployment-request.timer
readonly RECONCILE_SERVICE_FILE=/etc/systemd/system/ash-atlas-deployment-reconcile.service
readonly RECONCILE_TIMER_FILE=/etc/systemd/system/ash-atlas-deployment-reconcile.timer
readonly CONFIG_FILE=/etc/ash-atlas/deployment-controller.conf

fail() {
  printf 'STOP: %s\n' "$*" >&2
  exit 1
}

[[ ${EUID} -eq 0 ]] || fail 'release controller installation must run as root'
[[ "$STAGING" =~ ^/tmp/ash-atlas-release-v3\.[0-9]+$ ]] ||
  fail 'staging directory identity is unsafe'
for hash in "$EXPECTED_UPDATER_HASH" "$EXPECTED_CONTROLLER_HASH" "$EXPECTED_UNIT_HASH" \
    "$EXPECTED_STATUS_ROUTE_HASH" "$EXPECTED_CONFIG_HASH" "$EXPECTED_CACHE_POLICY_HASH" \
    "$EXPECTED_POLLER_HASH" "$EXPECTED_REQUEST_SERVICE_HASH" "$EXPECTED_REQUEST_TIMER_HASH" \
    "$EXPECTED_RECONCILE_SERVICE_HASH" "$EXPECTED_RECONCILE_TIMER_HASH"; do
  [[ "$hash" =~ ^[0-9a-f]{64}$ ]] || fail 'an expected installation hash is invalid'
done
[[ -d "$STAGING" && ! -L "$STAGING" ]] || fail 'staging directory is absent or unsafe'
for file in deploy-test-update.sh deploy-control.sh poll-deployment-request.sh \
    ash-atlas-deploy@.service ash-atlas-deployment-request.service \
    ash-atlas-deployment-request.timer ash-atlas-deployment-reconcile.service \
    ash-atlas-deployment-reconcile.timer deployment-status.caddy \
    deployment-controller.conf game-cache-policy.caddy; do
  [[ -f "$STAGING/$file" && ! -L "$STAGING/$file" ]] ||
    fail "staged file is absent or unsafe: $file"
done
[[ $(sha256sum "$STAGING/deploy-test-update.sh" | cut -d' ' -f1) = "$EXPECTED_UPDATER_HASH" ]] ||
  fail 'staged updater hash differs'
[[ $(sha256sum "$STAGING/deploy-control.sh" | cut -d' ' -f1) = "$EXPECTED_CONTROLLER_HASH" ]] ||
  fail 'staged controller hash differs'
[[ $(sha256sum "$STAGING/ash-atlas-deploy@.service" | cut -d' ' -f1) = "$EXPECTED_UNIT_HASH" ]] ||
  fail 'staged systemd unit hash differs'
[[ $(sha256sum "$STAGING/deployment-status.caddy" | cut -d' ' -f1) = "$EXPECTED_STATUS_ROUTE_HASH" ]] ||
  fail 'staged deployment status route hash differs'
[[ $(sha256sum "$STAGING/deployment-controller.conf" | cut -d' ' -f1) = "$EXPECTED_CONFIG_HASH" ]] ||
  fail 'staged deployment controller configuration hash differs'
[[ $(sha256sum "$STAGING/game-cache-policy.caddy" | cut -d' ' -f1) = "$EXPECTED_CACHE_POLICY_HASH" ]] ||
  fail 'staged game cache policy hash differs'
[[ $(sha256sum "$STAGING/poll-deployment-request.sh" | cut -d' ' -f1) = "$EXPECTED_POLLER_HASH" ]] ||
  fail 'staged deployment request poller hash differs'
[[ $(sha256sum "$STAGING/ash-atlas-deployment-request.service" | cut -d' ' -f1) = "$EXPECTED_REQUEST_SERVICE_HASH" ]] ||
  fail 'staged request service hash differs'
[[ $(sha256sum "$STAGING/ash-atlas-deployment-request.timer" | cut -d' ' -f1) = "$EXPECTED_REQUEST_TIMER_HASH" ]] ||
  fail 'staged request timer hash differs'
[[ $(sha256sum "$STAGING/ash-atlas-deployment-reconcile.service" | cut -d' ' -f1) = "$EXPECTED_RECONCILE_SERVICE_HASH" ]] ||
  fail 'staged reconcile service hash differs'
[[ $(sha256sum "$STAGING/ash-atlas-deployment-reconcile.timer" | cut -d' ' -f1) = "$EXPECTED_RECONCILE_TIMER_HASH" ]] ||
  fail 'staged reconcile timer hash differs'
chmod 0755 "$STAGING/deploy-test-update.sh" "$STAGING/deploy-control.sh" \
  "$STAGING/poll-deployment-request.sh" "$STAGING/install-release-controller.sh"

exec 8>/run/lock/ash-atlas-deploy-control.lock
flock -n 8 || fail 'deployment controller is active'
exec 9>/run/lock/ash-atlas-test-update.lock
flock -n 9 || fail 'deployment updater is active'
[[ ! -e /var/lib/ash-atlas/deploy-operations/active-operation ]] ||
  fail 'active deployment marker exists'
active_units=$(systemctl list-units 'ash-atlas-deploy@*.service' \
  --state=active,activating,deactivating --no-legend --plain)
[[ -z "$active_units" ]] || fail 'a deployment systemd unit is still active'

/usr/bin/node - /var/lib/ash-atlas/deploy-operations <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const root = process.argv[2];
if (!fs.existsSync(root)) process.exit(0);
for (const name of fs.readdirSync(root)) {
  if (!name.endsWith(".json")) continue;
  const receipt = JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
  if (receipt.result === "accepted" || receipt.result === "running") process.exit(1);
}
NODE

install -d -o root -g root -m 0755 /home/debian/ops/ash-atlas-server
install -d -o root -g root -m 0755 /etc/ash-atlas
install -d -o root -g ash-atlas -m 0750 \
  /var/lib/ash-atlas/deploy-operations \
  /var/lib/ash-atlas/deployment-requests \
  /var/log/ash-atlas/deploy-operations \
  /var/log/ash-atlas/deployments
[[ ! -L "$STATUS_ROOT" ]] || fail 'deployment status root is an unsafe symbolic link'
install -d -o root -g caddy -m 0750 "$STATUS_ROOT"
install -d -o debian -g debian -m 0750 /home/debian/repos /home/debian/worktrees

if [[ ! -d /home/debian/repos/game.git ]]; then
  sudo -u debian env HOME=/home/debian \
    git clone --mirror github.com:example-org/game.git \
    /home/debian/repos/game.git
fi
[[ $(sudo -u debian git --git-dir=/home/debian/repos/game.git \
  rev-parse --is-bare-repository) = true ]] ||
  fail 'persistent repository cache is not bare'
[[ $(sudo -u debian git --git-dir=/home/debian/repos/game.git \
  remote get-url origin) = github.com:example-org/game.git ]] ||
  fail 'persistent repository cache has the wrong origin'

[[ -f "$CADDY_FILE" && ! -L "$CADDY_FILE" ]] || fail 'Caddyfile is absent or unsafe'
if [[ -e "$CADDY_STATUS_ROUTE" || -L "$CADDY_STATUS_ROUTE" ]]; then
  [[ -f "$CADDY_STATUS_ROUTE" && ! -L "$CADDY_STATUS_ROUTE" ]] ||
    fail 'installed deployment status route is unsafe'
fi
if [[ -e "$CADDY_CACHE_POLICY" || -L "$CADDY_CACHE_POLICY" ]]; then
  [[ -f "$CADDY_CACHE_POLICY" && ! -L "$CADDY_CACHE_POLICY" ]] ||
    fail 'installed game cache policy is unsafe'
fi
systemctl is-active --quiet caddy.service || fail 'Caddy service is not active'

readonly CADDY_CANDIDATE="$STAGING/Caddyfile.candidate"
readonly CADDY_VALIDATION="$STAGING/Caddyfile.validation"
readonly CADDY_FILE_BACKUP="$STAGING/Caddyfile.previous"
readonly CADDY_ROUTE_BACKUP="$STAGING/deployment-status.caddy.previous"
readonly CADDY_CACHE_BACKUP="$STAGING/game-cache-policy.caddy.previous"
readonly UPDATER_BACKUP="$STAGING/deploy-test-update.sh.previous"
readonly CONTROLLER_BACKUP="$STAGING/deploy-control.sh.previous"
readonly POLLER_BACKUP="$STAGING/poll-deployment-request.sh.previous"
readonly UNIT_BACKUP="$STAGING/ash-atlas-deploy@.service.previous"
readonly REQUEST_SERVICE_BACKUP="$STAGING/ash-atlas-deployment-request.service.previous"
readonly REQUEST_TIMER_BACKUP="$STAGING/ash-atlas-deployment-request.timer.previous"
readonly RECONCILE_SERVICE_BACKUP="$STAGING/ash-atlas-deployment-reconcile.service.previous"
readonly RECONCILE_TIMER_BACKUP="$STAGING/ash-atlas-deployment-reconcile.timer.previous"
readonly CONFIG_BACKUP="$STAGING/deployment-controller.conf.previous"
/usr/bin/node - "$CADDY_FILE" "$CADDY_CANDIDATE" "$CADDY_STATUS_IMPORT" "$CADDY_CACHE_IMPORT" <<'NODE'
const fs = require("node:fs");
const [source, target, ...requiredImports] = process.argv.slice(2);
const oldCsp = "default-src 'self'; script-src 'self' https://accounts.google.com/gsi/client; script-src-attr 'none'; frame-src https://accounts.google.com/gsi/; frame-ancestors 'none'; connect-src 'self' data: https://accounts.google.com/gsi/ https://tile.openstreetmap.org; img-src 'self' data: blob: https://tile.openstreetmap.org; style-src 'self' https://accounts.google.com/gsi/style; style-src-attr 'unsafe-inline'; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'";
const newCsp = "default-src 'self'; script-src 'self' https://accounts.google.com/gsi/client https://static.cloudflareinsights.com; script-src-attr 'none'; frame-src https://accounts.google.com/gsi/; frame-ancestors 'none'; connect-src 'self' data: https://accounts.google.com/gsi/ https://tile.openstreetmap.org https://cloudflareinsights.com; img-src 'self' data: blob: https://tile.openstreetmap.org; style-src 'self' https://accounts.google.com/gsi/style; style-src-attr 'unsafe-inline'; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'";
let candidate = fs.readFileSync(source, "utf8");
const count = (text, value) => text.split(value).length - 1;
const oldCount = count(candidate, oldCsp);
const newCount = count(candidate, newCsp);
if (oldCount === 2 && newCount === 0) candidate = candidate.replaceAll(oldCsp, newCsp);
else if (oldCount !== 0 || newCount !== 2) {
  throw new Error(`expected exactly two canonical old or new CSP values; found old=${oldCount}, new=${newCount}`);
}
const lines = candidate.split(/\r?\n/);
const openers = lines.flatMap((line, index) => line.trim() === "playashatlas.com {" ? [index] : []);
if (openers.length !== 1) throw new Error("canonical playashatlas.com site block was not found uniquely");
let insertion = openers[0] + 1;
for (const requiredImport of requiredImports) {
  const imports = lines.flatMap((line, index) => line.trim() === requiredImport ? [index] : []);
  if (imports.length > 1) throw new Error(`${requiredImport} is duplicated`);
  if (imports.length === 0) {
    lines.splice(insertion, 0, `\t${requiredImport}`);
    insertion += 1;
  }
}
fs.writeFileSync(target, lines.join("\n"));
NODE
/usr/bin/node - "$CADDY_CANDIDATE" "$CADDY_VALIDATION" \
  "$CADDY_STATUS_ROUTE" "$STAGING/deployment-status.caddy" \
  "$CADDY_CACHE_POLICY" "$STAGING/game-cache-policy.caddy" <<'NODE'
const fs = require("node:fs");
const [source, target, ...replacements] = process.argv.slice(2);
let config = fs.readFileSync(source, "utf8");
for (let index = 0; index < replacements.length; index += 2) {
  const installed = replacements[index];
  const staged = replacements[index + 1];
  if (!config.includes(installed)) throw new Error(`candidate Caddyfile omitted ${installed}`);
  config = config.replaceAll(installed, staged);
}
fs.writeFileSync(target, config);
NODE
caddy validate --config "$CADDY_VALIDATION"
CADDY_CONFIGURATION_CHANGED=true
if cmp -s "$CADDY_CANDIDATE" "$CADDY_FILE" &&
    [[ -f "$CADDY_STATUS_ROUTE" ]] &&
    cmp -s "$STAGING/deployment-status.caddy" "$CADDY_STATUS_ROUTE" &&
    [[ -f "$CADDY_CACHE_POLICY" ]] &&
    cmp -s "$STAGING/game-cache-policy.caddy" "$CADDY_CACHE_POLICY"; then
  CADDY_CONFIGURATION_CHANGED=false
fi
systemd-analyze verify "$STAGING/ash-atlas-deploy@.service"
readonly SYSTEMD_VALIDATION_ROOT="$STAGING/systemd-validation"
install -d -m 0700 "$SYSTEMD_VALIDATION_ROOT"
sed "s#/home/debian/ops/ash-atlas-server/poll-deployment-request.sh#$STAGING/poll-deployment-request.sh#" \
  "$STAGING/ash-atlas-deployment-request.service" \
  > "$SYSTEMD_VALIDATION_ROOT/ash-atlas-deployment-request.service"
sed "s#/home/debian/ops/ash-atlas-server/deploy-control.sh#$STAGING/deploy-control.sh#" \
  "$STAGING/ash-atlas-deployment-reconcile.service" \
  > "$SYSTEMD_VALIDATION_ROOT/ash-atlas-deployment-reconcile.service"
cp "$STAGING/ash-atlas-deployment-request.timer" \
  "$STAGING/ash-atlas-deployment-reconcile.timer" "$SYSTEMD_VALIDATION_ROOT/"
systemd-analyze verify "$SYSTEMD_VALIDATION_ROOT/ash-atlas-deployment-request.service" \
  "$SYSTEMD_VALIDATION_ROOT/ash-atlas-deployment-request.timer" \
  "$SYSTEMD_VALIDATION_ROOT/ash-atlas-deployment-reconcile.service" \
  "$SYSTEMD_VALIDATION_ROOT/ash-atlas-deployment-reconcile.timer"

cp -a -- "$CADDY_FILE" "$CADDY_FILE_BACKUP"
CADDY_ROUTE_EXISTED=false
CADDY_CACHE_EXISTED=false
if [[ -f "$CADDY_STATUS_ROUTE" ]]; then
  cp -a -- "$CADDY_STATUS_ROUTE" "$CADDY_ROUTE_BACKUP"
  CADDY_ROUTE_EXISTED=true
fi
if [[ -f "$CADDY_CACHE_POLICY" ]]; then
  cp -a -- "$CADDY_CACHE_POLICY" "$CADDY_CACHE_BACKUP"
  CADDY_CACHE_EXISTED=true
fi

UPDATER_EXISTED=false
CONTROLLER_EXISTED=false
POLLER_EXISTED=false
UNIT_EXISTED=false
REQUEST_SERVICE_EXISTED=false
REQUEST_TIMER_EXISTED=false
RECONCILE_SERVICE_EXISTED=false
RECONCILE_TIMER_EXISTED=false
CONFIG_EXISTED=false
REQUEST_TIMER_WAS_ENABLED=false
REQUEST_TIMER_WAS_ACTIVE=false
RECONCILE_TIMER_WAS_ENABLED=false
RECONCILE_TIMER_WAS_ACTIVE=false
systemctl is-enabled --quiet ash-atlas-deployment-request.timer 2>/dev/null &&
  REQUEST_TIMER_WAS_ENABLED=true
systemctl is-active --quiet ash-atlas-deployment-request.timer 2>/dev/null &&
  REQUEST_TIMER_WAS_ACTIVE=true
systemctl is-enabled --quiet ash-atlas-deployment-reconcile.timer 2>/dev/null &&
  RECONCILE_TIMER_WAS_ENABLED=true
systemctl is-active --quiet ash-atlas-deployment-reconcile.timer 2>/dev/null &&
  RECONCILE_TIMER_WAS_ACTIVE=true
if [[ -e "$UPDATER_FILE" || -L "$UPDATER_FILE" ]]; then
  [[ -f "$UPDATER_FILE" && ! -L "$UPDATER_FILE" ]] || fail 'installed updater is unsafe'
  cp -a -- "$UPDATER_FILE" "$UPDATER_BACKUP"
  UPDATER_EXISTED=true
fi
if [[ -e "$CONTROLLER_FILE" || -L "$CONTROLLER_FILE" ]]; then
  [[ -f "$CONTROLLER_FILE" && ! -L "$CONTROLLER_FILE" ]] || fail 'installed controller is unsafe'
  cp -a -- "$CONTROLLER_FILE" "$CONTROLLER_BACKUP"
  CONTROLLER_EXISTED=true
fi
if [[ -e "$POLLER_FILE" || -L "$POLLER_FILE" ]]; then
  [[ -f "$POLLER_FILE" && ! -L "$POLLER_FILE" ]] || fail 'installed request poller is unsafe'
  cp -a -- "$POLLER_FILE" "$POLLER_BACKUP"
  POLLER_EXISTED=true
fi
if [[ -e "$UNIT_FILE" || -L "$UNIT_FILE" ]]; then
  [[ -f "$UNIT_FILE" && ! -L "$UNIT_FILE" ]] || fail 'installed systemd unit is unsafe'
  cp -a -- "$UNIT_FILE" "$UNIT_BACKUP"
  UNIT_EXISTED=true
fi
for descriptor in \
  "REQUEST_SERVICE_EXISTED|$REQUEST_SERVICE_FILE|$REQUEST_SERVICE_BACKUP" \
  "REQUEST_TIMER_EXISTED|$REQUEST_TIMER_FILE|$REQUEST_TIMER_BACKUP" \
  "RECONCILE_SERVICE_EXISTED|$RECONCILE_SERVICE_FILE|$RECONCILE_SERVICE_BACKUP" \
  "RECONCILE_TIMER_EXISTED|$RECONCILE_TIMER_FILE|$RECONCILE_TIMER_BACKUP"; do
  IFS='|' read -r flag target backup <<<"$descriptor"
  if [[ -e "$target" || -L "$target" ]]; then
    [[ -f "$target" && ! -L "$target" ]] || fail "installed systemd file is unsafe: $target"
    cp -a -- "$target" "$backup"
    printf -v "$flag" true
  fi
done
if [[ -e "$CONFIG_FILE" || -L "$CONFIG_FILE" ]]; then
  [[ -f "$CONFIG_FILE" && ! -L "$CONFIG_FILE" ]] || fail 'installed controller configuration is unsafe'
  cp -a -- "$CONFIG_FILE" "$CONFIG_BACKUP"
  CONFIG_EXISTED=true
fi

INSTALL_MUTATION_ARMED=false
restore_file() {
  local backup=$1 existed=$2 target=$3 temporary
  temporary="${target}.rollback.$$"
  if [[ "$existed" = true ]]; then
    cp -a -- "$backup" "$temporary" &&
      mv -f "$temporary" "$target"
  else
    rm -f "$target"
  fi
}
restore_installation() {
  local failed=false
  restore_file "$UPDATER_BACKUP" "$UPDATER_EXISTED" "$UPDATER_FILE" ||
    failed=true
  restore_file "$CONTROLLER_BACKUP" "$CONTROLLER_EXISTED" "$CONTROLLER_FILE" ||
    failed=true
  restore_file "$POLLER_BACKUP" "$POLLER_EXISTED" "$POLLER_FILE" ||
    failed=true
  restore_file "$UNIT_BACKUP" "$UNIT_EXISTED" "$UNIT_FILE" ||
    failed=true
  restore_file "$REQUEST_SERVICE_BACKUP" "$REQUEST_SERVICE_EXISTED" "$REQUEST_SERVICE_FILE" ||
    failed=true
  restore_file "$REQUEST_TIMER_BACKUP" "$REQUEST_TIMER_EXISTED" "$REQUEST_TIMER_FILE" ||
    failed=true
  restore_file "$RECONCILE_SERVICE_BACKUP" "$RECONCILE_SERVICE_EXISTED" "$RECONCILE_SERVICE_FILE" ||
    failed=true
  restore_file "$RECONCILE_TIMER_BACKUP" "$RECONCILE_TIMER_EXISTED" "$RECONCILE_TIMER_FILE" ||
    failed=true
  restore_file "$CONFIG_BACKUP" "$CONFIG_EXISTED" "$CONFIG_FILE" ||
    failed=true
  if [[ "$CADDY_CONFIGURATION_CHANGED" = true ]]; then
    restore_file "$CADDY_ROUTE_BACKUP" "$CADDY_ROUTE_EXISTED" "$CADDY_STATUS_ROUTE" ||
      failed=true
    restore_file "$CADDY_CACHE_BACKUP" "$CADDY_CACHE_EXISTED" "$CADDY_CACHE_POLICY" ||
      failed=true
    restore_file "$CADDY_FILE_BACKUP" true "$CADDY_FILE" || failed=true
  fi
  systemctl daemon-reload || failed=true
  if [[ "$REQUEST_TIMER_WAS_ENABLED" = true ]]; then
    systemctl enable ash-atlas-deployment-request.timer || failed=true
  else
    systemctl disable ash-atlas-deployment-request.timer >/dev/null 2>&1 || true
  fi
  if [[ "$RECONCILE_TIMER_WAS_ENABLED" = true ]]; then
    systemctl enable ash-atlas-deployment-reconcile.timer || failed=true
  else
    systemctl disable ash-atlas-deployment-reconcile.timer >/dev/null 2>&1 || true
  fi
  if [[ "$REQUEST_TIMER_WAS_ACTIVE" = true ]]; then
    systemctl start ash-atlas-deployment-request.timer || failed=true
  else
    systemctl stop ash-atlas-deployment-request.timer >/dev/null 2>&1 || true
  fi
  if [[ "$RECONCILE_TIMER_WAS_ACTIVE" = true ]]; then
    systemctl start ash-atlas-deployment-reconcile.timer || failed=true
  else
    systemctl stop ash-atlas-deployment-reconcile.timer >/dev/null 2>&1 || true
  fi
  if [[ "$CADDY_CONFIGURATION_CHANGED" = true ]]; then
    systemctl reload caddy.service || failed=true
  fi
  [[ "$failed" = false ]]
}
installer_exit() {
  local code=$?
  trap - EXIT
  if [[ "$INSTALL_MUTATION_ARMED" = true ]] && ! restore_installation; then
    printf 'STOP: release controller installation failed and rollback could not be fully restored\n' >&2
  fi
  exit "$code"
}
trap installer_exit EXIT
INSTALL_MUTATION_ARMED=true

install -o root -g root -m 0755 "$STAGING/deploy-test-update.sh" "$UPDATER_FILE"
install -o root -g root -m 0755 "$STAGING/deploy-control.sh" "$CONTROLLER_FILE"
install -o root -g root -m 0755 "$STAGING/poll-deployment-request.sh" "$POLLER_FILE"
install -o root -g root -m 0644 "$STAGING/ash-atlas-deploy@.service" "$UNIT_FILE"
install -o root -g root -m 0644 "$STAGING/ash-atlas-deployment-request.service" "$REQUEST_SERVICE_FILE"
install -o root -g root -m 0644 "$STAGING/ash-atlas-deployment-request.timer" "$REQUEST_TIMER_FILE"
install -o root -g root -m 0644 "$STAGING/ash-atlas-deployment-reconcile.service" "$RECONCILE_SERVICE_FILE"
install -o root -g root -m 0644 "$STAGING/ash-atlas-deployment-reconcile.timer" "$RECONCILE_TIMER_FILE"
install -o root -g root -m 0644 "$STAGING/deployment-controller.conf" "$CONFIG_FILE"
systemctl daemon-reload
[[ $(sha256sum "$UPDATER_FILE" | cut -d' ' -f1) = "$EXPECTED_UPDATER_HASH" ]] ||
  fail 'installed updater hash differs'
[[ $(sha256sum "$CONTROLLER_FILE" | cut -d' ' -f1) = "$EXPECTED_CONTROLLER_HASH" ]] ||
  fail 'installed controller hash differs'
[[ $(sha256sum "$POLLER_FILE" | cut -d' ' -f1) = "$EXPECTED_POLLER_HASH" ]] ||
  fail 'installed request poller hash differs'
[[ $(sha256sum "$UNIT_FILE" | cut -d' ' -f1) = "$EXPECTED_UNIT_HASH" ]] ||
  fail 'installed systemd unit hash differs'
[[ $(sha256sum "$CONFIG_FILE" | cut -d' ' -f1) = "$EXPECTED_CONFIG_HASH" ]] ||
  fail 'installed deployment controller configuration hash differs'
[[ $(sha256sum "$REQUEST_SERVICE_FILE" | cut -d' ' -f1) = "$EXPECTED_REQUEST_SERVICE_HASH" &&
      $(sha256sum "$REQUEST_TIMER_FILE" | cut -d' ' -f1) = "$EXPECTED_REQUEST_TIMER_HASH" &&
      $(sha256sum "$RECONCILE_SERVICE_FILE" | cut -d' ' -f1) = "$EXPECTED_RECONCILE_SERVICE_HASH" &&
      $(sha256sum "$RECONCILE_TIMER_FILE" | cut -d' ' -f1) = "$EXPECTED_RECONCILE_TIMER_HASH" ]] ||
  fail 'installed deployment request/reconcile systemd hashes differ'

if [[ "$CADDY_CONFIGURATION_CHANGED" = true ]]; then
  route_temporary="${CADDY_STATUS_ROUTE}.new.$$"
  cache_temporary="${CADDY_CACHE_POLICY}.new.$$"
  file_temporary="${CADDY_FILE}.new.$$"
  install -o root -g root -m 0644 "$STAGING/deployment-status.caddy" "$route_temporary"
  mv -f "$route_temporary" "$CADDY_STATUS_ROUTE"
  install -o root -g root -m 0644 "$STAGING/game-cache-policy.caddy" "$cache_temporary"
  mv -f "$cache_temporary" "$CADDY_CACHE_POLICY"
  install -o root -g root -m 0644 "$CADDY_CANDIDATE" "$file_temporary"
  mv -f "$file_temporary" "$CADDY_FILE"
  caddy validate --config "$CADDY_FILE"
  systemctl reload caddy.service
fi
systemctl enable --now ash-atlas-deployment-request.timer ash-atlas-deployment-reconcile.timer
systemctl is-enabled --quiet ash-atlas-deployment-request.timer
systemctl is-enabled --quiet ash-atlas-deployment-reconcile.timer
systemctl is-active --quiet ash-atlas-deployment-request.timer
systemctl is-active --quiet ash-atlas-deployment-reconcile.timer
[[ $(sha256sum "$CADDY_STATUS_ROUTE" | cut -d' ' -f1) = "$EXPECTED_STATUS_ROUTE_HASH" ]] ||
  fail 'installed deployment status route hash differs'
[[ $(sha256sum "$CADDY_CACHE_POLICY" | cut -d' ' -f1) = "$EXPECTED_CACHE_POLICY_HASH" ]] ||
  fail 'installed game cache policy hash differs'
INSTALL_MUTATION_ARMED=false
trap - EXIT

rm -rf --one-file-system "$STAGING"
