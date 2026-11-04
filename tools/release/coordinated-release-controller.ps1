[CmdletBinding()]
param(
    [ValidateSet('Start', 'Inspect', 'Resume', 'ResumeActive')][string]$Action = 'Start',
    [Parameter(Mandatory = $true)][string]$ConfigPath,
    [string]$OperationId,
    [string]$BatchRequestJson,
    [string]$BatchRequestPath,
    [switch]$DryRun,
    [ValidatePattern('^[0-9a-fA-F]{40}$')][string]$ExpectedCandidateSha,
    [ValidatePattern('^t\d{3,4}$')][string]$ExpectedGeneration,
    [ValidateSet('daily-testers')][string]$ExpectedDeliveryMode
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Stop-CoordinatedController([string]$Message) {
    throw "ACTION_REQUIRED: $Message"
}

if ($Action -ne 'Start' -and ($BatchRequestJson -or $BatchRequestPath)) {
    Stop-CoordinatedController 'batch_request is accepted only by a new Start action'
}
if ($BatchRequestJson -and $BatchRequestPath) {
    Stop-CoordinatedController 'provide batch_request through JSON or a file, not both'
}
if ([bool]$ExpectedCandidateSha -ne [bool]$ExpectedGeneration) {
    Stop-CoordinatedController 'expected_candidate_sha and expected_generation must be supplied together'
}
if (($ExpectedCandidateSha -or $ExpectedGeneration) -and $Action -ne 'Start') {
    Stop-CoordinatedController 'expected candidate binding is valid only for a new Start action'
}
if (($ExpectedCandidateSha -or $ExpectedGeneration) -and ($BatchRequestJson -or $BatchRequestPath)) {
    Stop-CoordinatedController 'expected candidate binding is valid only for a no-batch Start action'
}
if ($ExpectedDeliveryMode -and $Action -ne 'Start') {
    Stop-CoordinatedController 'expected delivery mode binding is valid only for a new Start action'
}
if ($ExpectedDeliveryMode -and ($BatchRequestJson -or $BatchRequestPath)) {
    Stop-CoordinatedController 'expected delivery mode binding is valid only for a no-batch Start action'
}
if ($ExpectedCandidateSha) { $ExpectedCandidateSha = $ExpectedCandidateSha.ToLowerInvariant() }

function Get-RequiredProperty {
    param([Parameter(Mandatory = $true)]$Object, [Parameter(Mandatory = $true)][string]$Name)
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property -or $null -eq $property.Value -or [string]$property.Value -eq '') {
        Stop-CoordinatedController "control configuration is missing '$Name'"
    }
    return $property.Value
}

function Get-FullPath([string]$Path) {
    return [IO.Path]::GetFullPath($Path).TrimEnd('\')
}

function Get-OptionalProperty {
    param(
        [AllowNull()][object]$Object,
        [Parameter(Mandatory = $true)][string]$Name,
        [AllowNull()][object]$Default = $null
    )
    if ($null -eq $Object) { return $Default }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) { return $Default }
    return $property.Value
}

function ConvertTo-ControllerCanonicalJson {
    param([AllowNull()]$Value)
    if ($null -eq $Value) { return 'null' }
    if ($Value -is [string]) { return ($Value | ConvertTo-Json -Compress) }
    if ($Value -is [bool]) { return $(if ($Value) { 'true' } else { 'false' }) }
    if ($Value -is [System.Collections.IDictionary]) {
        $keys = [string[]]@($Value.Keys | ForEach-Object { [string]$_ })
        if ($keys.Count -gt 1) { [Array]::Sort($keys, [StringComparer]::Ordinal) }
        return '{' + (@($keys | ForEach-Object {
                    '"{0}":{1}' -f ($_ -replace '\\', '\\\\' -replace '"', '\"'),
                    (ConvertTo-ControllerCanonicalJson $Value[$_])
                }) -join ',') + '}'
    }
    if ($Value -is [System.Collections.IEnumerable] -and $Value -isnot [string]) {
        return '[' + (@($Value | ForEach-Object { ConvertTo-ControllerCanonicalJson $_ }) -join ',') + ']'
    }
    if ($Value -is [ValueType]) { return ($Value | ConvertTo-Json -Compress) }
    $properties = @($Value.PSObject.Properties)
    $keys = [string[]]@($properties | ForEach-Object { [string]$_.Name })
    if ($keys.Count -gt 1) { [Array]::Sort($keys, [StringComparer]::Ordinal) }
    return '{' + (@($keys | ForEach-Object {
                '"{0}":{1}' -f ($_ -replace '\\', '\\\\' -replace '"', '\"'),
                (ConvertTo-ControllerCanonicalJson $Value.PSObject.Properties[$_].Value)
            }) -join ',') + '}'
}

function Get-ControllerSha256([string]$Text) {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString(
                $algorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text)))).Replace('-', '').ToLowerInvariant()
    } finally { $algorithm.Dispose() }
}

function New-DispatchNonce {
    $bytes = New-Object byte[] 16
    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $generator.GetBytes($bytes) }
    finally { $generator.Dispose() }
    return ([BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
}

function Get-DispatchName([string]$Operation, [string]$Nonce) {
    if ($Nonce -notmatch '^[0-9a-f]{32}$') {
        Stop-CoordinatedController 'durable mobile dispatch nonce is not canonical'
    }
    return "ash-atlas-mobile-$Operation-$Nonce"
}

function Read-BatchRequest {
    param([string]$Json)
    if (-not $Json) { return @() }
    try { $parsed = $Json | ConvertFrom-Json -ErrorAction Stop }
    catch { Stop-CoordinatedController 'batch_request must be valid UTF-8 JSON' }
    $items = @($parsed)
    if ($items.Count -lt 2) {
        Stop-CoordinatedController 'batch_request requires at least two ordered feature entries'
    }
    $seenBranches = @{}
    $seenShas = @{}
    $normalized = @()
    foreach ($item in $items) {
        if ($null -eq $item) { Stop-CoordinatedController 'batch_request contains a null feature entry' }
        $properties = @($item.PSObject.Properties.Name)
        foreach ($required in @('branch', 'sha', 'player_patch_note')) {
            if ($required -notin $properties) {
                Stop-CoordinatedController "batch_request entry is missing '$required'"
            }
        }
        if (@($properties | Where-Object { $_ -notin @('branch', 'sha', 'player_patch_note') }).Count -gt 0) {
            Stop-CoordinatedController 'batch_request entries contain unsupported fields'
        }
        $branch = [string]$item.branch
        $sha = [string]$item.sha
        $note = [string]$item.player_patch_note
        if ($branch -cnotmatch '^(?:feature|fix|chore|audit)/[A-Za-z0-9][A-Za-z0-9._/-]{1,127}$' -or
            $branch.Contains('..') -or $branch.Contains('//')) {
            Stop-CoordinatedController "batch_request branch is not an allowed feature ref: $branch"
        }
        if ($sha -cnotmatch '^[0-9a-f]{40}$') {
            Stop-CoordinatedController 'batch_request SHA must be a lowercase canonical 40-character SHA'
        }
        if ($note.Length -lt 10 -or $note.Length -gt 160 -or $note -match '[\r\n\p{Cc}\p{Cf}\p{Zl}\p{Zp}]') {
            Stop-CoordinatedController 'batch_request player_patch_note must be one safe 10-to-160 character line'
        }
        if ($seenBranches.ContainsKey($branch) -or $seenShas.ContainsKey($sha)) {
            Stop-CoordinatedController 'batch_request branches and SHAs must be unique and ordered'
        }
        $seenBranches[$branch] = $true
        $seenShas[$sha] = $true
        $normalized += [pscustomobject][ordered]@{
            branch = $branch
            sha = $sha
            player_patch_note = $note
        }
    }
    return @($normalized)
}

function Read-BatchRequestFile {
    param([Parameter(Mandatory = $true)][string]$Path)
    $resolved = Get-FullPath $Path
    if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
        Stop-CoordinatedController "batch_request file was not found: $resolved"
    }
    $info = Get-Item -LiteralPath $resolved
    if ($info.Length -gt 65536) {
        Stop-CoordinatedController 'batch_request file exceeds the 64 KiB input limit'
    }
    try {
        $text = [IO.File]::ReadAllText($resolved, [Text.UTF8Encoding]::new($false))
    } catch {
        Stop-CoordinatedController "batch_request file is not valid UTF-8: $($_.Exception.Message)"
    }
    if ($text.Length -gt 0 -and [int]$text[0] -eq 0xfeff) {
        $text = $text.Substring(1)
    }
    return $text
}

