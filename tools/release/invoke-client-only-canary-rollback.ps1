[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$')]
    [string]$OperationId,
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{40}$')]
    [string]$ExpectedTargetSha,
    [Parameter(Mandatory = $true)][string]$RepositoryRoot,
    [switch]$ConfirmClientOnlyCanaryRollback,
    [string]$SshHost,
    [string]$SshKey,
    [string]$KnownHostsFile
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'deployment-transport.ps1')
if (-not $SshHost) { $SshHost = $script:AshAtlasProductionSshHost }

if (-not $ConfirmClientOnlyCanaryRollback) {
    throw 'Client-only canary rollback requires -ConfirmClientOnlyCanaryRollback.'
}
if (-not $SshKey) { $SshKey = $script:AshAtlasProductionSshKeyPath }
if (-not $KnownHostsFile) { $KnownHostsFile = Join-Path $env:USERPROFILE '.ssh\known_hosts' }
$RepositoryRoot = [IO.Path]::GetFullPath($RepositoryRoot)
if (-not (Test-Path -LiteralPath $RepositoryRoot -PathType Container)) {
    throw "Browser-smoke repository root is absent: $RepositoryRoot"
}

$remote = @'
set -euo pipefail
operation_id=$1
expected_target=$2
receipt=/var/lib/ash-atlas/deploy-operations/${operation_id}.json
game_current=/srv/ash-atlas/game/current
public_current=/srv/www/playashatlas/current
game_root=/srv/ash-atlas/game/releases
public_root=/srv/www/playashatlas/game-releases
env_file=/etc/ash-atlas/game.env
caddy_file=/etc/caddy/Caddyfile

fail() { printf 'STOP: %s\n' "$*" >&2; exit 1; }
field() {
  /usr/bin/node - "$receipt" "$1" <<'NODE'
const fs = require("node:fs");
const [path, field] = process.argv.slice(2);
const value = JSON.parse(fs.readFileSync(path, "utf8"))[field];
if (!["string", "number", "boolean"].includes(typeof value)) process.exit(2);
process.stdout.write(String(value));
NODE
}
process_identity() {
  pid=$(systemctl show ash-atlas.service --property MainPID --value)
  start=$(systemctl show ash-atlas.service --property ExecMainStartTimestampMonotonic --value)
  [[ "$pid" =~ ^[1-9][0-9]*$ && "$start" =~ ^[1-9][0-9]*$ ]] ||
    fail 'game process identity is unavailable'
}
public_release_sha() {
  curl --fail --silent --show-error --max-time 20 \
    'https://playashatlas.com/play/release.json?canary_rollback=1' |
    /usr/bin/node -e '
      let value="";
      process.stdin.on("data", chunk => value += chunk);
      process.stdin.on("end", () => process.stdout.write(JSON.parse(value).game_sha || ""));
    '
}
verify_public_assets() {
  local expected=$1 html js css headers
  [[ $(public_release_sha) = "$expected" ]] || fail 'public release identity differs'
  html=$(curl --fail --silent --show-error --max-time 20 \
    'https://playashatlas.com/play/?canary_rollback=1')
  js=$(printf '%s' "$html" | grep -Eo '/play/assets/[^"'"'"'[:space:]<>]+[.]js' | head -n 1)
  css=$(printf '%s' "$html" | grep -Eo '/play/assets/[^"'"'"'[:space:]<>]+[.]css' | head -n 1)
  [[ -n "$js" && -n "$css" ]] || fail 'public HTML does not reference exact JS/CSS assets'
  for asset in "$js" "$css"; do
    headers=$(curl --fail --silent --show-error --max-time 20 --dump-header - \
      --output /dev/null "https://playashatlas.com$asset")
    printf '%s' "$headers" | grep -Eiq '^cache-control:.*max-age=31536000.*immutable' ||
      fail 'public client asset cache policy differs'
  done
}

[[ -f "$receipt" && ! -L "$receipt" ]] || fail 'authoritative deployment receipt is absent'
[[ $(field result) = completed && $(field release_class) = client_only ]] ||
  fail 'operation is not one completed client-only deployment'
[[ $(field requested_target_sha) = "$expected_target" ]] || fail 'deployment target differs'
server_sha=$(field prepared_server_component_sha)
previous_public_sha=$(field prepared_previous_public_sha)
prepared_pid=$(field prepared_game_main_pid)
prepared_start=$(field prepared_game_start_timestamp_monotonic)
[[ "$server_sha" =~ ^[0-9a-f]{40}$ && "$previous_public_sha" =~ ^[0-9a-f]{40}$ ]] ||
  fail 'prepared component identity is unsafe'
