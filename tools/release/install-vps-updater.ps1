[CmdletBinding()]
param(
    [switch]$ConfirmUpdaterInstall,
    [string]$SshHost,
    [string]$SshKey,
    [string]$KnownHostsFile
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'deployment-transport.ps1')
if (-not $SshHost) { $SshHost = $script:AshAtlasProductionSshHost }
if (-not $ConfirmUpdaterInstall) { throw 'Release controller installation requires -ConfirmUpdaterInstall.' }
if (-not $SshKey) { $SshKey = $script:AshAtlasProductionSshKeyPath }
if (-not $KnownHostsFile) { $KnownHostsFile = Join-Path $env:USERPROFILE '.ssh\known_hosts' }

$vpsRoot = Join-Path $PSScriptRoot 'vps'
$sources = [ordered]@{
    updater = Join-Path $vpsRoot 'deploy-test-update.sh'
    controller = Join-Path $vpsRoot 'deploy-control.sh'
    poller = Join-Path $vpsRoot 'poll-deployment-request.sh'
    unit = Join-Path $vpsRoot 'ash-atlas-deploy@.service'
    requestService = Join-Path $vpsRoot 'ash-atlas-deployment-request.service'
    requestTimer = Join-Path $vpsRoot 'ash-atlas-deployment-request.timer'
    reconcileService = Join-Path $vpsRoot 'ash-atlas-deployment-reconcile.service'
    reconcileTimer = Join-Path $vpsRoot 'ash-atlas-deployment-reconcile.timer'
    statusRoute = Join-Path $vpsRoot 'deployment-status.caddy'
    cachePolicy = Join-Path $vpsRoot 'game-cache-policy.caddy'
    config = Join-Path $vpsRoot 'deployment-controller.conf'
    installer = Join-Path $vpsRoot 'install-release-controller.sh'
}
foreach ($entry in $sources.GetEnumerator()) {
    if (-not (Test-Path -LiteralPath $entry.Value -PathType Leaf)) {
        throw "Source-controlled $($entry.Key) is absent: $($entry.Value)"
    }
}
$hashes = [ordered]@{}
$payloads = [ordered]@{}
$utf8 = [Text.UTF8Encoding]::new($false, $true)
foreach ($entry in $sources.GetEnumerator()) {
    $text = [IO.File]::ReadAllText([string]$entry.Value, $utf8).
        Replace("`r`n", "`n").Replace("`r", "`n")
    $bytes = $utf8.GetBytes($text)
    $payloads[$entry.Key] = $bytes
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        $hashes[$entry.Key] = ([BitConverter]::ToString(
            $algorithm.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
    } finally {
        $algorithm.Dispose()
    }
}
$transport = Resolve-WslOpenSshTransport `
    -SshHost $SshHost -SshKey $SshKey -KnownHostsFile $KnownHostsFile
$temporary = "/tmp/ash-atlas-release-v3.$PID"
$bootstrap = [Collections.Generic.List[string]]::new()
$bootstrap.Add('set -euo pipefail')
$bootstrap.Add('umask 077')
$bootstrap.Add("temporary='$temporary'")
$bootstrap.Add("trap 'sudo rm -rf --one-file-system `"`${temporary}`"' EXIT HUP INT TERM")
$bootstrap.Add('mkdir "$temporary"')
foreach ($entry in $sources.GetEnumerator()) {
    $fileName = Split-Path -Leaf ([string]$entry.Value)
    $encoded = [Convert]::ToBase64String([byte[]]$payloads[$entry.Key])
    $bootstrap.Add("printf '%s' '$encoded' | base64 --decode > `"`${temporary}/$fileName`"")
}
$bootstrap.Add('sudo chown root:root "$temporary" "$temporary"/*')
$bootstrap.Add('sudo chmod 0700 "$temporary"')
$bootstrap.Add(
    "test `$(sudo sha256sum `"`${temporary}/install-release-controller.sh`" | cut -d' ' -f1) = '$($hashes.installer)'")
$bootstrap.Add(
    "sudo bash `"`${temporary}/install-release-controller.sh`" `"`${temporary}`" " +
    "'$($hashes.updater)' '$($hashes.controller)' '$($hashes.unit)' '$($hashes.statusRoute)' " +
    "'$($hashes.config)' '$($hashes.cachePolicy)' '$($hashes.poller)' " +
    "'$($hashes.requestService)' '$($hashes.requestTimer)' " +
    "'$($hashes.reconcileService)' '$($hashes.reconcileTimer)'")
$bootstrap.Add('trap - EXIT HUP INT TERM')
$bootstrap.Add('sudo rm -rf --one-file-system "$temporary"')
$installed = Invoke-WslOpenSshCommand -Transport $transport -Program ssh -Arguments @(
    [string]$transport.endpoint, 'bash -s'
) -ConnectTimeoutSeconds 30 -HardDeadlineSeconds 240 `
    -StandardInput (($bootstrap -join "`n") + "`n")
if ($installed.exit_code -ne 0) {
    throw "VPS release controller installation or verification failed ($($installed.failure_class)): $($installed.output)"
}

[pscustomobject][ordered]@{
    updater_sha256 = $hashes.updater
    controller_sha256 = $hashes.controller
    poller_sha256 = $hashes.poller
    unit_sha256 = $hashes.unit
    status_route_sha256 = $hashes.statusRoute
    cache_policy_sha256 = $hashes.cachePolicy
    configuration_sha256 = $hashes.config
    installer_sha256 = $hashes.installer
    systemd_template = 'ash-atlas-deploy@.service'
    request_timer = 'ash-atlas-deployment-request.timer'
    reconcile_timer = 'ash-atlas-deployment-reconcile.timer'
    request_ref = 'refs/heads/integration/deployment-requests'
    deployment_status_endpoint = 'https://playashatlas.com/deployment-status/<token>.json'
    mirror = '/home/debian/repos/game.git'
} | ConvertTo-Json -Compress