if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
    Stop-CoordinatedController "trusted control configuration was not found: $ConfigPath"
}
$config = Get-Content -Raw -LiteralPath $ConfigPath -Encoding utf8 | ConvertFrom-Json
if ([int](Get-RequiredProperty $config 'schema_version') -ne 1 -or
    [string](Get-RequiredProperty $config 'kind') -cne 'ash-atlas-coordinated-release-control-config') {
    Stop-CoordinatedController 'trusted control configuration schema is unsupported'
}
if ([string](Get-RequiredProperty $config 'status') -cne 'ready') {
    Stop-CoordinatedController 'private control repository and trusted runner provisioning is incomplete'
}
$controller = Get-RequiredProperty $config 'trusted_controller'
$sourcePolicy = Get-RequiredProperty $config 'source_policy'
$bootstrap = Get-RequiredProperty $config 'bootstrap_contract'
$server = Get-RequiredProperty $config 'server'
$mobile = Get-RequiredProperty $config 'mobile'
$batchAdmission = Get-RequiredProperty $config 'batch_admission'
$expectedAccount = [string](Get-RequiredProperty $controller 'runner_account')
if ([Environment]::UserName -cne $expectedAccount) {
    Stop-CoordinatedController "trusted coordinator must run as $expectedAccount"
}
$repositoryRoot = Get-FullPath (Get-RequiredProperty $controller 'source_checkout_root')
$integrationWorktree = Get-FullPath (Get-RequiredProperty $controller 'integration_worktree_root')
$toolingRoot = Get-FullPath (Get-RequiredProperty $controller 'tooling_checkout_root')
$configuredControllerScript = Get-FullPath (Get-RequiredProperty $controller 'controller_script')
$expectedControllerScript = Get-FullPath (Join-Path $toolingRoot 'tools\release\coordinated-release-controller.ps1')
if (-not [String]::Equals($configuredControllerScript, $expectedControllerScript,
        [StringComparison]::OrdinalIgnoreCase)) {
    Stop-CoordinatedController 'trusted controller script must be the pinned script inside tooling_checkout_root'
}
$allowedToolingSha = [string](Get-RequiredProperty $sourcePolicy 'allowed_tooling_sha').ToLowerInvariant()
if ($allowedToolingSha -notmatch '^[0-9a-f]{40}$') {
    Stop-CoordinatedController 'source policy must pin one canonical trusted tooling SHA'
}
if (-not (Test-Path -LiteralPath $repositoryRoot -PathType Container)) {
    Stop-CoordinatedController "source checkout was not found: $repositoryRoot"
}
if (-not (Test-Path -LiteralPath $integrationWorktree -PathType Container)) {
    Stop-CoordinatedController "integration worktree was not found: $integrationWorktree"
}
if (-not (Test-Path -LiteralPath $toolingRoot -PathType Container)) {
    Stop-CoordinatedController "immutable tooling checkout was not found: $toolingRoot"
}
if (-not (Test-Path -LiteralPath $configuredControllerScript -PathType Leaf)) {
    Stop-CoordinatedController "pinned controller script was not found: $configuredControllerScript"
}
$stateRoot = Get-FullPath (Get-RequiredProperty $controller 'state_root')
if ($stateRoot.StartsWith($repositoryRoot, [StringComparison]::OrdinalIgnoreCase) -or
    $stateRoot.StartsWith($toolingRoot, [StringComparison]::OrdinalIgnoreCase)) {
    Stop-CoordinatedController 'coordinator state root must be outside both source and tooling checkouts'
}
New-Item -ItemType Directory -Path $stateRoot -Force | Out-Null
$stateAcl = Get-Acl -LiteralPath $stateRoot
$aclText = $stateAcl.AccessToString
if ($aclText -notmatch [Regex]::Escape($expectedAccount)) {
    Stop-CoordinatedController 'coordinator state root ACL does not name the trusted runner account'
}
$checkoutHead = @(& git -C $toolingRoot rev-parse --verify 'HEAD^{commit}' 2>&1)
if ($LASTEXITCODE -ne 0 -or @($checkoutHead).Count -ne 1 -or
    [string]$checkoutHead[0] -cnotmatch '^[0-9a-f]{40}$' -or
    [string]$checkoutHead[0] -cne $allowedToolingSha) {
    Stop-CoordinatedController 'immutable tooling checkout HEAD does not match source_policy.allowed_tooling_sha'
}
$checkoutStatus = @(& git -C $toolingRoot status --porcelain 2>&1)
if ($LASTEXITCODE -ne 0 -or @($checkoutStatus).Count -ne 0) {
    Stop-CoordinatedController 'immutable tooling checkout is not clean'
}
$sourceStatus = @(& git -C $repositoryRoot status --porcelain 2>&1)
if ($LASTEXITCODE -ne 0 -or @($sourceStatus).Count -ne 0) {
    Stop-CoordinatedController 'source checkout is not clean'
}
$integrationStatus = @(& git -C $integrationWorktree status --porcelain 2>&1)
if ($LASTEXITCODE -ne 0 -or @($integrationStatus).Count -ne 0) {
    Stop-CoordinatedController 'integration worktree is not clean'
}
$canonicalScript = Get-FullPath (Join-Path $toolingRoot 'tools\release\accept-and-publish-test-server.ps1')
$configuredCanonicalScript = Get-FullPath (Get-RequiredProperty $server 'canonical_script')
if (-not [String]::Equals($configuredCanonicalScript, $canonicalScript,
        [StringComparison]::OrdinalIgnoreCase)) {
    Stop-CoordinatedController 'server canonical_script must be the pinned script inside tooling_checkout_root'
}
if (-not (Test-Path -LiteralPath $canonicalScript -PathType Leaf)) {
    Stop-CoordinatedController "pinned canonical coordinator script was not found: $canonicalScript"
}
$mobileBootstrapScript = Get-FullPath (Get-RequiredProperty $mobile 'bootstrap_script')
$expectedMobileBootstrapScript = Get-FullPath (Join-Path $toolingRoot 'tools\release\coordinated-mobile-bootstrap-transport.example.ps1')
if (-not [String]::Equals($mobileBootstrapScript, $expectedMobileBootstrapScript,
        [StringComparison]::OrdinalIgnoreCase)) {
    Stop-CoordinatedController 'mobile bootstrap script must be the pinned transport inside tooling_checkout_root'
}
if (-not (Test-Path -LiteralPath $expectedMobileBootstrapScript -PathType Leaf)) {
    Stop-CoordinatedController "pinned mobile bootstrap transport was not found: $expectedMobileBootstrapScript"
}
$generationScript = Join-Path $toolingRoot 'tools\dev\test-generation.ps1'
if (-not (Test-Path -LiteralPath $generationScript -PathType Leaf)) {
    Stop-CoordinatedController 'generation authority script is missing from the immutable tooling checkout'
}

function Get-GenerationSnapshot {
    $lines = @(& powershell -NoProfile -ExecutionPolicy Bypass -File $generationScript `
        status -RepositoryPath $repositoryRoot -Json 2>&1)
    if ($LASTEXITCODE -ne 0) { Stop-CoordinatedController "generation snapshot failed: $($lines -join ' ')" }
    try { return (($lines -join "`n") | ConvertFrom-Json) }
    catch { Stop-CoordinatedController 'generation authority returned unreadable JSON' }
}

function Assert-ExpectedCandidate {
    param([Parameter(Mandatory = $true)]$Snapshot)
    if (-not $ExpectedCandidateSha) { return }
    $actualGeneration = [string](Get-RequiredProperty $Snapshot 'generation')
    $actualCandidateSha = [string](Get-RequiredProperty $Snapshot 'integration_test_sha').ToLowerInvariant()
    if ($actualGeneration -cne $ExpectedGeneration -or $actualCandidateSha -cne $ExpectedCandidateSha) {
        Stop-CoordinatedController ("expected candidate $ExpectedGeneration@$ExpectedCandidateSha differs from " +
            "the authoritative Start snapshot $actualGeneration@$actualCandidateSha")
    }
}

function New-BatchAdmissionManifest {
    param(
        [Parameter(Mandatory = $true)][string]$Operation,
        [Parameter(Mandatory = $true)][object[]]$ResolvedBatchRequest,
        [string]$ParentOperation = '',
        [string]$ReservedGeneration = '',
        [string]$OriginalSourceSha = '',
        [string]$OriginalMasterSha = ''
    )
    $features = @($ResolvedBatchRequest | ForEach-Object {
            [pscustomobject][ordered]@{
                branch = [string]$_.branch
                sha = [string]$_.sha
                player_patch_note = [string]$_.player_patch_note
                worktree = [string]$_.worktree
            }
        })
    return [pscustomobject][ordered]@{
        schema_version = 1
        kind = 'ash-atlas-batch-admission-manifest'
        operation_id = $Operation
        parent_operation_id = $ParentOperation
        reserved_generation = $ReservedGeneration
        original_source_sha = $OriginalSourceSha
        original_master_sha = $OriginalMasterSha
        source_repository_root = $repositoryRoot
        integration_worktree_path = $integrationWorktree
        features = $features
        request_sha256 = Get-ControllerSha256 (ConvertTo-ControllerCanonicalJson @($features | ForEach-Object {
                    [pscustomobject][ordered]@{
                        branch = [string]$_.branch
                        sha = [string]$_.sha
                        player_patch_note = [string]$_.player_patch_note
                    }
                }))
        created_at_utc = (Get-Date).ToUniversalTime().ToString('o')
    }
}

function Read-BatchAdmissionManifest {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Operation,
        [Parameter(Mandatory = $true)][object[]]$ExpectedFeatures,
        [string]$ExpectedParentOperation = '',
        [string]$ExpectedReservedGeneration = '',
        [string]$ExpectedOriginalSourceSha = '',
        [string]$ExpectedOriginalMasterSha = ''
    )
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        Stop-CoordinatedController "durable batch admission manifest was not found: $Path"
    }
    try { $manifest = Get-Content -Raw -LiteralPath $Path -Encoding utf8 | ConvertFrom-Json }
    catch { Stop-CoordinatedController "durable batch admission manifest is unreadable: $($_.Exception.Message)" }
    if ([int](Get-RequiredProperty $manifest 'schema_version') -ne 1 -or
        [string](Get-RequiredProperty $manifest 'kind') -cne 'ash-atlas-batch-admission-manifest' -or
        [string](Get-RequiredProperty $manifest 'operation_id') -cne $Operation) {
        Stop-CoordinatedController 'durable batch admission manifest identity does not match the child operation'
    }
    if ([string](Get-RequiredProperty $manifest 'source_repository_root') -cne $repositoryRoot -or
        [string](Get-RequiredProperty $manifest 'integration_worktree_path') -cne $integrationWorktree) {
        Stop-CoordinatedController 'durable batch admission manifest source checkout identity changed'
    }
    if ($ExpectedParentOperation -and
        [string](Get-OptionalProperty $manifest 'parent_operation_id' '') -cne $ExpectedParentOperation) {
        Stop-CoordinatedController 'durable batch admission manifest parent operation identity changed'
    }
    if ($ExpectedReservedGeneration -and
        [string](Get-OptionalProperty $manifest 'reserved_generation' '') -cne $ExpectedReservedGeneration) {
        Stop-CoordinatedController 'durable batch admission manifest reserved generation changed'
    }
    if ($ExpectedOriginalSourceSha -and
        [string](Get-OptionalProperty $manifest 'original_source_sha' '').ToLowerInvariant() -cne $ExpectedOriginalSourceSha.ToLowerInvariant()) {
        Stop-CoordinatedController 'durable batch admission manifest original source identity changed'
    }
    if ($ExpectedOriginalMasterSha -and
        [string](Get-OptionalProperty $manifest 'original_master_sha' '').ToLowerInvariant() -cne $ExpectedOriginalMasterSha.ToLowerInvariant()) {
        Stop-CoordinatedController 'durable batch admission manifest original master identity changed'
    }
    $features = @((Get-RequiredProperty $manifest 'features'))
    if ($features.Count -ne @($ExpectedFeatures).Count) {
        Stop-CoordinatedController 'durable batch admission manifest feature count changed'
    }
    for ($index = 0; $index -lt $features.Count; $index++) {
        $expectedFeature = @($ExpectedFeatures)[$index]
        foreach ($field in @('branch', 'sha', 'player_patch_note', 'worktree')) {
            if ([string](Get-OptionalProperty $features[$index] $field '') -cne
                [string](Get-OptionalProperty $expectedFeature $field '')) {
                Stop-CoordinatedController 'durable batch admission manifest feature packet changed'
            }
        }
    }
    return $manifest
}

function Get-CurrentServerSha {
    $statusUri = [string](Get-RequiredProperty $server 'public_status_uri')
    try { $payload = Invoke-RestMethod -Uri $statusUri -TimeoutSec 15 }
    catch { Stop-CoordinatedController "current public server identity is unavailable: $($_.Exception.Message)" }
    $sha = [string](Get-RequiredProperty $payload 'game_sha').ToLowerInvariant()
    if ($sha -notmatch '^[0-9a-f]{40}$') { Stop-CoordinatedController 'current public server identity is not canonical' }
    return $sha
}

function Invoke-ControllerGit {
    param(
        [Parameter(Mandatory = $true)][string]$Repository,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )
    $output = @(& git -C $Repository @Arguments 2>&1)
    if ($LASTEXITCODE -ne 0) {
        Stop-CoordinatedController "git $($Arguments -join ' ') failed for the trusted source checkout"
    }
    return (($output -join "`n").Trim())
}