process_identity
before_pid=$pid
before_start=$start
before_game=$(readlink -e "$game_current")
before_public=$(readlink -e "$public_current")
before_public_release=$(public_release_sha)
[[ "$before_pid" = "$prepared_pid" && "$before_start" = "$prepared_start" ]] ||
  fail 'game process changed before rollback'
[[ "$before_game" = "$game_root/$server_sha" &&
    "$before_public" = "$public_root/$expected_target" &&
    "$before_public_release" = "$expected_target" ]] ||
  fail 'live component identity differs before rollback'
verify_public_assets "$expected_target"

rollback_started_ns=$(date +%s%N)
temporary=${public_current}.canary-rollback.${operation_id}
rm -f "$temporary"
ln -s "$public_root/$previous_public_sha" "$temporary"
mv -T "$temporary" "$public_current"
caddy validate --config "$caddy_file"
systemctl reload caddy.service
/usr/local/libexec/ash-atlas-wait-ready game
rollback_finished_ns=$(date +%s%N)

process_identity
after_pid=$pid
after_start=$start
after_game=$(readlink -e "$game_current")
after_public=$(readlink -e "$public_current")
after_public_release=$(public_release_sha)
[[ "$after_pid" = "$prepared_pid" && "$after_start" = "$prepared_start" ]] ||
  fail 'game process changed during rollback'
[[ "$after_game" = "$game_root/$server_sha" &&
    "$after_public" = "$public_root/$previous_public_sha" &&
    "$after_public_release" = "$previous_public_sha" ]] ||
  fail 'restored component identity differs after rollback'
verify_public_assets "$previous_public_sha"
rollback_duration_ms=$(((rollback_finished_ns - rollback_started_ns) / 1000000))

OPERATION_ID="$operation_id" TARGET_SHA="$expected_target" SERVER_SHA="$server_sha" \
PREVIOUS_PUBLIC_SHA="$previous_public_sha" BEFORE_PID="$before_pid" BEFORE_START="$before_start" \
BEFORE_GAME="$before_game" BEFORE_PUBLIC="$before_public" BEFORE_PUBLIC_RELEASE="$before_public_release" \
AFTER_PID="$after_pid" AFTER_START="$after_start" AFTER_GAME="$after_game" \
AFTER_PUBLIC="$after_public" AFTER_PUBLIC_RELEASE="$after_public_release" \
ROLLBACK_DURATION_MS="$rollback_duration_ms" /usr/bin/node <<'NODE'
const e = process.env;
process.stdout.write(`${JSON.stringify({
  schema_version: 1,
  operation_id: e.OPERATION_ID,
  target_sha: e.TARGET_SHA,
  release_class: "client_only",
  result: "rollback_completed",
  server_component_sha: e.SERVER_SHA,
  previous_public_sha: e.PREVIOUS_PUBLIC_SHA,
  before: {
    game_main_pid: Number(e.BEFORE_PID),
    game_start_timestamp_monotonic: Number(e.BEFORE_START),
    game_link: e.BEFORE_GAME,
    public_link: e.BEFORE_PUBLIC,
    public_release_sha: e.BEFORE_PUBLIC_RELEASE
  },
  after: {
    game_main_pid: Number(e.AFTER_PID),
    game_start_timestamp_monotonic: Number(e.AFTER_START),
    game_link: e.AFTER_GAME,
    public_link: e.AFTER_PUBLIC,
    public_release_sha: e.AFTER_PUBLIC_RELEASE,
    game_readiness: "passed",
    caddy_reload: "passed",
    public_assets: "passed"
  },
  rollback_duration_ms: Number(e.ROLLBACK_DURATION_MS),
  finished_at_utc: new Date().toISOString()
})}\n`);
NODE
'@
$remote = $remote.TrimStart([char]0xFEFF)

