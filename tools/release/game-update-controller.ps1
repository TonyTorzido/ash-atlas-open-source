[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateSet('start', 'inspect', 'resume')][string]$Action,
    [ValidatePattern('^test/t\d{3,4}$')][string]$ExpectedGeneration,
    [ValidatePattern('^[0-9a-f]{40}$')][string]$ExpectedCandidateSha,
    [switch]$ConfirmExactPublish,
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$')][string]$OperationId
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Stop-GameUpdateController([string]$Message) {
    throw "ACTION_REQUIRED: $Message"
}

function Get-RequiredProperty {
    param([Parameter(Mandatory = $true)]$Object, [Parameter(Mandatory = $true)][string]$Name)
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property -or $null -eq $property.Value -or [string]$property.Value -eq '') {
        Stop-GameUpdateController "control configuration is missing '$Name'"
    }
    return $property.Value
}

function Get-FullPath([string]$Path) {
    if (-not [IO.Path]::IsPathRooted($Path)) {
        Stop-GameUpdateController "configured path must be absolute: $Path"
    }
    return [IO.Path]::GetFullPath($Path).TrimEnd([char[]]@('\', '/'))
}

function Test-PathInside([string]$Path, [string]$Root) {
    $normalizedPath = Get-FullPath $Path
    $normalizedRoot = Get-FullPath $Root
    return [String]::Equals($normalizedPath, $normalizedRoot, [StringComparison]::OrdinalIgnoreCase) -or
        $normalizedPath.StartsWith($normalizedRoot + '\', [StringComparison]::OrdinalIgnoreCase)
}

function Get-GitText {
    param([Parameter(Mandatory = $true)][string]$Repository, [Parameter(Mandatory = $true)][string[]]$Arguments)
    $lines = @(& git -C $Repository @Arguments 2>&1)
    if ($LASTEXITCODE -ne 0) {
        Stop-GameUpdateController "git $($Arguments -join ' ') failed: $($lines -join ' ')"
    }
    return ($lines -join "`n").Trim()
}

function Assert-GitCheckout {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$ExpectedBranch,
        [Parameter(Mandatory = $true)][string]$Label
    )
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
        Stop-GameUpdateController "$Label was not found: $Path"
    }
    $gitRoot = Get-GitText $Path @('rev-parse', '--show-toplevel')
    if (-not [String]::Equals((Get-FullPath $gitRoot), $Path, [StringComparison]::OrdinalIgnoreCase)) {
        Stop-GameUpdateController "$Label path is not the exact Git checkout root"
    }
    if ((Get-GitText $Path @('branch', '--show-current')) -cne $ExpectedBranch) {
        Stop-GameUpdateController "$Label is not on $ExpectedBranch"
    }
    if (Get-GitText $Path @('status', '--porcelain')) {
        Stop-GameUpdateController "$Label is not clean"
    }
}

if ($Action -eq 'start') {
    if (-not $ExpectedGeneration -or -not $ExpectedCandidateSha) {
        Stop-GameUpdateController 'start requires an exact expected generation and candidate SHA'
    }
    if (-not $ConfirmExactPublish) {
        Stop-GameUpdateController 'start requires -ConfirmExactPublish'
    }
    if ($OperationId) { Stop-GameUpdateController 'start does not accept an operation ID' }
} else {
    if (-not $OperationId) { Stop-GameUpdateController 'inspect/resume requires a durable operation ID' }
    if ($ExpectedGeneration -or $ExpectedCandidateSha -or $ConfirmExactPublish) {
        Stop-GameUpdateController 'expected candidate and publish confirmation are valid only for start'
    }
}

$controlConfigPath = 'C:\ProgramData\AshAtlas\CoordinatedRelease\control.json'
if (-not (Test-Path -LiteralPath $controlConfigPath -PathType Leaf)) {
    Stop-GameUpdateController "ACL-protected control configuration was not found: $controlConfigPath"
}
try {
    $config = Get-Content -Raw -LiteralPath $controlConfigPath -Encoding utf8 | ConvertFrom-Json
} catch {
    Stop-GameUpdateController "control configuration is unreadable: $($_.Exception.Message)"
}
if ([int](Get-RequiredProperty $config 'schema_version') -ne 1 -or
    [string](Get-RequiredProperty $config 'kind') -cne 'ash-atlas-coordinated-release-control-config' -or
    [string](Get-RequiredProperty $config 'status') -cne 'ready') {
    Stop-GameUpdateController 'trusted control configuration schema or provisioning status is unsupported'
}

$controller = Get-RequiredProperty $config 'trusted_controller'
$sourcePolicy = Get-RequiredProperty $config 'source_policy'
$server = Get-RequiredProperty $config 'server'
$expectedAccount = [string](Get-RequiredProperty $controller 'runner_account')
if ([Environment]::UserName -cne $expectedAccount) {
    Stop-GameUpdateController "trusted controller must run as $expectedAccount"
}

$sourceRoot = Get-FullPath (Get-RequiredProperty $controller 'source_checkout_root')
$integrationRoot = Get-FullPath (Get-RequiredProperty $controller 'integration_worktree_root')
$toolingRoot = Get-FullPath (Get-RequiredProperty $controller 'tooling_checkout_root')
$stateRoot = Get-FullPath (Get-RequiredProperty $controller 'state_root')
$allowedToolingSha = ([string](Get-RequiredProperty $sourcePolicy 'allowed_tooling_sha')).ToLowerInvariant()
if ($allowedToolingSha -notmatch '^[0-9a-f]{40}$') {
    Stop-GameUpdateController 'source policy must pin one canonical trusted tooling SHA'
}
if ([String]::Equals($sourceRoot, $integrationRoot, [StringComparison]::OrdinalIgnoreCase) -or
    [String]::Equals($sourceRoot, $toolingRoot, [StringComparison]::OrdinalIgnoreCase) -or
    [String]::Equals($integrationRoot, $toolingRoot, [StringComparison]::OrdinalIgnoreCase)) {
    Stop-GameUpdateController 'source, integration, and tooling checkout roots must be distinct'
}
foreach ($checkoutRoot in @($sourceRoot, $integrationRoot, $toolingRoot)) {
    if (Test-PathInside $stateRoot $checkoutRoot) {
        Stop-GameUpdateController 'configured state root must be outside every checkout'
    }
}

$expectedWrapper = Get-FullPath (Join-Path $toolingRoot 'tools\release\game-update-controller.ps1')
if (-not [String]::Equals((Get-FullPath $PSCommandPath), $expectedWrapper,
        [StringComparison]::OrdinalIgnoreCase)) {
    Stop-GameUpdateController 'controller must run from the pinned tooling checkout'
}
$expectedCanonicalScript = Get-FullPath (Join-Path $toolingRoot 'tools\release\accept-and-publish-test-server.ps1')
$canonicalScript = Get-FullPath (Get-RequiredProperty $server 'canonical_script')
if (-not [String]::Equals($canonicalScript, $expectedCanonicalScript,
        [StringComparison]::OrdinalIgnoreCase) -or
    -not (Test-Path -LiteralPath $canonicalScript -PathType Leaf)) {
    Stop-GameUpdateController 'server canonical_script must be the pinned coordinator inside tooling_checkout_root'
}

$toolingHead = Get-GitText $toolingRoot @('rev-parse', '--verify', 'HEAD^{commit}')
if ($toolingHead -cne $allowedToolingSha) {
    Stop-GameUpdateController 'immutable tooling checkout HEAD does not match source_policy.allowed_tooling_sha'
}
$toolingGitRoot = Get-GitText $toolingRoot @('rev-parse', '--show-toplevel')
if (-not [String]::Equals((Get-FullPath $toolingGitRoot), $toolingRoot,
        [StringComparison]::OrdinalIgnoreCase)) {
    Stop-GameUpdateController 'immutable tooling path is not the exact Git checkout root'
}
foreach ($checkout in @(
        [pscustomobject]@{ path = $toolingRoot; branch = ''; label = 'immutable tooling checkout' },
        [pscustomobject]@{ path = $sourceRoot; branch = 'master'; label = 'source checkout' },
        [pscustomobject]@{ path = $integrationRoot; branch = 'integration/test'; label = 'integration worktree' }
    )) {
    if (-not $checkout.branch) {
        if (Get-GitText $checkout.path @('status', '--porcelain')) {
            Stop-GameUpdateController "$($checkout.label) is not clean"
        }
    } else {
        Assert-GitCheckout $checkout.path $checkout.branch $checkout.label
    }
}

if (-not (Test-Path -LiteralPath $stateRoot -PathType Container)) {
    Stop-GameUpdateController "configured state root was not found: $stateRoot"
}
$stateAcl = Get-Acl -LiteralPath $stateRoot
if ($stateAcl.AccessToString -notmatch [Regex]::Escape($expectedAccount)) {
    Stop-GameUpdateController 'coordinator state root ACL does not name the trusted runner account'
}

$canonicalMode = switch ($Action) {
    'start' { 'Publish' }
    'inspect' { 'Inspect' }
    'resume' { 'Resume' }
}
$arguments = @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $canonicalScript,
    '-Mode', $canonicalMode,
    '-StateRoot', $stateRoot,
    '-SourceRepositoryRoot', $sourceRoot,
    '-IntegrationWorktreePath', $integrationRoot,
    '-Json'
)
if ($Action -eq 'start') {
    $canonicalGeneration = $ExpectedGeneration.Substring('test/'.Length)
    $arguments += @(
        '-ApprovedIntegrationTest', '-ConfirmPublish', '-ConfirmDeploy',
        '-ExpectedGeneration', $canonicalGeneration,
        '-ExpectedCandidateSha', $ExpectedCandidateSha
    )
} else {
    $arguments += @('-OperationId', $OperationId)
}

& powershell.exe @arguments
if ($LASTEXITCODE -ne 0) {
    Stop-GameUpdateController "canonical $canonicalMode operation failed with exit code $LASTEXITCODE"
}