function Get-RegisteredWorktrees {
    $raw = Invoke-ControllerGit $repositoryRoot @('worktree', 'list', '--porcelain')
    $lines = @($raw -split "`n")
    $records = @()
    $current = $null
    foreach ($rawLine in $lines + @('')) {
        $line = ([string]$rawLine).TrimEnd("`r")
        if (-not $line) {
            if ($null -ne $current) { $records += [pscustomobject]$current }
            $current = $null
            continue
        }
        if ($line -like 'worktree *') {
            if ($null -ne $current) { $records += [pscustomobject]$current }
            $current = [ordered]@{ path = Get-FullPath ($line.Substring(9)); head = ''; branch = '' }
            continue
        }
        if ($null -eq $current) { continue }
        if ($line -like 'HEAD *') { $current.head = $line.Substring(5).Trim().ToLowerInvariant(); continue }
        if ($line -like 'branch refs/heads/*') {
            $current.branch = $line.Substring(18).Trim(); continue
        }
    }
    return @($records)
}

function Resolve-RegisteredBatchWorktrees {
    param([Parameter(Mandatory = $true)][object[]]$Requests)
    $records = @(Get-RegisteredWorktrees)
    $resolved = @()
    foreach ($request in $Requests) {
        $matches = @($records | Where-Object { [string]$_.branch -ceq [string]$request.branch })
        if ($matches.Count -ne 1) {
            Stop-CoordinatedController "batch branch is not registered in exactly one source worktree: $($request.branch)"
        }
        $record = $matches[0]
        if ([string]$record.head -cne [string]$request.sha) {
            Stop-CoordinatedController "registered worktree HEAD differs for $($request.branch)"
        }
        $status = Invoke-ControllerGit $record.path @('status', '--porcelain')
        if ($status) { Stop-CoordinatedController "batch source worktree is dirty: $($request.branch)" }
        $remote = Invoke-ControllerGit $repositoryRoot @('ls-remote', 'origin', "refs/heads/$($request.branch)")
        $remoteSha = if ($remote) { ([string]$remote -split '\s+')[0].ToLowerInvariant() } else { '' }
        if ($remoteSha -cne [string]$request.sha) {
            Stop-CoordinatedController "origin/$($request.branch) does not point to the requested exact SHA"
        }
        $resolved += [pscustomobject][ordered]@{
            branch = [string]$request.branch
            sha = [string]$request.sha
            player_patch_note = [string]$request.player_patch_note
            worktree = [string]$record.path
        }
    }
    return @($resolved)
}

function Get-PinnedOperationIdentity {
    param(
        [Parameter(Mandatory = $true)][string]$Operation,
        [Parameter(Mandatory = $true)][string]$Seed,
        [Parameter(Mandatory = $true)][string]$Manifest,
        [Parameter(Mandatory = $true)][string]$Dispatch
    )
    $sourcePath = if (Test-Path -LiteralPath $Manifest -PathType Leaf) { $Manifest }
        elseif (Test-Path -LiteralPath $Seed -PathType Leaf) { $Seed }
        elseif (Test-Path -LiteralPath $Dispatch -PathType Leaf) { $Dispatch }
        else { $null }
    $source = $null
    if ($sourcePath) {
        try { $source = Get-Content -Raw -LiteralPath $sourcePath -Encoding utf8 | ConvertFrom-Json }
        catch { Stop-CoordinatedController "durable coordinated identity is unreadable: $($_.Exception.Message)" }
    } else {
        $claim = Get-CoordinatedSourceClaimForOperation $Operation
        if ($null -eq $claim) {
            Stop-CoordinatedController 'Resume requires the durable pinned dispatch, seed, manifest, or active start claim from the original operation'
        }
        $source = Get-OptionalProperty $claim 'dispatch' $claim
    }
    $sourceOperation = Get-OptionalProperty $source 'operation_id' ''
    if ([string]$sourceOperation -cne $Operation) {
        Stop-CoordinatedController 'durable coordinated identity operation ID does not match Resume'
    }
    $pinnedProperty = $source.PSObject.Properties['pinned']
    $pinned = if ($null -ne $pinnedProperty) { $pinnedProperty.Value } else { $source }
    if ($null -eq $pinned) {
        Stop-CoordinatedController 'durable coordinated identity has no pinned server tuple'
    }
    $identity = [pscustomobject][ordered]@{
        generation = [string](Get-OptionalProperty $pinned 'generation' '')
        server_sha = [string](Get-OptionalProperty $pinned 'server_sha' '')
        accepted_master_sha = [string](Get-OptionalProperty $pinned 'accepted_master_sha' '')
        current_server_sha = [string](Get-OptionalProperty $pinned 'current_server_sha' '')
    }
    if ($identity.generation -notmatch '^t\d{3,4}$' -or
        $identity.server_sha -notmatch '^[0-9a-f]{40}$' -or
        $identity.accepted_master_sha -notmatch '^[0-9a-f]{40}$' -or
        $identity.current_server_sha -notmatch '^[0-9a-f]{40}$') {
        Stop-CoordinatedController 'durable coordinated identity contains a non-canonical pinned tuple'
    }
    return $identity
}

function Write-ControlJson([string]$Path, $Value) {
    $directory = Split-Path -Parent $Path
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    $temporary = "$Path.$PID.tmp"
    try {
        [IO.File]::WriteAllText(
            $temporary,
            ($Value | ConvertTo-Json -Depth 32) + [Environment]::NewLine,
            [Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $temporary -Destination $Path -Force
    } finally {
        if (Test-Path -LiteralPath $temporary) {
            Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
        }
    }
}

function Get-CoordinatedState([string]$Operation) {
    $path = Join-Path $stateRoot "$Operation.json"
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
    try { return Get-Content -Raw -LiteralPath $path -Encoding utf8 | ConvertFrom-Json }
    catch { Stop-CoordinatedController "durable state is unreadable for $Operation" }
}

function Get-CoordinatedPhase($State) {
    if ($null -eq $State -or $null -eq $State.coordinated_manifest) { return '' }
    return [string]$State.coordinated_manifest.current_phase
}

function Test-CoordinatedOperationTerminal([string]$Operation) {
    if (-not $Operation) { return $false }
    $statePath = Join-Path $stateRoot "$Operation.json"
    if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) { return $false }
    try { $state = Get-Content -Raw -LiteralPath $statePath -Encoding utf8 | ConvertFrom-Json }
    catch { Stop-CoordinatedController "durable state is unreadable for $Operation" }
    $manifest = Get-OptionalProperty $state 'coordinated_manifest' $null
    $phase = [string](Get-OptionalProperty $manifest 'current_phase' '')
    $status = [string](Get-OptionalProperty $state 'coordinated_status' '')
    $completion = Get-OptionalProperty $manifest 'completion' $null
    $completionStatus = [string](Get-OptionalProperty $completion 'status' '')
    return $phase -ceq 'completed' -or $status -ceq 'completed' -or
        $completionStatus -ceq 'completed'
}

function Get-CoordinatedSourceClaimPath {
    param(
        [Parameter(Mandatory = $true)][string]$Generation,
        [Parameter(Mandatory = $true)][string]$SourceSha
    )
    $sourceIdentity = [ordered]@{
        generation = $Generation
        source_sha = $SourceSha
    }
    $identityHash = Get-ControllerSha256 (ConvertTo-ControllerCanonicalJson $sourceIdentity)
    return Join-Path $stateRoot "coordinated-source-$identityHash.claim.json"
}

function Read-CoordinatedSourceClaim([string]$Path) {
    try { return Get-Content -Raw -LiteralPath $Path -Encoding utf8 | ConvertFrom-Json }
    catch { return $null }
}

function Get-CoordinatedSourceClaimForOperation([string]$Operation) {
    foreach ($file in @(Get-ChildItem -LiteralPath $stateRoot -Filter 'coordinated-source-*.claim.json' -File -ErrorAction SilentlyContinue)) {
        $claim = Read-CoordinatedSourceClaim $file.FullName
        if ($null -eq $claim) { continue }
        if ([string](Get-OptionalProperty $claim 'operation_id' '') -ceq $Operation) {
            return $claim
        }
    }
    return $null
}

function Write-ExclusiveControlJson {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$Value
    )
    $directory = Split-Path -Parent $Path
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    $temporary = "$Path.$PID.$([guid]::NewGuid().ToString('n')).tmp"
    try {
        $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($Value | ConvertTo-Json -Depth 32) + [Environment]::NewLine)
        [IO.File]::WriteAllBytes($temporary, $bytes)
        [IO.File]::Move($temporary, $Path)
        return $true
    } catch [IO.IOException] {
        return $false
    } finally {
        if (Test-Path -LiteralPath $temporary) {
            Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
        }
    }
}