$transport = Resolve-WslOpenSshTransport `
    -SshHost $SshHost -SshKey $SshKey -KnownHostsFile $KnownHostsFile
$response = Invoke-WslOpenSshCommand -Transport $transport -Program ssh -Arguments @(
    [string]$transport.endpoint,
    "sudo bash -s -- $OperationId $ExpectedTargetSha"
) -ConnectTimeoutSeconds 30 -HardDeadlineSeconds 180 -StandardInput $remote
if ([int]$response.exit_code -ne 0) {
    throw "client-only canary rollback failed ($($response.failure_class)): $($response.output)"
}
$jsonLine = @([string]$response.stdout -split "`r?`n" |
    Where-Object { $_.TrimStart().StartsWith('{') } | Select-Object -Last 1)
if ($jsonLine.Count -ne 1) { throw 'client-only canary rollback returned no exact receipt' }
$receipt = $jsonLine[0] | ConvertFrom-Json
if ([string]$receipt.result -ne 'rollback_completed' -or
    [string]$receipt.target_sha -ne $ExpectedTargetSha -or
    [long]$receipt.before.game_main_pid -ne [long]$receipt.after.game_main_pid -or
    [long]$receipt.before.game_start_timestamp_monotonic -ne
        [long]$receipt.after.game_start_timestamp_monotonic -or
    [string]$receipt.before.game_link -ne [string]$receipt.after.game_link) {
    throw 'client-only canary rollback receipt violates the unchanged-server invariant'
}

$browserScript = @'
import { chromium } from "@playwright/test";
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const errors = [];
  await page.addInitScript(() => {
    window.__ashAtlasCspViolations = [];
    document.addEventListener("securitypolicyviolation", event => {
      window.__ashAtlasCspViolations.push({
        blockedURI: event.blockedURI,
        effectiveDirective: event.effectiveDirective,
        sourceFile: event.sourceFile,
        disposition: event.disposition
      });
    });
  });
  const isKnownGoogleGisInlineStyleConsole = message =>
    message.location().url === "https://accounts.google.com/gsi/client" &&
    message.text().includes("Applying inline style violates") &&
    message.text().includes("style-src") &&
    message.text().includes("The action has been blocked");
  const isKnownGoogleGisInlineStyleViolation = violation =>
    violation.blockedURI === "inline" &&
    violation.effectiveDirective === "style-src-elem" &&
    violation.sourceFile === "https://accounts.google.com/gsi/client" &&
    violation.disposition === "enforce";
  page.on("pageerror", error => errors.push(`pageerror: ${error.message}`));
  page.on("console", message => {
    if (message.type() === "error" && !isKnownGoogleGisInlineStyleConsole(message)) {
      errors.push(`console: ${message.text()} (${JSON.stringify(message.location())})`);
    }
  });
  page.on("requestfailed", request =>
    errors.push(`requestfailed: ${request.url()} (${request.failure()?.errorText ?? "unknown"})`));
  page.on("response", response => {
    if (response.status() >= 400) errors.push(`HTTP ${response.status()}: ${response.url()}`);
  });
  const response = await page.goto("https://playashatlas.com/play/?canary_rollback=1", {
    waitUntil: "networkidle", timeout: 30000
  });
  if (!response?.ok()) throw new Error(`public game returned HTTP ${response?.status()}`);
  await page.locator("body").waitFor({ state: "visible", timeout: 10000 });
  const violations = await page.evaluate(() => window.__ashAtlasCspViolations ?? []);
  for (const violation of violations) {
    if (!isKnownGoogleGisInlineStyleViolation(violation)) {
      errors.push(`securitypolicyviolation: ${JSON.stringify(violation)}`);
    }
  }
  if (errors.length > 0) throw new Error(errors.join("\n"));
} finally { await browser.close(); }
'@
$browserPackage = Join-Path $RepositoryRoot 'apps\client'
$smokePath = Join-Path $browserPackage ('.release-rollback-smoke-{0}.mjs' -f [guid]::NewGuid().ToString('n'))
$browserExit = 1
try {
    [IO.File]::WriteAllText($smokePath, $browserScript, [Text.UTF8Encoding]::new($false))
    & pnpm.cmd --dir $RepositoryRoot --filter '@ash-atlas/client' exec node $smokePath
    $browserExit = $LASTEXITCODE
} finally {
    if (Test-Path -LiteralPath $smokePath -PathType Leaf) {
        Remove-Item -LiteralPath $smokePath -Force
    }
}
$receipt | Add-Member -NotePropertyName browser_smoke `
    -NotePropertyValue $(if ($browserExit -eq 0) { 'passed' } else { 'failed' })
$receipt | ConvertTo-Json -Depth 6 -Compress
if ($browserExit -ne 0) { throw 'restored-client browser smoke failed' }