function Invoke-CoordinatedClaimLock {
    param([Parameter(Mandatory = $true)][scriptblock]$Action)
    $lockPath = Join-Path $stateRoot 'coordinated-start.claim.lock'
    $lock = $null
    for ($attempt = 0; $attempt -lt 1200 -and $null -eq $lock; $attempt++) {
        try {
            $lock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate,
                [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
        } catch [IO.IOException] {
            Start-Sleep -Milliseconds 25
        }
    }
    if ($null -eq $lock) {
        Stop-CoordinatedController 'coordinated start claim lock remained busy; inspect and Resume the existing operation'
    }
    try { return & $Action }
    finally { $lock.Dispose() }
}

function Get-PendingCoordinatedOperations {
    $files = @(Get-ChildItem -LiteralPath $stateRoot -Filter '*.json' -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}\.json$' })
    $terminalOperations = @{}
    foreach ($file in $files) {
        try { $candidate = Get-Content -Raw -LiteralPath $file.FullName -Encoding utf8 | ConvertFrom-Json }
        catch { continue }
        $operation = [string](Get-OptionalProperty $candidate 'operation_id' '')
        $manifest = Get-OptionalProperty $candidate 'coordinated_manifest' $null
        if (-not $operation -or $null -eq $manifest) { continue }
        $phase = [string](Get-OptionalProperty $manifest 'current_phase' '')
        $status = [string](Get-OptionalProperty $candidate 'coordinated_status' '')
        $completion = Get-OptionalProperty $manifest 'completion' $null
        $completionStatus = [string](Get-OptionalProperty $completion 'status' '')
        if ($phase -ceq 'completed' -or $status -ceq 'completed' -or $completionStatus -ceq 'completed') {
            $terminalOperations[$operation] = $true
        }
    }

    $records = @()
    foreach ($file in $files) {
        try { $candidate = Get-Content -Raw -LiteralPath $file.FullName -Encoding utf8 | ConvertFrom-Json }
        catch { continue }
        $operation = [string](Get-OptionalProperty $candidate 'operation_id' '')
        if ($operation -notmatch '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$' -or
            $terminalOperations.ContainsKey($operation)) { continue }
        $kind = [string](Get-OptionalProperty $candidate 'kind' '')
        $requestedMode = [string](Get-OptionalProperty $candidate 'requested_mode' '')
        if (-not $requestedMode -and $kind -eq 'ash-atlas-coordinated-mobile-dispatch-request') {
            $requestedMode = 'CoordinatedRelease'
        }
        if ($requestedMode -cne 'CoordinatedRelease') { continue }
        $pinned = Get-OptionalProperty $candidate 'pinned' $null
        $generation = [string](Get-OptionalProperty $candidate 'generation' '')
        if (-not $generation) { $generation = [string](Get-OptionalProperty $pinned 'generation' '') }
        $sourceSha = [string](Get-OptionalProperty $candidate 'source_sha' '')
        if (-not $sourceSha) { $sourceSha = [string](Get-OptionalProperty $candidate 'server_sha' '') }
        if (-not $sourceSha) { $sourceSha = [string](Get-OptionalProperty $pinned 'server_sha' '') }
        $admissionIdentity = Get-CoordinatedBatchAdmissionIdentity $candidate
        $isGenerationReservation = $false
        if ($null -ne $admissionIdentity) {
            $generation = [string]$admissionIdentity.generation
            $sourceSha = [string]$admissionIdentity.source_sha
            $isGenerationReservation = [bool]$admissionIdentity.is_reservation
        }
        if ($generation -notmatch '^t\d{3,4}$' -or
            ($sourceSha -notmatch '^[0-9a-f]{40}$' -and -not $isGenerationReservation)) { continue }
        $records += [pscustomobject][ordered]@{
            operation_id = $operation
            generation = $generation
            source_sha = $sourceSha
            updated_at_utc = [string](Get-OptionalProperty $candidate 'updated_at_utc' '')
            path = $file.FullName
            is_claim = $false
            is_generation_reservation = $isGenerationReservation
        }
    }

    foreach ($file in @(Get-ChildItem -LiteralPath $stateRoot -Filter 'coordinated-source-*.claim.json' -File -ErrorAction SilentlyContinue)) {
        $claim = Read-CoordinatedSourceClaim $file.FullName
        if ($null -eq $claim) { continue }
        $operation = [string](Get-OptionalProperty $claim 'operation_id' '')
        if ($operation -notmatch '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$' -or
            $terminalOperations.ContainsKey($operation)) { continue }
        $generation = [string](Get-OptionalProperty $claim 'generation' '')
        $sourceSha = [string](Get-OptionalProperty $claim 'source_sha' '')
        $claimDispatch = Get-OptionalProperty $claim 'dispatch' $null
        $admissionIdentity = if ($null -ne $claimDispatch) {
            Get-CoordinatedBatchAdmissionIdentity $claimDispatch
        } else { $null }
        $isGenerationReservation = $false
        if ($null -ne $admissionIdentity) {
            $generation = [string]$admissionIdentity.generation
            $sourceSha = [string]$admissionIdentity.source_sha
            $isGenerationReservation = [bool]$admissionIdentity.is_reservation
        }
        if ($generation -notmatch '^t\d{3,4}$' -or
            ($sourceSha -notmatch '^[0-9a-f]{40}$' -and -not $isGenerationReservation)) { continue }
        $records += [pscustomobject][ordered]@{
            operation_id = $operation
            generation = $generation
            source_sha = $sourceSha
            updated_at_utc = [string](Get-OptionalProperty $claim 'created_at_utc' '')
            path = $file.FullName
            is_claim = $true
            is_generation_reservation = $isGenerationReservation
        }
    }
    return @($records | Group-Object operation_id | ForEach-Object {
            $reservation = @($_.Group | Where-Object { [bool]$_.is_generation_reservation } |
                Sort-Object updated_at_utc | Select-Object -Last 1)
            if ($reservation.Count -gt 0) { $reservation[0]; return }
            $dispatch = @($_.Group | Where-Object { -not [bool]$_.is_claim } | Sort-Object updated_at_utc | Select-Object -Last 1)
            if ($dispatch.Count -gt 0) { $dispatch[0] }
            else { @($_.Group | Sort-Object updated_at_utc | Select-Object -Last 1)[0] }
        })
}

function Claim-CoordinatedStart {
    param(
        [Parameter(Mandatory = $true)][string]$Operation,
        [Parameter(Mandatory = $true)][string]$Generation,
        [Parameter(Mandatory = $true)][string]$SourceSha,
        [Parameter(Mandatory = $true)][string]$AcceptedMasterSha,
        [Parameter(Mandatory = $true)][string]$CurrentServerSha,
        [Parameter(Mandatory = $true)][string]$RequestSha256,
        [Parameter(Mandatory = $true)]$Dispatch
    )
    $claim = [pscustomobject][ordered]@{
        schema_version = 1
        kind = 'ash-atlas-coordinated-start-claim'
        operation_id = $Operation
        generation = $Generation
        source_sha = $SourceSha
        accepted_master_sha = $AcceptedMasterSha
        current_server_sha = $CurrentServerSha
        request_sha256 = $RequestSha256
        dispatch = $Dispatch
        created_at_utc = (Get-Date).ToUniversalTime().ToString('o')
    }
    return Invoke-CoordinatedClaimLock {
        $claimPath = Get-CoordinatedSourceClaimPath $Generation $SourceSha
        for ($attempt = 0; $attempt -lt 3; $attempt++) {
            $pending = @(Get-PendingCoordinatedOperations | Where-Object {
                    [string]$_.generation -ceq $Generation -and
                    ([string]$_.source_sha -ceq $SourceSha -or [bool]$_.is_generation_reservation)
                })
            if ($pending.Count -gt 0) {
                Stop-CoordinatedController "coordinated operation $($pending[0].operation_id) already owns generation $Generation at $SourceSha; use Resume"
            }
            if (Test-Path -LiteralPath $claimPath -PathType Leaf) {
                $existing = Read-CoordinatedSourceClaim $claimPath
                if ($null -eq $existing) {
                    Stop-CoordinatedController "active coordinated start claim is unreadable for generation $Generation at $SourceSha; inspect the claim before resuming"
                }
                $existingOperation = [string](Get-OptionalProperty $existing 'operation_id' '')
                if (-not $existingOperation -or
                    [string](Get-OptionalProperty $existing 'generation' '') -cne $Generation -or
                    [string](Get-OptionalProperty $existing 'source_sha' '') -cne $SourceSha) {
                    Stop-CoordinatedController 'active coordinated start claim has an unexpected source identity'
                }
                if (Test-CoordinatedOperationTerminal $existingOperation) {
                    Remove-Item -LiteralPath $claimPath -Force
                    continue
                }
                Stop-CoordinatedController "coordinated operation $existingOperation already owns generation $Generation at $SourceSha; use Resume"
            }
            if (Write-ExclusiveControlJson $claimPath $claim) {
                $raced = @(Get-PendingCoordinatedOperations | Where-Object {
                        [string]$_.generation -ceq $Generation -and
                        ([string]$_.source_sha -ceq $SourceSha -or [bool]$_.is_generation_reservation) -and
                        [string]$_.operation_id -cne $Operation
                    })
                if ($raced.Count -gt 0) {
                    Remove-Item -LiteralPath $claimPath -Force -ErrorAction SilentlyContinue
                    Stop-CoordinatedController "coordinated operation $($raced[0].operation_id) already owns generation $Generation at $SourceSha; use Resume"
                }
                return [pscustomobject][ordered]@{ path = $claimPath; operation_id = $Operation }
            }
        }
        Stop-CoordinatedController 'coordinated start claim changed concurrently; inspect and Resume the existing operation'
    }
}

function Update-CoordinatedStartClaim {
    param(
        [Parameter(Mandatory = $true)][string]$Operation,
        [Parameter(Mandatory = $true)][string]$DispatchPath,
        [Parameter(Mandatory = $true)]$Dispatch,
        [Parameter(Mandatory = $true)]$Snapshot,
        [Parameter(Mandatory = $true)][string]$Status,
        [switch]$AllowMissing
    )
    return Invoke-CoordinatedClaimLock {
        $existing = Get-CoordinatedSourceClaimForOperation $Operation
        if ($null -eq $existing) {
            if ($AllowMissing) {
                Update-InitialDispatchRequest $DispatchPath $Dispatch $Snapshot $Status
                return [pscustomobject][ordered]@{ path = ''; operation_id = $Operation }
            }
            Stop-CoordinatedController "coordinated start claim for $Operation is missing; inspect the durable operation before resuming"
        }
        $oldGeneration = [string](Get-OptionalProperty $existing 'generation' '')
        $oldSourceSha = [string](Get-OptionalProperty $existing 'source_sha' '')
        if ($oldGeneration -notmatch '^t\d{3,4}$' -or $oldSourceSha -notmatch '^[0-9a-f]{40}$') {
            Stop-CoordinatedController "coordinated start claim for $Operation has a non-canonical source identity"
        }
        $newGeneration = [string]$Snapshot.generation
        $newSourceSha = [string]$Snapshot.integration_test_sha
        $newMasterSha = [string]$Snapshot.master_sha
        if ($newGeneration -notmatch '^t\d{3,4}$' -or $newSourceSha -notmatch '^[0-9a-f]{40}$' -or
            $newMasterSha -notmatch '^[0-9a-f]{40}$') {
            Stop-CoordinatedController "coordinated accepted source identity for $Operation is not canonical"
        }
        $requestSha = [string](Get-OptionalProperty $existing 'request_sha256' '')
        $currentServerSha = [string](Get-OptionalProperty $existing 'current_server_sha' '')
        $oldClaimPath = Get-CoordinatedSourceClaimPath $oldGeneration $oldSourceSha
        $newClaimPath = Get-CoordinatedSourceClaimPath $newGeneration $newSourceSha

        $updatedClaim = [pscustomobject][ordered]@{
            schema_version = 1
            kind = 'ash-atlas-coordinated-start-claim'
            operation_id = $Operation
            generation = $newGeneration
            source_sha = $newSourceSha
            accepted_master_sha = $newMasterSha
            current_server_sha = $currentServerSha
            request_sha256 = $requestSha
            dispatch = $Dispatch
            created_at_utc = [string](Get-OptionalProperty $existing 'created_at_utc' (Get-Date).ToUniversalTime().ToString('o'))
            updated_at_utc = (Get-Date).ToUniversalTime().ToString('o')
        }

        if ((Test-Path -LiteralPath $newClaimPath -PathType Leaf) -and
            -not ([String]::Equals($newClaimPath, $oldClaimPath, [StringComparison]::OrdinalIgnoreCase))) {
            $destination = Read-CoordinatedSourceClaim $newClaimPath
            if ($null -eq $destination) {
                Stop-CoordinatedController "coordinated accepted claim destination is unreadable for $Operation"
            }
            $destinationOperation = [string](Get-OptionalProperty $destination 'operation_id' '')
            if ($destinationOperation -cne $Operation) {
                if (-not (Test-CoordinatedOperationTerminal $destinationOperation)) {
                    Stop-CoordinatedController "coordinated accepted source is already claimed by $destinationOperation"
                }
            }
            Remove-Item -LiteralPath $newClaimPath -Force
        }

        # Check the accepted destination owner before rewriting the dispatch.
        # A concurrent Start may have claimed the accepted source after the
        # admission child completed but before this parent migrated its claim.
        # Keep that rejection recoverable with the original dispatch/claim pair.
        Update-InitialDispatchRequest $DispatchPath $Dispatch $Snapshot $Status
        if ([String]::Equals($newClaimPath, $oldClaimPath, [StringComparison]::OrdinalIgnoreCase)) {
            Remove-Item -LiteralPath $oldClaimPath -Force
        }
        if (-not (Write-ExclusiveControlJson $newClaimPath $updatedClaim)) {
            Stop-CoordinatedController "coordinated accepted source claim could not be published for $Operation"
        }
        if (-not ([String]::Equals($newClaimPath, $oldClaimPath, [StringComparison]::OrdinalIgnoreCase)) -and
            (Test-Path -LiteralPath $oldClaimPath -PathType Leaf)) {
            Remove-Item -LiteralPath $oldClaimPath -Force
        }
        return [pscustomobject][ordered]@{ path = $newClaimPath; operation_id = $Operation }
    }
}

function Get-CoordinatedBatchAdmissionIdentity($Dispatch) {
    $admissionOperation = [string](Get-OptionalProperty $Dispatch 'batch_admission_operation_id' '')
    if ($admissionOperation -notmatch '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$') { return $null }
    $parentOperation = [string](Get-OptionalProperty $Dispatch 'operation_id' '')
    if ($parentOperation -notmatch '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$') { return $null }
    $reservedGeneration = [string](Get-OptionalProperty $Dispatch 'batch_admission_reserved_generation' '')
    $originalSourceSha = [string](Get-OptionalProperty $Dispatch 'batch_admission_original_source_sha' '').ToLowerInvariant()
    $originalMasterSha = [string](Get-OptionalProperty $Dispatch 'batch_admission_original_master_sha' '').ToLowerInvariant()
    if ($reservedGeneration -notmatch '^t\d{3,4}$' -or
        $originalSourceSha -notmatch '^[0-9a-f]{40}$' -or
        $originalMasterSha -notmatch '^[0-9a-f]{40}$') { return $null }

    $reservation = [pscustomobject][ordered]@{
        generation = $reservedGeneration
        source_sha = ''
        admission_operation_id = $admissionOperation
        parent_operation_id = $parentOperation
        is_reservation = $true
        accepted = $false
    }
    $manifestPath = Join-Path $stateRoot "$admissionOperation.batch-admission-manifest.json"
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { return $reservation }
    try { $manifest = Get-Content -Raw -LiteralPath $manifestPath -Encoding utf8 | ConvertFrom-Json }
    catch { return $reservation }
    if ([int](Get-OptionalProperty $manifest 'schema_version' 0) -ne 1 -or
        [string](Get-OptionalProperty $manifest 'kind' '') -cne 'ash-atlas-batch-admission-manifest' -or
        [string](Get-OptionalProperty $manifest 'operation_id' '') -cne $admissionOperation -or
        [string](Get-OptionalProperty $manifest 'parent_operation_id' '') -cne $parentOperation -or
        [string](Get-OptionalProperty $manifest 'reserved_generation' '') -cne $reservedGeneration -or
        [string](Get-OptionalProperty $manifest 'original_source_sha' '').ToLowerInvariant() -cne $originalSourceSha -or
        [string](Get-OptionalProperty $manifest 'original_master_sha' '').ToLowerInvariant() -cne $originalMasterSha) {
        return $reservation
    }
    $admissionPath = Join-Path $stateRoot "$admissionOperation.json"
    if (-not (Test-Path -LiteralPath $admissionPath -PathType Leaf)) { return $reservation }
    try { $admissionState = Get-Content -Raw -LiteralPath $admissionPath -Encoding utf8 | ConvertFrom-Json }
    catch { return $reservation }
    if ([string](Get-OptionalProperty $admissionState 'operation_id' '') -cne $admissionOperation -or
        [string](Get-OptionalProperty $admissionState 'requested_mode' '') -cne 'IntegrateBatchAdmission' -or
        -not [bool](Get-OptionalProperty $admissionState 'batch_admission_accepted' $false)) {
        return $reservation
    }
    $generation = [string](Get-OptionalProperty $admissionState 'accepted_generation' '')
    $sourceSha = [string](Get-OptionalProperty $admissionState 'accepted_integration_sha' '').ToLowerInvariant()
    $stateOriginalMaster = [string](Get-OptionalProperty $admissionState 'original_master_sha' '').ToLowerInvariant()
    $stateOriginalSource = [string](Get-OptionalProperty $admissionState 'original_integration_sha' '').ToLowerInvariant()
    if ($generation -notmatch '^t\d{3,4}$' -or $sourceSha -notmatch '^[0-9a-f]{40}$' -or
        $generation -cne $reservedGeneration -or $stateOriginalMaster -cne $originalMasterSha -or
        $stateOriginalSource -notmatch '^[0-9a-f]{40}$' -or
        $stateOriginalSource -cne $originalSourceSha) { return $reservation }
    return [pscustomobject][ordered]@{
        generation = $generation
        source_sha = $sourceSha
        admission_operation_id = $admissionOperation
        parent_operation_id = $parentOperation
        is_reservation = $true
        accepted = $true
    }
}

function New-InitialDispatchRequest {
    param(
        [Parameter(Mandatory = $true)][string]$Operation,
        [Parameter(Mandatory = $true)]$Snapshot,
        [Parameter(Mandatory = $true)][string]$CurrentServer,
        [object[]]$BatchRequest = @(),
        [object[]]$ResolvedBatchRequest = @(),
        [string]$BatchAdmissionOperationId = '',
        [string]$ExpectedGeneration = '',
        [string]$ExpectedCandidateSha = '',
        [string]$ExpectedDeliveryMode = ''
    )
    $hasBatch = @($BatchRequest).Count -gt 0
    $dispatchNonce = New-DispatchNonce
    return [pscustomobject][ordered]@{
        schema_version = 2
        kind = 'ash-atlas-coordinated-mobile-dispatch-request'
        operation_id = $Operation
        requested_mode = 'CoordinatedRelease'
        batch_request_schema = if ($hasBatch) { 'ash-atlas-batch-request/v1' } else { '' }
        batch_request = @($BatchRequest)
        batch_request_sha256 = if ($hasBatch) {
            Get-ControllerSha256 (ConvertTo-ControllerCanonicalJson @($BatchRequest))
        } else { '' }
        batch_resolved_worktrees = @($ResolvedBatchRequest)
        batch_admission_operation_id = $BatchAdmissionOperationId
        batch_admission_reserved_generation = if ($hasBatch) {
            [string](Get-OptionalProperty $Snapshot 'next_generation' '')
        } else { '' }
        batch_admission_original_source_sha = if ($hasBatch) {
            [string]$Snapshot.integration_test_sha
        } else { '' }
        batch_admission_original_master_sha = if ($hasBatch) {
            [string]$Snapshot.master_sha
        } else { '' }
        batch_admission_status = if ($hasBatch) { 'requested' } else { 'not_requested' }
        batch_admission_accepted_sha = ''
        batch_admission_accepted_generation = ''
        coordinated_status = 'waiting'
        action = 'start'
        generation = [string]$Snapshot.generation
        server_sha = [string]$Snapshot.integration_test_sha
        accepted_master_sha = [string]$Snapshot.master_sha
        current_server_sha = $CurrentServer
        expected_generation = $ExpectedGeneration
        expected_candidate_sha = $ExpectedCandidateSha
        expected_delivery_mode = $ExpectedDeliveryMode
        source_repository = [string](Get-RequiredProperty $mobile 'source_repository')
        source_ref = "refs/tags/test/$([string]$Snapshot.generation)"
        source_sha = [string]$Snapshot.integration_test_sha
        control_repository = [string](Get-RequiredProperty $mobile 'control_repository')
        control_workflow = [string](Get-RequiredProperty $mobile 'workflow')
        control_ref = [string](Get-RequiredProperty $mobile 'workflow_ref')
        control_sha = [string](Get-RequiredProperty $mobile 'workflow_sha').ToLowerInvariant()
        tooling_sha = [string](Get-RequiredProperty $mobile 'tooling_sha').ToLowerInvariant()
        artifact_name = "ash-atlas-private-mobile-$Operation"
        dispatch_nonce = $dispatchNonce
        dispatch_name = Get-DispatchName $Operation $dispatchNonce
        pinned = [ordered]@{
            generation = [string]$Snapshot.generation
            server_sha = [string]$Snapshot.integration_test_sha
            accepted_master_sha = [string]$Snapshot.master_sha
            current_server_sha = $CurrentServer
        }
        status = 'requested'
        requested_at_utc = (Get-Date).ToUniversalTime().ToString('o')
        updated_at_utc = (Get-Date).ToUniversalTime().ToString('o')
    }
}

function Update-InitialDispatchRequest {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$Dispatch,
        [Parameter(Mandatory = $true)]$Snapshot,
        [Parameter(Mandatory = $true)][string]$Status
    )
    $Dispatch.generation = [string]$Snapshot.generation
    $Dispatch.server_sha = [string]$Snapshot.integration_test_sha
    $Dispatch.accepted_master_sha = [string]$Snapshot.master_sha
    $Dispatch.source_ref = "refs/tags/test/$([string]$Snapshot.generation)"
    $Dispatch.source_sha = [string]$Snapshot.integration_test_sha
    $Dispatch.pinned.generation = [string]$Snapshot.generation
    $Dispatch.pinned.server_sha = [string]$Snapshot.integration_test_sha
    $Dispatch.pinned.accepted_master_sha = [string]$Snapshot.master_sha
    $Dispatch.batch_admission_status = $Status
    $Dispatch.updated_at_utc = (Get-Date).ToUniversalTime().ToString('o')
    Write-ControlJson $Path $Dispatch
}

function Read-CoordinatedSeedDeliveryPolicy {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Operation
    )
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        Stop-CoordinatedController 'mobile bootstrap returned without its durable seed policy'
    }
    try { $seed = Get-Content -Raw -LiteralPath $Path -Encoding utf8 | ConvertFrom-Json }
    catch { Stop-CoordinatedController 'coordinated mobile seed policy is not valid JSON' }
    if ([int](Get-OptionalProperty $seed 'schema_version' 0) -ne 1 -or
        [string](Get-OptionalProperty $seed 'kind' '') -cne 'ash-atlas-coordinated-release-seed' -or
        [string](Get-OptionalProperty $seed 'operation_id' '') -cne $Operation) {
        Stop-CoordinatedController 'coordinated mobile seed policy identity is not bound to the operation'
    }
    $deliveryMode = [string](Get-OptionalProperty $seed 'delivery_mode' 'production')
    if (-not $deliveryMode) { $deliveryMode = 'production' }
    if ($deliveryMode -notin @('production', 'daily-testers')) {
        Stop-CoordinatedController "unsupported coordinated delivery mode '$deliveryMode'"
    }
    $apps = Get-OptionalProperty $seed 'apps' $null
    if ($null -eq $apps) { Stop-CoordinatedController 'coordinated mobile seed has no app delivery policy' }
    $destinations = [ordered]@{}
    foreach ($platform in @('ios', 'android')) {
        $app = Get-OptionalProperty $apps $platform $null
        if ($null -eq $app) { Stop-CoordinatedController "coordinated mobile seed is missing $platform delivery policy" }
        $candidate = Get-OptionalProperty $app 'candidate' $null
        $destination = if ($null -ne $candidate) {
            Get-OptionalProperty $candidate 'tester_destination' (Get-OptionalProperty $candidate 'testerDestination' $null)
        } else { $null }
        if ($null -eq $destination) {
            $destination = Get-OptionalProperty $app 'tester_destination' (Get-OptionalProperty $app 'testerDestination' $null)
        }
        if ($deliveryMode -eq 'daily-testers' -and $null -eq $destination) {
            Stop-CoordinatedController "$platform daily tester destination is missing from the seed"
        }
        if ($deliveryMode -eq 'production' -and $null -ne $destination) {
            Stop-CoordinatedController "$platform tester destination requires daily-testers delivery mode"
        }
        $destinations[$platform] = $destination
    }
    $policy = [ordered]@{
        delivery_mode = $deliveryMode
        tester_destinations = [pscustomobject]$destinations
    }
    return [pscustomobject][ordered]@{
        policy = [pscustomobject]$policy
        policy_sha256 = Get-ControllerSha256 (ConvertTo-ControllerCanonicalJson $policy)
    }
}

function Set-CoordinatedDispatchProperty {
    param(
        [Parameter(Mandatory = $true)]$Object,
        [Parameter(Mandatory = $true)][string]$Name,
        [AllowNull()]$Value
    )
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) {
        $Object | Add-Member -NotePropertyName $Name -NotePropertyValue $Value | Out-Null
    } else {
        $property.Value = $Value
    }
}

function Update-CoordinatedDispatchDeliveryPolicy {
    param(
        [Parameter(Mandatory = $true)][string]$DispatchPath,
        [Parameter(Mandatory = $true)][string]$SeedPath,
        [Parameter(Mandatory = $true)][string]$Operation
    )
    if (-not (Test-Path -LiteralPath $DispatchPath -PathType Leaf)) {
        Stop-CoordinatedController 'durable mobile dispatch request is missing before seed policy binding'
    }
    try { $dispatch = Get-Content -Raw -LiteralPath $DispatchPath -Encoding utf8 | ConvertFrom-Json }
    catch { Stop-CoordinatedController 'durable mobile dispatch request is unreadable before seed policy binding' }
    $seedPolicy = Read-CoordinatedSeedDeliveryPolicy $SeedPath $Operation
    $policyHash = [string]$seedPolicy.policy_sha256
    $priorHash = [string](Get-OptionalProperty $dispatch 'delivery_policy_sha256' '')
    if ($priorHash -and $priorHash -cne $policyHash) {
        Stop-CoordinatedController 'mobile delivery policy changed during Resume'
    }
    $priorMode = [string](Get-OptionalProperty $dispatch 'delivery_mode' '')
    if ($priorMode -and $priorMode -cne [string]$seedPolicy.policy.delivery_mode) {
        Stop-CoordinatedController 'mobile delivery mode changed during Resume'
    }
    $expectedMode = [string](Get-OptionalProperty $dispatch 'expected_delivery_mode' '')
    if ($expectedMode -and $expectedMode -cne [string]$seedPolicy.policy.delivery_mode) {
        Stop-CoordinatedController "mobile delivery mode '$($seedPolicy.policy.delivery_mode)' does not match the requested '$expectedMode' mode"
    }
    $priorDestinations = Get-OptionalProperty $dispatch 'tester_destinations' $null
    if ($null -ne $priorDestinations -and
        (ConvertTo-ControllerCanonicalJson $priorDestinations) -cne
        (ConvertTo-ControllerCanonicalJson $seedPolicy.policy.tester_destinations)) {
        Stop-CoordinatedController 'mobile tester destinations changed during Resume'
    }
    Set-CoordinatedDispatchProperty $dispatch 'delivery_mode' ([string]$seedPolicy.policy.delivery_mode)
    Set-CoordinatedDispatchProperty $dispatch 'tester_destinations' $seedPolicy.policy.tester_destinations
    Set-CoordinatedDispatchProperty $dispatch 'delivery_policy_sha256' $policyHash
    Set-CoordinatedDispatchProperty $dispatch 'delivery_policy_source' 'coordinated-seed'
    Set-CoordinatedDispatchProperty $dispatch 'updated_at_utc' (Get-Date).ToUniversalTime().ToString('o')
    Write-ControlJson $DispatchPath $dispatch
    return $dispatch
}

function Invoke-MobileBootstrap {
    param(
        [Parameter(Mandatory = $true)][ValidateSet('Start', 'Resume', 'PostHealth')][string]$TransportAction,
        [Parameter(Mandatory = $true)][string]$Operation,
        [Parameter(Mandatory = $true)]$Snapshot,
        [Parameter(Mandatory = $true)][string]$CurrentServer,
        [Parameter(Mandatory = $true)][string]$SeedPath,
        [Parameter(Mandatory = $true)][string]$ReceiptPath,
        [Parameter(Mandatory = $true)][string]$DispatchPath,
        [string]$EvidencePath,
        [string]$AuthenticatedEvidencePath
    )
    $arguments = @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $mobileBootstrapScript,
        '-Action', $TransportAction, '-OperationId', $Operation,
        '-Generation', [string]$Snapshot.generation,
        '-ServerSha', [string]$Snapshot.integration_test_sha,
        '-AcceptedMasterSha', [string]$Snapshot.master_sha,
        '-CurrentServerSha', $CurrentServer,
        '-OutputSeedPath', $SeedPath,
        '-OutputReceiptPath', $ReceiptPath,
        '-DispatchRecordPath', $DispatchPath
    )
    $arguments += @(
        '-ControlRepository', [string](Get-RequiredProperty $mobile 'control_repository'),
        '-ControlWorkflow', [string](Get-RequiredProperty $mobile 'workflow'),
        '-ControlRef', [string](Get-RequiredProperty $mobile 'workflow_ref'),
        '-ControlSha', [string](Get-RequiredProperty $mobile 'workflow_sha'),
        '-ToolingSha', [string](Get-RequiredProperty $mobile 'tooling_sha'),
        '-SourceRepository', [string](Get-RequiredProperty $mobile 'source_repository')
    )
    if ($EvidencePath) { $arguments += @('-ServerEvidencePath', $EvidencePath) }
    if ($AuthenticatedEvidencePath) { $arguments += @('-AuthenticatedEvidencePath', $AuthenticatedEvidencePath) }
    if ($TransportAction -eq 'PostHealth') {
        $arguments += @('-ServerEvidenceFile', [string](Get-RequiredProperty $mobile 'server_evidence_file'))
    }
    & powershell @arguments
    if ($LASTEXITCODE -ne 0) { Stop-CoordinatedController "mobile $TransportAction did not complete with an exact durable handoff" }
    if ($TransportAction -ne 'PostHealth' -and -not (Test-Path -LiteralPath $SeedPath -PathType Leaf)) {
        Stop-CoordinatedController 'mobile bootstrap returned without its exact durable seed'
    }
    if (-not (Test-Path -LiteralPath $ReceiptPath -PathType Leaf)) {
        Stop-CoordinatedController 'mobile handoff returned without its child receipt result'
    }
    if (Test-Path -LiteralPath $SeedPath -PathType Leaf) {
        Update-CoordinatedDispatchDeliveryPolicy $DispatchPath $SeedPath $Operation | Out-Null
    }
}

function Invoke-CanonicalCoordinator {
    param(
        [Parameter(Mandatory = $true)][ValidateSet('CoordinatedRelease', 'Resume', 'Inspect')][string]$CanonicalMode,
        [Parameter(Mandatory = $true)][string]$Operation,
        [Parameter(Mandatory = $true)][string]$ManifestPath,
        [Parameter(Mandatory = $true)][string]$ReceiptPath,
        [Parameter(Mandatory = $true)][string]$EvidencePath,
        [string]$SeedPath
    )
    $arguments = @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $canonicalScript,
        '-Mode', $CanonicalMode, '-OperationId', $Operation, '-StateRoot', $stateRoot,
        '-CoordinatedManifestPath', $ManifestPath,
        '-CoordinatedMobileReceiptPath', $ReceiptPath,
        '-CoordinatedServerEvidencePath', $EvidencePath,
        '-Json'
    )
    if ($SeedPath) { $arguments += @('-CoordinatedSeedPath', $SeedPath) }
    $arguments += @('-SourceRepositoryRoot', $repositoryRoot, '-IntegrationWorktreePath', $integrationWorktree)
    $registryRemote = [string](Get-OptionalProperty $mobile 'registry_remote' '')
    if ($registryRemote) { $arguments += @('-MobileRegistryRemote', $registryRemote) }
    if ($CanonicalMode -ne 'Inspect') { $arguments += '-ConfirmCoordinatedRelease' }
    & powershell @arguments
    if ($LASTEXITCODE -ne 0) { Stop-CoordinatedController 'canonical coordinated server coordinator did not complete' }
}

function Read-CoordinatedBatchAdmissionResult {
    param(
        [Parameter(Mandatory = $true)][string]$BatchOperationId,
        [Parameter(Mandatory = $true)][string]$ParentOperation,
        [Parameter(Mandatory = $true)][string]$ReservedGeneration,
        [Parameter(Mandatory = $true)][string]$OriginalSourceSha,
        [Parameter(Mandatory = $true)][string]$OriginalMasterSha,
        [Parameter(Mandatory = $true)][object[]]$ResolvedBatchRequest
    )
    $manifestPath = Join-Path $stateRoot "$BatchOperationId.batch-admission-manifest.json"
    $null = Read-BatchAdmissionManifest $manifestPath $BatchOperationId $ResolvedBatchRequest `
        $ParentOperation $ReservedGeneration $OriginalSourceSha $OriginalMasterSha
    $state = Get-CoordinatedState $BatchOperationId
    if ($null -eq $state -or
        [string](Get-OptionalProperty $state 'operation_id' '') -cne $BatchOperationId -or
        [string](Get-OptionalProperty $state 'requested_mode' '') -cne 'IntegrateBatchAdmission' -or
        -not [bool](Get-OptionalProperty $state 'batch_admission_accepted' $false)) {
        Stop-CoordinatedController 'batch admission state is absent or not durably accepted'
    }
    $acceptedSha = [string](Get-OptionalProperty $state 'accepted_integration_sha' '').ToLowerInvariant()
    $acceptedGeneration = [string](Get-OptionalProperty $state 'accepted_generation' '')
    $originalMaster = [string](Get-OptionalProperty $state 'original_master_sha' '').ToLowerInvariant()
    if ($acceptedSha -notmatch '^[0-9a-f]{40}$' -or $acceptedGeneration -notmatch '^t\d{3,4}$' -or
        $originalMaster -notmatch '^[0-9a-f]{40}$' -or
        $acceptedGeneration -cne $ReservedGeneration -or
        $originalMaster -cne $OriginalMasterSha.ToLowerInvariant()) {
        Stop-CoordinatedController 'batch admission accepted state has a non-canonical pinned tuple'
    }
    $stateOriginalSource = [string](Get-OptionalProperty $state 'original_integration_sha' '')
    if ($stateOriginalSource -notmatch '^[0-9a-f]{40}$' -or
        $stateOriginalSource.ToLowerInvariant() -cne $OriginalSourceSha.ToLowerInvariant()) {
        Stop-CoordinatedController 'batch admission accepted state original source identity changed'
    }
    return [pscustomobject][ordered]@{
        state = $state
        generation = $acceptedGeneration
        integration_test_sha = $acceptedSha
        master_sha = $originalMaster
    }
}

function Invoke-BatchAdmissionCoordinator {
    param(
        [Parameter(Mandatory = $true)][ValidateSet('Start', 'Resume')][string]$BatchAction,
        [Parameter(Mandatory = $true)][string]$BatchOperationId,
        [object[]]$ResolvedBatchRequest = @(),
        [Parameter(Mandatory = $true)][string]$ParentOperation,
        [Parameter(Mandatory = $true)][string]$ReservedGeneration,
        [Parameter(Mandatory = $true)][string]$OriginalSourceSha,
        [Parameter(Mandatory = $true)][string]$OriginalMasterSha
    )
    $validatorPath = [string](Get-OptionalProperty $batchAdmission 'validator_adapter_path' '')
    $receiptPath = Join-Path $stateRoot "$BatchOperationId.batch-validator-receipt.json"
    $manifestPath = Join-Path $stateRoot "$BatchOperationId.batch-admission-manifest.json"
    if ($BatchAction -eq 'Start') {
        $manifest = New-BatchAdmissionManifest $BatchOperationId $ResolvedBatchRequest `
            $ParentOperation $ReservedGeneration $OriginalSourceSha $OriginalMasterSha
        Write-ControlJson $manifestPath $manifest
    } else {
        $manifest = Read-BatchAdmissionManifest $manifestPath $BatchOperationId $ResolvedBatchRequest `
            $ParentOperation $ReservedGeneration $OriginalSourceSha $OriginalMasterSha
    }
    $arguments = @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $canonicalScript,
        '-Mode', $(if ($BatchAction -eq 'Start') { 'IntegrateBatchAdmission' } else { 'Resume' }),
        '-OperationId', $BatchOperationId, '-StateRoot', $stateRoot,
        '-BatchAdmissionManifestPath', $manifestPath,
        '-SourceRepositoryRoot', $repositoryRoot, '-IntegrationWorktreePath', $integrationWorktree,
        '-BatchValidatorReceiptPath', $receiptPath, '-Json'
    )
    if (-not $validatorPath) {
        Stop-CoordinatedController 'control configuration has no isolated validator adapter path'
    }
    $arguments += @('-BatchValidatorAdapterPath', (Get-FullPath $validatorPath))
    if ($BatchAction -eq 'Start') {
        $arguments += @('-ConfirmBatchAdmission', '-ConfirmIntegration', '-ConfirmGenerationCheckpoint',
            '-ApprovedIntegrationTest')
    }
    $registryRemote = [string](Get-OptionalProperty $mobile 'registry_remote' '')
    if ($registryRemote) { $arguments += @('-MobileRegistryRemote', $registryRemote) }
    & powershell @arguments | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Stop-CoordinatedController 'batch admission did not produce an accepted durable integration generation'
    }
    return Read-CoordinatedBatchAdmissionResult $BatchOperationId $ParentOperation $ReservedGeneration `
        $OriginalSourceSha $OriginalMasterSha $ResolvedBatchRequest
}

function Test-CoordinatedNeedsPostHealth($State) {
    if ($null -eq $State -or $null -eq $State.coordinated_manifest) { return $false }
    if ([string]$State.coordinated_manifest.current_phase -eq 'completed') { return $false }
    return [bool]$State.coordinated_manifest.server.healthy
}

function Get-ActiveCoordinatedOperationIds {
    $files = @(Get-ChildItem -LiteralPath $stateRoot -Filter '*.json' -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^[A-Za-z0-9][A-Za-z0-9._-]{2,95}\.json$' })
    $records = @()
    $terminalOperations = @{}

    # Read canonical operation records first.  A completed canonical state makes
    # all matching dispatch/seed/evidence sidecars terminal for the sweep.
    foreach ($file in @($files | Where-Object { $_.Name -match '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}\.json$' })) {
        try { $candidate = Get-Content -Raw -LiteralPath $file.FullName -Encoding utf8 | ConvertFrom-Json }
        catch { continue }
        $operation = [string](Get-OptionalProperty $candidate 'operation_id' '')
        $manifest = Get-OptionalProperty $candidate 'coordinated_manifest' $null
        if (-not $operation -or $null -eq $manifest) { continue }
        $phase = [string](Get-OptionalProperty $manifest 'current_phase' '')
        $coordinatedStatus = [string](Get-OptionalProperty $candidate 'coordinated_status' '')
        $completion = Get-OptionalProperty $manifest 'completion' $null
        $completionStatus = [string](Get-OptionalProperty $completion 'status' '')
        if ($phase -eq 'completed' -or $coordinatedStatus -eq 'completed' -or
            $completionStatus -eq 'completed') {
            $terminalOperations[$operation] = $true
        }
    }

    foreach ($file in $files) {
        try { $candidate = Get-Content -Raw -LiteralPath $file.FullName -Encoding utf8 | ConvertFrom-Json }
        catch { continue }
        $operation = [string](Get-OptionalProperty $candidate 'operation_id' '')
        if ($operation -notmatch '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$' -or
            $terminalOperations.ContainsKey($operation)) { continue }
        $kind = [string](Get-OptionalProperty $candidate 'kind' '')
        $requestedMode = [string](Get-OptionalProperty $candidate 'requested_mode' '')
        if (-not $requestedMode -and $kind -eq 'ash-atlas-coordinated-mobile-dispatch-request') {
            $requestedMode = 'CoordinatedRelease'
        }
        if ($requestedMode -cne 'CoordinatedRelease') { continue }
        $records += [pscustomobject]@{
            operation_id = $operation
            updated_at_utc = [string](Get-OptionalProperty $candidate 'updated_at_utc' '')
        }
    }
    foreach ($file in @(Get-ChildItem -LiteralPath $stateRoot -Filter 'coordinated-source-*.claim.json' -File -ErrorAction SilentlyContinue)) {
        $claim = Read-CoordinatedSourceClaim $file.FullName
        if ($null -eq $claim) { continue }
        $operation = [string](Get-OptionalProperty $claim 'operation_id' '')
        if ($operation -notmatch '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$' -or
            $terminalOperations.ContainsKey($operation)) { continue }
        $records += [pscustomobject]@{
            operation_id = $operation
            updated_at_utc = [string](Get-OptionalProperty $claim 'created_at_utc' '')
        }
    }
    return @($records | Sort-Object updated_at_utc |
        Group-Object operation_id | ForEach-Object { $_.Group | Select-Object -Last 1 } |
        Select-Object -First 16 | ForEach-Object { $_.operation_id })
}

if ($Action -eq 'ResumeActive') {
    $active = @(Get-ActiveCoordinatedOperationIds)
    if ($DryRun) {
        [pscustomobject][ordered]@{ action = $Action; operations = $active } |
            ConvertTo-Json -Depth 8 -Compress
        exit 0
    }
    $failures = @()
    $processed = @()
    $deferred = @()
    $sweepDeadline = (Get-Date).ToUniversalTime().AddMinutes(80)
    foreach ($activeOperation in $active) {
        if ((Get-Date).ToUniversalTime() -ge $sweepDeadline) {
            $deferred += @($active | Where-Object { $_ -notin $processed })
            break
        }
        $processed += $activeOperation
        $output = @(& powershell -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath `
            -Action Resume -OperationId $activeOperation -ConfigPath $ConfigPath 2>&1)
        if ($LASTEXITCODE -ne 0) {
            $failures += [pscustomobject]@{
                operation_id = $activeOperation
                output = ($output -join "`n")
            }
        }
    }
    [pscustomobject][ordered]@{
        action = $Action
        resumed_operations = @($processed | Where-Object { $_ -notin @($failures.operation_id) })
        deferred_operations = $deferred
        failures = $failures
    } | ConvertTo-Json -Depth 12 -Compress
    if ($failures.Count -gt 0) { Stop-CoordinatedController 'one or more durable coordinated releases require action' }
    exit 0
}

if ($Action -eq 'Start') {
    if ($OperationId) { Stop-CoordinatedController 'Start does not accept a caller-supplied operation ID' }
    $OperationId = 'coordinated-{0}-{1}' -f (Get-Date -Format 'yyyyMMddTHHmmss'),
        ([guid]::NewGuid().ToString('n').Substring(0, 8))
} elseif ($OperationId -notmatch '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$') {
    Stop-CoordinatedController 'Inspect or Resume requires an exact durable operation ID'
}

$seedPath = Join-Path $stateRoot "$OperationId.coordinated-seed.json"
$manifestPath = Join-Path $stateRoot "$OperationId.coordinated-manifest.json"
$receiptPath = Join-Path $stateRoot "$OperationId.coordinated-mobile-receipt.json"
$evidencePath = Join-Path $stateRoot "$OperationId.coordinated-server-evidence.json"
$authenticatedEvidencePath = Join-Path $stateRoot "$OperationId.coordinated-server-evidence.authenticated.json"
$initialDispatchPath = Join-Path $stateRoot "$OperationId.coordinated-mobile-dispatch.json"
$postHealthDispatchPath = Join-Path $stateRoot "$OperationId.coordinated-post-health-dispatch.json"
$durableBatchRequestPath = Join-Path $stateRoot "$OperationId.batch-request.json"
$batchAdmissionManifestPath = Join-Path $stateRoot "$OperationId-admission.batch-admission-manifest.json"
$snapshot = $null
$currentServerSha = ''
$batchRequest = @()
$resolvedBatchRequest = @()
$batchAdmissionOperationId = ''
$batchAdmissionReservedGeneration = ''
$batchAdmissionOriginalSourceSha = ''
$batchAdmissionOriginalMasterSha = ''
$dispatch = $null
$batchRequestHash = ''
if ($Action -eq 'Start') {
    if ($BatchRequestJson -or $BatchRequestPath) {
        $batchRequestInput = if ($BatchRequestPath) {
            Read-BatchRequestFile $BatchRequestPath
        } else { $BatchRequestJson }
        $batchRequest = @(Read-BatchRequest $batchRequestInput)
        $resolvedBatchRequest = @(Resolve-RegisteredBatchWorktrees $batchRequest)
        $batchAdmissionOperationId = "$OperationId-admission"
    }
    $batchRequestHash = Get-ControllerSha256 (ConvertTo-ControllerCanonicalJson @($batchRequest))
    $snapshot = Get-GenerationSnapshot
    $generation = [string](Get-RequiredProperty $snapshot 'generation')
    $serverSha = [string](Get-RequiredProperty $snapshot 'integration_test_sha').ToLowerInvariant()
    $masterSha = [string](Get-RequiredProperty $snapshot 'master_sha').ToLowerInvariant()
    if ($generation -notmatch '^t\d{3,4}$' -or $serverSha -notmatch '^[0-9a-f]{40}$' -or
        $masterSha -notmatch '^[0-9a-f]{40}$') {
        Stop-CoordinatedController 'generation snapshot is not an exact accepted integration identity'
    }
    Assert-ExpectedCandidate $snapshot
    if ($batchRequest.Count -gt 0) {
        $batchAdmissionReservedGeneration = [string](Get-RequiredProperty $snapshot 'next_generation')
        if ($batchAdmissionReservedGeneration -notmatch '^t\d{3,4}$' -or
            [int]$batchAdmissionReservedGeneration.Substring(1) -le [int]$generation.Substring(1)) {
            Stop-CoordinatedController 'batch admission snapshot has no exact unused next generation to reserve'
        }
        $batchAdmissionOriginalSourceSha = $serverSha
        $batchAdmissionOriginalMasterSha = $masterSha
    }
    $currentServerSha = Get-CurrentServerSha
    if (-not $DryRun) {
        $dispatch = New-InitialDispatchRequest $OperationId $snapshot $currentServerSha `
            $batchRequest $resolvedBatchRequest $batchAdmissionOperationId `
            $ExpectedGeneration $ExpectedCandidateSha $ExpectedDeliveryMode
        Claim-CoordinatedStart $OperationId $generation $serverSha $masterSha $currentServerSha `
            $batchRequestHash $dispatch | Out-Null
        Write-ControlJson $initialDispatchPath $dispatch
        if ($batchRequest.Count -gt 0) {
            Write-ControlJson $durableBatchRequestPath ([pscustomobject][ordered]@{
                    schema_version = 1
                    kind = 'ash-atlas-batch-request'
                    operation_id = $OperationId
                    features = @($batchRequest)
                    resolved_worktrees = @($resolvedBatchRequest)
                    request_sha256 = Get-ControllerSha256 (ConvertTo-ControllerCanonicalJson @($batchRequest))
                    created_at_utc = (Get-Date).ToUniversalTime().ToString('o')
                })
        }
    }
    if ($batchRequest.Count -gt 0 -and -not $DryRun) {
        $admission = Invoke-BatchAdmissionCoordinator -BatchAction 'Start' -BatchOperationId $batchAdmissionOperationId `
            -ResolvedBatchRequest $resolvedBatchRequest -ParentOperation $OperationId `
            -ReservedGeneration $batchAdmissionReservedGeneration -OriginalSourceSha $batchAdmissionOriginalSourceSha `
            -OriginalMasterSha $batchAdmissionOriginalMasterSha
        $snapshot = [pscustomobject][ordered]@{
            generation = $admission.generation
            integration_test_sha = $admission.integration_test_sha
            master_sha = $admission.master_sha
        }
        $dispatch.batch_admission_status = 'accepted'
        $dispatch.batch_admission_accepted_sha = $admission.integration_test_sha
        $dispatch.batch_admission_accepted_generation = $admission.generation
        Update-CoordinatedStartClaim $OperationId $initialDispatchPath $dispatch $snapshot 'accepted' | Out-Null
    }
} elseif ($Action -eq 'Resume') {
    if ($BatchRequestJson -or $BatchRequestPath) {
        Stop-CoordinatedController 'Resume uses the original durable batch_request; a new request is not accepted'
    }
    $sourceClaim = Get-CoordinatedSourceClaimForOperation $OperationId
    $pinned = Get-PinnedOperationIdentity $OperationId $seedPath $manifestPath $initialDispatchPath
    $generation = $pinned.generation
    $serverSha = $pinned.server_sha
    $masterSha = $pinned.accepted_master_sha
    $currentServerSha = $pinned.current_server_sha
    $snapshot = [pscustomobject][ordered]@{
        generation = $generation
        integration_test_sha = $serverSha
        master_sha = $masterSha
    }
    if (-not (Test-Path -LiteralPath $initialDispatchPath -PathType Leaf) -and $null -ne $sourceClaim) {
        $claimedDispatch = Get-OptionalProperty $sourceClaim 'dispatch' $null
        if ($null -ne $claimedDispatch) {
            Write-ControlJson $initialDispatchPath $claimedDispatch
        }
    }
    if (Test-Path -LiteralPath $initialDispatchPath -PathType Leaf) {
        try { $dispatch = Get-Content -Raw -LiteralPath $initialDispatchPath -Encoding utf8 | ConvertFrom-Json }
        catch { Stop-CoordinatedController 'durable mobile dispatch request is unreadable' }
        $batchAdmissionOperationId = [string](Get-OptionalProperty $dispatch 'batch_admission_operation_id' '')
        $batchRequest = @((Get-OptionalProperty $dispatch 'batch_request' @()))
        $resolvedBatchRequest = @((Get-OptionalProperty $dispatch 'batch_resolved_worktrees' @()))
        if ($batchAdmissionOperationId -and $batchRequest.Count -gt 0) {
            $batchAdmissionReservedGeneration = [string](Get-OptionalProperty $dispatch 'batch_admission_reserved_generation' '')
            $batchAdmissionOriginalSourceSha = [string](Get-OptionalProperty $dispatch 'batch_admission_original_source_sha' '')
            $batchAdmissionOriginalMasterSha = [string](Get-OptionalProperty $dispatch 'batch_admission_original_master_sha' '')
            if ($batchAdmissionReservedGeneration -notmatch '^t\d{3,4}$' -or
                $batchAdmissionOriginalSourceSha -notmatch '^[0-9a-f]{40}$' -or
                $batchAdmissionOriginalMasterSha -notmatch '^[0-9a-f]{40}$') {
                Stop-CoordinatedController 'durable batch admission reservation has a non-canonical pinned tuple'
            }
            $admissionState = Get-CoordinatedState $batchAdmissionOperationId
            $accepted = $null -ne $admissionState -and
                [bool](Get-OptionalProperty $admissionState 'batch_admission_accepted' $false)
            $admission = if ($accepted) {
                Read-CoordinatedBatchAdmissionResult $batchAdmissionOperationId $OperationId `
                    $batchAdmissionReservedGeneration $batchAdmissionOriginalSourceSha $batchAdmissionOriginalMasterSha `
                    $resolvedBatchRequest
            } elseif ($null -eq $admissionState) {
                # The durable request exists even if the canonical child was interrupted
                # before its first state write; replay the same child identity and packet.
                Invoke-BatchAdmissionCoordinator -BatchAction 'Start' -BatchOperationId $batchAdmissionOperationId `
                    -ResolvedBatchRequest $resolvedBatchRequest -ParentOperation $OperationId `
                    -ReservedGeneration $batchAdmissionReservedGeneration -OriginalSourceSha $batchAdmissionOriginalSourceSha `
                    -OriginalMasterSha $batchAdmissionOriginalMasterSha
            } else {
                Invoke-BatchAdmissionCoordinator -BatchAction 'Resume' -BatchOperationId $batchAdmissionOperationId `
                    -ResolvedBatchRequest $resolvedBatchRequest -ParentOperation $OperationId `
                    -ReservedGeneration $batchAdmissionReservedGeneration -OriginalSourceSha $batchAdmissionOriginalSourceSha `
                    -OriginalMasterSha $batchAdmissionOriginalMasterSha
            }
            $snapshot = [pscustomobject][ordered]@{
                generation = $admission.generation
                integration_test_sha = $admission.integration_test_sha
                master_sha = $admission.master_sha
            }
            Update-CoordinatedStartClaim $OperationId $initialDispatchPath $dispatch $snapshot 'accepted' -AllowMissing | Out-Null
            $generation = [string]$snapshot.generation
            $serverSha = [string]$snapshot.integration_test_sha
            $masterSha = [string]$snapshot.master_sha
        }
    }
} else {
    $generation = ''
    $serverSha = ''
    $masterSha = ''
}

if ($DryRun) {
    [pscustomobject][ordered]@{
        action = $Action
        operation_id = $OperationId
        generation = $generation
        server_sha = $serverSha
        accepted_master_sha = $masterSha
        current_server_sha = $currentServerSha
        seed_path = $seedPath
        manifest_path = $manifestPath
        receipt_path = $receiptPath
        evidence_path = $evidencePath
        initial_dispatch_path = $initialDispatchPath
        post_health_dispatch_path = $postHealthDispatchPath
        batch_admission_manifest_path = $batchAdmissionManifestPath
    } | ConvertTo-Json -Depth 8 -Compress
    exit 0
}

if ($Action -eq 'Inspect') {
    Invoke-CanonicalCoordinator 'Inspect' $OperationId $manifestPath $receiptPath $evidencePath
    exit 0
}

$durableState = Get-CoordinatedState $OperationId
$needsPreHealth = $Action -eq 'Start' -or -not (Test-CoordinatedNeedsPostHealth $durableState)
if ($needsPreHealth) {
    if ($Action -eq 'Resume' -and -not (Test-Path -LiteralPath $initialDispatchPath -PathType Leaf)) {
        Stop-CoordinatedController 'Resume cannot find the original pinned mobile dispatch request'
    }
    $transportAction = if ($Action -eq 'Start') { 'Start' } else { 'Resume' }
    Invoke-MobileBootstrap $transportAction $OperationId $snapshot $currentServerSha `
        $seedPath $receiptPath $initialDispatchPath
}

$hasCoordinatedState = $null -ne $durableState -and
    $null -ne $durableState.PSObject.Properties['coordinated_manifest']
$canonicalMode = if ($Action -eq 'Start' -or -not $hasCoordinatedState) {
    'CoordinatedRelease'
} else { 'Resume' }
$canonicalSeedPath = if ($canonicalMode -eq 'CoordinatedRelease') { $seedPath } else { $null }
Invoke-CanonicalCoordinator $canonicalMode $OperationId $manifestPath $receiptPath $evidencePath $canonicalSeedPath
$durableState = Get-CoordinatedState $OperationId
if (Test-CoordinatedNeedsPostHealth $durableState) {
    if (-not (Test-Path -LiteralPath $evidencePath -PathType Leaf)) {
        Stop-CoordinatedController 'healthy canonical coordination returned without controller evidence'
    }
    Invoke-MobileBootstrap 'PostHealth' $OperationId $snapshot $currentServerSha `
        $seedPath $receiptPath $postHealthDispatchPath $evidencePath $authenticatedEvidencePath
    Invoke-CanonicalCoordinator 'Resume' $OperationId $manifestPath $receiptPath $evidencePath
}
